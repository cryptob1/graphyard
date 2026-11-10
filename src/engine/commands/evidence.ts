import { appendEvidence } from '../../model-boundary/append-evidence.js';
import { record } from '../../store/mutations.js';
import { randomUUID } from 'node:crypto';
import { authorizedForProof } from '../../model/proof.js';
import { attachedCriteria, exerciseRefusal, deploySmokeProof, deploySmokeRequired, demand } from '../../model.js';
import type { Evidence } from '../../model.js';
import { attestedProof } from '../../model/mechanical-proofs.js';
import { producerIndependenceRefusal } from '../../delegation.js';
import type { Ctx } from './types.js';

export async function run(c: Ctx) {
  const { engine, db, actor, data, all, now, work } = c;
  // GY-3238: the master's attest is the one evidence an operator-agent identity records — a
  // manual: proof no producer may run, attested on the exact current head. A manual: proof is
  // judged as the attestation it is, so a worker never records one at all: its record could only
  // claim a trust no worker holds.
  const attest = actor.role === 'operator-agent';
  demand(attest || actor.role === 'producer' || actor.role === 'worker' || actor.role === 'admin', 'Evidence submission is not permitted', 403);
  demand(!(actor.role === 'worker' && attestedProof(data.proof)),
    `A manual: proof is the master's attestation, never a worker's record: graphyard master attest ${work.key} ${data.proof} REASON`, 403);
  // Workers may still record their own untrusted assertions; every identity
  // that could mint trust must be independent of the implementation and the lead.
  const dependent = actor.role === 'worker' ? null : producerIndependenceRefusal(actor, work, engine.principals);
  demand(!dependent, dependent ?? 'Evidence producer is not independent', 403);
  // Trust is decided by the live grant set, never by the deployment environment — except the
  // master's attest, which is the operator-agent identity's own recorded judgement.
  const trusted = attest || authorizedForProof(actor, data.proof);
  if (data.proof === deploySmokeProof) {
    // Post-deployment proof is a trust boundary with no untrusted tier: it is accepted only
    // from a producer granted the proof, only once Graphyard has observed the deployment,
    // and only bound to that observed serving commit and this item's merge commit.
    demand(trusted, `${deploySmokeProof} evidence is accepted only from a producer authorized for that proof`, 403);
    demand(deploySmokeRequired(work.policy), `Work policy does not require ${deploySmokeProof}`);
    demand(work.stage === 'done' && !!work.delivery, `${deploySmokeProof} evidence is accepted only after delivery`);
    demand(!!work.delivery!.deployment, 'Graphyard has not observed a deployment covering this delivery');
    demand(data.sha === work.delivery!.deployment!.sha && data.baseSha === work.delivery!.mergeSha,
      `${deploySmokeProof} evidence must name the observed deployed commit ${work.delivery!.deployment!.sha} as sha and merge commit ${work.delivery!.mergeSha} as baseSha`);
    demand(data.policyRevision === work.policyRevision, 'Policy revision does not match this delivery');
  }
  // GY-135: a pass is trusted only beside a recorded run that fails with the criterion's
  // behaviour removed; otherwise it is kept, untrusted, as not exercising its criterion.
  const unexercised = trusted && data.proof !== deploySmokeProof ? exerciseRefusal(work, all, data) : null;
  const evidence: Evidence = { ...data, id: randomUUID(), producer: actor.id, trusted: trusted && !unexercised, at: now.toISOString(), ...(unexercised ? { unexercised } : {}) };
  if (unexercised) await record(db, work, actor.id, 'evidence.exercise.refused', { details: { proof: data.proof, criteria: attachedCriteria(work, all, data.proof), behaviour: data.exercise?.behaviour ?? null, sha: data.sha, reason: unexercised } });
  await appendEvidence(work, evidence, db);
  // GY-162: a trusted e2e: record is also a run of its test case, appended to the case's history.
  if (data.proof === deploySmokeProof) work.delivery!.smoke = { evidenceId: evidence.id, result: data.result, sha: data.sha, mergeSha: data.baseSha, producer: actor.id, at: evidence.at, executed: data.executed, skipped: data.skipped, ...(data.url ? { url: data.url } : {}) };
}

export function delivered({ data }: Ctx) {
  // The only command a delivered item still accepts: the post-deployment smoke fact that
  // extends the delivery snapshot without reopening the merge.
  return data.proof === deploySmokeProof;
}

/** The master's attest: a manual: proof a criterion of this item binds, on the exact current head (GY-3238). */
export function operator({ data, work, all }: Ctx) {
  demand(attestedProof(data.proof), `The master attests only manual: proofs; ${data.proof} is established by the identity granted it`, 403);
  demand(!(work.producerProofs ?? []).includes(data.proof), `${data.proof} is producer-runnable (${work.key} names it in producerProofs), so it is never attested`, 403);
  demand(attachedCriteria(work, all, data.proof).length > 0, `${data.proof} is bound by no criterion of ${work.key}`, 422);
  demand(!!work.candidate && data.sha === work.candidate.sha && data.baseSha === work.candidate.baseSha && data.policyRevision === work.policyRevision,
    `An attestation is recorded on ${work.key}'s current candidate ${work.candidate?.sha.slice(0, 12) ?? '(none)'} on base ${work.candidate?.baseSha.slice(0, 12) ?? '(none)'} under policy revision ${work.policyRevision}`, 409);
}
