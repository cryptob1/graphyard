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
  /** Names the newest candidate UAT holds no verdict for yet, to be resumed after a crash; else, only when `due`, cuts the next one from the base tip (`cut`). A cut not due cuts nothing. */
  cut(due: boolean): Promise<{ cut: true; candidate: LocalCandidate } | { cut: false; resume: LocalCandidate } | { cut: false; reason: string }>;
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
 * UAT deploy + validation for one candidate. Promote and revert are left to the cycle that finds
 * the verdict, so a freeze that lands while validation runs (up to twenty minutes) still stops them.
 */
async function validateLocalCandidate(local: LocalReleasePorts, candidate: LocalCandidate): Promise<LocalValidation> {
  await local.uat(candidate.id);
  return local.validate(candidate.id);
}

/**
 * Promote or revert after a UAT verdict (AC-2, AC-4). Production stays on the previous release when
 * the candidate failed; a required E2E failure that is not flaky reverts the implicated item's merge
 * (release-revert.ts) — one attempt, its refusal recorded, never a second item. A flaky case stays
 * on the holds and evidence-decision path.
 */
export async function finishLocalCandidate(local: LocalReleasePorts, candidate: LocalCandidate, resumed: boolean, validation: LocalValidation): Promise<LocalRunOutcome> {
  const name = `candidate ${candidate.id} (${short(candidate.sha)})`;
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
 * The candidate's full run from UAT to production or to the revert, for callers that hold the freeze
 * themselves (tests of the ports). The cycle path splits validate from finish so a freeze that
 * arrives during validation still gates promote and revert.
 */
export async function runLocalCandidate(local: LocalReleasePorts, candidate: LocalCandidate, resumed: boolean): Promise<LocalRunOutcome> {
  return finishLocalCandidate(local, candidate, resumed, await validateLocalCandidate(local, candidate));
}

/**
 * One in-flight local candidate across loop cycles (AC-2): cut (or resume) stamps `inFlight`, UAT
 * and validation run beside the cycle, and the cycle that finds the verdict promotes or reverts —
 * or holds when the main watch's freeze stands (AC-5). Keyed by the port set so a restart with no
 * WeakMap entry resumes from the ledger through `cut` instead.
 */
interface LocalFlight {
  candidate: LocalCandidate;
  resumed: boolean;
  /** Set once UAT + validation settle (or fail before a verdict). */
  settled: { validation: LocalValidation } | { error: string } | null;
  work: Promise<void>;
}
const flights = new WeakMap<LocalReleasePorts, LocalFlight>();

/** Resolves once the local candidate in flight for `local` has finished UAT validation; for tests. */
export const localPromotionIdle = async (local: LocalReleasePorts) => {
  for (let waited = 0; flights.get(local) && !flights.get(local)!.settled && waited < 600_000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
};

/** Drain every local flight through promote/revert (or freeze hold) for tests that call the cycle once per step. */
export async function settleLocalPromotion(
  previous: PromotionState | null,
  reads: PromotionReads & { local: LocalReleasePorts },
  options: PromotionOptions,
): Promise<{ state: PromotionState; dispatched: boolean; failure: string | null; run?: LocalRunOutcome }> {
  let result = await localPromotionCycle(previous, reads, options);
  let dispatched = result.dispatched;
  for (let step = 0; result.state.inFlight && !result.failure && step < 20; step++) {
    await localPromotionIdle(reads.local);
    // A freeze hold leaves inFlight set with no work left to drain; stop so the caller can lift it.
    if (options.frozen && result.state.reason === promotionFrozenReason(options.frozen)) break;
    const next = await localPromotionCycle(result.state, reads, { ...options, now: options.now + (step + 1) * 1_000 });
    dispatched = dispatched || next.dispatched;
    result = next;
  }
  return { ...result, dispatched };
}

/**
 * One cycle of the promotion drive in control-plane mode. The ledger is read on the same windows
 * as in github mode and the same gates hold first — nothing to promote, the main watch's freeze
 * (AC-5: no cut, UAT deploy, promote or revert runs, and the reason names the commit), a tip the
 * watch has not classified, the `everyMinutes` gap since the last candidate. A cut or resume stamps
 * `PromotionState.inFlight` and starts UAT + validation beside the cycle; later cycles keep that
 * flag until the run settles, then promote or revert only when the freeze is clear. It never
 * throws: a failed port comes back as `failure` with the stamps kept.
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
  const soak = { ...(previous?.soaks ? { soaks: previous.soaks } : {}), ...(previous?.soaksReadAt ? { soaksReadAt: previous.soaksReadAt } : {}) };
  const stamps = { runsReadAt: previous?.runsReadAt ?? null, dispatchedAt: previous?.dispatchedAt ?? null, lastDispatchAt: previous?.lastDispatchAt ?? null, cutSha: previous?.cutSha ?? null,
    ...(previous?.candidateAtDispatch !== undefined ? { candidateAtDispatch: previous.candidateAtDispatch } : {}) };
  if (options.everyMinutes <= 0) return done({ checkedAt: at, ...kept, ...soak, ...stamps, inFlight: false }, 'Promotion by the loop is off (run.promoteEveryMinutes is 0)', false);
  let ledger = kept;
  if (!kept.ledgerReadAt || options.now - Date.parse(kept.ledgerReadAt) >= windows.ledgerMs) {
    try { ledger = { ...await readLedger(), ledgerReadAt: at }; } catch (error) {
      return failed({ checkedAt: at, ...kept, ledgerReadAt: at, ...soak, ...stamps, inFlight: previous?.inFlight ?? false }, `The base branch and the promotion record could not be read: ${message(error)}`);
    }
  }
  const base = { checkedAt: at, ...ledger, ...soak, ...stamps };
  if (!ledger.mainSha) return done({ ...base, inFlight: previous?.inFlight ?? false }, 'The base branch tip could not be read, so nothing is cut', false);
  if (ledger.mainSha === ledger.promotedSha && !previous?.inFlight && !flights.get(local)) return done({ ...base, inFlight: false }, 'Production runs the base branch tip; nothing to cut or promote', false);

  // An in-flight candidate from a prior cycle (or a crash that left the stamp): finish it before any new cut.
  const flight = flights.get(local);
  if (flight || previous?.inFlight) {
    const inFlightBase = { ...base, inFlight: true, cutSha: flight?.candidate.sha ?? base.cutSha, candidateAtDispatch: flight?.candidate.id ?? base.candidateAtDispatch };
    if (flight && !flight.settled) {
      // Validation still runs beside the cycle; the freeze cannot stop it mid-suite, but promote/revert wait.
      const reason = options.frozen ? promotionFrozenReason(options.frozen) : `Candidate ${flight.candidate.id} (${short(flight.candidate.sha)}) is in validation; the next cut waits for its verdict`;
      return done(inFlightBase, reason, !options.frozen);
    }
    if (flight?.settled && 'error' in flight.settled) {
      flights.delete(local);
      return failed({ ...inFlightBase, inFlight: false }, flight.settled.error);
    }
    if (flight?.settled && 'validation' in flight.settled) {
      // AC-5: re-check the freeze with this cycle's options before promote or revert.
      if (options.frozen) return done(inFlightBase, promotionFrozenReason(options.frozen), false);
      let run: LocalRunOutcome;
      try { run = await finishLocalCandidate(local, flight.candidate, flight.resumed, flight.settled.validation); }
      catch (error) {
        flights.delete(local);
        return failed({ ...inFlightBase, inFlight: false }, `${flight.resumed ? 'Resuming' : 'Cut'} candidate ${flight.candidate.id} (${short(flight.candidate.sha)}) failed after UAT: ${message(error)}`);
      }
      flights.delete(local);
      let after = { ...inFlightBase, inFlight: false };
      try { after = { ...after, ...await readLedger(), ledgerReadAt: new Date(Date.now()).toISOString() }; } catch { /* the next window re-reads it */ }
      return done(after, `${flight.resumed ? `Resumed candidate ${flight.candidate.id}: ` : `Cut candidate ${flight.candidate.id} at ${short(flight.candidate.sha)}: `}${run.detail}`, true, { run });
    }
    // Stamp without a WeakMap flight (process restart): resume from the ledger on the next cut read.
  }

  // GY-1519 / AC-5: the freeze holds every new local step; a tip the watch has not classified waits for it.
  if (options.frozen) return done({ ...base, inFlight: false }, promotionFrozenReason(options.frozen), false);
  if (options.watchedTip !== undefined && options.watchedTip !== ledger.mainSha) return done({ ...base, inFlight: false }, `The main watch has not classified the base branch tip ${short(ledger.mainSha)} yet; the cut waits for its verdict`, true);
  const sinceLast = base.lastDispatchAt ? options.now - Date.parse(base.lastDispatchAt) : Number.POSITIVE_INFINITY;
  if (sinceLast < everyMs && !previous?.inFlight) return done({ ...base, inFlight: false }, `The last candidate was cut ${Math.round(sinceLast / 60_000)} minute(s) ago; the next is due no sooner than ${options.everyMinutes} minute(s) after it`, true);
  // The cut rule is read once a run-read window, like the workflow's runs are in github mode.
  if (base.runsReadAt && options.now - Date.parse(base.runsReadAt) < windows.runsMs && !previous?.inFlight) return done({ ...base, inFlight: false }, previous?.reason ?? 'The cut rule is read once a minute; nothing is due yet', true);
  let history: CutCommit[];
  try { history = await local.history(); } catch (error) { return failed({ ...base, runsReadAt: at, inFlight: false }, `The base branch history could not be read for the cut rule: ${message(error)}`); }
  const assessment = assessCut(ledger, history, options.now, local.settings);
  // After a crash that left inFlight, ask only for a resumable candidate so nothing is re-cut.
  const due = previous?.inFlight ? false : assessment.due;
  let decided: Awaited<ReturnType<LocalReleasePorts['cut']>>;
  try { decided = await local.cut(due); } catch (error) { return failed({ ...base, runsReadAt: at, inFlight: false }, `The release candidate could not be cut: ${message(error)}`); }
  if (!decided.cut && !('resume' in decided)) {
    return done({ ...base, runsReadAt: at, inFlight: false }, previous?.inFlight ? `A candidate was in flight but nothing is left to resume: ${decided.reason}` : assessment.due ? `${assessment.reason}, but nothing was cut: ${decided.reason}` : assessment.reason, !assessment.due && assessment.merges > 0);
  }
  const candidate = decided.cut ? decided.candidate : decided.resume, resumed = !decided.cut;
  // Stamp inFlight before the long work so a budget-deferred cycle still reports the candidate.
  const attempted = { ...base, runsReadAt: at, dispatchedAt: at, lastDispatchAt: at, cutSha: candidate.sha, candidateAtDispatch: candidate.id, inFlight: true };
  const pending: LocalFlight = { candidate, resumed, settled: null, work: Promise.resolve() };
  pending.work = validateLocalCandidate(local, candidate).then(
    validation => { pending.settled = { validation }; },
    error => { pending.settled = { error: `${resumed ? 'Resuming' : 'Cut'} candidate ${candidate.id} (${short(candidate.sha)}) failed before a verdict was recorded; it is resumed at the next read: ${message(error)}` }; },
  );
  flights.set(local, pending);
  return done(attempted, `${resumed ? 'Resumed' : 'Cut'} candidate ${candidate.id} (${short(candidate.sha)}); UAT validation is in flight`, true, { dispatched: true });
}
