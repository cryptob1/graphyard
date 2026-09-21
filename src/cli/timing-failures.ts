import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { latestCheck } from '../merge-queue.js';
import { agentOwner, type AttentionItem, type buildMasterStatus } from '../master.js';
import type { Work } from '../model.js';

// A required check that failed on the clock, named as one in `master status`. The CI `test` job
// annotates its own check run with every timing-dependent assertion that went over its budget
// (tests/helpers/timing-report.ts); this module reads those annotations back and replaces the
// unqualified `Required CI check test has not passed` with the measurement against its budget.
// It reports and never decides: the check stays failed and the test gate stays refused.

type MasterStatus = ReturnType<typeof buildMasterStatus>;

/**
 * A timing-dependent assertion that went over its budget, as the CI run reported it on the failed
 * check run: what was measured, against which budget, and how many tests failed beside the
 * timing-dependent ones (null when the run could not tell).
 */
const timingFailureSchema = z.object({
  name: z.string().min(1).max(200), test: z.string().min(1).max(500), statistic: z.string().min(1).max(40),
  measuredMs: z.number().finite().nonnegative(), budgetMs: z.number().finite().nonnegative(), comparison: z.enum(['<', '<=']),
  samples: z.number().int().positive(), warmupDiscarded: z.number().int().nonnegative(), otherFailures: z.number().int().nonnegative().nullable(),
});
export type TimingFailure = z.infer<typeof timingFailureSchema>;
/** What precedes the machine-readable record in an annotation's message. */
export const timingAnnotationMarker = 'graphyard-timing:';

/** The timing failures among a check run's annotations; anything else, or malformed, is ignored. */
export function parseTimingAnnotations(annotations: { message?: string | null }[]): TimingFailure[] {
  return annotations.flatMap(annotation => {
    const at = annotation.message?.indexOf(timingAnnotationMarker) ?? -1;
    if (at < 0) return [];
    try { const parsed = timingFailureSchema.safeParse(JSON.parse(annotation.message!.slice(at + timingAnnotationMarker.length))); return parsed.success ? [parsed.data] : []; }
    catch { return []; }
  });
}

/**
 * Why a required check is red when what failed in it was the clock: each timing-dependent
 * assertion with its measured value against its budget, and whether anything else failed beside
 * them. It replaces the unqualified `Required CI check test has not passed` in master status; the
 * gate itself is untouched, and the check stays failed until a run passes.
 */
export function timingFailureReason(check: string, failures: TimingFailure[]) {
  const measured = failures.map(failure => `${failure.name} (${failure.test.split(' — ')[0]}) measured ${failure.statistic} ${Math.round(failure.measuredMs)}ms against its budget of ${failure.comparison} ${failure.budgetMs}ms over ${failure.samples} sample${failure.samples === 1 ? '' : 's'}${failure.warmupDiscarded ? ` after ${failure.warmupDiscarded} discarded warmup reads` : ''}`);
  const others = failures[0].otherFailures;
  return `Required CI check ${check} failed on ${failures.length === 1 ? 'a timing-dependent assertion' : `${failures.length} timing-dependent assertions`}${others === 0 ? ', not on behaviour' : ''}: ${measured.join('; ')}; ${others === 0 ? 'every other test in the run passed'
    : others === null ? 'the run did not report whether other tests failed' : `${others} other test${others === 1 ? '' : 's'} failed in the same run, so it is not only a timing failure`}`;
}

export type CheckAnnotations = (checkRunId: number) => Promise<{ message?: string | null }[]>;
/** Annotations of one check run, read with the master's own `gh`; an unreadable run qualifies nothing. */
export const ghCheckAnnotations = (repository: string, run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })): CheckAnnotations =>
  async checkRunId => JSON.parse(run('gh', ['api', '--paginate', `repos/${repository}/check-runs/${checkRunId}/annotations`]));

/**
 * Name every open candidate whose required check failed on a timing-dependent assertion. The
 * row's refusal and attention carry the measured value against the budget, and the attention
 * list gains an item for the master with the rerun, so the item is never silently held behind
 * `Required CI check test has not passed`. Only a failed required check of the current candidate
 * is looked up, and a lookup that fails leaves the row exactly as it was.
 */
export async function qualifyTimingFailures(status: MasterStatus, work: Work[], repository: string, annotations: CheckAnnotations): Promise<MasterStatus> {
  const qualified = new Map<string, AttentionItem>();
  for (const item of work) {
    const observation = item.observation;
    if (item.stage === 'done' || !observation || !item.candidate || observation.candidate.sha !== item.candidate.sha) continue;
    for (const name of item.policy.checks) {
      const check = latestCheck(observation.checks.filter(entry => entry.name === name));
      if (!check?.id || check.result !== 'failure' || qualified.has(item.key)) continue;
      const failures = parseTimingAnnotations(await annotations(check.id).catch(() => []));
      if (!failures.length) continue;
      const regression = failures[0].otherFailures !== 0;
      qualified.set(item.key, { subject: item.key, text: timingFailureReason(name, failures),
        ...agentOwner('master', regression ? `Read the failed ${name} run of ${item.key}: the failures beside the timing-dependent ones are the worker's to fix`
          : `gh api --method POST repos/${repository}/actions/jobs/${check.id}/rerun reruns the ${name} job once; a second measurement over budget is a latency regression, returned with graphyard master decide ${item.key} rework REASON`) });
    }
  }
  if (!qualified.size) return status;
  const unqualified = (key: string, text: string | null | undefined) => !!text && /^Required CI check .* has not passed on the current candidate$/.test(text) && qualified.has(key);
  let raised = 0;
  const rows = status.work.map(row => {
    const item = qualified.get(row.key);
    if (!item) return row;
    const { subject, text, ...owner } = item;
    const refusal = row.refusal && unqualified(row.key, row.refusal.reason) ? { ...row.refusal, reason: text } : row.refusal;
    // Another attention line (a blocked session, a containment hold) keeps its place in the row;
    // the timing failure is still listed below, so neither hides the other.
    if (row.attention && !unqualified(row.key, row.attention)) return { ...row, refusal };
    if (!row.attention) raised++;
    return { ...row, refusal, attention: text, attentionOwner: owner };
  });
  const attentionItems = [...status.attentionItems.filter(entry => !unqualified(entry.subject, entry.text)), ...qualified.values()];
  return { ...status, work: rows, attentionItems, counts: { ...status.counts, attention: status.counts.attention + raised } };
}
