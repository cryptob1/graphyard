import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureWork, NOW } from '../scripts/dashboard-fixture.mjs';
import type { Work } from '../src/model.js';
import { deliveryLabel } from '../src/model/format.js';
import { plainStatus } from '../src/model/plain-status.js';
import { buildBoard, groupOf } from '../src/model/board.js';

// GY-1845: a done item's outcome headlines its delivery state, never the word Done and never a bare
// Merged. GY-1981: done = merged, so every merged item is Delivered whatever its smoke policy or
// deployment record, on the plain status and the board alike; a release recorded serving it on an
// older delivery is named beside the label. These tests read the same model functions the
// dashboard, the item page and `master status` render from, over the checked-in fixture's
// delivered item reshaped into each shape it can carry.

const work = fixtureWork() as Work[];
const find = (key: string) => work.find(item => item.key === key)!;

// GY-18 is the fixture's delivered item: merged, no deployment record, no smoke policy.
const base = find('GY-18');
const mergedAt = Date.parse(base.delivery!.mergedAt);
const iso = (offsetMinutes: number) => new Date(mergedAt + offsetMinutes * 60_000).toISOString();
const deployedSha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345a6b';
const deployment = { sha: deployedSha, mergeSha: base.delivery!.mergeSha, source: 'endpoint' as const, covers: 'exact' as const, observedAt: iso(30), at: iso(30), observer: 'master' };
const smoke = (result: 'pass' | 'fail') => ({ evidenceId: `evidence-smoke-${result}`, result, sha: deployedSha, mergeSha: base.delivery!.mergeSha, producer: 'graphyard-producer-1', at: iso(120), executed: 8, skipped: 0 });

const inState = (delivery: Work['delivery'], deploySmoke = true) =>
  ({ ...base, policy: { ...base.policy, deploySmoke }, delivery }) as unknown as Work;

const shapes: [string, Work][] = [
  ['smoke policy, no deployment record', inState({ ...base.delivery! })],
  ['deployment recorded', inState({ ...base.delivery!, deployment })],
  ['smoke passed', inState({ ...base.delivery!, deployment, smoke: smoke('pass') })],
  ['smoke failed', inState({ ...base.delivery!, deployment, smoke: smoke('fail') })],
  ['no smoke policy', inState({ ...base.delivery! }, false)],
];

test('unit:completion-states-shown — a merged item headlines Delivered on the plain status and is shipped on the board, never Done and never Merged alone (GY-1845, GY-1981)', () => {
  assert.deepEqual(deliveryLabel, { delivered: 'Delivered' });
  for (const [shape, item] of shapes) {
    const status = plainStatus(item, NOW);
    if (item.delivery!.deployment) assert.equal(status.outcome, 'Delivered — release a1b2c3d4 serving it', shape);
    else assert.equal(status.outcome, 'Delivered', `${shape}: with no deployment record there is no serving release to name`);
    assert.equal(status.phase, 'shipped', shape);
    assert.equal(status.sentence, 'Shipped in PR #40', shape);
    assert.equal(groupOf(item, NOW), 'shipped', `${shape} left the open board`);
    assert.equal(buildBoard([item], NOW).open, 0, shape);
  }
});
