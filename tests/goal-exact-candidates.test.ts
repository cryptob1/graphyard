import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer as netServer, type AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save } from '../src/store.js';
import { lockedWork } from '../src/store/locked-read.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { candidateIdentityText, candidateValidationKind, exactCandidateKind, type ExactCandidate } from '../src/model/release.js';
import { candidateBacklog, firstFloor, listCandidates } from '../src/server/routes/candidates.js';
import { cutAsync, readLedgerAsync, type AsyncGit, type ReleaseCandidate } from '../src/release-candidate.js';
import { revertTarget, type CandidateItemDelta } from '../src/release-revert.js';
import type { VerificationMap } from '../src/model/verification-maps.js';
import { exactValidation } from '../src/daemon/release-ports.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1904 (GOAL-1, small-exact-candidates): ready changes — items Graphyard delivered — are cut into
// immutable candidates of at most five exact work/merge members on the plane's ledger, through the
// authenticated /api/candidates routes; the sixth waits for the next candidate.

const operator: Principal = { id: 'operator', role: 'admin' }, coordinator: Principal = { id: 'graphyard', role: 'coordinator' };
const worker: Principal = { id: 'worker-1', role: 'worker' }, reader: Principal = { id: 'reader-1', role: 'reader' };
const tokens = { operator: `operator-${'o'.repeat(40)}`, coordinator: `coordinator-${'c'.repeat(40)}`, worker: `worker-${'w'.repeat(40)}`, reader: `reader-${'r'.repeat(40)}` };
const credentials = [{ ...operator, token: tokens.operator }, { ...coordinator, token: tokens.coordinator }, { ...worker, token: tokens.worker }, { ...reader, token: tokens.reader }];

let database: EmbeddedPostgres, connection: string, store: Store, http: ReturnType<typeof server>, url: string, origin: string, checkout: string;
const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const asyncGit: AsyncGit = async args => git(...args);
const scopedAgent = { id: 'scoped-agent', token: `scoped-agent-${'s'.repeat(40)}` };
const freePort = async () => { const probe = netServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const { port } = probe.address() as AddressInfo; await new Promise<void>(done => probe.close(() => done())); return port; };
async function start() {
  store = new Store(connection); await store.init();
  http = server(new Engine(store, 120, 'owner/fixture'), credentials);
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
  const repository = await temporaryDirectory('goal-exact-candidates-git');
  origin = join(repository, 'origin.git'); checkout = join(repository, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git('config', key, value);
  await writeFile(join(checkout, 'README.md'), '# Fixture\n');
  git('add', '.'); git('commit', '-q', '-m', 'base'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
  const created = await call('POST', 'operator-agents', 'operator', { id: scopedAgent.id, displayName: scopedAgent.id, capabilities: ['intent:create'], scope: { repositories: ['owner/fixture'], workItems: ['GY-1'] }, token: scopedAgent.token, reason: 'A scoped agent' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});
after(async () => { if (http) await new Promise<void>(done => http.close(() => done())); if (store) await store.close().catch(() => {}); if (database) await database.stop(); });

let keys = 0;
const call = async (method: string, path: string, as: keyof typeof tokens | 'scoped', body?: unknown, key: string | null = `key-${++keys}`) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${as === 'scoped' ? scopedAgent.token : tokens[as]}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const sha = (label: string) => createHash('sha1').update(label).digest('hex');
let merges = 0;
/** A real merge on main's first-parent history, pushed to origin: its merge commit. */
async function mergeOnMain(title: string) {
  merges += 1;
  const branch = `graphyard/exact-${merges}`;
  git('checkout', '-q', '-b', branch, 'refs/remotes/origin/main');
  await writeFile(join(checkout, `change-${merges}.txt`), `${title}\n`); git('add', '.'); git('commit', '-q', '-m', title);
  git('checkout', '-q', '--detach', 'refs/remotes/origin/main');
  git('merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${merges} from owner/${branch}`);
  git('push', '-q', 'origin', 'HEAD:main'); git('fetch', '-q', 'origin');
  return git('rev-parse', 'HEAD');
}
/** Record `id` delivered by `mergeSha`, `minutesAgo` before now (or at `mergedAt`), as the merge writer's reconciliation records it. */
async function deliver(id: string, mergeSha: string, at: { minutesAgo?: number; mergedAt?: string } = {}) {
  await store.transaction(async (db, now) => {
    const work = structuredClone((await lockedWork(db, [id])).find(entry => entry.id === id)!);
    work.stage = 'done';
    work.delivery = { mergedAt: at.mergedAt ?? new Date(now.getTime() - (at.minutesAgo ?? 1) * 60_000).toISOString(), mergeSha, authorizationRevision: work.revision };
    await save(db, work, 'graphyard', 'merge-writer.reconciled', now, { mergeSha });
  });
}
/** A change Graphyard delivered: an item created through the API, merged on main, then recorded done with its merge commit, `minutesAgo` before now. */
async function delivered(title: string, minutesAgo = 1, mergedAt?: string): Promise<Work & { mergeSha: string }> {
  const answer = await call('POST', 'work', 'operator', { title, description: 'A change delivered to main, waiting for its candidate.', type: 'feature', priority: 3,
    policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'The change is delivered', proofs: ['unit:delivered'] }] });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const mergeSha = await mergeOnMain(title);
  await deliver(answer.body.id, mergeSha, { minutesAgo, mergedAt });
  return { ...answer.body, mergeSha };
}
/** The loop's release cut of an exact candidate: `rc/ID` tagged at its source in the real repository, carrying its members. */
async function tag(candidate: ExactCandidate, at: Date) {
  const result = await cutAsync(asyncGit, { base: 'main', trigger: 'manual', now: at, push: true,
    exact: { id: candidate.id, identity: candidate.identity, sourceSha: candidate.sourceSha, members: candidate.members.map(member => ({ key: member.key, mergeSha: member.mergeSha, pr: member.pr })) } });
  assert.equal(result.cut, true, JSON.stringify(result));
  const record = (await readLedgerAsync(asyncGit)).candidates.find(entry => entry.exact?.id === candidate.id)!;
  assert.equal(record.sha, candidate.sourceSha, 'the rc is tagged at the candidate\'s combined source');
  assert.deepEqual(record.exact?.members.map(member => [member.key, member.mergeSha]), candidate.members.map(member => [member.key, member.mergeSha]), 'exact.members keep membership/identity order');
  assert.deepEqual(record.items.map(item => [item.key, item.mergeSha]), [...candidate.members].reverse().map(member => [member.key, member.mergeSha]), 'items are newest-first for revertTarget');
  for (const member of candidate.members) git('merge-base', '--is-ancestor', member.mergeSha, record.sha);
  return record;
}
const cut = (body: unknown = { trigger: 'manual' }, as: keyof typeof tokens = 'coordinator', key?: string) => call('POST', 'candidates', as, body, key);
const ids = (candidate: ExactCandidate) => candidate.members.map(member => member.workId);
/** Every candidate on the ledger, read through the route as the reader, oldest first. */
const ledger = async () => { const answer = await call('GET', 'candidates', 'reader'); assert.equal(answer.status, 200); return (answer.body.candidates as ExactCandidate[]).slice().reverse(); };
const pinned = (candidate: ExactCandidate) => {
  assert.equal(candidate.sourceSha, candidate.members.at(-1)!.mergeSha, 'the combined source is the newest member\'s merge commit, which holds every earlier one');
  assert.equal(candidate.identity, `sha256:${createHash('sha256').update(candidateIdentityText(candidate.sourceSha, candidate.members)).digest('hex')}`, 'the identity pins the source and the exact membership');
};

test('integration:goal-exact-five-change-candidates — five- and six-change backlogs and concurrent cuts make candidates of at most five exact work/merge members with a pinned source and identity, each tagged as rc at that source on a real main; the sixth is only in the next candidate, never lost or repeated', async () => {
  let clock = Date.now();
  const next = () => new Date(clock += 1_000);
  // A backlog of exactly five: one candidate of all five, in merge order, each bound to its merge commit.
  const five = [];
  for (let index = 1; index <= 5; index++) five.push(await delivered(`Five-backlog change ${index}`));
  const first = await cut();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(ids(first.body), five.map(item => item.id));
  assert.deepEqual(first.body.members.map((member: any) => [member.key, member.mergeSha]), five.map(item => [item.key, item.mergeSha]));
  assert.equal(first.body.waiting, 0); assert.equal(first.body.previous, null); pinned(first.body);
  await tag(first.body, next());
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
  await tag(second.body, next());
  const third = await cut();
  assert.equal(third.status, 200);
  assert.deepEqual(ids(third.body), [six[5].id], 'the sixth change is the whole of the next candidate'); pinned(third.body);
  assert.deepEqual((await tag(third.body, next())).items.map(item => item.mergeSha), [six[5].mergeSha], 'the sixth change\'s rc carries it alone');
  // Multi-member exact cut: items newest-first so failure attribution matches the revert contract.
  const pair = [await delivered('Revert-order older'), await delivered('Revert-order newer')];
  const paired = await cut();
  assert.equal(paired.status, 200);
  assert.deepEqual(ids(paired.body), pair.map(item => item.id));
  const release = await tag(paired.body, next()) as ReleaseCandidate;
  assert.deepEqual(release.items.map(item => item.key), [pair[1].key, pair[0].key]);
  assert.deepEqual(release.exact!.members.map(member => member.key), [pair[0].key, pair[1].key]);
  const deltas: CandidateItemDelta[] = [
    { key: pair[0].key, mergeSha: pair[0].mergeSha, files: ['src/shared/a.ts'] },
    { key: pair[1].key, mergeSha: pair[1].mergeSha, files: ['src/shared/b.ts'] },
  ];
  const map: VerificationMap = { path: 'verification/shared.md', paths: ['src/shared/**'], sections: { Tests: 't', Drive: 'd', Invariants: 'i', Gotchas: 'g' } };
  const failing = { e2e: { runId: 'run-revert-order', sha: release.sha, blocking: ['shared-case'], cases: [{ case: 'shared-case', verdict: 'failed' as const, required: true, attempts: 1, failingStep: { index: 1, name: 'open', reason: 'missing' } }] } };
  const matched = revertTarget(release, failing, deltas, [map], { outcomes: [{ id: 'shared', cases: ['shared-case'] }], cases: [{ id: 'shared-case', tags: ['shared'] }] })!;
  assert.equal(matched.key, pair[1].key, 'matching map covering both members reverts the newest');
  const fallback = revertTarget(release, failing, deltas, [], { outcomes: [] })!;
  assert.equal(fallback.key, pair[1].key, 'no map falls back to the newest member, not the oldest');
  const olderOnly = revertTarget(release, failing, [
    { key: pair[0].key, mergeSha: pair[0].mergeSha, files: ['src/older/only.ts'] },
    { key: pair[1].key, mergeSha: pair[1].mergeSha, files: ['src/newer/only.ts'] },
  ], [{ path: 'verification/older.md', paths: ['src/older/**'], sections: { Tests: 't', Drive: 'd', Invariants: 'i', Gotchas: 'g' } }],
    { outcomes: [{ id: 'older', cases: ['shared-case'] }], cases: [{ id: 'shared-case', tags: ['older'] }] })!;
  assert.equal(olderOnly.key, pair[0].key, 'a map covering only the older member still selects it');

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
  for (const candidate of cutRecords) await tag(candidate, next());

  // Two merges recorded at the same instant are taken in main's merge order, not item order: the
  // later-created item merged first, so the source is the other's merge, which holds both.
  const [early, late] = [await call('POST', 'work', 'operator', { title: 'Tie created first', description: 'Merged second.', type: 'feature', priority: 3, policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'Delivered', proofs: ['unit:delivered'] }] }),
    await call('POST', 'work', 'operator', { title: 'Tie created second', description: 'Merged first.', type: 'feature', priority: 3, policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'Delivered', proofs: ['unit:delivered'] }] })];
  const instant = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000).toISOString();
  const lateSha = await mergeOnMain('Tie created second'); await deliver(late.body.id, lateSha, { mergedAt: instant });
  const earlySha = await mergeOnMain('Tie created first'); await deliver(early.body.id, earlySha, { mergedAt: instant });
  const tied = await cut();
  assert.deepEqual(ids(tied.body), [late.body.id, early.body.id]); assert.equal(tied.body.sourceSha, earlySha); pinned(tied.body);
  await tag(tied.body, next());

  // A reverted change reworked and merged again is a new change: its new merge enters the next candidate under the same work item.
  const reworked = five[2], remerged = await mergeOnMain('Five-backlog change 3, reworked');
  await deliver(reworked.id, remerged);
  const rework = await cut();
  assert.equal(rework.status, 200, JSON.stringify(rework.body));
  assert.deepEqual(rework.body.members.map((member: any) => [member.workId, member.mergeSha]), [[reworked.id, remerged]]);
  await tag(rework.body, next());

  // Across the whole ledger no change appears twice and no candidate holds more than five.
  const all = await ledger();
  assert.deepEqual(all.map(candidate => candidate.sequence), all.map((_, index) => index + 1));
  const everyMember = all.flatMap(ids);
  const everyPair = all.flatMap(candidate => candidate.members.map(member => `${member.workId} ${member.mergeSha}`));
  assert.equal(new Set(everyPair).size, everyPair.length, 'no change is in two candidates');
  assert.deepEqual(new Set(everyMember), new Set([...five, ...six, ...seven, ...pair].map(item => item.id).concat(late.body.id, early.body.id)));
  assert.ok(all.every(candidate => candidate.members.length <= 5));
  // A retried cut answers its first result rather than cutting again.
  const item = await delivered('Retried cut change');
  const once = await cut({ trigger: 'manual' }, 'coordinator', 'retried-cut'), again = await cut({ trigger: 'manual' }, 'coordinator', 'retried-cut');
  assert.equal(once.status, 200); assert.deepEqual(again.body, once.body); assert.deepEqual(ids(once.body), [item.id]);
});

test('integration:goal-candidate-cut-recovery — a partial batch cuts after the configured bounded wait, a long-waiting change is never dropped, membership survives a restart, unauthorized cuts and lifecycle mutations are refused, and the record holds the validation run on exactly its members', async () => {
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
  // A change that waited two days — through a weekend or a cut outage — is still backlog, never history.
  const stale = await delivered('Waited through the weekend', 2 * 24 * 60);
  const resumed = await cut();
  assert.equal(resumed.status, 200);
  assert.deepEqual(ids(resumed.body), [stale.id, batch[5].id], 'the oldest waiting change first, however old');
  assert.equal(resumed.body.sequence, before.at(-1)!.sequence + 1);
  assert.deepEqual(resumed.body.previous, { id: before.at(-1)!.id, sourceSha: before.at(-1)!.sourceSha });

  // Unauthorized cuts are refused, and nothing edits, deletes or moves a candidate.
  const uncut = await delivered('Never cut by a worker');
  for (const as of ['worker', 'reader'] as const) {
    const refused = await cut({ trigger: 'manual' }, as);
    assert.equal(refused.status, 403, as); assert.match(refused.body.error, /cutting or validating a candidate needs admin or coordinator/);
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
  assert.equal(record.validation, null, 'no verdict before UAT ran'); pinned(record);
  // The loop tags rc at that source and validates it; its verdict is recorded on the candidate, bound to the source and identity.
  const release = await tag(record, new Date(Date.now() + 3_600_000));
  const uat = { result: 'passed' as const, suites: [{ name: 'e2e', passed: true, detail: 'ok' }], e2e: { runId: 'run-1', sha: release.sha, blocking: [], cases: [{ case: 'candidate-batches-five', verdict: 'passed' as const, required: true, attempts: 1 }] } };
  const verdict = exactValidation({ ...release, exact: release.exact! }, uat as any);
  for (const as of ['worker', 'reader'] as const) assert.equal((await call('POST', `candidates/${record.id}/validation`, as, verdict)).status, 403, as);
  const elsewhere = await call('POST', `candidates/${record.id}/validation`, 'coordinator', { ...verdict, sha: resumed.body.sourceSha });
  assert.equal(elsewhere.status, 409); assert.match(elsewhere.body.error, /must name its source/);
  const recorded = await call('POST', `candidates/${record.id}/validation`, 'coordinator', verdict);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  const validated = (await call('GET', `candidates/${record.id}`, 'reader')).body as ExactCandidate;
  assert.deepEqual({ ...validated, validation: null }, record, 'the cut record itself never changes');
  assert.deepEqual(validated.validation && { release: validated.validation.release, sha: validated.validation.sha, identity: validated.validation.identity, result: validated.validation.result, cases: validated.validation.cases },
    { release: release.id, sha: record.sourceSha, identity: record.identity, result: 'pass', cases: [{ id: 'candidate-batches-five', result: 'pass' }] });
  assert.equal((await call('POST', `candidates/${record.id}/validation`, 'coordinator', verdict)).status, 200, 'the same verdict again answers as recorded');
  const identicalReplay = await call('POST', `candidates/${record.id}/validation`, 'coordinator', verdict, 'validation-identical-replay');
  assert.equal(identicalReplay.status, 200, 'identical content under a fresh Idempotency-Key replays the stored record');
  assert.deepEqual(identicalReplay.body.validation && { release: identicalReplay.body.validation.release, result: identicalReplay.body.validation.result, cases: identicalReplay.body.validation.cases, failed: identicalReplay.body.validation.failed },
    { release: release.id, result: 'pass', cases: [{ id: 'candidate-batches-five', result: 'pass' }], failed: [] });
  const changedCases = await call('POST', `candidates/${record.id}/validation`, 'coordinator', { ...verdict, cases: [{ id: 'candidate-batches-five', result: 'failed' }] }, 'validation-changed-cases');
  assert.equal(changedCases.status, 409); assert.match(changedCases.body.error, /a validation is recorded once/);
  const changedFailed = await call('POST', `candidates/${record.id}/validation`, 'coordinator', { ...verdict, failed: ['e2e'] }, 'validation-changed-failed');
  assert.equal(changedFailed.status, 409); assert.match(changedFailed.body.error, /a validation is recorded once/);
  const contradicting = await call('POST', `candidates/${record.id}/validation`, 'coordinator', { ...verdict, result: 'fail' });
  assert.equal(contradicting.status, 409); assert.match(contradicting.body.error, /a validation is recorded once/);
  // An operator agent scoped to some work items reads no candidate naming another's, and cannot cut or validate one either.
  const scoped = await call('GET', 'candidates', 'scoped');
  assert.equal(scoped.status, 200);
  assert.ok((scoped.body.candidates as ExactCandidate[]).every(candidate => candidate.members.every(member => member.key === 'GY-1')), JSON.stringify(scoped.body.candidates.map((candidate: ExactCandidate) => candidate.id)));
  assert.ok(scoped.body.next.every((member: any) => member.key === 'GY-1'));
  const outside = await call('GET', `candidates/${record.id}`, 'scoped');
  assert.equal(outside.status, 403); assert.match(outside.body.error, /outside operator agent scoped-agent's scope/);
  const candidatesBeforeScoped = Number((await store.pool.query("SELECT count(*) AS n FROM events WHERE kind='release.candidate'")).rows[0].n);
  const scopedCut = await call('POST', 'candidates', 'scoped', { trigger: 'manual' }, 'scoped-cut-refused');
  assert.equal(scopedCut.status, 403); assert.match(scopedCut.body.error, /outside operator agent scoped-agent's scope/);
  assert.equal(Number((await store.pool.query("SELECT count(*) AS n FROM events WHERE kind='release.candidate'")).rows[0].n), candidatesBeforeScoped, 'the refused scoped cut wrote nothing');
  const scopedValidate = await call('POST', `candidates/${record.id}/validation`, 'scoped', verdict, 'scoped-validation-refused');
  assert.equal(scopedValidate.status, 403); assert.match(scopedValidate.body.error, /outside operator agent scoped-agent's scope/);
  const listed = await call('GET', 'candidates', 'reader');
  assert.equal(listed.body.cap, 5); assert.equal(listed.body.waiting, 1); assert.deepEqual(listed.body.next.map((member: any) => member.workId), [uncut.id], 'the refused cuts left the change waiting');
});

test('integration:goal-candidate-cut-recovery — the first cut after legacy rc candidates starts after the newest rc source\'s recorded delivery, never re-cutting it, and every candidate without a verdict stays listed however many newer ones were cut', async () => {
  // The plane records a delivery's merge time when its push lands, after the merge commit's own time.
  const answer = await call('POST', 'work', 'operator', { title: 'Shipped by the newest legacy rc', description: 'A change the newest legacy rc candidate already holds.', type: 'feature', priority: 3,
    policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'The change is delivered', proofs: ['unit:delivered'] }] });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const legacySha = await mergeOnMain('Shipped by the newest legacy rc');
  const committed = new Date(git('show', '-s', '--format=%cI', legacySha)).toISOString();
  await deliver(answer.body.id, legacySha, { mergedAt: new Date(Date.parse(committed) + 30_000).toISOString() });
  const byCommit = await firstFloor(store.pool, { trigger: 'schedule', since: committed });
  assert.ok((await candidateBacklog(store.pool, byCommit, 100)).members.some(member => member.workId === answer.body.id), 'the commit time alone leaves the shipped change as backlog');
  const floor = await firstFloor(store.pool, { trigger: 'schedule', since: committed, sinceSha: legacySha });
  assert.equal(floor, new Date(Date.parse(committed) + 30_000).toISOString(), 'the boundary moves up to the recorded delivery');
  assert.ok(!(await candidateBacklog(store.pool, floor, 100)).members.some(member => member.workId === answer.body.id), 'the change the legacy rc shipped is history, not backlog');
  assert.equal(await firstFloor(store.pool, { trigger: 'schedule', since: committed, sinceSha: sha('never delivered') }), committed, 'a source with no recorded delivery keeps since');

  // An untagged candidate behind 21 newer, validated ones stays listed; a validated one past the newest 20 does not.
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    const insert = (kind: string, payload: unknown) => client.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', kind, JSON.stringify(payload)]);
    await insert(exactCandidateKind, { id: 'C-untagged-old', members: [] });
    for (let index = 0; index < 21; index++) {
      await insert(exactCandidateKind, { id: `C-window-${index}`, members: [] });
      await insert(candidateValidationKind, { candidate: `C-window-${index}`, validation: { result: 'pass' } });
    }
    const listed = (await listCandidates(client)).map(candidate => candidate.id);
    assert.ok(listed.indexOf('C-untagged-old') > listed.indexOf('C-window-1'), 'the old unvalidated candidate is listed, after every newer one');
    assert.ok(!listed.includes('C-window-0'), 'a validated candidate older than the newest 20 is not');
    assert.ok(listed.includes('C-window-1') && listed.includes('C-window-20'));
  } finally { await client.query('ROLLBACK'); client.release(); }
});
