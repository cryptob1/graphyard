import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { Refusal, type Principal } from '../src/model.js';
import type { Observation, Work } from '../src/model/work.js';
import { actionableSubjects, approvalStep, approvalWatchSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { maxApproverLaunches, recordWatchEnded, routineDecision } from '../src/daemon/decisions.js';
import { decisionKey } from '../src/daemon/reconcile.js';
import { Launcher } from '../src/daemon/cycle.js';
import { assertDispatchable, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { approvalApplyGraceMs } from '../src/model/approval.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1300: approval and application are two steps, and an interruption between them stranded a
// decision at 'approved' with no outcome. Only the risk lane's own approvals were ever resumed
// (GY-1110); GY-949's session-approved rework 8b62b40b stood 2.5 days approved and unapplied while
// the loop kept waiting for an approver session to judge what it had already judged, and every
// re-request was refused 'already approved; wait for it'. The server now resumes any approved,
// unapplied decision, the loop's decision cycle applies one through it, and the silence measure
// names it for what it is.

const minute = 60_000;
const decisionId = '8b62b40b-0f3d-4cd6-b3c0-3920340a512b';
const session = 'graphyard-approver-gy-949-8b62b4';

// ---- AC-4: the loop's step for an approved decision ---------------------------------------------
test('unit:approval-step-approved-not-awaiting — an approved decision is applied, never waited on, relaunched or exhausted', () => {
  const at = Date.parse('2026-10-03T16:40:00Z'), approvedAt = '2026-10-03T16:47:22.985Z';
  const watch = approvalWatchSchema.parse({ work: 'GY-949', action: 'rework', decision: decisionId, agentName: session, requestedAt: new Date(at).toISOString(), launchedAt: new Date(at).toISOString(), launches: 1 });
  const approved = { state: 'approved', approvedBy: 'graphyard-approver-graphyard', approvedAt };
  const gone = { agents: [] as HerdrAgent[], available: true };
  const later = Date.parse(approvedAt) + 2.5 * 24 * 60 * minute;
  const step = approvalStep(watch, approved, gone, later);
  assert.equal(step.step, 'apply', 'the session is gone: the loop applies what was approved');
  assert.match(step.detail, new RegExp(`approved but unapplied since ${approvedAt}`));
  assert.match(step.detail, /approved by graphyard-approver-graphyard/);
  assert.doesNotMatch(step.detail, /waiting for approver|to judge it/);
  // Whatever the launch count: a spent watch is not escalated as unjudged, and a fresh one is not relaunched.
  assert.equal(approvalStep({ ...watch, launches: maxApproverLaunches }, approved, gone, later).step, 'apply');
  assert.equal(approvalStep({ ...watch, launches: maxApproverLaunches, exhaustedAt: approvedAt }, approved, gone, later).step, 'apply');
  assert.equal(approvalStep({ ...watch, agentName: null, launches: 0 }, approved, gone, later).step, 'apply', 'never launched: still applied, no session is launched for it');
  // An idle or ended session, or Herdr unreadable: the decision is judged, so none of that is waited on.
  const idle = { agents: [{ name: session, pane_id: 'p', agent_status: 'idle' }], available: true };
  assert.equal(approvalStep(watch, approved, idle, later).step, 'apply');
  assert.equal(approvalStep(watch, approved, { agents: [], available: false }, later).step, 'apply');
  // Only the approver's own call, still in flight within a minute of its approval, is left to finish. Past the minute a session
  // still working is not waited on either: it is put down and the control plane settles the decision (GY-1297), never relaunched.
  const working = { agents: [{ name: session, pane_id: 'p', agent_status: 'working' }], available: true };
  assert.equal(approvalStep(watch, approved, working, Date.parse(approvedAt) + 10_000).step, 'wait');
  const stalled = approvalStep(watch, { ...approved, id: decisionId, action: 'rework' }, working, Date.parse(approvedAt) + approvalApplyGraceMs + 1);
  assert.equal(stalled.step, 'rerequest', 'past the minute the working session is not waited on');
  assert.match(stalled.detail, /its application is resumed so it settles applied or failed/);
  // The requested and settled states are unchanged.
  assert.notEqual(approvalStep(watch, { state: 'requested' }, gone, later).step, 'apply');
  assert.equal(approvalStep(watch, { state: 'applied' }, gone, later).step, 'settled');
});

// ---- Fixtures shared by the loop tests ----------------------------------------------------------
const config = { hostId: 'machine-a', autoMerge: true, mergeMethod: 'merge', workers: [], reviewers: [], producers: [], repository: 'owner/decisions', baseBranch: 'main',
  url: 'https://graphyard.example', credentialFile: '/dev/null', cliPath: 'graphyard', githubAppId: 1234, run: { intervalSeconds: 20 } } as unknown as MasterConfig;

/** A submitted item whose reviewer requested changes on its head: the loop owes it a rework. */
function verdictItem(key: string, now: number): Work {
  const head = 'e'.repeat(40), base = 'f'.repeat(40), iso = (offset: number) => new Date(now + offset).toISOString();
  const candidate = { sha: head, baseSha: base, pr: 9, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  return {
    id: `work-${key}`, key, title: 'Stranded approval', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:approved-decision-applies-on-cycle'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'test', revision: 7, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(0), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 9 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { candidate, checks: [], reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'CHANGES_REQUESTED', submittedAt: iso(-60_000) }],
      protected: true, mergeable: true, merged: false, prState: 'open', draft: false, at: iso(-10_000), baseTip: base, baseTree: 'tree-0', files: [], scopeFiles: [] },
  } as unknown as Work;
}

// ---- AC-4: the silence measure names the true state ---------------------------------------------
test('unit:loop-silence-decision-state — an approved, unapplied decision is named as such once its session ended, never as waiting for its approver', () => {
  const now = Date.parse('2026-10-05T12:23:51.627Z'), approvedAt = '2026-10-03T16:47:22.985Z';
  const item = verdictItem('GY-949', now);
  const decision = routineDecision(item, config, now)!;
  assert.equal(decision.action, 'rework');
  const watch = approvalWatchSchema.parse({ work: item.key, action: 'rework', decision: decisionId, agentName: session, requestedAt: approvedAt, launchedAt: approvedAt, launches: 1 });
  const subject = (approvals: Record<string, typeof watch>) => actionableSubjects(config, [item], now, { approvals }).find(entry => entry.kind === 'decision' && entry.work === item.key)!;
  // While the session is the approver's to end, the wait is named as one.
  assert.match(subject({ [decisionKey(item, decision)]: watch }).detail, /is requested and waiting for approver session/);
  // The loop found it approved and its session ended: the apply step keeps that on the watch.
  const step = approvalStep(watch, { state: 'approved', approvedBy: 'graphyard-approver-graphyard', approvedAt }, { agents: [], available: true }, now);
  assert.equal(step.step, 'apply');
  recordWatchEnded(watch, step.detail);
  const named = subject({ [decisionKey(item, decision)]: watch }).detail;
  assert.match(named, new RegExp(`GY-949's rework decision ${decisionId} is approved but unapplied since ${approvedAt}`));
  assert.doesNotMatch(named, /requested and waiting for approver session|to judge it/);
  // A spent watch says the same: its true state, not an unjudged decision.
  assert.match(subject({ [decisionKey(item, decision)]: { ...watch, exhaustedAt: approvedAt } }).detail, /approved but unapplied since/);
  // A re-request's new decision carries the old entry, which names the old id, never its own.
  const fresh = { ...watch, decision: randomUUID() };
  assert.match(subject({ [decisionKey(item, decision)]: fresh }).detail, /is requested and waiting for approver session/);
});

// ---- The control plane --------------------------------------------------------------------------
let fixture: ReturnType<typeof start> | undefined;
let teardown: (() => Promise<void>) | undefined;
after(async () => { await teardown?.(); });
const plane = () => fixture ??= start();

async function start() {
  const repository = 'owner/decisions';
  const operator: Principal = { id: 'decisions-operator', role: 'admin', sessionKind: 'human' };
  const implementer: Principal = { id: 'decisions-implementer', role: 'worker', sessionKind: 'ai' };
  const credentials = [operator, implementer].map(principal => ({ ...principal, token: `decisions-${principal.id}-${'x'.repeat(32)}` }));
  const master = { id: 'decisions-master', token: `decisions-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'decision:rework', 'intent:unblock'] };
  const approver = { id: 'graphyard-approver-graphyard', token: `decisions-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve', 'decision:rework', 'intent:ready', 'intent:unblock'] };
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1300;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('decision-application'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('decisions_test');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/decisions_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  const http = server(engine, credentials);
  teardown = async () => { http.close(); await store.close(); await database.stop(); };
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const send = async (token: string, path: string, body: unknown, key: string = randomUUID()) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (token: string, path: string, body: unknown, key?: string) => {
    const result = await send(token, path, body, key);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const decisions = async (key: string) => {
    const response = await fetch(`${url}/api/work/${key}/decisions`, { headers: { Authorization: `Bearer ${master.token}` } });
    return (await response.json() as { decisions: any[] }).decisions;
  };
  for (const agent of [master, approver])
    await call(credentials[0].token, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Decision application fixture' });
  /** How many decision outcomes, and how many engine applications of `command`, the item's ledger holds. */
  const counts = async (work: Work, id: string, command: string) => {
    const rows = (await store.pool.query("SELECT kind FROM events WHERE work_id=$1 AND (payload->>'id'=$2 OR kind=$3)", [work.id, id, command])).rows.map(row => row.kind as string);
    return { outcomes: rows.filter(kind => ['decision.applied', 'decision.failed', 'decision.stale'].includes(kind)).length, applications: rows.filter(kind => kind === command).length };
  };
  const current = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
  let pr = 1300;
  const observed = (paths: string[], pull: number, branch: string): Observation => {
    const candidate = { sha: 'c'.repeat(40), baseSha: 'd'.repeat(40), pr: pull, branch, author: 'worker' };
    return { candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'CHANGES_REQUESTED', submittedAt: new Date().toISOString() }],
      merged: false, mergeSha: null, mergeable: true, protected: true, files: paths, at: new Date().toISOString(),
      scopeFiles: paths.map(path => ({ path, status: 'modified' as const, sha: 'a'.repeat(40), additions: 1, deletions: 1, binary: false })) } as unknown as Observation;
  };
  /** A submitted item; a high-lane path makes its rework wait for an independent approver. */
  const submitted = async (title: string, paths = ['src/server/routes/decisions-fixture.ts']) => {
    let work = await call(master.token, 'work', { title, plannedFiles: paths, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Decision application fixture' }) as Work;
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
    work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'decisions-host', path: `/tmp/decisions/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
    work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, randomUUID());
    return engine.observe(work.id, work.revision, observed(paths, pr, work.workspaces.at(-1)!.branch));
  };
  /** Run `act` with the engine's `command` replaced once by `fault` (after running it, when `ran`). */
  const faulting = async <T>(command: string, fault: () => Error, act: () => Promise<T>, ran = false): Promise<T> => {
    const execute = engine.execute;
    engine.execute = (async (...args: Parameters<typeof execute>) => {
      if (args[1] !== command) return execute.apply(engine, args);
      engine.execute = execute;
      if (ran) await execute.apply(engine, args);
      throw fault();
    }) as typeof execute;
    try { return await act(); } finally { engine.execute = execute; }
  };
  /**
   * GY-949's shape: the master requests a rework, the approver session approves it, and the
   * application is interrupted before any outcome is recorded — the approval committed, nothing else.
   * With `ran`, the engine call itself committed first, as a crash after it would leave it.
   */
  const stranded = async (title: string, ran = false) => {
    const work = await submitted(title);
    const requested = await call(master.token, `work/${work.key}/decide`, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'graphyard-reviewer[bot] requested changes on the head' });
    assert.equal(requested.state, 'requested', 'a high-lane rework waits for its approver');
    const approving = await faulting('rework', () => new Error('connection terminated while applying the rework'),
      () => send(approver.token, `work/${work.key}/approve`, { decision: requested.id, reason: 'The verdict stands against the current head' }), ran);
    assert.notEqual(approving.status, 200, 'the interrupted application answers no outcome');
    const [decision] = await decisions(work.key);
    assert.deepEqual([decision.id, decision.state, decision.approvedBy, decision.outcome], [requested.id, 'approved', approver.id, null], 'approved by the session, outcome null');
    assert.equal((await current(work)).reworkRequested, ran);
    return { work, decision };
  };
  // The ledger is append-only, so time is moved instead: the control plane's clock runs `ms` ahead for the duration of `during`.
  const later = async <T>(ms: number, during: () => Promise<T>): Promise<T> => {
    const transaction = store.transaction;
    store.transaction = ((fn, options) => transaction.call(store, (db, now) => fn(db, new Date(now.getTime() + ms)), options)) as typeof transaction;
    try { return await during(); } finally { store.transaction = transaction; }
  };
  /** The loop's report of an approver session, saved on the item it judges: it moves the revision, and only in bookkeeping (GY-1296). */
  const report = (work: Work, decision: string) => call(credentials[0].token, `work/${work.id}/session`, { id: `approver:${decision}`, kind: 'coordination', principal: approver.id, role: 'approver',
    runtime: 'claude', host: 'decisions-host', subject: `${work.key}: judge decision ${decision}`, observed: 'working', observedAt: new Date().toISOString(), missedReports: 0 });
  return { engine, store, master, approver, send, call, decisions, counts, current, submitted, faulting, stranded, later, report, url };
}

// ---- AC-2: a re-request reconciles instead of refusing ------------------------------------------
test('unit:approved-rework-rerequest-reconciles — a decide request resumes the stranded approval before the pending guard, for session and lane approvals alike', { timeout: 120_000 }, async () => {
  const { engine, master, send, call, decisions, current, submitted, faulting, stranded, later } = await plane();
  const rework = { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The loop requests the rework again' };
  // A session approval is stranded once the grace its own call had to apply it has passed (GY-1297): within it, the request is
  // told the approval is still being applied and when a request resumes it, never to wait for it.
  const stalled = approvalApplyGraceMs + 1000, past = <T>(act: () => Promise<T>) => later(stalled, act);
  const { work, decision } = await stranded('session-approved-resumed');
  const early = await send(master.token, `work/${work.key}/decide`, rework);
  assert.equal(early.status, 409);
  assert.match(early.body.error, new RegExp(`approved by graphyard-approver-graphyard at .+ and its application has recorded no outcome yet; a request after 60s resumes it`));
  assert.doesNotMatch(early.body.error, /wait for it before requesting another/);
  // Session-approved and applied on resume: the stranded decision answers the request, and replays answer the same.
  const key = randomUUID();
  const again = await past(() => send(master.token, `work/${work.key}/decide`, rework, key));
  assert.equal(again.status, 200, `never 'already approved; wait for it': ${JSON.stringify(again.body)}`);
  assert.deepEqual([again.body.id, again.body.state, again.body.approvedBy], [decision.id, 'applied', 'graphyard-approver-graphyard']);
  assert.equal((await current(work)).reworkRequested, true, 'the item is sent back for rework');
  assert.deepEqual((await past(() => send(master.token, `work/${work.key}/decide`, rework, key))).body, again.body, 'its replay answers the same');
  assert.equal((await decisions(work.key)).length, 1, 'no second rework was recorded');
  // An unrelated request resumes it too, and is judged on its own merits.
  const other = await stranded('session-approved-unrelated');
  const unrelated = await past(() => send(master.token, `work/${other.work.key}/decide`, { action: 'unblock', input: { expectedRevision: 1 }, reason: 'Nothing to unblock' }));
  assert.equal(unrelated.status, 409, JSON.stringify(unrelated.body));
  assert.equal((await decisions(other.work.key)).find(entry => entry.id === other.decision.id)!.state, 'applied');
  // Settled failed on resume: the stranded decision stops blocking and the new request is recorded in its place.
  const refused = await stranded('session-approved-failed');
  const superseding = await faulting('rework', () => new Refusal('The item moved on before the rework was applied', 409),
    () => past(() => send(master.token, `work/${refused.work.key}/decide`, rework)));
  assert.equal(superseding.status, 200, JSON.stringify(superseding.body));
  assert.notEqual(superseding.body.id, refused.decision.id, 'a new decision supersedes the stranded one');
  assert.equal(superseding.body.state, 'requested', 'and waits for its own approver, as a high-lane rework does');
  assert.equal((await decisions(refused.work.key)).find(entry => entry.id === refused.decision.id)!.state, 'failed');
  // A lane-approved rework strands and reconciles the same way, at once: the lane's approval and application are one request.
  const low = await submitted('lane-approved', ['src/model/decisions-fixture.ts']);
  const interrupted = await faulting('rework', () => new Error('connection terminated'), () => send(master.token, `work/${low.key}/decide`, rework));
  assert.notEqual(interrupted.status, 200);
  const [lane] = await decisions(low.key);
  assert.deepEqual([lane.state, lane.approvedBy], ['approved', 'graphyard-risk-lane']);
  const answered = await call(master.token, `work/${low.key}/decide`, rework);
  assert.deepEqual([answered.id, answered.state], [lane.id, 'applied']);
  // A server fault on resume is no deadlock either: the stranded approval settles failed, naming the fault, and the request is recorded.
  const faulted = await stranded('session-approved-faulted');
  const retry = await faulting('rework', () => new Error('connection terminated while resuming'), () => past(() => send(master.token, `work/${faulted.work.key}/decide`, rework)));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual([retry.body.state, retry.body.id === faulted.decision.id], ['requested', false]);
  const settled = (await decisions(faulted.work.key)).find(entry => entry.id === faulted.decision.id)!;
  assert.equal(settled.state, 'failed');
  assert.match(settled.outcome, /^Approved by graphyard-approver-graphyard at .+ but its application was never recorded; resuming it failed: connection terminated while resuming$/);
  void engine;
});

// ---- AC-3: idempotent and single-outcome --------------------------------------------------------
test('integration:approved-resume-idempotent — the resume replays the decision-keyed engine call, records one outcome, settles a moved situation stale, and leaves a settled decision alone', { timeout: 120_000 }, async () => {
  const { engine, store, master, approver, send, call, decisions, counts, current, faulting, stranded, report } = await plane();
  // Concurrent resumers: one engine application and one outcome between them.
  const { work, decision } = await stranded('resume-concurrent');
  const resume = () => send(master.token, `work/${work.key}/decide`, { action: 'resume', decision: decision.id });
  const answers = await Promise.all([resume(), resume(), resume()]);
  for (const answer of answers) assert.deepEqual([answer.status, answer.body.id, answer.body.state], [200, decision.id, 'applied'], JSON.stringify(answer.body));
  assert.deepEqual(await counts(work, decision.id, 'rework'), { outcomes: 1, applications: 1 });
  assert.equal((await current(work)).reworkRequested, true);
  // A settled decision is never touched: resuming it again records nothing.
  assert.equal((await resume()).body.state, 'applied');
  assert.deepEqual(await counts(work, decision.id, 'rework'), { outcomes: 1, applications: 1 });
  // The engine call committed before the crash: the resume replays it under decision:<id>, never runs it twice.
  const crashed = await stranded('resume-after-engine-commit', true);
  const replayed = await call(master.token, `work/${crashed.work.key}/decide`, { action: 'resume', decision: crashed.decision.id });
  assert.equal(replayed.state, 'applied');
  assert.deepEqual(await counts(crashed.work, crashed.decision.id, 'rework'), { outcomes: 1, applications: 1 });
  // The approver repeating its approval after the resume settled it is told so, and records no second outcome.
  const repeated = await send(approver.token, `work/${crashed.work.key}/approve`, { decision: crashed.decision.id, reason: 'The verdict stands against the current head' });
  assert.equal(repeated.status, 409, JSON.stringify(repeated.body));
  assert.match(repeated.body.error, /is already applied/);
  assert.deepEqual(await counts(crashed.work, crashed.decision.id, 'rework'), { outcomes: 1, applications: 1 });
  // A refusal settles it failed — once.
  const refused = await stranded('resume-refused');
  const failed = await faulting('rework', () => new Refusal('The item moved on', 409), () => call(master.token, `work/${refused.work.key}/decide`, { action: 'resume', decision: refused.decision.id }));
  assert.equal(failed.state, 'failed');
  assert.equal((await call(master.token, `work/${refused.work.key}/decide`, { action: 'resume', decision: refused.decision.id })).state, 'failed', 'a failed decision is answered as it stands');
  assert.deepEqual(await counts(refused.work, refused.decision.id, 'rework'), { outcomes: 1, applications: 0 });
  // A revision race: a release approved against a revision the item has since moved past settles
  // stale through recordStale's entry, and stops blocking a fresh release request.
  const proposed = await call(master.token, 'work', { title: 'resume-stale', plannedFiles: ['src/server/routes/decisions-fixture.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Decision application fixture' }) as Work;
  const release = await call(master.token, `work/${proposed.key}/decide`, { action: 'release', input: { expectedRevision: proposed.revision }, reason: 'Ready to build' });
  const approving = await faulting('ready', () => new Error('connection terminated while releasing'), () => send(approver.token, `work/${proposed.key}/approve`, { decision: release.id, reason: 'Release it' }));
  assert.notEqual(approving.status, 200);
  assert.equal((await decisions(proposed.key))[0].state, 'approved');
  await store.pool.query("UPDATE work_items SET document = jsonb_set(jsonb_set(document, '{revision}', to_jsonb((document->>'revision')::int + 1)), '{title}', '\"resume-stale (retitled)\"') WHERE id=$1", [proposed.id]);
  const stale = await call(master.token, `work/${proposed.key}/decide`, { action: 'resume', decision: release.id });
  assert.equal(stale.state, 'stale', JSON.stringify(stale));
  assert.deepEqual(stale.race, { expected: { revision: proposed.revision }, current: { revision: proposed.revision + 1 } });
  assert.deepEqual(await counts(proposed, release.id, 'ready'), { outcomes: 1, applications: 0 });
  const fresh = await call(master.token, `work/${proposed.key}/decide`, { action: 'release', input: { expectedRevision: proposed.revision + 1 }, reason: 'Ready to build' });
  assert.notEqual(fresh.id, release.id);
  assert.equal(fresh.state, 'requested', 'the stale decision no longer blocks a fresh request');
  // A revision that moved only in the loop's bookkeeping (its approver session's reports) is rebased as the approval rebases it
  // (GY-1296). Lost before the engine call, the resume applies it rather than settling it stale; lost after the engine call
  // committed under the rebased revision, the resume finds the decision-keyed call and settles applied, never stale.
  for (const ran of [false, true]) {
    const item = await call(master.token, 'work', { title: `resume-bookkeeping-${ran}`, plannedFiles: ['src/server/routes/decisions-fixture.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Decision application fixture' }) as Work;
    const asked = await call(master.token, `work/${item.key}/decide`, { action: 'release', input: { expectedRevision: item.revision }, reason: 'Ready to build' });
    await report(item, asked.id);
    const interrupted = await faulting('ready', () => new Error('connection terminated while releasing'), () => send(approver.token, `work/${item.key}/approve`, { decision: asked.id, reason: 'Release it' }), ran);
    assert.notEqual(interrupted.status, 200);
    await report(item, asked.id);
    assert.equal((await current(item)).ready, ran, ran ? 'the engine call committed before the crash' : 'nothing was applied');
    const resumed = await call(master.token, `work/${item.key}/decide`, { action: 'resume', decision: asked.id });
    assert.equal(resumed.state, 'applied', `${ran ? 'committed' : 'never ran'}: ${JSON.stringify(resumed)}`);
    assert.match(resumed.outcome, ran ? /^Applied by its approval's own engine call \(decision:.+\), which committed before its outcome was recorded$/ : /^Released to ready$/);
    assert.equal((await current(item)).ready, true);
    assert.deepEqual(await counts(item, asked.id, 'ready'), { outcomes: 1, applications: 1 });
  }
  // Only an identity with authority for the decision's action may ask for its resumption.
  const other = await stranded('resume-authority');
  const implementerToken = `decisions-decisions-implementer-${'x'.repeat(32)}`;
  assert.equal((await send(implementerToken, `work/${other.work.key}/decide`, { action: 'resume', decision: other.decision.id })).status, 403);
  assert.equal((await decisions(other.work.key))[0].state, 'approved');
  void engine;
});

// ---- AC-1: the loop's decision cycle applies it -------------------------------------------------
test('unit:approved-decision-applies-on-cycle — GY-949\'s stranded session approval is applied by one loop cycle, and the item is back for a worker', { timeout: 120_000 }, async () => {
  const { master, current, decisions, stranded, url } = await plane();
  const { work, decision } = await stranded('gy-949-replay');
  const item = await current(work);
  const clock = Date.now();
  const needed = routineDecision(item, config, clock);
  assert.equal(needed?.action, 'rework', 'the item still calls for the rework the approver approved');
  const key = decisionKey(item, needed!);
  // The loop's watch as GY-949 had it: one approver session launched, judged, and gone since.
  const state = emptyDaemonState(config);
  state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: 'rework', decision: decision.id, agentName: session, requestedAt: new Date(clock - 3 * 24 * 60 * minute).toISOString(), launchedAt: new Date(clock - 3 * 24 * 60 * minute).toISOString(), launches: 1 });
  const operatorAgent = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${master.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const answer = await response.json() as any;
    if (!response.ok) throw new Error(answer.error ?? JSON.stringify(answer));
    return answer;
  };
  const launched: string[] = [], resumed: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], herdr: async () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [await current(work)], now: new Date(clock).toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(clock).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    decisions: target => operatorAgent('GET', `work/${target.id}/decisions`),
    decide: (target, action, reason, input) => operatorAgent('POST', `work/${target.id}/decide`, { action, reason, input }),
    withdraw: (target, id, reason) => operatorAgent('POST', `work/${target.id}/decide`, { action: 'withdraw', decision: id, reason }),
    resume: (target, id) => { resumed.push(id); return operatorAgent('POST', `work/${target.id}/decide`, { action: 'resume', decision: id }); },
    approver: async (_target, id) => { launched.push(id); throw new Error('the approver quota is exhausted until 2026-10-08T07:00Z'); },
  };
  const launcher = new Launcher();
  await runCycle(config, state, effects, () => clock, launcher); await launcher.idle();

  assert.deepEqual(resumed, [decision.id], 'the cycle asked the control plane to apply the approved decision');
  assert.deepEqual(launched, [], 'no approver session is launched for an already-judged decision');
  const [settled] = await decisions(work.key);
  assert.deepEqual([settled.id, settled.state, settled.approvedBy], [decision.id, 'applied', 'graphyard-approver-graphyard']);
  const after = await current(work);
  assert.equal(after.reworkRequested, true, 'the rework is applied');
  assert.doesNotThrow(() => assertDispatchable(after, [after], new Date().toISOString()), 'the item is back for a worker to claim');
  assert.ok(state.approvals[key].settledAt, 'the watch is settled, so the binding is not requested again');
  assert.ok(Object.values(state.actions).some(action => action.work === item.key && /Applied rework decision .* on the loop's resume/.test(action.detail)), 'the cycle records what it did');
  // The next cycle finds nothing left to do for it.
  await runCycle(config, state, effects, () => clock + minute, launcher); await launcher.idle();
  assert.deepEqual([resumed.length, launched.length], [1, 0]);
  assert.equal((await decisions(work.key)).length, 1);
});
