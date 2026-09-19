import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { standingEscalations, type Observation, type Principal, type Work } from '../src/model.js';
import { Store } from '../src/store.js';
import { MERGE_PROTOCOL } from '../src/protocol-version.js';

// GY-75: a decision whose approval is refused on a revision race must never stay 'requested'
// forever. A pinned race settles the decision as stale, resolve and attest are pinned to what
// they act on rather than the whole revision, and the master can withdraw its own request.
// Each test is named for the proof it produces.
const repository = 'owner/decisions';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:*'], sessionKind: 'ai' };
const roster = [operator, implementer, producer];
const credentials = roster.map(principal => ({ ...principal, token: `decision-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'decision:resolve', 'decision:attest', 'decision:merge', 'decision:rework', 'decision:grant'] };
const approver = { id: 'approver-agent', token: `approver-agent-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
const head = 'c'.repeat(40), base = 'd'.repeat(40);
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let pr = 900;

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(credential, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const decide = (credential: string, work: Work, action: string, input: unknown, reason: string) => call(credential, 'POST', `work/${work.key}/decide`, { action, input, reason });
const withdraw = (credential: string, work: Work, decision: string, reason: string, key?: string) => call(credential, 'POST', `work/${work.key}/decide`, { action: 'withdraw', decision, reason }, key);
const approve = (credential: string, work: Work, decision: string, reason: string) => call(credential, 'POST', `work/${work.key}/approve`, { decision, reason });
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows;
const input = (title: string) => ({ title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }, { id: 'AC-2', text: 'Audited', proofs: ['manual:audit'] }], reason: 'Operator goal: decisions survive the races of the work they act on' });
function observation(work: Work): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha: head, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: [`src/${work.title}.ts`], scopeFiles: [], at: new Date().toISOString() };
}
async function created(title: string) {
  return ok(master.token, 'POST', 'work', input(title)) as Promise<Work>;
}
async function candidate(title: string) {
  let work = await created(title);
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'decision-host', path: `/tmp/decision/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, randomUUID());
  return engine.observe(work.id, work.revision, observation(work));
}
/** An unrelated requirement revision: strengthens the item without touching the standing escalation. */
let extraId = 8;
const extraCriterion = (work: Work) => engine.execute(operator, 'requirements', work.id, { expectedPolicyRevision: work.policyRevision, criteria: [...work.criteria, { id: `AC-${++extraId}`, text: 'Changelog entry', proofs: ['manual:changelog'] }], dependencies: [], plannedFiles: work.plannedFiles, exclusiveResources: [], producerProofs: [], reason: 'Unrelated policy growth' }, randomUUID());

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 42;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-decision-lifecycle-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('decision_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/decision_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver])
    await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:decision-stale-on-revision-race — an approval refused on a revision race settles the decision stale with both revisions, and a new request of the same action is accepted immediately', async () => {
  let work = await created('stale-on-race');
  const pinned = work.revision;
  const requested = await decide(master.token, work, 'release', { expectedRevision: pinned }, 'Next by priority');
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal(requested.body.state, 'requested');
  // A dispatch-grade mutation moves the item while the request waits for its approver.
  work = await extraCriterion(work);
  const refused = await approve(approver.token, work, requested.body.id, 'Approved in principle');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, new RegExp(`Task revision changed \\(now ${work.revision}\\); reload and request again; the decision was not applied`));
  // The refusal settled the decision in its own transaction: terminal, with the reason and both revisions.
  const listed = await ok(master.token, 'GET', `work/${work.key}/decisions`);
  const stale = listed.decisions.find((entry: any) => entry.id === requested.body.id);
  assert.equal(stale.state, 'stale');
  assert.match(stale.outcome, /Task revision changed/);
  assert.deepEqual(stale.race, { expected: { revision: pinned }, current: { revision: work.revision } });
  const recorded = (await events(work)).find(row => row.kind === 'decision.stale');
  assert.equal(recorded.actor, approver.id);
  assert.deepEqual(recorded.payload.expected, { revision: pinned });
  assert.deepEqual(recorded.payload.current, { revision: work.revision });
  assert.match(recorded.payload.reason, /revision changed/);
  assert.equal(recorded.payload.observedBy.id, approver.id);
  // A new request of the same action is accepted immediately and completes.
  const again = await decide(master.token, work, 'release', { expectedRevision: work.revision }, 'Re-requested on the fresh revision');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const applied = await approve(approver.token, work, again.body.id, 'Now the pin holds');
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.state, 'applied');
  // The policy-revision race settles the same way for a requirements decision.
  work = await reload(work.id);
  const rewrite = { expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: [], plannedFiles: work.plannedFiles, exclusiveResources: [], producerProofs: [] };
  const policyRequest = await decide(master.token, work, 'requirements', rewrite, 'Restate the standing policy');
  assert.equal(policyRequest.status, 200, JSON.stringify(policyRequest.body));
  work = await extraCriterion(work);
  const policyRefused = await approve(approver.token, work, policyRequest.body.id, 'Too late');
  assert.equal(policyRefused.status, 409);
  assert.match(policyRefused.body.error, /Policy revision changed \(now \d+\)/);
  const staleEvents = (await events(work)).filter(row => row.kind === 'decision.stale');
  assert.equal(staleEvents.length, 2);
  assert.deepEqual(staleEvents[1].payload.expected, { policyRevision: rewrite.expectedPolicyRevision });
  assert.deepEqual(staleEvents[1].payload.current, { policyRevision: work.policyRevision });
  const policyListed = await ok(master.token, 'GET', `work/${work.key}/decisions`);
  assert.equal(policyListed.decisions.find((entry: any) => entry.id === policyRequest.body.id).state, 'stale');
  // A settled decision is closed for good: not approvable, not withdrawable.
  const late = await approve(approver.token, work, requested.body.id, 'Approve the stale one');
  assert.equal(late.status, 409); assert.match(late.body.error, /already stale/);
  const takeBack = await withdraw(master.token, work, requested.body.id, 'Too late for that');
  assert.equal(takeBack.status, 409); assert.match(takeBack.body.error, /already stale/);
});

test('integration:decision-pinning-scope — resolve is pinned to the standing trigger and attest to the candidate head and policy, so unrelated item changes do not invalidate them', async () => {
  // Resolving a named escalation trigger: the item moves on while the request waits, and the
  // approval still applies because the trigger it acts on still stands.
  let work = await created('pinned-resolve');
  work = await engine.execute(operator, 'requirements', work.id, { expectedPolicyRevision: work.policyRevision, criteria: [work.criteria[0]], dependencies: [], plannedFiles: work.plannedFiles, exclusiveResources: [], producerProofs: [], reason: 'AC-2 moves to a follow-up item' }, randomUUID());
  assert.deepEqual(standingEscalations(work).map(entry => entry.trigger), ['requirement-weakening']);
  const atRequest = work.revision;
  const requested = await decide(master.token, work, 'resolve', { trigger: 'requirement-weakening', expectedRevision: atRequest }, 'The follow-up carries the retired criterion');
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  work = await extraCriterion(work);
  assert.ok(work.revision > atRequest, 'the item revision moved while the request waited');
  const approved = await approve(approver.token, work, requested.body.id, 'The requirement-weakening escalation still stands');
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.state, 'applied');
  work = await reload(work.id);
  assert.deepEqual(standingEscalations(work), []);
  const resolved = (await events(work)).find(row => row.kind === 'escalation.resolved')!;
  assert.equal(resolved.payload.details.resolvedBy, master.id);
  assert.equal(resolved.payload.details.approvedBy, approver.id);
  assert.equal((await events(work)).some(row => row.kind === 'decision.stale'), false, 'no race was recorded for the resolve');
  // Attesting a proof on a fixed head: a producer record moves the revision, the candidate head
  // and policy stay, and the approval still applies.
  let item = await candidate('pinned-attest');
  const binding = { sha: head, baseSha: base, policyRevision: item.policyRevision };
  const atCandidate = item.revision;
  const attestRequest = await decide(master.token, item, 'attest', { proof: 'manual:audit', ...binding, result: 'pass', executed: 1, skipped: 0 }, 'Audit recorded against the goal');
  assert.equal(attestRequest.status, 200, JSON.stringify(attestRequest.body));
  await engine.execute(producer, 'evidence', item.id, { proof: 'unit:works', ...binding, result: 'pass', executed: 3, skipped: 0 }, randomUUID());
  item = await reload(item.id);
  assert.ok(item.revision > atCandidate, 'the producer record moved the item revision');
  assert.deepEqual(standingEscalations(item), []);
  const attestApproved = await approve(approver.token, item, attestRequest.body.id, 'Head and policy are exactly as requested');
  assert.equal(attestApproved.status, 200, JSON.stringify(attestApproved.body));
  assert.equal(attestApproved.body.state, 'applied');
  const attested = (await reload(item.id)).evidence.find(entry => entry.proof === 'manual:audit')!;
  assert.equal(attested.trusted, true);
  // The resolve pin names the incident, not the trigger slot: once the incident it was
  // requested against is cleared by another path and the same trigger is raised again, the
  // approval refuses and settles stale instead of clearing the second, unreviewed incident,
  // and a fresh resolve of the same action is accepted immediately.
  let swapped = await created('swapped-resolve');
  swapped = await engine.execute(operator, 'requirements', swapped.id, { expectedPolicyRevision: swapped.policyRevision, criteria: [swapped.criteria[0]], dependencies: [], plannedFiles: swapped.plannedFiles, exclusiveResources: [], producerProofs: [], reason: 'AC-2 moves to a follow-up item' }, randomUUID());
  const firstIncident = standingEscalations(swapped).find(entry => entry.trigger === 'requirement-weakening')!;
  const swapRequest = await decide(master.token, swapped, 'resolve', { trigger: 'requirement-weakening', expectedRevision: swapped.revision }, 'Resolve the narrowing this item records');
  assert.equal(swapRequest.status, 200, JSON.stringify(swapRequest.body));
  // Another path clears that incident: a declared human session resolves the trigger directly.
  swapped = await engine.execute(operator, 'resolve', swapped.id, { trigger: 'requirement-weakening', expectedRevision: swapped.revision, reason: 'A human session resolves the incident the request named' }, randomUUID());
  assert.deepEqual(standingEscalations(swapped), []);
  // The scope widens with a fresh criterion, then narrows again: the same trigger is raised
  // for a new incident (AC-2 stays retired, so the widening adds AC-3).
  swapped = await engine.execute(operator, 'requirements', swapped.id, { expectedPolicyRevision: swapped.policyRevision, criteria: [...swapped.criteria, { id: 'AC-3', text: 'Changelog', proofs: ['manual:changelog'] }], dependencies: [], plannedFiles: swapped.plannedFiles, exclusiveResources: [], producerProofs: [], reason: 'Changelog criterion arrives' }, randomUUID());
  swapped = await engine.execute(operator, 'requirements', swapped.id, { expectedPolicyRevision: swapped.policyRevision, criteria: [swapped.criteria[0]], dependencies: [], plannedFiles: swapped.plannedFiles, exclusiveResources: [], producerProofs: [], reason: 'AC-3 moves to a follow-up item' }, randomUUID());
  const secondIncident = standingEscalations(swapped).find(entry => entry.trigger === 'requirement-weakening')!;
  assert.ok(secondIncident, 'the trigger stands again');
  assert.ok(secondIncident.reason.includes('AC-3') && !firstIncident.reason.includes('AC-3'), 'the standing incident is the later one, not the incident the request named');
  const swapRefused = await approve(approver.token, swapped, swapRequest.body.id, 'Approved against the incident I read');
  assert.equal(swapRefused.status, 409);
  assert.match(swapRefused.body.error, new RegExp(`The requirement-weakening escalation this decision was requested against is no longer the standing one; request it again; the decision was not applied`));
  swapped = await reload(swapped.id);
  const stillStanding = standingEscalations(swapped).find(entry => entry.trigger === 'requirement-weakening')!;
  assert.equal(stillStanding.reason, secondIncident.reason, 'the second incident is untouched by the approval');
  const swapListed = await ok(master.token, 'GET', `work/${swapped.key}/decisions`);
  const settled = swapListed.decisions.find((entry: any) => entry.id === swapRequest.body.id);
  assert.equal(settled.state, 'stale');
  assert.deepEqual(settled.race, { expected: { trigger: 'requirement-weakening', standingAt: swapRequest.body.requestedAt }, current: { trigger: 'requirement-weakening', standingAt: stillStanding.at } });
  const settledEvent = (await events(swapped)).find(row => row.kind === 'decision.stale' && row.payload.id === swapRequest.body.id);
  assert.equal(settledEvent.actor, approver.id);
  // The stale settlement unblocks the action: a resolve of the new incident is accepted at once.
  const fresh = await decide(master.token, swapped, 'resolve', { trigger: 'requirement-weakening', expectedRevision: swapped.revision }, 'Requested against the incident that stands now');
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  const freshApplied = await approve(approver.token, swapped, fresh.body.id, 'The new incident is the one reviewed');
  assert.equal(freshApplied.status, 200, JSON.stringify(freshApplied.body));
  assert.equal(freshApplied.body.state, 'applied');
  swapped = await reload(swapped.id);
  assert.deepEqual(standingEscalations(swapped), []);
});

test('integration:decision-withdraw — the master withdraws its own requested decision with a reason, and master-visible state shows it as withdrawn without blocking a re-request', async () => {
  let work = await created('withdrawn-decision');
  const requested = await decide(master.token, work, 'release', { expectedRevision: work.revision }, 'Next by priority');
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  // Only the requester may withdraw; the independent approver is refused.
  const foreign = await withdraw(approver.token, work, requested.body.id, 'Not my request');
  assert.equal(foreign.status, 403);
  assert.match(foreign.body.error, new RegExp(`Only the requester may withdraw decision ${requested.body.id}; ${master.id} requested it`));
  const key = randomUUID();
  const taken = await withdraw(master.token, work, requested.body.id, 'Priority moved behind GY-80', key);
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(taken.body.state, 'withdrawn');
  assert.equal(taken.body.outcome, 'Priority moved behind GY-80');
  const recorded = (await events(work)).find(row => row.kind === 'decision.withdrawn');
  assert.equal(recorded.actor, master.id);
  assert.equal(recorded.payload.reason, 'Priority moved behind GY-80');
  assert.equal(recorded.payload.action, 'release');
  // A replay of the same withdrawal returns its recorded receipt.
  const replay = await withdraw(master.token, work, requested.body.id, 'Priority moved behind GY-80', key);
  assert.equal(replay.status, 200); assert.equal(replay.body.state, 'withdrawn'); assert.equal(replay.body.id, requested.body.id);
  // A withdrawn decision cannot be approved, and a new request of the same action is accepted.
  const approveWithdrawn = await approve(approver.token, work, requested.body.id, 'Approve it anyway');
  assert.equal(approveWithdrawn.status, 409); assert.match(approveWithdrawn.body.error, /already withdrawn/);
  const again = await decide(master.token, work, 'release', { expectedRevision: work.revision }, 'Re-requested after the withdrawal');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const applied = await approve(approver.token, work, again.body.id, 'It holds now');
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.state, 'applied');
  // Withdrawal is refused for an unknown decision and for one that has already been applied.
  const unknown = await withdraw(master.token, work, randomUUID(), 'Nothing there');
  assert.equal(unknown.status, 404);
  const late = await withdraw(master.token, work, again.body.id, 'Too late');
  assert.equal(late.status, 409); assert.match(late.body.error, /already applied/);
  const listed = await ok(master.token, 'GET', `work/${work.key}/decisions`);
  assert.deepEqual(listed.decisions.map((entry: any) => entry.state), ['withdrawn', 'applied']);
  assert.deepEqual(listed.decisions.map((entry: any) => entry.race), [null, null]);
});

test('master withdraw takes back the master\'s own request through the decide route and master status lists stale decisions with the next command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-decision-cli-'));
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-decision-cli-credentials-'));
  const credentialFile = join(credentialDirectory, 'coordinator.token');
  const operatorFile = join(credentialDirectory, 'operator.token');
  const decisionId = randomUUID();
  const now = () => new Date().toISOString();
  const item = { id: 'blocked-1', key: 'GY-70', title: 'Needs an operator', stage: 'ready', ready: true, blocker: null, priority: 1, epoch: 0, dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['integration:loop'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], workspaces: [], evidence: [], gates: [], violations: [], createdAt: now(), updatedAt: now(), stageEnteredAt: now(), lease: null, candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], observation: null, revision: 12, policyRevision: 1 };
  const decisions: any[] = [{ id: decisionId, workId: item.id, action: 'release', input: { expectedRevision: 11 }, reason: 'Next by priority', requestedBy: 'master-operator', requestedAt: now(), state: 'stale', approvedBy: null, approvedAt: null, approvalReason: null, outcome: 'Task revision changed (now 12); reload and request again; the decision was not applied', refusals: [], race: { expected: { revision: 11 }, current: { revision: 12 } } }];
  let withdrawalBody: any, authorization = '';
  const stub = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    authorization = req.headers.authorization ?? '';
    if (req.url === '/api/status') return res.end(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, build: { commit: null, protocol: MERGE_PROTOCOL } }));
    if (req.url === '/api/work-snapshot') return res.end(JSON.stringify({ now: now(), work: [item] }));
    if (req.url === '/api/work/blocked-1/decisions') return res.end(JSON.stringify({ key: item.key, decisions }));
    if (req.url === '/api/work/GY-70/decide') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      return req.on('end', () => {
        withdrawalBody = JSON.parse(body);
        res.end(JSON.stringify({ ...decisions[0], state: 'withdrawn', outcome: withdrawalBody.reason, race: null }));
      });
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  const env = { ...process.env, GRAPHYARD_URL: stubUrl, GRAPHYARD_TOKEN: undefined as any, GRAPHYARD_TOKEN_FILE: undefined as any };
  try {
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await writeFile(operatorFile, 'operator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await mkdir(join(root, '.graphyard'));
    await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ version: 1, url: stubUrl, credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], operatorAgent: { id: 'master-operator', credentialFile: operatorFile }, run: { intervalSeconds: 5, deploymentShaField: 'commit' } }), { mode: 0o600 });
    // The withdraw runs under the master's operator-agent identity, not the coordinator credential.
    const withdrawn = JSON.parse((await exec(process.execPath, [launcher, 'master', 'withdraw', 'GY-70', decisionId, 'Priority moved'], { cwd: root, env })).stdout);
    assert.equal(withdrawn.state, 'withdrawn');
    assert.deepEqual(withdrawalBody, { action: 'withdraw', decision: decisionId, reason: 'Priority moved' });
    assert.equal(authorization, `Bearer ${'operator-token-'.padEnd(40, 'x')}`);
    // master status shows the stale decision, with the re-request as the next command.
    const status = JSON.parse((await exec(process.execPath, [launcher, 'master', 'status'], { cwd: root, env })).stdout);
    assert.deepEqual(status.terminalDecisions, [{ work: 'GY-70', id: decisionId, action: 'release', state: 'stale', reason: decisions[0].outcome, race: decisions[0].race }]);
    const attention = status.attentionItems.find((entry: any) => entry.subject === 'GY-70' && entry.text.includes('is stale'));
    assert.ok(attention, 'the stale decision raises master attention');
    assert.equal(attention.role, 'master'); assert.equal(attention.approvedBy, 'approver');
    assert.match(attention.next, /graphyard master decide GY-70 release .*graphyard master approver GY-70 DECISION/);
    // A later decision of the same action supersedes the stale one: it stays listed for the
    // record but raises no attention, so the loop is never told to re-request an action that
    // already moved on.
    const again = { ...decisions[0], id: randomUUID(), state: 'applied', outcome: 'Released to ready', race: null };
    decisions.push(again);
    const superseded = JSON.parse((await exec(process.execPath, [launcher, 'master', 'status'], { cwd: root, env })).stdout);
    assert.deepEqual(superseded.terminalDecisions.map((entry: any) => entry.id), [decisionId], 'the stale decision stays listed for the record');
    assert.equal(superseded.attentionItems.some((entry: any) => entry.subject === 'GY-70' && entry.text.includes('is stale')), false, 'a superseded stale decision raises no attention');
    // When the later decision goes stale too, it is the one that raises attention: the latest
    // decision for the action, not every stale one in the history.
    decisions[1] = { ...again, state: 'stale', outcome: 'Task revision changed (now 13); reload and request again; the decision was not applied', race: { expected: { revision: 12 }, current: { revision: 13 } } };
    const raised = JSON.parse((await exec(process.execPath, [launcher, 'master', 'status'], { cwd: root, env })).stdout);
    assert.deepEqual(raised.terminalDecisions.map((entry: any) => entry.id), [decisionId, again.id]);
    const staleAttention = raised.attentionItems.filter((entry: any) => entry.subject === 'GY-70' && entry.text.includes('is stale'));
    assert.equal(staleAttention.length, 1, 'only the latest stale decision for the action raises attention');
    assert.ok(staleAttention[0].text.includes(again.id), 'attention names the latest stale decision, not the superseded one');
  } finally {
    await new Promise<void>(resolve => stub.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true });
  }
});
