import { z } from 'zod';
import type { Work } from './work.js';
import type { CiRun } from './ci-proofs.js';
import { evidenceBindsCandidate } from './carry.js';
import { reservedForAttestation, type ClosedQuestionRecord } from './closed-question.js';
import { inheritedObligations } from './bootstrap.js';

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
  /** What a validation result was attributed to: the exact manifest, compatibility signature and independently observed target; see docs/delivery.md, "Attribution". */
  attribution?: EvidenceAttribution;
  /**
   * D6: this entry was derived from an executed attempt's pass by a recorded reuse decision
   * rather than measured for this head. `observedAt` is when the original evidence was
   * collected; `sourceSha` is the head it measured. A later live attempt for the same proof
   * supersedes the selection this entry is bound to, so a later failure always wins.
   */
  /**
   * GY-109: this record is a closed-question answer the control plane asked for, not a producer's
   * measurement: the question, the answers offered, the hash of the bound state, the responder and
   * its version, the answer, its probability and the threshold applied. `producer` names the
   * responder. It is evidence only — see `answerCounts` and model/closed-question.ts.
   */
  closedQuestion?: ClosedQuestionRecord;
  reuse?: { decisionId: string; evidenceId: string; candidateId: string; requestId: string; attemptId: string; sequence: number; sourceSha: string; observedAt: string; policy: { id: string; revision: number } };
  /**
   * GY-135: the producer's run of the same proof against a tree with its criterion's behaviour
   * removed, recorded beside the outcome. A pass stands only when that run failed; otherwise the
   * record is kept untrusted with `unexercised` naming the proof, the criterion and the behaviour.
   */
  exercise?: ProofExercise;
  /** Set by the control plane, never the producer: why this pass does not exercise its criterion. */
  unexercised?: string;
}
export interface ProofExercise {
  /**
   * The criterion the proof is attached to, e.g. `AC-1`; an inherited obligation is `KEY AC-n`.
   * It may be left out only when the proof is attached to exactly one criterion.
   */
  criterion?: string;
  /** The behaviour the producer removed from the tree, in words a worker can find in the diff. */
  behaviour: string;
  /** How the proof came out against that tree, and how many cases ran there. */
  result: 'pass' | 'fail'; executed: number;
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

/**
 * A closed-question answer counts only as the verdict it claims to be: confident against the
 * threshold recorded with it, and never for a proof that only an approved attest decision — a
 * two-party decision — may establish. Every other record is unaffected.
 */
export function answerCounts(work: Pick<Work, 'producerProofs'>, evidence: Evidence) {
  const answer = evidence.closedQuestion;
  if (!answer) return true;
  return answer.verdict === 'decided' && answer.probability >= answer.threshold && !reservedForAttestation(work, evidence.proof);
}

// Shared by gates and human-facing proof previews. A record binds the candidate exactly, or
// carried across a Graphyard-authored tip (see carry.ts); nothing else applies.
export function currentEvidence(work: Work, proof: string, now = new Date()): Evidence | undefined {
  const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
  const validation = work.validation?.[proof];
  const implementers = implementerIdentities(work);
  const latest = work.evidence.filter(e => e.proof === proof && e.trusted && !e.revocation && answerCounts(work, e) && !implementers.includes(e.producer) && evidenceBindsCandidate(work, e) && e.policyRevision === work.policyRevision
    && (!validation || !!validation.attemptId && e.validation?.candidateId === validation.candidateId && e.validation?.requestId === validation.requestId && e.validation?.attemptId === validation.attemptId)
    && (!scenario || e.scenarioRevision === scenario.revision && e.environment === scenario.environment)).at(-1);
  return latest && (!latest.expiresAt || Date.parse(latest.expiresAt) > now.getTime()) ? latest : undefined;
}

/** What a producer submits as `exercise`. */
export const proofExerciseSchema = z.object({
  criterion: z.string().trim().min(1).max(80).optional(), behaviour: z.string().trim().min(1).max(300),
  result: z.enum(['pass', 'fail']), executed: z.number().int().min(0),
}).strict();

/** The criteria a proof is attached to on this item: its own, and any bootstrap obligation it inherited. */
export function attachedCriteria(work: Work, all: Work[], proof: string): string[] {
  return [...work.criteria.filter(criterion => criterion.proofs.includes(proof)).map(criterion => criterion.id),
    ...inheritedObligations(work, all).filter(obligation => obligation.proof === proof).map(obligation => `${obligation.key} ${obligation.criterionId}`)];
}

/**
 * GY-135: a proof that passes against an unchanged tree proves nothing. A passing record for a
 * proof attached to a criterion is trusted only when the producer also recorded the same proof
 * failing, with cases executed, against a tree with that criterion's behaviour removed. Anything
 * else is recorded as not exercising its criterion rather than as passing, and this reason names
 * the proof, the criterion and the behaviour whose removal left it passing. A failing record needs
 * no such run, and a proof attached to no criterion (post-deployment smoke) has none to exercise.
 */
export function exerciseRefusal(work: Work, all: Work[], data: Pick<Evidence, 'proof' | 'result' | 'exercise'>): string | null {
  if (data.result !== 'pass') return null;
  const criteria = attachedCriteria(work, all, data.proof);
  if (!criteria.length) return null;
  const named = criteria.join(', ');
  const exercise = data.exercise;
  if (!exercise) return `${data.proof} does not exercise ${named}: it passed, but no run of it against a tree with ${criteria.length > 1 ? 'a' : 'the'} criterion's behaviour removed was recorded, so it is recorded as not exercising its criterion rather than as passing`;
  const criterion = exercise.criterion ?? (criteria.length === 1 ? criteria[0] : undefined);
  if (!criterion) return `${data.proof} does not name which of ${named} its run against a tree with "${exercise.behaviour}" removed exercises; it is recorded as not exercising its criterion rather than as passing`;
  if (!criteria.includes(criterion)) return `${data.proof} names ${criterion} for its run against a tree with "${exercise.behaviour}" removed, but it is attached to ${named}; it is recorded as not exercising its criterion rather than as passing`;
  if (exercise.executed < 1) return `${data.proof} does not exercise ${criterion}: no case ran against the tree with "${exercise.behaviour}" removed, so it is recorded as not exercising its criterion rather than as passing`;
  if (exercise.result === 'pass') return `${data.proof} does not exercise ${criterion}: it passed against the tree with "${exercise.behaviour}" removed as well as against the change, so it is recorded as not exercising its criterion rather than as passing`;
  return null;
}
