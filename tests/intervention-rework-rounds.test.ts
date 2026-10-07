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
import { loopBaseFailed, loopRework, type HandReworkLoop } from '../src/cli/hand-rework.js';
import type { ExhaustedProof } from '../src/daemon/decisions.js';
import { dropRetiredQueueFields, retiredQueueFields } from '../src/model/retired-queue.js';
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
  // A coordinator's hand request is one; master decide now refuses the 21 of them the loop's own rules own (below).
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
  // So did one approving the loop's failed-check round, which the fold otherwise reads as CI's own (GY-1387).
  const ci = { ...grounded.decision!, binding: `${'a'.repeat(40)}:ci:test` };
  assert.equal(reworks(rowsOf({ ...grounded, decision: ci })).length, 0);
  assert.equal(reworks(rowsOf({ ...grounded, decision: { ...ci, approved: { ...ci.approved!, actor: 'human-operator', role: 'admin' } } })).length, 1);
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

test('unit:rework-reach-serves-window-outcomes — a decision row read from the reach before the window is folded only when a row inside the window names the same decision or a rework inside it may apply it; a request that only waited before the window is no signal of it', () => {
  const since = '2026-10-06T00:00:00.000Z', before = '2026-10-05T12:00:00.000Z', inside = '2026-10-06T06:00:00.000Z';
  const row = (seq: number, kind: string, work: string, at: string, id?: string) => ({ seq, kind, work_id: work, created_at: at, top: id ? { id } : null });
  const rows = [row(1, 'decision.requested', 'w1', before, 'd1'), row(2, 'decision.requested', 'w2', before, 'd2'), row(3, 'decision.requested', 'w3', before, 'd3'), row(4, 'decision.approved', 'w3', before, 'd3'),
    row(5, 'rework', 'w1', inside), row(6, 'decision.withdrawn', 'w2', inside, 'd2'), row(7, 'decision.requested', 'w4', before, 'd4')];
  assert.deepEqual(interventions.windowOutcomes(rows, since).map(entry => entry.seq), [1, 2, 5, 6], 'w3 settled and w4 only waited before the window opened');
});

// The 26 linked instances a master requested by hand, each judged on the work document the ledger
// held just before its request (trimmed; the trim is checked to leave the loop's verdict unchanged).
interface HandInstance { id: string; work: string; requestedAt: string; precedent: string[] | null; reason: string; loopRework: string | null; document: Work }
const handFixture = async () => JSON.parse(await readFile(new URL('./fixtures/gy-1389-hand-reworks.json', import.meta.url), 'utf8')) as { instances: HandInstance[] };
const reviewerApp = { appId: 1, installationId: 2, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.pem', boundAt: '2026-09-24T00:00:00Z' };
const loopConfig = { autoMerge: true, reviewer: reviewerApp };
/**
 * The producer requests the loop had spent on a head, as its dispatch cursor held them: the cursor is
 * not in the ledger, so each is rebuilt from what the hand request itself quoted — every launch on the
 * agy account answered 'Individual quota reached', and the session never started.
 */
const quotaSpent = (instance: HandInstance): ExhaustedProof[] => /Individual quota reached/.test(instance.reason)
  ? [{ requestId: `spent-${instance.work}`, work: instance.work, sha: instance.document.candidate!.sha, group: 'unit', proofs: [], reason: 'the loop stopped attempting the request',
    attempts: ["attempt 1 on agy-producer: failed — never started: the agy account answered the launch with 'Individual quota reached'"] }] : [];
const loopOf = (instance: HandInstance, loop: Partial<HandReworkLoop> = {}): HandReworkLoop =>
  ({ now: Date.parse(instance.requestedAt), requestsDecisions: true, precedent: instance.precedent?.join(',') ?? null, baseFailed: new Set(), exhausted: quotaSpent(instance), mechanical: [], capEscalated: false, ...loop });
const handRework = (instance: HandInstance, loop: Partial<HandReworkLoop> = {}, input: Record<string, unknown> = { previousWorkerStopped: true }) =>
  loopRework(instance.document, 'rework', input, loopConfig, loopOf(instance, loop));
/** Graphyard's own merge queue ejected the head (GY-1236 removed the queue: no speculative tip is built or ejected now). */
const queueEjected = (instance: HandInstance) => !!(instance.document as Work & { queueEjection?: unknown }).queueEjection
  && (instance.document.gates.find(gate => gate.name === 'merge')?.reasons ?? []).some(reason => reason.startsWith('Ejected from the merge queue:'));

test('unit:hand-rework-restating-loop-refused — of the 26 hand reworks among the linked instances, the 21 the loop\'s own rules now own are refused by master decide (the round it requests on the same record, its mechanical bot round, a capped change request its approver judges or it withdraws, a head whose producers never started), 4 rested on the retired merge queue\'s ejections, and 1 judgement call is left: under 3 in the replayed week', async () => {
  const { instances } = await handFixture();
  assert.equal(instances.length, 26);
  const refused = instances.filter(instance => handRework(instance));
  const owned = (pattern: RegExp) => refused.filter(instance => pattern.test(handRework(instance)!)).map(instance => instance.work);
  // The round the loop's decisions step was requesting on the same record — 15 of them, the binding the fixture recorded from the loop's own rule.
  for (const instance of instances.filter(instance => instance.loopRework)) {
    const refusal = handRework(instance)!;
    assert.match(refusal, /the loop's decisions step requests this rework itself/, instance.id);
    assert.ok(refusal.includes(instance.loopRework!), `${instance.id} names the grounds the loop requests it on`);
    assert.match(refusal, /--precedent/, 'it names the way a refusal is still answered by hand');
    // Where the loop sends the master, the hand rework stays open.
    assert.equal(handRework(instance, { precedent: 'a-refused-decision' }), null, 'answering a refusal');
    assert.equal(handRework(instance, { requestsDecisions: false }), null, 'a loop with no operator-agent identity');
    assert.equal(loopRework({ ...instance.document, systemDriven: false }, 'rework', { previousWorkerStopped: true }, loopConfig, loopOf(instance)), null, 'an item that is not system-driven');
  }
  // GY-1166's change request past the cap names a blocking finding: the loop now requests that round for its approver.
  assert.deepEqual(owned(/:capped:graphyard-reviewer\[bot\]\)/), ['GY-1166']);
  // GY-1339's approval named a mechanical nit the worker bot's round fixes (GY-971).
  assert.deepEqual(owned(/classified mechanical, which the worker bot fixes/), ['GY-1339']);
  // GY-1039's capped change request named no blocking finding: the loop withdraws it, and the head is reviewed again.
  assert.deepEqual(owned(/review-cap step withdraws such a request/), ['GY-1039']);
  // GY-1157, GY-1114 and GY-949: no producer session ever started on the head; the loop relaunches once an account is eligible, and a precedent does not reopen it.
  assert.deepEqual(owned(/ended without the session acting/), ['GY-1157', 'GY-1114', 'GY-949']);
  assert.ok(instances.filter(instance => quotaSpent(instance).length).every(instance => /ended without the session acting/.test(handRework(instance, { precedent: 'c0557205-db4a-48f9-ba1b-af0bd85cf74c' }) ?? '')));
  assert.equal(refused.length, 21);

  // Left open: four ejections by Graphyard's own merge queue — retired with GY-1236, so nothing ejects a head now
  // and every document write drops the fields — and one judgement the loop does not make.
  const open = instances.filter(instance => !handRework(instance));
  assert.deepEqual(open.filter(queueEjected).map(instance => instance.work), ['GY-1171', 'GY-1069', 'GY-913', 'GY-501']);
  assert.ok(retiredQueueFields.includes('queueEjection') && !('queueEjection' in dropRetiredQueueFields({ ...open[0].document })));
  const judgement = open.filter(instance => !queueEjected(instance));
  assert.deepEqual(judgement.map(instance => [instance.work, instance.requestedAt]), [['GY-501', '2026-10-02T05:00:27.216Z']]);
  assert.ok(judgement.length < 3, 'the replayed week leaves under 3 rework interventions at the review stage');

  // A hand request never carries the loop's grounds binding, so the report can tell the two apart.
  assert.match(handRework(instances[0], {}, { previousWorkerStopped: true, binding: 'x:verdict:y' })!, /grounds binding marks the loop's own rework request/);
  assert.equal(loopRework(instances[0].document, 'attest', {}, loopConfig, loopOf(instances[0])), null, 'only rework is judged here');
});

test('unit:hand-rework-loop-context — the guard judges a hand rework on the loop\'s own context: a check the base fails too is no worker\'s, so it refuses nothing on it (nor on a failed check while the loop\'s base judgement is unread); a capped request the loop already escalated stays the master\'s', async () => {
  const { instances } = await handFixture();
  const ci = instances.find(instance => instance.loopRework?.includes(':ci:'))!;
  const check = ci.loopRework!.split(':ci:')[1];
  assert.ok(handRework(ci), 'a failed check the base passes is the loop\'s round');
  assert.equal(handRework(ci, { baseFailed: new Set(check.split(',')) }), null, 'the loop raises a check the base fails too against the base and requests no rework (GY-528)');
  assert.equal(handRework(ci, { baseFailed: null }), null, 'without the loop\'s base judgement a failed check is not known to be the worker\'s');
  const state = (baseFailures: Record<string, { check: string; blocks: { id: string; sha: string }[] }>, actions: Record<string, { detail: string }> = {}) => ({ baseFailures, actions });
  const head = ci.document.candidate!.sha;
  assert.deepEqual([...loopBaseFailed(ci.document, state({ a: { check, blocks: [{ id: ci.document.id, sha: head }] }, b: { check: 'other', blocks: [{ id: 'elsewhere', sha: head }] } }))!], [check]);
  assert.equal(loopBaseFailed(ci.document, state({}, { [`wait:base-failure:${ci.document.id}`]: { detail: `required check ${check} failed on ${head.slice(0, 12)}; rework waits for the base head` } })), null, 'still judging it');
  assert.equal(loopBaseFailed(ci.document, null), null, 'the loop state could not be read');
  const capped = instances.find(instance => instance.work === 'GY-1039')!;
  assert.equal(handRework(capped, { capEscalated: true }), null, 'a capped request the loop escalated, not withdrew, is the master\'s to answer');
  assert.equal(handRework(capped, { capEscalated: null }), null);
});

// Driven through the real decide route on a disposable Postgres: the risk lane applies the loop's
// grounded request, and a request recorded before the report's window opened is still read.
const repository = 'owner/rework-rounds';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `rounds-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
// The loop requests its rounds as the master's operator-agent identity, as `master autonomy` provisions it.
const masterAgent = { id: 'graphyard-master-rounds', token: `graphyard-master-rounds-${'m'.repeat(32)}`, capabilities: ['decision:rework'] };
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
  await ok(token(operator), 'POST', 'operator-agents', { id: masterAgent.id, displayName: masterAgent.id, capabilities: masterAgent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: masterAgent.token, reason: 'Onboarding provisions the master agent' });
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
const rework = (work: Work, input: Record<string, unknown>, credential = masterAgent.token) => ok(credential, 'POST', `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true, ...input }, reason: `${work.key}: required CI check test failed; the item returns to a worker` });
const reworksOf = (report: InterventionReport, key: string) => report.interventions.filter(entry => entry.kind === 'rework' && entry.work?.key === key);

test('integration:rework-review-rounds-report — the loop\'s grounded rework applied by the risk lane is no intervention in GET /api/interventions; a hand request applied the same way is one, as is a binding a person\'s credential sent; and a grounded request recorded long before the window opened still reads as grounded', async () => {
  const loop = await submitted('loop-round');
  const applied = await rework(loop, { binding: `${loop.candidate!.sha}:ci:test` });
  assert.equal(applied.state, 'applied', 'the medium lane applies a rework as it is requested');
  assert.equal(applied.approvedBy, 'graphyard-risk-lane');
  const hand = await submitted('hand-round');
  assert.equal((await rework(hand, {})).state, 'applied');
  // A binding is the loop's provenance only from the loop's identity: a person sending one is still stepping in.
  const forged = await submitted('forged-round');
  assert.equal((await rework(forged, { binding: `${forged.candidate!.sha}:ci:test` }, token(operator))).state, 'applied');

  const report = await ok(token(coordinator), 'GET', 'interventions?window=7') as InterventionReport;
  assert.deepEqual(reworksOf(report, loop.key), [], 'the loop\'s own review round is no signal');
  assert.deepEqual(reworksOf(report, hand.key).map(entry => entry.trigger), ['decision'], 'a coordinator\'s hand request is one');
  assert.deepEqual(reworksOf(report, forged.key).map(entry => entry.trigger), ['decision'], 'a binding from a person\'s credential is no loop provenance');

  // Past the review-round cap the loop's request is kept for its independent approver: no lane applies it (GY-1118).
  const capped = await submitted('capped-round');
  const requested = await rework(capped, { binding: `${capped.candidate!.sha}:capped:graphyard-reviewer[bot]` });
  assert.deepEqual([requested.state, requested.approvedBy ?? null], ['requested', null], 'the risk lane does not apply a capped round');

  // The boundary: request and approval a day and more before the window — beyond the reach — the rework inside it.
  const early = await submitted('early-round');
  await rework(early, { binding: `${early.candidate!.sha}:ci:test` });
  // The ledger is append-only; the fixture backdates two rows with its triggers off for this one session.
  const client = await store.pool.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await client.query(`UPDATE events SET created_at = created_at - interval '30 hours' WHERE work_id=$1 AND kind IN ('decision.requested','decision.approved')`, [early.id]);
  } finally { await client.query('RESET session_replication_role').catch(() => {}); client.release(); }
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { rows } = await readInterventionLedger(store.reportPool, { since });
  assert.ok(rows.some(row => row.workId === early.id && row.kind === 'decision.requested'), 'the decision behind an in-window rework is read by its id, however long before the window it was requested');
  assert.ok(typeof (interventions as Record<string, unknown>).interventionDecisionReachMs === 'number', 'the reach is a named bound');
  const folded = foldInterventions(rows, await store.list(), new Date().toISOString()).interventions;
  assert.deepEqual(folded.filter(entry => entry.kind === 'rework' && entry.work?.id === early.id), [], 'not read as a rework nobody requested');
});
