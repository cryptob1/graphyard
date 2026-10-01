// Concern: the landability verdict as GitHub sees it — the one `graphyard/landable` check run on a candidate head.
import { LANDABLE_CHECK, type Work } from './model.js';
import { evaluateLandability, type LandabilityVerdict } from './model/landability.js';

/**
 * GY-887. The landability verdict (GY-878, model/landability.ts) reaches GitHub as one required
 * check, published by the control-plane App on every candidate head. GitHub's required checks are
 * repository-wide, so Graphyard's policy travels as this single verdict rather than as per-lane check
 * sets: branch protection requires it beside CI (install/github.ts), and GitHub enforces what
 * Graphyard decided with no second copy of the decision.
 */
export { LANDABLE_CHECK };

/** GitHub's bound on a check run's output summary. */
const summaryLimit = 65_535;

export interface LandableCheckRun {
  name: typeof LANDABLE_CHECK; head_sha: string; status: 'completed'; conclusion: 'success' | 'failure'; external_id: string;
  output: { title: string; summary: string };
}

/**
 * The check run the verdict gives the item's current candidate head, or null when it has none:
 * success when the verdict is landable, failure with every refusal reason as its summary otherwise.
 * Pure: it is recomputed from the verdict's live inputs on every observation, so a new head, check
 * result, review, proof or policy revision republishes it, and nothing is stored to go stale.
 */
export function landableCheckRun(work: Work, all: Work[], now: Date, verdict: LandabilityVerdict = evaluateLandability(work, all, now)): LandableCheckRun | null {
  if (!work.candidate) return null;
  const { sha, baseSha } = work.candidate;
  const identity = `Candidate ${sha}; base ${baseSha}; policy ${work.policyRevision}; verdict v${verdict.version}`;
  if (verdict.verdict === 'landable') {
    return { name: LANDABLE_CHECK, head_sha: sha, status: 'completed', conclusion: 'success', external_id: work.id, output: { title: 'Landable', summary: identity } };
  }
  const reasons = verdict.reasons.map(entry => `- ${entry.gate}: ${entry.reason}`);
  return { name: LANDABLE_CHECK, head_sha: sha, status: 'completed', conclusion: 'failure', external_id: work.id,
    output: { title: `Refused: ${reasons.length} reason${reasons.length === 1 ? '' : 's'}`, summary: refusalSummary(reasons, identity) } };
}

/**
 * Every refusal reason, then the candidate's identity, within GitHub's summary bound. A list too long
 * for it keeps whole reasons only and says how many it left out, so no reason is silently dropped;
 * the title still counts them all.
 */
function refusalSummary(reasons: string[], identity: string) {
  const whole = `${reasons.join('\n')}\n\n${identity}`;
  if (whole.length <= summaryLimit) return whole;
  const omitted = (count: number) => `- … ${count} more reason${count === 1 ? '' : 's'} omitted: GitHub bounds a check summary at ${summaryLimit} characters`;
  const kept: string[] = [];
  let length = identity.length + 2 + omitted(reasons.length).length + 1;
  for (const reason of reasons) {
    if (length + reason.length + 1 > summaryLimit) break;
    kept.push(reason); length += reason.length + 1;
  }
  return `${[...kept, omitted(reasons.length - kept.length)].join('\n')}\n\n${identity}`.slice(0, summaryLimit);
}

/** Whether a published check run already says exactly what `body` would: an unchanged verdict is not written again. */
export function landableCheckCurrent(existing: any, body: LandableCheckRun) {
  return existing?.status === body.status && existing.conclusion === body.conclusion && existing.external_id === body.external_id
    && existing.output?.title === body.output.title && existing.output?.summary === body.output.summary;
}

/**
 * The success a head Graphyard merges outside the queue's gates carries — a merge group commit, the
 * repair lane's head, a main-guard revert — once branch protection requires `graphyard/landable`;
 * `summary` names why that head may land.
 */
export function landableCarried(work: Pick<Work, 'id'>, head: string, title: string, summary: string): LandableCheckRun {
  return { name: LANDABLE_CHECK, head_sha: head, status: 'completed', conclusion: 'success', external_id: work.id, output: { title, summary: summary.slice(0, summaryLimit) } };
}
