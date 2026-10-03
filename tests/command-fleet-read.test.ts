import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { fleetSql, readFleet } from '../src/store/fleet.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// 2026-10-02: every coordination command read every whole document (~19 MB with ~1,000 delivered
// items) while holding the coordination lock, so 17 of 27 connections queued on the lock and
// webhooks, heartbeats and claims timed out. A command now reads settled deliveries as their
// work-index summaries, as the reconciliation pass and the coordination snapshot already do, and
// only live items and its own targets whole.

const operator: Principal = { id: 'operator', role: 'admin' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
const seen: string[] = [];

const createItem = async (title: string) =>
  engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:command-fleet-read'] }] }, randomUUID());
const delivered = async (template: Work, key: string): Promise<Work> => {
  const document: Work = { ...structuredClone(template), id: randomUUID(), key, stage: 'done', stageEnteredAt: new Date().toISOString(),
    lease: null, nextAction: undefined, queue: undefined, actionQueue: undefined, containmentQuarantine: undefined, sessions: [] } as Work;
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1, $2)', [document.id, JSON.stringify(document)]);
  return JSON.parse(JSON.stringify(document)) as Work;
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1124;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('command-fleet-read'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`);
  store.pool.on('connect', client => {
    const query = (client as { query: (...args: any[]) => any }).query.bind(client);
    (client as { query: (...args: any[]) => any }).query = (...args: any[]) => { if (typeof args[0] === 'string') seen.push(args[0]); return query(...args); };
  });
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('unit:command-fleet-read — a command reads live items and its own targets whole and every other settled delivery as its work-index summary, and never the whole-document fleet read', async () => {
  const live = await createItem('Live item');
  const template = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [live.id])).rows[0].document as Work;
  const settledA = await delivered(template, 'GY-9001'), settledB = await delivered(template, 'GY-9002');
  const index = new Map((await store.pool.query('SELECT id::text, settled, summary FROM work_index')).rows.map(row => [row.id, row]));
  assert.equal(index.get(settledA.id)?.settled, true, 'a delivered item with nothing owed is settled in the index');

  const byId = (fleet: Work[]) => new Map(fleet.map(item => [item.id, item]));
  const plain = byId(await readFleet(store.pool));
  assert.deepEqual(plain.get(settledA.id), index.get(settledA.id)!.summary, 'an untargeted settled delivery is its summary');
  assert.deepEqual(plain.get(live.id), (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [live.id])).rows[0].document, 'a live item is read whole');
  assert.deepEqual([...plain.keys()], (await store.pool.query('SELECT id::text FROM work_items ORDER BY number')).rows.map(row => row.id), 'every item, in number order');

  for (const target of [settledB.id, settledB.key]) {
    const named = byId(await readFleet(store.pool, [target]));
    assert.deepEqual(named.get(settledB.id), settledB, `a settled delivery named as the target (${target === settledB.id ? 'id' : 'key'}) is read whole`);
    assert.deepEqual(named.get(settledA.id), index.get(settledA.id)!.summary, 'other settled deliveries stay summaries');
  }

  // A real command still works on the new read and never issues the whole-document fleet read.
  seen.length = 0;
  const readied = await engine.execute(operator, 'ready', live.id, {}, randomUUID());
  assert.equal(readied.id, live.id);
  assert.ok(seen.includes(fleetSql), 'the command reads the fleet through readFleet');
  assert.ok(!seen.some(text => /^SELECT document FROM work_items ORDER BY number$/.test(text.trim())), 'no command transaction reads every whole document');
});
