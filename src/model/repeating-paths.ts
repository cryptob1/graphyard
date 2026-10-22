// The paths whose changes repeat on every loop cycle, for which the review contract requires soak
// coverage (GY-404, src/reviewer.ts repetitionReviewSection).

/**
 * The paths whose changes run on every loop cycle, head and item (GY-404): the loop, the master
 * and the merge writer. A fault there passes the change's own
 * gates and appears only when the behaviour repeats, so the review asks what repetition does.
 */
export const repeatingPaths = ['src/daemon/', 'src/master/', 'src/merge-writer/'] as const;
export const touchesRepeatingPath = (files: readonly string[]) => files.some(file => repeatingPaths.some(path => path.endsWith('/') ? file.startsWith(path) : file === path));

