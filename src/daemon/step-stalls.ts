// Concern: loop-step stall signatures (GY-1854) and upstream filing of uncleared stalls (GY-1855) — normalised signature, three-cycle stall, bound remedy, master wake, five-minute backoff, and one upstream item per signature past the clearing bound.
import { createHash } from 'node:crypto';
import { chmod, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { runChild } from '../child-runner.js';
import type { ActionableSubject } from './metrics.js';
import { message, type DaemonAction, type DaemonState, type StepStall, type StepStallRemedyRecord } from './state.js';
import { applyStepStallRemedy, stepStallRemedy, type BoundStepStallRemedy, type StepStallRemedyKind, type StepStallRemedyOutcome } from '../stall-remedies.js';
import type { MasterConfig } from '../master.js';
import { agentToken } from '../master/autonomy.js';
import { agentOwner, type AttentionItem } from '../master/attention.js';
import type { DaemonEffects } from './effects.js';
import { record } from './preserve.js';
import { readyToRetry } from './sessions.js';
import { mergeRecordKey, pushEnvironment } from '../merge-writer/executor.js';
import { externalCredential, loadMasterConfig, readCredentialFile } from '../master/config.js';
import { serverOrigin } from '../repository-setup.js';
import type { Work } from '../model.js';
import { RefusedResponse } from '../model/refusal.js';
import { planeWideRefusal } from '../model/blocker-class.js';
import { configuredProfileFingerprint, readReviewerProfileRefusal, type ReviewerProfileRefusal } from '../reviewer.js';
import { mergeWriterSettings } from '../master/merge-writer-settings.js';
import { installIdFor } from '../install/types.js';
import { installDirectory } from '../install/secrets.js';
import { DEPLOY_KEY_FILE, ensureDeployKey } from '../install/deploy-key.js';
import { githubCli } from '../install/github.js';
import { localTransport } from '../install/transport.js';
import { DispatchReservedError } from '../master/dispatch-reservation.js';
import { setupAgentEnvironments } from '../master/environments.js';

/** Consecutive cycles one signature must fail for the run to be recorded as one stall (GY-1854 AC-1). */
export const stallCycleBound = 3;
/** A stalled call is attempted at most once per five minutes while its stall stands (GY-1854 AC-1): */
export const stallBackoffMs = 5 * 60_000;
/** The most a signature holds: the step and the normalised error text. */
export const stallSignatureMax = 800;
/** The most runs the cursor keeps: a run the current cycle failed in first, then standing stalls, then the newest; a cycle failing more distinct ways than this folds the rest into one overflow run. */
export const retainedStepStalls = 200;

/** Everything that differs between attempts of one cause is taken out of a signature. */
const uuids = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A commit id: hex with at least one letter, so a long digit run stays a number for the pass below. */
const shas = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi;
/** Numbers not already inside a `<…>` token: the 401 the credential remedy binds to keeps its token. */
const numbers = /(?<!<)\d+/g;

/** The normalised signature of a failing loop step or dispatcher call: the step and the error text with everything that differs between attempts of one cause taken out — UUIDs,… */
export function stallSignature(step: string, error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error ?? '')).replace(/\s+/g, ' ').trim();
  return `${step}: ${text}`.replace(uuids, '<id>').replace(shas, '<sha>').replace(/\b401\b/g, '<unauthorized>').replace(numbers, 'N').slice(0, stallSignatureMax);
}

/** The refusal a held call's port answers with; `noteStepFailure` counts a text carrying it as nothing (the hold is the tracker speaking, not the fault failing again). */
export const stallHoldMarker = 'stalled call held to its five-minute window';
/** Whether a failure text is a held call's hold answer, never a fault to count. */
export const isStallHold = (text: unknown): boolean => typeof text === 'string' && text.includes(stallHoldMarker);

/** The hold one stalled step's call is under right now: until when, and the refusal its port answers with. */
export interface StallHold { step: string; signature: string; until: number; reason: string }

/** The five-minute window one stalled call's retry is held to (GY-1854 AC-1): while a stall of `step` stands with `now < nextAttemptAt`, its owning step attempts the call at most… */
export function stallHold(state: DaemonState, step: string, now: number): StallHold | null {
  let hold: StallHold | null = null;
  for (const run of Object.values(state.stepStalls)) {
    if (run.step !== step || !run.stalledAt || !run.nextAttemptAt) continue;
    const until = Date.parse(run.nextAttemptAt);
    if (!Number.isFinite(until) || now >= until) continue;
    if (!hold || until < hold.until) {
      hold = { step, signature: run.signature, until, reason: `${stallHoldMarker}: the ${step} call stands stalled since ${run.stalledAt} and is attempted again at ${run.nextAttemptAt}` };
    }
  }
  return hold;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error ?? ''));

/** What one counted failure carries, or the nothing a hold or a run the cycle ended leaves. */
export interface StepStallNote { run: StepStall; counted: boolean; stalled: boolean; bound: BoundStepStallRemedy | null }

const heldNote = (step: string, error: unknown): StepStallNote =>
  ({ run: { signature: stallSignature(step, error), step, count: 0, lastCycle: 0, firstAt: '', lastAt: '', lastError: errorText(error).slice(0, 1000), stalledAt: null, remedy: null, nextAttemptAt: null, attemptAt: null, calls: [], cycle: false }, counted: false, stalled: false, bound: null });

/** One failure of a loop step or dispatcher call, under the signature it signs: the run advances at most one count per cycle — several actions of one step failing the same way in a… */
export function noteStepFailure(state: DaemonState, step: string, error: unknown, now: number, cycle: number, options: { cycleCall?: boolean } = {}): StepStallNote {
  // A held call's hold answer counts nothing: the tracker speaking, not the fault failing again.
  if (isStallHold(error)) return heldNote(step, error);
  const signature = stallSignature(step, error), at = new Date(now).toISOString();
  const previous = state.stepStalls[signature];
  const continued = !!previous && previous.step === step;
  const sameCycle = continued && cycle === previous.lastCycle, consecutive = continued && cycle === previous.lastCycle + 1;
  // A standing stall continues across the cycles its call was held: a held cycle is not a gap.
  const standing = continued && !!previous.stalledAt;
  // The admitted attempt's own failure is the window's one failure: it counts, and the window
  // that admission armed stands. Any other failure inside the window moves only the last error.
  const attempted = standing && !!previous.attemptAt && !sameCycle;
  const backingOff = standing && !attempted && previous.nextAttemptAt !== null && now < Date.parse(previous.nextAttemptAt);
  const run: StepStall = continued && (sameCycle || consecutive || standing)
    ? { ...previous, count: sameCycle || backingOff ? previous.count : previous.count + 1, lastCycle: Math.max(previous.lastCycle, cycle), lastAt: at, lastError: errorText(error).slice(0, 1000), attemptAt: attempted ? null : previous.attemptAt }
    : { signature, step, count: 1, lastCycle: cycle, firstAt: at, lastAt: at, lastError: errorText(error).slice(0, 1000), stalledAt: null, remedy: null, nextAttemptAt: null, attemptAt: null, calls: [], cycle: false };
  if (options.cycleCall) run.cycle = true;
  const stalled = run.count >= stallCycleBound && run.stalledAt === null;
  if (stalled) run.stalledAt = at;
  const armed = attempted && previous.nextAttemptAt !== null && now < Date.parse(previous.nextAttemptAt);
  if (stalled || (run.stalledAt && !backingOff && !armed)) run.nextAttemptAt = new Date(now + stallBackoffMs).toISOString();
  state.stepStalls[signature] = run;
  pruneStepStalls(state, cycle);
  return { run, counted: !sameCycle && !backingOff, stalled, bound: run.stalledAt ? stepStallRemedy(signature) : null };
}

/** Admits a held call's one attempt per window (GY-1854 AC-1): while a stall of `step` stands with `now < nextAttemptAt` the call is held and the hold is answered; */
export function admitStalledCall(state: DaemonState, step: string, now: number): StallAdmission {
  const hold = stallHold(state, step, now);
  if (hold) return { hold, armed: false };
  let armed = false;
  for (const run of Object.values(state.stepStalls)) {
    if (run.step !== step || !run.stalledAt) continue;
    run.attemptAt = new Date(now).toISOString();
    run.nextAttemptAt = new Date(now + stallBackoffMs).toISOString();
    armed = true;
  }
  return { hold: null, armed };
}


/** Admits the next cycle of a loop whose failed cycles stalled on one of its own calls (GY-1854 AC-1) — the snapshot read every step waits on, which no effect hold can reach because… */
export function admitStalledCycle(state: DaemonState, now: number): StallAdmission {
  const runs = Object.values(state.stepStalls).filter(run => run.cycle && run.stalledAt);
  let hold: StallHold | null = null;
  for (const run of runs) {
    const until = run.nextAttemptAt ? Date.parse(run.nextAttemptAt) : Number.NaN;
    if (Number.isFinite(until) && now < until && (!hold || until < hold.until))
      hold = { step: run.step, signature: run.signature, until, reason: `${stallHoldMarker}: the failed cycles stand stalled on the ${run.step} call since ${run.stalledAt}, so the next cycle runs at ${run.nextAttemptAt}` };
  }
  if (hold) return { hold, armed: false, signatures: [] };
  for (const run of runs) { run.attemptAt = new Date(now).toISOString(); run.nextAttemptAt = new Date(now + stallBackoffMs).toISOString(); }
  return { hold: null, armed: runs.length > 0, signatures: runs.map(run => run.signature) };
}

/** What admitting a call answered: the hold it is under, or none — and whether the admission armed a standing stall's next window (the runs it armed named), which the caller persists before the call is made. */
export interface StallAdmission { hold: StallHold | null; armed: boolean; signatures?: string[] }

/** The steps whose stall is held at the step itself — the dispatcher's launch and the merge writer's start — rather than at the effect calls it carries. */
const stepHeldSteps: ReadonlySet<string> = new Set(['dispatch', 'merge']);
/** The effects never held: the cursor write, the cycle's own read (held cycle-wide, `admitStalledCycle`), the dispatcher's launch (held at its step) and plain data. */
const unheldEffects: ReadonlySet<string> = new Set(['persist', 'snapshot', 'dispatch', 'mergeWriter', 'loadedRelease']);
/** The effect calls that failed since the stall step last ran, by state: what a failed action's detail is matched against to name the call that failed. */
const failedCalls = new WeakMap<DaemonState, { call: string; async: boolean; resource: string | null; text: string }[]>();
const flatText = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The resource one effect invocation acts on, read off its first argument: a string or number as itself, an object by its `key`, `pane_id`, `id` or `name` (a work item, a pane, a… */
export function callResource(args: readonly unknown[]): string | null {
  const first = args[0];
  if (typeof first === 'string' || typeof first === 'number') return String(first).slice(0, 200);
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    for (const field of ['key', 'pane_id', 'id', 'name']) {
      const value = (first as Record<string, unknown>)[field];
      if (typeof value === 'string' && value) return value.slice(0, 200);
    }
  }
  return null;
}

/** Whether a run's held call entry is this invocation: the same call, and the same resource unless the failing invocation named none. */
const sameInvocation = (entry: StepStall['calls'][number], call: string, resource: string | null) =>
  entry.call === call && (entry.resource === null || entry.resource === resource);

/** Notes one effect call's failure, so the stall step can name the invocation a failed action carries. A hold's own answer, or a failure with no text at all, names nothing. */
export function noteCallFailure(state: DaemonState, call: string, error: unknown, async: boolean, resource: string | null = null): void {
  const text = flatText(errorText(error)).slice(0, 300);
  if (!text || isStallHold(text)) return;
  const list = failedCalls.get(state) ?? failedCalls.set(state, []).get(state)!;
  if (list.length < 50 && !list.some(entry => entry.call === call && entry.resource === resource && entry.text === text)) list.push({ call, async, resource, text });
}

/** Whether a failed action's detail carries one call's failure text: the text stands in the detail as a whole — never as the inside of a longer word — however short it is. */
export const detailCarries = (detail: string, text: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u').test(detail);

/** The stalled runs holding one invocation of `call`. */
export const stallsHolding = (state: DaemonState, call: string, resource: string | null): StepStall[] =>
  Object.values(state.stepStalls).filter(run => run.stalledAt && run.calls.some(entry => sameInvocation(entry, call, resource)));

/** Admits one effect invocation of a stalled run (GY-1854 AC-1): the generic form of `admitStalledCall` for every step whose failing call is an effect — the host's reclaim, a… */
export function admitStalledEffect(state: DaemonState, call: string, now: number, resource: string | null = null): StallAdmission {
  const runs = stallsHolding(state, call, resource);
  let hold: StallHold | null = null;
  for (const run of runs) {
    const until = run.nextAttemptAt ? Date.parse(run.nextAttemptAt) : Number.NaN;
    if (Number.isFinite(until) && now < until && (!hold || until < hold.until))
      hold = { step: run.step, signature: run.signature, until, reason: `${stallHoldMarker}: the ${call} call${resource ? ` for ${resource}` : ''} the ${run.step} step stands stalled on since ${run.stalledAt} is attempted again at ${run.nextAttemptAt}` };
  }
  if (hold) return { hold, armed: false, signatures: [] };
  for (const run of runs) { run.attemptAt = new Date(now).toISOString(); run.nextAttemptAt = new Date(now + stallBackoffMs).toISOString(); }
  return { hold: null, armed: runs.length > 0, signatures: runs.map(run => run.signature) };
}

/** Whether the stalls holding an invocation saw it fail as a promise (the hold is then a rejection, and the admission is persisted before the call) rather than synchronously. */
const callIsAsync = (state: DaemonState, call: string, resource: string | null) =>
  stallsHolding(state, call, resource).some(run => run.calls.some(entry => sameInvocation(entry, call, resource) && entry.async));

/** An admitted invocation that answered: it no longer fails, so the runs holding exactly it let it go — another resource of the same call answering lets nothing go — and a run… */
export function noteCallAnswered(state: DaemonState, call: string, resource: string | null = null): void {
  for (const run of Object.values(state.stepStalls)) {
    if (!run.stalledAt || !run.attemptAt || !run.calls.some(entry => sameInvocation(entry, call, resource))) continue;
    run.calls = run.calls.filter(entry => !sameInvocation(entry, call, resource));
    run.attemptAt = null;
    if (!run.calls.length && !stepHeldSteps.has(run.step)) run.nextAttemptAt = null;
  }
}

/** Ends every run the completed cycle did not fail in: one clean cycle breaks the consecutive chain, and its stall with it. */
export function noteStepsSucceeded(state: DaemonState, cycle: number, now?: number): number {
  let cleared = 0;
  for (const [signature, run] of Object.entries(state.stepStalls)) {
    if (run.lastCycle >= cycle) continue;
    if (run.stalledAt && (run.attemptAt || run.calls.length || (run.nextAttemptAt && now !== undefined && Date.parse(run.nextAttemptAt) > now))) continue;
    delete state.stepStalls[signature];
    cleared += 1;
  }
  return cleared;
}

/** The cursor keeps at most `retainedStepStalls` runs. A run the current cycle failed in is never the one dropped — `noteCycleStalls` folds a cycle's failures past the bound into one… */
export function pruneStepStalls(state: DaemonState, cycle?: number): void {
  const entries = Object.entries(state.stepStalls);
  if (entries.length <= retainedStepStalls) return;
  const rank = (run: StepStall) => (cycle !== undefined && run.lastCycle >= cycle ? 2 : 0) + (run.stalledAt ? 1 : 0);
  state.stepStalls = Object.fromEntries(entries.sort((a, b) => rank(b[1]) - rank(a[1]) || Date.parse(b[1].lastAt) - Date.parse(a[1].lastAt)).slice(0, retainedStepStalls));
}

/** The step a cycle's failures past the cursor's bound are signed as, one run for all of them, so recurring overflow still stalls and wakes the master. */
export const overflowStep = 'stall-overflow';

/** A cycle's failed actions, one per signature, fitted to the cursor's bound: runs already on the cursor are continued first (the most advanced first), new signatures in their order,… */
function fitCycleFailures(state: DaemonState, failed: readonly { kind: string; detail: string }[]): { kind: string; detail: string }[] {
  const distinct = new Map<string, { kind: string; detail: string }>();
  for (const action of failed) { const signature = stallSignature(action.kind, action.detail); if (!distinct.has(signature)) distinct.set(signature, action); }
  const room = retainedStepStalls - 1;
  if (distinct.size <= room) return failed.slice();
  const ordered = [...distinct].sort(([a], [b]) => (state.stepStalls[b]?.count ?? 0) - (state.stepStalls[a]?.count ?? 0));
  const kept = new Set(ordered.slice(0, room).map(([signature]) => signature));
  const over = ordered.slice(room).map(([, action]) => action);
  const steps = [...new Set(over.map(action => action.kind))].sort().join(', ').slice(0, 300);
  return [...failed.filter(action => kept.has(stallSignature(action.kind, action.detail))),
    { kind: overflowStep, detail: `${over.length} more distinct failing signatures in one cycle than the ${room} the cursor keeps a run for, from the steps ${steps}` }];
}

/** The port one bound remedy runs through: it applies the remedy for the stalled run and answers whether its verification held. */
export type StepStallRemedyRunner = (kind: StepStallRemedyKind, stall?: StepStall) => Promise<StepStallRemedyOutcome>;

/** Applies the stalled run's bound remedy once and records the attempt on it: a run already carrying one is applied nothing (one attempt per run, whoever asks). */
export async function remedyStepStall(state: DaemonState, signature: string, runner: StepStallRemedyRunner, now: number, persist?: (state: DaemonState) => Promise<void>): Promise<StepStallRemedyRecord | null> {
  const stall = state.stepStalls[signature];
  if (!stall?.stalledAt || stall.remedy) return null;
  const bound = stepStallRemedy(signature);
  if (!bound) return null;
  const at = new Date(now).toISOString();
  stall.remedy = { kind: bound.kind, at, outcome: 'started', verified: false, detail: `The ${bound.kind} remedy was started at ${at} and its outcome was never recorded: the process ended during it` };
  if (persist) {
    try { await persist(state); } catch { stall.remedy = null; return null; }
  }
  const outcome = await applyStepStallRemedy(bound.kind, kind => runner(kind, stall));
  // The run object may have been replaced while the remedy ran; the record lands on the live one.
  const live = state.stepStalls[signature] ?? stall;
  live.remedy = { kind: bound.kind, at, outcome: outcome.outcome, verified: outcome.verified, detail: outcome.detail.slice(0, 2000) };
  return live.remedy;
}

/** Applies every stalled, unremedied and bound run's remedy once, each attempt written through `persist` before it runs; answers what was applied. */
export async function remedyStalledSteps(state: DaemonState, runner: StepStallRemedyRunner, now: number, persist?: (state: DaemonState) => Promise<void>): Promise<{ signature: string; record: StepStallRemedyRecord }[]> {
  const applied: { signature: string; record: StepStallRemedyRecord }[] = [];
  for (const signature of Object.keys(state.stepStalls)) {
    const record = await remedyStepStall(state, signature, runner, now, persist);
    if (record) applied.push({ signature, record });
  }
  return applied;
}

/** The subject key one stall rides the master wake as, hashed off its signature so a standing stall is never a second subject. */
export const stallSubjectKey = (signature: string) => `stall:${createHash('sha256').update(signature).digest('hex').slice(0, 12)}`;

/** Whether a stall needs the master session: no remedy binds to it, or its one bound remedy was refused or did not verify, or a verified remedy has stood through a second full run of… */
export function stallNeedsMaster(stall: StepStall): boolean {
  if (!stall.stalledAt) return false;
  if (!stall.remedy) return true;
  return stall.remedy.outcome === 'refused' || !stall.remedy.verified || stall.count >= 2 * stallCycleBound;
}

/** Past this many consecutive failing cycles an uncleared stall files its one upstream item (GY-1855 AC-2): woken at three, the master session holds one full stall-length more. */
export const stallUpstreamCycles = 2 * stallCycleBound;
/** Whether a standing stall files its one upstream item: it still needs the master session and stood past the bound. */
export const stallFilesUpstream = (stall: StepStall): boolean => stallNeedsMaster(stall) && stall.count >= stallUpstreamCycles;

/** The task an unbound stall wakes the master session with: the signature, the step, the stall's own recording instant, and the remedy attempt when one was made (GY-1854 AC-1). */
export function stallWakeTask(stall: StepStall, cliPath: string): string {
  const remedy = !stall.remedy ? ''
    : stall.remedy.outcome === 'started' ? ` Its ${stall.remedy.kind} remedy was started once at ${stall.remedy.at} and never reported: ${stall.remedy.detail}`
      : ` Its ${stall.remedy.kind} remedy was applied once at ${stall.remedy.at} and ${stall.remedy.outcome}${stall.remedy.verified ? ', verified' : ', unverified'}: ${stall.remedy.detail}`;
  return `Loop-step stall: the ${stall.step} call failed with one signature on ${stallCycleBound} consecutive cycles and stands stalled since ${stall.stalledAt}.${remedy} Step: ${stall.step}. Signature: ${stall.signature}. The call is attempted at most once per five minutes while this stands. Run node ${cliPath} master status (daemon.stepStalls, subject ${stallSubjectKey(stall.signature)}) for the failing attempts so far, judge the cause, and clear it or file what does.`;
}

/** The stalls that need the master session, as master-wake subjects the digest machinery wakes once per changed task. */
export function stallWakeSubjects(state: DaemonState, cliPath: string): ActionableSubject[] {
  return Object.values(state.stepStalls).filter(stallNeedsMaster)
    .map(stall => ({ key: stallSubjectKey(stall.signature), kind: 'wake' as const, work: null, detail: stallWakeTask(stall, cliPath) }));
}

/** The stall bookkeeping one completed cycle owes (GY-1854), run beside the cycle's result: */
export function noteCycleStalls(state: DaemonState, actions: readonly (Pick<DaemonAction, 'kind' | 'state' | 'detail'> | StepFailure)[], cycle: number, now: number): { notes: StepStallNote[]; cleared: number } {
  const calls = failedCalls.get(state) ?? [];
  failedCalls.delete(state);
  const failed = fitCycleFailures(state, actions.filter(action => action.state === 'failed' && !isStallHold(action.detail)));
  const notes = failed.map(action => {
    const note = noteStepFailure(state, action.kind, action.detail, now, cycle), detail = flatText(action.detail);
    for (const entry of calls) {
      if (!detailCarries(detail, entry.text) || note.run.calls.some(known => known.call === entry.call && known.resource === entry.resource) || note.run.calls.length >= 8) continue;
      note.run.calls = [...note.run.calls, { call: entry.call, async: entry.async, resource: entry.resource }];
    }
    return note;
  });
  let cleared = 0;
  const failedSteps = new Set(notes.map(note => note.run.step));
  for (const [signature, run] of Object.entries(state.stepStalls)) {
    // A completed cycle made every cycle-level call (the snapshot read) and it answered.
    const answered = run.cycle && run.lastCycle < cycle;
    const landed = run.stalledAt && run.attemptAt && stepHeldSteps.has(run.step) && !failedSteps.has(run.step) && actions.some(action => action.kind === run.step && action.state === 'done');
    if (!answered && !landed) continue;
    delete state.stepStalls[signature];
    cleared += 1;
  }
  return { notes, cleared: cleared + noteStepsSucceeded(state, cycle, now) };
}

/** A failure the cycle owes the stall step beside its recorded actions: a call no action row carries. */
export interface StepFailure { kind: string; state: 'failed'; detail: string }

/** The step a review launch refused for an unknown reviewer profile signs as (GY-1854). */
export const reviewLaunchStep = 'review-launch';

/** The review-launch failure one cycle owes the stall step: the refusal the launch boundary recorded, while it stands against the profiles this loop has configured, signed exactly as… */
export function reviewerProfileFailures(refusal: ReviewerProfileRefusal | null, config: Pick<MasterConfig, 'workers' | 'reviewers'>): StepFailure[] {
  if (!refusal || refusal.profiles !== configuredProfileFingerprint(config)) return [];
  return [{ kind: reviewLaunchStep, state: 'failed', detail: `Unknown reviewer profile ${refusal.profile}` }];
}

/** Reads the launch boundary's unknown-reviewer-profile record and answers the failure it owes; an unreadable record owes nothing. */
export async function readReviewerProfileFailures(config: Pick<MasterConfig, 'credentialFile' | 'workers' | 'reviewers'>): Promise<StepFailure[]> {
  return reviewerProfileFailures(await readReviewerProfileRefusal(config).catch(() => null), config);
}

/** Judges the report the profile write answered with (GY-1854): applied when it wrote at least one profile change, verified when the write landed and no credential was skipped unread. */
export function profileRemedyOutcome(report: { applied?: boolean; profiles?: unknown[]; skipped?: { reason: string }[]; next?: string }): StepStallRemedyOutcome {
  const profiles = report.profiles?.length ?? 0, skipped = report.skipped?.length ?? 0;
  return {
    outcome: profiles ? 'applied' : 'unchanged',
    verified: report.applied === true && profiles > 0 && skipped === 0,
    detail: `${profiles} profile change(s) written${skipped ? `, ${skipped} credential(s) skipped: ${report.skipped!.map(entry => entry.reason).join('; ')}` : ''}: ${report.next ?? 'no report'}`.slice(0, 2000),
  };
}

/** The verification a review-launch stall's profile remedy owes (GY-1854): the write is verified only when the reviewer profile the refused launches named is configured once it… */
export function profileRemedyVerification(outcome: StepStallRemedyOutcome, stall: StepStall | undefined, configured: Pick<MasterConfig, 'reviewers'>): StepStallRemedyOutcome {
  if (!stall || stall.step !== reviewLaunchStep) return outcome;
  const named = /Unknown reviewer profile (\S+)/.exec(stall.lastError)?.[1] ?? null;
  const present = !!named && configured.reviewers.some(profile => profile.name === named);
  return { ...outcome, verified: present,
    detail: `${outcome.detail}; reviewer profile ${named ?? '(unnamed)'} is ${present ? 'configured now, so the next review launch finds it' : 'still not configured after the write, so review launches asking for it are still refused'}`.slice(0, 2000) };
}

/** The profile remedy's ports: the write `master environments --apply` makes, and the configuration it produced, read back. */
export interface ProfileRemedyPorts {
  apply(): Promise<Parameters<typeof profileRemedyOutcome>[0]>;
  configured(): Promise<Pick<MasterConfig, 'reviewers'>>;
}

/** Adopts the server's merge ledger for a refused merge record (GY-1854), and answers whether the next attempt records under a key that was never sent. */
export function mergeLedgerAdoption(state: DaemonState, work: readonly { key: string; id: string; mergeLedger?: { events: number } | null }[], refused: { key: string; head: string; at: string } | null): StepStallRemedyOutcome {
  if (!refused) return { outcome: 'refused', verified: false, detail: 'No failed merge action carrying a reused record key stands on the cursor, so nothing was adopted' };
  const item = work.find(entry => entry.key === refused.key);
  const events = item?.mergeLedger?.events ?? null;
  const marker = state.mergeWriter.inFlight;
  const stale = !!marker && marker.key === refused.key && marker.head === refused.head && Date.parse(marker.startedAt) < Date.parse(refused.at);
  if (stale) state.mergeWriter.inFlight = null;
  // A replay of the item's writes would send the refused key again: until its answer is settled, the adoption cannot claim a fresh key. The refused attempt's…
  const replay = state.mergeWriter.unconfirmed?.find(entry => entry.key === refused.key) ?? null;
  const verified = events !== null && !replay;
  const derivation = item && events ? ` — the next attempt-free record for it derives ${mergeRecordKey({ id: item.id, mergeLedger: item.mergeLedger ?? null }, { kind: 'refused', head: refused.head, reason: 'adopted' })}, a derivation the pre-adoption ledger never gave` : '';
  return { outcome: 'applied', verified,
    detail: `Adopted the server's merge ledger for ${refused.key} (${events === null ? 'no folded ledger read' : `${events} events`})${derivation}; the refused attempt's in-flight marker is ${stale ? 'cleared' : 'already gone'}, so the next flight mints a fresh attempt id${replay ? `; a replay of its writes still stands, so the refused key may be sent once more` : ' and no replay of its writes stands, so the refused key is never sent again'}`.slice(0, 2000) };
}

/** What the plane answers one credential file with: the principal it authenticates as, a refusal (401), or no reading. */
export interface CredentialReading { state: 'ok' | 'refused' | 'unknown'; principal: string | null; detail: string }

/** The host-owned credentials the credential-401 remedy may renew (GY-1854), and how it reads and writes them. */
export interface CredentialRenewalPorts {
  /** Reads one credential file and asks the plane whom it authenticates as. */
  authenticate(file: string): Promise<CredentialReading>;
  /** The coordinator's credential file. */
  coordinator: string;
  /** Each worker and producer profile's credential file and the principal it must authenticate as. */
  profiles: { name: string; principal: string; file: string }[];
  /** The credential files the install issued on this host: the sources a refused profile credential is renewed from. */
  issued(): Promise<string[]>;
  /** Writes an issued credential into a profile's file, private (0600), replacing it in one rename. */
  adopt(from: string, to: string): Promise<void>;
  /** The merge writer's deploy key, generated when absent and registered on the repository unless listed (ensureDeployKey); answers its path. */
  renewDeployKey(): Promise<string>;
  /** Reaches the repository with the deploy key alone (git ls-remote under the push environment); throws when it cannot. */
  reachWithDeployKey(): Promise<void>;
}

/** Whether a stall's 401 is the merge writer's push credential rather than a profile's: the merge step, or a refusal naming the deploy key or a push. */
const deployKeyStall = (stall: StepStall | undefined) => !!stall && (stall.step === 'merge' || /deploy.?key|publickey|git push/i.test(stall.signature));

/** The credential-401 remedy (GY-1854): renews the host-owned credential the refusal names, once, and verifies it authenticates. */
export async function renewHostCredentials(stall: StepStall | undefined, ports: CredentialRenewalPorts): Promise<StepStallRemedyOutcome> {
  const coordinator = await ports.authenticate(ports.coordinator);
  if (coordinator.state === 'refused')
    return { outcome: 'refused', verified: false, detail: `The coordinator credential ${ports.coordinator} is refused (${coordinator.detail}): renewing it is outside the loop's authority; the operator rotates it (graphyard install --apply, or operator-agent rotate as admin)` };
  if (deployKeyStall(stall)) {
    const key = await ports.renewDeployKey();
    try { await ports.reachWithDeployKey(); }
    catch (error) { return { outcome: 'applied', verified: false, detail: `Renewed the merge writer's deploy key ${key}, but it does not reach the repository: ${errorText(error)}`.slice(0, 2000) }; }
    return { outcome: 'applied', verified: true, detail: `Renewed the merge writer's deploy key ${key} (generated when absent, registered on the repository unless listed) and reached the repository with it alone` };
  }
  const before = await Promise.all(ports.profiles.map(async profile => ({ profile, reading: await ports.authenticate(profile.file) })));
  const refused = before.filter(entry => entry.reading.state === 'refused').map(entry => entry.profile);
  if (!refused.length)
    return { outcome: 'unchanged', verified: false, detail: `No host-owned credential is refused: the coordinator credential and ${before.length} profile credential(s) read ${before.map(entry => `${entry.profile.name} ${entry.reading.state}`).join(', ') || 'nothing'}, so the 401 is not one this loop can renew` };
  const refusedFiles = new Set(refused.map(profile => profile.file));
  const sources = new Map<string, CredentialReading>();
  for (const file of await ports.issued()) if (!refusedFiles.has(file)) sources.set(file, await ports.authenticate(file));
  const renewed: string[] = [], missing: string[] = [];
  for (const profile of refused) {
    const source = [...sources].find(([, reading]) => reading.state === 'ok' && reading.principal === profile.principal)?.[0];
    if (!source) { missing.push(`${profile.name} (${profile.principal})`); continue; }
    await ports.adopt(source, profile.file);
    renewed.push(`${profile.name} from ${source}`);
  }
  const after = await Promise.all(refused.map(async profile => ({ profile, reading: await ports.authenticate(profile.file) })));
  const verified = after.every(({ profile, reading }) => reading.state === 'ok' && reading.principal === profile.principal);
  return { outcome: renewed.length ? 'applied' : 'refused', verified,
    detail: `${renewed.length ? `Renewed ${renewed.join('; ')}` : 'Renewed nothing'}${missing.length ? `; no credential issued on this host authenticates as ${missing.join(', ')}, so re-issuing it is the operator's (graphyard install --apply)` : ''}; read back: ${after.map(({ profile, reading }) => `${profile.name} ${reading.state}`).join(', ')}`.slice(0, 2000) };
}

/** The production credential ports over the loop's configuration: the plane's /api/status, the install's issued token directories, and the merge writer's deploy key. */
export function hostCredentialPorts(config: MasterConfig, root: string): CredentialRenewalPorts {
  const settings = mergeWriterSettings(config.run, installIdFor(config.repository));
  const credentialHome = dirname(dirname(config.credentialFile));
  const tokenFiles = async (folder: string) => (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith('.token')).sort().map(name => resolve(folder, name));
  return {
    coordinator: config.credentialFile,
    profiles: [...config.workers, ...config.producers].flatMap(profile => profile.credentialFile && profile.principal ? [{ name: profile.name, principal: profile.principal, file: profile.credentialFile }] : []),
    authenticate: async file => {
      let token: string;
      try { token = await readCredentialFile(file); } catch (error) { return { state: 'unknown', principal: null, detail: errorText(error) }; }
      try {
        const response = await fetch(`${config.url}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
        if (response.status === 401) return { state: 'refused', principal: null, detail: '401' };
        if (!response.ok) return { state: 'unknown', principal: null, detail: String(response.status) };
        const status = await response.json() as { actor?: { id?: unknown } };
        return { state: 'ok', principal: typeof status.actor?.id === 'string' ? status.actor.id : null, detail: 'authenticated' };
      } catch (error) { return { state: 'unknown', principal: null, detail: errorText(error) }; }
    },
    issued: async () => [...await tokenFiles(resolve(credentialHome, 'workers')), ...await tokenFiles(resolve(credentialHome, 'producers')), ...await tokenFiles(resolve(installDirectory(installIdFor(config.repository)), 'tokens'))],
    adopt: async (from, to) => {
      const next = `${to}.next`;
      await writeFile(next, `${await readCredentialFile(from)}\n`, { mode: 0o600 });
      await chmod(next, 0o600);
      await rename(next, to);
    },
    renewDeployKey: async () => {
      if (basename(settings.deployKeyFile) !== DEPLOY_KEY_FILE) throw new Error(`the configured deploy key ${settings.deployKeyFile} is not the install's own; renewing it is the operator's`);
      return ensureDeployKey(dirname(settings.deployKeyFile), config.repository, githubCli(localTransport()));
    },
    reachWithDeployKey: async () => {
      await runChild('git', ['-C', root, 'ls-remote', '--exit-code', 'origin', `refs/heads/${config.baseBranch}`], { env: pushEnvironment(settings.deployKeyFile), timeoutMs: 60_000 });
    },
  };
}

/** The stall step's own remedy ports (GY-1854): the loop writes the agent profiles exactly as `master environments --apply` does, renews the host-owned credential a 401 names… */
export function stallRemedyRunner(config: () => MasterConfig, state: () => DaemonState, read: DaemonEffects['snapshot'], root: () => string, credentials?: () => CredentialRenewalPorts, profiles?: () => ProfileRemedyPorts): StepStallRemedyRunner {
  return async (kind, stall) => {
    if (kind === 'profile-unknown') {
      const ports: ProfileRemedyPorts = profiles ? profiles() : {
        apply: () => setupAgentEnvironments(root(), { apply: true, verify: async token => {
          const response = await fetch(`${config().url}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
          return response.json();
        } }),
        configured: () => loadMasterConfig(root()),
      };
      const outcome = profileRemedyOutcome(await ports.apply());
      return stall?.step === reviewLaunchStep ? profileRemedyVerification(outcome, stall, await ports.configured()) : outcome;
    }
    if (kind === 'merge-record-idempotency') {
      // The refused attempt is the newest failed merge action that carries the refusal — the writer's settle wording ("a record key reused") or the engine's…
      const refused = Object.values(state().actions)
        .filter(action => action.kind === 'merge' && action.state === 'failed' && /key reused with different input/i.test(action.detail))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
      const named = refused ? /Merge of (\S+) head ([0-9a-f]+)/i.exec(refused.detail) : null;
      return mergeLedgerAdoption(state(), (await read()).work, refused && named ? { key: named[1], head: named[2].toLowerCase(), at: refused.at } : null);
    }
    return renewHostCredentials(stall, credentials ? credentials() : hostCredentialPorts(config(), root()));
  };
}

/** The stalled calls' hold, composed over the loop's own effects (GY-1854 AC-1): while a stall stands inside its five-minute window, its failing call is attempted at most once per… */
export function stallHeldEffects<T extends DaemonEffects>(effects: T, state: () => DaemonState, now: () => number, persist?: (state: DaemonState) => Promise<void>): T {
  const wrapped = new Map<string, { value: unknown; held: unknown }>();
  // The synchronous admissions whose armed window reached the cursor and whose attempt is not yet
  // made: signature → the admission instant it was written under.
  const durable = new Map<string, string>();
  const hold = (name: string, value: Function): Function => {
    if (name === 'dispatch') return async (...args: Parameters<DaemonEffects['dispatch']>) => {
      const admission = admitStalledCall(state(), 'dispatch', now());
      if (admission.hold) throw new DispatchReservedError('work', args[0].key, admission.hold.reason);
      if (admission.armed && persist) await persist(state());
      return value(...args);
    };
    const make = (resource: string | null, args: unknown[]) => {
      let result: unknown;
      try { result = value(...args); } catch (error) { noteCallFailure(state(), name, error, false, resource); throw error; }
      if (!(result instanceof Promise)) { noteCallAnswered(state(), name, resource); return result; }
      return result.then(answer => { noteCallAnswered(state(), name, resource); return answer; }, error => { noteCallFailure(state(), name, error, true, resource); throw error; });
    };
    return (...args: unknown[]) => {
      const resource = callResource(args), async = callIsAsync(state(), name, resource);
      const admission = admitStalledEffect(state(), name, now(), resource);
      if (admission.hold) {
        // A synchronous admission whose window is on the cursor makes the window's one attempt.
        const runs = stallsHolding(state(), name, resource);
        if (!async && runs.length && runs.every(run => run.attemptAt && durable.get(run.signature) === run.attemptAt)) {
          for (const run of runs) durable.delete(run.signature);
          return make(resource, args);
        }
        const error = new Error(admission.hold.reason);
        if (async) return Promise.reject(error);
        throw error;
      }
      if (!admission.armed || !persist) return make(resource, args);
      if (async) return persist(state()).then(() => make(resource, args));
      const armed = (admission.signatures ?? []).map(signature => [signature, state().stepStalls[signature]?.attemptAt ?? null] as const);
      void persist(state()).then(() => { for (const [signature, at] of armed) if (at) durable.set(signature, at); }, () => undefined);
      throw new Error(`${stallHoldMarker}: the ${name} call${resource ? ` for ${resource}` : ''} is admitted for its window, and is made once that window is on the cursor`);
    };
  };
  /** A structured port with each of its methods held as `port.method`, applied to the port itself. */
  const holdPort = (property: string, port: object, override: Record<string, unknown> = {}) => new Proxy(port, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in override) return override[key];
      const member = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || typeof member !== 'function') return member;
      const name = `${property}.${key}`;
      const known = wrapped.get(name);
      if (known && known.value === member) return known.held;
      const held = hold(name, (...args: unknown[]) => member.apply(target, args));
      wrapped.set(name, { value: member, held });
      return held;
    },
  });
  return new Proxy(effects, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !value) return value;
      if (property === 'mergeWriter' || (typeof value === 'object' && !Array.isArray(value) && !unheldEffects.has(property))) {
        const known = wrapped.get(property);
        if (known?.value === value) return known.held;
        // The merge writer starts a merge only when admitted; its merger read runs before
        // admission on every cycle, so it is held as the call itself.
        const writer = value as unknown as NonNullable<DaemonEffects['mergeWriter']>;
        const held = property === 'mergeWriter'
          ? holdPort(property, value as object, { admit: () => (writer.admit?.() ?? true) && !admitStalledCall(state(), 'merge', now()).hold })
          : holdPort(property, value as object);
        wrapped.set(property, { value, held });
        return held;
      }
      if (typeof value !== 'function' || (unheldEffects.has(property) && property !== 'dispatch')) return value;
      const known = wrapped.get(property);
      if (known?.value === value) return known.held;
      const held = hold(property, (...args: unknown[]) => value.apply(target, args));
      wrapped.set(property, { value, held });
      return held;
    },
  });
}

/** Cursor action key for one stall's upstream filing (GY-1855): derived from its subject so a done row is the local dedup. */
export const stallUpstreamActionKey = (signature: string) => `stall-upstream:${stallSubjectKey(signature).slice('stall:'.length)}`;
/** Idempotency key for the filed item: the signature alone, so a retry or re-ask returns the one item already filed. */
export const stallUpstreamIdempotencyKey = (signature: string) => `loop-step-stall:${stallSubjectKey(signature).slice('stall:'.length)}`;

/** Item body as the create command parses it; validated before ask so a body the plane would refuse is recorded, never sent. */
export const stallUpstreamItemSchema = z.object({
  title: z.string().min(1).max(200), type: z.literal('bug'), priority: z.literal(1),
  description: z.string().min(1).max(20_000),
  criteria: z.array(z.object({ id: z.string().regex(/^AC-\d+$/), text: z.string().min(1).max(2000), proofs: z.array(z.string().min(1).max(100)).min(1).max(20) }).strict()).min(1).max(50),
  reason: z.string().min(1).max(2000),
}).strict();
export type StallUpstreamItemInput = z.infer<typeof stallUpstreamItemSchema>;

/** Pure function of the signature: same key and body forever so a retry never files a second item. Live evidence stays on the filing install. */
export function stallUpstreamItem(signature: string): StallUpstreamItemInput {
  const step = signature.includes(': ') ? signature.slice(0, signature.indexOf(': ')) : 'loop';
  return {
    title: `Loop-step stall: the ${step} call fails with one signature past its clearing bound`.slice(0, 200), type: 'bug' as const, priority: 1,
    description: [
      `The master loop filed this item itself (GY-1855): a loop step or dispatcher call failed with one normalised signature on three consecutive cycles — one stall — and the stall stood past ${stallUpstreamCycles}, so the master session woken for it had not cleared it within its bound. Exactly one item is filed per signature: this signature never files a second one.`,
      `Signature: ${signature}`,
      `Step: ${step}. While a stall stands its failing call is attempted at most once per five minutes, and a remedy the signature binds to is applied once and verified; a stall no remedy binds to is only woken for. The live evidence — the standing count, the failing attempts so far and the last error text, and the one remedy record — is on the filing install: run graphyard master status there and read daemon.stepStalls, subject ${stallSubjectKey(signature)}.`,
    ].join('\n\n'),
    criteria: [{ id: 'AC-1', text: `The ${step} call no longer fails with this signature on a release serving the filing install, or the stall is cleared within its bound before one is filed, covered by a test that pins the bound`, proofs: ['unit:loop-step-stall-cleared'] }],
    reason: `The loop-step stall with this signature stood past ${stallUpstreamCycles} consecutive failing cycles and no open item names it`,
  };
}

export type StallUpstreamFiler = (input: StallUpstreamItemInput, key: string) => Promise<Work>;

async function postStallWork(origin: string, token: string, input: StallUpstreamItemInput, key: string): Promise<Work> {
  const response = await fetch(`${origin}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
  const text = await response.text(); // GY-1751: a proxy's empty or HTML 502-504 keeps its status
  let result: any; try { result = JSON.parse(text); } catch { result = response.ok ? undefined : { text: text.slice(0, 200) }; }
  if (!response.ok) throw new RefusedResponse(`Graphyard refused work (${response.status}): ${result?.error ?? result?.text ?? text.slice(0, 200)}`, response.status, result);
  return result as Work;
}

/** Production filer: `upstream` absent files into this install as the operator-agent (slow-loop precedent); present files into the named install with its credential file. */
export function stallUpstreamFiler(config: MasterConfig, root: string): StallUpstreamFiler {
  const upstream = config.upstream;
  if (!upstream) return async (input, key) => {
    if (!config.operatorAgent) throw new Error('No master operator-agent identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply so the loop can file the stalls it cannot clear');
    return postStallWork(config.url, await agentToken(root, config, 'operatorAgent'), input, key);
  };
  return async (input, key) => {
    await externalCredential(root, upstream.credentialFile, 'Upstream filing');
    return postStallWork(serverOrigin(upstream.url), await readCredentialFile(upstream.credentialFile), input, key);
  };
}

/**
 * Filing step beside the remedies (GY-1855 AC-2): every standing stall past `stallFilesUpstream` files exactly one
 * upstream item per signature — local action-row dedup plus control-plane idempotency. Unanswered plane asks retry on backoff.
 */
export async function fileStalledStepsUpstream(state: DaemonState, filer: StallUpstreamFiler | null, now: () => number, persist: DaemonEffects['persist']): Promise<DaemonAction | null> {
  let last: DaemonAction | null = null;
  if (!filer) return last;
  const due = Object.values(state.stepStalls).filter(run => run.stalledAt && stallFilesUpstream(run)).sort((a, b) => Date.parse(a.stalledAt!) - Date.parse(b.stalledAt!));
  for (const stall of due) {
    const key = stallUpstreamActionKey(stall.signature), previous = state.actions[key];
    if (previous?.state === 'done' || (previous && !readyToRetry(previous, state.cycle))) continue;
    const short = stall.signature.slice(0, 160);
    const attempts = (previous?.attempts ?? 0) + 1;
    await record(state, key, { kind: 'fault', work: null, principal: null, state: 'started', detail: `Filing the one upstream item for the loop-step stall on the ${stall.step} call, standing since ${stall.stalledAt} past ${stallUpstreamCycles} consecutive failing cycles: ${short}`, attempts, cycle: state.cycle }, now(), persist);
    const parsed = stallUpstreamItemSchema.safeParse(stallUpstreamItem(stall.signature));
    if (!parsed.success) {
      last = await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the upstream item for the loop-step stall on the ${stall.step} call: the body does not parse as the create command reads it: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500)}`, attempts, cycle: state.cycle }, now(), persist);
      continue;
    }
    try {
      const filed = await filer(parsed.data, stallUpstreamIdempotencyKey(stall.signature));
      last = await record(state, key, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} for the loop-step stall on the ${stall.step} call (${stallUpstreamIdempotencyKey(stall.signature)}); the same signature never files a second item, and a later ask returns this one`, attempts, cycle: state.cycle }, now(), persist);
    } catch (error) {
      const unanswered = planeWideRefusal(error);
      last = await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the upstream item for the loop-step stall on the ${stall.step} call${unanswered ? ' (the control plane did not answer, so it is asked again on a later cycle)' : ''}: ${message(error)}`, attempts, cycle: state.cycle }, now(), persist, unanswered ? null : undefined);
    }
  }
  return last;
}

/** `master status` listing (GY-1855 AC-2): one attention line per standing stall with signature, count, remedy and owner. */
export function stallStatusAttention(state: DaemonState | null, cliPath: string): AttentionItem[] {
  if (!state) return [];
  return Object.values(state.stepStalls).filter(run => run.stalledAt).map(run => {
    const subject = stallSubjectKey(run.signature);
    const remedy = !run.remedy ? 'no remedy binds to it'
      : run.remedy.outcome === 'started' ? `its ${run.remedy.kind} remedy was started at ${run.remedy.at} and never reported`
        : `its ${run.remedy.kind} remedy was applied once at ${run.remedy.at} and ${run.remedy.outcome}${run.remedy.verified ? ', verified' : ', unverified'}`;
    const filed = state.actions[stallUpstreamActionKey(run.signature)];
    const upstream = stallFilesUpstream(run)
      ? (filed?.state === 'done' && filed.work ? ` Its upstream item is ${filed.work}.` : ` It stood past its ${stallUpstreamCycles}-cycle bound${filed?.state === 'failed' ? ` and its upstream filing is on its backoff (${filed.attempts} attempt(s))` : ', so its one upstream item is being filed'}.`)
      : '';
    return {
      subject,
      text: `Loop-step stall: the ${run.step} call failed ${run.count} cycle(s) with one signature, standing since ${run.stalledAt}: ${run.signature}; ${remedy}.${upstream} The stalled call is attempted at most once per five minutes while this stands.`,
      ...agentOwner('master', `node ${cliPath} master status (daemon.stepStalls, subject ${subject}) names the failing attempts; judge the cause and clear it, or judge the upstream item it filed`),
    };
  });
}
