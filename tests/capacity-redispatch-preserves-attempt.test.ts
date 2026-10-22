import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, failoverKey, runCycle, type DaemonEffects, type DaemonState, type LaunchedSession } from '../src/master-daemon.js';
import {
  approverRoleHealth, approverSessionName, masterConfigSchema, observedExhaustions, preservePartialWork,
  readEnvironmentLog, recordObservedExhaustion, selectAccount, selectApproverAccount, workerPrompt,
  type MasterConfig,
} from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1708 AC-1: mid-attempt limit exhaustion records the spend, fails over without re-selecting the
// held account, and keeps the in-flight attempt's work and any recorded judgement through redispatch.

const repository = 'owner/capacity-redispatch';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, workerA, coordinator].map(principal => ({ ...principal, token: `redispatch-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, home: string;

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(principal, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 178;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('capacity-redispatch-db'),
    user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('capacity_redispatch');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/capacity_redispatch`);
  await store.init();
  engine = new Engine(store, 300, repository);
  engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await temporaryDirectory('capacity-redispatch');
  await mkdir(join(home, 'env-a'), { recursive: true });
  await mkdir(join(home, 'env-b'), { recursive: true });
  await writeFile(join(home, 'env-a/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  await writeFile(join(home, 'env-b/auth.json'), JSON.stringify({ tokens: { access_token: 'x' } }));
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

const profileOf = (name: string, principal: Principal, accounts?: string[]) => ({
  name, principal: principal.id, agentName: `agent-${name}`, mode: 'launch' as const, kind: 'claude' as const,
  credentialFile: join(home, `${name}.token`), ...(accounts ? { accounts } : {}),
});
const loopConfig = (workers: ReturnType<typeof profileOf>[], extra: Record<string, unknown> = {}) => masterConfigSchema.parse({
  version: 1, url, credentialFile: join(home, 'coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-redispatch', workers,
  environments: [{ name: 'env-a', kind: 'claude', home: join(home, 'env-a') }, { name: 'env-b', kind: 'codex', home: join(home, 'env-b') }],
  ...extra,
}) as MasterConfig;
const loginsOnly = (now: () => number) => ({ quota: false, now, cacheMs: 0 });

interface Herdr { agents: { name: string; pane_id: string; agent_status: string }[]; output: Record<string, string> }

test('integration:capacity-redispatch-preserves-attempt — worker WIP and an approver decision survive mid-attempt exhaustion redispatch without re-selecting the held account', async () => {
  const capacity = await import('../src/model/capacity.js') as {
    redispatchPreservesAttempt?: (work: Work, spentEpoch: number) => { ok: boolean; detail: string };
  };
  assert.equal(typeof capacity.redispatchPreservesAttempt, 'function', 'GY-1708 exports redispatchPreservesAttempt');
  const redispatchPreservesAttempt = capacity.redispatchPreservesAttempt!;

  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const config = loopConfig([profileOf('builder', workerA, ['env-a', 'env-b'])]);
  const herdr: Herdr = { agents: [], output: {} }, clock = { skewMs: 0 };
  const worktree = await temporaryDirectory('capacity-redispatch-wt');
  git(worktree, 'init', '-q', '-b', 'graphyard/attempt');
  await writeFile(join(worktree, 'README.md'), 'base\n');
  git(worktree, 'add', '-A');
  git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const settlementToken = 'c'.repeat(64);
  const calls = { dispatch: [] as { work: string; account: string | null }[], closed: [] as string[] };
  const now = () => Date.now() + clock.skewMs;
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: async () => ({ builder: { available: true, reason: null } }),
    snapshot: async () => {
      const snapshot = await ok(coordinator, 'GET', 'work-snapshot');
      return { work: snapshot.work as Work[], now: new Date(Date.parse(snapshot.now) + clock.skewMs).toISOString() };
    },
    closeSession: pane => { calls.closed.push(pane); herdr.agents = herdr.agents.filter(agent => agent.pane_id !== pane); },
    dispatch: async (work, profile) => {
      const selected = await selectAccount(config, 'worker', profile, { ...loginsOnly(now), work: work.key });
      const claimed = await ok(workerA, 'POST', `work/${work.id}/claim`, {}) as Work;
      const path = calls.dispatch.length ? `${worktree}-next` : worktree;
      await ok(workerA, 'POST', `work/${work.id}/workspace`, {
        epoch: claimed.epoch, host: 'loop-host', path, branch: `graphyard/${claimed.key.toLowerCase()}-${claimed.epoch}`,
      });
      await ok(workerA, 'POST', `work/${work.id}/quarantine`, {
        epoch: claimed.epoch,
        settlementHash: createHash('sha256').update(settlementToken).digest('hex'),
        scope: { unit: `graphyard-watch-4242-${randomUUID()}.scope`, pid: 4242 },
      });
      herdr.agents.push({ name: profile.agentName, pane_id: `pane-${calls.dispatch.length}`, agent_status: 'working' });
      calls.dispatch.push({ work: work.key, account: selected.account?.name ?? null });
    },
    stopSupervisor: async orphan => {
      herdr.agents = herdr.agents.filter(agent => agent.name !== orphan.agentName);
      await ok(workerA, 'POST', `work/${orphan.id}/settle`, { epoch: orphan.epoch, settlementToken });
    },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'n/a', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    persist: async () => {},
    sessionOutput: agent => herdr.output[agent.name!] ?? '',
    reportCapacity: (work, event) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    selectedAccount: async (role, profile) => readEnvironmentLog(config).then(log => log.selected[`${role}:${profile}`] ?? null),
    holdAccount: (account, observed) => recordObservedExhaustion(config, account, observed, now()),
    preserveWork: async (work, epoch) => preservePartialWork(
      work.workspaces.find(entry => entry.epoch === epoch)!.path,
      `${work.key} attempt ${epoch} interrupted by provider quota exhaustion`,
    ),
  };
  const cycle = (state: DaemonState) => runCycle(config, state, effects, now);
  const state = emptyDaemonState(config);

  const filed = await ok(operator, 'POST', 'work', {
    title: 'redispatch preserves', 
    criteria: [{ id: 'AC-1', text: 'redispatch', proofs: ['integration:capacity-redispatch-preserves-attempt'] }],
  }) as Work;
  let work = await ok(operator, 'POST', `work/${filed.id}/ready`, {}) as Work;

  await cycle(state);
  assert.deepEqual(calls.dispatch, [{ work: work.key, account: 'env-a' }]);
  work = await reload(work.id);
  assert.equal(work.epoch, 1);

  await writeFile(join(worktree, 'README.md'), 'base\nhalf-finished\n');
  await writeFile(join(worktree, 'feature.ts'), 'export const half = true;\n');
  const resetsAt = new Date(Date.now() + 6 * 24 * 3_600_000).toISOString();
  herdr.output['agent-builder'] = `● Update(feature.ts)\n  ⎿ You've hit your weekly limit · resets ${resetsAt}\n`;
  herdr.agents[0].agent_status = 'idle';
  clock.skewMs += 20_000;
  await cycle(state);
  const failover = state.actions[failoverKey('worker', work, 1)];
  assert.equal(failover.state, 'done', failover.detail);
  work = await reload(work.id);
  const preserved = redispatchPreservesAttempt(work, 1);
  assert.equal(preserved.ok, true, preserved.detail);
  assert.ok(preserved.detail.includes('work kept at'));
  const kept = work.capacity!.exhaustions[0].partialWork.commit!;
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  assert.match(git(worktree, 'log', '-1', '--format=%s'), new RegExp(`^WIP: ${work.key} attempt 1 interrupted`));
  assert.deepEqual(Object.keys(await observedExhaustions(config)), ['env-a']);

  clock.skewMs += 20_000;
  await cycle(state);
  assert.deepEqual(calls.dispatch[1], { work: work.key, account: 'env-b' }, 'redispatch takes the next account, never the held one');
  work = await reload(work.id);
  assert.equal(work.epoch, 2);
  assert.match(workerPrompt(config, work, config.workers[0], 2), new RegExp(`its work is kept as commit ${kept}`));

  // Approver: the same decision is relaunched on another account; the judgement request is not re-created.
  const decisions: { id: string; action: string; state: string; input: any; approvedBy: string | null }[] = [];
  const launches: (string | null)[] = [];
  const reviewerOn = (accounts: string[]) => ({
    name: 'reviewer-a', agentName: 'agent-reviewer-a', kind: 'claude' as const, agentArgs: [], approvals: 'auto' as const, environment: {}, accounts,
  });
  const holdHome = await temporaryDirectory('approver-redispatch-home');
  const approverConfig = {
    ...loopConfig([profileOf('builder', workerA)], { credentialFile: join(holdHome, 'coordinator.token') }),
    reviewers: [reviewerOn(['env-a', 'env-b'])],
  } as MasterConfig;
  const approverHerdr: Herdr = { agents: [], output: {} };
  const holdApprover = (account: string, observed: Parameters<typeof recordObservedExhaustion>[2]) =>
    recordObservedExhaustion(approverConfig, account, observed, now());
  const approverEffects: DaemonEffects = {
    ...effects,
    agents: () => approverHerdr.agents,
    herdr: () => ({ agents: approverHerdr.agents, available: true }),
    sessionOutput: agent => approverHerdr.output[agent.name!] ?? '',
    closeSession: pane => { approverHerdr.agents = approverHerdr.agents.filter(agent => agent.pane_id !== pane); },
    dispatch: async () => {},
    holdAccount: holdApprover,
    decide: async (_work, action, _reason, input) => {
      const entry = { id: 'decision-redispatch-1', action, state: 'requested', input: input ?? {}, approvedBy: null };
      decisions.push(entry);
      return entry;
    },
    decisions: async () => ({ decisions }),
    approver: async (item, decision) => {
      const chosen = await selectApproverAccount(approverConfig, item.key, 'approver-agent', { ...loginsOnly(now), registry: undefined });
      const agentName = approverSessionName(item, decision), pane = `pane-approver-${launches.length}`;
      approverHerdr.agents.push({ name: agentName, pane_id: pane, agent_status: 'working' });
      launches.push(chosen.account?.name ?? null);
      return { agentName, pane, account: chosen.account?.name ?? null, runtime: chosen.account?.kind ?? null, session: `registry-${launches.length}` };
    },
    roleHealth: async () => ({ approver: await approverRoleHealth(approverConfig, loginsOnly(now)) }),
    endRegistrySession: async () => {},
  };
  const filedClose = await ok(operator, 'POST', 'work', {
    title: 'approver redispatch', 
    criteria: [{ id: 'AC-1', text: 'close', proofs: ['integration:capacity-redispatch-preserves-attempt'] }],
    origin: { reviewFollowUps: { parent: 'GY-1', findings: [{ path: 'src/a.ts', text: 'src/a.ts — a finding' }] } },
  }) as Work;
  const proposed = await ok(coordinator, 'POST', `work/${filedClose.id}/triage`, {
    judgement: { outcome: 'close', reason: 'Not worth doing once the parent shipped' },
  }) as Work;
  assert.equal(proposed.triage?.state, 'proposed');
  const approverState = emptyDaemonState(approverConfig);
  await runCycle(approverConfig, approverState, approverEffects, now);
  assert.equal(decisions.length, 1, 'one close decision is requested');
  assert.deepEqual(launches, ['env-a']);
  const decisionId = decisions[0].id;
  const launchedAt = Object.values(approverState.approvals)[0].launchedAt;
  const name = approverSessionName(proposed, decisionId);
  approverHerdr.agents.find(agent => agent.name === name)!.agent_status = 'idle';
  approverHerdr.output[name] = `● Reading the decision…\n  ⎿ You've hit your weekly limit · resets ${resetsAt}\n`;
  await runCycle(approverConfig, approverState, approverEffects, now);
  assert.equal(decisions.length, 1, 'the decision is not requested again — the judgement request survives');
  assert.deepEqual(launches, ['env-a', 'env-b'], 'approver fails over to the next account');
  assert.equal(Object.values(approverState.approvals)[0].decision, decisionId);
  assert.equal(approverState.actions[failoverKey('approver', proposed, `${decisionId}:${launchedAt}`)].state, 'done');

  // Reviewer session: request id and relaunch preserve the in-flight proof/review request.
  const session: LaunchedSession = {
    role: 'reviewer', record: randomUUID(), profile: 'reviewer', agentName: 'agent-reviewer',
    pane: 'pane-reviewer', work: work.key, requestId: 'review-request-1',
  };
  const ended: string[] = [], relaunched: string[] = [];
  herdr.agents.push({ name: 'agent-reviewer', pane_id: 'pane-reviewer', agent_status: 'blocked' });
  herdr.output['agent-reviewer'] = `Error: Weekly usage limit reached.\nYour quota will reset at ${resetsAt.slice(0, 19).replace('T', ' ')} UTC`;
  const reviewerEffects: DaemonEffects = {
    ...effects,
    dispatch: async () => {},
    launchedSessions: async () => [session],
    endSession: async (_entry, resolution) => { ended.push(resolution); herdr.agents = herdr.agents.filter(agent => agent.name !== 'agent-reviewer'); },
    relaunch: async entry => { relaunched.push(entry.requestId!); return { profile: 'reviewer-b' }; },
  };
  await runCycle(config, state, reviewerEffects, now);
  const reviewerFailover = state.actions[failoverKey('reviewer', work, session.record)];
  assert.equal(reviewerFailover.state, 'done', reviewerFailover.detail);
  assert.deepEqual(relaunched, ['review-request-1'], 'the same review request is relaunched');
  assert.match(ended[0], /provider quota exhausted/);
});
