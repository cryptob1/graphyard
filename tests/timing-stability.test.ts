import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWithinBudget, measureLatency, percentile, percentileRank, readTimingReport, recordTiming, sampleCount, singleObservation, timingAssertionTitle, timingFailureMessage, timingSpread, timingSummary, type TimingMeasurement } from './helpers/timing.js';
import { annotationCommands, summaryMarkdown } from './helpers/timing-report.js';
import { stabilityMarkdown } from './helpers/timing-stability.js';
import { providerMergeInstant, wholeSecondAfter } from './helpers/clock.js';
import { failedRequiredCheck, nameTimingFailures, timingAssertionTitle as masterTimingTitle, timingFindings, type CheckAnnotation } from '../src/cli/master-timing.js';
import { buildMasterStatus } from '../src/master.js';
import type { Work } from '../src/model.js';

/** A clock that advances by the scripted amount at each read, so the helper is tested without timing anything. */
function scriptedClock(durations: number[]) {
  let now = 0, index = 0;
  return () => { const value = now; now += durations[index++ % durations.length] ?? 0; return value; };
}
const budget = { assertion: 'integration:work-snapshot-latency', measure: 'coordination snapshot read', budgetMs: 2_000, percentile: 0.95, warmup: 5, samples: 40 };

test('unit:percentile-and-warmup the percentile helper returns the order statistic its sample size names, and discarded warmup reads never enter the samples', async () => {
  // Nearest rank: for 40 samples p95 is the 38th smallest, with two observations above it; for 20
  // it was the 19th — the second-worst read, which is what made a single outlier decide the verdict.
  const forty = Array.from({ length: 40 }, (_, i) => 40 - i);
  assert.equal(percentile(forty, 0.95), 38); assert.equal(percentileRank(40, 0.95), 38);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95), 19); assert.equal(percentileRank(20, 0.95), 19);
  assert.equal(percentile([7], 0.95), 7); assert.equal(percentile([3, 1, 2], 0.5), 2); assert.equal(percentile([3, 1, 2, 4], 1), 4);
  assert.equal(percentile([5, 1], 0.01), 1, 'a tiny percentile reads the smallest sample');
  assert.throws(() => percentile([], 0.95), /at least one sample/); assert.throws(() => percentile([1], 0), /\(0, 1\]/); assert.throws(() => percentile([1], 1.5), /\(0, 1\]/);
  // The smallest sample that leaves two observations above p95 is 40; the latency test uses exactly that.
  assert.equal(sampleCount(0.95), 40); assert.equal(sampleCount(0.95, 1), 20); assert.equal(sampleCount(0.5), 4); assert.equal(sampleCount(0.99), 200);
  assert.equal(budget.samples, sampleCount(0.95));

  // Five slow warmup reads, then forty fast ones with one outlier: the warmup reads are recorded as
  // discarded, the samples are exactly the forty that followed, and the outlier alone cannot breach.
  const durations = [...Array(5).fill(900), ...Array(39).fill(120), 5_000];
  let reads = 0;
  const { measurement, last } = await measureLatency(budget, async () => ++reads, scriptedClock(durations.flatMap(duration => [duration, 0])));
  assert.equal(reads, 45); assert.equal(last, 45);
  assert.deepEqual(measurement.discarded, Array(5).fill(900));
  assert.equal(measurement.observed.all.length, 40); assert.equal(measurement.observed.max, 5_000); assert.equal(measurement.observed.min, 120);
  assert.ok(!measurement.observed.all.includes(900), 'no warmup read entered the samples');
  assert.equal(measurement.measuredMs, 120, 'p95 of forty samples is the 38th smallest, not the outlier or its neighbour');
  assert.equal(measurement.withinBudget, true); assert.equal(measurement.budgetMs, 2_000, 'the budget is carried unchanged');
  // Too small a sample for the named percentile is refused rather than silently reported.
  await assert.rejects(measureLatency({ ...budget, samples: 20 }, async () => 1), /needs at least 40/);
  // The first read counts as warmup even when it is the only slow one.
  const { measurement: cold } = await measureLatency({ ...budget, warmup: 1, samples: 40 }, async () => 1, scriptedClock([[3_000, 0], ...Array(40).fill([100, 0])].flat()));
  assert.deepEqual(cold.discarded, [3_000]); assert.equal(cold.measuredMs, 100);
});

test('unit:percentile-and-warmup the merge instant a delivery case asserts on is pinned to the recorded commit, not to the runner pace', () => {
  assert.equal(wholeSecondAfter(Date.parse('2026-09-21T02:00:00.000Z')), '2026-09-21T02:00:01Z');
  assert.equal(wholeSecondAfter(Date.parse('2026-09-21T02:00:00.999Z')), '2026-09-21T02:00:01Z');
  assert.equal(wholeSecondAfter(Date.parse('2026-09-21T02:00:00.000Z') - 1), '2026-09-21T02:00:00Z');
  const committingAt = '2026-09-21T02:00:00.400Z';
  // With no offset the merge lands on the next whole second after the commit.
  assert.equal(providerMergeInstant(committingAt), '2026-09-21T02:00:01Z');
  // A repository clock five seconds behind GitHub: carried back by the offset's lower bound, the
  // provider instant still postdates the recorded commit, whatever the wall clock did meanwhile.
  const offset = { min: -5000, max: -4000 };
  const mergedAt = providerMergeInstant(committingAt, offset);
  assert.equal(mergedAt, '2026-09-21T02:00:06Z');
  assert.ok(Date.parse(mergedAt) + offset.min > Date.parse(committingAt));
  assert.ok(Date.parse(mergedAt) + offset.min - Date.parse(committingAt) <= 1000, 'and by no more than the rounding to a whole second');
});

const failedMeasurement = (): TimingMeasurement => ({ ...budget, measuredMs: 2_092, withinBudget: false, observed: { min: 640, median: 1_180, max: 2_410, all: Array(40).fill(1_180) }, discarded: Array(5).fill(3_000), at: '2026-09-21T02:20:00.000Z', run: '123/1' });
const keptMeasurement = (): TimingMeasurement => singleObservation({ assertion: 'integration:cycle-within-interval', measure: 'coordination cycle', budgetMs: 60_000 }, 412);

/** What GitHub records from the workflow commands the report step prints. */
function annotationsFromCommands(commands: string[]): CheckAnnotation[] {
  return commands.map(command => {
    const match = /^::(notice|warning|error) title=(.*?)::(.*)$/.exec(command)!;
    const unescape = (text: string) => text.replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%25/g, '%');
    return { annotation_level: match[1] === 'error' ? 'failure' : match[1], title: unescape(match[2]), message: unescape(match[3]) };
  });
}

const observedAt = '2026-09-21T02:30:00.000Z';
function heldItem(checkResult: string, overrides: Partial<Work> = {}): Work {
  const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
  return { id: 'work-95', key: 'GY-95', title: 'Required CI checks assert on runner timing', description: '', type: 'bug', priority: 0,
    dependencies: [], criteria: [{ id: 'AC-3', text: 'Reported as timing', proofs: ['unit:timing-failure-reported'] }],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['tests/'], stage: 'test', revision: 12, policyRevision: 1,
    createdAt: '2026-09-21T02:00:00.000Z', updatedAt: observedAt, stageEnteredAt: '2026-09-21T02:25:00.000Z', ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'machine-a', path: '/srv/GY-95-1', branch: 'graphyard/gy-95-1', epoch: 1, owner: 'worker-a' }], implementers: ['worker-a'],
    candidate: { sha, baseSha, pr: 97, branch: 'graphyard/gy-95-1', author: 'worker-a' }, submission: { epoch: 1, pr: 97 },
    reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null,
    observation: { candidate: { sha, baseSha, pr: 97, branch: 'graphyard/gy-95-1', author: 'worker-a' }, at: observedAt, merged: false, mergeSha: null, mergeable: true, protected: true, files: ['tests/a.test.ts'],
      checks: [{ name: 'test', result: 'failure', appId: 15368, id: 4_101 }, { name: 'test', result: checkResult, appId: 15368, id: 4_242, attempt: 2 }, { name: 'typecheck', result: 'success', appId: 15368, id: 4_243 }],
      reviews: [{ reviewer: 'reviewer', sha, state: 'APPROVED' }] },
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
      { name: 'test', passed: checkResult === 'success', reasons: checkResult === 'success' ? [] : ['Required CI check test has not passed on the current candidate'] }],
    violations: [], ...overrides } as unknown as Work;
}

test('unit:timing-failure-reported a required check that failed on a timing assertion is reported in master status with the measured value against the budget, not as an unqualified failed check', async () => {
  // The assertion message and the annotation the CI job publishes both carry the fixed title and the measurement.
  const failed = failedMeasurement(), kept = keptMeasurement();
  assert.equal(timingSummary(failed), 'integration:work-snapshot-latency: coordination snapshot read p95 2092ms over 40 samples (5 warmup discarded; min 640ms, median 1180ms, max 2410ms) against a 2000ms budget, 4.6% over');
  assert.ok(timingFailureMessage(failed).startsWith(`${timingAssertionTitle} integration:work-snapshot-latency: `));
  assert.equal(timingAssertionTitle, masterTimingTitle, 'the test helper and master status agree on the title that marks a timing assertion');
  assert.throws(() => assertWithinBudget(failed, join(tmpdir(), 'graphyard-timing-unused.jsonl')), { message: timingFailureMessage(failed) });
  const commands = annotationCommands([failed, kept]);
  assert.match(commands[0], /^::error title=timing assertion::integration:work-snapshot-latency: .* against a 2000ms budget, 4\.6%25 over$/);
  assert.match(commands[1], /^::notice title=timing assertion::integration:cycle-within-interval: coordination cycle p100 412ms over 1 samples/);
  const markdown = summaryMarkdown([failed, kept]);
  assert.match(markdown, /\| integration:work-snapshot-latency \| coordination snapshot read \| p95 \| 2092ms \| 2000ms \| 40 \(\+5 warmup\) \| 640 \/ 1180 \/ 2410 \| \*\*over budget\*\* \|/);
  assert.match(summaryMarkdown([]), /No timing-dependent assertion recorded/);

  // The required check publishes them: the report path is set for the whole job, the annotations are
  // emitted whatever the outcome of `npm test`, and the report survives as an artifact.
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const testJob = ci.slice(ci.indexOf('\n  test:\n'));
  assert.match(testJob, /GRAPHYARD_TIMING_REPORT: \$\{\{ runner\.temp \}\}\/timing-report\.jsonl/);
  assert.match(testJob, /if: always\(\)\n\s+run: npx tsx tests\/helpers\/timing-report\.ts "\$GRAPHYARD_TIMING_REPORT"/);
  assert.ok(testJob.indexOf('run: npm test') < testJob.indexOf('timing-report.ts'), 'published after the run it reports on');

  // Master status reads the failed check's annotations and tells the timing assertion from a regression.
  const annotations: CheckAnnotation[] = [{ annotation_level: 'failure', title: 'Process completed with exit code 1.', message: 'Process completed with exit code 1.' }, ...annotationsFromCommands(commands)];
  const findings = timingFindings(annotations);
  assert.deepEqual(findings.map(finding => [finding.assertion, finding.passed, finding.measuredMs, finding.budgetMs, finding.statistic]), [['integration:work-snapshot-latency', false, 2_092, 2_000, 'p95'], ['integration:cycle-within-interval', true, 412, 60_000, 'p100']]);
  const work = heldItem('failure');
  assert.deepEqual(failedRequiredCheck(work), { name: 'test', id: 4_242, attempt: 2 }, 'the latest run of the failed required check, not an earlier attempt');
  const read: { name: string; id: number }[] = [];
  const status = nameTimingFailures(buildMasterStatus({ work: [work], now: observedAt }, [], []), [work], 'owner/project', check => { read.push(check); return annotations; });
  assert.deepEqual(read, [{ name: 'test', id: 4_242, attempt: 2 }]);
  const [row] = status.work;
  assert.equal(row.refusal!.gate, 'test');
  assert.match(row.refusal!.reason, /^Required CI check test failed on a timing assertion, which measures the runner as much as the system: integration:work-snapshot-latency: coordination snapshot read p95 2092ms over 40 samples .* against a 2000ms budget, 4\.6% over$/);
  assert.equal(row.refusal!.reason.includes('has not passed'), false, 'the unqualified refusal is replaced');
  // Held for five minutes, well under the hour after which an unqualified refusal would surface: the item is not silent.
  assert.equal(row.attention, row.refusal!.reason);
  assert.match(row.attentionOwner!.next, /^gh run rerun --job 4242 --repo owner\/project re-runs the failed test job/);
  assert.match(row.attentionOwner!.next, /three consecutive runs is a regression to route to rework, never a budget to relax/);
  assert.equal(row.attentionOwner!.role, 'master'); assert.equal(row.attentionOwner!.human, false);
  assert.deepEqual(row.timing, { check: 'test', checkId: 4_242, attempt: 2, failures: [findings[0]], measurements: findings });
  const item = status.attentionItems.find(entry => entry.subject === 'GY-95')!;
  assert.equal(item.text, row.attention); assert.equal(item.next, row.attentionOwner!.next);
  assert.equal(status.counts.attention, 1); assert.deepEqual(status.timing, { checked: ['GY-95'], heldOnTiming: ['GY-95'] });

  // An item that had dwelt long enough for the unqualified refusal to surface has that line replaced, in the row and in the list.
  const dwelt = heldItem('failure', { stageEnteredAt: '2026-09-20T20:00:00.000Z' });
  const before = buildMasterStatus({ work: [dwelt], now: observedAt }, [], []);
  assert.equal(before.work[0].attention, 'Required CI check test has not passed on the current candidate');
  const after = nameTimingFailures(before, [dwelt], 'owner/project', () => annotations);
  assert.equal(after.work[0].attention, after.work[0].refusal!.reason); assert.equal(after.counts.attention, before.counts.attention);
  assert.equal(after.attentionItems.filter(entry => entry.subject === 'GY-95').length, 1);
  assert.equal(after.attentionItems.find(entry => entry.subject === 'GY-95')!.text, after.work[0].attention);

  // A failed check whose annotations carry no timing assertion is a regression: the refusal stands unqualified and nothing is re-run.
  const regression = nameTimingFailures(buildMasterStatus({ work: [work], now: observedAt }, [], []), [work], 'owner/project', () => [annotations[0]]);
  assert.equal(regression.work[0].refusal!.reason, 'Required CI check test has not passed on the current candidate');
  assert.equal(regression.work[0].attention, null); assert.deepEqual(regression.work[0].timing, { check: 'test', checkId: 4_242, attempt: 2, failures: [], measurements: [] });
  assert.deepEqual(regression.timing, { checked: ['GY-95'], heldOnTiming: [] });
  // Annotations that cannot be read leave the row exactly as it was; a passing check is never read.
  const unread = nameTimingFailures(buildMasterStatus({ work: [work], now: observedAt }, [], []), [work], 'owner/project', () => { throw new Error('gh: HTTP 403'); });
  assert.equal(unread.work[0].refusal!.reason, 'Required CI check test has not passed on the current candidate'); assert.equal(unread.work[0].timing, null);
  const passing = heldItem('success');
  assert.equal(failedRequiredCheck(passing), null);
  const green = nameTimingFailures(buildMasterStatus({ work: [passing], now: observedAt }, [], []), [passing], 'owner/project', () => { throw new Error('must not be read'); });
  assert.equal(green.work[0].timing, null); assert.deepEqual(green.timing, { checked: [], heldOnTiming: [] });
  // A check the observation could not identify, or one still running, has no annotations to read.
  const unidentified = heldItem('failure', { observation: { ...work.observation!, checks: [{ name: 'test', result: 'failure', appId: 15368 }] } });
  assert.equal(failedRequiredCheck(unidentified), null);
  const running = heldItem('in_progress');
  assert.equal(failedRequiredCheck(running), null);
});

test('unit:timing-failure-reported the run records every timing assertion with what it measured, and repeated runs record the spread a regression is judged against', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-timing-record-'));
  try {
    const file = join(directory, 'nested', 'timing-report.jsonl');
    const first = { ...failedMeasurement(), measuredMs: 1_400, withinBudget: true };
    recordTiming(first, file); recordTiming(keptMeasurement(), file); recordTiming(failedMeasurement(), file);
    const recorded = readTimingReport(await readFile(file, 'utf8'));
    assert.equal(recorded.length, 3);
    assert.deepEqual(recorded[0], first, 'a measurement survives the round trip whole: samples, warmup reads, budget and verdict');
    assert.deepEqual(recorded.map(entry => [entry.assertion, entry.withinBudget]), [['integration:work-snapshot-latency', true], ['integration:cycle-within-interval', true], ['integration:work-snapshot-latency', false]]);
    assert.throws(() => readTimingReport('{"assertion":\n'), /line 1 is not JSON/);
    const spread = timingSpread(recorded);
    assert.deepEqual(spread.map(entry => ({ assertion: entry.assertion, runs: entry.runs, failures: entry.failures, budgetMs: entry.budgetMs, measured: entry.measuredMs })), [
      { assertion: 'integration:cycle-within-interval', runs: 1, failures: 0, budgetMs: 60_000, measured: { min: 412, median: 412, p95: 412, max: 412 } },
      { assertion: 'integration:work-snapshot-latency', runs: 2, failures: 1, budgetMs: 2_000, measured: { min: 1_400, median: 1_400, p95: 2_092, max: 2_092 } },
    ]);
    assert.equal(spread[1].worstShareOfBudget, 2_092 / 2_000);
    const markdown = stabilityMarkdown({ commit: 'c'.repeat(40), runs: 2, passedRuns: 1, startedAt: '2026-09-21T02:00:00.000Z', finishedAt: '2026-09-21T02:10:00.000Z', results: [], spread });
    assert.match(markdown, /1 of 2 consecutive runs of the required check passed/);
    assert.match(markdown, /\| integration:work-snapshot-latency \| coordination snapshot read \| p95 \| 2 \| 1 \| 1400 \/ 1400 \/ 2092 \/ 2092 \| 2000 \| 105% \|/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
