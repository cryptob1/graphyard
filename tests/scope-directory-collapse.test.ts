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
import { answeringWidening, emptyDaemonState, runCycle, scopeRoutineDecision, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { approverSessionName, decisionInput, masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { liveScopeWidening, type ScopeRequestState } from '../src/model/scope.js';
import { collapseArea, collapsePlannedFiles, mergedScopeRequest, plannedFilesMax } from '../src/model/scope-collapse.js';
import type { Principal, Work } from '../src/model.js';

// GY-549: a change that legitimately touches more than 100 files (GY-421 migrated 158 test files)
// could never be scoped. File-by-file requests hit the plannedFiles cap, each batch was its own
// approver decision, and the master's revision folding the files into `tests/` was refused as
// immutable under the worker's live lease. The widening the loop proposes now folds wide asks into
// directory entries, an attempt's pending asks are merged into one decision, and a plannedFiles-only
// folding applies under a live lease. Each test is named for the proof it produces.
const repository = 'owner/scope-collapse';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `scope-collapse-${principal.id}-${'x'.repeat(32)}` }));
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
const helper = 'tests/helpers/temp-dirs.ts', layout = 'src/widget/Layout.tsx';
const criteria = [{ id: 'AC-1', text: `Every test file creates its temporary directories through ${helper}`, proofs: ['unit:temp-dirs'] }];
const testFiles = (count: number, prefix = 'tests/') => Array.from({ length: count }, (_, index) => `${prefix}migrated-${String(index).padStart(3, '0')}.test.ts`);

async function claimed(title: string) {
  let work = await ok(master.token, 'POST', 'work', { title, plannedFiles: [layout, helper], criteria, reason: 'Operator goal: a mechanical change across every test file can be scoped' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the attempt' }) as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  return reload(work.id);
}
const ask = (work: Work, paths: string[], reason: string) => ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths, reason }) as Promise<Work>;

const loopConfig = () => masterConfigSchema.parse({ version: 1, url, credentialFile: join(tmpdir(), 'scope-collapse-coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-scope-collapse',
  workers: [{ name: 'worker', principal: implementer.id, agentName: 'graphyard-worker-scope-collapse', mode: 'existing' }] }) as MasterConfig;

/** The loop with the decision effects wired as `daemonEffects` wires them; the approver launch is recorded, not spawned. */
function harness() {
  const sessions: HerdrAgent[] = [], decided: { key: string; action: string; reason: string; input: any }[] = [];
  const effects: DaemonEffects = {
    agents: () => sessions,
    herdr: () => ({ agents: sessions, available: true }),
    credentials: async () => ({}),
    snapshot: async () => { const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
    closeSession: pane => { sessions.splice(0, sessions.length, ...sessions.filter(agent => agent.pane_id !== pane)); },
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    decideScope: work => ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.scopeRequest!.epoch }) as Promise<Work>,
    reviewFindings: async () => [],
    basePaths: async () => new Set<string>(),
    widenScope: (work, request, paths, reason) => ok(master.token, 'POST', `work/${work.id}/requirements`, answeringWidening(work, request, paths, reason)),
    decide: async (work, action, reason, input = {}) => { decided.push({ key: work.key, action, reason, input }); return ok(master.token, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }); },
    approver: async (work, decision) => {
      const agentName = approverSessionName(work, decision), pane = `pane-${sessions.length + 1}`;
      sessions.push({ name: agentName, pane_id: pane, agent_status: 'working' } as HerdrAgent);
      return { agentName, pane };
    },
    decisions: work => ok(master.token, 'GET', `work/${encodeURIComponent(work.id)}/decisions`),
    withdraw: (work, decision, reason) => ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason }),
    persist: async () => {},
  };
  const cycle = (state: DaemonState) => runCycle(loopConfig(), state, effects);
  const about = (work: Work) => decided.filter(entry => entry.key === work.key);
  return { cycle, about };
}
const requirementsDecisions = async (work: Work) => (await ok(master.token, 'GET', `work/${work.id}/decisions`)).decisions.filter((decision: any) => decision.action === 'requirements');

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 549;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-scope-collapse-db-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('scope_collapse_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scope_collapse_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver]) await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: `Onboarding provisions ${agent.id}` });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:scope-collapses-to-directory — 158 test files plus 10 planned paths fold into one tests/ entry under the cap, and 3 other files stay listed', () => {
  const existing = [helper, 'tests/helpers/run-tests.ts', ...Array.from({ length: 8 }, (_, index) => `src/model/part-${index}.ts`)];
  const migrated = [...testFiles(150), ...testFiles(8, 'tests/fixtures/')];
  const others = ['src/engine.ts', 'scripts/contracts.mjs', 'docs/coordination.md'];
  const area = collapseArea({ criteria, plannedFiles: existing });
  assert.deepEqual(area.sort(), ['src/', 'tests/'], "the fold stays inside the item's area: the top-level directories its criteria name and it plans");

  const widened = collapsePlannedFiles(existing, [...migrated, ...others], area);
  assert.ok(widened.plannedFiles.length <= plannedFilesMax, `the widening fits under the cap (${widened.plannedFiles.length} entries)`);
  assert.deepEqual(widened.plannedFiles.filter(path => path.startsWith('tests/')), ['tests/'], 'every test file, and the planned helpers, are one tests/ entry');
  assert.deepEqual(widened.collapsed.map(entry => entry.scope), ['tests/']);
  assert.equal(widened.collapsed[0].files.length, 158, 'the entry names the 158 files it covers');
  for (const path of others) assert.ok(widened.plannedFiles.includes(path), `${path} stays listed individually`);
  assert.equal(widened.plannedFiles.filter(path => path.startsWith('src/model/')).length, 8, 'planned files no fold needed are kept as they are');

  // With no more than 20 entries under a directory (the two planned helpers count), and inside the cap, nothing folds.
  const small = collapsePlannedFiles(existing, testFiles(18), area);
  assert.deepEqual(small.collapsed, []);
  assert.equal(small.plannedFiles.length, existing.length + 18);
  // More than 20 under one directory fold to the deepest common directory, not above it.
  const deep = collapsePlannedFiles(existing, testFiles(21, 'tests/fixtures/'), area);
  assert.deepEqual(deep.collapsed.map(entry => entry.scope), ['tests/fixtures/']);
  // Outside the item's area nothing folds, and the repository root is never an entry.
  const outside = collapsePlannedFiles(existing, testFiles(30, 'web/specs/'), area);
  assert.deepEqual(outside.collapsed, []);
  assert.ok(!outside.plannedFiles.some(path => path === '/' || path === ''));

  // The decision the loop builds proposes the fold and names the directory and the files it covers.
  const now = Date.parse('2031-03-01T10:00:00Z');
  const lease = { epoch: 2, owner: 'implementer', expiresAt: '2031-03-01T10:05:00Z' };
  const paths = [...migrated, ...others];
  const refused = { state: 'refused' as const, reason: 'outside', at: '2031-03-01T09:59:00Z', decidedBy: 'graphyard', waitedMs: 1, paths, requestedBy: 'implementer', requestedAt: '2031-03-01T09:58:00Z' };
  const item = { key: 'GY-9', stage: 'build', plannedFiles: existing, criteria, lease, scopeRequest: { epoch: 2, paths, reason: 'Migrate every test onto the helper', requestedBy: 'implementer', at: '2031-03-01T09:58:00Z', decision: refused } } as unknown as Work;
  const decision = scopeRoutineDecision(item, now, true)!;
  assert.equal(decision.action, 'requirements');
  assert.deepEqual(decision.input!.plannedFiles, widened.plannedFiles, 'the decision proposes the folded plannedFiles');
  assert.match(decision.reason, /tests\/ \(one directory entry, plannedFiles holding at most 100; covers 158 requested files: tests\/migrated-000\.test\.ts/, 'the decision names the directory and the files it covers');
  assert.match(decision.reason, /Broad scope exception \(tests\/\)/, 'a root-level fold is still the audited broad-scope exception');
  assert.ok(decision.reason.length <= 2000);
});

test('unit:scope-requests-merged — two consecutive scope requests of one attempt become one requirements decision covering both', async () => {
  const first = testFiles(2), second = testFiles(2, 'tests/fixtures/');
  let work = await claimed('merged asks');
  await ask(work, first, 'The first tests to migrate onto the helper');
  const merged = await ask(work, second, 'The fixture tests use the helper too');
  assert.deepEqual(merged.scopeRequest!.paths, [...first, ...second], 'the second ask is merged into the pending first');
  assert.match(merged.scopeRequest!.reason, /first tests.*fixture tests/);

  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  await loop.cycle(state);
  work = await reload(work.id);
  assert.equal(loop.about(work).length, 1, 'one decision is requested for both asks');
  for (const path of [...first, ...second]) assert.ok(loop.about(work)[0].input.plannedFiles.includes(path), `the decision covers ${path}`);
  const [requested] = await requirementsDecisions(work);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'Both batches are the migration AC-1 names' });
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, [layout, helper, ...first, ...second]);
  assert.equal(work.scopeRequest, null, 'one approval answers every outstanding path');

  // An ask while the first is already with the approver is merged too: the earlier decision is
  // moved past and withdrawn, and one decision stands for the whole.
  let later = await claimed('merged after routing');
  await ask(later, first, 'The first tests to migrate onto the helper');
  const routed = harness(), routedState = emptyDaemonState(loopConfig());
  await routed.cycle(routedState);
  await ask(later, second, 'The fixture tests use the helper too');
  await routed.cycle(routedState);
  later = await reload(later.id);
  const open = (await requirementsDecisions(later)).filter((decision: any) => decision.state === 'requested');
  assert.equal(open.length, 1, 'one decision stands for the attempt');
  for (const path of [...first, ...second]) assert.ok(open[0].input.plannedFiles.includes(path), `the standing decision covers ${path}`);

  // Only a pending ask of the same attempt is merged: an approver's refusal, another epoch, or a
  // narrowing is replaced exactly as before.
  const ask1: ScopeRequestState = { epoch: 2, paths: ['tests/a.test.ts'], reason: 'one', requestedBy: 'implementer', at: 't1' };
  const ask2: ScopeRequestState = { epoch: 2, paths: ['tests/b.test.ts'], reason: 'two', requestedBy: 'implementer', at: 't2' };
  const byApprover = { state: 'refused' as const, reason: 'no', at: 't1', decidedBy: 'independent-approver', waitedMs: 1, paths: ask1.paths, requestedBy: 'implementer', requestedAt: 't1' };
  assert.deepEqual(mergedScopeRequest({ ...ask1, decision: { ...byApprover, decidedBy: 'graphyard' } }, ask2).paths, ['tests/a.test.ts', 'tests/b.test.ts']);
  assert.deepEqual(mergedScopeRequest({ ...ask1, decision: byApprover }, ask2), ask2);
  assert.deepEqual(mergedScopeRequest({ ...ask1, epoch: 1 }, ask2), ask2);
  assert.deepEqual(mergedScopeRequest(ask1, { ...ask2, remove: ['src/a.ts'] }), { ...ask2, remove: ['src/a.ts'] });
  assert.deepEqual(mergedScopeRequest(ask1, ask2, ['tests/']), ask2, 'paths planned meanwhile are not carried');
});

test('unit:widening-applies-under-lease — an approved plannedFiles-only fold applies under a live lease and containment fence; a criteria change does not', async () => {
  let work = await claimed('fold under lease');
  await engine.execute(implementer, 'quarantine', work.id, { epoch: work.epoch, settlementHash: 'e'.repeat(64) }, randomUUID());
  const migrated = testFiles(25);
  await ask(work, migrated, 'Every test file moves onto the shared temp-dir helper');
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  work = await reload(work.id);
  assert.deepEqual(loop.about(work)[0].input.plannedFiles, [layout, 'tests/'], 'the planned helper folds into the proposed tests/ entry');
  const [requested] = await requirementsDecisions(work);
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'Granting tests/: the migration touches every test file, and listing them cannot fit the cap' });
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, [layout, 'tests/'], 'the approved decision applied');
  assert.equal(work.scopeRequest, null);
  assert.equal(work.scopeDecision!.state, 'approved');
  assert.ok(work.lease && work.lease.owner === implementer.id && work.lease.epoch === requested.input.answers.epoch, 'the attempt keeps its lease');
  assert.ok(work.containmentQuarantine && work.containmentQuarantine.epoch === work.epoch, 'and its containment fence');
  const revision = (await events(work)).filter(entry => entry.kind === 'requirements').at(-1)!;
  assert.equal(revision.payload.details.liveScopeWidening, true, 'the widening is recorded');
  assert.deepEqual(revision.payload.details.before.plannedFiles, [layout, helper]);

  const changed = await call(master.token, 'POST', `work/${work.id}/requirements`, { expectedPolicyRevision: work.policyRevision, criteria: [...work.criteria, { id: 'AC-2', text: 'More', proofs: ['unit:more'] }], dependencies: work.dependencies,
    plannedFiles: work.plannedFiles, exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], reason: 'A criteria change under a live lease' });
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.match(changed.body.error, /requirements remain immutable until settlement/);

  // The rule itself: folding planned files into a directory that contains them is a widening; dropping one is not.
  const current = { criteria, dependencies: [] as string[], plannedFiles: [layout, helper] };
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: [layout, 'tests/'] }), true);
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: ['tests/'] }), false, 'dropping a planned path is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: [layout, 'tests/helpers/'] }), true);
  assert.equal(liveScopeWidening({ ...current, plannedFiles: [layout, 'tests/'] }, { ...current, plannedFiles: [layout, 'tests/', 'tests/a.test.ts'] }), false, 'a path already covered widens nothing');
  assert.equal(liveScopeWidening(current, { ...current, criteria: [{ ...criteria[0], text: 'Changed' }], plannedFiles: [layout, 'tests/'] }), false);
});
