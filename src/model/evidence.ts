import type { Work } from './work.js';
import type { CiRun } from './ci-proofs.js';
import { evidenceBindsCandidate } from './carry.js';

export type ArtifactKind = 'log' | 'report' | 'screenshot' | 'trace' | 'other';
export type ArtifactAvailability = 'available' | 'expired' | 'redacted' | 'missing' | 'upload-failed' | 'external';
export interface EvidenceArtifact {
  kind: ArtifactKind; label: string; mediaType?: string; size?: number; digest?: string;
  expiresAt?: string; availability: ArtifactAvailability;
  /** Public location. External locations are never treated as trusted proof. */
  url?: string;
  /** Authenticated Graphyard route components; never contains a bearer credential. */
  reference?: { requestId: string; artifactId: string };
}
export interface Evidence {
  id: string; proof: string; sha: string; baseSha: string; policyRevision: number;
  producer: string; trusted: boolean; result: 'pass' | 'fail';
  executed: number; skipped: number; url?: string; at: string; expiresAt?: string;
  artifacts?: EvidenceArtifact[];
  scenarioRevision?: number; environment?: string;
  /**
   * The paths this proof depends on, in the bounded scope syntax of `plannedFiles`, declared by
   * the producer. The merge queue carries the record onto a Graphyard-authored tip only when this
   * scope is disjoint from what the predecessor changed; an undeclared scope is never carried.
   */
  scopeFiles?: string[];
  revocation?: { at: string; actor: string; reason: string };
  /**
   * The same proof run against the candidate's base tree — the tree as it stood before the
   * implementation — as the producer reports it. A proof that passes there as well does not
   * exercise its criterion, so the control plane records the entry `unexercised` and it
   * satisfies nothing; see `unexercisedProof` and docs/master-agent.md#verify-before-review.
   */
  baseline?: { sha: string; result: 'pass' | 'fail'; executed: number; skipped: number };
  /** Derived by the control plane from `baseline` when the record is accepted; never asserted by a producer. */
  unexercised?: boolean;
  provenance?: {
    provider: 'github-actions'; repository: string; workflowCommit: string;
    runId: string; runAttempt: number;
    artifact: { id: number; name: string; digest: string; url: string; createdAt: string };
  };
  validation?: { candidateId: string; requestId: string; attemptId: string };
  /**
   * CI-produced evidence: the GitHub Actions job that executed the registered contract on this
   * commit, as the control plane read it back from GitHub before accepting the record. Only the
   * CI producer principal writes this lane; see docs/protocol/evidence.md.
   */
  ciRun?: CiRun;
  /** What a validation result was attributed to: the exact manifest, compatibility signature and independently observed target; see docs/attribution.md. */
  attribution?: EvidenceAttribution;
  /**
   * D6: this entry was derived from an executed attempt's pass by a recorded reuse decision
   * rather than measured for this head. `observedAt` is when the original evidence was
   * collected; `sourceSha` is the head it measured. A later live attempt for the same proof
   * supersedes the selection this entry is bound to, so a later failure always wins.
   */
  reuse?: { decisionId: string; evidenceId: string; candidateId: string; requestId: string; attemptId: string; sequence: number; sourceSha: string; observedAt: string; policy: { id: string; revision: number } };
}
export interface EvidenceAttribution {
  manifestHash: string; digestHash: string; signature: string; environmentId: string; environmentRevision: number;
  targetKind: 'immutable-preview' | 'shared-staging'; targetState: 'unobserved' | 'matched' | 'mismatched' | 'unknown'; targetObservationIds: string[];
}

// Every identity that has held an assignment on this item, including superseded
// epochs and legacy documents that predate the append-only list.
export function implementerIdentities(work: Work): string[] {
  return [...new Set([
    ...(work.implementers ?? []),
    ...work.workspaces.map(workspace => workspace.owner),
    ...(work.lastAssignment ? [work.lastAssignment.owner] : []),
    ...(work.lease ? [work.lease.owner] : []),
  ])];
}

// AC-4 independence is a standing property, not a submission-time check. The
// implementer set is append-only, so trusted evidence whose producer later takes
// an assignment stops being applicable, without any history being rewritten. The
// loss is reported only for proofs no still-independent producer has re-proved,
// so re-proving the same candidate remains possible.
export function evidenceIndependenceRefusals(work: Work, now = new Date()): string[] {
  const implementers = implementerIdentities(work);
  const refusals: string[] = [];
  for (const proof of new Set(work.criteria.flatMap(criterion => criterion.proofs))) {
    if (currentEvidence(work, proof, now)) continue;
    const superseded = work.evidence.filter(evidence => evidence.proof === proof && evidence.trusted && implementers.includes(evidence.producer)
      && evidenceBindsCandidate(work, evidence) && evidence.policyRevision === work.policyRevision);
    for (const producer of new Set(superseded.map(evidence => evidence.producer)))
      refusals.push(`Trusted ${proof} evidence from ${producer} is no longer independent: ${producer} has since held an assignment on ${work.key}`);
  }
  return refusals;
}

// Shared by gates and human-facing proof previews. A record binds the candidate exactly, or
// carried across a Graphyard-authored tip (see carry.ts); nothing else applies.
export function currentEvidence(work: Work, proof: string, now = new Date()): Evidence | undefined {
  const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
  const validation = work.validation?.[proof];
  const implementers = implementerIdentities(work);
  const latest = work.evidence.filter(e => e.proof === proof && e.trusted && !e.revocation && !implementers.includes(e.producer) && evidenceBindsCandidate(work, e) && e.policyRevision === work.policyRevision
    && (!validation || !!validation.attemptId && e.validation?.candidateId === validation.candidateId && e.validation?.requestId === validation.requestId && e.validation?.attemptId === validation.attemptId)
    && (!scenario || e.scenarioRevision === scenario.revision && e.environment === scenario.environment)).at(-1);
  return latest && (!latest.expiresAt || Date.parse(latest.expiresAt) > now.getTime()) ? latest : undefined;
}

/**
 * A proof that passes against the base tree proves nothing about the change: it passed before the
 * implementation existed, so its passing on the candidate cannot be what the criterion asked for.
 */
export const unexercisedProof = (evidence: Pick<Evidence, 'result' | 'baseline'>) =>
  evidence.result === 'pass' && !!evidence.baseline && evidence.baseline.result === 'pass' && evidence.baseline.executed > 0;
