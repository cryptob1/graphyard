import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, unauthorizedMergeViolation } from '../src/engine.js';
import { directMergeWindows } from '../src/direct-merge.js';
import { evaluate, type Observation, type Principal, type Work } from '../src/model.js';
import { mergeAuthorized, mergeQueueAction } from '../src/merge-queue.js';
import { reviewNeed } from '../src/model/dispatch.js';
import { githubMergesAnswer, operationsCommand } from '../src/cli/master/operations.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GitHub delivery is the only delivery (GY-1235): a candidate whose build, review and required
// checks pass on its head is GitHub's to merge, and GitHub's merge of that head is the delivery.
// No merge authorization, execution, direct-merge window, acceptance proof, queue or observation
// age stands between them; a merge of a head whose gates did not pass is held as a violation.

const sha = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const A = sha('a1'), M = sha('b1');
const now = new Date('2026-10-04T12:30:00.000Z');
const ciAppIds = [15368];

function item(observedAt: string): Work {
  const at = now.toISOString(), candidate = { sha: A, baseSha: M, pr: 700, branch: 'graphyard/gy-9-1', author: 'worker' };
  const observation = { candidate: { ...candidate }, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: A, state: 'APPROVED' }],
    merged: false, mergeSha: null, mergeable: true, protected: false, prState: 'open', draft: false, baseTip: M, baseTree: sha('7e'), baseTipContained: true,
    files: ['src/server/routes/work.ts'], scopeFiles: [{ path: 'src/server/routes/work.ts', status: 'modified' as const, sha: sha('f'), additions: 1, deletions: 1, binary: false }], at: observedAt } as Observation;
  return {
    id: 'gy-9', key: 'GY-9', title: 'Item', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Behaviour holds', proofs: ['manual:never-attested'] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'],
    stage: 'merge', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine', path: '/tmp/gy-9', branch: 'graphyard/gy-9-1', epoch: 1, owner: 'worker' }], implementers: ['worker'], candidate,
    submission: { epoch: 1, pr: 700 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], observation,
  } as unknown as Work;
}
function evaluated(work: Work): Work {
  const result = evaluate(work, [work], now, ciAppIds);
  return { ...work, stage: result.stage, gates: result.gates, queue: result.queue };
}
const githubState = { pullRequestId: 'PR_x', head: A, queue: false, mergeStateStatus: 'CLEAN', mode: 'none' as const, entryState: null, position: null, groupHead: null, at: now.toISOString() };

test('unit:guarded-merge-removed — the guarded merge is gone, master merge says GitHub merges, and a ten-minute-old observation does not hold a passing candidate', async () => {
  assert.equal(existsSync(new URL('../src/master/merge.ts', import.meta.url)), false, 'src/master/merge.ts is deleted');
  assert.equal(existsSync(new URL('../src/model/delivery-mode.ts', import.meta.url)), false, 'the delivery-mode switch is deleted');
  const printed: unknown[] = [];
  await operationsCommand({ id: 'merge', args: ['GY-9'], print: (value: unknown) => { printed.push(value); return value; } } as any);
  assert.deepEqual(printed, [{ merged: false, result: githubMergesAnswer }]);
  assert.match(githubMergesAnswer, /^GitHub merges/);

  const stale = new Date(now.getTime() - 10 * 60_000).toISOString();
  const work = evaluated(item(stale));
  assert.equal(work.stage, 'merge');
  assert.deepEqual(work.gates.filter(gate => !gate.passed).map(gate => gate.name), [], 'no gate refuses on observation age');
  assert.equal(work.gates.some(gate => gate.reasons.some(reason => /older than two minutes/.test(reason))), false);
  assert.equal(work.gates.find(gate => gate.name === 'acceptance'), undefined, 'no acceptance-proof gate');
  assert.equal(work.gates.some(gate => gate.name === 'github-delivery'), false, 'no delivery-mode marker gate');
  assert.equal(work.queue, null);
  assert.ok(mergeAuthorized(work), 'every passing gate is the whole authorization');
  assert.equal(mergeQueueAction(work, githubState, null, now.getTime()).kind, 'enqueue');

  const unreviewed = item(now.toISOString());
  unreviewed.observation = { ...unreviewed.observation!, reviews: [] };
  const held = evaluated(unreviewed);
  assert.equal(held.stage, 'review');
  assert.equal(mergeAuthorized(held), false);
  assert.equal(mergeQueueAction(held, githubState, null, now.getTime()).kind, 'hold');
  // Review is asked at once: no proof holds it.
  const owed = item(now.toISOString());
  owed.criteria = [{ id: 'AC-1', text: 'Behaviour holds', proofs: ['unit:behaviour-holds'] }] as any;
  owed.observation = { ...owed.observation!, reviews: [] };
  assert.equal(reviewNeed(owed, [owed], now).needed, true);
});

// ---- The merged observation, against a real database -------------------------------------------

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
let pg: EmbeddedPostgres, store: Store, engine: Engine, serial = 0;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1235;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('github-delivery'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('github_delivery_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/github_delivery_test`); await store.init();
  engine = new Engine(store, ciAppIds, 120, 'test/repository');
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const head = 'a'.repeat(40), base = 'b'.repeat(40);
async function submitted(): Promise<{ work: Work; observation: (overrides?: Partial<Observation>) => Observation }> {
  const n = ++serial;
  let work = await engine.execute(operator, 'create', null, { title: `GitHub-merged change ${n}`, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:behaves'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: `/tmp/github-delivery-${n}`, branch: `graphyard/github-delivery-${n}` }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: n }, randomUUID());
  const observation = (overrides: Partial<Observation> = {}): Observation => ({ candidate: { sha: head, baseSha: base, pr: n, branch: `graphyard/github-delivery-${n}`, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString(), ...overrides });
  return { work, observation };
}
async function mergedByGitHub(work: Work, observation: (overrides?: Partial<Observation>) => Observation, mergeSha: string) {
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  return engine.observe(work.id, (await store.workItem(work.id))!.revision, observation({ merged: true, mergedAt, mergeSha }));
}
const mergeEvents = async (id: string) => (await store.events(id)).filter(event => /^merge\.(enqueue\.requested|execution\.|operator-authorized|reconciled)/.test(event.kind));

test('unit:github-merge-is-delivery — GitHub merging a head whose build, review and checks passed is the delivery, with no authorization, execution or direct-merge window; a merge of a head whose gates failed is held as a violation', async () => {
  assert.equal(engine.directMergeEnvironment, null);
  const client = await store.pool.connect();
  try { assert.deepEqual(await directMergeWindows(client, null), [], 'no direct-merge window is open'); } finally { client.release(); }

  const passing = await submitted();
  let work = await engine.observe(passing.work.id, passing.work.revision, passing.observation());
  assert.equal(work.stage, 'merge', `every gate passes on the head: ${JSON.stringify(work.gates.filter(gate => !gate.passed))}`);
  assert.equal(work.gates.find(gate => gate.name === 'acceptance'), undefined, 'the unproven unit proof gates nothing');
  assert.equal(work.mergeAuthorization ?? null, null, 'no merge authorization is recorded');
  work = await mergedByGitHub(work, passing.observation, 'e'.repeat(40));
  assert.equal(work.stage, 'done');
  assert.deepEqual(work.violations, []);
  assert.equal(work.delivery?.mergeSha, 'e'.repeat(40));
  assert.equal('operatorAuthorization' in work.delivery!, false, 'not delivered on an operator or direct-merge authorization');
  assert.equal('reconciliation' in work.delivery!, false);
  assert.equal(work.mergeExecution ?? null, null);
  assert.deepEqual(await mergeEvents(work.id), [], 'no merge request, execution or override stands behind the delivery');

  const unreviewed = await submitted();
  work = await engine.observe(unreviewed.work.id, unreviewed.work.revision, unreviewed.observation({ reviews: [] }));
  assert.equal(work.stage, 'review');
  work = await mergedByGitHub(work, (overrides = {}) => unreviewed.observation({ reviews: [], ...overrides }), 'f'.repeat(40));
  assert.notEqual(work.stage, 'done', 'a merge of a head whose review gate failed is not delivered');
  assert.ok(work.violations.includes(unauthorizedMergeViolation), 'it is held as a violation');
  assert.equal(work.delivery ?? null, null);
});
