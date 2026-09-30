import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { followUpItem, type LaunchThread } from '../src/review-threads.js';
import { followUpRecordRequest } from '../src/reviewer.js';
import { followUpParent, machineKind } from '../src/model/machine-backlog.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-896 AC-1 against the real control plane: an approved review's non-blocking findings are
// recorded against the approved item's own record, naming its pull request, exactly as the loop's
// filing sends them (src/reviewer.ts followUpRecordRequest). No work item is created for them — not
// one per review, and not one per item — so the filing produces no item that carries no implementation.

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
const events = async (work: Work) => (await store.pool.query('SELECT kind FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows.map(row => row.kind as string);
/** One thread of the approval, as the reviewer's launch records it. */
const thread = (id: string, path: string, excerpt: string): LaunchThread =>
  ({ id, author: 'graphyard-reviewer', path, line: 30, outdated: false, excerpt, url: `https://github.com/${repository}/pull/7#discussion-r-${id}` });
/** One approval's filing, exactly as the loop sends it: the filing's payload (followUpItem) through the loop's sink request. */
const fileApproval = async (parent: Work, reviewId: number, threads: LaunchThread[], findings: { path: string | null; text: string }[]) => {
  const request = followUpRecordRequest(followUpItem({ key: parent.key, workId: parent.id, pr: 7, sha: String(reviewId).padEnd(40, 'a'), reviewId }, threads, findings.map(finding => ({ ...finding, line: null }))));
  return ok(coordinator, request.path, request.body, `graphyard-followups:${repository}#7:${reviewId}`);
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 460;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('batched-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('batched_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/batched_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:followups-batched-not-filed — two approvals record their findings on the approved item and file no work item', async () => {
  const parent = await ok(operator, 'work', { title: 'Parent', plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:a'] }] }) as Work;
  // The approved head: the pull request the approvals reviewed (as the observation records it).
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{candidate}', $2::jsonb) WHERE id=$1`,
    [parent.id, JSON.stringify({ pr: 7, sha: 'c'.repeat(40), author: 'worker', branch: 'graphyard/parent', baseSha: 'd'.repeat(40), createdAt: new Date().toISOString() })]);
  const before = (await store.list()).length;

  // The first approval records its thread and its finding with no thread on the approved item.
  const first = await fileApproval(parent, 11, [thread('T1', 'src/a.ts', 'the retry is unbounded')], [{ path: 'src/b.ts', text: 'the cache never expires' }]);
  assert.deepEqual(first, { key: parent.key, added: 2, findings: 2 });

  // A second approval of the same item adds only what is new: a finding the later head names
  // again (same path and text, the line moved) is deduplicated, the new one is kept.
  const second = await fileApproval(parent, 12, [], [{ path: 'src/a.ts', text: 'src/a.ts:42 — the retry is unbounded' }, { path: 'src/c.ts', text: 'the loop never backs off' }]);
  assert.deepEqual(second, { key: parent.key, added: 1, findings: 3 });
  // The same approval retried is idempotent: nothing is recorded twice.
  assert.deepEqual(await fileApproval(parent, 12, [], [{ path: 'src/a.ts', text: 'src/a.ts:42 — the retry is unbounded' }, { path: 'src/c.ts', text: 'the loop never backs off' }]), second);

  // No work item was filed: not one per review, not one follow-up item for the parent, nothing ready.
  const all = await store.list();
  assert.equal(all.length, before, 'recording follow-ups creates no work item');
  assert.deepEqual(all.filter(item => followUpParent(item) || machineKind(item)).map(item => item.key), []);
  assert.deepEqual(all.filter(item => item.id !== parent.id && item.ready).map(item => item.key), []);

  // The findings are on the approved item's own record, naming its pull request and head.
  assert.deepEqual((await events(parent)).filter(kind => kind === 'followups.recorded').length, 2);
  const batch = await ok(operator, `work/${parent.key}/followups`);
  assert.equal(batch.key, parent.key);
  assert.equal(batch.pr, 7);
  assert.deepEqual(batch.findings.map((finding: any) => [finding.index, finding.path, finding.text, finding.pr, finding.sha, finding.promoted]), [
    [1, 'src/a.ts', 'the retry is unbounded', 7, 'c'.repeat(40), null],
    [2, 'src/b.ts', 'the cache never expires', 7, 'c'.repeat(40), null],
    [3, 'src/c.ts', 'the loop never backs off', 7, 'c'.repeat(40), null],
  ]);
  assert.equal(batch.findings[0].ref, `https://github.com/${repository}/pull/7#discussion-r-T1`, 'a thread finding keeps the PR thread it was raised on');

  // A worker may not record follow-ups.
  assert.equal((await call(worker, `work/${parent.key}/followups`, { findings: [{ path: null, text: 'x' }], reason: 'r' })).status, 403);
});
