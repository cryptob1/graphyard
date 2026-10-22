import { after, before, test } from 'node:test';
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
  doctorLimitRetryAt, doctorLimitUntilMarker, headlessTimeoutLimit,
} from '../src/model/capacity.js';
import {
  approverRoleHealth, approverSessionName, holdRepeatedLimitAccount, masterConfigSchema, observedExhaustions, recordObservedExhaustion,
  repeatedLimitAccount, selectAccount, selectApproverAccount, type MasterConfig,
} from '../src/master.js';
import { clearDoctorRuns, doctorDue, doctorRunsSettled, type DoctorEffects } from '../src/daemon/doctor.js';
import { doctorSettingsSchema } from '../src/master/doctor-settings.js';
import type { Principal, Work } from '../src/model.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import type { RunEvent, RunResult, Runner } from '../src/runner/types.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1705 soak: over a simulated hour of the real loop, a pane that ends silent (`done`, never
 * working, no notice) holds its launch account once and fails the decision over onto another
 * account; a doctor all-timeout round with one readable limit waits out the hold so no second
 * no-report spends the same account; no duplicate open approver sessions linger; and every system
 * invariant holds after every cycle. Instants are relative to a fixed soak epoch. (The diagnostician
 * this soak also watched is retired by GY-2186; its limit-wait replay lives in git history.)
 */

const repository = 'owner/silent-soak';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `soak-silent-${principal.id}-${'x'.repeat(24)}` }));
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

before(async () => {
  const port = Number(process.env.GRAPHYARD_SILENT_SOAK_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 77);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('silent-soak-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('silent_soak');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/silent_soak`); await store.init();
  engine = new Engine(store, 300, repository); engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await temporaryDirectory('silent-soak-home');
  await mkdir(join(home, 'env-a'), { recursive: true }); await mkdir(join(home, 'env-b'), { recursive: true });
  await writeFile(join(home, 'env-a/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'not-a-real-token' } }));
  await writeFile(join(home, 'env-b/auth.json'), JSON.stringify({ tokens: { access_token: 'not-a-real-token' } }));
});
after(async () => {
  clearDoctorRuns();
  await new Promise<void>(resolve => http.close(() => resolve()));
  await store.close();
  await database.stop();
});

const minute = 60_000;
/** Fixed soak epoch: 2026-10-11T12:00:00.000Z as a millisecond instant. */
const soakStart = 1_791_720_000_000;
/** Provider limit with no named reset — the assumed one-hour hold, so the soak can pass the probe. */
const limitError = '429: Weekly/Monthly Limit Exhausted';
const timeoutFailure = (): RunResult<never> => ({ ok: false, failure: { reason: 'timeout', detail: 'no terminal event within 1200s; the run was stopped' }, payloads: [] });
function limitedTimeoutRunner(events: RunEvent[]): Runner {
  return { name: 'pi', start() { return { id: randomUUID(), events, onEvent: () => () => {}, cancel() {}, result: async () => timeoutFailure() }; } };
}
function successDiagnosisRunner(payload: unknown): Runner {
  return {
    name: 'pi',
    start<T>(_prompt: string, options: { validate: (payload: unknown) => T; tool?: string }) {
      const parsed = options.validate(payload);
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => ({ ok: true as const, tool: options.tool ?? 'diagnose', payload: parsed, payloads: [parsed] }) };
    },
  };
}

test('unit:soak-invariants-hold — over a simulated hour silent ended failover holds once, the doctor limit-wait prevents a second spend, and every invariant holds', { timeout: 300_000 }, async () => {
  clearDoctorRuns();
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const dir = await temporaryDirectory('silent-soak-run');
  const credentialFile = join(dir, 'coordinator.token');
  await writeFile(credentialFile, token(coordinator), { mode: 0o600 });
  const config = masterConfigSchema.parse({
    version: 1, url, credentialFile, cliPath: join(process.cwd(), 'bin/graphyard.mjs'), repository, baseBranch: 'main',
    githubAppId: 1, hostId: 'silent-soak-host', masterAgentName: 'gy-master', autoMerge: true, mergeMethod: 'merge', workers: [],
    environments: [{ name: 'env-a', kind: 'claude', home: join(home, 'env-a') }, { name: 'env-b', kind: 'codex', home: join(home, 'env-b') }],
    reviewers: [{ name: 'reviewer-a', agentName: 'agent-reviewer-a', kind: 'claude', agentArgs: [], approvals: 'auto', environment: {}, accounts: ['env-a', 'env-b'] }],
    run: { launchStartSeconds: 60, doctor: { enabled: true, intervalMinutes: 10 } },
  }) as MasterConfig;

  type Pane = { name: string; pane_id: string; agent_status: string; decision: string; launchedAt: number };
  const panes = new Map<string, Pane>();
  const decisions: { id: string; action: string; state: string; input: any; approvedBy: string | null; work: string }[] = [];
  const launches: { account: string | null; decision: string; at: number }[] = [];
  const heldAccounts: { account: string; role: string; at: number }[] = [];
  let now = soakStart;
  const clock = () => now;

  const filed = await ok(operator, 'POST', 'work', {
    title: 'silent soak death', 
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }],
    origin: { reviewFollowUps: { parent: 'GY-1', findings: [{ path: 'src/a.ts', text: 'src/a.ts — a finding' }] } },
  }) as Work;
  const silentWork = await ok(coordinator, 'POST', `work/${filed.id}/triage`, { judgement: { outcome: 'close', reason: 'Not worth doing' } }) as Work;

  const at = soakStart - 3 * 3_600_000;
  const coveringWork = {
    id: 'work-GY-99', key: 'GY-99', title: 'Covering scope fix', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), stageEnteredAt: new Date(at).toISOString(),
    ready: false, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [],
    evidence: [], observation: null, blocker: null, gates: [], violations: [],
  } as unknown as Work;

  const retry: RunEvent = { kind: 'retry', at: new Date(soakStart).toISOString(), attempt: 1, error: limitError };
  const doctorSettings = doctorSettingsSchema.parse({ intervalMinutes: 10 }) as DoctorEffects['settings'];
  let doctorPhase: 'limit' | 'ok' = 'limit';
  const doctorReport = { findings: [], actions: [], filed: [] };
  const doctor: DoctorEffects = {
    settings: doctorSettings, cwd: '/tmp', env: {},
    // Live wiring: registry primary names the account; Pi fallback always returns account: null.
    // Both timeout with a readable limit — the named primary must stay held (AC-2/AC-3).
    runner: async attempt => ({
      runtime: 'pi', model: attempt, account: attempt === 'primary' ? 'zai-doctor' : null, release: async () => {},
      runner: doctorPhase === 'limit'
        ? limitedTimeoutRunner([retry])
        : { name: 'pi', start<T>(_p: string, options: { validate: (payload: unknown) => T; tool?: string }) {
            const parsed = options.validate(doctorReport);
            return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => ({ ok: true as const, tool: options.tool ?? 'doctor', payload: parsed, payloads: [parsed] }) };
          } },
    }),
    file: async () => { throw new Error('nothing filed'); },
    recordRun: async () => {},
  };
  const loginsOnly = { quota: false, now: clock, cacheMs: 0 };
  const effects = {
    agents: () => [...panes.values()].map(({ name, pane_id, agent_status }) => ({ name, pane_id, agent_status })),
    herdr: () => ({ agents: [...panes.values()].map(({ name, pane_id, agent_status }) => ({ name, pane_id, agent_status })), available: true }),
    sessionOutput: () => '',
    idleScreenPauseMs: 0,
    closeSession: (pane: string) => { for (const [id, entry] of panes) if (entry.pane_id === pane) panes.delete(id); },
    holdAccount: async (account: string, observed: Parameters<typeof recordObservedExhaustion>[2]) => {
      heldAccounts.push({ account, role: observed.role, at: now });
      await recordObservedExhaustion(config, account, observed, now);
    },
    reportCapacity: (work: Work, event: unknown) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    decide: async (work: Work, action: string, _reason: string, input: unknown) => {
      const entry = { id: `decision-soak-${decisions.length + 1}`, action, state: 'requested', input: input ?? {}, approvedBy: null, work: work.key };
      decisions.push(entry);
      return entry;
    },
    decisions: async (work: Work) => ({ decisions: decisions.filter(entry => entry.work === work.key) }),
    approver: async (work: Work, decision: string) => {
      const chosen = await selectApproverAccount(config, work.key, 'approver-agent', { ...loginsOnly, registry: undefined });
      const agentName = approverSessionName(work, decision), pane = `pane-${launches.length}`;
      panes.set(pane, { name: agentName, pane_id: pane, agent_status: 'idle', decision, launchedAt: now });
      launches.push({ account: chosen.account?.name ?? null, decision, at: now });
      return { agentName, pane, account: chosen.account?.name ?? null, runtime: chosen.account?.kind ?? null, session: `registry-${launches.length}` };
    },
    roleHealth: async () => ({ approver: await approverRoleHealth(config, loginsOnly) }),
    snapshot: async () => {
      const snapshot = await ok(coordinator, 'GET', 'work-snapshot');
      const live = snapshot.work as Work[];
      const extras = [coveringWork].filter(extra => !live.some(entry => entry.key === extra.key));
      return { work: [...live, ...extras], now: new Date(now).toISOString() };
    },
    endRegistrySession: async () => {},
    persist: async () => {},
    credentials: async () => ({}),
    dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now).toISOString(), reason: 'none', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    doctor,
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config);
  const violations: string[] = [];
  let silentEnded = false;
  let busyTicks = 0;
  let screenReads = 0;
  // A watched idle approver whose screen keeps moving — hand-watched on the covering item that
  // stays open — so the shared idle-read branch runs every cycle past the start bound without
  // exhausting its account or competing for the silent-death failover (and without closing when
  // the silent item's triage decision applies).
  const busyDecision = 'busy-decision-soak';
  const busyName = approverSessionName(coveringWork, busyDecision);
  decisions.push({ id: busyDecision, action: 'close', state: 'requested', input: {}, approvedBy: null, work: coveringWork.key });
  panes.set('pane-busy', { name: busyName, pane_id: 'pane-busy', agent_status: 'idle', decision: busyDecision, launchedAt: now - 90_000 });
  effects.sessionOutput = (agent: { name?: string | null }) => {
    screenReads++;
    if (agent.name === busyName) return `${busyDecision}\n⏺ Bash(npm test)\n  ⎿ running ${++busyTicks}`;
    // Any other live pane that is not the silent-death target shows its decision, so an idle
    // approver pane is never mistaken for a second silent spend.
    const pane = [...panes.values()].find(entry => entry.name === agent.name);
    if (pane && pane.agent_status === 'idle') return `${pane.decision}\nworking`;
    return '';
  };

  for (let cycle = 0; cycle < 70; cycle++, now += minute) {
    // Keep the busy hand-watch registered and past its start bound but under the judge bound.
    if (!decisions.some(entry => entry.id === busyDecision)) {
      decisions.push({ id: busyDecision, action: 'close', state: 'requested', input: {}, approvedBy: null, work: coveringWork.key });
    }
    state.approvals[`hand:${busyDecision}`] = {
      work: coveringWork.key, action: 'close', decision: busyDecision, requestedAt: new Date(soakStart).toISOString(),
      agentName: busyName, pane: 'pane-busy', launchedAt: new Date(now - 90_000).toISOString(), launches: 1,
      account: 'env-b', runtime: 'codex', session: 'registry-busy', settledAt: null, exhaustedAt: null, ended: [],
      requests: 0, lostRuns: 0, closeAttempts: 0, capacity: null, run: null, reportedExhaustion: null, heldExhaustion: null,
    } as any;
    if (!panes.has('pane-busy')) panes.set('pane-busy', { name: busyName, pane_id: 'pane-busy', agent_status: 'idle', decision: busyDecision, launchedAt: now - 90_000 });
    else { const busy = panes.get('pane-busy')!; busy.agent_status = 'idle'; busy.launchedAt = now - 90_000; }

    if (!silentEnded) {
      for (const pane of panes.values()) {
        if (pane.name !== busyName && now - pane.launchedAt >= 61_000) {
          pane.agent_status = 'done';
          silentEnded = true;
        }
      }
    }
    // After failover lands on env-b, let that replacement apply so the decision settles.
    const replacement = [...panes.values()].find(entry => entry.name !== busyName && entry.agent_status === 'idle' && launches.find(launch => launch.decision === entry.decision)?.account === 'env-b');
    if (replacement && now - replacement.launchedAt >= 5 * minute) {
      const entry = decisions.find(entry => entry.id === replacement.decision);
      if (entry) entry.state = 'applied';
      replacement.agent_status = 'done';
    }
    // After the assumed-hour hold, the next doctor round succeeds instead of re-spending.
    if (doctorPhase === 'limit' && state.doctor.runs.some(run => run.detail.includes(doctorLimitUntilMarker)) && !doctorLimitRetryAt(state.doctor.runs, now)) {
      doctorPhase = 'ok';
    }

    await runCycle(config, state, effects, clock);
    await doctorRunsSettled();
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`+${(now - soakStart) / minute}m ${check.line}`);
    const names = [...panes.values()].map(entry => entry.name);
    assert.equal(new Set(names).size, names.length, `cycle ${cycle}: duplicate open approver names ${names.join(',')}`);
    assert.ok(panes.has('pane-busy'), `cycle ${cycle}: the watched long-command idle pane was closed under it`);
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.ok(launches.some(entry => entry.account === 'env-a'), 'env-a was launched');
  assert.ok(launches.some(entry => entry.account === 'env-b'), 'failover landed on env-b');
  const silentHolds = heldAccounts.filter(entry => entry.account === 'env-a' && entry.role === 'approver');
  const earlySilent = silentHolds.filter(entry => entry.at < soakStart + 30 * minute);
  assert.equal(earlySilent.length, 1, `exactly one silent-death hold on env-a in the first half-hour: ${JSON.stringify(heldAccounts)}`);
  assert.ok(earlySilent[0]!.at <= soakStart + 3 * minute, 'the silent death is the early env-a hold');
  assert.ok((await observedExhaustions(config, soakStart + 30 * minute))['env-a'], 'env-a stays held through the early soak window');
  assert.ok(panes.has('pane-busy'), 'the watched long-command idle pane survives the whole soak');
  assert.ok(screenReads > 10, `watched idle screens were read across cycles (${screenReads})`);
  assert.equal(silentWork.key, silentWork.key); // keep the filed work referenced for the typechecker

  assert.ok(state.doctor.runs.length >= 1, 'the doctor ran');
  assert.ok(heldAccounts.some(entry => entry.account === 'zai-doctor' && entry.role === 'doctor'), `doctor primary held despite null-account fallback: ${JSON.stringify(heldAccounts)}`);
  const limitWaits = state.doctor.runs.filter(run => run.detail.includes(doctorLimitUntilMarker));
  assert.equal(limitWaits.length, 1, 'one limit-wait doctor round, not a second spend');
  const heldUntil = limitWaits[0]!.detail.slice(limitWaits[0]!.detail.indexOf(doctorLimitUntilMarker) + doctorLimitUntilMarker.length).split(/[\s;]/)[0];
  assert.ok(Date.parse(heldUntil) > soakStart + 10 * minute, 'the limit wait covered the ten-minute mark');
  assert.equal(doctorDue({ ...state, doctor: { ...state.doctor, runs: limitWaits } }, soakStart + 10 * minute, doctorSettings), false, 'doctorDue waits out the limit hold');
  // After the wait, the held primary is still observed spent — selection cannot hand it back mid-hold.
  assert.ok((await observedExhaustions(config, soakStart + 10 * minute))['zai-doctor'], 'doctor primary stays held through the wait');

  // Multi-cycle reviewer selection: two spent sessions sharing one request id re-hold before selectAccount.
  const reviewBase = soakStart + 55 * minute;
  const reviewExhaustion = (offsetMs: number) => ({
    at: new Date(reviewBase + offsetMs).toISOString(), role: 'reviewer' as const, account: 'env-a', profile: 'reviewer-a', reason: 'quota', resetsAt: null,
    requestId: 'review-request-shared', recordedBy: 'loop', owner: null, runtime: 'claude',
    partialWork: { state: 'not-applicable' as const, detail: 'a reviewer session edits nothing' },
  });
  const reviewItem = {
    key: silentWork.key, epoch: 2,
    capacity: { escalations: [], exhaustions: [reviewExhaustion(0), reviewExhaustion(5 * minute)] },
  };
  assert.equal(repeatedLimitAccount(reviewItem, reviewBase + 5 * minute, 'reviewer')?.account, 'env-a');
  // Assumed hold has lapsed; the next selection must re-hold before choosing.
  const afterLapse = reviewBase + 5 * minute + 3_600_000 + 1;
  assert.equal((await observedExhaustions(config, afterLapse))['env-a'], undefined, 'the earlier silent-death hold has lapsed');
  const reheld = await holdRepeatedLimitAccount(config, reviewItem, afterLapse, {}, 'reviewer');
  assert.equal(reheld?.account, 'env-a');
  const reviewProfile = { ...config.reviewers[0]!, accounts: ['env-a'] };
  await assert.rejects(
    selectAccount(config, 'reviewer', reviewProfile, { quota: false, cacheMs: 0, now: () => afterLapse, work: reviewItem.key }),
    /exhausted|no healthy|spent|quota|NoHealthy/i,
    'post-lapse reviewer selectAccount refuses the repeatedly spent account',
  );

  const round = headlessTimeoutLimit([
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [retry] },
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [] },
  ], soakStart);
  assert.ok(round);
});
