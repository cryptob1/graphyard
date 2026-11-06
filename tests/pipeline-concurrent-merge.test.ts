import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { gateRecordPath, readGateRecord } from '../src/batch-gate.js';
import { mergeWriterIdle } from '../src/daemon/cycle-merge-writer.js';
import { deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import { coordinatorToken, cycleUntil, deployPass, git, pipelineWorld, rollout, worldLoop } from './helpers/pipeline-world.js';

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

// GY-3164 AC-1: the same loop, a head whose review gate has not passed. Its trial starts as soon as
// the build gate passed, the passing trial is kept for exactly that head while review stands open,
// and once the same head is approved it lands on the kept result — one trial in all, everything
// recorded through the real plane's merge-record route.

test('e2e:pipeline-concurrent-merge — a build-passed head whose review gate has not passed trials beside its review, keeps the passing trial without landing, and lands on it once the same head is approved, with one trial in all', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('pipeline-concurrent-review');
  try {
    await rollout(world);
    const post = async (token: string, path: string, body: unknown, key: string) => {
      const response = await fetch(`${world.url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
      const text = await response.text();
      if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${text}`);
      return JSON.parse(text);
    };
    // A sensitive delta (the generic policy's Dockerfile rule): its review gate holds until an exact approval of this head.
    const item = await world.submit('Container image', { Dockerfile: 'FROM scratch\n' }, { unreviewed: true });
    const head = item.candidate!.sha;
    const loop = worldLoop(world, { gate: false });
    await loop.cycle();
    assert.equal(loop.state.mergeWriter.inFlights?.map(entry => entry.key).join(), item.key, 'the unreviewed head is trialling while its review gate has not passed');
    await mergeWriterIdle(loop.state);
    await loop.cycle();
    // The trial passed and settled as kept: nothing landed, the head holds its result, the queue holds the head.
    const kept = (await world.work()).find(entry => entry.key === item.key)!;
    assert.equal(kept.mergeLedger?.state, 'refused');
    assert.ok(kept.mergeLedger!.refusal!.reason.startsWith('trial passed ahead of review'), kept.mergeLedger!.refusal!.reason);
    assert.equal(kept.mergeLedger!.trial?.head, head, 'the fold keeps the passing trial for the head');
    assert.equal(world.main(), world.base, 'an unapproved head never lands');
    assert.deepEqual(loop.state.mergeWriter.queue, [], 'the head is owed nothing while its review gate has not passed');
    // The same head is approved through the plane's review route: an independent reviewer's launch and verdict.
    const token = randomBytes(32).toString('hex');
    await post(coordinatorToken, `work/${item.id}/review-launch`, { reviewer: 'fixture-reviewer', head, baseTip: item.candidate!.baseSha, tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, randomUUID());
    await post(token, `work/${item.id}/review-verdict`, { event: 'APPROVE', body: `Reviewed head ${head} against merge base ${item.candidate!.baseSha}. AC-1 met.`, sha: head, token }, randomUUID());
    const approved = (await world.work()).find(entry => entry.key === item.key)!;
    assert.equal(approved.gates.find(gate => gate.name === 'review')!.passed, true, 'the approval passes the review gate for this head');
    // The landing flight reuses the kept trial: no second trial, one push, delivered.
    await cycleUntil(loop, 'the approved head lands on its kept trial', async () => (await world.work()).find(entry => entry.key === item.key)!.stage === 'done');
    const done = (await world.work()).find(entry => entry.key === item.key)!;
    assert.equal(done.mergeLedger?.state, 'reconciled');
    assert.equal(done.delivery!.mergeSha, done.mergeLedger!.mergeSha);
    assert.equal(world.trialLog.filter(entry => entry.key === item.key).length, 1, 'the kept result is reused: exactly one trial for the head');
    assert.notEqual(world.main(), world.base, 'the approved head landed');
    assert.ok(git(world.origin, 'show', `${done.delivery!.mergeSha}:Dockerfile`) !== null, 'main holds the change');
  } finally { await world.close(); }
});
