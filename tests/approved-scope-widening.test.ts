import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
// Namespace imports, so a tree without the change still loads and its cases fail on what they exercise.
import * as engineModule from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { decisionInput } from '../src/master.js';
import * as decisionsModule from '../src/daemon/decisions.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { nonRepositoryPaths, nonRepositoryReason } from '../src/model/scope-repository.js';
import { decideScopeRequest, routableScopeRequest } from '../src/model/scope.js';

// GY-1484: on GY-1480 the independent approver approved two routed scope widenings, and both settled
// failed — "The scope request this widening answers is no longer open" — because the worker's wait
// window ran out (it withdrew) or its attempt ended before the approval applied. An approved widening
// now applies through its decision whatever became of the request it answered, and is recorded on
// the item; a failure of that kind no longer counts toward the loop's stop-requesting threshold.
// One case per proof: integration:approved-scope-widening-applies, unit:failed-widening-not-stale-counted.
const repository = 'owner/approved-scope';
const operator: Principal = { id: 'scope-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'scope-implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'scope-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `approved-scope-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'scope-master', token: `scope-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const approver = { id: 'graphyard-approver-graphyard', token: `scope-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
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
const decisions = async (work: Work) => (await ok(master.token, 'GET', `work/${work.key}/decisions`)).decisions as any[];
const layout = 'src/widget/Layout.tsx', daemon = 'src/daemon/cycle-widget.ts';

async function claimed(title: string) {
  let work = await ok(master.token, 'POST', 'work', { title, plannedFiles: [layout], criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], reason: 'Approved widening fixture' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the attempt' }) as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'scope-host', path: `/tmp/approved-scope/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  return reload(work.id);
}
/** The worker asks for a file no rule implies, the rule refuses it, and the master routes it to the approver as the loop does (scopeRoutineDecision). */
async function routed(title: string, sha?: string | null) {
  const work = await claimed(title);
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [daemon], reason: 'AC-1 needs the research worktree, which only the cycle module creates' });
  const asked = await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch, treeRead: true }) as Work;
  assert.equal(asked.scopeRequest?.decision?.decidedBy, 'graphyard', 'the widening rule defers it to the approver');
  const request = asked.scopeRequest!;
  const answers = { epoch: request.epoch, at: request.at, ...(sha === undefined ? {} : { sha }) };
  const decision = await ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'requirements', input: decisionInput('requirements', asked, { plannedFiles: [layout, daemon], answers }), reason: `${work.key}: the worker asks for ${daemon}` });
  assert.equal(decision.state, 'requested');
  return { work: asked, request, decision };
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1484;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('approved-scope-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('approved_scope_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/approved_scope_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver])
    await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Approved widening fixture' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:approved-scope-widening-applies — an approved widening applies though its scope request closed first, and is recorded on the item', async () => {
  // GY-1480's first failure: the wait window ran out and the request was withdrawn before the approval landed.
  const withdrawn = await routed('Approval after withdrawal');
  await ok(token(implementer), 'POST', `work/${withdrawn.work.id}/scope`, { epoch: withdrawn.work.epoch, paths: [], reason: 'Withdrawn by the worker' });
  assert.equal((await reload(withdrawn.work.id)).scopeRequest, null, 'the request is closed');
  await ok(approver.token, 'POST', `work/${withdrawn.work.id}/approve`, { decision: withdrawn.decision.id, reason: 'Additive and required by AC-1' });
  let item = await reload(withdrawn.work.id);
  const [applied] = await decisions(item);
  assert.equal(applied.state, 'applied', JSON.stringify(applied));
  assert.deepEqual(item.plannedFiles, [layout, daemon], 'the approved widening applied');
  assert.ok(item.lease && item.lease.epoch === withdrawn.work.epoch, 'the attempt keeps its lease');
  assert.deepEqual({ ...item.scopeDecision, at: undefined, waitedMs: undefined }, { state: 'approved', reason: 'Additive and required by AC-1', at: undefined, waitedMs: undefined, decidedBy: approver.id,
    paths: [daemon], requestedBy: master.id, requestedAt: withdrawn.request.at, epoch: withdrawn.request.epoch }, 'the applied widening is recorded as the closed request\'s decision');
  const [revision] = (await store.pool.query(`SELECT payload FROM events WHERE work_id=$1 AND kind='requirements' ORDER BY seq DESC LIMIT 1`, [item.id])).rows;
  assert.deepEqual(revision.payload.details.answeredClosedRequest, { epoch: withdrawn.request.epoch, at: withdrawn.request.at, approver: approver.id }, 'the ledger records the late answer');

  // GY-1480's second failure: the asking attempt ended 28 seconds before the approval.
  const ended = await routed('Approval after the attempt ended');
  await engine.execute(implementer, 'release', ended.work.id, { epoch: ended.work.epoch }, randomUUID());
  item = await reload(ended.work.id);
  assert.equal(item.lease, null);
  assert.equal(item.scopeRequest, null, 'the attempt\'s request closed with it');
  await ok(approver.token, 'POST', `work/${ended.work.id}/approve`, { decision: ended.decision.id, reason: 'Still additive and required' });
  item = await reload(ended.work.id);
  assert.equal((await decisions(item))[0].state, 'applied');
  assert.deepEqual(item.plannedFiles, [layout, daemon]);
  assert.equal(item.scopeDecision?.state, 'approved');
  assert.equal(item.scopeDecision?.requestedBy, implementer.id, 'the carried ask names its worker');
  assert.equal(item.carriedScopeRequest, null, 'the carried ask is answered');

  // A widening grounded on findings read for a head still lapses with its request, and nothing widens outside a decision.
  const grounded = await routed('Finding-grounded widening', null);
  await ok(token(implementer), 'POST', `work/${grounded.work.id}/scope`, { epoch: grounded.work.epoch, paths: [], reason: 'Withdrawn by the worker' });
  await ok(approver.token, 'POST', `work/${grounded.work.id}/approve`, { decision: grounded.decision.id, reason: 'Approved' });
  const [failed] = await decisions(grounded.work);
  assert.equal(failed.state, 'failed');
  assert.match(failed.outcome, /scope request this widening answers is no longer open/);
  assert.deepEqual((await reload(grounded.work.id)).plannedFiles, [layout]);
  // The key of an approved decision authorizes only the widening that decision recorded (review B1): reused for another one, it is refused.
  const reused = await engine.execute({ id: master.id, role: 'admin', sessionKind: 'ai' }, 'requirements', grounded.work.id,
    { ...decisionInput('requirements', await reload(grounded.work.id), { plannedFiles: [layout, daemon], answers: { epoch: grounded.request.epoch, at: grounded.request.at } }), reason: 'reusing an approval' }, `decision:${grounded.decision.id}`).then(() => null, (error: Error) => error);
  assert.match(String(reused?.message), /no longer open/, 'an approval of other answers does not authorize this widening');
  assert.deepEqual((await reload(grounded.work.id)).plannedFiles, [layout]);
  const hand = await routed('Hand widening of a closed ask');
  await ok(token(implementer), 'POST', `work/${hand.work.id}/scope`, { epoch: hand.work.epoch, paths: [], reason: 'Withdrawn by the worker' });
  const current = await reload(hand.work.id);
  const direct = await call(master.token, 'POST', `work/${hand.work.id}/requirements`, { ...decisionInput('requirements', current, { plannedFiles: [layout, daemon], answers: { epoch: hand.request.epoch, at: hand.request.at } }), reason: 'not a decision' });
  assert.equal(direct.status, 409, JSON.stringify(direct.body));
  assert.match(direct.body.error, /no longer open/);
});

test('integration:approved-scope-widening-applies — a late widening is bound to the exact approved request it answers', () => {
  const answers = { epoch: 2, at: '2026-10-07T21:59:33.000Z' }, input = { plannedFiles: [layout, daemon], answers };
  const approval = { requester: master.id, input };
  assert.equal(engineModule.sameApprovedWidening(approval, master.id, { plannedFiles: [daemon, layout], answers }), true, 'the approved widening, in any order');
  assert.equal(engineModule.sameApprovedWidening(approval, master.id, { plannedFiles: [layout, daemon, 'src/engine.ts'], answers }), false, 'other paths');
  assert.equal(engineModule.sameApprovedWidening(approval, master.id, { plannedFiles: [layout, daemon], answers: { ...answers, at: '2026-10-07T22:10:00.000Z' } }), false, 'another request');
  assert.equal(engineModule.sameApprovedWidening(approval, master.id, { plannedFiles: [layout, daemon], answers: { ...answers, epoch: 3 } }), false, 'another attempt');
  assert.equal(engineModule.sameApprovedWidening(approval, master.id, { plannedFiles: [layout, daemon], answers: { ...answers, sha: null } }), false, 'a finding-grounded answer');
  assert.equal(engineModule.sameApprovedWidening(approval, 'someone-else', { plannedFiles: [layout, daemon], answers }), false, 'another requester');
  assert.equal(engineModule.sameApprovedWidening({ requester: master.id, input: { reason: 'resolve' } }, master.id, { plannedFiles: [layout, daemon], answers }), false, 'a decision that answered no request');
});

test('unit:failed-widening-not-stale-counted — a widening that failed only because its request closed is not counted toward the stop threshold while its paths stay unplanned', () => {
  const watch = { action: 'requirements' as const, scope: { epoch: 1, at: '2026-10-07T21:59:33.000Z', requestedBy: 'worker', paths: [daemon] } };
  const closed = { state: 'failed', outcome: 'The scope request this widening answers is no longer open' };
  const lapsed = { state: 'failed', outcome: 'Epoch 1, which asked for this scope, no longer holds the lease' };
  const unplanned = { plannedFiles: [layout] }, planned = { plannedFiles: [layout, 'src/daemon/'] };
  assert.equal(decisionsModule.uncountedScopeFailure(watch, closed, unplanned), true, 'the closed request is not counted while the blocker stands');
  assert.equal(decisionsModule.uncountedScopeFailure(watch, lapsed, unplanned), true, 'nor is the ended attempt');
  // The loop keeps asking: three such races in a row stay under maxDecisionRequests.
  let requests = 1;
  for (let race = 0; race < decisionsModule.maxDecisionRequests + 2; race++) {
    if (decisionsModule.uncountedScopeFailure(watch, closed, unplanned)) requests -= 1;
    assert.ok(requests < decisionsModule.maxDecisionRequests, `race ${race + 1} does not reach the stop threshold`);
    requests += 1;
  }
  assert.equal(decisionsModule.uncountedScopeFailure(watch, closed, planned), false, 'once plannedFiles cover the paths, nothing is left to re-escalate');
  assert.equal(decisionsModule.uncountedScopeFailure(watch, { state: 'failed', outcome: 'Policy revision changed (now 3); reload and request again' }, unplanned), false, 'any other failure counts');
  assert.equal(decisionsModule.uncountedScopeFailure(watch, { state: 'refused', outcome: 'The scope request this widening answers is no longer open' }, unplanned), false, 'a refusal is a judgement');
  assert.equal(decisionsModule.uncountedScopeFailure({ action: 'rework', scope: watch.scope } as never, closed, unplanned), false, 'only a requirements decision');
  assert.equal(decisionsModule.uncountedScopeFailure({ action: 'requirements', scope: null }, closed, unplanned), false, 'only one that answers a scope request');
});

// GY-1764. A scope ask is checked against the repository tree before it can become an approver decision:
// GY-1696's worker asked for 'daemon.relea' and 'upgrade.align' (truncated master-status fields) and for
// '.graphyard/master.json' (the install-local credential), and each ask spent an approver session.
const tree = new Set(['src/model/scope.ts', 'src/daemon/cycle-scope.ts', 'tests/scope.test.ts', 'docs/master-agent.md', 'README.md', 'package.json']);

test('unit:scope-ask-nonrepository-path-refused — paths that are not repository files are refused naming the path and the near miss', () => {
  const found = nonRepositoryPaths(['daemon.relea', 'upgrade.align', 'src/model/scope.ts'], tree);
  assert.deepEqual(found.map(entry => entry.path), ['daemon.relea', 'upgrade.align']);
  assert.equal(found[0]!.nearMiss, 'daemon.release');
  assert.equal(found[1]!.nearMiss, 'upgrade.alignedRelease');
  const reason = nonRepositoryReason(found);
  assert.match(reason, /daemon\.relea is not a repository file/);
  assert.match(reason, /did you mean daemon\.release\? daemon\.release is a master-status field, not a file/);
  assert.deepEqual(nonRepositoryPaths(['nowhere/else/file.ts'], tree).map(entry => entry.path), ['nowhere/else/file.ts'], 'inside no tracked directory');
  // The rule itself refuses, and the refusal is the evidence gate's, which nothing routes.
  const verdict = decideScopeRequest({ plannedFiles: ['src/model/scope.ts'], criteria: [{ id: 'AC-1', text: 'x', proofs: [] }] }, { paths: ['daemon.relea'] }, { nonRepository: found });
  assert.equal(verdict.state, 'refused');
  assert.equal(verdict.nonRepository, true);
  assert.match(verdict.reason, /daemon\.release/);
});

test('unit:scope-ask-install-local-path-refused — the install-local .graphyard/ directory is never a repository path', () => {
  const found = nonRepositoryPaths(['.graphyard/master.json', '.graphyard/', '.graphyard/worktrees/x/y.ts'], new Set([...tree, '.graphyard/tracked-by-mistake.json']));
  assert.deepEqual(found.map(entry => [entry.path, entry.why]), [['.graphyard/master.json', 'install-local'], ['.graphyard/', 'install-local'], ['.graphyard/worktrees/x/y.ts', 'install-local']]);
  assert.match(nonRepositoryReason(found), /\.graphyard\/master\.json is under the install-local \.graphyard\/ directory/);
});

test('unit:scope-ask-new-file-still-decidable — a file a change will add beside tracked ones, and a directory entry, are not refused', () => {
  assert.deepEqual(nonRepositoryPaths(['src/model/scope-repository.ts', 'src/daemon/new/deeper/file.ts', 'tests/scope-repository.test.ts', 'docs/', 'src/*.ts', 'src/model/'], tree), []);
  assert.deepEqual(nonRepositoryPaths(['README.md', 'package.json'], tree), [], 'tracked root files');
  assert.deepEqual(nonRepositoryPaths(['./src/model/scope.ts', './src/daemon/new-file.ts', './src/*.ts'], tree), [], 'a ./-prefixed tracked or new path stays decidable');
  assert.deepEqual(nonRepositoryPaths(['./.graphyard/master.json', './nowhere/x.ts'], tree).map(entry => entry.why), ['install-local', 'untracked'], 'a ./ prefix hides neither refusal');
});

test('integration:decision-refused-gy-1696-replay — a worker\'s ask for truncated field names or the install-local credential is refused in-process and never routed to the approver', async () => {
  for (const [title, paths] of [['truncated fields', ['daemon.relea', 'upgrade.align']], ['install-local credential', ['.graphyard/master.json']]] as const) {
    const work = await claimed(`GY-1696 replay: ${title}`);
    await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths, reason: 'AC-1 is a live observation only a master session can record' });
    // Base: the loop decides without the tree, the rule defers to the approver, and the ask is routed verbatim.
    const asked = await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch }) as Work;
    const now = Date.parse(asked.lease!.expiresAt) - 60_000; // inside the lease, from the item's own record
    assert.equal(routableScopeRequest(asked, now), null, `${title}: a refusal the tree was never read for is not routed to the approver`);
    assert.equal(decisionsModule.scopeRoutineDecision(asked, now, true), null, `${title}: and forms no requirements decision`);
    // Candidate: the loop reads the tree, and the same cycle's decision refuses the ask for what it names.
    const offenders = nonRepositoryPaths(paths, tree);
    const refused = await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch, nonRepository: offenders }) as Work;
    assert.equal(refused.scopeRequest?.decision?.state, 'refused');
    assert.equal(refused.scopeRequest?.decision?.nonRepository, true);
    assert.match(refused.scopeRequest!.decision!.reason, /not a repository file|install-local/);
    assert.equal(routableScopeRequest(refused, now), null, `${title}: never routed`);
    assert.equal(decisionsModule.scopeRoutineDecision(refused, now, true), null, `${title}: no approver decision`);
    assert.deepEqual((await decisions(refused)).filter(decision => decision.action === 'requirements'), [], `${title}: none was requested`);
  }
});

// GY-1764 rework, AC-1/AC-3: the replay above posts the offenders itself; these drive the entry point the
// loop really claims — the executor's approve-scope handler — against the real control plane, once with an
// injected tree and once with the wiring a shipped executor builds itself from its coordinator checkout.
const executorEffects = (repositoryFiles?: () => Promise<ReadonlySet<string>>) => ({
  snapshot: async () => ({ work: (await store.list()) as Work[], now: '2026-10-13T08:30:00.000Z' }),
  mutate: async (path: string, body: unknown) => (await ok(token(coordinator), 'POST', path, body)) as unknown,
  agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}),
  dispatchWorker: async () => { throw new Error('not reached'); }, launchReview: async () => { throw new Error('not reached'); },
  launchProducer: async () => { throw new Error('not reached'); }, observeDeployment: async () => { throw new Error('not reached'); },
  ...(repositoryFiles ? { repositoryFiles } : {}),
});

async function claimedExecutorAsk(title: string, paths: readonly string[]) {
  const work = await claimed(`GY-1696 replay: ${title}`);
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths, reason: 'AC-1 is a live observation only a master session can record' });
  return work;
}

const executorRow = (work: Work) => ({ key: work.key, work: work.id, kind: 'approve-scope', inputs: { kind: 'approve-scope', epoch: work.epoch } }) as never;

async function refusedNotRouted(work: Work, title: string) {
  const decided = await reload(work.id);
  assert.equal(decided.scopeRequest?.decision?.state, 'refused', `${title}: refused`);
  assert.equal(decided.scopeRequest?.decision?.nonRepository, true, `${title}: as its own verdict`);
  const now = Date.parse(decided.lease!.expiresAt) - 60_000;
  assert.equal(routableScopeRequest(decided, now), null, `${title}: the claimed action's refusal is never routed`);
  assert.equal(decisionsModule.scopeRoutineDecision(decided, now, true), null, `${title}: and forms no requirements decision`);
  assert.deepEqual((await decisions(decided)).filter(entry => entry.action === 'requirements'), [], `${title}: none was requested`);
  return decided;
}

test('integration:approve-scope-executor-claimed-path — a claimed approve-scope action reads the tree, and the control plane refuses what it refutes', async () => {
  const { controlPlaneHandlers } = await import('../src/executor.js');
  const tree = new Set(['src/model/scope.ts', 'src/daemon/cycle-scope.ts', 'docs/master-agent.md', 'README.md', 'package.json']);
  const handlers = controlPlaneHandlers(() => ({}) as never, executorEffects(() => Promise.resolve(tree)) as never);
  for (const [title, paths] of [['truncated fields', ['daemon.relea', 'upgrade.align']], ['install-local credential', ['.graphyard/master.json']]] as const) {
    const work = await claimedExecutorAsk(title, paths);
    const report = await handlers['approve-scope']!(executorRow(work), { id: 'executor-1', host: 'scope-host' }) as string;
    assert.match(report, /refused — /);
    await refusedNotRouted(work, title);
  }
});

test('integration:approve-scope-executor-default-tree — the executor builds its evidence read from the coordinator checkout it loads from', async () => {
  const { controlPlaneHandlers } = await import('../src/executor.js');
  // A clean fake checkout: bin/graphyard.mjs committed, origin/main at it, so the executor's own
  // baseTree read resolves without a network and the checkout guard finds nothing dirty.
  const checkout = await temporaryDirectory('executor-checkout');
  const git = (args: string[]) => execFileSync('git', ['-C', checkout, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  await (await import('node:fs/promises')).mkdir(join(checkout, 'bin'), { recursive: true });
  await writeFile(join(checkout, 'bin/graphyard.mjs'), '');
  git(['init', '-q', '-b', 'main', '.']);
  git(['add', 'bin/graphyard.mjs']);
  git(['-c', 'user.email=executor@test', '-c', 'user.name=executor', 'commit', '-q', '-m', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const handlers = controlPlaneHandlers(() => ({ cliPath: join(checkout, 'bin/graphyard.mjs'), baseBranch: 'main' }) as never, executorEffects() as never);
  for (const paths of [['daemon.relea'], ['.graphyard/master.json']]) {
    const title = `default tree: ${paths.join(', ')}`;
    const work = await claimedExecutorAsk(title, paths);
    await handlers['approve-scope']!(executorRow(work), { id: 'executor-1', host: 'scope-host' });
    const decided = await refusedNotRouted(work, title);
    assert.match(decided.scopeRequest!.decision!.reason, /not a repository file|install-local/);
  }
});

test('integration:scope-request-command-evidence — the request command answers a scope ask in one transaction with the asker\'s tree evidence, refuse-only', async () => {
  // The typed scope-request branch applies the rule in the transaction that records the ask; the
  // evidence rides with it, validated and restricted to the paths the ask names (GY-1764).
  const work = await claimedExecutorAsk('request command evidence', ['daemon.relea']);
  const asked = await ok(token(implementer), 'POST', `work/${work.id}/request`, { type: 'scope-request', epoch: work.epoch, paths: ['daemon.relea'], reason: 'AC-1 is a live observation only a master session can record', release: false, nonRepository: [{ path: 'daemon.relea', nearMiss: 'daemon.release', why: 'untracked' }] }) as Work;
  assert.equal(asked.scopeRequest?.decision?.state, 'refused');
  assert.equal(asked.scopeRequest?.decision?.nonRepository, true, 'refused as its own verdict, in the transaction that recorded the ask');
  const now = Date.parse(asked.lease!.expiresAt) - 60_000;
  assert.equal(routableScopeRequest(asked, now), null, 'never routed to the approver');
  assert.deepEqual((await decisions(asked)).filter(entry => entry.action === 'requirements'), [], 'no approver session is spent');
  // A report that names a path the ask does not name is ignored, so a bad report never refuses an ask:
  // the verdict stays the ordinary rule refusal, which the loop may still put to the approver.
  const unasked = await claimedExecutorAsk('request command ignores unasked evidence', ['daemon.relea']);
  const other = await ok(token(implementer), 'POST', `work/${unasked.id}/request`, { type: 'scope-request', epoch: unasked.epoch, paths: ['daemon.relea'], reason: 'AC-1 is a live observation only a master session can record', release: false, nonRepository: [{ path: 'upgrade.align', nearMiss: null, why: 'untracked' }] }) as Work;
  assert.equal(other.scopeRequest?.decision?.state, 'refused');
  assert.equal(other.scopeRequest?.decision?.nonRepository, undefined, 'the unasked offender is ignored');
  assert.equal(routableScopeRequest(other, now), null, 'the typed ask carries no tree reading of the loop\'s, so it is not routable yet');
  const read = await ok(token(coordinator), 'POST', `work/${unasked.id}/autoscope`, { epoch: unasked.epoch, treeRead: true }) as Work;
  assert.ok(routableScopeRequest(read, now), 'once the loop read the tree for it, the ordinary refusal is routable, as before');
});
