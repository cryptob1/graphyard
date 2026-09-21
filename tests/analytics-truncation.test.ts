import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFlow, coveredWindow, flowDrilldown, flowExport, flowLimits, type FlowDataset, type FlowFact, type FlowQuery, type FlowWindow } from '../src/flow-analytics.js';
import type { Work } from '../src/model.js';

const day = 86_400_000;
const to = Date.parse('2026-09-20T00:00:00.000Z');
const from = to - 30 * day;
const at = (ms: number) => new Date(ms).toISOString();

const item = { id: '11111111-2222-4333-8444-555555555555', key: 'GY-1', title: 'Truncation fixture', type: 'feature', stage: 'build', plannedFiles: ['src/'], criteria: [], evidence: [], gates: [], violations: [], observation: null } as unknown as Work;
const fact = (kind: string, observedAt: number): FlowFact => ({
  id: observedAt, workId: item.id, workKey: item.key, kind: kind as FlowFact['kind'], observedAt: at(observedAt), recordedAt: at(observedAt),
  source: 'graphyard', sourceEvent: observedAt, stage: 'build', workType: 'feature', slices: ['src'], details: {}, dedupe: `${kind}:${observedAt}`,
});

/** A scan that stopped one day into a thirty-day window, exactly as an exhausted row bound does. */
function dataset(overrides: Partial<FlowDataset> = {}): FlowDataset {
  const facts = [fact('work.created', from), fact('lease.claimed', from + day / 2), fact('stage.changed', from + day)];
  return {
    observedAt: at(to), from: at(from), to: at(to), days: 30 as FlowWindow, work: [item], included: [item],
    facts, latest: [], carryIn: [], deployments: [], mergedForDeployments: [],
    scanned: facts.length, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false,
    projection: { lastEvent: 10, updatedAt: at(to), pendingEvents: 0, pendingCapped: false }, ...overrides,
  };
}
const query: FlowQuery = { days: 30 as FlowWindow };

test('unit:analytics-truncation-disclosure — a flow report whose fact scan hit its row bound states the interval it actually covered, the share of the requested window that is, and how much it never examined, instead of returning a partial window as a whole one', () => {
  // The disclosure itself: covered interval, share, the gap nobody looked at, and the remainder.
  const covered = coveredWindow(at(from), at(to), at(from + day), 4_212, flowLimits.scan);
  assert.equal(covered.truncated, true);
  assert.equal(covered.from, at(from));
  assert.equal(covered.to, at(to), 'the window that was asked for is still stated');
  assert.equal(covered.toCovered, at(from + day));
  assert.equal(covered.ms, day);
  assert.equal(covered.windowMs, 30 * day);
  assert.equal(covered.fraction, 0.0333);
  assert.deepEqual(covered.uncovered, { from: at(from + day), to: at(to), ms: 29 * day });
  assert.equal(covered.remainingFacts, 4_212);
  assert.equal(covered.remainingCapped, false);
  assert.match(covered.statement, /reached its 20,000-row bound/);
  assert.match(covered.statement, /2026-08-21T00:00:00\.000Z to 2026-08-22T00:00:00\.000Z/);
  assert.match(covered.statement, /3%/);
  assert.match(covered.statement, /4,212 fact\(s\) between 2026-08-22T00:00:00\.000Z and 2026-09-20T00:00:00\.000Z were not examined/);
  assert.match(covered.statement, /Every figure below describes the covered interval only/);
  // A remainder that fills its own probe is reported as a floor, never as an exact total.
  const capped = coveredWindow(at(from), at(to), at(from + day), flowLimits.remainingProbe + 1, flowLimits.scan);
  assert.equal(capped.remainingCapped, true);
  assert.equal(capped.remainingFacts, flowLimits.remainingProbe);
  assert.match(capped.statement, /at least 100,000 fact\(s\)/);
  // A scan that reached the end of the window covers all of it; a zero-length window is not a division by zero.
  assert.equal(coveredWindow(at(from), at(to), at(to), 0, flowLimits.scan).fraction, 1);
  assert.equal(coveredWindow(at(to), at(to), at(to), 0, flowLimits.scan).fraction, 1);
  // A last-covered instant outside the window is clamped into it rather than reported as coverage.
  assert.equal(coveredWindow(at(from), at(to), at(to + day), 0, flowLimits.scan).toCovered, at(to));
  assert.equal(coveredWindow(at(from), at(to), at(from - day), 0, flowLimits.scan).ms, 0);

  // An untruncated report states the whole window as covered, and is complete.
  const whole = computeFlow(dataset(), query);
  assert.equal(whole.window.truncated, false);
  assert.equal(whole.window.covered.toCovered, at(to));
  assert.equal(whole.window.covered.fraction, 1);
  assert.equal(whole.coverage.truncated, false);
  assert.equal(whole.coverage.complete, true);
  assert.equal(whole.coverage.covered.statement, 'The scan covered the whole requested window.');

  // The same report from a truncated scan names the window it was asked for and the interval it
  // describes, and is not complete.
  const partial = computeFlow(dataset({ truncated: true, covered }), query);
  assert.equal(partial.window.days, 30);
  assert.equal(partial.window.from, at(from));
  assert.equal(partial.window.to, at(to), 'the requested window is never rewritten to hide the shortfall');
  assert.equal(partial.window.truncated, true);
  assert.deepEqual(partial.window.covered, covered);
  assert.deepEqual(partial.coverage.covered, covered);
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.coverage.scanLimit, flowLimits.scan);
  assert.equal(partial.coverage.oldestFact, at(from));
  assert.equal(partial.coverage.newestFact, at(from + day));

  // An export of that report carries the disclosure in its own rows, so a CSV read away from the
  // API cannot present a one-day scan as a thirty-day window.
  const drilldown = flowDrilldown(dataset({ truncated: true, covered }), partial, { metric: 'bottleneck', key: null, authorized: false });
  const exported = JSON.parse(flowExport(partial, drilldown, 'json'));
  assert.equal(exported.metadata.window, `${at(from)}/${at(to)}`);
  assert.equal(exported.metadata.windowCovered, `${at(from)}/${at(from + day)}`);
  assert.equal(exported.metadata.windowTruncated, true);
  assert.equal(exported.metadata.windowCoveredFraction, 0.0333);
  assert.equal(exported.metadata.windowCoverage, covered.statement);
  assert.equal(exported.metadata.coverageComplete, false);
  const csv = flowExport(partial, drilldown, 'csv');
  assert.match(csv, /# windowTruncated,true/);
  assert.match(csv, /# windowCovered,2026-08-21T00:00:00\.000Z\/2026-08-22T00:00:00\.000Z/);
  const wholeCsv = flowExport(whole, flowDrilldown(dataset(), whole, { metric: 'bottleneck', key: null, authorized: false }), 'csv');
  assert.match(wholeCsv, /# windowTruncated,false/);
});
