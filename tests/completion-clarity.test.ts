import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureWork, NOW } from '../scripts/dashboard-fixture.mjs';
import type { Work } from '../src/model.js';
import { deliveryLabel } from '../src/model/format.js';
import { plainStatus } from '../src/model/plain-status.js';
import { buildBoard, groupOf, groups } from '../src/model/board.js';

// GY-1845, under GY-1979's board: a done item's outcome must read as where production has carried
// it, so merged code can never pass for shipped. Every post-merge state headlines its own label —
// 'Merged, awaiting deployment', 'Deployed, awaiting verification', 'Production verified', 'Deployed
// with a failure' — on the plain status the item page reads, never the word Done and never a bare
// Merged. The board itself no longer carries merged rows at all (GY-1979): a merged item is Done
// and has left every group, and the top bar's one release line carries the deployment. These tests
// read the same model functions the dashboard, the item page and `master status` render from, over
// the checked-in fixture's delivered item reshaped into each state.

const work = fixtureWork() as Work[];
const find = (key: string) => work.find(item => item.key === key)!;

// GY-18 is the fixture's delivered item: merged, no deployment record, no smoke policy.
const base = find('GY-18');
const mergedAt = Date.parse(base.delivery!.mergedAt);
const iso = (offsetMinutes: number) => new Date(mergedAt + offsetMinutes * 60_000).toISOString();
// A deployment the production watch observed serving the merge, and the two smoke verdicts.
const deployedSha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345a6b';
const deployment = { sha: deployedSha, mergeSha: base.delivery!.mergeSha, source: 'endpoint' as const, covers: 'exact' as const, observedAt: iso(30), at: iso(30), observer: 'master' };
const smoke = (result: 'pass' | 'fail') => ({ evidenceId: `evidence-smoke-${result}`, result, sha: deployedSha, mergeSha: base.delivery!.mergeSha, producer: 'graphyard-producer-1', at: iso(120), executed: 8, skipped: 0 });

const inState = (delivery: Work['delivery'], deploySmoke = true) =>
  ({ ...base, policy: { ...base.policy, deploySmoke }, delivery }) as unknown as Work;

const awaitingDeployment = inState({ ...base.delivery! });
const awaitingSmoke = inState({ ...base.delivery!, deployment });
const smokePassed = inState({ ...base.delivery!, deployment, smoke: smoke('pass') });
const deliveredWithFailure = inState({ ...base.delivery!, deployment, smoke: smoke('fail') });
// Its own shape — no smoke policy — stays the delivered state: shipped at its merge.
const delivered = inState({ ...base.delivery! }, false);

const states: [keyof typeof deliveryLabel, Work][] = [
  ['awaiting-deployment', awaitingDeployment],
  ['awaiting-smoke', awaitingSmoke],
  ['smoke-passed', smokePassed],
  ['delivered-with-failure', deliveredWithFailure],
  ['delivered', delivered],
];

test('unit:completion-states-shown — a delivered item in every DeliveryState headlines that state\'s own label on the plain status and its board row, never Done and never Merged alone (GY-1845)', () => {
  // Each state has exactly one own label, the labels are distinct, and none reads as Done or as a bare Merged.
  assert.deepEqual(deliveryLabel, {
    delivered: 'Delivered',
    'awaiting-deployment': 'Merged, awaiting deployment',
    'awaiting-smoke': 'Deployed, awaiting verification',
    'smoke-passed': 'Production verified',
    'delivered-with-failure': 'Deployed with a failure',
  });
  assert.equal(new Set(Object.values(deliveryLabel)).size, 5, 'every state headlines a distinct label');
  for (const label of Object.values(deliveryLabel)) {
    assert.notEqual(label, 'Done', label);
    assert.notEqual(label, 'Merged', label);
    assert.ok(!/^\s*Done\b/.test(label) && !/\bDone\b/.test(label), `${label} must not say Done`);
  }

  for (const [state, item] of states) {
    const label = deliveryLabel[state];
    const status = plainStatus(item, NOW);
    // The plain-status headline is the state's own label, with the serving release named beside it
    // wherever a deployment was observed; before that observation nothing may imply a release.
    assert.ok(status.outcome && status.outcome.startsWith(label), `${state}: outcome ${JSON.stringify(status.outcome)} does not headline "${label}"`);
    assert.equal(status.outcome !== 'Merged' && status.outcome !== 'Done', true, state);
    if (state === 'awaiting-deployment' || state === 'delivered') assert.equal(status.outcome, label, `${state}: with no deployment record there is no serving release to name`);
    else assert.match(status.outcome!, / — release a1b2c3d4 serving it$/, state);
    assert.equal(status.phase, 'shipped', state);

    // GY-1979: a merged item is Done and has left the open board in every delivery state — the
    // release line on the top bar carries the deployment, not a board row. Its page still renders
    // from the same plain status, so the state's own label stays the headline the operator reads.
    assert.equal(groupOf(item, NOW), 'shipped', `${state}: a merged item has left the board`);
    const board = buildBoard([item], NOW);
    for (const group of groups) assert.ok(!board.groups[group].some(entry => entry.key === item.key), `${state}: no ${group} row for a merged item`);
  }
});

test('unit:completion-states-sentences — the three post-merge sentences that are not fixed by the dashboard copy lead with their state, and the five states read apart (GY-1845)', () => {
  assert.equal(plainStatus(awaitingSmoke, NOW).sentence, 'Deployed, awaiting verification — PR #40');
  assert.equal(plainStatus(smokePassed, NOW).sentence, 'Production verified — PR #40');
  assert.equal(plainStatus(deliveredWithFailure, NOW).sentence, 'Deployed with a failure — the check after deploying failed (PR #40)');
  // No smoke policy: delivered at its merge, the one state whose merge is its shipment.
  assert.equal(plainStatus(delivered, NOW).sentence, 'Shipped in PR #40');
  // Five done states, five different sentences: no two delivery states can be mistaken for each other.
  const sentences = states.map(([, item]) => plainStatus(item, NOW).sentence);
  assert.equal(new Set(sentences).size, 5, sentences.join(' | '));
});
