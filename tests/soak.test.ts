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
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { Launcher } from '../src/daemon/cycle.js';
import { successorWidening } from '../src/model/successors.js';
import { systemInvariants, type InvariantCheck } from '../src/model/invariants.js';
import { performSelfUpgrade, type SelfUpgradeOutcome } from '../src/daemon/upgrade.js';
import { resetFollowUpMigration } from '../src/daemon/cycle-triage.js';
import { followUpItem, followUpTriageProof, type FollowUpFinding } from '../src/review-threads.js';
import { followUpParent } from '../src/model/machine-backlog.js';
import { clearTriageRuns, triageTool } from '../src/triage.js';
import type { Run, RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { SimulatedGitHub, SimulatedHerdr, clock, clockSql, hour, minute, sha } from './helpers/soak-world.js';

/**
 * GY-404: per-item gates cannot catch faults that emerge from interaction over time, so this runs
 * the real loop — `runCycle` with the real engine on the test Postgres, the real reconciliation job
 * (`processJob`) and the real guarded merge — against a deterministic simulated GitHub, Herdr and
 * clock for a simulated day, and asserts after every cycle that every system invariant
 * (src/model/invariants.ts) holds. Fifteen items pass through it: released every fifteen minutes so
 * a merge lands about every fifteen, three sent back by their reviewer, two whose worker dies, two
 * production deploys, a file split on main that re-plans an item, one pull request GitHub reports
 * CLEAN at once and one UNSTABLE, a reviewer bot out of quota that fails over, and the loop's
 * between-cycles self-upgrade (GY-437) against a simulated coordinator checkout that stands dirty
 * across the second deploy for a while. The day is also research-configured (`run.research`) and
 * carries the machine-filed backlog (GY-402): it starts from one follow-up item an earlier approval
 * of one item filed, the loop's first cycle asks for the one-time migration on the research account,
 * an approval mid-day files one more finding as the parent's fresh follow-up, and the triage step
 * judges each follow-up through its typed tool, every closure applied once the approver agrees.
 * Every one of the fifteen must be delivered. The loop
 * carries one `Launcher` across its cycles (GY-616), as `runDaemon` does, so session launches run
 * beside the cycle — outliving it, holding their profile from hand-off, and reported by the next
 * cycle — and the invariants hold on that detached path. A change to the loop that breaks an
 * invariant fails here, in CI, before
 * it merges; a new behaviour that repeats per cycle, head or item belongs in this world.
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
  run: { proofWorkflow: 'acceptance.yml', intervalSeconds: 60, research: {} } });

/** The day, in simulated time from the start. */
const start = Date.parse('2031-06-02T08:00:00Z');
const plan = {
  items: 15, releaseEveryMs: 15 * minute, workMs: 20 * minute,
  rework: new Set([3, 7, 11]), deaths: new Set([5, 9]), deathAfterMs: 8 * minute,
  deploys: [2 * hour + 30 * minute, 5 * hour], dirtyCheckout: { from: 4 * hour + 50 * minute, to: 6 * hour }, split: { at: 45 * minute, item: 12 }, clean: 2, unstable: 4, slowRecompute: 8, exhaustedReviewer: 6,
  // The item whose review carries a finding beyond its criteria (GY-402): its follow-ups are triaged.
  followUp: 13,
};
const file = (n: number) => `src/soak/item-${n}.ts`;

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
async function simulateDay(options: { hours: number; regression?: 'approvers-left-open'; handApprovers?: boolean }) {
  // Each day is a fresh loop process: the one-time follow-up migration is asked once per process,
  // and no triage run of a previous day is still counted in flight.
  resetFollowUpMigration(); clearTriageRuns();
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

  // ---- The machine-filed backlog (GY-402): the parent whose review carries a follow-up finding. ----
  const parent = items[plan.followUp - 1];
  // Each day starts with the follow-up an approval of this parent filed before the day began, in
  // the shape items carried before the origin did: its findings live in the numbered description.
  await engine.execute(principals.operator, 'create', null, {
    title: `Follow-ups from the approved review of ${parent.key} (PR #900)`,
    description: `The independent reviewer approved ${parent.key} at a head before this day (review 9000) and judged this finding FOLLOW-UP: beyond the item's criteria. Graphyard filed it here.\n\n1. Finding with no thread: ${file(plan.followUp)}:55 — the item's worker submits a head that already contains the base tip, so the merge lands the whole tree`,
    type: 'chore', priority: 2, dependencies: [parent.id],
    criteria: [{ id: 'AC-1', text: 'Each follow-up listed in the description is addressed in code, or declined with a recorded reason.', proofs: [followUpTriageProof] }],
    producerProofs: [followUpTriageProof], plannedFiles: [file(plan.followUp)],
    reason: `Follow-ups named by an earlier approval of ${parent.key}`,
  }, id());

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
  // GY-551: decisions a master requested and put to an approver by hand (`master approver`), whose
  // sessions all end without judging: the first vanishes or stops, each relaunch the loop makes
  // stops `done`, and one relaunch is refused by a registry timeout.
  const hand = new Map<string, { key: string; launches: number; refused: number }>();
  const approver: DaemonEffects['approver'] = async (work, decision) => {
    const unjudged = hand.get(decision);
    if (unjudged) {
      unjudged.launches += 1;
      if (unjudged.key === items[plan.items - 1].key && unjudged.launches === 1) { unjudged.refused += 1; throw new Error('the agent registry for the approver role is unreachable: timeout'); }
      const agentName = approverSessionName(work, decision), pane = herdr.open(agentName);
      pending.push(async () => { herdr.status(pane, 'done'); });
      return { agentName, pane };
    }
    const agentName = approverSessionName(work, decision), pane = herdr.open(agentName);
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

  // ---- Triage sessions (GY-402): the loop starts them for the machine-filed backlog on the research account. ----
  const triageStarts: { prompt: string; options: RunOptions<unknown> }[] = [];
  const research: Runner = {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      triageStarts.push({ prompt, options: options as RunOptions<unknown> });
      const result: RunResult<T> = options.tool === triageTool
        ? { ok: true, tool: options.tool, payload: options.validate({ outcome: 'close', reason: 'Not worth doing: the finding names the soak\'s simulated world, not the change under coordination' }), payloads: [] }
        : { ok: false, failure: { reason: 'no-payload', detail: 'the soak research account answers only the triage tool' }, payloads: [] };
      return { id: `triage-${triageStarts.length}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: () => Promise.resolve(result) };
    },
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
  const effects: DaemonEffects = {
    agents: () => herdr.list(),
    herdr: () => ({ agents: herdr.list(), available: true }),
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    snapshot, dispatch, requestProof, approver, merge,
    research: { cwd: '/soak/coordinator', runner: research },
    recordTriage: (work, body) => api(principals.coordinator, 'POST', `work/${work.id}/triage`, body),
    migrateFollowUps: () => api(principals.operatorAgent, 'POST', 'followups/migrate', {}),
    closeSession: pane => { if (options.regression === 'approvers-left-open' && /approver/.test(herdr.agents.get(pane)?.name ?? '')) return; herdr.close(pane); },
    decide: (work, action, reason, input = {}) => api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }),
    decisions: work => api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`),
    withdraw: (work, decision, reason) => api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason }),
    baseSuccessions: async since => ({ tip: github.tip, successions: github.successions.filter(entry => github.commits.get(entry.commit)!.at >= Date.parse(since)), files: new Set(github.files) }),
    replan: (work, paths, reason) => api(principals.operatorAgent, 'POST', `work/${work.id}/requirements`, successorWidening(work, paths, reason)),
    controlPlane: async () => ({ build: { commit: production.build } }),
    observeDeployment: async delivered => {
      const serving = delivered.filter(item => github.contains(production.sha, item.delivery!.mergeSha));
      return { source: 'endpoint', sha: production.sha, at: new Date(clock.now()).toISOString(), reason: null, deployed: serving.map(item => item.key), pending: delivered.filter(item => !serving.includes(item)).map(item => item.key) };
    },
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  };

  // ---- The coordinator checkout the loop runs from, and its supervisor (GY-437). ----
  // A detached checkout of the base branch, at the tip the day starts on; git answers from the
  // simulated GitHub, and a restart of the fleet or of the loop itself is recorded, not performed.
  const checkout = { head: github.tip, origin: github.tip, dirty: false };
  const upgrades = { fetches: 0, checkouts: [] as { at: number; from: string; to: string }[], executors: [] as string[], self: 0, outcomes: [] as SelfUpgradeOutcome['outcome'][] };
  /** The paths the base branch changed between two commits: every merged pull request's files, and what any other commit added or removed. */
  const changedPaths = (from: string, to: string) => {
    const paths = new Set<string>(), seen = new Set<string>(), queue = [to];
    while (queue.length) {
      const at = queue.pop()!;
      if (seen.has(at) || github.contains(from, at)) continue;
      seen.add(at);
      const commit = github.commits.get(at)!, merged = github.merges.find(entry => entry.sha === at);
      if (merged) for (const path of github.prs.get(merged.pr)!.files) paths.add(path);
      else if (commit.parents[0]) {
        const before = new Set(github.commits.get(commit.parents[0])!.files), after = new Set(commit.files);
        for (const path of [...before, ...after]) if (before.has(path) !== after.has(path)) paths.add(path);
      }
      if (!merged) queue.push(...commit.parents);
      else queue.push(commit.parents[0]);
    }
    return [...paths];
  };
  const coordinatorGit = async (command: string, args: string[]): Promise<string> => {
    assert.equal(command, 'git');
    const [op, ...operands] = args.slice(2);
    if (op === 'fetch') { upgrades.fetches++; checkout.origin = github.tip; return ''; }
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? checkout.head : checkout.origin}\n`;
    if (op === 'symbolic-ref') throw Object.assign(new Error('fatal: ref HEAD is not a symbolic ref'), { status: 1 });
    if (op === 'status') return checkout.dirty ? ' M src/master.ts\n' : '';
    if (op === 'diff') { const [from, to] = operands[1].split('..'); return `${changedPaths(from, to).join('\n')}\n`; }
    if (op === 'checkout') { assert.ok(!checkout.dirty, 'a dirty checkout is never touched'); upgrades.checkouts.push({ at: clock.now(), from: checkout.head, to: operands[2] }); checkout.head = operands[2]; return ''; }
    throw new Error(`the simulated coordinator checkout cannot answer git ${args.slice(2).join(' ')}`);
  };
  const selfUpgrade = (state: DaemonState) => performSelfUpgrade(config, state, {
    root: '/soak/coordinator', run: coordinatorGit, now: clock.now, persist: async () => {},
    restartExecutors: async to => { upgrades.executors.push(to); return { result: 'restarted', reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] }; },
    // The supervisor re-executes the loop: the next process loads the release the checkout holds, as runDaemon records it.
    restartSelf: async () => { upgrades.self++; state.release = { commit: checkout.head, dirty: checkout.dirty }; },
  });

  // ---- The day. ----
  const state = emptyDaemonState(config);
  /** The cursor's upgrade actions and the refusal's attempts, sampled every cycle the checkout stood refused. */
  const refusalSamples: { keys: number; attempts: number }[] = [];
  // Session launches run beside the cycle (GY-616): the loop carries one launcher across its
  // cycles, the way `runDaemon` does, and a launch settles in the interval after the cycle that
  // handed it over — here, before the simulated clock moves on.
  const launcher = new Launcher();
  const violations: string[] = [], observed = new Set<string>(), failures: string[] = [], escalations: string[] = [], spent = new Set<string>();
  let released = 0, split = false, deploys = 0, cycles = 0, reportedDispatches = 0, approvalFiled = false;
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
    // GY-551: twenty minutes in, the master requests a release of the last two items by hand and
    // puts each to an approver session it launches itself; neither session judges it.
    if (options.handApprovers && elapsed === 20 * minute) for (const [n, ending] of [[plan.items, 'vanishes'], [plan.items - 1, 'stops']] as const) {
      const current = (await store.list()).find(item => item.id === items[n - 1].id)!;
      const decision = await api(principals.operatorAgent, 'POST', `work/${current.id}/decide`, { action: 'release', input: decisionInput('release', current, {}), reason: `Soak: a hand-requested release of ${current.key} its approver never judges` });
      hand.set(decision.id, { key: current.key, launches: 0, refused: 0 });
      const pane = herdr.open(approverSessionName(current, decision.id));
      // Each ends a minute after the loop first lists it.
      pending.push(async () => { pending.push(async () => { if (ending === 'vanishes') herdr.kill(pane); else herdr.status(pane, 'done'); }); });
    }
    const deploying = deploys < plan.deploys.length && elapsed >= plan.deploys[deploys];
    if (deploying) { production.build = sha('build', ++deploys); production.sha = github.tip; production.deploys.push({ at: now, build: production.build, sha: production.sha }); }
    // The world moves: GitHub, then the sessions. A deploy restarts the control plane once the
    // sessions have renewed: for the rest of that minute nothing reaches it, the loop included.
    github.tick(now);
    await workersTick(now);
    if (!deploying) {
      for (const act of pending.splice(0)) await act();
      // The parent's approval carries one finding beyond its criteria (the soak's reviewer answers
      // with one): the dispatcher files it as the parent's follow-up — a fresh item here, since the
      // day's triage judged and closed the parent's migrated one within its first minutes.
      if (!approvalFiled) {
        const candidate = (await store.list()).find(item => item.id === parent.id)!.candidate;
        const pr = candidate ? github.prs.get(candidate.pr) : undefined;
        const verdict = pr?.reviews.find(review => review.state === 'APPROVED' && review.sha === candidate!.sha);
        if (candidate && pr && verdict) {
          approvalFiled = true;
          const finding: FollowUpFinding = { path: file(plan.followUp), line: 55, text: `${file(plan.followUp)}:55 — the simulated reviewer answers one verdict per head, so a second verdict inside the CI window is never judged` };
          await engine.execute(principals.operatorAgent, 'create', null, followUpItem({ key: parent.key, workId: parent.id, pr: pr.number, sha: candidate.sha, reviewId: verdict.id }, [], [finding]), id());
        }
      }
      await engine.reconcile();
      for (let guard = 0; guard < 200 && await jobsDue(); guard++) await processJob(engine, adapter);
      try {
        const result = await runCycle(config, state, effects, clock.now, launcher); cycles++;
        reportedDispatches += result.actions.filter(action => action.kind === 'dispatch' && action.state === 'done').length;
        escalations.push(...result.actions.filter(action => action.kind === 'escalation').map(action => action.detail));
        for (const watch of Object.values(state.approvals)) if (hand.has(watch.decision) && watch.exhaustedAt) spent.add(watch.decision);
        if (process.env.SOAK_TRACE) for (const action of result.actions) console.error(`+${Math.round(elapsed / minute)} ${action.kind} ${action.state} ${action.work ?? ''}: ${action.detail.slice(0, 300)}`);
      }
      catch (error) { failures.push(`${new Date(now).toISOString()}: ${error instanceof Error ? error.message : String(error)}`); }
      // The interval between cycles is when a hand-off launch settles; the day's clock waits for
      // them so the world never acts on a half-finished launch.
      await launcher.idle();
      // Between cycles, as runDaemon runs it: the self-upgrade against the simulated checkout.
      checkout.dirty = elapsed >= plan.dirtyCheckout.from && elapsed < plan.dirtyCheckout.to;
      const upgraded = await selfUpgrade(state);
      upgrades.outcomes.push(upgraded.outcome);
      if (upgraded.outcome === 'failed') failures.push(`${new Date(now).toISOString()}: self-upgrade failed: ${upgraded.reason}`);
      if (upgraded.outcome === 'refused') refusalSamples.push({ keys: Object.keys(state.actions).filter(key => key.startsWith('upgrade:')).length, attempts: state.actions['upgrade:refused']?.attempts ?? 0 });
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
  const followUps = (await store.list()).filter(item => followUpParent(item) !== null);
  return { items, final, github, sessions, lost, violations, observed, failures, production, cycles, reportedDispatches, state, dayStart, herdr, hand, escalations, spent, upgrades, refusalSamples, checkout, followUps, triageStarts };
}

test('unit:soak-invariants-hold — a simulated day of the real loop: fifteen items delivered and every system invariant holding after every cycle', { timeout: 180_000 }, async () => {
  const began = performance.now();
  const { items, final, github, sessions, lost, violations, observed, failures, production, cycles, reportedDispatches, dayStart, state, upgrades, refusalSamples, checkout, followUps, triageStarts } = await simulateDay({ hours: Number(process.env.SOAK_HOURS ?? 24) });
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
  assert.ok(cycles > 24 * 6, `the loop cycled through the day (${cycles} cycles)`);
  // GY-437: the between-cycles self-upgrade ran after every cycle of the day. Each deploy aligned
  // the checkout once, and restarted the fleet and the loop once (every merge touches src/); the
  // dirty checkout across the second deploy was refused, untouched, without growing the cursor,
  // and aligned once it was clean again.
  const summary = `${upgrades.checkouts.map(entry => `+${Math.round((entry.at - dayStart) / minute)} min ${entry.from.slice(0, 7)}..${entry.to.slice(0, 7)}`).join(', ')}`;
  assert.equal(upgrades.outcomes.length, cycles, 'the self-upgrade ran between every cycle');
  assert.equal(upgrades.checkouts.length, production.deploys.length, `one alignment per deploy: ${summary}`);
  assert.equal(upgrades.executors.length, production.deploys.length, 'one fleet restart per deploy');
  assert.equal(upgrades.self, production.deploys.length, 'one re-execution of the loop per deploy');
  assert.deepEqual(upgrades.executors, upgrades.checkouts.map(entry => entry.to), 'the fleet restarts against the tip the checkout moved to');
  assert.ok(upgrades.checkouts[1].at >= dayStart + plan.dirtyCheckout.to, `the second deploy aligned only once the checkout was clean: ${summary}`);
  assert.ok(refusalSamples.length >= 3, `the dirty checkout stood refused across the second deploy (${refusalSamples.length} cycles)`);
  assert.deepEqual(new Set(refusalSamples.map(sample => JSON.stringify(sample))).size, 1, `a standing refusal does not grow the cursor's actions: ${JSON.stringify(refusalSamples.slice(0, 3))}`);
  assert.equal(state.upgrade.refused, null, 'the refusal cleared with the alignment');
  assert.equal(state.upgrade.alignedRelease, production.deploys[1].sha, 'the loop stands aligned with the last deployed release');
  assert.equal(state.release?.commit, checkout.head, 'the re-executed loop reports the release the checkout holds');
  assert.ok(Object.keys(state.actions).filter(key => key.startsWith('upgrade:')).length <= production.deploys.length + 1, `the cursor holds one upgrade action per deploy and one refusal: ${Object.keys(state.actions).filter(key => key.startsWith('upgrade:')).join(', ')}`);
  // The machine-filed backlog (GY-402) against the live loop: the loop asked for the one-time
  // follow-up migration on its first cycle and the control plane answered through the route, the
  // pre-day follow-up and the approval's fresh one were each judged in a triage session through the
  // typed tool, and every proposed closure was applied once the approver agreed.
  assert.equal(state.actions['followups:migration']?.state, 'done', 'the loop asked for the one-time follow-up migration on its first cycle');
  assert.match(state.actions['followups:migration']?.detail ?? '', /^Merged 0 duplicate follow-up items/, `the control plane answered through the migration route: ${state.actions['followups:migration']?.detail}`);
  assert.deepEqual(triageStarts.map(start => start.options.tool), [triageTool, triageTool], 'a triage session for each machine-filed item: the pre-day follow-up and the approval\'s fresh one');
  assert.ok(triageStarts.every(start => start.options.env?.GRAPHYARD_PI_ROLE === 'triage' && /You are the Graphyard triage agent for owner\/project/.test(start.prompt)), 'each triage session runs in the triage role and is asked to judge its item');
  const [legacy, filed] = followUps.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
  assert.equal(followUps.length, 2, `the day holds the pre-day follow-up and the approval's fresh one: ${followUps.map(item => item.key).join(', ')}`);
  assert.deepEqual(followUps.map(item => [item.stage, item.candidate === null]), [['done', true], ['done', true]], 'each follow-up is judged and closed without ever being built');
  assert.equal(legacy.origin?.reviewFollowUps, undefined, 'the pre-day follow-up predates the origin: its findings live in the description');
  assert.ok(triageStarts[0]!.prompt.includes(`1. src/soak/item-${plan.followUp}.ts:`), 'its triage session was shown the findings, read from the numbered description');
  assert.equal(legacy.triage?.state, 'applied', 'the pre-day follow-up was triaged');
  assert.equal(legacy.closure?.kind, 'obsolete', 'and closed once the approver agreed');
  assert.equal(filed.origin?.reviewFollowUps?.parent, items[plan.followUp - 1].key, 'the approval\'s finding was filed as the parent\'s follow-up');
  assert.ok(filed.origin?.reviewFollowUps?.findings[0]?.text.includes('a second verdict inside the CI window'), 'the item holds the finding the approval carried');
  assert.equal(filed.triage?.state, 'applied', 'the approval\'s follow-up was triaged too');
  const seconds = (performance.now() - began) / 1000;
  assert.ok(seconds < 120, `the day runs well inside the three minutes the CI test job allows it (${seconds.toFixed(1)} s)`);
});

test('unit:soak-invariants-hold — hand-launched approvers that vanish or stop without judging are relaunched within the bound, a refused relaunch is retried, and the spent watches keep every invariant holding', { timeout: 120_000 }, async () => {
  // GY-551: for every decision a master put to an approver by hand the loop now launches up to two
  // more sessions itself and keeps the spent watch past the bound, so both repeat per item here.
  const { final, violations, failures, state, herdr, hand, escalations, spent } = await simulateDay({ hours: 6, handApprovers: true });
  // Every item is delivered, so the day after starts from a clean board.
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the relaunches and the kept spent watches');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.equal(hand.size, 2);
  for (const [decision, { key, launches, refused }] of hand) {
    assert.equal(launches - refused, 2, `${key}: the loop relaunched the hand-launched approver twice, the hand launch being the first of three`);
    assert.ok(spent.has(decision), `${key}: past the bound the watch was kept, spent`);
    assert.ok(escalations.some(detail => detail.includes(decision) && /3 approver session\(s\)/.test(detail) && /session 1: .*session 2: .*session 3: /.test(detail)), `${key}: the unanswered decision was escalated with each session's end reason`);
    assert.equal(final.find(item => item.key === key)!.stage, 'done', `${key} was still delivered`);
    assert.ok(!Object.values(state.approvals).some(watch => watch.decision === decision), `${key}: the spent watch went with its delivered item`);
    assert.ok(![...herdr.agents.values()].some(agent => agent.name === approverSessionName(final.find(item => item.key === key)!, decision)), `${key}: no approver session for it is left open`);
  }
  assert.equal([...hand.values()].reduce((total, entry) => total + entry.refused, 0), 1, 'one relaunch was refused by a registry timeout, and retried');
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
