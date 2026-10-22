import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { actorlessSubmissions } from '../src/cli/actorless-submissions.js';
import { syncConflict } from '../src/daemon/rework.js';
import { reviewNeed } from '../src/model/dispatch.js';
import { baseRefreshConflict } from '../src/model/base-refresh.js';
import { coordinationSnapshot } from '../src/server/work-view.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1557: two `actorless` submissions (GY-1522, GY-1526) were counted while the product's own remedy
// was in motion, because the base-conflict bound was anchored to a moment before the hold existed.
// The bound now runs from the hold's first sighting; each instance is replayed from the ledger
// (tests/fixtures/gy-1557-stalled-gate.json) as the item stood when the loop recorded it.

interface Conflict { at: string; base: string; baseSha: string }
interface Instance {
  id: string; kind: 'actorless' | 'unsubmitted-attempt'; subject: string; at: string; epoch: number; movedAt: string; moved: string;
  pr?: number; claimedAt?: string; submittedAt?: string; headObservedAt?: string; holdSightedAt?: string; sha?: string; baseSha?: string; baseTip?: string; baseMovedAt?: string;
  observedAt?: string; mergeable?: boolean | null; conflicting?: boolean; conflicts?: Conflict[];
  owner?: string; leaseExpiresAt?: string; sessionObservedAt?: string;
}
const instances: Instance[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gy-1557-stalled-gate.json', import.meta.url)), 'utf8'));
const shift = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
const minute = 60_000;
const baseConflictWaitBoundMs = 30 * minute;
async function holds() {
  const declared = await import('../src/model/behind-base.js');
  assert.equal(typeof declared.observeBaseHold, 'function', 'the observation write records the hold\'s first sighting');
  assert.equal(typeof declared.baseHoldSightedAt, 'function', 'the actorless bound reads the sighting');
  return declared;
}

const conflictText = (sha: string, base: string) => `Candidate ${sha.slice(0, 12)} cannot be brought onto base branch tip ${base.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: Merge of ${base.slice(0, 12)} into graphyard-merge-check/gy conflicts and cannot be resolved by Graphyard.`;
/**
 * The submitted item as the record held it: a head the base moved past, its stage entered at the
 * claim, no request of any kind raised; the control plane's confirmed conflicts as `baseRefresh`
 * (the newest, dated from the first on this head: GY-1200), the head's first observation, and the
 * hold's first sighting where the observation write recorded one.
 */
function submitted(instance: Instance, overrides: Partial<Work> = {}): Work {
  const candidate = { sha: instance.sha!, baseSha: instance.baseSha!, pr: instance.pr!, branch: `graphyard/${instance.subject.toLowerCase()}-${instance.epoch}`, author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: instance.mergeable, conflicting: instance.conflicting, protected: true, files: ['src/a.ts'], scopeFiles: [],
    at: instance.observedAt, prState: 'open', draft: false, baseTip: instance.baseTip, baseTree: instance.baseTip, baseTipContained: false } as unknown as Observation;
  const conflicts = instance.conflicts ?? [], last = conflicts.at(-1);
  const baseRefresh = last ? { from: { sha: instance.sha!, baseSha: last.baseSha }, base: last.base, baseTree: last.base, policyRevision: 1, at: last.at, head: null,
    conflict: conflictText(instance.sha!, last.base), conflictPaths: ['src/daemon/cycle.ts', 'src/daemon/state.ts'], trigger: 'conflict confirmed', conflictSince: conflicts[0]!.at } : null;
  return { id: `work-${instance.subject}`, key: instance.subject, title: instance.subject, description: '', type: 'bug', priority: 1, dependencies: [], 
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'build', revision: 1, policyRevision: 1,
    createdAt: instance.claimedAt, updatedAt: instance.observedAt, stageEnteredAt: instance.claimedAt, ready: true, epoch: instance.epoch, lease: null, workspaces: [],
    candidate, submission: { epoch: instance.epoch, pr: instance.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, escalations: [],
    headObserved: { pr: instance.pr, sha: instance.sha, at: instance.headObservedAt }, ...(instance.holdSightedAt ? { baseHold: { sha: instance.sha, at: instance.holdSightedAt } } : {}), baseRefresh,
    autoDispatch: { review: null, producers: [], history: [] }, actionQueue: { actions: [], history: [] }, gates: [], violations: [], proofGaps: [], scopeRequest: null, containmentQuarantine: null, ...overrides } as unknown as Work;
}
/** The item as the loop reads it, with the actorless lines master status reports at `at`. */
function stalledGate(stored: Work, at: string) {
  const [work] = coordinationSnapshot({ work: [stored] }).work;
  assert.equal((work as unknown as { pipeline?: unknown }).pipeline, undefined, 'the loop reads the item without its pipeline timeline');
  return { work, reported: actorlessSubmissions([work], new Date(at)) };
}

for (const instance of instances.filter(entry => entry.kind === 'actorless')) {
  const confirmed = !!instance.conflicts?.length;
  test(`manual:fault-class-stalled-gate — ${instance.id}: a hold the base's late move opened is in motion for the bound from its sighting, not from the submission`, () => {
    const work = submitted(instance);
    // The reading the instance recorded: a sync is the missing actor, nothing named, hours or minutes past the 5-minute actorless bound.
    assert.equal(reviewNeed(work, [work], new Date(instance.at)).state, 'base-not-contained');
    const { work: viewed, reported } = stalledGate(work, instance.at);
    assert.ok(viewed.headObserved, 'the coordination view keeps the head observation the bound is read from');
    assert.equal(reported.length, 1, 'master status still names the line, so the wait stays visible');
    assert.match(reported[0].text, /no rework request and no named wait; missing a sync rework/);
    assert.match(reported[0].text, confirmed ? /cannot be brought onto it without resolving a conflict/ : /GitHub reports a merge conflict with that base/);
    assert.match(reported[0].text, new RegExp(`has been submitted for ${Math.round((Date.parse(instance.at) - Date.parse(instance.claimedAt!)) / minute)}m`), 'dated from the stage entry, as the instance was');
    // The loop's own remedy stands on the record: the confirmed conflict grounds its rework request; GitHub's conflict is its sync rework decision.
    if (confirmed) assert.ok(baseRefreshConflict(viewed), 'the control plane\'s test merge confirmed the conflict');
    else assert.ok(syncConflict(viewed), 'the routine decision step requests the sync rework for this head');
  });

}

for (const instance of instances.filter(entry => entry.kind === 'actorless')) {
  const confirmed = !!instance.conflicts?.length;
  test(`unit:base-hold-bound — ${instance.id}: the actorless bound runs from the hold's first sighting`, async () => {
    const { baseHoldSightedAt } = await holds();
    const { work: viewed, reported } = stalledGate(submitted(instance), instance.at);
    assert.ok(confirmed ? viewed.baseRefresh?.conflictSince : viewed.baseHold, 'the coordination view keeps the sighting record');
    assert.equal(baseHoldSightedAt(viewed), confirmed ? instance.conflicts![0]!.at : instance.holdSightedAt);
    assert.equal(reported[0].inMotionUntil, shift(baseHoldSightedAt(viewed)!, baseConflictWaitBoundMs));
  });
}

test('unit:base-hold-sighting — the hold\'s first sighting is set once per head, kept while the hold stands across base moves, cleared when it clears, and read from the control plane\'s first confirmed conflict when one stands', async () => {
  const { observeBaseHold, baseHoldSightedAt } = await holds();
  const instance = instances.find(entry => entry.subject === 'GY-1526')!;
  const work = submitted(instance, { baseHold: null, observation: { ...submitted(instance).observation, mergeable: null, conflicting: false } } as unknown as Partial<Work>);
  const t = (n: number) => shift(instance.submittedAt!, n * minute);
  observeBaseHold(work, t(0));
  assert.deepEqual(work.baseHold, { sha: instance.sha, at: t(0) }, 'GitHub has not computed mergeability: the hold is sighted');
  work.observation = { ...work.observation!, at: t(1), baseTip: 'e'.repeat(40), baseTree: 'e'.repeat(40), mergeable: false, conflicting: true };
  observeBaseHold(work, t(1));
  assert.deepEqual(work.baseHold, { sha: instance.sha, at: t(0) }, 'the base moving under a conflicting head keeps the sighting');
  assert.equal(baseHoldSightedAt(work), t(0));
  work.observation = { ...work.observation!, at: t(2), mergeable: true, conflicting: false };
  observeBaseHold(work, t(2));
  assert.equal(work.baseHold, null, 'a head GitHub reports mergeable stands under no hold');
  assert.equal(baseHoldSightedAt(work), null);
  work.observation = { ...work.observation!, at: t(3), mergeable: false, conflicting: true };
  observeBaseHold(work, t(3));
  assert.deepEqual(work.baseHold, { sha: instance.sha, at: t(3) }, 'a hold that returns is a new sighting');
  work.candidate = { ...work.candidate!, sha: 'd'.repeat(40) }; work.observation = { ...work.observation!, at: t(4), candidate: work.candidate };
  observeBaseHold(work, t(4));
  assert.deepEqual(work.baseHold, { sha: 'd'.repeat(40), at: t(4) }, 'a hold on a new head is a new sighting');
  // The control plane's confirmed conflict dates the hold from its first conflict on the head, whatever the observation write recorded.
  const earlier = instances.find(entry => entry.subject === 'GY-1522')!;
  assert.equal(baseHoldSightedAt(submitted(earlier, { baseHold: { sha: earlier.sha, at: earlier.observedAt } } as Partial<Work>)), earlier.conflicts![0]!.at);
});

// ---- the observation write records the sighting -------------------------------------------------

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1557;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('base-hold'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = [operator, worker];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('integration:base-hold-observed — the observation write records when the current head was first read withheld behind the base, keeps it across a base move, and clears it when GitHub reports the head mergeable', async () => {
  await holds();
  const head = 'a'.repeat(40), base = 'b'.repeat(40), moved = 'c'.repeat(40);
  let item = await engine.execute(operator, 'create', null, { title: 'Base hold', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:base-hold-fixture'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/base-hold/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}` }, randomUUID());
  item = await engine.execute(worker, 'submit', item.id, { epoch: item.epoch, pr: 77 }, randomUUID());
  const reload = async () => (await store.list()).find(entry => entry.id === item.id)!;
  const observe = async (at: string, reading: Partial<Record<keyof Observation, unknown>>) => {
    const current = await reload();
    await engine.observe(item.id, current.revision, { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: 77, branch: current.workspaces.at(-1)!.branch, author: 'implementer' },
      checks: [], reviews: [], protected: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], prState: 'open', draft: false, baseTree: 'd'.repeat(40),
      at, baseTip: base, baseTipContained: false, mergeable: null, ...reading } as unknown as Observation);
    return reload();
  };
  const first = await observe('2026-10-08T18:20:27.699Z', { mergeable: null });
  assert.deepEqual(first.baseHold, { sha: head, at: '2026-10-08T18:20:27.699Z' }, 'the first observation that reads the hold dates it');
  const polled = await observe('2026-10-08T18:21:07.439Z', { mergeable: false, conflicting: true });
  assert.deepEqual(polled.baseHold, { sha: head, at: '2026-10-08T18:20:27.699Z' }, 'a poll that reads the hold again keeps the sighting');
  const movedBase = await observe('2026-10-08T18:40:00.000Z', { baseTip: moved, mergeable: false, conflicting: true });
  assert.deepEqual(movedBase.baseHold, { sha: head, at: '2026-10-08T18:20:27.699Z' }, 'the base moving again under the conflicting head keeps the sighting');
  const cleared = await observe('2026-10-08T18:45:00.000Z', { baseTip: moved, mergeable: true, conflicting: false });
  assert.equal(cleared.baseHold, null, 'a head GitHub reports mergeable stands under no hold');
});
