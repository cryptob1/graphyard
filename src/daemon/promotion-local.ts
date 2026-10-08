// Concern: the promotion drive in control-plane mode (GY-1526) — the loop cuts, validates, promotes and reverts release candidates itself, with no workflow to dispatch.
import type { UatRecord } from '../release-candidate.js';
import { failingRequiredCases, revertTarget, type CandidateItemDelta, type RevertContract, type RevertOutcome, type RevertTarget } from '../release-revert.js';
import type { VerificationMap } from '../model/verification-maps.js';
import { assessCut, type CutCommit, type CutSettings } from './candidate-cut.js';
import { message, type PromotionState } from './state.js';
import { promotionFrozenReason, promotionReadWindows, type PromotionOptions, type PromotionReads } from './deployment.js';

/** A candidate as the local ports hand it back: the record's id and SHA, and the delivered items it carries. */
export interface LocalCandidate { id: string; sha: string; cutAt: string; items: { key: string; mergeSha: string; pr: number | null }[] }
/** What the local `validate` answers: the UAT record as `validateAndRecord` wrote it, and the follow-up it filed, if any. */
export interface LocalValidation { record: Pick<UatRecord, 'result' | 'suites' | 'e2e' | 'followUp' | 'deployedSha'>; followUp: string | null }
/**
 * The port set the loop runs release candidates through in control-plane mode (AC-2): each port
 * runs the matching src/release-candidate.ts function from the coordinator checkout, pushing tags
 * and environment branches through the install's deploy key (effects.ts wires them;
 * daemon/release-ports.ts builds them). No workflow run is read or dispatched.
 */
export interface LocalReleasePorts {
  /** Cuts the next candidate from the base tip (`cut`), or names the newest one UAT holds no verdict for yet, to be resumed after a crash. */
  cut(): Promise<{ cut: true; candidate: LocalCandidate } | { cut: false; resume: LocalCandidate } | { cut: false; reason: string }>;
  /** Moves `release/uat` to the candidate's exact SHA (`deployToUat`); refused while another candidate's validation runs there. */
  uat(id: string): Promise<{ sha: string }>;
  /** Waits for UAT to serve the SHA, runs every suite and records `rc-uat/ID` (`validateAndRecord`), filing holds and the follow-up. */
  validate(id: string): Promise<LocalValidation>;
  /** Moves `release/production` to the candidate's SHA and records `rc-production/ID` (`promote`), only after UAT passed on it. */
  promote(id: string): Promise<{ promoted: true; sha: string } | { promoted: false; refusals: string[] }>;
  /** Confirms production serves `sha` (`awaitServing`): what it serves at the end of the wait. */
  verify(sha: string): Promise<{ served: string | null; verified: boolean }>;
  /** Main's first-parent commits after the newest cut, newest first, each with its committer time, for the cut rule. */
  history(): Promise<CutCommit[]>;
  /** The candidate items' merge deltas, the verification maps and the release contract the revert target is chosen from. */
  revertInputs(candidate: LocalCandidate): Promise<{ items: CandidateItemDelta[]; maps: VerificationMap[]; contract: RevertContract }>;
  /** Lands the revert through the merge writer's steps (release-revert.ts `revertCandidateItem`), under ledger kind `revert`. */
  revert(target: RevertTarget): Promise<RevertOutcome>;
  /** `run.candidates` with its defaults. */
  settings: CutSettings;
}

/** What one local run did, for the promotion reason and the loop's action record. */
export interface LocalRunOutcome { candidate: LocalCandidate; resumed: boolean; validation: LocalValidation | null; promoted: boolean; served: string | null; revert: { target: RevertTarget; outcome: RevertOutcome } | null; detail: string }

const short = (sha: string) => sha.slice(0, 12);

/**
 * The candidate's run from UAT to production or to the revert (AC-2, AC-4). UAT is deployed and
 * validated; a passing record promotes and verifies production; a failing one leaves production on
 * the previous release and, when a required E2E case failed outright, reverts the merge of the
 * candidate item the failure implicates (release-revert.ts) — one attempt, its refusal recorded,
 * never a second item. A flaky case stays on the holds and evidence-decision path, and a failure no
 * case explains files the ordinary follow-up alone. The next cut starts after whatever landed.
 */
export async function runLocalCandidate(local: LocalReleasePorts, candidate: LocalCandidate, resumed: boolean): Promise<LocalRunOutcome> {
  const name = `candidate ${candidate.id} (${short(candidate.sha)})`;
  await local.uat(candidate.id);
  const validation = await local.validate(candidate.id);
  const outcome: LocalRunOutcome = { candidate, resumed, validation, promoted: false, served: null, revert: null, detail: '' };
  if (validation.record.result === 'passed') {
    const promoted = await local.promote(candidate.id);
    if (!promoted.promoted) { outcome.detail = `${name} passed UAT but was not promoted: ${promoted.refusals.join('; ')}`; return outcome; }
    outcome.promoted = true;
    const verified = await local.verify(candidate.sha);
    outcome.served = verified.served;
    outcome.detail = verified.verified ? `Promoted ${name} to production, which serves it` : `Promoted ${name} to production, which still serves ${verified.served ? short(verified.served) : 'no observable commit'}; the deployment observation confirms it when it lands`;
    return outcome;
  }
  const failing = validation.record.suites.filter(suite => !suite.passed).map(suite => suite.name);
  const failed = failingRequiredCases(validation.record).filter(entry => entry.verdict === 'failed');
  const stays = 'production stays on the previous release';
  if (!failed.length) { outcome.detail = `${name} failed UAT (${failing.join(', ')}); ${stays}${validation.followUp ? ` and follow-up ${validation.followUp} names the failure` : ''}; the next cut starts after it`; return outcome; }
  const inputs = await local.revertInputs(candidate);
  const target = revertTarget(candidate, validation.record, inputs.items, inputs.maps, inputs.contract);
  if (!target) { outcome.detail = `${name} failed required E2E case ${failed[0].case} but carries no delivered item to revert; ${stays}`; return outcome; }
  const reverted = await local.revert(target);
  outcome.revert = { target, outcome: reverted };
  outcome.detail = reverted.outcome === 'reverted' ? `${target.reason}: reverted as ${short(reverted.revertSha)} on ${short(reverted.baseTip)} and ${target.key} reopened for rework; ${stays}; the next cut starts after the revert`
    : `${name} failed required E2E case ${target.case} at step "${target.step}"; the revert of ${target.key}'s merge ${short(target.mergeSha)} was ${reverted.outcome === 'refused' ? 'refused' : 'left queued'} (${reverted.reason}); ${stays} and the follow-up stands`;
  return outcome;
}

/**
 * One cycle of the promotion drive in control-plane mode. The ledger is read on the same windows
 * as in github mode and the same gates hold first — nothing to promote, the main watch's freeze
 * (AC-5: no cut, UAT deploy, promote or revert runs, and the reason names the commit), a tip the
 * watch has not classified, the `everyMinutes` gap since the last candidate. Then, once a
 * run-read window, main's history is read for the cut rule (candidate-cut.ts): a candidate the
 * ledger holds without a UAT verdict is resumed, else one is cut when due, and the run goes
 * through UAT to production or to the revert in this one call, which the deployment step keeps in
 * flight across cycles. It never throws: a failed port comes back as `failure` with the stamps kept.
 */
export async function localPromotionCycle(previous: PromotionState | null, reads: PromotionReads & { local: LocalReleasePorts }, options: PromotionOptions): Promise<{ state: PromotionState; dispatched: boolean; failure: string | null; run?: LocalRunOutcome }> {
  const { local } = reads;
  const at = new Date(options.now).toISOString(), everyMs = options.everyMinutes * 60_000, windows = promotionReadWindows(options.intervalMs ?? 0);
  const settle = (state: Omit<PromotionState, 'nextDueAt' | 'reason'>, reason: string, due: boolean): PromotionState => ({ ...state, reason: reason.slice(0, 500),
    nextDueAt: due && state.lastDispatchAt ? new Date(Math.max(options.now, Date.parse(state.lastDispatchAt) + everyMs)).toISOString() : due ? at : null });
  const done = (state: Omit<PromotionState, 'nextDueAt' | 'reason'>, reason: string, due: boolean, extra: { dispatched?: boolean; run?: LocalRunOutcome } = {}) => ({ state: settle(state, reason, due), dispatched: extra.dispatched ?? false, failure: null, ...(extra.run ? { run: extra.run } : {}) });
  const failed = (state: Omit<PromotionState, 'nextDueAt' | 'reason'>, failure: string) => ({ state: settle(state, failure, true), dispatched: false, failure });
  const kept = { mainSha: previous?.mainSha ?? null, promotedSha: previous?.promotedSha ?? null, promotedAt: previous?.promotedAt ?? null, behind: previous?.behind ?? null, candidates: previous?.candidates ?? [], ledgerReadAt: previous?.ledgerReadAt ?? null };
  const readLedger = async () => { const read = await reads.ledger(); return { ...read, candidates: read.candidates ?? [] }; };
  // No workflow runs exist in this mode: `inFlight` is never set, since the run completes inside this call, and the soak list is left as it was.
  const carried = { ...(previous?.soaks ? { soaks: previous.soaks } : {}), ...(previous?.soaksReadAt ? { soaksReadAt: previous.soaksReadAt } : {}), inFlight: false, runsReadAt: previous?.runsReadAt ?? null, dispatchedAt: previous?.dispatchedAt ?? null, lastDispatchAt: previous?.lastDispatchAt ?? null, cutSha: previous?.cutSha ?? null,
    ...(previous?.candidateAtDispatch !== undefined ? { candidateAtDispatch: previous.candidateAtDispatch } : {}) };
  if (options.everyMinutes <= 0) return done({ checkedAt: at, ...kept, ...carried }, 'Promotion by the loop is off (run.promoteEveryMinutes is 0)', false);
  let ledger = kept;
  if (!kept.ledgerReadAt || options.now - Date.parse(kept.ledgerReadAt) >= windows.ledgerMs) {
    try { ledger = { ...await readLedger(), ledgerReadAt: at }; } catch (error) {
      return failed({ checkedAt: at, ...kept, ledgerReadAt: at, ...carried }, `The base branch and the promotion record could not be read: ${message(error)}`);
    }
  }
  const base = { checkedAt: at, ...ledger, ...carried };
  if (!ledger.mainSha) return done(base, 'The base branch tip could not be read, so nothing is cut', false);
  if (ledger.mainSha === ledger.promotedSha) return done(base, 'Production runs the base branch tip; nothing to cut or promote', false);
  // GY-1519 / AC-5: the freeze holds every local step; a tip the watch has not classified waits for it.
  if (options.frozen) return done(base, promotionFrozenReason(options.frozen), false);
  if (options.watchedTip !== undefined && options.watchedTip !== ledger.mainSha) return done(base, `The main watch has not classified the base branch tip ${short(ledger.mainSha)} yet; the cut waits for its verdict`, true);
  const sinceLast = base.lastDispatchAt ? options.now - Date.parse(base.lastDispatchAt) : Number.POSITIVE_INFINITY;
  if (sinceLast < everyMs) return done(base, `The last candidate was cut ${Math.round(sinceLast / 60_000)} minute(s) ago; the next is due no sooner than ${options.everyMinutes} minute(s) after it`, true);
  // The cut rule is read once a run-read window, like the workflow's runs are in github mode.
  if (base.runsReadAt && options.now - Date.parse(base.runsReadAt) < windows.runsMs) return done(base, previous?.reason ?? 'The cut rule is read once a minute; nothing is due yet', true);
  let history: CutCommit[];
  try { history = await local.history(); } catch (error) { return failed({ ...base, runsReadAt: at }, `The base branch history could not be read for the cut rule: ${message(error)}`); }
  const assessment = assessCut(ledger, history, options.now, local.settings);
  let decided: Awaited<ReturnType<LocalReleasePorts['cut']>>;
  try { decided = assessment.due ? await local.cut() : await resumable(local); } catch (error) { return failed({ ...base, runsReadAt: at }, `The release candidate could not be cut: ${message(error)}`); }
  if (!decided.cut && !('resume' in decided)) return done({ ...base, runsReadAt: at }, assessment.due ? `${assessment.reason}, but nothing was cut: ${decided.reason}` : assessment.reason, !assessment.due && assessment.merges > 0);
  const candidate = decided.cut ? decided.candidate : decided.resume, resumed = !decided.cut;
  // The attempt is stamped before the run: whatever its outcome, the next cut waits out the gap and starts after this candidate.
  const attempted = { ...base, runsReadAt: at, dispatchedAt: at, lastDispatchAt: at, cutSha: candidate.sha, candidateAtDispatch: candidate.id };
  let run: LocalRunOutcome;
  try { run = await runLocalCandidate(local, candidate, resumed); } catch (error) {
    return failed(attempted, `${resumed ? 'Resuming' : 'Cut'} candidate ${candidate.id} (${short(candidate.sha)}) failed before a verdict was recorded; it is resumed at the next read: ${message(error)}`);
  }
  // What the run promoted, and the merge or revert it left on main, is read now rather than a window later.
  let after = attempted;
  try { after = { ...attempted, ...await readLedger(), ledgerReadAt: new Date(Date.now()).toISOString() }; } catch { /* the next window re-reads it */ }
  return done(after, `${resumed ? `Resumed candidate ${candidate.id}: ` : `Cut candidate ${candidate.id} at ${short(candidate.sha)}: `}${run.detail}`, true, { dispatched: true, run });
}

/** A cut not due still resumes a candidate whose validation never recorded: the port answers it as `resume` without cutting. */
async function resumable(local: LocalReleasePorts): Promise<Awaited<ReturnType<LocalReleasePorts['cut']>>> {
  const decided = await local.cut().catch(() => null);
  return decided && !decided.cut && 'resume' in decided ? decided : { cut: false, reason: 'not due' };
}
