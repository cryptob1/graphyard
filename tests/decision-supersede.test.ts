import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { Refusal, type Principal } from '../src/model.js';
import * as approval from '../src/model/approval.js';
import { approvalStep, overtakenDecision, type RoutineDecision } from '../src/daemon/decisions.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { approverSessionName, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model/work.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1297: an approved decision whose application never recorded an outcome stood approved for
// good, and the control plane holds one standing decision of an action at a time, so it refused
// every later request of that action: GY-949's rework, approved for head 5d78667000f3, still stood
// when the item had moved to c7c93c895f68 and needed a rework of its own. A decision bound to a
// situation the item has moved past now settles superseded, recording both; one whose situation
// holds is applied, or settles failed naming why, within one loop cycle past the grace.

// Looked up at run time, so the base (which has no such bounds) fails here as test cases.
const bounds = approval as Partial<{ approvalApplyGraceMs: number; approvedDecisionBoundMs: number }>;
const approvalApplyGraceMs = bounds.approvalApplyGraceMs ?? 60_000, approvedDecisionBoundMs = bounds.approvedDecisionBoundMs ?? 0;

const headA = 'a'.repeat(40), headB = 'b'.repeat(40), base = 'd'.repeat(40);
const paths = ['src/server/routes/supersede.ts']; // a high-lane path: its rework waits for an approver
const observed = (sha: string, pr: number, branch: string): Observation => ({
  candidate: { sha, baseSha: base, pr, branch, author: 'worker' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }],
  reviews: [{ reviewer: 'reviewer', sha, state: 'CHANGES_REQUESTED' }],
  merged: false, mergeSha: null, mergeable: true, protected: true, files: paths, at: new Date().toISOString(),
  scopeFiles: paths.map(path => ({ path, status: 'modified' as const, sha: 'e'.repeat(40), additions: 1, deletions: 1, binary: false })),
});

let teardown: (() => Promise<void>) | undefined;
after(async () => { await teardown?.(); });
let fixture: ReturnType<typeof start> | undefined;
const plane = () => fixture ??= start();
async function start() {
  const repository = 'owner/supersede';
  const operator: Principal = { id: 'supersede-operator', role: 'admin', sessionKind: 'human' };
  const implementer: Principal = { id: 'supersede-implementer', role: 'worker', sessionKind: 'ai' };
  const credentials = [operator, implementer].map(principal => ({ ...principal, token: `supersede-${principal.id}-${'x'.repeat(32)}` }));
  const master = { id: 'supersede-master', token: `supersede-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'decision:rework', 'intent:unblock'] };
  const approver = { id: 'supersede-approver', token: `supersede-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1297;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('decision-supersede'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('supersede_test');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/supersede_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  const http = server(engine, credentials);
  teardown = async () => { http.close(); await store.close(); await database.stop(); };
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const send = async (token: string, path: string, body: unknown, key: string = randomUUID()) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (token: string, path: string, body: unknown) => {
    const result = await send(token, path, body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const decisions = async (key: string) => {
    const response = await fetch(`${url}/api/work/${key}/decisions`, { headers: { Authorization: `Bearer ${master.token}` } });
    return (await response.json() as { decisions: any[] }).decisions;
  };
  for (const agent of [master, approver]) await call(credentials[0].token, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Supersede fixture' });
  let pr = 1290;
  const submitted = async (title: string) => {
    let work = await call(master.token, 'work', { title, plannedFiles: paths, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Supersede fixture' }) as Work;
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
    const branch = `graphyard/${work.key.toLowerCase()}-${work.epoch}`;
    work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'supersede-host', path: `/tmp/supersede/${work.id}`, branch }, randomUUID());
    work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, randomUUID());
    return engine.observe(work.id, work.revision, observed(headA, pr, branch));
  };
  const rework = { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The reviewer requested changes on this head' };
  // GY-949's 8b62b40b: the approval commits, then its application is interrupted before any
  // outcome is recorded (a server fault on the engine call, as a killed request leaves it).
  const stranded = async (title: string) => {
    const work = await submitted(title);
    assert.equal(work.lane, 'high');
    const requested = await call(master.token, `work/${work.key}/decide`, rework);
    assert.equal(requested.state, 'requested', 'a high-lane rework waits for its approver');
    const execute = engine.execute;
    engine.execute = (async (...args: Parameters<typeof execute>) => {
      if (args[1] === 'rework') { engine.execute = execute; throw new Error('connection terminated while applying the rework'); }
      return execute.apply(engine, args);
    }) as typeof execute;
    const approving = await send(approver.token, `work/${work.key}/approve`, { decision: requested.id, reason: 'The rework is justified' });
    engine.execute = execute;
    assert.notEqual(approving.status, 200, 'the interrupted application answers no outcome');
    const [decision] = await decisions(work.key);
    assert.deepEqual([decision.state, decision.outcome, decision.situation], ['approved', null, { sha: headA, baseSha: base }], 'approved for head A and never applied');
    // The old refusal, unchanged before GY-1297: nothing could request the rework again.
    return { work, decision };
  };
  // The ledger is append-only, so time is moved instead: the control plane's clock runs `ms` ahead
  // for the duration of `during`, as when the loop finds the approval a cycle or more later.
  const later = async <T>(ms: number, during: () => Promise<T>): Promise<T> => {
    const transaction = store.transaction;
    store.transaction = ((fn, options) => transaction.call(store, (db, now) => fn(db, new Date(now.getTime() + ms)), options)) as typeof transaction;
    try { return await during(); } finally { store.transaction = transaction; }
  };
  const moveTo = async (work: Work, sha: string) => engine.observe(work.id, (await store.list()).find(item => item.id === work.id)!.revision, observed(sha, work.submission!.pr, work.workspaces.at(-1)!.branch));
  const get = async (path: string) => (await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${master.token}` } })).json();
  return { engine, store, master, send, call, get, decisions, stranded, later, moveTo, rework };
}

test('unit:stale-approved-decision-superseded — a rework approved for head A settles superseded once the item is at head B, and B’s rework request is accepted', { timeout: 120_000 }, async () => {
  const { store, master, send, decisions, stranded, moveTo, rework } = await plane();
  const { work, decision } = await stranded('superseded-by-head');
  const moved = await moveTo(work, headB);
  assert.equal(moved.candidate!.sha, headB, 'the item moved to head B');
  const request = await send(master.token, `work/${work.key}/decide`, rework);
  assert.equal(request.status, 200, `B’s rework request is accepted, not refused 'already approved': ${JSON.stringify(request.body)}`);
  assert.notEqual(request.body.id, decision.id, 'a new decision');
  assert.deepEqual([request.body.state, request.body.situation], ['requested', { sha: headB, baseSha: base }], 'judged for head B');
  const old = (await decisions(work.key)).find(entry => entry.id === decision.id)!;
  assert.equal(old.state, 'superseded');
  assert.deepEqual(old.superseded, { bound: { sha: headA, baseSha: base }, current: { sha: headB, baseSha: base } }, 'it records the head it was bound to and the current one');
  assert.match(old.outcome, new RegExp(`approved for head ${headA.slice(0, 12)} on base ${base.slice(0, 12)}, but ${work.key} is now at head ${headB.slice(0, 12)}`));
  assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, false, 'and head A’s rework was never applied to head B');
  const ledger = (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind='decision.superseded'", [work.id])).rows;
  assert.equal(ledger.length, 1, 'settled once, on the append-only ledger');
  // A loop whose history predates that settlement withdraws it, and is answered with the same record.
  const late = await send(master.token, `work/${work.key}/decide`, { action: 'withdraw', decision: decision.id, reason: 'The item moved past it' });
  assert.deepEqual([late.status, late.body.id, late.body.state], [200, decision.id, 'superseded']);

  // The loop's own path: it never adopts a standing approval the item moved past. Its withdrawal
  // settles the decision on the server, which answers with the superseded record.
  const second = await stranded('superseded-by-loop');
  await moveTo(second.work, headB);
  const current = (await store.list()).find(item => item.id === second.work.id)!;
  const routine: RoutineDecision = { action: 'rework', reason: 'changes requested', binding: headB } as RoutineDecision;
  const why = overtakenDecision(current, routine, (await decisions(second.work.key))[0], true);
  assert.match(why!, /is superseded so the current candidate's request is judged/);
  const withdrawn = await send(master.token, `work/${second.work.key}/decide`, { action: 'withdraw', decision: second.decision.id, reason: why });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.deepEqual([withdrawn.body.id, withdrawn.body.state], [second.decision.id, 'superseded']);
  assert.equal((await send(master.token, `work/${second.work.key}/decide`, rework)).body.state, 'requested', 'and the request for B follows');
});

test('unit:approved-decision-applied-or-named — an approved decision whose situation holds is applied, or names why it cannot be, within one loop cycle and inside the decision bound', { timeout: 120_000 }, async () => {
  const { engine, store, master, send, get, decisions, stranded, later, rework } = await plane();
  // Inside the grace the approval is still its own: a request is refused as before, and the loop
  // leaves it to its approver session.
  const { work, decision } = await stranded('applied-after-stall');
  const early = await send(master.token, `work/${work.key}/decide`, rework);
  assert.equal(early.status, 409, 'an approval inside its grace is not taken over');
  assert.equal((await decisions(work.key))[0].state, 'approved');
  const watch = approvalWatchSchema.parse({ work: work.key, action: 'rework', decision: decision.id, agentName: 'approver-1', requestedAt: decision.requestedAt, launchedAt: decision.requestedAt, launches: 1 });
  const working = { agents: [{ name: 'approver-1', pane_id: 'pane-1', agent_status: 'working' }], available: true };
  const approvedAt = Date.parse(decision.approvedAt);
  assert.equal(approvalStep(watch, decision, working, approvedAt + 1000).step, 'wait');
  // Past the grace, the loop's very next cycle sends it back to the server rather than waiting on
  // an approver, and never waits on it again: at every cycle from the grace to the bound the step
  // is the re-request that settles it.
  const loopCycleMs = 20_000;
  assert.ok(approvalApplyGraceMs + loopCycleMs <= approvedDecisionBoundMs, 'the bound covers the grace and the cycle that sees it');
  for (let at = approvalApplyGraceMs; at <= approvedDecisionBoundMs; at += loopCycleMs) {
    const step = approvalStep(watch, decision, working, approvedAt + at);
    assert.equal(step.step, 'rerequest', `${at} ms after its approval`);
    assert.match(step.detail, /no outcome was recorded within 60s; its application is resumed so it settles applied or failed/);
  }
  const current = (await store.list()).find(item => item.id === work.id)!;
  const why = overtakenDecision(current, { action: 'rework', reason: 'changes requested', binding: headA } as RoutineDecision, decision, true, approvedAt + approvalApplyGraceMs);
  assert.match(why!, /its application is resumed/);
  // The loop's withdrawal resumes the application: it is applied, under its own approval, and the
  // server says so rather than withdrawing anything.
  const settled = await later(approvalApplyGraceMs + 1000, () => send(master.token, `work/${work.key}/decide`, { action: 'withdraw', decision: decision.id, reason: why }));
  assert.equal(settled.status, 409);
  assert.match(settled.body.error ?? JSON.stringify(settled.body), new RegExp(`Decision ${decision.id} \\(rework\\) stood approved by supersede-approver with no outcome recorded; its application was resumed and it is applied now`));
  const applied = (await decisions(work.key)).find(entry => entry.id === decision.id)!;
  assert.deepEqual([applied.state, applied.approvedBy, applied.outcome], ['applied', 'supersede-approver', 'Rework authorized']);
  assert.equal((await store.list()).find(item => item.id === work.id)!.reworkRequested, true, 'the rework was applied');
  assert.equal(approvalStep(watch, applied, working, approvedAt + approvalApplyGraceMs).step, 'settled', 'and the loop settles its watch');

  // One that cannot apply settles failed, naming why, and no longer blocks a new request.
  const second = await stranded('failed-after-stall');
  const execute = engine.execute;
  engine.execute = (async (...args: Parameters<typeof execute>) => {
    if (args[1] === 'rework') { engine.execute = execute; throw new Refusal('Merged work requires a follow-up task', 409); }
    return execute.apply(engine, args);
  }) as typeof execute;
  const next = await later(approvalApplyGraceMs + 1000, () => send(master.token, `work/${second.work.key}/decide`, rework));
  engine.execute = execute;
  assert.equal(next.status, 200, `the request is accepted: ${JSON.stringify(next.body)}`);
  assert.notEqual(next.body.id, second.decision.id);
  const failed = (await decisions(second.work.key)).find(entry => entry.id === second.decision.id)!;
  assert.equal(failed.state, 'failed');
  assert.match(failed.outcome, /^Approved by supersede-approver at .+ but its application was never recorded; resuming it was refused: Merged work requires a follow-up task$/);
  // Nothing stands approved and unapplied on either item.
  for (const key of [work.key, second.work.key]) assert.deepEqual((await decisions(key)).filter(entry => entry.state === 'approved'), []);

  // A decision a master requested and put to an approver by hand: the loop's own request path
  // never sees it, so the loop's hand watch settles it. One real loop cycle past the grace closes
  // the approver session and sends the withdrawal; the server resumes it, and it is applied
  // within the bound. The next cycle retires the watch.
  const third = await stranded('hand-watched-stall');
  const pane = { name: approverSessionName(third.work, third.decision.id), pane_id: 'pane-hand', agent: 'claude', agent_status: 'idle' }, closed: string[] = [];
  let loopNow = Date.parse(third.decision.approvedAt);
  const config = { hostId: 'supersede-host', autoMerge: false, mergeMethod: 'merge', workers: [], reviewers: [], producers: [], repository: 'owner/supersede', baseBranch: 'main',
    url: 'https://graphyard.example', credentialFile: '/dev/null', githubAppId: 1234, run: { intervalSeconds: 20 } } as unknown as MasterConfig;
  const loop: DaemonEffects = {
    agents: () => closed.includes(pane.pane_id) ? [] : [pane], credentials: async () => ({}),
    snapshot: async () => ({ work: (await store.list()).filter(item => item.id === third.work.id), now: new Date(loopNow).toISOString() }),
    closeSession: closing => { closed.push(closing); }, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    approverLaunches: async () => [], approver: async () => { throw new Error('no approver is launched here'); },
    decisions: work => get(`work/${encodeURIComponent(work.id)}/decisions`),
    withdraw: async (work, decision, reason) => { const result = await send(master.token, `work/${work.id}/decide`, { action: 'withdraw', decision, reason }); if (result.status !== 200) throw new Error(result.body.error); return result.body; },
  };
  const state = emptyDaemonState(config), stalledAt = Date.parse(third.decision.approvedAt) + approvalApplyGraceMs + 1000;
  loopNow = stalledAt;
  await later(approvalApplyGraceMs + 1000, () => runCycle(config, state, loop, () => loopNow));
  assert.deepEqual(closed, [pane.pane_id], 'the approver session of the stalled approval is put down');
  const resumed = (await decisions(third.work.key)).find(entry => entry.id === third.decision.id)!;
  assert.deepEqual([resumed.state, resumed.approvedBy], ['applied', 'supersede-approver'], 'one loop cycle applied it under its own approval');
  assert.ok(stalledAt - Date.parse(third.decision.approvedAt) <= approvedDecisionBoundMs, 'the cycle that applied it ran inside the decision bound');
  loopNow = stalledAt + 20_000;
  await later(approvalApplyGraceMs + 21_000, () => runCycle(config, state, loop, () => loopNow));
  assert.equal(Object.values(state.approvals).some(watch => watch.decision === third.decision.id), false, 'and the next cycle retires its watch');
});
