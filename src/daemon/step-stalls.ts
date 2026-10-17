// Concern: loop-step stall signatures (GY-1854) — the normalised signature of a failing call, the three-consecutive-cycle stall rule, the bound remedy applied once per run and verified, and the unbound stall's master wake and five-minute backoff.
import { createHash } from 'node:crypto';
import type { ActionableSubject } from './metrics.js';
import type { DaemonAction, DaemonState, StepStall, StepStallRemedyRecord } from './state.js';
import { applyStepStallRemedy, stepStallRemedy, type BoundStepStallRemedy, type StepStallRemedyKind, type StepStallRemedyOutcome } from '../stall-remedies.js';

/** Consecutive cycles one signature must fail for the run to be recorded as one stall (GY-1854 AC-1). */
export const stallCycleBound = 3;
/**
 * A stalled call is attempted at most once per five minutes while its stall stands (GY-1854 AC-1):
 * `noteStepFailure` arms one window per attempt, failures inside it are that attempt still failing,
 * and the loop's own failing-call retry schedule converges to the same bound
 * (cycleFailureCeilingMs in ./liveness.ts).
 */
export const stallBackoffMs = 5 * 60_000;
/** The most a signature holds: the step and the normalised error text. */
export const stallSignatureMax = 800;
/** The most runs the cursor keeps, newest first; a long-cleared run is the first dropped. */
export const retainedStepStalls = 100;

/** Everything that differs between attempts of one cause is taken out of a signature. */
const uuids = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const shas = /\b[0-9a-f]{7,40}\b/gi;
/** Numbers not already inside a `<…>` token: the 401 the credential remedy binds to keeps its token. */
const numbers = /(?<!<)\d+/g;

/**
 * The normalised signature of a failing loop step or dispatcher call: the step and the error text
 * with everything that differs between attempts of one cause taken out — UUIDs, 7-to-40-hex
 * commit ids, epochs, worktree ordinals and every other number — so two failures of one fault
 * sign the same and any other change in the fault signs differently. A `401` is made its own
 * letters-only token before the numbers pass, so the credential refusal a remedy binds to stays
 * readable.
 */
export function stallSignature(step: string, error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error ?? '')).replace(/\s+/g, ' ').trim();
  return `${step}: ${text}`.replace(uuids, '<id>').replace(shas, '<sha>').replace(/\b401\b/g, '<unauthorized>').replace(numbers, 'N').slice(0, stallSignatureMax);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error ?? ''));

export interface StepStallNote { run: StepStall; stalled: boolean; bound: BoundStepStallRemedy | null }

/**
 * One failure of a loop step or dispatcher call, under the signature it signs: the run advances,
 * a run that reached three consecutive cycles is recorded as one stall — once, never again while
 * it stands — and the stall is bound to its remedy when the registry recognises the signature.
 * A stalled call backs off to once per five minutes: a failure inside the backoff window is that
 * window's one attempt still failing, so it moves the run's last error without advancing count.
 * `cycle` is what makes the run consecutive: a cycle that ends without the step failing clears
 * the run (`noteStepsSucceeded`), so only unbroken runs stall.
 */
export function noteStepFailure(state: DaemonState, step: string, error: unknown, now: number, cycle: number): StepStallNote {
  const signature = stallSignature(step, error), at = new Date(now).toISOString();
  const previous = state.stepStalls[signature];
  const backingOff = !!previous?.stalledAt && previous.nextAttemptAt !== null && now < Date.parse(previous.nextAttemptAt);
  const run: StepStall = previous && previous.step === step
    ? { ...previous, count: backingOff ? previous.count : previous.count + 1, lastCycle: cycle, lastAt: at, lastError: errorText(error).slice(0, 1000) }
    : { signature, step, count: 1, lastCycle: cycle, firstAt: at, lastAt: at, lastError: errorText(error).slice(0, 1000), stalledAt: null, remedy: null, nextAttemptAt: null };
  const stalled = run.count >= stallCycleBound && run.stalledAt === null;
  if (stalled) run.stalledAt = at;
  if (stalled || (run.stalledAt && !backingOff)) run.nextAttemptAt = new Date(now + stallBackoffMs).toISOString();
  state.stepStalls[signature] = run;
  pruneStepStalls(state);
  return { run, stalled, bound: run.stalledAt ? stepStallRemedy(signature) : null };
}

/** Ends every run the completed cycle did not fail in: one clean cycle breaks the consecutive chain, and its stall with it. */
export function noteStepsSucceeded(state: DaemonState, cycle: number): void {
  for (const [signature, run] of Object.entries(state.stepStalls)) if (run.lastCycle < cycle) delete state.stepStalls[signature];
}

/** The cursor keeps the newest runs; whatever a recovered history alone would read is dropped first. */
export function pruneStepStalls(state: DaemonState): void {
  const entries = Object.entries(state.stepStalls);
  if (entries.length <= retainedStepStalls) return;
  state.stepStalls = Object.fromEntries(entries.sort((a, b) => Date.parse(b[1].lastAt) - Date.parse(a[1].lastAt)).slice(0, retainedStepStalls));
}

/** The port one bound remedy runs through: it applies the remedy and answers whether its verification held. */
export type StepStallRemedyRunner = (kind: StepStallRemedyKind) => Promise<StepStallRemedyOutcome>;

/**
 * Applies the stalled run's bound remedy once and records the attempt on it: a run already
 * carrying one is applied nothing (one attempt per run, whoever asks), and the outcome — refused
 * or unverified included — is what the run keeps. Answers the record, or null when the run is
 * unbound, not stalled, or already remedied.
 */
export async function remedyStepStall(state: DaemonState, signature: string, runner: StepStallRemedyRunner, now: number): Promise<StepStallRemedyRecord | null> {
  const stall = state.stepStalls[signature];
  if (!stall?.stalledAt || stall.remedy) return null;
  const bound = stepStallRemedy(signature);
  if (!bound) return null;
  const outcome = await applyStepStallRemedy(bound.kind, runner);
  stall.remedy = { kind: bound.kind, at: new Date(now).toISOString(), outcome: outcome.outcome, verified: outcome.verified, detail: outcome.detail.slice(0, 2000) };
  return stall.remedy;
}

/** Applies every stalled, unremedied and bound run's remedy once; answers what was applied. */
export async function remedyStalledSteps(state: DaemonState, runner: StepStallRemedyRunner, now: number): Promise<{ signature: string; record: StepStallRemedyRecord }[]> {
  const applied: { signature: string; record: StepStallRemedyRecord }[] = [];
  for (const signature of Object.keys(state.stepStalls)) {
    const record = await remedyStepStall(state, signature, runner, now);
    if (record) applied.push({ signature, record });
  }
  return applied;
}

/** The subject key one stall rides the master wake as, hashed off its signature so a standing stall is never a second subject. */
export const stallSubjectKey = (signature: string) => `stall:${createHash('sha256').update(signature).digest('hex').slice(0, 12)}`;

/**
 * Whether a stall needs the master session: no remedy binds to it, or its one bound remedy was
 * refused or did not verify, or a verified remedy has stood through a second full run of failures —
 * otherwise the loop would back the call off indefinitely and nobody would be told.
 */
export function stallNeedsMaster(stall: StepStall): boolean {
  if (!stall.stalledAt) return false;
  if (!stall.remedy) return true;
  return stall.remedy.outcome === 'refused' || !stall.remedy.verified || stall.count >= 2 * stallCycleBound;
}

/** The task an unbound stall wakes the master session with: the signature, the last error, the step and the count (GY-1854 AC-1). */
export function stallWakeTask(stall: StepStall, cliPath: string): string {
  const remedy = stall.remedy
    ? ` Its ${stall.remedy.kind} remedy was applied once at ${stall.remedy.at} and ${stall.remedy.outcome}${stall.remedy.verified ? ', verified' : ', unverified'}: ${stall.remedy.detail}`
    : '';
  return `Loop-step stall: ${stall.count} consecutive cycles failed the ${stall.step} call with one signature.${remedy} Step: ${stall.step}. Signature: ${stall.signature}. Last error: ${stall.lastError}. The call is retried at most once per five minutes while this stands. Run node ${cliPath} master status (daemon.stepStalls), judge the cause, and clear it or file what does.`;
}

/** The stalls that need the master session, as master-wake subjects the digest machinery wakes once per changed task. */
export function stallWakeSubjects(state: DaemonState, cliPath: string): ActionableSubject[] {
  return Object.values(state.stepStalls).filter(stallNeedsMaster)
    .map(stall => ({ key: stallSubjectKey(stall.signature), kind: 'wake' as const, work: null, detail: stallWakeTask(stall, cliPath) }));
}

/**
 * The stall bookkeeping one completed cycle owes (GY-1854), run beside the cycle's result: every
 * action the cycle recorded failed — the dispatcher's failures among them — signs its action kind
 * as the step, and a cycle that failed nowhere ends the runs it did not fail in.
 */
export function noteCycleStalls(state: DaemonState, actions: Pick<DaemonAction, 'kind' | 'state' | 'detail'>[], cycle: number, now: number): StepStallNote[] {
  const noted = actions.filter(action => action.state === 'failed').map(action => noteStepFailure(state, action.kind, action.detail, now, cycle));
  noteStepsSucceeded(state, cycle);
  return noted;
}
