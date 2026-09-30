import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFlow, coveredWindow, dayBuckets, flowExport, flowDrilldown, flowLimits, flowWindowLabel, flowWindowMessage, flowWindows, type FlowDataset, type FlowFact, type FlowQuery, type FlowWindow } from '../src/flow-analytics.js';
import { attributionWindows } from '../src/attribution.js';
import type { Work } from '../src/model.js';

const day = 86_400_000, hour = 3_600_000;
// Observed mid-day, so the 24-hour window spans two UTC calendar days.
const to = Date.parse('2026-09-20T15:00:00.000Z');
const from = to - day;
const at = (ms: number) => new Date(ms).toISOString();

const item = { id: '11111111-2222-4333-8444-555555555556', key: 'GY-2', title: '24-hour fixture', type: 'feature', stage: 'build', plannedFiles: ['src/'], criteria: [], evidence: [], gates: [], violations: [], observation: null } as unknown as Work;
const fact = (kind: string, observedAt: number): FlowFact => ({
  id: observedAt, workId: item.id, workKey: item.key, kind: kind as FlowFact['kind'], observedAt: at(observedAt), recordedAt: at(observedAt),
  source: 'graphyard', sourceEvent: observedAt, stage: 'build', workType: 'feature', slices: ['src'], details: {}, dedupe: `${kind}:${observedAt}`,
});
function dataset(overrides: Partial<FlowDataset> = {}): FlowDataset {
  const facts = [fact('work.created', from + hour), fact('lease.claimed', from + 2 * hour), fact('stage.changed', from + 3 * hour)];
  return {
    observedAt: at(to), from: at(from), to: at(to), days: 1 as FlowWindow, work: [item], included: [item],
    facts, latest: [], carryIn: [], deployments: [], mergedForDeployments: [],
    scanned: facts.length, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false,
    projection: { lastEvent: 10, updatedAt: at(to), pendingEvents: 0, pendingCapped: false }, ...overrides,
  };
}
const query: FlowQuery = { days: 1 };

test('unit:flow-window-24h — flow analytics offers a 24-hour window beside 7, 30 and 90 days, the schema message names it, and the existing partial-window and sparse notices cover it', () => {
  // The window set, its attribution twin, and how each window reads.
  assert.deepEqual([...flowWindows], [1, 7, 30, 90]);
  assert.deepEqual([...attributionWindows], [1, 7, 30, 90]);
  assert.equal(flowWindowLabel(1), '24 hours');
  assert.equal(flowWindowLabel(30), '30 days');
  assert.equal(flowWindowMessage, 'Window must be 24 hours, 7 days, 30 days, 90 days');

  // One daily bucket (today), holding the pre-midnight sliver, and never flagged as truncated.
  const buckets = dayBuckets(from, to, 1);
  assert.deepEqual(buckets.starts, [Date.parse('2026-09-20T00:00:00.000Z')]);
  assert.equal(buckets.truncated, false);
  assert.equal(buckets.bucketOf(from), buckets.starts[0], 'the sliver before midnight counts in the one bucket');
  assert.equal(buckets.bucketOf(from - 1), null);
  assert.equal(buckets.bucketOf(to), null);

  // A 24-hour report is its own window: one bucket, a one-day span, and too few facts reads sparse.
  const report = computeFlow(dataset(), query);
  assert.equal(report.window.days, 1);
  assert.equal(Date.parse(report.window.to) - Date.parse(report.window.from), day);
  assert.equal(report.coverage.sparse, true);
  assert.equal(report.coverage.complete, true);
  assert.equal(report.window.truncated, false);

  // A scan bound hit inside the 24 hours is disclosed in hours, and the report is not complete.
  const covered = coveredWindow(at(from), at(to), at(from + 6 * hour), 40, flowLimits.scan);
  assert.equal(covered.windowMs, day);
  assert.equal(covered.fraction, 0.25);
  assert.match(covered.statement, /\(6 h of the requested 24 h, 25%\)/);
  const partial = computeFlow(dataset({ truncated: true, covered }), query);
  assert.equal(partial.coverage.truncated, true);
  assert.equal(partial.coverage.complete, false);
  assert.deepEqual(partial.window.covered, covered);

  // The export states the 24-hour window it describes.
  const csv = flowExport(partial, flowDrilldown(dataset({ truncated: true, covered }), partial, { metric: 'bottleneck', key: null, authorized: false }), 'csv');
  assert.match(csv, /\n# windowDays,1\n/);
  assert.match(csv, /# windowTruncated,true/);
});
