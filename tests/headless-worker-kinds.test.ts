import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headlessWorkerWorld } from './helpers/headless-worker-world.js';
import { runtimeKinds } from '../src/master/runtimes.js';
import { workerRunsDirectory } from '../src/headless-session.js';

// GY-3259's runtime matrix, second half (GY-3290): the merge trial bounds one test file at five
// minutes, and twenty-three real headless runs — a worktree, a claim, a commit and a submit each —
// do not fit that beside the handoff scenarios on a loaded host. The first kinds and the handoff
// scenarios are tests/headless-workers.test.ts; these are the rest, under the same world
// (tests/helpers/headless-worker-world.ts).
const half = Math.ceil(runtimeKinds.length / 2);

let world: Awaited<ReturnType<typeof headlessWorkerWorld>>;
before(async () => { world = await headlessWorkerWorld('headless-worker-kinds'); });
after(async () => { if (world) await world.stop(); });

for (const [index, kind] of runtimeKinds.slice(half).entries()) test(`e2e:headless-workers — ${kind} claims, commits and completes as one headless run`, async () => {
  await world.configure([{ name: kind, kind }]);
  const work = await world.readyItem(`GY-${9600 + half + index}`);
  const launched = await world.dispatch(work);
  assert.equal(launched.epoch, 1);
  assert.equal(launched.runtime, kind);
  assert.match(launched.run, /^[0-9a-f-]{36}$/);
  const item = await world.submitted(work.id, 1);
  assert.equal(item.lease, null, 'complete ended the lease');
  assert.equal(item.workspaces[0]?.owner, 'worker-a', 'the worker claimed under its own identity');
  const argv = (await world.started(kind)).args as string[];
  assert.equal(argv[0], 'one-task');
  assert.ok(!argv.includes('--interactive-must-not-appear'));
  assert.equal(argv.filter(word => word.includes(`complete ${work.key} 1 --head`)).length, 1, 'the brief is the one request on the command line');
  assert.equal((await world.started(kind)).tty, false);
  assert.equal((await world.started(kind)).cwd, item.workspaces[0]!.path);
  // The durable run record names the work, epoch, principal, account and runtime, outside the worktree.
  const record = JSON.parse(await readFile(join(workerRunsDirectory(world.root), launched.run, 'session.json'), 'utf8'));
  assert.deepEqual([record.work, record.epoch, record.principal, record.account, record.kind], [work.key, 1, 'worker-a', kind, kind]);
  assert.ok(!join(workerRunsDirectory(world.root), launched.run).startsWith(item.workspaces[0]!.path));
  assert.equal(world.herdrCalled(), false, 'no Herdr call is made for workers');
});
