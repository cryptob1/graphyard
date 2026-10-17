import { test } from 'node:test';
import assert from 'node:assert/strict';

// GY-1869: an imported external run keeps the result strings its producer's tool reported byte
// for byte: a tool that reported ' PASS ' is stored as ' PASS ', never trimmed to 'PASS' — the
// exact bytes are part of what the tool reported (follow-up of the GY-1860 review thread
// PRRT_kwDOUZby-s6tdUSP). An evidence pointer's `evidenceId` is an opaque token into the
// producer's own records and is kept byte for byte the same way: ' ev-41 ' is stored and read
// back as ' ev-41 '. Either is refused when blank, over 200 characters or carrying a control
// character. The fields that name things — producer, runId, case id, toolVersion — keep their
// trimming normalisation, so a padded hand-in still matches the names it is replayed by.

/** The module under test, imported inside each test so that run against a tree without the import (graphyard verify's exercise) each case fails on its own assertion instead of the file failing to load. */
const load = async () => (await import('../src/runner-report.js')).importExternalRun;

const sha = 'a'.repeat(40);
/** A hand-in whose result fields and names all carry the surrounding whitespace a tool may print. */
const handIn = {
  format: 'graphyard-external-run-v1',
  producer: ' huck-engineer ',
  sha,
  runId: ' he-run-7 ',
  toolVersion: ' huck-engineer 4.2.1 ',
  result: ' PASS ',
  cases: [{ id: ' checkout-guest ', verdict: 'passed', attempts: 1, durationMs: 4310, result: ' 2 passed in 4.3s ' }],
};

test('unit:runner-report-result-verbatim — a tool-reported run and case result is kept byte for byte, and producer, runId, case id and toolVersion are still trimmed', async () => {
  const importExternalRun = await load();
  const imported = importExternalRun(handIn);
  assert.equal(imported.result, ' PASS ', 'the run result is stored exactly as the tool reported it');
  assert.equal(imported.cases[0].result, ' 2 passed in 4.3s ', 'the case result is stored exactly as the tool reported it');
  assert.equal(imported.producer, 'huck-engineer', 'the producer name is still trimmed');
  assert.equal(imported.runId, 'he-run-7', 'the run id is still trimmed');
  assert.equal(imported.toolVersion, 'huck-engineer 4.2.1', 'the tool version is still trimmed');
  assert.equal(imported.cases[0].id, 'checkout-guest', 'the case id is still trimmed');
});

test('unit:runner-report-result-verbatim — a blank, over-200-character or control-character result is refused for the run and for each case', async () => {
  const importExternalRun = await load();
  for (const bad of ['', '   ', 'PASS\n', '\x1b[32mPASS', 'x'.repeat(201)]) {
    assert.throws(() => importExternalRun({ ...handIn, result: bad }), `a run result of ${JSON.stringify(bad)} is refused`);
    assert.throws(() => importExternalRun({ ...handIn, cases: [{ id: 'checkout-guest', verdict: 'failed', attempts: 1, durationMs: 1, result: bad }] }), `a case result of ${JSON.stringify(bad)} is refused`);
  }
  // Exactly 200 characters is inside the bound, surrounding whitespace included.
  assert.equal(importExternalRun({ ...handIn, result: ` ${'x'.repeat(198)} ` }).result!.length, 200);
});

test("unit:runner-report-evidence-id-verbatim — an evidence pointer's id is kept byte for byte and refused when blank, over 200 characters or carrying a control character", async () => {
  const importExternalRun = await load();
  const pointer = { evidenceId: ' ev-41 ', storageKey: 'huck/runs/he-run-7/checkout/trace.zip' };
  const imported = importExternalRun({ ...handIn, cases: [{ id: 'checkout-guest', verdict: 'failed', attempts: 1, durationMs: 5, evidence: [pointer] }] });
  assert.deepEqual(imported.cases[0].evidence[0], pointer, 'the evidence id is stored and read back byte for byte');
  for (const bad of ['', '   ', ' ev-41\n', 'e'.repeat(201)])
    assert.throws(() => importExternalRun({ ...handIn, cases: [{ id: 'checkout-guest', verdict: 'failed', attempts: 1, durationMs: 1, evidence: [{ evidenceId: bad, storageKey: 'huck/runs/r/trace.zip' }] }] }), `an evidence id of ${JSON.stringify(bad)} is refused`);
  // A pointer that names only its storage key is unchanged, and one that names neither is still refused.
  assert.deepEqual(importExternalRun({ ...handIn, cases: [{ id: 'checkout-guest', verdict: 'failed', attempts: 1, durationMs: 1, evidence: [{ storageKey: 'huck/runs/r/trace.zip' }] }] }).cases[0].evidence, [{ storageKey: 'huck/runs/r/trace.zip' }]);
  assert.throws(() => importExternalRun({ ...handIn, cases: [{ id: 'checkout-guest', verdict: 'failed', attempts: 1, durationMs: 1, evidence: [{}] }] }), 'an evidence pointer names its evidence id or storage key');
});
