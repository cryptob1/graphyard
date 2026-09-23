import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { GitHub } from '../src/github.js';
import { Refusal, standingEscalations, type Observation, type Principal, type Work } from '../src/model.js';
import { assembleEscalationContext, canonical, contextFingerprint, contextLadder, contextOverflowAttention, contextOverflows, contextSqueeze, defaultContextBudget, followPrecedent, handleEscalation, type ContextInputs, type EscalationContext } from '../src/model/escalation-context.js';
import { launchEscalationHandler, masterConfigSchema, runAutonomyCommand, type AutonomyDependencies, type MasterConfig } from '../src/master.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
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
  // GY-138: a floor over budget is squeezed until it fits, and says so.
  assert.ok(Buffer.byteLength(narrow.text) <= 4000, `${Buffer.byteLength(narrow.text)} bytes within the 4000-byte budget`);
  if (narrow.body.budget.assembled !== null) { assert.match(narrow.body.budget.exceeded, /summary floor/); assert.deepEqual(narrow.body.budget.level, contextLadder.at(-1)); }
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
  assert.equal(requested.length, 1); assert.deepEqual(requested[0].payload.precedent, [expected.id]);
  // Whichever handler recorded first, each judgement is bound to the context that handler judged from: the later one may
  // have assembled its context after the first request landed, which changes the fingerprint and never the line followed.
  const fingerprints = handlers.map(handler => handler.result.fingerprint);
  assert.ok(fingerprints.includes(requested[0].payload.context), 'the request names the context its handler judged from');
  const concurred = ledger.filter(row => row.kind === 'decision.concurred');
  assert.equal(concurred.length, 1); assert.deepEqual(concurred[0].payload.precedent, [expected.id]); assert.equal(concurred[0].payload.id, requested[0].payload.id);
  assert.deepEqual([requested[0].payload.context, concurred[0].payload.context].sort(), [...fingerprints].sort());
  const listed = await ok(master.token, 'GET', `work/${work.key}/decisions`);
  const decision = listed.decisions.find((entry: any) => entry.id === requested[0].payload.id);
  assert.deepEqual(decision.precedent, [expected.id]); assert.equal(decision.context, requested[0].payload.context); assert.equal(decision.concurrences.length, 1);
  assert.equal(decision.concurrences[0].requester, master.id);
  // A later handler in this process follows the same line from the context alone.
  const reads: string[] = [];
  const later = await runAutonomyCommand(masterRoot, config, 'escalation', [work.key, 'precedent'], dependencies({ coordinator: async path => { reads.push(path); return coordinatorApi(path); } })) as Awaited<ReturnType<typeof handleEscalation>>;
  assert.deepEqual(reads, [`work/${work.key}/context`]);
  assert.deepEqual(later.judgement!.precedent, [expected.id]); assert.equal((later.decision as any).id, decision.id);
  assert.equal((later.decision as any).concurrences.length, 2);
  // A request that names a different precedent while the decision stands is still a competing request, refused as before.
  const other = before.precedent.detail.find(entry => entry.state === 'applied' && entry.id !== expected.id)!;
  const competing = await decide(master.token, work, { action: 'resolve', input: { trigger: 'requirement-weakening', expectedRevision: (await reload(work.id)).revision }, reason: 'Another line', precedent: [other.id] });
  assert.equal(competing.status, 409); assert.match(competing.body.error, /already requested/);
  // A citation is a claim the ledger can check: an id that is no recorded resolve decision is refused, and nothing is recorded for it.
  const invented = randomUUID();
  const uncited = await decide(master.token, work, { action: 'resolve', input: { trigger: 'requirement-weakening', expectedRevision: (await reload(work.id)).revision }, reason: 'A line nobody took', precedent: [invented] });
  assert.equal(uncited.status, 422); assert.match(uncited.body.error, new RegExp(`${invented} is not a recorded resolve decision`));
  assert.equal((await events(work)).filter(row => row.kind === 'decision.concurred').length, 2);
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
  assert.equal(recorded, 0); assert.match(declined.declined!, /No applied resolve precedent of the requirement-weakening trigger/); assert.equal(declined.request, null);
  // An applied decision of another trigger is no line to follow: its reason describes a different kind of incident.
  // It stays in the context for a judging session to weigh, and the built-in judgement declines.
  const foreign: EscalationContext = { ...before, precedent: { ...before.precedent, detail: before.precedent.detail.filter(entry => entry.state === 'applied').map(entry => ({ ...entry, trigger: 'lease-loss' })) } };
  assert.ok(foreign.precedent.detail.length > 0);
  assert.equal(followPrecedent(foreign), null);
  assert.match((await handleEscalation(foreign, followPrecedent, async () => { recorded++; return null; })).declined!, /a judging session decides this escalation/);
  assert.equal(recorded, 0);

  // The judging session that decides then is launched like every other session (GY-93): its instruction rides the
  // runtime's own command line as its first request, never a paste it would refuse, and its whole input is one private file.
  const herdrCalls: string[][] = [];
  const herdr = (_command: string, args: string[]) => {
    herdrCalls.push(args);
    if (args[0] === 'tab' && args[1] === 'create') return JSON.stringify({ result: { root_pane: { pane_id: 'pane-escalation', tab_id: 'tab-escalation' } } });
    return startedAtOnce(args) ?? JSON.stringify({ result: {} });
  };
  const launched = await launchEscalationHandler(masterRoot, config, before, 'claude', [], herdr);
  assert.equal(launched.delivery, 'request');
  // GY-121: the typed line references the request file in the master's own checkout; the shell hands the runtime its text.
  const typed = herdrCalls.find(call => call[0] === 'pane' && call[1] === 'run')!;
  assert.equal(typed[2], 'pane-escalation');
  const start = expandTypedCommand(typed[3]);
  assert.equal(start.kind, 'claude'); assert.equal(start.stem, join(masterRoot, '.graphyard/launch', launched.agentName));
  assert.deepEqual(herdrCalls.find(call => call[0] === 'agent' && call[1] === 'rename')?.slice(2), ['pane-escalation', launched.agentName], 'the started runtime takes the session name');
  const request = start.args.at(-1)!;
  assert.ok(start.args.length > 1 && start.args.slice(0, -1).every(word => word.startsWith('--') || word === 'bypassPermissions'), 'the request follows the runtime arguments');
  assert.match(request, new RegExp(`^You are a Graphyard escalation handler spawned for the requirement-weakening escalation on ${work.key}`));
  assert.ok(request.includes(launched.context) && request.includes(`--context ${before.fingerprint}`), 'the prompt names the context file and its fingerprint');
  assert.equal(herdrCalls.filter(call => call[0] === 'agent' && call[1] === 'prompt').length, 0, 'nothing is typed into the session');
  assert.ok(launched.context.startsWith(join(masterRoot, '.graphyard/escalations/')), launched.context);
  assert.equal((await stat(launched.context)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(launched.context, 'utf8')), before);
  // A runtime with no request contract keeps the confirmed paste, and the result says so.
  herdrCalls.length = 0;
  const pasted = await launchEscalationHandler(masterRoot, config, before, 'muse', [], herdr);
  assert.equal(pasted.delivery, 'paste');
  assert.equal(herdrCalls.filter(call => call[0] === 'agent' && call[1] === 'prompt').length, 1);
  // The context's rules layer never comes from a template: it is the repository's file, or an explicit absence.
  assert.equal(before.rules.text, projectRules(base));
  assert.ok(!before.rules.text!.includes('<!-- graphyard'), 'no generated Graphyard block is mistaken for the project\'s rules');
  const digest = createHash('sha256').update(JSON.stringify(canonical({ ...before, fingerprint: undefined }))).digest('hex');
  assert.equal(digest, before.fingerprint);
});

/** Resolve decisions written straight into the ledger of one item: requested, approved and applied, oldest first. */
async function appliedDecisions(work: Work, triggers: string[], label: string) {
  const ids: string[] = [];
  for (const [index, trigger] of triggers.entries()) {
    const id = randomUUID(); ids.push(id);
    await store.pool.query('INSERT INTO events(work_id, actor, kind, payload) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7), ($1, $5, $8, $9)', [work.id,
      master.id, 'decision.requested', JSON.stringify({ id, action: 'resolve', input: { trigger, expectedRevision: 1 }, reason: `${label} ${index}: ${'the ledger explains the lapse and the candidate is unchanged; '.repeat(4)}`, requester: { id: master.id, role: 'operator-agent' } }),
      approver.id, 'decision.approved', JSON.stringify({ id, action: 'resolve', reason: `Approval ${index}`, requestedBy: master.id, approver: { id: approver.id, role: 'operator-agent' } }),
      'decision.applied', JSON.stringify({ id, outcome: `Resolved ${trigger} on ${work.key}` })]);
  }
  return ids;
}

test('integration:precedent-survives-budget-squeeze — an over-budget context still lists a citable decision of its own trigger beside the rules, reports what it omitted and stays within the budget', async () => {
  // A context whose natural size is far over a 4,000-byte budget: a long description, a busy graph, a long history and many decisions.
  const work = await escalated('squeezed-item', { description: `Why squeezed-item matters: ${'the context must still name a decision to cite. '.repeat(40)}` });
  for (let index = 0; index < 12; index++) await created(`squeeze-neighbour-${index}`);
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT $1, 'implementer', 'blocked', jsonb_build_object('details', jsonb_build_object('reason', 'Typed row ' || n || ' ' || repeat('x', 200))) FROM generate_series(1, 80) AS n`, [work.id]);
  // Precedent: applied decisions of the item's own trigger, then of another trigger recorded after them (so newer).
  const ledger = await created('squeeze-precedent-ledger');
  const own = await appliedDecisions(ledger, ['requirement-weakening', 'requirement-weakening'], 'Own trigger');
  await appliedDecisions(ledger, Array.from({ length: 30 }, () => 'lease-loss'), 'Other trigger');
  const newestOwn = own.at(-1)!;

  const budget = 4000;
  const response = await contextOf(master.token, work, `?budget=${budget}`);
  assert.equal(response.status, 200, response.text);
  const context: EscalationContext = response.body;
  // The natural size — the ladder's first level, and even its summary floor — is over the budget.
  const natural = await contextOf(master.token, work, '?budget=1000000');
  assert.ok(Buffer.byteLength(natural.text) > budget, `natural size ${Buffer.byteLength(natural.text)} bytes`);
  assert.ok(context.budget.assembled! > budget, `the summary floor is ${context.budget.assembled} bytes against ${budget}`);
  // The document stays within the budget.
  assert.ok(Buffer.byteLength(response.text) <= budget, `${Buffer.byteLength(response.text)} bytes within the ${budget}-byte budget`);
  assert.equal(fingerprintOf(context), context.fingerprint);
  // The rules layer and the citable precedent survive, before any other content.
  assert.equal(context.rules.text, projectRules(base), 'the rules layer is never shortened');
  assert.deepEqual(context.budget.level, contextLadder.at(-1));
  const citable = context.precedent.detail.filter(entry => entry.trigger === 'requirement-weakening' && entry.state === 'applied');
  assert.ok(citable.length >= 1, 'precedent.detail names at least one citable decision of the escalation\'s own trigger');
  assert.equal(citable[0].id, newestOwn, 'the newest applied decision of that trigger');
  assert.ok(context.precedent.total >= 32, `${context.precedent.total} decisions`);
  assert.equal(context.precedent.omitted, context.precedent.total - context.precedent.detail.length, 'every other decision is still counted');
  // budget.exceeded still reports the overflow and names every omitted section, dropped in the documented order.
  assert.match(context.budget.exceeded!, new RegExp(`^The context is ${context.budget.assembled} bytes at the summary floor against a ${budget}-byte budget; kept the repository rules \\(\\d+ bytes, never shortened\\) and citable precedent ${newestOwn}; omitted `));
  assert.ok(context.budget.omitted.length >= 1, 'the squeeze dropped at least one section');
  const order = contextSqueeze.map(step => step.section);
  assert.deepEqual(context.budget.omitted, order.filter(section => context.budget.omitted.includes(section)), 'sections are dropped in the documented order');
  assert.ok(context.budget.exceeded!.includes(`omitted ${context.budget.omitted.join(', ')}.`), context.budget.exceeded!);
  assert.ok(context.budget.omitted.includes('goals.graph') && context.goals.graph.length === 0 && context.goals.graphOmitted.reduce((sum, entry) => sum + entry.count, 0) > 12, 'the goals graph is counted by stage, not listed');
  // The built-in judgement can follow it, and the command it forms carries an id the server accepts.
  const judgement = followPrecedent(context)!;
  assert.deepEqual(judgement.precedent, [newestOwn]);
  const recorded = await decide(master.token, work, { action: 'resolve', input: { trigger: 'requirement-weakening', expectedRevision: (await reload(work.id)).revision }, reason: judgement.reason, precedent: judgement.precedent, context: context.fingerprint });
  assert.equal(recorded.status, 200, recorded.text); assert.deepEqual(recorded.body.precedent, [newestOwn]); assert.equal(recorded.body.noPrecedent, null);
  // A budget the floor fits in is not squeezed at all.
  assert.equal(natural.body.budget.exceeded, null); assert.equal(natural.body.budget.assembled, null); assert.deepEqual(natural.body.budget.omitted, []);
});

test('integration:decision-without-precedent-accepted — a decision citing no precedent, for a trigger with none applied, is accepted and recorded as such; an id that is no decision of the same action is still refused', async () => {
  // A security-concern escalation raised by the live attempt: no resolve decision of that trigger has ever been applied.
  let work = await created('first-of-its-kind');
  work = await engine.execute(operator, 'ready', work.id, { reason: 'Ready' }, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'request', work.id, { type: 'escalation', epoch: work.epoch, trigger: 'security-concern', reason: 'A credential-shaped string is in the diff' }, randomUUID());
  assert.ok(standingEscalations(work).some(entry => entry.trigger === 'security-concern'));
  const applied = await store.pool.query("SELECT 1 FROM events requested JOIN events done ON done.kind='decision.applied' AND done.payload->>'id'=requested.payload->>'id' WHERE requested.kind='decision.requested' AND requested.payload->'input'->>'trigger'='security-concern'");
  assert.equal(applied.rowCount, 0, 'no applied precedent of the trigger exists');
  const context = (await contextOf(master.token, work, '?trigger=security-concern')).body as EscalationContext;
  assert.ok(!context.precedent.detail.some(entry => entry.trigger === 'security-concern' && entry.state === 'applied'), 'the context has nothing of this trigger to cite');
  const input = { trigger: 'security-concern', expectedRevision: (await reload(work.id)).revision };

  // A cited id that is not a recorded decision of the same action is still refused: an invented one, and a real decision of another action.
  const invented = randomUUID();
  const refusedInvented = await decide(master.token, work, { action: 'resolve', input, reason: 'Cites nothing real', precedent: [invented] });
  assert.equal(refusedInvented.status, 422); assert.match(refusedInvented.body.error, new RegExp(`${invented} is not a recorded resolve decision`));
  const rework = randomUUID();
  await store.pool.query('INSERT INTO events(work_id, actor, kind, payload) VALUES ($1, $2, $3, $4)', [work.id, master.id, 'decision.requested', JSON.stringify({ id: rework, action: 'rework', input: {}, reason: 'Another action', requester: { id: master.id, role: 'operator-agent' } })]);
  const refusedOther = await decide(master.token, work, { action: 'resolve', input, reason: 'Cites a rework decision', precedent: [rework] });
  assert.equal(refusedOther.status, 422); assert.match(refusedOther.body.error, new RegExp(`${rework} is not a recorded resolve decision`));

  // Without --precedent the decision is accepted, and the ledger records that no precedent was available.
  const accepted = await decide(master.token, work, { action: 'resolve', input, reason: 'The string is a test fixture, not a credential', context: context.fingerprint });
  assert.equal(accepted.status, 200, accepted.text);
  assert.deepEqual(accepted.body.precedent, []);
  assert.equal(accepted.body.noPrecedent, 'No precedent was available: no applied resolve decision of the security-concern trigger had been recorded, so this decision was taken on the facts alone');
  const row = (await events(work)).find(entry => entry.kind === 'decision.requested' && entry.payload.id === accepted.body.id)!;
  assert.equal(row.payload.noPrecedent, accepted.body.noPrecedent); assert.equal(row.payload.precedent, undefined);
  const listed = await ok(master.token, 'GET', `work/${work.key}/decisions`);
  assert.equal(listed.decisions.find((entry: any) => entry.id === accepted.body.id).noPrecedent, accepted.body.noPrecedent);
  // It is an ordinary decision: the independent approver applies it and the escalation is resolved.
  const approval = await approve(approver.token, work, accepted.body.id, 'Checked the fixture');
  assert.equal(approval.status, 200, approval.text); assert.equal(approval.body.state, 'applied');
  assert.ok(!standingEscalations(await reload(work.id)).some(entry => entry.trigger === 'security-concern'));
  // Once one exists, a later request citing nothing is still accepted, and the note says a precedent was there to cite.
  let next = await created('second-of-its-kind');
  next = await engine.execute(operator, 'ready', next.id, { reason: 'Ready' }, randomUUID());
  next = await engine.execute(implementer, 'claim', next.id, {}, randomUUID());
  next = await engine.execute(implementer, 'request', next.id, { type: 'escalation', epoch: next.epoch, trigger: 'security-concern', reason: 'Another credential-shaped string' }, randomUUID());
  const second = await decide(master.token, next, { action: 'resolve', input: { trigger: 'security-concern', expectedRevision: (await reload(next.id)).revision }, reason: 'Also a fixture' });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.noPrecedent, 'No precedent cited, though 1 applied resolve decision of the security-concern trigger was recorded');
});

test('unit:context-overflow-surfaced — master status names the item, its trigger and the assembled size against the budget whenever an escalation context overflows', async () => {
  const escalation = { trigger: 'lease-loss' as const, reason: 'graphyard-claude-2 lost lease epoch 9', at: '2026-09-23T09:13:33.000Z', actor: 'graphyard' };
  const gate = (name: string) => ({ name, passed: false, reasons: [`Unresolved lease-loss escalation requires operator resolution: ${escalation.reason}`] });
  const work = { id: 'w-118', key: 'GY-118', title: 'Deployment cost', type: 'bug', description: 'd'.repeat(2000), stage: 'merge', ready: true, revision: 40, policyRevision: 1, epoch: 11, createdAt: '2026-09-20T00:00:00.000Z',
    priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'c'.repeat(300), proofs: ['unit:x'] }], plannedFiles: ['src/x.ts'], policy: { checks: ['test'], review: true },
    gates: ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(gate), blocker: null, violations: [], candidate: null, submission: { epoch: 11, pr: 120 }, lease: null, implementers: ['graphyard-claude-2'],
    escalation, escalations: [escalation] } as unknown as Work;
  const graph = [work, ...Array.from({ length: 40 }, (_, index) => ({ ...work, id: `w-${index}`, key: `GY-${200 + index}`, title: `Neighbour ${index} ${'t'.repeat(80)}`, escalation: null, escalations: [] }) as unknown as Work)];
  const decisions = Array.from({ length: 32 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, workId: 'w-1', workKey: 'GY-1', action: 'resolve' as const, input: { trigger: index % 2 ? 'lease-loss' : 'requirement-weakening' }, reason: `Reason ${index} ${'r'.repeat(300)}`,
    requestedBy: 'master', requestedAt: '2026-09-22T00:00:00.000Z', state: 'applied' as const, approvedBy: 'approver', approvedAt: null, approvalReason: 'ok', outcome: 'Resolved', refusals: [], refusal: null, precedent: [], context: null, noPrecedent: null, concurrences: [], seq: index + 1 }));
  const inputs = (budget: number): ContextInputs => ({ repository, work, trigger: 'lease-loss', rules: { path: 'AGENTS.md', ref: base, sha: rulesBlob, text: projectRules(base), unavailable: null }, graph,
    history: { total: 80, kinds: [{ kind: 'blocked', count: 80, firstSeq: '1', lastSeq: '80', firstAt: '2026-09-20T00:00:00.000Z', lastAt: '2026-09-23T00:00:00.000Z' }], recent: [], intents: [] }, decisions, budget });
  // Over budget: the attention item names the item, the trigger and the assembled size against the budget.
  const over = assembleEscalationContext(inputs(6000));
  assert.ok(over.budget.exceeded && over.budget.assembled! > 6000, `assembled ${over.budget.assembled}`);
  const item = contextOverflowAttention(over)!;
  assert.equal(item.subject, 'GY-118');
  assert.equal(item.text.split(';')[0], `The lease-loss escalation context for GY-118 assembled to ${over.budget.assembled} bytes against its 6000-byte budget`);
  assert.match(item.text, new RegExp(`; the squeeze omitted ${over.budget.omitted.join(', ')} and kept the rules and precedent ${decisions[31].id}$`));
  assert.deepEqual({ role: item.role, human: item.human, humanOnly: item.humanOnly }, { role: 'master', human: false, humanOnly: null });
  assert.equal(item.next, `Raise GRAPHYARD_ESCALATION_CONTEXT_BUDGET on the control plane, or run graphyard master escalation GY-118 lease-loss --budget N with N above ${over.budget.assembled}`);
  // Within budget: nothing is raised.
  const fitting = assembleEscalationContext(inputs(defaultContextBudget));
  assert.equal(fitting.budget.exceeded, null); assert.equal(contextOverflowAttention(fitting), null);
  // The status report reads the context of every standing escalation on open work, and raises one item per overflow.
  const reads: string[] = [];
  const read = async (path: string) => { reads.push(path); return JSON.parse(JSON.stringify(path.startsWith('work/GY-118/') ? over : fitting)); };
  const done = { ...work, id: 'w-done', key: 'GY-5', stage: 'done' } as Work;
  const raised = await contextOverflows(read, [work, graph[1], done]);
  assert.deepEqual(reads, ['work/GY-118/context?trigger=lease-loss'], 'only standing escalations on open work are read');
  assert.deepEqual(raised, [item]);
  // An unreadable context is skipped rather than failing the whole report.
  assert.deepEqual(await contextOverflows(async () => { throw new Error('offline'); }, [work]), []);
  // master status carries it: the report adds these items to its attention list and its count.
  const report = await readFile(join(root, 'src/cli/master-status.ts'), 'utf8');
  assert.match(report, /const overflow = await contextOverflows\(masterApi, snapshot\.work\);/);
  assert.match(report, /attentionItems\.push\(\.\.\.generatedFiles, \.\.\.overflow\)/);
  // The overflow items count toward the attention total, wherever other reports sit beside them.
  assert.match(report, /attention: status\.counts\.attention \+[^\n]*\+ overflow\.length \+/);
});
