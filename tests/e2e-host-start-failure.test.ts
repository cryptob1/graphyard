import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runMergeTrial, trialFailureReason } from '../src/merge-writer/executor.js';
import { TrialRunnerError, trialMerge, type TrialRun } from '../src/merge-writer/trial.js';
import { containerTrialE2e, trialHarness } from '../src/merge-writer/trial-container.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { parseCase } from '../src/e2e/case.js';
import { runCases, type E2eLauncher } from '../src/e2e/runner.js';
import { confinedSession, type ProcessRunner } from '../src/e2e/steps.js';

// GY-3180: a browser or runner that cannot start judged nothing, so the merge trial ends with no
// verdict through the runner-failure path and the head stays queued; a step that ran and failed
// is still the head's. The trial's private home holds no installed browser here, which is the
// real launch failure that refused heads.

const identity = {
  GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const repository = join(import.meta.dirname, '..');
const servePort = 20000 + (process.pid % 20_000);
const browserCase = { id: 'home-opens', title: 'The home page opens', target: 'any', required: false,
  steps: [{ kind: 'browser', action: 'open', path: '/' }, { kind: 'browser', action: 'expectText', text: 'served' }] };
const failingCase = { id: 'home-says', title: 'The home page says the thing', target: 'any', required: false,
  steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'message', equals: 'never said' }] }] };
const serveScript = `require('node:http').createServer((request, response) => { response.writeHead(200, {'Content-Type':'application/json'}); response.end(JSON.stringify({ message: 'served' })); }).listen(${servePort}, '127.0.0.1');\n`;

let fixtureRoot: string, root: string, baseTip: string, mergeSha: string;
const gitIn = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };

before(async () => {
  fixtureRoot = await temporaryDirectory('e2e-host-start-failure', tmpdir());
  root = join(fixtureRoot, 'repo');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node --eval 0' } }));
  write('graphyard.json', JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.js', url: `http://127.0.0.1:${servePort}`, readySeconds: 10 } } }));
  write('serve.js', serveScript);
  gitIn('add', '-A'); gitIn('commit', '-q', '-m', 'base');
  baseTip = gitIn('rev-parse', 'HEAD');
  gitIn('checkout', '-q', '-b', 'head');
  write('e2e/cases/home-opens.json', JSON.stringify(browserCase));
  write('e2e/cases/home-says.json', JSON.stringify(failingCase));
  gitIn('add', '-A'); gitIn('commit', '-q', '-m', 'cases');
  const head = gitIn('rev-parse', 'HEAD');
  gitIn('checkout', '-q', 'main');
  const merged = await trialMerge((args: readonly string[]) => defaultChildRun('git', ['-C', root, ...args]), { head, baseTip });
  assert.ok('mergeSha' in merged);
  mergeSha = merged.mergeSha;
});
after(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

/** The trial's children outside its container, the E2E runner against this checkout's harness with no browser installed, so the launch that fails is the real one wherever this runs. */
const uncontained: ChildRun = async (command, args, options) => {
  const script = args.at(-1)!;
  if (!script.endsWith('run.mjs')) return defaultChildRun(command, args, { ...options, wrapper: undefined });
  writeFileSync(script, readFileSync(script, 'utf8').replaceAll(trialHarness, repository));
  return defaultChildRun(command, ['--import', 'tsx', script], { ...options, cwd: repository, wrapper: undefined, env: { ...options?.env, PLAYWRIGHT_BROWSERS_PATH: '/nonexistent/browsers' } });
};
const trial = (e2eProofs: string[]) => runMergeTrial({
  root, base: join(fixtureRoot, 'managed'), mergeSha, changedFiles: ['e2e/cases/home-opens.json'], proofs: [], e2eProofs, proofFiles: [], run: uncontained,
  timeoutMs: 120_000, key: 'GY-3180', environment: { PATH: process.env.PATH!, HOME: process.env.HOME! }, retries: 0,
});
/** What a trial came to: its run, or the error that left it with no verdict. */
const outcomeOf = (ran: Promise<TrialRun>) => ran.then(run => ({ run, error: null }), (error: unknown) => ({ run: null, error }));

const browserFile = { file: 'e2e/cases/home-opens.json', definition: parseCase('e2e/cases/home-opens.json', JSON.stringify(browserCase)) };
const commandFile = (run: string) => ({ file: 'e2e/cases/home-runs.json', definition: parseCase('e2e/cases/home-runs.json', JSON.stringify({ ...browserCase, id: 'home-runs', steps: [{ kind: 'command', run }] })) });

test('unit:e2e-host-start-failure — a browser that cannot launch is the host\'s; a step that fails is the case\'s', async () => {
  const launcher: E2eLauncher = { launch: async () => { throw new Error("Executable doesn't exist at /nowhere/chrome"); } };
  const report = await runCases([browserFile], { url: 'http://127.0.0.1:1', token: 't', launcher });
  assert.equal(report.cases[0].attemptResults?.at(-1)?.hostFailure, true);
  assert.match(report.cases[0].failingStep!.reason, /^the browser could not start: Executable doesn't exist/);

  const page = () => { throw new Error('a step failed'); };
  const opens: E2eLauncher = { launch: async () => ({ newPage: async () => ({ on: () => {}, goto: page, close: async () => {} }) as never, close: async () => {} }) };
  const stepFailed = await runCases([browserFile], { url: 'http://127.0.0.1:1', token: 't', launcher: opens });
  assert.equal(stepFailed.cases[0].verdict, 'failed');
  assert.equal(stepFailed.cases[0].attemptResults?.at(-1)?.hostFailure, undefined);
});

test('unit:e2e-host-start-failure — a process that never started is the host\'s, whether spawned directly or under a session gone', async () => {
  const notStarted: ProcessRunner = async () => ({ code: null, output: 'spawn sh ENOENT', timedOut: false, notStarted: true });
  const spawned = await runCases([commandFile('true')], { url: 'http://127.0.0.1:1', token: 't', root, processRunner: notStarted });
  assert.equal(spawned.cases[0].attemptResults?.at(-1)?.hostFailure, true);

  const session = confinedSession(['/nonexistent/bwrap']);
  try {
    const confined = await runCases([commandFile('true')], { url: 'http://127.0.0.1:1', token: 't', root, processRunner: session.run });
    assert.equal(confined.cases[0].attemptResults?.at(-1)?.hostFailure, true);
  } finally { await session.close(); }

  const exited = await runCases([commandFile('exit 3')], { url: 'http://127.0.0.1:1', token: 't', root });
  assert.equal(exited.cases[0].verdict, 'failed');
  assert.equal(exited.cases[0].attemptResults?.at(-1)?.hostFailure, undefined, 'a command that ran and failed is the head\'s');
});

test('unit:e2e-host-start-failure — a trial whose bound browser cannot launch ends as a runner failure, refusing nothing', async () => {
  const { run, error } = await outcomeOf(trial(['e2e:home-opens']));
  assert.ok(error instanceof TrialRunnerError, `no runner failure: ${run ? trialFailureReason({ run }) : error}`);
  assert.equal(error.phase, 'tests');
  assert.match(error.outputTail, /e2e case home-opens: the browser could not start/);
});

test('unit:e2e-host-start-failure — a case that fails a step still refuses the head, a browser that could not start beside it or not', async () => {
  for (const proofs of [['e2e:home-says'], ['e2e:home-opens', 'e2e:home-says']]) {
    const run = await trial(proofs);
    assert.match(trialFailureReason({ run })!, /^trial failed: e2e case home-says: step 1 GET \//);
  }
});

test('unit:e2e-host-start-failure — a runner process that cannot start is reported as the host\'s; one out of budget stays a failure', async () => {
  const input = { worktree: root, mergeSha, proofs: ['e2e:home-opens'], env: { PATH: process.env.PATH! }, wrapper: [], networkWrapper: () => [], budgetMs: 5_000, log: () => {} };
  const scratch = await temporaryDirectory('e2e-host-runner', fixtureRoot);
  gitIn('checkout', '-q', '--detach', mergeSha);
  try {
    const dead = await containerTrialE2e({ ...input, scratch, run: async () => { throw new Error('node could not be started'); } });
    assert.equal(dead[0].hostFailure, true);
    assert.match(dead[0].failingStep!, /the E2E runner could not start: node could not be started/);
    const slow = await containerTrialE2e({ ...input, scratch, run: async () => { throw Object.assign(new Error('did not finish'), { timedOut: true }); } });
    assert.equal(slow[0].hostFailure, undefined);
    assert.equal(slow[0].failed, 1);
  } finally { gitIn('checkout', '-q', 'main'); }
});
