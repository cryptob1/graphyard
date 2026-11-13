import type { PoolClient } from 'pg';
import { unauthorizedProofs } from '../../model/proof.js';
import { admin, criteriaChanges, deploySmokeProof, deploySmokeRequired, demand, singleCaseWarnings } from '../../model.js';
import type { Principal, Work } from '../../model.js';
import { resolveScenario } from '../../scenarios.js';
import { e2eProofRefusal } from '../../model/user-facing.js';
import { physicalCheckRefusal } from '../../model/human-proof.js';
import { endLapsedAttempt, recordIntervention } from '../../pipeline-speed.js';
import type { Ctx } from './types.js';
import type { Engine } from '../../engine.js';
import { assertHumanOwner, declareBootstrap, refuseRenewedDeferral } from './shared.js';

export async function run(c: Ctx) {
  await reviseRequirements(c.engine, c.db, c.actor, c.work, c.all, c.data, c.now);
}

/** Revise requirements and human ownership inside the caller's transaction. */
async function reviseRequirements(engine: Engine, db: PoolClient, actor: Principal, work: Work, all: Work[], data: any, now: Date): Promise<void> {
  if (actor.role !== 'operator-agent') admin(actor);
  demand(!work.observation?.merged, 'Merged work requires a follow-up task');
  // A revision read before the item's last one is refused as exactly that, first (GY-1293).
  demand(data.expectedPolicyRevision === work.policyRevision, 'Policy revision changed; reload before revising');
  // GY-3266: a live lease no longer refuses the revision — it is recorded at once below and the
  // lease stays; the worker reaches the changed criteria at its next sync or status, and complete
  // refuses until that sync.
  const previousCriteria = work.criteria;
  const descriptionChanged = data.description !== undefined && data.description !== work.description;
  const liveLease = !!work.lease && Date.parse(work.lease.expiresAt) > now.getTime();
  demand(new Set(data.criteria.map((ac: { id: string }) => ac.id)).size === data.criteria.length, 'Criterion IDs must be unique');
  demand(data.criteria.every((ac: { id: string }) => !work!.retiredCriterionIds?.includes(ac.id)), 'Retired criterion IDs cannot be reused');
  // GY-3037: an item keeps its e2e proof through a revision; no description excuses one.
  const e2e = e2eProofRefusal({ type: work!.type, description: data.description ?? work!.description, criteria: data.criteria });
  demand(!e2e, e2e!);
  const unphysical = physicalCheckRefusal(data.criteria);
  demand(!unphysical, unphysical!);
  demand(new Set(data.dependencies).size === data.dependencies.length && data.dependencies.every((dep: string) => all.some(w => w.id === dep)), 'Unknown or duplicate dependency');
  const reachesWork = (id: string, visited = new Set<string>()): boolean => {
    if (id === work!.id) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return all.find(w => w.id === id)!.dependencies.some(dep => reachesWork(dep, visited));
  };
  demand(!data.dependencies.some((dep: string) => reachesWork(dep)), 'Dependencies would create a cycle');
  const revised = declareBootstrap(engine, actor, data, work.criteria, work.policyRevision + 1, now, work);
  const pins: Work['scenarioRequirements'] = [];
  const proofs = [...new Set<string>(data.criteria.flatMap((ac: { proofs: string[] }) => ac.proofs))];
  for (const proof of proofs.filter(p => p.startsWith('e2e:'))) {
    const pinned = work.scenarioRequirements.find(s => s.proof === proof);
    if (pinned) { pins.push(pinned); continue; }
    const scenario = await resolveScenario(db, proof.slice(4), { at: now, by: actor.id }, engine.repository);
    // GY-2973: an unregistered scenario pins nothing; the case is the item's own deliverable, and
    // the trial refuses the head while it lacks e2e/cases/NAME.json.
    if (scenario) pins.push({ proof, revision: scenario.revision, environment: scenario.environment, hash: scenario.hash });
  }
  work.retiredCriterionIds = [...(work.retiredCriterionIds ?? []), ...work.criteria.filter(ac => !data.criteria.some((next: { id: string }) => next.id === ac.id)).map(ac => ac.id)];
  if (data.owner !== undefined) { await assertHumanOwner(engine, db, data.owner); work.owner = data.owner; }
  work.criteria = revised;
  if (descriptionChanged) work.description = data.description;
  if (data.plannedFiles !== undefined) work.plannedFiles = data.plannedFiles;
  work.dependencies = data.dependencies; work.exclusiveResources = data.exclusiveResources; work.producerProofs = data.producerProofs;
  work.scenarioRequirements = pins; work.policyRevision++;
  refuseRenewedDeferral(work, all);
  work.proofGaps = unauthorizedProofs(engine.principals, [...proofs, ...(deploySmokeRequired(work.policy) ? [deploySmokeProof] : [])], work.producerProofs);
  // GY-2975: a revision rejudges the warning from the revised criteria; none, the field goes.
  const warnings = singleCaseWarnings(revised);
  work.warnings = warnings.length ? warnings : undefined;
  work.formalReviewResetRequired = true; work.formalReviewBaseline = undefined;
  // A revision is a hand-off for an item already under way: its timeline counts it, and the
  // lapsed lease it discards ends that attempt at its deadline. A live one stays (GY-3266): the
  // revision is queued on it instead, and complete refuses the submission until the worker's
  // sync acknowledges it.
  if (liveLease) work.unsyncedRevision = { policyRevision: work.policyRevision, at: now.toISOString(), by: actor.id, changed: [...(descriptionChanged ? [`description changed: ${data.description.slice(0, 450)}`] : []), ...criteriaChanges(previousCriteria, revised)] };
  if (work.lease && !liveLease) endLapsedAttempt(work, work.lease, now);
  recordIntervention(work, 'requirements');
  work.lease = liveLease ? work.lease : null;
  work.observation = null; work.mergeAuthorization = null;
  // A submitted implementation must be explicitly reconsidered for changed intent.
  if (work.submission) { work.reworkRequested = true; work.lastRework = { reason: `Requirements revised: ${data.reason}`, binding: null, at: now.toISOString() }; }

}
