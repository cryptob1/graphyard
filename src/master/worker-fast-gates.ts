// Concern: the fast mechanical gates a worker request names to run before complete (GY-1797).
/**
 * The fast mechanical gates (GY-1797): the module and docs budget tests, the docs growth and
 * glossary gates, the wall-clock bomb scan and the CI shard map, plus the docs page checker. Each
 * runs locally in seconds, and each is a check CI fails a whole rework round on when a worker
 * ships past it, so the worker request names them where the sync rule left the before-push
 * discipline: after it, before the complete instruction. One exported constant, so the request
 * (dispatch.ts workerPrompt), its test (tests/worker-prompt-gates.test.ts) and the documentation
 * (docs/coordination.md) read the same list; every entry is a test file or script this repository
 * carries, and all of them run as one command line, chained with `&&`, so the request names one.
 * This module holds the list beside the prompt rather than in dispatch.ts, which sits within a few
 * lines of its own 800-line budget: the first attempt at this item merged at 801 and was reverted
 * by the very gate it names.
 */
export const workerFastGates = {
  tests: ['tests/module-budgets.test.ts', 'tests/docs-budget.test.ts', 'tests/docs-growth-gate.test.ts', 'tests/docs-glossary.test.ts', 'tests/no-wall-clock-time-bombs.test.ts', 'tests/ci-shards.test.ts'],
  scripts: ['scripts/check-docs.mjs'],
} as const;
/** The list lives in this repository's tree only: no other managed repository carries these files. */
export const workerFastGatesRepository = 'graphyard';
/** Only this repository's own requests name the gates; any other repository's request renders exactly as before they existed. */
export const fastGatesApply = (repository?: string) => repository?.split('/').at(-1)?.toLowerCase() === workerFastGatesRepository;
/** The one command line the gates run as: the test files through the suite's own harness (run-tests.ts reserves the port window a bare run lacks), then the docs checker, chained with `&&`. */
export const workerFastGatesCommand = `node --import tsx tests/helpers/run-tests.ts ${workerFastGates.tests.join(' ')} && ${workerFastGates.scripts.map(script => `node ${script}`).join(' && ')}`;
/** The one sentence the request adds: the gates, their one command line, and what to do when one fails. */
export const workerFastGatesSentence = `Before complete, run the fast gates — \`${workerFastGatesCommand}\` — and fix what they name before pushing, since CI fails on each of them. `;
