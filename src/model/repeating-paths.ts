// The paths whose changes repeat on every loop cycle, and the soak coverage the review contract
// requires for them (GY-404). One authority for both readers: the reviewer asks for the coverage
// (src/reviewer.ts repetitionReviewSection), and the scope rule grants the files that coverage
// lives in (GY-1892), so a worker answering that finding never waits on an approver for it.

/**
 * The paths whose changes run on every loop cycle, head and item (GY-404): the loop, the master
 * and the merge writer. A fault there passes the change's own
 * gates and appears only when the behaviour repeats, so the review asks what repetition does.
 */
export const repeatingPaths = ['src/daemon/', 'src/master/', 'src/merge-writer/'] as const;
export const touchesRepeatingPath = (files: readonly string[]) => files.some(file => repeatingPaths.some(path => path.endsWith('/') ? file.startsWith(path) : file === path));

/** A soak suite (`tests/soak-*.test.ts`) or the simulation helper one runs on (`tests/helpers/soak-*.ts`). */
export const soakSuiteFile = (path: string) => /^tests\/soak-[\w.-]+\.test\.ts$/.test(path) || /^tests\/helpers\/soak-[\w.-]+\.ts$/.test(path);

/**
 * GY-1892: the soak suite a change to a repeating path must carry. The review contract makes its
 * absence a BLOCKING finding, so the file is the change's own scope, as the timing baseline is a
 * test's: GY-1773 asked for tests/soak-day.test.ts with its helper tests/helpers/soak-simulation.ts,
 * and GY-1888 for tests/soak-decision-faults.test.ts, and each waited on a person or the approver
 * because the rule did not ground what the reviewer demanded.
 */
export function soakSuiteGround(path: string, plannedFiles: readonly string[]): string | null {
  if (!soakSuiteFile(path)) return null;
  const repeating = plannedFiles.find(file => touchesRepeatingPath([file]));
  return repeating ? `${path} is the soak coverage the review contract requires of a change to ${repeating}, which repeats on every loop cycle` : null;
}
