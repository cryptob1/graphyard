import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureWork, NOW } from '../scripts/dashboard-fixture.mjs';
import type { Work } from '../src/model.js';
import { deliveryLabel } from '../src/model/format.js';
import { plainStatus } from '../src/model/plain-status.js';
import { buildBoard, groupOf } from '../src/model/board.js';

// GY-1845: a done item's outcome must read as where production has carried it, so merged code can
// never pass for shipped. Every post-merge state headlines its own label — 'Merged, awaiting
// deployment', 'Deployed, awaiting verification', 'Production verified', 'Deployed with a
// failure' — on the plain status and on the board row alike, never the word Done and never a bare
// Merged. These tests read the same model functions the dashboard, the item page and `master
// status` render from, over the checked-in fixture's delivered item reshaped into each state.

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

    // The board row the item lands on carries the same outcome; a state whose release already
    // serves it has left the open board, and says so through `shipped`, not through a bare Merged.
    const group = groupOf(item, NOW);
    if (group === 'shipped') {
      assert.equal(state === 'smoke-passed' || state === 'delivered', true, `${state} left the open board`);
    } else {
      const board = buildBoard([item], NOW);
      const row = [...board.groups.moving, ...board.groups.blocked].find(entry => entry.key === item.key);
      assert.ok(row, `${state}: the item has a board row`);
      assert.equal(row!.outcome, status.outcome, `${state}: the board row headlines the same outcome`);
      assert.ok(!/\bDone\b/.test(row!.outcome!), state);
    }
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
