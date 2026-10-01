import type { Work } from './work.js';
import { itemLane, laneRequiresProof, type BootstrapMode } from './policy.js';
import { evidenceBindsCandidate } from './carry.js';
import { evidenceProves } from './mechanical-proofs.js';
import { pathScopesOverlap } from './scope.js';
export { pathScope, pathScopeContains, pathScopesOverlap } from './scope.js';

export interface BootstrapObligation extends BootstrapMode { key: string; workId: string; criterionId: string; proof: string }

/**
 * A deferred proof is discharged only by a delivered change that actually ran it: trusted
 * passing evidence bound to that change's merged candidate and policy. Nothing an operator
 * or worker asserts can retire an obligation. GY-895: a manual: proof is judged, never counted
 * from titles, so its trusted pass discharges whatever it executed.
 */
export function deliveredProof(work: Work, proof: string) {
  return work.stage === 'done' && !!work.candidate && work.evidence.some(evidence => evidence.proof === proof && evidence.trusted
    && evidenceProves(proof, evidence)
    && evidenceBindsCandidate(work, evidence) && evidence.policyRevision === work.policyRevision);
}

/** Every bootstrap deferral no delivered change has proven yet. Derived, never asserted. */
export function bootstrapObligations(all: Work[]): BootstrapObligation[] {
  const declared = all.flatMap(item => item.criteria.flatMap(ac => ac.bootstrap
    ? ac.proofs.map(proof => ({ key: item.key, workId: item.id, criterionId: ac.id, proof, ...ac.bootstrap! }))
    : []));
  return declared.filter(obligation => !all.some(item => deliveredProof(item, obligation.proof)));
}

/**
 * Obligations another change deferred that this item's planned files now touch. A criterion
 * of this item cannot defer an inherited proof a second time: its own bootstrap declaration is
 * deliberately not consulted here, so the deferral can never be renewed by the change that
 * inherits it.
 */
export function inheritedObligations(work: Work, all: Work[]): BootstrapObligation[] {
  if (work.stage === 'done') return [];
  const alreadyRequired = new Set(work.criteria.flatMap(ac => ac.bootstrap ? [] : ac.proofs));
  const inherited: BootstrapObligation[] = [];
  for (const obligation of bootstrapObligations(all)) {
    if (obligation.workId === work.id || alreadyRequired.has(obligation.proof)) continue;
    if (inherited.some(seen => seen.proof === obligation.proof)) continue;
    if (work.plannedFiles.some(path => obligation.contractPaths.some(contract => pathScopesOverlap(path, contract)))) inherited.push(obligation);
  }
  return inherited;
}

/**
 * Exactly the proofs the acceptance gate demands for the current candidate: the criteria's proofs
 * the item's risk lane requires (GY-883: low none of its producer-run or manual ones, medium no
 * manual one) and every inherited obligation, which no lane waives.
 */
export function requiredProofs(work: Work, all: Work[]): string[] {
  const lane = itemLane(work);
  return [...new Set([...work.criteria.flatMap(ac => ac.bootstrap ? [] : ac.proofs.filter(proof => laneRequiresProof(lane, proof))), ...inheritedObligations(work, all).map(obligation => obligation.proof)])];
}
