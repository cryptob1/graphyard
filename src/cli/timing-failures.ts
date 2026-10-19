import { z } from 'zod';

// A timing-dependent assertion that went over its budget, as a test run reports it. The CI `test`
// job annotates its own run with each one (tests/helpers/timing-report.ts) for whoever reads that
// run. Graphyard reads nothing back (GY-2010): check-run annotations were a GitHub API read, and the
// merge writer's own trial is the only test gate.

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
