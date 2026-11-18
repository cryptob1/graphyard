// Concern: the fast mechanical gates a worker request names to run before complete (GY-1797).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
/**
 * The fast mechanical gates (GY-1797): the wall-clock bomb scan and the CI shard map. Each
 * runs locally in seconds, and each is a check CI fails a whole rework round on when a worker
 * ships past it, so the worker request names them where its before-push discipline is stated:
 * after the sync instruction, before the complete instruction. One exported constant, so the
 * request (dispatch.ts workerPrompt) and its tests (tests/worker-prompt-gates.test.ts) read the same
 * list; every entry is a test file this repository carries, and all of them run as one
 * command line, so the request names one. This module holds the list beside the
 * prompt rather than in dispatch.ts, which sits within a few lines of its own 800-line budget: the
 * first attempt at this item merged at 801 and was reverted by the very gate it names.
 */
export const workerFastGates = {
  tests: ['tests/no-wall-clock-time-bombs.test.ts', 'tests/ci-shards.test.ts'],
} as const;
/**
 * Whether the checkout the launcher runs from carries every gate: only then does a request name
 * them. The launcher reads this once per launch and hands the answer to the prompt as an input, so
 * the prompt stays a pure function of its inputs, and a managed repository whose tree carries no
 * such file (any repository but this one) renders its request exactly as before the gates existed.
 */
export const workerFastGatesPresent = (root: string) => workerFastGates.tests.every(gate => existsSync(join(root, gate)));
/** The one command line the gates run as: the test files through the suite's own harness (run-tests.ts reserves the port window a bare run lacks). */
export const workerFastGatesCommand = `node --import tsx tests/helpers/run-tests.ts ${workerFastGates.tests.join(' ')}`;
/** The one sentence item 2 of the pre-submit list adds (GY-3489): the gates and their one command line. */
export const workerFastGatesSentence = `Then the fast gates: \`${workerFastGatesCommand}\`. `;
