import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { emptyDaemonState, runCycle, scopeRoutineDecision, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { approverSessionName, decisionInput, masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { derivedIntent } from '../src/cli/master.js';
import { plannedFilesMax } from '../src/model/scope.js';
import { askedScopes, collapseArea, collapsePlannedFiles } from '../src/model/scope-collapse.js';
import { derivePlannedFiles } from '../src/model/work.js';
import type { Principal, Work } from '../src/model.js';
// Time-bomb allowance (GY-1694): the 2031-03-01 lease and refusal instants meet only the explicit now Date.parse('2031-03-01T10:00:00Z') given to scopeRoutineDecision; new Date() just stamps the stub deployment.

// GY-1676: a worker under a live lease and containment quarantine asked for one new file beside the
// 21 source files its item already planned. The loop folded the ask into a root-level `src/` (the
// 21 planned paths counted towards the directory threshold), which the approver refused; and the
// exact-path alternative was refused by `master requirements` because the base branch did not hold
// the file yet, while the criterion that would have described it made the revision more than a
// widening, refused under the quarantine. Each test is named for the proof it produces.
const repository = 'owner/scope-request-new-file';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `scope-new-file-${principal.id}-${'x'.repeat(32)}` }));
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

// The shape of GY-1675: 21 planned source files, under src/ and src/server/, and one new file asked for.
const planned = [...Array.from({ length: 13 }, (_, index) => `src/part-${String(index).padStart(2, '0')}.ts`), ...Array.from({ length: 8 }, (_, index) => `src/server/route-${index}.ts`), 'tests/main.test.ts'];
const newFile = 'src/server/control-plane-observation.ts';
const criteria = [{ id: 'AC-1', text: 'The control-plane observation job runs outside the server entry point', proofs: ['unit:observation'] }];

const loopConfig = () => masterConfigSchema.parse({ version: 1, url, credentialFile: join(tmpdir(), 'scope-new-file-coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-scope-new-file',
  workers: [{ name: 'worker', principal: implementer.id, agentName: 'graphyard-worker-scope-new-file', mode: 'existing' }] }) as MasterConfig;

/** The loop with the decision effects wired as `daemonEffects` wires them; the approver launch is recorded, not spawned. */
function harness() {
  const sessions: HerdrAgent[] = [], decided: { key: string; action: string; input: any }[] = [];
  const effects: DaemonEffects = {
    agents: () => sessions,
    herdr: () => ({ agents: sessions, available: true }),
    credentials: async () => ({}),
    snapshot: async () => { const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
    closeSession: pane => { sessions.splice(0, sessions.length, ...sessions.filter(agent => agent.pane_id !== pane)); },
    dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    decideScope: work => ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.scopeRequest!.epoch, treeRead: true }) as Promise<Work>,
    reviewFindings: async () => [],
    basePaths: async () => new Set<string>(),
    widenScope: async () => { throw new Error('no review finding grounds this ask'); },
    decide: async (work, action, reason, input = {}) => { decided.push({ key: work.key, action, input }); return ok(master.token, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }); },
    approver: async (work, decision) => {
      const agentName = approverSessionName(work, decision), pane = `pane-${sessions.length + 1}`;
      sessions.push({ name: agentName, pane_id: pane, agent_status: 'working' } as HerdrAgent);
      return { agentName, pane };
    },
    decisions: work => ok(master.token, 'GET', `work/${encodeURIComponent(work.id)}/decisions`),
    withdraw: (work, decision, reason) => ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason }),
    persist: async () => {},
  };
  return { cycle: (state: DaemonState) => runCycle(loopConfig(), state, effects), about: (work: Work) => decided.filter(entry => entry.key === work.key) };
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1676;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('scope-new-file-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('scope_new_file_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scope_new_file_test`); await store.init();
  engine = new Engine(store, 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver]) await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: `Onboarding provisions ${agent.id}` });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:scope-request-new-file — one new file beside 21 planned src paths is proposed as that exact path; a wide ask or one over the cap still folds', () => {
  const area = collapseArea({ criteria, plannedFiles: planned });
  // AC-1: the 21 planned src paths do not count towards the directory threshold: only the ask does.
  const one = collapsePlannedFiles(planned, [newFile], area);
  assert.deepEqual(one.collapsed, [], 'nothing folds for a one-file ask');
  assert.deepEqual(one.plannedFiles, [...planned, newFile], 'the ask is proposed as its exact path');

  // The decision the loop routes to the approver proposes the exact path, never the broad-scope exception.
  const now = Date.parse('2031-03-01T10:00:00Z');
  const lease = { epoch: 1, owner: 'implementer', expiresAt: '2031-03-01T10:05:00Z' };
  const refused = { state: 'refused' as const, reason: 'outside', at: '2031-03-01T09:59:00Z', decidedBy: 'graphyard', treeRead: true, waitedMs: 1, paths: [newFile], requestedBy: 'implementer', requestedAt: '2031-03-01T09:58:00Z' };
  const item = { key: 'GY-9', stage: 'build', plannedFiles: planned, criteria, lease, scopeRequest: { epoch: 1, paths: [newFile], reason: 'Move the job out of src/server/main.ts', requestedBy: 'implementer', at: '2031-03-01T09:58:00Z', decision: refused } } as unknown as Work;
  const decision = scopeRoutineDecision(item, now, true)!;
  assert.equal(decision.action, 'requirements');
  assert.deepEqual(decision.input!.plannedFiles, [...planned, newFile]);
  assert.ok(!decision.input!.plannedFiles.includes('src/'), 'no root-level src/ entry is proposed');
  assert.doesNotMatch(decision.reason, /Broad scope exception/);

  // AC-3: a request naming more than 20 files under one directory folds as before, the planned paths there with it.
  const wide = Array.from({ length: 21 }, (_, index) => `src/server/job-${String(index).padStart(2, '0')}.ts`);
  const folded = collapsePlannedFiles(planned, wide, area);
  assert.deepEqual(folded.collapsed.map(entry => entry.scope), ['src/server/']);
  assert.equal(folded.collapsed[0].files.length, 21);
  assert.ok(!folded.plannedFiles.some(path => path.startsWith('src/server/') && path !== 'src/server/'), 'the planned src/server/ paths fold with it');
  // Twenty asked files under one directory are still listed.
  assert.deepEqual(collapsePlannedFiles(planned, wide.slice(0, 20), area).collapsed, []);
  // AC-3: a small ask that would pass the plannedFiles cap still folds to stay under it.
  const full = Array.from({ length: plannedFilesMax - 1 }, (_, index) => `src/bulk/file-${String(index).padStart(3, '0')}.ts`);
  const capped = collapsePlannedFiles(full, ['src/bulk/new-a.ts', 'src/bulk/new-b.ts'], collapseArea({ criteria, plannedFiles: full }));
  assert.ok(capped.plannedFiles.length <= plannedFilesMax, `the fold keeps the list under the cap (${capped.plannedFiles.length})`);
  assert.deepEqual(capped.collapsed.map(entry => entry.scope), ['src/bulk/']);

  // AC-2's derivation: a path the item's open ask names is planned although the base does not hold it yet; any other is still refused.
  const tree = new Set(planned);
  assert.deepEqual(askedScopes(item), [newFile]);
  assert.deepEqual(askedScopes({ ...item, scopeRequest: null, carriedScopeRequest: item.scopeRequest }), [newFile], 'an ask an ended attempt carried counts too');
  assert.deepEqual(derivePlannedFiles({ plannedFiles: [...planned, newFile], criteria }, tree, askedScopes(item)).missing, []);
  assert.deepEqual(derivePlannedFiles({ plannedFiles: [...planned, newFile], criteria }, tree).missing, [newFile], 'without the ask the new path is refused as before');
  assert.deepEqual(derivePlannedFiles({ plannedFiles: [...planned, newFile, 'src/typo.ts'], criteria }, tree, askedScopes(item)).missing, ['src/typo.ts']);
  // A directory the base lacks is grounded only by a fold the ask itself produces, never by one asked file inside it.
  const newCriteria = [{ id: 'AC-1', text: 'The split job lives in newdir/a.ts', proofs: ['unit:split'] }];
  const ask = (paths: string[], plannedFiles: readonly string[]) => askedScopes({ plannedFiles, criteria: newCriteria, scopeRequest: { ...item.scopeRequest!, paths } });
  assert.deepEqual(ask(['newdir/a.ts'], planned), ['newdir/a.ts'], 'a one-file ask grounds only its path');
  assert.deepEqual(derivePlannedFiles({ plannedFiles: ['newdir/', 'newdir/**'], criteria }, tree, ask(['newdir/a.ts'], planned)).missing, ['newdir/', 'newdir/**']);
  const wideNew = Array.from({ length: 21 }, (_, index) => `newdir/file-${String(index).padStart(2, '0')}.ts`);
  assert.deepEqual(ask(wideNew, planned), [...wideNew, 'newdir/'], 'a 21-file ask grounds the directory its width folds into');
  assert.deepEqual(derivePlannedFiles({ plannedFiles: ['newdir/'], criteria }, tree, ask(wideNew, planned)).missing, [], 'the fold of a 21-file ask is planned');
  assert.deepEqual(derivePlannedFiles({ plannedFiles: ['newdir/a.ts'], criteria }, tree, ['newdir/']).missing, [], 'a file inside an asked directory is planned');
  // AC-3: a two-file ask for a directory the base lacks, folded into that directory only to stay under
  // the cap, is grounded by the fold the loop proposes: the cap fold applies while the lease stands.
  const nearCap = Array.from({ length: plannedFilesMax - 1 }, (_, index) => `src/bulk/file-${String(index).padStart(3, '0')}.ts`);
  const capFold = collapsePlannedFiles(nearCap, ['newdir/a.ts', 'newdir/b.ts'], collapseArea({ criteria: newCriteria, plannedFiles: nearCap }));
  assert.deepEqual(capFold.collapsed.map(entry => entry.scope), ['newdir/'], 'the cap folds the two files into their directory');
  assert.equal(capFold.plannedFiles.length, plannedFilesMax);
  assert.deepEqual(ask(['newdir/a.ts', 'newdir/b.ts'], nearCap), ['newdir/a.ts', 'newdir/b.ts', 'newdir/']);
  assert.deepEqual(derivePlannedFiles({ plannedFiles: capFold.plannedFiles, criteria: newCriteria }, new Set(nearCap), ask(['newdir/a.ts', 'newdir/b.ts'], nearCap)).missing, [], 'the cap fold into a directory the base lacks is planned');
  assert.deepEqual(derivePlannedFiles({ plannedFiles: capFold.plannedFiles, criteria: newCriteria }, new Set(nearCap)).missing, ['newdir/'], 'without the ask the directory is refused as before');
  assert.deepEqual(derivePlannedFiles({ plannedFiles: [...capFold.plannedFiles, 'other/'], criteria: newCriteria }, new Set(nearCap), ask(['newdir/a.ts', 'newdir/b.ts'], nearCap)).missing, ['other/'], 'a directory the fold did not produce is still refused');
  // The decision the loop routes for that ask is the cap fold, and derivation accepts exactly what it proposes.
  const cappedItem = { ...item, plannedFiles: nearCap, criteria: newCriteria, scopeRequest: { ...item.scopeRequest!, paths: ['newdir/a.ts', 'newdir/b.ts'], decision: { ...refused, paths: ['newdir/a.ts', 'newdir/b.ts'] } } } as unknown as Work;
  const cappedDecision = scopeRoutineDecision(cappedItem, now, true)!;
  assert.equal(cappedDecision.action, 'requirements');
  assert.deepEqual(cappedDecision.input!.plannedFiles, capFold.plannedFiles);
  assert.deepEqual(derivePlannedFiles({ plannedFiles: cappedDecision.input!.plannedFiles, criteria: newCriteria }, new Set(nearCap), askedScopes(cappedItem)).missing, []);
});

test('integration:scope-request-new-file — an approved exact-path widening for a file the base lacks applies under the live lease and containment quarantine, and the worker keeps its lease', async () => {
  let work = await ok(master.token, 'POST', 'work', { title: 'new file under a live lease', plannedFiles: planned, criteria, reason: 'Operator goal: one new file is scoped without ending the attempt' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the attempt' }) as Work;
  work = await reload((await engine.execute(implementer, 'claim', work.id, {}, randomUUID())).id);
  await engine.execute(implementer, 'quarantine', work.id, { epoch: work.epoch, settlementHash: 'e'.repeat(64) }, randomUUID());
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [newFile], reason: 'Move the observation job out of src/server/main.ts, over its hotspots budget' });
  work = await reload(work.id);
  assert.ok(work.containmentQuarantine, 'the attempt runs under a containment quarantine');

  // `master requirements` with the exact path: the base branch does not hold it, and no criterion
  // changes, because the item's open ask names it. What it would post is a pure widening.
  const dir = await temporaryDirectory('scope-new-file-intent'), file = join(dir, 'intent.json');
  await writeFile(file, JSON.stringify({ plannedFiles: [...planned, newFile] }));
  const sent: any[] = [];
  await derivedIntent(dir, { baseBranch: 'main' }, 'requirements', [work.key, file, 'the worker\'s ask'], {
    coordinator: async () => ({ work: [work] }), token: async () => 'operator-agent-token', tree: async () => ({ ref: 'main', files: new Set(planned) }),
    mutate: async (path, data) => { sent.push({ path, data }); return {}; } });
  assert.equal(sent.length, 1, 'the exact-path revision is not refused for a path the base lacks');
  assert.deepEqual(sent[0].data.plannedFiles, [...planned, newFile]);
  assert.deepEqual(sent[0].data.criteria, work.criteria, 'no criterion is rewritten to describe the file');

  // The loop routes the ask as that exact path, the approver approves, and it applies under the lease and quarantine.
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  await loop.cycle(state);
  work = await reload(work.id);
  const [routed] = loop.about(work);
  assert.equal(routed?.action, 'requirements', 'the ask is put to the approver');
  assert.deepEqual(routed.input.plannedFiles, [...planned, newFile], 'as the exact path, not src/');
  const [requested] = (await ok(master.token, 'GET', `work/${work.id}/decisions`)).decisions.filter((decision: any) => decision.action === 'requirements' && decision.state === 'requested');
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'One new file the worker creates to move a job out of an over-budget module' });
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, [...planned, newFile], 'the approved widening applied');
  assert.equal(work.scopeRequest, null, 'and answered the ask');
  assert.equal(work.scopeDecision!.state, 'approved');
  assert.ok(work.lease && work.lease.owner === implementer.id && work.lease.epoch === requested.input.answers.epoch, 'the worker keeps its lease');
  assert.ok(work.containmentQuarantine && work.containmentQuarantine.epoch === work.epoch, 'and the containment quarantine stands');
  assert.deepEqual(work.criteria, criteria, 'no criterion changed');
});
