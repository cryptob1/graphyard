import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { owedAttention, routedScopeStatus, scopeRequestAttention } from '../src/cli/owed-report.js';
import { routedScopeRequests } from '../src/cli/status-attention.js';
import { answeringWidening, daemonSummary, emptyDaemonState, runCycle, scopeBudget, scopeOutcomeAnswered, scopeRoutineDecision, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { approverSessionName, buildMasterStatus, decisionInput, masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { scopeBlockedBudgetMs, scopeOutcomeMessage, scopeRequestOutcome } from '../src/model/scope.js';
import { awaitScopeOutcome } from '../src/cli/session-commands.js';
import { approveScopeRequest } from '../src/cli/master-status.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-176: an additive scope request the implication rule refuses and no review finding grounds
// used to wait for a master to run `master scope`. The loop now requests a `requirements`
// decision as the master's operator-agent identity and launches the independent approver, as it
// does for rework, recovery, resolution and merge. The decision is bound to the asking attempt's
// request and lease, and its outcome is held on the item, where the worker's own command reads it:
// nothing is pasted into the worker's session.
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
 * as the master's operator-agent identity, and the approver launch recorded rather than spawned.
 * There is no effect that reaches the worker's session: the loop has no way to paste into it.
 */
function harness() {
  const sessions: HerdrAgent[] = [], launched: string[] = [], closed: string[] = [], decided: { key: string; action: string; reason: string; input: any }[] = [];
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
    persist: async () => {},
  };
  const cycle = (state: DaemonState) => runCycle(loopConfig(), state, effects);
  // The store is shared by every test, so each reads what the loop did about its own item.
  const about = (work: Work) => ({ decided: decided.filter(entry => entry.key === work.key) });
  return { effects, cycle, sessions, launched, closed, decided, about };
}
const standing = async (work: Work) => (await ok(master.token, 'GET', `work/${work.id}/decisions`)).decisions.filter((decision: any) => decision.action === 'requirements');

before(async () => {
  const port = Number(process.env.GRAPHYARD_SCOPE_APPROVER_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 183);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('scope-approver-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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
  assert.deepEqual(loop.about(work).decided[0].input, { plannedFiles: [layout, helper], answers: { epoch: asked.epoch, at: asked.scopeRequest!.at } }, 'an additive widening by exactly the requested paths, bound to the ask');
  assert.match(loop.about(work).decided[0].reason, new RegExp(reason), "the request cites the worker's reason");
  assert.match(loop.about(work).decided[0].reason, /AC-1: The widget layout renders/, "the request cites the item's criteria");
  assert.match(loop.about(work).decided[0].reason, /src\/widget\/measure\.ts/, 'the request names the paths');
  const [requested] = await standing(work);
  assert.equal(requested.state, 'requested');
  assert.equal(requested.requestedBy, master.id, "requested as the master's operator-agent identity");
  assert.deepEqual(requested.input.answers, { epoch: asked.epoch, at: asked.scopeRequest!.at }, 'the enforceable input names the request and its lease epoch');
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

  assert.equal(work.scopeDecision!.state, 'approved', 'the outcome is held on the item');
  assert.equal(work.scopeDecision!.decidedBy, approver.id, 'by the approver, not the requester the decision is applied as');
  assert.equal(work.scopeDecision!.reason, 'The helper is the layout criterion spelled out', "with the approver's own reason, never truncated behind the request's");
  // Cycle 3: the item no longer needs the decision; the approver session goes and the outcome is noted.
  await loop.cycle(state);
  assert.equal(Object.values(state.actions).filter(action => action.kind === 'scope' && action.work === work.key && /^Approved/.test(action.detail)).length, 1);
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
  assert.equal(work.scopeDecision!.decidedBy, approver.id, 'the refusal is held on the item, by the approver');
  assert.match(work.blocker!, /^Scope request refused by the independent approver independent-approver/);
});

test('unit:scope-approver-routine — a refusal keeps a blocker the worker reported while the request waited, and withdrawing the ask does not clear it', async () => {
  let work = await claimed('refused over a worker blocker');
  await ask(work, ['src/server/routes/work.ts'], 'The route would be easier to change here too');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [requested] = await standing(work);
  const own = 'The fixture database is unreachable from this host';
  await engine.execute(implementer, 'blocked', work.id, { epoch: work.epoch, reason: own }, randomUUID());
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: requested.id, reason: 'The route is another item\'s scope' });
  work = await reload(work.id);
  assert.equal(work.scopeDecision!.state, 'refused', 'the refusal is still recorded');
  assert.equal(work.scopeDecision!.decidedBy, approver.id);
  assert.equal(work.blocker, own, 'the worker\'s own blocker is not overwritten');
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [], reason: 'Staying inside plannedFiles' });
  work = await reload(work.id);
  assert.equal(work.scopeRequest, null);
  assert.equal(work.blocker, own, 'withdrawing the ask leaves the unrelated blocker standing');
});

test('unit:scope-approver-routine — an approval is refused once the asking attempt no longer holds the lease, with the policy revision unchanged', async () => {
  let work = await claimed('stale approval');
  const asked = await ask(work, [helper], 'The layout measures through the helper');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [requested] = await standing(work);
  // The asking attempt ends and a new one claims the item while the approver is still deciding.
  await engine.execute(implementer, 'release', work.id, { epoch: asked.epoch }, randomUUID());
  const released = await reload(work.id);
  await ok(master.token, 'POST', `work/${work.id}/unblock`, { expectedRevision: released.revision, reason: 'The refusal belonged to the attempt that ended' });
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  assert.equal(work.policyRevision, asked.policyRevision, 'nothing moved the policy revision');
  const late = await call(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'The helper is AC-1 spelled out' });
  assert.equal(late.body.state, 'failed', JSON.stringify(late.body));
  assert.match(JSON.stringify(late.body), /no longer open|no longer holds the lease/);
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, [layout], 'the new attempt, which never asked, is not widened');
  assert.equal(work.lease!.epoch, asked.epoch + 1);
});

test('unit:scope-approver-routine — a refusal answers only the request it names: the same paths asked again with a better reason go to the approver again', async () => {
  let work = await claimed('re-asked after refusal');
  const first = await ask(work, [helper], 'Would be tidier');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [refused] = await standing(work);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: refused.id, reason: 'Tidiness is no ground; name what AC-1 needs' });
  await loop.cycle(state);
  // The worker withdraws the refused ask and asks again for the same paths, with the grounds.
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: first.epoch, paths: [], reason: 'Withdrawn by the worker' });
  const again = await ask(await reload(work.id), [helper], 'AC-1 renders every breakpoint, and the breakpoints are measured only in the helper');
  assert.notEqual(again.scopeRequest!.at, first.scopeRequest!.at);
  await loop.cycle(state);
  assert.equal(loop.about(work).decided.length, 2, 'the new request is put to the approver, not settled by the old refusal');
  assert.deepEqual(loop.about(work).decided[1].input.answers, { epoch: again.epoch, at: again.scopeRequest!.at });
  const second = (await standing(work)).find((decision: any) => decision.state === 'requested');
  assert.ok(second, 'a decision stands for the new request');
  assert.equal(loop.launched.length, 2, 'and the approver is launched for it');
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: second.id, reason: 'The helper is where AC-1 is measured' });
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, [layout, helper]);
});

test('unit:scope-approver-routine — a decision standing for a withdrawn request is never adopted by the same paths asked again: it is withdrawn and the new request is asked', async () => {
  let work = await claimed('re-asked before judgement');
  const first = await ask(work, [helper], 'The layout needs its helper');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [old] = await standing(work);
  assert.equal(old.state, 'requested');
  // Before any approver judges it, the worker withdraws the ask and makes it again for the same paths.
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: first.epoch, paths: [], reason: 'Withdrawn by the worker' });
  const again = await ask(await reload(work.id), [helper], 'AC-1 renders every breakpoint, and the breakpoints are measured only in the helper');
  assert.notEqual(again.scopeRequest!.at, first.scopeRequest!.at);
  await loop.cycle(state);
  assert.equal(loop.about(work).decided.length, 2, 'the new request is asked, not settled by adopting the old decision');
  assert.deepEqual(loop.about(work).decided[1].input.answers, { epoch: again.epoch, at: again.scopeRequest!.at });
  const decisions = await standing(work);
  assert.notEqual(decisions.find((decision: any) => decision.id === old.id).state, 'requested', 'the decision for the withdrawn request is taken back');
  const current = decisions.find((decision: any) => decision.state === 'requested');
  assert.ok(current && current.id !== old.id, 'a decision stands for the new request');
  assert.deepEqual(current.input.answers, { epoch: again.epoch, at: again.scopeRequest!.at });
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: current.id, reason: 'Still no ground in the criteria' });
  await loop.cycle(state);
  work = await reload(work.id);
  assert.equal(scopeRequestOutcome(work, { epoch: again.epoch, at: again.scopeRequest!.at, paths: [helper] }, Date.now()).state, 'refused', 'the refusal reaches the request the worker is waiting on');
  assert.deepEqual(work.plannedFiles, [layout]);
});

test('unit:scope-approver-routine — a refusal that arrives after the asking lease expired writes nothing onto the attempt', async () => {
  let work = await claimed('late refusal');
  await ask(work, ['src/server/routes/work.ts'], 'The route would be easier to change here too');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [requested] = await standing(work);
  const before = await reload(work.id);
  // The lease lapses before reconciliation has run.
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [work.id, new Date(Date.now() - 60_000).toISOString()]);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: requested.id, reason: 'The route belongs to another item' });
  work = await reload(work.id);
  assert.equal(work.scopeDecision!.decidedBy, 'graphyard', "the rule's refusal stands; the approver's is not written onto the lapsed attempt");
  assert.equal(work.scopeRequest!.decision!.decidedBy, 'graphyard');
  assert.equal(work.blocker, before.blocker, 'no approver blocker is written');
  assert.equal((await events(work)).filter(entry => entry.kind === 'scope.refused').length, 0);
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

test('unit:scope-outcome-delivered — the worker reads the outcome in its session from its own command, and master status stops naming master scope for a routed request', async () => {
  // The worker's own command, run with the worker's own credential: durable control-plane state.
  const own = (work: Work, waitMs = 0) => awaitScopeOutcome({ api: path => ok(token(implementer), 'GET', path) }, work, work.epoch, { waitMs, everyMs: 20, cli: 'graphyard' });
  // Approved: continue.
  let work = await claimed('outcome approved');
  const asked = await ask(work, [helper], 'The layout measures through the helper');
  const approved = harness(), approvedState = emptyDaemonState(loopConfig());
  await approved.cycle(approvedState);
  const pending = await own(await reload(work.id));
  assert.equal(pending.state, 'pending', 'a rule refusal the loop routed is not the answer');
  assert.match(pending.text, /with the independent approver/);

  // While the approver judges it, status names no `master scope` for it; without the routing it would.
  const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot') as { work: Work[]; now: string };
  const mine = { work: snapshot.work.filter(item => item.id === work.id), now: snapshot.now };
  assert.match(scopeRequestAttention(mine).map(item => item.next).join('\n'), new RegExp(`graphyard master scope ${work.key}`), 'an unrouted refusal still names master scope');
  const approvals = daemonSummary(approvedState, Date.now(), 30_000).approvals;
  assert.ok(routedScopeRequests(approvals)(mine.work[0]), 'the loop has routed this request');
  assert.deepEqual(scopeRequestAttention(mine, approvals).filter(item => /master scope/.test(`${item.next} ${item.text}`)), [], 'a routed request names no master scope');

  const [first] = await standing(work);
  // The worker is already waiting on its own command when the approver decides.
  const waiting = own(await reload(work.id), 10_000);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: first.id, reason: 'The helper is AC-1 spelled out' });
  const heard = await waiting;
  assert.equal(heard.state, 'approved');
  assert.match(heard.text, /approved/);
  assert.match(heard.text, /The helper is AC-1 spelled out/, "with the approver's reason");
  assert.match(heard.text, /you keep your lease: continue the work/);
  assert.match(heard.text, /src\/widget\/measure\.ts/);
  await approved.cycle(approvedState);
  assert.equal(scopeRequestOutcome(await reload(work.id), { epoch: asked.epoch, at: asked.scopeRequest!.at, paths: [helper] }, Date.now()).state, 'approved', 'and it stays readable after the loop moves on');
  // An approval clears the request: a worker that only starts waiting afterwards still hears it.
  assert.equal((await reload(work.id)).scopeRequest, null);
  const late = await own(await reload(work.id));
  assert.equal(late.state, 'approved', 'waiting after the approval reads the decided outcome, not an error');
  assert.match(late.text, /The helper is AC-1 spelled out/);

  // Refused: the approver's reason, and that the worker stays inside plannedFiles.
  work = await claimed('outcome refused');
  await ask(work, ['src/server/routes/work.ts'], 'The route would be easier to change here too');
  const refused = harness(), refusedState = emptyDaemonState(loopConfig());
  await refused.cycle(refusedState);
  const [second] = await standing(work);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: second.id, reason: 'The route belongs to another item' });
  const told = await own(await reload(work.id));
  assert.equal(told.state, 'refused');
  assert.match(told.text, /refused by the independent approver independent-approver: The route belongs to another item/);
  assert.match(told.text, /Stay inside plannedFiles/);
  assert.match(told.text, new RegExp(`scope-request ${work.key} ${work.epoch} -`), 'with the command that withdraws the ask');
  await refused.cycle(refusedState);
  const after = await ok(token(coordinator), 'GET', 'work-snapshot') as { work: Work[]; now: string };
  const refusedOwn = { work: after.work.filter(item => item.id === work.id), now: after.now };
  assert.deepEqual(scopeRequestAttention(refusedOwn, daemonSummary(refusedState, Date.now(), 30_000).approvals), [], 'status still names no master scope once the approver refused');
  assert.equal(scopeOutcomeMessage('GY-1', 1, { state: 'refused', paths: ['a.ts'], approver: null, reason: null }).includes('no reason recorded'), true);
});

test('unit:scope-outcome-delivered — a wait on a request whose lease passed its deadline ends, even before reconciliation clears the lease', async () => {
  const work = await claimed('outcome lapsed');
  await ask(work, ['src/server/routes/work.ts'], 'The route would be easier to change here too');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  // The lease lapses (a failed heartbeat, say) and nothing has reconciled it yet.
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [work.id, new Date(Date.now() - 60_000).toISOString()]);
  const lapsed = await reload(work.id);
  assert.equal(lapsed.lease?.epoch, work.epoch, 'the lease is still on the item');
  assert.ok(lapsed.scopeRequest, 'and so is the request');
  const started = Date.now();
  const heard = await awaitScopeOutcome({ api: path => ok(token(implementer), 'GET', path) }, lapsed, lapsed.epoch, { waitMs: 10_000, everyMs: 20, cli: 'graphyard' });
  assert.equal(heard.state, 'ended', 'no approval or refusal can reach an attempt whose lease has lapsed');
  assert.ok(Date.now() - started < 5_000, 'the wait ends at once rather than reporting pending until it times out');
  assert.doesNotMatch(heard.text, /you keep your lease/);
  const at = lapsed.scopeRequest!.at, paths = lapsed.scopeRequest!.paths;
  const deadline = Date.parse(lapsed.lease!.expiresAt);
  assert.equal(scopeRequestOutcome(lapsed, { epoch: lapsed.epoch, at, paths }, deadline - 1).state, 'pending', 'while the lease is live the request is still pending');
  assert.equal(scopeRequestOutcome(lapsed, { epoch: lapsed.epoch, at, paths }, deadline).state, 'ended');
  // A decision that landed before the deadline is not the attempt's to act on once it has passed:
  // neither an approval (the request cleared, the paths covered) nor a refusal says to go on.
  const approvedLate = { ...lapsed, scopeRequest: null, plannedFiles: [...lapsed.plannedFiles, ...paths] };
  assert.equal(scopeRequestOutcome(approvedLate, { epoch: lapsed.epoch, at, paths }, deadline - 1).state, 'approved');
  const approvedAfter = scopeRequestOutcome(approvedLate, { epoch: lapsed.epoch, at, paths }, deadline);
  assert.equal(approvedAfter.state, 'ended', 'an approval read after the deadline does not say to continue');
  assert.doesNotMatch(approvedAfter.text, /continue/);
  const refusedLate = { ...lapsed, scopeRequest: { ...lapsed.scopeRequest!, decision: { state: 'refused' as const, reason: 'Not this item', at, decidedBy: approver.id } } } as Work;
  assert.equal(scopeRequestOutcome(refusedLate, { epoch: lapsed.epoch, at, paths }, deadline - 1).state, 'refused');
  assert.equal(scopeRequestOutcome(refusedLate, { epoch: lapsed.epoch, at, paths }, deadline).state, 'ended', 'nor does a refusal');
  assert.equal(scopeRequestOutcome({ ...approvedLate, lease: null }, { epoch: lapsed.epoch, at, paths }, deadline - 1).state, 'ended', 'nor either once reconciliation has cleared the lease');
});

test('unit:scope-outcome-delivered — a request a master widens by hand with master scope is recorded as approved, so the waiting worker reads it', async () => {
  const work = await claimed('outcome by master scope');
  const asked = await ask(work, [helper], 'The layout needs its measuring helper');
  assert.ok(asked.scopeRequest, 'the request is open and no rule or decision has answered it yet');
  const config = { ...loopConfig(), url };
  await approveScopeRequest(process.cwd(), config, [work.key, 'The helper is part of the layout criterion'], { coordinator: path => ok(token(coordinator), 'GET', path), operatorToken: async () => master.token });
  const widened = await reload(work.id);
  assert.equal(widened.scopeRequest, null, 'the widening answered the request');
  assert.equal(widened.lease?.epoch, work.epoch, 'and the worker keeps its lease');
  assert.equal(widened.scopeDecision?.state, 'approved', 'the outcome is kept although the widening carried no routed answers');
  assert.equal(widened.scopeDecision?.epoch, work.epoch);
  assert.equal(widened.scopeDecision?.decidedBy, master.id);
  assert.equal(widened.scopeDecision?.reason, 'The helper is part of the layout criterion');
  const heard = await awaitScopeOutcome({ api: path => ok(token(implementer), 'GET', path) }, widened, work.epoch, { waitMs: 1_000, everyMs: 20, cli: 'graphyard' });
  assert.equal(heard.state, 'approved', 'the wait reads the approval instead of finding no request');
  assert.match(heard.text, /master-operator/);
});

test('unit:scope-approver-routine — a refusal judged against a superseded policy revision leaves the request undecided', async () => {
  let work = await claimed('stale refusal');
  await ask(work, ['src/server/routes/work.ts'], 'The route would be easier to change here too');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [requested] = await standing(work);
  const before = await reload(work.id);
  // The requirements move on while the worker keeps its lease and the request stays open.
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{policyRevision}',to_jsonb($2::int)) WHERE id=$1", [work.id, before.policyRevision + 1]);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: requested.id, reason: 'Judged against the old requirements' });
  work = await reload(work.id);
  assert.equal(work.scopeDecision!.decidedBy, 'graphyard', "the rule's refusal stands; the stale decline is not the request's answer");
  assert.equal(work.scopeRequest!.decision!.decidedBy, 'graphyard');
  assert.equal(work.blocker, before.blocker, 'no approver blocker is written');
  assert.equal((await events(work)).filter(entry => entry.kind === 'scope.refused').length, 0);
  assert.equal(scopeRequestOutcome(work, { epoch: work.epoch, at: work.scopeRequest!.at, paths: ['src/server/routes/work.ts'] }, Date.now()).state, 'pending', 'the worker is not told to withdraw');
});

test('unit:scope-outcome-delivered — an outcome recorded before decisions carried their epoch is read by the attempt that asked it, and by no other', async () => {
  const work = await claimed('legacy outcome');
  await ask(work, [helper], 'The layout needs its measuring helper');
  const config = { ...loopConfig(), url };
  await approveScopeRequest(process.cwd(), config, [work.key, 'The helper is part of the layout criterion'], { coordinator: path => ok(token(coordinator), 'GET', path), operatorToken: async () => master.token });
  // As persisted before the upgrade: the request is cleared and its decision names no epoch.
  await store.pool.query("UPDATE work_items SET document=document #- '{scopeDecision,epoch}' WHERE id=$1", [work.id]);
  const legacy = await reload(work.id);
  assert.equal(legacy.scopeRequest, null);
  assert.equal(legacy.scopeDecision?.epoch, undefined);
  const heard = await awaitScopeOutcome({ api: path => ok(token(implementer), 'GET', path) }, legacy, work.epoch, { waitMs: 1_000, everyMs: 20, cli: 'graphyard' });
  assert.equal(heard.state, 'approved', 'the same live lease reads its legacy outcome');
  // A legacy outcome asked before this epoch's claim belongs to an earlier attempt.
  const earlier = { ...legacy, scopeDecision: { ...legacy.scopeDecision!, requestedAt: new Date(Date.parse(legacy.lastAssignment!.claimedAt!) - 1_000).toISOString() } };
  await assert.rejects(awaitScopeOutcome({ api: path => ok(token(implementer), 'GET', path) }, earlier, work.epoch, { waitMs: 0 }), /no scope request for epoch/);
});

test('unit:scope-approver-routine — a decision still requested against a superseded policy revision is withdrawn and asked again against the current one', async () => {
  let work = await claimed('stale standing decision');
  await ask(work, [helper], 'The layout measures its breakpoints through a helper');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [first] = await standing(work);
  assert.equal(first.state, 'requested');
  const before = await reload(work.id);
  assert.equal(first.input.expectedPolicyRevision, before.policyRevision);
  // The requirements move on (a reviewpolicy change, say) while the decision is still requested.
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{policyRevision}',to_jsonb($2::int)) WHERE id=$1", [work.id, before.policyRevision + 1]);
  // A loop that restarted since holds no watch for it, so nothing but the request path meets it.
  const restarted = emptyDaemonState(loopConfig());
  for (let cycles = 0; cycles < 3 && (await standing(work)).filter((decision: any) => decision.state === 'requested' && decision.input.expectedPolicyRevision === before.policyRevision + 1).length === 0; cycles++) await loop.cycle(restarted);
  const decisions = await standing(work);
  assert.equal(decisions.find((decision: any) => decision.id === first.id)?.state, 'withdrawn', 'the stale decision is taken back rather than adopted');
  const current = decisions.filter((decision: any) => decision.state === 'requested');
  assert.equal(current.length, 1, 'one decision is asked against the current revision');
  assert.equal(current[0].input.expectedPolicyRevision, before.policyRevision + 1);
  assert.ok(loop.launched.includes(current[0].id), 'and an approver is launched for it');
  // Its approval now answers the request: the widening applies and the worker keeps its lease.
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: current[0].id, reason: 'The helper is AC-1 spelled out' });
  work = await reload(work.id);
  assert.ok(work.plannedFiles.includes(helper));
  assert.equal(work.lease?.epoch, before.epoch);
});

test('unit:scope-outcome-delivered — the wait judges lease liveness on the control plane clock, not the worker host', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString(), at = new Date().toISOString();
  const item = { id: 'clock-item', key: 'GY-9', plannedFiles: [layout], lease: { epoch: 2, owner: implementer.id, expiresAt }, scopeRequest: { epoch: 2, paths: [helper], reason: 'needed', requestedBy: implementer.id, at } } as unknown as Work;
  const wait = (now: string) => awaitScopeOutcome({ api: async path => { assert.equal(path, 'work-snapshot'); return { work: [item], now }; } }, item, 2, { waitMs: 0 });
  // The local clock says the lease is live; the server's says it has lapsed: the wait ends.
  assert.equal((await wait(new Date(Date.parse(expiresAt) + 1_000).toISOString())).state, 'ended');
  // And the other way round: a server that still holds the lease live keeps the request pending.
  const later = { ...item, lease: { ...item.lease!, expiresAt: new Date(Date.now() - 60_000).toISOString() } } as Work;
  const heard = await awaitScopeOutcome({ api: async () => ({ work: [later], now: new Date(Date.now() - 120_000).toISOString() }) }, later, 2, { waitMs: 0 });
  assert.equal(heard.state, 'pending', 'a lease the server still holds live is not ended by a host clock ahead of it');
});

test('unit:scope-approver-routine — a restarted loop adopts the decision already standing for the same request rather than withdrawing it', async () => {
  const work = await claimed('adopted after restart');
  await ask(work, [helper], 'The layout measures its breakpoints through a helper');
  const loop = harness();
  await loop.cycle(emptyDaemonState(loopConfig()));
  const [first] = await standing(work);
  assert.equal(first.state, 'requested');
  // The ledger returns `answers` with its keys reordered (jsonb): it is still the same request.
  const restarted = emptyDaemonState(loopConfig());
  for (let cycles = 0; cycles < 3 && !Object.values(restarted.approvals).some(watch => watch.decision === first.id); cycles++) await loop.cycle(restarted);
  const decisions = await standing(work);
  assert.deepEqual(decisions.map((decision: any) => [decision.id, decision.state]), [[first.id, 'requested']], 'the standing decision is adopted, not withdrawn and asked again');
  assert.ok(Object.values(restarted.actions).some(action => action.work === work.key && /^Adopted decision/.test(action.detail)));
});

test('unit:scope-approver-routine — a decision still requested when a partial widening moved plannedFiles is withdrawn by a restarted loop, not left to itself as a master\'s revision', async () => {
  let work = await claimed('stale decision after partial widening');
  await ask(work, [helper], 'The layout measures its breakpoints through a helper');
  const loop = harness();
  await loop.cycle(emptyDaemonState(loopConfig()));
  const [first] = await standing(work);
  assert.equal(first.state, 'requested');
  const before = await reload(work.id), other = 'src/widget/theme.ts';
  // Another additive widening lands that does not cover the request: plannedFiles and the policy
  // revision both move, and the request stays open.
  await store.pool.query("UPDATE work_items SET document=jsonb_set(jsonb_set(document,'{policyRevision}',to_jsonb($2::int)),'{plannedFiles}',$3::jsonb) WHERE id=$1", [work.id, before.policyRevision + 1, JSON.stringify([...before.plannedFiles, other])]);
  assert.ok((await reload(work.id)).scopeRequest, 'the request is still open');
  const restarted = emptyDaemonState(loopConfig());
  for (let cycles = 0; cycles < 3 && (await standing(work)).filter((decision: any) => decision.state === 'requested' && decision.input.expectedPolicyRevision === before.policyRevision + 1).length === 0; cycles++) await loop.cycle(restarted);
  const decisions = await standing(work);
  assert.equal(decisions.find((decision: any) => decision.id === first.id)?.state, 'withdrawn', 'the loop\'s own stale decision is taken back, not treated as another requester\'s');
  const current = decisions.filter((decision: any) => decision.state === 'requested');
  assert.equal(current.length, 1);
  assert.equal(current[0].input.expectedPolicyRevision, before.policyRevision + 1);
  assert.ok(current[0].input.plannedFiles.includes(other) && current[0].input.plannedFiles.includes(helper), 'asked against the current file list');
  assert.ok(loop.launched.includes(current[0].id));
  assert.ok(!Object.values(restarted.actions).some(action => action.work === work.key && action.state === 'failed' && /left to its requester/.test(action.detail)));
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: current[0].id, reason: 'The helper is AC-1 spelled out' });
  work = await reload(work.id);
  assert.ok(work.plannedFiles.includes(helper) && work.plannedFiles.includes(other));
  assert.equal(work.lease?.epoch, before.epoch);
});

test('unit:scope-outcome-delivered — after a partial widening, a refusal names only the paths still outside plannedFiles', async () => {
  let work = await claimed('refused after a partial widening');
  const route = 'src/server/routes/work.ts';
  await ask(work, [helper, route], 'The layout needs its measuring helper and the route');
  // Another additive widening plans the helper; the request stays open for the route alone.
  const asked = await reload(work.id);
  await ok(master.token, 'POST', `work/${work.id}/requirements`, { expectedPolicyRevision: asked.policyRevision, criteria: asked.criteria, dependencies: asked.dependencies, plannedFiles: [layout, helper], exclusiveResources: asked.exclusiveResources ?? [], producerProofs: asked.producerProofs ?? [], reason: 'The helper is part of the layout criterion' });
  work = await reload(work.id);
  assert.ok(work.scopeRequest, 'a partial widening leaves the request open');
  assert.equal(work.lease?.epoch, asked.epoch, 'and the worker keeps its lease');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [requested] = await standing(work);
  assert.ok(requested, 'the loop asks the approver about the rest');
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: requested.id, reason: 'The route belongs to another item' });
  work = await reload(work.id);
  assert.equal(work.scopeDecision!.decidedBy, approver.id);
  assert.deepEqual(work.scopeDecision!.paths, [route], 'the recorded refusal is of the route alone');
  const told = scopeRequestOutcome(work, { epoch: work.epoch, at: work.scopeRequest!.at, paths: [helper, route] }, Date.now());
  assert.equal(told.state, 'refused');
  assert.match(told.text, /for src\/server\/routes\/work\.ts was refused/);
  assert.doesNotMatch(told.text, /measure\.ts/, 'the helper, now planned, is not among the paths to finish without');
});

test('unit:scope-approver-routine — a routed request stays open in the blocked-time budget until the approver answers, and its wait is measured to that answer', async () => {
  let work = await claimed('budget counts the approver wait');
  const asked = await ask(work, [helper], 'The layout measures its breakpoints through a helper');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  work = await reload(work.id);
  assert.equal(work.scopeRequest!.decision!.decidedBy, 'graphyard', 'the rule refused it and the loop routed it');
  assert.equal(state.scope.filter(entry => entry.work === work.key).length, 0, 'the rule refusal is not the answer the worker waits on, so it is not measured');

  // Past the blocked bound with the approver still judging: the request is open and breaches.
  const later = Date.parse(asked.scopeRequest!.at) + scopeBlockedBudgetMs + 60_000;
  const live = { ...work, lease: { ...work.lease!, expiresAt: new Date(later + 60_000).toISOString() } };
  const routed = scopeBudget([live], [], later, true);
  assert.deepEqual(routed.open.map(entry => entry.key), [work.key], 'the approver wait counts');
  assert.equal(routed.breaches.length, 1);
  assert.match(routed.breaches[0].detail, /with the independent approver: read it with graphyard master decisions/);
  assert.doesNotMatch(routed.breaches[0].detail, /master scope/, 'a routed request never names master scope');
  assert.equal(scopeBudget([live], [], later, false).open.length, 0, 'a loop that routes nothing leaves the rule refusal to its master scope escalation');

  const [requested] = await standing(work);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'The helper is the layout criterion spelled out' });
  await loop.cycle(state);
  const measured = state.scope.filter(entry => entry.work === work.key);
  assert.equal(measured.length, 1, 'one sample, taken when the approver answered');
  assert.equal(measured[0].state, 'approved');
  work = await reload(work.id);
  assert.equal(scopeBudget([work], [], Date.now(), true).open.length, 0, 'an answered request is no longer open');
});

test('unit:scope-approver-routine — a routed wait is measured to the time the control plane recorded the answer, not to when a stopped loop next observes it', async () => {
  const delayMs = 45 * 60_000;
  for (const verdict of ['approve', 'refuse'] as const) {
    let work = await claimed(`measured to the recorded ${verdict}`);
    const asked = await ask(work, [helper], 'The layout measures its breakpoints through a helper');
    const loop = harness(), state = emptyDaemonState(loopConfig());
    await loop.cycle(state);
    const [requested] = await standing(work);
    await ok(approver.token, 'POST', `work/${work.id}/approve`, verdict === 'approve'
      ? { decision: requested.id, reason: 'The helper is the layout criterion spelled out' }
      : { action: 'refuse', decision: requested.id, reason: 'AC-1 needs only the layout' });
    work = await reload(work.id);
    const answeredAt = Date.parse(work.scopeDecision!.at);
    // The loop was stopped: its next cycle observes the answer long after it was recorded.
    const snapshot = loop.effects.snapshot;
    loop.effects.snapshot = async () => { const read = await snapshot(); return { ...read, now: new Date(Date.parse(read.now) + delayMs).toISOString() }; };
    await loop.cycle(state);
    const measured = state.scope.filter(entry => entry.work === work.key);
    assert.equal(measured.length, 1, `one sample for the ${verdict}`);
    assert.equal(measured[0].state, verdict === 'approve' ? 'approved' : 'refused');
    assert.ok(Math.abs(Date.parse(measured[0].at) - answeredAt) < 5_000, `the sample ends at the recorded ${verdict}, not the late observation`);
    assert.ok(measured[0].waitedMs < delayMs / 2, `the loop's own delay is not charged to the ${verdict}: ${measured[0].waitedMs}ms`);
    assert.equal(measured[0].waitedMs, Math.max(0, Date.parse(measured[0].at) - Date.parse(asked.scopeRequest!.at)));
    assert.equal(Object.values(state.actions).filter(action => action.kind === 'scope' && action.work === work.key && new RegExp(`^${verdict === 'approve' ? 'Approved' : 'Refused'} ${work.key}'s scope request .* through requirements decision`).test(action.detail)).length, 1, `the ${verdict} is noted`);
  }
});

test('unit:scope-approver-routine — a refusal that did not answer the routed request is neither measured nor reported to the worker', async () => {
  let work = await claimed('stale refusal is not an outcome');
  await ask(work, ['src/server/routes/work.ts'], 'The route would be easier to change here too');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [requested] = await standing(work);
  const before = await reload(work.id);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{policyRevision}',to_jsonb($2::int)) WHERE id=$1", [work.id, before.policyRevision + 1]);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: requested.id, reason: 'Judged against the old requirements' });
  work = await reload(work.id);
  assert.equal(work.scopeDecision!.decidedBy, 'graphyard', 'the control plane left the request as it stood');
  assert.equal(scopeOutcomeAnswered(work, { epoch: work.epoch, at: work.scopeRequest!.at, paths: ['src/server/routes/work.ts'] }, { state: 'refused', refusal: { at: new Date(Date.now() - 1000).toISOString() } }, Date.now()), 'unanswered');
  await loop.cycle(state);
  assert.equal(state.scope.filter(entry => entry.work === work.key).length, 0, 'no refused sample for an outcome the worker never sees');
  const notes = Object.values(state.actions).filter(action => action.kind === 'scope' && action.work === work.key).map(action => action.detail);
  assert.equal(notes.filter(detail => new RegExp(`^Refused ${work.key}'s scope request .* through requirements decision`).test(detail)).length, 0, 'no refusal reported to the worker');
  assert.ok(notes.some(detail => detail.includes(`did not answer ${work.key}'s scope request`)), notes.join('\n'));
});

test('unit:scope-approver-routine — a refusal recorded after the loop\'s observation is settled from an observation that shows it, then measured once', async () => {
  let work = await claimed('refusal after the observation');
  await ask(work, ['src/server/routes/work.ts'], 'The route would be easier to change here too');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [requested] = await standing(work);
  // The loop's next read was taken before the approver refused.
  const read = loop.effects.snapshot, earlier = await read();
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: requested.id, reason: 'The route belongs to another item' });
  loop.effects.snapshot = async () => earlier;
  await loop.cycle(state);
  const watch = Object.values(state.approvals).find(entry => entry.decision === requested.id)!;
  assert.equal(watch.settledAt, null, 'an observation that predates the refusal cannot say whether it answered');
  assert.equal(state.scope.filter(entry => entry.work === work.key).length, 0);
  loop.effects.snapshot = read;
  await loop.cycle(state);
  const measured = state.scope.filter(entry => entry.work === work.key);
  assert.deepEqual(measured.map(entry => entry.state), ['refused'], 'measured once the refusal is observed on the item');
  work = await reload(work.id);
  assert.ok(Math.abs(Date.parse(measured[0].at) - Date.parse(work.scopeDecision!.at)) < 5_000, 'the sample ends at the recorded refusal');
});

test('unit:scope-outcome-delivered — while the approver judges a routed request, the master status row and owed action name the approver, not master unblock', async () => {
  const work = await claimed('status row names the approver');
  await ask(work, ['src/server/routes/work.ts'], 'The route would be easier to change here too');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const [requested] = await standing(work);
  const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot') as { work: Work[]; now: string };
  const mine = { work: snapshot.work.filter(item => item.id === work.id), now: snapshot.now };
  const plain = buildMasterStatus(mine, [], []);
  const unrouted = plain.work.find(row => row.key === work.key)!;
  assert.ok(unrouted.attention, 'the rule refusal is the row attention');
  const approvals = daemonSummary(state, Date.now(), 30_000).approvals;
  const status = routedScopeStatus(plain, mine.work, approvals);
  const row = status.work.find(entry => entry.key === work.key)!;
  assert.match(row.attention!, /is with the independent approver/);
  assert.equal(row.attentionOwner!.approvedBy, 'approver');
  assert.match(row.attentionOwner!.next, new RegExp(`requirements decision ${requested.id}`));
  assert.doesNotMatch(`${row.attention} ${row.attentionOwner!.next}`, /master (unblock|scope|decide)|Clear the cause/);
  const items = status.attentionItems.filter(item => item.subject === work.key);
  assert.ok(items.length >= 1 && items.every(item => !/master (unblock|scope)|Clear the cause/.test(`${item.text} ${item.next}`)), JSON.stringify(items));
  const owed = owedAttention(mine, status.work, []);
  const escalated = owed.rows.filter(entry => entry.key === work.key && entry.source === 'action');
  assert.ok(escalated.length >= 1, "the rule refusal's escalation is owed");
  assert.ok(escalated.every(entry => entry.resolve === (row as { routedScope?: string }).routedScope && /approver/.test(entry.decision)), JSON.stringify(escalated));
  // Once the approver answers, the row is the item's own again.
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision: requested.id, reason: 'The route belongs to another item' });
  await loop.cycle(state);
  const after = await ok(token(coordinator), 'GET', 'work-snapshot') as { work: Work[]; now: string };
  const answered = { work: after.work.filter(item => item.id === work.id), now: after.now };
  const settled = buildMasterStatus(answered, [], []);
  assert.deepEqual(routedScopeStatus(settled, answered.work, daemonSummary(state, Date.now(), 30_000).approvals).work, settled.work);
});
