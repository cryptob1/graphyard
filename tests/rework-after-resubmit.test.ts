import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { itemLine } from '../src/cli/master-status.js';
import { trialFailureRework } from '../src/daemon/cycle-merge-writer.js';
import type { Principal, Work } from '../src/model.js';

// GY-3582: the loop's resubmission of a finished head (GY-3335/GY-3576) raises the item's epoch
// and records its submission there, while the candidate keeps the branch the blocked attempt's
// workspace held — no workspace stands at the submission's epoch. When the merge trial then
// refused the head, the rework launch looked for the linked branch among the submission epoch's
// workspaces, found none and refused every branch: each resubmitted item that needed rework was
// stranded with no actor. The linked branch is the submitted candidate's branch, falling back to
// the submission epoch's workspace, so the rework worker reserves the same branch the candidate
// used and completes on it.

const proof = 'integration:rework-after-resubmit';

test(`${proof} — the rework of a resubmitted head reserves the candidate's branch, and a worker completes on it`, { timeout: 120_000 }, async t => {
  const base = await realpath(await temporaryDirectory('rework-after-resubmit'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = join(base, 'origin.git'), checkout = join(base, 'checkout'), branch = 'graphyard/gy-1-1';
  const attempt = join(checkout, '.graphyard', 'worktrees', 'GY-1-1'), rework = join(checkout, '.graphyard', 'worktrees', 'GY-1-3');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await mkdir(join(checkout, 'src', 'store'), { recursive: true });
  await writeFile(join(checkout, 'README.md'), '# Fixture\n'); git(checkout, 'add', 'README.md'); git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'push', '-q', 'origin', 'main'); git(checkout, 'fetch', '-q', 'origin');
  git(checkout, 'worktree', 'add', '-q', '-b', branch, attempt);
  // A store change is sensitive under the test process's policy, so every head here owes its
  // review: the resubmitted one and the rework's new one both continue through the same gates.
  const commit = async (cwd: string, path: string, text: string, message: string) => {
    await mkdir(join(cwd, path, '..'), { recursive: true });
    await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const head = await commit(attempt, 'src/store/finished.ts', 'export const finished = 1;\n', 'the finished head');

  const store = await withDatabase('rework-after-resubmit');
  await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project');
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  const operator: Principal = { id: 'operator', role: 'admin' }, worker: Principal = { id: 'worker', role: 'worker' }, loop: Principal = { id: 'loop', role: 'coordinator' };
  const run = (actor: Principal, command: string, id: string | null, data: unknown) => engine.execute(actor, command as never, id, data, randomUUID());

  let work: Work = await run(operator, 'create', null, { type: 'bug', title: 'Stranded rework', criteria: [{ id: 'AC-1', text: 'Reworked on the resubmitted branch', proofs: [proof, 'e2e:rework-after-resubmit'] }] });
  work = await run(operator, 'ready', work.id, {});
  const first = await engine.pullAssignment(worker, { work: work.id }, randomUUID());
  assert.equal(first.assigned?.id, work.id, JSON.stringify(first.refused));
  work = await run(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: attempt, branch });
  // The worker's complete failed on a host fault; the loop resubmits the finished head (GY-3335).
  work = await run(worker, 'blocked', work.id, { epoch: 1, reason: 'complete failed: the trial host has no image', finishedHead: head });
  work = await run(operator, 'unblock', work.id, { reason: 'the trial host is repaired' });
  work = await run(loop, 'resubmit', work.id, { head });
  assert.equal(work.submission?.epoch, 2, 'the resubmission is the item\'s next attempt');
  assert.equal(work.candidate?.branch, branch, 'the candidate keeps the blocked attempt\'s branch');
  assert.equal(work.workspaces.some(entry => entry.epoch === 2), false, 'and registers no workspace at the submission\'s epoch');

  // The merge trial refuses the head; the loop applies the rework its refusal grounds.
  const grounded = trialFailureRework(work, head, 'trial failed: the merge conflicts in src/store/finished.ts');
  work = await run(operator, 'rework', work.id, { reason: grounded.reason, ...grounded.input });
  assert.equal(work.reworkRequested, true);
  assert.equal(work.stage, 'build', 'the item is back at build');
  assert.doesNotThrow(() => assertDispatchable(work, [work], new Date().toISOString()), 'one dispatch takes the item');

  const second = await engine.pullAssignment(worker, { work: work.id }, randomUUID());
  assert.equal(second.assigned?.id, work.id, JSON.stringify(second.refused));
  work = second.assigned!;
  const epoch = work.lease!.epoch;
  assert.equal(epoch, 3, 'the rework claim is the attempt after the resubmission');

  // A different branch is still refused: the rework must use the already linked PR branch.
  await assert.rejects(run(worker, 'workspace', work.id, { epoch, host: 'test', path: rework, branch: 'graphyard/gy-1-rework' }), /Rework must use the already linked PR branch in a fresh workspace/);
  // The candidate's branch is reserved — the reservation every rework launch of a resubmitted item failed to make.
  work = await run(worker, 'workspace', work.id, { epoch, host: 'test', path: rework, branch });
  const reserved = work.workspaces.at(-1)!;
  assert.deepEqual({ epoch: reserved.epoch, branch: reserved.branch, path: reserved.path }, { epoch, branch, path: rework }, 'the rework workspace holds the candidate\'s branch');
  // Master status shows the item at build with the worker on it.
  const line = itemLine(work, Date.now());
  assert.deepEqual({ stage: line.stage, owner: line.owner }, { stage: 'Building', owner: 'worker' });

  // The reserved workspace is a worktree on the candidate's branch: the worker syncs, commits and completes on it.
  git(attempt, 'checkout', '-q', '--detach'); // the launcher detaches the earlier attempt's hold on the branch
  git(checkout, 'worktree', 'add', '-q', rework, branch);
  git(rework, 'merge', '-q', '--no-edit', 'origin/main'); // what sync GY-1 runs on the reserved branch
  const reworked = await commit(rework, 'src/store/finished.ts', 'export const finished = 2;\n', 'the rework: resolve the conflict');
  assert.notEqual(reworked, head, 'the rework\'s head is new work on the same branch');
  work = await run(worker, 'submit', work.id, { epoch, head: reworked });
  assert.equal(work.submission?.epoch, epoch, 'the rework completes as its own attempt');
  assert.equal(work.candidate?.sha, reworked);
  assert.equal(work.candidate?.branch, branch, 'the reworked head is submitted on the candidate\'s branch');
  assert.equal(work.reworkRequested, false);
  assert.equal(work.lease, null);
  assert.equal(work.stage, 'review', 'the reworked head continues through the gates as any submission');
});
