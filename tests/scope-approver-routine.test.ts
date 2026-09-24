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
import { scopeRequestAttention } from '../src/cli/owed-report.js';
import { routedScopeRequests } from '../src/cli/status-attention.js';
import { answeringWidening, daemonSummary, emptyDaemonState, runCycle, scopeRoutineDecision, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { approverSessionName, decisionInput, masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { scopeOutcomeMessage } from '../src/model/scope.js';
import type { Principal, Work } from '../src/model.js';

// GY-176: an additive scope request the implication rule refuses and no review finding grounds
// used to wait for a master to run `master scope`. The loop now requests a `requirements`
// decision as the master's operator-agent identity and launches the independent approver, as it
// does for rework, recovery, resolution and merge; the worker is told the outcome in its session.
// Each test is named for the proof it produces.
const repository = 'owner/scope-approver';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `scope-approver-${principal.id}-${'x'.repeat(32)}` }));
// The master's operator-agent identity requests; a second, independent identity approves.
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const approver = { id: 'independent-approver', token: `independent-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(credential, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows;
const layout = 'src/widget/Layout.tsx', helper = 'src/widget/measure.ts';
const criteria = [{ id: 'AC-1', text: `The widget layout renders from ${layout} at every breakpoint`, proofs: ['unit:layout'] }];

async function claimed(title: string) {
  let work = await ok(master.token, 'POST', 'work', { title, plannedFiles: [layout], criteria, reason: 'Operator goal: scope is a routine decision, not a wait on a master' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the attempt' }) as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  return reload(work.id);
}
const ask = (work: Work, paths: string[], reason: string) => ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths, reason }) as Promise<Work>;

const workerSession = 'graphyard-worker-scope';
const loopConfig = () => masterConfigSchema.parse({ version: 1, url, credentialFile: join(tmpdir(), 'scope-approver-coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-scope-approver',
  workers: [{ name: 'worker', principal: implementer.id, agentName: workerSession, mode: 'existing' }] }) as MasterConfig;

/**
 * The loop with the decision effects wired as `daemonEffects` wires them: requests and withdrawals
 * as the master's operator-agent identity, the approver launch recorded rather than spawned, and
 * every message the worker session is sent kept for the test to read.
 */
function harness() {
  const sessions: HerdrAgent[] = [], told: { key: string; agentName: string; text: string }[] = [], launched: string[] = [], closed: string[] = [], decided: { key: string; action: string; reason: string; input: any }[] = [];
  const effects: DaemonEffects = {
    agents: () => sessions,
    herdr: () => ({ agents: sessions, available: true }),
    credentials: async () => ({}),
    snapshot: async () => { const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
    closeSession: pane => { closed.push(pane); sessions.splice(0, sessions.length, ...sessions.filter(agent => agent.pane_id !== pane)); },
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    decideScope: work => ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.scopeRequest!.epoch }) as Promise<Work>,
    // No review finding names anything, so the finding rule judges and grounds nothing.
    reviewFindings: async () => [],
    basePaths: async () => new Set<string>(),
    widenScope: (work, request, paths, reason) => ok(master.token, 'POST', `work/${work.id}/requirements`, answeringWidening(work, request, paths, reason)),
    decide: async (work, action, reason, input = {}) => { decided.push({ key: work.key, action, reason, input }); return ok(master.token, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }); },
    approver: async (work, decision) => {
      const agentName = approverSessionName(work, decision), pane = `pane-${launched.length + 1}`;
      launched.push(decision); sessions.push({ name: agentName, pane_id: pane, agent_status: 'working' } as HerdrAgent);
      return { agentName, pane };
    },
    decisions: work => ok(master.token, 'GET', `work/${encodeURIComponent(work.id)}/decisions`),
    withdraw: (work, decision, reason) => ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason }),
    tellWorker: async (work, agentName, text) => { told.push({ key: work.key, agentName, text }); },
    persist: async () => {},
  };
  const cycle = (state: DaemonState) => runCycle(loopConfig(), state, effects);
  // The store is shared by every test, so each reads what the loop did about its own item.
  const about = (work: Work) => ({ told: told.filter(entry => entry.key === work.key), decided: decided.filter(entry => entry.key === work.key) });
  return { effects, cycle, sessions, told, launched, closed, decided, about };
}
const standing = async (work: Work) => (await ok(master.token, 'GET', `work/${work.id}/decisions`)).decisions.filter((decision: any) => decision.action === 'requirements');

before(async () => {
  const port = Number(process.env.GRAPHYARD_SCOPE_APPROVER_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 183);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-scope-approver-db-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('scope_approver_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scope_approver_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver]) await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: `Onboarding provisions ${agent.id}` });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:scope-approver-routine — an additive request the rules refuse is requested as a routine decision, launched to the approver, and an approval widens plannedFiles as master scope does while the worker keeps its lease', async () => {
  let work = await claimed('approved through the approver');
  const reason = 'The layout measures its breakpoints through a helper the criteria rely on but do not name';
  const asked = await ask(work, [helper], reason);
  const loop = harness(), state = emptyDaemonState(loopConfig());

  // Cycle 1: the rule refuses, no finding names it, and the loop requests the decision itself.
  await loop.cycle(state);
  work = await reload(work.id);
  assert.equal(work.scopeRequest!.decision!.state, 'refused', 'the implication rule refused it');
  assert.equal(loop.about(work).decided.length, 1, 'the loop requested one decision');
  assert.equal(loop.about(work).decided[0].action, 'requirements');
  assert.deepEqual(loop.about(work).decided[0].input, { plannedFiles: [layout, helper] }, 'an additive widening by exactly the requested paths');
  assert.match(loop.about(work).decided[0].reason, new RegExp(reason), "the request cites the worker's reason");
  assert.match(loop.about(work).decided[0].reason, /AC-1: The widget layout renders/, "the request cites the item's criteria");
  assert.match(loop.about(work).decided[0].reason, /src\/widget\/measure\.ts/, 'the request names the paths');
  const [requested] = await standing(work);
  assert.equal(requested.state, 'requested');
  assert.equal(requested.requestedBy, master.id, "requested as the master's operator-agent identity");
  assert.deepEqual(loop.launched, [requested.id], 'the independent approver was launched for it');
  assert.equal(Object.values(state.actions).filter(action => action.kind === 'escalation' && /master scope/.test(action.detail)).length, 0, 'nothing sends a master to run master scope');
  assert.ok(work.lease && work.lease.epoch === asked.epoch, 'the worker holds its lease while the approver judges');

  // A second cycle while the approver works neither requests again nor launches another session.
  await loop.cycle(state);
  assert.equal(loop.about(work).decided.length, 1);
  assert.equal(loop.launched.length, 1);

  // The requester can never approve its own request; the independent approver can.
  const self = await call(master.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'Self-approval' });
  assert.notEqual(self.status, 200, 'the requester cannot approve its own decision');
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'The helper is the layout criterion spelled out' });
  work = await reload(work.id);
  // Exactly what `master scope` would have applied: the planned files plus the requested paths.
  assert.deepEqual(work.plannedFiles, [...new Set([layout, ...asked.scopeRequest!.paths])]);
  assert.equal(work.scopeRequest, null, 'the request is answered');
  assert.equal(work.blocker, null, 'the refusal no longer holds the item');
  assert.ok(work.lease && work.lease.epoch === asked.epoch && work.lease.owner === implementer.id, 'the worker keeps its lease');
  const revision = (await events(work)).filter(entry => entry.kind === 'requirements').at(-1)!;
  assert.equal(revision.payload.details.liveScopeWidening ?? revision.payload.liveScopeWidening ?? true, true);

  // Cycle 3: the item no longer needs the decision; the approver session goes and the worker is told.
  await loop.cycle(state);
  assert.equal(loop.about(work).told.length, 1);
  assert.equal(Object.keys(state.approvals).length, 0, 'the watch is retired once applied');
  assert.deepEqual(loop.closed, ['pane-1'], 'the approver session is closed');
});

test('unit:scope-approver-routine — a refused decision is recorded, never re-requested, and never escalated to master scope', async () => {
  let work = await claimed('refused by the approver');
  await ask(work, ['src/server/routes/work.ts'], 'The route would be easier to change here too');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [requested] = await standing(work);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: requested.id, reason: 'The route is another item\'s scope; AC-1 needs only the layout' });
  await loop.cycle(state);
  await loop.cycle(state);
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, [layout], 'nothing is widened');
  assert.ok(work.lease, 'the worker keeps its lease');
  assert.equal(loop.about(work).decided.length, 1, 'a refused decision is not requested again');
  assert.equal(loop.launched.length, 1, 'and no other approver is launched');
  assert.equal(Object.values(state.actions).filter(action => action.kind === 'escalation' && /master scope/.test(action.detail)).length, 0);
  assert.equal(loop.about(work).told.length, 1, 'the worker is told once');
});

test('unit:scope-approver-routine — a root-level directory scope is requested as the broad-scope exception, granted only with a stated reason', async () => {
  let work = await claimed('broad scope');
  await ask(work, ['tests/'], 'Every fixture under tests/ pins the layout text');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  assert.equal(loop.about(work).decided.length, 1);
  assert.match(loop.about(work).decided[0].reason, /Broad scope exception \(tests\/\) recorded with --allow-broad-scope/, 'the exception is written into the audited reason');
  assert.match(loop.about(work).decided[0].reason, /grant it only with a stated reason/);
  const [requested] = await standing(work);
  // An approval without a reason is no grant: the control plane refuses it.
  const bare = await call(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: ' ' });
  assert.equal(bare.status, 400, JSON.stringify(bare.body));
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'Granting the broad scope: the layout text is pinned in fixtures across tests/, and no narrower list is known yet' });
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, [layout, 'tests/']);
  const revision = (await events(work)).filter(entry => entry.kind === 'requirements').at(-1)!;
  const audited = JSON.stringify(revision.payload);
  assert.match(audited, /Broad scope exception \(tests\/\)/, 'the applied revision records the exception');
  assert.match(audited, /the layout text is pinned in fixtures/, "and the approver's stated reason");
});

test('unit:scope-approver-routine — only a live, additive, rule-refused request the findings did not ground is routed', () => {
  const now = Date.parse('2031-03-01T10:00:00Z');
  const lease = { epoch: 2, owner: 'implementer', expiresAt: '2031-03-01T10:05:00Z' };
  const refused = { state: 'refused' as const, reason: 'outside', at: '2031-03-01T09:59:00Z', decidedBy: 'graphyard', waitedMs: 1, paths: [helper], requestedBy: 'implementer', requestedAt: '2031-03-01T09:58:00Z' };
  const base = { key: 'GY-9', stage: 'build', plannedFiles: [layout], criteria, lease, scopeRequest: { epoch: 2, paths: [helper], reason: 'needed', requestedBy: 'implementer', at: '2031-03-01T09:58:00Z', decision: refused } } as unknown as Work;
  assert.equal(scopeRoutineDecision(base, now, true)?.action, 'requirements');
  assert.equal(scopeRoutineDecision(base, now, false), null, 'the review-finding rule is judged first');
  assert.equal(scopeRoutineDecision({ ...base, scopeRequest: { ...base.scopeRequest!, decision: undefined } } as Work, now, true), null, 'an undecided request is the rule\'s first');
  assert.equal(scopeRoutineDecision({ ...base, scopeRequest: { ...base.scopeRequest!, remove: [layout] } } as Work, now, true), null, 'a narrowing is not routine');
  assert.equal(scopeRoutineDecision({ ...base, lease: { ...lease, epoch: 3 } } as Work, now, true), null, 'a request of an ended attempt is moot');
  assert.equal(scopeRoutineDecision({ ...base, lease: { ...lease, expiresAt: '2031-03-01T09:00:00Z' } } as Work, now, true), null);
});

test('unit:scope-outcome-delivered — the worker is told the outcome in its session, and master status stops naming master scope for a routed request', async () => {
  // Approved: continue.
  let work = await claimed('outcome approved');
  await ask(work, [helper], 'The layout measures through the helper');
  const approved = harness(), approvedState = emptyDaemonState(loopConfig());
  await approved.cycle(approvedState);

  // While the approver judges it, status names no `master scope` for it; without the routing it would.
  const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot') as { work: Work[]; now: string };
  const own = { work: snapshot.work.filter(item => item.id === work.id), now: snapshot.now };
  assert.match(scopeRequestAttention(own).map(item => item.next).join('\n'), new RegExp(`graphyard master scope ${work.key}`), 'an unrouted refusal still names master scope');
  const approvals = daemonSummary(approvedState, Date.now(), 30_000).approvals;
  assert.ok(routedScopeRequests(approvals)(own.work[0]), 'the loop has routed this request');
  assert.deepEqual(scopeRequestAttention(own, approvals).filter(item => /master scope/.test(`${item.next} ${item.text}`)), [], 'a routed request names no master scope');

  const [first] = await standing(work);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: first.id, reason: 'The helper is AC-1 spelled out' });
  await approved.cycle(approvedState);
  assert.equal(approved.about(work).told.length, 1);
  assert.equal(approved.about(work).told[0].agentName, workerSession, 'told in the worker\'s own session');
  assert.match(approved.about(work).told[0].text, /approved by the independent approver independent-approver/);
  assert.match(approved.about(work).told[0].text, /you keep your lease: continue the work/);
  assert.match(approved.about(work).told[0].text, /src\/widget\/measure\.ts/);
  await approved.cycle(approvedState);
  assert.equal(approved.about(work).told.length, 1, 'told once');

  // Refused: the approver's reason, and that the worker stays inside plannedFiles.
  work = await claimed('outcome refused');
  await ask(work, ['src/server/routes/work.ts'], 'The route would be easier to change here too');
  const refused = harness(), refusedState = emptyDaemonState(loopConfig());
  await refused.cycle(refusedState);
  const [second] = await standing(work);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: second.id, reason: 'The route belongs to another item' });
  await refused.cycle(refusedState);
  assert.equal(refused.about(work).told.length, 1);
  assert.match(refused.about(work).told[0].text, /refused by the independent approver independent-approver: The route belongs to another item/);
  assert.match(refused.about(work).told[0].text, /Stay inside plannedFiles/);
  assert.match(refused.about(work).told[0].text, new RegExp(`scope-request ${work.key} ${work.epoch} -`), 'with the command that withdraws the ask');
  const after = await ok(token(coordinator), 'GET', 'work-snapshot') as { work: Work[]; now: string };
  const mine = { work: after.work.filter(item => item.id === work.id), now: after.now };
  assert.deepEqual(scopeRequestAttention(mine, daemonSummary(refusedState, Date.now(), 30_000).approvals), [], 'status still names no master scope once the approver refused');
  assert.equal(scopeOutcomeMessage('GY-1', 1, { state: 'refused', paths: ['a.ts'], approver: null, reason: null }).includes('no reason recorded'), true);
});
