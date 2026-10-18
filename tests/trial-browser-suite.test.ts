import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun } from '../src/child-runner.js';
import { browserSuite, runTrial, trialMerge } from '../src/merge-writer/trial.js';
import { trialFailureReason } from '../src/merge-writer/executor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2092: GitHub CI no longer runs the Playwright suite, so the merge writer's trial runs it when a change touches the dashboard.

const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

test('unit:trial-runs-browser-suite — a trial of a change touching web/ runs npm run test:browser and a failing browser test refuses the merge; a change touching only src/daemon/ never runs it', async () => {
  const root = await temporaryDirectory('trial-browser-repo', tmpdir());
  gitIn(root, 'init', '-q', '-b', 'main');
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'true', 'test:browser': 'playwright test' } }));
  write('web/app.tsx', 'one\n'); write('src/daemon/cycle.ts', 'one\n');
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const base = gitIn(root, 'rev-parse', 'HEAD');
  const trialOf = async (path: string, browserFails: boolean) => {
    gitIn(root, 'checkout', '-q', '--detach', base); write(path, 'two\n'); gitIn(root, 'commit', '-q', '-am', `edit ${path}`);
    const head = gitIn(root, 'rev-parse', 'HEAD'); gitIn(root, 'checkout', '-q', 'main');
    const merged = await trialMerge(async args => String(await defaultChildRun('git', ['-C', root, ...args], { env: { ...process.env, ...identity } })), { head, baseTip: base });
    assert.ok('mergeSha' in merged);
    // The recording runner: git runs for real, every npm script is recorded and answered.
    const npm: string[] = [];
    const run = (async (command: string, args: string[], options: never) => {
      if (command !== 'npm') return defaultChildRun(command, args, options);
      npm.push(args.join(' '));
      if (args[1] === 'test:browser' && browserFails) throw Object.assign(new Error('Command failed: npm run test:browser'), { status: 1, signal: null, stdout: '1 failed\n  dashboard.spec.ts:12 board shows the lanes\n', stderr: '' });
      return '';
    }) as never;
    const verdict = await runTrial({ root, base: await temporaryDirectory('trial-browser-root', tmpdir()), mergeSha: merged.mergeSha, changedFiles: [path], timeoutMs: 120_000, key: 'GY-9', environment: { PATH: process.env.PATH! }, run, retries: 0 });
    return { verdict, npm };
  };

  const dashboard = await trialOf('web/app.tsx', true);
  assert.deepEqual(dashboard.npm, ['run build', 'run test:browser'], 'a change to web/ runs the browser suite after the build');
  assert.deepEqual(dashboard.verdict.tests.failed, [browserSuite]);
  assert.match(trialFailureReason({ run: dashboard.verdict })!, /tests browser-tests\//, 'a failing browser test refuses the merge');
  assert.match(dashboard.verdict.logTail, /dashboard\.spec\.ts:12/, 'the failing browser test is in the log');

  const passing = await trialOf('web/app.tsx', false);
  assert.deepEqual(passing.npm, ['run build', 'run test:browser']);
  assert.equal(trialFailureReason({ run: passing.verdict }), null, 'a passing browser suite lets the merge through');

  const daemon = await trialOf('src/daemon/cycle.ts', true);
  assert.deepEqual(daemon.npm, ['run build'], 'a change touching only src/daemon/ never runs the browser suite');
  assert.equal(trialFailureReason({ run: daemon.verdict }), null);
});
