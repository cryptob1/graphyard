import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save, coordinationLock, migrationLock, backupLock, takeBackupLock, summarizeWork, workIndexSummary } from '../src/store.js';
import { createBackup } from '../src/backup.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server/index.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { schemaVersion } from '../src/release.js';
import { planWorktreeReclaim } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';

// GY-203: migrations and backups take their own advisory locks, never the coordination lock, and
// the coordination snapshot is read from a small index projected in the same transaction as
// every work document write.
let postgres: EmbeddedPostgres, port: number, scratch: string;
const url = (database: string) => `postgres://graphyard:testing-only@127.0.0.1:${port}/${database}`;

before(async () => {
  port = Number(process.env.GRAPHYARD_STORE_LOCKS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 203);
  scratch = await mkdtemp(join(tmpdir(), 'graphyard-store-locks-'));
  postgres = new EmbeddedPostgres({ databaseDir: join(scratch, 'data'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await postgres.initialise(); await postgres.start();
  for (const name of ['locks', 'serialize', 'index', 'board']) await postgres.createDatabase(name);
});
after(async () => { if (postgres) await postgres.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

/** A second session holding advisory locks in an open transaction until released. */
async function holding(database: string, locks: number[], then?: (db: pg.Client) => Promise<unknown>) {
  const db = new pg.Client({ connectionString: url(database) });
  await db.connect(); await db.query('BEGIN');
  for (const lock of locks) await db.query('SELECT pg_advisory_xact_lock($1)', [lock]);
  await then?.(db);
  return async () => { await db.query('ROLLBACK'); await db.end(); };
}
async function timed<T>(run: () => Promise<T>) {
  const started = Date.now();
  const result = await run().then(value => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));
  return { ...result, ms: Date.now() - started };
}

test('integration:migration-backup-locks-separate a migration and a backup proceed while the coordination lock is held, and coordination proceeds while they hold theirs', async () => {
  assert.equal(new Set([coordinationLock, migrationLock, backupLock, 71490322]).size, 4, 'every advisory lock id is distinct, including the flow projection\'s');
  const store = new Store(url('locks'));
  try {
    await store.init();
    // The live replica is mid-coordination, holding the lock and a write to a work document; this
    // release must migrate (nothing records its migration).
    await store.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
    const release = await holding('locks', [coordinationLock], async db => {
      await db.query("INSERT INTO work_items(id, document) VALUES(gen_random_uuid(), '{}'::jsonb)");
      await db.query('UPDATE work_items SET document = document');
    });
    const next = new Store(url('locks'));
    try {
      const boot = await timed(() => next.init({ lockTimeoutMs: 2_000 }));
      assert.equal(boot.error, null, `the migration queued behind the coordination lock: ${boot.error?.message}`);
      assert.ok(boot.ms < 2_000, `migration took ${boot.ms} ms`);
      assert.equal(await next.schema(), schemaVersion);
      assert.match(String((await next.pool.query("SELECT obj_description('graphyard_schema'::regclass,'pg_class') AS d")).rows[0].d), /^migration sha256:/, 'the migration ran and recorded itself');
      // The backup lock is acquired at once, and a whole backup completes, under the held coordination lock.
      const db = await next.pool.connect();
      try {
        await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout = '1s'");
        const acquired = await timed(() => takeBackupLock(db));
        assert.equal(acquired.error, null); assert.ok(acquired.ms < 1_000);
        await db.query('ROLLBACK');
      } finally { db.release(); }
      const backup = await timed(() => createBackup(next.pool));
      assert.equal(backup.error, null, `backup waited on the coordination lock: ${backup.error?.message}`);
      assert.equal(backup.value!.schemaVersion, schemaVersion);
    } finally { await release(); await next.close(); }
    // The other way round: a migration and a backup holding their locks never hold up a coordination transaction.
    const migrating = await holding('locks', [migrationLock, backupLock]);
    try {
      const coordinated = await timed(() => store.transaction(async db => (await db.query('SELECT 1 AS one')).rows[0].one));
      assert.equal(coordinated.error, null); assert.equal(coordinated.value, 1); assert.ok(coordinated.ms < 1_000, `coordination waited ${coordinated.ms} ms`);
    } finally { await migrating(); }
  } finally { await store.close(); }
});

test('integration:migration-backup-locks-separate two migrations still serialize on the migration lock', async () => {
  const deployed = new Store(url('serialize'));
  await deployed.init();
  await deployed.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
  // Another migrating release holds the migration lock: this one waits for it, bounded, and names it.
  let release = await holding('serialize', [migrationLock]);
  const next = new Store(url('serialize'));
  try {
    const blocked = await timed(() => next.init({ lockTimeoutMs: 500 }));
    assert.ok(blocked.error, 'a second migration must not run beside the first');
    assert.ok(blocked.ms < 5_000, `failed only after ${blocked.ms} ms`);
    assert.match(blocked.error!.message, new RegExp(`Schema migration to generation ${schemaVersion} gave up after 500 ms waiting for the migration advisory lock pg_advisory_xact_lock\\(${migrationLock}\\)`));
    await release();
    // Released part-way through the wait, the migration takes the lock and completes after it.
    release = await holding('serialize', [migrationLock]);
    const handoff = setTimeout(() => { void release(); }, 400);
    const waited = await timed(() => next.init({ lockTimeoutMs: 5_000 }));
    clearTimeout(handoff);
    assert.equal(waited.error, null, waited.error?.message);
    assert.ok(waited.ms >= 350, `the migration ran after ${waited.ms} ms, beside the one holding the lock`);
    // Two migrations started together both complete, one after the other.
    await deployed.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
    const other = new Store(url('serialize'));
    try {
      const both = await Promise.all([timed(() => next.init()), timed(() => other.init())]);
      for (const run of both) assert.equal(run.error, null, run.error?.message);
    } finally { await other.close(); }
  } finally { await release().catch(() => {}); await next.close(); await deployed.close(); }
});

// The index row a document projects to, computed here independently of the SQL projection.
function expectedRow(id: string, work: any) {
  const time = (value: unknown) => { const at = typeof value === 'string' ? Date.parse(value) : Number.NaN; return Number.isFinite(at) ? at : null; };
  const observation = work.observation && typeof work.observation === 'object' ? work.observation : null;
  const due = [time(work.lease?.expiresAt), ...(work.actionQueue?.actions ?? []).map((action: any) => time(action.retryAt) ?? time(action.claim?.expiresAt) ?? time(action.requestedAt))].filter((at): at is number => at !== null);
  const summary = summarizeWork(work);
  return {
    id, key: work.key ?? null, stage: work.stage ?? null, priority: typeof work.priority === 'number' ? work.priority : null, owner: work.lease?.owner ?? null,
    epoch: work.epoch ?? null, revision: work.revision ?? null,
    pr_state: observation ? (observation.merged === true ? 'merged' : observation.prState ?? null) : null,
    pr_open: work.stage !== 'done' && !!work.submission && !!observation && observation.merged !== true && observation.prState !== 'closed',
    next_action: work.nextAction?.kind ?? null, due_at: due.length ? new Date(Math.min(...due)).toISOString() : null,
    updated_at: time(work.updatedAt) === null ? null : new Date(time(work.updatedAt)!).toISOString(), summary,
  };
}
async function assertIndexMatches(store: Store, label: string) {
  const documents = (await store.pool.query('SELECT id::text, document FROM work_items ORDER BY number')).rows;
  const rows = (await store.pool.query(`SELECT i.id::text, i.key, i.stage, i.priority::float8 AS priority, i.owner, i.epoch::int AS epoch, i.revision::int AS revision, i.pr_state, i.pr_open, i.next_action,
    to_char(i.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due_at, to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at, i.summary
    FROM work_index i JOIN work_items w ON w.id = i.id ORDER BY w.number`)).rows;
  assert.equal(Number((await store.pool.query('SELECT count(*) AS n FROM work_index')).rows[0].n), documents.length, `${label}: one index row per document`);
  assert.deepEqual(rows, documents.map(row => expectedRow(row.id, row.document)), `${label}: the index equals the documents`);
}

test('integration:index-matches-documents the work index stays equal to the documents through a series of mutations, in the same transaction as each write', async () => {
  const store = new Store(url('index'));
  await store.init();
  const engine = new Engine(store, [15368], 120, 'test/repository');
  const operator: Principal = { id: 'operator', role: 'admin' }, worker: Principal = { id: 'implementer', role: 'worker' }, other: Principal = { id: 'second-worker', role: 'worker' };
  try {
    await assertIndexMatches(store, 'empty');
    let a = await engine.execute(operator, 'create', null, { title: 'First', priority: 2, plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: 'First works', proofs: ['unit:first'] }] }, randomUUID());
    let b = await engine.execute(operator, 'create', null, { title: 'Second', plannedFiles: ['src/b.ts'], criteria: [{ id: 'AC-1', text: 'Second works', proofs: ['unit:second'] }] }, randomUUID());
    await assertIndexMatches(store, 'created');
    a = await engine.execute(operator, 'ready', a.id, {}, randomUUID()); b = await engine.execute(operator, 'ready', b.id, {}, randomUUID());
    await assertIndexMatches(store, 'ready');
    a = await engine.execute(worker, 'claim', a.id, {}, randomUUID()); b = await engine.execute(other, 'claim', b.id, {}, randomUUID());
    assert.equal((await store.pool.query('SELECT owner FROM work_index WHERE id=$1', [a.id])).rows[0].owner, worker.id);
    await assertIndexMatches(store, 'claimed');
    a = await engine.execute(worker, 'heartbeat', a.id, { epoch: 1 }, randomUUID());
    a = await engine.execute(worker, 'workspace', a.id, { epoch: 1, host: 'host', path: '/srv/a', branch: 'graphyard/a-1' }, randomUUID());
    b = await engine.execute(other, 'release', b.id, { epoch: 1 }, randomUUID());
    await assertIndexMatches(store, 'heartbeat, workspace, release');
    a = await engine.execute(worker, 'submit', a.id, { epoch: 1, pr: 7 }, randomUUID());
    a = await engine.observe(a.id, a.revision, { candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 7, branch: 'graphyard/a-1', author: 'implementer' }, checks: [{ name: 'test', appId: 15368, result: 'success' }], reviews: [], merged: false, mergeSha: null, protected: true, mergeable: true, files: ['src/a.ts'], prState: 'open', at: new Date().toISOString() } as any);
    assert.deepEqual((await store.pool.query('SELECT pr_state, pr_open FROM work_index WHERE id=$1', [a.id])).rows[0], { pr_state: 'open', pr_open: true });
    await assertIndexMatches(store, 'submitted and observed');
    // A write through save() in a coordination transaction, then one rolled back: the index follows
    // the committed document and never the rolled-back one.
    await store.transaction(async (db, now) => {
      const work = (await db.query('SELECT document FROM work_items WHERE id=$1', [a.id])).rows[0].document as Work;
      work.stage = 'done'; work.observation = { ...work.observation!, merged: true } as Work['observation'];
      await save(db, work, 'test', 'test.delivered', now);
    });
    assert.deepEqual((await store.pool.query('SELECT stage, pr_state, pr_open FROM work_index WHERE id=$1', [a.id])).rows[0], { stage: 'done', pr_state: 'merged', pr_open: false });
    await assert.rejects(store.transaction(async (db, now) => {
      const work = (await db.query('SELECT document FROM work_items WHERE id=$1', [b.id])).rows[0].document as Work;
      work.priority = 9; await save(db, work, 'test', 'test.rolled-back', now);
      assert.equal(Number((await db.query('SELECT priority FROM work_index WHERE id=$1', [b.id])).rows[0].priority), 9, 'written inside the same transaction');
      throw new Error('roll back');
    }), /roll back/);
    await assertIndexMatches(store, 'saved and rolled back');
    // Direct writes to the documents, as a restore or an older release makes them, are projected too.
    await store.pool.query("INSERT INTO work_items(id, document) VALUES(gen_random_uuid(), '{}'::jsonb)");
    await store.pool.query("UPDATE work_items SET document = jsonb_set(document, '{revision}', to_jsonb(COALESCE((document->>'revision')::int, 0) + 1))");
    await assertIndexMatches(store, 'direct writes');
    // A lost or stale index is rebuilt by the migration's backfill.
    await store.pool.query('DELETE FROM work_index WHERE id=$1', [b.id]);
    await store.pool.query("UPDATE work_index SET stage='stale', revision=revision-1 WHERE id=$1", [a.id]);
    await store.pool.query('COMMENT ON TABLE graphyard_schema IS NULL');
    await store.init();
    await assertIndexMatches(store, 'backfilled');
  } finally { await store.close(); }
});

const worktree = (index: number) => `/srv/graphyard/worktrees/GY-${index + 1}-2`;
// A board item with the history a long-lived item carries: evidence for many heads, a scope
// comparison, resolved requests and a long description. About 60 KB of JSON each.
function boardItem(index: number, now: number): Work {
  const stage = index < 170 ? 'done' : (['build', 'review', 'merge'] as const)[index % 3];
  const updated = stage === 'done' ? now - (index < 160 ? 7 : 0.25) * 86_400_000 : now;
  return {
    id: randomUUID(), key: `GY-${index + 1}`, title: `Board item ${index + 1}`, type: 'feature', priority: index % 3, stage, revision: 40, epoch: 2, ready: true,
    description: 'The history a long-lived item accumulates. '.repeat(40), dependencies: [], plannedFiles: ['src/'], implementers: ['worker'], policy: { checks: ['test'], review: true }, policyRevision: 1,
    criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }], createdAt: new Date(now - 30 * 86_400_000).toISOString(), updatedAt: new Date(updated).toISOString(), stageEnteredAt: new Date(updated).toISOString(),
    lease: null, workspaces: [{ host: 'host', path: worktree(index), branch: `graphyard/gy-${index + 1}-2`, epoch: 2, owner: 'worker' }], submission: { epoch: 2, pr: index + 1 }, candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: index + 1 }, gates: [], violations: [], scenarioRequirements: [], blocker: null,
    evidence: Array.from({ length: 60 }, (_, n) => ({ id: randomUUID(), proof: 'unit:works', sha: n.toString(16).padStart(40, 'c'), baseSha: 'b'.repeat(40), policyRevision: 1, producer: 'runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at: new Date(now).toISOString(),
      scopeFiles: Array.from({ length: 10 }, (_, file) => `src/module-${file}/file-${index}.ts`) })),
    observation: { at: new Date(now).toISOString(), merged: stage === 'done', prState: stage === 'done' ? 'closed' : 'open', files: ['src/index.ts'], scopeFiles: Array.from({ length: 100 }, (_, file) => ({ path: `src/generated/${file}.ts`, sha: 'e'.repeat(40), status: 'unchanged' })) },
    ...(stage === 'done' ? { delivery: { mergedAt: new Date(updated).toISOString(), mergeSha: 'd'.repeat(40) } } : {}),
  } as unknown as Work;
}

test('integration:index-matches-documents the coordination snapshot of a 200-item board is served from the index, under 1 MB, with every in-flight document whole', async () => {
  const store = new Store(url('board'));
  await store.init();
  const now = Date.now(), token = 'c'.repeat(40);
  const items = Array.from({ length: 200 }, (_, index) => boardItem(index, now));
  for (const item of items) await store.pool.query('INSERT INTO work_items(id, document) VALUES($1, $2)', [item.id, JSON.stringify(item)]);
  const http = server(new Engine(store, [15368], 120, 'owner/project'), [{ id: 'coordinator', role: 'coordinator', token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const read = async (headers: Record<string, string>) => {
    const response = await fetch(`${origin}/api/work-snapshot`, { headers: { ...headers, Authorization: `Bearer ${token}` } });
    const text = await response.text(); assert.equal(response.status, 200, text.slice(0, 300));
    return { body: JSON.parse(text), bytes: Buffer.byteLength(text) };
  };
  try {
    await assertIndexMatches(store, 'board');
    // The coordination read first: the full read catches pipeline timelines up, which writes documents.
    const coordination = await read({ [coordinationViewHeader]: 'coordination' });
    const full = await read({});
    assert.ok(full.bytes > 8 * 1024 * 1024, `the board's whole documents are ${full.bytes} bytes`);
    assert.ok(coordination.bytes < 1024 * 1024, `the coordination snapshot is ${coordination.bytes} bytes`);
    assert.equal(coordination.body.view, 'coordination');
    assert.equal(coordination.body.work.length, 200); assert.equal(coordination.body.summarized, 160);
    // Every item in flight, and every recent delivery, is its document (trimmed only by the view);
    // a settled delivery is its index summary, which still says what it is and what it delivered.
    for (const [index, item] of (coordination.body.work as any[]).entries()) {
      const source = items[index] as any;
      assert.equal(item.id, source.id); assert.equal(item.key, source.key); assert.equal(item.stage, source.stage);
      assert.deepEqual(item.delivery, source.delivery); assert.deepEqual(item.policy, source.policy); assert.deepEqual(item.gates, source.gates);
      if (index < 160) {
        assert.equal(item.summarized, true);
        // A stand-in keeps every key its document has, with the type it holds, so a consumer that
        // scans every item never meets a missing field; only the history in them is emptied.
        for (const [key, value] of Object.entries(source)) {
          if ((workIndexSummary.dropped as readonly string[]).includes(key)) { assert.equal(key in item, false, `${item.key} carries ${key}`); continue; }
          assert.ok(key in item, `${item.key} lost ${key}`);
          assert.equal(Array.isArray(item[key]), Array.isArray(value), `${item.key}.${key} changed type`); assert.equal(typeof item[key], typeof value, `${item.key}.${key} changed type`);
        }
        assert.deepEqual(item.criteria, source.criteria); assert.deepEqual(item.workspaces, source.workspaces); assert.deepEqual(item.submission, source.submission);
        assert.deepEqual(item.evidence, []); assert.equal(item.description, '');
        assert.deepEqual(item.observation.files, source.observation.files); assert.equal('scopeFiles' in item.observation, false);
        assert.ok(Buffer.byteLength(JSON.stringify(item)) < 2_048, `${item.key}'s stand-in is ${Buffer.byteLength(JSON.stringify(item))} bytes`);
      } else {
        assert.equal(item.summarized, undefined); assert.deepEqual(item.criteria, source.criteria); assert.equal(item.description, source.description);
        assert.deepEqual(item.observation.files, source.observation.files);
      }
    }
    // The master loop hands this snapshot to the worktree reclaimer, which scans every item's
    // workspaces: a settled delivery's worktree is still matched to its owner and classified.
    const dependencies = [{ path: 'node_modules', kind: 'directory' as const }];
    const plan = planWorktreeReclaim([0, 165, 199].map(index => ({ path: worktree(index), name: `GY-${index + 1}-2`, activityAt: now, dependencies })).concat({ path: '/srv/graphyard/worktrees/stray', name: 'stray', activityAt: now - 86_400_000, dependencies }), coordination.body.work, { now, idleMs: 3_600_000 });
    assert.deepEqual(plan.map(entry => [entry.key, entry.disposition]), [['GY-1', 'delivered'], ['GY-166', 'delivered'], ['GY-200', 'recent'], [null, 'idle']]);
    assert.equal(plan[0].branch, 'graphyard/gy-1-2'); assert.equal(plan[0].disposable, true);
    // The store's own read of the same snapshot: a shorter window leaves only the open items whole.
    const narrow = await store.coordinationSnapshot(3_600_000);
    const settled = (narrow.work as any[]).filter(item => item.stage === 'done' && Date.parse(item.updatedAt) < Date.now() - 3_600_000).length;
    assert.ok(settled > 0); assert.equal(narrow.summarized, settled); assert.equal(narrow.work.length, 200);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); }
});
