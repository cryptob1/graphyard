import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapGate, gateRecordPath, gateSummary, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import { adminToken, cycleUntil, deployPass, git, pipelineWorld, repository, worldLoop } from './helpers/pipeline-world.js';

// GY-3431: the real loop's batch gate over real trials. A batch whose only failure is a check with
// an open "Flaky check on main" item reverts nothing: the failure is recorded on that item, the
// batch verifies and is deployed, and master status names the flaky item.

test('e2e:gate-known-flaky-no-revert — a batch whose only failure is a check with an open flaky item is verified and deployed, not reverted, and master status names the flaky item', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('gate-known-flaky');
  const gateFile = gateRecordPath(world.checkout), gate = () => readGateRecord(gateFile)!;
  try {
    await writeGateRecord(gateFile, { ...bootstrapGate(repository, world.base), diagnosticsAt: new Date().toISOString() });
    const filed = await fetch(`${world.url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'flake:e2e:smoke' },
      body: JSON.stringify({ title: 'Flaky check on main: e2e:smoke', why: 'w', simplest: 's', type: 'bug', criteria: [{ id: 'AC-1', text: 'Deterministic', proofs: ['unit:smoke-pinned', 'e2e:fixture'] }] }) });
    const flaky = (await filed.json()) as { key: string };
    assert.ok(filed.ok, JSON.stringify(flaky));

    // The change fails smoke on the tip; its own trial runs only its bound case, so it lands.
    const change = await world.submit('A change the flaky smoke fails', { broken: 'yes\n' });
    const loop = worldLoop(world, { gate: true });
    await cycleUntil(loop, `${change.key} lands and the gate keeps it`, async () => (await world.work()).find(item => item.id === change.id)?.stage === 'done' && gate().verified === world.main());
    const tip = world.main(), record = gate();
    assert.deepEqual(git(world.origin, 'log', '--format=%s', 'main').split('\n').filter(subject => subject.startsWith('Revert')), [], 'nothing is reverted');
    assert.equal(record.lastOutcome?.outcome, 'verified');
    assert.equal(record.lastOutcome?.reason, `kept the batch: e2e:smoke failed and has the open flaky item ${flaky.key}`);
    assert.deepEqual(record.flaky?.[flaky.key]?.map(failure => [failure.check, failure.tip]), [['e2e:smoke', tip]], 'the failure is recorded on the flaky item');
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [[change.key, false]]);

    // The deploy watch serves the kept batch, and master status names the flaky item.
    assert.equal(await deployPass(world), 'deployed');
    assert.equal(readDeployRecord(deployRecordPath(world.checkout))?.tip, tip);
    assert.deepEqual(gateSummary(record)!.knownFlaky.map(entry => [entry.item, entry.check]), [[flaky.key, 'e2e:smoke']], 'master status names the flaky item');
  } finally { await world.close(); }
});
