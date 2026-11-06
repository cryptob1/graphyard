import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { Store, boundedSnapshot } from '../src/store.js';
import type { Principal } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

/**
 * GY-3187: the bounded work snapshot every dashboard polls rebuilt every settled delivery's
 * summary from its whole document on every read. A poll with no settled item changed reads no
 * settled document, answers the same, and a newly settled item appears in the next read.
 */

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
let store: Store, engine: Engine;
before(async () => {
  store = await withDatabase('settled-summaries-cached');
  await store.init();
  engine = new Engine(store, 120, 'owner/project');
});
after(async () => { if (store) await store.close(); });

/** Every query text the bounded snapshot sends while `read` runs. */
const queriesDuring = async (pool: pg.Pool, read: () => Promise<unknown>) => {
  const seen: string[] = [], connect = pool.connect.bind(pool);
  (pool as any).connect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    (client as any).query = (text: any, ...rest: any[]) => { seen.push(typeof text === 'string' ? text : text.text); return (query as any)(text, ...rest); };
    const release = client.release.bind(client);
    (client as any).release = (...args: any[]) => { (client as any).query = query; (client as any).release = release; return release(...args); };
    return client;
  };
  try { return { result: await read(), seen }; } finally { (pool as any).connect = connect; }
};
const settle = (id: string) => store.pool.query(`UPDATE work_items SET document = (document || jsonb_build_object('stage', 'done', 'actionQueue', jsonb_build_object('actions', '[]'::jsonb, 'history', '[]'::jsonb))) - 'lease' - 'nextAction' - 'queue' WHERE id = $1`, [id]);
const create = (title: string) => engine.execute(operator, 'create', null, { type: 'chore', title, criteria: [{ id: 'AC-1', text: 'test', proofs: ['unit:test', 'e2e:fixture'] }] }, randomUUID());
const readsSettledDocuments = (seen: string[]) => seen.some(text => /FROM work_items w WHERE w\.id = d\.id/.test(text));

test('unit:tests/settled-summaries-cached.test.ts — an unchanged poll reads no settled document; a newly settled item appears next read', async () => {
  const first = await create('Settled first'), open = await create('Still open');
  await settle(first.id);
  const one = await queriesDuring(store.pool, () => boundedSnapshot(store.pool));
  assert.ok(readsSettledDocuments(one.seen), 'the first read builds the settled summary');
  const two = await queriesDuring(store.pool, () => boundedSnapshot(store.pool));
  assert.equal(readsSettledDocuments(two.seen), false, `the second read reads no settled document: ${two.seen.join('\n')}`);
  const strip = (snapshot: any) => ({ ...snapshot, now: undefined, jobs: undefined });
  assert.deepEqual(strip(two.result), strip(one.result), 'the second response equals the first');
  const summary = (one.result as any).work.find((work: any) => work.id === first.id);
  assert.equal(summary.summary, true);

  await settle(open.id);
  const three = await queriesDuring(store.pool, () => boundedSnapshot(store.pool));
  const settled = (three.result as any).work.find((work: any) => work.id === open.id);
  assert.equal(settled.summary, true, 'the newly settled item is served as its summary in the next read');
  assert.equal((three.result as any).work.find((work: any) => work.id === first.id).summary, true);
});
