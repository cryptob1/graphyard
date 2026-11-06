import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gateRecordPath, readGateRecord } from '../src/batch-gate.js';
import { deployRecordPath, readDeployRecord, releaseHandover, watchMain } from '../src/deploy-watch.js';
import { cycleUntil, git, pipelineWorld, repository, rollout, watchPorts, worldLoop } from './helpers/pipeline-world.js';

// GY-3152 AC-4 (GY-3123, GY-3136, GY-3137): the deploy watch over the real loop's gate. A merged
// tip the gate has not verified is fetched and never served; once the gate verifies it, the watch
// serves it, and since that commit carries new watch code the watch hands itself over: the
// successor runs the served commit's code and neither rebuilds nor redeploys it.

test('e2e:pipeline-deploy-handover — the deploy watch serves only the gate-verified commit and hands itself over to the watch code it serves', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('pipeline-deploy-handover', { 'src/deploy-watch.js': 'export const watch = 1;\n' });
  const record = deployRecordPath(world.checkout), served = () => readDeployRecord(record)?.tip ?? null;
  const built: string[] = [];
  /** One watch process running the code of the tree checked out at `commit`, as the launcher's published pointer loads it; one pass. */
  const watchProcess = async (commit: string) => {
    const tree = join(world.root, `release-${commit.slice(0, 12)}`);
    if (!existsSync(tree)) git(world.checkout, 'worktree', 'add', '--detach', '--quiet', tree, commit);
    let stopped = false;
    const pass = watchMain(record, watchPorts(world, built), { intervalMs: 10, once: true, repository, log: () => {},
      handover: releaseHandover(() => git(tree, 'rev-parse', 'HEAD'), () => { stopped = true; }) });
    return { pass, stopped: () => stopped };
  };
  try {
    await rollout(world);
    // The rollout's commit serves: the first pass has nothing to deploy.
    await (await watchProcess(world.base)).pass;
    assert.deepEqual(built, []);

    const change = await world.submit('New deploy-watch code', { 'src/deploy-watch.js': 'export const watch = 2;\n' });
    const loop = worldLoop(world, { gate: false });
    await cycleUntil(loop, `${change.key} lands`, async () => (await world.work()).find(item => item.id === change.id)?.stage === 'done');
    const tip = world.main();
    // The merged tip is unverified: the watch fetches it and serves nothing new.
    await (await watchProcess(world.base)).pass;
    assert.equal(git(world.checkout, 'rev-parse', 'refs/remotes/origin/main'), tip, 'the watch fetched the merged tip');
    assert.notEqual(served(), tip, 'an unverified tip is never served');
    assert.deepEqual(built, [], 'nor built');

    loop.gating(true);
    await cycleUntil(loop, 'the gate verifies the merged tip', () => readGateRecord(gateRecordPath(world.checkout))?.verified === tip);
    const old = await watchProcess(world.base);
    await assert.rejects(old.pass, (error: Error & { releaseHandover?: boolean }) => error.releaseHandover === true && error.message.includes(`hands itself over to ${tip.slice(0, 12)}`));
    assert.ok(old.stopped(), 'the old watch stops');
    assert.equal(served(), tip, 'the verified commit is served before the handover');
    assert.deepEqual(built, [tip]);
    assert.equal(git(world.origin, 'show', `${tip}:src/deploy-watch.js`), 'export const watch = 2;', 'the served commit carries the new watch code');

    // The successor runs the served commit's code: nothing to hand over, nothing redeployed.
    const successor = await watchProcess(tip);
    await successor.pass;
    assert.equal(successor.stopped(), false);
    assert.equal(served(), tip);
    assert.deepEqual(built, [tip], 'the successor neither rebuilds nor redeploys the served commit');
    assert.equal(readDeployRecord(record)?.failed ?? null, null);
  } finally { await world.close(); }
});
