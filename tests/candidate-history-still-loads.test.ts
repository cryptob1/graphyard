import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import EmbeddedPostgres from 'embedded-postgres';
import { daemonStateSchema } from '../src/daemon/state.js';
import { candidatePromotionKind } from '../src/delivery.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1983 removed the release-candidate drive without a migration: a cursor it wrote, and the
// candidate events it recorded, still load.

const admin: Principal = { id: 'history-admin', role: 'admin', sessionKind: 'human' };
const credential = { ...admin, token: `history-admin-${'h'.repeat(32)}` };
const sha = 'a'.repeat(40), promoted = 'b'.repeat(40);
let database: EmbeddedPostgres | null = null, store: Store | null = null, http: ReturnType<typeof server> | null = null;
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:candidate-history-still-loads — a cursor carrying the removed candidate, soak, seal-check, dispatch and run fields loads with mainSha, promotedSha, promotedAt and behind; a candidate promotion event still reads', { timeout: 120_000 }, async () => {
  const promotion = {
    checkedAt: '2026-10-18T00:00:00.000Z', mainSha: sha, promotedSha: promoted, promotedAt: '2026-10-17T23:00:00.000Z', behind: 2,
    ledgerReadAt: '2026-10-17T23:59:00.000Z', inFlight: true, runsReadAt: '2026-10-17T23:59:00.000Z', dispatchedAt: '2026-10-17T23:50:00.000Z', lastDispatchAt: '2026-10-17T23:50:00.000Z',
    cutSha: sha, candidateAtDispatch: '20261017T235000Z', nextDueAt: '2026-10-18T00:10:00.000Z', reason: null,
    candidates: [{ id: '20261017T235000Z', sha, cutAt: '2026-10-17T23:50:00.000Z', prs: 2, queued: 0, soak: { result: 'passed', at: '2026-10-18T00:00:00.000Z', run: null },
      sealCheck: { mayseal: true, role: 'operator-agent', needed: [], at: '2026-10-17T23:55:00.000Z', secret: 'GRAPHYARD_RELEASE_TOKEN', environment: 'uat' } }],
    sealChecks: [{ id: '20261017T235000Z' }], sealChecksReadAt: '2026-10-17T23:59:00.000Z',
    soaks: [{ sha, status: 'completed', conclusion: 'success', createdAt: '2026-10-17T23:51:00.000Z', url: null }], soaksReadAt: '2026-10-17T23:59:00.000Z',
  };
  const cursor = daemonStateSchema.parse({ version: 1, url: 'http://127.0.0.1:4310', repository: 'owner/history', promotion,
    mainWatch: { checkedAt: '2026-10-18T00:00:00.000Z', tip: sha, unknown: [], frozen: { sha, since: '2026-10-17T00:00:00.000Z' } } });
  assert.deepEqual(cursor.promotion, { checkedAt: promotion.checkedAt, mainSha: sha, promotedSha: promoted, promotedAt: promotion.promotedAt, behind: 2, reason: null });
  assert.ok(cursor.mainWatch, 'the retired main watch (GY-1519) state still loads, untouched');

  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1984;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('candidate-history'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('candidate_history_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/candidate_history_test`); await store.init();
  await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard-coordinator', candidatePromotionKind,
    JSON.stringify({ candidate: '20261017T235000Z', promotion: { environment: 'production', releaseId: 'release-1', sourceSha: sha, artifact: `sha256:${'c'.repeat(64)}`, at: '2026-10-17T23:58:00.000Z', by: 'graphyard-coordinator' } })]);
  const engine = new Engine(store, 120, 'owner/history'); engine.submissionObserver = null;
  http = server(engine, [credential]);
  await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${(http.address() as { port: number }).port}/api/delivery`, { headers: { Authorization: `Bearer ${credential.token}` } });
  assert.equal(response.status, 200);
  const production = (await response.json() as { environments: { environmentId: string; expected: { candidate: string; sourceSha: string } }[] }).environments.find(entry => entry.environmentId === 'production');
  assert.equal(production?.expected.candidate, '20261017T235000Z');
  assert.equal(production?.expected.sourceSha, sha);
});
