import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Observation, Principal, Work } from '../src/model.js';
import * as interventions from '../src/interventions.js';
import { foldInterventions, readInterventionLedger, type InterventionLedgerRow } from '../src/interventions.js';
import type { InterventionReport } from '../src/model/interventions.js';
import { loopRework } from '../src/cli/hand-rework.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1389: 386 rework "interventions" at the review stage in seven days, every one of them the
// loop's own review round — a rework it requested on a recorded ground (a standing change request,
// a failed required check, a base conflict, a mechanical finding) and its own approver (the risk
// lane, or the operator agent it launched) applied. Nobody stepped in, so none is a signal; a
// rework a coordinator requested, approved or applied by hand still is.

/** Every linked instance of the pattern, as the ledger recorded its decision and its rework. */
interface Instance {
  id: string; work: string;
  decision: { id: string; seq: number; at: string; binding: string | null; approved: { seq: number; at: string; actor: string; role: string } | null } | null;
  rework: { seq: number; at: string; actor: string; sha: string | null; pr: number | null };
}
const fixture = async () => JSON.parse(await readFile(new URL('./fixtures/gy-1389-rework-rounds.json', import.meta.url), 'utf8')) as { window: { from: string; to: string }; instances: Instance[] };

/** The ledger rows of one instance, in the order the fold reads them. */
function rowsOf(instance: Instance, workId = randomUUID()): InterventionLedgerRow[] {
  const work = { key: instance.work, stage: 'review', title: instance.work, candidate: instance.rework.sha ? { sha: instance.rework.sha, pr: instance.rework.pr ?? 0 } : null };
  const rows: InterventionLedgerRow[] = [];
  if (instance.decision) {
    rows.push({ seq: instance.decision.seq, workId, actor: 'graphyard-master-graphyard-operator', kind: 'decision.requested', at: instance.decision.at, details: undefined, stageBefore: 'review',
      payload: { id: instance.decision.id, action: 'rework', input: { previousWorkerStopped: true, ...(instance.decision.binding ? { binding: instance.decision.binding } : {}) }, requester: { id: 'graphyard-master-graphyard-operator', role: 'operator-agent' } } });
    const approved = instance.decision.approved;
    if (approved) rows.push({ seq: approved.seq, workId, actor: approved.actor, kind: 'decision.approved', at: approved.at, details: undefined, stageBefore: 'review',
      payload: { id: instance.decision.id, action: 'rework', approver: { id: approved.actor, role: approved.role }, requestedBy: 'graphyard-master-graphyard-operator' } });
  }
  rows.push({ seq: instance.rework.seq, workId, actor: instance.rework.actor, kind: 'rework', at: instance.rework.at, details: { reason: 'the loop returns the candidate to a worker', previousWorkerStopped: true }, stageBefore: 'review', work: { ...work, stage: 'build' } });
  return rows;
}

test('unit:rework-review-rounds-not-interventions — each of the 386 linked rework instances is replayed from the ledger rows it was read from (the request, its approval, the rework): the 360 the loop requested on recorded grounds and its own approver applied fold to no intervention; the 26 a master requested by hand still fold to one', async () => {
  const { instances } = await fixture();
  assert.equal(instances.length, 386);
  assert.ok(instances.every(instance => instance.decision?.approved && ['risk-lane', 'operator-agent'].includes(instance.decision.approved.role)), 'every linked instance was applied by the risk lane or a launched approver');
  const grounded = instances.filter(instance => instance.decision!.binding), hand = instances.filter(instance => !instance.decision!.binding);
  assert.deepEqual([grounded.length, hand.length], [360, 26]);
  const reworks = (instance: Instance) => foldInterventions(rowsOf(instance), [], instance.rework.at).interventions.filter(entry => entry.kind === 'rework');
  for (const instance of grounded) assert.deepEqual(reworks(instance).map(entry => entry.id), [], `${instance.id} (${instance.work}) is the review round working, not an intervention`);
  // A coordinator's hand request is one; master decide now refuses the 15 of them that restated the loop's round (below).
  for (const instance of hand) assert.deepEqual(reworks(instance).map(entry => entry.trigger), ['decision'], `${instance.id} (${instance.work}) was requested by hand`);
  // All of them on one ledger, in seq order, as the pattern scan reads them.
  const ids = new Map(instances.map(instance => [instance.work, randomUUID()]));
  const all = instances.flatMap(instance => rowsOf(instance, ids.get(instance.work)!)).sort((a, b) => a.seq - b.seq);
  assert.equal(foldInterventions(all, [], instances[0].rework.at).interventions.filter(entry => entry.kind === 'rework').length, hand.length);
});

test('unit:rework-by-hand-still-counted — a rework requested without grounds, approved by a person, applied with no decision, or applied beside a blocked report stays a rework intervention; a grounded request still waiting opens none', () => {
  const at = (minutes: number) => new Date(Date.parse('2026-10-06T00:00:00.000Z') + minutes * 60_000).toISOString();
  const grounded: Instance = { id: 'x', work: 'GY-HAND', decision: { id: randomUUID(), seq: 10, at: at(0), binding: `${'a'.repeat(40)}:verdict:graphyard-reviewer[bot]`, approved: { seq: 11, at: at(0), actor: 'graphyard-risk-lane', role: 'risk-lane' } }, rework: { seq: 12, at: at(1), actor: 'graphyard-master-graphyard-operator', sha: 'a'.repeat(40), pr: 7 } };
  const reworks = (rows: InterventionLedgerRow[], now = at(5)) => foldInterventions(rows, [], now).interventions.filter(entry => entry.kind === 'rework');
  assert.equal(reworks(rowsOf(grounded)).length, 0);
  // An operator agent the loop launched approving a high-lane round is the product's own approver too.
  assert.equal(reworks(rowsOf({ ...grounded, decision: { ...grounded.decision!, approved: { ...grounded.decision!.approved!, actor: 'graphyard-approver-graphyard', role: 'operator-agent' } } })).length, 0);
  // A master's hand request (no grounds binding) is a coordinator stepping in, whoever approved it.
  const hand = reworks(rowsOf({ ...grounded, decision: { ...grounded.decision!, binding: null } }));
  assert.deepEqual(hand.map(entry => [entry.trigger, entry.stage, entry.blocked]), [['decision', 'review', `candidate ${'a'.repeat(12)} (PR #7)`]]);
  // A person approving the loop's request did the approver's job.
  assert.equal(reworks(rowsOf({ ...grounded, decision: { ...grounded.decision!, approved: { ...grounded.decision!.approved!, actor: 'human-operator', role: 'admin' } } })).length, 1);
  // A rework command with no decision behind it is an operator's by hand.
  assert.deepEqual(reworks(rowsOf({ ...grounded, decision: null })).map(entry => entry.trigger), ['direct']);
  // A blocked report the rework answers is somebody stepping in, grounded request or not.
  const workId = randomUUID(), rows = rowsOf(grounded, workId);
  rows.unshift({ seq: 5, workId, actor: 'implementer', kind: 'blocked', at: at(-10), details: { reason: 'the fixture needs an answer' }, stageBefore: 'review', work: { key: 'GY-HAND', stage: 'review', blocker: 'the fixture needs an answer' } });
  assert.deepEqual(reworks(rows).map(entry => entry.trigger), ['blocked-report']);
  // Waiting: a hand request still waiting is an open signal; the loop's grounded one waiting on its own approver is not.
  const item = { id: workId, key: 'GY-HAND', title: 'GY-HAND', stage: 'review' } as Work;
  const waiting = (binding: string | null) => foldInterventions(rowsOf({ ...grounded, decision: { ...grounded.decision!, binding, approved: null } }, workId).slice(0, 1), [item], at(5)).interventions.filter(entry => entry.kind === 'rework');
  assert.equal(waiting(grounded.decision!.binding).length, 0);
  assert.deepEqual(waiting(null).map(entry => entry.resolvedAt), [null]);
});

// The 26 linked instances a master requested by hand, each judged on the work document the ledger
// held just before its request (trimmed; the trim is checked to leave the loop's verdict unchanged).
interface HandInstance { id: string; work: string; requestedAt: string; precedent: string[] | null; loopRework: string | null; document: Work }
const handFixture = async () => JSON.parse(await readFile(new URL('./fixtures/gy-1389-hand-reworks.json', import.meta.url), 'utf8')) as { instances: HandInstance[] };
const handRework = (instance: HandInstance, loop: Partial<Parameters<typeof loopRework>[4]> = {}, input: Record<string, unknown> = { previousWorkerStopped: true }) =>
  loopRework(instance.document, 'rework', input, { autoMerge: true }, { now: Date.parse(instance.requestedAt), requestsDecisions: true, precedent: instance.precedent?.join(',') ?? null, ...loop });

test('unit:hand-rework-restating-loop-refused — of the 26 hand reworks among the linked instances, the 15 that restated the round the loop\'s own rule was requesting on the same record are refused by master decide, naming the loop step; the 11 judgement calls stay open and stay counted', async () => {
  const { instances } = await handFixture();
  assert.equal(instances.length, 26);
  const refused = instances.filter(instance => handRework(instance));
  assert.deepEqual(refused.map(instance => instance.id), instances.filter(instance => instance.loopRework).map(instance => instance.id));
  assert.equal(refused.length, 15);
  for (const instance of refused) {
    const refusal = handRework(instance)!;
    assert.match(refusal, /the loop's decisions step requests this rework itself/);
    assert.ok(refusal.includes(instance.loopRework!), `${instance.id} names the grounds the loop requests it on`);
    assert.match(refusal, /--precedent/, 'it names the way a refusal is still answered by hand');
    // Where the loop sends the master, the hand rework stays open.
    assert.equal(handRework(instance, { precedent: 'a-refused-decision' }), null, 'answering a refusal');
    assert.equal(handRework(instance, { requestsDecisions: false }), null, 'a loop with no operator-agent identity');
    assert.equal(loopRework({ ...instance.document, systemDriven: false }, 'rework', { previousWorkerStopped: true }, { autoMerge: true }, { now: Date.parse(instance.requestedAt), requestsDecisions: true }), null, 'an item that is not system-driven');
  }
  for (const instance of instances.filter(instance => !instance.loopRework)) assert.equal(handRework(instance), null, `${instance.id} (${instance.work}): a judgement the loop does not make stays the master's`);
  // A hand request never carries the loop's grounds binding, so the report can tell the two apart.
  assert.match(handRework(instances[0], {}, { previousWorkerStopped: true, binding: 'x:verdict:y' })!, /grounds binding marks the loop's own rework request/);
  assert.equal(loopRework(instances[0].document, 'attest', {}, { autoMerge: true }, { now: 0, requestsDecisions: true }), null, 'only rework is judged here');
});

// Driven through the real decide route on a disposable Postgres: the risk lane applies the loop's
// grounded request, and a request recorded before the report's window opened is still read.
const repository = 'owner/rework-rounds';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `rounds-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1389;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('rework-rounds'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('rework_rounds_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/rework_rounds_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, null, undefined, { env: { ...process.env, GRAPHYARD_INTERVENTION_PATTERNS: '0' } });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const id = () => randomUUID();
async function ok(credential: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}
/** A submitted candidate observed touching two top-level areas: the medium lane, whose rework the risk lane applies. */
async function submitted(title: string) {
  const n = ++serial;
  let work = await engine.execute(operator, 'create', null, { title: `${title} ${n}`, plannedFiles: ['src/a.ts', 'docs/a.md'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] }, id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'rounds-host', path: `/tmp/rounds/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, id());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: 900 + n }, id());
  const observation: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: sha(work.key), baseSha: 'b'.repeat(40), pr: work.submission!.pr, branch: work.workspaces[0].branch, author: worker.id },
    checks: [{ name: 'test', result: 'failure', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null,
    baseTip: 'b'.repeat(40), baseTree: '7e'.repeat(20), files: ['src/a.ts', 'docs/a.md'], at: new Date().toISOString() };
  return engine.observe(work.id, work.revision, observation);
}
const rework = (work: Work, input: Record<string, unknown>) => ok(token(operator), 'POST', `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true, ...input }, reason: `${work.key}: required CI check test failed; the item returns to a worker` });
const reworksOf = (report: InterventionReport, key: string) => report.interventions.filter(entry => entry.kind === 'rework' && entry.work?.key === key);

test('integration:rework-review-rounds-report — the loop\'s grounded rework applied by the risk lane is no intervention in GET /api/interventions; a hand request applied the same way is one; and a grounded request recorded before the window opened still reads as grounded', async () => {
  const loop = await submitted('loop-round');
  const applied = await rework(loop, { binding: `${loop.candidate!.sha}:ci:test` });
  assert.equal(applied.state, 'applied', 'the medium lane applies a rework as it is requested');
  assert.equal(applied.approvedBy, 'graphyard-risk-lane');
  const hand = await submitted('hand-round');
  assert.equal((await rework(hand, {})).state, 'applied');

  const report = await ok(token(coordinator), 'GET', 'interventions?window=7') as InterventionReport;
  assert.deepEqual(reworksOf(report, loop.key), [], 'the loop\'s own review round is no signal');
  assert.deepEqual(reworksOf(report, hand.key).map(entry => entry.trigger), ['decision'], 'a coordinator\'s hand request is one');

  // The boundary: request and approval an hour before the window, the rework inside it.
  const early = await submitted('early-round');
  await rework(early, { binding: `${early.candidate!.sha}:ci:test` });
  // The ledger is append-only; the fixture backdates two rows with its triggers off for this one session.
  const client = await store.pool.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await client.query(`UPDATE events SET created_at = created_at - interval '2 hours' WHERE work_id=$1 AND kind IN ('decision.requested','decision.approved')`, [early.id]);
  } finally { await client.query('RESET session_replication_role').catch(() => {}); client.release(); }
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { rows } = await readInterventionLedger(store.reportPool, { since });
  assert.ok(rows.some(row => row.workId === early.id && row.kind === 'decision.requested'), 'the decision behind an in-window rework is read from before the window');
  assert.ok(typeof (interventions as Record<string, unknown>).interventionDecisionReachMs === 'number', 'the reach is a named bound');
  const folded = foldInterventions(rows, await store.list(), new Date().toISOString()).interventions;
  assert.deepEqual(folded.filter(entry => entry.kind === 'rework' && entry.work?.id === early.id), [], 'not read as a rework nobody requested');
});
