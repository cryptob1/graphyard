import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1992 AC-2: an item stored while the scope-request machinery ran still reads. Its document
// carries the retired scope fields and a standing scope-refusal blocker, and its history carries the
// scope events and requirements payloads of that time; every reader of either answers, the gates name
// no scope, and the next evaluation drops the fields and clears the blocker, so the item dispatches.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const principals = [operator, worker, coordinator];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, scratch: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1992;
  scratch = await temporaryDirectory('old-scope-history');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('old_scope_history_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/old_scope_history_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

const get = async (path: string, actor: Principal = coordinator) => {
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${tokens.get(actor.id)}` } });
  return { status: response.status, body: await response.json() as any };
};

test('unit:old-scope-history-loads — a document and history carrying scopeRequest, carriedScopeRequest, scopeDecision, scopeWithdrawn and a scope-refusal blocker load and evaluate; the gates name no scope and the blocker clears', async () => {
  let work = await engine.execute(operator, 'create', null, { title: 'Stored before GY-1992', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const request = { epoch: 1, paths: ['src/b.ts'], reason: 'needs b', requestedBy: worker.id, at };
  const decision = { state: 'refused', reason: 'outside what the criteria imply', at, decidedBy: 'graphyard', waitedMs: 1000, paths: ['src/b.ts'], requestedBy: worker.id, requestedAt: at, epoch: 1, treeRead: true };
  const stored = { ...work, plannedFiles: ['src/a.ts'], scopeRequest: { ...request, decision }, carriedScopeRequest: { ...request, decision }, scopeDecision: decision,
    scopeWithdrawn: { epoch: 1, at }, heldGroundings: [{ decision: randomUUID(), from: 1, to: 2, paths: ['src/b.ts'] }], blocker: `Scope request refused: ${decision.reason}`,
    agentRequests: [{ id: randomUUID(), type: 'scope-request', epoch: 1, requestedBy: worker.id, at, reason: 'needs b', paths: ['src/b.ts'], decider: 'graphyard', releasedLease: false, state: 'resolved', resolvedAt: at, resolution: 'refused' }] };
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(stored)]);
  const event = (actor: string, kind: string, payload: object) => store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor, kind, JSON.stringify(payload)]);
  await event(worker.id, 'scope', { epoch: 1, paths: ['src/b.ts'], reason: 'needs b', work: stored });
  await event(coordinator.id, 'autoscope', { epoch: 1, decision, before: { plannedFiles: ['src/a.ts'], blocker: null }, work: stored });
  await event('graphyard', 'scope.closed', { details: { ...request, decision: 'refused', refusal: decision.reason, reason: 'attempt ended', by: 'release', at, carried: true } });
  await event(operator.id, 'requirements', { liveScopeWidening: true, before: { plannedFiles: ['src/a.ts'] }, plannedFiles: ['src/a.ts', 'src/b.ts'], answers: { epoch: 1, at }, work: { ...stored, plannedFiles: ['src/a.ts', 'src/b.ts'] } });
  await event(operator.id, 'decision.requested', { id: randomUUID(), action: 'requirements', input: { plannedFiles: ['src/a.ts', 'src/b.ts'], answers: { epoch: 1, at } }, reason: 'widen' });

  // Every reader of the stored document and its history answers.
  for (const path of [`work/${work.id}`, 'board', 'status', 'work-snapshot?view=coordination', `events?work=${work.id}`, 'pipeline-timelines', 'interventions']) {
    const read = await get(path, path === 'interventions' ? operator : coordinator);
    assert.equal(read.status, 200, `${path}: ${JSON.stringify(read.body).slice(0, 500)}`);
  }

  // The next evaluation drops the retired fields and the refusal they left, and names no scope.
  const evaluated = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  for (const field of ['plannedFiles', 'scopeRequest', 'carriedScopeRequest', 'scopeDecision', 'scopeWithdrawn', 'heldGroundings']) assert.ok(!(field in evaluated), `${field} is dropped`);
  assert.equal(evaluated.blocker, null);
  assert.doesNotMatch(JSON.stringify(evaluated.gates), /scope/i);
  const row = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document;
  assert.ok(!('scopeRequest' in row) && !('plannedFiles' in row) && row.blocker === null, 'the saved document carries none of it');
  const claimed = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  assert.equal(claimed.lease?.owner, worker.id, 'the item dispatches again');
});
