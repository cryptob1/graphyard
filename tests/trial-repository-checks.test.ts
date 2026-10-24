import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun } from '../src/child-runner.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master.js';
import { baseFailurePrefix, baseFailureReason, clearBaseTipCheckCache, failureIsBase, mergeOne, runMergeTrial, trialFailureReason, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { trialFailedGround, trialFailurePrefix } from '../src/model/rework-ground.js';
import type { Work } from '../src/model.js';
import {
  noTestCheckConfigured,
  repositoryCheckFailure,
  repositoryTrialChecks,
  runTrial,
  trialMerge,
  trialTestGateStatus,
} from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2958: without scripts/ci-tests.mjs the trial runs the managed repository's own test checks.
// GY-2960: a failing check names its files and first case; a failure the base tip shares is held, not reworked.

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

const twoFileFailure = [
  '✖ first case in a (1.2ms)',
  '  AssertionError: expected true',
  'test at tests/a.test.ts:10:3',
  '✖ second case in b (0.8ms)',
  '  AssertionError: expected false',
  'test at tests/b.test.ts:5:1',
].join('\n');

test('unit:repository-check-refusal-names-failing-tests — a repository test check whose npm test fails two named cases in two files refuses naming both files and the first case, and the verdict carries the log tail', async () => {
  const parsed = repositoryCheckFailure(twoFileFailure);
  assert.deepEqual(parsed.files, ['tests/a.test.ts', 'tests/b.test.ts']);
  assert.equal(parsed.firstCase, 'first case in a');
  assert.equal(parsed.timedOut, false);

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

  const run = (async (command: string, args: string[], options: never) => {
    if (command !== 'npm') return defaultChildRun(command, args, options);
    if (args[0] === 'run' && args[1] === 'test') {
      throw Object.assign(new Error('Command failed: npm run test'), {
        status: 1, signal: null, stdout: twoFileFailure, stderr: '',
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
    key: 'GY-2960',
    environment: { PATH: process.env.PATH! },
    run,
    retries: 0,
  });
  assert.equal(failing.build, 'pass');
  assert.deepEqual(failing.tests.failed, ['tests/a.test.ts', 'tests/b.test.ts'], failing.logTail);
  assert.equal(failing.failingCase, 'first case in a');
  assert.match(failing.logTail, /first case in a/);
  assert.match(failing.logTail, /tests\/a\.test\.ts/);
  const reason = trialFailureReason({ run: failing })!;
  assert.match(reason, new RegExp(`^${trialFailurePrefix}: tests tests/a\\.test\\.ts, tests/b\\.test\\.ts: first case in a$`));
  assert.equal(repositoryCheckFailure('✖ frame budget timed out (180000ms)\ntest at tests/frame-budget.test.ts:1:1').timedOut, true);
  assert.match(trialFailureReason({ run: { ...failing, tests: { passed: 0, failed: ['tests/frame-budget.test.ts'], files: 1 }, failingCase: 'frame budget', timedOut: true } })!, /timed out/);
});

test('unit:repository-check-base-failure-holds-head — the same failing repository check on the base tip holds the head as a base failure (no rework); a failure only the head has is the ordinary trial-failed refusal and grounds a rework', async () => {
  const caseTitle = 'unit:shared-failure — the base tip fails this too';
  const file = 'tests/shared.test.ts';
  const failingOut = [`✖ ${caseTitle} (3ms)`, '  AssertionError: boom', `test at ${file}:2:1`].join('\n');
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
    repo.write('src/change.ts', 'export {};\n');
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

  const runFor = (failOn: ReadonlySet<string>) => {
    let checkedOut = '';
    return (async (command: string, args: string[], options: never) => {
      if (command === 'git' && args.includes('worktree') && args.includes('add')) {
        checkedOut = args.at(-1)!.toLowerCase();
        return defaultChildRun(command, args, options);
      }
      if (command !== 'npm') return defaultChildRun(command, args, options);
      if (args[0] === 'run' && args[1] === 'test') {
        if (failOn.has(checkedOut)) {
          throw Object.assign(new Error('Command failed: npm run test'), {
            status: 1, signal: null, stdout: failingOut, stderr: '',
          });
        }
        return 'ok\n';
      }
      return '';
    }) as never;
  };

  const both = await runMergeTrial({
    root: repo.root,
    base: await temporaryDirectory('trial-repo-checks-root', tmpdir()),
    mergeSha: merged.mergeSha,
    changedFiles: ['src/change.ts'],
    proofs: [],
    proofFiles: [],
    baseTip: repo.base,
    timeoutMs: 120_000,
    key: 'GY-2960',
    environment: { PATH: process.env.PATH! },
    run: runFor(new Set([merged.mergeSha.toLowerCase(), repo.base.toLowerCase()])),
    retries: 0,
    remove: async () => {},
  });
  assert.ok(failureIsBase(both), `base failure expected: ${JSON.stringify(both.base)}`);
  assert.ok(both.base!.files.includes(file), `base files: ${both.base!.files.join(',')}`);
  const heldReason = baseFailureReason(both.base!);
  assert.match(heldReason, new RegExp(`^${baseFailurePrefix}: tests ${file.replaceAll('.', '\\.')} fail on the base tip ${repo.base}`));
  assert.match(heldReason, /shared-failure/);

  const heldEvents: MergeRecordEvent[] = [];
  const heldWork = {
    id: 'w-2960', key: 'GY-2960',
    candidate: { sha: head, baseSha: repo.base, pr: 1, branch: 'graphyard/gy-2960-1', author: 'worker' },
    submission: { epoch: 1, pr: 1 },
    criteria: [],
  } as unknown as Work;
  const heldPorts: MergePorts = {
    baseBranch: 'main', retrials: 0, now: () => Date.parse('2030-01-01T00:00:00Z'),
    fetch: async () => repo.base,
    merge: async () => ({ mergeSha: merged.mergeSha, files: ['src/change.ts'] }),
    trial: async () => both,
    push: async () => 'pushed',
    holds: async () => false,
    record: async (_work, event) => { heldEvents.push(event); },
  };
  const held = await mergeOne(heldPorts, heldWork);
  assert.equal(held.outcome, 'requeued', 'a base failure holds the head, never reworks it');
  assert.equal(held.reason, heldReason);
  const heldRefusal = heldEvents.find(event => event.kind === 'refused');
  assert.ok(heldRefusal && heldRefusal.kind === 'refused');
  assert.equal(trialFailedGround({
    candidate: heldWork.candidate,
    mergeLedger: { key: 'GY-2960', state: 'refused', head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason: heldRefusal.reason }, events: 1 },
  }), null, 'a base-failure refusal grounds no rework');

  clearBaseTipCheckCache();
  const headOnly = await runMergeTrial({
    root: repo.root,
    base: await temporaryDirectory('trial-repo-checks-root', tmpdir()),
    mergeSha: merged.mergeSha,
    changedFiles: ['src/change.ts'],
    proofs: [],
    proofFiles: [],
    baseTip: repo.base,
    timeoutMs: 120_000,
    key: 'GY-2960-head',
    environment: { PATH: process.env.PATH! },
    run: runFor(new Set([merged.mergeSha.toLowerCase()])),
    retries: 0,
    remove: async () => {},
  });
  assert.equal(headOnly.base, undefined, 'a failure only the head has is not the base\'s');
  assert.deepEqual(headOnly.tests.failed, [file], headOnly.logTail);
  const headReason = trialFailureReason({ run: headOnly })!;
  assert.match(headReason, new RegExp(`^${trialFailurePrefix}: tests ${file.replaceAll('.', '\\.')}`));
  const reworkEvents: MergeRecordEvent[] = [];
  const reworkWork = {
    id: 'w-2960b', key: 'GY-2960b',
    candidate: { sha: head, baseSha: repo.base, pr: 2, branch: 'graphyard/gy-2960-2', author: 'worker' },
    submission: { epoch: 1, pr: 2 },
    criteria: [],
  } as unknown as Work;
  const reworkPorts: MergePorts = {
    baseBranch: 'main', retrials: 0, now: () => Date.parse('2030-01-01T00:00:00Z'),
    fetch: async () => repo.base,
    merge: async () => ({ mergeSha: merged.mergeSha, files: ['src/change.ts'] }),
    trial: async () => headOnly,
    push: async () => 'pushed',
    holds: async () => false,
    record: async (_work, event) => { reworkEvents.push(event); },
  };
  const reworked = await mergeOne(reworkPorts, reworkWork);
  assert.equal(reworked.outcome, 'refused');
  assert.equal(reworked.reason, headReason);
  const refusal = reworkEvents.find(event => event.kind === 'refused');
  assert.ok(refusal && refusal.kind === 'refused');
  assert.ok(trialFailedGround({
    candidate: reworkWork.candidate,
    mergeLedger: { key: 'GY-2960b', state: 'refused', head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason: refusal.reason }, events: 1 },
  }), 'an ordinary trial-failed refusal grounds a rework');
});
