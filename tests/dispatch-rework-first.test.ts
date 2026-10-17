import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSort, dispatchStarvationMs } from '../src/coordination.js';
import { dispatchSchedule } from '../src/master/status.js';
import type { Work } from '../src/model.js';

// GY-1891: dispatch finishes before it starts — an item returning for rework is offered before a
// never-attempted item of the same priority. A rework has already been built and reviewed once and
// is the nearest thing to a merge; holding it while fresh work starts raises work in progress and
// delays merges. `dispatchSort` — the order the loop's dispatch step and master status's schedule
// both offer — ranks an item that already carries an attempt (a standing submission, or a recorded
// pipeline attempt) ahead of the starvation, hot-file and scope keys within one priority; priority
// still decides first, and within each group the existing order stands unchanged.
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hotFile = 'src/daemon/cycle-sessions.ts';

function work(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(0),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
/** A returned rework: the earlier attempt's submission stands, sent back for a new claim. */
const rework = (key: string, plannedFiles: string[], overrides: Partial<Work> = {}) =>
  work(key, { stage: 'build', plannedFiles, submission: { epoch: 1, pr: 7 }, reworkRequested: true, ...overrides });
/** A retry: an earlier attempt ended without submitting, so the pipeline records it and no submission stands. */
const retried = (key: string, plannedFiles: string[], overrides: Partial<Work> = {}) =>
  work(key, { plannedFiles, pipeline: { attempts: [{ epoch: 1, owner: `${key}-worker`, claimedAt: iso(-7_200_000), endedAt: iso(-3_600_000), end: 'expired' }], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } }, ...overrides });
const claimed = (key: string, plannedFiles: string[]) =>
  work(key, { stage: 'build', plannedFiles, epoch: 1, lease: { owner: `${key}-worker`, epoch: 1, expiresAt: iso(600_000) } });

test('unit:dispatch-reworks-before-fresh-items — dispatchSort offers every same-priority item that already carries an attempt before every never-attempted one, whatever their scope, heat or wait; within each group the existing order stands', () => {
  const heat = new Set([hotFile]);
  // The attempted pair: a retry that is narrow, cold and long-waiting, and a returned rework that
  // is broad, hot and only just sent back — the old keys would put the retry first regardless.
  const narrowRetry = retried('GY-retryNarrow', ['docs/one.md'], { createdAt: iso(-30 * 60_000), stageEnteredAt: iso(-30 * 60_000) });
  const broadHotRework = rework('GY-reworkBroad', ['src/', 'tests/', hotFile], { createdAt: iso(-2 * 60_000), stageEnteredAt: iso(-60_000) });
  // The fresh trio: one starving and narrow, one cold, one just created — the old keys' order.
  const starvingFresh = work('GY-starvingFresh', { plannedFiles: ['docs/one.md'], createdAt: iso(-2 * dispatchStarvationMs), stageEnteredAt: iso(-2 * dispatchStarvationMs) });
  const coldFresh = work('GY-coldFresh', { plannedFiles: ['docs/two.md'], createdAt: iso(-30 * 60_000), stageEnteredAt: iso(-30 * 60_000) });
  const newFresh = work('GY-newFresh', { plannedFiles: ['docs/three.md'], createdAt: iso(-60_000), stageEnteredAt: iso(-60_000) });
  const mixed = [newFresh, broadHotRework, starvingFresh, narrowRetry, coldFresh];
  assert.deepEqual(dispatchSort(mixed, heat, clock).map(item => item.key),
    ['GY-retryNarrow', 'GY-reworkBroad', 'GY-starvingFresh', 'GY-coldFresh', 'GY-newFresh'],
    'both attempted items precede every fresh one — the rework is broad, hot and newest, the starving fresh item has waited two bounds — and each group keeps the old order');
  assert.ok(dispatchSort([broadHotRework, starvingFresh], heat, clock)[0] === broadHotRework, 'a broad, hot, just-returned rework is still offered before a starving fresh item: the attempt key outranks wait');
  assert.ok(dispatchSort([newFresh, narrowRetry], new Set())[0] === narrowRetry, 'the key holds without a clock or heat, as the empty defaults give the cold order');
  // master status's schedule offers this same order: two live attempts heat the file, the
  // dispatchable five are offered in the loop's order.
  const all = [claimed('GY-hotA', [hotFile]), claimed('GY-hotB', [hotFile]), ...mixed];
  assert.deepEqual(dispatchSchedule(all, clock).order.map(entry => entry.key),
    ['GY-retryNarrow', 'GY-reworkBroad', 'GY-starvingFresh', 'GY-coldFresh', 'GY-newFresh'],
    'the dispatch schedule reports the loop\'s order: reworks and retries before fresh work within the priority');
});

test('unit:dispatch-rework-first-keeps-priority — a higher-priority fresh item still ranks before a lower-priority rework, and a starving fresh item still ranks before a non-starving fresh one', () => {
  // The fresh item is the broader scope, so only priority can decide the pair.
  const broadFresh = work('GY-freshP0', { priority: 0, plannedFiles: ['src/', 'tests/'], createdAt: iso(-60_000), stageEnteredAt: iso(-60_000) });
  const narrowRework = rework('GY-reworkP1', ['docs/one.md'], { priority: 1 });
  assert.deepEqual(dispatchSort([narrowRework, broadFresh], new Set(), clock).map(item => item.key), ['GY-freshP0', 'GY-reworkP1'],
    'priority still decides first: a P0 fresh item outranks a P1 rework even across a broader scope');
  const starvingFresh = work('GY-starvingFresh', { plannedFiles: ['docs/one.md'], createdAt: iso(-2 * dispatchStarvationMs), stageEnteredAt: iso(-2 * dispatchStarvationMs) });
  const newFresh = work('GY-newFresh', { plannedFiles: ['docs/two.md'], createdAt: iso(-60_000), stageEnteredAt: iso(-60_000) });
  assert.deepEqual(dispatchSort([newFresh, starvingFresh], new Set(), clock).map(item => item.key), ['GY-starvingFresh', 'GY-newFresh'],
    `among never-attempted items the starvation rule stands: past dispatchStarvationMs (${dispatchStarvationMs}ms) still offers first`);
});
