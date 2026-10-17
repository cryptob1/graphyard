import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as netServer, type AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save } from '../src/store.js';
import { lockedWork } from '../src/store/locked-read.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { candidateIdentityText, type ExactCandidate } from '../src/model/release.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1904 (GOAL-1, small-exact-candidates): ready changes — items Graphyard delivered — are cut into
// immutable candidates of at most five exact work/merge members on the plane's ledger, through the
// authenticated /api/candidates routes; the sixth waits for the next candidate.

const operator: Principal = { id: 'operator', role: 'admin' }, coordinator: Principal = { id: 'graphyard', role: 'coordinator' };
const worker: Principal = { id: 'worker-1', role: 'worker' }, reader: Principal = { id: 'reader-1', role: 'reader' };
const tokens = { operator: `operator-${'o'.repeat(40)}`, coordinator: `coordinator-${'c'.repeat(40)}`, worker: `worker-${'w'.repeat(40)}`, reader: `reader-${'r'.repeat(40)}` };
const credentials = [{ ...operator, token: tokens.operator }, { ...coordinator, token: tokens.coordinator }, { ...worker, token: tokens.worker }, { ...reader, token: tokens.reader }];

let database: EmbeddedPostgres, connection: string, store: Store, http: ReturnType<typeof server>, url: string;
const freePort = async () => { const probe = netServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const { port } = probe.address() as AddressInfo; await new Promise<void>(done => probe.close(() => done())); return port; };
async function start() {
  store = new Store(connection); await store.init();
  http = server(new Engine(store, [15368], 120, 'owner/fixture'), credentials);
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}
async function stop() { await new Promise<void>(done => http.close(() => done())); await store.close(); }

before(async () => {
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('goal-exact-candidates-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('candidates_test');
  connection = `postgres://graphyard:testing-only@127.0.0.1:${port}/candidates_test`;
  await start();
});
after(async () => { if (http) await stop().catch(() => {}); if (database) await database.stop(); });

let keys = 0;
const call = async (method: string, path: string, as: keyof typeof tokens, body?: unknown, key: string | null = `key-${++keys}`) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${tokens[as]}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const sha = (label: string) => createHash('sha1').update(label).digest('hex');
/** A change Graphyard delivered: an item created through the API, then recorded done with its merge commit, `minutesAgo` before now. */
async function delivered(title: string, minutesAgo = 1): Promise<Work & { mergeSha: string }> {
  const answer = await call('POST', 'work', 'operator', { title, description: 'A change delivered to main, waiting for its candidate.', type: 'feature', priority: 3,
    policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'The change is delivered', proofs: ['unit:delivered'] }] });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const mergeSha = sha(title);
  await store.transaction(async (db, now) => {
    const work = (await lockedWork(db, [answer.body.id])).find(entry => entry.id === answer.body.id)!;
    work.stage = 'done';
    work.delivery = { mergedAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(), mergeSha, authorizationRevision: work.revision };
    await save(db, work, 'test', 'test.delivered', now);
  });
  return { ...answer.body, mergeSha };
}
const cut = (body: unknown = { trigger: 'manual' }, as: keyof typeof tokens = 'coordinator', key?: string) => call('POST', 'candidates', as, body, key);
const ids = (candidate: ExactCandidate) => candidate.members.map(member => member.workId);
/** Every candidate on the ledger, read through the route as the reader, oldest first. */
const ledger = async () => { const answer = await call('GET', 'candidates', 'reader'); assert.equal(answer.status, 200); return (answer.body.candidates as ExactCandidate[]).slice().reverse(); };
const pinned = (candidate: ExactCandidate) => {
  assert.equal(candidate.sourceSha, candidate.members.at(-1)!.mergeSha, 'the combined source is the newest member\'s merge commit, which holds every earlier one');
  assert.equal(candidate.identity, `sha256:${createHash('sha256').update(candidateIdentityText(candidate.sourceSha, candidate.members)).digest('hex')}`, 'the identity pins the source and the exact membership');
};

test('integration:goal-exact-five-change-candidates — five- and six-change backlogs and concurrent cuts make candidates of at most five exact work/merge members with a pinned source and identity; the sixth is only in the next candidate, never lost or repeated', async () => {
  // A backlog of exactly five: one candidate of all five, in merge order, each bound to its merge commit.
  const five = [];
  for (let index = 1; index <= 5; index++) five.push(await delivered(`Five-backlog change ${index}`));
  const first = await cut();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(ids(first.body), five.map(item => item.id));
  assert.deepEqual(first.body.members.map((member: any) => [member.key, member.mergeSha]), five.map(item => [item.key, item.mergeSha]));
  assert.equal(first.body.waiting, 0); assert.equal(first.body.previous, null); pinned(first.body);
  const read = await call('GET', `candidates/${first.body.id}`, 'reader');
  assert.equal(read.status, 200); assert.deepEqual(read.body, first.body, 'the record read back is exactly the record cut');
  const empty = await cut();
  assert.equal(empty.status, 409); assert.match(empty.body.error, /No delivered change waits/);

  // A backlog of six: the oldest five, and the sixth only in the next candidate.
  const six = [];
  for (let index = 1; index <= 6; index++) six.push(await delivered(`Six-backlog change ${index}`));
  const second = await cut();
  assert.equal(second.status, 200);
  assert.deepEqual(ids(second.body), six.slice(0, 5).map(item => item.id));
  assert.equal(second.body.members.length, 5); assert.equal(second.body.waiting, 1); pinned(second.body);
  assert.deepEqual(second.body.previous, { id: first.body.id, sourceSha: first.body.sourceSha });
  const third = await cut();
  assert.equal(third.status, 200);
  assert.deepEqual(ids(third.body), [six[5].id], 'the sixth change is the whole of the next candidate'); pinned(third.body);

  // Concurrent cuts over a backlog of seven: disjoint candidates of at most five that together hold all seven once.
  const seven = [];
  for (let index = 1; index <= 7; index++) seven.push(await delivered(`Concurrent change ${index}`));
  const raced = await Promise.all([cut(), cut(), cut()]);
  const cutRecords = raced.filter(answer => answer.status === 200).map(answer => answer.body as ExactCandidate);
  assert.ok(raced.every(answer => answer.status === 200 || (answer.status === 409 && /No delivered change waits/.test(answer.body.error))), JSON.stringify(raced.map(answer => answer.status)));
  assert.ok(cutRecords.every(candidate => candidate.members.length >= 1 && candidate.members.length <= 5));
  const taken = cutRecords.sort((a, b) => a.sequence - b.sequence).flatMap(ids);
  assert.deepEqual(taken, seven.map(item => item.id), 'every waiting change is taken once, in merge order, by exactly one candidate');
  assert.deepEqual(cutRecords[0].members.length, 5);

  // Across the whole ledger no change appears twice and no candidate holds more than five.
  const all = await ledger();
  assert.deepEqual(all.map(candidate => candidate.sequence), all.map((_, index) => index + 1));
  const everyMember = all.flatMap(ids);
  assert.equal(new Set(everyMember).size, everyMember.length);
  assert.deepEqual(new Set(everyMember), new Set([...five, ...six, ...seven].map(item => item.id)));
  assert.ok(all.every(candidate => candidate.members.length <= 5));
  // A retried cut answers its first result rather than cutting again.
  const item = await delivered('Retried cut change');
  const once = await cut({ trigger: 'manual' }, 'coordinator', 'retried-cut'), again = await cut({ trigger: 'manual' }, 'coordinator', 'retried-cut');
  assert.equal(once.status, 200); assert.deepEqual(again.body, once.body); assert.deepEqual(ids(once.body), [item.id]);
});

test('integration:goal-candidate-cut-recovery — a partial batch cuts after the configured bounded wait, membership survives a restart, unauthorized cuts and lifecycle mutations are refused, and the record names the exact membership validation uses', async () => {
  // A partial batch under a scheduled cut waits for its bounded wait, then cuts.
  const fresh = await delivered('Partial batch change 1', 2);
  const early = await cut({ trigger: 'schedule', waitMinutes: 10 });
  assert.equal(early.status, 409); assert.match(early.body.error, new RegExp(`once ${fresh.key} has waited 10 minutes`));
  const due = await cut({ trigger: 'schedule', waitMinutes: 2 });
  assert.equal(due.status, 200, JSON.stringify(due.body));
  assert.deepEqual(ids(due.body), [fresh.id]); assert.equal(due.body.trigger, 'schedule');
  // A full batch under a scheduled cut is due at once.
  const batch = [];
  for (let index = 1; index <= 6; index++) batch.push(await delivered(`Scheduled batch change ${index}`, 0));
  const full = await cut({ trigger: 'schedule', waitMinutes: 60 });
  assert.equal(full.status, 200); assert.deepEqual(ids(full.body), batch.slice(0, 5).map(item => item.id));

  // The ledger survives a restart: the records read back unchanged, and the next cut starts after them.
  const before = await ledger();
  await stop(); await start();
  assert.deepEqual(await ledger(), before);
  const resumed = await cut();
  assert.equal(resumed.status, 200);
  assert.deepEqual(ids(resumed.body), [batch[5].id]);
  assert.equal(resumed.body.sequence, before.at(-1)!.sequence + 1);
  assert.deepEqual(resumed.body.previous, { id: before.at(-1)!.id, sourceSha: before.at(-1)!.sourceSha });

  // Unauthorized cuts are refused, and nothing edits, deletes or moves a candidate.
  const uncut = await delivered('Never cut by a worker');
  for (const as of ['worker', 'reader'] as const) {
    const refused = await cut({ trigger: 'manual' }, as);
    assert.equal(refused.status, 403, as); assert.match(refused.body.error, /cutting a candidate needs admin or coordinator/);
  }
  const unauthenticated = await fetch(`${url}/api/candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'anonymous' }, body: '{"trigger":"manual"}' });
  assert.equal(unauthenticated.status, 401);
  const forged = await cut({ trigger: 'manual', members: [{ workId: batch[0].id, mergeSha: sha('forged') }], sourceSha: sha('forged') });
  assert.equal(forged.status, 400); assert.match(forged.body.error, /A cut takes only/);
  const target = resumed.body.id;
  for (const [method, path, body] of [['POST', `candidates/${target}`, { validation: { result: 'pass' } }], ['PUT', `candidates/${target}`, { state: 'promoted' }], ['PATCH', `candidates/${target}`, { members: [] }],
    ['DELETE', `candidates/${target}`, undefined], ['POST', `candidates/${target}/state`, { state: 'promoted' }], ['DELETE', 'candidates', undefined]] as const) {
    const answer = await call(method, path, 'operator', body);
    assert.equal(answer.status, 405, `${method} ${path}`); assert.match(answer.body.error, /Candidate records are immutable/);
  }
  assert.deepEqual((await call('GET', `candidates/${target}`, 'reader')).body, resumed.body, 'the refused mutations changed nothing');
  assert.equal((await call('GET', 'candidates/C-999', 'reader')).status, 404);
  const rows = await store.pool.query("SELECT count(*) AS n FROM events WHERE kind='release.candidate'");
  assert.equal(Number(rows.rows[0].n), (await ledger()).length, 'one immutable ledger event per candidate');

  // The record names exactly what validation runs: each member's work item and merge commit, the source holding them all, and its identity.
  const record = (await call('GET', `candidates/${full.body.id}`, 'reader')).body as ExactCandidate;
  assert.deepEqual(record.members.map(member => ({ workId: member.workId, mergeSha: member.mergeSha })), batch.slice(0, 5).map(item => ({ workId: item.id, mergeSha: item.mergeSha })));
  assert.equal(record.validation, null); pinned(record);
  const listed = await call('GET', 'candidates', 'reader');
  assert.equal(listed.body.cap, 5); assert.equal(listed.body.waiting, 1); assert.deepEqual(listed.body.next.map((member: any) => member.workId), [uncut.id], 'the refused cuts left the change waiting');
});
