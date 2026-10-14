import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, planeStallMs } from '../src/engine.js';
import { standingEscalations, type Principal, type Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1791: every reconciliation pass records the plane's own liveness, and a lapse inside a
 * recorded stall is explained by it rather than raised as a lease loss. That runs on every pass, so
 * this soak drives the real engine over three simulated days of passes with a worker holding a
 * lease throughout: an ordinary pass appends no event, each gap past the stall bound is exactly one
 * `plane.stall` row, a lease that ran out inside a gap survives the very pass that detects the
 * gap, and no lease-loss escalation stands at the end (the deploy-lease-loss invariant of
 * docs/master-agent.md#system-invariants).
 */
const human: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'worker-plane-stall', role: 'worker', sessionKind: 'ai' };
let pg: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1791;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('soak-plane-stall'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('soak_plane_stall');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/soak_plane_stall`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [human, worker];
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const count = async (kind: string) => Number((await store.pool.query('SELECT count(*) AS n FROM events WHERE kind = $1', [kind])).rows[0].n);
const total = async () => Number((await store.pool.query('SELECT count(*) AS n FROM events')).rows[0].n);
const document = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;

test('unit:soak-plane-stall — three simulated days of passes: one stall row per gap, no event per tick, and a lease that ran out inside a gap survives the pass that detects it', { timeout: 240_000 }, async () => {
  let work = await engine.execute(human, 'create', null, { title: 'plane-stall-soak', plannedFiles: ['src/plane-stall-soak.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, randomUUID());
  work = await engine.execute(human, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  await engine.reconcile();

  const gapsPerDay = 3, quietPasses = 4, days = 3;
  let gaps = 0;
  for (let day = 0; day < days; day++) for (let gap = 0; gap < gapsPerDay; gap++) {
    for (let pass = 0; pass < quietPasses; pass++) {
      const events = await total();
      await engine.reconcile();
      assert.equal(await total(), events, 'an ordinary pass appends no event: the liveness row is overwritten, never logged per tick');
    }
    // The plane was down for 90 s: the lease ran out inside the gap, and the pass that ends the
    // gap is the pass that first meets both the gap and the expired lease.
    await store.pool.query(`UPDATE plane_liveness SET tick_at = tick_at - interval '${Math.round((planeStallMs + 30_000) / 1000)} seconds'`);
    const doc = await document(work.id);
    // A renewal between gaps clears the last gap's grace, as a heartbeat does.
    delete (doc.lease as { renewalFault?: unknown }).renewalFault;
    doc.lease!.expiresAt = new Date(Date.now() - 45_000).toISOString();
    await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [work.id, JSON.stringify(doc)]);
    const before = await count('plane.stall');
    await engine.reconcile();
    gaps += 1;
    assert.equal(await count('plane.stall'), before + 1, 'the gap is one stall row');
    const after = await document(work.id);
    assert.ok(after.lease && Date.parse(after.lease.expiresAt) > Date.now(), 'the lease survived the recovery pass');
    assert.deepEqual(standingEscalations(after).map(entry => entry.trigger), [], 'no lease loss stands');
  }
  assert.equal(await count('plane.stall'), gaps, 'one stall row per gap over the whole run');
  assert.equal(Number((await store.pool.query('SELECT count(*) AS n FROM plane_liveness')).rows[0].n), 1, 'the liveness record stays one row');
  assert.equal(await count('lease.expired'), 0, 'no lapse was recorded: the stall kept the lease live');
});
