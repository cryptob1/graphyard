import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateRecordPath, readGateRecord } from '../src/batch-gate.js';
import { mergeWriterIdle } from '../src/daemon/cycle-merge-writer.js';
import { deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import { cycleUntil, deployPass, git, pipelineWorld, rollout, worldLoop } from './helpers/pipeline-world.js';

// GY-3152 AC-1 (GY-3120, GY-3151): two reviewed heads trial at once on the real loop. When one
// lands, the other — its candidate's base now behind main — is re-merged onto the new tip on a
// clean rebase and pushed: never refused as "candidate changed", never trialled a second time.

test('e2e:pipeline-concurrent-merge — two reviewed heads trial at once; the second lands on the first one\'s tip with exactly one trial each and no candidate-changed refusal', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('pipeline-concurrent-merge');
  try {
    await rollout(world);
    const first = await world.submit('First change', { 'first.txt': 'first\n' });
    const second = await world.submit('Second change', { 'second.txt': 'second\n' });
    const loop = worldLoop(world, { gate: false });
    await loop.cycle();
    assert.deepEqual(loop.state.mergeWriter.inFlights?.map(entry => entry.key).sort(), [first.key, second.key].sort(), 'both heads are in flight at once');
    await mergeWriterIdle(loop.state);
    await cycleUntil(loop, 'both items delivered', async () => (await world.work()).filter(item => item.stage === 'done').length === 2);

    const trials = world.trialLog.filter(entry => entry.key !== 'batch-gate');
    assert.deepEqual(trials.map(entry => entry.key).sort(), [first.key, second.key].sort(), 'exactly one trial per head');
    const [a, b] = trials;
    assert.ok(a!.startedAt < b!.endedAt! && b!.startedAt < a!.endedAt!, 'the two trials ran at the same time');
    const done = await world.work();
    for (const item of done) {
      assert.ok(!(item.mergeLedger?.refusal?.reason ?? '').includes('candidate changed'), `${item.key} was not refused as candidate changed`);
      assert.equal(item.mergeLedger?.state, 'reconciled');
    }
    // main's first-parent chain holds both merges, the later on top of the earlier.
    const chain = git(world.origin, 'rev-list', '--first-parent', 'main').split('\n');
    const merges = done.map(item => item.delivery!.mergeSha).sort((x, y) => chain.indexOf(x) - chain.indexOf(y));
    assert.deepEqual(chain.slice(0, 3), [...merges, world.base], 'both land on main, one after the other');
    assert.equal(git(world.origin, 'rev-parse', `${merges[0]}^1`), merges[1], 'the later merge was made on the earlier one\'s tip');
    assert.ok(git(world.origin, 'show', `${merges[0]}:first.txt`) && git(world.origin, 'show', `${merges[0]}:second.txt`), 'main holds both changes');

    // The batch gate verifies the tip both landed on, and only then does the deploy watch serve it.
    assert.equal(await deployPass(world), 'unchanged', 'the unverified tip is not served');
    loop.gating(true);
    await cycleUntil(loop, 'the gate verifies main', () => readGateRecord(gateRecordPath(world.checkout))?.verified === world.main());
    assert.equal(await deployPass(world), 'deployed');
    assert.equal(readDeployRecord(deployRecordPath(world.checkout))?.tip, world.main());
  } finally { await world.close(); }
});
