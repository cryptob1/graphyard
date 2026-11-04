import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from './helpers/warm-postgres.js';
import { Store, save } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { boundLockedCache, isStandIn, lockedRows, lockedWork, rememberSaved, savedVersions, warmLockedReads, withWhole, type Queryable } from '../src/store/locked-read.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3037: the fixtures here file items, and every item owes an e2e proof; they declare the serve one needs.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'engineer-a', role: 'worker', runtime: 'claude', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail in their `before` hook.
  const port = Number(process.env.GRAPHYARD_FOLLOWUPS_1042_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1042);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('followups-1042'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('followups_1042');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/followups_1042`); await store.init();
  engine = new Engine(store, 120, 'owner/followups');
  engine.principals = [operator, worker];
});
after(async () => { boundLockedCache(); if (store) await store.close(); if (database) await database.stop(); });

const create = (title: string, plannedFiles: string[]) => engine.execute(operator, 'create', null, { type: 'chore',  title, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x', 'e2e:fixture'] }] }, randomUUID());
/** `db` with every query's text recorded. */
const recorded = (db: Queryable, texts: string[]): Queryable => ({ query: (text, values) => { texts.push(text); return db.query(text, values); } });
const projects = (texts: string[]) => texts.filter(text => /CROSS JOIN LATERAL/.test(text)).length;
const readsWhole = (texts: string[]) => texts.filter(text => /^SELECT number, document FROM work_items/.test(text)).length;
async function locked<T>(run: (db: Queryable) => Promise<T>) {
  const client = await store.pool.connect();
  try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

test('unit:locked-read-cold-cache-warmed — a fresh process warms the stand-in cache outside the lock, so its first locked read projects nothing (GY-1042 findings 19, 47)', async () => {
  // This file runs in its own process, so the cache starts cold, as after each deploy.
  for (let n = 0; n < 6; n++) await create(`Cold ${n}`, [`src/cold-${n}/`]);
  const cold: string[] = [];
  await warmLockedReads(recorded(store.pool, cold));
  assert.ok(projects(cold) >= 1, 'the warm-up, outside any transaction, built the projections');
  const warm: string[] = [];
  await locked(db => lockedRows(recorded(db, warm), []));
  assert.equal(projects(warm), 0, 'the locked read found every stand-in cached');
  assert.equal(readsWhole(warm), 0);
  // The engine warms on its first pass, before the pass's opening locked read.
  const engineSource = readFileSync(fileURLToPath(new URL('../src/engine.ts', import.meta.url)), 'utf8');
  const reconcile = engineSource.slice(engineSource.indexOf('  private async reconcileTick() {'));
  assert.ok(reconcile.indexOf('await warmLockedReads(this.store.pool)') > 0 && reconcile.indexOf('await warmLockedReads(this.store.pool)') < reconcile.indexOf('await lockedRows(db, [])') && reconcile.indexOf('  private async reconcileTick() {') === 0, 'reconcile warms the cache before its opening locked read');
});

test('unit:locked-read-keeps-cache-hits — a call that caches its misses past the cache bound still serves the hits it found, never reading them whole (GY-1042 finding 42)', async () => {
  const items = [];
  for (let n = 0; n < 8; n++) items.push(await create(`Bounded ${n}`, [`src/bounded-${n}/`]));
  await lockedWork(store.pool, []);
  boundLockedCache(8);
  try {
    // Rewrite half of them: the next call has hits and misses, and caching the misses evicts hits.
    for (const work of items.slice(0, 4)) await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    await lockedWork(store.pool, []);
    for (const work of items.slice(4)) await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    const texts: string[] = [];
    const rows = await locked(db => lockedRows(recorded(db, texts), []));
    assert.equal(readsWhole(texts), 0, 'no stand-in fell through to a whole read');
    assert.ok(rows.every(row => isStandIn(row.document)), 'every unfocused item is a stand-in');
  } finally { boundLockedCache(); }
});

test('unit:locked-read-version-names-revision — a stand-in\'s version names the item\'s revision, so a row version repeated at another revision is not served from the cache (GY-1042 findings 9, 17, 46)', async () => {
  const work = await create('Versioned', ['src/versioned/']);
  await lockedWork(store.pool, []);
  const again: string[] = [];
  await lockedWork(recorded(store.pool, again), []);
  assert.equal(projects(again), 0, 'unchanged, the stand-in is cached');
  // The same row version (its xmin unchanged) at another revision, as a wrapped transaction id would present it.
  await store.pool.query('UPDATE work_index SET revision = revision + 1000 WHERE id = $1', [work.id]);
  const moved: string[] = [];
  await lockedWork(recorded(store.pool, moved), []);
  assert.equal(projects(moved), 1, 'the item is projected afresh');
});

test('unit:saved-stand-in-is-what-save-wrote — a batch caches the text each save wrote, not a later unsaved change to the object (GY-1042 finding 21)', async () => {
  const work = await create('Saved', ['src/saved/']);
  let saved: Awaited<ReturnType<typeof savedVersions>> = [];
  await store.transaction(async (db, now) => {
    const [document] = (await db.query('SELECT document FROM work_items WHERE id = $1', [work.id])).rows.map(row => row.document as Work);
    document.title = 'Saved title';
    await save(db, document, operator.id, 'test', now);
    document.title = 'Changed after the save, never saved';
    saved = await savedVersions(db, [document]);
  });
  assert.equal(saved.length, 1);
  rememberSaved(saved);
  const texts: string[] = [];
  const standIn = (await lockedWork(recorded(store.pool, texts), [])).find(item => item.id === work.id)!;
  assert.equal(projects(texts), 0, 'the saved row\'s stand-in came from the cache');
  assert.equal(standIn.title, 'Saved title');
});

test('unit:projection-contract — an open item\'s projection leaves out its per-file scope, artifacts and pipeline and refuses assignment; a submission\'s landing check reads open submitted peers whole (GY-1042 findings 7, 8, 27)', async () => {
  const peer = await create('Submitted peer', ['src/peer/']);
  const scopeFiles = [{ path: 'src/peer/a.ts', status: 'modified', sha: 'a'.repeat(40) }];
  const submitted = { ...peer, stage: 'review', submission: { epoch: 1, pr: 7001 }, candidate: { sha: 'c'.repeat(40), baseSha: 'b'.repeat(40), pr: 7001 },
    observation: { candidate: { sha: 'c'.repeat(40), baseSha: 'b'.repeat(40), pr: 7001 }, merged: false, prState: 'open', checks: [], files: ['src/peer/a.ts'], scopeFiles, at: new Date().toISOString() },
    pipeline: { attempts: [], submittedAt: new Date().toISOString(), reworkRounds: 0 } } as unknown as Work;
  await store.pool.query('UPDATE work_items SET document = $2 WHERE id = $1', [peer.id, JSON.stringify(submitted)]);
  const projection = (await lockedWork(store.pool, [])).find(item => item.id === peer.id)!;
  assert.ok(isStandIn(projection));
  assert.equal(projection.observation?.scopeFiles, undefined, 'the projection carries no per-file scope');
  assert.equal((projection as any).pipeline, undefined);
  assert.throws(() => { (projection as any).title = 'edited'; }, TypeError);
  const whole = (await withWhole(store.pool, await lockedWork(store.pool, []), item => item.stage !== 'done' && !!item.submission)).find(item => item.id === peer.id)!;
  assert.ok(!isStandIn(whole));
  assert.deepEqual(whole.observation?.scopeFiles, scopeFiles, 'read whole, the peer carries its scope for the landing check');

});
