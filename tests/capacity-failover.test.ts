import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { processJob, type GitHub } from '../src/github.js';
import { queueRef, type QueuePlacement, type QueueSpeculation } from '../src/merge-queue.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { answerHumanCommand, humanRequestsCommand, parkCommand } from '../src/cli/session-commands.js';
import type { CliContext } from '../src/cli/context.js';
import { actionableSubjects, approvalWatchSchema, capacityKey, carriedSession, emptyDaemonState, failoverKey, handlerSettleMs, launchAppearanceMs, runCycle, type DaemonEffects, type DaemonState, type LaunchedSession } from '../src/master-daemon.js';
import { capacityRecheckMs, emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { approverRoleHealth, approverSessionName, buildMasterStatus, escalationProfile, escalationRoleHealth, readApproverLaunch, readEscalationSessions, saveApproverLaunch, saveEscalationSession, type EscalationSession, heldAwareProbe, inspectProfileAccounts, masterConfigSchema, observedExhaustions, preservePartialWork, profileAccount, recordObservedExhaustion, selectAccount, selectApproverAccount, readEnvironmentLog, workerPrompt, type MasterConfig } from '../src/master.js';
import { selectFleetSession, type FleetClient } from '../src/fleet.js';
import { describeCapacity, detectExhaustion, parseResetTime } from '../src/model/capacity.js';
import { answerCommand, humanRequestBlocker, openHumanRequests } from '../src/model/human-request.js';
import type { Observation, Principal, Work } from '../src/model.js';
import HumanRequestsPage from '../web/pages/human-requests.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-89: mid-session exhaustion and human-only waits must not stall an item or a fleet. A
// session that runs out of provider quota is detected from its own output and its action moves
// to another account; a role with no account left is one capacity escalation and one status
// line, not a stream of launch failures; a decision only a human may make is typed state that
// parks the item without a lease; and the human's answer resumes it with no master session.
// Everything below runs against a real Postgres, the real HTTP routes, the real account
// selection and a real Git worktree. Each test is named for the proof it produces.
const repository = 'owner/capacity-failover';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const aiAdmin: Principal = { id: 'ai-admin', role: 'admin', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const workerB: Principal = { id: 'worker-b', role: 'worker', sessionKind: 'ai' };
// The loop's entire authority: one coordinator token. Nothing here holds an operator-agent
// credential, so nothing the loop does could have come from a master session.
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:wait'] };
const credentials = [operator, aiAdmin, workerA, workerB, coordinator, producer].map(principal => ({ ...principal, token: `capacity-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, home: string;
let pullRequest = 900;

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
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows as { actor: string; kind: string; payload: any }[];
const sha40 = (seed: string) => createHash('sha1').update(seed).digest('hex');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** The CLI as a person or a worker runs it: a command object and the credential it speaks with. */
const cli = (principal: Principal, args: string[]) => {
  const printed: any[] = [];
  const context = { args, print: (value: unknown) => { printed.push(value); }, api: (path: string, data?: unknown) => ok(principal, data === undefined ? 'GET' : 'POST', path, data) } as unknown as CliContext;
  return { context, printed };
};

const definition = (title: string, extra: Record<string, unknown> = {}) => ({ title, plannedFiles: [`src/${title.replace(/\W+/g, '-')}.ts`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }], ...extra });
async function released(title: string, extra: Record<string, unknown> = {}) {
  const work = await ok(operator, 'POST', 'work', definition(title, extra)) as Work;
  return ok(operator, 'POST', `work/${work.id}/ready`, {}) as Promise<Work>;
}
/** What the worker launcher does at dispatch: claim under the worker's own identity and register the worktree. */
async function launcherClaims(work: Work, worker: Principal, path = `/tmp/capacity/${work.id}/${randomUUID()}`) {
  const claimed = await ok(worker, 'POST', `work/${work.id}/claim`, {}) as Work;
  return ok(worker, 'POST', `work/${work.id}/workspace`, { epoch: claimed.epoch, host: 'loop-host', path, branch: `graphyard/${claimed.key.toLowerCase()}-${claimed.epoch}` }) as Promise<Work>;
}
function seen(work: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40(`tree:${candidate.baseSha}`), baseTipContained: true,
    files: work.plannedFiles, scopeFiles: [], at: new Date().toISOString(), ...extra };
}
/** The worker submits; the provider observes an approved head; the trusted producer proves it. */
async function submittedAndProven(work: Work, worker: Principal, extra: Partial<Observation> = {}) {
  const candidate = { sha: sha40(`head:${work.id}:${work.epoch}`), baseSha: sha40('base') };
  let current = await ok(worker, 'POST', `work/${work.id}/submit`, { epoch: work.epoch, pr: ++pullRequest }) as Work;
  current = await engine.observe(current.id, current.revision, seen(current, candidate, extra));
  await ok(producer, 'POST', `work/${work.id}/evidence`, { proof: 'unit:wait', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: current.policyRevision, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } });
  // A head observed without a review is proven and left there: its review request follows the proof (GY-115).
  if (extra.reviews) return { work: await reload(work.id), candidate };
  // The control plane's own reconciliation job: it observes the head again and publishes the merge
  // queue's tip for it, which for a head that already contains its predicted base is the head itself.
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
  await processJob(engine, { observe: async (item: Work) => seen(item, candidate), publish: async () => {},
    publishSpeculativeTip: async (item: Work, placement: QueuePlacement): Promise<QueueSpeculation> => ({ ref: queueRef(item.key), tip: item.candidate!.sha, base: placement.predictedBase!, baseTree: sha40(`tree:${placement.predictedBase!}`),
      predecessors: placement.predecessors, policyRevision: item.policyRevision, publishedAt: new Date().toISOString(), merge: null }) } as unknown as GitHub);
  return { work: await reload(work.id), candidate };
}
/** The loop's guarded merge, as the broker performs it with the coordinator credential alone. */
async function guardedMerge(work: Work) {
  const current = await reload(work.id), candidate = { sha: current.candidate!.sha, baseSha: current.candidate!.baseSha };
  const granted = await engine.acquireMerge(coordinator, current.id, { expectedRevision: current.revision, ...candidate, policyRevision: current.policyRevision }, randomUUID());
  await engine.verifyMerge(coordinator, current.id, { executionId: granted.execution.id }, seen(current, candidate), randomUUID());
  const committed = await engine.commitMerge(coordinator, current.id, { executionId: granted.execution.id }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  await engine.observe(current.id, committed.revision, seen(current, candidate, { merged: true, mergeSha: sha40(`merge:${work.id}`), mergedAt }));
  return { result: 'merged' };
}

// Two agent accounts on two runtimes, both logged in. Neither exposes quota to this test (the
// probe reads logins only), which is exactly the case mid-session detection exists for.
const profileOf = (name: string, principal: Principal, accounts?: string[]) => ({ name, principal: principal.id, agentName: `agent-${name}`, mode: 'launch' as const, kind: 'claude' as const, credentialFile: join(home, `${name}.token`), ...(accounts ? { accounts } : {}) });
const loopConfig = (workers: ReturnType<typeof profileOf>[], extra: Record<string, unknown> = {}) => masterConfigSchema.parse({ version: 1, url, credentialFile: join(home, 'coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-capacity', workers,
  environments: [{ name: 'env-a', kind: 'claude', home: join(home, 'env-a') }, { name: 'env-b', kind: 'codex', home: join(home, 'env-b') }], ...extra }) as MasterConfig;
const loginsOnly = (now: () => number) => ({ quota: false, now, cacheMs: 0 });
const workerHealth = (config: MasterConfig, now: () => number) => inspectProfileAccounts(config, 'worker', config.workers, Object.fromEntries(config.workers.map(profile => [profile.name, { available: true, reason: null as string | null }])), loginsOnly(now));

interface Herdr { agents: { name: string; pane_id: string; agent_status: string }[]; output: Record<string, string> }
/**
 * The loop as `master run` wires it, with Herdr replaced by an inventory the test controls and
 * the launcher by its two control-plane calls. Everything that decides — the snapshot, the
 * capacity record, the account hold, account selection, partial-work preservation — is real.
 */
function loop(config: MasterConfig, herdr: Herdr, clock: { skewMs: number }, overrides: Partial<DaemonEffects> = {}) {
  const now = () => Date.now() + clock.skewMs;
  const calls = { dispatch: [] as { work: string; profile: string; account: string | null }[], merge: [] as string[], stopped: [] as string[], closed: [] as string[] };
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: () => workerHealth(config, now),
    snapshot: async () => { const snapshot = await ok(coordinator, 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: new Date(Date.parse(snapshot.now) + clock.skewMs).toISOString() }; },
    closeSession: pane => { calls.closed.push(pane); herdr.agents = herdr.agents.filter(agent => agent.pane_id !== pane); },
    dispatch: async (work, profile) => {
      // The real selection: the first of the profile's accounts that is logged in and not held.
      const selected = await selectAccount(config, 'worker', profile, { ...loginsOnly(now), work: work.key });
      const worker = [workerA, workerB].find(principal => principal.id === profile.principal)!;
      await launcherClaims(work, worker);
      herdr.agents.push({ name: profile.agentName, pane_id: `pane-${profile.name}-${calls.dispatch.length}`, agent_status: 'working' });
      calls.dispatch.push({ work: work.key, profile: profile.name, account: selected.account?.name ?? null });
    },
    requestProof: () => {},
    merge: async work => { calls.merge.push(work.key); return guardedMerge(work); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    sessionOutput: agent => herdr.output[agent.name!] ?? '',
    reportCapacity: (work, event) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    selectedAccount: async (role, profile) => readEnvironmentLog(config).then(log => log.selected[`${role}:${profile}`] ?? null),
    holdAccount: (account, observed) => recordObservedExhaustion(config, account, observed, now()),
    preserveWork: async (work, epoch) => preservePartialWork(work.workspaces.find(entry => entry.epoch === epoch)!.path, `${work.key} attempt ${epoch} interrupted by provider quota exhaustion`),
    ...overrides,
  };
  return { effects, calls, now, cycle: (state: DaemonState) => runCycle(config, state, effects, now) };
}
/** Each test reads a graph of its own: what an earlier test left open would be dispatched by this one's loop. */
const fresh = () => store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
const kinds = (state: DaemonState, kind: string) => Object.entries(state.actions).filter(([, action]) => action.kind === kind).map(([key, action]) => ({ key, ...action }));

before(async () => {
  const port = Number(process.env.GRAPHYARD_CAPACITY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 44);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-capacity-db-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('capacity_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/capacity_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await mkdtemp(join(tmpdir(), 'graphyard-capacity-'));
  // env-a and env-b are logged in; env-out is a real environment with no credential at all.
  await mkdir(join(home, 'env-a'), { recursive: true }); await mkdir(join(home, 'env-b'), { recursive: true }); await mkdir(join(home, 'env-out'), { recursive: true });
  await writeFile(join(home, 'env-a/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'not-a-real-token' } }));
  await writeFile(join(home, 'env-b/auth.json'), JSON.stringify({ tokens: { access_token: 'not-a-real-token' } }));
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('a provider limit notice is read from the tail of a stopped session, with the reset time it names', () => {
  const now = Date.parse('2026-09-20T10:00:00Z');
  // The three that cost 20–60 minutes each on 2026-09-19/20: Claude's weekly limit, Z.AI's weekly limit on OpenCode, Cursor's spend limit.
  assert.deepEqual(detectExhaustion("● Running the suite…\n  ⎿ You've hit your weekly limit · resets 2026-09-26T07:00:00Z\n", now), { reason: "You've hit your weekly limit · resets 2026-09-26T07:00:00Z", resetsAt: '2026-09-26T07:00:00.000Z' });
  assert.equal(detectExhaustion('Error: Weekly usage limit reached for GLM Coding Plan.\nYour quota will reset at 2026-09-26 08:30:00 UTC', now)!.resetsAt, '2026-09-26T08:30:00.000Z');
  assert.equal(detectExhaustion("You've hit your usage limit. Upgrade to Pro, or try again in 3 days 4 hours 5 minutes.", now)!.resetsAt, new Date(now + (3 * 24 * 60 + 4 * 60 + 5) * 60_000).toISOString());
  assert.equal(detectExhaustion('Claude AI usage limit reached|1790409600', now)!.resetsAt, new Date(1790409600_000).toISOString());
  const cursor = detectExhaustion("You've reached your spend limit for this billing cycle. It resets on 10/8.", now)!;
  assert.equal(new Date(cursor.resetsAt!).getMonth(), 9); assert.equal(new Date(cursor.resetsAt!).getDate(), 8);
  const clock = parseResetTime('limit reached ∙ resets 3pm', now)!;
  assert.ok(Date.parse(clock) > now && Date.parse(clock) - now <= 24 * 3_600_000, 'a wall clock is the next time the host reads it');
  assert.equal(detectExhaustion('Rate limit reached for requests', now)!.resetsAt, null, 'a notice that names no time records an unknown reset rather than a guess');
  // Not a notice: a worker's own prose about limits, a notice the session has long worked past, an ordinary failure.
  // The short prose matters most: an idle worker's last summary line, on exactly the items that
  // touch this code, would otherwise end a live lease and hold its account for an hour.
  for (const summary of [
    'Added a test for the rate limit reached path',
    'I covered the case where the weekly usage limit is reached',
    'Done: the dispatcher now waits when the usage limit is reached.',
    'GY-89: escalate once when every account quota is exhausted',
    'Tests pass; the token limit reached branch is covered.',
  ]) assert.equal(detectExhaustion(`● ${summary}`, now), null, summary);
  assert.equal(detectExhaustion(`I will make sure the loop reads "usage limit reached" notices from a session, ${'and explain at length why that matters '.repeat(8)}`, now), null);
  assert.equal(detectExhaustion(`You've hit your limit · resets 3pm\n${Array.from({ length: 60 }, (_, index) => `edited file ${index}`).join('\n')}`, now), null);
  assert.equal(detectExhaustion('npm ERR! Test failed. See above for more details.', now), null);
});

test('integration:midsession-exhaustion-failover — a session that exhausts its account mid-work is detected from its own output, its partial work is committed, history names the account and the reset time, and the item is re-queued on another account within two minutes', async () => {
  await fresh();
  const config = loopConfig([profileOf('builder', workerA, ['env-a', 'env-b'])]);
  const herdr: Herdr = { agents: [], output: {} }, clock = { skewMs: 0 };
  const worktree = await mkdtemp(join(tmpdir(), 'graphyard-capacity-worktree-'));
  git(worktree, 'init', '-q', '-b', 'graphyard/attempt'); await writeFile(join(worktree, 'README.md'), 'base\n');
  git(worktree, 'add', '-A'); git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const base = git(worktree, 'rev-parse', 'HEAD');
  const stopped: string[] = [];
  const settlementToken = 'c'.repeat(64);
  const { cycle, calls } = loop(config, herdr, clock, {
    dispatch: async (work, profile) => {
      const selected = await selectAccount(config, 'worker', profile, { ...loginsOnly(() => Date.now() + clock.skewMs), work: work.key });
      const claimed = await launcherClaims(work, workerA, calls.dispatch.length ? `${worktree}-next` : worktree);
      // The supervisor records its containment before the agent starts, exactly as `watch` does.
      await ok(workerA, 'POST', `work/${work.id}/quarantine`, { epoch: claimed.epoch, settlementHash: createHash('sha256').update(settlementToken).digest('hex'), scope: { unit: `graphyard-watch-4242-${randomUUID()}.scope`, pid: 4242 } });
      herdr.agents.push({ name: profile.agentName, pane_id: `pane-${calls.dispatch.length}`, agent_status: 'working' });
      calls.dispatch.push({ work: work.key, profile: profile.name, account: selected.account?.name ?? null });
    },
    // SIGTERM through the recorded scope: the supervisor kills the agent, verifies the scope empty and settles its own quarantine.
    stopSupervisor: async orphan => { stopped.push(`${orphan.key}:${orphan.epoch}:${orphan.scope.unit}`); herdr.agents = herdr.agents.filter(agent => agent.name !== orphan.agentName); await ok(workerA, 'POST', `work/${orphan.id}/settle`, { epoch: orphan.epoch, settlementToken }); },
  });
  const state = emptyDaemonState(config);
  let work = await released('exhaustion failover');

  await cycle(state);
  assert.deepEqual(calls.dispatch, [{ work: work.key, profile: 'builder', account: 'env-a' }], 'the first attempt runs on the first account');
  work = await reload(work.id);
  assert.equal(work.lease?.owner, workerA.id); assert.equal(work.epoch, 1);

  // Mid-work: the session has edited a tracked file and written a new one, committed neither, and
  // its runtime prints the provider's notice. While it is still working the notice is only text.
  await writeFile(join(worktree, 'README.md'), 'base\nhalf-finished change\n'); await writeFile(join(worktree, 'feature.ts'), 'export const half = true;\n');
  const resetsAt = new Date(Date.now() + 6 * 24 * 3_600_000).toISOString();
  herdr.output['agent-builder'] = `● Update(feature.ts)\n  ⎿ You've hit your weekly limit · resets ${resetsAt}\n`;
  clock.skewMs += 20_000; await cycle(state);
  assert.equal(kinds(state, 'failover').length, 0, 'a working session is never failed over on what it prints');
  assert.equal((await reload(work.id)).lease?.epoch, 1);

  // The runtime stops on the notice; the next cycle is the detection.
  herdr.agents[0].agent_status = 'idle';
  clock.skewMs += 20_000; const detection = await cycle(state);
  const failover = state.actions[failoverKey('worker', work, 1)];
  assert.equal(failover.state, 'done', failover.detail);
  assert.match(failover.detail, /exhausted env-a mid-session \(You've hit your weekly limit/);
  assert.match(failover.detail, /Partial work committed at [0-9a-f]{12}/);
  assert.match(failover.detail, /re-queued for another account/);
  assert.ok(detection.actions.some(action => action.kind === 'failover' && action.state === 'done'), 'the cycle reports the failover it performed');
  assert.ok(!kinds(state, 'session').length, 'an exhausted session is not reported as a worker waiting on input');
  assert.equal(stopped.length, 1, 'the supervisor is stopped through the containment scope it recorded');

  // Partial work is preserved: committed on the attempt's own branch, the worktree left clean.
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  const kept = git(worktree, 'rev-parse', 'HEAD');
  assert.notEqual(kept, base);
  assert.match(git(worktree, 'log', '-1', '--format=%s'), new RegExp(`^WIP: ${work.key} attempt 1 interrupted by provider quota exhaustion`));
  assert.deepEqual(git(worktree, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['README.md', 'feature.ts']);

  // The record: the exhaustion, the account and the reset time, and an attempt that ended rather than lapsed.
  work = await reload(work.id);
  assert.equal(work.lease, null, 'the attempt ended on the record; nothing waits for a lease nobody renews to lapse');
  assert.equal(work.containmentQuarantine ?? null, null);
  const exhaustion = work.capacity!.exhaustions[0];
  assert.deepEqual({ ...exhaustion, at: null }, { role: 'worker', epoch: 1, profile: 'builder', account: 'env-a', runtime: 'claude', reason: `You've hit your weekly limit · resets ${resetsAt}`, resetsAt, owner: workerA.id, recordedBy: coordinator.id, at: null,
    partialWork: { state: 'committed', commit: kept, branch: 'graphyard/attempt', path: worktree, detail: 'uncommitted changes were committed on the attempt branch, unpushed' } });
  const history = (await events(work)).find(event => event.kind === 'capacity.exhausted')!;
  assert.equal(history.actor, coordinator.id);
  assert.equal(history.payload.details.exhaustion.account, 'env-a');
  assert.equal(history.payload.details.exhaustion.resetsAt, resetsAt);
  assert.equal(history.payload.details.exhaustion.reason, exhaustion.reason);
  assert.equal((work as any).pipeline.attempts[0].end, 'released');
  assert.deepEqual(work.escalations ?? [], [], 'an exhausted account is never a lease-loss incident');
  assert.equal((await call(workerA, 'POST', `work/${work.id}/heartbeat`, { epoch: 1 })).status, 409, 'the ended attempt can renew nothing');
  assert.deepEqual(Object.keys(await observedExhaustions(config)), ['env-a'], 'the spent account is held until it resets');
  assert.equal((await observedExhaustions(config))['env-a'].until, resetsAt);

  // Re-queued on a different account, one cycle later: twenty seconds after detection, not two minutes.
  clock.skewMs += 20_000; await cycle(state);
  assert.deepEqual(calls.dispatch[1], { work: work.key, profile: 'builder', account: 'env-b' }, 'the same action runs again on the next account, on another runtime');
  work = await reload(work.id);
  assert.equal(work.epoch, 2); assert.equal(work.lease?.owner, workerA.id);
  const redispatch = state.actions[`dispatch:${work.id}:1`];
  assert.equal(redispatch.state, 'done');
  const requeuedMs = Date.parse(redispatch.at) - Date.parse(failover.at);
  assert.ok(requeuedMs > 0 && requeuedMs <= 120_000, `re-queued ${requeuedMs}ms after detection`);
  assert.match((await readEnvironmentLog(config)).skipped.at(-1)!.reason, /env-a exhausted its quota mid-session/);
  // The next attempt is told where the interrupted work is.
  assert.match(workerPrompt(config, work, config.workers[0], 2), new RegExp(`its work is kept as commit ${kept} on local branch graphyard/attempt`));

  // A reviewer or producer session holds no lease: the same detection holds its account, records
  // the exhaustion against its request, ends the session and launches the request again at once.
  const session: LaunchedSession = { role: 'producer', record: randomUUID(), profile: 'prover', agentName: 'agent-prover', pane: 'pane-prover', work: work.key, requestId: 'request-1' };
  const ended: string[] = [], relaunched: string[] = [];
  herdr.agents.push({ name: 'agent-prover', pane_id: 'pane-prover', agent_status: 'blocked' });
  herdr.output['agent-prover'] = 'Error: Weekly usage limit reached for GLM Coding Plan.\nYour quota will reset at 2026-09-26 08:30:00 UTC';
  const producerLoop = loop(config, herdr, clock, { dispatch: async () => {}, launchedSessions: async () => [session], endSession: async (entry, resolution) => { ended.push(resolution); herdr.agents = herdr.agents.filter(agent => agent.name !== entry.agentName); }, relaunch: async entry => { relaunched.push(entry.requestId!); return { profile: 'prover-b' }; } });
  await producerLoop.cycle(state);
  const producerFailover = state.actions[failoverKey('producer', work, session.record)];
  assert.equal(producerFailover.state, 'done', producerFailover.detail);
  assert.match(producerFailover.detail, /exhausted prover's own account mid-session .*resets 2026-09-26T08:30:00.000Z\); relaunched on profile prover-b/);
  assert.deepEqual(relaunched, ['request-1']); assert.match(ended[0], /provider quota exhausted/);
  assert.ok((await observedExhaustions(config))[profileAccount('prover')], 'a profile that names no account is held under its own name');
  const recorded = (await reload(work.id)).capacity!.exhaustions.at(-1)!;
  assert.deepEqual([recorded.role, recorded.requestId, recorded.profile, recorded.resetsAt, recorded.partialWork.state], ['producer', 'request-1', 'prover', '2026-09-26T08:30:00.000Z', 'not-applicable']);
  await producerLoop.cycle(state);
  assert.equal((await reload(work.id)).capacity!.exhaustions.length, 2, 'an exhaustion already on the record is not written twice');
});

test('integration:capacity-exhausted-escalation — with every account of a role exhausted the item records one capacity escalation naming each account and its reset, the role is not launched again, nothing else is delayed, and status says it in one line', async () => {
  await fresh();
  const capacityHome = await mkdtemp(join(tmpdir(), 'graphyard-capacity-spent-'));
  const config = loopConfig([profileOf('builder', workerA, ['env-a']), profileOf('second', workerB, ['env-b'])], { credentialFile: join(capacityHome, 'coordinator.token') });
  const herdr: Herdr = { agents: [], output: {} }, clock = { skewMs: 0 };
  const { cycle, calls, now } = loop(config, herdr, clock);
  const resetA = new Date(Date.now() + 2 * 3_600_000).toISOString(), resetB = new Date(Date.now() + 5 * 24 * 3_600_000).toISOString();
  await recordObservedExhaustion(config, 'env-a', { at: new Date().toISOString(), resetsAt: resetA, reason: "You've hit your 5-hour limit", role: 'worker', profile: 'builder', work: null });
  await recordObservedExhaustion(config, 'env-b', { at: new Date().toISOString(), resetsAt: resetB, reason: 'Weekly usage limit reached', role: 'worker', profile: 'second', work: null });

  // One item needs a worker; another is one guarded merge away from delivery and needs none.
  let waiting = await released('capacity waits');
  const other = await released('capacity does not delay');
  const otherClaim = await launcherClaims(other, workerB);
  await submittedAndProven(otherClaim, workerB);
  assert.equal((await reload(other.id)).stage, 'merge');

  const state = emptyDaemonState(config);
  const first = await cycle(state);
  assert.deepEqual(calls.dispatch, [], 'no worker is launched while the role has no account left');
  assert.deepEqual(calls.merge, [other.key], 'an item that needs a different role moves in the same cycle');
  assert.equal(kinds(state, 'merge')[0].state, 'done', kinds(state, 'merge')[0].detail);
  assert.equal((await reload(other.id)).stage, 'done', 'and is delivered');

  waiting = await reload(waiting.id);
  const escalation = waiting.capacity!.escalations[0];
  assert.equal(escalation.role, 'worker');
  assert.deepEqual(escalation.accounts.map(entry => [entry.account, entry.profile, entry.resetsAt]), [['env-a', 'builder', resetA], ['env-b', 'second', resetB]]);
  assert.match(escalation.accounts[0].reason, /env-a exhausted its quota mid-session .*You've hit your 5-hour limit/);
  assert.equal(escalation.retryAt, resetA, 'the role is tried again at the first reset');
  const recorded = (await events(waiting)).filter(event => event.kind === 'capacity.escalated');
  assert.equal(recorded.length, 1); assert.equal(recorded[0].actor, coordinator.id);
  assert.deepEqual(recorded[0].payload.details.escalation.accounts.map((entry: any) => entry.resetsAt), [resetA, resetB]);
  assert.equal(waiting.stage, 'ready'); assert.equal(waiting.blocker, null, 'capacity is not a blocker anyone has to clear');

  // One line, once: not a launch failure per cycle, and no "no worker profile can take it" escalation.
  const line = state.actions[capacityKey('worker')];
  assert.equal(line.kind, 'capacity');
  assert.match(line.detail, new RegExp(`^worker capacity is exhausted on every configured account \\(env-a resets ${resetA.replace(/\./g, '\\.')}, env-b resets ${resetB.replace(/\./g, '\\.')}\\); worker launches are paused until ${resetA.replace(/\./g, '\\.')}, and nothing else is delayed; waiting: ${waiting.key}$`));
  assert.equal(first.actions.filter(action => action.kind === 'capacity').length, 1);
  for (let pass = 0; pass < 3; pass++) { clock.skewMs += 20_000; const again = await cycle(state); assert.deepEqual(again.actions.filter(action => ['capacity', 'dispatch', 'escalation'].includes(action.kind)), [], 'later cycles repeat nothing'); }
  assert.deepEqual(calls.dispatch, []);
  assert.equal(kinds(state, 'dispatch').length + kinds(state, 'escalation').length, 0);
  assert.equal((await events(waiting)).filter(event => event.kind === 'capacity.escalated').length, 1, 'the escalation is recorded once, not per cycle');

  // master status: capacity is one line and one attention item, whatever waits on it.
  const snapshot = await ok(coordinator, 'GET', 'work-snapshot');
  const status = buildMasterStatus({ work: snapshot.work, now: snapshot.now }, config.workers, [], await workerHealth(config, now));
  assert.equal(status.capacity.length, 1);
  assert.equal(status.capacity[0].line, line.detail);
  assert.deepEqual(status.capacity[0].waiting, [waiting.key]);
  assert.equal(status.counts.capacityExhausted, 1);
  const attention = status.attentionItems.filter(item => /capacity/.test(item.subject));
  assert.equal(attention.length, 1); assert.equal(attention[0].text, line.detail); assert.equal(attention[0].human, false);
  assert.deepEqual(status.attentionItems.map(item => item.subject), ['worker capacity'], 'that one line is all the attention there is: no launch failure, no refusal, nothing per item');

  // The automatic reviewer/producer dispatcher treats the same condition the same way: a role
  // with no account left is a wait, never a counted refusal, and it is not launched again.
  const reviewed = await released('capacity review waits');
  const reviewClaim = await launcherClaims(reviewed, workerB);
  await submittedAndProven(reviewClaim, workerB, { reviews: [] });
  const request = (await reload(reviewed.id)).autoDispatch?.review;
  assert.equal(request?.state, 'requested');
  const reviewerConfig = { ...config, reviewer: { appId: 99, installationId: 1, slug: 'graphyard-reviewer', credentialFile: join(capacityHome, 'reviewer.json'), boundAt: new Date().toISOString() }, reviewers: [{ name: 'reviewer-a', agentName: 'agent-reviewer-a', kind: 'claude' as const, agentArgs: [], approvals: 'auto' as const, environment: {}, accounts: ['env-a'] }] } as MasterConfig;
  let launches = 0, launchConfig = reviewerConfig;
  const dispatchEffects: DispatchEffects = { snapshot: async () => { const fresh = await ok(coordinator, 'GET', 'work-snapshot'); return { work: fresh.work, now: fresh.now }; }, agents: () => [], credentials: async () => ({}),
    reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }), launchProducer: async () => {}, persist: async () => {},
    launchReview: async (_work, _request, profile) => { launches++; await selectAccount(launchConfig, 'reviewer', profile, loginsOnly(now)); } };
  const cursor = emptyDispatchCursor(reviewerConfig);
  const tick = await runDispatchTick(reviewerConfig, cursor, dispatchEffects, now);
  assert.deepEqual(tick.refused, [], 'out of capacity is not a refused launch');
  assert.deepEqual(cursor.failures, {}, 'and counts toward no failure limit');
  assert.match(tick.waiting.find(entry => entry.requestId === request!.id)!.reason, /^reviewer capacity is exhausted \(reviewer-a: No healthy agent account for reviewer profile reviewer-a: env-a exhausted its quota mid-session/);
  const next = await runDispatchTick(reviewerConfig, cursor, dispatchEffects, now);
  assert.equal(launches, 1, 'the dispatcher stops launching the role until its accounts are due to be read again');
  assert.match(next.waiting.find(entry => entry.requestId === request!.id)!.reason, /launches are paused/);

  // …and only that condition. An account that is logged out, or a name that is not a configured
  // environment, also leaves no profile able to launch, but it is a fault a master fixes in one
  // command. It must stay a counted refusal with its own attention item, never a wait for a
  // provider reset that nothing would ever clear.
  for (const [label, accounts, expected] of [
    ['its only account is logged out', ['env-out'], /env-out is not logged in/],
    ['one account is spent and the other logged out', ['env-a', 'env-out'], /env-out is not logged in/],
    ['its account is not a configured environment', ['env-nope'], /env-nope is not a configured agent environment/],
  ] as const) {
    const fixable = await released(`reviewer ${label}`);
    await submittedAndProven(await launcherClaims(fixable, workerB), workerB, { reviews: [] });
    const fixableRequest = (await reload(fixable.id)).autoDispatch!.review!;
    launchConfig = { ...reviewerConfig, environments: [...(reviewerConfig.environments ?? []), { name: 'env-out', kind: 'claude', home: join(home, 'env-out') }],
      reviewers: [{ ...reviewerConfig.reviewers[0], accounts: [...accounts] }] } as MasterConfig;
    const fixableCursor = emptyDispatchCursor(launchConfig);
    // The role was paused for spent quota on an earlier tick and is due to be read again: the
    // hold is stale, and the refusal is what proves it wrong, so the refusal withdraws it rather
    // than leaving `dispatch.capacity` reporting a provider reset beside the fault.
    fixableCursor.capacity.review = { at: new Date(now() - 2 * capacityRecheckMs).toISOString(), recheckAt: new Date(now() - capacityRecheckMs).toISOString(), reason: 'reviewer-a: every account exhausted its quota' };
    const refusedTick = await runDispatchTick(launchConfig, fixableCursor, dispatchEffects, now);
    const refusal = refusedTick.refused.find(entry => entry.requestId === fixableRequest.id);
    assert.ok(refusal, `${label}: the launch is refused, not recorded as capacity`);
    assert.match(refusal.reason, expected);
    assert.equal(refusal.kind, 'review');
    assert.equal(fixableCursor.failures[fixableRequest.id]?.attempts, 1, `${label}: and counts toward the failure limit`);
    assert.deepEqual(fixableCursor.capacity, {}, `${label}: no role is paused for a reset that would never come, and a stale pause is withdrawn`);
    assert.equal(refusedTick.waiting.find(entry => entry.requestId === fixableRequest.id), undefined, `${label}: it does not read as a wait`);

    // And the master is told: the launch-review attention item the refusal has always raised.
    const snapshot = await ok(coordinator, 'GET', 'work-snapshot');
    const status = buildMasterStatus({ work: snapshot.work, now: snapshot.now }, config.workers, [], await workerHealth(config, now), {}, { pending: [], completed: [] }, 'main', undefined,
      { producers: { pending: [], completed: [] }, failures: Object.entries(fixableCursor.failures).map(([requestId, failure]) => ({ requestId, ...failure })) });
    const item = status.attentionItems.find(entry => entry.subject === fixable.key);
    assert.ok(item, `${label}: the master is told; attention is ${JSON.stringify(status.attentionItems.map(entry => entry.subject))}`);
    assert.match(item.text, new RegExp(`^Automatic review launch for ${fixable.key} refused 1 time\\(s\\)`));
    assert.match(item.text, expected);
    assert.equal(item.role, 'master'); assert.equal(item.human, false);
    assert.equal(status.capacity.filter(entry => /reviewer/.test(entry.line)).length, 0, `${label}: and it is not reported as reviewer capacity`);
  }
  launchConfig = reviewerConfig;

  // An account resets: the escalation is withdrawn on the record and the item is dispatched, by the loop alone.
  clock.skewMs += 2 * 3_600_000 + 60_000; const restored = await cycle(state);
  assert.deepEqual(calls.dispatch, [{ work: waiting.key, profile: 'builder', account: 'env-a' }]);
  assert.match(restored.actions.find(action => action.kind === 'capacity')!.detail, new RegExp(`^Restored: a worker account reports quota again; worker launches resume for ${waiting.key}`));
  waiting = await reload(waiting.id);
  assert.deepEqual(waiting.capacity!.escalations, []);
  assert.equal((await events(waiting)).filter(event => event.kind === 'capacity.restored').length, 1);
});

test('integration:human-decision-parking — a human-only decision is a typed request with the reason and the exact thing needed; the session ends without a lease, the item parks, the rest of the graph continues, and the request is listed with its wait and how to answer it', async () => {
  await fresh();
  const config = loopConfig([profileOf('builder', workerB)], { credentialFile: join(await mkdtemp(join(tmpdir(), 'graphyard-capacity-park-')), 'coordinator.token') });
  const herdr: Herdr = { agents: [], output: {} }, clock = { skewMs: 0 };
  const { cycle, calls } = loop(config, herdr, clock);
  const parked = await launcherClaims(await released('needs a provider account'), workerA);
  const independent = await released('independent of the wait');

  // The worker records the decision with the CLI its prompt names, under its own credential.
  assert.match(workerPrompt(config, parked, config.workers[0], 1), new RegExp(`node \\S+ park ${parked.key} 1 KIND NEEDED -- REASON`));
  const asked = cli(workerA, ['1', 'money-or-accounts', 'A', 'Hetzner', 'Cloud', 'project', 'with', 'an', 'API', 'token', 'for', 'the', 'live-install', 'proofs', '--', 'The', 'four', 'live-install', 'proofs', 'provision', 'real', 'servers;', 'opening', 'the', 'account', 'and', 'accepting', 'its', 'charges', 'is', 'the', "operator's"]);
  await parkCommand.run(asked.context, parked);
  let work = await reload(parked.id);
  const request = work.humanRequest!;
  assert.deepEqual({ ...request, id: null, at: null }, { id: null, at: null, kind: 'money-or-accounts', needed: 'A Hetzner Cloud project with an API token for the live-install proofs',
    reason: "The four live-install proofs provision real servers; opening the account and accepting its charges is the operator's", requestedBy: workerA.id, epoch: 1 });
  assert.equal(work.lease, null, 'recording the request ended the lease in the same transaction');
  assert.equal((work as any).pipeline.attempts[0].end, 'released');
  assert.equal(work.blocker, `${humanRequestBlocker} (spending money or opening third-party accounts): ${request.needed}`);
  const event = (await events(work)).find(entry => entry.kind === 'human.requested')!;
  assert.equal(event.actor, workerA.id); assert.deepEqual(event.payload.details.leaseEnded, { owner: workerA.id, epoch: 1 });
  // The session exits holding nothing: its supervisor can renew nothing, and nobody else can claim the parked item.
  assert.equal((await call(workerA, 'POST', `work/${work.id}/heartbeat`, { epoch: 1 })).status, 409);
  assert.equal((await call(workerB, 'POST', `work/${work.id}/claim`, {})).status, 409);
  assert.equal((await call(workerB, 'POST', `work/${independent.id}/park`, { epoch: 1, kind: 'money-or-accounts', needed: 'x', reason: 'y' })).status, 409, 'only the attempt that holds the lease may park its item');
  assert.equal((await call(workerA, 'POST', `work/${work.id}/park`, { epoch: 1, kind: 'vibes', needed: 'x', reason: 'y' })).status, 400, 'the decision is one of the three a human keeps');

  // The rest of the graph continues: the loop dispatches the independent item and leaves the parked one alone.
  await delay(30);
  const state = emptyDaemonState(config);
  const first = await cycle(state);
  assert.deepEqual(calls.dispatch.map(entry => entry.work), [independent.key]);
  const notice = kinds(state, 'human');
  assert.equal(notice.length, 1); assert.equal(notice[0].work, work.key);
  assert.match(notice[0].detail, new RegExp(`parked on a human-only decision \\(spending money or opening third-party accounts\\): A Hetzner Cloud project .* the human answers with graphyard answer ${work.key} ${request.id} ANSWER`));
  assert.ok(first.actions.some(action => action.kind === 'human'));
  clock.skewMs += 20_000; const second = await cycle(state);
  assert.ok(!second.actions.some(action => action.kind === 'human' || action.kind === 'escalation'), 'named once, never escalated to an agent');
  await engine.reconcile();
  work = await reload(work.id);
  assert.deepEqual(work.escalations ?? [], [], 'a parked attempt is not a lost lease');
  assert.equal(work.lease, null);

  // The human-facing list: what is needed, why, who asked, how long it has waited, how to answer.
  const listed = await ok(operator, 'GET', 'human-requests');
  assert.equal(listed.requests.length, 1);
  const row = listed.requests[0];
  assert.equal(row.work, work.key); assert.equal(row.request.id, request.id); assert.equal(row.decision, 'spending money or opening third-party accounts');
  assert.ok(row.waitedMs >= 30, `waited ${row.waitedMs}ms`);
  assert.equal(row.answer.cli, answerCommand(work.key, request));
  const printed = cli(operator, []); await humanRequestsCommand.run(printed.context, undefined);
  assert.equal(printed.printed[0].waiting, 1);
  assert.deepEqual([printed.printed[0].requests[0].work, printed.printed[0].requests[0].needed, printed.printed[0].requests[0].waited, printed.printed[0].requests[0].answer], [work.key, request.needed, '1m', `graphyard answer ${work.key} ${request.id} ANSWER`]);

  // master status hands it to the human, not to the master; the dashboard page shows the same row.
  const snapshot = await ok(coordinator, 'GET', 'work-snapshot');
  const status = buildMasterStatus({ work: snapshot.work, now: new Date(Date.parse(snapshot.now) + 3 * 3_600_000).toISOString() }, config.workers, []);
  assert.equal(status.counts.humanRequests, 1);
  assert.equal(status.humanRequests[0].work, work.key); assert.ok(status.humanRequests[0].waitedMs >= 3 * 3_600_000);
  const owed = status.attentionItems.find(item => item.subject === work.key)!;
  assert.equal(owed.role, 'human'); assert.equal(owed.human, true); assert.equal(owed.humanOnly, 'spending money or opening third-party accounts');
  assert.match(owed.next, new RegExp(`^graphyard answer ${work.key} ${request.id} ANSWER`));
  assert.match(owed.text, /holds no lease and delays nothing else/);
  const dashboard = (actor: Principal) => ({ work: snapshot.work, status: { actor }, observedAt: Date.parse(snapshot.now) + 3 * 3_600_000, busy: false, action: async () => {}, setSelected: () => {} }) as unknown as Dashboard;
  const page = renderToStaticMarkup(createElement(HumanRequestsPage, dashboard(operator)));
  for (const shown of [work.key, 'A Hetzner Cloud project with an API token', 'spending money or opening third-party accounts', `asked by ${workerA.id}`, 'Waiting 3', `graphyard answer ${work.key} ${request.id} ANSWER`, `Answer and resume ${work.key}`]) assert.ok(page.includes(shown), shown);
  assert.ok(!renderToStaticMarkup(createElement(HumanRequestsPage, dashboard(aiAdmin))).includes('Answer and resume'), 'an agent session is shown the request, never the form');

  // Only the human answers a human-only request.
  for (const agent of [aiAdmin, coordinator, workerA]) assert.equal((await call(agent, 'POST', `work/${work.id}/answer`, { request: request.id, answer: 'Approved by an agent' })).status, 403, agent.id);
  assert.equal((await reload(work.id)).humanRequest?.id, request.id);
});

test('integration:human-answer-resumes-item — answering from the CLI or the dashboard route returns the item to the loop, which dispatches it, and it is delivered with no coordinator session present', async () => {
  await fresh();
  const config = loopConfig([profileOf('builder', workerA)], { credentialFile: join(await mkdtemp(join(tmpdir(), 'graphyard-capacity-answer-')), 'coordinator.token') });
  const herdr: Herdr = { agents: [], output: {} }, clock = { skewMs: 0 };
  const { cycle, calls } = loop(config, herdr, clock);
  const state = emptyDaemonState(config);

  // Driven into the wait by the loop's own dispatch and the worker's own request.
  let work = await released('resumes on the human answer');
  await cycle(state);
  assert.deepEqual(calls.dispatch.map(entry => entry.work), [work.key]);
  await ok(workerA, 'POST', `work/${work.id}/park`, { epoch: 1, kind: 'credentials-for-people', needed: 'A deploy key for the staging host, issued to the on-call engineer', reason: 'Only the operator issues credentials to people' });
  herdr.agents = [];
  clock.skewMs += 20_000; await cycle(state);
  assert.equal(calls.dispatch.length, 1, 'a parked item is not dispatched');
  work = await reload(work.id);
  assert.equal(work.lease, null); assert.ok(work.humanRequest);

  // The human answers from the CLI. That is the last thing any person or master does.
  const answered = cli(operator, ['The', 'key', 'is', 'issued;', 'its', 'fingerprint', 'is', 'in', 'the', 'staging', 'runbook']);
  await answerHumanCommand.run(answered.context, work);
  work = await reload(work.id);
  assert.equal(work.humanRequest, null); assert.equal(work.blocker, null);
  const record = work.humanRequests!.at(-1)!;
  assert.deepEqual([record.answer!.by, record.answer!.outcome, record.answer!.text], [operator.id, 'provided', 'The key is issued; its fingerprint is in the staging runbook']);
  assert.ok(record.answer!.waitedMs >= 0);
  const event = (await events(work)).find(entry => entry.kind === 'human.answered')!;
  assert.equal(event.actor, operator.id); assert.equal(event.payload.details.resumed, true);

  // From here only the loop runs, with its coordinator token: the next action is computed and executed by it.
  const before = (await events(work)).length;
  clock.skewMs += 20_000; const resumed = await cycle(state);
  assert.deepEqual(calls.dispatch.map(entry => entry.work), [work.key, work.key], 'the loop dispatches the answered item on its next cycle');
  assert.ok(resumed.actions.some(action => action.kind === 'dispatch' && action.state === 'done' && action.work === work.key));
  work = await reload(work.id);
  assert.equal(work.epoch, 2); assert.equal(work.lease?.owner, workerA.id);
  assert.match(workerPrompt(config, work, config.workers[0], 2), /the human answered: The key is issued; its fingerprint is in the staging runbook\. Continue from that answer\./);

  // The new attempt delivers: the worker submits, the provider and the trusted producer do their parts, the loop merges.
  await submittedAndProven(work, workerA);
  herdr.agents = [];
  clock.skewMs += 20_000; await cycle(state);
  assert.deepEqual(calls.merge, [work.key]);
  work = await reload(work.id);
  assert.equal(work.stage, 'done'); assert.ok(work.delivery, 'delivered');
  // No coordinator session took part: every actor after the answer is the worker, the producer, the loop's token, or the control plane and its provider observation.
  const actors = new Set((await events(work)).slice(before).map(entry => entry.actor));
  assert.deepEqual([...actors].filter(actor => ![workerA.id, producer.id, coordinator.id, 'graphyard', 'github'].includes(actor)), []);

  // The dashboard answers through the same route (`action(id, 'answer', …)`); a declined answer keeps the item parked on the human's words.
  let declined = await launcherClaims(await released('declined by the human'), workerB);
  declined = await ok(workerB, 'POST', `work/${declined.id}/park`, { epoch: 1, kind: 'goals-and-priorities', needed: 'Whether the legacy importer is still a goal', reason: 'The item removes it' });
  assert.equal((await call(operator, 'POST', `work/${declined.id}/answer`, { request: randomUUID(), answer: 'stale' })).status, 409, 'an answer names the request it read');
  declined = await ok(operator, 'POST', `work/${declined.id}/answer`, { request: declined.humanRequest!.id, outcome: 'declined', answer: 'Keep the importer this quarter' });
  assert.equal(declined.humanRequest, null);
  assert.equal(declined.blocker, 'A human declined goals and priorities for this item: Keep the importer this quarter');
  assert.deepEqual(openHumanRequests([declined], Date.now()), []);
  clock.skewMs += 20_000; await cycle(state);
  assert.ok(!calls.dispatch.some(entry => entry.work === declined.key), 'a declined item stays parked');
});

// GY-182: approvers and escalation handlers are capacity roles, and an account one role saw spent
// is spent for every role. The approver's account selection, its hold and its failover are the
// real ones; only the Herdr tab and the approver's own judgement are the test's.
const reviewerOn = (accounts: string[]) => ({ name: 'reviewer-a', agentName: 'agent-reviewer-a', kind: 'claude' as const, agentArgs: [], approvals: 'auto' as const, environment: {}, accounts });
async function approverLoop(label: string, accounts = ['env-a', 'env-b'], extra: (now: () => number) => Partial<DaemonEffects> = () => ({})) {
  await fresh();
  const approverHome = await mkdtemp(join(tmpdir(), `graphyard-capacity-${label}-`));
  const config = { ...loopConfig([profileOf('builder', workerA)], { credentialFile: join(approverHome, 'coordinator.token'), autoMerge: false }), reviewers: [reviewerOn(accounts)] } as MasterConfig;
  const herdr: Herdr = { agents: [], output: {} }, clock = { skewMs: 0 };
  const decisions: { id: string; action: string; state: string; input: any; approvedBy: string | null }[] = [];
  const launches: (string | null)[] = [], attempts: string[] = [];
  const now = () => Date.now() + clock.skewMs;
  const harness = loop(config, herdr, clock, {
    dispatch: async () => {},
    decide: async (_work, action, _reason, input) => { const entry = { id: `decision-${label}-${decisions.length + 1}`, action, state: 'requested', input: input ?? {}, approvedBy: null }; decisions.push(entry); return entry; },
    decisions: async () => ({ decisions }),
    // The launch as `launchApprover` makes it: the same account selection, then a Herdr tab.
    approver: async (work, decision) => {
      attempts.push(decision);
      const chosen = await selectApproverAccount(config, work.key, 'approver-agent', { ...loginsOnly(now), registry: undefined });
      const agentName = approverSessionName(work, decision), pane = `pane-approver-${launches.length}`;
      herdr.agents.push({ name: agentName, pane_id: pane, agent_status: 'working' });
      launches.push(chosen.account?.name ?? null);
      // The agent registry session the launch holds, as a registry-decided `launchApprover` reports it.
      return { agentName, pane, account: chosen.account?.name ?? null, runtime: chosen.account?.kind ?? null, session: `registry-session-${launches.length}` };
    },
    roleHealth: async () => ({ approver: await approverRoleHealth(config, loginsOnly(now)) }),
    ...extra(now),
  });
  // One item whose every gate passes; automatic merging is off, so it needs an approved merge decision.
  const work = (await submittedAndProven(await launcherClaims(await released(`approver ${label}`), workerB), workerB)).work;
  assert.equal(work.stage, 'merge');
  return { config, herdr, clock, decisions, launches, attempts, work, ...harness };
}

test('unit:approver-exhaustion-fails-over — an approver session stopped on its provider limit notice is ended within one cycle, its account is recorded exhausted until the reset the notice names, and the same decision is relaunched on another account without a person', async () => {
  const { config, herdr, decisions, launches, work, cycle, calls } = await approverLoop('failover');
  const state = emptyDaemonState(config);
  await cycle(state);
  assert.equal(decisions.length, 1, 'the loop requests the merge decision');
  assert.deepEqual(launches, ['env-a'], 'and puts it to an approver on the first account');
  const watch = Object.values(state.approvals)[0], launchedAt = watch.launchedAt;
  assert.equal(watch.account, 'env-a');

  // The approver stops on Claude's weekly-limit menu, as the seven approvers of 2026-09-24 did.
  const notice = "You've hit your weekly limit · resets Sep 26, 10pm";
  const name = approverSessionName(work, decisions[0].id);
  herdr.agents.find(agent => agent.name === name)!.agent_status = 'idle';
  herdr.output[name] = `● Reading the decision…\n  ⎿ ${notice}\n    /upgrade to increase your usage limit.\n`;
  const detectedAt = Date.now();
  const detection = await cycle(state);
  const resetsAt = parseResetTime(notice, detectedAt)!;
  assert.ok(Date.parse(resetsAt) > detectedAt, 'the notice names a reset in the future');

  // Ended within that one cycle: the session is closed, not left on the provider's menu.
  assert.deepEqual(calls.closed, ['pane-approver-0']);
  const failover = detection.actions.find(action => action.kind === 'failover');
  assert.ok(failover, `the cycle that saw the notice failed it over: ${JSON.stringify(detection.actions)}`);
  assert.equal(failover.state, 'done', failover.detail);
  assert.match(failover.detail, new RegExp(`exhausted env-a mid-session \\(${notice}; resets ${resetsAt.replace(/\./g, '\\.')}\\) judging merge decision ${decisions[0].id}; launched independent approver session ${name} on env-b`));
  assert.equal(state.actions[failoverKey('approver', work, `${decisions[0].id}:${launchedAt}`)].state, 'done', 'one failover per exhausted session');

  // The account is recorded exhausted until the time the notice names, for every launcher.
  const held = (await observedExhaustions(config))['env-a'];
  assert.equal(held.until, resetsAt); assert.equal(held.resetsAt, resetsAt); assert.equal(held.role, 'approver');
  const recorded = (await reload(work.id)).capacity!.exhaustions.at(-1)!;
  assert.deepEqual([recorded.role, recorded.requestId, recorded.account, recorded.resetsAt, recorded.reason, recorded.partialWork.state], ['approver', decisions[0].id, 'env-a', resetsAt, notice, 'not-applicable']);
  const history = (await events(work)).filter(event => event.kind === 'capacity.exhausted');
  assert.equal(history.length, 1); assert.equal(history[0].actor, coordinator.id);

  // The same decision, relaunched on the other account: no new request, no launch spent.
  assert.deepEqual(launches, ['env-a', 'env-b']);
  assert.equal(decisions.length, 1, 'the decision is not requested again');
  const relaunched = Object.values(state.approvals)[0];
  assert.deepEqual([relaunched.decision, relaunched.account, relaunched.launches, relaunched.exhaustedAt], [decisions[0].id, 'env-b', 1, null], 'an exhausted account is not a judgement the decision failed to get');
  assert.ok(herdr.agents.some(agent => agent.name === name && agent.pane_id === 'pane-approver-1'));

  // The next cycle repeats nothing: one exhaustion, one failover, the new approver left to judge.
  const after = await cycle(state);
  assert.deepEqual(after.actions.filter(action => ['failover', 'decision', 'capacity'].includes(action.kind)), []);
  assert.deepEqual(launches, ['env-a', 'env-b']);
  assert.equal((await reload(work.id)).capacity!.exhaustions.length, 1);
});

test('unit:exhaustion-shared-across-roles — an account a worker session exhausted is skipped by the approver, reviewer, producer and registry-chosen launches until its reset, and is eligible again after it', async () => {
  await fresh();
  const sharedHome = await mkdtemp(join(tmpdir(), 'graphyard-capacity-shared-'));
  const config = { ...loopConfig([profileOf('builder', workerA, ['env-a', 'env-b'])], { credentialFile: join(sharedHome, 'coordinator.token') }), reviewers: [reviewerOn(['env-a', 'env-b'])] } as MasterConfig;
  const at = Date.now(), resetsAt = new Date(at + 3 * 3_600_000).toISOString();
  // What the loop's worker failover holds when a worker stops on its notice.
  await recordObservedExhaustion(config, 'env-a', { at: new Date(at).toISOString(), resetsAt, reason: "You've hit your weekly limit", role: 'worker', profile: 'builder', work: 'GY-1' }, at);

  const before = { ...loginsOnly(() => at + 60_000), work: 'GY-2' }, afterReset = { ...loginsOnly(() => Date.parse(resetsAt) + 60_000), work: 'GY-2' };
  const producerProfile = { name: 'prover', accounts: ['env-a', 'env-b'] };
  const launched = async (probe: typeof before) => ({
    worker: (await selectAccount(config, 'worker', config.workers[0], probe)).account?.name,
    approver: (await selectApproverAccount(config, probe.work, 'approver-agent', probe)).account?.name,
    reviewer: (await selectAccount(config, 'reviewer', config.reviewers[0], probe)).account?.name,
    producer: (await selectAccount(config, 'producer', producerProfile, probe)).account?.name,
    'escalation-handler': (await selectAccount(config, 'escalation-handler', producerProfile, probe)).account?.name,
  });
  assert.deepEqual(await launched(before), { worker: 'env-b', approver: 'env-b', reviewer: 'env-b', producer: 'env-b', 'escalation-handler': 'env-b' }, 'no role is handed the account another role saw spent');
  const skips = (await readEnvironmentLog(config)).skipped.filter(entry => entry.environment === 'env-a');
  assert.deepEqual([...new Set(skips.map(entry => entry.role))].sort(), ['approver', 'escalation-handler', 'producer', 'reviewer', 'worker']);
  assert.ok(skips.every(entry => entry.cause === 'exhausted' && /env-a exhausted its quota mid-session/.test(entry.reason)));

  // A role the agent registry decides: the registry is told the account is spent, so it chooses another.
  const seen: { account: string; state: string; resetsAt: string | null }[][] = [];
  const registry = {
    revision: 1, runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR' } }], models: [{ name: 'default', runtime: 'claude', id: null }],
    accounts: ['env-a', 'env-b'].map(name => ({ name, runtime: 'claude', model: 'default', enabled: true, credential: { host: 'loop-host', home: null }, quota: { state: 'unknown' } })),
    roles: ['approver', 'reviewer'].map(name => ({ name, accounts: ['env-a', 'env-b'], concurrency: 2 })),
  };
  const client: FleetClient = {
    document: async () => registry as any, end: async () => {},
    select: async request => {
      seen.push(request.observations.map(entry => ({ account: entry.account, state: entry.quota.state, resetsAt: entry.quota.resetsAt })));
      const account = registry.accounts.find(entry => request.observations.find(observed => observed.account === entry.name)?.quota.state !== 'exhausted')!;
      return { selected: true, reason: `first eligible account ${account.name}`, skipped: [], session: { id: `session-${seen.length}` }, account, runtime: registry.runtimes[0], model: registry.models[0], revision: 1 } as any;
    },
  };
  // The registry's own cache sits beside the credential, so the registry-decided roles get a home of their own.
  const fleetConfig = { ...config, credentialFile: join(await mkdtemp(join(tmpdir(), 'graphyard-capacity-fleet-')), 'coordinator.token') };
  for (const role of ['approver', 'reviewer'] as const) {
    const chosen = await selectFleetSession(fleetConfig, role, { name: `${role}-fleet` }, await heldAwareProbe(config, { ...before, registry: client }));
    assert.equal(chosen?.account.name, 'env-b', `${role}: the registry chose around the held account`);
  }
  assert.deepEqual(seen.map(observations => observations.find(entry => entry.account === 'env-a')), [{ account: 'env-a', state: 'exhausted', resetsAt }, { account: 'env-a', state: 'exhausted', resetsAt }]);

  // After the reset nothing holds it: every role selects it again, on its own.
  assert.deepEqual(await launched(afterReset), { worker: 'env-a', approver: 'env-a', reviewer: 'env-a', producer: 'env-a', 'escalation-handler': 'env-a' });
  const restored = await selectFleetSession(fleetConfig, 'approver', { name: 'approver-fleet' }, await heldAwareProbe(config, { ...afterReset, registry: client }));
  assert.equal(restored?.account.name, 'env-a');
  assert.notEqual(seen.at(-1)!.find(entry => entry.account === 'env-a')!.state, 'exhausted');
});

test('unit:role-exhausted-waits-for-reset — with every approver account exhausted no approver is launched before the earliest reset, master status shows one capacity line naming each account and its reset, and no decision reads as stalled per item', async () => {
  const { config, clock, decisions, launches, attempts, now, work, cycle } = await approverLoop('spent');
  const resetA = new Date(Date.now() + 2 * 3_600_000).toISOString(), resetB = new Date(Date.now() + 5 * 24 * 3_600_000).toISOString();
  await recordObservedExhaustion(config, 'env-a', { at: new Date().toISOString(), resetsAt: resetA, reason: "You've hit your weekly limit", role: 'approver', profile: 'approver', work: null });
  await recordObservedExhaustion(config, 'env-b', { at: new Date().toISOString(), resetsAt: resetB, reason: 'Weekly usage limit reached', role: 'worker', profile: 'builder', work: null });

  const state = emptyDaemonState(config);
  const first = await cycle(state);
  assert.equal(decisions.length, 1, 'the decision is requested: it is the launch that waits');
  assert.deepEqual(attempts, [], 'no approver launch is even attempted while every account is spent');
  const watch = Object.values(state.approvals)[0];
  assert.deepEqual([watch.launches, watch.agentName, watch.exhaustedAt], [0, null, null]);

  // One capacity escalation naming each account and its reset, and one line for the cycle.
  const waiting = await reload(work.id);
  const escalation = waiting.capacity!.escalations.find(entry => entry.role === 'approver')!;
  assert.deepEqual(escalation.accounts.map(entry => [entry.account, entry.resetsAt]), [['env-a', resetA], ['env-b', resetB]]);
  assert.equal(escalation.retryAt, resetA, 'the role is tried again at the earliest reset');
  const line = state.actions[capacityKey('approver')];
  assert.equal(line.detail, `${describeCapacity('approver', escalation.accounts)}; waiting: ${work.key}`);
  assert.match(line.detail, new RegExp(`^approver capacity is exhausted on every configured account \\(env-a resets ${resetA.replace(/\./g, '\\.')}, env-b resets ${resetB.replace(/\./g, '\\.')}\\); approver launches are paused until ${resetA.replace(/\./g, '\\.')}`));
  assert.equal(first.actions.filter(action => action.kind === 'capacity').length, 1);

  // Later cycles attempt no launch before the earliest reset and repeat nothing.
  for (let pass = 0; pass < 3; pass++) {
    clock.skewMs += 20 * 60_000;
    const again = await cycle(state);
    assert.deepEqual(again.actions.filter(action => ['capacity', 'decision', 'escalation', 'failover'].includes(action.kind)), [], `pass ${pass}: ${JSON.stringify(again.actions)}`);
  }
  assert.deepEqual(attempts, []); assert.deepEqual(launches, []);
  assert.equal(decisions.length, 1);
  assert.equal(Object.values(state.approvals)[0].launches, 0, 'a launch never made is never counted against the decision');
  assert.equal((await events(waiting)).filter(event => event.kind === 'capacity.escalated').length, 1);

  // master status: one capacity line for the role, and no stalled-decision alarm for the item.
  const snapshot = await ok(coordinator, 'GET', 'work-snapshot');
  const status = buildMasterStatus({ work: snapshot.work, now: snapshot.now }, config.workers, [], await workerHealth(config, now));
  assert.equal(status.capacity.length, 1);
  assert.equal(status.capacity[0].role, 'approver');
  assert.equal(status.capacity[0].line, line.detail);
  assert.deepEqual(status.capacity[0].accounts.map(entry => [entry.account, entry.resetsAt]), [['env-a', resetA], ['env-b', resetB]]);
  assert.deepEqual(status.attentionItems.filter(item => /capacity/.test(item.subject)).map(item => item.text), [line.detail]);
  assert.deepEqual(status.attentionItems.filter(item => /approver session|unjudged|unanswered/.test(item.text)), []);
  assert.deepEqual(actionableSubjects(config, snapshot.work, now(), { approvals: state.approvals }).filter(subject => subject.kind === 'decision'), [], 'waiting on capacity is not a decision the loop reads as stalled');

  // The earliest reset passes: the loop alone launches the approver on that account.
  clock.skewMs = Date.parse(resetA) - Date.now() + 60_000;
  const restored = await cycle(state);
  assert.deepEqual(launches, ['env-a']);
  assert.ok(restored.actions.some(action => action.kind === 'decision' && /launched independent approver session .* on env-a/.test(action.detail)), JSON.stringify(restored.actions));
  assert.deepEqual((await reload(work.id)).capacity!.escalations, []);
});

/** A repository of its own for the loop's local records (`.graphyard/local`). */
async function localRoot(label: string) {
  const root = await mkdtemp(join(tmpdir(), `graphyard-capacity-${label}-`));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('an approver session a master launched is adopted on the account its launch chose, and its exhaustion holds that account, not the runtime login', async () => {
  const root = await localRoot('adopt-root');
  const { config, herdr, decisions, launches, attempts, work, cycle } = await approverLoop('adopt', ['env-a', 'env-b'], () => ({ approverLaunch: agentName => readApproverLaunch(root, agentName) }));
  // `master approver` already launched the decision's session on env-a, and recorded where.
  const name = approverSessionName(work, 'decision-adopt-1');
  herdr.agents.push({ name, pane_id: 'pane-master-approver', agent_status: 'working' });
  await saveApproverLaunch(root, { agentName: name, account: 'env-a', runtime: 'claude', session: null, launchedAt: new Date().toISOString() });

  const state = emptyDaemonState(config);
  const adopted = await cycle(state);
  assert.equal(decisions.length, 1);
  assert.deepEqual(attempts, [], 'the listed session is adopted, not launched again');
  const watch = Object.values(state.approvals)[0];
  assert.deepEqual([watch.agentName, watch.account, watch.runtime], [name, 'env-a', 'claude']);
  assert.ok(adopted.actions.some(action => action.kind === 'decision' && action.detail.includes(`adopted approver session ${name} on env-a`)), JSON.stringify(adopted.actions));

  const notice = "You've hit your weekly limit · resets Sep 26, 10pm";
  herdr.agents.find(agent => agent.name === name)!.agent_status = 'idle';
  herdr.output[name] = `  ⎿ ${notice}\n`;
  const detection = await cycle(state);
  const failover = detection.actions.find(action => action.kind === 'failover')!;
  assert.equal(failover?.state, 'done', JSON.stringify(detection.actions));
  const held = await observedExhaustions(config);
  assert.ok(held['env-a'], 'the account the adopted session spent is held');
  assert.equal(held[profileAccount('approver')], undefined, 'not the runtime\'s own login');
  assert.equal((await reload(work.id)).capacity!.exhaustions.at(-1)!.account, 'env-a');
  assert.deepEqual(launches, ['env-b'], 'the failover launch goes around the spent account');
});

test('a waiting escalation handler is kept until its reset, even a weekly one more than a day away', async () => {
  const root = await localRoot('escalation-records');
  const at = Date.now(), day = 86_400_000, retryAt = new Date(at + 3 * day).toISOString();
  const handler = (work: string, trigger: string, launchedAt: number, waiting: EscalationSession['waiting']): EscalationSession =>
    ({ agentName: `esc-${trigger}`, pane: null, work, trigger, kind: 'claude', account: 'env-a', runtime: 'claude', launchedAt: new Date(launchedAt).toISOString(), session: null, waiting });
  await saveEscalationSession(root, 'GY-1', 'weekly', handler('GY-1', 'weekly', at, { since: new Date(at).toISOString(), retryAt, reason: 'every account is spent' }), at);
  await saveEscalationSession(root, 'GY-1', 'running', handler('GY-1', 'running', at, null), at);
  // Two days on another handler is saved: the running record is past its day, the waiting one is not past its reset.
  await saveEscalationSession(root, 'GY-2', 'other', handler('GY-2', 'other', at + 2 * day, null), at + 2 * day);
  assert.deepEqual((await readEscalationSessions(root)).map(entry => entry.trigger), ['weekly', 'other']);
  // A waiting record a day past its reset that was never launched again is dropped.
  await saveEscalationSession(root, 'GY-2', 'other', null, Date.parse(retryAt) + day);
  assert.deepEqual(await readEscalationSessions(root), []);
});

test('an escalation handler waiting on spent quota records an escalation-handler capacity escalation on the item, shown in master status, and withdrawn at the reset', async () => {
  const at = Date.now(), resetsAt = new Date(at + 3 * 86_400_000).toISOString();
  let waitingFor = '';
  const { config, clock, work, cycle, now } = await approverLoop('escalation-capacity', ['env-a', 'env-b'], now => ({
    roleHealth: async () => ({ 'escalation-handler': await escalationRoleHealth(config, loginsOnly(now)) }),
    escalationSessions: async () => [{ agentName: 'gy-esc', pane: null, work: waitingFor, trigger: 'lease-loss', kind: 'claude', account: null, runtime: 'claude', launchedAt: new Date(at).toISOString(), session: null, waiting: { since: new Date(at).toISOString(), retryAt: resetsAt, reason: 'no account left' } }],
  }));
  waitingFor = work.key;
  await recordObservedExhaustion(config, profileAccount(escalationProfile), { at: new Date(at).toISOString(), resetsAt, reason: "You've hit your weekly limit", role: 'escalation-handler', profile: escalationProfile, work: work.key }, at);

  const state = emptyDaemonState(config);
  await cycle(state);
  const escalation = (await reload(work.id)).capacity!.escalations.find(entry => entry.role === 'escalation-handler');
  assert.ok(escalation, 'the wait is recorded on the item, not only in the local record');
  assert.deepEqual(escalation.accounts.map(entry => [entry.account, entry.resetsAt]), [[profileAccount(escalationProfile), resetsAt]]);
  const snapshot = await ok(coordinator, 'GET', 'work-snapshot');
  const status = buildMasterStatus({ work: snapshot.work, now: snapshot.now }, config.workers, [], await workerHealth(config, now));
  assert.deepEqual(status.capacity.filter(entry => entry.role === 'escalation-handler').map(entry => entry.waiting), [[work.key]]);

  clock.skewMs = Date.parse(resetsAt) - Date.now() + 60_000;
  await cycle(state);
  assert.deepEqual((await reload(work.id)).capacity!.escalations.filter(entry => entry.role === 'escalation-handler'), []);
});

test('an exhausted approver\'s agent registry session is ended before its replacement is launched, so a role at concurrency 1 has the slot for it', async () => {
  const ended: { session: string; reason: string; launchesBefore: number }[] = [];
  const launched: (string | null)[] = [];
  const { config, herdr, decisions, launches, work, cycle } = await approverLoop('registry-slot', ['env-a', 'env-b'], () => ({
    endRegistrySession: async (session, reason) => { ended.push({ session, reason, launchesBefore: launched.length }); },
  }));
  const state = emptyDaemonState(config);
  await cycle(state);
  launched.push(...launches);
  assert.equal(Object.values(state.approvals)[0].session, 'registry-session-1', 'the watch keeps the registry session its launch holds');
  const name = approverSessionName(work, decisions[0].id);
  herdr.agents.find(agent => agent.name === name)!.agent_status = 'idle';
  herdr.output[name] = "  ⎿ You've hit your weekly limit · resets Sep 26, 10pm\n";
  const detection = await cycle(state);
  assert.equal(detection.actions.find(action => action.kind === 'failover')?.state, 'done', JSON.stringify(detection.actions));
  assert.equal(ended.length, 1, 'the spent session\'s registry slot is ended once');
  assert.equal(ended[0].session, 'registry-session-1');
  assert.match(ended[0].reason, /^approver session .* exhausted env-a mid-session/);
  assert.equal(ended[0].launchesBefore, 1, 'before the replacement is launched');
  assert.deepEqual(launches, ['env-a', 'env-b']);
  assert.equal(Object.values(state.approvals)[0].session, 'registry-session-2', 'the replacement\'s own session is what the watch holds now');
});

/** An approver launch against a registry role at its default concurrency of 1: one live session holds the slot. */
function approverSlot() {
  const live = new Set<string>(), ended: string[] = [], slot = { herdr: null as Herdr | null };
  let launched = 0;
  const effects: Partial<DaemonEffects> = {
    approver: async (work, decision) => {
      if (live.size >= 1) throw new Error(`approver is at its concurrency limit of 1 (${[...live].join(', ')})`);
      const session = `registry-slot-${++launched}`, agentName = approverSessionName(work, decision), pane = `pane-slot-${launched}`;
      live.add(session);
      slot.herdr!.agents = [...slot.herdr!.agents.filter(agent => agent.name !== agentName), { name: agentName, pane_id: pane, agent_status: 'working' }];
      return { agentName, pane, account: 'env-a', runtime: 'claude', session };
    },
    endRegistrySession: async session => { live.delete(session); ended.push(session); },
  };
  return { live, ended, effects, slot };
}

test('an approver that applies its decision has its registry session ended with its pane, so a role at concurrency 1 has the slot for the next decision', async () => {
  const registry = approverSlot();
  const { config, herdr, decisions, cycle, calls } = await approverLoop('registry-settled', ['env-a', 'env-b'], () => registry.effects);
  registry.slot.herdr = herdr;
  const state = emptyDaemonState(config);
  await cycle(state);
  assert.deepEqual([...registry.live], ['registry-slot-1'], 'the launch holds the role\'s one slot');
  decisions[0].state = 'applied';
  await cycle(state);
  const watch = Object.values(state.approvals)[0];
  assert.ok(watch.settledAt, 'the decision is settled');
  assert.deepEqual(registry.ended, ['registry-slot-1'], 'the settled approver\'s registry session is ended');
  assert.deepEqual([...registry.live], [], 'the slot is free for the next decision\'s approver');
  assert.equal(watch.session, null);
  assert.ok(calls.closed.includes('pane-slot-1'), 'and its pane is closed');
});

test('an approver that ends without judging has its registry session ended before the replacement, which the role at concurrency 1 then admits', async () => {
  const registry = approverSlot();
  const { config, herdr, clock, work, decisions, cycle } = await approverLoop('registry-relaunch', ['env-a', 'env-b'], () => registry.effects);
  registry.slot.herdr = herdr;
  const state = emptyDaemonState(config);
  await cycle(state);
  // The approver stops with no limit notice and no judgement: a declined or dropped prompt.
  herdr.agents.find(agent => agent.name === approverSessionName(work, decisions[0].id))!.agent_status = 'idle';
  clock.skewMs += 61_000;
  const relaunch = await cycle(state);
  assert.equal(relaunch.actions.find(action => action.kind === 'failover'), undefined, 'no limit notice, so no failover');
  assert.deepEqual(registry.ended, ['registry-slot-1'], 'the ended approver\'s registry session is ended');
  assert.deepEqual([...registry.live], ['registry-slot-2'], 'the replacement holds the slot');
  const watch = Object.values(state.approvals)[0];
  assert.deepEqual([watch.session, watch.launches], ['registry-slot-2', 2], JSON.stringify(relaunch.actions));
});

test('an exhausted escalation handler\'s record survives a failed relaunch, which a later cycle retries; with no account left the wait reaches the item through the runtime-login hold', async () => {
  const root = await localRoot('escalation-retry');
  const at = Date.now(), notice = "You've hit your weekly limit · resets Sep 26, 10pm";
  const ended: string[] = [], relaunches: string[] = [];
  let failWith: 'fault' | 'capacity' | null = 'fault';
  const { config, herdr, clock, work, cycle } = await approverLoop('escalation-retry', ['env-a', 'env-b'], now => ({
    // No approver decision is involved: only the escalation handler's own records and effects.
    approver: undefined, decide: undefined,
    roleHealth: async () => ({ 'escalation-handler': await escalationRoleHealth(config, loginsOnly(now)) }),
    escalationSessions: () => readEscalationSessions(root),
    endEscalation: async (session, resolution, waiting) => {
      if (session.session) ended.push(session.session);
      await saveEscalationSession(root, session.work, session.trigger, waiting ? { ...session, pane: null, session: null, waiting } : null, now());
      herdr.agents = herdr.agents.filter(agent => agent.pane_id !== session.pane);
      void resolution;
    },
    relaunchEscalation: async session => {
      relaunches.push(session.trigger);
      if (failWith === 'fault') throw new Error('the context route answered 503');
      // The launch as `launchEscalationHandler` makes it: the runtime login is held, so nothing is left.
      if (failWith === 'capacity') { await selectAccount(config, 'escalation-handler', { name: escalationProfile }, { ...loginsOnly(now), work: session.work }); }
      const agentName = `gy-esc-${relaunches.length}`;
      herdr.agents.push({ name: agentName, pane_id: `pane-${agentName}`, agent_status: 'working' });
      await saveEscalationSession(root, session.work, session.trigger, { ...session, agentName, pane: `pane-${agentName}`, launchedAt: new Date(now()).toISOString(), session: null, waiting: null }, now());
      return { agentName, account: null };
    },
  }));
  // A handler a master launched on the registry, now stopped on its provider's notice.
  await saveEscalationSession(root, work.key, 'lease-loss', { agentName: 'gy-esc-0', pane: 'pane-gy-esc-0', work: work.key, trigger: 'lease-loss', kind: 'claude', account: null, runtime: 'claude', launchedAt: new Date(at).toISOString(), session: 'registry-esc-0', waiting: null }, at);
  herdr.agents.push({ name: 'gy-esc-0', pane_id: 'pane-gy-esc-0', agent_status: 'idle' });
  herdr.output['gy-esc-0'] = `  ⎿ ${notice}\n`;

  const state = emptyDaemonState(config);
  const first = await cycle(state);
  const failed = first.actions.find(action => action.kind === 'failover');
  assert.equal(failed?.state, 'failed', JSON.stringify(first.actions));
  assert.match(failed!.detail, /context route answered 503/);
  assert.deepEqual(ended, ['registry-esc-0'], 'the spent handler\'s registry session is ended with it');
  const kept = await readEscalationSessions(root);
  assert.equal(kept.length, 1, 'the only durable record of the escalation is not deleted by a failed relaunch');
  assert.ok(kept[0].waiting && Date.parse(kept[0].waiting.retryAt) <= clock.skewMs + Date.now(), 'it is due at once');

  // The next cycle retries it; this time no account is left: the runtime login the handler spent is held.
  failWith = 'capacity';
  clock.skewMs += 20_000;
  await cycle(state);
  assert.deepEqual(relaunches, ['lease-loss', 'lease-loss']);
  const waiting = await readEscalationSessions(root);
  assert.equal(waiting.length, 1);
  assert.ok(waiting[0].waiting && Date.parse(waiting[0].waiting.retryAt) > Date.now() + clock.skewMs, 'it waits for capacity');
  // The wait reaches Graphyard with no registry: the synthetic profile carries the held runtime login.
  clock.skewMs += 20_000;
  await cycle(state);
  const escalation = (await reload(work.id)).capacity!.escalations.find(entry => entry.role === 'escalation-handler');
  assert.ok(escalation, 'the escalation-handler capacity wait is recorded on the item');
  assert.deepEqual(escalation.accounts.map(entry => entry.account), [profileAccount(escalationProfile)]);

  // After the reset the loop alone launches it again, and the running handler replaces the waiting record.
  failWith = null;
  clock.skewMs = Date.parse(parseResetTime(notice, at)!) - Date.now() + 24 * 3_600_000;
  await cycle(state);
  await cycle(state);
  assert.equal(relaunches.length >= 3, true, JSON.stringify(relaunches));
  const running = await readEscalationSessions(root);
  assert.deepEqual(running.map(entry => [entry.trigger, entry.waiting]), [['lease-loss', null]]);
});

test('an escalation handler that finishes with no limit notice has its registry session, pane and record ended, so a second escalation launches at the role\'s concurrency of 1', async () => {
  const root = await localRoot('escalation-finished');
  const ended: string[] = [], closed: string[] = [];
  // The registry's escalation-handler role at its default concurrency of 1: one live session holds the slot.
  const slots = new Set<string>();
  const launchHandler = async (work: string, trigger: string, at: number) => {
    if (slots.size >= 1) throw new Error(`escalation-handler is at its concurrency limit of 1 (${[...slots].join(', ')})`);
    const session = `registry-esc-${trigger}`, agentName = `gy-esc-${trigger}`;
    slots.add(session);
    herdr.agents.push({ name: agentName, pane_id: `pane-${agentName}`, agent_status: 'working' });
    await saveEscalationSession(root, work, trigger, { agentName, pane: `pane-${agentName}`, work, trigger, kind: 'claude', account: 'env-a', runtime: 'claude', launchedAt: new Date(at).toISOString(), session, waiting: null }, at);
  };
  const { config, herdr, clock, work, cycle, now } = await approverLoop('escalation-finished', ['env-a', 'env-b'], now => ({
    approver: undefined, decide: undefined,
    roleHealth: async () => ({ 'escalation-handler': await escalationRoleHealth(config, loginsOnly(now)) }),
    escalationSessions: () => readEscalationSessions(root),
    markEscalation: session => saveEscalationSession(root, session.work, session.trigger, session, now()),
    // As `master run` wires it: the registry session ends, the pane closes and the record goes.
    endEscalation: async (session, _resolution, waiting) => {
      if (session.session) { ended.push(session.session); slots.delete(session.session); }
      if (session.pane) { closed.push(session.pane); herdr.agents = herdr.agents.filter(agent => agent.pane_id !== session.pane); }
      await saveEscalationSession(root, session.work, session.trigger, waiting ? { ...session, pane: null, session: null, waiting, idleSince: undefined } : null, now());
    },
    relaunchEscalation: async () => { throw new Error('a finished handler is never launched again'); },
  }));
  await launchHandler(work.key, 'lease-loss', now());
  await assert.rejects(launchHandler(work.key, 'stalled', now()), /concurrency limit/, 'the running handler holds the slot');
  const state = emptyDaemonState(config);
  await cycle(state);
  assert.deepEqual([ended, closed], [[], []], 'a working handler is left alone');

  // It records its decision and stops. Herdr reports a session idle while a command runs too, so one sighting ends nothing.
  herdr.agents.find(agent => agent.name === 'gy-esc-lease-loss')!.agent_status = 'idle';
  herdr.output['gy-esc-lease-loss'] = '  ⎿ Recorded the decision; stopping.\n';
  await cycle(state);
  assert.deepEqual(ended, []);
  assert.ok((await readEscalationSessions(root))[0].idleSince, 'the first stopped sighting is noted on the record');
  // Working again clears it; stopped again starts the grace afresh.
  herdr.agents.find(agent => agent.name === 'gy-esc-lease-loss')!.agent_status = 'working';
  clock.skewMs += 20_000; await cycle(state);
  assert.equal((await readEscalationSessions(root))[0].idleSince, undefined);
  herdr.agents.find(agent => agent.name === 'gy-esc-lease-loss')!.agent_status = 'done';
  clock.skewMs += 20_000; await cycle(state);
  clock.skewMs += handlerSettleMs - 1_000; await cycle(state);
  assert.deepEqual(ended, [], 'not before the grace has passed');

  clock.skewMs += 2_000;
  const finished = await cycle(state);
  const close = finished.actions.find(action => action.kind === 'close');
  assert.equal(close?.state, 'done', JSON.stringify(finished.actions));
  assert.match(close!.detail, /Ended escalation handler gy-esc-lease-loss .* stopped with no limit notice/);
  assert.deepEqual([ended, closed], [['registry-esc-lease-loss'], ['pane-gy-esc-lease-loss']], 'its registry session and pane are ended');
  assert.deepEqual(await readEscalationSessions(root), [], 'and its record dropped');
  assert.ok(!finished.actions.some(action => action.kind === 'failover'), 'a finished handler is not failed over');
  assert.deepEqual((await reload(work.id)).capacity?.exhaustions ?? [], [], 'nor recorded as spent');

  // The second escalation takes the freed slot. When its pane is gone from Herdr, it is ended at once.
  await launchHandler(work.key, 'stalled', now());
  herdr.agents = herdr.agents.filter(agent => agent.name !== 'gy-esc-stalled');
  await cycle(state);
  assert.deepEqual(ended, ['registry-esc-lease-loss'], 'not while a just-launched session may not be listed yet');
  clock.skewMs += launchAppearanceMs + 1_000;
  await cycle(state);
  assert.deepEqual(ended, ['registry-esc-lease-loss', 'registry-esc-stalled']);
  assert.deepEqual(await readEscalationSessions(root), []);
  assert.equal(slots.size, 0);
});

test('a re-keyed approval watch carries its session\'s account, runtime and registry session, so a retained session\'s exhaustion holds the account it spent', () => {
  const prior = approvalWatchSchema.parse({ work: 'GY-1', action: 'rework', decision: 'decision-1', requestedAt: new Date().toISOString(),
    launches: 1, agentName: 'graphyard-approver-GY-1-abc123', pane: 'pane-7', launchedAt: new Date().toISOString(), account: 'env-a', runtime: 'claude', session: 'registry-session-9' });
  const carried = carriedSession(prior);
  assert.deepEqual([carried.agentName, carried.pane, carried.launches, carried.account, carried.runtime, carried.session], [prior.agentName, 'pane-7', 1, 'env-a', 'claude', 'registry-session-9']);
});
