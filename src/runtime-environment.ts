import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const canonical = (path: string) => { const absolute = resolve(path); try { return realpathSync(absolute); } catch { return absolute; } };
/**
 * The directories every host treats as temporary, by name. A unit whose WorkingDirectory is under
 * one outlives the directory: on 2026-09-22 a unit written with a reviewer's `/var/tmp` checkout as
 * its WorkingDirectory crash-looped 233 times in 40 minutes after that checkout was deleted.
 */
export const temporaryDirectories = () => [...new Set([tmpdir(), '/tmp', '/var/tmp'].map(canonical))];
/**
 * Whether this process is the test suite. Node's test runner marks every process it runs a test
 * file in (`NODE_TEST_CONTEXT` in the children `--test` spawns, `--test` itself on the runner), and
 * `npm test` marks everything it starts with its lifecycle event. The marks are read from the real
 * process only: a `LoopSupervisorHost.env` says where a unit goes, never whether this is a test, so
 * no argument a test passes — or forgets — can switch the guard below off.
 */
export const underTestRunner = () => !!process.env.NODE_TEST_CONTEXT || process.execArgv.includes('--test') || process.env.npm_lifecycle_event === 'test';
