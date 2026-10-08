// Concern: the shadow merge gate's pure parts — which head is tried next, how a shadow verdict compares with GitHub's, and the report.
import type { Work } from '../model.js';
import { ownHeads } from '../merge-queue.js';

export const shadowOutcomes = ['agree-pass', 'agree-fail', 'shadow-only-fail', 'shadow-missed', 'pending'] as const;
export type ShadowOutcome = typeof shadowOutcomes[number];
/** What the shadow gate recorded for one head against one main tip. */
export interface ShadowVerdict {
  key: string; id: string; head: string; baseTip: string; mergeSha: string | null; risk: 'sensitive' | 'normal';
  build: 'pass' | 'fail'; tests: { passed: number; failed: string[]; files: number }; conflict: string[];
  durationMs: number; at: string; outcome: ShadowOutcome;
}
/** What GitHub's gate did with the head: nothing yet, merged and kept, merged then reverted by the main guard, or failed its required checks. */
export type GithubOutcome = 'pending' | 'merged' | 'reverted' | 'failed';

/** Whether the trial passed: it merged cleanly, built, and every affected test passed. */
export const shadowPassed = (verdict: Pick<ShadowVerdict, 'build' | 'tests' | 'conflict'>) => !verdict.conflict.length && verdict.build === 'pass' && !verdict.tests.failed.length;

/** When the item's current head was handed in: the pipeline timeline's resubmission, else its submission, else the stage entry. */
export function submittedAtOf(item: Pick<Work, 'stageEnteredAt'>): number {
  const pipeline = (item as { pipeline?: { submittedAt?: string | null; resubmittedAt?: string | null } }).pipeline;
  for (const at of [pipeline?.resubmittedAt, pipeline?.submittedAt, item.stageEnteredAt]) if (at && Number.isFinite(Date.parse(at))) return Date.parse(at);
  return 0;
}
/** A head GitHub has already merged (or whose item is done) has no turn left: GitHub's gate decided it first. */
const landed = (item: Pick<Work, 'stage' | 'observation'>) => item.stage === 'done' || !!item.observation?.merged;

/**
 * The heads still owed a trial: submitted (a pull request and a candidate), not yet merged by
 * GitHub, with no verdict for this head against this main tip. Oldest submission first, and only
 * one per cycle.
 */
export function shadowDue(work: readonly Work[], verdicts: readonly Pick<ShadowVerdict, 'head' | 'baseTip'>[], mainTip: string): Work | null {
  const tried = new Set(verdicts.map(verdict => `${verdict.head}:${verdict.baseTip}`));
  const owed = work.filter(item => !landed(item) && item.submission && item.candidate && !tried.has(`${item.candidate.sha.toLowerCase()}:${mainTip.toLowerCase()}`));
  return owed.sort((a, b) => submittedAtOf(a) - submittedAtOf(b) || a.key.localeCompare(b.key))[0] ?? null;
}

/** GitHub's side of the comparison for a verdict's head, from the item as the snapshot holds it. Only a delivery of this very head counts: an earlier, reworked head that a later one superseded was never merged. */
export function githubOutcome(item: Pick<Work, 'stage' | 'candidate' | 'baseRefresh' | 'delivery' | 'mainGuardReverts' | 'observation' | 'policy'> | undefined, head: string): GithubOutcome {
  if (!item) return 'pending';
  const own = ownHeads(item).includes(head.toLowerCase());
  if (item.stage === 'done' && item.delivery) return !own ? 'pending' : item.mainGuardReverts?.length ? 'reverted' : 'merged';
  if (item.candidate?.sha.toLowerCase() !== head.toLowerCase()) return 'pending';
  const observed = item.observation;
  if (observed?.candidate.sha.toLowerCase() !== head.toLowerCase()) return 'pending';
  return observed.checks.some(check => item.policy.checks.includes(check.name) && ['failure', 'timed_out', 'cancelled', 'action_required', 'fail', 'failed'].includes(check.result)) ? 'failed' : 'pending';
}

/**
 * Shadow against GitHub. A pass GitHub merged is `agree-pass`; a pass the main guard reverted is
 * `shadow-missed`; a fail GitHub also failed (checks, or a revert) is `agree-fail`; a fail GitHub
 * merged and kept is `shadow-only-fail`. A pass whose checks failed on GitHub has no merge outcome
 * to judge (the head is reworked and gets a new verdict), so it stays `pending` with the rest.
 */
export function compareVerdicts(shadow: Pick<ShadowVerdict, 'build' | 'tests' | 'conflict'>, github: GithubOutcome): ShadowOutcome {
  if (github === 'pending') return 'pending';
  if (shadowPassed(shadow)) return github === 'merged' ? 'agree-pass' : github === 'reverted' ? 'shadow-missed' : 'pending';
  return github === 'merged' ? 'shadow-only-fail' : 'agree-fail';
}

const percentile = (sorted: readonly number[], fraction: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]! : null;
export interface ShadowReport {
  total: number; counts: Record<ShadowOutcome, number>; p50Ms: number | null; p90Ms: number | null;
  disagreements: { outcome: ShadowOutcome; key: string; head: string; mergeSha: string | null }[];
}
/** Outcomes re-judged against the items still in `work`; a verdict whose item is not there keeps its recorded outcome. */
export const judgedVerdicts = (verdicts: readonly ShadowVerdict[], work: readonly Work[]): ShadowVerdict[] =>
  verdicts.map(verdict => { const item = work.find(candidate => candidate.id === verdict.id || candidate.key === verdict.key); return item ? { ...verdict, outcome: compareVerdicts(verdict, githubOutcome(item, verdict.head)) } : verdict; });

/** Counts per outcome, p50 and p90 trial duration, and the newest ten disagreements with item key, head and merge sha. */
export function shadowReport(verdicts: readonly ShadowVerdict[], work: readonly Work[]): ShadowReport {
  const judged = judgedVerdicts(verdicts, work), counts = Object.fromEntries(shadowOutcomes.map(outcome => [outcome, 0])) as Record<ShadowOutcome, number>;
  for (const verdict of judged) counts[verdict.outcome] += 1;
  const durations = judged.map(verdict => verdict.durationMs).sort((a, b) => a - b);
  const disagreements = judged.filter(verdict => verdict.outcome === 'shadow-only-fail' || verdict.outcome === 'shadow-missed')
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 10).map(verdict => ({ outcome: verdict.outcome, key: verdict.key, head: verdict.head, mergeSha: verdict.mergeSha }));
  return { total: judged.length, counts, p50Ms: percentile(durations, 0.5), p90Ms: percentile(durations, 0.9), disagreements };
}
