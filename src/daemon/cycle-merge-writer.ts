import { mergeWriterKeptQueue, mergeWriterKeptRefusals, mergeWriterKeptReworks, mergeWriterKeptTimeouts, mergeWriterTrialTimeoutRefusals, mergeWriterKeptUnconfirmed, mergeWriterUnconfirmedReplays, serveRevertsKept, type PendingRework, type UnconfirmedRecord, type MergeWriterState, type RevertFlight } from './merge-writer-state.js';
export { mergeWriterKeptQueue, mergeWriterKeptRefusals, mergeWriterKeptReworks, mergeWriterKeptTimeouts, mergeWriterTrialTimeoutRefusals, mergeWriterKeptUnconfirmed, mergeWriterUnconfirmedReplays, serveRevertsKept, pendingReworkSchema, unconfirmedRecordSchema, mergeWriterStateSchema, emptyMergeWriterState, type PendingRework, type UnconfirmedRecord, type MergeWriterState, type RevertFlight } from './merge-writer-state.js';
// Concern: the control-plane merge executor's cycle step (GY-1524) — reconcile open intents, pick the next head, run one merge beside the cycle and record what it did.
import { randomUUID } from 'node:crypto';
import type { ChildRun } from '../child-runner.js';
import type { MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import type { MergeLedgerState } from '../model/merge-ledger.js';
import { mergeWriterTrialGround, trialFailurePrefix } from '../model/rework-ground.js';
import { installIdFor } from '../install/types.js';
import { defaultMergeWriterRetrials, mergeWriterSettings, trialTimeoutMinutes } from '../master/merge-writer-settings.js';
import { mergeStallMs } from '../model/merge-ledger.js';
import { mergeSubject, trialMerge, TrialTimeoutError, trialHiddenPaths } from '../merge-writer/trial.js';
import { itemPreviewStep, previewSiteOf, previewSkip, runPreview, type ItemPreviewPorts, type LivePreview } from '../merge-writer/preview.js';
import { relandItemFor, relandTitle, runServeRevert, type RelandInput } from '../merge-writer/serve-revert.js';
import { loadProjectDelivery } from '../project-applications.js';
import { defaultMergeBatch, mergeBatch, type BatchResult } from '../merge-writer/batch.js';
import { baseFailureHoldMs, criterionProofs, e2eProofsOf, firstParentHolds, keyReusedRefusal, mergeRecordStatus, mergeQueue, previewRecordEvent, proofTestFiles, pushArgs, pushEnvironment, pushFailureWithStderr, reconcileIntents, runMergeTrial, staleLeaseRejection, trialRefusalHeld, type MergePorts, type MergeRecordEvent } from '../merge-writer/executor.js';
import { message, storeAction, type DaemonState } from './state.js';
import type { Cycle } from './cycle.js';

/** The merge writer's ports (merge-writer/executor.ts). */
export interface MergeWriterReads extends MergePorts {
  /**
   * GY-1854: whether a new merge may start now, asked only when one is due. A stalled merge call
   * is admitted once per five-minute window; settling, replays and owed reworks never ask. Absent,
   * every due merge starts.
   */
  admit?(): boolean;
  /** GY-2088: how many queued heads one merge takes together (`defaultMergeBatch`); absent, one at a time. */
  batch?: number;
  /** GY-1902: the item previews' ports (merge-writer/preview.ts `itemPreviewStep`); absent, no item is previewed. */
  itemPreviews?: ItemPreviewPorts;
  /** One git call in the coordinator checkout (`git -C <root>` and the child's stdout, with `env` for the author like the trial's own); absent, the serve-revert step reads nothing. */
  git?: (args: string[], env?: Record<string, string>) => Promise<string>;
  /**
   * GY-2990: the served commit and its required cases' verdict, as the serve pass recorded it
   * (serve-app.ts `readServeRecord`); absent, a failing serve reverts nothing. Null when nothing
   * serves or the verdict has not run against the served commit.
   */
  serveRecord?(): Promise<{ commit: string; check: { verified: boolean; case: string | null; step: string | null; reason: string | null } | null } | null>;
  /**
   * GY-2990: files the re-land item (`POST /api/work` as the master's operator-agent identity)
   * under `idempotencyKey`, the same on every retry, so a filing whose reply was lost is never
   * filed twice; answers what the control plane filed. Absent, the pushed revert stands without
   * its re-land until a loop that can file adopts it.
   */
  createWork?(input: RelandInput, idempotencyKey: string): Promise<{ key?: string } | null>;
}
/** The idempotency key one recorded step keeps across retries. */
export { mergeRecordKey } from '../merge-writer/executor.js';

const output = (error: unknown) => { const failed = error as { stdout?: unknown; stderr?: unknown; message?: string }; return `${typeof failed.stdout === 'string' ? failed.stdout : ''}${typeof failed.stderr === 'string' ? failed.stderr : ''}` || String(failed.message ?? error); };

/**
 * The reads over the coordinator checkout `root` (its object store holds every submitted head,
 * GY-1523, and the trial commits). Git writes are the trial ref and the one leased push to
 * `origin`; a trial checkout under `base` is the only worktree made. The push child's environment
 * is `pushEnvironment`: the deploy key as GIT_SSH_COMMAND and no other credential. The loop wires
 * them in effects.ts; a test hands its own through `effects.mergeWriter`.
 */
export function mergeWriterReads(config: Pick<MasterConfig, 'baseBranch' | 'run' | 'repository'>, root: string, run: ChildRun,
  options: { base: string; record: MergePorts['record']; hold?: MergePorts['hold']; trial?: typeof runMergeTrial; preview?: typeof runPreview; environment?: NodeJS.ProcessEnv; now?: () => number;
    itemPreviews?: Partial<ItemPreviewPorts> }): MergeWriterReads {
  const git = async (...args: string[]) => String(await run('git', ['-C', root, ...args]));
  const gitAs = async (args: string[], env?: Record<string, string>) => String(await run('git', ['-C', root, ...args], env ? { env: { ...(options.environment ?? process.env), ...env } } : undefined));
  const settings = mergeWriterSettings(config.run, installIdFor(config.repository));
  // GY-2997: the trial's children run the merge's code, so they never read the deploy key the push uses, nor any coordinator credential.
  const hidden = trialHiddenPaths(settings.deployKeyFile, options.environment);
  const base = config.baseBranch, ref = `refs/remotes/origin/${base}`;
  const tip = async () => {
    const sha = (await git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`The coordinator checkout holds no ${ref} to merge onto`);
    return sha;
  };
  return {
    baseBranch: base, retrials: settings.retrials, batch: defaultMergeBatch, now: options.now ?? Date.now, record: options.record, ...(options.hold ? { hold: options.hold } : {}),
    git: (args, env) => gitAs(args, env),
    fetch: async () => { await git('fetch', '--no-tags', 'origin', base); return tip(); },
    // The head itself when its first-parent chain holds the tip (main fast-forwards), else the merge commit `Merge GY-N: <title>`.
    merge: async (head, baseTip, item) => {
      const merged = await trialMerge(gitAs, { head, baseTip, ...(item ? { subject: mergeSubject(item) } : {}) });
      if ('conflict' in merged) return merged;
      return { mergeSha: merged.mergeSha, files: (await git('diff', '--name-only', baseTip, merged.mergeSha)).split('\n').map(line => line.trim()).filter(Boolean) };
    },
    trial: async (mergeSha, files, item, baseTip, onStep) => {
      const proofs = criterionProofs(item);
      // Discovered inside each retried attempt (GY-1832), so a git grep that fails or times out is timed and retried like the trial's other reads.
      const discoverProofFiles = (runOptions: { timeoutMs?: number }) => proofTestFiles(run, root, mergeSha, proofs, runOptions);
      return (options.trial ?? runMergeTrial)({ root, base: options.base, mergeSha, changedFiles: files, proofs, e2eProofs: e2eProofsOf(item), proofFiles: [], discoverProofFiles, timeoutMs: trialTimeoutMinutes * 60_000, key: item.key, bug: item.type === 'bug', run, environment: options.environment, hidden, ...(baseTip ? { baseTip } : {}), ...(onStep ? { onStep } : {}) });
    },
    // GY-1718: a repository naming a static UAT previews every passing trial whose delta is more than docs or tests.
    preview: async (mergeSha, files) => {
      const environment = options.environment ?? process.env, site = previewSiteOf(environment);
      if (!site || previewSkip(files, site)) return null;
      return (options.preview ?? runPreview)({ root, base: options.base, mergeSha, site, timeoutMs: trialTimeoutMinutes * 60_000, run, hostEnvironment: environment });
    },
    // GY-1902: an item citing a case bound to a declared static application is previewed from the coordinator checkout, its record written through the merge-record route.
    itemPreviews: { root, base: options.base, timeoutMs: trialTimeoutMinutes * 60_000, run, hostEnvironment: options.environment, now: options.now,
      delivery: () => loadProjectDelivery(options.environment ?? process.env, root), baseTip: tip, record: (item, preview, site) => options.record(item, previewRecordEvent(preview, site)), ...options.itemPreviews },
    // Only git's own stale-lease wording is a rejection the executor re-reads the tip for; a remote's refusal (a branch rule, a hook) or a transport failure is thrown as it came, with git's stderr in the message (GY-2940).
    push: async (mergeSha, baseTip) => {
      try { await run('git', ['-C', root, ...pushArgs(base, baseTip, mergeSha)], { env: pushEnvironment(settings.deployKeyFile, options.environment) }); return 'pushed'; }
      catch (error) { if (staleLeaseRejection(output(error))) return 'rejected'; throw pushFailureWithStderr(error); }
    },
    // The whole first-parent history, not a window of it: an intent older than any bound is still a push (AC-5).
    holds: sha => firstParentHolds(args => git(...args), ref, sha),
  };
}

/** What a serve-revert flight (GY-2990) settled as: the pushed revert, a held revert, or one to try again. */
export type RevertSettled = { ok: true } | { ok: false; reason: string; retry?: boolean };
interface Flight { key: string; id: string; head: string; startedAt: string; settled: { results: BatchResult[] } | { error: unknown } | { revert: RevertSettled } | null;
  /** The serve-revert flight's context (GY-2990), as `state.mergeWriter.inFlight.revert` persists it. */
  revert?: RevertFlight }
const flights = new WeakMap<DaemonState, Flight>();
/** Resolves once the merge in flight for `state` has settled; for the step's tests. */
/** The item previews this loop process serves, by item key (GY-1902). */
const itemPreviews = new WeakMap<DaemonState, Map<string, LivePreview>>();
/** Whether a merge trial is running beside the cycle: the loop's restart waits while one is, since it would kill the trial. */
export const mergeWriterInFlight = (state: DaemonState) => { const flight = flights.get(state); return !!flight && !flight.settled; };
export const mergeWriterIdle = async (state: DaemonState) => { for (let waited = 0; flights.get(state) && !flights.get(state)!.settled && waited < 600_000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5)); };
/** The action key a merge of `key`'s `head` is recorded under. */
export const mergeWriterActionKey = (key: string, head: string) => `merge-writer:${key}:${head}`;
/** The ledger states the snapshot carries, by item key: what `mergeQueue` and `reconcileIntents` read. */
export const snapshotLedger = (work: readonly Work[]): Record<string, MergeLedgerState> => Object.fromEntries(work.flatMap(item => item.mergeLedger ? [[item.key, item.mergeLedger] as const] : []));
/** The rework a failed trial grounds (AC-3): its binding names the head and the ground, as every loop rework does, so the server's lane rework finds it. */
export const trialFailureRework = (work: Work, head: string, reason: string) => ({
  reason: `${work.key}: the merge writer's trial of candidate ${head.slice(0, 12)} failed: ${reason}. Nothing but a new head can pass the trial, so the item returns to a worker.`,
  input: { previousWorkerStopped: true as const, binding: `${head}:${mergeWriterTrialGround}` },
});

// ---- Trial timeouts yield the queue turn (GY-2079) ------------------------------------------------

/** The test files a timed-out trial's log names: the slow files the runner was reporting when the time budget ran out. */
const timeoutFiles = (error: TrialTimeoutError) => [...new Set(error.logTail.match(/tests\/[\w./-]+\.test\.ts/g) ?? [])];
/**
 * The refusal of a head whose trial timed out `count` times while other heads' trials passed (GY-2079):
 * the ground starts `trialFailurePrefix`, so the queue drops the head and the refusal grounds the
 * rework, naming the slow test files where the runner reported them.
 */
export const trialTimeoutReason = (count: number, files: readonly string[]) =>
  `${trialFailurePrefix}: the trial timed out ${count} times while other heads' trials passed${files.length ? `: ${files.slice(0, 10).join(', ')}` : ''}`.slice(0, 2000);
/** One timeout record of `state.mergeWriter.timeouts`. */
type TrialTimeout = NonNullable<MergeWriterState['timeouts']>[number];
/**
 * A trial timeout of `flight` counts on its head's record: the first sets the head yielding its queue
 * turn; one where another head passed since the head's previous timeout counts toward the refusal
 * bound, and at the bound names its ground. A timeout with no other head passing is host noise: the
 * head keeps yielding, its count stands.
 */
function countTrialTimeout(writer: MergeWriterState, flight: { key: string; id: string; head: string }, at: string, files: readonly string[]): TrialTimeout {
  const timeouts = writer.timeouts ??= [];
  const counted = timeouts.find(entry => entry.key === flight.key && entry.head === flight.head);
  if (!counted) {
    const record: TrialTimeout = { key: flight.key, id: flight.id, head: flight.head, at, count: 1, othersPassed: false, reason: null };
    writer.timeouts = [...timeouts, record].slice(-mergeWriterKeptTimeouts);
    return record;
  }
  if (counted.othersPassed) { counted.count = Math.min(counted.count + 1, 100_000); counted.othersPassed = false; if (counted.count >= mergeWriterTrialTimeoutRefusals) counted.reason = trialTimeoutReason(counted.count, files); }
  counted.at = at;
  return counted;
}

// ---- Record writes that converge (GY-1852) ------------------------------------------------------------

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Whether a failed write's reply is unknown, so the server may hold it: no status, a 5xx, 408 or 429. Any other answer is the server's decision on that input. */
const replyUnknown = (error: unknown) => { const status = mergeRecordStatus(error); return status === null || status >= 500 || status === 408 || status === 429; };

/**
 * GY-2053: the writer's configured worst case for one flight — every retrial its settings allow, each one trial timeout, plus one cycle — the
 * bound a held head's motion is judged inside (owed-report.ts `mergeWriterMotionBound`), so a hold outlives however long a legal flight runs.
 */
export const mergeWriterFlightBoundMs = (run: { mergeWriter?: { retrials?: number }; intervalSeconds?: number }) =>
  ((run.mergeWriter?.retrials ?? defaultMergeWriterRetrials) + 1) * trialTimeoutMinutes * 60_000
    + (run.intervalSeconds ?? 20) * 1000;

/**
 * GY-2053: what one recorded write says, as the reader reads it — the attempt step the writer's summary reports as its newest movement.
 * Every ledger write a flight or a reconcile makes is attempt progress: a retrial's intent, a trial verdict, a push, a reconcile.
 */
export const attemptProgressLine = (item: { key: string }, event: MergeRecordEvent): string => {
  const sha = (value: unknown) => typeof value === 'string' && value ? value.slice(0, 12) : null;
  switch (event.kind) {
    case 'intent': return `${item.key}'s head ${sha(event.head)} recorded its merge intent on base tip ${sha(event.baseTip)} as merge ${sha(event.mergeSha)}`;
    case 'trial': return `${item.key}'s merge ${sha(event.mergeSha)} recorded its trial (${event.outcome})`;
    case 'pushed': return `${item.key}'s merge ${sha(event.mergeSha)} was recorded pushed`;
    case 'reconciled': return `${item.key}'s merge ${sha(event.mergeSha)} was reconciled: the base holds it`;
    case 'refused': return `${item.key}'s head ${sha(event.head)} recorded its refusal: ${event.reason.slice(0, 300)}`;
    case 'trial-step': return `${item.key}'s merge trial is now at ${event.step}`;
    default: return `${item.key} recorded a ${(event as { kind: string }).kind} step`;
  }
};

/**
 * The record port of one attempt (GY-1852): every write carries the attempt id and its place in the
 * attempt, so its key (`mergeRecordKey`) is never sent with any other input. A write whose reply is
 * unknown is kept on `state.mergeWriter.unconfirmed` with its exact input, for `replayUnconfirmed`.
 * Each write is also the attempt progress the summary reports (GY-2053), recorded before it is
 * sent: the write itself is the writer moving, whatever its reply turns out to be.
 */
export function attemptRecorder(writer: MergeWriterState, record: MergePorts['record'], attempt: string, at: () => string): MergePorts['record'] {
  let next = 0;
  return async (item, event) => {
    const mergeAttempt = { id: attempt, write: next++ };
    writer.progress = { at: at(), what: attemptProgressLine(item, event) };
    try { return await record({ ...item, mergeAttempt }, event); }
    catch (error) {
      if (!keyReusedRefusal(error) && replyUnknown(error)) {
        writer.unconfirmed = [...writer.unconfirmed ?? [], { key: item.key, id: item.id, attempt, write: mergeAttempt.write, event: { ...event }, sentAt: at(), replays: 0, lastError: errorText(error).slice(0, 2000) }].slice(-mergeWriterKeptUnconfirmed);
      }
      throw error;
    }
  };
}

/**
 * Every write whose reply was lost, replayed before anything new starts (GY-1852): the identical
 * input under the identical key, so a write the server holds answers its stored receipt and the
 * merge proceeds from the ledger next cycle. A key the server refuses as reused with different
 * input, any other answer the server gave, or a write still unanswered after
 * `mergeWriterUnconfirmedReplays` cycles is never sent again: the item's merge ledger, as the
 * snapshot read it, is adopted, and the next merge runs under a new attempt id. Answers whether any
 * write was settled or is still owed; while one is, nothing new starts.
 */
export async function replayUnconfirmed(cycle: Pick<Cycle, 'state' | 'now' | 'snapshot' | 'performed'>, record: MergePorts['record']): Promise<boolean> {
  const { state, now, snapshot, performed } = cycle;
  const writer = state.mergeWriter;
  if (!writer.unconfirmed?.length) return false;
  const at = () => new Date(now()).toISOString();
  const kept: UnconfirmedRecord[] = [];
  for (const pending of writer.unconfirmed) {
    const actionKey = `merge-writer-replay:${pending.key}:${pending.attempt}:${pending.write}`, kind = String(pending.event.kind);
    const item = snapshot.work.find(entry => entry.id === pending.id);
    const action = (actionState: 'done' | 'failed', detail: string) => performed.push(storeAction(state, actionKey, { kind: 'merge', work: pending.key, principal: null, state: actionState, detail: detail.slice(0, 1900), attempts: pending.replays + 1, epoch: null, cycle: state.cycle, at: at() }));
    const ledger = item?.mergeLedger ? `${item.mergeLedger.state}${item.mergeLedger.mergeSha ? ` ${item.mergeLedger.mergeSha.slice(0, 12)}` : ''}` : 'empty';
    const adopt = (why: string) => action('done', `The ${kind} record of ${pending.key} (attempt ${pending.attempt}, write ${pending.write}) ${why}; it is never sent again: the item's merge ledger (${ledger}) is adopted and the next merge runs under a new attempt id`);
    if (!item) { adopt('names an item the snapshot no longer holds'); continue; }
    // A failed trial's refusal grounds a rework the lost reply never handed the settled flight: it is owed once the server holds the refusal (the replay stored or answered it, or the adopted ledger records it), and asked for by requestPendingReworks.
    const head = String(pending.event.head ?? '').toLowerCase(), reason = String(pending.event.reason ?? '');
    const oweRework = () => {
      if (kind !== 'refused' || !reason.startsWith(trialFailurePrefix) || writer.reworks.some(entry => entry.key === pending.key && entry.head === head)) return;
      writer.reworks = [...writer.reworks, { key: pending.key, id: pending.id, head, reason: reason.slice(0, 2000), refusedAt: at(), attempts: 0, lastError: null }].slice(-mergeWriterKeptReworks);
    };
    const ledgerHolds = () => item.mergeLedger?.state === 'refused' && item.mergeLedger.head?.toLowerCase() === head && item.mergeLedger.refusal?.reason === reason;
    try {
      await record({ ...item, mergeAttempt: { id: pending.attempt, write: pending.write } }, pending.event as unknown as MergeRecordEvent);
      oweRework();
      action('done', `Replayed the ${kind} record of ${pending.key} (attempt ${pending.attempt}, write ${pending.write}) with its exact input; the server answered its receipt and the merge proceeds from the ledger`);
    } catch (error) {
      if (ledgerHolds()) oweRework();
      if (keyReusedRefusal(error)) adopt('was refused as a key reused with different input');
      else if (!replyUnknown(error)) adopt(`was refused: ${errorText(error).slice(0, 500)}`);
      else if (pending.replays + 1 >= mergeWriterUnconfirmedReplays) adopt(`was still unanswered after ${pending.replays + 1} replays: ${errorText(error).slice(0, 500)}`);
      else {
        kept.push({ ...pending, replays: pending.replays + 1, lastError: errorText(error).slice(0, 2000) });
        action('failed', `The ${kind} record of ${pending.key} (attempt ${pending.attempt}, write ${pending.write}) is still unanswered (replay ${pending.replays + 1}); it is replayed with its exact input next cycle and nothing new starts: ${errorText(error)}`);
      }
    }
  }
  if (kept.length) writer.unconfirmed = kept; else delete writer.unconfirmed;
  return true;
}

/** The action key a pending rework of `key`'s `head` is recorded under. */
export const mergeWriterReworkKey = (key: string, head: string) => `${mergeWriterActionKey(key, head)}:rework`;
/**
 * Every rework the writer still owes (AC-3), asked for again this cycle. One the snapshot shows
 * applied — the item reworked, on a new head, or done — is settled without a request: the server
 * applied it, whatever became of the answer. Otherwise the decision is requested; a request that
 * fails (the plane down, a refusal) keeps the record for the next cycle and is counted, so a
 * transient failure never loses the rework. Without the decision effects the record waits, named
 * for the operator. Answers whether the state changed.
 */
export async function requestPendingReworks(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'snapshot' | 'performed'>): Promise<boolean> {
  const { state, effects, now, snapshot, performed } = cycle;
  const writer = state.mergeWriter;
  const at = () => new Date(now()).toISOString();
  // GY-2166: the settlement that first owed a trial failure's rework lives only in memory, so the
  // restart an upgrade delivered mid-settlement kept the refusal and lost the request: the head
  // stayed out of the queue (mergeQueue drops a trial-refused head) with its rework unasked, and
  // the item's test gate then refuses `merge writer has not trialled …` to no answerer — three
  // owed-decision faults on 19 October 2026. The record re-derives the debt: every head the ledger
  // still refuses with `trial failed` on its exact candidate is owed its rework here, whatever
  // became of the flight, until the snapshot shows it applied.
  for (const item of snapshot.work) {
    const refused = trialRefusalHeld(item.candidate, item.mergeLedger);
    if (!refused || item.reworkRequested) continue;
    const head = item.candidate!.sha.toLowerCase();
    if (writer.reworks.some(entry => entry.key === item.key && entry.head === head)) continue;
    writer.reworks = [...writer.reworks, { key: item.key, id: item.id, head, reason: refused.reason.slice(0, 2000), refusedAt: at(), attempts: 0, lastError: null }].slice(-mergeWriterKeptReworks);
  }
  if (!writer.reworks.length) return false;
  const kept: PendingRework[] = [];
  for (const pending of writer.reworks) {
    const key = mergeWriterReworkKey(pending.key, pending.head);
    const item = snapshot.work.find(entry => entry.key === pending.key);
    const applied = !item || item.stage === 'done' || item.reworkRequested || item.candidate?.sha.toLowerCase() !== pending.head;
    const action = (actionState: 'done' | 'failed', detail: string) => performed.push(storeAction(state, key, { kind: 'judgement', work: pending.key, principal: null, state: actionState, detail: detail.slice(0, 1900), attempts: pending.attempts + 1, epoch: null, cycle: state.cycle, at: at() }));
    if (applied) { action('done', `The rework the merge writer's refusal of ${pending.key} head ${pending.head} grounds is applied: the snapshot shows the item ${!item || item.stage === 'done' ? 'done' : item.reworkRequested ? 'returned to a worker' : 'on a new head'}`); continue; }
    if (!effects.rework) { kept.push({ ...pending, attempts: pending.attempts + 1, lastError: 'this loop runs without the master identity' }); action('failed', `The rework the merge writer's refusal of ${pending.key} head ${pending.head} grounds waits: this loop runs without the master identity, so apply it with graphyard master rework ${pending.key} REASON`); continue; }
    const rework = trialFailureRework(item, pending.head, pending.reason);
    try {
      await effects.rework(item, rework.reason, rework.input.binding);
      action('done', `Returned ${pending.key} to a worker on the merge writer's refusal of head ${pending.head}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      kept.push({ ...pending, attempts: pending.attempts + 1, lastError: message.slice(0, 2000) });
      action('failed', `The rework the merge writer's refusal of ${pending.key} head ${pending.head} grounds was not applied (attempt ${pending.attempts + 1}); it is applied again next cycle: ${message}`);
    }
  }
  writer.reworks = kept;
  return true;
}

// ---- The serve revert: one failing item comes back out (GY-2990) ----------------------------------

type ServeRevertCycle = Pick<Cycle, 'state' | 'effects' | 'now' | 'snapshot' | 'performed'>;

/** The loop's persisted serve-revert state, created on first use. */
const serveRevertState = (state: DaemonState) => state.mergeWriter.serveRevert ??= { lastVerified: null, reverts: [], held: null, retry: null, answered: null };

/**
 * Settles a serve-revert flight: the pushed revert is recorded owing its re-land
 * (`fileOwedRelands` files it this same cycle), a held revert is kept with its reason for master
 * status to name, and anything else — a trial that never settled or a push the base move
 * rejected — is tried again.
 */
function settleServeRevertFlight(cycle: ServeRevertCycle, reads: MergeWriterReads, flight: { key: string; head: string; revert: RevertFlight }, settled: RevertSettled) {
  const { state, performed } = cycle;
  const revert = flight.revert, writer = state.mergeWriter, revertState = serveRevertState(state);
  const at = () => new Date(cycle.now()).toISOString();
  const action = (actionState: 'done' | 'failed', detail: string) => performed.push(storeAction(state, mergeWriterActionKey(flight.key, flight.head),
    { kind: 'merge', work: flight.key, principal: null, state: actionState, detail: detail.slice(0, 1900), attempts: (state.actions[mergeWriterActionKey(flight.key, flight.head)]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at() }));
  const short = (sha: string) => sha.slice(0, 12);
  if (!settled.ok && settled.retry) {
    // The attempt is owed, not due: the next one waits the base-failure hold unless the tip
    // moves (serveRevertAttempt), so back-to-back trials never starve the merge queue — and
    // with no flight in flight the queue's repair takes its turn next cycle.
    revertState.retry = { serve: revert.serve, culprit: flight.key, mergeSha: revert.mergeSha, baseTip: revert.baseTip, reason: settled.reason.slice(0, 2000), at: at() };
    action('failed', `The revert of ${flight.key}'s merge ${short(revert.mergeSha)} was not pushed: ${settled.reason}; it is tried again once the base tip moves or the hold elapses`);
    return;
  }
  if (revertState.retry?.serve === revert.serve) revertState.retry = null;
  if (!settled.ok) {
    revertState.held = { serve: revert.serve, culprit: flight.key, reason: settled.reason.slice(0, 2000), at: at() };
    action('failed', `Held: ${settled.reason}`);
    return;
  }
  const reverts = [...revertState.reverts, { serve: revert.serve, culprit: flight.key, mergeSha: revert.mergeSha, revertSha: revert.revertSha, reland: null,
    failingCase: revert.failingCase, failingStep: revert.failingStep, failingReason: revert.failingReason, at: at() }];
  const forgotten = reverts.length > serveRevertsKept ? reverts.find(entry => entry.reland) : undefined;
  revertState.reverts = reverts.filter(entry => entry !== forgotten);
  if (revertState.held?.serve === revert.serve) revertState.held = null;
  writer.lastMergeAt = at();
  action('done', `Reverted ${flight.key}'s merge ${short(revert.mergeSha)} from ${reads.baseBranch} as ${short(revert.revertSha)} after served ${short(revert.serve)} failed the required case ${revert.failingCase}`);
}

/**
 * A serve revert the persisted in-flight entry names but no flight in this process runs: the loop
 * restarted beside it. The base holding the revert commit settles it as pushed, so its re-land is
 * still owed and it never reverts again; otherwise nothing landed and the attempt starts afresh. An
 * unreachable base keeps the entry, and nothing new starts until it reads. Answers whether the
 * state changed.
 */
async function reconcileServeRevert(cycle: ServeRevertCycle, reads: MergeWriterReads): Promise<boolean> {
  const writer = cycle.state.mergeWriter, inFlight = writer.inFlight;
  if (!inFlight?.revert || flights.has(cycle.state)) return false;
  let pushed: boolean;
  try { await reads.fetch(); pushed = await reads.holds(inFlight.revert.revertSha); } catch { return false; }
  writer.inFlight = null;
  if (pushed) settleServeRevertFlight(cycle, reads, { key: inFlight.key, head: inFlight.head, revert: inFlight.revert }, { ok: true });
  return true;
}

/**
 * Files every re-land a pushed revert still owes, from the failing case its record carries — so
 * a filing that failed is retried whatever is served afterwards. An item already titled `Re-land
 * GY-N` is adopted, and the filing's idempotency key names the reverted merge, so a reply lost
 * before the snapshot shows the item still files one. Answers whether the state changed.
 */
async function fileOwedRelands(cycle: ServeRevertCycle, reads: MergeWriterReads): Promise<boolean> {
  const { state, snapshot, performed } = cycle;
  let changed = false;
  for (const done of state.mergeWriter.serveRevert?.reverts ?? []) {
    if (done.reland) continue;
    const culprit = snapshot.work.find(entry => entry.key === done.culprit);
    if (!culprit) continue;
    const key = `serve-revert:${done.serve}`, attempts = (state.actions[key]?.attempts ?? 0) + 1, at = new Date(cycle.now()).toISOString();
    try {
      const expected = relandTitle(culprit);
      const adopted = snapshot.work.find(entry => entry.title === expected || entry.title.startsWith(`${expected}:`));
      const reland = adopted?.key ?? (await reads.createWork?.(relandItemFor(culprit, { ...done, baseBranch: reads.baseBranch }), `serve-reland:${done.mergeSha}`))?.key;
      if (!reland) continue;
      done.reland = reland;
      performed.push(storeAction(state, key, { kind: 'merge', work: done.culprit, principal: null, state: 'done',
        detail: `Filed ${reland} for the revert of ${done.culprit}'s merge ${done.mergeSha.slice(0, 12)}`.slice(0, 1900), attempts, epoch: null, cycle: state.cycle, at }));
    } catch (error) {
      performed.push(storeAction(state, key, { kind: 'merge', work: done.culprit, principal: null, state: 'failed',
        detail: `Filing the re-land for the revert of ${done.culprit}'s merge failed and is retried: ${message(error)}`.slice(0, 1900), attempts, epoch: null, cycle: state.cycle, at }));
    }
    changed = true;
  }
  return changed;
}

/**
 * One serve-revert attempt (GY-2990): the serve record's verdict moves the baseline forward
 * while it passes, and when the served commit fails a required case past that baseline, the
 * landings between them (merge commits and fast-forwarded heads) name the culprit — the item whose own `e2e:` proof names the failing
 * case, else the newest when every landing names its item — whose revert commit is trialled and pushed beside the cycle. One
 * serve reverts once; a held revert waits; without the git or serve-record ports nothing reads.
 * Answers whether the state changed.
 */
async function serveRevertAttempt(cycle: ServeRevertCycle, reads: MergeWriterReads): Promise<boolean> {
  const { state, snapshot, performed } = cycle;
  if (!reads.git || !reads.serveRecord || state.mergeWriter.inFlight?.revert) return false;
  const git = reads.git, writer = state.mergeWriter, revertState = serveRevertState(state);
  const at = () => new Date(cycle.now()).toISOString();
  let record: Awaited<ReturnType<NonNullable<MergeWriterReads['serveRecord']>>>;
  try { record = await reads.serveRecord(); } catch { return false; }
  if (!record?.commit || !fullServeSha(record.commit)) return false;
  const serve = record.commit.toLowerCase(), check = record.check;
  if (check?.verified) {
    // The served commit passed its required cases: the new baseline a later failure measures from.
    // A healthy main leaves no held revert standing.
    if (revertState.lastVerified === serve && !revertState.held) return false;
    revertState.lastVerified = serve;
    revertState.held = null;
    return true;
  }
  if (!check || check.verified || !check.case || !revertState.lastVerified || serve === revertState.lastVerified) return false;
  const failing = { serve, failingCase: check.case.slice(0, 500), failingStep: check.step?.slice(0, 2000) ?? null, failingReason: check.reason?.slice(0, 2000) ?? null };
  // One serve reverts once.
  if (revertState.reverts.some(entry => entry.serve === serve)) return false;
  // Every kept record owes its re-land: a new revert would have to forget one, so it waits for a filing.
  if (revertState.reverts.filter(entry => !entry.reland).length >= serveRevertsKept) return false;
  if (revertState.held?.serve === serve || flights.has(state)) return false;
  // A serve the guard already answered reads nothing until the serve or the baseline moves.
  if (revertState.answered?.serve === serve && revertState.answered.lastVerified === revertState.lastVerified) return false;
  // An owed retrial waits the base-failure hold like a base-held head (executor.ts GY-1834)
  // unless the tip moved: while it waits no flight is in flight, so the merge queue — whose
  // base-failure repair would let the revert pass — takes its turn.
  let fetched: string | null = null;
  const owed = revertState.retry?.serve === serve ? revertState.retry : null;
  if (owed) {
    try { fetched = (await reads.fetch()).toLowerCase(); } catch { return false; }
    if (fetched === owed.baseTip && cycle.now() - Date.parse(owed.at) < baseFailureHoldMs) return false;
    revertState.retry = null;
  }
  let baseTip: string;
  try { baseTip = fetched ?? (await reads.fetch()).toLowerCase(); } catch { return false; }
  let onStep: ((step: string) => void) | undefined;
  try {
    const result = await runServeRevert({
      git,
      trial: (sha, files, item) => reads.trial(sha, files, item, baseTip, onStep),
      push: reads.push,
      // The persisted pushed-revert record owns filing and its retries (fileOwedRelands).
      file: async () => null,
    }, {
      ...failing, lastVerified: revertState.lastVerified, baseTip, baseBranch: reads.baseBranch,
      work: snapshot.work, alreadyReverted: revertState.reverts.map(entry => entry.mergeSha),
      schedule: async ({ culprit, mergeSha, revertSha }, run) => {
        const key = culprit.key, id = culprit.id, startedAt = at();
        const context: RevertFlight = { ...failing, mergeSha, revertSha, baseTip };
        const entry: Flight = { key, id, head: revertSha, startedAt, settled: null, revert: context };
        // Publish the flight only after persisting its revert, so restart recovery can
        // recognize a push even when the process dies before it records the result.
        writer.inFlight = { key, id, head: revertSha, startedAt, attempt: randomUUID(), step: 'revert trial', stepStartedAt: startedAt, revert: context };
        try { await cycle.effects.persist(state); } catch (error) { writer.inFlight = null; throw error; }
        flights.set(state, entry);
        onStep = step => {
          if (writer.inFlight?.head !== revertSha) return;
          writer.inFlight = { ...writer.inFlight, step, stepStartedAt: at() };
          void cycle.effects.persist(state).catch(() => {});
        };
        void run().then(decided => {
          if (decided.outcome === 'reverted') entry.settled = { revert: { ok: true } };
          else if (decided.outcome === 'held' || decided.outcome === 'retry')
            entry.settled = { revert: { ok: false, reason: decided.reason, retry: decided.outcome === 'retry' } };
        }).catch(error => { entry.settled = { error }; });
      },
    });
    if (result.outcome === 'already-reverted') {
      revertState.answered = { serve, lastVerified: revertState.lastVerified };
      return true;
    }
    if (result.outcome === 'held') {
      revertState.held = { serve, culprit: result.culprit.key, reason: result.reason.slice(0, 2000), at: at() };
      performed.push(storeAction(state, mergeWriterActionKey(result.culprit.key, result.mergeSha), { kind: 'merge', work: result.culprit.key, principal: null, state: 'failed',
        detail: `Held: ${result.reason}`.slice(0, 1900), attempts: 1, epoch: null, cycle: state.cycle, at: at() }));
      return true;
    }
    return result.outcome === 'scheduled';
  } catch { return false; }
}

/** A full 40-hex sha, the only serve record this step acts on. */
const fullServeSha = (sha: string) => /^[0-9a-f]{40}$/i.test(sha);

/**
 * Cycle step 6b' (right after the merge step). Without `effects.mergeWriter` it does nothing. Each cycle: the merge that settled since the last one is recorded
 * (delivered, refused, re-queued or failed), and every rework a trial failure grounds is requested
 * until the server confirms it (AC-3); then, with nothing in flight, every intent a crash left open is reconciled
 * against the base (AC-5) before anything new; then the queue is read from the snapshot and its
 * oldest heads, up to `defaultMergeBatch`, are merged together beside the cycle, one batch at a time (AC-1, GY-2088). A timeout measures the host, not
 * the merge: the timed-out head yields its turn and is tried alone after every other queued head, and one
 * that times out repeatedly where other heads' trials passed is refused to rework (GY-2079).
 */
export async function mergeWriterStep(cycle: Cycle) {
  const { state, effects, now, snapshot, performed } = cycle;
  const reads = effects.mergeWriter;
  if (!reads) return;
  // GY-1902: item previews start, settle and end beside the cycle under any merger; a failure here never holds a merge.
  if (reads.itemPreviews) {
    let live = itemPreviews.get(state);
    if (!live) itemPreviews.set(state, live = new Map());
    try { await itemPreviewStep(live, snapshot.work, reads.itemPreviews); } catch (error) { console.error(`The item preview step failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const writer = state.mergeWriter;
  writer.timeouts ??= []; // GY-2079: the yields the queue turns over, read plainly below and persisted with the rest.
  const at = () => new Date(now()).toISOString();
  let changed = false, delivered = false;
  // GY-2053: the summary names its own motion bound — the configured worst case for one flight — so the owed-decision readers hold a held head through the whole live flight however the install configures retrials.
  const motionBoundMs = mergeWriterFlightBoundMs(cycle.config?.run ?? {});
  if (writer.motionBoundMs !== motionBoundMs) { writer.motionBoundMs = motionBoundMs; changed = true; }
  const flight = flights.get(state);
  if (flight?.settled) {
    flights.delete(state);
    writer.inFlight = null; changed = true;
    if (flight.revert) {
      // GY-2990: a serve-revert flight settles its pushed revert, holds
      // it, or owes its retrial. A trial that threw settles as an owed retrial too — never as a
      // merge of the culprit's key under the revert sha, which would dirty the culprit's records.
      const revert: RevertSettled = 'revert' in flight.settled ? flight.settled.revert
        : { ok: false, reason: `the revert trial failed before it was recorded: ${message('error' in flight.settled ? flight.settled.error : 'no verdict')}`, retry: true };
      settleServeRevertFlight(cycle, reads, { key: flight.key, head: flight.head, revert: flight.revert }, revert);
    } else {
      // A batch (GY-2088) settles each of its heads as a merge of its own.
      const results: BatchResult[] = 'error' in flight.settled ? [{ work: { key: flight.key, id: flight.id } as Work, error: flight.settled.error }] : (flight.settled as { results: BatchResult[] }).results;
      for (const result of results) {
        const { key: itemKey, id } = result.work, head = result.work.candidate?.sha.toLowerCase() ?? flight.head;
        const key = mergeWriterActionKey(itemKey, head), attempts = (state.actions[key]?.attempts ?? 0) + 1;
        const action = (actionState: 'done' | 'failed', detail: string) => performed.push(storeAction(state, key, { kind: 'merge', work: itemKey, principal: null, state: actionState, detail: detail.slice(0, 1900), attempts, epoch: null, cycle: state.cycle, at: at() }));
        if ('error' in result) {
          const error = result.error;
          if (error instanceof TrialTimeoutError) {
            // GY-2079: a timeout measures the host, not the merge: the head yields its turn behind every
            // queued head, and repeated timeouts where another head's trial passed are a ground, not noise.
            const counted = countTrialTimeout(writer, { key: itemKey, id, head }, at(), timeoutFiles(error));
            action('failed', counted.reason ? `Merge of ${itemKey} head ${head} timed out its trial ${counted.count} times while other heads' trials passed (${error.message}); the head is refused once this cycle has settled the intent its trial left open, and returns to a worker`
              : `Merge of ${itemKey} head ${head} timed out in its trial (${error.message}); a timeout measures the host, not the merge, so the head yields its turn and is tried after every other queued head`);
          } else action('failed', keyReusedRefusal(error) ? `Merge of ${itemKey} head ${head} was refused a record key reused with different input; that key is never sent again: the item's merge ledger is adopted and the head is tried again under a new attempt id`
            : `Merge of ${itemKey} head ${head} failed before it was recorded, so the head stays queued and is tried again: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const { outcome } = result;
        if (outcome.outcome === 'merged' || outcome.outcome === 'reconciled') {
          writer.lastMergeAt = at();
          // GY-2079: this head's trial passed — the yields' evidence that the host completes trials.
          for (const counted of writer.timeouts) if (counted.key !== itemKey) counted.othersPassed = true;
          delivered = true;
          action('done', outcome.outcome === 'merged' ? `Merged ${itemKey} head ${head} as ${outcome.mergeSha} onto ${outcome.baseTip} with ${outcome.pushes} push(es); ${reads.baseBranch} observed at ${outcome.observedTip} and the item delivered`
            : `Reconciled ${itemKey} head ${head}: ${reads.baseBranch} already held ${outcome.mergeSha} (observed at ${outcome.observedTip}), so it was delivered without a second push`);
        } else {
          writer.refusals = [...writer.refusals, { key: itemKey, head, reason: outcome.reason.slice(0, 2000), at: at() }].slice(-mergeWriterKeptRefusals);
          action('failed', outcome.outcome === 'requeued' ? `Merge of ${itemKey} head ${head} refused: ${outcome.reason} (${outcome.pushes} leased pushes rejected); the head stays queued`
            : `Merge of ${itemKey} head ${head} refused: ${outcome.reason}; the refusal is recorded on the ledger and the rework it grounds is requested`);
          // The trial failed the head (AC-3): the rework is owed until the server confirms it, and asked for below.
          if (outcome.outcome === 'refused' && !writer.reworks.some(entry => entry.key === itemKey && entry.head === head)) {
            writer.reworks = [...writer.reworks, { key: itemKey, id, head, reason: outcome.reason.slice(0, 2000), refusedAt: at(), attempts: 0, lastError: null }].slice(-mergeWriterKeptReworks);
          }
        }
      }
    }
  }
  if (await requestPendingReworks(cycle)) changed = true;
  // GY-2990: a served commit that fails live verification reverts only the item that broke it.
  // The attempt runs beside the cycle like a merge (its trial and leased push), so once one is
  // in flight the replay and reconcile below wait — `flights.has(state)` guards them already.
  if (await reconcileServeRevert(cycle, reads)) changed = true;
  if (await fileOwedRelands(cycle, reads)) changed = true;
  if (await serveRevertAttempt(cycle, reads)) changed = true;
  // GY-1852: a write whose reply was lost is replayed first; the snapshot predates it, so nothing new starts in the cycle that settled one.
  const replayed = !flights.has(state) && await replayUnconfirmed(cycle, reads.record);
  if (replayed) changed = true;
  // A merge that landed this cycle starts nothing new: the loop upgrades onto it between cycles, and a
  // trial started now would die in that restart and run again (12 of 17 merges on 2026-10-18 lost one so).
  if (!flights.has(state) && !writer.inFlight?.revert && !replayed && !delivered) {
    const ledger = snapshotLedger(snapshot.work);
    // Intents a crash left open are settled against the base before any new merge (AC-5); the next cycle reads the snapshot they changed.
    // Each item's reconcile is its own attempt (GY-1852), so a pushed or reconciled record retried later never reuses a key with a new instant or tip.
    const attempts = new Map<string, MergePorts['record']>();
    const record: MergePorts['record'] = (item, event) => { const recorder = attempts.get(item.id) ?? attemptRecorder(writer, reads.record, randomUUID(), at); attempts.set(item.id, recorder); return recorder(item, event); };
    let reconciled: Awaited<ReturnType<typeof reconcileIntents>>;
    try { reconciled = await reconcileIntents({ ...reads, record }, snapshot.work, ledger); }
    catch (error) { if (writer.unconfirmed?.length) await effects.persist(state); throw error; }
    for (const entry of reconciled) {
      if (entry.outcome === 'reconciled') writer.lastMergeAt = at();
      performed.push(storeAction(state, `merge-writer-reconcile:${entry.key}:${entry.mergeSha}`, { kind: 'merge', work: entry.key, principal: null, state: entry.outcome === 'held' ? 'failed' : 'done', attempts: 1, epoch: null, cycle: state.cycle, at: at(),
        detail: entry.outcome === 'held' ? `Recovery of ${entry.key} for ${entry.mergeSha} remains held: ${entry.reason}; original intent and trial retained, head excluded from fresh merges`
          : entry.outcome === 'reconciled' ? `Reconciled an open intent of ${entry.key}: ${reads.baseBranch} holds ${entry.mergeSha}, so it is recorded pushed and reconciled and the item delivered without a second push`
          : `Settled an open intent of ${entry.key} for ${entry.mergeSha}: it is refused and the current head queued again` }));
      changed = true;
    }
    // GY-2079: with the cycle's open intents settled, a head whose timeout record reached the bound is refused: the refusal is the ledger's last word for the head, so the queue drops it, and the rework it grounds is requested next cycle. A write whose reply was lost is replayed (GY-1852); the record keeps its reason and is asked for again.
    for (const counted of writer.timeouts) {
      if (!counted.reason) continue;
      const item = snapshot.work.find(entry => entry.id === counted.id);
      if (!item) { counted.reason = null; continue; }
      try { await record(item, { kind: 'refused', head: counted.head, reason: counted.reason }); }
      catch { continue; }
      const key = mergeWriterActionKey(counted.key, counted.head);
      writer.refusals = [...writer.refusals, { key: counted.key, head: counted.head, reason: counted.reason.slice(0, 2000), at: at() }].slice(-mergeWriterKeptRefusals);
      if (!writer.reworks.some(entry => entry.key === counted.key && entry.head === counted.head)) {
        writer.reworks = [...writer.reworks, { key: counted.key, id: counted.id, head: counted.head, reason: counted.reason.slice(0, 2000), refusedAt: at(), attempts: 0, lastError: null }].slice(-mergeWriterKeptReworks);
      }
      performed.push(storeAction(state, key, { kind: 'merge', work: counted.key, principal: null, state: 'failed', attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: at(),
        detail: `Merge of ${counted.key} head ${counted.head} timed out its trial ${counted.count} times while other heads' trials passed: refused (${counted.reason}); the refusal is recorded on the ledger and the rework it grounds is requested` }));
      counted.reason = null;
      changed = true;
    }
    if (reconciled.every(entry => entry.outcome === 'held')) {
      const held = new Set(reconciled.map(entry => entry.key));
      const queue = mergeQueue(snapshot.work.filter(item => !held.has(item.key)), ledger, now());
      // GY-2079: the heads yielding their queue turn keep the oldest-first order only behind every head not yielding, and the next merge is the first head in that order.
      const yielding = new Set(writer.timeouts.map(entry => `${entry.key}:${entry.head}`));
      const ordered = yielding.size
        ? [...queue.queue.filter(entry => !yielding.has(`${entry.key}:${entry.head}`)), ...queue.queue.filter(entry => yielding.has(`${entry.key}:${entry.head}`))]
        : queue.queue;
      const summary = ordered.slice(0, mergeWriterKeptQueue);
      if (JSON.stringify(summary) !== JSON.stringify(writer.queue)) { writer.queue = summary; changed = true; }
      // GY-2079: a yield whose head the queue no longer holds goes with it.
      const kept = writer.timeouts.filter(entry => ordered.some(queued => queued.key === entry.key && queued.head === entry.head));
      if (kept.length !== writer.timeouts.length) { writer.timeouts = kept; changed = true; }
      // At the cap of unconfirmed reworks nothing new starts: the plane is not taking the writer's decisions.
      const owed = queue.blockedBy ? null : snapshot.work.find(entry => entry.id === ordered[0]?.id) ?? null;
      const next = writer.reworks.length >= mergeWriterKeptReworks ? null : owed;
      const due = next?.candidate && (reads.admit?.() ?? true) ? next : null;
      // GY-2088: the oldest heads, up to the batch size, are merged together; the flight is named by the oldest. A yielding head (GY-2079) merges alone, so its timeouts are its own.
      const yields = (work: Work) => yielding.has(`${work.key}:${work.candidate?.sha.toLowerCase()}`);
      const inOrder = ordered.map(entry => queue.due.find(work => work.id === entry.id)).filter((work): work is Work => !!work);
      const batch = due && yields(due) ? [due] : inOrder.filter(work => !yields(work)).slice(0, Math.max(1, reads.batch ?? 1));
      if (due?.candidate) {
        const head = due.candidate.sha.toLowerCase();
        const entry: Flight = { key: due.key, id: due.id, head, startedAt: at(), settled: null };
        // GY-1852: the attempt id is on the persisted state before the attempt's first write; the flight is published only once it is, so a failed persist leaves nothing in flight and a later cycle starts afresh.
        const attempt = randomUUID();
        // GY-2963: the flight's first step is its wait — the fetch, the trial merge and the intent
        // record before the trial's checkout begins — so even a slow start is named from the first instant.
        writer.inFlight = { key: due.key, id: due.id, head, startedAt: entry.startedAt, attempt, step: 'queue wait', stepStartedAt: entry.startedAt }; changed = true;
        try { await effects.persist(state); } catch (error) { writer.inFlight = null; throw error; }
        flights.set(state, entry);
        const recorder = attemptRecorder(writer, reads.record, attempt, at);
        // Each step the trial reports is where the merge is: on the in-flight entry master status reads, persisted at once, and on the item's ledger the pipeline and Work page read.
        const onStep: NonNullable<MergePorts['onStep']> = step => {
          if (writer.inFlight?.head !== head) return;
          writer.inFlight = { ...writer.inFlight, step, stepStartedAt: at() };
          void effects.persist(state).catch(() => {});
          void recorder(due, { kind: 'trial-step', head, step, at: at() }).catch(() => {});
        };
        void mergeBatch({ ...reads, record: recorder, onStep }, batch).then(results => { entry.settled = { results }; }, error => { entry.settled = { error }; });
      }
    }
  }
  if (changed) await effects.persist(state);
}

/**
 * The `mergeWriter` section of `master status` and the daemon summary: the queue, the merge in flight, the last delivery, the newest refusals, the reworks still owed, and — GY-2053 — the attempt progress and motion bound the owed-decision readers hold a head inside. The two new fields are
 * optional, so a summary an older loop built, or a writer that has not run yet, reads as before.
 * With `now` (GY-2963) the flight names its current step's elapsed time and whether it has run past
 * the stall bound without a step advancing.
 */
export type MergeWriterSummary = {
  queue: MergeWriterState['queue']; inFlight: (MergeWriterState['inFlight'] & { stepMs?: number; stalled?: boolean }) | null; lastMergeAt: string | null;
  refusals: MergeWriterState['refusals']; reworks: MergeWriterState['reworks'];
  progress?: MergeWriterState['progress']; motionBoundMs?: MergeWriterState['motionBoundMs'];
  /** GY-2990: the last verified serve, the reverts a failing serve caused, and the revert held when its own trial failed. */
  serveRevert?: MergeWriterState['serveRevert'];
};
export const mergeWriterSummary = (writer: MergeWriterState | null | undefined, now?: number): MergeWriterSummary => {
  if (!writer) return { queue: [], inFlight: null, lastMergeAt: null, refusals: [], reworks: [] };
  const at = writer.inFlight ? Date.parse(writer.inFlight.stepStartedAt ?? writer.inFlight.startedAt) : Number.NaN;
  const inFlight = writer.inFlight && Number.isFinite(at) && now !== undefined
    ? { ...writer.inFlight, stepMs: Math.max(0, now - at), stalled: now - at >= mergeStallMs }
    : writer.inFlight;
  return { queue: writer.queue, inFlight, lastMergeAt: writer.lastMergeAt, refusals: writer.refusals, reworks: writer.reworks, progress: writer.progress, motionBoundMs: writer.motionBoundMs, serveRevert: writer.serveRevert };
};
export type { MergeRecordEvent };
