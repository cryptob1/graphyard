import type { Work } from './work.js';
import type { ProductionRecord, ReleaseCandidate, UatRecord } from '../release-candidate.js';
import { releaseCandidateProof } from './policy.js';
import { isClosed } from './closure.js';

/**
 * GY-1101: the release train. The merge gate is build, typecheck, the pre-merge unit set and one
 * independent review; an item's `integration:` and `e2e:` proofs never hold its merge
 * (`releaseCandidateProof`, model/policy.ts). They are collected once against the first release
 * candidate (src/release-candidate.ts, GY-1094) that contains the item's merge commit.
 *
 * A merged item is therefore `merged-pending-release`: its stage is `done`, so it is immutable and
 * is never reworked or reverted for a candidate's failure, and its delivery snapshot is the merge.
 * It is Done — released — only when a candidate containing it passes UAT and is promoted to
 * production. A failed candidate leaves it pending, files one fix-forward item (`followUpItem`),
 * and the next candidate, measured from the last promoted one, carries it again.
 *
 * Pure: the control plane applies a candidate report the release CLI sends after each ledger
 * step (`release validate`, `release promote`, `release settle`), and readers derive the state.
 * Items merged before the train existed carry no record and read as released (grandfathered).
 */

export type ReleaseState = 'merged-pending-release' | 'released';
export type CandidateUat = 'pending' | 'passed' | 'failed';
export interface TrainCandidate { id: string; sha: string; uat: CandidateUat; failing: string[]; followUp: string | null; promotedAt: string | null }
export interface ReleaseTrain {
  state: 'pending' | 'released';
  mergeSha: string; mergedAt: string;
  /** The release-candidate proofs the item's criteria name: requested of its first containing candidate. */
  proofs: string[];
  /** The first candidate that contains the merge commit: where `proofs` are requested and run. */
  first: { id: string; sha: string } | null;
  /** The newest candidate reported containing the item, with its UAT verdict. */
  candidate: TrainCandidate | null;
  /** Each proof's outcome on the candidate that ran it, as that candidate's UAT record reports it. */
  outcomes: { proof: string; candidate: string; passed: boolean }[];
  releasedAt: string | null;
}
declare module './work.js' {
  interface Work {
    /** GY-1101: the release-train record of a merged item; see model/release-train.ts. */
    releaseTrain?: ReleaseTrain | null;
  }
}

/** One ledger step for one candidate, as the release CLI reports it to every item the candidate contains. */
export interface CandidateReport {
  candidate: Pick<ReleaseCandidate, 'id' | 'sha' | 'items'>;
  uat: Pick<UatRecord, 'result' | 'suites' | 'followUp'> | null;
  production: Pick<ProductionRecord, 'at'> | null;
}

/** The suite name a release-candidate proof runs under in a candidate's UAT record. */
export const proofSuite = (proof: string) => `proof ${proof}`;
const suiteProof = (name: string) => name.startsWith('proof ') ? name.slice(6) : null;

/** The release-candidate proofs an item owes after merge: every `integration:`/`e2e:` proof its criteria name. */
export const trainProofs = (work: Pick<Work, 'criteria'>) =>
  [...new Set(work.criteria.filter(criterion => !criterion.bootstrap).flatMap(criterion => criterion.proofs).filter(releaseCandidateProof))];

/** The record an observed merge starts: pending release, with the proofs its first candidate runs. */
export function pendingRelease(work: Pick<Work, 'criteria'>, delivery: { mergeSha: string; mergedAt: string }): ReleaseTrain {
  return { state: 'pending', mergeSha: delivery.mergeSha, mergedAt: delivery.mergedAt, proofs: trainProofs(work), first: null, candidate: null, outcomes: [], releasedAt: null };
}

/** Where a delivered item is on the train; null for open or closed work. Delivered work with no record predates the train and reads released. */
export function releaseState(work: Pick<Work, 'stage' | 'delivery' | 'releaseTrain' | 'closure'>): ReleaseState | null {
  if (work.stage !== 'done' || !work.delivery || isClosed(work as Work)) return null;
  return work.releaseTrain?.state === 'pending' ? 'merged-pending-release' : 'released';
}
export const pendingReleaseOf = (work: Pick<Work, 'stage' | 'delivery' | 'releaseTrain' | 'closure'>) => releaseState(work) === 'merged-pending-release';

/** Whether a candidate contains an item: its merge commit, or its key, among the deliveries the cut recorded. */
export function candidateContains(candidate: Pick<ReleaseCandidate, 'items'>, work: Pick<Work, 'key'> & { delivery?: { mergeSha: string } }) {
  return candidate.items.some(item => item.key === work.key || !!work.delivery && item.mergeSha === work.delivery.mergeSha);
}

/** Why a report cannot be applied to this item, or null. */
export function candidateReportRefusal(work: Work, report: CandidateReport): string | null {
  if (work.stage !== 'done' || !work.delivery) return `${work.key} is not delivered; only a merged item rides a release candidate`;
  if (!candidateContains(report.candidate, work)) return `Candidate ${report.candidate.id} does not contain ${work.key} (merge commit ${work.delivery.mergeSha})`;
  if (report.production && report.uat?.result !== 'passed') return `Candidate ${report.candidate.id} is reported promoted without a passing UAT record`;
  return null;
}

/**
 * Apply one candidate report. Released is terminal: a report never moves a released item back, so
 * a later failed candidate cannot reopen a delivery. A failed candidate records its verdict and the
 * failing proofs and leaves the item pending; nothing about the merge changes. Only a promoted
 * candidate whose UAT passed releases the item.
 */
export function applyCandidateReport(work: Work, report: CandidateReport, now: Date): { changed: boolean; train: ReleaseTrain } {
  const train: ReleaseTrain = work.releaseTrain ? structuredClone(work.releaseTrain) : pendingRelease(work, work.delivery!);
  const before = JSON.stringify(work.releaseTrain ?? null);
  if (train.state === 'released') return { changed: false, train };
  const { candidate, uat, production } = report;
  if (!train.first || candidate.id < train.first.id) train.first = { id: candidate.id, sha: candidate.sha };
  if (!train.candidate || candidate.id >= train.candidate.id) {
    const failing = uat ? uat.suites.filter(suite => !suite.passed).map(suite => suite.name) : [];
    train.candidate = { id: candidate.id, sha: candidate.sha, uat: uat ? uat.result : 'pending', failing, followUp: uat?.followUp ?? null, promotedAt: production?.at ?? null };
  }
  for (const suite of uat?.suites ?? []) {
    const proof = suiteProof(suite.name);
    if (!proof || !train.proofs.includes(proof)) continue;
    train.outcomes = [...train.outcomes.filter(entry => !(entry.proof === proof && entry.candidate === candidate.id)), { proof, candidate: candidate.id, passed: suite.passed }];
  }
  if (production && uat?.result === 'passed') Object.assign(train, { state: 'released', releasedAt: production.at ?? now.toISOString() });
  return { changed: JSON.stringify(train) !== before, train };
}

/**
 * The release-candidate proofs a candidate runs: the union, one run per distinct proof, of the
 * proofs still owed by the pending items it contains — every proof no containing candidate has yet
 * passed, so a proof that failed (or never ran) on a failed candidate runs again on the next one.
 * Each proof names the items it answers for.
 */
export function candidateProofPlan(candidate: Pick<ReleaseCandidate, 'id' | 'items'>, work: readonly Work[]): { proof: string; suite: string; items: string[] }[] {
  const plan = new Map<string, string[]>();
  for (const item of work) {
    if (!pendingReleaseOf(item) || !candidateContains(candidate, item)) continue;
    const train = item.releaseTrain!;
    for (const proof of train.proofs) {
      if (!train.outcomes.some(entry => entry.proof === proof && entry.passed)) plan.set(proof, [...(plan.get(proof) ?? []), item.key]);
    }
  }
  return [...plan].sort(([a], [b]) => a.localeCompare(b)).map(([proof, items]) => ({ proof, suite: proofSuite(proof), items }));
}

/** One pending item as master status names it: the candidate carrying it and that candidate's UAT state. */
export function pendingReleaseRow(work: Work) {
  const train = work.releaseTrain!;
  const candidate = train.candidate;
  return { key: work.key, mergeSha: train.mergeSha, mergedAt: train.mergedAt, proofs: train.proofs,
    candidate: candidate ? { id: candidate.id, sha: candidate.sha, uat: candidate.uat, failing: candidate.failing, followUp: candidate.followUp } : null,
    next: !candidate ? 'waiting for the next release candidate cut from main'
      : candidate.uat === 'failed' ? `candidate ${candidate.id} failed UAT (${candidate.failing.join(', ') || 'no suite named'}); ${candidate.followUp ? `${candidate.followUp} fixes forward and ` : ''}the next candidate carries it`
      : candidate.uat === 'passed' ? `candidate ${candidate.id} passed UAT; Done when it is promoted`
      : `candidate ${candidate.id} is in UAT` };
}
/** Every merged item still waiting for a promoted candidate, oldest merge first. */
export const pendingReleases = (work: readonly Work[]) =>
  work.filter(pendingReleaseOf).sort((a, b) => a.releaseTrain!.mergedAt.localeCompare(b.releaseTrain!.mergedAt)).map(pendingReleaseRow);
