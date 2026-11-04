import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Work } from '../src/model.js';
import { observationClaim } from '../src/observation-priority.js';
import { processControlPlaneJob } from '../src/server/control-plane-observation.js';
import { observationWorkers } from '../src/server/main.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('integration:observation-idle-no-fleet-scan — idle workers read only jobs; due work retains priority, locks and cadence', async t => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3080;
  const postgres = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('observation-idle-db'),
    user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await postgres.initialise(); await postgres.start(); await postgres.createDatabase('observation_idle');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/observation_idle`);
  const originalQuery = pg.Client.prototype.query;
  let statements: string[] = [];
  try {
    pg.Client.prototype.query = function (this: pg.Client, ...args: any[]) {
      statements.push(typeof args[0] === 'string' ? args[0] : args[0].text);
      return (originalQuery as Function).apply(this, args);
    } as typeof originalQuery;
    await store.init();
    const now = new Date().toISOString();
    const work = (overrides: Partial<Work> = {}) => ({
      id: randomUUID(), key: 'GY-1', title: 'Observation fixture', type: 'chore', description: '',
      stage: 'build', ready: true, priority: 1, revision: 1, epoch: 1, policyRevision: 1,
      dependencies: [], criteria: [], policy: { checks: [], review: false },
      gates: [], violations: [], evidence: [], workspaces: [], sessions: [], lease: null,
      submission: { sha: 'a'.repeat(40) }, candidate: { sha: 'a'.repeat(40) }, observation: null,
      actionQueue: { actions: [], history: [] }, createdAt: now, updatedAt: now, stageEnteredAt: now,
      ...overrides,
    } as Work);
    const settled = work({ stage: 'done', submission: null, candidate: null });
    await store.pool.query(`INSERT INTO work_items(id, document)
      SELECT id, $1::jsonb || jsonb_build_object('id', id, 'key', 'GY-' || n)
      FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, 1000) n) s`, [JSON.stringify(settled)]);
    const pending = work({ key: 'GY-1001', submission: null, candidate: null });
    await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [pending.id, pending]);
    assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM work_index WHERE settled')).rows[0].n, 1000);

    statements = [];
    // Measure the previous idle path on the same real database, before enabling the new worker.
    for (let i = 0; i < 8; i++) assert.equal((await store.fleet()).length, 1001);
    const before = statements.filter(sql => /FROM work_index WHERE settled/.test(sql)).length;
    assert.equal(before, 8);
    t.diagnostic(`Before: 8 idle passes read ${before * 1000} settled summaries and run 16 work-index queries.`);
    const engine = new Engine(store, 120, 'owner/project');
    for (const state of ['empty', 'future', 'locked']) {
      if (state === 'future') await store.pool.query("INSERT INTO jobs(work_id, available_at) VALUES ($1, now()+interval '1 hour')", [pending.id]);
      if (state === 'locked') await store.pool.query("UPDATE jobs SET available_at=now(), locked_until=now()+interval '1 hour'");
      statements = [];
      assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => processControlPlaneJob(engine))), Array(8).fill(false));
      assert.equal(statements.length, 8);
      assert.ok(statements.every(sql => /SELECT EXISTS \(SELECT 1 FROM jobs/.test(sql)), state);
    }
    statements = [];
    let stop = false;
    const workers = observationWorkers(engine, 8, () => stop);
    await new Promise(resolve => setTimeout(resolve, 1100));
    stop = true; await workers;
    assert.ok(statements.length >= 16, 'workers keep their one-second idle cadence');
    assert.ok(statements.every(sql => /SELECT EXISTS \(SELECT 1 FROM jobs/.test(sql)));
    t.diagnostic(`After: ${statements.length} idle worker passes read 0 work documents, 0 settled summaries, and run 0 work-index queries.`);

    await store.pool.query('DELETE FROM jobs');
    const backlog = work({ key: 'GY-1002' });
    const running = work({ key: 'GY-1003', sessions: [{ state: 'running', endedAt: null }] as Work['sessions'] });
    const first = work({ key: 'GY-1004', candidate: null });
    const merge = work({ key: 'GY-1005', stage: 'merge' });
    const woken = work({ key: 'GY-1006' });
    const starved = work({ key: 'GY-1007' });
    for (const item of [backlog, running, first, merge, woken, starved]) {
      await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [item.id, item]);
      await store.pool.query("INSERT INTO jobs(work_id, available_at) VALUES ($1, now()-interval '1 second')", [item.id]);
    }
    await store.pool.query('UPDATE jobs SET webhook_at=now() WHERE work_id=$1', [woken.id]);
    await store.pool.query("UPDATE jobs SET available_at=now()-interval '1 hour' WHERE work_id=$1", [starved.id]);
    const all = await store.fleet();
    statements = [];
    const open = await store.observationWork();
    assert.equal(open.length, 7);
    assert.ok(statements.every(sql => !/summary/.test(sql)));
    assert.deepEqual(observationClaim(open), observationClaim(all), 'open-only plan matches the previous fleet plan');

    const claims: string[] = [];
    const takeJob = store.takeJob.bind(store);
    store.takeJob = async (...args) => { const job = await takeJob(...args); if (job) claims.push(job.work_id); return job; };
    engine.observeControlPlaneCandidate = async () => null;
    for (let i = 0; i < 6; i++) assert.equal(await processControlPlaneJob(engine), true);
    assert.deepEqual(claims, [woken.id, merge.id, starved.id, first.id, running.id, backlog.id]);
    assert.equal(await processControlPlaneJob(engine), false);
    const jobs = (await store.pool.query('SELECT work_id, EXTRACT(EPOCH FROM available_at-now())::float AS seconds FROM jobs')).rows;
    for (const job of jobs) assert.ok(job.seconds > (job.work_id === first.id ? 55 : 15) && job.seconds <= (job.work_id === first.id ? 60 : 20), JSON.stringify(job));

    // A concurrent claimant holding a row lock must not prevent another job being claimed.
    await store.pool.query("UPDATE jobs SET available_at=now()-interval '1 second'");
    const holder = await store.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT work_id FROM jobs WHERE work_id=$1 FOR UPDATE', [merge.id]);
      const plan = observationClaim(open);
      const job = await store.takeJob(plan.order, plan.headCount);
      assert.ok(job); assert.notEqual(job.work_id, merge.id);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  } finally {
    pg.Client.prototype.query = originalQuery;
    await store.close(); await postgres.stop();
  }
});
