import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { startHeadlessSession } from '../src/headless-session.js';
import { clearRuns, registerRun } from '../src/runner/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3401: vishrog reached load 91 on 24 cores because every running session fanned its tests out
// one file per core. Each session is now launched with its share of the host's test parallelism,
// floor(cores / running sessions) and never below two, as VITEST_MAX_WORKERS; `npm test` takes it
// as its --test-concurrency. Driven through the real headless launch and the real test runner.

const proof = 'integration:session-test-budget';
after(() => clearRuns());

/** `count` sessions running in this process, as the loop's run registry lists them. */
function running(count: number) {
  clearRuns();
  for (let index = 0; index < count; index++) registerRun({ name: `running-${index}`, role: 'worker', work: `GY-${index}`, subject: 'running', run: {
    id: `run-${index}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: false as const, failure: { reason: 'no-payload' as const, detail: 'fixture' }, payloads: [] }),
  } as never });
}

/** Launch one headless session on a 24-core host and return the environment its runtime starts with. */
async function launchedEnvironment(base: string) {
  const root = await temporaryDirectory('session-test-budget-root', base), directory = await temporaryDirectory('session-test-budget-session', base);
  let seen: Record<string, string> = {};
  const session = await startHeadlessSession({
    name: `budget-${Math.random()}`, work: 'GY-3401', subject: 'review', kind: 'pi', args: [], environment: { PATH: `${join(base, 'bin')}:/usr/bin:/bin`, MISE_NO_CONFIG: '1' },
    directory, root, route: 'review', context: {}, prompt: 'Review.', cores: 24,
    exec: async (_command, _args, options) => { seen = options.env; return '{"ok":true}'; },
    answer: async output => output,
  });
  await session.settled;
  return seen;
}

/** The most test files that ran at once under `npm test` with `environment`. */
async function filesAtOnce(environment: NodeJS.ProcessEnv) {
  const root = await temporaryDirectory('session-test-budget-suite'), log = join(root, 'log');
  const names = ['a', 'b', 'c', 'd', 'e'].map(name => `${name}.test.mjs`);
  for (const name of names) await writeFile(join(root, name), `
    import { test } from 'node:test';
    import { appendFileSync } from 'node:fs';
    test('${name}', async () => {
      appendFileSync(${JSON.stringify(log)}, 'start\\n');
      await new Promise(done => setTimeout(done, 1500));
      appendFileSync(${JSON.stringify(log)}, 'end\\n');
    });
  `);
  const runner = fileURLToPath(new URL('./helpers/run-tests.ts', import.meta.url));
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), runner, ...names], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise<number | null>(done => child.on('close', done));
  assert.equal(code, 0, output);
  let now = 0, most = 0;
  for (const line of (await readFile(log, 'utf8')).trim().split('\n')) { now += line === 'start' ? 1 : -1; most = Math.max(most, now); }
  return most;
}

test(`${proof} — with 24 cores and 9 running sessions a launched session gets VITEST_MAX_WORKERS=2 and npm test runs 2 files at once; with 4 it gets 6; never below 2`, async () => {
  // The headless launch resolves its runtime on PATH: a stand-in `pi` that is never run.
  const base = await temporaryDirectory('session-test-budget');
  await mkdir(join(base, 'bin'));
  await writeFile(join(base, 'bin', 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  running(9);
  const nine = await launchedEnvironment(base);
  assert.equal(nine.VITEST_MAX_WORKERS, '2', 'floor(24 / 9) = 2');
  running(4);
  assert.equal((await launchedEnvironment(base)).VITEST_MAX_WORKERS, '6', 'floor(24 / 4) = 6');
  running(30);
  assert.equal((await launchedEnvironment(base)).VITEST_MAX_WORKERS, '2', 'never below 2');
  clearRuns();

  // The session's own `npm test` keeps to its budget: five one-and-a-half-second files, two at a time.
  assert.equal(await filesAtOnce({ ...process.env, VITEST_MAX_WORKERS: nine.VITEST_MAX_WORKERS }), 2, 'npm test runs with --test-concurrency 2');
});
