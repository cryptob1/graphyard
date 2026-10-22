import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
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
async function holds() {
  const declared = await import('../src/model/behind-base.js');
  assert.equal(typeof declared.observeBaseHold, 'function', 'the observation write records the hold\'s first sighting');
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
    candidate, submission: { epoch: instance.epoch, pr: instance.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null,
    headObserved: { pr: instance.pr, sha: instance.sha, at: instance.headObservedAt }, ...(instance.holdSightedAt ? { baseHold: { sha: instance.sha, at: instance.holdSightedAt } } : {}), baseRefresh,
    autoDispatch: { review: null, producers: [], history: [] }, actionQueue: { actions: [], history: [] }, gates: [], violations: [], proofGaps: [], scopeRequest: null, containmentQuarantine: null, ...overrides } as unknown as Work;
}
test('unit:base-hold-sighting — the hold\'s first sighting is set once per head, kept while the hold stands across base moves, and cleared when it clears', async () => {
  const { observeBaseHold } = await holds();
  const instance = instances.find(entry => entry.subject === 'GY-1526')!;
  const work = submitted(instance, { baseHold: null, observation: { ...submitted(instance).observation, mergeable: null, conflicting: false } } as unknown as Partial<Work>);
  const t = (n: number) => shift(instance.submittedAt!, n * minute);
  observeBaseHold(work, t(0));
  assert.deepEqual(work.baseHold, { sha: instance.sha, at: t(0) }, 'GitHub has not computed mergeability: the hold is sighted');
  work.observation = { ...work.observation!, at: t(1), baseTip: 'e'.repeat(40), baseTree: 'e'.repeat(40), mergeable: false, conflicting: true };
  observeBaseHold(work, t(1));
  assert.deepEqual(work.baseHold, { sha: instance.sha, at: t(0) }, 'the base moving under a conflicting head keeps the sighting');
  work.observation = { ...work.observation!, at: t(2), mergeable: true, conflicting: false };
  observeBaseHold(work, t(2));
  assert.equal(work.baseHold, null, 'a head GitHub reports mergeable stands under no hold');
  work.observation = { ...work.observation!, at: t(3), mergeable: false, conflicting: true };
  observeBaseHold(work, t(3));
  assert.deepEqual(work.baseHold, { sha: instance.sha, at: t(3) }, 'a hold that returns is a new sighting');
  work.candidate = { ...work.candidate!, sha: 'd'.repeat(40) }; work.observation = { ...work.observation!, at: t(4), candidate: work.candidate };
  observeBaseHold(work, t(4));
  assert.deepEqual(work.baseHold, { sha: 'd'.repeat(40), at: t(4) }, 'a hold on a new head is a new sighting');
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
