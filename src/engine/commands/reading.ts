import { appendEvidence } from '../../model-boundary/append-evidence.js';
import { randomUUID } from 'node:crypto';
import { grantsAuthorize } from '../../model/proof.js';
import { demand } from '../../model.js';
import type { Evidence } from '../../model.js';
import { followUpRequest } from '../../model/observation-window.js';
import { loopObservationProofs } from '../../model/loop-observation.js';
import type { Ctx } from './types.js';

export async function run(c: Ctx) {
  const { db, actor, data, all, now, work } = c;
  // A reading is the loop's own observation of the serving release: only the loop's coordinator records it, and
  // only for a proof its roster --proof patterns name, so proof authority stays the roster's alone (GY-2876).
  demand(actor.role === 'coordinator', 'Coordinator permission required: only the loop records a reading', 403);
  // The one record of this kind: the loop's reading of a proof only it records (GY-1762), bound as loopObservation reads it.
  const proofs = loopObservationProofs(work);
  demand(!!proofs?.includes(data.proof), `${work.key} is not a loop-owned observation item owing ${data.proof}; a reading is recorded only on an item whose every criterion is a post-deploy observation the loop takes`, 409);
  demand(grantsAuthorize(actor.proofs ?? [], data.proof), `${actor.id} has no roster --proof pattern for ${data.proof}; a reading is recorded only under one`, 403);
  demand(data.policyRevision === work.policyRevision, `The reading names policy revision ${data.policyRevision}; ${work.key} is at ${work.policyRevision}`, 409);
  const request = followUpRequest(work), parent = request ? all.find(item => item.id === request.work) : null;
  if (request) {
    demand(!!parent?.delivery, `${work.key}'s follow-up request names ${request.work}, which is not a delivered item; its reading has no merge to bind to`, 409);
    demand(data.baseSha === parent!.delivery!.mergeSha, `The reading's base ${data.baseSha.slice(0, 12)} is not ${parent!.key}'s merge ${parent!.delivery!.mergeSha.slice(0, 12)}: a reading is bound to the parent delivery's merge`, 409);
  } else demand(data.sha === data.baseSha, 'A reading of an item that follows no delivery is bound to the serving release alone: sha and baseSha name it', 409);
  demand(!work.observationWindow || Date.parse(work.observationWindow.notBefore) <= now.getTime(), `${work.key}'s reading can first exist at ${work.observationWindow?.notBefore}; one taken before then is not recorded`, 409);
  const evidence: Evidence = { id: randomUUID(), proof: data.proof, sha: data.sha, baseSha: data.baseSha, policyRevision: data.policyRevision, producer: actor.id, trusted: true, result: data.result, executed: 1, skipped: 0, at: now.toISOString(), reading: { detail: data.detail } };
  await appendEvidence(work, evidence, db);
}
