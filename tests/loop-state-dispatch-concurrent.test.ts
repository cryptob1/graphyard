import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { databaseUrl } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDispatchCursor, readDispatchCursor, writeDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DispatchEffects } from '../src/dispatch/effects.js';
import type { DaemonEffects } from '../src/daemon/effects.js';

test('loop-state-dispatch-concurrent: two writers of the dispatch cursor get a conflict and a retry, never a 500 (GY-3366)', async t => {
  const dbUrl = await databaseUrl('loop_state_dispatch_race');
  const store = new Store(dbUrl); await store.init();
  // A loaded host's wait outlives the server's own timeout (the pool's 60 s statement timeout in
  // production). The database's lock_timeout stands in for it so the race needs seconds, not a minute.
  await store.pool.query(`ALTER DATABASE "${new URL(dbUrl).pathname.slice(1)}" SET lock_timeout = '1s'`);
  await store.close();
  const served = new Store(dbUrl); await served.init();
  const token = 'fixture-coordinator-token'.padEnd(40, 'x');
  const http = server(new Engine(served, 120, 'owner/project'), [{ id: 'fixture-loop', role: 'coordinator', token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await served.close(); });
  const credentialFile = join(await temporaryDirectory('loop-state-race'), 'coordinator.token');
  await writeFile(credentialFile, token, { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile, cliPath: '/bin/graphyard', repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'machine-a', masterAgentName: 'gmp', workers: [] });
  const cursor = (ticks: number) => ({ ...emptyDispatchCursor(config), ticks });
  await writeDispatchCursor(config, cursor(1));
  const scope = (await served.pool.query(`SELECT scope FROM loop_state WHERE kind='dispatch'`)).rows[0].scope;

  /** The other writer — the old loop still running beside a restarted one — mid-way through persisting its cursor. */
  const otherWriter = async (ticks: number) => {
    const db = new pg.Client({ connectionString: dbUrl }); await db.connect();
    await db.query('BEGIN');
    await db.query(`UPDATE loop_state SET data=$2 WHERE scope=$1 AND kind='dispatch'`, [scope, JSON.stringify(cursor(ticks))]);
    return { commitAfter: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)).then(() => db.query('COMMIT')).finally(() => db.end()) };
  };
  const stored = async () => Number((await served.pool.query(`SELECT data->>'ticks' AS ticks FROM loop_state WHERE kind='dispatch'`)).rows[0].ticks);

  // The loser of the race is answered with a conflict, not a 500.
  const first = await otherWriter(5);
  const raw = await fetch(`${url}/api/loop-state/${scope}/dispatch`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [cursor(6)] }) });
  const body = await raw.text();
  assert.equal(raw.status, 409, `the losing writer is answered with a conflict: ${raw.status} ${body}`);
  await first.commitAfter(0);

  // The loop's own client retries the conflict, so its later cursor lands after the other writer's.
  const second = await otherWriter(7);
  const committed = second.commitAfter(3_000);
  await writeDispatchCursor(config, cursor(8));
  await committed;
  assert.equal(await stored(), 8, 'the stored cursor is the later write');

  // A loop cycle whose dispatch step persists while the other writer holds the cursor completes that step.
  const effects: DispatchEffects = {
    snapshot: async () => ({ work: [], now: new Date().toISOString() }), agents: () => [],
    credentials: async () => ({}), reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
    launchReview: async () => { throw new Error('nothing to review'); }, launchProducer: async () => { throw new Error('nothing to prove'); },
    persist: value => writeDispatchCursor(config, value),
  };
  const state = emptyDaemonState(config);
  const daemon: DaemonEffects = {
    agents: () => [], snapshot: effects.snapshot, credentials: async () => ({}), closeSession: async () => {}, dispatch: async () => {}, persist: async () => {},
    dispatchTick: async () => {
      const read = await readDispatchCursor('/unused', config);
      const third = await otherWriter(read.ticks + 5);
      const done = third.commitAfter(3_000);
      try { return await runDispatchTick(config, read, effects); } finally { await done; }
    },
  };
  await runCycle(config, state, daemon, Date.now, undefined, () => {});
  assert.equal(state.stepFailures.dispatch, undefined, `the dispatch step completed: ${JSON.stringify(state.stepFailures.dispatch)}`);
  assert.equal(await stored(), 9, 'the cycle\'s tick cursor, written after the other writer, is stored');
});
