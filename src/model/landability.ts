import { baseRefreshConflict, restoringAfterEjection, staleSpeculativeTip } from '../merge-queue.js';
import type { QueueEjection } from '../merge-queue.js';
import type { Work } from './work.js';
import { currentEvidence, evidenceIndependenceRefusals } from './evidence.js';
import { inheritedObligations, requiredProofs } from './bootstrap.js';
import { evidenceBindsCandidate } from './carry.js';
import { mechanicalFailure, mechanicalVerdicts, evidenceProves, attestedProof } from './mechanical-proofs.js';
import { queuedRegressions, regressionRefusals, staleTipRegressions } from '../regression-guard.js';
import { itemLane, laneRequiresProof, releaseCandidateProof } from './policy.js';

/**
 * GY-878. One landability verdict. Whether a candidate can land was answered twice — by the build
 * and acceptance gates, and again by the merge queue's ejection check and its landing re-check —
 * and the answers drifted apart: the queue ejected files the build gate excused as carried
 * (GY-871), manual evidence that executed nothing (GY-875), and a revert the three-way merge showed
 * was none (GY-863). `evaluateLandability` is now the single authority. The build and acceptance
 * gates are its two families, word for word, and the queue ejects an entry only for a reason the
 * verdict gives: a refusal that is an observed adverse conclusion about the queued tip carries the
 * queue's wording as `eject`, and nothing else ejects on landability grounds.
 *
 * The verdict is pure and deterministic: it is computed on demand from the live facts keyed by the
 * candidate SHA and policy revision (observation, evidence, peers, `now`), never stored and never
 * read back — a stored verdict would go stale exactly as GY-710's did. What is recorded is the
 * audit of a refusal (`version` and `inputs`) on the gate and on any ejection it causes.
 */
export const LANDABILITY_VERSION = 1;

export type LandabilityGate = 'build' | 'acceptance';
export interface LandabilityReason {
  gate: LandabilityGate;
  reason: string;
  /** The merge queue's ejection wording, when this refusal is an adverse conclusion about the queued tip. */
  eject?: string;
  /** Where the queue reads that ejection: with the landing check on the tip's tree, or with its proofs after CI and review. */
  ground?: LandabilityGround;
}
export type LandabilityGround = 'landing' | 'proof';
/** What the verdict was computed from: the candidate identity, the policy revision and the evidence it read. */
export interface LandabilityInputs {
  key: string; sha: string | null; baseSha: string | null; policyRevision: number;
  observed: { sha: string; baseSha: string } | null; landingBase: string | null; evidence: string[];
}
export interface LandabilityAudit { version: number; inputs: LandabilityInputs }
export type LandabilityVerdict =
  | ({ verdict: 'landable' } & LandabilityAudit)
  | ({ verdict: 'refused'; reasons: LandabilityReason[] } & LandabilityAudit);

declare module './work.js' {
  interface Gate {
    /** GY-878: the landability verdict's version and inputs, recorded on a refused build or acceptance gate. */
    verdict?: LandabilityAudit;
  }
}
function inputsOf(work: Work): LandabilityInputs {
  const obs = work.observation;
  return {
    key: work.key, sha: work.candidate?.sha ?? null, baseSha: work.candidate?.baseSha ?? null, policyRevision: work.policyRevision,
    observed: obs ? { sha: obs.candidate.sha, baseSha: obs.candidate.baseSha } : null, landingBase: obs?.landing?.base ?? null,
    evidence: work.evidence.filter(entry => entry.policyRevision === work.policyRevision && evidenceBindsCandidate(work, entry)).map(entry => entry.id).sort(),
  };
}

/** The build family: exactly the build gate's refusals, in its order, with the queue's landing ejection attached. */
function buildFamily(work: Work, all: Work[], now: Date): LandabilityReason[] {
  const candidate = work.candidate, obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;
  // A speculative tip built behind an entry that left the queue unlanded holds that entry's work
  // (GY-568): nothing its tree shows is this item's, so no tree-dependent refusal is read from it.
  const restoring = restoringAfterEjection(work, all);
  const conflict = restoring ? null : baseRefreshConflict(work);
  // Mechanical verification precedes review (GY-115).
  const mechanical = current && work.submission && !work.reworkRequested && !restoring
    ? mechanicalVerdicts(work, all, now).filter(verdict => verdict.outcome === 'failed').map(verdict => mechanicalFailure(verdict, candidate!.sha)) : [];
  const regressions = current && !restoring ? regressionRefusals(work, obs!, all) : [];
  const reasons: LandabilityReason[] = [
    ...(!work.submission || work.reworkRequested ? ['Worker has not submitted implementation for this attempt'] : []),
    ...(!candidate ? ['Pull request has not been independently observed'] : []),
    ...(!work.workspaces.length ? ['No workspace registered'] : []),
    ...(restoring ? [restoring] : []), ...(conflict ? [conflict] : []),
  ].map(reason => ({ gate: 'build' as const, reason }));
  const own: LandabilityReason[] = regressions.map(reason => ({ gate: 'build', reason }));
  reasons.push(...own, ...mechanical.map(reason => ({ gate: 'build' as const, reason })));
  if (!current) return reasons;
  // The landing guard's view of the same tree. A tip still built behind an entry that left without
  // landing, whose tree shows a refused conclusion before any carried excusal, leaves the queue so
  // the control plane restores it; otherwise only this change's own adverse regressions — carried
  // files excused exactly as the build gate excuses them (GY-871), uncompared files never — eject.
  const tip = candidate!.sha.slice(0, 12);
  const unexcused = staleTipRegressions(work, obs!, all);
  const stale = unexcused.length ? staleSpeculativeTip(work, all) : null;
  const queued = stale ? [] : queuedRegressions(work, obs!, all);
  const eject = stale
    ? `Speculative tip ${tip} was built behind ${stale.departed.join(', ')}, which left the merge queue without landing; landing it on ${unexcused[0].base.slice(0, 12)} would carry their unlanded work (${unexcused.map(entry => entry.text).join('; ')}), so the branch is restored to its own reviewed head`
    : queued.length ? `Landing speculative tip ${tip} on ${queued[0].base.slice(0, 12)} would revert work outside its planned files: ${queued.map(entry => entry.text).join('; ')}` : null;
  if (!eject) return reasons;
  // The ejection is attached to the refusal it comes from: the restore the stale tip waits for, or
  // the first of this change's own regressions. Every adverse landing conclusion is a build
  // refusal, so the fallback only keeps the rule total: nothing ejects that the verdict lacks.
  const carrier = (stale && restoring ? reasons.find(entry => entry.reason === restoring) : undefined) ?? reasons.find(entry => own.includes(entry));
  if (carrier) Object.assign(carrier, { eject, ground: 'landing' });
  else reasons.push({ gate: 'build', reason: eject, eject, ground: 'landing' });
  return reasons;
}

/** The acceptance family: exactly the acceptance gate's refusals, each tagged with the proof it demands. */
function acceptanceFamily(work: Work, all: Work[], now: Date): (LandabilityReason & { proof?: string })[] {
  // GY-895: the pass rule is per family — a manual: proof is judged as an attestation, so its
  // trusted pass proves it whatever it executed, while every other proof keeps the title-count rule.
  const unproven = (proof: string) => {
    const evidence = currentEvidence(work, proof, now);
    return !evidence || !evidenceProves(proof, evidence);
  };
  const demanded = (proof: string) => {
    const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
    // Name an explicit revocation: an operator otherwise cannot tell a revoked
    // candidate apart from one that was never proven.
    const revoked = work.evidence.some(e => e.proof === proof && e.trusted && !!e.revocation && evidenceBindsCandidate(work, e) && e.policyRevision === work.policyRevision);
    return `${proof} needs trusted passing evidence, with${attestedProof(proof) ? '' : ' executed > 0 and'} skipped = 0, for this candidate and policy${scenario ? `; scenario v${scenario.revision} in ${scenario.environment}` : ''}${revoked && !currentEvidence(work, proof, now) ? '; previously accepted evidence was revoked' : ''}`;
  };
  const reasons: (LandabilityReason & { proof?: string })[] = [];
  // A bootstrap criterion's proofs are deferred here and required of the next change that
  // touches the same contract; review, CI and every other criterion still gate this one.
  // The item's risk lane is an input to this verdict (GY-883): it decides which of the criteria's
  // proofs are required — low none of their producer-run or manual ones, medium no manual one,
  // high all — while an inherited obligation is required in every lane. GY-1101: no lane requires
  // an integration: or e2e: proof before merge; those run against the release candidate that first
  // contains the merge commit (model/release.ts), so the merge gate is build, CI and review.
  const lane = itemLane(work);
  for (const ac of work.criteria.filter(criterion => !criterion.bootstrap)) for (const proof of ac.proofs) {
    if (laneRequiresProof(lane, proof) && unproven(proof)) reasons.push({ gate: 'acceptance', reason: `${ac.id}: ${demanded(proof)}`, proof });
  }
  for (const obligation of inheritedObligations(work, all)) {
    if (!releaseCandidateProof(obligation.proof) && unproven(obligation.proof)) reasons.push({ gate: 'acceptance', reason: `Bootstrap obligation inherited from ${obligation.key} ${obligation.criterionId}: ${demanded(obligation.proof)}`, proof: obligation.proof });
  }
  // Independence is re-decided on every evaluation, so evidence minted before its
  // producer joined the implementer set refuses acceptance with a named reason.
  reasons.push(...evidenceIndependenceRefusals(work, now).map(reason => ({ gate: 'acceptance' as const, reason })));
  return reasons;
}

/**
 * The adverse proof conclusion about the tip, attached to the refusal it comes from. A proof whose
 * evidence binding this tip failed or was withdrawn is an adverse conclusion, not a missing one:
 * the queue ejects it rather than hold everything behind it. A required proof's is the acceptance
 * refusal of that proof, so a failure the newest record has answered refuses and ejects nothing. A
 * judged failure of a proof no criterion or obligation requires is still a failure of the change
 * (GY-868): the build family refuses it, returning the head to its worker, and the queue ejects on
 * it. One failing record is no conclusion: a trusted `manual:` proof whose executed is 0 judged
 * nothing — the unexercised finding answered by an attestation the loop requests for a proof a
 * criterion of this item names (GY-875, GY-910) — so the entry is held for that instead.
 */
function attachProofEjection(work: Work, all: Work[], now: Date, build: LandabilityReason[], acceptance: (LandabilityReason & { proof?: string })[], judged: boolean): LandabilityReason[] {
  const candidate = work.candidate;
  const plain = () => acceptance.map(({ proof: _proof, ...entry }) => entry);
  if (!candidate) return plain();
  const refused = new Set(acceptance.flatMap(entry => entry.proof ? [entry.proof] : []));
  const required = new Set(requiredProofs(work, all));
  const stray = (proof: string) => judged && !required.has(proof) && !(currentEvidence(work, proof, now) && evidenceProves(proof, currentEvidence(work, proof, now)!));
  const binds = (item: Work['evidence'][number]) => item.trusted && evidenceBindsCandidate(work, item) && item.policyRevision === work.policyRevision;
  const failed = work.evidence.find(item => binds(item) && item.result === 'fail' && (refused.has(item.proof) || stray(item.proof))
    && !(item.proof.startsWith('manual:') && item.executed === 0 && work.criteria.some(criterion => criterion.proofs.includes(item.proof))));
  const revoked = failed ? undefined : work.evidence.find(item => binds(item) && !!item.revocation && refused.has(item.proof));
  const tip = candidate.sha.slice(0, 12);
  const adverse = failed ? { proof: failed.proof, eject: `Proof ${failed.proof} failed on speculative tip ${tip}`, ground: 'proof' as const }
    : revoked ? { proof: revoked.proof, eject: `Proof ${revoked.proof} was revoked on speculative tip ${tip}: ${revoked.revocation!.reason}`, ground: 'proof' as const } : null;
  if (!adverse) return plain();
  const carrier = acceptance.findIndex(entry => entry.proof === adverse.proof);
  if (carrier < 0) build.push({ gate: 'build', reason: `${adverse.proof}, which no criterion requires, failed on ${tip} (trusted evidence from ${failed!.producer}); the head returns to its worker before review`, eject: adverse.eject, ground: adverse.ground });
  return acceptance.map(({ proof: _proof, ...entry }, index) => index === carrier ? { ...entry, eject: adverse.eject, ground: adverse.ground } : entry);
}

/**
 * The single landability verdict for a work item's current candidate under its current policy:
 * `landable`, or `refused` with every reason, each naming the gate it refuses. Pure: the same
 * item, peers and instant always give the same verdict, and nothing stored is consulted.
 */
export function evaluateLandability(work: Work, all: Work[], now: Date): LandabilityVerdict {
  const build = buildFamily(work, all, now);
  // A stray judged failure is read where the build family reads the tree: on the observed candidate
  // of a submitted attempt that is not waiting for its branch restore.
  const candidate = work.candidate, obs = work.observation;
  const judged = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha
    && !!work.submission && !work.reworkRequested && !restoringAfterEjection(work, all);
  const acceptance = attachProofEjection(work, all, now, build, acceptanceFamily(work, all, now), judged);
  const reasons = [...build, ...acceptance];
  const audit = { version: LANDABILITY_VERSION, inputs: inputsOf(work) };
  return reasons.length ? { verdict: 'refused', reasons, ...audit } : { verdict: 'landable', ...audit };
}

/** The refusal reasons of one gate family, as the gate words them. */
export function landabilityRefusals(verdict: LandabilityVerdict, gate: LandabilityGate): string[] {
  return verdict.verdict === 'refused' ? verdict.reasons.filter(entry => entry.gate === gate).map(entry => entry.reason) : [];
}

/** The queue ejection the verdict gives on one ground, or null: the queue ejects on landability grounds only for this. */
export function landabilityEjection(verdict: LandabilityVerdict, ground: LandabilityGround): string | null {
  return verdict.verdict === 'refused' ? verdict.reasons.find(entry => entry.ground === ground && entry.eject)?.eject ?? null : null;
}

/** Every queue ejection the verdict gives. */
export const landabilityEjections = (verdict: LandabilityVerdict): string[] =>
  verdict.verdict === 'refused' ? verdict.reasons.flatMap(entry => entry.eject ? [entry.eject] : []) : [];

/** The audit a refusal records: the verdict version and its inputs. */
export const landabilityAudit = (verdict: LandabilityVerdict): LandabilityAudit => ({ version: verdict.version, inputs: verdict.inputs });

/**
 * How ejections were worded before the typed `family` existed. Read only for those legacy records,
 * as `speculativeConflictReason` is for conflicts, so rewording can never change a typed record.
 */
export const landabilityEjectionReason = /^(Landing speculative tip [0-9a-f]+ on [0-9a-f]+ would revert work outside its planned files|Speculative tip [0-9a-f]+ was built behind .+, which left the merge queue without landing|Proof \S+ (failed|was revoked) on speculative tip [0-9a-f]+)/;
export function landabilityFamily(ejection: Pick<QueueEjection, 'reason' | 'family'>): boolean {
  return ejection.family === undefined ? landabilityEjectionReason.test(ejection.reason) : ejection.family === 'landability';
}
