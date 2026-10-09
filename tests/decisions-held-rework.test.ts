import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import type { Observation, Work } from '../src/model/work.js';
import { requestDecision } from '../src/server/decisions.js';
import { heldRework } from '../src/server/held-rework.js';
import { foldDecisions, judgedSame, standingRefusal } from '../src/model/approval.js';
import type { Services } from '../src/server/routes.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { nextAction } from '../src/model/next-action.js';
import { humanNeeded } from '../src/model/concerns.js';
import { terminalDecisions } from '../src/cli/decision-report.js';
import { refusedOnOtherGrounds } from '../src/daemon/rework-grounds.js';

// GY-1579, observed on GY-1522 at 2026-10-08T11:38:06Z: the master requested rework bd40dc45 by hand,
// input { previousWorkerStopped: true } with no binding, on an item that already held applied rework
// 8da1e201 (reworkRequested true since 10:14:41Z; the real hold was an unfinished dependency). An
// approver session was launched only to refuse it: "The request misreads the stall".

const clock = Date.parse('2030-01-01T12:00:00Z');
const shaA = 'a'.repeat(40), shaB = 'c'.repeat(40), base = 'b'.repeat(40);

function item(sha: string, reworkRequested: boolean): Work {
  const candidate = { sha, baseSha: base, pr: 42, branch: 'graphyard/gy-1522-1', author: 'worker' };
  return {
    id: '00000000-0000-4000-8000-000000001522', key: 'GY-1522', title: 'Held rework', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5, policyRevision: 1, createdAt: new Date(clock - 3_600_000).toISOString(), updatedAt: new Date(clock).toISOString(),
    stageEnteredAt: new Date(clock - 600_000).toISOString(), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate, reworkRequested, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [],
  } as unknown as Work;
}

/** The decide route over an in-memory ledger, as tests/decision-refusal-scope.test.ts drives it. */
function ledger(work: { current: Work }) {
  const events: { actor: string; kind: string; payload: any; created_at: string }[] = [];
  const receipts = new Map<string, { fingerprint: string; result: unknown }>();
  const db = {
    query: async (sql: string, params: any[] = []) => {
      if (sql.startsWith('SELECT * FROM receipts')) { const row = receipts.get(`${params[0]}:${params[1]}`); return { rows: row ? [row] : [] }; }
      if (sql.startsWith('INSERT INTO receipts')) { receipts.set(`${params[0]}:${params[1]}`, { fingerprint: params[2], result: JSON.parse(params[3]) }); return { rows: [] }; }
      if (sql.startsWith('SELECT document FROM work_items')) return { rows: [{ document: work.current }] };
      if (sql.startsWith('SELECT actor, kind, payload, created_at FROM events')) return { rows: events.filter(event => event.kind.startsWith('decision.')) };
      if (sql.startsWith('SELECT count(*)::int AS count FROM events')) return { rows: [{ count: 0 }] };
      if (sql.startsWith('INSERT INTO events')) { events.push({ actor: params[1], kind: params[2], payload: JSON.parse(params[3]), created_at: new Date(clock + events.length).toISOString() }); return { rows: [] }; }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const services = { repository: 'owner/project', principals: [], engine: { store: { transaction: (body: (db: unknown, now: Date) => unknown) => body(db, new Date(clock)) } } } as unknown as Services;
  return { events, services };
}
const operator: Principal = { id: 'graphyard-master-operator', role: 'admin' } as Principal;

test('unit:decide-route-records-rework-situation — a decide-route rework records the candidate head and base beside its input, and the applied rework it would re-authorize when one stands', async () => {
  const work = { current: item(shaA, false) };
  const { events, services } = ledger(work);
  const first = await requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The reviewer requested changes on head A' }, 'key-1');
  assert.deepEqual(events.at(-1)!.payload.situation, { sha: shaA, baseSha: base }, 'the situation of a request with no rework standing');
  assert.deepEqual(first.situation, { sha: shaA, baseSha: base });
  // The approver approves it and it applies: the item holds the rework.
  events.push({ actor: 'graphyard-approver', kind: 'decision.approved', payload: { id: first.id, reason: 'Stands' }, created_at: new Date(clock + 100).toISOString() });
  events.push({ actor: 'graphyard-approver', kind: 'decision.applied', payload: { id: first.id, outcome: 'Rework authorized' }, created_at: new Date(clock + 101).toISOString() });
  // A base refresh carries the head to a new candidate while the rework still holds: new grounds, so a request is recorded, naming the rework it re-authorizes.
  work.current = item(shaB, true);
  assert.equal(heldRework(work.current, [{ ...first, state: 'applied' }])?.id, first.id);
  const second = await requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true, binding: `${shaB}:conflict` }, reason: 'The refreshed head conflicts with its base' }, 'key-2');
  const recorded = events.at(-1)!;
  assert.equal(recorded.kind, 'decision.requested');
  assert.equal(recorded.payload.id, second.id);
  assert.deepEqual(recorded.payload.input, { previousWorkerStopped: true, binding: `${shaB}:conflict` });
  assert.deepEqual(recorded.payload.situation, { sha: shaB, baseSha: base, reauthorizes: first.id }, 'the applied rework it would re-authorize is recorded beside the situation');
  // The decision read back keeps it: readDecisions folds the reauthorization identity with the head and base.
  assert.deepEqual(second.situation, { sha: shaB, baseSha: base, reauthorizes: first.id }, 'the route returns the decision as read back from the ledger');
  const [, read] = foldDecisions(work.current.id, events.map(event => ({ kind: event.kind, actor: event.actor, at: event.created_at, payload: event.payload })));
  assert.deepEqual(read!.situation, { sha: shaB, baseSha: base, reauthorizes: first.id });
  // Refusals and duplicates key on it: refused, the request stands against one re-authorizing the same rework, never against one re-authorizing another or none.
  const refused = { ...read!, state: 'refused' as const, refusal: { approver: 'graphyard-approver', reason: 'Not on these grounds', at: new Date(clock).toISOString() } };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  assert.equal(standingRefusal([refused], 'rework', refused.input, 'Retry', same, [], { sha: shaB, baseSha: base, reauthorizes: first.id })?.decision, second.id);
  assert.equal(standingRefusal([refused], 'rework', refused.input, 'Retry', same, [], { sha: shaB, baseSha: base, reauthorizes: 'another-applied-rework' }), null);
  assert.equal(standingRefusal([refused], 'rework', refused.input, 'Retry', same, [], { sha: shaB, baseSha: base }), null);
  assert.ok(judgedSame('rework', read!, { sha: shaB, baseSha: base, reauthorizes: first.id }) && !judgedSame('rework', read!, { sha: shaB, baseSha: base }));
  // Through the route: the same request again is refused naming that refusal, by the recorded field.
  events.push({ actor: 'graphyard-approver', kind: 'decision.declined', payload: { id: second.id, reason: 'Not on these grounds' }, created_at: new Date(clock + 200).toISOString() });
  await assert.rejects(requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true, binding: `${shaB}:conflict` }, reason: 'The refreshed head conflicts with its base' }, 'key-3'),
    (error: any) => error.status === 409 && error.details?.standingRefusal?.decision === second.id);
  // On the held head itself: a bare request is refused naming the held rework, and so is one naming a binding the held rework did
  // not carry while nothing on the record is newer (the binding is the requester's free text, never grounds on its own).
  work.current = item(shaA, true);
  await assert.rejects(requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The previous worker stopped' }, 'key-4'),
    (error: any) => error.status === 409 && error.details?.heldRework?.decision === first.id);
  for (const [index, binding] of [`${shaA}:verdict:someone-else`, `overlong-cap:${work.current.id}:2030-01-01T12:00:00Z`].entries())
    await assert.rejects(requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true, binding }, reason: 'Another ground, same head' }, `key-4-${index}`),
      (error: any) => error.status === 409 && error.details?.heldRework?.decision === first.id, `${binding} on the held head with no attempt since is refused`);
  // An attempt claimed before the rework was decided is no newer ground either; one claimed after it is (the retry cap's, after
  // attempts that never submitted), and the request is recorded, naming the rework it re-authorizes.
  work.current = { ...item(shaA, true), lastAssignment: { owner: 'worker', epoch: 1, claimedAt: new Date(clock - 60_000).toISOString() } };
  await assert.rejects(requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true, binding: `overlong-cap:${work.current.id}:2030-01-01T12:00:00Z` }, reason: 'Another ground, same head' }, 'key-4-stale'),
    (error: any) => error.status === 409 && error.details?.heldRework?.decision === first.id);
  work.current = { ...item(shaA, true), epoch: 4, lastAssignment: { owner: 'worker', epoch: 4, claimedAt: new Date(clock + 500).toISOString() } };
  await assert.rejects(requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The previous worker stopped' }, 'key-4-bare'),
    (error: any) => error.status === 409 && error.details?.heldRework?.decision === first.id, 'a bare request names no newer grounds even after attempts');
  const capped = await requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true, binding: `overlong-cap:${work.current.id}:2030-01-01T12:00:00Z` }, reason: 'held: 3 attempts in a row ended without submitting' }, 'key-5');
  assert.equal(capped.state, 'requested');
  assert.deepEqual(capped.situation, { sha: shaA, baseSha: base, reauthorizes: first.id });
  // Once a worker submitted, the rework no longer holds, and nothing is re-authorized.
  assert.equal(heldRework(item(shaB, false), [{ ...first, state: 'applied' }]), null);
  // A request on the fresh submission is not held off by that re-authorization, still awaiting its approver: it settles stale, and the request is recorded.
  work.current = item(shaB, false);
  const fresh = await requestDecision(services, operator, work.current.id, { action: 'rework', input: { previousWorkerStopped: true, binding: `${shaB}:verdict:graphyard-reviewer[bot]` }, reason: 'The fresh submission has a new finding' }, 'key-6');
  assert.equal(fresh.state, 'requested');
  assert.deepEqual(fresh.situation, { sha: shaB, baseSha: base });
  const stale = events.find(event => event.kind === 'decision.stale' && event.payload.id === capped.id);
  assert.match(stale?.payload.reason ?? '', new RegExp(`re-authorize applied rework ${first.id}, but GY-1522 no longer holds it \\(a worker has submitted since\\)`));
});

let teardown: (() => Promise<void>) | null = null;
after(async () => { await teardown?.(); });

test('integration:held-rework-request-refused-mechanically — a rework request on an item that already holds an applied rework for its head is refused naming that decision, and nothing is put to an approver', { timeout: 120_000 }, async () => {
  const repository = 'owner/held-rework';
  const admin: Principal = { id: 'held-operator', role: 'admin', sessionKind: 'human' };
  const implementer: Principal = { id: 'held-implementer', role: 'worker', sessionKind: 'ai' };
  const credentials = [admin, implementer].map(principal => ({ ...principal, token: `held-${principal.id}-${'x'.repeat(32)}` }));
  const master = { id: 'held-master', token: `held-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'decision:rework'] };
  const approver = { id: 'held-approver', token: `held-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1579;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('held-rework'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('held_rework_test');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/held_rework_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  const http = server(engine, credentials);
  teardown = async () => { http.close(); await store.close(); await database.stop(); };
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const send = async (token: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const decisions = async (key: string) => (await (await fetch(`${url}/api/work/${key}/decisions`, { headers: { Authorization: `Bearer ${master.token}` } })).json() as { decisions: any[] }).decisions;
  for (const agent of [master, approver]) {
    const provisioned = await send(credentials[0].token, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  }

  // A submitted high-lane item, observed with a change request on its head.
  const paths = ['src/server/routes/held-rework.ts'];
  const created = await send(master.token, 'work', { title: 'Held rework', plannedFiles: paths, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Held rework fixture' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  let work = await engine.execute(admin, 'ready', created.body.id, {}, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'held-host', path: `/tmp/held/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: 1579 }, randomUUID());
  const candidate = { sha: shaA, baseSha: base, pr: 1579, branch: work.workspaces.at(-1)!.branch, author: 'worker' };
  work = await engine.observe(work.id, work.revision, { candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: shaA, state: 'CHANGES_REQUESTED', submittedAt: new Date().toISOString() }],
    merged: false, mergeSha: null, mergeable: true, protected: true, files: paths, at: new Date().toISOString(),
    scopeFiles: paths.map(path => ({ path, status: 'modified' as const, sha: 'e'.repeat(40), additions: 1, deletions: 1, binary: false })) } as unknown as Observation);
  assert.equal(work.lane, 'high');

  // The rework is requested, approved by the independent approver, and applied: the item holds it.
  const requested = await send(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'graphyard-reviewer[bot] requested changes on the head' });
  assert.equal(requested.body.state, 'requested', JSON.stringify(requested.body));
  const approved = await send(approver.token, `work/${work.key}/approve`, { decision: requested.body.id, reason: 'The verdict stands on this head' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const holding = (await store.list()).find(entry => entry.id === work.id)! as Work;
  assert.equal(holding.reworkRequested, true, 'the applied rework holds the item');

  // GY-1522's hand request: same head, no binding. Refused at creation, naming the applied decision.
  const again = await send(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The previous worker stopped; send it back to a worker' });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.ok(String(again.body.error).includes(`decision ${requested.body.id} was applied for head ${shaA.slice(0, 12)}`), again.body.error);
  assert.match(again.body.error, /a second rework authorizes nothing/);
  assert.deepEqual(again.body.heldRework, { decision: requested.body.id }, 'the applied decision travels as a field beside the message');

  // Nothing was recorded, so no request stands for the loop to launch an approver on.
  const ledger = await decisions(work.key);
  assert.deepEqual(ledger.map(entry => [entry.id, entry.state]), [[requested.body.id, 'applied']]);
  assert.equal(ledger.filter(entry => entry.state === 'requested').length, 0, 'no decision awaits an approver');

  // A base refresh moves the head while the rework holds: a request on the new head is recorded, naming the rework it re-authorizes.
  const observe = async (sha: string) => {
    const current = (await store.list()).find(entry => entry.id === work.id)! as Work;
    return engine.observe(work.id, current.revision, { candidate: { ...candidate, sha }, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha, state: 'CHANGES_REQUESTED', submittedAt: new Date().toISOString() }],
      merged: false, mergeSha: null, mergeable: true, protected: true, files: paths, at: new Date().toISOString(),
      scopeFiles: paths.map(path => ({ path, status: 'modified' as const, sha: 'e'.repeat(40), additions: 1, deletions: 1, binary: false })) } as unknown as Observation);
  };
  await observe(shaB);
  const reauthorizing = await send(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true, binding: `${shaB}:verdict:graphyard-reviewer[bot]` }, reason: 'The verdict stands on the refreshed head' });
  assert.equal(reauthorizing.body.state, 'requested', JSON.stringify(reauthorizing.body));
  assert.equal(reauthorizing.body.situation.reauthorizes, requested.body.id);
  // Before its approver answers, a worker takes the held rework and submits: the hold it was asked to re-authorize clears, on the same head.
  let resumed = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  resumed = await engine.execute(implementer, 'workspace', resumed.id, { epoch: resumed.epoch, host: 'held-host', path: `/tmp/held/${resumed.id}-${resumed.epoch}`, branch: candidate.branch }, randomUUID());
  resumed = await engine.execute(implementer, 'submit', resumed.id, { epoch: resumed.epoch, pr: 1579 }, randomUUID());
  assert.equal(resumed.reworkRequested, false);
  await observe(shaB);
  // Approving it now would send the fresh submission back for a rework nobody judged: it is refused and settled stale, never applied.
  const late = await send(approver.token, `work/${work.key}/approve`, { decision: reauthorizing.body.id, reason: 'The verdict stands' });
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.match(late.body.error, new RegExp(`re-authorize applied rework ${requested.body.id}, but ${work.key} no longer holds it \\(a worker has submitted since\\)`));
  const settled = (await decisions(work.key)).find(entry => entry.id === reauthorizing.body.id);
  assert.notEqual(settled.state, 'requested', 'settled, so it blocks no later request');
  assert.notEqual(settled.state, 'applied');
  assert.equal(((await store.list()).find(entry => entry.id === work.id)! as Work).reworkRequested, false, 'the fresh submission is not sent back');
});

// GY-1606, observed on GY-1598 PR #1070 head 004570f5858c on 2026-10-09: past the review-round cap the loop requested capped
// review rework a5116d00 (21:03:01Z). The head's required check `test` had failed, so at 21:03:59Z the loop's failed-check rework
// adopted a5116d00, still requested, under its own binding. The approver refused a5116d00 as non-blocking (21:04:56Z), that
// refusal settled the failed-check binding's watch, and no failed-check rework was requested until the master answered the
// refusal by hand 24 minutes later; master status meanwhile named the refused review rework as the item's next action.
const reviewer = 'graphyard-reviewer[bot]';
const cappedBinding = `${shaA}:capped:${reviewer}`, ciBinding = `${shaA}:ci:test`;
const cappedId = '0a5116d0-013f-4e58-8e9e-a97481d8e202';
function failingHead(at: number, test = 'failure'): Work {
  const work = item(shaA, false);
  const observation = { candidate: work.candidate, checks: [{ name: 'test', result: test, appId: 15368, id: 7, attempt: 2 }, { name: 'typecheck', result: 'success', appId: 15368, id: 8 }],
    reviews: [{ reviewer, sha: shaA, state: 'CHANGES_REQUESTED', submittedAt: new Date(clock - 600_000).toISOString(), id: 5475323343 }], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/loop.ts'], scopeFiles: [], at: new Date(at).toISOString(), prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true, conversations: { required: true, unresolved: [] } };
  return { ...work, stage: 'review', policy: { checks: ['test', 'typecheck'], review: true }, pipeline: { reworkRounds: 3 }, observation,
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: [`Outstanding change requests from ${reviewer}`] },
      test === 'success' ? { name: 'test', passed: true, reasons: [] } : { name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate'], ciAppIds: [15368] }] } as unknown as Work;
}
const cappedRework = (state: 'requested' | 'refused') => ({ id: cappedId, action: 'rework', state, input: { previousWorkerStopped: true, binding: cappedBinding }, requestedBy: 'graphyard-master-operator',
  requestedAt: new Date(clock - 120_000).toISOString(), reason: '[Capped review under policy revision 1.] a blocking finding', approvedBy: null,
  refusal: state === 'refused' ? { approver: 'graphyard-approver-graphyard', reason: 'Non-blocking past the round cap', at: new Date(clock - 60_000).toISOString() } : null });
function loop(history: { current: any[] }) {
  const decided: { action: string; input: any; reason: string }[] = [], approvers: string[] = [];
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(clock).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    // The high lane's risk lane applies a failed-check rework as it is requested, as it does any.
    decide: async (_work: Work, action: string, reason: string, input: any) => { decided.push({ action, input, reason }); const id = randomUUID(); history.current.push({ id, action, state: 'applied', input, approvedBy: 'graphyard-risk-lane', reason }); return { id, state: 'applied', approvedBy: 'graphyard-risk-lane' }; },
    decisions: async () => ({ decisions: structuredClone(history.current) }),
    approver: async (work: Work, decision: string) => { approvers.push(decision); return { agentName: `gy-approver-${work.key.toLowerCase()}-${decision.slice(0, 8)}`, pane: 'pane-1' }; },
  } as unknown as DaemonEffects;
  return { decided, approvers, effects };
}
const loopConfig = () => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] }) as MasterConfig;

test('unit:ci-rework-after-review-refusal — a refused capped review rework never holds back the failed-check rework the same head owes', async () => {
  const config = loopConfig();
  // The order GY-1598 met: the failed check is first seen while the capped review rework stands requested, so the CI binding adopts it.
  const history = { current: [cappedRework('requested')] as any[] };
  const { decided, approvers, effects } = loop(history);
  const state = emptyDaemonState(config);
  let work = failingHead(clock);
  await runCycle(config, state, { ...effects, snapshot: async () => ({ work: [work], now: new Date(clock).toISOString() }) }, () => clock);
  assert.equal(decided.length, 0, 'the standing capped request is adopted, not requested twice');
  assert.equal(Object.entries(state.approvals).find(([, watch]) => watch.decision === cappedId)?.[0].includes(':ci:test:'), true, 'adopted under the failed-check binding');
  // Its approver refuses it as non-blocking; a fresh observation still shows the failed check on the head.
  history.current = [cappedRework('refused')];
  const later = clock + 90_000;
  work = failingHead(later);
  await runCycle(config, state, { ...effects, snapshot: async () => ({ work: [work], now: new Date(later).toISOString() }) }, () => later);
  assert.deepEqual(decided.map(entry => entry.input.binding), [ciBinding], 'the failed-check rework is requested in the cycle the fresh observation reaches');
  assert.match(decided[0].reason, /required CI check test failed on candidate aaaaaaaaaaaa/);
  assert.doesNotMatch(decided[0].reason, new RegExp(cappedId), 'it rests on its own grounds, so it cites no refusal');
  assert.equal(state.actions[`escalation:decision-refused:${cappedId}`], undefined, 'nobody is asked to answer the refusal by hand');
  assert.match(state.actions[`approver:${cappedId}:refused`]!.detail, /judged capped:graphyard-reviewer\[bot\], not ci:test/);
  // Applied by the risk lane: settled, and nothing more is asked of the head, least of all the refused review rework.
  await runCycle(config, state, { ...effects, snapshot: async () => ({ work: [failingHead(later + 30_000)], now: new Date(later + 30_000).toISOString() }) }, () => later + 30_000);
  assert.deepEqual(decided.map(entry => entry.input.binding), [ciBinding]);
  assert.ok(!decided.some(entry => entry.input.binding === cappedBinding), 'the refused review-grounds request is never re-requested on that head');
  assert.equal(approvers.filter(entry => entry !== cappedId).length, 0, 'no approver is launched for the failed-check rework');

  // The other order (GY-1600's): the refusal is already recorded when the failed check is seen; the rework is requested at once.
  const refusedFirst = { current: [cappedRework('refused')] as any[] };
  const fresh = loop(refusedFirst), freshState = emptyDaemonState(config);
  await runCycle(config, freshState, { ...fresh.effects, snapshot: async () => ({ work: [failingHead(clock)], now: new Date(clock).toISOString() }) }, () => clock);
  assert.deepEqual(fresh.decided.map(entry => entry.input.binding), [ciBinding]);

  // A refusal judged only the checks it named: a refused `ci:test` rework does not judge `ci:lint` or `ci:lint,test`.
  assert.equal(refusedOnOtherGrounds(ciBinding, `${shaA}:ci:lint`), true);
  assert.equal(refusedOnOtherGrounds(ciBinding, `${shaA}:ci:lint,test`), true);
  assert.equal(refusedOnOtherGrounds(`${shaA}:ci:lint,test`, ciBinding), false, 'a check it judged is not other grounds');
  assert.equal(refusedOnOtherGrounds(ciBinding, ciBinding), false);
  assert.equal(refusedOnOtherGrounds(`${shaA}:threads:1,2`, `${shaA}:threads:3`), false, 'a moved thread set is the same grounds');

  // The failed check clears while the adopted capped request stands; its approver then refuses it. The watch comes back to the
  // capped binding and the refusal is answered there: no second capped rework is requested on the head.
  const cleared = { current: [cappedRework('requested')] as any[] };
  const back = loop(cleared), backState = emptyDaemonState(config);
  await runCycle(config, backState, { ...back.effects, snapshot: async () => ({ work: [failingHead(clock)], now: new Date(clock).toISOString() }) }, () => clock);
  assert.ok(Object.keys(backState.approvals).some(key => key.includes(':ci:test:')), 'adopted under the failed-check binding');
  cleared.current = [cappedRework('refused')];
  for (const at of [later, later + 30_000]) await runCycle(config, backState, { ...back.effects, snapshot: async () => ({ work: [failingHead(at, 'success')], now: new Date(at).toISOString() }) }, () => at);
  assert.deepEqual(back.decided, [], 'the refused capped rework is not requested again');
  assert.ok(Object.entries(backState.approvals).some(([key, watch]) => key.includes(':capped:') && watch.decision === cappedId && watch.settledAt), 'its watch settled under the capped binding');
  assert.equal(backState.actions[`escalation:decision-refused:${cappedId}`], undefined);
});

test('unit:ci-rework-after-review-refusal — master status names the failed-check rework, never the refused review rework, and asks nobody to answer the refusal by hand', async () => {
  const work = failingHead(clock), now = new Date(clock);
  const action = nextAction(work, [work], now)!;
  assert.equal(action.kind, 'request-rework');
  assert.equal(action.gate, 'test', 'the failed required check is the rework named, not the review change request');
  assert.match(action.reason, /Required CI check test has not passed/);
  assert.match(humanNeeded(action)!.resolve, /^the loop requests this rework for the failed required check itself/);
  // A review change request alone is still named as before.
  const reviewOnly = { ...work, gates: work.gates.filter(gate => gate.name !== 'test') } as Work;
  assert.equal(nextAction(reviewOnly, [reviewOnly], now)?.gate, 'review');
  // The refused capped rework raises no "answer the refusal" attention; another refused rework still does.
  const attention = async (decisions: any[]) => (await terminalDecisions(async () => ({ decisions }), [{ id: work.id, key: work.key, stage: 'review' }], { approvals: [], runtime: { available: true, agents: [] }, now: clock })).attentionItems;
  assert.deepEqual(await attention([cappedRework('refused')]), []);
  const other = { ...cappedRework('refused'), input: { previousWorkerStopped: true, binding: `${shaA}:verdict:${reviewer}` } };
  assert.match((await attention([other]))[0]?.text ?? '', /Answer the refusal/);
});
