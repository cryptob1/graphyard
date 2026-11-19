import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';

// GY-3527: /api/status serves the Work page's speed line from the real ledger: release (the first
// `ready` event) to merge over the last merges, the last merge time and the open item released longest ago.
const operator: Principal = { id: 'operator', role: 'admin' };
const token = `operator-${'t'.repeat(32)}`;
let store: Store, http: ReturnType<typeof server>, url: string;

before(async () => {
  store = await withDatabase('main-page-pipeline-time'); await store.init();
  http = server(new Engine(store, 120, 'owner/game'), [{ ...operator, token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
});

const api = async (path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${path}-${Math.random()}` }, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json() as any;
  assert.ok(response.ok, `${path}: ${json?.error}`);
  return json;
};
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test('e2e:main-page-pipeline-time — /api/status reports merges in 24 hours, release-to-merge minutes, the last merge and the oldest open item from the ledger', async () => {
  const created = [];
  for (const n of [1, 2, 3, 4]) {
    const item = await api('work', { title: `Change ${n}`, why: 'Speed is visible.', simplest: 'One line.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] });
    await api(`work/${item.id}/ready`, { reason: 'Seeded' });
    created.push(item);
  }
  // Released 30, 60 and 90 minutes before merging; the fourth is still in review, released 200 minutes ago.
  const plan = [{ released: 40, merged: 10 }, { released: 80, merged: 20 }, { released: 120, merged: 30 }];
  for (const [index, { released, merged }] of plan.entries()) {
    await store.pool.query("UPDATE events SET created_at=$2 WHERE work_id=$1 AND kind='ready'", [created[index].id, ago(released)]);
    await store.pool.query(`UPDATE work_items SET document=jsonb_set(jsonb_set(document,'{stage}','"done"'),'{delivery}',jsonb_build_object('mergedAt',$2::text)) WHERE id=$1`, [created[index].id, ago(merged)]);
  }
  await store.pool.query("UPDATE events SET created_at=$2 WHERE work_id=$1 AND kind='ready'", [created[3].id, ago(200)]);
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{stage}','"review"') WHERE id=$1`, [created[3].id]);

  const { pipelineTime } = await api('status');
  assert.deepEqual({ merged24h: pipelineTime.merged24h, median: pipelineTime.median, p90: pipelineTime.p90, samples: pipelineTime.samples }, { merged24h: 3, median: 60, p90: 90, samples: 3 });
  assert.equal(Math.round((Date.now() - Date.parse(pipelineTime.lastMergeAt)) / 60_000), 10);
  assert.deepEqual({ ...pipelineTime.oldest, releasedAt: undefined }, { id: created[3].id, key: created[3].key, title: 'Change 4', stage: 'review', releasedAt: undefined });
});
