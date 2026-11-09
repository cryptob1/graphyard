import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mergeWriterIdle, mergeWriterStep } from '../src/daemon/cycle-merge-writer.js';
import { coordinatorToken, cycleUntil, loopReads, pipelineWorld, rollout, worldLoop } from './helpers/pipeline-world.js';

// GY-3205: a head's trial passes ahead of review and its flight settles as kept after the cycle's
// snapshot was read, so that snapshot still shows the flight's intent open. The same cycle's
// reconcile used to settle that intent as a plain refusal, which replaced the kept-trial marker and
// queued the head for a whole second trial. The real merge writer runs here over a real temporary
// Postgres plane and a scratch remote; the head is trialled exactly once.

test('e2e:merge-kept-trial-once — a trial that passes ahead of review, settled in a cycle whose snapshot still shows its intent open, keeps its marker: no second trial while review is pending, and the approved head lands on the kept result', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('merge-kept-trial-once');
  try {
    await rollout(world);
    const post = async (token: string, path: string, body: unknown, key: string) => {
      const response = await fetch(`${world.url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
      const text = await response.text();
      if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${text}`);
      return JSON.parse(text);
    };
    const current = async () => (await world.work()).find(entry => entry.key === item.key)!;
    // A sensitive delta (the generic policy's Dockerfile rule): its review gate holds until an exact approval of this head.
    const item = await world.submit('Container image', { Dockerfile: 'FROM scratch\n' }, { unreviewed: true });
    const head = item.candidate!.sha;
    const loop = worldLoop(world, { gate: false });
    await loop.cycle();
    assert.equal(loop.state.mergeWriter.inFlights?.map(entry => entry.key).join(), item.key, 'the unreviewed head is trialling');
    // The next cycle reads its snapshot while the trial runs — the intent is open — and the flight settles before the merge writer step.
    for (let waited = 0; (await current()).mergeLedger?.state !== 'intent' && waited < 60_000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
    const stale = { work: await world.work(), now: new Date().toISOString() };
    assert.equal(stale.work.find(entry => entry.key === item.key)!.mergeLedger?.state, 'intent', 'the snapshot shows the flight\'s intent open');
    await mergeWriterIdle(loop.state);
    const effects = { mergeWriter: loopReads({ ...world, snapshot: world.work }, { gate: false }), persist: async () => {}, rework: async () => {} };
    await mergeWriterStep({ config: world.config, state: loop.state, effects, now: Date.now, snapshot: stale, performed: [] } as never);

    const kept = await current();
    assert.equal(kept.mergeLedger?.state, 'refused');
    assert.ok(kept.mergeLedger!.refusal!.reason.startsWith('trial passed ahead of review'), `the kept-trial marker is the ledger's last word: ${kept.mergeLedger!.refusal!.reason}`);
    assert.equal(kept.mergeLedger!.trial?.head, head, 'the passing trial is kept for the head');
    for (const action of Object.values(loop.state.actions)) assert.ok(!/Settled an open intent/.test(action.detail ?? ''), `the reconcile left the settled flight's intent alone: ${action.detail}`);
    // While review is pending the head is owed nothing: further cycles start no trial.
    for (let cycles = 0; cycles < 3; cycles++) { await loop.cycle(); await mergeWriterIdle(loop.state); }
    assert.equal(world.trialLog.filter(entry => entry.key === item.key).length, 1, 'no second trial while the review is pending');
    assert.equal(world.main(), world.base, 'an unapproved head never lands');

    // The same head is approved: it lands on the kept result.
    const token = randomBytes(32).toString('hex');
    await post(coordinatorToken, `work/${item.id}/review-launch`, { reviewer: 'fixture-reviewer', head, baseTip: item.candidate!.baseSha, tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, randomUUID());
    await post(token, `work/${item.id}/review-verdict`, { event: 'APPROVE', body: `Reviewed head ${head} against merge base ${item.candidate!.baseSha}. AC-1 met.`, sha: head, token }, randomUUID());
    await cycleUntil(loop, 'the approved head lands on its kept trial', async () => (await current()).stage === 'done');
    assert.equal((await current()).mergeLedger?.state, 'reconciled');
    assert.equal(world.trialLog.filter(entry => entry.key === item.key).length, 1, 'exactly one trial run for the head');
    assert.notEqual(world.main(), world.base, 'the approved head landed');
  } finally { await world.close(); }
});
