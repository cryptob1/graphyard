import { appendEvidence } from '../model-boundary/append-evidence.js';
import { once, digest } from '../store/mutations.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Evidence, type Principal, type Work } from '../model.js';
import { evaluate } from '../model-boundary/gates.js';
import { foldMergeLedger, previewVerdictSchema, trialFlakedSchema } from '../model-boundary/merge-ledger.js';
import { readOnlyTrialBlocker } from '../model/merge-queue.js';
import { mergeLedgerKinds, mergeTrialKind, mergeTrialStepKind, type MergeLedgerState } from '../model/merge-ledger.js';
import { settleDelivered } from '../model-boundary/actions.js';
import { reconciliationRefusalPrefix } from '../model/merge-authorization.js';
import { save, eventWorkSql } from '../store.js';
import { evaluateLandability } from '../model-boundary/landability.js';
import { exactApproval } from '../model/review.js';
import { decisionWork } from '../store/decision-read.js';
import { gitRunnerFor, type GitRunner } from '../merge-writer/local-observation.js';
import { firstParentHolds, trialAuthor } from '../merge-writer/trial.js';
import { trialScreenshotBytesMax, trialScreenshotCasesMax } from '../merge-writer/e2e-trial.js';
import { mergeCandidateObsolete, mergeRecordKinds, orphanRefusal, unpushedIntentReason, type MergeRecordEvent } from '../merge-writer/executor.js';
import { keepTrialScreenshots } from './trial-screenshots.js';
import { trialPhases, type TrialPhase } from '../merge-writer/trial.js';
import type { Engine } from '../engine.js';
import { recordDispatch } from '../engine/evaluate.js';
import type { Services } from './routes.js';

import { foldServeReverts, mergeServeRevertKind, mergeServeRevertSchema } from '../merge-writer/serve-revert-ledger.js';

/**
 * GY-1524. The merge writer's ledger, written by the loop's coordinator identity through
 * `POST /api/work/:id/merge-record`: one event per step of a merge (model/merge-ledger.ts) —
 * `intent`, `trial` (the executor's own record, whose proof counts the fold keeps beside the state, GY-1528), `pushed`, `reconciled` and
 * `refused`. Every record re-folds the item's ledger into `work.mergeLedger`, which the gates read
 * where they read GitHub's checks and mergeability for a control-plane observation (GY-1523), and
 * saves the item. A `reconciled` delivers the item: stage done, the delivery, `settleDelivered`,
 * the jobs
 * row gone, all in the one transaction, saved as `merge-writer.delivered`; one for a merge commit
 * the base branch does not hold is refused, since nothing landed, and so is one (or a `pushed`)
 * for a merge commit the item's own open intent of its submitted head does not name, since a
 * commit main holds for another item or none delivers nothing here.
 */
const sha = z.string().regex(/^[0-9a-f]{40}$/i).transform(value => value.toLowerCase());
const instant = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)), 'an ISO 8601 instant');
const tests = z.object({ passed: z.number().int().min(0), failed: z.array(z.string().max(300)).max(100), files: z.number().int().min(0) }).strict();
const trialPhase = z.enum(trialPhases), trialNoVerdictOutcome = z.enum(['timeout', 'cancelled', 'host-failure']);
const trialPhaseDurations = z.object(Object.fromEntries(trialPhases.map(phase => [phase, z.number().min(0)])) as Record<TrialPhase, z.ZodNumber>).strict();
const trialAttempts = z.array(z.object({ outcome: trialNoVerdictOutcome, phase: trialPhase, reason: z.string().max(1000), phases: trialPhaseDurations }).strict()).max(10);
/** Every e2e result one trial can owe: one item's 50 criteria of 20 proofs. */
const trialE2eResultLimit = 50 * 20;
export const mergeRecordBodySchema = z.discriminatedUnion('kind', [
  mergeServeRevertSchema.extend({ kind: z.literal('serve-revert') }),
  z.object({ kind: z.literal('intent'), head: sha, baseTip: sha, mergeSha: sha, risk: z.string().min(1).max(40), at: instant }).strict(),
  // GY-1832: a trial is a verdict, with its phases' times and the attempts before it that reached none, or a final no-verdict outcome naming its phase and reason.
  z.discriminatedUnion('outcome', [
    z.object({ kind: z.literal('trial'), head: sha, baseTip: sha, mergeSha: sha, outcome: z.literal('verdict'), build: z.enum(['pass', 'fail']), tests,
      files: z.array(z.string().max(500)).max(1000),
      proofs: z.record(z.string().max(200), z.object({ executed: z.number().int().min(0), failed: z.number().int().min(0), reason: z.string().max(200).optional() }).strict()), durationMs: z.number().int().min(0),
      phases: trialPhaseDurations.optional(), attempts: trialAttempts,
      // GY-2965: how each bound E2E case ran against the served head; a run of one becomes a trusted record on the item and a run in the case's history.
      e2e: z.array(z.object({ proof: z.string().regex(/^e2e:[a-zA-Z0-9._/-]+$/).max(200), case: z.string().max(200), executed: z.number().int().min(0), failed: z.number().int().min(0),
        missing: z.boolean().optional(), failingStep: z.string().max(2000).nullable().optional() }).strict()).max(trialE2eResultLimit).optional(),
      // GY-3267: each browser case's kept screenshots (after the candidate, before the base tip), base64 PNGs within the trial's capture bound.
      screenshots: z.array(z.object({ case: z.string().min(1).max(200),
        before: z.string().max(Math.ceil(trialScreenshotBytesMax / 3) * 4).optional(), after: z.string().max(Math.ceil(trialScreenshotBytesMax / 3) * 4).optional() }).strict()).max(trialScreenshotCasesMax).optional(),
      preview: previewVerdictSchema.optional(), flaked: trialFlakedSchema.optional() }).strict(),
    z.object({ kind: z.literal('trial'), head: sha, baseTip: sha, mergeSha: sha, outcome: trialNoVerdictOutcome, phase: trialPhase, reason: z.string().min(1).max(1000),
      phases: trialPhaseDurations, attempts: trialAttempts.min(1), durationMs: z.number().int().min(0) }).strict(),
  ]),
  z.object({ kind: z.literal('pushed'), mergeSha: sha, pushedAt: instant }).strict(),
  z.object({ kind: z.literal('reconciled'), mergeSha: sha, observedTip: sha }).strict(),
  z.object({ kind: z.literal('refused'), head: sha, reason: z.string().min(1).max(2000) }).strict(),
  // GY-2963: where the trial is while it runs — a step name and the instant it began, no state.
  z.object({ kind: z.literal('trial-step'), head: sha, step: z.string().min(1).max(100), at: instant }).strict(),
]);
export type MergeRecordBody = z.infer<typeof mergeRecordBodySchema>;
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
  // The executor's trial rows fold too (GY-1528): their proof counts are what control-plane acceptance reads. A trial's step rows fold beside them (GY-2963).
  const kinds = [...Object.values(mergeLedgerKinds), mergeServeRevertKind, mergeTrialKind, mergeTrialStepKind];
  const rows = (await db.query(`SELECT kind, payload FROM events WHERE work_id=$1 AND kind = ANY($2::text[]) ORDER BY seq`, [work.id, kinds])).rows as { kind: string; payload: unknown }[];
  const events = rows.map(row => ({ ...row, work: work.key }));
  const folded = foldServeReverts(foldMergeLedger(events), events)[work.key];
  if (folded) return folded;
  if (data.kind !== 'refused') return null;
  return { key: work.key, state: 'refused', head: data.head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason: data.reason }, events: 1 };
}

/** What a merge record's receipt is matched on: the item and the step, its instants and duration aside, so a retried post replays and a different step under the same key is refused. */
export function mergeRecordInput(id: string, data: unknown) {
  const fingerprintData = typeof data === 'object' && data !== null
    ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'at' && k !== 'pushedAt' && k !== 'durationMs'))
    : data;
  return { id, data: fingerprintData };
}

/** Recover only the original, proven flight. Read its immutable saves as well as its raw latest
 * trial: the compact fold deliberately omits failure details and policy/review bindings. */
async function demandOrphanRecovery(db: pg.PoolClient, work: Work, all: Work[], ledger: MergeLedgerState, base: string, engine: Engine, now: Date) {
  const reason = `${work.key}'s refused intent needs its original passing trial, policy and review binding`;
  demand(orphanRefusal(ledger, base), reason, 409);
  const rows = (await db.query(`SELECT kind, payload, ${eventWorkSql()} AS work FROM events WHERE work_id=$1
    AND seq >= (SELECT max(seq) FROM events WHERE work_id=$1 AND kind='merge.intent') ORDER BY seq`, [work.id])).rows;
  const refusals = rows.filter(row => row.kind === 'merge.refused');
  demand(refusals.length > 0 && refusals.every(row => row.payload.kind === 'merge' && row.payload.head === ledger.head
    && row.payload.reason === unpushedIntentReason(ledger.mergeSha!, base)), reason, 409);
  const original = rows.find(row => row.kind === 'merge-writer.intent')?.work as Work | undefined;
  const tried = rows.findLast(row => row.kind === 'merge-writer.trial')?.work as Work | undefined;
  for (const bound of [original, tried]) {
    demand(bound?.policyRevision === work.policyRevision && bound?.candidate?.sha === work.candidate?.sha
      && bound?.candidate?.baseSha === original?.candidate?.baseSha
      && bound?.mergeLedger?.head === ledger.head && bound?.mergeLedger?.baseTip === ledger.baseTip
      && bound?.mergeLedger?.mergeSha === ledger.mergeSha
      && JSON.stringify(exactApproval(bound!)) === JSON.stringify(exactApproval(work))
      && bound?.gates.some(gate => gate.name === 'review' && gate.passed), reason, 409);
  }
  const latest = rows.findLast(row => row.kind === 'merge.trial');
  demand(latest && rows.indexOf(latest) > rows.indexOf(refusals[0]), reason, 409);
  const parsed = mergeRecordBodySchema.safeParse(latest ? { kind: 'trial', ...latest.payload } : null);
  demand(parsed.success && parsed.data.kind === 'trial' && parsed.data.outcome === 'verdict', reason, 409);
  if (!parsed.success || parsed.data.kind !== 'trial' || parsed.data.outcome !== 'verdict') return;
  const trial = parsed.data;
  demand(trial.head === ledger.head && trial.baseTip === ledger.baseTip && trial.mergeSha === ledger.mergeSha
    && trial.build === 'pass' && trial.tests.files > 0 && trial.tests.passed === trial.tests.files && trial.tests.failed.length === 0
    && (!trial.preview || (trial.preview.mergeSha === trial.mergeSha && trial.preview.result === 'pass'))
    && (trial.e2e ?? []).every(entry => entry.executed > 0 && entry.failed === 0 && !entry.missing), reason, 409);
  // Observe current invalidation, but judge the flight against the base/delta it actually
  // proved. Later main can already contain the fix; that observation is no retrial target.
  engine.evaluate(work, all, now);
  const flight: Work = { ...work, candidate: tried!.candidate, observation: tried!.observation, mergeLedger: ledger };
  demand(!work.reworkRequested && evaluateLandability(flight, all, now).verdict === 'landable'
    && evaluate(flight, all, now).gates.some(gate => gate.name === 'review' && gate.passed)
    && work.gates.some(gate => gate.name === 'review' && gate.passed), reason, 409);
}

export const mergeRecordFingerprint = (id: string, data: unknown) => digest(mergeRecordInput(id, data));

export async function recordMergeEvent(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'coordinator', 'Only the loop\'s coordinator identity records the merge writer\'s ledger', 403);
  const data = mergeRecordBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const receiptInput = mergeRecordInput(id, data);
  const engine = services.engine, base = engine.baseBranch;
  // Whether the base branch holds the merge commit is read from the checkout before the transaction, as every provider read is.
  let held: boolean | null = null, recoveryHeld: boolean | null = null;
  if (data.kind === 'serve-revert' && data.outcome === 'reverted') {
    demand(data.revertSha, 'A pushed revert must name its commit', 400);
    held = (await gitRunner(engine)(['merge-base', '--is-ancestor', data.revertSha!, `refs/remotes/origin/${base}`])).status === 0;
  }
  if (data.kind === 'reconciled') held = (await gitRunner(engine)(['merge-base', '--is-ancestor', data.mergeSha, `refs/remotes/origin/${base}`])).status === 0;
  // Recovery requires first-parent containment; ordinary reconciliation retains its ancestry contract.
  if (data.kind === 'pushed' || data.kind === 'reconciled') recoveryHeld = await firstParentHolds(async args => {
    const result = await gitRunner(engine)(args);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  }, `refs/remotes/origin/${base}`, data.mergeSha);
  return engine.store.transaction(async (db: pg.PoolClient, now: Date) => once(db, actor, key, receiptInput, async () => {
    const all = await decisionWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    const answer = () => ({ recorded: true, key: work!.key, kind: data.kind, stage: work!.stage, mergeLedger: work!.mergeLedger ?? null, delivery: work!.delivery ?? null });
    if (data.kind === 'intent') {
      demand(work!.stage !== 'done' && !work!.reworkRequested && !work!.lease && work!.submission?.epoch === work!.epoch,
        `${work!.key}: merge intent needs the current submitted implementation, without rework or replacement ownership`, 409);
    }
    const candidate = work!.candidate?.sha.toLowerCase() ?? null;
    // Every record is about the item's own submitted head (AC-4): an intent, a trial or a refusal
    // names it; a push or a reconciliation names the merge commit the item's open intent of that
    // head intends. Main holding some commit never delivers an item whose ledger did not intend it.
    // GY-3039: an open intent on a superseded head still settles. The reconcile records the old
    // head refused so the ledger leaves its blocking state and the current candidate queues; only
    // a refusal or late trial naming the ledger's own open head is retained as history.
    // A late obsolete trial cannot supply evidence for the replacement below.
    if (data.kind === 'serve-revert') {
      demand(work!.delivery?.mergeSha.toLowerCase() === data.mergeSha,
        'A serve revert must name this item’s delivered merge', 409);
      if (data.outcome === 'reverted') demand(held, 'The base branch must hold the revert commit', 409);
      else demand(data.reason && !data.revertSha && !data.reland, 'A revert refusal needs its reason and no pushed commit or re-land', 400);
    } else if ('head' in data) {
      if (data.head !== candidate) {
        demand(data.kind === 'refused' || data.kind === 'trial' || data.kind === 'trial-step', otherHeadRefusal(work!.key, data.head, candidate), 409);
        const ledger = await foldItemLedger(db, work!, data);
        demand(ledger !== null && (ledger.state === 'intent' || ledger.state === 'pushed') && ledger.head?.toLowerCase() === data.head, otherHeadRefusal(work!.key, data.head, candidate), 409);
      }
    }
    else {
      // The merge already delivered under this very commit: a record whose receipt was lost, answered as it stands.
      if (work!.stage === 'done' && work!.delivery?.mergeSha.toLowerCase() === data.mergeSha) return answer();
      demand(work!.stage !== 'done', `${work!.key} is already done, so ${data.mergeSha.slice(0, 12)} delivers nothing`, 409);
      const ledger = await foldItemLedger(db, work!, data);
      const recovering = !!ledger && orphanRefusal(ledger, base);
      const intended = ledger && (ledger.state !== 'refused' || recovering) && ledger.head === candidate ? ledger.mergeSha : null;
      demand(intended === data.mergeSha, unintendedShaRefusal(work!.key, data.mergeSha, intended), 409);
      if (data.kind === 'reconciled') demand(held, unheldShaRefusal(data.mergeSha, base), 409);
      if (recovering) demand(recoveryHeld, unheldShaRefusal(data.mergeSha, base), 409);
      if (recovering) await demandOrphanRecovery(db, work!, all, ledger!, base, engine, now);
      const admission = evaluate(work!, all, now).gates.filter(gate => ['ready', 'build', 'review', 'acceptance'].includes(gate.name));
      demand(admission.every(gate => gate.passed), `${work!.key}: merge admission refused: ${admission.flatMap(gate => gate.reasons).join('; ')}`, 409);
    }
    const { kind, ...fields } = data;
    const event: MergeRecordEvent = data;
    // GY-3267: the kept screenshots' bytes live in their own table and on the item, never in the ledger row.
    const lean = 'screenshots' in fields ? (({ screenshots: _screenshots, ...rest }) => rest)(fields) : fields;
    const payload = kind === 'intent' ? { key: work!.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : lean;
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work!.id, actor.id, mergeRecordKinds[event.kind], JSON.stringify(payload)]);
    work!.mergeLedger = await foldItemLedger(db, work!, data);
    // GY-3229: a trial that could not write a read-only file system is the host's fault: one blocker naming the path, never a rework.
    if (data.kind === 'trial' && data.outcome === 'host-failure' && data.reason.startsWith(readOnlyTrialBlocker) && !work!.blocker) { work!.blocker = data.reason; work!.blockedAt = now.toISOString(); }
    // GY-2965: the trial is a trusted producer of its E2E case runs. Every case that ran is recorded on the
    // item as trusted evidence bound to the merge commit it ran against — a pass and a fail both keep their
    // run in the case's Tests-page history; only a pass can stand behind the proof, and only through the
    // trial counts the acceptance gate reads.
    const original = data.kind === 'trial' && data.outcome === 'verdict' && data.e2e?.length
      ? (await db.query(`SELECT ${eventWorkSql()} AS work FROM events WHERE work_id=$1 AND kind='merge-writer.intent' ORDER BY seq DESC LIMIT 1`, [work!.id])).rows[0]?.work as Work | undefined : undefined;
    if (data.kind === 'trial' && data.outcome === 'verdict' && data.e2e?.length && original && !mergeCandidateObsolete(work!, original)) {
      for (const entry of data.e2e) {
        if (entry.executed === 0) continue;
        const evidence: Evidence = { id: randomUUID(), proof: entry.proof, sha: data.mergeSha, baseSha: data.baseTip, policyRevision: work!.policyRevision,
          producer: trialAuthor, trusted: true, result: entry.failed === 0 ? 'pass' : 'fail', executed: entry.executed, skipped: 0, at: now.toISOString(),
          environment: 'merge-writer-trial' };
        await appendEvidence(work!, evidence, db);
      }
    }
    // GY-3267: each verdict trial replaces the earlier trial's kept browser-case screenshots; one that kept none clears them.
    if (data.kind === 'trial' && data.outcome === 'verdict') {
      const cases = await keepTrialScreenshots(db, work!.id, data.screenshots ?? []);
      work!.trialScreenshots = cases.length ? { mergeSha: data.mergeSha, baseTip: data.baseTip, at: now.toISOString(), cases } : null;
    }
    if (kind === 'reconciled') {
      const mergedAt = work!.mergeLedger?.pushedAt ?? now.toISOString();
      const observation = work!.observation;
      if (observation) work!.observation = { ...observation, merged: true, mergeSha: data.mergeSha, mergedAt };
      work!.violations = work!.violations.filter(entry => !entry.startsWith(reconciliationRefusalPrefix));
      work!.stage = 'done'; work!.stageEnteredAt = now.toISOString();
      work!.delivery = { mergedAt, mergeSha: data.mergeSha, authorizationRevision: work!.revision };
      // GY-3281: the delivered document's gates read the reconciled ledger. The last evaluation
      // before this one wrote the `pushed` save, whose merge gate refuses the push it had not yet
      // seen reconciled; a settled delivery is never evaluated again, so without this re-read a
      // done item shows a pending merge gate forever.
      Object.assign(work!, evaluate(work!, all, now));
      // Proof gaps count proofs executed in the merged trial (GY-3281): the trial is the producer
      // the acceptance gate already read, so the delivered item owes no authority it cannot show.
      const executed = new Set(Object.entries(work!.mergeLedger?.trial?.proofs ?? {}).filter(([, counts]) => counts.executed > 0).map(([proof]) => proof));
      if (executed.size && work!.proofGaps?.length) work!.proofGaps = work!.proofGaps.filter(proof => !executed.has(proof));
      // What the delivery still owes, in the same transaction: nothing retries against it (GY-185).
      settleDelivered(work!, all, now);
      await save(db, work!, actor.id, deliveredReason, now, { mergeSha: data.mergeSha, observedTip: data.observedTip, mergedAt });
      // The job row after the item row (GY-1115), the order every transaction takes them in.
      await db.query('DELETE FROM jobs WHERE work_id=$1', [work!.id]);
    } else {
      // The gates read the ledger: the test gate passes on the intent, the merge gate on the push and its reconciliation.
      engine.evaluate(work!, all, now);
      await recordDispatch(db, work!, now);
      await save(db, work!, actor.id, `merge-writer.${kind}`, now, payload);
    }
    return answer();
  }));
}
