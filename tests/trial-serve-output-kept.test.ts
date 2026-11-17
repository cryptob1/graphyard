import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { removeTree, writableDirectories } from '../src/install/worktree-root.js';
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

// Leave startup and the full trial room on a saturated host; the output and cleanup
// assertions, rather than a short wall-clock race, are the regression (GY-3386).
async function trialOf(exit: boolean) {
  const scratch = await temporaryDirectory('trial-serve-output', tmpdir());
  const root = join(scratch, 'repo');
  mkdirSync(root, { recursive: true });
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  gitIn(root, 'init', '-q', '-b', 'main');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { build: readOnlyBuild, test: 'node --eval 0' } }));
  write('graphyard.json', JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.js', url: `http://127.0.0.1:${port}`, readySeconds: 30 } } }));
  write('serve.js', printer(exit));
  write('e2e/cases/home.json', JSON.stringify(homeCase));
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const head = gitIn(root, 'rev-parse', 'HEAD');
  const merged = await trialMerge(args => defaultChildRun('git', ['-C', root, ...args]), { head, baseTip: head });
  assert.ok('mergeSha' in merged);
  const runDirectory = join(scratch, 'run'), temporaryRoot = join(scratch, 'tmp');
  mkdirSync(runDirectory); mkdirSync(temporaryRoot);
  const run = await runMergeTrial({ root, base: join(scratch, 'managed'), mergeSha: merged.mergeSha, changedFiles: ['serve.js'], proofs: [], e2eProofs: ['e2e:home'], proofFiles: [],
    // The non-answer is intentional; host overload must not replace the serve verdict.
    cpu: () => null, timeoutMs: 600_000, key: 'GY-3343', environment: { PATH: process.env.PATH!, HOME: process.env.HOME! }, retries: 0, runDirectory, temporaryRoots: [temporaryRoot] });
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
  assertKept(run, runDirectory, /did not answer .* within 30s/);
  assertNoLeftover(run, temporaryRoot);
});

test('e2e:trial-serve-output-kept — a serve command that exits early keeps its output the same way', async () => {
  const { run, runDirectory, temporaryRoot } = await trialOf(true);
  assertKept(run, runDirectory, /the serve command ended \(status 3\)/);
  assertNoLeftover(run, temporaryRoot);
});

// The merge trial of this change's first candidate failed here: while removeTree chmod-walked the
// read-only scratch, the trial image's own tooling removed a compile-cache directory beside it, and
// the walk read that vanished entry as a failed removal. A path another remover takes mid-removal
// counts as removed, exactly as Node's own rm reads ENOENT.
test('e2e:trial-serve-output-kept — a directory another remover takes mid-removal is gone, not a failed removal', async () => {
  const gone = join(tmpdir(), 'trial-serve-output-never-made');
  await removeTree(gone);
  await writableDirectories(gone);
  assert.equal(existsSync(gone), false, 'a path that was never there removes as if removed');

  const root = await temporaryDirectory('trial-serve-output-race');
  // The read-only tree that forces the chmod-walk, as Go's module cache does, made wide enough that the walk is still running when the other remover strikes.
  for (let index = 0; index < 400; index++) {
    const directory = join(root, `ro-${index}`);
    mkdirSync(join(directory, 'mod'), { recursive: true });
    writeFileSync(join(directory, 'mod', 'file'), 'x');
    chmodSync(join(directory, 'mod', 'file'), 0o444);
    chmodSync(join(directory, 'mod'), 0o555);
    chmodSync(directory, 0o555);
  }
  // The entries another process removes the moment the walk makes the root writable (it chmods the root first), as a compile cache goes from under a trial's temporary directory.
  for (let index = 0; index < 40; index++) {
    mkdirSync(join(root, `churn-${index}`), { recursive: true });
    writeFileSync(join(root, `churn-${index}`, 'blob'), 'x');
  }
  chmodSync(root, 0o555);
  const remover = spawn(process.execPath, ['-e', `
    const { readdirSync, rmSync, statSync } = require('node:fs');
    for (;;) {
      try {
        if ((statSync(process.argv[1]).mode & 0o200) === 0) continue;
        for (const name of readdirSync(process.argv[1])) if (name.startsWith('churn-')) rmSync(\`\${process.argv[1]}/\${name}\`, { recursive: true, force: true });
        process.exit(0);
      } catch { process.exit(0); }
    }`, '--', root], { stdio: 'ignore' });
  try {
    await removeTree(root);
    assert.equal(existsSync(root), false, 'the whole tree, read-only parts and raced parts alike, is removed');
  } finally { remover.kill('SIGKILL'); }
});
