import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { GitHub } from '../src/github.js';
import { Refusal, standingEscalations, type Observation, type Principal, type Work } from '../src/model.js';
import { assembleEscalationContext, canonical, contextFingerprint, contextLadder, defaultContextBudget, followPrecedent, handleEscalation, type EscalationContext } from '../src/model/escalation-context.js';
import { masterConfigSchema, runAutonomyCommand, type AutonomyDependencies, type MasterConfig } from '../src/master.js';
import { Store } from '../src/store.js';

// GY-90: the control plane assembles an escalation's context from the project — the repository's
// own rules and policy, the goals and priorities the work graph records, the item slice and the
// precedent of earlier decisions — so a master spawned for one escalation decides as well as one
// that carried it all in its own window. Each test is named for the proof it produces.
const repository = 'owner/escalations';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const reader: Principal = { id: 'auditor', role: 'reader', sessionKind: 'human' };
const roster = [operator, coordinator, implementer, reader];
const credentials = roster.map(principal => ({ ...principal, token: `context-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'decision:resolve', 'decision:attest', 'decision:merge', 'decision:rework', 'decision:grant'] };
const approver = { id: 'approver-agent', token: `approver-agent-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
const head = 'c'.repeat(40), base = 'd'.repeat(40), rulesBlob = 'e'.repeat(40);
// The repository under review states its own rules; nothing here comes from a Graphyard template.
const projectRules = (ref: string) => `# Working on ${repository}\n\nRules read at ${ref}: never weaken a criterion to pass; a retired criterion moves to a follow-up item that names it.\n\n## Goals\n\nShip the escalation handler before the registry.\n`;
const contentReads: string[] = [];
const github = {
  config: { repository, base: 'main', appId: 1234, installationId: 1 },
  async request(path: string) {
    const match = /^\/contents\/AGENTS\.md\?ref=(.+)$/.exec(path);
    if (!match) throw new Refusal(`GET ${path} (404)`, 502);
    const ref = decodeURIComponent(match[1]); contentReads.push(ref);
    if (ref === 'no-rules') throw new Refusal(`GET /repos/${repository}${path} failed (404)`, 502);
    return { type: 'file', sha: rulesBlob, encoding: 'base64', content: Buffer.from(projectRules(ref), 'utf8').toString('base64').replace(/(.{60})/g, '$1\n') };
  },
} as unknown as GitHub;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let pr = 700;

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(credential, method, path, body);
  assert.equal(result.status, 200, result.text);
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows;
const input = (title: string, extra: Record<string, unknown> = {}) => ({ title, description: `Why ${title} matters`, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }, { id: 'AC-2', text: 'Audited', proofs: ['manual:audit'] }], reason: `Operator goal: ${title} lands before the registry`, ...extra });
function observation(work: Work): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [`src/${work.title}.ts`], scopeFiles: [], baseTip: base, baseTree: 'f'.repeat(40), baseTipContained: true, at: new Date().toISOString() };
}
const created = (title: string, extra: Record<string, unknown> = {}) => ok(master.token, 'POST', 'work', input(title, extra)) as Promise<Work>;
/** A submitted candidate whose only standing concern is the requirement-weakening escalation a narrowing raised. */
async function escalated(title: string, extra: Record<string, unknown> = {}) {
  let work = await created(title, extra);
  work = await engine.execute(operator, 'ready', work.id, { reason: 'Priority one this week' }, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'context-host', path: `/tmp/context/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, randomUUID());
  work = await engine.observe(work.id, work.revision, observation(work));
  work = await engine.execute(operator, 'requirements', work.id, { expectedPolicyRevision: work.policyRevision, criteria: [work.criteria[0]], dependencies: work.dependencies, plannedFiles: work.plannedFiles, exclusiveResources: [], producerProofs: [], reason: 'AC-2 moves to a follow-up item' }, randomUUID());
  assert.deepEqual(standingEscalations(work).map(entry => entry.trigger), ['requirement-weakening']);
  return work;
}
const decide = (credential: string, work: Work, body: Record<string, unknown>) => call(credential, 'POST', `work/${work.key}/decide`, body);
const approve = (credential: string, work: Work, decision: string, reason: string) => call(credential, 'POST', `work/${work.key}/approve`, { decision, reason });
const contextOf = (credential: string, work: Work, query = '') => call(credential, 'GET', `work/${work.key}/context${query}`);
const fingerprintOf = (body: any) => { const { fingerprint: _fingerprint, ...document } = body; return contextFingerprint(document); };

let masterRoot: string, credentialDirectory: string, config: MasterConfig;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 27;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-escalation-context-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('context_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/context_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, github);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver])
    await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
  // A master installation whose operator-agent credential lives outside every worktree, as onboarding leaves it.
  masterRoot = await mkdtemp(join(tmpdir(), 'graphyard-context-root-'));
  execFileSync('git', ['init', '-q', masterRoot]);
  await writeFile(join(masterRoot, '.gitignore'), '.graphyard/\n');
  credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-context-credentials-'));
  await writeFile(join(credentialDirectory, 'master.token'), token(coordinator), { mode: 0o600 });
  await writeFile(join(credentialDirectory, 'master-operator.token'), master.token, { mode: 0o600 });
  config = masterConfigSchema.parse({ version: 1, url, credentialFile: join(credentialDirectory, 'master.token'), cliPath: join(root, 'bin/graphyard.mjs'), repository, baseBranch: 'main', githubAppId: 1234, hostId: 'context-host', masterAgentName: 'graphyard-master-escalations',
    operatorAgent: { id: master.id, credentialFile: join(credentialDirectory, 'master-operator.token') } });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); await rm(masterRoot, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); });

const coordinatorApi = async (path: string) => ok(token(coordinator), 'GET', path);
const dependencies = (overrides: Partial<AutonomyDependencies> = {}): AutonomyDependencies => ({ coordinator: coordinatorApi, readSecret: async () => '', agents: () => [], daemonLock: async () => null, ...overrides });

test('integration:escalation-context-assembly — the context is assembled from four layers of project data and is retrievable through the API and the CLI', async () => {
  // Precedent: an earlier item's requirement-weakening escalation, resolved by a two-party decision.
  const earlier = await escalated('precedent-one');
  const requested = await decide(master.token, earlier, { action: 'resolve', input: { trigger: 'requirement-weakening', expectedRevision: earlier.revision }, reason: 'The follow-up item carries the retired criterion; nothing was weakened' });
  assert.equal(requested.status, 200, requested.text);
  const approved = await approve(approver.token, earlier, requested.body.id, 'The follow-up is created and released');
  assert.equal(approved.status, 200, approved.text); assert.equal(approved.body.state, 'applied');

  // The escalated item, a higher-priority neighbour, and an item that depends on it.
  const upstream = await created('upstream-dependency', { priority: 0 });
  const work = await escalated('escalated-item', { priority: 1 });
  const downstream = await created('downstream-dependent', { dependencies: [work.id], priority: 3 });

  const response = await contextOf(master.token, work);
  assert.equal(response.status, 200, response.text);
  const context: EscalationContext = response.body;
  assert.equal(context.version, 1); assert.equal(context.repository, repository); assert.equal(context.key, work.key); assert.equal(context.action, 'resolve');
  assert.equal(context.escalation.trigger, 'requirement-weakening'); assert.match(context.escalation.reason, /retires AC-2/);
  // Layer 1 — the repository's own rules, read at the base tip the item was observed against, and the item's policy.
  assert.deepEqual(context.rules.source, { path: 'AGENTS.md', ref: base, sha: rulesBlob });
  assert.equal(context.rules.text, projectRules(base)); assert.equal(context.rules.unavailable, null);
  assert.ok(contentReads.includes(base), 'the rules were read from the repository at the observed base tip');
  assert.deepEqual(context.rules.policy, { checks: ['test', 'typecheck'], review: true });
  // Layer 2 — goals and priorities as the graph records them: the operator's stated intent and the priority order.
  assert.equal(context.goals.priority, 1);
  assert.ok(context.goals.intents.some(entry => entry.kind === 'create' && entry.summary.reason === 'Operator goal: escalated-item lands before the registry'), JSON.stringify(context.goals.intents));
  assert.ok(context.goals.intents.some(entry => entry.kind === 'ready' && entry.summary.reason === 'Priority one this week'));
  assert.ok(context.goals.intents.some(entry => entry.kind === 'requirements' && entry.summary.reason === 'AC-2 moves to a follow-up item'));
  const order = context.goals.graph.map(entry => entry.key);
  assert.ok(order.indexOf(upstream.key) < order.indexOf(work.key) && order.indexOf(work.key) < order.indexOf(downstream.key), `priority order ${order.join(' ')}`);
  assert.deepEqual(context.goals.dependencies, []); assert.deepEqual(context.goals.dependents, [downstream.key]);
  // Layer 3 — the item slice: requirements, the standing refusal, the candidate, a typed history summary.
  assert.deepEqual(context.item.criteria.map(entry => entry.id), ['AC-1']); assert.deepEqual(context.item.retiredCriterionIds, ['AC-2']);
  assert.deepEqual(context.item.plannedFiles, ['src/escalated-item.ts']); assert.equal(context.item.description, 'Why escalated-item matters');
  assert.deepEqual(context.item.refusal.escalation, context.escalation); assert.equal(context.item.refusal.standing.length, 1);
  assert.ok(context.item.refusal.gates.find(gate => gate.name === 'merge')!.reasons.some(reason => /Unresolved requirement-weakening escalation/.test(reason)));
  assert.equal(context.item.candidate!.sha, head); assert.equal(context.item.candidate!.baseSha, base); assert.equal(context.item.submission!.pr, pr);
  assert.deepEqual(context.item.implementers, [implementer.id]);
  const kinds = Object.fromEntries(context.item.history.kinds.map(entry => [entry.kind, entry.count]));
  for (const kind of ['create', 'ready', 'claim', 'workspace', 'submit', 'github.observed', 'requirements']) assert.ok(kinds[kind] >= 1, `history counts ${kind}`);
  assert.equal(context.item.history.total, context.item.history.kinds.reduce((sum, entry) => sum + entry.count, 0));
  const recent = context.item.history.recent;
  assert.equal(recent[0].kind, 'requirements'); assert.equal(recent[0].actor, operator.id); assert.equal(recent[0].summary.reason, 'AC-2 moves to a follow-up item');
  assert.ok(recent.every(entry => entry.kind !== 'github.observed' && entry.kind !== 'heartbeat'), 'routine rows are counted, not listed');
  assert.ok(recent.every(entry => !('work' in entry.summary)), 'the embedded work snapshot never rides along');
  assert.ok(recent.some(entry => entry.kind === 'submit' && entry.summary.pr === pr));
  // Layer 4 — precedent: the earlier decision of the same action, with its reason and outcome.
  assert.equal(context.precedent.action, 'resolve'); assert.ok(context.precedent.total >= 1);
  const precedent = context.precedent.detail.find(entry => entry.id === requested.body.id)!;
  assert.equal(precedent.work, earlier.key); assert.equal(precedent.trigger, 'requirement-weakening'); assert.equal(precedent.state, 'applied');
  assert.equal(precedent.requestedBy, master.id); assert.equal(precedent.reason, 'The follow-up item carries the retired criterion; nothing was weakened');
  assert.equal(precedent.approvedBy, approver.id); assert.equal(precedent.approvalReason, 'The follow-up is created and released');
  assert.equal(precedent.outcome, `Resolved requirement-weakening on ${earlier.key}`);
  assert.equal(context.budget.limit, defaultContextBudget); assert.equal(context.budget.exceeded, null);
  assert.equal(fingerprintOf(context), context.fingerprint, 'the fingerprint covers every byte but itself');
  assert.equal(response.text, JSON.stringify(canonical(context)), 'the wire form is the canonical serialisation the fingerprint covers');

  // Retrieval: coordinator and reader read it; a worker does not; a trigger that does not stand is refused.
  assert.equal((await contextOf(token(coordinator), work)).status, 200);
  assert.equal((await contextOf(token(reader), work)).status, 200);
  assert.equal((await contextOf(token(implementer), work)).status, 403);
  const missing = await contextOf(master.token, work, '?trigger=lease-loss');
  assert.equal(missing.status, 404); assert.match(missing.body.error, /No standing lease-loss escalation/);
  assert.equal((await contextOf(master.token, work, '?budget=12')).status, 400);
  const unescalated = await contextOf(master.token, upstream);
  assert.equal(unescalated.status, 404); assert.match(unescalated.body.error, /standing: none/);
  // The CLI reads the same document through the coordinator credential, verified against its fingerprint.
  const reads: string[] = [];
  const cli = await runAutonomyCommand(masterRoot, config, 'context', [work.key, 'requirement-weakening'], dependencies({ coordinator: async path => { reads.push(path); return coordinatorApi(path); } })) as EscalationContext;
  assert.deepEqual(reads, [`work/${work.key}/context?trigger=requirement-weakening`], 'the CLI reads the context by key and nothing else');
  assert.deepEqual(cli, (await contextOf(master.token, work)).body);
  await assert.rejects(runAutonomyCommand(masterRoot, config, 'context', [work.key], dependencies({ coordinator: async path => ({ ...await coordinatorApi(path), key: 'GY-0' }) })), /does not match its fingerprint/);
});

test('integration:context-deterministic-bounded — the same escalation and graph state produce byte-identical context that stays within its budget by summarising, on an item with more than 2,000 events and more than 50 prior decisions', async () => {
  const work = await escalated('long-lived-item');
  // A long life: 1,600 routine rows and 600 typed rows on the item itself.
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload)
    SELECT $1, 'implementer', 'heartbeat', jsonb_build_object('details', jsonb_build_object('epoch', 1)) FROM generate_series(1, 1600)`, [work.id]);
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload)
    SELECT $1, 'implementer', (ARRAY['blocked', 'unblock', 'heartbeat.note', 'rework', 'scope', 'claim'])[1 + (n % 6)], jsonb_build_object('details', jsonb_build_object('reason', 'Typed row ' || n, 'epoch', n % 7))
    FROM generate_series(1, 600) AS n`, [work.id]);
  // Sixty earlier resolve decisions across the graph, each requested, approved and applied.
  const earlier = await created('precedent-ledger');
  for (let index = 0; index < 60; index++) {
    const id = randomUUID(), trigger = index % 3 === 0 ? 'lease-loss' : 'requirement-weakening';
    await store.pool.query('INSERT INTO events(work_id, actor, kind, payload) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7), ($1, $5, $8, $9)', [earlier.id,
      master.id, 'decision.requested', JSON.stringify({ id, action: 'resolve', input: { trigger, expectedRevision: 1 }, reason: `Precedent ${index}: the lapse is explained by the ledger and the candidate is unchanged`, requester: { id: master.id, role: 'operator-agent' } }),
      approver.id, 'decision.approved', JSON.stringify({ id, action: 'resolve', reason: `Approval ${index}`, requestedBy: master.id, approver: { id: approver.id, role: 'operator-agent' } }),
      'decision.applied', JSON.stringify({ id, outcome: `Resolved ${trigger} on ${earlier.key}` })]);
  }
  const total = Number((await store.pool.query('SELECT count(*)::int AS count FROM events WHERE work_id=$1', [work.id])).rows[0].count);
  assert.ok(total > 2000, `the item has ${total} events`);

  const first = await contextOf(master.token, work), second = await contextOf(master.token, work);
  assert.equal(first.status, 200, first.text); assert.equal(second.status, 200, second.text);
  assert.equal(first.text, second.text, 'byte-identical for the same escalation and graph state');
  const context: EscalationContext = first.body;
  assert.equal(fingerprintOf(context), context.fingerprint);
  assert.ok(Buffer.byteLength(first.text) <= defaultContextBudget, `${Buffer.byteLength(first.text)} bytes within the ${defaultContextBudget}-byte budget`);
  assert.equal(context.budget.exceeded, null);
  // Bounded by summarising: every event is counted, every decision is counted, nothing is dropped.
  assert.equal(context.item.history.total, total);
  assert.equal(context.item.history.kinds.reduce((sum, entry) => sum + entry.count, 0), total);
  assert.equal(context.item.history.kinds.find(entry => entry.kind === 'heartbeat')!.count, 1600);
  const typed = context.item.history.kinds.filter(entry => entry.kind !== 'heartbeat' && entry.kind !== 'github.observed').reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(context.item.history.recent.length + context.item.history.omitted, typed, 'the rows not listed are counted as omitted');
  assert.ok(context.item.history.recent.length <= contextLadder[0].recent);
  assert.ok(context.precedent.total > 50, `${context.precedent.total} prior decisions`);
  assert.equal(context.precedent.detail.length + context.precedent.summary.reduce((sum, entry) => sum + entry.count, 0), context.precedent.total, 'summarised precedent is counted per trigger and state');
  assert.equal(context.precedent.omitted, context.precedent.total - context.precedent.detail.length);
  assert.ok(context.precedent.detail.every(entry => entry.trigger === 'requirement-weakening'), 'the escalation\'s own trigger is listed first');
  assert.ok(context.precedent.summary.some(entry => entry.trigger === 'lease-loss' && entry.state === 'applied' && entry.count === 20));
  // A wider budget shows more in full; a narrow one summarises harder and says so when even the floor does not fit.
  const wide = await contextOf(master.token, work, '?budget=400000');
  assert.equal(wide.status, 200, wide.text); assert.deepEqual(wide.body.budget.level, contextLadder[0]); assert.equal(wide.body.precedent.detail.length, contextLadder[0].detail);
  assert.notEqual(wide.body.fingerprint, context.fingerprint); assert.equal(wide.body.item.history.total, total);
  const narrow = await contextOf(master.token, work, '?budget=4000');
  assert.equal(narrow.status, 200, narrow.text);
  if (Buffer.byteLength(narrow.text) > 4000) { assert.match(narrow.body.budget.exceeded, /summary floor/); assert.deepEqual(narrow.body.budget.level, contextLadder.at(-1)); }
  else assert.equal(narrow.body.budget.exceeded, null);
  assert.equal(narrow.body.rules.text, projectRules(base), 'the rules layer is never shortened');
  // The assembly itself is a pure function: shuffled key order in its inputs changes nothing.
  const inputs = { repository, work, trigger: 'requirement-weakening' as const, rules: { path: 'AGENTS.md', ref: base, sha: rulesBlob, text: projectRules(base), unavailable: null }, graph: await store.list(),
    history: { total: 3, kinds: [{ kind: 'create', count: 1, firstSeq: '1', lastSeq: '1', firstAt: '2026-01-01T00:00:00.000Z', lastAt: '2026-01-01T00:00:00.000Z' }], recent: [{ seq: '3', at: '2026-01-01T00:00:02.000Z', actor: 'x', kind: 'blocked', details: { reason: 'r', epoch: 1 } }], intents: [] }, decisions: [], budget: defaultContextBudget };
  const reordered = JSON.parse(JSON.stringify(inputs, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
  assert.equal(JSON.stringify(canonical(assembleEscalationContext(reordered))), JSON.stringify(canonical(assembleEscalationContext(inputs))));
});

test('integration:fresh-master-consistency — two independent handlers spawned on the same escalation receive only the assembled context, cite the same precedent and record the decision with its reason and precedent', async () => {
  const work = await escalated('handled-item');
  const before = (await contextOf(master.token, work)).body as EscalationContext;
  const expected = before.precedent.detail.find(entry => entry.state === 'applied' && entry.trigger === 'requirement-weakening')!;
  assert.ok(expected, 'an applied precedent of the same trigger exists');

  // Two handlers in separate processes, at the same time, each with nothing but the control plane's URL and the item key.
  const script = join(masterRoot, 'handler.mts');
  await writeFile(script, `import { runAutonomyCommand, masterConfigSchema } from ${JSON.stringify(join(root, 'src/master.ts'))};
const [configFile, key, trigger, credential] = process.argv.slice(2);
const config = masterConfigSchema.parse(JSON.parse(await (await import('node:fs/promises')).readFile(configFile, 'utf8')));
const reads = [];
const coordinator = async path => { reads.push(path); const response = await fetch(config.url + '/api/' + path, { headers: { Authorization: 'Bearer ' + credential } }); const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body; };
const result = await runAutonomyCommand(${JSON.stringify(masterRoot)}, config, 'escalation', [key, trigger, 'precedent'], { coordinator, readSecret: async () => '', agents: () => [], daemonLock: async () => null });
console.log(JSON.stringify({ result, reads }));
`);
  const configFile = join(credentialDirectory, 'master.json');
  await writeFile(configFile, JSON.stringify(config));
  const spawnHandler = () => exec(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')), script, configFile, work.key, 'requirement-weakening', token(coordinator)], { cwd: root });
  const [one, two] = await Promise.all([spawnHandler(), spawnHandler()]);
  const handlers = [one, two].map(run => JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { result: any; reads: string[] });
  for (const handler of handlers) {
    assert.deepEqual(handler.reads, [`work/${work.key}/context?trigger=requirement-weakening`], 'the handler reads the assembled context and nothing else');
    assert.equal(handler.result.declined, null, JSON.stringify(handler.result));
    assert.deepEqual(handler.result.judgement.precedent, [expected.id]);
    assert.equal(handler.result.judgement.followed.id, expected.id);
    assert.match(handler.result.request.reason, new RegExp(`^Following precedent ${expected.id} on ${expected.work} \\(requirement-weakening, applied\\): `));
    assert.equal(handler.result.request.context, handler.result.fingerprint);
  }
  assert.deepEqual(handlers[0].result.judgement, handlers[1].result.judgement, 'both handlers reach the same judgement');
  assert.equal(handlers[0].result.decision.id, handlers[1].result.decision.id, 'the second handler concurred with the decision the first recorded');

  // The ledger carries the decision with its reason, the precedent cited and the context judged from; the later handler is a concurrence.
  const ledger = await events(work);
  const requested = ledger.filter(row => row.kind === 'decision.requested');
  assert.equal(requested.length, 1); assert.deepEqual(requested[0].payload.precedent, [expected.id]); assert.equal(requested[0].payload.context, handlers[0].result.fingerprint);
  const concurred = ledger.filter(row => row.kind === 'decision.concurred');
  assert.equal(concurred.length, 1); assert.deepEqual(concurred[0].payload.precedent, [expected.id]); assert.equal(concurred[0].payload.id, requested[0].payload.id);
  const listed = await ok(master.token, 'GET', `work/${work.key}/decisions`);
  const decision = listed.decisions.find((entry: any) => entry.id === requested[0].payload.id);
  assert.deepEqual(decision.precedent, [expected.id]); assert.equal(decision.context, handlers[0].result.fingerprint); assert.equal(decision.concurrences.length, 1);
  assert.equal(decision.concurrences[0].requester, master.id);
  // A later handler in this process follows the same line from the context alone.
  const reads: string[] = [];
  const later = await runAutonomyCommand(masterRoot, config, 'escalation', [work.key, 'precedent'], dependencies({ coordinator: async path => { reads.push(path); return coordinatorApi(path); } })) as Awaited<ReturnType<typeof handleEscalation>>;
  assert.deepEqual(reads, [`work/${work.key}/context`]);
  assert.deepEqual(later.judgement!.precedent, [expected.id]); assert.equal((later.decision as any).id, decision.id);
  assert.equal((later.decision as any).concurrences.length, 2);
  // A request that names a different precedent while the decision stands is still a competing request, refused as before.
  const competing = await decide(master.token, work, { action: 'resolve', input: { trigger: 'requirement-weakening', expectedRevision: (await reload(work.id)).revision }, reason: 'Another line', precedent: [randomUUID()] });
  assert.equal(competing.status, 409); assert.match(competing.body.error, /already requested/);
  // The independent approver applies it; the resolution names the decision the handlers recorded.
  const applied = await approve(approver.token, work, decision.id, 'Consistent with the precedent cited');
  assert.equal(applied.status, 200, applied.text); assert.equal(applied.body.state, 'applied');
  assert.deepEqual(standingEscalations(await reload(work.id)), []);
  assert.equal((await events(work)).find(row => row.kind === 'escalation.resolved')!.payload.details.decision, decision.id);

  // With no applied precedent to follow, the built-in judgement declines and records nothing.
  const empty: EscalationContext = { ...before, precedent: { ...before.precedent, detail: before.precedent.detail.filter(entry => entry.state !== 'applied') } };
  assert.equal(followPrecedent(empty), null);
  let recorded = 0;
  const declined = await handleEscalation(empty, followPrecedent, async () => { recorded++; return null; });
  assert.equal(recorded, 0); assert.match(declined.declined!, /No applied resolve precedent/); assert.equal(declined.request, null);
  // The context's rules layer never comes from a template: it is the repository's file, or an explicit absence.
  assert.equal(before.rules.text, projectRules(base));
  assert.ok(!before.rules.text!.includes('<!-- graphyard'), 'no generated Graphyard block is mistaken for the project\'s rules');
  const digest = createHash('sha256').update(JSON.stringify(canonical({ ...before, fingerprint: undefined }))).digest('hex');
  assert.equal(digest, before.fingerprint);
});
