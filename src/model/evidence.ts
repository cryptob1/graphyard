import type { Work } from './work.js';

export type ArtifactKind = 'log' | 'report' | 'screenshot' | 'trace' | 'other';
export type ArtifactAvailability = 'available' | 'expired' | 'redacted' | 'missing' | 'external';
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
  validation?: { candidateId: string; requestId: string; attemptId: string };
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
      && !!work.candidate && evidence.sha === work.candidate.sha && evidence.baseSha === work.candidate.baseSha && evidence.policyRevision === work.policyRevision);
    for (const producer of new Set(superseded.map(evidence => evidence.producer)))
      refusals.push(`Trusted ${proof} evidence from ${producer} is no longer independent: ${producer} has since held an assignment on ${work.key}`);
  }
  return refusals;
}

// Shared by gates and human-facing proof previews.
export function currentEvidence(work: Work, proof: string, now = new Date()): Evidence | undefined {
  const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
  const validation = work.validation?.[proof];
  const implementers = implementerIdentities(work);
  const latest = work.evidence.filter(e => e.proof === proof && e.trusted && !implementers.includes(e.producer) && e.sha === work.candidate?.sha && e.baseSha === work.candidate?.baseSha && e.policyRevision === work.policyRevision
    && (!validation || !!validation.attemptId && e.validation?.candidateId === validation.candidateId && e.validation?.requestId === validation.requestId && e.validation?.attemptId === validation.attemptId)
    && (!scenario || e.scenarioRevision === scenario.revision && e.environment === scenario.environment)).at(-1);
  return latest && (!latest.expiresAt || Date.parse(latest.expiresAt) > now.getTime()) ? latest : undefined;
}
