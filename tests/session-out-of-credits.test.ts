import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, failoverKey, runCycle, type DaemonEffects, type DaemonState, type LaunchedSession } from '../src/master-daemon.js';
import { approverRoleHealth, approverSessionName, masterConfigSchema, observedExhaustions, recordObservedExhaustion, selectAccount, selectApproverAccount, unknownResetHoldMs, type MasterConfig } from '../src/master.js';
import { detectRuntimeExhaustion } from '../src/master/environments.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1889: on 2026-10-17 several reviewer and approver sessions stopped on Claude Code's
// out-of-usage-credits screen — "You're out of usage credits. Run /usage-credits to keep using
// Fable 5.1 or /model to switch models." No source line recognised it: the loop read each reviewer
// as never started, counted the attempt against its request, and read each approver as a stall,
// while master status fleet still listed the accounts eligible, so later launches went to the same
// spent account. The screen is now read as the account's exhaustion (detection in src/fleet.ts,
// judged by detectRuntimeExhaustion): the session's account is held — the screen names no reset,
// so for the bounded unknown-reset hour — the session is closed, and its review request or
// approver decision is launched again on the next eligible profile in the same cycle, neither
// counted as a never-started attempt.

/** The screen as Claude Code draws it, behind its own bullet, notice and hint on one line. */
const screen = `● Reading the PR diff before reviewing.
  ⎿ You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.
`;
/** The same screen with its hint wrapped onto the line beneath the notice, as a narrow pane draws it. */
const wrapped = `● Working on the review.
You're out of usage credits.
Run /usage-credits to keep using Fable 5.1 or /model to switch models.
`;
const notice = "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.";

test('unit:out-of-credits-session-fails-over-at-once — the screen is the account\'s exhaustion wherever the runtime draws it, its first line alone is not the screen, and a reviewer session stopped on it is failed over in one cycle: account held for the bounded hour, request relaunched on the next eligible account, no never-started attempt, and the fleet reads the account ineligible', async () => {
  // Detection first, as the loop judges it: the stopped-session read of a claude pane.
  // Imported here so a checkout without the detection fails this case rather than the file's load.
  const { outOfCreditsScreen } = await import('../src/fleet.js');
  const judged = outOfCreditsScreen(screen)!;
  assert.deepEqual(judged, { reason: notice, resetsAt: null }, 'the screen names no reset, so the hold is bounded');
  assert.deepEqual(detectRuntimeExhaustion(screen, 'claude', Date.now()), judged, 'the loop\'s stopped-session judge reads the screen');
  assert.deepEqual(detectRuntimeExhaustion(screen, undefined, Date.now()), judged, 'whatever runtime the profile names');
  // The hint wrapped beneath the notice is the same screen, read whole.
  assert.deepEqual(outOfCreditsScreen(wrapped), judged);
  assert.deepEqual(detectRuntimeExhaustion(wrapped, 'claude', Date.now()), judged);
  // So is a narrow pane's wrap inside the notice itself, and one splitting both notice and hint.
  const noticeWrapped = "● Working on the review.\n⎿ You're out of usage\n  credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.\n";
  assert.deepEqual(outOfCreditsScreen(noticeWrapped), judged, 'a wrap inside the notice is the same screen');
  assert.deepEqual(detectRuntimeExhaustion(noticeWrapped, 'claude', Date.now()), judged);
  const narrow = "│ You're out of │\n│ usage credits. Run │\n│ /usage-credits to keep │\n│ using Fable 5.1 or /model │\n│ to switch models. │\n";
  assert.deepEqual(outOfCreditsScreen(narrow), judged, 'a boxed screen wrapped across five lines is the same screen');
  // Terminal decoration in front of the notice is not part of it.
  const drawn = '\u001b[2m⎿ API Error\u001b[0m · You\'re out of usage credits.\n  Run /usage-credits to keep using Fable 5.1 or /model to switch models.\n';
  assert.match(outOfCreditsScreen(drawn)!.reason, /^API Error · You're out of usage credits\./);
  // The notice alone, in a summary or a transcript line, is not the screen.
  assert.equal(outOfCreditsScreen("● Summarising: the pane reads You're out of usage credits, so I stopped.\n"), null);
  assert.equal(outOfCreditsScreen('Run /usage-credits to keep going — the account is fine.\n'), null, 'the hint alone is not the screen either');
  // An agent's sentence quoting both the notice and the hint is not the screen, wrapped or not.
  const quoted = "The detector wrongly accepts You're out of usage credits. Run /usage-credits to continue.";
  assert.equal(outOfCreditsScreen(`● Reviewing.\n${quoted}\n`), null, 'prose quoting the notice and a hint');
  assert.equal(detectRuntimeExhaustion(`● Reviewing.\n${quoted}\n`, 'claude', Date.now()), null);
  assert.equal(outOfCreditsScreen(`● The reviewer saw the screen: ${notice}\n`), null, 'prose quoting the whole screen behind a sentence');
  assert.equal(outOfCreditsScreen(`● Finding: the pane shows\nYou're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models. Then it waited.\n`), null, 'the hint must end the screen, not run on into prose');
  // What the session scrolled away is worked past, not stopped on.
  const scrolled = [screen, ...Array.from({ length: 60 }, (_, index) => `edited file ${index}`)].join('\n');
  assert.equal(outOfCreditsScreen(scrolled), null);

  await fresh();
  // A credential directory of its own: the environment log, and with it the account holds, is per test.
  config = await configWithCredentials('reviewer');
  await applyFleet();
  const work = await released('out of credits review');
  const session: LaunchedSession = { role: 'reviewer', record: randomUUID(), profile: 'reviewer-a', agentName: 'agent-reviewer-a', pane: 'pane-reviewer', work: work.key, requestId: 'request-credits-1' };
  herdr.agents.push({ name: session.agentName, pane_id: 'pane-reviewer', agent_status: 'idle' });
  herdr.output[session.agentName] = screen;
  const ended: string[] = [], relaunched: (string | null)[] = [];
  const state = emptyDaemonState(config);
  const reviewerRun = loop({
    launchedSessions: async () => [session],
    endSession: async (entry, resolution) => { ended.push(resolution); herdr.agents = herdr.agents.filter(agent => agent.name !== entry.agentName); },
    relaunch: async (entry, item) => {
      // The hold the failover just placed is what steers the relaunch: the real account choice for
      // the same profile now refuses the spent account and answers with the next eligible one.
      const chosen = await selectAccount(config, 'reviewer', config.reviewers[0], { quota: false, now: () => Date.now() + clock.skewMs, cacheMs: 0, work: item.key });
      relaunched.push(chosen.account?.name ?? null);
      return { profile: 'reviewer-b' };
    },
    // The launch record names the account the session was launched on (GY-1582): the hold lands there.
    selectedAccount: async () => ({ environment: 'env-a', kind: 'claude' }),
  });
  await reviewerRun.cycle(state);
  const failover = state.actions[failoverKey('reviewer', work, session.record)];
  assert.equal(failover?.state, 'done', failover?.detail);
  assert.match(failover.detail, /exhausted env-a mid-session \(You're out of usage credits[\s\S]*; reset time unknown\); relaunched on profile reviewer-b/);

  // Closed, with the exhaustion as the resolution — never "never started".
  assert.equal(ended.length, 1);
  assert.match(ended[0], /provider quota exhausted on env-a mid-session \(You're out of usage credits[\s\S]*; reset time unknown\); launched again on another account/);
  assert.deepEqual(relaunched, ['env-b'], 'the request is launched again in the same cycle, on the next eligible account');
  assert.ok(!Object.values(state.actions).some(action => /never started/.test(action.detail)), 'the screen is no never-started attempt');

  // The account is held for the bounded unknown-reset hour: the screen names no reset to wait for.
  const held = (await observedExhaustions(config))['env-a'];
  assert.ok(held, 'the account is held');
  assert.equal(held.resetsAt, null);
  const bound = Date.parse(held.until) - Date.parse(held.at);
  assert.ok(bound >= unknownResetHoldMs && bound < unknownResetHoldMs + 60_000, `the hold is the bounded unknown-reset hour, not ${bound}ms`);
  assert.match(held.reason, new RegExp(notice.slice(0, 40)));
  assert.equal(held.role, 'reviewer');
  const recorded = (await reload(work.id)).capacity!.exhaustions.at(-1)!;
  assert.deepEqual([recorded.role, recorded.requestId, recorded.account, recorded.resetsAt, recorded.profile, recorded.partialWork.state],
    ['reviewer', 'request-credits-1', 'env-a', null, 'reviewer-a', 'not-applicable']);

  // master status fleet reads its fleet view from the registry the hold was reported to: the spent
  // account is not eligible there, the other one still is.
  const view = await ok(coordinator, 'GET', 'agent-registry?host=loop-host') as { accounts: { name: string; eligible: boolean; quota: string; ineligible: string | null }[] };
  const spent = view.accounts.find(account => account.name === 'env-a')!;
  assert.equal(spent.eligible, false, 'the exhausted account is not eligible');
  assert.equal(spent.quota, 'exhausted');
  assert.match(spent.ineligible ?? '', /quota is exhausted until/);
  assert.equal(view.accounts.find(account => account.name === 'env-b')!.eligible, true, 'the other account is still eligible');

  // The next cycle repeats nothing: the ended session is no longer pending.
  await reviewerRun.cycle(state);
  assert.deepEqual(relaunched, ['env-b']);
  assert.equal(ended.length, 1);
  assert.equal((await reload(work.id)).capacity!.exhaustions.length, 1);
});

test('unit:out-of-credits-session-fails-over-at-once — an approver session stopped on the same screen is closed and its decision relaunched on the next eligible approver account in the same cycle, its account held for the bounded hour, and no stall or never-started is recorded', async () => {
  await fresh();
  config = await configWithCredentials('approver');
  // One machine-filed item the loop itself puts a close decision to: its approver is the session below.
  const filed = await ok(operator, 'POST', 'work', { title: 'approver out of credits', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }],
    origin: { reviewFollowUps: { parent: 'GY-1', findings: [{ path: 'src/a.ts', text: 'src/a.ts — a finding' }] } } }) as Work;
  const work = await ok(coordinator, 'POST', `work/${filed.id}/triage`, { judgement: { outcome: 'close', reason: 'Not worth doing once the parent shipped' } }) as Work;

  const decisions: { id: string; action: string; state: string; input: any; approvedBy: string | null }[] = [], launches: (string | null)[] = [];
  const state = emptyDaemonState(config);
  const decisionRun = loop({
    dispatch: async () => {},
    decide: async (_work, action, _reason, input) => { const entry = { id: `decision-credits-${decisions.length + 1}`, action, state: 'requested', input: input ?? {}, approvedBy: null }; decisions.push(entry); return entry; },
    decisions: async () => ({ decisions }),
    // The launch as the production one makes it: the real account choice, then a pane. With the
    // hold in place it answers with the next eligible account, so the relaunch below lands on env-b.
    approver: async (entry, decision) => {
      const chosen = await selectApproverAccount(config, entry.key, 'approver-agent', { quota: false, now: () => Date.now() + clock.skewMs, cacheMs: 0, registry: undefined });
      const agentName = approverSessionName(entry, decision), pane = `pane-approver-${launches.length}`;
      herdr.agents.push({ name: agentName, pane_id: pane, agent_status: 'working' });
      launches.push(chosen.account?.name ?? null);
      return { agentName, pane, account: chosen.account?.name ?? null, runtime: chosen.account?.kind ?? null, session: `registry-session-${launches.length}` };
    },
    roleHealth: async () => ({ approver: await approverRoleHealth(config, loginsOnly()) }),
    endRegistrySession: async (session, reason) => { calls.registryEnded.push([session, reason]); },
  });
  await decisionRun.cycle(state);
  assert.equal(decisions.length, 1, 'the loop requests the close decision');
  assert.deepEqual(launches, ['env-a'], 'and puts it to an approver on the first account');

  // The approver stops on Claude Code's out-of-usage-credits screen, as the approvers of GY-1889 did.
  const name = approverSessionName(work, decisions[0].id);
  herdr.agents.find(agent => agent.name === name)!.agent_status = 'idle';
  herdr.output[name] = screen;
  await decisionRun.cycle(state);

  // Closed in that one cycle: pane and registry session, with the screen as the reason.
  assert.deepEqual(calls.closed, ['pane-approver-0']);
  assert.deepEqual(calls.registryEnded.map(([session]) => session), ['registry-session-1']);
  assert.match(calls.registryEnded[0]![1], /You're out of usage credits/);
  const failover = Object.values(state.actions).find(action => action.kind === 'failover');
  assert.equal(failover?.state, 'done', failover?.detail);
  assert.match(failover.detail, /exhausted env-a mid-session \(You're out of usage credits[\s\S]*; reset time unknown\) judging close decision/);
  assert.match(failover.detail, /launched independent approver session \S+ on env-b/);
  assert.deepEqual(launches, ['env-a', 'env-b'], 'the decision is relaunched in the same cycle, on the next eligible account');
  assert.equal(decisions.length, 1, 'the decision is not requested again');

  // The account is held for the bounded hour, and the exhaustion — not a stall, not a
  // never-started attempt — is what the record and the watch carry.
  const held = (await observedExhaustions(config))['env-a'];
  assert.equal(held.resetsAt, null);
  const bound = Date.parse(held.until) - Date.parse(held.at);
  assert.ok(bound >= unknownResetHoldMs && bound < unknownResetHoldMs + 60_000, `the hold is the bounded unknown-reset hour, not ${bound}ms`);
  assert.match(held.reason, new RegExp(notice.slice(0, 40)));
  assert.equal(held.role, 'approver');
  const recorded = (await reload(work.id)).capacity!.exhaustions.at(-1)!;
  assert.deepEqual([recorded.role, recorded.account, recorded.resetsAt, recorded.partialWork.state], ['approver', 'env-a', null, 'not-applicable']);
  const watch = Object.values(state.approvals).find(entry => entry.decision === decisions[0].id)!;
  assert.equal(watch.account, 'env-b');
  assert.ok(watch.ended.length && watch.ended.every(entry => /You're out of usage credits/.test(entry)), 'the watch keeps the screen as each session\'s end');
  assert.ok(!Object.values(state.actions).some(action => /never started|\bstall\b/.test(action.detail)), 'no stall and no never-started attempt is recorded');

  // The next cycle repeats nothing: one hold, one close, one relaunch, the new approver left to judge.
  await decisionRun.cycle(state);
  assert.deepEqual(launches, ['env-a', 'env-b']);
  assert.equal(calls.closed.length, 1);
  assert.equal((await reload(work.id)).capacity!.exhaustions.length, 1);
});

// ---------------------------------------------------------------------------
// The loop as `master run` wires it, on a real control plane, with Herdr an inventory the test
// controls. Everything that decides — the snapshot, the capacity record, the account hold (and
// its report to the agent registry), the account selection for the relaunch — is real.
// ---------------------------------------------------------------------------

const repository = 'owner/session-out-of-credits';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `credits-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, home: string;
const herdr: { agents: { name: string; pane_id: string; agent_status: string }[]; output: Record<string, string> } = { agents: [], output: {} };
const clock = { skewMs: 0 };
const calls = { closed: [] as string[], registryEnded: [] as [string, string][] };

const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const loginsOnly = () => ({ quota: false, now: () => Date.now() + clock.skewMs, cacheMs: 0 });

let config: MasterConfig;

before(async () => {
  const port = Number(process.env.GRAPHYARD_RUNTIME_OUT_OF_CREDITS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1889);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('out-of-credits-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('out_of_credits_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/out_of_credits_test`); await store.init();
  engine = new Engine(store, 300, repository); engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await temporaryDirectory('out-of-credits-home');
  for (const account of ['env-a', 'env-b']) {
    await mkdir(join(home, account), { recursive: true });
    await writeFile(join(home, account, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'not-a-real-token' } }));
  }
  config = masterConfigSchema.parse({
    version: 1, url, credentialFile: join(home, 'coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
    repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-out-of-credits',
    workers: [],
    reviewers: [{ name: 'reviewer-a', agentName: 'agent-reviewer-a', kind: 'claude' as const, agentArgs: [], approvals: 'auto' as const, environment: {}, accounts: ['env-a', 'env-b'] }],
    environments: [{ name: 'env-a', kind: 'claude', home: join(home, 'env-a') }, { name: 'env-b', kind: 'claude', home: join(home, 'env-b') }],
  }) as MasterConfig;
});
/** A per-test config: its own credential directory (so the environment log and its account holds are per test) with the coordinator credential written, which the hold's registry report authenticates with. */
const configWithCredentials = async (label: string) => {
  const credentialFile = join(await temporaryDirectory(`out-of-credits-${label}`), 'coordinator.token');
  await writeFile(credentialFile, token(coordinator), { mode: 0o600 });
  return { ...config, credentialFile } as MasterConfig;
};
/** The fleet the account holds are reported to, so `master status fleet` can read them back. Each test applies it again: a test's fresh() truncates the events the registry is read from. */
const applyFleet = async () => {
  await ok(coordinator, 'POST', 'agent-registry/apply', {
    runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } }],
    models: [{ name: 'sonnet', id: 'claude-sonnet-5' }],
    accounts: [
      { name: 'env-a', runtime: 'claude', model: 'sonnet', credential: { host: 'loop-host', home: join(home, 'env-a') } },
      { name: 'env-b', runtime: 'claude', model: 'sonnet', credential: { host: 'loop-host', home: join(home, 'env-b') } },
    ],
    reason: 'the fleet GY-1889\'s holds are read back from',
  });
};
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

const fresh = async () => { await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE'); };
const released = async (title: string) => {
  const work = await ok(operator, 'POST', 'work', { title, criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }) as Work;
  return ok(operator, 'POST', `work/${work.id}/ready`, {}) as Promise<Work>;
};

function loop(overrides: Partial<DaemonEffects> = {}) {
  const now = () => Date.now() + clock.skewMs;
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: async () => ({}),
    snapshot: async () => { const snapshot = await ok(coordinator, 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: new Date(Date.parse(snapshot.now) + clock.skewMs).toISOString() }; },
    closeSession: pane => { calls.closed.push(pane); herdr.agents = herdr.agents.filter(agent => agent.pane_id !== pane); },
    dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    persist: async () => {},
    sessionOutput: agent => herdr.output[agent.name!] ?? '',
    reportCapacity: (work, event) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    // The hold goes to the environment log and, at once, to the agent registry, as the loop's does.
    holdAccount: (account, observed) => recordObservedExhaustion(config, account, observed, now(), { fetch }),
    endRegistrySession: async (session, reason) => { calls.registryEnded.push([session, reason]); },
    ...overrides,
  };
  return { effects, cycle: (state: DaemonState) => runCycle(config, state, effects, now) };
}
