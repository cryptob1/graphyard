// Concern: the fast mechanical gates a worker request names to run before complete (GY-1797).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
/**
 * The fast mechanical gates (GY-1797): the module budget test, the docs glossary gate, the wall-clock
 * bomb scan and the CI shard map, plus the docs page checker. Each
 * runs locally in seconds, and each is a check CI fails a whole rework round on when a worker
 * ships past it, so the worker request names them where its before-push discipline is stated:
 * after the sync instruction, before the complete instruction. One exported constant, so the
 * request (dispatch.ts workerPrompt), its tests (tests/worker-prompt-gates.test.ts) and the
 * documentation (docs/coordination.md) read the same
 * list; every entry is a test file or script this repository carries, and all of them run as one
 * command line, chained with `&&`, so the request names one. This module holds the list beside the
 * prompt rather than in dispatch.ts, which sits within a few lines of its own 800-line budget: the
 * first attempt at this item merged at 801 and was reverted by the very gate it names.
 */
export const workerFastGates = {
  tests: ['tests/docs-glossary.test.ts', 'tests/no-wall-clock-time-bombs.test.ts', 'tests/ci-shards.test.ts'],
  scripts: ['scripts/check-docs.mjs'],
} as const;
/**
 * Whether the checkout the launcher runs from carries every gate: only then does a request name
 * them. The launcher reads this once per launch and hands the answer to the prompt as an input, so
 * the prompt stays a pure function of its inputs, and a managed repository whose tree carries no
 * such file (any repository but this one) renders its request exactly as before the gates existed.
 */
export const workerFastGatesPresent = (root: string) => [...workerFastGates.tests, ...workerFastGates.scripts].every(gate => existsSync(join(root, gate)));
/** The one command line the gates run as: the test files through the suite's own harness (run-tests.ts reserves the port window a bare run lacks), then the docs checker, chained with `&&`. */
export const workerFastGatesCommand = `node --import tsx tests/helpers/run-tests.ts ${workerFastGates.tests.join(' ')} && ${workerFastGates.scripts.map(script => `node ${script}`).join(' && ')}`;
/** The sync instruction the gates sentence follows: the before-submit discipline the repository's standing instructions state, in the request itself, with the CLI and the item it is for. */
export const workerSyncSentence = (cliPath: string, key: string) => `Run node ${cliPath} sync ${key} before submitting: it merges the shared base branch the merge writer advances. `;
/** The one sentence the request adds after the sync instruction: the gates, their one command line, and what to do when one fails. */
export const workerFastGatesSentence = `Before complete, run the fast gates — \`${workerFastGatesCommand}\` — and fix what they name first, since the merge writer's trial fails on each of them. `;
/** The whole addition, in order: the sync instruction, then the gates; the complete instruction follows it in the request. */
export const workerBeforePushSection = (cliPath: string, key: string) => workerSyncSentence(cliPath, key) + workerFastGatesSentence;
