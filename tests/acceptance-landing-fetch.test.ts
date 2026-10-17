import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRunnerFor, type GitRunner } from '../src/merge-writer/local-observation.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1661 AC-2: the goals route fetches the base branch from origin when its checkout's origin ref
// does not yet hold a merge-writer acceptance landing (GY-1922: one it already holds needs no fetch),
// so a merge commit pushed after the control plane's checkout last fetched is accepted rather than
// refused as unlanded; and the image carries git, which that fetch runs.
const root = fileURLToPath(new URL('..', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const identity = (cwd: string) => { git(cwd, 'config', 'user.email', 't@example.com'); git(cwd, 'config', 'user.name', 'T'); };

test('unit:acceptance-landing-fetch — a merge commit pushed after the plane last fetched is accepted once the land route fetches the base', async () => {
  // Loaded inside the test, so a tree without the fetching check fails here as a test case.
  const { acceptanceLandingRefusal, acceptanceMergeRefusal } = await import('../src/server/routes/goals.js');
  assert.equal(typeof acceptanceLandingRefusal, 'function', 'the goals route exports its fetching landing check');
  const fixture = await realpath(await temporaryDirectory('landing-fetch'));
  try {
    const origin = join(fixture, 'origin.git'), plane = join(fixture, 'plane'), writer = join(fixture, 'writer');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, writer], { stdio: 'ignore' }); identity(writer);
    await writeFile(join(writer, 'README.md'), '# base\n');
    git(writer, 'add', '-A'); git(writer, 'commit', '-q', '-m', 'base'); git(writer, 'push', '-q', 'origin', 'main');
    // The control plane's checkout fetched here, before the merge writer landed anything.
    execFileSync('git', ['clone', '-q', origin, plane], { stdio: 'ignore' });
    // The merge writer lands the approved acceptance head as a merge commit and pushes it.
    git(writer, 'checkout', '-q', '-b', 'acceptance');
    await writeFile(join(writer, 'case.json'), '{}\n');
    git(writer, 'add', '-A'); git(writer, 'commit', '-q', '-m', 'acceptance');
    const head = git(writer, 'rev-parse', 'HEAD');
    git(writer, 'checkout', '-q', 'main'); git(writer, 'merge', '-q', '--no-ff', '-m', 'land acceptance', 'acceptance');
    const mergeSha = git(writer, 'rev-parse', 'HEAD');
    git(writer, 'push', '-q', 'origin', 'main');

    const calls: string[][] = [];
    const runner = gitRunnerFor(plane), recording: GitRunner = args => { calls.push([...args]); return runner(args); };
    // Read without a fetch, the plane's stale view refuses the landing as unlanded.
    assert.match(await acceptanceMergeRefusal(runner, 'main', head, mergeSha) ?? '', /is not a merge of the approved head|does not hold/);
    // The land route's judgement fetches first, and accepts it.
    assert.equal(await acceptanceLandingRefusal(recording, 'main', head, mergeSha), null);
    assert.deepEqual(calls.find(args => args[0] === 'fetch'), ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], 'the base is fetched from origin when the checkout\'s ref does not hold the landing');
    assert.equal(git(plane, 'rev-parse', 'refs/remotes/origin/main'), mergeSha);
    // A merge that is not of the approved head is still refused after the fetch.
    assert.match(await acceptanceLandingRefusal(runner, 'main', 'd'.repeat(40), mergeSha) ?? '', /is not a merge of the approved head/);

    // GY-1922: once the plane's origin/main holds the merge, a failing fetch is never needed; a merge it
    // does not hold is refused with a retryable 503 and nothing past the failed fetch is read.
    git(plane, 'remote', 'set-url', 'origin', join(fixture, 'missing.git'));
    const judged: string[][] = [], failing: GitRunner = args => { judged.push([...args]); return runner(args); };
    assert.equal(await acceptanceLandingRefusal(failing, 'main', head, mergeSha), null);
    assert.ok(!judged.some(args => args[0] === 'fetch'), 'a ref already holding the landing is not fetched');
    judged.length = 0;
    await assert.rejects(acceptanceLandingRefusal(failing, 'main', 'd'.repeat(40), mergeSha), (error: { status?: number; message: string }) =>
      error.status === 503 && /could not fetch main from origin .*nothing is recorded until it can/s.test(error.message));
    assert.equal(judged.at(-1)?.[0], 'fetch', 'nothing past the failed fetch is read');
    // A runner that throws is a failed fetch too.
    await assert.rejects(acceptanceLandingRefusal(async () => { throw new Error('spawn git ENOENT'); }, 'main', head, mergeSha), (error: { status?: number; message: string }) => error.status === 503 && /spawn git ENOENT/.test(error.message));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('unit:acceptance-landing-fetch — a fetch that stalls is bounded and refused with the retryable 503', async () => {
  const { acceptanceLandingRefusal, acceptanceFetchTimeoutMs } = await import('../src/server/routes/goals.js');
  assert.ok(acceptanceFetchTimeoutMs > 0 && acceptanceFetchTimeoutMs < 30_000, 'the bound sits inside the loop\'s 30-second land request');
  // A runner that never answers (a stalled origin, DNS lookup, SSH negotiation or credential helper).
  const asked: { args: readonly string[]; timeoutMs?: number }[] = [];
  const stalled: GitRunner = (args, options) => { asked.push({ args, timeoutMs: options?.timeoutMs }); return args[0] === 'fetch' ? new Promise(() => {}) : Promise.resolve({ status: 1, stdout: '', stderr: 'no such ref' }); };
  const started = Date.now();
  await assert.rejects(acceptanceLandingRefusal(stalled, 'main', 'a'.repeat(40), 'b'.repeat(40), 200), (error: { status?: number; message: string }) =>
    error.status === 503 && /could not fetch main from origin .*\(git fetch did not finish within 200ms\)/.test(error.message));
  assert.ok(Date.now() - started < 5_000, 'the route stops waiting at the bound');
  const fetches = asked.filter(call => call.args[0] === 'fetch');
  assert.equal(fetches.length, 1); assert.ok(fetches[0].timeoutMs! > 0 && fetches[0].timeoutMs! <= 200, 'the runner is asked to kill git within the same bound');
  assert.equal(asked.at(-1)!.args[0], 'fetch', 'nothing past the fetch is read');
  // GY-1922: a stalled read of the checkout's own ref is bounded by the same deadline.
  await assert.rejects(acceptanceLandingRefusal(() => new Promise(() => {}), 'main', 'a'.repeat(40), 'b'.repeat(40), 200), (error: { status?: number; message: string }) =>
    error.status === 503 && /\(reading refs\/remotes\/origin\/main did not finish within 200ms\)/.test(error.message));

  // The default runner kills a git that outlasts its bound and says so.
  const fixture = await realpath(await temporaryDirectory('landing-fetch-timeout'));
  try {
    execFileSync('git', ['init', '-q', fixture]);
    const result = await gitRunnerFor(fixture)(['-c', 'alias.hang=!sleep 5', 'hang'], { timeoutMs: 200 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /git -c was stopped after 200ms|was stopped after 200ms/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('unit:acceptance-landing-fetch — the land route judges through the fetching check, and the image installs git', async () => {
  const route = await readFile(join(root, 'src/server/routes/goals.ts'), 'utf8');
  assert.match(route, /const refusal = await acceptanceLandingRefusal\(engine\.gitRunner, engine\.baseBranch, goal\.approval\.head, body\.mergeSha\)/);
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  assert.match(runtime, /\nRUN apt-get update && apt-get install -y [^\n]*\bgit\b/, 'the runtime stage, not only the build stage, installs git');
});
