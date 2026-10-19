import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import {
  doctorLimitRetryAt, doctorLimitUntilMarker, headlessTimeoutLimit, headlessTimeoutLimitCharge, runTimeoutLimit, silentPaneExhaustion, silentPaneExhaustionReason,
} from '../src/model/capacity.js';
import {
  approverProfile, approverRoleHealth, approverSessionName, holdRepeatedLimitAccount, masterConfigSchema, observedExhaustions, recordEnvironmentLog,
  recordObservedExhaustion, repeatedLimitAccount, selectAccount, selectApproverAccount, selectionKey, sessionAccount, type MasterConfig,
} from '../src/master.js';
import { clearDoctorRuns, doctorDue, doctorRunsSettled, doctorStep, type DoctorEffects } from '../src/daemon/doctor.js';
import { doctorSettingsSchema } from '../src/master/doctor-settings.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Principal, Work } from '../src/model.js';
import type { RunEvent, RunResult, Runner } from '../src/runner/types.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1705: a pane-role session that ends silent (Herdr `done`, never working, no outcome or notice
// past its start bound, still untouched screen) and a headless round stopped at its bound with a
// readable provider limit both hold the account the launch spent and fail the role over. Idle is
// not silent spend: Herdr reports a long or silent command as idle while it still runs.
// Fixed clocks are numeric epochs (no Date.parse/Date.UTC of a calendar day); Date.now() only
// drives the live approver-loop fixtures and relative holds.

const repository = 'owner/silent-exhaustion';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `silent-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, home: string;

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(principal, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const fresh = () => store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');

before(async () => {
  const port = Number(process.env.GRAPHYARD_SILENT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 55);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('silent-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('silent_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/silent_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await temporaryDirectory('silent-home');
  await mkdir(join(home, 'env-a'), { recursive: true }); await mkdir(join(home, 'env-b'), { recursive: true });
  await writeFile(join(home, 'env-a/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'not-a-real-token' } }));
  await writeFile(join(home, 'env-b/auth.json'), JSON.stringify({ tokens: { access_token: 'not-a-real-token' } }));
});
after(async () => {
  await new Promise<void>(resolve => http.close(() => resolve()));
  await store.close();
  await database.stop();
});
afterEach(() => clearDoctorRuns());

const limitError = '429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-03 08:27:35"}';/** 2026-10-01T22:22:33.900Z as a millisecond epoch — handed to limit detectors as their fixed now. */
const limitNow = 1_790_893_353_900;
const limitReset = new Date(2026, 9, 3, 8, 27, 35).toISOString();

test('unit:silent-pane-exhaustion-signal — only a listed, ended, never-working, outcomeless pane past its start bound with no notice is spent', () => {
  const spent = silentPaneExhaustion({ listed: true, everWorking: false, hasOutcome: false, notice: null, pastStartBound: true, ended: true });
  assert.deepEqual(spent, { reason: silentPaneExhaustionReason, resetsAt: null });
  for (const [label, input] of [
    ['not listed', { listed: false, everWorking: false, hasOutcome: false, notice: null, pastStartBound: true, ended: true }],
    ['not ended', { listed: true, everWorking: false, hasOutcome: false, notice: null, pastStartBound: true, ended: false }],
    ['worked', { listed: true, everWorking: true, hasOutcome: false, notice: null, pastStartBound: true, ended: true }],
    ['has outcome', { listed: true, everWorking: false, hasOutcome: true, notice: null, pastStartBound: true, ended: true }],
    ['has notice', { listed: true, everWorking: false, hasOutcome: false, notice: { reason: 'limit', resetsAt: null }, pastStartBound: true, ended: true }],
    ['inside start bound', { listed: true, everWorking: false, hasOutcome: false, notice: null, pastStartBound: false, ended: true }],
  ] as const) {
    assert.equal(silentPaneExhaustion(input), null, label);
  }
});

test('unit:run-timeout-limit-signal — a timeout round carries its provider limit from retry/stream errors; prose and tool-end booleans do not', () => {
  const retry: RunEvent = { kind: 'retry', at: new Date(limitNow).toISOString(), attempt: 1, error: limitError };
  const signal = runTimeoutLimit([retry], 'no terminal event within 1200s; the run was stopped', limitNow);
  assert.ok(signal); assert.equal(signal.resetsAt, limitReset); assert.match(signal.reason, /Weekly\/Monthly Limit Exhausted/);
  assert.equal(runTimeoutLimit([{ kind: 'tool-end', at: '', tool: 'x', call: '1', error: true, text: 'limit' } as RunEvent], 'timeout', limitNow), null);
  assert.equal(runTimeoutLimit([], 'no terminal event within 1200s; the run was stopped', limitNow), null, 'a bare timeout detail with no provider error is not a limit');
  const round = headlessTimeoutLimit([
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [retry] },
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [{ kind: 'message', error: limitError }] },
  ], limitNow);
  assert.ok(round); assert.equal(round.resetsAt, limitReset);
  // One readable limit in an all-timeout round is enough: the fallback need not repeat the notice.
  const oneNotice = headlessTimeoutLimit([
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [retry] },
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [] },
  ], limitNow);
  assert.ok(oneNotice); assert.equal(oneNotice.resetsAt, limitReset);
  assert.equal(headlessTimeoutLimit([{ result: 'timeout', detail: 'stopped', events: [] }, { result: 'timeout', detail: 'stopped', events: [] }], limitNow), null);
  assert.equal(headlessTimeoutLimit([{ result: 'timeout', detail: 'stopped', events: [retry] }, { result: 'exit', detail: 'gone', events: [] }], limitNow), null);
});

test('unit:hold-charged-to-selected-account — sessionAccount and repeatedLimit read the launch/selection account, never a nominal profile', async () => {
  const root = await temporaryDirectory('hold-charged');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'token', { mode: 0o600 });
  const config = { credentialFile } as Pick<MasterConfig, 'credentialFile'>;
  await recordEnvironmentLog(config, [], [], { key: selectionKey('approver', approverProfile), environment: 'claude-c', kind: 'claude', at: new Date().toISOString(), work: 'GY-1701' });
  await recordEnvironmentLog(config, [], [], { key: selectionKey('doctor', 'doctor'), environment: 'zai-a', kind: 'pi', at: new Date().toISOString(), work: null });
  assert.equal((await sessionAccount(root, config, 'approver', approverProfile, { work: 'GY-1701' }))?.environment, 'claude-c');
  assert.equal((await sessionAccount(root, config, 'doctor', 'doctor'))?.environment, 'zai-a');
  const base = Date.now();
  const exhaustion = (requestId: string, offsetMs: number) => ({
    at: new Date(base + offsetMs).toISOString(), role: 'approver' as const, account: 'claude-c', profile: approverProfile, reason: 'silent', resetsAt: null, requestId,
    recordedBy: 'loop', owner: null, runtime: 'claude', partialWork: { state: 'not-applicable' as const, detail: 'n/a' },
  });
  // Distinct sessions share one decision/request id across failover relaunches — they still count.
  const work = { key: 'GY-1', epoch: 2, capacity: { escalations: [], exhaustions: [exhaustion('same-decision', 0), exhaustion('same-decision', 60_000)] } };
  assert.equal(repeatedLimitAccount(work, base + 60_000, 'approver')?.account, 'claude-c');
  const duplicateReport = { key: 'GY-1', epoch: 2, capacity: { escalations: [], exhaustions: [exhaustion('req-1', 0), exhaustion('req-1', 0)] } };
  assert.equal(repeatedLimitAccount(duplicateReport, base, 'approver'), null, 'the same instant reported twice is one session');
});

test('integration:no-repeat-launch-into-silent-account — holdRepeatedLimitAccount before selectApproverAccount keeps a repeatedly spent pane account out of selection', async () => {
  const dir = await temporaryDirectory('pane-repeat-hold');
  const credentialFile = join(dir, 'coordinator.token');
  await writeFile(credentialFile, 'token', { mode: 0o600 });
  await mkdir(join(dir, 'env-a'), { recursive: true }); await mkdir(join(dir, 'env-b'), { recursive: true });
  await writeFile(join(dir, 'env-a/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  await writeFile(join(dir, 'env-b/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile, cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1, hostId: 'machine-a', masterAgentName: 'gy-master', autoMerge: true, mergeMethod: 'merge', workers: [],
    environments: [{ name: 'env-a', kind: 'claude', home: join(dir, 'env-a') }, { name: 'env-b', kind: 'claude', home: join(dir, 'env-b') }],
    reviewers: [{ name: 'reviewer-a', agentName: 'agent-reviewer-a', kind: 'claude', agentArgs: [], approvals: 'auto', environment: {}, accounts: ['env-a', 'env-b'] }],
  }) as MasterConfig;
  const base = Date.now();
  const exhaustion = (role: 'approver' | 'reviewer', offsetMs: number) => ({
    at: new Date(base + offsetMs).toISOString(), role, account: 'env-a', profile: role === 'approver' ? approverProfile : 'reviewer-a', reason: 'quota', resetsAt: null,
    requestId: 'shared-request', recordedBy: 'loop', owner: null, runtime: 'claude', partialWork: { state: 'not-applicable' as const, detail: 'n/a' },
  });
  const work = { key: 'GY-1701', epoch: 2, capacity: { escalations: [], exhaustions: [exhaustion('approver', 0), exhaustion('approver', 60_000)] } };
  assert.equal(repeatedLimitAccount(work, base + 60_000, 'approver')?.account, 'env-a');
  const placed = await holdRepeatedLimitAccount(config, work, base + 60_000, {}, 'approver');
  assert.equal(placed?.account, 'env-a');
  assert.ok((await observedExhaustions(config, base + 60_000))['env-a']);
  const chosen = await selectApproverAccount(config, work.key, 'approver-agent', { quota: false, cacheMs: 0, registry: undefined });
  assert.equal(chosen.account?.name, 'env-b', 'real selection path skips the repeatedly held pane-role account');
  // Reviewer selection after the assumed hold lapses: two spent sessions sharing one request id
  // still re-hold before selectAccount (the launchReview path).
  const reviewWork = { key: 'GY-1701', epoch: 2, capacity: { escalations: [], exhaustions: [exhaustion('reviewer', 0), exhaustion('reviewer', 90_000)] } };
  assert.equal(repeatedLimitAccount(reviewWork, base + 90_000, 'reviewer')?.account, 'env-a');
  const afterLapse = base + 90_000 + 3_600_000 + 1;
  assert.equal((await observedExhaustions(config, afterLapse))['env-a'], undefined, 'the earlier hold has lapsed');
  const reviewHold = await holdRepeatedLimitAccount(config, reviewWork, afterLapse, {}, 'reviewer');
  assert.equal(reviewHold?.account, 'env-a');
  const reviewProfile = config.reviewers[0]!;
  const reviewChosen = await selectAccount(config, 'reviewer', reviewProfile, { quota: false, cacheMs: 0, now: () => afterLapse, work: reviewWork.key });
  assert.equal(reviewChosen.account?.name, 'env-b', 'launchReview\'s selectAccount path skips the repeatedly held reviewer account');
});

type Herdr = { agents: { name: string; pane_id: string; agent_status: string }[]; output: Record<string, string> };
const loginsOnly = (now: () => number) => ({ quota: false, now, cacheMs: 0 });
const definition = (title: string) => ({ title, plannedFiles: [`src/${title.replace(/\W+/g, '-')}.ts`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }],
  origin: { reviewFollowUps: { parent: 'GY-1', findings: [{ path: 'src/a.ts', text: 'src/a.ts — a finding' }] } } });

async function silentApproverLoop(label: string) {
  await fresh();
  const dir = await temporaryDirectory(`silent-${label}`);
  const credentialFile = join(dir, 'coordinator.token');
  await writeFile(credentialFile, token(coordinator), { mode: 0o600 });
  const config = masterConfigSchema.parse({
    version: 1, url, credentialFile, cliPath: join(process.cwd(), 'bin/graphyard.mjs'), repository, baseBranch: 'main',
    githubAppId: 1, hostId: 'silent-host', masterAgentName: 'gy-master', autoMerge: true, mergeMethod: 'merge', workers: [],
    environments: [{ name: 'env-a', kind: 'claude', home: join(home, 'env-a') }, { name: 'env-b', kind: 'codex', home: join(home, 'env-b') }],
    reviewers: [{ name: 'reviewer-a', agentName: 'agent-reviewer-a', kind: 'claude', agentArgs: [], approvals: 'auto', environment: {}, accounts: ['env-a', 'env-b'] }],
    run: { launchStartSeconds: 60 },
  }) as MasterConfig;
  const herdr: Herdr = { agents: [], output: {} };
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  const decisions: { id: string; action: string; state: string; input: any; approvedBy: string | null }[] = [];
  const launches: (string | null)[] = [];
  const effects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    sessionOutput: (agent: { name?: string | null }) => herdr.output[agent.name!] ?? '',
    closeSession: (pane: string) => { herdr.agents = herdr.agents.filter(agent => agent.pane_id !== pane); },
    holdAccount: (account: string, observed: Parameters<typeof recordObservedExhaustion>[2]) => recordObservedExhaustion(config, account, observed, now()),
    reportCapacity: (work: Work, event: unknown) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    decide: async (_work: Work, action: string, _reason: string, input: unknown) => { const entry = { id: `decision-${label}-${decisions.length + 1}`, action, state: 'requested', input: input ?? {}, approvedBy: null }; decisions.push(entry); return entry; },
    decisions: async () => ({ decisions }),
    approver: async (work: Work, decision: string) => {
      const chosen = await selectApproverAccount(config, work.key, 'approver-agent', { ...loginsOnly(now), registry: undefined });
      const agentName = approverSessionName(work, decision), pane = `pane-${launches.length}`;
      herdr.agents.push({ name: agentName, pane_id: pane, agent_status: 'idle' });
      launches.push(chosen.account?.name ?? null);
      return { agentName, pane, account: chosen.account?.name ?? null, runtime: chosen.account?.kind ?? null, session: `registry-${launches.length}` };
    },
    roleHealth: async () => ({ approver: await approverRoleHealth(config, loginsOnly(now)) }),
    snapshot: async () => { const snapshot = await ok(coordinator, 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: new Date(now()).toISOString() }; },
    endRegistrySession: async () => {},
    persist: async () => {},
    credentials: async () => ({}),
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'none', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    idleScreenPauseMs: 0,
  } as unknown as DaemonEffects;
  const filed = await ok(operator, 'POST', 'work', definition(`silent ${label}`)) as Work;
  const work = await ok(coordinator, 'POST', `work/${filed.id}/triage`, { judgement: { outcome: 'close', reason: 'Not worth doing' } }) as Work;
  return { config, herdr, clock, decisions, launches, work, now, cycle: (state: DaemonState) => runCycle(config, state, effects, now) };
}

/** Mark the live approver pane as ended (`done`) with an empty screen — the silent-death shape. */
function endSilent(herdr: Herdr, name: string) {
  const agent = herdr.agents.find(entry => entry.name === name);
  assert.ok(agent, name);
  agent.agent_status = 'done';
  herdr.output[name] = '';
}

test('integration:approver-silent-exhaustion-failover — a silent ended approver past its start bound holds its launch account and the decision continues on another', async () => {
  const { config, herdr, clock, decisions, launches, work, cycle } = await silentApproverLoop('failover');
  const state = emptyDaemonState(config);
  await cycle(state);
  assert.deepEqual(launches, ['env-a']);
  assert.equal(Object.values(state.approvals)[0].account, 'env-a');
  const name = approverSessionName(work, decisions[0].id);
  endSilent(herdr, name);
  clock.skewMs += 61_000;
  const detection = await cycle(state);
  const failover = detection.actions.find(action => action.kind === 'failover');
  assert.ok(failover, JSON.stringify(detection.actions));
  assert.equal(failover.state, 'done', failover.detail);
  assert.match(failover.detail, /without working|without a readable provider limit notice|ended without working/);
  const held = (await observedExhaustions(config, Date.now() + clock.skewMs))['env-a'];
  assert.ok(held, 'env-a is held');
  assert.equal(held.role, 'approver');
  assert.equal((await reload(work.id)).capacity!.exhaustions.at(-1)!.account, 'env-a');
  assert.deepEqual(launches, ['env-a', 'env-b']);
  assert.equal(Object.values(state.approvals)[0].account, 'env-b');
});

test('integration:approver-silent-exhaustion-failover — an idle pane whose screen still moves is not spent (long-command protection)', async () => {
  const { config, herdr, clock, decisions, launches, work, cycle } = await silentApproverLoop('idle-busy');
  const state = emptyDaemonState(config);
  await cycle(state);
  const name = approverSessionName(work, decisions[0].id);
  let ticks = 0;
  Object.defineProperty(herdr.output, name, { configurable: true, enumerable: true, get: () => `⏺ Bash(npm test)\n  ⎿ running ${++ticks}` });
  clock.skewMs += 61_000;
  const detection = await cycle(state);
  assert.equal(detection.actions.find(action => action.kind === 'failover'), undefined, JSON.stringify(detection.actions));
  assert.deepEqual(launches, ['env-a'], 'no replacement while the idle command may still be running');
  assert.equal((await observedExhaustions(config, Date.now() + clock.skewMs))['env-a'], undefined);
});

test('integration:approver-silent-exhaustion-failover — a done pane whose screen shows its decision is not silent exhaustion', async () => {
  const { config, herdr, clock, decisions, work, cycle } = await silentApproverLoop('done-worked');
  const state = emptyDaemonState(config);
  await cycle(state);
  const decision = decisions[0].id;
  const name = approverSessionName(work, decision);
  const agent = herdr.agents.find(entry => entry.name === name)!;
  agent.agent_status = 'done';
  herdr.output[name] = `${decision}\nAPPROVED\n`;
  clock.skewMs += 61_000;
  const detection = await cycle(state);
  const silent = detection.actions.find(action => action.kind === 'failover' && /without working|without a readable provider limit notice|ended without working/.test(action.detail ?? ''));
  assert.equal(silent, undefined, `silent exhaustion must not charge a done pane that shows its decision: ${JSON.stringify(detection.actions)}`);
  assert.equal((await observedExhaustions(config, Date.now() + clock.skewMs))['env-a'], undefined);
  assert.equal((await reload(work.id)).capacity?.exhaustions.length ?? 0, 0, 'no capacity exhaustion was recorded');
});

test('integration:no-repeat-launch-into-silent-account — after a silent death selection skips the held account', async () => {
  const { config, herdr, clock, decisions, launches, work, cycle, now } = await silentApproverLoop('no-repeat');
  const state = emptyDaemonState(config);
  await cycle(state);
  endSilent(herdr, approverSessionName(work, decisions[0].id));
  clock.skewMs += 61_000;
  await cycle(state);
  assert.deepEqual(launches, ['env-a', 'env-b']);
  const next = await selectAccount(config, 'approver', { name: approverProfile, accounts: ['env-a', 'env-b'], kind: 'claude' }, { ...loginsOnly(now), work: work.key });
  assert.equal(next.account?.name, 'env-b', 'selection hands the other account, never the silently spent one');
  await assert.rejects(selectAccount(config, 'approver', { name: approverProfile, accounts: ['env-a'], kind: 'claude' }, { ...loginsOnly(now), work: work.key }), /exhausted|no healthy|spent|quota|NoHealthy/i);
});

test('integration:replay-approver-silent-deaths — GY-1701\'s silent claude-c deaths hold on the first and leave the decision for another account', async () => {
  const { config, herdr, clock, decisions, launches, work, cycle } = await silentApproverLoop('replay-1701');
  const state = emptyDaemonState(config);
  await cycle(state);
  endSilent(herdr, approverSessionName(work, decisions[0].id));
  clock.skewMs += 61_000;
  await cycle(state);
  assert.ok((await observedExhaustions(config, Date.now() + clock.skewMs))['env-a']);
  assert.equal(launches.at(-1), 'env-b');
  assert.equal((await reload(work.id)).capacity!.exhaustions.filter(entry => entry.account === 'env-a').length, 1);
});

const timeoutFailure = (): RunResult<never> => ({ ok: false, failure: { reason: 'timeout', detail: 'no terminal event within 1200s; the run was stopped' }, payloads: [] });
function limitedTimeoutRunner(events: RunEvent[]): Runner {
  return { name: 'pi', start() { return { id: randomUUID(), events, onEvent: () => () => {}, cancel() {}, result: async () => timeoutFailure() }; } };
}

test('unit:run-timeout-limit-signal — headlessTimeoutLimitCharge holds every named limit attempt with its own reset', () => {
  const retry: RunEvent = { kind: 'retry', at: new Date(limitNow).toISOString(), attempt: 1, error: limitError };
  // Fallback-only notice on an unnamed Pi login: do not charge the silent registry primary.
  const charged = headlessTimeoutLimitCharge([
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [], account: 'registry-a' },
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [retry], account: null },
  ], limitNow);
  assert.ok(charged);
  assert.equal(charged.account, null, 'a fallback notice with no named account does not keep the primary registry account');
  assert.deepEqual(charged.holds, []);
  const primaryNotice = headlessTimeoutLimitCharge([
    { result: 'timeout', detail: 'stopped', events: [retry], account: 'registry-a' },
    { result: 'timeout', detail: 'stopped', events: [], account: null },
  ], limitNow);
  assert.equal(primaryNotice?.account, 'registry-a');
  assert.deepEqual(primaryNotice?.holds.map(entry => entry.account), ['registry-a']);
  // Both attempts print a limit: keep the named primary even when the Pi fallback is account: null.
  const both = headlessTimeoutLimitCharge([
    { result: 'timeout', detail: 'stopped', events: [retry], account: 'registry-a' },
    { result: 'timeout', detail: 'stopped', events: [retry], account: null },
  ], limitNow);
  assert.equal(both?.account, 'registry-a');
  assert.deepEqual(both?.holds.map(entry => entry.account), ['registry-a']);
  // Each named hold keeps its own resetsAt; the round wait still uses the earliest reset.
  const earlyReset = new Date(limitNow + 86_400_000).toISOString();
  const early = `Weekly/Monthly Limit Exhausted. Your limit will reset at ${earlyReset.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`;
  const lateRetry: RunEvent = { kind: 'retry', at: new Date(limitNow).toISOString(), attempt: 1, error: limitError };
  const earlyRetry: RunEvent = { kind: 'retry', at: new Date(limitNow).toISOString(), attempt: 1, error: early };
  const paired = headlessTimeoutLimitCharge([
    { result: 'timeout', detail: 'stopped', events: [lateRetry], account: 'registry-a' },
    { result: 'timeout', detail: 'stopped', events: [earlyRetry], account: null },
  ], limitNow);
  assert.equal(paired?.account, 'registry-a');
  assert.equal(paired?.holds.length, 1);
  assert.equal(paired?.holds[0]!.account, 'registry-a');
  assert.equal(paired?.holds[0]!.limit.resetsAt, limitReset, 'named hold keeps registry-a\'s own reset');
  assert.ok(paired?.limit.resetsAt);
  assert.ok(Date.parse(paired!.limit.resetsAt!) < Date.parse(limitReset), 'round wait still uses the earlier fallback reset');
  const round = headlessTimeoutLimit([
    { result: 'timeout', detail: 'stopped', events: [lateRetry] },
    { result: 'timeout', detail: 'stopped', events: [earlyRetry] },
  ], limitNow);
  assert.equal(round?.resetsAt, paired?.limit.resetsAt, 'round retry still uses the earliest reset');
});

test('integration:doctor-timeout-account-hold — a no-report timeout round with a readable limit holds the account and doctorDue waits it out', async () => {
  const held: { account: string; role: string }[] = [];
  const settings = doctorSettingsSchema.parse({ intervalMinutes: 10 }) as DoctorEffects['settings'];
  const retry: RunEvent = { kind: 'retry', at: new Date(limitNow).toISOString(), attempt: 1, error: limitError };
  const doctor: DoctorEffects = {
    settings, cwd: '/tmp', env: {},
    // Registry primary + null Pi fallback, both with a limit — hold the named primary (AC-2/AC-3).
    runner: async attempt => ({ runtime: 'pi', model: attempt, account: attempt === 'primary' ? 'zai-doctor' : null, release: async () => {}, runner: limitedTimeoutRunner([retry]) }),
    file: async () => { throw new Error('nothing filed'); },
    recordRun: async () => {},
  };
  /** 2026-10-11T12:11:26.439Z as a millisecond epoch — the filed doctor no-report clock. */
  const at = 1_791_720_686_439;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const state = emptyDaemonState(config);
  const fx = {
    doctor, persist: async () => {},
    holdAccount: async (account: string, observed: { role: string }) => { held.push({ account, role: observed.role }); },
  } as unknown as DaemonEffects;
  const cycle = { config, state, effects: fx, now: () => at, snapshot: { work: [], now: new Date(at).toISOString() }, clock: at, performed: [] as any[],
    isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle;
  await doctorStep(cycle);
  await doctorRunsSettled();
  assert.deepEqual(held, [{ account: 'zai-doctor', role: 'doctor' }]);
  const run = state.doctor.runs.at(-1)!;
  assert.equal(run.state, 'failed');
  assert.ok(run.detail.includes(doctorLimitUntilMarker), run.detail);
  assert.equal(doctorDue(state, at + 10 * 60_000, settings), false);
  const until = doctorLimitRetryAt(state.doctor.runs, at)!;
  assert.ok(until);
  assert.equal(doctorDue(state, Date.parse(until) + 1, settings), true);
});

test('manual:replay-doctor-no-report — the 2026-10-11 zai no-report rounds would hold the account so the next interval does not spend it twice', () => {
  const at = 1_791_720_686_439;
  const until = new Date(at + 3_600_000).toISOString();
  const marked = { state: 'failed', detail: `no report: zai/glm-5.3-flash timeout; zai/glm-5.3 timeout; ${doctorLimitUntilMarker}${until}` };
  const unmarked = { state: 'failed', detail: 'no report: zai/glm-5.3-flash timeout; zai/glm-5.3 timeout' };
  assert.equal(doctorLimitRetryAt([unmarked, marked], at + 10 * 60_000), until, 'the latest marked no-report waits out the hold');
  assert.equal(doctorLimitRetryAt([marked, unmarked], at + 10 * 60_000), null, 'an unmarked latest no-report (pre-fix) would not wait');
  const round = headlessTimeoutLimit([
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [{ kind: 'retry', error: limitError }] },
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [{ kind: 'retry', error: limitError }] },
  ], at);
  assert.ok(round);
});
