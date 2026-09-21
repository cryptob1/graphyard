import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMasterStatus } from '../src/master.js';
import type { Work } from '../src/model.js';
import { parseTimingAnnotations, qualifyTimingFailures, timingFailureReason } from '../src/cli/timing-failures.js';
import { TimingAssertionError, assertTiming, measureTiming, minimumSamples, observationsAbove, parseTimingRecord, percentile, percentileRank, steadyState, timingFailureMarker } from './helpers/timing.js';
import { annotationCommand, failedTestCount, readBaseline, timingFailures, timingSpread, timingSummary } from './helpers/timing-report.js';
import { baselineRecordingVariable, requiredRuns, stabilityRecord, type StabilityRecord } from './helpers/timing-stability.js';

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('unit:percentile-and-warmup — the percentile helper returns the order statistic its sample size names, and discarded warmup reads never enter the samples', async () => {
  // Nearest rank: the p95 of twenty samples is the 19th, the second-worst, with one observation
  // above it; a hundred put five above it, which is the smallest count that does.
  assert.equal(percentileRank(20, 0.95), 19); assert.equal(observationsAbove(20, 0.95), 1);
  assert.equal(percentileRank(100, 0.95), 95); assert.equal(observationsAbove(100, 0.95), 5);
  assert.equal(minimumSamples(0.95, 5), 100); assert.equal(minimumSamples(0.95, 1), 20); assert.equal(minimumSamples(0.5, 1), 2);
  for (const count of [1, 2, 19, 20, 21, 99, 100, 101, 1000]) {
    // Whatever order the samples arrive in, the helper returns exactly the ranked one.
    const ascending = Array.from({ length: count }, (_, index) => index + 1), shuffled = [...ascending].sort((a, b) => (a * 7919) % count - (b * 7919) % count);
    for (const fraction of [0.5, 0.9, 0.95, 0.99, 1]) assert.equal(percentile(shuffled, fraction), Math.ceil(count * fraction), `p${fraction * 100} of ${count}`);
    assert.deepEqual(shuffled.length, count, 'the samples are not reordered in place');
  }
  assert.equal(percentile([5], 0.95), 5); assert.throws(() => percentile([], 0.95), /at least one sample/); assert.throws(() => percentileRank(10, 0), /fraction/);
  // One outlier beside the worst read decides a twenty-sample "p95"; it cannot move a hundred-sample one.
  const steady = (count: number) => Array.from({ length: count }, (_, index) => 400 + index);
  assert.equal(percentile([...steady(18), 2092, 9000], 0.95), 2092, 'of twenty, the second-worst read is the verdict');
  assert.ok(percentile([...steady(98), 2092, 9000], 0.95) < 500, 'of a hundred, two outliers leave the p95 in the steady state');
  assert.ok(percentile([...steady(94), ...Array.from({ length: 6 }, () => 2092)], 0.95) === 2092, 'six reads in a hundred over the budget are a real p95 regression and still fail');

  // Warmup reads are taken, in order, before sampling, and are kept apart from the samples.
  const durations = [9000, 7000, 5000, 100, 110, 120, 130]; let reads = 0, now = 0;
  const { warmup, samples } = await steadyState(async () => { now += durations[reads++]; }, { warmup: 3, samples: 4, clock: () => now });
  assert.equal(reads, 7); assert.deepEqual(warmup, [9000, 7000, 5000]); assert.deepEqual(samples, [100, 110, 120, 130]);
  const measured = measureTiming({ name: 'example.p95', test: 'unit:example', statistic: 'p95', fraction: 0.95, budgetMs: 2_000, samples, warmup });
  assert.equal(measured.measuredMs, 130); assert.equal(measured.warmupDiscarded, 3); assert.equal(measured.samples, 4); assert.equal(measured.passed, true);
  assert.equal(measured.distribution.maxMs, 130, 'no warmup read is counted, even though each was over the budget');
  assert.deepEqual((await steadyState(async () => {}, { warmup: 0, samples: 2, clock: () => 0 })).warmup, []);

  // The snapshot latency assertion uses them: warmup discarded, a sample count that leaves five
  // reads above the p95, and the 2 s budget it always asserted.
  const latency = await source('./work-snapshot-latency.test.ts');
  assert.match(latency, /const WARMUP_READS = 5, LATENCY_SAMPLES = minimumSamples\(0\.95, 5\), SNAPSHOT_BUDGET_MS = 2_000;/);
  assert.match(latency, /steadyState\(async \(\) => \{ compact = await read\('work-snapshot\?view=coordination'\); \}, \{ warmup: WARMUP_READS, samples: LATENCY_SAMPLES \}\)/);
  assert.match(latency, /assertTiming\(\{ name: 'work-snapshot-latency\.p95', [^}]*statistic: 'p95', fraction: 0\.95, budgetMs: SNAPSHOT_BUDGET_MS, samples, warmup \}\)/);
  assert.doesNotMatch(latency, /Math\.ceil\(samples\.length \* 0\.95\)/, 'no second percentile lives beside the helper');
});

const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
function heldOnTest(overrides: Partial<Work> = {}) {
  const now = new Date().toISOString();
  return { id: 'work-id', key: 'GY-42', title: 'Held on a red test check', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:master'] }],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [], stage: 'test', revision: 9, policyRevision: 2, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 1, lease: null, workspaces: [],
    candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeAuthorization: null,
    observation: { at: now, candidate, checks: [{ name: 'test', result: 'failure', appId: 15368, id: 7001, attempt: 1 }, { name: 'typecheck', result: 'success', appId: 15368, id: 7002 }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [] },
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate'] }], ...overrides } as unknown as Work;
}
// What GitHub's annotations API returns for a workflow-command annotation: the message, unescaped.
const published = (command: string) => ({ annotation_level: 'failure', title: 'Timing-dependent assertion over budget', message: command.slice(command.indexOf('::', 2) + 2).replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%25/g, '%') });

test('unit:timing-failure-reported — a failed timing-dependent assertion is recorded with what it measured, and master status reports it with the measured value against the budget instead of an unqualified red check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-timing-record-'));
  try {
    // The run records every timing-dependent assertion, passed or failed, with what it measured.
    const file = join(directory, 'timing.jsonl');
    const slow = [...Array.from({ length: 94 }, (_, index) => 900 + index), ...Array.from({ length: 6 }, () => 2092)];
    assertTiming({ name: 'cycle-within-interval.duration', test: 'integration:cycle-within-interval — a cycle completes within its interval', statistic: 'duration', comparison: '<=', budgetMs: 20_000, samples: [181] }, file);
    assert.throws(() => assertTiming({ name: 'work-snapshot-latency.p95', test: 'integration:work-snapshot-latency — the snapshot answers under 2 s p95', statistic: 'p95', fraction: 0.95, budgetMs: 2_000, samples: slow, warmup: [3000, 2500, 2400, 2300, 2200] }, file), (error: unknown) => {
      assert.ok(error instanceof TimingAssertionError); assert.ok(error instanceof assert.AssertionError);
      assert.ok(error.message.startsWith(timingFailureMarker)); assert.match(error.message, /work-snapshot-latency\.p95: p95 measured 2092ms, over its budget of < 2000ms \(100 samples, 5 warmup discarded\)/);
      return true;
    });
    const record = parseTimingRecord(await readFile(file, 'utf8'));
    assert.deepEqual(record.map(entry => [entry.name, entry.passed, entry.measuredMs, entry.budgetMs]), [['cycle-within-interval.duration', true, 181, 20_000], ['work-snapshot-latency.p95', false, 2092, 2_000]]);
    assert.equal(record[1].observationsAbove, 5); assert.equal(record[1].warmupDiscarded, 5); assert.deepEqual(record[1].distribution, { minMs: 900, medianMs: 949, maxMs: 2092 });

    // The CI job publishes one annotation per over-budget assertion on its own check run, saying
    // whether anything else failed beside it; `master status` reads the same record back.
    assert.equal(failedTestCount('ℹ tests 851\nℹ pass 850\nℹ fail 1\n'), 1); assert.equal(failedTestCount('# pass 3\n# fail 0\n'), 0); assert.equal(failedTestCount('no summary'), null);
    const onlyTiming = timingFailures(record, 1), withRegression = timingFailures(record, 3), unknown = timingFailures(record, null);
    assert.equal(onlyTiming.length, 1); assert.equal(onlyTiming[0].otherFailures, 0); assert.equal(withRegression[0].otherFailures, 2); assert.equal(unknown[0].otherFailures, null);
    assert.deepEqual(timingFailures(record.filter(entry => entry.passed), 0), []);
    const command = annotationCommand(onlyTiming[0]);
    assert.match(command, /^::error title=Timing-dependent assertion over budget::\[timing-dependent\] work-snapshot-latency\.p95: p95 measured 2092ms, over its budget of < 2000ms/); assert.doesNotMatch(command, /\n/);
    assert.deepEqual(parseTimingAnnotations([published(command)]), onlyTiming);
    assert.deepEqual(parseTimingAnnotations([{ message: 'Process completed with exit code 1.' }, { message: 'graphyard-timing:{"name":"forged"}' }, { message: 'graphyard-timing:not json' }, { message: null }]), []);
    assert.match(timingSummary(record, onlyTiming, null), /\| work-snapshot-latency\.p95 \|.*\| p95 2092ms \| < 2000ms \| 100 \(5 warmup discarded\) \| not recorded \| \*\*over budget\*\* \|/);
    assert.match(timingSummary(record, onlyTiming, null), /Every failed test in this run failed on a timing-dependent assertion/);

    // Master status: the unqualified refusal becomes the measurement against its budget, and the
    // item raises attention at once with the rerun, instead of sitting silently behind a red check.
    const work = heldOnTest(), snapshot = { work: [work], now: new Date().toISOString() };
    const plain = buildMasterStatus(snapshot, [], []);
    assert.equal(plain.work[0].refusal?.reason, 'Required CI check test has not passed on the current candidate'); assert.equal(plain.work[0].attention, null);
    const asked: number[] = [];
    const annotations = (failures: typeof onlyTiming) => async (id: number) => { asked.push(id); return [{ message: 'Process completed with exit code 1.' }, ...failures.map(failure => published(annotationCommand(failure)))]; };
    const qualified = await qualifyTimingFailures(plain, snapshot.work, 'owner/project', annotations(onlyTiming));
    assert.deepEqual(asked, [7001], 'only the failed required check of the current candidate is looked up');
    const reason = 'Required CI check test failed on a timing-dependent assertion, not on behaviour: work-snapshot-latency.p95 (integration:work-snapshot-latency) measured p95 2092ms against its budget of < 2000ms over 100 samples after 5 discarded warmup reads; every other test in the run passed';
    assert.equal(timingFailureReason('test', onlyTiming), reason);
    assert.deepEqual(qualified.work[0].refusal, { gate: 'test', reason }); assert.equal(qualified.work[0].attention, reason);
    assert.equal(qualified.counts.attention, plain.counts.attention + 1);
    const item = qualified.attentionItems.find(entry => entry.subject === 'GY-42')!;
    assert.equal(item.text, reason); assert.equal(item.role, 'master'); assert.equal(item.human, false);
    assert.match(item.next, /^gh api --method POST repos\/owner\/project\/actions\/jobs\/7001\/rerun reruns the test job once; a second measurement over budget is a latency regression/);
    assert.ok(!JSON.stringify(qualified).includes('has not passed on the current candidate'), 'nothing in the report still calls it an unqualified failure');

    // A regression beside the timing failure is said to be one, and is not offered a rerun.
    const mixed = await qualifyTimingFailures(plain, snapshot.work, 'owner/project', annotations(withRegression));
    assert.match(mixed.work[0].attention!, /failed on a timing-dependent assertion: .*2092ms against its budget of < 2000ms.*; 2 other tests failed in the same run, so it is not only a timing failure$/);
    assert.doesNotMatch(mixed.attentionItems.find(entry => entry.subject === 'GY-42')!.next, /rerun/);
    assert.match((await qualifyTimingFailures(plain, snapshot.work, 'owner/project', annotations(unknown))).work[0].attention!, /the run did not report whether other tests failed$/);

    // A red check with no timing annotation, an unreadable run, a passing check, an observation of
    // another head and a delivered item are all left exactly as they were.
    assert.deepEqual(await qualifyTimingFailures(plain, snapshot.work, 'owner/project', annotations([])), plain);
    assert.deepEqual(await qualifyTimingFailures(plain, snapshot.work, 'owner/project', async () => { throw new Error('gh: HTTP 502'); }), plain);
    asked.length = 0;
    const passing = heldOnTest({ observation: { ...work.observation!, checks: [{ name: 'test', result: 'failure', appId: 15368, id: 7001, attempt: 1 }, { name: 'test', result: 'success', appId: 15368, id: 7003, attempt: 2 }] } });
    const moved = heldOnTest({ observation: { ...work.observation!, candidate: { ...candidate, sha: 'c'.repeat(40) } } });
    for (const other of [passing, moved, heldOnTest({ stage: 'done' })]) await qualifyTimingFailures(buildMasterStatus({ work: [other], now: snapshot.now }, [], []), [other], 'owner/project', annotations(onlyTiming));
    assert.deepEqual(asked, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the stability record counts consecutive passes on an unchanged tree and the run-to-run spread of every timing assertion', () => {
  const measurement = (name: string, measuredMs: number, budgetMs = 2_000) => measureTiming({ name, test: `integration:${name.split('.')[0]}`, statistic: 'p95', budgetMs, samples: [measuredMs] });
  const timings = [[measurement('a.p95', 180), measurement('b.elapsed', 700, 10_000)], [measurement('a.p95', 240), measurement('b.elapsed', 900, 10_000)], [measurement('a.p95', 2_092)]];
  assert.deepEqual(timingSpread(timings).map(({ name, runs, failures, minMs, medianMs, maxMs, spreadMs, headroomMs }) => ({ name, runs, failures, minMs, medianMs, maxMs, spreadMs, headroomMs })), [
    { name: 'a.p95', runs: 3, failures: 1, minMs: 180, medianMs: 240, maxMs: 2_092, spreadMs: 1_912, headroomMs: -92 },
    { name: 'b.elapsed', runs: 2, failures: 0, minMs: 700, medianMs: 700, maxMs: 900, spreadMs: 200, headroomMs: 9_100 }]);
  const run = (index: number, passed = true) => ({ run: index, passed, exitCode: passed ? 0 : 1, durationMs: 48_000, failedTests: passed ? 0 : 1, timingFailures: passed ? [] : ['a.p95'] });
  const twenty = Array.from({ length: requiredRuns }, (_, index) => run(index + 1));
  const stable = stabilityRecord({ commit: 'a'.repeat(40), treeUnchanged: true, command: ['npm', 'test'], runs: twenty, timings });
  assert.equal(stable.stable, true); assert.equal(stable.consecutivePasses, 20); assert.equal(stable.passed, 20); assert.equal(stable.spread.length, 2);
  // Nineteen runs, one failed run anywhere, or a tree that changed under the runs is not stability.
  assert.equal(stabilityRecord({ commit: 'a'.repeat(40), treeUnchanged: true, command: ['npm', 'test'], runs: twenty.slice(0, 19), timings }).stable, false);
  const flaky = stabilityRecord({ commit: 'a'.repeat(40), treeUnchanged: true, command: ['npm', 'test'], runs: twenty.map(entry => entry.run === 12 ? run(12, false) : entry), timings });
  assert.equal(flaky.stable, false); assert.equal(flaky.consecutivePasses, 11); assert.equal(flaky.passed, 19);
  assert.equal(stabilityRecord({ commit: 'a'.repeat(40), treeUnchanged: false, command: ['npm', 'test'], runs: twenty, timings }).stable, false);
});

test('the recorded baseline holds twenty consecutive passing runs of the required check and the spread of every timing assertion in the suite', async t => {
  // The runs that record the baseline cannot be judged by the baseline they are about to replace.
  if (process.env[baselineRecordingVariable]) return t.skip('this run is recording the baseline');
  const baseline = readBaseline() as (StabilityRecord | null);
  assert.ok(baseline, 'tests/helpers/timing-baseline.json is recorded with: npx tsx tests/helpers/timing-stability.ts --record tests/helpers/timing-baseline.json');
  assert.equal(baseline.stable, true); assert.equal(baseline.treeUnchanged, true); assert.deepEqual(baseline.command, ['npm', 'test']);
  assert.ok(baseline.runs.length >= requiredRuns && baseline.consecutivePasses === baseline.runs.length, `${baseline.consecutivePasses} consecutive passes over ${baseline.runs.length} runs`);
  assert.match(baseline.commit ?? '', /^[0-9a-f]{40}$/);
  // Every timing-dependent assertion the suite makes has its spread on record, measured in every
  // run and never over its budget, so a new one cannot land without a recorded spread.
  const names = new Set<string>();
  for (const file of (await readdir(new URL('.', import.meta.url))).filter(name => name.endsWith('.test.ts') && name !== 'timing-stability.test.ts'))
    for (const match of (await source(`./${file}`)).matchAll(/assertTiming\(\{ name: '([^']+)'/g)) names.add(match[1]);
  assert.ok(names.size >= 3, 'the suite routes its timing-dependent assertions through assertTiming');
  assert.deepEqual(baseline.spread.map(entry => entry.name).sort(), [...names].sort());
  for (const entry of baseline.spread) {
    assert.equal(entry.runs, baseline.runs.length, `${entry.name} was measured in every run`); assert.equal(entry.failures, 0);
    assert.ok(entry.minMs <= entry.medianMs && entry.medianMs <= entry.maxMs && entry.spreadMs >= 0 && entry.headroomMs > 0, `${entry.name} spread ${entry.minMs}–${entry.maxMs}ms against ${entry.budgetMs}ms`);
  }
});
