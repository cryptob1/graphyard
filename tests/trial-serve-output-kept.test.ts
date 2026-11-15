import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runMergeTrial } from '../src/merge-writer/executor.js';
import { trialMerge } from '../src/merge-writer/trial.js';
import { defaultChildRun } from '../src/child-runner.js';

// GY-3343: a declared serve command that never answers, or exits early, leaves its whole output
// in a file under the trial run directory and its last 40 lines, with when it ran, in the trial
// result; a trial whose scratch holds a read-only tree removes it and reports no leftover.

const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const port = 20000 + ((process.pid + 7919) % 20_000);
const homeCase = { id: 'home', title: 'The home page answers', target: 'any', required: false, steps: [{ kind: 'http', method: 'GET', path: '/', status: 200 }] };
// 100 lines, then waits forever (or exits) without ever listening.
const printer = (exit: boolean) => `for (let i = 1; i <= 100; i++) console.log('serve line ' + i);${exit ? ' process.exit(3);' : ' setInterval(() => {}, 1000);'}\n`;
// The build leaves a read-only tree in the trial's scratch, as Go's module cache does.
const readOnlyBuild = 'mkdir -p "$TMPDIR/cache/mod/sub" && echo x > "$TMPDIR/cache/mod/sub/file" && echo y > "$TMPDIR/cache/mod/file" && chmod 0444 "$TMPDIR/cache/mod/sub/file" "$TMPDIR/cache/mod/file" && chmod 0555 "$TMPDIR/cache/mod/sub" "$TMPDIR/cache/mod" "$TMPDIR/cache"';

async function trialOf(exit: boolean) {
  const scratch = await temporaryDirectory('trial-serve-output', tmpdir());
  const root = join(scratch, 'repo');
  mkdirSync(root, { recursive: true });
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  gitIn(root, 'init', '-q', '-b', 'main');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { build: readOnlyBuild, test: 'node --eval 0' } }));
  write('graphyard.json', JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.js', url: `http://127.0.0.1:${port}`, readySeconds: 3 } } }));
  write('serve.js', printer(exit));
  write('e2e/cases/home.json', JSON.stringify(homeCase));
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const head = gitIn(root, 'rev-parse', 'HEAD');
  const merged = await trialMerge(args => defaultChildRun('git', ['-C', root, ...args]), { head, baseTip: head });
  assert.ok('mergeSha' in merged);
  const runDirectory = join(scratch, 'run'), temporaryRoot = join(scratch, 'tmp');
  mkdirSync(runDirectory); mkdirSync(temporaryRoot);
  const run = await runMergeTrial({ root, base: join(scratch, 'managed'), mergeSha: merged.mergeSha, changedFiles: ['serve.js'], proofs: [], e2eProofs: ['e2e:home'], proofFiles: [],
    timeoutMs: 180_000, key: 'GY-3343', environment: { PATH: process.env.PATH!, HOME: process.env.HOME! }, retries: 0, runDirectory, temporaryRoots: [temporaryRoot] });
  return { run, runDirectory, temporaryRoot };
}

function assertKept(run: Awaited<ReturnType<typeof trialOf>>['run'], runDirectory: string, why: RegExp) {
  assert.equal(run.build, 'pass', run.logTail);
  const [entry] = run.e2e ?? [];
  assert.ok(entry, JSON.stringify(run));
  assert.equal(entry.failed, 1);
  assert.match(entry.failingStep ?? '', why);
  assert.match(entry.failingStep ?? '', /ran from \d{4}-\d\d-\d\dT[\d:.]+Z to \d{4}-\d\d-\d\dT[\d:.]+Z/, 'the time the command ran');
  assert.deepEqual(entry.output, Array.from({ length: 40 }, (_, index) => `serve line ${index + 61}`), 'the last 40 lines ride the trial result');
  const logs = readdirSync(runDirectory).filter(name => name.startsWith('serve-'));
  assert.equal(logs.length, 1, `one serve log in the run directory: ${readdirSync(runDirectory).join(', ')}`);
  assert.match(entry.failingStep ?? '', new RegExp(logs[0]!.replace(/\./g, '\\.')));
  assert.deepEqual(readFileSync(join(runDirectory, logs[0]!), 'utf8').trimEnd().split('\n'), Array.from({ length: 100 }, (_, index) => `serve line ${index + 1}`), 'all 100 lines are kept');
}

function assertNoLeftover(run: Awaited<ReturnType<typeof trialOf>>['run'], temporaryRoot: string) {
  assert.equal(run.leftover, undefined, run.leftover);
  assert.deepEqual(readdirSync(temporaryRoot), [], 'the read-only scratch tree is fully removed');
}

test('e2e:trial-serve-output-kept — a serve command that never answers keeps its output and the read-only scratch goes', async () => {
  const { run, runDirectory, temporaryRoot } = await trialOf(false);
  assertKept(run, runDirectory, /did not answer .* within 3s/);
  assertNoLeftover(run, temporaryRoot);
});

test('e2e:trial-serve-output-kept — a serve command that exits early keeps its output the same way', async () => {
  const { run, runDirectory, temporaryRoot } = await trialOf(true);
  assertKept(run, runDirectory, /the serve command ended \(status 3\)/);
  assertNoLeftover(run, temporaryRoot);
});
