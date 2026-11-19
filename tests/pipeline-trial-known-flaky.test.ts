import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, cycleUntil, pipelineWorld, worldLoop } from './helpers/pipeline-world.js';

// GY-3545: the real loop's merge writer over a real trial. With an open "Flaky check on main" item
// for tests/flaky.test.cjs, a candidate whose trial fails only that test merges instead of being
// sent back, and the flaky item gains a note naming the candidate.

const flakyTest = "const { test } = require('node:test');\ntest('tests/flaky.test.cjs fails while broken exists', () => { if (require('fs').existsSync('broken')) throw new Error('flaked'); });\n";

test('e2e:trial-known-flaky — a candidate whose trial fails only on a test with an open flaky item merges, and the flaky item gains a note', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('trial-known-flaky', {
    'package.json': JSON.stringify({ name: 'pipeline-fixture', scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs tests/flaky.test.cjs' } }),
    'tests/flaky.test.cjs': flakyTest,
  });
  try {
    const filed = await fetch(`${world.url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'flake:test:tests/flaky.test.cjs' },
      body: JSON.stringify({ title: 'Flaky check on main: test:tests/flaky.test.cjs', why: 'w', simplest: 's', type: 'bug', criteria: [{ id: 'AC-1', text: 'Deterministic', proofs: ['unit:flaky-pinned', 'e2e:fixture'] }] }) });
    const flaky = (await filed.json()) as { key: string; id: string };
    assert.ok(filed.ok, JSON.stringify(flaky));

    const change = await world.submit('A change the flaky test fails on', { broken: 'yes\n' });
    const loop = worldLoop(world, { gate: false });
    await cycleUntil(loop, `${change.key} merges`, async () => (await world.work()).find(item => item.id === change.id)?.stage === 'done');
    const work = await world.work(), landed = work.find(item => item.id === change.id)!;
    assert.equal(landed.reworkRequested, false, 'the candidate was not sent back');
    const trial = landed.mergeLedger;
    assert.ok(trial?.state === 'reconciled', JSON.stringify(trial));
    const notes = (work.find(item => item.key === flaky.key)!.agentRequests ?? []).filter(request => request.type === 'note');
    assert.equal(notes.length, 1, 'the flaky item gains one note');
    assert.match(notes[0]!.reason, new RegExp(`tests/flaky\\.test\\.cjs failed in ${change.key}'s merge trial`));
  } finally { await world.close(); }
});
