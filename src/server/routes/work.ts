import { demand, type Principal } from '../../model.js';
import { RenewalFault, type Command } from '../../engine.js';
import { leaseCommands } from '../../store/pools.js';
import { producerIndependenceRefusal, recordEvidenceRefusal, recordLeadViolation } from '../../delegation.js';
import { defineRoutes, parseJson, Sent, type RouteContext } from '../routes.js';
import { answerHumanDecision, answerHumanProof, listHumanRequests, requestHumanProof, recordCapacity, requestHumanDecision } from '../waits.js';
import { judgeClosedQuestion } from '../closed-question.js';
import { closeWork } from '../close.js';
import { productScreenshotBodyLimit, readProductScreenshot, recordProductReviewByHand, recordReviewLaunch, recordReviewVerdict } from '../review-verdict.js';
import { mergeRecordFingerprint, recordMergeEvent } from '../merge-record.js';
import { save } from '../../store.js';
import { lockedWork } from '../../store/locked-read.js';
import { applyPreviewRecord, previewRecordBodySchema, previewSiteByteLimit, previewSiteFileLimit } from '../../project-previews.js';
import type { Services } from '../routes.js';

/** Whether a request is a lease command (store/pools.ts `leaseCommands`), which authenticates and runs on the lease pool (GY-558). */
export const leaseCommandRequest = (method: string | undefined, pathname: string) => {
  const command = method === 'POST' ? /^\/api\/work\/[^/]+\/([a-z]+)$/.exec(pathname)?.[1] : undefined;
  return !!command && leaseCommands.has(command);
};

// Every mutating work route refuses a slice lead the same way and leaves the same
// ledger entry. Routing order decides which handler matches first; it must never
// decide whether the attempt is recorded.
const refuseLead = async ({ actor, services }: RouteContext, id: string | null, attemptedAction: string) => {
  if (actor.role !== 'slice-lead') return;
  await recordLeadViolation(services.engine.store, actor, id, attemptedAction);
  demand(false, 'Slice leads cannot perform lifecycle mutations', 403);
};

/** Work mutations: the human-only waits, the merge writer's record and every engine command. */
export const workRoutes = defineRoutes('work', [
  // The two waits that stall only their own item (GY-89): a human-only decision a worker records
  // (`park`) and the human answers (`answer`), and the provider capacity the loop observes
  // (`capacity`). They precede the generic route, which would read them as commands.
  { method: 'GET', path: '/api/human-requests', handle: ({ actor, services }) => listHumanRequests(services, actor) },
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/(park|answer|capacity)$/,
    async handle(context, [id, action]) {
      await refuseLead(context, id, action);
      const data = await parseJson(context), key = context.idempotencyKey(), target = decodeURIComponent(id);
      return action === 'park' ? requestHumanDecision(context.services, context.actor, target, data, key)
        : action === 'answer' ? answerHumanDecision(context.services, context.actor, target, data, key)
        : recordCapacity(context.services, context.actor, target, data, key);
    },
  },
  // Closing an item that will never be delivered: the master's or an admin's, never a worker's.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/close$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'close');
      return closeWork(context.services, context.actor, decodeURIComponent(id), await parseJson(context), context.idempotencyKey());
    },
  },
  // A closed-question proof (GY-109): the control plane asks the configured responder against the
  // bound candidate state and records the answer as evidence, never as an approval.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/closed-question$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'closed-question');
      return judgeClosedQuestion(context.services, context.actor, decodeURIComponent(id), await parseJson(context), context.idempotencyKey());
    },
  },
  // Review by risk in control-plane mode (GY-1525): the coordinator registers each reviewer launch
  // with its token hash, and the launched session posts its one verdict as that token.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/(review-launch|review-verdict)$/,
    async handle(context, [id, action]) {
      await refuseLead(context, id, action);
      const data = await parseJson(context, action === 'review-verdict' ? productScreenshotBodyLimit : undefined), key = context.idempotencyKey(), target = decodeURIComponent(id);
      return action === 'review-launch' ? recordReviewLaunch(context.services, context.actor, target, data, key) : recordReviewVerdict(context.services, context.actor, target, data, key);
    },
  },
  // A product review recorded by hand (GY-2989): the operator's or the loop's own verdict on a
  // user-facing feature, judged on the preview, without a launched session.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/product-review$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'product-review');
      return recordProductReviewByHand(context.services, context.actor, decodeURIComponent(id), await parseJson(context, productScreenshotBodyLimit), context.idempotencyKey());
    },
  },
  // A real-world check (GY-2986): the loop asks for it on Needs you and a person answers it with a note and any photo.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/(human-proof-request|human-proof)$/,
    async handle(context, [id, action]) {
      await refuseLead(context, id, action);
      const data = await parseJson(context, productScreenshotBodyLimit), key = context.idempotencyKey(), target = decodeURIComponent(id);
      return action === 'human-proof' ? answerHumanProof(context.services, context.actor, target, data, key) : requestHumanProof(context.services, context.actor, target, data, key);
    },
  },
  // The screenshots a product review uploaded, served to any reader of the item (its panel fetches them).
  {
    method: 'GET', path: /^\/api\/work\/([^/]+)\/product-review\/screenshots\/([^/]+)$/,
    async handle({ res, services }, [id, name]) {
      const shot = await readProductScreenshot(services, decodeURIComponent(id), decodeURIComponent(name));
      res.writeHead(200, { 'Content-Type': shot.mediaType, 'Content-Length': shot.bytes.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' });
      res.end(shot.bytes);
      return Sent;
    },
  },
  // The merge writer's ledger (GY-1524): intent, trial, pushed, reconciled and refused, recorded by the
  // loop's coordinator identity only; a reconciliation delivers the item in the same transaction.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/merge-record$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'merge-record');
      // GY-1902: a running preview's record carries its built site, so the coordinator's body may be as large as a site.
      const data = await parseJson(context, context.actor.role === 'coordinator' ? previewRecordBodyLimit : undefined), target = decodeURIComponent(id);
      // GY-1902: an item preview's record rides the same coordinator route; it moves no merge state.
      if ((data as { kind?: unknown } | null)?.kind === 'preview') return recordItemPreview(context.services, context.actor, target, data, context.idempotencyKey());
      return recordMergeEvent(context.services, context.actor, target, data, context.idempotencyKey());
    },
  },
  {
    method: 'POST', path: /^\/api\/work(?:\/([^/]+)\/([a-z]+))?$/,
    async handle(context, [id, command]) {
      const { actor, services: { engine } } = context;
      const attempted = command ?? 'create';
      // Creating work names no existing item, so the refusal is recorded
      // unscoped rather than dropped for want of a ledger to append to.
      await refuseLead(context, id ?? null, attempted);
      const raw = await context.body();
      if (attempted === 'evidence' && id && actor.role !== 'worker') {
        const item = await engine.store.workDocument(id);
        const dependent = item ? producerIndependenceRefusal(actor as Principal, item, engine.principals) : null;
        if (item && dependent) {
          // An unparsable body is still a recorded refusal; the engine repeats this decision.
          let proof: unknown = null;
          try { proof = JSON.parse(raw.toString() || '{}')?.proof; } catch { proof = null; }
          await recordEvidenceRefusal(engine.store, actor, item.id, proof, dependent);
          demand(false, dependent, 403);
        }
      }
      const input = JSON.parse(raw.toString() || '{}');
      try { return await engine.execute(actor, attempted as Command, id ?? null, input, context.idempotencyKey()); }
      catch (error) {
        // A renewal that failed server-side says what grace its recorded fault earned (GY-558), so the supervisor keeps retrying through it.
        if (error instanceof RenewalFault) return context.send(503, { error: error.message, renewalFault: error.grace });
        throw error;
      }
    },
  },
]);

/**
 * GY-1902: the loop's record of an item's preview (project-previews.ts), by the coordinator identity
 * only, idempotent under its key, applied under the item's lock (`applyPreviewRecord`) and saved as
 * `preview.<state>`. A running record's built site is stored with it (item_preview_files), which the
 * link serves; every other preview's files of the item are deleted in the same transaction, so a
 * superseded, cancelled or failed preview serves nothing. It is the control plane's own observation:
 * never evidence, so it satisfies no proof and grants no worker or producer anything.
 */
async function recordItemPreview(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'coordinator', 'Only the loop\'s coordinator identity records an item\'s preview', 403);
  const { preview, site } = previewRecordBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = mergeRecordFingerprint(id, { kind: 'preview', preview, ...(site ? { site } : {}) });
  return services.engine.store.transaction(async (db, now) => {
    const replay = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (replay) { demand(replay.fingerprint === fingerprint, 'Idempotency key reused with different input'); return replay.result; }
    const work = (await lockedWork(db, [id])).find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    const refusal = applyPreviewRecord(work!, preview); demand(!refusal, refusal!, 409);
    await save(db, work!, actor.id, `preview.${preview.state}`, now, { preview: { id: preview.id, sha: preview.sha, state: preview.state, endReason: preview.endReason } });
    const serving = work!.preview?.state === 'running' ? work!.preview.id : null;
    await db.query('DELETE FROM item_preview_files WHERE work_id=$1 AND preview_id IS DISTINCT FROM $2', [work!.id, serving]);
    if (site && serving === preview.id) {
      await db.query('DELETE FROM item_preview_files WHERE preview_id=$1', [preview.id]);
      await db.query('INSERT INTO item_preview_files(preview_id,work_id,path,media_type,bytes) SELECT $1,$2,* FROM unnest($3::text[],$4::text[],$5::bytea[])',
        [preview.id, work!.id, site.map(file => file.path), site.map(file => file.mediaType), site.map(file => Buffer.from(file.content, 'base64'))]);
    }
    const result = { recorded: true, key: work!.key, kind: 'preview', preview: work!.preview };
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}
/** The largest merge-record body the coordinator sends: a running preview's site, base64-encoded, and its record. */
const previewRecordBodyLimit = Math.ceil(previewSiteByteLimit / 3) * 4 + previewSiteFileLimit * 1024 + 64 * 1024;
