import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { readWorkReplay } from '../src/server/work-replay.js';

test('replay reads the baseline, stage changes, rework and release deltas within its window', async () => {
  const store = await withDatabase('work_replay'); await store.init();
  try {
    const end = Date.now(), hour = 3_600_000, id = randomUUID(), old = randomUUID();
    const work = { id, key: 'GY-1', stage: 'ready', implementers: ['runner'] };
    await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2),($3,$4)', [id, JSON.stringify(work), old, JSON.stringify({ ...work, id: old, key: 'GY-2' })]);
    const append = async (workId: string, ago: number, payload: unknown) => (await store.pool.query('INSERT INTO events(work_id,actor,kind,payload,created_at) VALUES($1,$2,$3,$4,$5) RETURNING seq', [workId, 'fixture', 'fixture', JSON.stringify(payload), new Date(end - ago * hour)])).rows[0].seq;
    await append(id, 30, { work });
    await append(id, 20, { work: { ...work, stage: 'build' } });
    await append(id, 16, { work: { ...work, stage: 'review' } });
    await append(id, 12, { work: { ...work, stage: 'build' } });
    const delivered = { ...work, stage: 'done', delivery: { mergedAt: new Date(end - 4 * hour).toISOString() } };
    const base = await append(id, 4, { work: delivered });
    await append(id, 2, { delta: { base, ops: [[['releaseDeliveries'], [{ environment: 'production', verifiedAt: new Date(end - 2 * hour).toISOString() }]]] } });
    await append(old, 80, { work: { ...work, id: old, key: 'GY-2' } });
    await append(old, 48, { work: { ...work, id: old, key: 'GY-2', stage: 'build' } });
    const day = await readWorkReplay(store.pool, 24, end);
    assert.equal(day.items.length, 1);
    assert.deepEqual(day.items[0].points.map(point => point.column), [0, 1, 2, 1, 4, 5]);
    assert.equal(day.items[0].points[0].at, end - 24 * hour);
    assert.equal((await readWorkReplay(store.pool, 72, end)).items.length, 2);
  } finally { await store.close(); }
});
