import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { approveScopeRequest } from '../src/cli/master-status.js';
import { emptyDaemonState, runCycle, scopeBudget, scopeKey, type DaemonEffects, type DaemonState, type ScopeMeasurement } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { decideScopeRequest, documentationConsumerScopes, impliedScopes, namedPaths, redecidableScopeRefusal, scopeBlockedBudgetMs, scopeDecisionBudgetMs, scopeRefusalBlocker } from '../src/model/scope.js';
import { regressionRefusals } from '../src/regression-guard.js';
import type { Principal, ScopeFile, Work } from '../src/model.js';

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
  assert.match(action.detail, new RegExp(`Widened ${work.key} with ${theme.replace(/\./g, '\\.')}, docs/widget\\.md`));
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
