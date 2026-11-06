import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gateRecordPath, readGateRecord } from '../src/batch-gate.js';
import { deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import { commandCase, cycleUntil, deployPass, pipelineWorld, rollout, worldLoop } from './helpers/pipeline-world.js';

// GY-3152 AC-3 (GY-3135): a loop process gating main is killed mid-run, as a deploy's restart
// replaces it. The next loop adopts the batch it finds in main-gate.json — the same candidate tip,
// even though another merge landed since — and finishes it to verified; the newer merge rides the
// next batch.

const loopScript = fileURLToPath(new URL('./helpers/pipeline-loop.ts', import.meta.url));

test('e2e:pipeline-gate-restart — a gate run in flight when the loop process is replaced is adopted and finished to verified by the next loop', { timeout: 280_000 }, async () => {
  // Smoke takes a few seconds, so the first loop is replaced while the gate's run is under way.
  const world = await pipelineWorld('pipeline-gate-restart', { 'e2e/cases/smoke.json': commandCase('smoke', 'node --eval "setTimeout(() => {}, 4000)"') });
  const gate = () => readGateRecord(gateRecordPath(world.checkout));
  const { checkout, trials, url, database, config } = world;
  let output = '';
  const first = spawn(process.execPath, ['--import', 'tsx', loopScript, JSON.stringify({ checkout, trials, url, database, config })], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  first.stdout!.on('data', data => { output += data; }); first.stderr!.on('data', data => { output += data; });
  const exited = new Promise<void>(resolve => first.once('exit', () => resolve()));
  try {
    await rollout(world);
    const landed = await world.submit('A change the first loop lands', { 'first.txt': 'first\n' });
    for (const start = Date.now(); !(gate()?.inFlight?.step?.startsWith('running') && gate()?.inFlight?.tip === world.main() && world.main() !== world.base);) {
      if (Date.now() - start > 120_000) {
        const ledgers = (await world.work()).map(item => `${item.key} ${item.stage} ${item.mergeLedger?.state ?? 'no ledger'}: ${item.mergeLedger?.refusal?.reason ?? ''}`);
        throw new Error(`the first loop never started gating ${landed.key}'s landing\n${ledgers.join('\n')}\ngate: ${JSON.stringify(gate())}\n${output.slice(-4000)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const cut = gate()!.inFlight!;
    // The loop process is replaced: killed with its trial, its gate run unsettled.
    process.kill(-first.pid!, 'SIGKILL');
    await exited;
    assert.equal(gate()!.inFlight?.tip, cut.tip, 'the killed loop left its batch in flight');
    assert.equal(gate()!.verified, world.base);

    // The next loop: another merge lands before it gates, then it adopts the batch it finds.
    const next = worldLoop(world, { gate: false });
    const later = await world.submit('A change that lands after the cut', { 'later.txt': 'later\n' });
    await cycleUntil(next, `${later.key} lands`, async () => (await world.work()).find(item => item.id === later.id)?.stage === 'done');
    const newer = world.main();
    assert.notEqual(newer, cut.tip);
    next.gating(true);
    await cycleUntil(next, 'the adopted batch settles', () => gate()?.lastOutcome !== null && gate()?.inFlight?.tip !== cut.tip);
    assert.deepEqual(gate()!.lastOutcome && { tip: gate()!.lastOutcome!.tip, outcome: gate()!.lastOutcome!.outcome }, { tip: cut.tip, outcome: 'verified' }, 'the adopted batch finishes to verified on the tip it was cut on, never recut onto the newer one');
    assert.ok(world.trialLog.some(entry => entry.key === 'batch-gate' && entry.mergeSha === cut.tip), 'the next loop ran the adopted batch\'s checks');
    assert.ok(!world.trialLog.some(entry => entry.key === 'batch-gate' && entry.mergeSha === newer && entry.startedAt < world.trialLog.find(other => other.key === 'batch-gate' && other.mergeSha === cut.tip)!.startedAt), 'nothing gated the newer tip before the adopted batch');

    // The merge that landed meanwhile rides the next batch.
    await cycleUntil(next, 'the next batch verifies the newer tip', () => gate()?.verified === newer);
    assert.equal(await deployPass(world), 'deployed');
    assert.equal(readDeployRecord(deployRecordPath(world.checkout))?.tip, newer);
  } finally {
    try { process.kill(-first.pid!, 'SIGKILL'); } catch { /* already gone */ }
    await exited;
    await world.close();
  }
});
