import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, ledgerTables } from '../src/store.js';
import { GitHub } from '../src/github.js';
import { GitHubCacheStore } from '../src/github-cache.js';

// GitHub response caches persist in Postgres so a restart starts warm instead of re-spending
// the App's request budget on answers that have not changed.

let database: EmbeddedPostgres, store: Store;
before(async () => {
  const port = Number(process.env.GRAPHYARD_GITHUB_CACHE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 163);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-github-cache-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

/** A GitHub adapter that is already authenticated, over a recorded fetch. */
function client(respond: (url: string, headers: Record<string, string>) => Response) {
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 7, privateKey: 'not-used' });
  Object.assign(github as any, { token: 'installation-token', expires: Date.now() + 3600_000 });
  const requests: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    requests.push({ url: String(input), headers });
    return respond(String(input), headers);
  }) as typeof fetch;
  return { github, requests };
}
const json = (body: unknown, etag: string) => new Response(JSON.stringify(body), { status: 200, headers: { etag, 'content-type': 'application/json' } });

test('a restarted adapter serves cached immutable answers with no request and revalidates an ETag entry with If-None-Match', async () => {
  const first = new GitHubCacheStore(store.pool, '7');
  const warm = client((url) => {
    if (url.includes(`/compare/${A}...${B}?per_page=1`)) return json({ status: 'ahead' }, '"cmp"');
    if (url.includes(`/compare/${A}...${C}?per_page=100`)) return json({ total_commits: 1, commits: [{ sha: C }] }, '"hist"');
    if (url.endsWith('/pulls/5')) return json({ number: 5, title: 'cached pull' }, '"pull-5"');
    throw new Error(`unexpected ${url}`);
  });
  await warm.github.attachCache(first);
  (warm.github as any).readBlob = async () => 'd'.repeat(40);
  assert.equal(await warm.github.contains(A, B), true);
  assert.deepEqual([...(await warm.github.historySince(A, C))!], [C]);
  assert.equal(await warm.github.blobAt('src/x.ts', B), 'd'.repeat(40));
  assert.deepEqual(await warm.github.request('/pulls/5'), { number: 5, title: 'cached pull' });
  assert.equal(warm.requests.length, 3);
  await first.close();
  assert.ok(Number((await store.pool.query('SELECT count(*) AS n FROM github_cache')).rows[0].n) >= 5, 'every answer was written behind');

  // The restart: a new adapter and a new cache over the same database.
  const second = new GitHubCacheStore(store.pool, '7');
  const restarted = client((url, headers) => {
    if (url.endsWith('/pulls/5') && headers['If-None-Match'] === '"pull-5"') return new Response(null, { status: 304 });
    throw new Error(`unexpected ${url}`);
  });
  (restarted.github as any).readBlob = async () => { throw new Error('the blob is cached'); };
  await restarted.github.attachCache(second);
  assert.equal(await restarted.github.contains(A, B), true);
  assert.deepEqual([...(await restarted.github.historySince(A, C))!], [C]);
  assert.equal(await restarted.github.blobAt('src/x.ts', B), 'd'.repeat(40));
  assert.equal(restarted.requests.length, 0, 'immutable answers cost no request after a restart');
  assert.deepEqual(await restarted.github.request('/pulls/5'), { number: 5, title: 'cached pull' });
  assert.deepEqual(restarted.requests.map(request => request.headers['If-None-Match']), ['"pull-5"'], 'the ETag entry is revalidated, and the 304 is free');
  assert.equal(restarted.github.budget().spentInWindow, 0);
  await second.close();

  // Another installation sharing the database does not read these entries.
  const other = new GitHubCacheStore(store.pool, '8');
  const maps = { etag: new Map(), ancestry: new Map(), blob: new Map(), history: new Map() };
  assert.equal(await other.load(maps, { etag: 10, ancestry: 10, blob: 10, history: 10 }), 0);
});

test('a failing cache database never fails an observation: the adapter asks GitHub', async () => {
  const broken = { query: async () => { throw new Error('connection refused'); } };
  const cache = new GitHubCacheStore(broken as any, '7', { flushMs: 1 });
  const { github, requests } = client(() => json({ status: 'diverged' }, '"x"'));
  const errors: unknown[] = []; const original = console.error; console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await github.attachCache(cache);
    assert.equal(await github.contains(B, C), false);
    assert.equal(requests.length, 1);
    await cache.close();
    assert.equal(await cache.prune(), 0);
  } finally { console.error = original; }
  assert.ok(errors.length >= 1, 'the failure is reported');
});

test('pruning caps the table by rows and by bytes, keeping the newest entries', async () => {
  await store.pool.query('DELETE FROM github_cache');
  const cache = new GitHubCacheStore(store.pool, 'prune', { maxRows: 5, pruneMs: Number.MAX_SAFE_INTEGER });
  for (let index = 0; index < 12; index++) { cache.put('blob', `${index.toString().padStart(2, '0')}`, `value-${index}`); await cache.flush(); }
  assert.equal(await cache.prune(), 7);
  const kept = (await store.pool.query('SELECT key FROM github_cache ORDER BY key')).rows.map(row => row.key);
  assert.deepEqual(kept, ['07', '08', '09', '10', '11'].map(key => `prune:blob:${key}`));
  const bytes = new GitHubCacheStore(store.pool, 'prune', { maxRows: 100, maxBytes: 64 });
  bytes.put('etag', '/large', 'x'.repeat(200), '"large"'); await bytes.flush();
  await bytes.prune();
  assert.equal(Number((await store.pool.query('SELECT count(*) AS n FROM github_cache')).rows[0].n), 0, 'the byte cap removes entries beyond it');
  assert.ok(!ledgerTables.includes('github_cache'), 'the cache is not ledger state: backups neither carry nor restore it');
});
