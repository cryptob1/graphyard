import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapGate, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import { adminToken, commandCase, cycleUntil, deployPass, git, pipelineWorld, repository, worldLoop } from './helpers/pipeline-world.js';

// GY-3152 AC-2 (GY-3147): the real loop's batch gate over real trials. An E2E case only the whole
// catalog runs, red on the verified commit and on the tip, is filed as known red: nothing is
// reverted and the tip verifies. The probe's verdict is in main-gate.json before the filing, and a
// filing the control plane refuses (the live 409: its key filed before with other wording) does not
// end the run. A smoke case (gate.core) red only on the tip reverts the landing that broke it.

test('e2e:pipeline-gate-known-red — a catalog-only case red before the batch is filed known red and reverts nothing; a smoke case the batch broke reverts its culprit', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('pipeline-gate-known-red', { 'e2e/cases/red-case.json': commandCase('red-case', 'node --eval "process.exit(1)"') });
  const gateFile = gateRecordPath(world.checkout), gate = () => readGateRecord(gateFile)!;
  const reverts = () => git(world.origin, 'log', '--format=%s', 'main').split('\n').filter(subject => subject.startsWith('Revert'));
  try {
    // The rollout serves the base. The daily diagnostics have not run, so the loop runs them first and
    // they measure the whole catalog: without that measure no gate runs a case no item binds.
    await writeGateRecord(gateFile, bootstrapGate(repository, world.base));
    const loop = worldLoop(world, { gate: true });
    await cycleUntil(loop, 'the diagnostics measure the catalog', () => gate().diagnosticsAt !== null);
    assert.ok(gate().catalogMs !== null, 'the whole catalog\'s time is measured');
    assert.ok(gate().filed?.['diagnostic:e2e:red-case'], 'the diagnostics filed the red case');

    // The known-red filing's key was filed before with other wording, so the plane refuses it (409).
    const earlier = await fetch(`${world.url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'known-red:e2e:red-case' },
      body: JSON.stringify({ title: 'Earlier wording of the red case', type: 'bug', criteria: [{ id: 'AC-1', text: 'Fixed', proofs: ['unit:red-case-pinned', 'e2e:create-work-item'] }] }) });
    assert.ok(earlier.ok, await earlier.text());

    const benign = await world.submit('A benign change', { 'benign.txt': 'benign\n' });
    await cycleUntil(loop, `${benign.key} lands and the gate verifies it`, async () => (await world.work()).find(item => item.id === benign.id)?.stage === 'done' && gate().verified === world.main());
    const landed = world.main();
    let record = gate();
    assert.equal(record.lastOutcome?.outcome, 'verified', 'the refused filing did not end the run');
    assert.equal(record.lastOutcome?.tip, landed);
    assert.ok(world.trialLog.some(entry => entry.key === 'batch-gate' && entry.mergeSha === world.base), 'the case was probed on the verified commit');
    const filing = world.filings.find(entry => entry.key === 'known-red:e2e:red-case');
    assert.ok(filing, 'the gate filed the case as known red');
    assert.equal(filing.gate?.results[world.base]?.['e2e:red-case'], true, 'the probe\'s verdict was in main-gate.json before the filing');
    assert.deepEqual(record.filed?.['known-red:e2e:red-case']?.item, null, 'the refused filing is bound, not retried');
    assert.ok(!(await world.work()).some(item => item.title === 'Known red on main: e2e:red-case'), 'the refused filing created no second item');
    assert.deepEqual(reverts(), [], 'nothing is reverted');
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [[benign.key, false]]);

    // A change that breaks smoke on the tip alone lands (its own trial runs only its bound case); the gate reverts it.
    const breaking = await world.submit('A change that breaks smoke', { broken: 'yes\n' });
    await cycleUntil(loop, `the gate reverts ${breaking.key}`, () => gate().lastOutcome?.outcome === 'reverted');
    record = gate();
    assert.equal(record.lastOutcome!.reason, `reverted ${breaking.key} for failing e2e:smoke`);
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [[benign.key, false], [breaking.key, true]]);
    const tip = world.main();
    assert.equal(reverts().length, 1, 'the culprit\'s landing is reverted on main');
    assert.throws(() => git(world.origin, 'cat-file', '-e', `${tip}:broken`), 'main no longer holds the culprit\'s change');
    assert.ok(git(world.origin, 'cat-file', '-e', `${tip}:benign.txt`) === '', 'the benign landing stays');
    await cycleUntil(loop, 'the recut batch verifies', () => gate().verified === tip);

    // The deploy watch serves the verified commit.
    assert.equal(await deployPass(world), 'deployed');
    assert.equal(readDeployRecord(deployRecordPath(world.checkout))?.tip, tip);
  } finally { await world.close(); }
});
