import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal, type Work } from '../model.js';
import { foldMergeLedger, mergeLedgerKinds, mergeTrialKind, type MergeLedgerState } from '../model/merge-ledger.js';
import { settleDelivered } from '../model/actions.js';
import { deliverSplitParent } from '../decomposition.js';
import { reconciliationRefusalPrefix, unauthorizedMergeViolation } from '../merge-queue.js';
import { save } from '../store.js';
import { lockedWork } from '../store/locked-read.js';
import { gitRunnerFor, type GitRunner } from '../merge-writer/local-observation.js';
import { mergeRecordKinds, type MergeRecordEvent } from '../merge-writer/executor.js';
import { applyCandidateRevert, candidateRevertReason, revertLedgerKind, type CandidateRevert } from '../release-revert.js';
import type { Engine } from '../engine.js';
import type { Services } from './routes.js';

/**
 * GY-1524. The merge writer's ledger, written by the loop's coordinator identity through
 * `POST /api/work/:id/merge-record`: one event per step of a merge (model/merge-ledger.ts) —
 * `intent`, `trial` (the executor's own record, whose proof counts the fold keeps beside the state, GY-1528), `pushed`, `reconciled` and
 * `refused`. Every record re-folds the item's ledger into `work.mergeLedger`, which the gates read
 * where they read GitHub's checks and mergeability for a control-plane observation (GY-1523), and
 * saves the item. A `reconciled` delivers the item exactly as a direct merge does (direct-merge.ts
 * `sweepDirectMerges`): stage done, the delivery, `settleDelivered`, `deliverSplitParent`, the jobs
 * row gone, all in the one transaction, saved as `merge-writer.delivered`; one for a merge commit
 * the base branch does not hold is refused, since nothing landed, and so is one (or a `pushed`)
 * for a merge commit the item's own open intent of its submitted head does not name, since a
 * commit main holds for another item or none delivers nothing here. A `revert` (GY-1526) is the
 * candidate revert of a delivered item's merge, in its own phases, recorded as `merge.revert`.
 */
const sha = z.string().regex(/^[0-9a-f]{40}$/i).transform(value => value.toLowerCase());
const instant = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)), 'an ISO 8601 instant');
const tests = z.object({ passed: z.number().int().min(0), failed: z.array(z.string().max(300)).max(100), files: z.number().int().min(0) }).strict();
export const mergeRecordBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('intent'), head: sha, baseTip: sha, mergeSha: sha, risk: z.string().min(1).max(40), at: instant }).strict(),
  z.object({ kind: z.literal('trial'), head: sha, baseTip: sha, mergeSha: sha, build: z.enum(['pass', 'fail']), tests, files: z.array(z.string().max(500)).max(1000),
    proofs: z.record(z.string().max(200), z.object({ executed: z.number().int().min(0), failed: z.number().int().min(0) }).strict()), durationMs: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('pushed'), mergeSha: sha, pushedAt: instant }).strict(),
  z.object({ kind: z.literal('reconciled'), mergeSha: sha, observedTip: sha }).strict(),
  z.object({ kind: z.literal('refused'), head: sha, reason: z.string().min(1).max(2000) }).strict(),
]);
export type MergeRecordBody = z.infer<typeof mergeRecordBodySchema>;
/**
 * GY-1526: the revert of a delivered item's merge for a failed release candidate, in the same
 * phases a merge takes (release-revert.ts `revertCandidateItem`), each recorded as `merge.revert`.
 * The `reconciled` phase, once the base branch holds the revert commit, records the revert on the
 * item (`candidateReverts`) and reopens it with a rework naming the case and step.
 */
const revertPhase = { kind: z.literal('revert'), mergeSha: sha, candidate: z.string().min(1).max(100), case: z.string().min(1).max(200), step: z.string().min(1).max(500), at: instant };
export const revertRecordBodySchema = z.discriminatedUnion('phase', [
  z.object({ ...revertPhase, phase: z.literal('intent'), revertSha: sha, baseTip: sha }).strict(),
  z.object({ ...revertPhase, phase: z.literal('trial'), revertSha: sha, baseTip: sha, build: z.enum(['pass', 'fail']), tests, durationMs: z.number().int().min(0) }).strict(),
  z.object({ ...revertPhase, phase: z.literal('pushed'), revertSha: sha, pushedAt: instant }).strict(),
  z.object({ ...revertPhase, phase: z.literal('reconciled'), revertSha: sha, observedTip: sha }).strict(),
  z.object({ ...revertPhase, phase: z.literal('refused'), reason: z.string().min(1).max(2000) }).strict(),
]);
export type RevertRecordBody = z.infer<typeof revertRecordBodySchema>;
/** The save reason a reconciled revert reopens the item under. */
export const revertReopenedReason = 'candidate-revert.reopened';
/** The refusal of a revert record naming a merge the item did not deliver. */
export const unrevertableRefusal = (key: string, mergeSha: string, delivered: string | null) => `${key} ${delivered ? `delivered ${delivered.slice(0, 12)}, not` : 'delivered nothing, so not'} ${mergeSha.slice(0, 12)}; a candidate revert is recorded only against the merge the item delivered`;
/** The refusal of a revert reconciliation naming a revert commit the base branch does not hold. */
export const unheldRevertRefusal = (revertSha: string, base: string) => `${base} does not hold ${revertSha.slice(0, 12)}; a revert is reconciled only once the base branch holds its commit`;
/** The save reason a reconciliation delivers under; the ledger's `merge-writer.<kind>` saves carry every other step. */
export const deliveredReason = 'merge-writer.delivered';
/** The refusal of a reconciliation naming a merge commit the base branch does not hold. */
export const unheldShaRefusal = (mergeSha: string, base: string) => `${base} does not hold ${mergeSha.slice(0, 12)}; a merge is reconciled only once the base branch holds its merge commit`;
/** The refusal of a push or reconciliation naming a merge commit the item's own ledger never intended (AC-4): main holding a commit is not this item's merge. */
export const unintendedShaRefusal = (key: string, mergeSha: string, intended: string | null) => `${key}'s ledger ${intended ? `intends ${intended.slice(0, 12)}, not` : 'holds no open intent for'} ${mergeSha.slice(0, 12)}; a merge is recorded pushed or reconciled only under the intent that opened it`;
/** The refusal of a record naming a head other than the item's submitted candidate. */
export const otherHeadRefusal = (key: string, head: string, candidate: string | null) => `${key}'s submitted head is ${candidate ? candidate.slice(0, 12) : 'none'}, not ${head.slice(0, 12)}; the merge writer records only the candidate it merges`;

/** The engine's git runner over the coordinator checkout, made on first use as the head observation makes it (engine.ts). */
function gitRunner(engine: Engine): GitRunner {
  if (engine.gitRunner === undefined) engine.gitRunner = gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());
  demand(engine.gitRunner, 'The control plane has no checkout to read the base branch from; a merge record needs the merge writer checkout', 503);
  return engine.gitRunner!;
}

/** The item's ledger, folded from its own rows; a refusal no intent opened (a conflicting merge has no commit to intend) stands as the state alone. */
async function foldItemLedger(db: pg.PoolClient, work: Work, data: MergeRecordBody): Promise<MergeLedgerState | null> {
  // The executor's trial rows fold too (GY-1528): their proof counts are what control-plane acceptance reads.
  const kinds = [...Object.values(mergeLedgerKinds), mergeTrialKind];
  const rows = (await db.query(`SELECT kind, payload FROM events WHERE work_id=$1 AND kind = ANY($2::text[]) ORDER BY seq`, [work.id, kinds])).rows as { kind: string; payload: unknown }[];
  const folded = foldMergeLedger(rows.map(row => ({ kind: row.kind, payload: row.payload, work: work.key })))[work.key];
  if (folded) return folded;
  if (data.kind !== 'refused') return null;
  return { key: work.key, state: 'refused', head: data.head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason: data.reason }, events: 1 };
}

export async function recordMergeEvent(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'coordinator', 'Only the loop\'s coordinator identity records the merge writer\'s ledger', 403);
  const data = (body as { kind?: unknown } | null)?.kind === 'revert' ? revertRecordBodySchema.parse(body) : mergeRecordBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, data })).digest('hex');
  const engine = services.engine, base = engine.baseBranch;
  // Whether the base branch holds the merge (or revert) commit is read from the checkout before the transaction, as every provider read is.
  let held: boolean | null = null;
  const reconciledSha = data.kind === 'reconciled' ? data.mergeSha : data.kind === 'revert' && data.phase === 'reconciled' ? data.revertSha : null;
  if (reconciledSha) held = (await gitRunner(engine)(['merge-base', '--is-ancestor', reconciledSha, `refs/remotes/origin/${base}`])).status === 0;
  return engine.store.transaction(async (db: pg.PoolClient, now: Date) => {
    const replay = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (replay) { demand(replay.fingerprint === fingerprint, 'Idempotency key reused with different input'); return replay.result; }
    const all = await lockedWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    const receipt = async (result: unknown) => { await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]); return result; };
    const answer = () => ({ recorded: true, key: work!.key, kind: data.kind, stage: work!.stage, mergeLedger: work!.mergeLedger ?? null, delivery: work!.delivery ?? null, ...(data.kind === 'revert' ? { candidateReverts: work!.candidateReverts ?? [] } : {}) });
    if (data.kind === 'revert') {
      // GY-1526: a revert is about the merge the item delivered; its reconcile records the revert and reopens the item.
      const delivered = work!.delivery?.mergeSha.toLowerCase() ?? null, already = (work!.candidateReverts ?? []).find(entry => entry.mergeSha === data.mergeSha);
      // The item already reopened under this very revert: a record whose receipt was lost, answered as it stands.
      if (already && 'revertSha' in data && already.revertSha === data.revertSha) return receipt(answer());
      demand(delivered === data.mergeSha, unrevertableRefusal(work!.key, data.mergeSha, delivered), 409);
      if (data.phase === 'reconciled') demand(held, unheldRevertRefusal(data.revertSha, base), 409);
      const { kind: _kind, ...payload } = data;
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work!.id, actor.id, revertLedgerKind, JSON.stringify({ key: work!.key, ...payload })]);
      if (data.phase !== 'reconciled') { await save(db, work!, actor.id, `merge-writer.revert.${data.phase}`, now, payload); return receipt(answer()); }
      const revert: CandidateRevert = { mergeSha: data.mergeSha, revertSha: data.revertSha, candidate: data.candidate, case: data.case, step: data.step, at: data.at };
      const { reopened } = applyCandidateRevert(work!, revert, now);
      const reason = candidateRevertReason(work!, revert);
      if (reopened) {
        engine.evaluate(work!, all, now);
        await (engine as unknown as { recordDispatch(db: pg.PoolClient, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
      }
      await save(db, work!, actor.id, reopened ? revertReopenedReason : 'merge-writer.revert.reconciled', now, { revert, reopened, rework: reason });
      return receipt(answer());
    }
    const candidate = work!.candidate?.sha.toLowerCase() ?? null;
    // Every record is about the item's own submitted head (AC-4): an intent, a trial or a refusal
    // names it; a push or a reconciliation names the merge commit the item's open intent of that
    // head intends. Main holding some commit never delivers an item whose ledger did not intend it.
    if ('head' in data) demand(data.head === candidate, otherHeadRefusal(work!.key, data.head, candidate), 409);
    else {
      // The merge already delivered under this very commit: a record whose receipt was lost, answered as it stands.
      if (work!.stage === 'done' && work!.delivery?.mergeSha.toLowerCase() === data.mergeSha) return receipt(answer());
      demand(work!.stage !== 'done', `${work!.key} is already done, so ${data.mergeSha.slice(0, 12)} delivers nothing`, 409);
      const ledger = await foldItemLedger(db, work!, data);
      const intended = ledger && ledger.state !== 'refused' && ledger.head === candidate ? ledger.mergeSha : null;
      demand(intended === data.mergeSha, unintendedShaRefusal(work!.key, data.mergeSha, intended), 409);
      if (data.kind === 'reconciled') demand(held, unheldShaRefusal(data.mergeSha, base), 409);
    }
    const { kind, ...fields } = data;
    const event: MergeRecordEvent = data;
    const payload = kind === 'intent' ? { key: work!.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields;
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work!.id, actor.id, mergeRecordKinds[event.kind], JSON.stringify(payload)]);
    work!.mergeLedger = await foldItemLedger(db, work!, data);
    if (kind === 'reconciled') {
      const mergedAt = work!.mergeLedger?.pushedAt ?? now.toISOString();
      const observation = work!.observation;
      if (observation) work!.observation = { ...observation, merged: true, mergeSha: data.mergeSha, mergedAt };
      work!.violations = work!.violations.filter(entry => entry !== unauthorizedMergeViolation && !entry.startsWith(reconciliationRefusalPrefix));
      work!.stage = 'done'; work!.stageEnteredAt = now.toISOString();
      work!.delivery = { mergedAt, mergeSha: data.mergeSha, authorizationRevision: work!.revision };
      // What the delivery still owes, in the same transaction: nothing retries against it (GY-185).
      settleDelivered(work!, all, now);
      await save(db, work!, actor.id, deliveredReason, now, { mergeSha: data.mergeSha, observedTip: data.observedTip, mergedAt });
      await deliverSplitParent(db, work!, all, now);
      // The job row after the item row (GY-1115), the order every transaction takes them in.
      await db.query('DELETE FROM jobs WHERE work_id=$1', [work!.id]);
    } else {
      // The gates read the ledger: the test gate passes on the intent, the merge gate on the push and its reconciliation.
      engine.evaluate(work!, all, now);
      await (engine as unknown as { recordDispatch(db: pg.PoolClient, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
      await save(db, work!, actor.id, `merge-writer.${kind}`, now, payload);
    }
    return receipt(answer());
  });
}
