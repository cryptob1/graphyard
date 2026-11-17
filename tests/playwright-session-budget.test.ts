import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { startHeadlessWorker } from '../src/headless-session.js';
import { clearRuns, registerRun } from '../src/runner/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3436: one worker running the full Playwright suite (8+ chromium processes) pushed vishrog to load
// 88 despite the GY-3401 test budget, which only capped node's test runner. A launched session now
// carries the same budget as PLAYWRIGHT_WORKERS, and playwright.config takes it as its workers.

const repo = fileURLToPath(new URL('..', import.meta.url));
after(() => clearRuns());

function running(count: number) {
  clearRuns();
  for (let index = 0; index < count; index++) registerRun({ name: `running-${index}`, role: 'worker', work: `GY-${index}`, subject: 'running', run: {
    id: `run-${index}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: false as const, failure: { reason: 'no-payload' as const, detail: 'fixture' }, payloads: [] }),
  } as never });
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env: Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return new Promise<{ code: number | null; output: string }>(done => child.on('close', code => done({ code, output })));
}

/** Launch one worker session on a 24-core host with 12 sessions running; `exec` runs as its runtime with the session's environment. */
async function launchWorker(exec: (env: Record<string, string>) => Promise<string>) {
  const base = await temporaryDirectory('playwright-session-budget');
  await mkdir(join(base, 'bin'));
  await writeFile(join(base, 'bin', 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const root = await temporaryDirectory('playwright-session-budget-root', base);
  running(12);
  let seen: Record<string, string> = {};
  const launched = await startHeadlessWorker({ name: 'eng-pi', work: 'GY-3436', subject: 'GY-3436: budget', epoch: 1, principal: 'worker-a', account: null, kind: 'pi', args: [],
    environment: { PATH: `${join(base, 'bin')}:/usr/bin:/bin`, MISE_NO_CONFIG: '1' }, directory: repo, supervisor: [], prompt: 'Implement it.', root, cores: 24, timeoutMs: 120_000, startupMs: 110_000,
    exec: async (_command, _args, options) => { seen = options.env; return exec(options.env); } });
  clearRuns();
  return { seen, launched };
}

test('integration:playwright-session-budget — a launched worker session carries PLAYWRIGHT_WORKERS=2 with 24 cores and 12 sessions; playwright.config takes it, and a trial keeps its configured workers', async () => {
  const { seen } = await launchWorker(async () => 'ok');
  assert.equal(seen.PLAYWRIGHT_WORKERS, '2', 'floor(24 / 12) = 2');
  assert.equal(seen.PLAYWRIGHT_WORKERS, seen.VITEST_MAX_WORKERS, 'the same GY-3401 budget');

  const workers = async (env: NodeJS.ProcessEnv) => {
    const { code, output } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const config = (await import(${JSON.stringify(join(repo, 'playwright.config.ts'))})).default; console.log(JSON.stringify(config.workers ?? null));`], repo, env);
    assert.equal(code, 0, output);
    return JSON.parse(output.trim().split('\n').at(-1)!);
  };
  const { PLAYWRIGHT_WORKERS: _unset, ...trial } = process.env;
  assert.equal(await workers({ ...trial, PLAYWRIGHT_WORKERS: seen.PLAYWRIGHT_WORKERS }), 2, 'playwright.config resolves workers from the session budget');
  assert.equal(await workers(trial), null, 'a trial, with no session budget, keeps Playwright\'s configured workers');
});

test('e2e:session-playwright-budget — a worker session running npx playwright test starts no more browser workers than its budget', async () => {
  // A fixture suite under the repository's own playwright.config, without its web server: each test notes
  // when its worker starts and ends, so the most at once is the number of browser workers running.
  const suite = await temporaryDirectory('playwright-session-budget-suite'), log = join(suite, 'log');
  await writeFile(join(suite, 'playwright.config.ts'), `import base from ${JSON.stringify(join(repo, 'playwright.config.ts'))};\nexport default { ...base, testDir: ${JSON.stringify(suite)}, webServer: undefined, outputDir: ${JSON.stringify(join(suite, 'out'))} };\n`);
  await writeFile(join(suite, 'fan.spec.ts'), `import { test } from ${JSON.stringify(join(repo, 'node_modules', '@playwright', 'test', 'index.js'))};\nimport { appendFileSync } from 'node:fs';\nfor (let index = 0; index < 8; index++) test('test ' + index, async () => {\n  appendFileSync(${JSON.stringify(log)}, 'start\\n');\n  await new Promise(done => setTimeout(done, 1500));\n  appendFileSync(${JSON.stringify(log)}, 'end\\n');\n});\n`);
  let result = { code: null as number | null, output: '' };
  const { seen } = await launchWorker(async env => {
    result = await run('npx', ['playwright', 'test', '--config', join(suite, 'playwright.config.ts'), '--reporter', 'line'], repo, env);
    return result.output;
  });
  assert.equal(result.code, 0, result.output);
  let now = 0, most = 0;
  for (const line of (await readFile(log, 'utf8')).trim().split('\n')) { now += line === 'start' ? 1 : -1; most = Math.max(most, now); }
  assert.equal(seen.PLAYWRIGHT_WORKERS, '2', 'the session\'s budget');
  assert.ok(most <= 2, `${most} Playwright workers ran at once; the budget is 2`);
});
