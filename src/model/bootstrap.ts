import type { Work } from './work.js';
import type { BootstrapMode } from './policy.js';

// Deliberately bounded scope syntax: exact paths or directory prefixes ending /, /*, /**.
// Unsupported glob expressions are not interpreted as semantic dependency knowledge.
export function pathScope(value: string) {
  const path = value.replace(/^\.\//, '');
  const prefix = path.endsWith('/') || /\/\*{1,2}$/.test(path);
  return { path: prefix ? path.replace(/\*+$/, '') : path, prefix };
}
export function pathScopesOverlap(a: string, b: string) {
  const left = pathScope(a), right = pathScope(b);
  return left.path === right.path || left.prefix && right.path.startsWith(left.path) || right.prefix && left.path.startsWith(right.path);
}
/** True when `outer` covers every file `inner` can name. A file scope contains only itself. */
export function pathScopeContains(outer: string, inner: string) {
  const wide = pathScope(outer), narrow = pathScope(inner);
  return wide.path === narrow.path ? wide.prefix || !narrow.prefix : wide.prefix && narrow.path.startsWith(wide.path);
}

export interface BootstrapObligation extends BootstrapMode { key: string; workId: string; criterionId: string; proof: string }

/**
 * A deferred proof is discharged only by a delivered change that actually ran it: trusted
 * passing evidence bound to that change's merged candidate and policy. Nothing an operator
 * or worker asserts can retire an obligation.
 */
export function deliveredProof(work: Work, proof: string) {
  const candidate = work.candidate;
  return work.stage === 'done' && !!candidate && work.evidence.some(evidence => evidence.proof === proof && evidence.trusted
    && evidence.result === 'pass' && evidence.executed > 0 && evidence.skipped === 0
    && evidence.sha === candidate.sha && evidence.baseSha === candidate.baseSha && evidence.policyRevision === work.policyRevision);
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

/** Exactly the proofs the acceptance gate demands for the current candidate. */
export function requiredProofs(work: Work, all: Work[]): string[] {
  return [...new Set([...work.criteria.flatMap(ac => ac.bootstrap ? [] : ac.proofs), ...inheritedObligations(work, all).map(obligation => obligation.proof)])];
}
