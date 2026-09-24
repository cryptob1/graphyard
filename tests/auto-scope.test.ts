import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { approveScopeRequest } from '../src/cli/master-status.js';
import { actionDetailMax, emptyDaemonState, findingRecheckMs, runCycle, scopeBudget, scopeKey, answeringWidening, type DaemonEffects, type DaemonState, type ScopeMeasurement } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { decideScopeRequest, documentationConsumerScopes, impliedScopes, namedPaths, redecidableScopeRefusal, scopeBlockedBudgetMs, scopeDecisionBudgetMs, scopeRefusalBlocker, type ScopeRequestState } from '../src/model/scope.js';
import { regressionRefusals } from '../src/regression-guard.js';
import { basePaths, findingScope, namesPath, readReviewFindings } from '../src/review-scope.js';
import type { Observation, Principal, ScopeFile, Work } from '../src/model.js';

// GY-85: an additive scope request is decided by the loop, not by a master command. A worker
// records the ask as structured state; the master loop asks the control plane to decide it on the
// cycle it appears; a request the item's own criteria or this repository's documentation rule
// already imply is applied to the live item with an audited reason, and everything wider is
// refused, escalated with the reason, and left blocking the item until an operator decides it.
// Each test is named for the proof it produces.
const repository = 'owner/auto-scope';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
// The loop's entire authority: a coordinator token. It holds no operator credential at all, so
// nothing it does here could have come from a master session.
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `auto-scope-${principal.id}-${'x'.repeat(32)}` }));
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
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows;
const layout = 'src/widget/Layout.tsx', theme = 'src/widget/Theme.ts';
const themeFile: ScopeFile = { path: theme, status: 'modified', sha: 'c'.repeat(40), baseSha: 'd'.repeat(40), additions: 6, deletions: 1, binary: false };
const criteria = [
  { id: 'AC-1', text: `The widget layout renders from ${layout}`, proofs: ['unit:layout'] },
  { id: 'AC-2', text: `The palette it renders with is read from ${theme}`, proofs: ['unit:theme'] },
];
const input = (title: string) => ({ title, plannedFiles: [layout], criteria, reason: 'Operator goal: a worker never waits on a session for scope its item already implies' });

async function claimed(title: string) {
  let work = await ok(master.token, 'POST', 'work', input(title)) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the auto-scope attempt' }) as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'scope-host', path: `/tmp/auto-scope/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  return reload(work.id);
}
const request = (work: Work, body: Record<string, unknown>) => ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, ...body }) as Promise<Work>;

const loopConfig = () => masterConfigSchema.parse({ version: 1, url, credentialFile: join(tmpdir(), 'auto-scope-coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-auto-scope', workers: [] }) as MasterConfig;
/**
 * The loop as it really runs: one coordinator credential, the bounded snapshot it polls, and the
 * one scope call it makes. `skew` moves the clock the cycle reads forward, which is how a request
 * nobody answered becomes an aged one without waiting a quarter of an hour for it.
 */
const loopEffects = (overrides: Partial<DaemonEffects> = {}, skewMs = 0): DaemonEffects => ({
  agents: () => [],
  credentials: async () => ({}),
  snapshot: async () => {
    const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot');
    return { work: snapshot.work as Work[], now: new Date(Date.parse(snapshot.now) + skewMs).toISOString() };
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
const cycle = (state: DaemonState, overrides: Partial<DaemonEffects> = {}, skewMs = 0) =>
  runCycle(loopConfig(), state, loopEffects(overrides, skewMs), () => Date.now() + skewMs);
const scopeAction = (state: DaemonState, work: Work, at: string) => state.actions[scopeKey(work, { epoch: work.epoch, paths: [], reason: '', requestedBy: '', at })];
const escalations = (state: DaemonState) => Object.entries(state.actions).filter(([, action]) => action.kind === 'escalation').map(([key, action]) => ({ key, ...action }));

before(async () => {
  const port = Number(process.env.GRAPHYARD_AUTO_SCOPE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 43);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-auto-scope-db-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('auto_scope_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/auto_scope_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await ok(token(operator), 'POST', 'operator-agents', { id: master.id, displayName: master.id, capabilities: master.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: master.token, reason: 'Onboarding provisions the master operator agent' });
  operatorTokenFile = join(await mkdtemp(join(tmpdir(), 'graphyard-auto-scope-')), 'operator.token');
  await writeFile(operatorTokenFile, `${master.token}\n`, { mode: 0o600 });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:auto-scope-approval — the loop decides an implied additive request and applies it to the live item, with no master session', async () => {
  let work = await claimed('implied widening');
  const asked = await request(work, { paths: [theme, 'docs/widget.md'], reason: 'The palette this item moves lives there, and the guide documents it' });
  // The ask is structured state, not a free-text blocker: paths, reason, requester, epoch, instant.
  assert.deepEqual(asked.scopeRequest, { epoch: work.epoch, paths: [theme, 'docs/widget.md'], reason: 'The palette this item moves lives there, and the guide documents it', requestedBy: implementer.id, at: asked.scopeRequest!.at });
  assert.equal(asked.scopeRequest!.decision, undefined, 'a fresh request is undecided');
  assert.equal(asked.blocker, null, 'asking never blocks the item');
  assert.ok(regressionRefusals(asked, { scopeFiles: [themeFile] }, []).length, 'before the decision the palette file is outside plannedFiles and refused');

  const state = emptyDaemonState(loopConfig());
  const result = await cycle(state);

  const action = scopeAction(state, work, asked.scopeRequest!.at);
  assert.equal(action.kind, 'scope');
  assert.equal(action.state, 'done');
  assert.equal(action.work, work.key);
  assert.equal(action.principal, implementer.id);
  assert.match(action.detail, new RegExp(`Widened ${work.key} with 2 files \\(${theme.replace(/\./g, '\\.')}, docs/widget\\.md\\)`));
  assert.match(action.detail, /AC-2 names src\/widget\/Theme\.ts/);
  assert.match(action.detail, /docs\/ is documentation this repository requires updating/);
  assert.ok(result.actions.some(entry => entry.kind === 'scope' && entry.state === 'done'), 'the cycle reports the decision it took');

  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, [layout, theme, 'docs/widget.md'], 'the implied paths are applied to the live item');
  assert.equal(work.policyRevision, asked.policyRevision + 1, 'the widening is an audited policy revision');
  assert.ok(work.lease && work.lease.owner === implementer.id && work.lease.epoch === asked.epoch, 'the attempt keeps its lease; nothing is handed back');
  assert.equal(work.blocker, null);
  assert.equal(work.scopeRequest, null, 'an applied request is answered and cleared');
  const decision = work.scopeDecision!;
  assert.equal(decision.state, 'approved');
  assert.deepEqual(decision.paths, [theme, 'docs/widget.md']);
  assert.equal(decision.requestedBy, implementer.id);
  assert.equal(decision.requestedAt, asked.scopeRequest!.at);
  assert.equal(decision.decidedBy, 'graphyard');
  assert.match(decision.reason, /additive scope the item already implies/);
  assert.ok(decision.waitedMs >= 0 && decision.waitedMs < scopeDecisionBudgetMs, `request to decision (${decision.waitedMs}ms) is inside the budget`);
  assert.equal(regressionRefusals(work, { scopeFiles: [themeFile] }, []).length, 0, 'the worker scope check sees the widened scope immediately');

  const ledger = await events(work);
  const applied = ledger.filter(entry => entry.kind === 'autoscope').at(-1)!;
  assert.equal(applied.actor, coordinator.id, 'the loop asked for the decision under its coordinator identity');
  assert.equal(applied.payload.details.decision.state, 'approved');
  assert.match(applied.payload.details.decision.reason, /AC-2 names src\/widget\/Theme\.ts/);
  assert.deepEqual(applied.payload.work.plannedFiles, [layout, theme, 'docs/widget.md']);
  assert.equal(ledger.filter(entry => entry.actor === master.id && entry.kind === 'requirements').length, 0, 'no master command revised the requirements');

  // A decided request is never decided twice, however long the loop keeps running.
  await cycle(state);
  assert.equal(scopeAction(state, work, asked.scopeRequest!.at).attempts, 1);
  assert.equal((await reload(work.id)).policyRevision, work.policyRevision);

  // The control plane decides; the caller does not. A coordinator asking for an epoch that no
  // longer has an undecided request is refused rather than obeyed.
  const repeated = await call(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  assert.equal(repeated.status, 404, JSON.stringify(repeated.body));
  assert.match(repeated.body.error, /No scope request is open/);
  const byWorker = await call(token(implementer), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  assert.equal(byWorker.status, 403, JSON.stringify(byWorker.body));
});

test('integration:scope-approval-boundary — a request beyond the implication, a removal, or a criteria change is refused, escalated, and blocks the item until it is decided', async () => {
  let work = await claimed('beyond the implication');
  const state = emptyDaemonState(loopConfig());

  // 1. A path neither the criteria nor the documentation rule imply: new scope, not this item's.
  const outside = await request(work, { paths: ['src/server/routes/work.ts'], reason: 'The route would be easier to change here too' });
  await cycle(state);
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, [layout], 'nothing is widened');
  assert.equal(work.policyRevision, outside.policyRevision, 'a refusal is not a revision');
  assert.equal(work.scopeRequest!.decision!.state, 'refused');
  assert.match(work.scopeRequest!.decision!.reason, /src\/server\/routes\/work\.ts is outside what this item's own criteria and the repository's documentation rule imply/);
  assert.ok(work.blocker?.startsWith(scopeRefusalBlocker), `the item is blocked on scope: ${work.blocker}`);
  assert.ok(work.gates.find(gate => gate.name === 'ready')!.reasons.includes(work.blocker!), 'the ready gate holds it until the refusal is decided');
  assert.ok(work.lease && work.lease.epoch === outside.epoch, 'the worker keeps its lease while the refusal stands');
  const escalated = escalations(state).find(entry => entry.key.startsWith(`escalation:scope:${work.id}`))!;
  assert.equal(escalated.work, work.key);
  assert.match(escalated.detail, /is blocked on scope/);
  assert.match(escalated.detail, /The route would be easier to change here too/);
  assert.match(escalated.detail, /is outside what this item's own criteria/);
  assert.match(escalated.detail, new RegExp(`graphyard master scope ${work.key}`));

  // A refused request is answered, so the loop leaves it alone; it does not churn.
  await cycle(state);
  assert.equal(scopeAction(state, work, work.scopeRequest!.at).attempts, 1);

  // Withdrawing the ask withdraws the refusal that was blocking the item.
  await request(work, { paths: [], reason: 'Withdrawn by the worker' });
  work = await reload(work.id);
  assert.equal(work.scopeRequest, null);
  assert.equal(work.blocker, null, 'the worker can unblock its own item by dropping the ask');

  // 2. A request that would drop planned containment, even though the path it adds is implied.
  const dropping = await request(work, { paths: ['docs/widget.md'], remove: [layout], reason: 'The layout file turned out to belong to another item' });
  await cycle(state);
  work = await reload(work.id);
  assert.match(work.scopeRequest!.decision!.reason, new RegExp(`the request drops planned paths \\(${layout.replace(/\./g, '\\.')}\\)`));
  assert.equal(work.scopeRequest!.decision!.state, 'refused');
  assert.deepEqual(work.plannedFiles, [layout], 'the planned scope is untouched, added paths included');
  assert.ok(work.blocker?.startsWith(scopeRefusalBlocker));
  assert.equal(work.policyRevision, dropping.policyRevision);

  // 3. A request that rewrites criteria or proofs is intent, and intent needs two parties.
  await request(work, { paths: ['docs/theme.md'], criteria: [{ id: 'AC-2', text: 'The palette is hard-coded', proofs: ['unit:theme'] }], reason: 'Reading the palette from a file is more work than it looked' });
  await cycle(state);
  work = await reload(work.id);
  assert.equal(work.scopeRequest!.decision!.state, 'refused');
  assert.match(work.scopeRequest!.decision!.reason, /rewrites criteria or proofs/);
  assert.deepEqual(work.criteria.map(criterion => ({ id: criterion.id, text: criterion.text, proofs: criterion.proofs })), criteria, 'the criteria the loop refused to touch are unchanged');
  assert.ok(work.blocker?.startsWith(scopeRefusalBlocker), 'the item stays blocked until it is decided');

  // The decision the loop refused to make is the operator's, and making it lifts the block.
  const decided = await approveScopeRequest(process.cwd(), { url, operatorAgent: { credentialFile: operatorTokenFile } } as unknown as MasterConfig, [work.key, 'The theme guide is in scope; the criteria stand as written'],
    { coordinator: path => ok(token(operator), 'GET', path) }) as Work;
  assert.deepEqual(decided.plannedFiles, [layout, 'docs/theme.md']);
  work = await reload(work.id);
  assert.equal(work.scopeRequest, null, 'the answered request is cleared');
  assert.equal(work.blocker, null, 'deciding it unblocks the item');
  assert.ok(work.gates.find(gate => gate.name === 'ready')!.passed);
  assert.ok(work.lease && work.lease.epoch === decided.epoch, 'the attempt never ended through any of it');
});

test('integration:scope-latency-budget — over more than ten requests the loop decides within five minutes at p90 and leaves nothing blocked on scope for fifteen', async () => {
  const items = [await claimed('latency one'), await claimed('latency two')];
  const state = emptyDaemonState(loopConfig());
  const rounds = 6;
  for (let round = 1; round <= rounds; round++) {
    for (const item of items) await request(item, { paths: [`docs/notes/${item.key.toLowerCase()}-${round}.md`], reason: `Round ${round} documents the behaviour this item changes` });
    const result = await cycle(state);
    assert.equal(result.actions.filter(action => action.kind === 'scope' && action.state === 'done').length, items.length, `round ${round} decided every open request in one cycle`);
    for (const item of items) {
      const current = await reload(item.id);
      assert.equal(current.scopeRequest, null);
      assert.equal(current.scopeDecision!.state, 'approved');
      assert.ok(current.plannedFiles.includes(`docs/notes/${item.key.toLowerCase()}-${round}.md`));
      assert.equal(current.blocker, null);
    }
  }

  const measured = state.scope;
  assert.equal(measured.length, rounds * items.length, 'every decision is measured');
  assert.ok(measured.length >= 10, 'the budget is measured over at least ten requests');
  assert.ok(measured.every(entry => entry.state === 'approved'));
  const snapshot = (await ok(token(coordinator), 'GET', 'work-snapshot')).work as Work[];
  const budget = scopeBudget(snapshot, measured, Date.now());
  assert.equal(budget.count, measured.length);
  assert.ok(budget.p90Ms <= scopeDecisionBudgetMs, `p90 request-to-decision is ${budget.p90Ms}ms, within the five-minute budget`);
  assert.equal(budget.longestOpenMs, 0, 'nothing is left waiting on the loop');
  assert.deepEqual(budget.breaches, []);
  assert.equal(budget.withinBudget, true);
  const metrics = state.metrics.at(-1)!;
  assert.equal(metrics.scope!.count, measured.length, 'the cycle records the latency it is judged on');
  assert.ok(metrics.scope!.p90Ms <= scopeDecisionBudgetMs);
  assert.equal(metrics.scopeOpenMs, 0);

  // The bound is enforced, not merely observed: a request nobody answered for a quarter of an
  // hour — which can only mean the loop is not running — is escalated with the wait.
  const stalled = await request(items[0], { paths: ['docs/notes/stalled.md'], reason: 'The loop is expected to answer this within minutes' });
  const skew = scopeBlockedBudgetMs + 60_000;
  const breached = await cycle(state, { decideScope: undefined }, skew);
  assert.equal(breached.scope.withinBudget, false);
  assert.equal(breached.scope.open.length, 1);
  const alarm = escalations(state).find(entry => entry.key.startsWith('escalation:scope-budget:'))!;
  assert.match(alarm.detail, new RegExp(`${items[0].key} has been blocked on its scope request for 16 minutes`));
  assert.match(alarm.detail, /above the 15-minute bound/);
  assert.deepEqual(breached.scope.breaches.map(breach => breach.id), [`blocked:${items[0].key}:${items[0].epoch}`], 'one breach id per item, whatever the wait grows to');
  assert.equal((await reload(items[0].id)).scopeRequest!.at, stalled.scopeRequest!.at, 'the undecided request is still waiting');

  // …and a loop that answers, but slowly, is escalated on its p90 once ten requests have been
  // decided. Nine slow decisions are not yet a measurement.
  const slow = (count: number, waitedMs: number): ScopeMeasurement[] => Array.from({ length: count }, () => ({ work: items[0].key, epoch: 1, at: new Date().toISOString(), waitedMs, state: 'approved' as const }));
  assert.equal(scopeBudget([], slow(9, scopeDecisionBudgetMs + 60_000), Date.now()).withinBudget, true, 'nine requests are not yet a measurement');
  const tooSlow = scopeBudget([], slow(10, scopeDecisionBudgetMs + 60_000), Date.now());
  assert.equal(tooSlow.withinBudget, false);
  assert.equal(tooSlow.breaches[0].id, 'p90');
  assert.match(tooSlow.breaches[0].detail, /Scope decisions are too slow: p90 is 360s over the last 10 requests, above the 5-minute budget/);
});

test('unit:scope-implication — an item implies the files its criteria name and the guides this repository requires, and nothing else', () => {
  const item = { plannedFiles: ['src/widget/Layout.tsx'], criteria };
  const ask = (paths: string[], extra: Record<string, unknown> = {}) => decideScopeRequest(item, { paths, ...extra });
  assert.equal(ask([theme]).state, 'approved', 'a source file a criterion names');
  assert.equal(ask(['docs/widget.md']).state, 'approved', 'a guide this repository requires updating');
  assert.equal(ask(['AGENTS.md']).state, 'approved', 'the agent contract itself');
  assert.equal(ask([theme, 'docs/widget.md', 'README.md']).state, 'approved');
  assert.equal(ask(['src/server/routes/work.ts']).state, 'refused', 'a source file nothing implies');
  assert.equal(ask([theme, 'src/server/routes/work.ts']).state, 'refused', 'one unimplied path refuses the whole request');
  assert.match(ask(['docs/']).reason, /outside what this item's own criteria/);
  assert.equal(ask(['docs/']).state, 'refused', 'the documentation rule covers a guide, never a whole tree');
  assert.equal(ask(['src/widget/Layout.tsx']).state, 'refused', 'a path already planned is no widening');
  assert.equal(ask([theme], { remove: ['src/widget/Layout.tsx'] }).state, 'refused', 'a removal is never decided here');
  assert.equal(ask([theme], { criteria: [{ id: 'AC-1', text: 'Something else', proofs: ['unit:layout'] }] }).state, 'refused', 'a criteria rewrite is never decided here');
  assert.equal(ask([]).state, 'refused');
  assert.match(ask([theme]).reason, /AC-2 names src\/widget\/Theme\.ts/, 'the approval says which criterion implied it');

  // A criterion that names a directory gives that breadth; prose that names no path gives none.
  const broad = { plannedFiles: [], criteria: [{ id: 'AC-1', text: 'Every command under src/cli/ prints its reason', proofs: ['unit:cli'] }] };
  assert.equal(decideScopeRequest(broad, { paths: ['src/cli/master.ts'] }).state, 'approved');
  assert.equal(decideScopeRequest(broad, { paths: ['src/cli/'] }).state, 'approved', 'the criterion named that breadth itself');
  assert.equal(decideScopeRequest(broad, { paths: ['src/engine.ts'] }).state, 'refused');
  assert.deepEqual(namedPaths('p90 of scope-request→decision is at most 5 minutes over ten requests'), [], 'prose with no path implies nothing');
  assert.deepEqual(namedPaths('Update src/engine.ts, tests/auto-scope.test.ts and docs/master-agent.md.'), ['src/engine.ts', 'tests/auto-scope.test.ts', 'docs/master-agent.md']);
  assert.deepEqual(impliedScopes([{ id: 'AC-1', text: 'No files here' }], []), []);
});

test('unit:documentation-consumer-scope — an item planning the whole docs/ tree implies single files that render or test those pages', () => {
  const docsTree = { plannedFiles: ['docs/', 'README.md'], criteria: [{ id: 'AC-1', text: 'The guides are rewritten', proofs: ['unit:docs'] }] };
  const approved = decideScopeRequest(docsTree, { paths: ['web/x.tsx', 'browser-tests/y.spec.ts'] });
  assert.equal(approved.state, 'approved', approved.reason);
  assert.match(approved.reason, /web\/x\.tsx \(web\/x\.tsx renders or tests the documentation this item rewrites\)/);
  assert.match(approved.reason, /browser-tests\/y\.spec\.ts \(browser-tests\/y\.spec\.ts renders or tests/);
  assert.deepEqual([...documentationConsumerScopes], ['web/', 'browser-tests/', 'integrations/']);
  const other = { plannedFiles: ['docs/one.md', 'src/a.ts'], criteria: docsTree.criteria };
  assert.equal(decideScopeRequest(other, { paths: ['web/x.tsx', 'browser-tests/y.spec.ts'] }).state, 'refused', 'one guide is not the whole tree');
  assert.equal(decideScopeRequest(docsTree, { paths: ['web/'] }).state, 'refused', 'a consumer directory is never implied');
  assert.equal(decideScopeRequest(docsTree, { paths: ['browser-tests/**'] }).state, 'refused');
  assert.equal(decideScopeRequest(docsTree, { paths: ['src/engine.ts'] }).state, 'refused', 'only the consumer surfaces');
  assert.equal(decideScopeRequest(docsTree, { paths: ['web/x.tsx'], remove: ['README.md'] }).state, 'refused', 'a removal is still never decided here');
  assert.equal(decideScopeRequest(docsTree, { paths: ['web/x.tsx'], criteria: [{ id: 'AC-1', text: 'Less', proofs: [] }] }).state, 'refused');
  assert.equal(decideScopeRequest(docsTree, { paths: ['web/x.tsx'] }, { documentationConsumers: ['site/'] }).state, 'refused', 'the consumer surfaces are overridable');
  assert.equal(decideScopeRequest(docsTree, { paths: ['site/x.tsx'] }, { documentationConsumers: ['site/'] }).state, 'approved');
});

test('integration:scope-redecision — a refusal the current rules would approve is decided again and applied; an approval never is', async () => {
  let work = await claimed('docs consumer redecision');
  const state = emptyDaemonState(loopConfig());
  const asked = await request(work, { paths: ['web/pages/overview.tsx', 'browser-tests/dashboard.spec.ts'], reason: 'They link to the guides this item moves' });
  await cycle(state);
  work = await reload(work.id);
  assert.equal(work.scopeRequest!.decision!.state, 'refused', 'nothing plans the docs tree yet');
  assert.ok(work.blocker?.startsWith(scopeRefusalBlocker));
  assert.equal(redecidableScopeRefusal(work), false);
  // A standing refusal the rules still give is not rewritten, by the loop or by a direct call.
  await cycle(state);
  assert.equal(scopeAction(state, work, asked.scopeRequest!.at).attempts, 1);
  const still = await call(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  assert.notEqual(still.status, 200, JSON.stringify(still.body));
  assert.match(still.body.error, /current rules still refuse/);

  // The item now plans the whole docs/ tree, so the rule implies the consumers it asked for.
  await ok(master.token, 'POST', `work/${work.id}/requirements`, { expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies,
    plannedFiles: [...work.plannedFiles, 'docs/'], exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], reason: 'The item rewrites the whole documentation tree' });
  work = await reload(work.id);
  assert.equal(work.scopeRequest!.decision!.state, 'refused', 'the widening did not cover the request itself');
  assert.equal(redecidableScopeRefusal(work), true);
  const before = work.policyRevision;
  await cycle(state);
  work = await reload(work.id);
  assert.equal(work.scopeRequest, null, 'the re-decided request is answered and cleared');
  assert.equal(work.scopeDecision!.state, 'approved');
  assert.match(work.scopeDecision!.reason, /renders or tests the documentation this item rewrites/);
  assert.equal(work.blocker, null, 'the refusal blocker is lifted');
  assert.deepEqual(work.plannedFiles, [layout, 'docs/', 'web/pages/overview.tsx', 'browser-tests/dashboard.spec.ts']);
  assert.equal(work.policyRevision, before + 1);
  assert.ok(work.lease && work.lease.epoch === asked.epoch, 'the attempt keeps its lease');

  // An approval is never re-decided.
  await cycle(state);
  assert.equal((await reload(work.id)).policyRevision, work.policyRevision);
  const again = await call(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  assert.equal(again.status, 404, JSON.stringify(again.body));
});

test('integration:scope-from-review-finding — a refused request for a file a review finding on the item names is widened by the loop, as the master, with the finding as its grounds', async () => {
  let work = await claimed('finding names the file');
  const state = emptyDaemonState(loopConfig());
  const widened: { paths: string[]; reason: string }[] = [];
  const findings = [{ ground: 'review thread PRRT_finding01', text: 'Not fixed: `src/merge-queue.ts:85-97` still marks every item with blocking threads; see also src/cli/master-status.ts:128.' }];
  const widen = async (item: Work, asked: ScopeRequestState, paths: string[], reason: string) => {
    widened.push({ paths, reason });
    return ok(master.token, 'POST', `work/${item.id}/requirements`, answeringWidening(item, asked, paths, reason));
  };
  const overrides: Partial<DaemonEffects> = { reviewFindings: async () => findings, basePaths: async paths => new Set(paths.filter(path => path !== 'src/new-helper.ts')), widenScope: widen };

  // Named by the finding: the control plane refuses it (no criterion names it), and the loop widens it.
  await request(work, { paths: ['src/merge-queue.ts'], reason: 'The reviewer finding names src/merge-queue.ts:85-97' });
  await cycle(state, overrides);
  work = await reload(work.id);
  assert.ok(work.plannedFiles.includes('src/merge-queue.ts'), `widened: ${work.plannedFiles}`);
  assert.equal(work.scopeRequest, null, 'the answered request is cleared');
  assert.equal(work.blocker, null, 'the item is not left blocked on scope');
  assert.ok(work.lease, 'the attempt keeps its lease');
  assert.match(widened[0].reason, /review thread PRRT_finding01/);
  assert.ok(!escalations(state).some(entry => entry.key.startsWith(`escalation:scope:${work.id}`)), 'nothing is escalated to a master session');

  // Not named by any finding: it stays refused and escalated, and the loop does not widen.
  await request(work, { paths: ['src/server/routes/work.ts'], reason: 'Easier to change here too' });
  await cycle(state, overrides);
  work = await reload(work.id);
  assert.equal(widened.length, 1, 'no widening without a finding naming the file');
  assert.equal(work.scopeRequest!.decision!.state, 'refused');
  assert.ok(work.blocker?.startsWith(scopeRefusalBlocker));
  assert.ok(escalations(state).some(entry => entry.key.startsWith(`escalation:scope:${work.id}`)));
  // A standing refusal is not re-read from GitHub every cycle...
  let reads = 0;
  const counted: Partial<DaemonEffects> = { ...overrides, reviewFindings: async () => { reads++; return findings; } };
  await cycle(state, counted);
  assert.equal(widened.length, 1);
  assert.equal(reads, 0, 'a fresh refusal on the findings is not judged again within findingRecheckMs');
  // ...but it is judged again once the findings may have changed: unchanged findings stay refused,
  // and a trusted thread naming the file that lands after the refusal widens it.
  await cycle(state, counted, findingRecheckMs + 1_000);
  assert.equal(reads, 1);
  assert.equal(widened.length, 1, 'the same findings are the same refusal');
  findings.push({ ground: 'review thread PRRT_later02', text: 'src/server/routes/work.ts:40 still returns the stale revision' });
  await cycle(state, counted, 2 * findingRecheckMs + 2_000);
  work = await reload(work.id);
  assert.equal(widened.length, 2, 'a finding posted after the refusal widens the request');
  assert.ok(work.plannedFiles.includes('src/server/routes/work.ts'));
  assert.match(widened[1].reason, /PRRT_later02/);

  // A path a prefix already in plannedFiles covers is not outstanding: after an operator plans
  // src/queue/ for half of a refused request, a finding naming only the other half widens it.
  let partial = await claimed('prefix covers part of the request');
  await request(partial, { paths: ['src/queue/entry.ts', 'src/cli/queue-status.ts'], reason: 'The reviewer finding names src/cli/queue-status.ts:12' });
  const partialFindings = [{ ground: 'review thread PRRT_partial03', text: 'src/cli/queue-status.ts:12 still prints the stale count' }];
  const partialEffects: Partial<DaemonEffects> = { ...overrides, reviewFindings: async () => partialFindings };
  await cycle(state, partialEffects);
  partial = await reload(partial.id);
  assert.equal(partial.scopeRequest!.decision!.state, 'refused', 'no finding names src/queue/entry.ts yet');
  await ok(master.token, 'POST', `work/${partial.id}/requirements`, { expectedPolicyRevision: partial.policyRevision, criteria: partial.criteria, dependencies: partial.dependencies,
    plannedFiles: [...partial.plannedFiles, 'src/queue/'], exclusiveResources: partial.exclusiveResources ?? [], producerProofs: partial.producerProofs ?? [], reason: 'The item owns the queue module' });
  partial = await reload(partial.id);
  assert.ok(partial.scopeRequest, 'a partly covered request stays open');
  await cycle(state, partialEffects);
  partial = await reload(partial.id);
  assert.deepEqual(widened.at(-1)!.paths, ['src/cli/queue-status.ts'], 'only the uncovered path is widened');
  assert.ok(partial.plannedFiles.includes('src/cli/queue-status.ts'), `widened: ${partial.plannedFiles}`);
  assert.equal(partial.scopeRequest, null);

  // A request at the bounds a scope request allows — 50 paths of 500 characters — that a finding names
  // in full is widened, and its record is bounded: the widening already happened, so recording it
  // must not fail and leave the request to be escalated as though nothing were widened.
  let many = await claimed('finding names many long paths');
  const long = Array.from({ length: 50 }, (_, index) => `src/${String(index).padStart(2, '0')}-${'x'.repeat(480)}.ts`);
  await request(many, { paths: long, reason: 'The reviewer finding names every one of these files' });
  const manyEffects: Partial<DaemonEffects> = { ...overrides, basePaths: async paths => new Set(paths), reviewFindings: async () => [{ ground: 'review thread PRRT_many05', text: long.join(' and ') }] };
  await cycle(state, manyEffects);
  many = await reload(many.id);
  assert.ok(long.every(path => many.plannedFiles.includes(path)), 'every named path is widened');
  assert.equal(many.scopeRequest, null);
  const recorded = Object.entries(state.actions).filter(([key]) => key.includes(many.id));
  assert.ok(recorded.every(([, action]) => action.detail.length <= actionDetailMax), 'every action detail is within its bound');
  const widenedMany = recorded.find(([key]) => key.includes(':finding:'))![1];
  assert.equal(widenedMany.state, 'done', widenedMany.detail);
  assert.match(widenedMany.detail, new RegExp(`^Widened ${many.key} with 50 files \\(src/00-x+…, src/01-x+… and 48 more\\) on the review finding that names them: src/00-`));
  assert.ok(!escalations(state).some(entry => entry.key.startsWith(`escalation:scope:${many.id}`)), 'a widened request is not escalated');

  // A file the base lacks is a creation: however plainly a finding asks for it, the loop never grants
  // it, and it stays refused and escalated to the master.
  let creation = await claimed('finding asks for a new file');
  await request(creation, { paths: ['src/new-helper.ts'], reason: 'The reviewer finding asks for src/new-helper.ts' });
  const before = widened.length;
  await cycle(state, { ...overrides, reviewFindings: async () => [{ ground: 'review thread PRRT_create04', text: 'Create src/new-helper.ts to hold the shared check' }] });
  creation = await reload(creation.id);
  assert.equal(widened.length, before, 'a creation is not widened by the loop');
  assert.ok(!creation.plannedFiles.includes('src/new-helper.ts'));
  assert.equal(creation.scopeRequest!.decision!.state, 'refused');
  assert.ok(escalations(state).some(entry => entry.key.startsWith(`escalation:scope:${creation.id}`)), 'the creation is escalated to the master');
  assert.match(state.actions[`${scopeKey(creation, creation.scopeRequest!)}:finding:${creation.policyRevision}`].detail, /does not exist on the base branch/);

  // The reads take seconds. The asking attempt can lose its lease while they run — released, lapsed
  // or overtaken by a new claim — without a new policy revision, so the widening decided on them
  // answers an attempt that no longer stands: it is refused in its own transaction, nothing widens.
  let raced = await claimed('lease ends during the finding reads');
  await request(raced, { paths: ['src/merge-queue.ts'], reason: 'The reviewer finding names src/merge-queue.ts:85-97' });
  const stale = (await reload(raced.id)).scopeRequest!;
  const attempted: string[] = [];
  const racing: Partial<DaemonEffects> = {
    reviewFindings: async item => {
      if (item.id === raced.id && item.lease) await engine.execute(implementer, 'release', raced.id, { epoch: raced.epoch }, randomUUID());
      return findings;
    },
    basePaths: async paths => new Set(paths),
    widenScope: async (item, asked, paths, reason) => {
      attempted.push(item.id);
      const answer = await call(master.token, 'POST', `work/${item.id}/requirements`, answeringWidening(item, asked, paths, reason));
      if (answer.status !== 200) throw new Error(answer.body.error ?? JSON.stringify(answer.body));
      return answer.body;
    },
  };
  await cycle(state, racing);
  raced = await reload(raced.id);
  assert.deepEqual(attempted, [raced.id], `the loop tried to widen on the stale reads: ${JSON.stringify(Object.entries(state.actions).filter(([key]) => key.includes(raced.id)))}`);
  assert.ok(!raced.plannedFiles.includes('src/merge-queue.ts'), `not widened: ${raced.plannedFiles}`);
  assert.equal(raced.lease, null);
  const refused = state.actions[`${scopeKey(raced, stale)}:finding:${raced.policyRevision}`];
  assert.equal(refused.state, 'failed');
  assert.match(refused.detail, /no longer open|no longer holds the lease/);
  // A request that no longer stands — withdrawn, or asked afresh — is refused the same way, however live the lease.
  let asked = await claimed('request asked afresh during the finding reads');
  await request(asked, { paths: ['src/merge-queue.ts'], reason: 'The reviewer finding names src/merge-queue.ts:85-97' });
  const first = (await reload(asked.id)).scopeRequest!;
  await request(asked, { paths: ['src/merge-queue.ts', 'src/cli/master-status.ts'], reason: 'Both files the finding names' });
  asked = await reload(asked.id);
  assert.notEqual(asked.scopeRequest!.at, first.at);
  const superseded = await call(master.token, 'POST', `work/${asked.id}/requirements`, answeringWidening(asked, first, ['src/merge-queue.ts'], 'stale request'));
  assert.notEqual(superseded.status, 200);
  assert.match(JSON.stringify(superseded.body), /scope request this widening answers is no longer open/);
  const answered = await call(master.token, 'POST', `work/${asked.id}/requirements`, answeringWidening(asked, asked.scopeRequest!, ['src/merge-queue.ts', 'src/cli/master-status.ts'], 'the open request'));
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.ok(answered.body.lease, 'the attempt keeps its lease');

  // A push during the reads replaces the head the findings were read for, with the request and the
  // lease both still standing: the reviewer's change request is another head's, so nothing widens.
  const observed = (item: Work, sha: string): Observation => ({ clockOffset: { min: 0, max: 0 },
    candidate: { sha, baseSha: 'b'.repeat(40), pr: item.submission!.pr, branch: item.workspaces.at(-1)!.branch, author: implementer.id },
    checks: [], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [layout], scopeFiles: [], at: new Date().toISOString() });
  let pushed = await claimed('head moves during the finding reads');
  pushed = await engine.execute(implementer, 'submit', pushed.id, { epoch: pushed.epoch, pr: 164_001 }, randomUUID());
  pushed = await engine.observe(pushed.id, pushed.revision, observed(pushed, 'a'.repeat(40)));
  pushed = await engine.execute(operator, 'rework', pushed.id, { reason: 'Review finding to address', previousWorkerStopped: true }, randomUUID());
  pushed = await engine.execute(implementer, 'claim', pushed.id, {}, randomUUID());
  pushed = await engine.execute(implementer, 'workspace', pushed.id, { epoch: pushed.epoch, host: 'scope-host', path: `/tmp/auto-scope/${pushed.id}-${pushed.epoch}`, branch: pushed.workspaces.at(-1)!.branch }, randomUUID());
  await request(pushed, { paths: ['src/merge-queue.ts'], reason: 'The reviewer finding names src/merge-queue.ts:85-97' });
  const readFor: string[] = [];
  const moving: Partial<DaemonEffects> = { ...racing,
    reviewFindings: async item => {
      if (item.id === pushed.id) {
        readFor.push(item.candidate!.sha);
        const current = await reload(pushed.id);
        await engine.observe(pushed.id, current.revision, observed(current, 'c'.repeat(40)));
      }
      return findings;
    } };
  await cycle(state, moving);
  pushed = await reload(pushed.id);
  assert.deepEqual(readFor, ['a'.repeat(40)], 'the findings were read for the head the request stood against');
  assert.equal(pushed.candidate!.sha, 'c'.repeat(40));
  assert.ok(pushed.lease && pushed.scopeRequest, 'the lease and the request both still stand');
  assert.ok(!pushed.plannedFiles.includes('src/merge-queue.ts'), `not widened: ${pushed.plannedFiles}`);
  const moved = state.actions[`${scopeKey(pushed, pushed.scopeRequest!)}:finding:${pushed.policyRevision}`];
  assert.equal(moved.state, 'failed');
  assert.match(moved.detail, /read for aaaaaaaaaaaa, which is no longer the item's head/);
});

test('unit:review-finding-scope — only a file on the base that a finding names literally is granted; a missing file, a directory, a longer path or an unnamed file is not', async () => {
  const findings = [{ ground: 'review 7', text: 'Change `src/merge-queue.ts:85-97` and create src/new-helper.ts; the whole src/ tree is fine.' }];
  const exists = (path: string) => path !== 'src/new-helper.ts' && path !== 'src/missing.ts';
  assert.deepEqual(findingScope(['src/merge-queue.ts'], findings, exists), { grounds: [{ path: 'src/merge-queue.ts', ground: 'review 7' }] });
  assert.match((findingScope(['src/'], findings, exists) as { refusal: string }).refusal, /directory scope/);
  assert.match((findingScope(['src/*'], findings, exists) as { refusal: string }).refusal, /directory scope/);
  assert.match((findingScope(['src/merge-queue.tsx'], findings, exists) as { refusal: string }).refusal, /no unresolved review finding on the head names/);
  assert.match((findingScope(['src/other.ts'], findings, exists) as { refusal: string }).refusal, /no unresolved review finding/);
  assert.match((findingScope(['src/merge-queue.ts', 'src/other.ts'], findings, exists) as { refusal: string }).refusal, /names src\/other\.ts/, 'one unnamed file refuses the whole request');
  assert.ok(namesPath('see src/a.ts.', 'src/a.ts') && namesPath('(src/a.ts:12)', 'src/a.ts') && !namesPath('lib/src/a.ts', 'src/a.ts') && !namesPath('src/a.ts.bak', 'src/a.ts'));
  // A file the base lacks is a creation, the master's to decide, however plainly a finding asks for it.
  for (const text of ['src/missing.ts is wrong', 'Create src/missing.ts for the helper', 'Add a new file at `src/missing.ts`', 'src/missing.ts should be added next to the queue'])
    assert.match((findingScope(['src/missing.ts'], [{ ground: 'review 9', text }], exists) as { refusal: string }).refusal, /src\/missing\.ts does not exist on the base branch/, text);
  assert.match((findingScope(['src/new-helper.ts'], findings, exists) as { refusal: string }).refusal, /does not exist on the base branch/);
  assert.match((findingScope(['src/merge-queue.ts', 'src/new-helper.ts'], findings, exists) as { refusal: string }).refusal, /does not exist on the base branch/, 'a creation beside an existing file refuses the whole request');
  assert.match((findingScope(['Dockerfile'], [{ ground: 'review 13', text: 'Create Dockerfile for the runner image' }], () => false) as { refusal: string }).refusal, /does not exist on the base branch/);
  // Names the file pattern of a path-like token would miss — extensionless, dot-prefixed — are named literally all the same.
  assert.deepEqual(findingScope(['Dockerfile', '.github/CODEOWNERS'], [{ ground: 'review 14', text: 'Fix Dockerfile and .github/CODEOWNERS' }], () => true),
    { grounds: [{ path: 'Dockerfile', ground: 'review 14' }, { path: '.github/CODEOWNERS', ground: 'review 14' }] });

  // The read: unresolved threads' comments by trusted authors, and the configured reviewer's latest change request on the head only.
  const run = (_command: string, args: string[]) => {
    // A long thread: the listing carries its first page of comments, the rest is read by the thread's id.
    if (args[1] === 'graphql' && args.includes('id=PRRT_long')) return JSON.stringify({ data: { node: { comments: args.includes('after=c1')
      ? { pageInfo: { hasNextPage: true, endCursor: 'c2' }, nodes: [{ body: 'noise', author: { login: 'graphyard-reviewer' } }] }
      : { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ body: 'late: fix src/g.ts', author: { login: 'graphyard-reviewer' } }] } } } });
    if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { id: 'PRRT_open', isResolved: false, comments: { nodes: [{ body: 'fix src/a.ts', author: { login: 'chatgpt-codex-connector' } }, { body: 'and src/worker.ts', author: { login: 'cryptob1' } }] } },
      { id: 'PRRT_reviewer', isResolved: false, comments: { nodes: [{ body: 'fix src/e.ts', author: { login: 'graphyard-reviewer' } }] } },
      { id: 'PRRT_worker', isResolved: false, comments: { nodes: [{ body: 'please widen src/f.ts', author: { login: 'cryptob1' } }] } },
      { id: 'PRRT_done', isResolved: true, comments: { nodes: [{ body: 'src/b.ts', author: { login: 'graphyard-reviewer' } }] } },
      { id: 'PRRT_long', isResolved: false, comments: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ body: 'first', author: { login: 'graphyard-reviewer' } }] } }] } } } } });
    return JSON.stringify([[{ id: 1, user: { login: 'graphyard-reviewer[bot]' }, commit_id: 'h'.repeat(40), state: 'CHANGES_REQUESTED', body: 'also src/c.ts' },
      { id: 2, user: { login: 'graphyard-reviewer[bot]' }, commit_id: 'o'.repeat(40), state: 'CHANGES_REQUESTED', body: 'old head src/d.ts' },
      // A thread reply is a COMMENTED review on the head: it withdraws no verdict, so review 1 still stands.
      { id: 3, user: { login: 'graphyard-reviewer[bot]' }, commit_id: 'h'.repeat(40), state: 'COMMENTED', body: '' }]]);
  };
  // Existence on the base: only a genuine absence is false; a missing base ref or failing git throws, so the loop retries.
  const repo = await mkdtemp(join(tmpdir(), 'gy-finding-base-'));
  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['-C', repo, 'init', '-q']); await mkdir(join(repo, 'src')); await writeFile(join(repo, 'src', 'present.ts'), 'export {};\n');
  git(['-C', repo, 'add', '.']); git(['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base']);
  git(['-C', repo, 'branch', '-M', 'main']);
  // The loop's checkout: its origin/main is read once and then left stale while the remote moves on.
  const checkout = await mkdtemp(join(tmpdir(), 'gy-finding-checkout-'));
  git(['clone', '-q', repo, checkout]);
  await writeFile(join(repo, 'src', 'added.ts'), 'export {};\n'); git(['-C', repo, 'rm', '-q', 'src/present.ts']); git(['-C', repo, 'add', '.']);
  git(['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base moves']);
  const gitRun = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // One decision is one fetch: however many paths it asks about, they are judged against one pinned tree.
  const calls: string[][] = [];
  const counted = (command: string, args: string[]) => { calls.push(args); return gitRun(command, args); };
  assert.deepEqual([...await basePaths(checkout, 'main', ['src/added.ts', 'src/present.ts', 'src/absent.ts', 'src'], counted)], ['src/added.ts'],
    'a file added to the base since the last fetch exists; one deleted since, one never there, and a directory are absent');
  assert.equal(calls.filter(args => args.includes('fetch')).length, 1, `one fetch per decision: ${JSON.stringify(calls)}`);
  assert.equal(calls.length, 3, `fetch, pin the commit, one ls-tree for every path: ${JSON.stringify(calls)}`);
  // Asked about alone, ls-tree lists a directory as its own tree entry: it is still not a file.
  assert.deepEqual([...await basePaths(checkout, 'main', ['src'], gitRun)], [], 'a bare directory on its own is not a file on the base');
  assert.match((findingScope(['src'], [{ ground: 'review 14', text: 'see src for the pattern' }], path => path !== 'src') as { refusal: string }).refusal, /src does not exist on the base branch as a file/);
  assert.deepEqual([...await basePaths(checkout, 'main', [], () => { throw new Error('no git for no paths'); })], []);
  await assert.rejects(basePaths(checkout, 'gone', ['src/added.ts'], gitRun), 'a missing base branch is a failure, not an absent file');
  await assert.rejects(basePaths(checkout, 'main', ['src/added.ts'], () => { throw new Error('git timed out'); }), /timed out/);
  await rm(repo, { recursive: true, force: true }); await rm(checkout, { recursive: true, force: true });

  const read = await readReviewFindings({ repository: 'owner/repo', pr: 5, sha: 'h'.repeat(40), reviewer: 'graphyard-reviewer[bot]', trusted: ['chatgpt-codex-connector[bot]'] }, run);
  assert.deepEqual(read.map(entry => entry.ground), ['review thread PRRT_open', 'review thread PRRT_reviewer', ...Array(3).fill('review thread PRRT_long'), 'review 1'], 'one finding per trusted comment');
  assert.ok(read.some(entry => entry.ground === 'review thread PRRT_long' && namesPath(entry.text, 'src/g.ts')), 'a trusted comment past the first page of a long thread is a finding');
  assert.equal(read[0].text, 'fix src/a.ts', 'a comment by an untrusted author in a trusted thread is not a finding');
  // A later verdict does replace it: an approval of the head leaves no change request standing.
  const approved = (command: string, args: string[]) => args[1] === 'graphql' ? run(command, args)
    : JSON.stringify([[{ id: 1, user: { login: 'graphyard-reviewer[bot]' }, commit_id: 'h'.repeat(40), state: 'CHANGES_REQUESTED', body: 'also src/c.ts' },
      { id: 4, user: { login: 'graphyard-reviewer[bot]' }, commit_id: 'h'.repeat(40), state: 'APPROVED', body: 'ok' }]]);
  assert.ok(!(await readReviewFindings({ repository: 'owner/repo', pr: 5, sha: 'h'.repeat(40), reviewer: 'graphyard-reviewer[bot]', trusted: [] }, approved)).some(entry => entry.ground.startsWith('review ') && !entry.ground.startsWith('review thread')), 'an approval after the change request withdraws it');
});
