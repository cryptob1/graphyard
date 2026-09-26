import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { processJob } from '../src/github.js';
import { Refusal, type Principal, type Work } from '../src/model.js';
import { approverSessionName, decisionInput, masterConfigSchema, mergeExecutor, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { diagnosticianSettings, diagnosisSettled } from '../src/runner/payloads.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import type { DiagnosticianEffects } from '../src/daemon/diagnosis.js';
import { Launcher } from '../src/daemon/cycle.js';
import { successorWidening } from '../src/model/successors.js';
import { systemInvariants, type InvariantCheck } from '../src/model/invariants.js';
import { SimulatedGitHub, SimulatedHerdr, clock, clockSql, hour, minute, sha } from './helpers/soak-world.js';

/**
 * GY-404: per-item gates cannot catch faults that emerge from interaction over time, so this runs
 * the real loop — `runCycle` with the real engine on the test Postgres, the real reconciliation job
 * (`processJob`) and the real guarded merge — against a deterministic simulated GitHub, Herdr and
 * clock for a simulated day, and asserts after every cycle that every system invariant
 * (src/model/invariants.ts) holds. Fifteen items pass through it: released every fifteen minutes so
 * a merge lands about every fifteen, three sent back by their reviewer, two whose worker dies, two
 * production deploys, a file split on main that re-plans an item, one pull request GitHub reports
 * CLEAN at once and one UNSTABLE, and a reviewer bot out of quota that fails over. The plane also
 * reports a held integration job in three separate windows, so the `held-jobs` fault class recurs
 * past its threshold and the loop files one recurring-fault item for it (GY-173): the diagnostician
 * (GY-439) is wired as a fake, so the real loop diagnoses the recurring item within the cycle that
 * files it and closes it, on the approved two-party decision, as a duplicate of an open item —
 * once, never again per cycle, with the approver session closed once the decision settles. Every
 * one of the fifteen must be delivered. The loop carries one `Launcher` across its cycles (GY-616),
 * as `runDaemon` does, so session launches run beside the cycle — outliving it, holding their
 * profile from hand-off, and reported by the next cycle — and the invariants hold on that detached
 * path. A change to the loop that breaks an invariant fails here, in CI, before it merges; a new
 * behaviour that repeats per cycle, head or item belongs in this world.
 */
const repository = 'owner/project';
const PROOF = 'unit:soak-behaves';
const principals = {
  operator: { id: 'operator', role: 'admin', sessionKind: 'ai' },
  operatorAgent: { id: 'graphyard-master-operator', role: 'admin', sessionKind: 'ai' },
  approver: { id: 'graphyard-approver', role: 'admin', sessionKind: 'ai' },
  coordinator: { id: 'graphyard-master', role: 'coordinator' },
  producer: { id: 'proof-runner', role: 'producer', proofs: [PROOF] },
} satisfies Record<string, Principal>;
const workers: WorkerProfile[] = ['one', 'two', 'three'].map(name => ({ name, principal: `worker-${name}`, agentName: `soak-worker-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} }) as WorkerProfile);
const everyone: Principal[] = [...Object.values(principals), ...workers.map(profile => ({ id: profile.principal, role: 'worker' as const }))];
const credentials = everyone.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(entry => entry.id === principal.id)!.token;
const reviewerApps = [{ id: 'claude-reviewer', runtime: 'claude', appId: 55_001, botUserId: 55_002 }, { id: 'cursor-reviewer', runtime: 'cursor', appId: 66_001, botUserId: 66_002 }];
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234,
  hostId: 'soak-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers,
  operatorAgent: { id: principals.operatorAgent.id, credentialFile: '/outside/operator.token' }, approver: { id: principals.approver.id, credentialFile: '/outside/approver.token' },
  run: { proofWorkflow: 'acceptance.yml', intervalSeconds: 60 } });

/** The day, in simulated time from the start. */
const start = Date.parse('2031-06-02T08:00:00Z');
const plan = {
  items: 15, releaseEveryMs: 15 * minute, workMs: 20 * minute,
  rework: new Set([3, 7, 11]), deaths: new Set([5, 9]), deathAfterMs: 8 * minute,
  deploys: [2 * hour + 30 * minute, 5 * hour], split: { at: 45 * minute, item: 12 }, clean: 2, unstable: 4, slowRecompute: 8, exhaustedReviewer: 6,
  // The control plane's held integration job, standing in three separate windows: three instances
  // of the `held-jobs` fault class inside the recurrence window, so the loop files the class's one
  // recurring item and the diagnostician diagnoses it (GY-439).
  heldJob: { at: [40, 80, 120].map(offset => offset * minute), forMs: 2 * minute },
};
const file = (n: number) => `src/soak/item-${n}.ts`;

/**
 * The diagnostician's answer, derived the way a read-only session would from the evidence the
 * prompt carries: the cause is the held integration job standing for the class, and the answer is
 * the newest open item listed as covering the cause. The payload goes through the options' own
 * validation, exactly as a real run's tool call does.
 */
function diagnosisRunner(seen: { subject: string }[]): Runner {
  return {
    name: 'soak-diagnostician',
    start<T>(prompt: string, options: RunOptions<T>) {
      const given = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { subject: string; faultClass: string; instances: { at: string }[]; openItems: string[] };
      seen.push({ subject: given.subject });
      const open = given.openItems.map(line => /^GY-(\d+)/.exec(line)?.[1]).filter((key): key is string => !!key && `GY-${key}` !== given.subject);
      const payload = {
        subject: given.subject,
        cause: 'The integration job queue held the same sync job on a permission shortfall that clears on its own; the loop already tracks the class, so the newest open item covers the cause',
        evidence: {
          logLines: [`${given.instances.at(-1)?.at ?? 'unknown'} held-jobs on installation: 1 integration job(s) held on a permission shortfall`],
          commands: ['graphyard master status — the held-jobs line stood in three separate windows and was absent between them'],
        },
        faultClass: given.faultClass,
        covering: open.length ? `GY-${Math.max(...open.map(Number))}` : null,
        fix: null,
      };
      let result: RunResult<T>;
      try { const parsed = options.validate(payload); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
      catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
      return { id: `soak-diagnosis-${seen.length}`, events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  };
}

let pgServer: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail in their `before` hook.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 404;
  pgServer = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-soak-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pgServer.initialise(); await pgServer.start(); await pgServer.createDatabase('soak_test');
  const connection = `postgres://graphyard:testing-only@127.0.0.1:${port}/soak_test`;
  // The database reads the simulated clock: its time functions are shadowed before the schema exists.
  const setup = new pg.Client({ connectionString: connection });
  await setup.connect();
  for (const statement of clockSql) await setup.query(statement);
  await setup.query('ALTER DATABASE soak_test SET search_path = public, pg_catalog');
  await setup.end();
  clock.install(start);
  store = new Store(connection); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  engine.principals = everyone; engine.reviewerApps = reviewerApps; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { clock.uninstall(); if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pgServer) await pgServer.stop(); });

const id = () => randomUUID();
async function api(principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
  return result;
}

/**
 * One simulated day of the loop against this world. `regression` injects a fault into the loop's own
 * effects, standing for a change that breaks an invariant, so the soak shows it would fail.
 */
let days = 0;
async function simulateDay(options: { hours: number; regression?: 'approvers-left-open' }) {
  const dayStart = clock.now();
  const github = new SimulatedGitHub({ repository, baseBranch: 'main', appId: 1234, ciAppId: 15368, reviewerApps, ciMs: 5 * minute, reviewMs: 3 * minute, firstPullRequest: 100 * ++days },
    [...Array.from({ length: plan.items }, (_, index) => file(index + 1)), 'README.md']);
  const herdr = new SimulatedHerdr();
  const adapter = github.adapter();
  const moveClock = async (ms: number) => { clock.advance(ms); await store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]); };
  await moveClock(0);

  // ---- The fifteen items, created in the backlog and released one every fifteen minutes. ----
  const items: Work[] = [];
  for (let n = 1; n <= plan.items; n++) {
    let work = await engine.execute(principals.operator, 'create', null, { title: `Soak item ${n}`, plannedFiles: [file(n)], criteria: [{ id: 'AC-1', text: `Item ${n} behaves`, proofs: [PROOF] }] }, id());
    if (n === plan.exhaustedReviewer) work = await engine.execute(principals.operator, 'reviewpolicy', work.id, { provider: 'agent', expectedPolicyRevision: work.policyRevision, reason: 'Reviewed by the reviewer bots',
      reviewerProfiles: [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer' }, { name: 'cursor-reviewer', runtime: 'cursor', reviewerApp: 'cursor-reviewer' }] }, id());
    items.push(work);
  }
  const numberOf = (work: Pick<Work, 'key'>) => items.findIndex(item => item.key === work.key) + 1;
  for (const n of plan.rework) github.verdicts.set(items[n - 1].key, ['CHANGES_REQUESTED']);
  github.unstable.add(items[plan.unstable - 1].key); github.slowRecompute.add(items[plan.slowRecompute - 1].key);
  github.exhaustedProfiles.add('claude-reviewer');

  // ---- Workers: the loop dispatches, the simulated session claims, works, pushes and submits (or dies). ----
  interface Session { work: string; key: string; branch: string; profile: WorkerProfile; epoch: number; pane: string; pushAt: number; diesAt: number | null; state: 'working' | 'submitted' | 'dead' }
  const sessions: Session[] = [], lost: string[] = [];
  const attempts = new Map<string, number>();
  const principalOf = (profile: WorkerProfile): Principal => ({ id: profile.principal, role: 'worker' });
  const dispatch: DaemonEffects['dispatch'] = async (work, profile) => {
    const principal = principalOf(profile);
    const claimed = await engine.execute(principal, 'claim', work.id, {}, id());
    const epoch = claimed.epoch, key = work.key, n = numberOf(work);
    // A rework attempt pushes to the pull request already linked, from a fresh workspace.
    const branch = work.candidate?.branch ?? `graphyard/${key.toLowerCase()}-${epoch}`;
    await engine.execute(principal, 'workspace', work.id, { epoch, host: 'soak-host', path: `/tmp/soak/${key.toLowerCase()}-${epoch}`, branch }, id());
    const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
    const pane = herdr.open(profile.agentName);
    sessions.push({ work: work.id, key, branch, profile, epoch, pane, pushAt: clock.now() + plan.workMs, diesAt: plan.deaths.has(n) && attempt === 1 ? clock.now() + plan.deathAfterMs : null, state: 'working' });
    return { key, epoch };
  };
  const workersTick = async (now: number) => {
    for (const session of sessions.filter(entry => entry.state === 'working')) {
      if (session.diesAt !== null && now >= session.diesAt) { herdr.kill(session.pane); session.state = 'dead'; continue; }
      const principal = principalOf(session.profile);
      if (now < session.pushAt) {
        // A renewal refused is lease loss: the supervisor stops the session, as `watch` does.
        try { await engine.execute(principal, 'heartbeat', session.work, { epoch: session.epoch }, id()); }
        catch (error) { if (!(error instanceof Refusal)) throw error; herdr.kill(session.pane); session.state = 'dead'; lost.push(`${session.key} epoch ${session.epoch}: ${error.message}`); }
        continue;
      }
      const pr = github.push(session.key, session.branch, principal.id, sha('head', session.key, session.epoch), [file(numberOf(session))]);
      await engine.execute(principal, 'submit', session.work, { epoch: session.epoch, pr: pr.number, documentation: 'A simulated item: it changes no documented behaviour' }, id());
      session.state = 'submitted';
      herdr.status(session.pane, 'done');
    }
  };

  // ---- Approvers and producers: sessions the loop launches, each acting on the minute after. ----
  const pending: (() => Promise<void>)[] = [];
  const approverPanes: string[] = [];
  const approver: DaemonEffects['approver'] = async (work, decision) => {
    const agentName = approverSessionName(work, decision), pane = herdr.open(agentName);
    approverPanes.push(pane);
    pending.push(async () => { await api(principals.approver, 'POST', `work/${work.id}/approve`, { decision, reason: `Approved: the loop's routine ${decision} decision for ${work.key} rests on what it verified` }); herdr.status(pane, 'done'); });
    return { agentName, pane };
  };
  const requestProof: DaemonEffects['requestProof'] = work => {
    pending.push(async () => {
      const current = (await store.list()).find(item => item.id === work.id)!;
      if (!current.candidate || current.candidate.sha !== work.candidate?.sha || current.stage === 'done') return;
      await engine.execute(principals.producer, 'evidence', current.id, { proof: PROOF, sha: current.candidate.sha, baseSha: current.candidate.baseSha, policyRevision: current.policyRevision, result: 'pass', executed: 4, skipped: 0,
        exercise: { criterion: 'AC-1', behaviour: `item ${numberOf(current)}'s change`, result: 'fail', executed: 1 } }, id());
    });
  };

  // ---- Production: two deploys, each a new control-plane build serving the base tip it was cut from. ----
  const production = { build: sha('build', 0), sha: github.tip, deploys: [] as { at: number; build: string; sha: string }[] };
  const snapshot = async () => { const read = await store.coordinationSnapshot(); return { work: read.work, now: read.now, jobs: read.jobs }; };
  const transport = async (path: string, data: any, key: string = id()) => {
    const match = /^work\/([^/]+)\/merge-acquire$/.exec(path);
    if (!match) throw new Error(`Unexpected mutation ${path}`);
    try { return await engine.requestEnqueue(principals.coordinator, match[1], data, key); }
    catch (error) { if (error instanceof Refusal) throw Object.assign(new Error(JSON.stringify({ error: error.message })), { confirmedRefusal: error.status >= 400 && error.status < 500 }); throw error; }
  };
  // One executor instance for the loop's process, and a fresh request per merge the loop asks for, as `master run` wires it.
  const executor = { principal: principals.coordinator.id, instance: `soak-${randomUUID()}` };
  const merge: DaemonEffects['merge'] = work => mergeExecutor(config, snapshot, transport, executor, randomUUID(), github.gh(repository))(work);
  // The diagnostician (GY-439), faked: its run answers from the evidence the prompt carries, and
  // its filing and deciding ride the same routes the production wiring uses, as the master's
  // operator-agent identity.
  const settings = diagnosticianSettings({ diagnostician: { invariantBoundMinutes: 30 } });
  const diagnosed: { subject: string }[] = [];
  const diagnostician: DiagnosticianEffects = {
    settings, cwd: '/tmp/soak/checkout',
    runner: async attempt => ({ runner: diagnosisRunner(diagnosed), runtime: `soak-${attempt}`, model: attempt === 'primary' ? settings.model : settings.fallbackModel }),
    context: async () => ({ journal: [`${new Date(clock.now()).toISOString()} graphyard-master: 1 integration job(s) held on a permission shortfall`], serverLog: [`${new Date(clock.now()).toISOString()} POST /api/status 200`], pullRequests: [] }),
    file: (input, key) => engine.execute(principals.operatorAgent, 'create', null, input, key),
    decide: (work, action, reason, input = {}) => api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }),
  };
  // The control plane's status read the faults are classified from; `heldJobs` is the flap below.
  let heldJobs = false;
  const effects: DaemonEffects = {
    agents: () => herdr.list(),
    herdr: () => ({ agents: herdr.list(), available: true }),
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    snapshot, dispatch, requestProof, approver, merge,
    closeSession: pane => { if (options.regression === 'approvers-left-open' && /approver/.test(herdr.agents.get(pane)?.name ?? '')) return; herdr.close(pane); },
    decide: (work, action, reason, input = {}) => api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }),
    decisions: work => api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`),
    withdraw: (work, decision, reason) => api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason }),
    faultClassPolicy: { threshold: 3, windowHours: 24 },
    fileFaultClass: (input, key) => engine.execute(principals.operatorAgent, 'create', null, input, key),
    diagnostician,
    baseSuccessions: async since => ({ tip: github.tip, successions: github.successions.filter(entry => github.commits.get(entry.commit)!.at >= Date.parse(since)), files: new Set(github.files) }),
    replan: (work, paths, reason) => api(principals.operatorAgent, 'POST', `work/${work.id}/requirements`, successorWidening(work, paths, reason)),
    controlPlane: async () => ({ build: { commit: production.build }, ...(heldJobs ? { heldJobs: 1 } : {}) }),
    observeDeployment: async delivered => {
      const serving = delivered.filter(item => github.contains(production.sha, item.delivery!.mergeSha));
      return { source: 'endpoint', sha: production.sha, at: new Date(clock.now()).toISOString(), reason: null, deployed: serving.map(item => item.key), pending: delivered.filter(item => !serving.includes(item)).map(item => item.key) };
    },
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  };

  // ---- The day. ----
  const state = emptyDaemonState(config);
  // Session launches run beside the cycle (GY-616): the loop carries one launcher across its
  // cycles, the way `runDaemon` does, and a launch settles in the interval after the cycle that
  // handed it over — here, before the simulated clock moves on.
  const launcher = new Launcher();
  const violations: string[] = [], observed = new Set<string>(), failures: string[] = [];
  let released = 0, split = false, deploys = 0, cycles = 0, reportedDispatches = 0;
  const jobsDue = async () => Number((await store.pool.query('SELECT count(*) AS due FROM jobs WHERE available_at<=now() AND (held_until IS NULL OR held_until<=now()) AND (locked_until IS NULL OR locked_until<now())')).rows[0].due);
  for (let elapsed = 0; elapsed <= options.hours * hour;) {
    const now = clock.now();
    // Scheduled events: releases, the file split on main, the deploys.
    while (released < plan.items && elapsed >= released * plan.releaseEveryMs) await engine.execute(principals.operator, 'ready', items[released++].id, {}, id());
    if (!split && elapsed >= plan.split.at) {
      split = true;
      const from = file(plan.split.item), successors = [`src/soak/item-${plan.split.item}-a.ts`, `src/soak/item-${plan.split.item}-b.ts`];
      const commit = github.commit(`Split ${from}\n\nGraphyard-Successor: ${from} -> ${successors.join(', ')}`, [...github.files.filter(path => path !== from), ...successors]);
      github.successions.push(...successors.map(to => ({ from, to, commit: commit.sha, similarity: 70 })));
    }
    const deploying = deploys < plan.deploys.length && elapsed >= plan.deploys[deploys];
    if (deploying) { production.build = sha('build', ++deploys); production.sha = github.tip; production.deploys.push({ at: now, build: production.build, sha: production.sha }); }
    // The plane reports its held integration job only inside the flap windows (GY-439's recurring fault).
    heldJobs = plan.heldJob.at.some(at => elapsed >= at && elapsed < at + plan.heldJob.forMs);
    // The world moves: GitHub, then the sessions. A deploy restarts the control plane once the
    // sessions have renewed: for the rest of that minute nothing reaches it, the loop included.
    github.tick(now);
    await workersTick(now);
    if (!deploying) {
      for (const act of pending.splice(0)) await act();
      await engine.reconcile();
      for (let guard = 0; guard < 200 && await jobsDue(); guard++) await processJob(engine, adapter);
      try {
        const result = await runCycle(config, state, effects, clock.now, launcher); cycles++;
        reportedDispatches += result.actions.filter(action => action.kind === 'dispatch' && action.state === 'done').length;
        if (process.env.SOAK_TRACE) for (const action of result.actions) console.error(`+${Math.round(elapsed / minute)} ${action.kind} ${action.state} ${action.work ?? ''}: ${action.detail.slice(0, 300)}`);
      }
      catch (error) { failures.push(`${new Date(now).toISOString()}: ${error instanceof Error ? error.message : String(error)}`); }
      // The interval between cycles is when a hand-off launch settles; the day's clock waits for
      // them so the world never acts on a half-finished launch.
      await launcher.idle();
      for (const check of state.invariants.report as InvariantCheck[]) {
        if (check.observed) observed.add(check.invariant);
        if (!check.holds) violations.push(`${new Date(now).toISOString()} (+${Math.round(elapsed / minute)} min) ${check.line}`);
      }
    }
    const open = (await store.list()).filter(item => item.stage !== 'done').length;
    const step = open ? minute : 10 * minute;
    elapsed += step; await moveClock(step);
  }

  const final = (await store.list()).filter(item => items.some(entry => entry.id === item.id));
  return { items, final, github, sessions, lost, violations, observed, failures, production, cycles, reportedDispatches, state, dayStart, approverPanes, herdrClosed: herdr.closed, diagnosisModel: settings.model };
}

test('unit:soak-invariants-hold — a simulated day of the real loop: fifteen items delivered and every system invariant holding after every cycle', { timeout: 180_000 }, async () => {
  const began = performance.now();
  const { items, final, github, sessions, lost, violations, observed, failures, production, cycles, reportedDispatches, state, dayStart, approverPanes, herdrClosed, diagnosisModel } = await simulateDay({ hours: Number(process.env.SOAK_HOURS ?? 24) });
  const undelivered = final.filter(item => item.stage !== 'done' || !item.delivery);
  assert.deepEqual(undelivered.map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease: a dead worker lapses, it is not refused');
  assert.deepEqual([...observed].sort(), [...systemInvariants].sort(), 'every invariant was observed, not merely left unread');
  // The day held what it was meant to: a merge about every fifteen minutes, the rework rounds, the deaths,
  // the deploys, the split, both merge states, auto-merge, and the failover.
  assert.equal(github.merges.length, plan.items, 'fifteen merges');
  const gaps = github.merges.slice(1).map((entry, index) => entry.at - github.merges[index].at).sort((a, b) => a - b);
  assert.ok(Math.abs(gaps[Math.floor(gaps.length / 2)] - 15 * minute) <= 5 * minute, `a merge about every fifteen minutes: ${github.merges.map(entry => `${entry.key} +${Math.round((entry.at - dayStart) / minute)} min`).join(', ')}`);
  assert.ok(github.merges.some(entry => entry.key === items[plan.clean - 1].key && entry.state === 'CLEAN' && entry.mode === 'immediate'), `a CLEAN pull request merged at once: ${JSON.stringify(github.merges)}`);
  assert.ok(github.merges.some(entry => entry.key === items[plan.unstable - 1].key && entry.state === 'UNSTABLE' && entry.mode === 'immediate'), 'an UNSTABLE pull request merged at once');
  assert.ok(github.merges.some(entry => entry.key === items[plan.slowRecompute - 1].key && entry.mode === 'auto-merge'), 'one GitHub reported BLOCKED when asked was set to auto-merge, and GitHub merged it once it recomputed');
  assert.equal(final.reduce((total, item) => total + (item.pipeline?.reworkRounds ?? 0), 0), plan.rework.size, 'three rework rounds');
  assert.equal(sessions.filter(session => session.state === 'dead').length, plan.deaths.size, 'two workers died');
  // Every dispatch the launcher settled was reported by a later cycle (GY-616): one dispatch-done
  // per session, none lost between the hand-off and the drain.
  assert.equal(reportedDispatches, sessions.length, 'each settled dispatch launch was reported to a cycle');
  assert.equal(production.deploys.length, plan.deploys.length, 'two production deploys');
  assert.ok(final.find(item => item.key === items[plan.split.item - 1].key)!.plannedFiles.includes(`src/soak/item-${plan.split.item}-a.ts`), 'the split file re-planned its item onto the successors');
  const reviewed = final.find(item => item.key === items[plan.exhaustedReviewer - 1].key)!;
  assert.ok(reviewed.reviewFailovers?.some(failover => failover.profile === 'claude-reviewer' && failover.exhaustion === 'usage-limit' && failover.nextProfile === 'cursor-reviewer'), `the exhausted reviewer bot failed over to the next profile: ${JSON.stringify(reviewed.reviewFailovers)}`);
  // The diagnostician (GY-439) rode the same day. The three held-job windows recur past the
  // threshold, so the loop files the class's one recurring item and diagnoses it within the cycle
  // that files it, and the day's own churn (the dead workers' leases, the delivery budget) recurs
  // into further classes beside it. Every filed item is diagnosed once, never relaunched per
  // cycle, and closed as a duplicate of the open item its diagnosis named, on the approved
  // two-party decision, with its approver session closed once the decision settled.
  const filedFaultItems = (await store.list()).filter(item => item.origin?.faultClass);
  assert.ok(filedFaultItems.length >= 1, `the day filed recurring-fault items: ${filedFaultItems.map(item => `${item.key} (${item.origin!.faultClass!.class})`).join(', ')}`);
  assert.deepEqual(Object.keys(state.diagnoses).sort(), filedFaultItems.map(item => item.key).sort(), 'one diagnosis per filed item, none relaunched per cycle');
  const byKey = new Map(filedFaultItems.map(item => [item.key, item]));
  for (const [subject, diagnosis] of Object.entries(state.diagnoses)) {
    const item = byKey.get(subject)!;
    assert.ok(diagnosisSettled(diagnosis), `${subject}'s diagnosis settled: ${diagnosis.state} ${diagnosis.detail}`);
    assert.equal(diagnosis.kind, 'recurring');
    assert.equal(diagnosis.faultClass, item.origin!.faultClass!.class);
    assert.equal(item.stage, 'done', `${subject} was closed on its diagnosis`);
    assert.deepEqual([item.closure?.kind, item.closure?.ref], ['duplicate', diagnosis.answeredBy], `${subject} was closed as the duplicate of the item its diagnosis answered it with`);
    if (diagnosis.state === 'answered') {
      assert.ok(diagnosis.diagnosis!.covering, `${subject}'s diagnosis named an open item as covering the cause`);
      assert.equal(diagnosis.answeredBy, diagnosis.diagnosis!.covering);
      assert.ok(diagnosis.decision && diagnosis.decision.action === 'close' && diagnosis.decision.approver, `${subject}'s closure rode an approved two-party decision with an independent approver`);
    }
  }
  // The injected class, end to end: three instances in the window, one item, one primary run,
  // every instance linked to it, and no fix item filed for a covering diagnosis.
  const heldJobs = state.faults.instances.filter(entry => entry.kind === 'held-jobs');
  assert.equal(heldJobs.length, plan.heldJob.at.length, `one instance per held-job window: ${JSON.stringify(heldJobs.map(entry => entry.at))}`);
  const configuration = filedFaultItems.filter(item => item.origin!.faultClass!.class === 'configuration');
  assert.equal(configuration.length, 1, 'the held-job class filed exactly one recurring item');
  const configurationKey = configuration[0].key, configurationDiagnosis = state.diagnoses[configurationKey];
  assert.ok(heldJobs.every(entry => entry.linkedTo === configurationKey), 'every held-job instance links to the recurring item, so none files again');
  assert.equal(configurationDiagnosis.state, 'answered', `the held-job diagnosis was answered: ${configurationDiagnosis.detail}`);
  assert.deepEqual(configurationDiagnosis.runs.map(entry => [entry.model, entry.result]), [[diagnosisModel, 'diagnosed']], 'one primary run diagnosed it, no fallback needed');
  assert.ok(!(await store.list()).some(item => /Filed by the master loop from the diagnostician's diagnosis/.test(item.description ?? '')), 'the covering diagnoses filed no fix item');
  assert.ok(approverPanes.length > 0, 'the day launched approver sessions for its decisions');
  assert.deepEqual(approverPanes.filter(pane => !herdrClosed.includes(pane)), [], `every approver session the day launched was closed once its decision settled: ${JSON.stringify(herdrClosed)}`);
  assert.ok(cycles > 24 * 6, `the loop cycled through the day (${cycles} cycles)`);
  const seconds = (performance.now() - began) / 1000;
  assert.ok(seconds < 120, `the day runs well inside the three minutes the CI test job allows it (${seconds.toFixed(1)} s)`);
});

test('unit:soak-invariants-hold — a loop change that breaks an invariant fails the soak: approver sessions the loop no longer closes are named within the hour', { timeout: 120_000 }, async () => {
  // The regression GY-403 was: approvers finished, nobody closed them. Here the loop's close reports
  // success and closes nothing, which no per-item gate of any change would notice.
  const { violations, state } = await simulateDay({ hours: 3, regression: 'approvers-left-open' });
  assert.ok(violations.some(line => /lingering-sessions: VIOLATED — .*approver session graphyard-approver-gy-\d+-/.test(line)), `the soak names the lingering approver: ${violations.slice(0, 3).join('\n')}`);
  assert.ok(violations.every(line => /lingering-sessions/.test(line)), `nothing else is violated: ${violations.filter(line => !/lingering-sessions/.test(line)).slice(0, 3).join('\n')}`);
  // The violation is a fault of its class on the loop's record, which files one item when it recurs.
  assert.equal(state.faults.instances.filter(instance => instance.kind === 'invariant:lingering-sessions' && instance.faultClass === 'session-liveness').length, 1);
});
