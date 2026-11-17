import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { databaseUrl } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDispatchCursor, readDispatchCursor, writeDispatchCursor } from '../src/dispatch/cursor.js';
import { sessionHandleKey } from '../src/dispatch/session-sweep.js';
import { runCycle, standingStepFailures, stepFailureThreshold } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';

/**
 * GY-3424 (integration:dispatch-state-save). From 2026-11-16 every save of the loop's dispatch
 * cursor answered 500: the cursor named a session its runtime had stopped listing under a key
 * joined with NUL, which Postgres refuses in jsonb, beside thousands of launch failures the
 * GY-3406 relaunch churn left on one item. The save goes through POST /api/loop-state/<scope>/dispatch.
 */
test('integration:dispatch-state-save — a cursor with thousands of launch failures for one item saves, keeping its latest; a refused save names the server reason on master status', async t => {
  const store = new Store(await databaseUrl('dispatch_state_save')); await store.init();
  const token = 'fixture-coordinator-token'.padEnd(40, 'x');
  const http = server(new Engine(store, 120, 'owner/project'), [{ id: 'fixture-loop', role: 'coordinator', token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); });
  const credentialFile = join(await temporaryDirectory('dispatch-state-save'), 'coordinator.token');
  await writeFile(credentialFile, token, { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, credentialFile, cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'machine-a', masterAgentName: 'gmp', workers: [] });

  const at = (i: number) => new Date(Date.parse('2026-11-16T08:00:00.000Z') + i * 1000).toISOString();
  const failure = (i: number, reason = 'Submitted workspace branch is missing') => ({ kind: 'review' as const, work: 'GY-3406', sha: 'a'.repeat(40), attempts: 1, reason, at: at(i), nextAt: at(i + 60) });
  const churned = {
    ...emptyDispatchCursor(config),
    failures: { ...Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`churn-${i}`, failure(i)])), other: { ...failure(0), work: 'GY-3420' } },
    sessionMisses: { [sessionHandleKey('8f1b743b-1a0e-4d44-b2ee-4d5ca9435000', 'implementation-4512')]: at(0) },
  };
  await writeDispatchCursor(config, churned);
  const stored = await readDispatchCursor('/unused', config);
  assert.deepEqual(Object.keys(stored.failures).filter(id => stored.failures[id].work === 'GY-3406').sort(),
    Array.from({ length: 20 }, (_, i) => `churn-${2980 + i}`).sort(), 'only the item\'s latest launch failures are kept');
  assert.ok(stored.failures.other, 'another item\'s failure is kept');
  assert.deepEqual(stored.sessionMisses, churned.sessionMisses, 'the missing session is stored');

  // A record the database refuses is the writer's to fix: the loop's dispatch step fails with the
  // server's reason, and master status raises it once the failure stands.
  const refused = { ...emptyDispatchCursor(config), failures: { cut: failure(1, 'launch failed \ud83d') } };
  const state = emptyDaemonState(config);
  const daemon: DaemonEffects = {
    agents: () => [], snapshot: async () => ({ work: [], now: new Date().toISOString() }), credentials: async () => ({}), closeSession: async () => {}, dispatch: async () => {}, persist: async () => {},
    dispatchTick: async () => { await writeDispatchCursor(config, refused); throw new Error('unreachable'); },
  };
  for (let cycle = 0; cycle < stepFailureThreshold; cycle++) await runCycle(config, state, daemon, Date.now, undefined, () => {});
  const shown = standingStepFailures(state);
  assert.equal(shown.length, 1, `master status shows the failed save once: ${JSON.stringify(shown)}`);
  assert.match(shown[0], /Loop state dispatch: 422 .*refused by the database: invalid input syntax for type json/, 'with the server\'s reason');
});
