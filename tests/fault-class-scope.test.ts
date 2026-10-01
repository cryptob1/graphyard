import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { actionDetailMax, emptyDaemonState, runCycle, scopeKey, answeringWidening, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { decisionInput, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { automaticScopeGrounds } from '../src/daemon/cycle-scope.js';
import * as scopeRules from '../src/model/scope.js';
import { decideScopeRequest, pinningTestGround, redecidableScopeRefusal, routableScopeRequest, scopeRefusalBlocker, type ScopeRequestState } from '../src/model/scope.js';
// The rules this change adds are read through the module, so the same file runs against the base:
// there each test fails on the behaviour it reproduces, not on a missing import.
const { documentationTestGround, touchesDocumentation } = scopeRules as Partial<typeof scopeRules> as typeof scopeRules;
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-954: the scope class recurred past its threshold on GY-945 and GY-883. Each test below is
// named for the instance it reproduces: against the base the ask refuses whole (one ungrounded
// companion refusing the paths the item already implies) and the loop's re-decide fails with
// "The current rules still refuse this scope request"; against this candidate the same ask is
// decided per path — what the rules imply is granted in the same answer, the rest is refused for
// exactly itself and routed to the independent approver — and a re-decide reads the control
// plane's standing answer back instead of failing. Each test is named for the proof it produces.
const repository = 'owner/fault-class-scope';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `fault-class-scope-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, operatorTokenFile: string;

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
const layout = 'src/widget/Layout.tsx';
const criteria = [{ id: 'AC-1', text: `The widget layout renders from ${layout}`, proofs: ['unit:layout'] }];

async function claimed(title: string, plannedFiles: string[] = [layout]) {
  let work = await ok(master.token, 'POST', 'work', { title, plannedFiles, criteria, reason: 'Operator goal: the scope machinery answers a change\'s own companions without a fault' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the fault-class-scope attempt' }) as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'scope-host', path: `/tmp/fault-class-scope/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  return reload(work.id);
}
const request = (work: Work, body: Record<string, unknown>) => ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, ...body }) as Promise<Work>;

const loopConfig = () => masterConfigSchema.parse({ version: 1, url, credentialFile: join(tmpdir(), 'fault-class-scope-coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-fcs', workers: [] }) as MasterConfig;
const loopEffects = (overrides: Partial<DaemonEffects> = {}, snapshot?: { work: unknown[]; now: string }): DaemonEffects => ({
  agents: () => [],
  credentials: async () => ({}),
  snapshot: async () => {
    if (snapshot) return { work: snapshot.work as Work[], now: snapshot.now };
    const fresh = await ok(token(coordinator), 'GET', 'work-snapshot');
    return { work: fresh.work as Work[], now: fresh.now };
  },
  closeSession: () => {},
  dispatch: async () => {},
  requestProof: () => {},
  merge: async () => ({}),
  observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
  recordDeployment: async () => {},
  requestSmoke: () => {},
  decideScope: work => ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.scopeRequest!.epoch }) as Promise<Work>,
  persist: async () => {},
  ...overrides,
});
const cycle = (state: DaemonState, overrides: Partial<DaemonEffects> = {}, stale?: { work: unknown[]; now: string }) =>
  runCycle(loopConfig(), state, loopEffects(overrides, stale), () => Date.now());
const scopeAction = (state: DaemonState, work: Work, at: string) => state.actions[scopeKey(work, { epoch: work.epoch, paths: [], reason: '', requestedBy: '', at })];
const escalations = (state: DaemonState) => Object.entries(state.actions).filter(([, action]) => action.kind === 'escalation').map(([key, action]) => ({ key, ...action }));

const scopeApprover = { id: 'scope-approver', token: `scope-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
let scopeApproverReady = false;
async function ensureScopeApprover() {
  if (scopeApproverReady) return;
  await ok(token(operator), 'POST', 'operator-agents', { id: scopeApprover.id, displayName: scopeApprover.id, capabilities: scopeApprover.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: scopeApprover.token, reason: 'Onboarding provisions the independent approver agent' });
  scopeApproverReady = true;
}
type Decided = { id: string; action: string; reason: string; input: Record<string, unknown> };
function scopeDecisionEffects(decided: Decided[], approvers: string[], mine: () => string[]): Partial<DaemonEffects> {
  return {
    herdr: async () => ({ agents: [], available: true }),
    decide: async (item, action, reason, input = {}) => {
      const requested = await ok(master.token, 'POST', `work/${item.id}/decide`, { action, input: decisionInput(action, item, input), reason });
      if (mine().includes(item.id)) decided.push({ id: requested.id, action, reason, input });
      return requested;
    },
    decisions: item => ok(master.token, 'GET', `work/${item.id}/decisions`),
    withdraw: (item, decision, reason) => ok(master.token, 'POST', `work/${item.id}/decide`, { action: 'withdraw', decision, reason }),
    approver: async (item, decision) => { if (mine().includes(item.id)) approvers.push(decision); return { agentName: `graphyard-approver-${approvers.length}`, pane: null }; },
  };
}
const widenAsMaster = (widened: string[][]) => async (item: Work, asked: ScopeRequestState, paths: string[], reason: string) => {
  widened.push(paths);
  return ok(master.token, 'POST', `work/${item.id}/requirements`, answeringWidening(item, asked, paths, reason));
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_FAULT_CLASS_SCOPE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 57);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('fault-class-scope-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('fault_class_scope_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/fault_class_scope_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await ok(token(operator), 'POST', 'operator-agents', { id: master.id, displayName: master.id, capabilities: master.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: master.token, reason: 'Onboarding provisions the master operator agent' });
  operatorTokenFile = join(await temporaryDirectory('fault-class-scope'), 'operator.token');
  await writeFile(operatorTokenFile, `${master.token}\n`, { mode: 0o600 });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:fault-class-scope-per-path — GY-945\'s ask is decided per path: the guide it must edit is granted in the same answer and only the companions nothing implies are refused', () => {
  // GY-945 as it was asked: nothing it planned reaches the docs tree, its criteria name no paths.
  // The base refused this very ask whole, naming all five files, the implied guide among them.
  const item = { plannedFiles: [layout], criteria: [{ id: 'AC-1', text: 'A fleet panel in the web UI lists every registry account with its quota state.', proofs: ['unit:fleet'] }] };
  const ask = decideScopeRequest(item, { paths: ['docs/dashboard.md', 'web/pages/fleet.tsx', 'web/style.css', 'tests/fleet-panel.test.ts', 'tests/docs-budget.test.ts'] });
  assert.equal(ask.state, 'approved', ask.reason);
  assert.deepEqual(ask.paths, ['docs/dashboard.md'], 'the guide the documentation rule implies is granted in the same answer');
  assert.deepEqual(ask.rest, ['web/pages/fleet.tsx', 'web/style.css', 'tests/fleet-panel.test.ts', 'tests/docs-budget.test.ts'], 'only the companions nothing implies are refused');
  assert.match(ask.reason, /the rest \(web\/pages\/fleet\.tsx, web\/style\.css, tests\/fleet-panel\.test\.ts, tests\/docs-budget\.test\.ts\) are outside what this item's own criteria and the repository's documentation rule imply and go to the independent approver/);
  // GY-883's later ask mixed the same way: the guide beside two files nothing implies.
  const later = decideScopeRequest({ plannedFiles: ['src/model/policy.ts'], criteria: [] }, { paths: ['src/model/invariants.ts', 'tests/system-invariants.test.ts', 'docs/master-agent.md'] });
  assert.deepEqual([later.state, later.paths, later.rest], ['approved', ['docs/master-agent.md'], ['src/model/invariants.ts', 'tests/system-invariants.test.ts']]);
  // A refusal still refuses only itself, and the rest stays routable to the approver.
  const gate = { plannedFiles: [layout, 'docs/dashboard.md'], criteria: item.criteria, lease: { epoch: 1, expiresAt: new Date(Date.now() + 300_000).toISOString() }, scopeRequest: { epoch: 1, paths: ask.rest!, reason: 'they break', requestedBy: 'w', at: '2026-09-29T06:30:57.512Z', decision: { state: 'refused' as const, reason: ask.reason, at: ask.reason, decidedBy: 'graphyard', waitedMs: 1, paths: ask.rest!, requestedBy: 'w', requestedAt: '2026-09-29T06:30:57.512Z' } } };
  const routed = routableScopeRequest(gate, Date.now() + 1_000);
  assert.ok(routed, 'the narrowed rest is routable to the approver');
  assert.deepEqual(routed!.paths, ask.rest);
});

test('unit:fault-class-scope-rest — GY-883\'s ask, which no rule implies, is refused whole and routed to the approver with the item\'s own criteria in the decision it judges', () => {
  const item = { plannedFiles: ['src/model/policy.ts', 'src/model/gates.ts'], criteria: [{ id: 'AC-2', text: 'In src/model/gates.ts a low-lane item is landable with its required CI checks green and one approving review.', proofs: ['unit:lanes'] }] };
  const ask = ['tests/auto-rebase.test.ts', 'tests/bootstrap-policy.test.ts', 'tests/queue-carry.test.ts'];
  const verdict = decideScopeRequest(item, { paths: ask });
  assert.equal(verdict.state, 'refused', 'nothing implies the policy tests, so the rule refuses them');
  assert.equal(verdict.rest, undefined, 'a refusal is whole, with no granted part beside it');
  assert.match(verdict.reason, /tests\/auto-rebase\.test\.ts, tests\/bootstrap-policy\.test\.ts, tests\/queue-carry\.test\.ts are outside what this item's own criteria/);
  const withRequest = { ...item, scopeRequest: { epoch: 1, paths: ask, reason: 'they pin the policy this change rewrites', requestedBy: 'w', at: '2026-09-29T07:04:10.214Z', decision: { state: 'refused' as const, reason: verdict.reason, at: 'x', decidedBy: 'graphyard', waitedMs: 1, paths: ask, requestedBy: 'w', requestedAt: '2026-09-29T07:04:10.214Z' } }, lease: { epoch: 1, expiresAt: new Date(Date.now() + 300_000).toISOString() } };
  const routed = routableScopeRequest(withRequest, Date.now());
  assert.ok(routed, 'the refusal is routable: the approver decides it, the item is never left undecided');
  assert.deepEqual(routed!.paths, ask);
});

test('unit:fault-class-scope-docs-gate — a test that reads the documentation is grounded when the change touches it, and never when it does not', async () => {
  const docs = ['docs/', 'AGENTS.md', 'README.md'];
  const budget = `// The documentation budget: README.md and docs/ total at most 13,100 words.\n`;
  assert.equal(documentationTestGround('tests/docs-budget.test.ts', budget, docs), 'tests/docs-budget.test.ts reads the documentation (docs/) this change rewrites');
  assert.equal(documentationTestGround('src/model/scope.ts', budget, docs), null, 'only a test file is grounded this way');
  assert.equal(documentationTestGround('tests/docs-budget.test.ts', 'export {};\n', docs), null, 'a test that names no documentation path is not grounded');
  assert.ok(touchesDocumentation({ plannedFiles: ['docs/'] }, []), 'an item whose scope reaches the docs touches them');
  assert.ok(touchesDocumentation({ plannedFiles: ['src/a.ts'] }, ['docs/b.md']), 'an ask for a guide touches the docs');
  assert.ok(!touchesDocumentation({ plannedFiles: ['src/a.ts'] }, ['tests/x.test.ts']), 'a source-only change does not');
  // The ground flows through the loop's grounding: the budget test is granted beside a docs ask,
  // and refused for an item that never touches the documentation.
  const read = async (path: string) => path === 'tests/docs-budget.test.ts' ? budget : null;
  const exists = (path: string) => path === 'tests/docs-budget.test.ts';
  const ask = (request: Pick<ScopeRequestState, 'paths' | 'reason'>, plannedFiles: string[]) => automaticScopeGrounds(
    { plannedFiles, criteria } as Work, { epoch: 1, requestedBy: 'w', at: 'x', ...request } as ScopeRequestState, request.paths, [], exists, read);
  const withDocs = await ask({ paths: ['tests/docs-budget.test.ts', 'docs/budget.md'], reason: 'The gate breaks on the rewrite' }, ['docs/']);
  assert.deepEqual(withDocs.grounds?.map(entry => entry.path), ['tests/docs-budget.test.ts'], JSON.stringify(withDocs));
  const withoutDocs = await ask({ paths: ['tests/docs-budget.test.ts'], reason: 'The gate breaks on the rewrite' }, ['src/a.ts']);
  assert.match((withoutDocs as { refusal: string }).refusal, /tests\/docs-budget\.test\.ts/, 'no documentation in play, no ground');
  assert.equal(pinningTestGround('tests/docs-budget.test.ts', 'no quoted assertion', budget, []), null, 'the gate quotes no failing assertion, so only this rule carries it');
});

test('integration:fault-class-scope-decide — GY-945\'s ask is answered without an operator: the guide widens in the decide, the gate test is grounded, and the rest routes to the approver', async () => {
  await ensureScopeApprover();
  let work = await claimed('fleet panel');
  const state = emptyDaemonState(loopConfig());
  const decided: Decided[] = [], approvers: string[] = [], widened: string[][] = [];
  const overrides: Partial<DaemonEffects> = {
    ...scopeDecisionEffects(decided, approvers, () => [work.id]),
    reviewFindings: async () => [],
    basePaths: async paths => new Set(paths),
    baseText: async path => path === 'tests/docs-budget.test.ts' ? '// README.md and docs/ word budget\n' : null,
    widenScope: widenAsMaster(widened),
  };
  const rest = ['web/pages/fleet.tsx', 'web/style.css', 'tests/fleet-panel.test.ts'];
  const ask = await request(work, { paths: ['docs/dashboard.md', ...rest, 'tests/docs-budget.test.ts'],
    reason: 'The fleet panel needs its page, its styles, its test, the docs guide and the budget gate the rewrite breaks' });
  assert.equal(ask.scopeRequest!.decision, undefined, 'a fresh ask is undecided');
  await cycle(state, overrides);
  work = await reload(work.id);
  // The decision the control plane recorded is per path: the guide widened in the same
  // transaction that answered, and the request stands narrowed to the rest.
  assert.ok(work.plannedFiles.includes('docs/dashboard.md'), `widened: ${work.plannedFiles}`);
  assert.deepEqual(work.scopeDecision!.paths, ['docs/dashboard.md']);
  assert.match(work.scopeDecision!.reason, /additive scope the item already implies/);
  assert.equal(work.scopeRequest!.decision!.state, 'refused');
  assert.match(work.scopeRequest!.decision!.reason, /the independent approver decides scope the item does not already carry/);
  assert.ok(work.blocker?.startsWith(scopeRefusalBlocker));
  assert.ok(!work.scopeRequest!.decision!.reason.includes('docs/dashboard.md'), 'no refusal names a path the rules granted');
  // In the same cycle the loop grounds the gate test from what it read on the base, and the
  // request stands narrowed to what only the approver may grant.
  assert.ok(work.plannedFiles.includes('tests/docs-budget.test.ts'), `the gate test is grounded: ${work.plannedFiles}`);
  assert.deepEqual(work.scopeRequest!.paths.filter(path => !work.plannedFiles.includes(path)), rest, 'the rest is exactly what no rule grounds');
  const grounding = Object.entries(state.actions).find(([key]) => key.includes(work.id) && key.includes(':finding:'))![1];
  assert.equal(grounding.state, 'done', grounding.detail);
  assert.match(grounding.detail, /Partly widened .*tests\/docs-budget\.test\.ts reads the documentation/);
  assert.match(grounding.detail, /The rest goes to the approver/);
  assert.equal(decided.length, 0, 'nothing is requested against the pre-widening revision');
  // The widening is a new policy revision, whose findings are not judged yet: no decision is
  // attempted against the stale one, so no failed action:decision is recorded either.
  assert.ok(!Object.keys(state.actions).some(key => key.startsWith('decision:requirements:')), 'no decision is attempted against the revision the widening replaced');
  // The next cycle judges the findings at the new revision and requests it against the item as the widening left it.
  await cycle(state, overrides);
  assert.equal(decided.length, 1, JSON.stringify(decided));
  assert.equal(decided[0].action, 'requirements');
  assert.deepEqual((decided[0].input.plannedFiles as string[]).slice(-rest.length), rest, 'the approver is asked for exactly the rest');
  assert.deepEqual(decided[0].input.answers, { epoch: ask.scopeRequest!.epoch, at: ask.scopeRequest!.at });
  assert.equal(approvers.length, 1, 'an independent approver is launched for it');
  assert.ok(!escalations(state).some(entry => entry.key.startsWith(`escalation:scope:${work.id}`)), 'nothing is left to a master session');
  assert.ok(work.lease && work.lease.epoch === ask.epoch, 'the attempt keeps its lease');
  assert.ok(Object.values(state.actions).every(action => action.detail.length <= actionDetailMax), 'every action detail is within its bound');

  // The approver grants the rest: the request clears and the item is whole.
  await ok(scopeApprover.token, 'POST', `work/${work.id}/approve`, { decision: decided[0].id, reason: 'The fleet panel page, styles and test implement the criteria' });
  work = await reload(work.id);
  assert.equal(work.scopeRequest, null, 'the answered request is cleared');
  assert.equal(work.blocker, null, 'the blocker clears');
  assert.ok(rest.every(path => work.plannedFiles.includes(path)), `widened: ${work.plannedFiles}`);
  assert.equal(redecidableScopeRefusal(work), false, 'no refusal stands to re-decide');
});

test('integration:fault-class-scope-redecide — GY-945\'s and GY-883\'s action:scope: a re-decide of a refusal the rules still give answers with the standing refusal instead of failing', async () => {
  let work = await claimed('standing refusal is the answer');
  const state = emptyDaemonState(loopConfig());
  // Loop one decides the ask: refused, the item blocked on the recorded reason.
  await request(work, { paths: ['web/pages/overview.tsx'], reason: 'It links to the guides this item moves' });
  await cycle(state, { reviewFindings: async () => [], basePaths: async paths => new Set(paths) });
  work = await reload(work.id);
  assert.equal(work.scopeRequest!.decision!.state, 'refused');
  assert.ok(work.blocker?.startsWith(scopeRefusalBlocker));
  const decision = work.scopeRequest!.decision!, revision = work.policyRevision, blocker = work.blocker;
  // Loop two holds the snapshot taken before that answer: its request is undecided, so it asks
  // the control plane to decide. The base refused this call with "The current rules still refuse
  // this scope request" and recorded the failed action:scope fault this item closes; the
  // candidate reads the control plane's standing answer back.
  const stale = await ok(token(coordinator), 'GET', 'work-snapshot');
  await cycle(state, { reviewFindings: async () => [], basePaths: async paths => new Set(paths) }, { work: stale.work, now: stale.now });
  const second = scopeAction(state, work, work.scopeRequest!.at);
  assert.ok(second, 'the stale loop did ask for the decision');
  assert.equal(second.state, 'done', second.detail);
  assert.match(second.detail, new RegExp(`Refused ${work.key}'s scope request`));
  assert.doesNotMatch(second.detail, /Could not decide/);
  assert.ok(!Object.entries(state.actions).some(([, action]) => action.kind === 'scope' && action.state === 'failed' && action.work === work.key), 'no action:scope fault is recorded');
  work = await reload(work.id);
  assert.equal(work.scopeRequest!.decision!.reason, decision.reason, 'the standing refusal stands');
  assert.equal(work.policyRevision, revision, 'reading the answer back widens nothing');
  assert.equal(work.blocker, blocker);
  // A direct call the executor or a third loop could make reads the same answer.
  const again = await call(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.scopeDecision.reason, decision.reason);
  assert.deepEqual(again.body.plannedFiles, work.plannedFiles);
  // A refusal the current rules would approve is still re-decided and applied: once the item
  // plans the whole docs/ tree the rule implies the consumer it asked for, and the re-decide
  // grants it. An approval never is.
  await ok(master.token, 'POST', `work/${work.id}/requirements`, { expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies,
    plannedFiles: [...work.plannedFiles, 'docs/'], exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], reason: 'The item rewrites the whole documentation tree' });
  work = await reload(work.id);
  assert.equal(redecidableScopeRefusal(work), true);
  await cycle(state, { reviewFindings: async () => [], basePaths: async paths => new Set(paths) });
  work = await reload(work.id);
  assert.equal(work.scopeRequest, null, 'the re-decided request is answered and cleared');
  assert.equal(work.scopeDecision!.state, 'approved');
  assert.ok(work.plannedFiles.includes('web/pages/overview.tsx'));
  await cycle(state);
  assert.equal((await reload(work.id)).policyRevision, work.policyRevision, 'an approval is never re-decided');
});
