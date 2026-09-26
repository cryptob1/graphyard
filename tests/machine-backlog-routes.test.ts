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
import { followUpItem } from '../src/review-threads.js';
import { followUpEntries } from '../src/model/machine-backlog.js';
import { isClosed, type Principal, type Work } from '../src/model.js';

// GY-402 against a real Postgres and the real routes: a later approval's findings appended to the
// parent's one follow-up item, the one-time migration recorded in history, and triage — a release
// applied at once, a closure applied only once an independent approver approves it.
const repository = 'owner/machine-backlog';
const operator: Principal = { id: 'backlog-operator', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'backlog-approver', role: 'admin', sessionKind: 'ai' };
const coordinator: Principal = { id: 'backlog-master', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'backlog-worker', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, approver, coordinator, worker].map(principal => ({ ...principal, token: `backlog-${principal.id}-${'x'.repeat(32)}` }));
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
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows as { actor: string; kind: string; payload: any }[];
/** A follow-up item as the loop files it: `withOrigin` false for one filed before GY-402. */
async function followUp(parent: Work, reviewId: number, findings: string[], withOrigin = true) {
  const item = followUpItem({ key: parent.key, workId: parent.id, pr: 7, sha: String(reviewId).padEnd(40, 'a'), reviewId }, [], findings.map(text => ({ path: text.split(' ')[0]!, line: null, text })));
  const { origin, ...legacy } = item;
  return ok(operator, 'work', { ...(withOrigin ? item : legacy), policy: { checks: ['test'], review: true } }) as Promise<Work>;
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 402;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-backlog-db-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('backlog_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/backlog_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:one-followup-per-parent — the followups route appends only the findings the item lacks, is idempotent, and refuses an item that is not an open follow-up', async () => {
  const parent = await ok(operator, 'work', { title: 'Parent A', plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:a'] }] }) as Work;
  const item = await followUp(parent, 11, ['src/a.ts — the retry is unbounded']);
  assert.equal(item.origin?.reviewFollowUps?.parent, parent.key);
  const body = { findings: [{ path: 'src/a.ts', text: 'src/a.ts:30 — the retry is unbounded' }, { path: 'src/b.ts', text: 'src/b.ts — the cache never expires' }], reason: 'approval 12' };
  const first = await ok(coordinator, `work/${item.key}/followups`, body, 'append-12');
  assert.deepEqual({ key: first.key, added: first.added, findings: first.findings }, { key: item.key, added: 1, findings: 2 });
  // The same approval retried returns the same answer; nothing is appended twice.
  assert.deepEqual(await ok(coordinator, `work/${item.key}/followups`, body, 'append-12'), first);
  const again = await ok(coordinator, `work/${item.key}/followups`, { ...body, reason: 'approval 13' });
  assert.equal(again.added, 0, 'every finding of a later approval is already held');
  const current = await reload(item.key);
  assert.equal(followUpEntries(current).length, 2);
  assert.equal(current.description.match(/the cache never expires/g)?.length, 1);
  assert.deepEqual((await events(current)).filter(event => event.kind === 'followups.appended').map(event => event.payload.details?.added ?? event.payload.added), [1]);
  // A worker may not append; an operator item is not a follow-up item.
  assert.equal((await call(worker, `work/${item.key}/followups`, body)).status, 403);
  const refused = await call(coordinator, `work/${parent.key}/followups`, body);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /not an open follow-up item/);
});

test('unit:followup-migration-merges — the one-time migration merges each parent\'s duplicates into its oldest open item, closes the rest naming it, records itself in history, and does not run twice', async () => {
  const parent = await ok(operator, 'work', { title: 'Parent B', plannedFiles: ['src/b.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:b'] }] }) as Work;
  const oldest = await followUp(parent, 21, ['src/b.ts — first finding'], false);
  const middle = await followUp(parent, 22, ['src/b.ts — first finding', 'src/c.ts — second finding'], false);
  const newest = await followUp(parent, 23, ['src/d.ts — third finding'], false);
  // GY-431: another parent's older follow-up item is leased while the migration runs.
  const other = await ok(operator, 'work', { title: 'Parent G', plannedFiles: ['src/g.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:g'] }] }) as Work;
  const leased = await followUp(other, 24, ['src/g.ts — leased finding'], false);
  const later = await followUp(other, 25, ['src/h.ts — later finding'], false);
  const lease = async (lease: object | null) => store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [leased.id, JSON.stringify({ ...(await reload(leased.key)), lease })]);
  await lease({ owner: 'backlog-worker', epoch: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const result = await ok(coordinator, 'followups/migrate', {});
  assert.equal(result.merged, 2);
  assert.deepEqual(result.deferred, [leased.key], 'the leased item is named, neither closed nor merged into');
  assert.equal((await reload(later.key)).stage, 'backlog');
  assert.deepEqual(result.survivors.find((entry: any) => entry.key === oldest.key), { key: oldest.key, absorbed: [middle.key, newest.key], added: 2 });
  const survivor = await reload(oldest.key);
  assert.equal(survivor.stage, 'backlog');
  assert.deepEqual(followUpEntries(survivor).map(entry => entry.text), ['src/b.ts — first finding', 'src/c.ts — second finding', 'src/d.ts — third finding']);
  for (const key of [middle.key, newest.key]) {
    const closed = await reload(key);
    assert.ok(isClosed(closed));
    assert.equal(closed.closure?.ref, oldest.key);
    assert.ok((await events(closed)).some(event => event.kind === 'work.closed'));
  }
  assert.ok((await events(survivor)).some(event => event.kind === 'followups.merged'));
  const recorded = (await store.pool.query("SELECT payload FROM events WHERE kind='followups.migrated'")).rows;
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].payload.merged, result.merged);
  // While the item stays leased, a second run changes nothing and still names it.
  const waiting = await ok(coordinator, 'followups/migrate', {}, 'migrate-waiting');
  assert.deepEqual({ already: waiting.already, merged: waiting.merged, deferred: waiting.deferred }, { already: true, merged: 0, deferred: [leased.key] });
  assert.equal((await store.pool.query("SELECT 1 FROM events WHERE kind='followups.migration.resumed'")).rowCount, 0, 'an unchanged pass records nothing');
  // Once its lease has ended, a later pass folds that parent's items into its oldest open one.
  await lease(null);
  const resumed = await ok(coordinator, 'followups/migrate', {}, 'migrate-resumed');
  assert.deepEqual({ merged: resumed.merged, deferred: resumed.deferred, survivors: resumed.survivors }, { merged: 1, deferred: [], survivors: [{ key: leased.key, absorbed: [later.key], added: 1 }] });
  assert.equal((await reload(later.key)).closure?.ref, leased.key);
  assert.deepEqual(followUpEntries(await reload(leased.key)).map(entry => entry.text), ['src/g.ts — leased finding', 'src/h.ts — later finding']);
  // One-time: with nothing deferred, a further run changes nothing and says it already ran.
  const repeat = await ok(coordinator, 'followups/migrate', {}, 'migrate-repeat');
  assert.equal(repeat.already, true);
  assert.equal(repeat.merged, result.merged);
  assert.equal((await store.pool.query("SELECT 1 FROM events WHERE kind='followups.migration.resumed'")).rowCount, 1);
  assert.equal((await store.list()).length, 9, 'nothing was deleted');
});

test('unit:machine-backlog-triaged — a triage release applies at once with its priority; a triage closure waits for an independent approver and a refusal returns the item to triage', async () => {
  const parent = await ok(operator, 'work', { title: 'Parent C', plannedFiles: ['src/e.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:c'] }] }) as Work;
  const shipped = await ok(operator, 'work', { title: 'Shipped fix', plannedFiles: ['src/f.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:c'] }] }) as Work;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [shipped.id, JSON.stringify({ ...(await reload(shipped.key)), stage: 'done', closure: null })]);
  const released = await followUp(parent, 31, ['src/e.ts — worth doing']);
  const closing = await followUp(parent, 32, ['src/f.ts — already fixed']);
  // Only the coordinator records a judgement, and only for a machine-filed item awaiting triage.
  assert.equal((await call(worker, `work/${released.key}/triage`, { judgement: { outcome: 'release', priority: 1, reason: 'real' } })).status, 403);
  assert.equal((await call(coordinator, `work/${parent.key}/triage`, { judgement: { outcome: 'release', priority: 1, reason: 'real' } })).status, 409);
  const release = await ok(coordinator, `work/${released.key}/triage`, { judgement: { outcome: 'release', priority: 1, reason: 'The retry bound is real work' }, runtime: 'pi' }) as Work;
  assert.equal(release.ready, true);
  assert.equal(release.priority, 1);
  assert.equal(release.triage?.state, 'applied');
  assert.ok((await events(release)).some(event => event.kind === 'triage.released'));
  // A closure naming an undelivered item is refused; one naming the delivered fix is proposed, not applied.
  assert.equal((await call(coordinator, `work/${closing.key}/triage`, { judgement: { outcome: 'close', ref: parent.key, reason: 'fixed' } })).status, 422);
  const proposed = await ok(coordinator, `work/${closing.key}/triage`, { judgement: { outcome: 'close', ref: shipped.key, reason: 'The fix shipped in the delivered item' } }) as Work;
  assert.equal(proposed.triage?.state, 'proposed');
  assert.equal(proposed.stage, 'backlog');
  const input = { kind: 'superseded', ref: shipped.key, reason: `Already fixed by ${shipped.key}: The fix shipped in the delivered item`, triageAt: proposed.triage!.at };
  // The requester cannot approve its own closure; a refusal returns the item to triage.
  const first = await ok(operator, `work/${closing.key}/decide`, { action: 'close', input, reason: 'triage judged it fixed' });
  assert.equal((await call(operator, `work/${closing.key}/approve`, { decision: first.id, reason: 'self' })).status, 403);
  await ok(approver, `work/${closing.key}/approve`, { action: 'refuse', decision: first.id, reason: 'The fix does not cover src/f.ts' });
  const refused = await reload(closing.key);
  assert.equal(refused.triage?.state, 'refused');
  assert.equal(refused.stage, 'backlog');
  // Judged again, and this time approved: the item is closed and its triage record applied.
  const again = await ok(coordinator, `work/${closing.key}/triage`, { judgement: { outcome: 'close', ref: shipped.key, reason: 'The fix shipped; src/f.ts is covered by its test' } }) as Work;
  const decision = await ok(operator, `work/${closing.key}/decide`, { action: 'close', input: { ...input, reason: `Already fixed by ${shipped.key}: covered`, triageAt: again.triage!.at }, reason: 'triage judged it fixed again' });
  const approved = await ok(approver, `work/${closing.key}/approve`, { decision: decision.id, reason: 'The delivered item covers it' });
  assert.equal(approved.state, 'applied', JSON.stringify(approved));
  const closed = await reload(closing.key);
  assert.ok(isClosed(closed));
  assert.equal(closed.closure?.kind, 'superseded');
  assert.equal(closed.closure?.ref, shipped.key);
  assert.equal(closed.triage?.state, 'applied');
  assert.equal(closed.triage?.decision, decision.id);
});

test('unit:machine-backlog-triaged — an approved triage merge applies atomically: a closure refused after the append leaves the target without the merged findings (GY-431)', async () => {
  const parent = await ok(operator, 'work', { title: 'Parent H', plannedFiles: ['src/m.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:h'] }] }) as Work;
  const target = await followUp(parent, 41, ['src/m.ts — kept finding']);
  const source = await ok(operator, 'work', { title: 'Recurring action:dispatch faults: 3 in 24 hours', type: 'bug', plannedFiles: ['src/n.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:h'] }] }) as Work;
  const proposed = await ok(coordinator, `work/${source.key}/triage`, { judgement: { outcome: 'merge', into: target.key, reason: 'the same fault' } }) as Work;
  const input = { kind: 'duplicate', ref: target.key, reason: `Merged into ${target.key} by triage: the same fault`, triageAt: proposed.triage!.at };
  const decision = await ok(operator, `work/${source.key}/decide`, { action: 'close', input, reason: 'triage merged it' });
  // A worker takes the source before the approval: its closure is refused after the append was made.
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [source.id, JSON.stringify({ ...(await reload(source.key)), lease: { owner: 'backlog-worker', epoch: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } })]);
  const failed = await ok(approver, `work/${source.key}/approve`, { decision: decision.id, reason: 'The same fault' });
  assert.equal(failed.state, 'failed', JSON.stringify(failed));
  const untouched = await reload(target.key);
  assert.deepEqual(followUpEntries(untouched).map(entry => entry.text), ['src/m.ts — kept finding'], 'the append rolled back with the refused closure');
  assert.ok(!(await events(untouched)).some(event => event.kind === 'followups.appended'));
  const open = await reload(source.key);
  assert.equal(open.stage, 'backlog');
  assert.equal(open.triage?.state, 'proposed');
});
