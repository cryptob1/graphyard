import { z } from 'zod';
/** How many queued heads, how many refusals, how many pending rework requests and how many trial-timeout yields `state.mergeWriter` keeps. */
export const mergeWriterKeptQueue = 50, mergeWriterKeptRefusals = 20, mergeWriterKeptReworks = 50, mergeWriterKeptTimeouts = 50;
/** GY-2079: the trial timeouts a head is refused to rework after, counted only on trials where another queued head passed since the head's previous timeout (a timeout alone measures the host, not the merge). */
export const mergeWriterTrialTimeoutRefusals = 2;
/** How many record writes whose reply was lost `state.mergeWriter` keeps, and how many cycles one is replayed before the ledger is adopted instead (GY-1852). */
export const mergeWriterKeptUnconfirmed = 20, mergeWriterUnconfirmedReplays = 10;
const shaField = z.string().max(64), instant = z.string().max(64);
/** Legacy cursor bound; durable revert history now lives on the merge ledger. */
export const serveRevertsKept = 20;
/**
 * A rework a failed trial grounds that the server has not yet confirmed (AC-3): kept until the
 * decision request succeeds or the snapshot shows the item reworked, moved to a new head or done,
 * and requested again every cycle until then. A refused head leaves the queue, so nothing but this
 * record would ask again.
 */
export const pendingReworkSchema = z.object({ key: z.string().max(100), id: z.string().max(100), head: shaField, reason: z.string().max(2000), refusedAt: instant, attempts: z.number().int().min(0).max(100_000), lastError: z.string().max(2000).nullable() }).strict();
export type PendingRework = z.infer<typeof pendingReworkSchema>;
/**
 * GY-1852: a merge record write whose reply the loop never saw (a transport failure or a 5xx): the
 * attempt and write it was sent under and its exact input, replayed next cycle under the same key.
 */
export const unconfirmedRecordSchema = z.object({ key: z.string().max(100), id: z.string().max(100), attempt: z.string().max(100), write: z.number().int().min(0).max(1000),
  event: z.record(z.string(), z.unknown()), sentAt: instant, replays: z.number().int().min(0).max(100_000), lastError: z.string().max(2000) }).strict();
export type UnconfirmedRecord = z.infer<typeof unconfirmedRecordSchema>;
/** GY-2053: the newest attempt progress the writer's own summary keeps, so a multi-attempt flight keeps showing movement. */
const attemptProgressSchema = z.object({ at: instant, what: z.string().max(2000) }).strict();
/**
 * GY-2990: what a serve revert in flight is answering, persisted before its trial so a restart after
 * the push still settles it: the failing serve, the reverted merge, the revert commit and the tip it
 * was made on.
 */
const revertFlightSchema = z.object({ serve: shaField, mergeSha: shaField, revertSha: shaField, baseTip: shaField,
  failingCase: z.string().max(500), failingStep: z.string().max(2000).nullable(), failingReason: z.string().max(2000).nullable() }).strict();
export type RevertFlight = z.infer<typeof revertFlightSchema>;
/** `state.mergeWriter`: when the writer last delivered, the heads owed a merge oldest first (a trial-timeout yield last, GY-2079), the merge in flight, the newest refusals, the reworks still to be confirmed, and the heads yielding their queue turn. */
export const mergeWriterStateSchema = z.object({
  lastMergeAt: instant.nullable().default(null),
  queue: z.array(z.object({ key: z.string().max(100), id: z.string().max(100), head: shaField, submittedAt: instant, waitingMs: z.number().int().min(0) }).strict()).max(mergeWriterKeptQueue).default([]),
  /** The merge in flight; `attempt` is the id its record keys carry (GY-1852), persisted before its first write. `step` (GY-2963) is where its trial is, with the instant the step began; `revert` (GY-2990) marks a serve revert. */
  inFlight: z.object({ key: z.string().max(100), id: z.string().max(100), head: shaField, startedAt: instant, attempt: z.string().max(100).optional(),
    step: z.string().max(100).optional(), stepStartedAt: instant.optional(), revert: revertFlightSchema.optional() }).strict().nullable().default(null),
  refusals: z.array(z.object({ key: z.string().max(100), head: shaField, reason: z.string().max(2000), at: instant }).strict()).max(mergeWriterKeptRefusals).default([]),
  reworks: z.array(pendingReworkSchema).max(mergeWriterKeptReworks).default([]),
  /** GY-2053: the newest attempt progress — a retrial's intent, a trial verdict, a push, a reconcile — recorded beside every ledger write a flight or reconcile makes, so the movement the summary reports advances inside a long flight. Absent until a write records it. */
  progress: attemptProgressSchema.optional(),
  /** GY-2053: the writer's own motion bound, its configured worst case for one flight ((retrials + 1) × the trial timeout plus a cycle); the owed-decision readers hold a held head inside it. Absent until the writer step first runs. */
  motionBoundMs: z.number().int().min(0).optional(),
  /** GY-2079: the heads whose merge trial timed out, yielding their queue turn until they leave the queue; absent until one does. `count` is the timeouts counted toward the refusal bound (only where another head passed since the previous one); `reason` is set while the bound refusal it names is still owed. */
  timeouts: z.array(z.object({ key: z.string().max(100), id: z.string().max(100), head: shaField, at: instant, count: z.number().int().min(1).max(100_000), othersPassed: z.boolean(), reason: z.string().max(2000).nullable() }).strict()).max(mergeWriterKeptTimeouts).optional(),
  /** GY-1852: record writes whose reply was lost, replayed with their exact input before anything new starts; absent until one is. */
  unconfirmed: z.array(unconfirmedRecordSchema).max(mergeWriterKeptUnconfirmed).optional(),
  /**
   * GY-2990: the last served commit whose required cases passed, the reverts a failing serve
   * already caused (each keyed by the serve it answered, so one serve reverts once, and carrying
   * its failing case, so an owed re-land is filed whatever is served later, and never twice; a merge reverts once altogether, so a serve that still fails
   * after its revert never reverts the same merge again), and the revert held when its own
   * trial failed. Absent until the serve-revert step first runs.
   */
  serveRevert: z.object({
    lastVerified: shaField.nullable().default(null),
    reverts: z.array(z.object({ serve: shaField, culprit: z.string().max(100), mergeSha: shaField, revertSha: shaField, reland: z.string().max(100).nullable(),
      failingCase: z.string().max(500), failingStep: z.string().max(2000).nullable(), failingReason: z.string().max(2000).nullable(), at: instant }).strict()).default([]),
    held: z.object({ serve: shaField, culprit: z.string().max(100), reason: z.string().max(2000), at: instant }).strict().nullable().default(null),
    /**
     * GY-2990 rework: the last revert attempt that needs another try (a trial failing only
     * where the base fails, a rejected push, a thrown trial): the failing serve, the culprit
     * merge and the tip it was tried on, with when it settled. The next attempt waits
     * `baseFailureHoldMs` like a base-held head (executor.ts GY-1834) unless the tip moves, so
     * retrials never starve the merge queue's base-failure repair.
     */
    retry: z.object({ serve: shaField, culprit: z.string().max(100), mergeSha: shaField, baseTip: shaField, reason: z.string().max(2000), at: instant }).strict().nullable().default(null),
    /**
     * GY-2990 rework: the failing serve the one-merge-reverts-once guard already answered, with
     * the baseline it was answered under — a serve still failing after its revert reads nothing
     * until either moves.
     */
    answered: z.object({ serve: shaField, lastVerified: shaField }).strict().nullable().default(null),
  }).strict().optional(),
}).strict();
export type MergeWriterState = z.infer<typeof mergeWriterStateSchema>;
export const emptyMergeWriterState = (): MergeWriterState => mergeWriterStateSchema.parse({});
