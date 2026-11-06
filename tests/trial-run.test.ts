import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { adoptTrialRun, launchTrialRun, stopTrialRun, trialRunsDirectory, type TrialRunSpec } from '../src/merge-writer/trial-run.js';
import { runFiles } from '../src/runner/pi.js';

// GY-3159: the detached trial run itself. A real `node` child of the running code runs the merge
// trial exactly as the loop's own trial port would, records each step as it reaches it, and writes
// its verdict to its directory — where the loop that started it and a loop that adopts it after a
// restart read the same files. The fixture repository declares no checks, so the trial needs no
// container: its verdict is its own pass, reached in its own process, beside the loop's life.

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

/** A repository with no package.json, no graphyard.json and no checks: its trial passes in its own process without a container. */
async function repository(label: string) {
  const root = await temporaryDirectory(label), base = await temporaryDirectory(`${label}-base`);
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'file'), 'content\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  return { root, base, mergeSha: git(root, 'rev-parse', 'HEAD') };
}

const specOf = (repository: { root: string; base: string; mergeSha: string }): TrialRunSpec =>
  ({ version: 1, key: 'GY-1', head: repository.mergeSha, mergeSha: repository.mergeSha, baseTip: null, changedFiles: ['file'],
    proofs: [], e2eProofs: [], timeoutMs: 120_000, reproduce: false, cores: null, root: repository.root, base: repository.base, hidden: [], startedAt: new Date().toISOString() });

test('unit:trial-run-detached — a merge trial launched as a detached run records its steps and its verdict in its own directory, and the loop that watches it reads exactly that; the run a restart left is adopted from its recorded verdict without a new process', { timeout: 120_000 }, async () => {
  const fixture = await repository('trial-run-verdict');
  const runsRoot = trialRunsDirectory(fixture.root);
  const steps: string[] = [];
  const handle = launchTrialRun({ runsRoot, spec: specOf(fixture), pollMs: 100 });
  for (let waited = 0; !existsSync(join(handle.directory, 'spec.json')) && waited < 10_000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  const verdict = await handle.trial(step => steps.push(step));
  assert.equal(verdict.build, 'pass', JSON.stringify(verdict));
  assert.ok(steps.includes('checkout'), `the watcher reported the run's own steps: ${steps.join(', ')}`);
  const recorded = JSON.parse(await readFile(join(handle.directory, 'result.json'), 'utf8')) as { ok: boolean };
  assert.equal(recorded.ok, true, 'the run recorded its verdict for whichever loop reads it');
  assert.deepEqual((await readdir(runsRoot)).length, 1, 'one detached run for one trial');

  // A restart left this run behind: its recorded verdict answers at once, and nothing runs again.
  const adopted = await adoptTrialRun({ key: 'GY-1', head: fixture.mergeSha, mergeSha: fixture.mergeSha, directory: handle.directory });
  assert.ok(adopted, 'a run with a recorded verdict is adoptable');
  assert.equal((await adopted!.trial()).build, 'pass', 'the adopted run answers its own recorded verdict');
  assert.deepEqual((await readdir(runsRoot)).length, 1, 'adoption launched nothing');
  assert.equal(await adoptTrialRun({ key: 'GY-1', head: fixture.mergeSha, mergeSha: '0'.repeat(40), directory: handle.directory }), null, 'a run of another merge commit is never adopted');
  assert.equal(await adoptTrialRun({ key: 'GY-1', head: fixture.mergeSha, mergeSha: fixture.mergeSha, directory: join(runsRoot, 'absent') }), null, 'a directory with no run is never adopted');
});

test('unit:trial-run-detached — a run still alive when its loop restarts is watched again from where it is: its watcher reports the step it is at now and settles on the verdict the run itself writes', { timeout: 60_000 }, async () => {
  const fixture = await repository('trial-run-alive');
  const runsRoot = trialRunsDirectory(fixture.root);
  // A run whose process is this test's own: alive, mid-trial, its verdict not yet written.
  const directory = join(runsRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  const spec = specOf(fixture);
  await writeFile(join(directory, 'spec.json'), `${JSON.stringify(spec)}\n`);
  await writeFile(runFiles(directory).meta, JSON.stringify({ version: 1, id: randomUUID(), command: process.execPath, pid: process.pid, identity: null, containment: 'setsid', unit: null, startedAt: spec.startedAt, timeoutMs: spec.timeoutMs, exitGraceMs: 0 }));
  await writeFile(join(directory, 'steps.jsonl'), `${JSON.stringify({ step: 'checkout', at: spec.startedAt })}\n${JSON.stringify({ timing: 'checkout', durationMs: 4 })}\n${JSON.stringify({ step: 'install', at: spec.startedAt })}\n`);
  const adopted = await adoptTrialRun({ key: 'GY-1', head: spec.head, mergeSha: spec.mergeSha, directory });
  assert.ok(adopted, 'a run whose process is alive is adopted and watched again');
  const seen: string[] = [], timings: [string, number][] = [];
  const watching = adopted!.trial(step => seen.push(step), (step, durationMs) => timings.push([step, durationMs]));
  for (let waited = 0; !seen.length && waited < 5_000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(seen, ['install'], 'the adopting watcher reports where the run is now, not the steps already past');
  assert.deepEqual(timings, [], 'a past timing is not replayed either');
  await writeFile(join(directory, 'steps.jsonl'), `${JSON.stringify({ step: 'tests', at: spec.startedAt })}\n${JSON.stringify({ timing: 'tests', durationMs: 9 })}\n`, { flag: 'a' });
  await writeFile(join(directory, 'result.json'), `${JSON.stringify({ ok: true, run: { build: 'pass', tests: { passed: 0, failed: [], files: 0 }, durationMs: 1, logTail: '', files: [], proofs: {} } })}\n`);
  assert.equal((await watching).build, 'pass', 'the run\'s own verdict settles its watcher');
  assert.deepEqual(seen, ['install', 'tests'], 'each step the run records from here on is reported');
  assert.deepEqual(timings, [['tests', 9]]);
});

test('unit:trial-run-detached — a run whose process is gone without a verdict is not adoptable, and a run nobody will read is stopped with its reason recorded', { timeout: 120_000 }, async () => {
  const fixture = await repository('trial-run-dead');
  const runsRoot = trialRunsDirectory(fixture.root);
  // A dead process that recorded no verdict: the fallback the merge writer takes instead of adopting.
  const directory = join(runsRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  const spec = specOf(fixture);
  await writeFile(join(directory, 'spec.json'), `${JSON.stringify(spec)}\n`);
  const dead = { version: 1, id: randomUUID(), command: process.execPath, pid: 999_999, identity: null, containment: 'setsid', unit: null, startedAt: spec.startedAt, timeoutMs: spec.timeoutMs, exitGraceMs: 0 };
  await writeFile(runFiles(directory).meta, JSON.stringify(dead));
  assert.equal(await adoptTrialRun({ key: 'GY-1', head: spec.head, mergeSha: spec.mergeSha, directory }), null, 'a run whose process is gone without a verdict is never adopted');

  // A live run nobody will read is stopped, and its reason is recorded beside it.
  const handle = launchTrialRun({ runsRoot, spec: specOf(fixture), pollMs: 100 });
  for (let waited = 0; !existsSync(join(handle.directory, 'spec.json')) && waited < 10_000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  await stopTrialRun({ directory: handle.directory });
  for (let waited = 0; !existsSync(runFiles(handle.directory).stopped) && waited < 10_000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(JSON.parse(readFileSync(runFiles(handle.directory).stopped, 'utf8')), { reason: 'cancelled', detail: 'the head it trials no longer awaits its merge' });
  await assert.rejects(handle.trial(), /The trial was cancelled/, 'the watcher of a stopped run settles cancelled at once');
});
