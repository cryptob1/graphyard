import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { Store } from '../src/store.js';
import { MERGE_PROTOCOL } from '../src/protocol-version.js';
import { approverSessionName } from '../src/master.js';
import { approvalStep, approvalWatchSchema } from '../src/master-daemon.js';
import { terminalDecisions, unansweredDecisions } from '../src/cli/decision-report.js';

// GY-141: an approver's refusal is a recorded outcome, not a session that ended without
// approving. A refused decision is reported with its reason and cannot be retried unchanged, and a
// decision nobody judged is reported unanswered, distinct from a refusal. Each test is named for
// the proof it produces.
const repository = 'owner/refusals';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const credentials = [{ ...operator, token: `refusal-operator-${'x'.repeat(32)}` }];
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'decision:rework'] };
const approver = { id: 'approver-agent', token: `approver-agent-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const created = async (title: string) => {
  const result = await call(master.token, 'POST', 'work', { title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Operator goal: refusals are recorded' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body as Work;
};
const release = (work: Work, reason: string) => call(master.token, 'POST', `work/${work.key}/decide`, { action: 'release', input: { expectedRevision: work.revision }, reason });
const refuse = (credential: string, work: Work, decision: string, reason: string) => call(credential, 'POST', `work/${work.key}/approve`, { action: 'refuse', decision, reason });

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 141;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-approver-refusal-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('refusal_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/refusal_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver]) {
    const provisioned = await call(credentials[0].token, 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  }
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

/**
 * A stub control plane for the CLI: it answers what `master` reads at start-up, serves the given
 * decision histories, and records every mutation it receives with the credential that sent it.
 */
async function stubbedMaster(item: { id: string; key: string }, decisions: () => unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-refusal-cli-'));
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-refusal-credentials-'));
  const files = { coordinator: join(credentialDirectory, 'coordinator.token'), operator: join(credentialDirectory, 'operator.token'), approver: join(credentialDirectory, 'approver.token') };
  const now = () => new Date().toISOString();
  const work = { id: item.id, key: item.key, title: 'Refused', stage: 'ready', ready: true, blocker: null, priority: 1, epoch: 0, dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['integration:loop'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], workspaces: [], evidence: [], gates: [], violations: [], createdAt: now(), updatedAt: now(), stageEnteredAt: now(), lease: null, candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], observation: null, revision: 3, policyRevision: 1 };
  const mutations: { path: string; authorization: string; body: any }[] = [];
  const stub = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') return res.end(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, build: { commit: null, protocol: MERGE_PROTOCOL } }));
    if (req.url === '/api/work-snapshot') return res.end(JSON.stringify({ now: now(), work: [work] }));
    if (req.url === `/api/work/${item.id}/decisions`) return res.end(JSON.stringify({ key: item.key, decisions: decisions() }));
    if (req.method === 'POST') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      return req.on('end', () => { mutations.push({ path: req.url!, authorization: req.headers.authorization ?? '', body: JSON.parse(body) }); res.end(JSON.stringify({ state: 'refused' })); });
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await writeFile(files.coordinator, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await writeFile(files.operator, 'operator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await writeFile(files.approver, 'approver-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(join(root, '.graphyard'));
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ version: 1, url: stubUrl, credentialFile: files.coordinator, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], operatorAgent: { id: 'master-operator', credentialFile: files.operator }, approver: { id: 'approver-agent', credentialFile: files.approver }, run: { intervalSeconds: 5, deploymentShaField: 'commit' } }), { mode: 0o600 });
  const env = (extra: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env, GRAPHYARD_URL: stubUrl };
    for (const name of Object.keys(base)) if (name.startsWith('GRAPHYARD_') && name !== 'GRAPHYARD_URL' && name !== 'GRAPHYARD_TEST_PORT') delete base[name];
    return { ...base, ...extra } as NodeJS.ProcessEnv;
  };
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    try { return { ok: true, stdout: (await exec(process.execPath, [launcher, 'master', ...args], { cwd: root, env: env(extra) })).stdout, stderr: '' }; }
    catch (error: any) { return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }; }
  };
  const close = async () => { await new Promise<void>(resolve => stub.close(() => resolve())); await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); };
  return { files, mutations, run, close };
}

test('integration:approver-refusal-recorded — an approver session records a refusal: the decision ends refused with the approver, the reason and the time; the requester cannot refuse its own decision, and the CLI write runs only under the approver session\'s credential', async () => {
  const work = await created('refusal-recorded');
  const requested = await release(work, 'Next by priority');
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  // The requester is not the one who judges its request: its refusal is refused, and the decision stands.
  const own = await refuse(master.token, work, requested.body.id, 'Changed my mind');
  assert.equal(own.status, 403);
  assert.match(own.body.error, /requester cannot refuse its own decision/);
  assert.match(own.body.error, /master withdraw/);
  // The approver refuses, and the refusal is a terminal outcome carrying who, why and when.
  const before = Date.now();
  const reason = 'The item is not next by priority: GY-3 blocks it and releasing it now would idle a worker';
  const refused = await refuse(approver.token, work, requested.body.id, reason);
  assert.equal(refused.status, 200, JSON.stringify(refused.body));
  assert.equal(refused.body.state, 'refused');
  assert.equal(refused.body.refusal.approver, approver.id);
  assert.equal(refused.body.refusal.reason, reason);
  assert.ok(Date.parse(refused.body.refusal.at) >= before - 5_000, 'the refusal carries the time it was recorded');
  const listed = (await call(master.token, 'GET', `work/${work.key}/decisions`)).body.decisions.find((entry: any) => entry.id === requested.body.id);
  assert.equal(listed.state, 'refused');
  assert.deepEqual(listed.refusal, refused.body.refusal);
  assert.equal(listed.outcome, reason);
  const ledger = (await store.pool.query("SELECT actor, payload FROM events WHERE work_id=$1 AND kind='decision.declined'", [work.id])).rows;
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].actor, approver.id);
  assert.equal(ledger[0].payload.reason, reason);
  // Terminal: it can be neither approved nor refused again.
  const late = await call(approver.token, 'POST', `work/${work.key}/approve`, { decision: requested.body.id, reason: 'Approve after all' });
  assert.equal(late.status, 409); assert.match(late.body.error, /already refused/);
  const again = await refuse(approver.token, work, requested.body.id, 'Refused twice');
  assert.equal(again.status, 409); assert.match(again.body.error, /already refused/);

  // The CLI: `master refuse` sends the refusal under the approver session's own credential file…
  const cli = await stubbedMaster({ id: work.id, key: work.key }, () => []);
  try {
    const decision = randomUUID();
    const sent = await cli.run(['refuse', work.key, decision, 'Not', 'justified'], { GRAPHYARD_TOKEN_FILE: cli.files.approver });
    assert.ok(sent.ok, sent.stderr);
    assert.deepEqual(cli.mutations.map(entry => ({ path: entry.path, body: entry.body })), [{ path: `/api/work/${work.key}/approve`, body: { action: 'refuse', decision, reason: 'Not justified' } }]);
    assert.equal(cli.mutations[0].authorization, `Bearer ${'approver-token-'.padEnd(40, 'x')}`);
    // …and never from the master's session or with one of the master's own credentials.
    const fromMaster = await cli.run(['refuse', work.key, decision, 'Mine'], { GRAPHYARD_TOKEN_FILE: cli.files.approver, GRAPHYARD_MASTER: '1' });
    assert.equal(fromMaster.ok, false); assert.match(fromMaster.stderr, /master never judges its own decisions/);
    const requesterCredential = await cli.run(['refuse', work.key, decision, 'Mine'], { GRAPHYARD_TOKEN_FILE: cli.files.operator });
    assert.equal(requesterCredential.ok, false); assert.match(requesterCredential.stderr, /master's own credentials/);
    const noSession = await cli.run(['refuse', work.key, decision, 'Mine']);
    assert.equal(noSession.ok, false); assert.match(noSession.stderr, /runs in an approver session/);
    assert.equal(cli.mutations.length, 1, 'no refused invocation reached the control plane');
  } finally { await cli.close(); }
});

test('integration:refused-decision-blocks-identical-retry — master status reports a refused decision with the approver\'s reason and answering the refusal as the next step; an identical re-request is refused naming the prior refusal, and one that cites it with a new reason is accepted', async () => {
  const work = await created('refusal-retry');
  const reasonGiven = 'Next by priority';
  const requested = await release(work, reasonGiven);
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const refusal = 'GY-3 blocks it; releasing it now idles a worker';
  assert.equal((await refuse(approver.token, work, requested.body.id, refusal)).status, 200);

  // The same request, unchanged, is the unjustified request retried: refused, naming the refusal.
  const identical = await release(work, reasonGiven);
  assert.equal(identical.status, 409);
  assert.match(identical.body.error, new RegExp(`Decision ${requested.body.id} \\(release\\) with this input was refused by ${approver.id}: ${refusal}`));
  assert.match(identical.body.error, /identical request is refused/);
  // A new reason that does not answer the refusal is still the same request.
  const uncited = await release(work, 'Really next by priority');
  assert.equal(uncited.status, 409); assert.match(uncited.body.error, new RegExp(requested.body.id));
  // Citing the refusal but repeating the refused reason gives it nothing it lacked.
  const repeated = await release(work, `${requested.body.id}: ${reasonGiven}.`);
  assert.equal(repeated.status, 409); assert.match(repeated.body.error, /identical request is refused/);

  // master status names it with the approver's reason and the next step: answering the refusal.
  const history = (await call(master.token, 'GET', `work/${work.key}/decisions`)).body.decisions;
  const cli = await stubbedMaster({ id: work.id, key: work.key }, () => history);
  try {
    const shown = await cli.run(['status']);
    assert.ok(shown.ok, shown.stderr);
    const status = JSON.parse(shown.stdout);
    const listed = status.terminalDecisions.find((entry: any) => entry.id === requested.body.id);
    assert.deepEqual({ state: listed.state, reason: listed.reason, refusedBy: listed.refusedBy }, { state: 'refused', reason: refusal, refusedBy: approver.id });
    assert.equal(status.counts.refusedDecisions, 1);
    const attention = status.attentionItems.find((entry: any) => entry.subject === work.key && entry.text.includes('was refused'));
    assert.ok(attention, 'the refused decision raises master attention');
    assert.equal(attention.text, `Decision ${requested.body.id} (release) was refused by ${approver.id}: ${refusal}. Answer the refusal: an identical request is refused, so a new one must cite ${requested.body.id} with what the refused request lacked, or the item needs something else`);
    assert.equal(attention.role, 'master');
    assert.match(attention.next, new RegExp(`^Answer the refusal: graphyard master decide ${work.key} release .*citing ${requested.body.id}`));
  } finally { await cli.close(); }

  // A request that answers the refusal — citing it, with what the first lacked — is accepted.
  const answered = await release(work, `Answering refusal ${requested.body.id}: GY-3 was delivered at 14:02, so nothing blocks it now`);
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.state, 'requested');
});

test('unit:unanswered-decisions-surfaced — a decision left at requested whose approver session ended without any write is reported unanswered with its age, distinct from a refusal; a live session, a refused decision and an unreadable Herdr report nothing', async () => {
  const now = Date.parse('2026-09-23T15:00:00.000Z');
  const decision = randomUUID(), manual = randomUUID(), declined = randomUUID();
  const session = approverSessionName({ key: 'GY-7' }, decision);
  const decisions = [
    { id: decision, action: 'rework', state: 'requested', requestedAt: '2026-09-23T14:35:00.000Z' },
    { id: declined, action: 'release', state: 'refused', requestedAt: '2026-09-23T14:00:00.000Z', outcome: 'Not justified', refusal: { approver: 'approver-agent', reason: 'Not justified', at: '2026-09-23T14:10:00.000Z' } },
  ];
  const watches = [{ work: 'GY-7', decision, agentName: session }];
  // While the approver session is working, the decision is with it: nothing to report.
  const working = { available: true, agents: [{ name: session, agent_status: 'working' }] };
  assert.deepEqual(unansweredDecisions([{ key: 'GY-7', decisions }], watches, working, now), []);
  // The session ends without a write: the decision is unanswered, with its age, and the refused one is not.
  const ended = { available: true, agents: [] };
  assert.deepEqual(unansweredDecisions([{ key: 'GY-7', decisions }], watches, ended, now),
    [{ work: 'GY-7', id: decision, action: 'rework', requestedAt: '2026-09-23T14:35:00.000Z', session, ageMs: 25 * 60_000, age: '25m' }]);
  // A session Herdr reports done is ended too.
  assert.equal(unansweredDecisions([{ key: 'GY-7', decisions }], watches, { available: true, agents: [{ name: session, agent_status: 'done' }] }, now).length, 1);
  // Herdr unreadable: nothing is concluded.
  assert.deepEqual(unansweredDecisions([{ key: 'GY-7', decisions }], watches, { available: false, agents: [] }, now), []);
  // A decision the loop never watched is judged by the name `master approver` gives its session.
  const byName = [{ id: manual, action: 'release', state: 'requested', requestedAt: '2026-09-23T13:00:00.000Z' }];
  assert.deepEqual(unansweredDecisions([{ key: 'GY-8', decisions: byName }], [], { available: true, agents: [{ name: approverSessionName({ key: 'GY-8' }, manual), agent_status: 'idle' }] }, now), []);
  assert.equal(unansweredDecisions([{ key: 'GY-8', decisions: byName }], [], ended, now)[0].age, '2h0m');

  // master status counts and names it: a stall, beside — never read as — the refusal.
  const report = await terminalDecisions(async () => ({ decisions }), [{ id: 'work-7', key: 'GY-7', stage: 'review' }], { approvals: watches, runtime: ended, now });
  assert.equal(report.unanswered.length, 1);
  assert.equal(report.refused, 1);
  const stall = report.attentionItems.find(item => item.text.includes('unanswered'));
  assert.equal(stall?.text, `Decision ${decision} (rework) is unanswered after 25m: approver session ${session} is not running and recorded no outcome — a stall, not a refusal`);
  assert.match(stall!.next, new RegExp(`graphyard master approver GY-7 ${decision}`));
  assert.ok(report.attentionItems.some(item => item.text.includes(`Decision ${declined} (release) was refused by approver-agent: Not justified`)));
  assert.equal(report.attentionItems.filter(item => item.text.includes(declined)).every(item => !item.text.includes('unanswered')), true);
});

test('a refusal settles the loop and the approver is told to record it — the launched approver declines with master refuse, never by stating a reason in its tab and stopping; the loop neither relaunches nor re-requests a refused decision', async () => {
  const at = Date.parse('2026-09-23T15:00:00.000Z'), decision = randomUUID();
  const session = approverSessionName({ key: 'GY-7' }, decision);
  const watch = approvalWatchSchema.parse({ work: 'GY-7', action: 'rework', decision, agentName: session, requestedAt: new Date(at).toISOString(), launchedAt: new Date(at).toISOString(), launches: 1 });
  const refused = { state: 'refused', outcome: 'Not justified', refusal: { approver: 'approver-agent', reason: 'Not justified' } };
  // Whatever the session is doing, and however many launches or requests were spent, a refusal is
  // the approver's judgement: settled for the loop, carrying who refused and why.
  for (const sessions of [{ agents: [], available: true }, { agents: [{ name: session, agent_status: 'done' }], available: true }, { agents: [], available: false }]) {
    const step = approvalStep(watch, refused, sessions, at + 20 * 60_000);
    assert.deepEqual(step, { step: 'refused', detail: `rework decision ${decision} on GY-7 was refused by approver-agent: Not justified` });
  }
  assert.equal(approvalStep({ ...watch, launches: 3, requests: 3 }, refused, { agents: [], available: true }, at).step, 'refused');
  // A decision the server failed or withdrew is still asked again; only a refusal is not.
  assert.equal(approvalStep(watch, { state: 'failed' }, { agents: [], available: true }, at).step, 'rerequest');

  const source = await readFile(fileURLToPath(new URL('../src/master.ts', import.meta.url)), 'utf8');
  const launch = source.slice(source.indexOf('export async function launchApprover'), source.indexOf('export function verifiedContext'));
  assert.match(launch, /master refuse \$\{work\.key\} \$\{decision\} "YOUR REASON"/);
  assert.match(launch, /a decline is recorded, never expressed by exiting/);
  assert.doesNotMatch(launch, /state the reason in this tab/);
});
