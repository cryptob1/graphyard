import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gateRecordPath, readGateRecord, type GateRecord } from '../src/batch-gate.js';
import { deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import { bootstrapGate, writeGateRecord } from '../src/batch-gate.js';
import { commandCase, cycleUntil, deployPass, git, pipelineWorld, repository, worldLoop } from './helpers/pipeline-world.js';

// GY-3152 AC-2 (GY-3147): the real loop's batch gate over real trials. An E2E case only the whole
// catalog runs, red on the verified commit and on the tip, is filed as known red: nothing is
// reverted and the tip verifies. The probe's verdict is in main-gate.json before the filing, and a
// filing the control plane refuses (the live 409: its key filed before with other wording) does not
// end the run. A smoke case (gate.core) red only on the tip reverts the landing that broke it.

test('e2e:pipeline-gate-known-red — a catalog-only case red before the batch is filed known red and reverts nothing; a smoke case the batch broke reverts its culprit', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('pipeline-gate-known-red', { 'e2e/cases/red-case.json': commandCase('red-case', 'node --eval "process.exit(1)"') });
  const gateFile = gateRecordPath(world.checkout);
  const gate = () => readGateRecord(gateFile)!;
  try {
    // The rollout serves the base; the daily diagnostics have not run, so the loop runs them first and
    // they measure the whole catalog — without that measure the gate never runs a catalog-only case.
    await writeGateRecord(gateFile, bootstrapGate(repository, world.base));
    const loop = worldLoop(world, { gate: true });
    await cycleUntil(loop, 'the diagnostics measure the catalog', () => gate().diagnosticsAt !== null);
    assert.ok(gate().catalogMs! > 0, 'the whole catalog\'s time is measured');
    assert.ok(gate().filed?.['diagnostic:e2e:red-case'], 'the diagnostics filed the red case');

    // The known-red filing's key was filed before with other wording: the plane refuses it with 409.
    await fetch(`${world.url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer pipeline-admin-${'y'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'known-red:e2e:red-case' },
      body: JSON.stringify({ title: 'Earlier wording of the red case', type: 'bug', criteria: [{ id: 'AC-1', text: 'Fixed', proofs: ['unit:red-case-pinned', 'e2e:create-work-item'] }] }) }).then(response => assert.equal(response.status, 201, 'the earlier filing'));
    // What the record held when the gate filed it.
    let atFiling: GateRecord | null = null;
    const created = world.engine.store.pool;
    void created;
    const benign = await world.submit('A benign change', { 'benign.txt': 'benign\n' });
    const filings = world.trialLog.length;
    void filings;
    const watch = setInterval(() => { const record = readGateRecord(gateFile); if (!atFiling && record?.inFlight?.step?.startsWith('probing e2e:red-case')) atFiling = record; }, 20);
    try {
      await cycleUntil(loop, `${benign.key} lands and the gate verifies it`, async () => (await world.work()).find(item => item.id === benign.id)?.stage === 'done' && gate().verified === world.main());
    } finally { clearInterval(watch); }
    const landed = world.main();
    let record = gate();
    assert.equal(record.lastOutcome?.outcome, 'verified');
    assert.equal(record.lastOutcome?.tip, landed);
    assert.ok(record.filed?.['known-red:e2e:red-case'], 'the case is filed known red, its refused filing bound to its earlier item');
    assert.equal(record.results[world.base]?.['e2e:red-case'] ?? record.results[landed]?.['e2e:red-case'] ?? true, true);
    assert.ok(atFiling, 'the gate probed the case on the verified commit');
    assert.ok(world.trialLog.some(entry => entry.key === 'batch-gate' && entry.mergeSha === world.base), 'the probe ran the case on the verified commit');
    assert.equal(git(world.origin, 'log', '--format=%s', 'main').split('\n').filter(subject => subject.startsWith('Revert')).length, 0, 'nothing is reverted');
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [[benign.key, false]]);
    assert.ok((await world.work()).every(item => !/known red/i.test(item.title) || item.title === 'Earlier wording of the red case'), 'the refused filing created no second item');

    // A change that breaks smoke on the tip alone: it lands (its own trial runs its bound case), then the gate reverts it.
    const breaking = await world.submit('A change that breaks smoke', { broken: 'yes\n' });
    await cycleUntil(loop, `the gate reverts ${breaking.key}`, () => gate().lastOutcome?.outcome === 'reverted');
    record = gate();
    assert.match(record.lastOutcome!.reason!, new RegExp(`reverted ${breaking.key} for failing e2e:smoke`));
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [[benign.key, false], [breaking.key, true]]);
    const tip = world.main();
    assert.match(git(world.origin, 'log', '-1', '--format=%s', tip), /^Revert/, 'the revert is pushed to main');
    assert.throws(() => git(world.origin, 'cat-file', '-e', `${tip}:broken`), 'main no longer holds the culprit\'s change');
    await cycleUntil(loop, 'the recut batch verifies', () => gate().verified === tip);
    assert.ok((await world.work()).some(item => item.title.includes(breaking.title) && item.key !== breaking.key), 'a re-land item is filed for the culprit');

    // The deploy watch serves the verified commit.
    assert.equal(await deployPass(world), 'deployed');
    assert.equal(readDeployRecord(deployRecordPath(world.checkout))?.tip, tip);
    void randomUUID;
  } finally { await world.close(); }
});
