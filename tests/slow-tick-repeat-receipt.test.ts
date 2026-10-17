import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  executeSlowTickReceiptRuns, pinnedProofFile, pinnedSourceSha, pinnedSourceTree,
  requiredPasses, retainedSlowTickReceipt, slowTickProof, verifySlowTickReceipt,
  type SlowTickReceipt, type SlowTickReceiptRun,
} from './helpers/slow-tick-repeat-receipt.js';

// GY-1907: the twenty-pass receipt GY-1886's AC-1 asked for is a record, not a claim. The retained
// receipt (tests/helpers/slow-tick-repeat-receipt.ts) binds unit:slow-tick-names-cause to the exact
// source it ran on and lists every run it executed; these checks keep it meaningful. They are
// bounded: the judgements run on fixtures, and the one execution here is the proof itself, which
// re-runs the pinned source twenty consecutive times and refuses a receipt that binds another head,
// holds fewer runs than it claims, loses its order, or records any failure.

/** A receipt run's stamp, on the fixture day: run n starts in minute n-1 and ends in minute n, so the sequence is ordered and consecutive. */
const at = (minute: number) => `2026-10-17T09:${String(minute).padStart(2, '0')}:00.000Z`;
const digest = (run: number) => `${String(run % 10).repeat(8)}-${'b'.repeat(56)}`.replace(/-/g, '');
const aRun = (run: number, overrides: Partial<SlowTickReceiptRun> = {}): SlowTickReceiptRun => ({
  run, startedAt: at(run - 1), endedAt: at(run), exitCode: 0, durationMs: 5_000 + run,
  executed: 1, failed: 0, skipped: 0, passed: true, logDigest: digest(run), ...overrides,
});
const aReceipt = (overrides: Partial<SlowTickReceipt> = {}, runs: SlowTickReceiptRun[] = Array.from({ length: requiredPasses }, (_, index) => aRun(index + 1))): SlowTickReceipt => ({
  schema: 1, proof: slowTickProof, pinnedSource: pinnedSourceSha, pinnedTree: pinnedSourceTree,
  command: ['node', '--import', 'tsx', '--test', '--test-reporter=tap', pinnedProofFile],
  recordedAt: at(requiredPasses),
  environment: { node: 'v24.5.0', platform: 'linux', arch: 'x64', cpus: 24, ci: false },
  runs, passed: runs.length, consecutivePasses: runs.length,
  artifact: '/some/retained/run-logs', ...overrides,
});
const faultsOf = (receipt: SlowTickReceipt) => verifySlowTickReceipt(receipt).faults;
const includesFault = (faults: string[], expected: string) => faults.some(fault => fault.includes(expected));

test('unit:slow-tick-receipt-source-binding — a receipt is judged by the source it binds: another head, another tree or another proof name is refused, and the exact pinned source passes', () => {
  assert.deepEqual(faultsOf(aReceipt()), [], 'a receipt bound to the exact pinned source verifies');
  const anotherHead = faultsOf(aReceipt({ pinnedSource: 'e'.repeat(40) }));
  assert.ok(includesFault(anotherHead, 'not the exact'), `another head's sha is refused by name: ${anotherHead.join(' | ')}`);
  const anotherTree = faultsOf(aReceipt({ pinnedTree: 'f'.repeat(40) }));
  assert.ok(includesFault(anotherTree, 'tree'), `another tree is refused by name: ${anotherTree.join(' | ')}`);
  const anotherProof = faultsOf(aReceipt({ proof: 'unit:some-other-proof' }));
  assert.ok(includesFault(anotherProof, slowTickProof), `another proof's receipt is refused: ${anotherProof.join(' | ')}`);
  // The binding is to the commit and its tree together: the retained receipt carries both.
  assert.equal(retainedSlowTickReceipt.pinnedSource, pinnedSourceSha);
  assert.equal(retainedSlowTickReceipt.pinnedTree, pinnedSourceTree);
});

test('unit:slow-tick-receipt-sequence — twenty ordered consecutive executed passes, or the receipt is refused: a missing run, a hole, a reordering, a failure, a crash, a skip or a lost log is named', () => {
  const short = faultsOf(aReceipt({}, aReceipt().runs.slice(1)));
  assert.ok(includesFault(short, `not the required ${requiredPasses}`), `nineteen runs are refused: ${short.join(' | ')}`);
  const holed = aReceipt({}, aReceipt().runs.map((run, index) => index >= 6 ? aRun(index + 2) : run));
  const hole = faultsOf(holed);
  assert.ok(includesFault(hole, 'numbered'), `a receipt that skips run 7 is refused: ${hole.join(' | ')}`);
  const reordered = aReceipt({}, [aRun(2), aRun(1), ...Array.from({ length: requiredPasses - 2 }, (_, index) => aRun(index + 3))]);
  const order = faultsOf(reordered);
  assert.ok(includesFault(order, 'execution order'), `a swapped pair is refused: ${order.join(' | ')}`);
  const broke = aReceipt({ passed: 9, consecutivePasses: 9 }, aReceipt().runs.with(9, aRun(10, { exitCode: 1, failed: 1, passed: false })));
  const failure = faultsOf(broke);
  assert.ok(includesFault(failure, 'a failure breaks the sequence') && includesFault(failure, 'consecutive passes are 9'), `a failed run is refused and names the break: ${failure.join(' | ')}`);
  const misdeclared = faultsOf(aReceipt({ passed: 19, consecutivePasses: 19 }));
  assert.ok(includesFault(misdeclared, 'consecutive passes are 19, not 20') && includesFault(misdeclared, '19 passed run(s) of 20'), `a receipt that under-declares its own runs is refused: ${misdeclared.join(' | ')}`);
  const crashed = faultsOf(aReceipt({}, aReceipt().runs.with(14, aRun(15, { exitCode: null, executed: 0, passed: false }))));
  assert.ok(includesFault(crashed, 'exited null') && includesFault(crashed, 'executed no case'), `a crashed run is refused: ${crashed.join(' | ')}`);
  const skipped = faultsOf(aReceipt({}, aReceipt().runs.with(2, aRun(3, { skipped: 1, passed: false }))));
  assert.ok(includesFault(skipped, 'skipped'), `a skipped case is refused: ${skipped.join(' | ')}`);
  const lost = faultsOf(aReceipt({}, aReceipt().runs.with(19, aRun(20, { logDigest: 'not-a-digest' }))));
  assert.ok(includesFault(lost, 'log digest'), `a run without its log digest is refused: ${lost.join(' | ')}`);
  const unordered = aReceipt(); unordered.runs[7].startedAt = at(0);
  const disorder = faultsOf(unordered);
  assert.ok(includesFault(disorder, 'not ordered'), `a run that starts before its predecessor ended is refused: ${disorder.join(' | ')}`);
  const noArtifact = faultsOf(aReceipt({ artifact: '  ' }));
  assert.ok(includesFault(noArtifact, 'artifact reference'), `a receipt without a durable artifact reference is refused: ${noArtifact.join(' | ')}`);
  const bare = faultsOf(aReceipt({ environment: { node: '', platform: 'linux', arch: 'x64', cpus: 0, ci: false } }));
  assert.ok(includesFault(bare, 'node') && includesFault(bare, 'processors'), `a receipt without its runner environment is refused: ${bare.join(' | ')}`);
});

test('unit:slow-tick-receipt-retained — the retained receipt verifies against the exact pinned source and holds twenty executed passes with their artifact', () => {
  const verdict = verifySlowTickReceipt(retainedSlowTickReceipt);
  assert.deepEqual(verdict.faults, [], `the retained receipt verifies: ${verdict.faults.join(' | ')}`);
  assert.equal(retainedSlowTickReceipt.runs.length, requiredPasses);
  assert.equal(retainedSlowTickReceipt.consecutivePasses, requiredPasses);
  assert.equal(retainedSlowTickReceipt.passed, requiredPasses);
  for (const run of retainedSlowTickReceipt.runs) {
    assert.equal(run.exitCode, 0, `run ${run.run} exited 0`);
    assert.ok(run.executed >= 1 && run.failed === 0 && run.skipped === 0, `run ${run.run} executed the proof cleanly`);
    assert.ok(retainedSlowTickReceipt.artifact.trim(), 'the receipt names where its run logs are retained');
  }
});

test('integration:slow-tick-exact-head-twenty-consecutive — an independent execution re-runs the pinned source twenty consecutive times and its receipt verifies beside the retained one', { timeout: 900_000 }, async () => {
  const execution = await executeSlowTickReceiptRuns();
  try {
    const verdict = verifySlowTickReceipt(execution.receipt);
    assert.deepEqual(verdict.faults, [], `the executed receipt verifies: ${verdict.faults.join(' | ')}`);
    assert.equal(execution.receipt.pinnedSource, pinnedSourceSha);
    assert.equal(execution.receipt.runs.length, requiredPasses);
    assert.equal(execution.receipt.consecutivePasses, requiredPasses);
    // The retention is real: the first and last runs' TAP output is readable at the artifact reference.
    const first = await readFile(join(execution.receipt.artifact, 'run-01.log'), 'utf8');
    assert.ok(first.includes(`ok 1 - ${slowTickProof}`), 'the first run\'s retained log holds the passing case');
    const retained = verifySlowTickReceipt(retainedSlowTickReceipt);
    assert.deepEqual(retained.faults, [], `the retained receipt still verifies: ${retained.faults.join(' | ')}`);
  } finally { await execution.release(); }
});
