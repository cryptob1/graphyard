// Concern: the control-plane merge executor's cycle step (GY-1524) — reconcile open intents, pick the next head, run one merge beside the cycle and record what it did.
import { z } from 'zod';
import type { ChildRun } from '../child-runner.js';
import type { MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import type { MergerMode } from '../merger-mode.js';
import type { MergeLedgerState } from '../model/merge-ledger.js';
import { mergeWriterTrialGround } from '../model/rework-ground.js';
import { installIdFor } from '../install/types.js';
import { mergeWriterSettings, shadowGateSettings } from '../master/merge-writer-settings.js';
import { trialMerge, TrialTimeoutError } from '../merge-writer/trial.js';
import { criterionProofs, firstParentHolds, mergeOne, mergeQueue, proofTestFiles, pushArgs, pushEnvironment, reconcileIntents, runMergeTrial, staleLeaseRejection, type MergeOutcome, type MergePorts, type MergeRecordEvent } from '../merge-writer/executor.js';
import { storeAction, type DaemonState } from './state.js';
import type { Cycle } from './cycle.js';

/** How many queued heads, how many refusals and how many pending rework requests `state.mergeWriter` keeps. */
export const mergeWriterKeptQueue = 50, mergeWriterKeptRefusals = 20, mergeWriterKeptReworks = 50;
const shaField = z.string().max(64), instant = z.string().max(64);
/**
 * A rework a failed trial grounds that the server has not yet confirmed (AC-3): kept until the
 * decision request succeeds or the snapshot shows the item reworked, moved to a new head or done,
 * and requested again every cycle until then. A refused head leaves the queue, so nothing but this
 * record would ask again.
 */
export const pendingReworkSchema = z.object({ key: z.string().max(100), id: z.string().max(100), head: shaField, reason: z.string().max(2000), refusedAt: instant, attempts: z.number().int().min(0).max(100_000), lastError: z.string().max(2000).nullable() }).strict();
export type PendingRework = z.infer<typeof pendingReworkSchema>;
/** `state.mergeWriter`: when the writer last delivered, the heads owed a merge oldest first, the merge in flight, the newest refusals, and the reworks still to be confirmed. */
export const mergeWriterStateSchema = z.object({
  lastMergeAt: instant.nullable().default(null),
  queue: z.array(z.object({ key: z.string().max(100), id: z.string().max(100), head: shaField, submittedAt: instant, waitingMs: z.number().int().min(0) }).strict()).max(mergeWriterKeptQueue).default([]),
  inFlight: z.object({ key: z.string().max(100), id: z.string().max(100), head: shaField, startedAt: instant }).strict().nullable().default(null),
  refusals: z.array(z.object({ key: z.string().max(100), head: shaField, reason: z.string().max(2000), at: instant }).strict()).max(mergeWriterKeptRefusals).default([]),
  reworks: z.array(pendingReworkSchema).max(mergeWriterKeptReworks).default([]),
}).strict();
export type MergeWriterState = z.infer<typeof mergeWriterStateSchema>;
export const emptyMergeWriterState = (): MergeWriterState => mergeWriterStateSchema.parse({});

/** The step's ports (merge-writer/executor.ts) and the one read that switches it on: the recorded merger. */
export interface MergeWriterReads extends MergePorts {
  /** The install's recorded merger (`/api/status` `mergeWriter.merger`); the step acts only under `control-plane`. */
  merger(): Promise<MergerMode>;
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
  options: { base: string; record: MergePorts['record']; merger: () => Promise<MergerMode>; trial?: typeof runMergeTrial; environment?: NodeJS.ProcessEnv; now?: () => number }): MergeWriterReads {
  const git = async (...args: string[]) => String(await run('git', ['-C', root, ...args]));
  const gitAs = async (args: string[], env?: Record<string, string>) => String(await run('git', ['-C', root, ...args], env ? { env: { ...(options.environment ?? process.env), ...env } } : undefined));
  const settings = mergeWriterSettings(config.run, installIdFor(config.repository)), shadow = shadowGateSettings(config.run);
  const base = config.baseBranch, ref = `refs/remotes/origin/${base}`;
  const tip = async () => {
    const sha = (await git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`The coordinator checkout holds no ${ref} to merge onto`);
    return sha;
  };
  return {
    baseBranch: base, retrials: settings.retrials, now: options.now ?? Date.now, merger: options.merger, record: options.record,
    fetch: async () => { await git('fetch', '--no-tags', 'origin', base); return tip(); },
    merge: async (head, baseTip) => {
      const merged = await trialMerge(gitAs, { head, baseTip });
      if ('conflict' in merged) return merged;
      return { mergeSha: merged.mergeSha, files: (await git('diff', '--name-only', baseTip, merged.mergeSha)).split('\n').map(line => line.trim()).filter(Boolean) };
    },
    trial: async (mergeSha, files, item) => {
      const proofs = criterionProofs(item);
      const proofFiles = await proofTestFiles(run, root, mergeSha, proofs);
      return (options.trial ?? runMergeTrial)({ root, base: options.base, mergeSha, changedFiles: files, proofs, proofFiles, timeoutMs: shadow.timeoutMinutes * 60_000, key: item.key, run, environment: options.environment });
    },
    push: async (mergeSha, baseTip) => {
      try { await run('git', ['-C', root, ...pushArgs(base, baseTip, mergeSha)], { env: pushEnvironment(settings.deployKeyFile, options.environment) }); return 'pushed'; }
      catch (error) { if (staleLeaseRejection(output(error))) return 'rejected'; throw error; }
    },
    // The whole first-parent history, not a window of it: an intent older than any bound is still a push (AC-5).
    holds: sha => firstParentHolds(args => git(...args), ref, sha),
  };
}

interface Flight { key: string; id: string; head: string; startedAt: string; settled: { outcome: MergeOutcome; work: Work } | { error: unknown } | null }
const flights = new WeakMap<DaemonState, Flight>();
/** Resolves once the merge in flight for `state` has settled; for the step's tests. */
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
  if (!writer.reworks.length) return false;
  const at = () => new Date(now()).toISOString();
  const kept: PendingRework[] = [];
  for (const pending of writer.reworks) {
    const key = mergeWriterReworkKey(pending.key, pending.head);
    const item = snapshot.work.find(entry => entry.key === pending.key);
    const applied = !item || item.stage === 'done' || item.reworkRequested || item.candidate?.sha.toLowerCase() !== pending.head;
    const action = (actionState: 'done' | 'failed', detail: string) => performed.push(storeAction(state, key, { kind: 'decision', work: pending.key, principal: null, state: actionState, detail: detail.slice(0, 1900), attempts: pending.attempts + 1, epoch: null, cycle: state.cycle, at: at() }, actionState === 'done' ? undefined : null));
    if (applied) { action('done', `The rework the merge writer's refusal of ${pending.key} head ${pending.head} grounds is applied: the snapshot shows the item ${!item || item.stage === 'done' ? 'done' : item.reworkRequested ? 'returned to a worker' : 'on a new head'}`); continue; }
    if (!effects.decide) { kept.push({ ...pending, attempts: pending.attempts + 1, lastError: 'this loop runs without the decision effects' }); action('failed', `The rework the merge writer's refusal of ${pending.key} head ${pending.head} grounds waits: this loop runs without the decision effects, so request it with graphyard master decide ${pending.key} rework '${JSON.stringify(trialFailureRework(item, pending.head, pending.reason).input)}' REASON`); continue; }
    const rework = trialFailureRework(item, pending.head, pending.reason);
    try {
      const decided = await effects.decide(item, 'rework', rework.reason, rework.input);
      action('done', `Requested the rework the merge writer's refusal of ${pending.key} head ${pending.head} grounds (decision ${decided.id}); the server applies it with the writer as its approver`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      kept.push({ ...pending, attempts: pending.attempts + 1, lastError: message.slice(0, 2000) });
      action('failed', `The rework the merge writer's refusal of ${pending.key} head ${pending.head} grounds was not requested (attempt ${pending.attempts + 1}); it is asked for again next cycle: ${message}`);
    }
  }
  writer.reworks = kept;
  return true;
}

/**
 * Cycle step 6b' (right after the merge step). Active only while the recorded merger is
 * `control-plane` (AC-6); without `effects.mergeWriter` (a loop wired without the reads, or a
 * test) it does nothing. Each cycle: the merge that settled since the last one is recorded
 * (delivered, refused, re-queued or failed), and every rework a trial failure grounds is requested
 * until the server confirms it (AC-3); then, with nothing in flight, every intent a crash left open is reconciled
 * against the base (AC-5) before anything new; then the queue is read from the snapshot and its
 * oldest head is merged beside the cycle, one at a time (AC-1). A timeout measures the host, not
 * the merge: the head stays queued and is tried again.
 */
export async function mergeWriterStep(cycle: Cycle) {
  const { state, effects, now, snapshot, performed } = cycle;
  const reads = effects.mergeWriter;
  if (!reads) return;
  const writer = state.mergeWriter;
  const at = () => new Date(now()).toISOString();
  let changed = false;
  const flight = flights.get(state);
  if (flight?.settled) {
    flights.delete(state);
    writer.inFlight = null; changed = true;
    const key = mergeWriterActionKey(flight.key, flight.head), attempts = (state.actions[key]?.attempts ?? 0) + 1;
    const action = (actionState: 'done' | 'failed', detail: string) => performed.push(storeAction(state, key, { kind: 'merge', work: flight.key, principal: null, state: actionState, detail: detail.slice(0, 1900), attempts, epoch: null, cycle: state.cycle, at: at() }, actionState === 'done' ? undefined : null));
    if ('error' in flight.settled) {
      const error = flight.settled.error;
      action('failed', error instanceof TrialTimeoutError ? `Merge of ${flight.key} head ${flight.head} timed out in its trial (${error.message}); a timeout measures the host, not the merge, so the head stays queued and is tried again`
        : `Merge of ${flight.key} head ${flight.head} failed before it was recorded, so the head stays queued and is tried again: ${error instanceof Error ? error.message : String(error)}`);
    } else {
      const { outcome, work } = flight.settled;
      if (outcome.outcome === 'merged' || outcome.outcome === 'reconciled') {
        writer.lastMergeAt = at();
        action('done', outcome.outcome === 'merged' ? `Merged ${flight.key} head ${flight.head} as ${outcome.mergeSha} onto ${outcome.baseTip} with ${outcome.pushes} push(es); ${reads.baseBranch} observed at ${outcome.observedTip} and the item delivered`
          : `Reconciled ${flight.key} head ${flight.head}: ${reads.baseBranch} already held ${outcome.mergeSha} (observed at ${outcome.observedTip}), so it was delivered without a second push`);
      } else {
        writer.refusals = [...writer.refusals, { key: flight.key, head: flight.head, reason: outcome.reason.slice(0, 2000), at: at() }].slice(-mergeWriterKeptRefusals);
        action('failed', outcome.outcome === 'requeued' ? `Merge of ${flight.key} head ${flight.head} refused: ${outcome.reason} (${outcome.pushes} leased pushes rejected); the head stays queued`
          : `Merge of ${flight.key} head ${flight.head} refused: ${outcome.reason}; the refusal is recorded on the ledger and the rework it grounds is requested`);
        // The trial failed the head (AC-3): the rework is owed until the server confirms it, and asked for below.
        if (outcome.outcome === 'refused' && !writer.reworks.some(entry => entry.key === flight.key && entry.head === flight.head)) {
          writer.reworks = [...writer.reworks, { key: flight.key, id: flight.id, head: flight.head, reason: outcome.reason.slice(0, 2000), refusedAt: at(), attempts: 0, lastError: null }].slice(-mergeWriterKeptReworks);
        }
      }
    }
  }
  if (await requestPendingReworks(cycle)) changed = true;
  if (!flights.has(state)) {
    if ((await reads.merger()) !== 'control-plane') {
      if (writer.queue.length) { writer.queue = []; changed = true; }
    } else {
      const ledger = snapshotLedger(snapshot.work);
      // Intents a crash left open are settled against the base before any new merge (AC-5); the next cycle reads the snapshot they changed.
      const reconciled = await reconcileIntents(reads, snapshot.work, ledger);
      for (const entry of reconciled) {
        if (entry.outcome === 'reconciled') writer.lastMergeAt = at();
        performed.push(storeAction(state, `merge-writer-reconcile:${entry.key}:${entry.mergeSha}`, { kind: 'merge', work: entry.key, principal: null, state: 'done', attempts: 1, epoch: null, cycle: state.cycle, at: at(),
          detail: entry.outcome === 'reconciled' ? `Reconciled an open intent of ${entry.key}: ${reads.baseBranch} holds ${entry.mergeSha}, so it is recorded pushed and reconciled and the item delivered without a second push`
            : `An open intent of ${entry.key} was never pushed: ${reads.baseBranch} does not hold ${entry.mergeSha}, so it is refused and the head queued again` }));
        changed = true;
      }
      if (!reconciled.length) {
        const queue = mergeQueue(snapshot.work, ledger, now());
        const summary = queue.queue.slice(0, mergeWriterKeptQueue);
        if (JSON.stringify(summary) !== JSON.stringify(writer.queue)) { writer.queue = summary; changed = true; }
        // At the cap of unconfirmed reworks nothing new starts: the plane is not taking the writer's decisions.
        const due = writer.reworks.length >= mergeWriterKeptReworks ? null : queue.next;
        if (due?.candidate) {
          const head = due.candidate.sha.toLowerCase();
          const entry: Flight = { key: due.key, id: due.id, head, startedAt: at(), settled: null };
          flights.set(state, entry);
          writer.inFlight = { key: due.key, id: due.id, head, startedAt: entry.startedAt }; changed = true;
          void mergeOne(reads, due).then(outcome => { entry.settled = { outcome, work: due }; }, error => { entry.settled = { error }; });
        }
      }
    }
  }
  if (changed) await effects.persist(state);
}

/** The `mergeWriter` section of `master status` and the daemon summary: the queue, the merge in flight, the last delivery, the newest refusals and the reworks still owed. */
export const mergeWriterSummary = (writer: MergeWriterState | null | undefined) =>
  writer ? { queue: writer.queue, inFlight: writer.inFlight, lastMergeAt: writer.lastMergeAt, refusals: writer.refusals, reworks: writer.reworks } : { queue: [], inFlight: null, lastMergeAt: null, refusals: [], reworks: [] };
export type { MergeRecordEvent };
