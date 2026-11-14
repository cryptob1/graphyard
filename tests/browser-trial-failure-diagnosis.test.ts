import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun } from '../src/child-runner.js';
import { hydratePostgresLibraries, postgresBinaries } from '../src/install/local-runtime.js';
import { runTrial, trialMerge } from '../src/merge-writer/trial.js';
import { trialFailureReason, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { trialAndPushRevert } from '../src/merge-writer/serve-revert.js';
import { bootstrapGate, runDiagnostics } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3305: a failed browser run kept only its teardown noise - Babel scope-tracker warnings, pool-end
// errors, ECONNREFUSED - in the records that judge a batch and its revert, so no failing test or error
// survived the trial's cleanup to name a cause. The browser suite's own recurring failure on this host
// had the same shape underneath: npm's install-scripts allowlist silently skipped the embedded Postgres
// package's postinstall, leaving binaries that cannot load their bundled libraries.

/** A browser run's output as Playwright prints it: passing progress, two failing tests with error blocks, the counts, then web-server teardown noise. */
const browserFailureOutput = () => [
  'Running 97 tests using 4 workers',
  ...Array.from({ length: 90 }, (_, at) => `  ✓ ${at + 1} [chromium] › browser-tests/pass-${at + 1}.spec.ts:${at + 1}:1 › passing case ${at + 1} holds its assertion`),
  '',
  '  1) [chromium] › browser-tests/terminal.spec.ts:12:1 › e2e:master-page-terminal — the operator types into the master pane live',
  '',
  '    Error: expect(locator).toContainText(expected) failed',
  '',
  '    Locator: locator(\'.xterm-rows\')',
  '    Expected substring: "screen of w1:master"',
  '    Received string:    ""',
  '',
  '  2) [chromium] › browser-tests/connect.spec.ts:30:1 › e2e:master-page-terminal-refused — when the terminal cannot start, the page says refused',
  '',
  '    Test timeout of 30000ms exceeded.',
  '',
  '  89 passed (2.1m)',
  'The exported identifier "HostDoableAsk" is not declared in Babel\'s scope tracker',
  'as a JavaScript value binding, and "@babel/plugin-transform-typescript"',
  'never encountered it as a TypeScript type declaration.',
  ...Array.from({ length: 30 }, (_, at) => [
    `[store] database connection lost: terminating connection due to administrator command; the next request reconnects (${at})`,
    `request failed GET /api/status: Cannot use a pool after calling end on the pool (${at})`,
  ]).flat(),
  'request failed GET /api/board: Error: connect ECONNREFUSED 127.0.0.1:4319',
].join('\n');

/** A browser run that fails naming no failing test: only the teardown noise a broken server lifecycle leaves. */
const noisyOutput = () => [
  'Running 97 tests using 4 workers',
  ...Array.from({ length: 20 }, (_, at) => `request failed GET /api/status: Cannot use a pool after calling end on the pool (${at})`),
  'The exported identifier "HostDoableAsk" is not declared in Babel\'s scope tracker',
  'request failed GET /api/board: Error: connect ECONNREFUSED 127.0.0.1:4319',
].join('\n');

/** The first failing test with its error, as the records must keep it. */
const failingTest = /browser-tests\/terminal\.spec\.ts:12 › e2e:master-page-terminal — the operator types into the master pane live: Error: expect\(locator\)\.toContainText\(expected\) failed/;
const noise = /HostDoableAsk|ECONNREFUSED|pool after calling end/;

test('e2e:browser-trial-failure-diagnosis — a browser run failing beside passing cases and noisy teardown keeps its failing test and error in the verdict, the revert record and the gate diagnostic record after cleanup; a run naming no failing test keeps an explicit no-cause marker, and Postgres binaries hydrate the symlinks a skipped postinstall left', async () => {
  // The reproduced lifecycle cause, repaired: the package's postinstall links its bundled libraries,
  // and an install whose scripts npm's allowlist skipped has none - the binaries cannot load them.
  const fixture = await temporaryDirectory('postgres-symlinks');
  const put = (path: string, content: string) => { mkdirSync(dirname(join(fixture, path)), { recursive: true }); writeFileSync(join(fixture, path), content); };
  put('native/bin/postgres', 'stub\n'); put('native/lib/libicui18n.so.60.2', 'stub\n');
  put('native/pg-symlinks.json', JSON.stringify([
    { source: 'native/lib/libicui18n.so.60.2', target: 'native/lib/libicui18n.so.60' },
    { source: 'native/lib/absent.so.1', target: 'native/lib/absent.so' },
  ]));
  await hydratePostgresLibraries({ postgres: join(fixture, 'native/bin/postgres') });
  assert.equal(readlinkSync(join(fixture, 'native/lib/libicui18n.so.60')), 'libicui18n.so.60.2', 'the missing library link is hydrated, relative as the postinstall makes it');
  assert.ok(!existsSync(join(fixture, 'native/lib/absent.so')), 'a link whose source is absent is not invented');
  const binaries = await postgresBinaries();
  await defaultChildRun(binaries.initdb, ['--version']);
  assert.match((await defaultChildRun(binaries.postgres, ['--version'])).trim(), /^postgres \(PostgreSQL\)/, 'the resolved binaries load their bundled libraries');

  // A repository whose browser check fails beside passing cases, with noisy teardown after the summary.
  const root = await temporaryDirectory('browser-diagnosis-repo', tmpdir());
  const author = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...author } }).trim();
  gitIn(root, 'init', '-q', '-b', 'main');
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'true', 'test:browser': 'playwright test' } }));
  write('graphyard.json', JSON.stringify({ delivery: { mode: 'local', mergeGate: { preMerge: [{ check: 'browser-tests/', command: 'npm run test:browser', source: 'script', reason: 'The browser suite runs beside the build' }], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null } } }));
  write('web/app.tsx', 'one\n');
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const base = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', '--detach', base); write('web/app.tsx', 'two\n'); gitIn(root, 'commit', '-q', '-am', 'edit web');
  const head = gitIn(root, 'rev-parse', 'HEAD'); gitIn(root, 'checkout', '-q', 'main');
  const merged = await trialMerge(async args => String(await defaultChildRun('git', ['-C', root, ...args], { env: { ...process.env, ...author } })), { head, baseTip: base });
  assert.ok('mergeSha' in merged);

  const session = await temporaryDirectory('browser-diagnosis-root', tmpdir());
  const recordingRunner = (stdout: () => string) => (async (command: string, args: string[], options: never) => {
    if (command !== 'npm' && command !== 'npx') return defaultChildRun(command, args, options);
    if (args[0] === 'run' && args[1] === 'test:browser') throw Object.assign(new Error('Command failed: npm run test:browser'), { status: 1, signal: null, stdout: stdout(), stderr: '' });
    return '';
  }) as never;
  const trialOf = (mergeSha: string, changedFiles: readonly string[], stdout: () => string) => runTrial({
    root, base: session, mergeSha, changedFiles: [...changedFiles], timeoutMs: 120_000, key: 'GY-3305',
    environment: { PATH: process.env.PATH! }, retries: 0, run: recordingRunner(stdout),
  });

  // The verdict keeps the failing specs, the first failing test and its error; the trial's cleanup
  // (its checkout is gone) takes everything else, and the teardown noise none of the identity.
  const verdict = await trialOf(merged.mergeSha, ['web/app.tsx'], browserFailureOutput);
  assert.deepEqual(verdict.tests.failed, ['browser-tests/terminal.spec.ts', 'browser-tests/connect.spec.ts'], 'the failing spec files, not the bare check id');
  assert.match(verdict.failingCase!, failingTest, 'the first failing test with its error');
  assert.notEqual(verdict.timedOut, true, 'an assertion failure beside a time-out is no load-only run');
  assert.match(verdict.logTail, /terminal\.spec\.ts:12 ›/, 'the log tail keeps the failing test');
  assert.match(verdict.logTail, /Test timeout of 30000ms exceeded\./, 'and the second failure\'s error');
  assert.match(verdict.logTail, /89 passed/, 'beside the run\'s own counts');
  assert.doesNotMatch(verdict.logTail, noise, 'the teardown warnings cannot crowd the diagnosis out');

  // The revert's record is the same reason: the identity rides it, the noise does not.
  let pushed = false;
  const decided = await trialAndPushRevert(
    { trial: async () => verdict as unknown as MergeTrialRun, push: async () => { pushed = true; return 'pushed'; } },
    { revertSha: 'c'.repeat(40), files: ['web/app.tsx'], baseTip: 'd'.repeat(40), culpritKey: 'GY-3305', mergeSha: 'e'.repeat(40) });
  assert.ok('held' in decided, 'a failing revert trial holds the revert');
  assert.match(decided.held, failingTest, 'the held reason names the failing test and its error');
  assert.doesNotMatch(decided.held, noise, 'not the teardown noise');
  assert.equal(pushed, false, 'a held revert is never pushed');
  assert.equal(trialFailureReason({ run: { ...verdict, failingCase: undefined, timedOut: true } }) !== null, true, 'a time-out-only browser run still refuses naming its files');

  // The batch gate's scheduled diagnostic files the same identity with the output that proves it.
  const gateReads = (stdout: () => string, filed: { key: string; description: string }[]): MergeWriterReads => ({
    baseBranch: 'main', now: Date.now,
    fetch: async () => base,
    git: async (args: string[]) => args[0] === 'ls-tree' ? '' : '',
    trial: async (commit: string, files: readonly string[]) => await trialOf(commit, files, stdout) as unknown as MergeTrialRun,
    createWork: async (input: { description: string }, key: string) => { filed.push({ key, description: input.description }); return { key: 'GY-1' }; },
  }) as unknown as MergeWriterReads;
  const filed: { key: string; description: string }[] = [];
  const reads = gateReads(browserFailureOutput, filed);
  const record = bootstrapGate('owner/project', base);
  assert.deepEqual(await runDiagnostics(batchGatePorts({ ...reads, git: reads.git! }, []), record),
    ['test:browser-tests/terminal.spec.ts', 'test:browser-tests/connect.spec.ts'], 'the diagnostic names the failing specs');
  assert.match(record.diagnosticFailures!['test:browser-tests/terminal.spec.ts']!.detail!, /terminal\.spec\.ts:12 › .*: Error: expect\(locator\)/, 'the record keeps the failing test and error after cleanup');
  const description = filed.find(entry => entry.key === 'diagnostic:test:browser-tests/terminal.spec.ts')!.description;
  assert.match(description, /terminal\.spec\.ts:12 › .*operator types into the master pane.*Error: expect\(locator\)/s, 'the filing carries the identity');
  assert.match(description, /Test timeout of 30000ms exceeded/, 'and the second failure');
  assert.doesNotMatch(description, noise, 'not the teardown noise');

  // A run that names no failing test keeps an explicit no-cause marker; nothing claims a diagnosis.
  const noisyFiled: { key: string; description: string }[] = [];
  const noisyReads = gateReads(noisyOutput, noisyFiled);
  const noisyRecord = bootstrapGate('owner/project', base);
  assert.deepEqual(await runDiagnostics(batchGatePorts({ ...noisyReads, git: noisyReads.git! }, []), noisyRecord), ['test:browser-tests/']);
  assert.equal(noisyRecord.diagnosticFailures!['test:browser-tests/']!.detail, 'the run named no failing test or error: nothing in its output establishes a cause', 'the record says no cause is established');
  assert.match(noisyFiled.find(entry => entry.key === 'diagnostic:test:browser-tests/')!.description, /named no failing test or error/, 'and so does the filing');
});
