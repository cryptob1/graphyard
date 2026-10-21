import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { derivedIntent } from '../src/cli/master.js';
import { dispatchSchedule } from '../src/master/status.js';
import { hotspots } from '../src/daemon/hotspots.js';
import { boardFromStatus } from '../src/model/board.js';
import type { Principal, Work } from '../src/model.js';
import WorkDetails from '../web/pages/work-details.js';
import CreateWork from '../web/pages/create-work.js';
import type { Dashboard } from '../web/pages/dashboard.js';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureApi, fixtureStatus, fixtureWork, NOW } from '../scripts/dashboard-fixture.mjs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1992 AC-3: plannedFiles is gone. master create and master requirements neither require,
// forward nor check it; dispatch orders work the same whatever a stored item still plans; the
// dashboard and status show no planned files; and a stored item that still carries the field loads.

const operator: Principal = { id: 'operator', role: 'admin' };
const agent: Principal = { id: 'operator-agent', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const principals = [operator, agent, worker, coordinator];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));
// More entries than the retired 100-entry cap, paths no tree holds, and a root-level directory the broad-scope guard refused.
const plan = ['src/', ...Array.from({ length: 150 }, (_, index) => `src/missing-${index}.ts`)];
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, scratch: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1993;
  scratch = await temporaryDirectory('planned-files-removed');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('planned_files_removed_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/planned_files_removed_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function request(path: string, actor: Principal, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
  const body = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(body?.error ?? JSON.stringify(body)), { status: response.status });
  return body;
}
/** master create / master requirements as the CLI runs them, against this server; every request the intent made is recorded. */
async function intent(id: 'create' | 'requirements', args: string[]) {
  const reads: string[] = [], posts: { path: string; data: any }[] = [];
  const result = await derivedIntent(id, args, {
    coordinator: path => { reads.push(path); return request(path, coordinator); },
    mutate: (path, data) => { posts.push({ path, data }); return request(path, agent, data); },
    token: async () => tokens.get(agent.id)!,
  });
  return { result: result as Work, reads, posts };
}

test('unit:planned-files-removed — master create and master requirements neither require, accept nor validate plannedFiles; dispatch never consults it; the dashboard and status show none; a stored item carrying it loads', async () => {
  const criteria = [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }];
  // master create: an intent without plannedFiles is enough, and one naming it is created without it, unchecked.
  const bare = join(scratch, 'bare.json'), planned = join(scratch, 'planned.json');
  await writeFile(bare, JSON.stringify({ title: 'No plan', criteria }));
  await writeFile(planned, JSON.stringify({ title: 'Old-style plan', criteria, plannedFiles: plan }));
  const unplanned = await intent('create', [bare, 'a plain item']);
  assert.ok(unplanned.result.id && !('plannedFiles' in unplanned.result));
  const created = await intent('create', [planned, 'an old intent']);
  assert.ok(!('plannedFiles' in created.result), 'nothing is stored');
  assert.ok(created.posts.every(post => !('plannedFiles' in post.data)), 'nothing is forwarded');
  assert.deepEqual(created.reads, [], 'no base tree or item is read to check it');

  // master requirements: the same.
  const revision = join(scratch, 'revision.json');
  await writeFile(revision, JSON.stringify({ criteria, plannedFiles: plan }));
  const revised = await intent('requirements', [created.result.key, revision, 'revise']);
  assert.equal(revised.result.policyRevision, created.result.policyRevision + 1);
  assert.ok(!('plannedFiles' in revised.result), JSON.stringify(revised.result.plannedFiles));
  assert.ok(revised.posts.every(post => !('plannedFiles' in post.data)), JSON.stringify(revised.posts));
  // The engine ignores it too, whoever sends it.
  const direct = await engine.execute(operator, 'create', null, { title: 'Direct', criteria, plannedFiles: plan }, randomUUID());
  assert.ok(!('plannedFiles' in direct));

  // Stored items that still plan the same files: one in flight, two ready. The order and the hot set are what they are without the field.
  let flying = await engine.execute(operator, 'ready', unplanned.result.id, {}, randomUUID());
  flying = await engine.execute(worker, 'claim', flying.id, {}, randomUUID());
  const ready = await engine.execute(operator, 'ready', revised.result.id, {}, randomUUID()), other = await engine.execute(operator, 'ready', direct.id, {}, randomUUID());
  const shared = ['src/shared.ts', 'src/'];
  const stored = [flying, ready, other].map(item => ({ ...item, plannedFiles: shared })) as Work[];
  const now = Date.now();
  assert.deepEqual(dispatchSchedule(stored, now), dispatchSchedule([flying, ready, other], now));
  assert.deepEqual(dispatchSchedule(stored, now).order.map(entry => entry.key).sort(), [ready.key, other.key].sort(), 'both overlapping ready items are offered');
  assert.deepEqual(hotspots(stored, now), hotspots([flying, ready, other], now));

  // Status: a stored document still carrying the field loads, and the item read shows none.
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [ready.id, JSON.stringify({ ...ready, plannedFiles: ['src/stored-plan.ts'] })]);
  const read = await request(`work/${ready.id}`, coordinator);
  assert.equal(read.key, ready.key);
  assert.ok(!('plannedFiles' in read));
  await request('work-snapshot?view=coordination', coordinator);

  // Dashboard: the item page and the create form show no planned files, even for an item that still carries them.
  const work = (fixtureWork() as Work[]).map(item => ({ ...item, plannedFiles: ['src/stored-plan.ts'] })) as Work[];
  const noop = () => {};
  const dashboard = { token: 'fixture', work, status: fixtureStatus('admin'), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: {}, events: fixtureApi('events'), editingRequirements: false, setEditingRequirements: noop, codexAvailable: false,
    sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, 'admin'), refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop } as unknown as Dashboard;
  const board = boardFromStatus(work, NOW, dashboard.status);
  for (const item of work) {
    const page = renderToStaticMarkup(createElement(WorkDetails, { ...dashboard, board, item }));
    assert.doesNotMatch(page, /stored-plan|[Pp]lanned files/, item.key);
  }
  assert.doesNotMatch(renderToStaticMarkup(createElement(CreateWork, dashboard)), /plannedFiles|[Pp]lanned files/);
});
