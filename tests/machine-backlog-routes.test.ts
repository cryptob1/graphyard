import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { isClosed, type Principal, type Work } from '../src/model.js';

// GY-402 against a real Postgres and the real routes: triage of the follow-up items filed before
// GY-1249 retired the filing — a release applied at once, a closure applied only once an
// independent approver approves it, and a merge that appends to an open follow-up item, filing none.
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
/** A follow-up item as the loop filed it before GY-1249, created directly as a stored fixture. */
async function followUp(parent: Work, reviewId: number, findings: string[]) {
  const entries = findings.map(text => ({ path: text.split(' ')[0]!, text }));
  return ok(operator, 'work', {
    title: `Follow-ups from the approved review of ${parent.key} (PR #7)`, description: `Review ${reviewId}.\n\n${entries.map((entry, index) => `${index + 1}. Finding with no thread: ${entry.text}`).join('\n')}`,
    type: 'chore', priority: 2, dependencies: [], plannedFiles: entries.map(entry => entry.path),
    criteria: [{ id: 'AC-1', text: 'Each follow-up listed in the description is addressed in code, or declined with a recorded reason.', proofs: ['manual:review-followups-triaged'] }],
    origin: { reviewFollowUps: { parent: parent.key, findings: entries } }, policy: { checks: ['test'], review: true },
  }) as Promise<Work>;
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 402;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('backlog-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('backlog_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/backlog_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

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

test('unit:machine-backlog-triaged — a triage merge appends the merged item\'s findings to the open follow-up item it names, deduplicated, and creates no item', async () => {
  const parent = await ok(operator, 'work', { title: 'Parent D', plannedFiles: ['src/g.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:d'] }] }) as Work;
  const into = await followUp(parent, 41, ['src/g.ts — the bound is unchecked']);
  const merging = await followUp(parent, 42, ['src/g.ts — the bound is unchecked', 'src/h.ts — the cache never expires']);
  const before = (await store.list()).length;
  const judged = await ok(coordinator, `work/${merging.key}/triage`, { judgement: { outcome: 'merge', into: into.key, reason: 'the same parent' } }) as Work;
  const decision = await ok(operator, `work/${merging.key}/decide`, { action: 'close', input: { kind: 'duplicate', ref: into.key, reason: `Merged into ${into.key} by triage: the same parent`, triageAt: judged.triage!.at }, reason: 'triage judged it a duplicate' });
  const approved = await ok(approver, `work/${merging.key}/approve`, { decision: decision.id, reason: 'Same parent, same findings' });
  assert.equal(approved.state, 'applied', JSON.stringify(approved));
  assert.ok(isClosed(await reload(merging.key)));
  const merged = await reload(into.key);
  assert.deepEqual(merged.origin?.reviewFollowUps?.findings.map(entry => entry.text), ['src/g.ts — the bound is unchecked', 'src/h.ts — the cache never expires']);
  assert.match(merged.description ?? '', /merged from GY-\d+:\n\d+\. src\/h\.ts — the cache never expires/);
  assert.ok((await events(merged)).some(event => event.kind === 'followups.appended'));
  assert.equal((await store.list()).length, before, 'the merge created no item');
});

test('unit:machine-backlog-triaged — the loop withdraws a triage closure a later recurrence overtook: the item returns to triage and an approval of its close decision closes nothing', async () => {
  const parent = await ok(operator, 'work', { title: 'Parent E', plannedFiles: ['src/i.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:e'] }] }) as Work;
  const shipped = await ok(operator, 'work', { title: 'Shipped fix E', plannedFiles: ['src/i.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:e'] }] }) as Work;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [shipped.id, JSON.stringify({ ...(await reload(shipped.key)), stage: 'done', closure: null })]);
  const closing = await followUp(parent, 51, ['src/i.ts — covered by the shipped fix']);
  const proposed = await ok(coordinator, `work/${closing.key}/triage`, { judgement: { outcome: 'close', ref: shipped.key, reason: 'covered' } }) as Work;
  const decision = await ok(operator, `work/${closing.key}/decide`, { action: 'close', input: { kind: 'superseded', ref: shipped.key, reason: `Already fixed by ${shipped.key}: covered`, triageAt: proposed.triage!.at }, reason: 'triage judged it covered' });
  const withdraw = { withdraw: { triageAt: proposed.triage!.at, reason: 'a recurrence after the landing was linked to it' } };
  // Only the coordinator withdraws; a withdrawal of a proposal the item no longer carries changes nothing.
  assert.equal((await call(worker, `work/${closing.key}/triage`, withdraw)).status, 403);
  const unchanged = await ok(coordinator, `work/${closing.key}/triage`, { withdraw: { ...withdraw.withdraw, triageAt: new Date(0).toISOString() } }) as Work;
  assert.equal(unchanged.triage?.state, 'proposed');
  const withdrawn = await ok(coordinator, `work/${closing.key}/triage`, withdraw) as Work;
  assert.equal(withdrawn.triage?.state, 'refused');
  assert.match(withdrawn.triage?.refusal ?? '', /Withdrawn by backlog-master: a recurrence after the landing/);
  assert.ok((await events(withdrawn)).some(event => event.kind === 'triage.withdrawn'));
  // The approver judging the close decision afterwards applies nothing: the item stays open, back in triage.
  assert.equal((await call(approver, `work/${closing.key}/approve`, { decision: decision.id, reason: 'covered' })).status, 409);
  const after = await reload(closing.key);
  assert.equal(isClosed(after), false);
  assert.equal(after.stage, 'backlog');
  assert.equal(after.triage?.state, 'refused');
});
