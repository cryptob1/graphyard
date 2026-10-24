import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun } from '../src/child-runner.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master.js';
import { trialFailureReason } from '../src/merge-writer/executor.js';
import {
  noTestCheckConfigured,
  repositoryTrialChecks,
  runTrial,
  trialMerge,
  trialTestGateStatus,
} from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2958: without scripts/ci-tests.mjs the trial runs the managed repository's own test checks.

const identity = {
  GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

const gateCheck = (check: string, command: string) =>
  ({ check, command, source: 'script' as const, reason: 'fixture' });

async function managedRepo(files: Record<string, string>) {
  const root = await temporaryDirectory('trial-repo-checks', tmpdir());
  gitIn(root, 'init', '-q', '-b', 'main');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'base');
  const base = gitIn(root, 'rev-parse', 'HEAD');
  return { root, base, write };
}

test('unit:trial-runs-repository-test-check — a fixture without scripts/ci-tests.mjs whose graphyard.json preMerge names npm run test fails the trial when that script fails, and passes with checks recorded when it passes', async () => {
  assert.deepEqual(
    repositoryTrialChecks({
      preMerge: [gateCheck('build', 'npm run build'), gateCheck('test', 'npm run test')],
      scripts: { build: 'true', test: 'node test.js' },
    }),
    [{ check: 'test', argv: ['npm', 'run', 'test'] }],
    'preMerge supplies the test check; build is already run',
  );

  const policy = {
    mode: 'local',
    mergeGate: { preMerge: [gateCheck('test', 'npm run test')], perCandidate: [] },
    candidateSchedule: null,
    deploy: { adapter: 'command', project: null, uat: null, production: null },
  };
  const repo = await managedRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'true', test: 'node test.js' } }),
    'graphyard.json': JSON.stringify({ delivery: policy }),
    'test.js': 'process.exit(1);\n',
  });
  const head = (() => {
    gitIn(repo.root, 'checkout', '-q', '--detach', repo.base);
    repo.write('src/a.ts', 'export {};\n');
    gitIn(repo.root, 'add', '-A');
    gitIn(repo.root, 'commit', '-q', '-m', 'change');
    const sha = gitIn(repo.root, 'rev-parse', 'HEAD');
    gitIn(repo.root, 'checkout', '-q', 'main');
    return sha;
  })();
  const merged = await trialMerge(
    async args => String(await defaultChildRun('git', ['-C', repo.root, ...args], { env: { ...process.env, ...identity } })),
    { head, baseTip: repo.base },
  );
  assert.ok('mergeSha' in merged);

  const npm: string[] = [];
  const run = (async (command: string, args: string[], options: never) => {
    if (command !== 'npm') return defaultChildRun(command, args, options);
    npm.push(`npm ${args.join(' ')}`);
    if (args[0] === 'run' && args[1] === 'test') {
      throw Object.assign(new Error('Command failed: npm run test'), {
        status: 1, signal: null, stdout: 'not ok 1 fixture case\n', stderr: '',
      });
    }
    return '';
  }) as never;
  const failing = await runTrial({
    root: repo.root,
    base: await temporaryDirectory('trial-repo-checks-root', tmpdir()),
    mergeSha: merged.mergeSha,
    changedFiles: ['src/a.ts'],
    timeoutMs: 120_000,
    key: 'GY-2958',
    environment: { PATH: process.env.PATH! },
    run,
    retries: 0,
  });
  assert.deepEqual(npm, ['npm run build', 'npm run test'], 'build then the preMerge test check');
  assert.equal(failing.build, 'pass');
  assert.deepEqual(failing.tests, { passed: 0, failed: ['test'], files: 1 }, failing.logTail);
  assert.match(failing.logTail, /not ok 1 fixture case/);
  assert.match(trialFailureReason({ run: failing })!, /tests test/, 'the refusal names the test check');

  const passingRun = (async (command: string, args: string[], options: never) => {
    if (command !== 'npm') return defaultChildRun(command, args, options);
    return 'ok\n';
  }) as never;
  const passing = await runTrial({
    root: repo.root,
    base: await temporaryDirectory('trial-repo-checks-root', tmpdir()),
    mergeSha: merged.mergeSha,
    changedFiles: ['src/a.ts'],
    timeoutMs: 120_000,
    key: 'GY-2958',
    environment: { PATH: process.env.PATH! },
    run: passingRun,
    retries: 0,
  });
  assert.equal(passing.build, 'pass');
  assert.deepEqual(passing.tests, { passed: 1, failed: [], files: 1 }, 'a passing check is recorded as run, never zero tests');
  assert.equal(trialFailureReason({ run: passing }), null);
});

test('unit:trial-reports-missing-test-check — a fixture with no selection script and no test or typecheck script yields a trial verdict and a master status line that say no test check is configured', async () => {
  assert.deepEqual(repositoryTrialChecks({ preMerge: [], scripts: { build: 'true' } }), []);
  assert.equal(noTestCheckConfigured, 'no test check configured');

  const repo = await managedRepo({
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'true' } }),
  });
  const head = (() => {
    gitIn(repo.root, 'checkout', '-q', '--detach', repo.base);
    repo.write('README.md', 'x\n');
    gitIn(repo.root, 'add', '-A');
    gitIn(repo.root, 'commit', '-q', '-m', 'change');
    const sha = gitIn(repo.root, 'rev-parse', 'HEAD');
    gitIn(repo.root, 'checkout', '-q', 'main');
    return sha;
  })();
  const merged = await trialMerge(
    async args => String(await defaultChildRun('git', ['-C', repo.root, ...args], { env: { ...process.env, ...identity } })),
    { head, baseTip: repo.base },
  );
  assert.ok('mergeSha' in merged);

  const run = (async (command: string, args: string[], options: never) => {
    if (command !== 'npm') return defaultChildRun(command, args, options);
    return '';
  }) as never;
  const verdict = await runTrial({
    root: repo.root,
    base: await temporaryDirectory('trial-repo-checks-root', tmpdir()),
    mergeSha: merged.mergeSha,
    changedFiles: ['README.md'],
    timeoutMs: 120_000,
    key: 'GY-2958',
    environment: { PATH: process.env.PATH! },
    run,
    retries: 0,
  });
  assert.equal(verdict.build, 'pass');
  assert.deepEqual(verdict.tests, { passed: 0, failed: [noTestCheckConfigured], files: 0 });
  assert.match(verdict.logTail, /no test check configured/);
  assert.match(trialFailureReason({ run: verdict })!, /no test check configured/);

  const gate = trialTestGateStatus(repo.root);
  assert.deepEqual(gate, { configured: false, detail: noTestCheckConfigured });

  const config = {
    url: 'http://127.0.0.1:9',
    credentialFile: join(repo.root, 'credential'),
    repository: 'owner/fixture',
    baseBranch: 'main',
    hostId: 'test',
    workers: [],
    run: { intervalSeconds: 30 },
  } as unknown as MasterConfig;
  writeFileSync(config.credentialFile, 'token\n');
  const status = await masterStatusReport(
    repo.root,
    config,
    async () => ({ work: [], now: new Date().toISOString() }),
    async () => `${repo.base}\n`,
  );
  assert.deepEqual(status.trialTests, { configured: false, detail: noTestCheckConfigured }, 'master status surfaces the missing test check');
});
