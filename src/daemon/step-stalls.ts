// Concern: loop-step stall signatures (GY-1854) — the normalised signature of a failing call, the three-consecutive-cycle stall rule, the bound remedy applied once per run and verified, and the unbound stall's master wake and five-minute backoff.
import { createHash } from 'node:crypto';
import type { ActionableSubject } from './metrics.js';
import type { DaemonAction, DaemonState, StepStall, StepStallRemedyRecord } from './state.js';
import { applyStepStallRemedy, stepStallRemedy, type BoundStepStallRemedy, type StepStallRemedyKind, type StepStallRemedyOutcome } from '../stall-remedies.js';
import type { MasterConfig } from '../master.js';
import type { DaemonEffects } from './effects.js';
import { mergeRecordKey } from '../merge-writer/executor.js';
import { DispatchReservedError } from '../master/dispatch-reservation.js';
import { setupAgentEnvironments } from '../master/environments.js';

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
/** A commit id: hex with at least one letter, so a long digit run stays a number for the pass below. */
const shas = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi;
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

/** The refusal a held call's port answers with; `noteStepFailure` counts a text carrying it as nothing (the hold is the tracker speaking, not the fault failing again). */
export const stallHoldMarker = 'stalled call held to its five-minute window';
/** Whether a failure text is a held call's hold answer, never a fault to count. */
export const isStallHold = (text: unknown): boolean => typeof text === 'string' && text.includes(stallHoldMarker);

/** The hold one stalled step's call is under right now: until when, and the refusal its port answers with. */
export interface StallHold { step: string; signature: string; until: number; reason: string }

/**
 * The five-minute window one stalled call's retry is held to (GY-1854 AC-1): while a stall of `step`
 * stands with `now < nextAttemptAt`, its owning step attempts the call at most once per window — the
 * dispatcher's launch is refused before any claim, the merge writer starts no new merge, and a failed
 * cycle's next run of the call waits out the window. The earliest standing window is the one that
 * holds; past every window the call is due again, and one failure re-arms the window.
 */
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
  ({ run: { signature: stallSignature(step, error), step, count: 0, lastCycle: 0, firstAt: '', lastAt: '', lastError: errorText(error).slice(0, 1000), stalledAt: null, remedy: null, nextAttemptAt: null, attemptAt: null }, counted: false, stalled: false, bound: null });

/**
 * One failure of a loop step or dispatcher call, under the signature it signs: the run advances
 * at most one count per cycle — several actions of one step failing the same way in a cycle are
 * that cycle's one failure, three affected work items are not three cycles — and a run that
 * reached three consecutive cycles is recorded as one stall, once, never again while it stands,
 * bound to its remedy when the registry recognises the signature. A stalled call backs off to
 * once per five minutes: a failure inside the backoff window is that window's one attempt still
 * failing, so it moves the run's last error without advancing count. `cycle` is what makes the
 * run consecutive: the count advances only on the cycle right after the run's last one, a cycle
 * that ends without the step failing clears the run (`noteStepsSucceeded`), and a failure past a
 * gap starts a new run whose stall and remedy the old one does not carry — except a standing stall,
 * whose held cycles are no gap: the failure of the attempt its window admitted (`admitStalledCall`),
 * however many cycles later it settles, counts as that window's one failure.
 */
export function noteStepFailure(state: DaemonState, step: string, error: unknown, now: number, cycle: number): StepStallNote {
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
    : { signature, step, count: 1, lastCycle: cycle, firstAt: at, lastAt: at, lastError: errorText(error).slice(0, 1000), stalledAt: null, remedy: null, nextAttemptAt: null, attemptAt: null };
  const stalled = run.count >= stallCycleBound && run.stalledAt === null;
  if (stalled) run.stalledAt = at;
  const armed = attempted && previous.nextAttemptAt !== null && now < Date.parse(previous.nextAttemptAt);
  if (stalled || (run.stalledAt && !backingOff && !armed)) run.nextAttemptAt = new Date(now + stallBackoffMs).toISOString();
  state.stepStalls[signature] = run;
  pruneStepStalls(state);
  return { run, counted: !sameCycle && !backingOff, stalled, bound: run.stalledAt ? stepStallRemedy(signature) : null };
}

/**
 * Admits a held call's one attempt per window (GY-1854 AC-1): while a stall of `step` stands with
 * `now < nextAttemptAt` the call is held and the hold is answered; once a window has passed, the
 * call is admitted and the admission itself arms the next window, so every other call of the step
 * until then is held — a call that settles a cycle or more later (a launch, a merge) is still the
 * window's one attempt, and its failure, whenever it is recorded, is counted as that attempt's.
 */
export function admitStalledCall(state: DaemonState, step: string, now: number): StallHold | null {
  const hold = stallHold(state, step, now);
  if (hold) return hold;
  for (const run of Object.values(state.stepStalls)) {
    if (run.step !== step || !run.stalledAt) continue;
    run.attemptAt = new Date(now).toISOString();
    run.nextAttemptAt = new Date(now + stallBackoffMs).toISOString();
  }
  return null;
}

/**
 * Ends every run the completed cycle did not fail in: one clean cycle breaks the consecutive
 * chain, and its stall with it. A stalled run whose five-minute window still stands is kept —
 * the loop is holding that call, so a quiet cycle is the hold working, not the fault clearing;
 * the window's one attempt is what resolves it. Answers how many runs ended, so the caller
 * persists a cursor the clearing actually moved.
 */
export function noteStepsSucceeded(state: DaemonState, cycle: number, now?: number): number {
  let cleared = 0;
  for (const [signature, run] of Object.entries(state.stepStalls)) {
    if (run.lastCycle >= cycle) continue;
    if (run.stalledAt && run.nextAttemptAt && now !== undefined && Date.parse(run.nextAttemptAt) > now) continue;
    delete state.stepStalls[signature];
    cleared += 1;
  }
  return cleared;
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

/**
 * The task an unbound stall wakes the master session with: the signature, the step, the stall's own
 * recording instant, and the remedy attempt when one was made (GY-1854 AC-1). Everything in it is
 * stable for as long as one run stands — the live count and last error stay on the cursor, where
 * `master status` reads them — so the digest machinery wakes the session once per run, never once
 * per cycle and never again per backed-off attempt of a standing stall.
 */
export function stallWakeTask(stall: StepStall, cliPath: string): string {
  const remedy = stall.remedy
    ? ` Its ${stall.remedy.kind} remedy was applied once at ${stall.remedy.at} and ${stall.remedy.outcome}${stall.remedy.verified ? ', verified' : ', unverified'}: ${stall.remedy.detail}`
    : '';
  return `Loop-step stall: the ${stall.step} call failed with one signature on ${stallCycleBound} consecutive cycles and stands stalled since ${stall.stalledAt}.${remedy} Step: ${stall.step}. Signature: ${stall.signature}. The call is attempted at most once per five minutes while this stands. Run node ${cliPath} master status (daemon.stepStalls, subject ${stallSubjectKey(stall.signature)}) for the failing attempts so far, judge the cause, and clear it or file what does.`;
}

/** The stalls that need the master session, as master-wake subjects the digest machinery wakes once per changed task. */
export function stallWakeSubjects(state: DaemonState, cliPath: string): ActionableSubject[] {
  return Object.values(state.stepStalls).filter(stallNeedsMaster)
    .map(stall => ({ key: stallSubjectKey(stall.signature), kind: 'wake' as const, work: null, detail: stallWakeTask(stall, cliPath) }));
}

/**
 * The stall bookkeeping one completed cycle owes (GY-1854), run beside the cycle's result: every
 * action the cycle recorded failed — the dispatcher's failures among them, a held call's hold
 * answer among them never counted — signs its action kind as the step, at most once per signature
 * per cycle, and a cycle that failed nowhere ends the runs it did not fail in. Answers what was
 * counted and how many standing runs the cycle ended, so the caller persists a cursor the
 * bookkeeping moved.
 */
export function noteCycleStalls(state: DaemonState, actions: Pick<DaemonAction, 'kind' | 'state' | 'detail'>[], cycle: number, now: number): { notes: StepStallNote[]; cleared: number } {
  const notes = actions.filter(action => action.state === 'failed' && !isStallHold(action.detail)).map(action => noteStepFailure(state, action.kind, action.detail, now, cycle));
  const cleared = noteStepsSucceeded(state, cycle, now);
  return { notes, cleared };
}

/**
 * Judges the report the profile write answered with (GY-1854): applied when it wrote at least one
 * profile change, verified when the write landed and no credential was skipped unread.
 */
export function profileRemedyOutcome(report: { applied?: boolean; profiles?: unknown[]; skipped?: { reason: string }[]; next?: string }): StepStallRemedyOutcome {
  const profiles = report.profiles?.length ?? 0, skipped = report.skipped?.length ?? 0;
  return {
    outcome: profiles ? 'applied' : 'unchanged',
    verified: report.applied === true && profiles > 0 && skipped === 0,
    detail: `${profiles} profile change(s) written${skipped ? `, ${skipped} credential(s) skipped: ${report.skipped!.map(entry => entry.reason).join('; ')}` : ''}: ${report.next ?? 'no report'}`.slice(0, 2000),
  };
}

/**
 * Adopts the server's merge ledger for a refused merge record (GY-1854), and answers whether the
 * next attempt records under a key that was never sent. The refused attempt is named by the failed
 * merge action that carries the refusal: its item key, its head, and the instant the refusal was
 * recorded. The adoption reads the item's folded ledger back from the snapshot — the executor
 * reads the same fold every cycle, so the queue and the attempt key it derives next are the
 * server's truth — clears the refused attempt's own persisted in-flight marker, and refuses to
 * touch a marker naming any other item or head, or one started after the refusal was recorded:
 * a merge of another item, or a later attempt of the same one, is a live or newer flight whose
 * crash-recovery marker is its own, never cleared from the remedy.
 */
export function mergeLedgerAdoption(state: DaemonState, work: readonly { key: string; id: string; mergeLedger?: { events: number } | null }[], refused: { key: string; head: string; at: string } | null): StepStallRemedyOutcome {
  if (!refused) return { outcome: 'refused', verified: false, detail: 'No failed merge action carrying a reused record key stands on the cursor, so nothing was adopted' };
  const item = work.find(entry => entry.key === refused.key);
  const events = item?.mergeLedger?.events ?? null;
  const marker = state.mergeWriter.inFlight;
  const stale = !!marker && marker.key === refused.key && marker.head === refused.head && Date.parse(marker.startedAt) < Date.parse(refused.at);
  if (stale) state.mergeWriter.inFlight = null;
  // A replay of the item's writes would send the refused key again: until its answer is settled, the adoption cannot claim a fresh key. The refused attempt's own marker never stands past this
  // function: it was either cleared above or belonged to no refused flight (started after the
  // refusal was recorded, so a later attempt's), and a later attempt always mints a fresh id.
  const replay = state.mergeWriter.unconfirmed?.find(entry => entry.key === refused.key) ?? null;
  const verified = events !== null && !replay;
  const derivation = item && events ? ` — the next attempt-free record for it derives ${mergeRecordKey({ id: item.id, mergeLedger: item.mergeLedger ?? null }, { kind: 'refused', head: refused.head, reason: 'adopted' })}, a derivation the pre-adoption ledger never gave` : '';
  return { outcome: 'applied', verified,
    detail: `Adopted the server's merge ledger for ${refused.key} (${events === null ? 'no folded ledger read' : `${events} events`})${derivation}; the refused attempt's in-flight marker is ${stale ? 'cleared' : 'already gone'}, so the next flight mints a fresh attempt id${replay ? `; a replay of its writes still stands, so the refused key may be sent once more` : ' and no replay of its writes stands, so the refused key is never sent again'}`.slice(0, 2000) };
}

/**
 * The stall step's own remedy ports (GY-1854): the loop writes the agent profiles exactly as
 * `master environments --apply` does, and adopts the server's merge ledger for a refused merge
 * record. A credential the plane answers 401 this loop holds no port to re-issue: the remedy is
 * recorded refused once and its stall wakes the master session, whose task names the bootstrap.
 */
export function stallRemedyRunner(config: () => Pick<MasterConfig, 'url'>, state: () => DaemonState, read: DaemonEffects['snapshot'], root: () => string): StepStallRemedyRunner {
  return async kind => {
    if (kind === 'profile-unknown') {
      return profileRemedyOutcome(await setupAgentEnvironments(root(), { apply: true, verify: async token => {
        const response = await fetch(`${config().url}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
        return response.json();
      } }));
    }
    if (kind === 'merge-record-idempotency') {
      // The refused attempt is the newest failed merge action that carries the refusal — the
      // writer's settle wording ("a record key reused") or the engine's ("Idempotency key
      // reused") — and its detail names the item and the head the flight was merging.
      const refused = Object.values(state().actions)
        .filter(action => action.kind === 'merge' && action.state === 'failed' && /key reused with different input/i.test(action.detail))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
      const named = refused ? /Merge of (\S+) head ([0-9a-f]+)/i.exec(refused.detail) : null;
      return mergeLedgerAdoption(state(), (await read()).work, refused && named ? { key: named[1], head: named[2].toLowerCase(), at: refused.at } : null);
    }
    throw new Error('this loop holds no port that re-issues a refused credential; the master session runs the install\'s bootstrap path for it');
  };
}

/**
 * The stalled calls' hold, composed over the loop's own effects (GY-1854 AC-1): while a step's
 * stall stands inside its five-minute window, its owning call is attempted at most once per
 * window. The dispatcher's launch is refused before anything is claimed, exactly as a dispatch
 * another dispatcher holds is — `DispatchReservedError` with the item as the held resource, which
 * the dispatch step answers by passing the item over and recording no failure — and the merge
 * writer's `admit` answers false, so it starts no new merge while the window stands (a settled
 * flight is still recorded, replays and owed reworks still run, and the recorded merger every
 * other step reads is left as it is). Past the window the first call is admitted and arms the
 * next window (`admitStalledCall`); every other effect passes through untouched.
 */
export function stallHeldEffects<T extends DaemonEffects>(effects: T, state: () => DaemonState, now: () => number): T {
  const dispatch = effects.dispatch, mergeWriter = effects.mergeWriter;
  return {
    ...effects,
    ...(dispatch ? { dispatch: async (work, profile, agents, snapshot) => {
      const hold = admitStalledCall(state(), 'dispatch', now());
      if (hold) throw new DispatchReservedError('work', work.key, hold.reason);
      return dispatch(work, profile, agents, snapshot);
    } } : {}),
    ...(mergeWriter ? { mergeWriter: { ...mergeWriter, admit: () => (mergeWriter.admit?.() ?? true) && !admitStalledCall(state(), 'merge', now()) } } : {}),
  } as T;
}
