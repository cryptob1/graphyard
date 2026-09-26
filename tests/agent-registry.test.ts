import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { apiRoutes } from '../src/server/index.js';
import { ledgerTables } from '../src/store/schema.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { discoverHostLogins, proposeFleet } from '../src/fleet.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { bindReviewer, launchReview, saveReviewerProfile } from '../src/reviewer.js';
import { NoHealthyAccountError, atomicPrivateWrite, buildMasterStatus, dispatchWork, launchApprover, loadMasterConfig, selectAccount, setupMaster, type EnvironmentProbe } from '../src/master.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, fleetRoles, fleetView, foldObservation, launchGraceMs, proposedRuntimes, sessionEnded, settleSessions, type AgentRegistry as Registry, type FleetSession, type FleetView } from '../src/model/registry.js';
import type { Principal, Work } from '../src/model.js';
import { FleetOverview } from '../web/pages/fleet.js';
import { views, visibleViews } from '../web/pages/index.js';
import { expandTypedCommand, requestOf, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const auditor: Principal = { id: 'auditor', role: 'reader' };
const producer: Principal = { id: 'proof-runner', role: 'producer' };
const principals = [operator, coordinator, worker, auditor, producer];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const hour = 3_600_000, future = (ms = hour) => new Date(Date.now() + ms).toISOString();
const HOST = 'build-host-1';

let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, url: string, scratch: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_REGISTRY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 45);
  scratch = await temporaryDirectory('registry');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('registry_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/registry_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function call(path: string, actor: Principal, data?: unknown, key: string = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}
const ok = async (path: string, actor: Principal, data?: unknown) => { const result = await call(path, actor, data); assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`); return result.body; };
/** Every test starts from an empty fleet: whatever a previous test registered is removed through the API. */
async function reset() {
  const document: Registry = await ok('agent-registry/document', operator);
  for (const role of document.roles) await ok(`agent-registry/roles/${role.name}/remove`, operator, { reason: 'test reset' });
  for (const runtime of document.runtimes) await ok(`agent-registry/runtimes/${runtime.name}/remove`, operator, { reason: 'test reset' });
  for (const model of document.models) await ok(`agent-registry/models/${model.name}/remove`, operator, { reason: 'test reset' });
  for (const session of (await ok('agent-registry/document', operator) as Registry).sessions.filter(entry => !entry.endedAt)) await ok(`agent-registry/sessions/${session.id}/end`, operator, { reason: 'test reset' });
}
const runtimeNamed = (name: string) => proposedRuntimes.find(runtime => runtime.name === name)!;

/** A login home as each agent CLI leaves it; the token inside is what the registry must never hold. */
async function login(directory: string, name: string, kind: 'claude' | 'codex' | null, secret = `${name}-oauth-token`) {
  const home = join(directory, name); await mkdir(home, { recursive: true });
  if (kind === 'claude') await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: secret, refreshToken: `${secret}-refresh`, expiresAt: Date.now() + 5 * hour } }), { mode: 0o600 });
  if (kind === 'codex') await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: secret, refresh_token: 'r' } }), { mode: 0o600 });
  return home;
}
/** The executor's network: the provider usage endpoint answers per stored login token, everything else is the real control plane. */
function network(byToken: Record<string, { five: number; seven: number }>): EnvironmentProbe {
  const fetcher = (async (target: string, init: any) => {
    if (!String(target).includes('api.anthropic.com')) return fetch(target, init);
    const entry = byToken[String(init.headers.Authorization).replace('Bearer ', '')];
    if (!entry) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ five_hour: { utilization: entry.five, resets_at: future(2 * hour) }, seven_day: { utilization: entry.seven, resets_at: future(48 * hour) } }));
  }) as unknown as typeof fetch;
  return { fetch: fetcher, cacheMs: 0 };
}
/** A master installation bound to the test control plane; its master.json names no runtime account at all. */
async function master(workers: { name: string; principal: string; kind: string; agentArgs?: string[] }[] = []) {
  const root = await temporaryDirectory('repo', scratch), credentialDirectory = await temporaryDirectory('credentials', scratch);
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const bound = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url, token: tokens.get('master')!, cliPath: launcher, credentialDirectory, hostId: HOST, herdrWorkspace: 'workspace-graphyard' }, bound as typeof fetch);
  await mkdir(join(credentialDirectory, 'workers'), { recursive: true, mode: 0o700 });
  const config = await loadMasterConfig(root) as any;
  for (const entry of workers) {
    const credentialFile = join(credentialDirectory, 'workers', `${entry.name}.token`); await writeFile(credentialFile, `${entry.name}-token-`.padEnd(40, 'x'), { mode: 0o600 });
    config.workers.push({ name: entry.name, principal: entry.principal, agentName: entry.name, mode: 'launch', kind: entry.kind, credentialFile, agentArgs: entry.agentArgs ?? [], approvals: 'auto', environment: {} });
  }
  const approverFile = join(credentialDirectory, 'approver.token'); await writeFile(approverFile, 'approver-token-'.padEnd(40, 'x'), { mode: 0o600 });
  config.approver = { id: 'graphyard-approver', credentialFile: approverFile };
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), config);
  return { root, credentialDirectory, config: await loadMasterConfig(root) };
}
const herdr = (calls: string[][], fail?: (args: string[]) => boolean) => (_command: string, args: string[]) => {
  calls.push(args);
  if (fail?.(args)) throw new Error('herdr refused the launch');
  // The typed launch starts its runtime at once, and Herdr sees it ready under the pane (GY-121).
  return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' && args[1] === 'create' ? { type: 'tab_created', root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' }, tab: { tab_id: 'tab-1' } }
    : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
};
const tabEnvironment = (tab: string[]) => Object.fromEntries(tab.flatMap((value, index) => value === '--env' ? [tab[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
let items = 0;
const readyWork = (key = `GY-${++items + 900}`) => ({ id: `work-${key}`, key, title: 'Registry fixture', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
  stage: 'ready', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], observation: null }) as unknown as Work;
/** A candidate ready for its independent review, as the loop reads one out of the snapshot. */
function reviewWork(key: string, sha: string): Work {
  const candidate = { sha, baseSha: 'b'.repeat(40), pr: 93, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  return { ...readyWork(key), stage: 'review', submission: { epoch: 1, pr: 93 }, candidate, epoch: 1,
    policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    observation: { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [],
      at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: 'c'.repeat(40), baseTipContained: true } } as unknown as Work;
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const mintReviewerSession = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });

/**
 * The `master registry` commands docs/onboarding.md prints, as a caller's argv: shell continuations
 * joined, quotes honoured, and the `node "$GRAPHYARD_CLI" master registry` prefix dropped.
 */
function documentedCommands(guide: string): string[][] {
  const joined = guide.replaceAll(/\\\n\s*/g, ' ');
  return joined.split('\n').filter(line => line.startsWith('node "$GRAPHYARD_CLI" master registry')).map(line => {
    const words = [...line.replace(/\s+#.*$/, '').matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
    return words.slice(words.indexOf('registry') + 1);
  });
}

/** One executor action: a worker dispatch through the same code path `master run` and `master dispatch` take. */
async function dispatch(root: string, config: any, profile: string, probe: EnvironmentProbe, calls: string[][] = [], fail?: (args: string[]) => boolean) {
  const item = readyWork();
  return dispatchWork(root, item, config.workers.find((entry: any) => entry.name === profile), [], herdr(calls, fail), [item], async () => ({ epoch: 1, path: join(root, 'assigned'), base: 'c'.repeat(40) }), async () => {}, 5_000, new Date().toISOString(), { probe, prompt: { attempts: 1, pauseMs: 0, acceptMs: 1_000 } });
}

// ---------------------------------------------------------------------------
// AC-1 — integration:agent-registry-model
// ---------------------------------------------------------------------------
test('integration:agent-registry-model — the control plane stores runtimes with launch contracts, accounts that reference a credential, models with cost and capability, and ordered roles with a concurrency limit, configured through the API, the CLI and the dashboard', async () => {
  await reset();
  const homes = await temporaryDirectory('homes', scratch);
  const claudeHome = await login(homes, 'claude-a', 'claude', 'claude-a-very-secret-oauth-token');
  const empty: FleetView = await ok('agent-registry', auditor);
  assert.equal(empty.configured, false); assert.deepEqual([empty.runtimes, empty.accounts, empty.roles], [[], [], []]);

  // Who may touch it: implementers and producers read nothing, a reader reads but never configures.
  for (const actor of [worker, producer]) { assert.equal((await call('agent-registry', actor)).status, 403, actor.id); assert.equal((await call('agent-registry/runtimes', actor, { runtime: runtimeNamed('claude'), reason: 'r' })).status, 403); }
  assert.equal((await call('agent-registry/runtimes', auditor, { runtime: runtimeNamed('claude'), reason: 'r' })).status, 403);
  assert.equal((await call('agent-registry/document', auditor)).status, 403, 'launch contracts and credential references are the executor\'s read');
  assert.equal((await call('status', worker)).body.fleet, null);

  // The order is runtime → account → role: each names the one before, and the refusal says so.
  const early = await call('agent-registry/accounts', operator, { account: { name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: HOST, home: claudeHome } }, reason: 'too early' });
  assert.equal(early.status, 409); assert.match(early.body.error, /Unknown runtime claude; add the runtime before its accounts/);
  assert.match((await call('agent-registry/roles', operator, { role: { name: 'worker', accounts: ['claude-a'], concurrency: 2 }, reason: 'too early' })).body.error, /Unknown account claude-a; add an account before the role that names it/);

  // API: every runtime the item names, each with its launch contract, and one added later that no code knows.
  for (const runtime of proposedRuntimes) await ok('agent-registry/runtimes', operator, { runtime, reason: `Register ${runtime.name}` });
  assert.deepEqual(proposedRuntimes.map(runtime => runtime.name).sort(), ['claude', 'codex', 'cursor', 'muse', 'opencode', 'pi']);
  await ok('agent-registry/runtimes', coordinator, { runtime: { name: 'aider', description: 'Added after release', launch: { kind: 'aider', args: ['--yes-always'], homeVariable: 'AIDER_HOME', modelFlag: '--model', login: 'AIDER_HOME={home} aider --login', loginFile: 'session.json' } }, reason: 'A runtime Graphyard has never heard of' });
  // A registry holds references, never secrets: not in a contract's environment, its arguments, or an account.
  for (const launch of [{ kind: 'x', environment: { ANTHROPIC_API_KEY: 'value' } }, { kind: 'x', args: ['--key', 'sk-ant-api03-abcdefghijklmnop'] }, { kind: 'x', environment: { GRAPHYARD_TOKEN_FILE: '/x' } }])
    assert.equal((await call('agent-registry/runtimes', operator, { runtime: { name: 'leaky', launch }, reason: 'r' })).status, 400, JSON.stringify(launch));
  await ok('agent-registry/models', operator, { model: { name: 'opus', provider: 'Anthropic', id: 'claude-opus-5', cost: { inputPerMTok: 15, outputPerMTok: 75 }, capability: { tier: 'frontier', contextTokens: 1_000_000 } }, reason: 'Record the model and its price' });
  assert.equal((await call('agent-registry/accounts', operator, { account: { name: 'bad', runtime: 'claude', model: 'opus', credential: { host: HOST, home: 'sk-ant-api03-not-a-path' } }, reason: 'r' })).status, 400, 'a credential is a reference to a login home, never the credential');
  assert.equal((await call('agent-registry/accounts', operator, { account: { name: 'bad', runtime: 'claude', model: 'opus', credential: { host: HOST, home: claudeHome }, token: 'x' }, reason: 'r' })).status, 400, 'an account has no field a secret could go in');

  // CLI: the same registry from any host that holds the coordinator credential.
  const cli = { read: (path: string) => ok(path, coordinator), write: (path: string, data: unknown) => ok(path, coordinator, data) };
  await registryCommand({ hostId: HOST }, ['model', 'set', 'gpt', '--id', 'gpt-5.2-codex', '--input-cost', '1.25', '--output-cost', '10', '--tier', 'strong', '--reason', 'Codex model'], cli);
  await registryCommand({ hostId: HOST }, ['account', 'set', 'claude-a', '--runtime', 'claude', '--model', 'opus', '--home', claudeHome, '--max-sessions', '2', '--reason', 'First Claude subscription'], cli);
  await registryCommand({ hostId: HOST }, ['account', 'set', 'codex-a', '--runtime', 'codex', '--model', 'gpt', '--home', join(homes, 'codex-a'), '--host', 'build-host-2', '--reason', 'Codex on the second host'], cli);
  await registryCommand({ hostId: HOST }, ['account', 'set', 'aider-a', '--runtime', 'aider', '--model', 'gpt', '--home', join(homes, 'aider-a'), '--reason', 'The later runtime has accounts like any other'], cli);
  await registryCommand({ hostId: HOST }, ['runtime', 'set', 'goose', '--kind', 'goose', '--arg=--yolo', '--home-variable', 'GOOSE_HOME', '--login', 'GOOSE_HOME={home} goose configure', '--reason', 'A runtime added from the CLI'], cli);
  assert.deepEqual((await ok('agent-registry/document', coordinator) as Registry).runtimes.find(runtime => runtime.name === 'goose')!.launch, { kind: 'goose', args: ['--yolo'], environment: {}, homeVariable: 'GOOSE_HOME', modelFlag: null, login: 'GOOSE_HOME={home} goose configure', loginFile: null });
  await assert.rejects(registryCommand({ hostId: HOST }, ['account', 'set', 'orphan', '--reason', 'r'], cli), /new account; name its --runtime and --model/);
  // A set names only what changes: the model moves, the credential reference and the limit stand.
  await registryCommand({ hostId: HOST }, ['model', 'set', 'sonnet', '--id', 'claude-sonnet-5', '--tier', 'fast', '--reason', 'Cheaper model'], cli);
  await registryCommand({ hostId: HOST }, ['account', 'set', 'claude-a', '--model', 'sonnet', '--reason', 'Run the cheaper model'], cli);
  const moved = (await ok('agent-registry/document', coordinator) as Registry).accounts.find(account => account.name === 'claude-a')!;
  assert.deepEqual([moved.model, moved.credential, moved.maxSessions], ['sonnet', { host: HOST, home: claudeHome }, 2]);
  await registryCommand({ hostId: HOST }, ['account', 'set', 'claude-a', '--model', 'opus', '--reason', 'Back to the frontier model'], cli);
  assert.match((await call('agent-registry/models/opus/remove', operator, { reason: 'r' })).body.error, /Model opus is what claude-a runs/);

  // Dashboard: the page posts to exactly these routes (each one served), and only to routes that exist.
  const page = await readFile(new URL('../web/pages/fleet.tsx', import.meta.url), 'utf8');
  const served = apiRoutes.flatMap(module => module.routes).filter(route => route.method !== 'GET').map(route => route.path);
  const posted = [...page.matchAll(/=> [`']agent-registry\/([^`']+)[`']/g)].map(match => `/api/agent-registry/${match[1].replace(/\$\{field\(form, 'collection'\)\}/, 'accounts').replace(/\$\{[^}]+\}/g, 'name')}`);
  assert.ok(posted.length >= 6, 'runtime, model, account, role, quota and remove forms');
  // GY-397: the browser's credential check reads the launch data only; the audit reason is prose that may name a token prefix.
  assert.match(page, /form\.entries\(\)\]\.some\(\(\[name, value\]\) => name !== 'reason' && typeof value === 'string' && value\.split\([^)]*\)\.some\(looksLikeSecret\)/);
  for (const path of posted) assert.ok(served.some(route => typeof route === 'string' ? route === path : route.test(path)), `${path} is served`);
  assert.ok(visibleViews({ status: { actor: { role: 'admin' } }, features: {} } as any).some(view => view.id === 'agents') && !visibleViews({ status: { actor: { role: 'worker' } }, features: {} } as any).some(view => view.id === 'agents'));
  assert.ok(views.some(view => view.id === 'agents'));
  // What the role form submits, as the signed-in admin's browser sends it.
  await ok('agent-registry/roles', operator, { role: { name: 'worker', accounts: ['claude-a', 'codex-a', 'aider-a'], concurrency: 3 }, reason: 'Prefer Claude, then Codex, then the newcomer' });
  await ok('agent-registry/roles', operator, { role: { name: 'reviewer', accounts: ['codex-a', 'claude-a'], concurrency: 1 }, reason: 'Review on a different model than the author' });
  await registryCommand({ hostId: HOST }, ['role', 'set', 'reviewer', '--concurrency', '2', '--reason', 'One more reviewer at a time'], cli);
  assert.deepEqual((await ok('agent-registry/document', coordinator) as Registry).roles.find(role => role.name === 'reviewer'), { name: 'reviewer', accounts: ['codex-a', 'claude-a'], concurrency: 2 }, 'the CLI changed the limit and kept the order');
  for (const name of ['producer', 'approver', 'escalation-handler']) await ok('agent-registry/roles', operator, { role: { name, accounts: ['claude-a'], concurrency: 1 }, reason: `Configure ${name}` });
  assert.equal((await call('agent-registry/roles', operator, { role: { name: 'janitor', accounts: ['claude-a'], concurrency: 1 }, reason: 'r' })).status, 400, 'the roles are the five the control plane launches');
  assert.equal((await call('agent-registry/roles', operator, { role: { name: 'worker', accounts: ['claude-a', 'claude-a'], concurrency: 1 }, reason: 'r' })).status, 400);

  // Observed quota state and reset time: marked by an operator here, observed by an executor's probe in the selection test.
  const resetsAt = future(6 * hour);
  await registryCommand({ hostId: HOST }, ['account', 'quota', 'aider-a', 'exhausted', '--resets-at', resetsAt, '--reason', 'Plan exhausted'], cli);
  const view: FleetView = await ok(`agent-registry?host=${HOST}`, auditor);
  assert.equal(view.configured, true);
  assert.deepEqual(view.roles.find(role => role.role === 'worker'), { role: 'worker', accounts: ['claude-a', 'codex-a', 'aider-a'], concurrency: 3, live: 0, next: 'claude-a', blocked: null, policy: { args: [], tools: [], model: null } });
  assert.deepEqual(fleetRoles.filter(name => view.roles.some(role => role.role === name)), [...fleetRoles]);
  const claude = view.accounts.find(account => account.name === 'claude-a')!;
  assert.deepEqual([claude.runtime, claude.model, claude.modelId, claude.cost, claude.capability?.tier, claude.host, claude.home, claude.maxSessions], ['claude', 'opus', 'claude-opus-5', { inputPerMTok: 15, outputPerMTok: 75 }, 'frontier', HOST, claudeHome, 2]);
  assert.deepEqual(claude.roles.map(entry => `${entry.role}:${entry.preference}/${entry.of}`), ['worker:1/3', 'reviewer:2/2', 'producer:1/1', 'approver:1/1', 'escalation-handler:1/1']);
  const aider = view.accounts.find(account => account.name === 'aider-a')!;
  assert.deepEqual([aider.quota, aider.resetsAt, aider.quotaSource, aider.eligible], ['exhausted', resetsAt, 'operator', false]); assert.match(aider.ineligible!, /aider-a quota is exhausted until/);
  assert.equal(view.runtimes.find(runtime => runtime.name === 'aider')!.launch.homeVariable, 'AIDER_HOME');
  assert.deepEqual(view.runtimes.find(runtime => runtime.name === 'muse')!.launch.args, ['--approval-mode', 'never', '--trust-workspace']);

  // It is control-plane state, not a file: a second replica over the same database answers the same, the login secret
  // never reached it, every change is attributable history on the ledger every backup carries, and a retry is safe.
  const replica = await new AgentRegistry(store).document(coordinator);
  assert.deepEqual(replica, await ok('agent-registry/document', operator));
  assert.doesNotMatch(JSON.stringify(replica), /very-secret-oauth-token/);
  const history = await ok('agent-registry/history?limit=500', auditor);
  assert.ok(history.some((entry: any) => entry.kind === 'role.set' && entry.actor === 'operator' && entry.change.reason === 'Prefer Claude, then Codex, then the newcomer'));
  assert.ok(history.some((entry: any) => entry.kind === 'account.set' && entry.actor === 'master'), 'the CLI change is attributed to the coordinator identity it ran under');
  assert.ok(ledgerTables.includes('events'));
  assert.ok(Number((await store.pool.query("SELECT count(*) FROM events WHERE work_id IS NULL AND kind LIKE 'agent-registry.%'")).rows[0].count) >= history.length);
  const key = randomUUID(), body = { model: { name: 'haiku', id: 'claude-haiku-4-5' }, reason: 'Retry-safe' };
  const first = await call('agent-registry/models', operator, body, key), retried = await call('agent-registry/models', operator, body, key);
  assert.equal(first.body.revision, retried.body.revision);
  assert.equal((await call('agent-registry/models', operator, { ...body, reason: 'different' }, key)).status, 409);
});

// ---------------------------------------------------------------------------
// AC-2 — integration:registry-driven-selection
// ---------------------------------------------------------------------------
test('integration:registry-driven-selection — an executor\'s action runs on the first account of its role that is placed on its host, logged in, within quota and under its limits; the choice and its reason are recorded; no runtime or account comes from code or a profile', async () => {
  await reset();
  const homes = await temporaryDirectory('homes', scratch);
  const spent = await login(homes, 'claude-spent', 'claude'), out = await login(homes, 'claude-out', null), fresh = await login(homes, 'claude-fresh', 'claude');
  const probe = network({ 'claude-spent-oauth-token': { five: 20, seven: 100 }, 'claude-fresh-oauth-token': { five: 5, seven: 10 } });
  for (const runtime of proposedRuntimes) await ok('agent-registry/runtimes', operator, { runtime, reason: 'register' });
  await ok('agent-registry/models', operator, { model: { name: 'opus', id: 'claude-opus-5', capability: { tier: 'frontier' } }, reason: 'model' });
  await ok('agent-registry/models', operator, { model: { name: 'muse-default' }, reason: 'model' });
  for (const [name, home, host] of [['claude-spent', spent, HOST], ['claude-out', out, HOST], ['claude-remote', join(homes, 'elsewhere'), 'build-host-2'], ['claude-fresh', fresh, HOST]] as const)
    await ok('agent-registry/accounts', operator, { account: { name, runtime: 'claude', model: 'opus', credential: { host, home }, maxSessions: name === 'claude-fresh' ? 1 : null }, reason: 'account' });
  await ok('agent-registry/accounts', operator, { account: { name: 'claude-off', runtime: 'claude', model: 'opus', credential: { host: HOST, home: fresh }, enabled: false }, reason: 'account' });
  await ok('agent-registry/accounts', operator, { account: { name: 'muse-a', runtime: 'muse', model: 'muse-default', credential: { host: HOST, home: null } }, reason: 'account' });
  await ok('agent-registry/roles', operator, { role: { name: 'worker', accounts: ['claude-off', 'claude-spent', 'claude-out', 'claude-remote', 'claude-fresh'], concurrency: 2 }, reason: 'role' });
  await ok('agent-registry/roles', operator, { role: { name: 'approver', accounts: ['muse-a'], concurrency: 1 }, reason: 'role' });

  // The profile is a Graphyard identity and nothing else here: it says codex, with Codex-only
  // arguments, and names no account. The registry decides what actually runs.
  const { root, config, credentialDirectory } = await master([{ name: 'worker-a', principal: 'implementer', kind: 'codex', agentArgs: ['--model', 'gpt-codex-only'] }, { name: 'worker-b', principal: 'implementer-b', kind: 'codex' }, { name: 'worker-c', principal: 'implementer-c', kind: 'claude', agentArgs: ['--permission-mode', 'default'] }]);
  assert.equal(config.environments, undefined); assert.ok(config.workers.every(entry => !entry.accounts));
  const calls: string[][] = [];
  const dispatched = await dispatch(root, config, 'worker-a', probe, calls);
  assert.equal(dispatched.account!.environment, 'claude-fresh'); assert.equal(dispatched.account!.kind, 'claude');
  assert.deepEqual(dispatched.account!.skipped.map(entry => entry.environment), ['claude-off', 'claude-spent', 'claude-out', 'claude-remote']);
  const reasons = dispatched.account!.skipped.map(entry => entry.reason);
  assert.match(reasons[0], /claude-off is disabled/); assert.match(reasons[1], /claude-spent quota is exhausted until .*7d window at 100%/); assert.match(reasons[2], /claude-out is not logged in/); assert.match(reasons[3], /claude-remote is placed on build-host-2; this executor is build-host-1/);
  const tab = tabEnvironment(calls[0]);
  assert.equal(tab.CLAUDE_CONFIG_DIR, fresh); assert.equal(tab.GRAPHYARD_HERDR_AGENT_KIND, 'claude'); assert.equal(tab.CODEX_HOME, undefined);
  const typed = expandTypedCommand(calls[1][3]!);
  assert.equal(typed.kind, 'claude'); assert.deepEqual(typed.args.slice(0, 4), ['--permission-mode', 'bypassPermissions', '--model', 'claude-opus-5'], 'the registry runtime\'s contract and the account\'s model, not the profile\'s runtime');
  assert.doesNotMatch(calls[1][3]!, /gpt-codex-only/);

  // The choice and its reason are recorded in the control plane, with what the executor observed.
  const recorded: Registry = await ok('agent-registry/document', coordinator);
  const session = recorded.sessions.at(-1)!;
  assert.deepEqual([session.role, session.account, session.runtime, session.model, session.host, session.work, session.principal, session.selectedBy, session.endedAt], ['worker', 'claude-fresh', 'claude', 'opus', HOST, dispatched.work, 'implementer', 'master', null]);
  assert.match(session.reason, /claude-fresh is the first eligible account for worker \(preference 5 of 5; 1 of 2 concurrent\) — passed over claude-off is disabled; claude-spent quota is exhausted/);
  assert.deepEqual(session.skipped.map(entry => entry.account), ['claude-off', 'claude-spent', 'claude-out', 'claude-remote']);
  const observed = Object.fromEntries(recorded.accounts.map(account => [account.name, account.quota]));
  assert.deepEqual([observed['claude-spent'].state, observed['claude-spent'].source, observed['claude-spent'].observedBy, observed['claude-out'].loggedIn, observed['claude-fresh'].state], ['exhausted', 'probe', 'master', false, 'available']);
  assert.ok(Date.parse(observed['claude-spent'].resetsAt!) > Date.now(), 'the reset time the provider reported');
  assert.equal(observed['claude-remote'].observedAt, null, 'an executor vouches only for the logins on its own host');
  const selectedEvent = (await ok('agent-registry/history', auditor)).find((entry: any) => entry.kind === 'selected');
  assert.equal(selectedEvent.actor, 'master'); assert.equal(selectedEvent.change.session.reason, session.reason);

  // Under its limits: the account's session limit, then the role's concurrency limit, each refused with its reason and recorded.
  await assert.rejects(dispatch(root, config, 'worker-b', probe), (error: any) => error instanceof NoHealthyAccountError && /claude-fresh is at its session limit \(1 of 1 live\)/.test(error.message));
  await ok('agent-registry/accounts', operator, { account: { name: 'claude-fresh', runtime: 'claude', model: 'opus', credential: { host: HOST, home: fresh }, maxSessions: 5 }, reason: 'Raise the limit' });
  assert.equal((await dispatch(root, config, 'worker-b', probe)).account!.environment, 'claude-fresh');
  await assert.rejects(selectAccount(config, 'worker', config.workers[0], { ...probe, work: 'GY-777' }), /role worker is at its concurrency limit \(2 of 2 live: claude-fresh on GY-\d+, claude-fresh on GY-\d+\)/);
  const refused: FleetView = await ok(`agent-registry?host=${HOST}`, auditor);
  assert.match(refused.refusals.at(-1)!.reason, /concurrency limit/); assert.equal(refused.refusals.at(-1)!.work, 'GY-777');
  assert.equal(refused.roles.find(role => role.role === 'worker')!.live, 2); assert.match(refused.roles.find(role => role.role === 'worker')!.blocked!, /concurrency limit/);
  const before = (await ok('agent-registry/history?limit=500', auditor)).length;
  await assert.rejects(selectAccount(config, 'worker', config.workers[0], { ...probe, work: 'GY-777' }), /concurrency limit/);
  assert.equal((await ok('agent-registry/history?limit=500', auditor)).length, before, 'a loop that keeps asking records the same refusal once');

  // A launch that fails gives its session back at once, so its account and the role's slot are free again.
  await ok('agent-registry/roles', operator, { role: { name: 'worker', accounts: ['claude-fresh'], concurrency: 3 }, reason: 'room for one more' });
  await assert.rejects(dispatch(root, config, 'worker-a', probe, [], args => args[0] === 'pane' && args[1] === 'run'), /herdr refused the launch/);
  const released = (await ok('agent-registry/document', coordinator) as Registry).sessions.at(-1)!;
  assert.ok(released.endedAt); assert.match(released.endReason!, /worker launch for GY-\d+ failed: herdr refused the launch/);
  // So does a launch refused for its effective arguments after the account was chosen: a role
  // policy restoring the approval prompt ends the session it reserved, not five minutes later
  // (GY-184). A registry role launches with its own policy, never the profile's arguments (GY-170).
  await ok('agent-registry/roles', operator, { role: { name: 'worker', accounts: ['claude-fresh'], concurrency: 3, policy: { args: ['--permission-mode', 'default'], tools: [], model: null } }, reason: 'a policy that would bring the prompt back' });
  await assert.rejects(dispatch(root, config, 'worker-c', probe), /refuses to launch the claude runtime with --permission-mode default/);
  await ok('agent-registry/roles', operator, { role: { name: 'worker', accounts: ['claude-fresh'], concurrency: 3 }, reason: 'the approval prompt stays off' });
  const refusedLaunch = (await ok('agent-registry/document', coordinator) as Registry).sessions.at(-1)!;
  assert.equal(refusedLaunch.principal, 'implementer-c'); assert.ok(refusedLaunch.endedAt, 'the refused launch gives its session back');
  assert.match(refusedLaunch.endReason!, /worker launch for GY-\d+ failed: Graphyard refuses to launch the claude runtime/);

  // The approver's runtime comes from its role too — here a runtime with no login home and its own contract.
  const approverCalls: string[][] = [];
  const approver = await launchApprover(root, readyWork('GY-950'), 'decision-1', undefined, { agents: [], available: true }, herdr(approverCalls), probe);
  assert.equal(approver.account!.environment, 'muse-a');
  const started = expandTypedCommand(approverCalls.find(args => args[0] === 'pane' && args[1] === 'run')![3]);
  assert.equal(started.kind, 'muse'); assert.deepEqual(started.args.slice(0, 3), ['--approval-mode', 'never', '--trust-workspace']);
  // Muse takes its request positionally, after its contract's arguments, never pasted (GY-184).
  assert.equal(started.args.length, 4); assert.match(started.args[3], /You are the independent Graphyard approver/);
  assert.equal(requestOf(started.kind, started.args), started.args[3]);
  assert.equal(approverCalls.some(args => args[0] === 'agent' && args[1] === 'prompt'), false);
  // …and a role the registry does not define is not guessed at: reviewer falls to the local profile, which names none.
  assert.deepEqual(await selectAccount(config, 'reviewer', { name: 'review-a' }, probe), { account: null, health: null, skipped: [] });
  const source = await readFile(new URL('../src/master/autonomy.ts', import.meta.url), 'utf8');
  const daemon = await readFile(new URL('../src/daemon/effects.ts', import.meta.url), 'utf8');
  const launchPaths = source.slice(source.indexOf('export async function launchApprover'), source.indexOf('export const autonomySubcommands')) + source.slice(source.indexOf("if (id === 'approver')"), source.indexOf("if (id === 'approver')") + 400)
    + daemon.slice(daemon.indexOf("const approver: DaemonEffects['approver']"), daemon.indexOf("const approver: DaemonEffects['approver']") + 400);
  assert.doesNotMatch(launchPaths, /\?\? '(claude|codex|cursor|opencode|muse)'/, 'no launch path falls back to a runtime named in code, in the loop as much as in the command');

  // A launch that fails *after* the choice gives its session back on every path, not only the
  // worker's: the reviewer's token mint fails here, and its account and the role's one slot are
  // free again at once rather than at the two-hour session cap.
  await ok('agent-registry/roles', operator, { role: { name: 'reviewer', accounts: ['claude-fresh'], concurrency: 1 }, reason: 'one reviewer at a time' });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') },
    async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }) as any);
  await saveReviewerProfile(root, { name: 'reviewer-a', agentName: 'review-a', kind: 'claude' });
  const head = 'a'.repeat(40), reviewed = reviewWork('GY-960', head);
  await assert.rejects(launchReview(root, reviewed, 'reviewer-a', [], new Date().toISOString(),
    { run: herdr([]), probe, mint: async () => { throw new Error('the installation token could not be minted'); } }), /could not be minted/);
  const givenBack = (await ok('agent-registry/document', coordinator) as Registry).sessions.at(-1)!;
  assert.equal(givenBack.role, 'reviewer'); assert.ok(givenBack.endedAt, 'the session the failed launch chose is ended');
  assert.match(givenBack.endReason!, /reviewer launch for GY-960 failed: the installation token could not be minted/);

  // So the next attempt of the same request is selected, at a concurrency of 1, rather than being
  // refused by the session of its own first attempt.
  const relaunch = await launchReview(root, reviewed, 'reviewer-a', [], new Date().toISOString(), { run: herdr([]), probe, mint: mintReviewerSession });
  assert.equal(relaunch.account!.environment, 'claude-fresh');

  // And a review relaunched for a new head supersedes the live session of the head it replaces:
  // the local ledger cancels its record, and the registry frees the slot in the same breath.
  const next = await launchReview(root, reviewWork('GY-960', 'd'.repeat(40)), 'reviewer-a', [], new Date().toISOString(), { run: herdr([]), probe, mint: mintReviewerSession });
  assert.equal(next.account!.environment, 'claude-fresh');
  const reviewSessions = (await ok('agent-registry/document', coordinator) as Registry).sessions.filter(entry => entry.role === 'reviewer' && entry.work === 'GY-960');
  assert.equal(reviewSessions.filter(entry => !entry.endedAt).length, 1, 'one live reviewer session for the item, the newest');
  assert.match(reviewSessions.at(-2)!.endReason!, /superseded by the reviewer session requested for GY-960/);

  // A producer is superseded only within its own proof group, so the groups of one item still run
  // side by side while each group's relaunch replaces its own predecessor.
  await ok('agent-registry/roles', operator, { role: { name: 'producer', accounts: ['claude-fresh'], concurrency: 2 }, reason: 'two proof groups at a time' });
  const select = (group: string) => ok('agent-registry/select', coordinator, { role: 'producer', host: HOST, work: 'GY-961', group, observations: [] });
  assert.equal((await select('integration')).selected, true); assert.equal((await select('manual')).selected, true);
  const again = await select('integration');
  assert.equal(again.selected, true, 'the integration group replaces its own session rather than waiting for the concurrency limit');
  const producers = (await ok('agent-registry/document', coordinator) as Registry).sessions.filter(entry => entry.role === 'producer' && entry.work === 'GY-961');
  assert.deepEqual(producers.filter(entry => !entry.endedAt).map(entry => entry.group), ['manual', 'integration']);
  assert.match(producers.find(entry => entry.endedAt)!.endReason!, /superseded by the producer session requested for GY-961/);

  // The one end the control plane cannot infer — a launcher killed mid-flight, a host that went
  // away — is an operator's own command rather than a wait for the session's outer cap.
  const stranded = producers.find(entry => !entry.endedAt)!;
  await registryCommand({ hostId: HOST }, ['session', 'end', stranded.id, '--reason', 'its executor host went away'],
    { read: path => ok(path, coordinator), write: (path, data) => ok(path, coordinator, data) });
  const ended = (await ok('agent-registry/document', coordinator) as Registry).sessions.find(entry => entry.id === stranded.id)!;
  assert.equal(ended.endReason, 'its executor host went away'); assert.ok(ended.endedAt);

  // An outage never hands a registry-decided role back to a file: nothing launches until the control plane answers.
  const down = { ...probe, fetch: (async (target: string, init: any) => String(target).includes('/api/agent-registry') ? new Response('bad gateway', { status: 502 }) : probe.fetch!(target, init)) as unknown as typeof fetch };
  await assert.rejects(selectAccount({ ...config, url: `${url}/` }, 'worker', config.workers[0], down), /answered 502; role worker is decided by the agent registry .* nothing launches for it until the control plane answers/);
});

// ---------------------------------------------------------------------------
// AC-3 — integration:registry-live-capacity
// ---------------------------------------------------------------------------
test('integration:registry-live-capacity — capacity is a registry change with no restart and no file edit: an account added mid-run takes the next action, an exhausted one is skipped, and a removed runtime\'s roles fall back in order', async () => {
  await reset();
  const homes = await temporaryDirectory('homes', scratch);
  const homeA = await login(homes, 'claude-a', 'claude'), homeB = await login(homes, 'claude-b', 'claude'), codexHome = await login(homes, 'codex-a', 'codex');
  const probe = network({ 'claude-a-oauth-token': { five: 1, seven: 1 }, 'claude-b-oauth-token': { five: 1, seven: 1 } });
  await ok('agent-registry/apply', operator, { runtimes: [runtimeNamed('claude')], models: [{ name: 'opus', id: 'claude-opus-5' }], accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: HOST, home: homeA } }],
    roles: [{ name: 'worker', accounts: ['claude-a'], concurrency: 50 }, { name: 'reviewer', accounts: ['claude-a'], concurrency: 50 }], reason: 'The fleet at the start of the run' });

  // One run: the executor's configuration is loaded once and never again, and its file is never written.
  const { root, config } = await master([{ name: 'worker-a', principal: 'implementer', kind: 'claude' }]);
  const file = join(root, '.graphyard/master.json'), bytes = await readFile(file, 'utf8');
  const next = async () => { const calls: string[][] = []; const result = await dispatch(root, config, 'worker-a', probe, calls); return { account: result.account!.environment, kind: result.account!.kind, skipped: result.account!.skipped, tab: tabEnvironment(calls.find(call => call[0] === 'tab')!) }; };
  assert.equal((await next()).account, 'claude-a');

  // Add an account mid-run, ahead of the one in use: the very next action runs on it.
  await ok('agent-registry/accounts', operator, { account: { name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: HOST, home: homeB } }, reason: 'A second subscription, mid-run' });
  await ok('agent-registry/roles', operator, { role: { name: 'worker', accounts: ['claude-b', 'claude-a'], concurrency: 50 }, reason: 'Prefer the new account' });
  const added = await next();
  assert.equal(added.account, 'claude-b'); assert.equal(added.tab.CLAUDE_CONFIG_DIR, homeB);

  // Mark it exhausted: the next action skips it, says why, and runs on the next account in order.
  await ok('agent-registry/accounts/claude-b/quota', coordinator, { quota: { state: 'exhausted', resetsAt: future(3 * hour) }, reason: 'The provider cut this plan off' });
  const skipped = await next();
  assert.equal(skipped.account, 'claude-a'); assert.deepEqual(skipped.skipped.map(entry => entry.environment), ['claude-b']);
  assert.match(skipped.skipped[0].reason, /claude-b quota is exhausted until .*The provider cut this plan off/);
  // The mark stands against the executor's own probe, which reads a healthy window for that login: it is there for what a probe cannot see.
  const held = ((await ok('agent-registry/document', coordinator)) as Registry).accounts.find(account => account.name === 'claude-b')!.quota;
  assert.deepEqual([held.state, held.source, held.observedBy, held.loggedIn], ['exhausted', 'operator', 'master', true]);
  assert.equal((await next()).account, 'claude-a');

  // A whole runtime joins mid-run at the head of two roles, serves the next action, and is then removed entirely.
  await ok('agent-registry/apply', operator, { runtimes: [runtimeNamed('codex')], models: [{ name: 'gpt', id: 'gpt-5.2-codex' }], accounts: [{ name: 'codex-a', runtime: 'codex', model: 'gpt', credential: { host: HOST, home: codexHome } }],
    roles: [{ name: 'worker', accounts: ['codex-a', 'claude-b', 'claude-a'], concurrency: 50 }, { name: 'reviewer', accounts: ['codex-a', 'claude-a'], concurrency: 50 }], reason: 'Codex joins the fleet' });
  const codex = await next();
  assert.deepEqual([codex.account, codex.kind, codex.tab.CODEX_HOME], ['codex-a', 'codex', codexHome]);
  assert.equal((await selectAccount(config, 'reviewer', { name: 'review-a' }, { ...probe, work: 'GY-960' })).account!.name, 'codex-a');
  const removal = await ok('agent-registry/runtimes/codex/remove', operator, { reason: 'The Codex plan was cancelled' });
  assert.deepEqual(removal.removed, { accounts: ['codex-a'], roles: { worker: ['codex-a'], reviewer: ['codex-a'] } });
  const after: FleetView = await ok(`agent-registry?host=${HOST}`, auditor);
  assert.deepEqual([after.runtimes.map(runtime => runtime.name), after.roles.find(role => role.role === 'worker')!.accounts, after.roles.find(role => role.role === 'reviewer')!.accounts], [['claude'], ['claude-b', 'claude-a'], ['claude-a']]);
  assert.ok(after.sessions.filter(entry => entry.account === 'codex-a').every(entry => entry.endedAt), 'sessions of a removed account stop counting');
  const fallback = await next();
  assert.deepEqual([fallback.account, fallback.kind, fallback.skipped.map(entry => entry.environment)], ['claude-a', 'claude', ['claude-b']], 'worker falls back in its own order: the exhausted account is passed over, the next one serves');
  assert.equal((await selectAccount(config, 'reviewer', { name: 'review-a' }, { ...probe, work: 'GY-961' })).account!.name, 'claude-a', 'reviewer falls back too');
  await ok('agent-registry/accounts/claude-b/quota', coordinator, { quota: { state: 'available' }, reason: 'The plan was renewed' });
  assert.equal((await next()).account, 'claude-b', 'and order is restored the moment the quota is');

  assert.equal(await readFile(file, 'utf8'), bytes, 'not one byte of the executor\'s file changed during the run');
  assert.doesNotMatch(bytes, /claude-a|claude-b|codex-a/, 'and it never named an account');
});

// ---------------------------------------------------------------------------
// AC-4 — unit:registry-visibility
// ---------------------------------------------------------------------------
test('unit:registry-visibility — master status and the dashboard show each account\'s runtime, model, role eligibility, live sessions, quota and reset time, and the reason any account is ineligible', () => {
  const at = '2026-09-20T12:00:00.000Z', now = Date.parse(at), context = { actor: 'operator', at }, resetsAt = '2026-09-20T17:00:00.000Z';
  let registry = emptyRegistry();
  const change = (kind: Parameters<typeof applyRegistryMutation>[1], input: unknown) => { registry = applyRegistryMutation(registry, kind, input, context).registry; };
  change('apply', { runtimes: [runtimeNamed('claude'), runtimeNamed('codex')], models: [{ name: 'opus', id: 'claude-opus-5', cost: { inputPerMTok: 15, outputPerMTok: 75 }, capability: { tier: 'frontier', contextTokens: 1_000_000 } }, { name: 'gpt', id: 'gpt-5.2-codex' }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: HOST, home: '/agents/claude-a' }, maxSessions: 1 }, { name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: HOST, home: '/agents/claude-b' } },
      { name: 'codex-a', runtime: 'codex', model: 'gpt', credential: { host: 'build-host-2', home: '/agents/codex-a' } }, { name: 'codex-out', runtime: 'codex', model: 'gpt', credential: { host: HOST, home: '/agents/codex-out' } }, { name: 'idle', runtime: 'codex', model: 'gpt', credential: { host: HOST, home: '/agents/idle' }, enabled: false }],
    roles: [{ name: 'worker', accounts: ['claude-a', 'claude-b', 'codex-a'], concurrency: 4 }, { name: 'reviewer', accounts: ['codex-out', 'claude-b'], concurrency: 1 }, { name: 'producer', accounts: ['claude-b'], concurrency: 0 }], reason: 'fixture' });
  change('account.quota', { name: 'claude-b', quota: { state: 'exhausted', loggedIn: true, resetsAt, usage: [{ window: '7d', percent: 100, resetsAt }] }, reason: 'weekly window spent' });
  foldObservation(registry.accounts.find(account => account.name === 'codex-out')!, { loggedIn: false, state: 'unknown', usage: [], resetsAt: null, reason: null }, { actor: 'master', at });
  const session = (overrides: Partial<FleetSession>): FleetSession => ({ id: randomUUID(), role: 'worker', account: 'claude-a', runtime: 'claude', model: 'opus', host: HOST, work: 'GY-5', principal: 'implementer', selectedAt: at, selectedBy: 'master', reason: 'claude-a is the first eligible account for worker', skipped: [], endedAt: null, endReason: null, ...overrides });
  registry.sessions.push(session({}));

  const view = fleetView(registry, now, HOST), byName = Object.fromEntries(view.accounts.map(account => [account.name, account]));
  assert.deepEqual(Object.fromEntries(view.accounts.map(account => [account.name, account.ineligible])), {
    'claude-a': 'claude-a is at its session limit (1 of 1 live)', 'claude-b': `claude-b quota is exhausted until ${resetsAt} (weekly window spent)`, 'codex-a': 'codex-a is placed on build-host-2; this executor is build-host-1', 'codex-out': 'codex-out is not logged in', idle: 'idle is disabled' });
  assert.deepEqual([byName['claude-a'].runtime, byName['claude-a'].model, byName['claude-a'].modelId, byName['claude-a'].capability!.tier, byName['claude-a'].cost], ['claude', 'opus', 'claude-opus-5', 'frontier', { inputPerMTok: 15, outputPerMTok: 75 }]);
  assert.deepEqual(byName['claude-b'].roles, [{ role: 'worker', preference: 2, of: 3 }, { role: 'reviewer', preference: 2, of: 2 }, { role: 'producer', preference: 1, of: 1 }]);
  assert.deepEqual(byName['claude-a'].liveSessions.map(entry => [entry.role, entry.work, entry.since]), [['worker', 'GY-5', at]]);
  assert.deepEqual([byName['claude-b'].quota, byName['claude-b'].resetsAt, byName['claude-b'].usage[0].percent, byName['claude-b'].loggedIn], ['exhausted', resetsAt, 100, true]);
  assert.match(view.roles.find(role => role.role === 'worker')!.blocked!, /no eligible account for worker: claude-a is at its session limit.*claude-b quota is exhausted.*codex-a is placed on build-host-2/);
  assert.match(view.roles.find(role => role.role === 'producer')!.blocked!, /role producer is paused \(concurrency 0\)/);
  assert.ok(view.attention.some(line => /idle serves no role/.test(line)) && view.attention.some(line => /role approver is not configured/.test(line)));
  // Past its reset an exhausted account is spendable again without anyone touching it, and a freed session frees its account.
  assert.equal(fleetView(registry, Date.parse(resetsAt) + 1, HOST).accounts.find(account => account.name === 'claude-b')!.eligible, true);
  assert.equal(chooseSession(registry, { role: 'worker', host: 'build-host-2' }, now).account?.name, 'codex-a', 'placement is judged for the executor asking');

  // Sessions end on their own: the control plane already knows what each was launched for.
  const later = now + launchGraceMs + 1, leased = (owner: string, expiresAt: string) => ({ key: 'GY-5', stage: 'build', lease: { owner, epoch: 1, expiresAt }, autoDispatch: null }) as any;
  assert.equal(sessionEnded(session({}), undefined, now + 1000), null, 'live through the launch grace, before the claim exists');
  assert.equal(sessionEnded(session({}), leased('implementer', new Date(later + hour).toISOString()), later), null);
  assert.match(sessionEnded(session({}), leased('implementer', at), later)!, /GY-5 holds no live lease/);
  assert.match(sessionEnded(session({}), leased('someone-else', new Date(later + hour).toISOString()), later)!, /leased to someone-else/);
  assert.match(sessionEnded(session({ role: 'reviewer' }), { key: 'GY-5', stage: 'review', lease: null, autoDispatch: { review: null, producers: [], history: [] } } as any, later)!, /no standing review request/);
  assert.equal(sessionEnded(session({ role: 'reviewer' }), { key: 'GY-5', stage: 'review', lease: null, autoDispatch: { review: { state: 'requested' }, producers: [], history: [] } } as any, later), null);
  assert.match(sessionEnded(session({ role: 'approver', work: null }), undefined, now + 31 * 60_000)!, /decision window passed/);
  const settled = structuredClone(registry); settled.sessions.push(session({ id: 'newer', selectedAt: new Date(now + 1000).toISOString() }));
  assert.deepEqual(settleSessions(settled, [], new Date(now + 2000).toISOString()).map(entry => entry.endReason), ['superseded by the claude-a session launched for GY-5']);

  // master status: the same facts, per account, with every blocked role raised as the master's own attention.
  const status = buildMasterStatus({ work: [], now: at }, [], [], {}, {}, { pending: [], completed: [] }, 'main', { fleet: view });
  const row = status.fleet!.accounts.find(account => account.account === 'claude-b')!;
  assert.deepEqual([row.runtime, row.model, row.roles, row.quota, row.resetsAt, row.eligible, row.ineligible], ['claude', 'opus', ['worker (2 of 3)', 'reviewer (2 of 2)', 'producer (1 of 1)'], 'exhausted', resetsAt, false, `claude-b quota is exhausted until ${resetsAt} (weekly window spent)`]);
  assert.deepEqual(status.fleet!.accounts.find(account => account.account === 'claude-a')!.liveSessions, [{ role: 'worker', work: 'GY-5', since: at }]);
  assert.deepEqual(status.fleet!.ineligible.map(entry => entry.account), ['claude-a', 'claude-b', 'codex-a', 'codex-out', 'idle']);
  const raised = status.attentionItems.filter(item => item.subject === 'fleet');
  assert.ok(raised.length >= 3 && raised.every(item => item.role === 'master' && !item.human && /graphyard master registry/.test(item.next)), 'the master resolves fleet attention itself, in the registry');
  assert.equal(status.counts.attention, raised.length);
  assert.equal(buildMasterStatus({ work: [], now: at }, [], []).fleet, null, 'a control plane before the registry reports none');
  assert.match(buildMasterStatus({ work: [], now: at }, [], [], {}, {}, { pending: [], completed: [] }, 'main', { fleet: fleetView(emptyRegistry(), now) }).fleet!.next!, /master registry propose --apply/);

  // Dashboard: the page renders the same view.
  const page = renderToStaticMarkup(createElement(FleetOverview, { fleet: view }));
  for (const shown of ['claude-b · claude · opus (claude-opus-5) · ineligible', `Ineligible: claude-b quota is exhausted until ${resetsAt} (weekly window spent)`, 'worker (2 of 3), reviewer (2 of 2), producer (1 of 1)', 'Quota: exhausted — 7d 100%', 'worker on GY-5 since', '(limit 1)', 'Ineligible: codex-out is not logged in', 'Login: logged out', 'Ineligible: codex-a is placed on build-host-2', '$15 in / $75 out per MTok', 'Capability: frontier',
    'worker · 1 of 4 running · next: none', 'claude-a → claude-b → codex-a', 'role producer is paused (concurrency 0)', 'Credential by reference: /agents/claude-a on build-host-1', 'CLAUDE_CONFIG_DIR'])
    assert.ok(page.includes(shown.replaceAll('\'', '&#x27;')), shown);
  assert.ok(page.includes(new Date(resetsAt).toLocaleString()), 'the reset time');
});

// ---------------------------------------------------------------------------
// AC-5 — setup discovers the host and proposes a registry (the onboarding review is manual:registry-onboarding-review)
// ---------------------------------------------------------------------------
test('integration:registry-setup-proposal — setup discovers the logged-in CLIs and their accounts, proposes a registry, and a new installation reaches a working fleet with no hand-written profile; the onboarding guide adds a runtime, an account and a role in that order', async () => {
  await reset();
  const directory = await temporaryDirectory('environments', scratch), home = await temporaryDirectory('home', scratch);
  const isolated = await login(directory, 'claude-b', 'claude'); await login(directory, 'claude-c', null); const codexHome = await login(directory, 'codex-a', 'codex');
  await login(home, '.claude', 'claude');
  const logins = await discoverHostLogins({ directory, home, executables: name => name === 'muse' });
  assert.deepEqual(logins.map(entry => [entry.name, entry.runtime, entry.loggedIn, entry.source]), [['claude-b', 'claude', true, 'environment'], ['claude-c', 'claude', false, 'environment'], ['codex-a', 'codex', true, 'environment'], ['claude', 'claude', true, 'default-home'], ['muse', 'muse', null, 'executable']]);
  assert.match(logins[1].login!, /CLAUDE_CONFIG_DIR=.*claude-c.* claude, then \/login/);

  const cli = { read: (path: string) => ok(path, coordinator), write: (path: string, data: unknown) => ok(path, coordinator, data) };
  const preview = await registryCommand({ hostId: HOST }, ['propose', '--directory', directory], cli, { home, executables: name => name === 'muse' }) as any;
  assert.equal(preview.applied, false); assert.match(preview.next, /--apply/);
  assert.deepEqual(preview.proposal.runtimes.map((runtime: any) => runtime.name), ['claude', 'codex', 'muse']);
  assert.deepEqual(preview.proposal.accounts.map((account: any) => [account.name, account.runtime, account.model, account.credential.home]), [['claude-b', 'claude', 'claude-default', isolated], ['codex-a', 'codex', 'codex-default', codexHome], ['claude', 'claude', 'claude-default', join(home, '.claude')], ['muse', 'muse', 'muse-default', null]]);
  assert.deepEqual(preview.proposal.roles.map((role: any) => role.name), [...fleetRoles]); assert.ok(preview.proposal.roles.every((role: any) => role.accounts.join() === 'claude-b,codex-a,claude,muse' && role.concurrency >= 1));
  assert.equal((await ok('agent-registry', auditor) as FleetView).configured, false, 'a proposal stores nothing');

  const applied = await registryCommand({ hostId: HOST }, ['propose', '--directory', directory, '--apply'], cli, { home, executables: name => name === 'muse' }) as any;
  assert.equal(applied.applied, true); assert.equal(applied.registry.configured, true);
  // A working fleet, with no profile account written by hand: the first dispatch runs on a discovered login.
  const { root, config } = await master([{ name: 'worker-a', principal: 'implementer', kind: 'codex' }]);
  const calls: string[][] = [];
  const first = await dispatch(root, config, 'worker-a', network({ 'claude-b-oauth-token': { five: 1, seven: 1 } }), calls);
  assert.equal(first.account!.environment, 'claude-b'); assert.equal(tabEnvironment(calls[0]).CLAUDE_CONFIG_DIR, isolated);
  // Running it again proposes only what is new, and never reorders what an operator arranged.
  await ok('agent-registry/roles', operator, { role: { name: 'worker', accounts: ['codex-a', 'claude-b'], concurrency: 7 }, reason: 'An operator\'s own order' });
  await writeFile(join(directory, 'claude-c', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'claude-c-token', refreshToken: 'r', expiresAt: Date.now() + hour } }));
  const again = proposeFleet(await discoverHostLogins({ directory, home, executables: () => false }), HOST, await ok('agent-registry/document', coordinator));
  assert.deepEqual([again.runtimes, again.accounts.map(account => account.name)], [[], ['claude-c']]);
  assert.deepEqual(again.roles.find(role => role.name === 'worker'), { name: 'worker', accounts: ['codex-a', 'claude-b', 'claude-c'], concurrency: 7 });

  const guide = await readFile(new URL('../docs/onboarding.md', import.meta.url), 'utf8');
  const order = ['### Add a runtime', '### Add an account', '### Add a role'].map(heading => guide.indexOf(heading));
  assert.ok(order.every(index => index >= 0) && order[0] < order[1] && order[1] < order[2], 'docs/onboarding.md adds a runtime, an account and a role, in that order');
  for (const command of ['master registry propose --apply', 'master registry runtime set', 'master registry account set', 'master registry role set']) assert.ok(guide.includes(command), command);

  // Every command the guide prints is run as written: a documented form the CLI cannot parse — a
  // value starting with a dash written apart from its flag, say — is a broken onboarding, and an
  // onboarding review is the only thing that ever found it.
  const empty = await temporaryDirectory('no-logins', scratch);
  const written: { path: string; data: any }[] = [];
  const recording = { read: async () => emptyRegistry(), write: async (path: string, data: unknown) => { written.push({ path, data }); return { revision: 1, registry: {} }; } };
  const documented = documentedCommands(guide);
  assert.ok(documented.length >= 8, 'the guide prints the fleet commands');
  for (const command of documented)
    await registryCommand({ hostId: HOST }, command, recording, { directory: empty, home: empty, executables: () => false });
  const runtime = written.find(entry => entry.path === 'agent-registry/runtimes')!;
  assert.deepEqual([runtime.data.runtime.name, runtime.data.runtime.launch.args, runtime.data.runtime.launch.modelFlag, runtime.data.runtime.launch.homeVariable], ['aider', ['--yes-always'], '--model', 'AIDER_HOME']);
  assert.deepEqual(written.filter(entry => entry.path === 'agent-registry/roles').map(entry => entry.data.role.name), ['worker', 'reviewer']);
  assert.deepEqual(written.find(entry => entry.data.role?.name === 'reviewer')!.data.role.policy, { args: [], tools: ['Read'], model: 'opus' });
});
