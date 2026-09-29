import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { followUpItem, type LaunchThread } from '../src/review-threads.js';
import { followUpEntries, followUpParent, openFollowUpItem } from '../src/model/machine-backlog.js';
import { followUpParent as invariantParent } from '../src/model/invariants.js';
import type { Principal, Work } from '../src/model.js';

// GY-896 AC-1 against the real control plane: an approved review's non-blocking findings are
// recorded on the parent's one follow-up item, and a second approval of the same parent appends
// to that item instead of filing another. The batch awaits triage in the backlog — the filing
// never produces a ready-stage item that carries no implementation.

const repository = 'owner/followups-batched';
const operator: Principal = { id: 'batched-operator', role: 'admin', sessionKind: 'ai' };
const coordinator: Principal = { id: 'batched-master', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'batched-worker', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `batched-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (principal: Principal, path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, path: string, body?: unknown, key?: string) => {
  const result = await call(principal, path, body, key);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (key: string) => (await store.list()).find(item => item.key === key)!;
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows as { actor: string; kind: string }[];
/** One thread of the approval, as the reviewer's launch records it. */
const thread = (id: string, path: string, excerpt: string): LaunchThread =>
  ({ id, author: 'graphyard-reviewer', path, line: 30, outdated: false, excerpt, url: `https://github.com/${repository}/pull/7#discussion-r-${id}` });
/** One approval's filing, exactly as the loop sends it (src/review-threads.ts followUpItem). */
const fileApproval = async (parent: Work, reviewId: number, threads: LaunchThread[], findings: { path: string | null; text: string }[]) =>
  ok(operator, 'work', { ...followUpItem({ key: parent.key, workId: parent.id, pr: 7, sha: String(reviewId).padEnd(40, 'a'), reviewId }, threads, findings.map(finding => ({ ...finding, line: null }))), policy: { checks: ['test'], review: true } }) as Promise<Work>;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 460;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-batched-db-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('batched_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/batched_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:followups-batched-not-filed — two approvals of one parent leave one backlog batch, not one ready item each', async () => {
  const parent = await ok(operator, 'work', { title: 'Parent', plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:a'] }] }) as Work;

  // The first approval files the parent's one follow-up item: backlog, awaiting triage.
  const batch = await fileApproval(parent, 11, [thread('T1', 'src/a.ts', 'the retry is unbounded')], [{ path: 'src/b.ts', text: 'the cache never expires' }]);
  assert.equal(followUpParent(batch), parent.key);
  assert.equal(batch.stage, 'backlog');
  assert.equal(batch.ready, false, 'a filed batch awaits triage; it is never a ready item');
  assert.deepEqual(followUpEntries(batch).map(entry => [entry.path, entry.text]),
    [['src/a.ts', 'the retry is unbounded'], ['src/b.ts', 'the cache never expires']]);

  // A second approval of the same parent appends to that one item: a finding the later head names
  // again (same path and text, the line moved) is deduplicated, the new one is kept.
  const body = { findings: [{ path: 'src/a.ts', text: 'src/a.ts:42 — the retry is unbounded' }, { path: 'src/c.ts', text: 'the loop never backs off' }], reason: 'approval 12' };
  const appended = await ok(coordinator, `work/${batch.key}/followups`, body, 'append-12');
  assert.deepEqual({ key: appended.key, added: appended.added, findings: appended.findings }, { key: batch.key, added: 1, findings: 3 });
  // The same approval retried is idempotent: nothing is appended twice.
  assert.deepEqual(await ok(coordinator, `work/${batch.key}/followups`, body, 'append-12'), appended);

  const all = await store.list();
  assert.deepEqual(all.filter(item => followUpParent(item) === parent.key).map(item => item.key), [batch.key],
    'the parent still holds exactly one follow-up item');
  assert.equal(openFollowUpItem(all, parent.key)?.key, batch.key, 'the filing appends to the open batch instead of filing another');
  const current = await reload(batch.key);
  assert.equal(current.stage, 'backlog');
  assert.equal(current.ready, false);
  assert.ok((await events(current)).some(event => event.kind === 'followups.appended'));
  // The invariant reader agrees: one open follow-up item on the parent.
  assert.equal(invariantParent(current), parent.id);
  assert.equal(all.filter(item => invariantParent(item) === parent.id).length, 1);

  // A worker may not append, and an item that is not a follow-up item refuses the append.
  assert.equal((await call(worker, `work/${batch.key}/followups`, body)).status, 403);
  const refused = await call(coordinator, `work/${parent.key}/followups`, body);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /not an open follow-up item/);
});
