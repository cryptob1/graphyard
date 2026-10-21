import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, failoverKey, runCycle, type DaemonEffects, type LaunchedSession } from '../src/master-daemon.js';
import { approverRoleHealth, approverSessionName, masterConfigSchema, observedExhaustions, recordObservedExhaustion, selectAccount, selectApproverAccount, unknownResetHoldMs, type MasterConfig } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1889 soak: two simulated days of the real loop on a host whose reviewer and approver sessions
 * launch on Claude accounts env-a (preferred) and env-b. env-a's usage credits are spent for the
 * first 30 hours: every session launched on it in that window stops on Claude Code's
 * out-of-usage-credits screen — sometimes drawn whole, sometimes wrapped by a narrow pane inside
 * the notice — and waits for a person. Sessions on a healthy account do their work and end. A
 * review request arrives every three hours and a close decision is filed every four. Every session
 * on the screen is closed and failed over in the cycle that first reads it, never counted as a
 * never-started attempt; env-a is held for the bounded unknown-reset hour each time, and nothing
 * launches on it while a hold stands; once a hold lapses the next launch tries env-a again and is
 * held again, so the holds stay bounded rather than stacking; once the credits return env-a takes
 * launches and keeps them; every request and decision is judged exactly once; and every system
 * invariant holds after every cycle. Instants are relative to a fixed soak epoch.
 */

const repository = 'owner/out-of-credits-soak';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `soak-credits-${principal.id}-${'x'.repeat(24)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string, home: string;

const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_OUT_OF_CREDITS_SOAK_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1890);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('credits-soak-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('credits_soak');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/credits_soak`); await store.init();
  const engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await temporaryDirectory('credits-soak-home');
  for (const account of ['env-a', 'env-b']) {
    await mkdir(join(home, account), { recursive: true });
    await writeFile(join(home, account, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'not-a-real-token' } }));
  }
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

const minute = 60_000, hour = 60 * minute;
/** Fixed soak epoch: 2026-10-17T00:00:00.000Z as a millisecond instant. */
const soakStart = 1_792_195_200_000;
const step = 5 * minute, days = 2, spentMs = 30 * hour, noticeMs = 5 * minute, reviewMs = 30 * minute;
/** An approver judges well inside the loop's 10-minute judge bound. */
const judgeMs = 5 * minute;
const reviewEveryMs = 3 * hour, decisionEveryMs = 4 * hour, arrivalsUntil = 40 * hour;
/** The screen as Claude Code draws it, and as a narrow pane wraps it inside the notice: the soak alternates them. */
const screens = [
  `● Reading the diff.\n  ⎿ You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.\n`,
  `● Reading the diff.\n  ⎿ You're out of usage\n    credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.\n`,
];

test('unit:soak-invariants-hold — over two days, every reviewer and approver session stopped on the out-of-usage-credits screen is closed and failed over in the cycle that reads it, its account held only for the bounded hour and re-held after each lapse while the credits stay spent, nothing launches on a held account, the account takes launches again once its credits return, every request and decision is judged once, and every invariant holds after every cycle', { timeout: 600_000 }, async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const credentialFile = join(await temporaryDirectory('credits-soak-run'), 'coordinator.token');
  await writeFile(credentialFile, token(coordinator), { mode: 0o600 });
  const config = masterConfigSchema.parse({
    version: 1, url, credentialFile, cliPath: join(process.cwd(), 'bin/graphyard.mjs'), repository, baseBranch: 'main',
    githubAppId: 4242, hostId: 'credits-soak-host', masterAgentName: 'graphyard-master-credits-soak', workers: [],
    reviewers: [{ name: 'reviewer-a', agentName: 'agent-reviewer-a', kind: 'claude', agentArgs: [], approvals: 'auto', environment: {}, accounts: ['env-a', 'env-b'] }],
    environments: [{ name: 'env-a', kind: 'claude', home: join(home, 'env-a') }, { name: 'env-b', kind: 'claude', home: join(home, 'env-b') }],
  }) as MasterConfig;

  let now = soakStart;
  const clock = () => now;
  const loginsOnly = { quota: false, now: clock, cacheMs: 0 };
  const spentUntil = soakStart + spentMs;
  interface Pane { name: string; pane_id: string; agent_status: string }
  interface Launch { role: 'reviewer' | 'approver'; subject: string; work: string; record?: string; account: string | null; pane: string; at: number; screen?: number; ended?: 'screen' | 'work'; closedAt?: number }
  let panes: Pane[] = [];
  const output = new Map<string, string>(), launches: Launch[] = [], holds: { account: string; role: string; at: number }[] = [], readings: { at: number; held: string; until: string; since: string }[] = [];
  /** The live reviewer sessions, as the loop's ledger lists them. */
  const reviews = new Map<string, LaunchedSession & { account: string | null }>();
  const reviewEnds: string[] = [];
  const decisions: { id: string; action: string; state: string; input: any; approvedBy: string | null; work: string }[] = [];
  let screenCount = 0;

  const launchReview = async (work: string, requestId: string) => {
    const chosen = await selectAccount(config, 'reviewer', config.reviewers[0]!, { ...loginsOnly, work });
    const pane = `pane-${launches.length}`, record = randomUUID(), agentName = `agent-reviewer-a-${launches.length}`;
    panes.push({ name: agentName, pane_id: pane, agent_status: 'working' });
    reviews.set(record, { role: 'reviewer', record, profile: 'reviewer-a', agentName, pane, work, requestId, account: chosen.account?.name ?? null });
    launches.push({ role: 'reviewer', subject: requestId, work, record, account: chosen.account?.name ?? null, pane, at: now });
  };

  const effects: DaemonEffects = {
    agents: () => panes,
    herdr: () => ({ agents: panes, available: true }),
    credentials: async () => ({}),
    snapshot: async () => { const snapshot = await ok(coordinator, 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: new Date(now).toISOString() }; },
    closeSession: pane => {
      const launch = launches.find(entry => entry.pane === pane);
      if (launch && launch.closedAt === undefined) launch.closedAt = now;
      panes = panes.filter(agent => agent.pane_id !== pane);
    },
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now).toISOString(), reason: 'no deployment endpoint in this soak', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    idleScreenPauseMs: 0,
    sessionOutput: agent => output.get(agent.pane_id ?? '') ?? `● Judging as ${agent.name}…\n`,
    reportCapacity: (work, event) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    holdAccount: async (account, observed) => { holds.push({ account, role: observed.role, at: now }); await recordObservedExhaustion(config, account, observed, now); },
    // Reviewers: the ledger's live sessions, ended and relaunched as the production launcher does — the relaunch through the real account choice.
    launchedSessions: async () => [...reviews.values()],
    selectedAccount: async (_role, _profile, session) => {
      const live = [...reviews.values()].find(entry => entry.work === session?.work);
      return live ? { environment: live.account, kind: 'claude' } : null;
    },
    endSession: async (session, resolution) => {
      reviewEnds.push(resolution);
      reviews.delete(session.record);
      effects.closeSession(session.pane!);
    },
    relaunch: async (session, item) => { await launchReview(item.key, session.requestId!); return { profile: 'reviewer-a' }; },
    // Approvers: the loop's own decision requests, each put to an approver on the real account choice.
    decide: async (work, action, _reason, input) => {
      const entry = { id: `decision-credits-${decisions.length + 1}`, action, state: 'requested', input: input ?? {}, approvedBy: null, work: work.key };
      decisions.push(entry);
      return entry;
    },
    decisions: async work => ({ decisions: decisions.filter(entry => entry.work === work.key) }),
    approver: async (work, decision) => {
      const chosen = await selectApproverAccount(config, work.key, 'approver-agent', { ...loginsOnly, registry: undefined });
      const agentName = approverSessionName(work, decision), pane = `pane-${launches.length}`;
      panes.push({ name: agentName, pane_id: pane, agent_status: 'working' });
      launches.push({ role: 'approver', subject: decision, work: work.key, account: chosen.account?.name ?? null, pane, at: now });
      return { agentName, pane, account: chosen.account?.name ?? null, runtime: chosen.account?.kind ?? null, session: `registry-${pane}` };
    },
    roleHealth: async () => ({ approver: await approverRoleHealth(config, loginsOnly) }),
    endRegistrySession: async () => {},
  };

  const state = emptyDaemonState(config);
  const violations: string[] = [], observed = new Set<string>(), failed: string[] = [];
  let nextReview = soakStart, nextDecision = soakStart + hour, requests = 0, filings = 0;
  for (; now < soakStart + days * 24 * hour; now += step) {
    // New work arrives: a review request on a fresh item, or a machine-filed item the loop puts a close decision to.
    if (now >= nextReview && now < soakStart + arrivalsUntil) {
      const created = await ok(operator, 'POST', 'work', { title: `credits soak review ${++requests}`, criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }) as Work;
      const work = await ok(operator, 'POST', `work/${created.id}/ready`, {}) as Work;
      await launchReview(work.key, `review-request-${requests}`);
      nextReview += reviewEveryMs;
    }
    if (now >= nextDecision && now < soakStart + arrivalsUntil) {
      const filed = await ok(operator, 'POST', 'work', { title: `credits soak close ${++filings}`, criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }],
        origin: { reviewFollowUps: { parent: 'GY-1', findings: [{ path: 'src/a.ts', text: `src/a.ts — finding ${filings}` }] } } }) as Work;
      await ok(coordinator, 'POST', `work/${filed.id}/triage`, { judgement: { outcome: 'close', reason: 'Not worth doing once the parent shipped' } });
      nextDecision += decisionEveryMs;
    }
    // Each open session: on spent env-a it stops on the screen; elsewhere it judges and ends.
    for (const launch of launches.filter(entry => !entry.ended && entry.closedAt === undefined)) {
      if (launch.account === 'env-a' && launch.at < spentUntil) {
        if (now - launch.at < noticeMs) continue;
        launch.ended = 'screen'; launch.screen = now;
        output.set(launch.pane, screens[screenCount++ % screens.length]!);
        panes = panes.map(agent => agent.pane_id === launch.pane ? { ...agent, agent_status: 'idle' } : agent);
      } else if (now - launch.at >= (launch.role === 'reviewer' ? reviewMs : judgeMs)) {
        launch.ended = 'work';
        if (launch.role === 'reviewer') {
          const [record] = [...reviews].find(([, session]) => session.pane === launch.pane) ?? [];
          if (record) reviews.delete(record);
          panes = panes.filter(agent => agent.pane_id !== launch.pane);
        } else {
          decisions.find(entry => entry.id === launch.subject)!.state = 'applied';
          panes = panes.map(agent => agent.pane_id === launch.pane ? { ...agent, agent_status: 'done' } : agent);
        }
      }
    }
    const result = await runCycle(config, state, effects, clock);
    failed.push(...result.actions.filter(action => action.state === 'failed' && action.kind !== 'deployment').map(action => `+${(now - soakStart) / minute}m ${action.detail}`));
    for (const check of state.invariants.report as InvariantCheck[]) {
      if (check.observed) observed.add(check.invariant);
      if (!check.holds) violations.push(`+${(now - soakStart) / minute}m ${check.line}`);
    }
    const held = (await observedExhaustions(config, now))['env-a'];
    if (held) readings.push({ at: now, held: held.reason, until: held.until, since: held.at });
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.ok(observed.size > 0, 'the loop evaluated its invariants');
  assert.deepEqual(failed, [], 'no failover, close or launch failed');
  const stopped = launches.filter(entry => entry.ended === 'screen');
  for (const role of ['reviewer', 'approver'] as const) {
    assert.ok(stopped.filter(entry => entry.role === role).length >= 3, `${role} sessions met the spent account across the days: ${launches.filter(entry => entry.role === role).map(entry => `${entry.subject}@${entry.account}`).join(', ')}`);
  }
  // Closed in the cycle that first read the screen, both shapes of it.
  assert.deepEqual(stopped.filter(entry => entry.closedAt !== entry.screen).map(entry => `${entry.role} ${entry.subject} screen +${(entry.screen! - soakStart) / minute}m closed ${entry.closedAt === undefined ? 'never' : `+${(entry.closedAt - soakStart) / minute}m`}`), [], 'every session on the screen is closed in the cycle that reads it');
  // One bounded hold per screen, on the spent account, and each relaunched on the other account at once.
  assert.equal(holds.length, stopped.length, `one hold per screen: ${JSON.stringify(holds)}`);
  assert.ok(holds.every(entry => entry.account === 'env-a'));
  for (const launch of stopped) {
    const relaunch = launches.find(entry => entry.subject === launch.subject && entry.at === launch.screen && entry.pane !== launch.pane);
    assert.equal(relaunch?.account, 'env-b', `${launch.role} ${launch.subject} was launched again in the same cycle, on env-b`);
  }
  const items = await store.list();
  for (const launch of stopped.filter(entry => entry.role === 'reviewer')) {
    const failover = state.actions[failoverKey('reviewer', items.find(work => work.key === launch.work)!, launch.record!)];
    assert.equal(failover?.state, 'done', `${launch.subject}'s failover is recorded done: ${failover?.detail}`);
    assert.match(failover.detail, /exhausted env-a mid-session \(You're out of usage credits\. Run \/usage-credits[^)]*; reset time unknown\); relaunched on profile reviewer-a$/);
  }
  const approverFailovers = Object.values(state.actions).filter(action => action.kind === 'failover' && /judging close decision/.test(action.detail));
  assert.equal(approverFailovers.filter(action => action.state === 'done').length, stopped.filter(entry => entry.role === 'approver').length, 'each approver on the screen is failed over once');
  assert.equal(reviewEnds.length, stopped.filter(entry => entry.role === 'reviewer').length);
  assert.ok(reviewEnds.every(entry => /^provider quota exhausted on env-a mid-session \(You're out of usage credits\. Run \/usage-credits to keep using Fable 5\.1 or \/model to switch models\.; reset time unknown\); launched again on another account$/.test(entry)), reviewEnds.join('\n'));
  assert.ok(!Object.values(state.actions).some(action => /never started|\bstall\b/.test(action.detail)), 'the screen is never read as a never-started or stalled session');
  // Every hold is the bounded unknown-reset hour, and nothing launches on env-a under one.
  assert.ok(readings.length > 0);
  for (const reading of readings) {
    const bound = Date.parse(reading.until) - Date.parse(reading.since);
    assert.ok(bound >= unknownResetHoldMs && bound < unknownResetHoldMs + minute, `the hold is the bounded hour, not ${bound}ms`);
    assert.match(reading.held, /You're out of usage credits/);
  }
  const heldAt = (instant: number) => readings.some(reading => Date.parse(reading.since) < instant && instant < Date.parse(reading.until));
  assert.deepEqual(launches.filter(entry => entry.account === 'env-a' && heldAt(entry.at)).map(entry => `${entry.role} ${entry.subject} +${(entry.at - soakStart) / minute}m`), [], 'no launch lands on env-a while it is held');
  // Holds lapse and are placed again while the credits stay spent: bounded, never stacked.
  const distinct = [...new Set(readings.map(reading => reading.since))];
  assert.ok(distinct.length >= 6, `env-a was held again after each lapse: ${distinct.join(', ')}`);
  assert.ok(readings.every(reading => reading.at < spentUntil + hour), 'no hold stands an hour past the credits\' return');
  assert.deepEqual(await observedExhaustions(config, now), {}, 'no hold stands at the end');
  // The credits return: env-a takes launches again and keeps them.
  const healthy = launches.filter(entry => entry.account === 'env-a' && entry.at >= spentUntil);
  assert.ok(healthy.some(entry => entry.role === 'reviewer') && healthy.some(entry => entry.role === 'approver'), 'env-a takes reviewer and approver launches once its credits return');
  assert.ok(healthy.every(entry => entry.ended === 'work'), 'and they do their work');
  // Every request and decision was judged exactly once, and none is still waiting.
  const judged = launches.filter(entry => entry.ended === 'work');
  assert.equal(judged.filter(entry => entry.role === 'reviewer').length, requests, 'every review request was judged once');
  assert.equal(new Set(judged.filter(entry => entry.role === 'reviewer').map(entry => entry.subject)).size, requests);
  assert.equal(decisions.length, filings, 'each filed item\'s close decision was requested once');
  assert.deepEqual(decisions.filter(entry => entry.state !== 'applied').map(entry => entry.id), [], 'every decision was applied');
  assert.equal(judged.filter(entry => entry.role === 'approver').length, filings, 'by one approver each');
  const exhaustions = items.flatMap(work => work.capacity?.exhaustions ?? []);
  assert.equal(exhaustions.length, stopped.length, 'each screen is one exhaustion on its item');
  assert.ok(exhaustions.every(entry => entry.account === 'env-a' && entry.resetsAt === null && entry.partialWork.state === 'not-applicable'));
});
