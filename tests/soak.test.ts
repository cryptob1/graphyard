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
import { mergeBatchSize, mergeParallelTips, optimisticExcludeGlobs, optimisticMergeEnabled, rerunFailedChecks } from '../src/master/profiles.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { Launcher } from '../src/daemon/cycle.js';
import { successorWidening } from '../src/model/successors.js';
import { systemInvariants, type InvariantCheck } from '../src/model/invariants.js';
import { lostRunReason, requestAttemptLimit, sessionRetry, sessionRetryLimit } from '../src/producer.js';
import type { ExhaustedProof } from '../src/daemon/decisions.js';
import { performSelfUpgrade, type SelfUpgradeOutcome } from '../src/daemon/upgrade.js';
import { defaultOptimisticExclude } from '../src/optimistic-merge.js';
import { queuePlacement } from '../src/merge-queue.js';
import { SimulatedGitHub, SimulatedHerdr, clock, clockSql, hour, minute, sha } from './helpers/soak-world.js';

/**
 * GY-404: per-item gates cannot catch faults that emerge from interaction over time, so this runs
 * the real loop — `runCycle` with the real engine on the test Postgres, the real reconciliation job
 * (`processJob`) and the real guarded merge — against a deterministic simulated GitHub, Herdr and
 * clock for a simulated day, and asserts after every cycle that every system invariant
 * (src/model/invariants.ts) holds. Fifteen items pass through it: released every fifteen minutes so
 * a merge lands about every fifteen, three sent back by their reviewer, two whose worker dies, two
 * production deploys, a file split on main that re-plans an item, one pull request GitHub reports
 * CLEAN at once and one UNSTABLE, a reviewer bot out of quota that fails over, two flaky tips
 * rerun once (GY-516), one passing on the rerun and one failing again, one head whose producer
 * runs are killed, then fail until the request is spent (GY-496), and the loop's
 * between-cycles self-upgrade (GY-437) against a simulated coordinator checkout that stands dirty
 * across the second deploy for a while. Every one of the fifteen must be delivered. The loop
 * carries one `Launcher` across its cycles (GY-616), as `runDaemon` does, so session launches run
 * beside the cycle — outliving it, holding their profile from hand-off, and reported by the next
 * cycle — and the invariants hold on that detached path. Optimistic merge (GY-500) is on, as by
 * default: disjoint items land past the queue, two that change shared infrastructure queue, and one
 * breaks main after its optimistic merge, so the main guard reads the post-merge runs, reverts it
 * and reopens it. The loop publishes its merge-queue configuration every cycle it changes (GY-330,
 * GY-498, GY-500, GY-516), and a second, queue-only day runs the parallel-tip window (GY-498) over
 * every item: several tips validated at once, a failing tip ejecting only its own entry once the
 * tips ahead pass while the suffix rebuilds without it, and the window reconfigured mid-day and
 * republished. A change to the loop that breaks an invariant fails here, in CI, before it merges;
 * a new behaviour that repeats per cycle, head or item belongs in this world.
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
// The queue-only day's roster (GY-498): worker capacity enough to fill the parallel-tip window,
// which three workers' push rate can never deepen past two tips in flight.
const queueWorkers: WorkerProfile[] = ['four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].map(name => ({ name, principal: `worker-${name}`, agentName: `soak-worker-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} }) as WorkerProfile);
const everyone: Principal[] = [...Object.values(principals), ...[...workers, ...queueWorkers].map(profile => ({ id: profile.principal, role: 'worker' as const }))];
const credentials = everyone.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(entry => entry.id === principal.id)!.token;
const reviewerApps = [{ id: 'claude-reviewer', runtime: 'claude', appId: 55_001, botUserId: 55_002 }, { id: 'cursor-reviewer', runtime: 'cursor', appId: 66_001, botUserId: 66_002 }];
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const soakConfig: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234,
  hostId: 'soak-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers,
  operatorAgent: { id: principals.operatorAgent.id, credentialFile: '/outside/operator.token' }, approver: { id: principals.approver.id, credentialFile: '/outside/approver.token' },
  run: { proofWorkflow: 'acceptance.yml', intervalSeconds: 60 } });

/** The day, in simulated time from the start. */
const start = Date.parse('2031-06-02T08:00:00Z');
const plan = {
  items: 15, releaseEveryMs: 15 * minute, workMs: 20 * minute,
  // GY-842: review panes of a previous day, standing agentless with their worktrees deleted.
  leftovers: 8,
  rework: new Set([3, 7, 11]), deaths: new Set([5, 9]), deathAfterMs: 8 * minute,
  deploys: [2 * hour + 30 * minute, 5 * hour], dirtyCheckout: { from: 4 * hour + 50 * minute, to: 6 * hour }, split: { at: 45 * minute, item: 12 }, stuckBatch: { at: 3 * hour, forMs: 15 * minute }, clean: 2, unstable: 4, slowRecompute: 8, exhaustedReviewer: 6,
  /** GY-500: the item whose first head breaks main after its optimistic merge, and the items that change shared infrastructure and so queue. */
  breaksMain: 10, infrastructure: new Set([13, 14]),
  // GY-516: a flake on a speculative tip whose one rerun passes, and one whose rerun fails again.
  flaky: { rerunPasses: 13, rerunFails: 14 },
  // GY-839: for one stretch of the day GitHub answers every open candidate's compares without a
  // usable merge base, so the landing comparison keeps the two-way endpoint diff and the base's
  // own new changes read as reverts — the reading this item fixes. The window covers the NOTICE
  // commit on main, which moves the base under candidates still unqueued: their false landing
  // refusals hold only the build gate and clear on the same heads when the window closes, before
  // a worker could even react to them.
  blind: { from: 96 * minute, to: 98 * minute },
  notice: 96 * minute,
  // GY-496: item 15's first head has its producer runs killed (exit 143) twice, then failing until
  // the request is spent; the loop escalates it once and requests one rework for that head.
  spentProducer: 15, lostRuns: 2,
};
const file = (n: number) => `src/soak/item-${n}.ts`;
const files = (n: number) => plan.infrastructure.has(n) ? [file(n), `tests/helpers/soak-item-${n}.ts`] : [file(n)];

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
 * effects, standing for a change that breaks an invariant, so the soak shows it would fail. `queued`
 * runs the day with the optimistic lane off, so every item goes through the merge queue under the
 * parallel-tip window (GY-498): `window` is the configured `mergeQueue.parallelTips`, `reconfigure`
 * rewrites master config mid-day the way an operator's edit does (the next cycle republishes it),
 * and `failTip` names the item whose first speculative tip fails and keeps failing after its rerun.
 */
let days = 0;
async function simulateDay(options: { hours: number; regression?: 'approvers-left-open'; handApprovers?: boolean; queued?: { window: number; reconfigure?: { at: number; window: number }; failTip?: number; releaseEveryMs?: number } }) {
  const dayStart = clock.now();
  const config: MasterConfig = options.queued
    ? masterConfigSchema.parse({ ...soakConfig, workers: [...workers, ...queueWorkers], mergeQueue: { optimistic: false, parallelTips: options.queued.window } })
    : soakConfig;
  // The spent producer request (GY-496) is a main-day fault, like the blind window and the split:
  // the queue-only, hand-approver and regression days exercise their own faults and would only
  // inherit this one's rework round.
  const mainDay = !options.queued && !options.handApprovers && !options.regression;
  const github = new SimulatedGitHub({ repository, baseBranch: 'main', appId: 1234, ciAppId: 15368, reviewerApps, ciMs: 5 * minute, reviewMs: 3 * minute, firstPullRequest: 100 * ++days },
    [...Array.from({ length: plan.items }, (_, index) => file(index + 1)), 'README.md']);
  const herdr = new SimulatedHerdr(() => clock.now());
  const adapter = github.adapter();
  // GY-691: from `plan.stuckBatch.at`, GitHub refuses the first fresh queue head's speculative tip
  // for `forMs`, so its batch sits in testing with no published tip past the dissolution threshold;
  // the day then shows the stuck batch dissolves once, and the queue resumes once GitHub recovers.
  let stuck = null as { key: string; at: number } | null;
  const publish = adapter.publishSpeculativeTip.bind(adapter);
  adapter.publishSpeculativeTip = async (work, ...rest) => {
    if (!stuck && !work.queue?.speculation && clock.now() >= dayStart + plan.stuckBatch.at) stuck = { key: work.key, at: clock.now() };
    if (stuck?.key === work.key && clock.now() < stuck.at + plan.stuckBatch.forMs) throw new Error(`GitHub refused the speculative tip for ${work.key}: 502 Bad Gateway`);
    return publish(work, ...rest);
  };
  const moveClock = async (ms: number) => { clock.advance(ms); await store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]); };
  await moveClock(0);

  // ---- The fifteen items, created in the backlog and released one every fifteen minutes. ----
  const releaseEveryMs = options.queued?.releaseEveryMs ?? plan.releaseEveryMs;
  const items: Work[] = [];
  for (let n = 1; n <= plan.items; n++) {
    let work = await engine.execute(principals.operator, 'create', null, { title: `Soak item ${n}`, plannedFiles: files(n), criteria: [{ id: 'AC-1', text: `Item ${n} behaves`, proofs: [PROOF] }] }, id());
    if (n === plan.exhaustedReviewer) work = await engine.execute(principals.operator, 'reviewpolicy', work.id, { provider: 'agent', expectedPolicyRevision: work.policyRevision, reason: 'Reviewed by the reviewer bots',
      reviewerProfiles: [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer' }, { name: 'cursor-reviewer', runtime: 'cursor', reviewerApp: 'cursor-reviewer' }] }, id());
    items.push(work);
  }
  // ---- The backlog a previous day left (GY-842): panes of review sessions whose worktrees the
  // ---- reclaim removed while the panes stood on. Enough of them that the sweep's per-pass bound
  // ---- is what paces the drain, and one pane Graphyard never launched that it must never touch.
  // Pane ids are this simulated world's own, so two days on one control plane never collide.
  const world = `w${days}:`, leftovers = plan.leftovers, foreignPane = `${world}operator`;
  for (let index = 0; index < leftovers; index++) {
    const work = items[index], pane = `${world}left${index}`;
    herdr.shell(pane, `/tmp/soak/leftover-${index} (deleted)`);
    await api(principals.coordinator, 'POST', `work/${work.id}/session`, { id: `review-leftover-${index}`, kind: 'review', runtime: 'claude', host: 'soak-host',
      subject: `${work.key}: review (previous day)`, state: 'running', pane, attach: `herdr pane attach ${pane}` });
  }
  herdr.shell(foreignPane, '/home/vish');
  const numberOf = (work: Pick<Work, 'key'>) => items.findIndex(item => item.key === work.key) + 1;
  for (const n of plan.rework) github.verdicts.set(items[n - 1].key, ['CHANGES_REQUESTED']);
  github.unstable.add(items[plan.unstable - 1].key); github.slowRecompute.add(items[plan.slowRecompute - 1].key);
  github.exhaustedProfiles.add('claude-reviewer');
  github.flaky.set(items[plan.flaky.rerunPasses - 1].key, 'rerun-passes'); github.flaky.set(items[plan.flaky.rerunFails - 1].key, 'rerun-fails');
  // GY-498: in the queue-only day one item's first tip fails and keeps failing after its rerun, so
  // the window has to attribute the failure to it and rebuild the tips behind it without it.
  if (options.queued?.failTip) github.flaky.set(items[options.queued.failTip - 1].key, 'rerun-fails');

  // ---- Workers: the loop dispatches, the simulated session claims, works, pushes and submits (or dies). ----
  interface Session { work: string; key: string; branch: string; profile: WorkerProfile; epoch: number; attempt: number; pane: string; pushAt: number; diesAt: number | null; state: 'working' | 'submitted' | 'dead'; syncs: number; syncedFor?: string; refusedSince?: number }
  const sessions: Session[] = [], lost: string[] = [];
  const attempts = new Map<string, number>();
  const principalOf = (profile: WorkerProfile): Principal => ({ id: profile.principal, role: 'worker' });
  const dispatch: DaemonEffects['dispatch'] = async (work, profile) => {
    const principal = principalOf(profile);
    const claimed = await engine.execute(principal, 'claim', work.id, {}, id());
    const epoch = claimed.epoch, key = work.key, n = numberOf(work);
    // A rework attempt pushes to the pull request already linked, from a fresh workspace.
    const branch = work.candidate?.branch ?? `graphyard/${key.toLowerCase()}-${epoch}`;
    const path = `/tmp/soak/${key}-${epoch}`;
    await engine.execute(principal, 'workspace', work.id, { epoch, host: 'soak-host', path, branch }, id());
    const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
    const pane = herdr.open(profile.agentName, 'working', path);
    sessions.push({ work: work.id, key, branch, profile, epoch, attempt, pane, pushAt: clock.now() + plan.workMs, diesAt: plan.deaths.has(n) && attempt === 1 ? clock.now() + plan.deathAfterMs : null, state: 'working', syncs: 0 });
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
      const head = sha('head', session.key, session.epoch);
      if (numberOf(session) === plan.breaksMain && session.attempt === 1) github.breaking.add(head);
      const pr = github.push(session.key, session.branch, principal.id, head, files(numberOf(session)));
      await engine.execute(principal, 'submit', session.work, { epoch: session.epoch, pr: pr.number, documentation: 'A simulated item: it changes no documented behaviour' }, id());
      session.state = 'submitted';
      // Its work done, the runtime exits and leaves the pane behind (GY-842); the loop's session
      // end closes it in the same step, or the sweep reclaims it as the backstop.
      herdr.kill(session.pane);
    }
    // GY-839: a worker whose candidate was refused on landing does what that refusal asks —
    // graphyard sync, restore what the base changed, push again. Under a fault window long enough
    // for a worker to react, this is the worker round the false refusal costs; while GitHub answers
    // merge bases truly the landing comparison clears on its own and no worker is woken at all.
    // The same remedy is what a queue ejection for a landing revert instructs, whose wording names
    // the work rather than a count of files.
    for (const session of sessions.filter(entry => entry.state === 'submitted')) {
      const current = (await store.list()).find(item => item.id === session.work);
      const refused = (current?.gates ?? []).flatMap(gate => gate.passed ? [] : gate.reasons)
        .some(reason => /would revert (?:\d+ files?|work) outside its planned files/.test(reason));
      const candidate = current?.candidate?.sha;
      // A sync answers one candidate; a later refusal of a new candidate is synced again, exactly
      // as a worker runs graphyard sync each time a landing refusal names its current head.
      if (!refused || !candidate || session.syncedFor === candidate) { session.refusedSince = undefined; continue; }
      const since = session.refusedSince ?? now;
      session.refusedSince = since;
      if (now - since < 3 * minute) continue;
      session.syncs += 1; session.syncedFor = candidate; session.refusedSince = undefined;
      github.push(session.key, session.branch, principalOf(session.profile).id, sha('head', session.key, session.epoch, 'sync', session.syncs), files(numberOf(session)));
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
  // GY-496: the dispatcher's producer request for item `plan.spentProducer`'s first head, scheduled by
  // the real `sessionRetry`. Its first runs are killed (a lost run relaunches at once, spending no
  // attempt), the rest fail, until the request is spent and the dispatcher stops attempting it.
  const producerRuns: { requestId: string; state: string; requestedAt: string; closedAt: string | null; resolution: string | null }[] = [];
  const abandoned = new Map<string, ExhaustedProof>();
  let spentHead: string | null = null;
  const spentOn = (work: Work) => mainDay && numberOf(work) === plan.spentProducer && !!work.candidate && (spentHead ??= work.candidate.sha) === work.candidate.sha;
  const producersTick = async (now: number) => {
    if (!mainDay) return;
    const item = (await store.list()).find(entry => numberOf(entry) === plan.spentProducer);
    if (!item?.submission || !item.candidate || item.stage === 'done' || !spentOn(item)) return;
    const requestId = `soak-producer-${item.key}-${item.candidate.sha.slice(0, 12)}`, at = new Date(now).toISOString();
    if (abandoned.has(requestId)) return;
    const runs = () => producerRuns.filter(run => run.requestId === requestId);
    const running = runs().find(run => run.state === 'pending');
    if (running) Object.assign(running, { state: 'failed', closedAt: at, resolution: runs().length <= plan.lostRuns
      ? `${lostRunReason}: the headless run was killed (pi exited on SIGTERM) before it reached a verdict, without trusted evidence for ${PROOF} (missing); it is relaunched and not counted as an attempt`
      : `the headless run ended (exit: pi exited with code 1) without trusted evidence for ${PROOF} (fail)` });
    const retry = sessionRetry(producerRuns, requestId, now);
    if (retry.exhausted) abandoned.set(requestId, { requestId, work: item.key, sha: item.candidate.sha, group: 'unit', proofs: [PROOF], reason: `${retry.started} of its sessions failed`, attempts: runs().map(run => `${run.state}: ${run.resolution}`) });
    else if (retry.launch) producerRuns.push({ requestId, state: 'pending', requestedAt: at, closedAt: null, resolution: null });
  };
  const requestProof: DaemonEffects['requestProof'] = work => {
    pending.push(async () => {
      const current = (await store.list()).find(item => item.id === work.id)!;
      if (!current.candidate || current.candidate.sha !== work.candidate?.sha || current.stage === 'done') return;
      // The trusted workflow publishes nothing for the spent head: only the dispatcher's producer runs stand for it.
      if (spentOn(current)) return;
      await engine.execute(principals.producer, 'evidence', current.id, { proof: PROOF, sha: current.candidate.sha, baseSha: current.candidate.baseSha, policyRevision: current.policyRevision, result: 'pass', executed: 4, skipped: 0,
        exercise: { criterion: 'AC-1', behaviour: `item ${numberOf(current)}'s change`, result: 'fail', executed: 1 } }, id());
    });
  };

  // ---- Production: two deploys, each a new control-plane build serving the base tip it was cut from. ----
  const production = { build: sha('build', 0), sha: github.tip, deploys: [] as { at: number; build: string; sha: string }[] };
  const snapshot = async () => { const read = await store.coordinationSnapshot(); return { work: read.work, now: read.now, jobs: read.jobs }; };
  const transport = async (path: string, data: any, key: string = id()) => {
    const match = /^work\/([^/]+)\/merge-acquire$/.exec(path);
    if (!match) {
      // The loop's own configuration publication (GY-330, GY-498, GY-500, GY-516) goes the same way.
      if (path === 'merge-queue') return await api(principals.coordinator, 'POST', 'merge-queue', data);
      throw new Error(`Unexpected mutation ${path}`);
    }
    try { return await engine.requestEnqueue(principals.coordinator, match[1], data, key); }
    catch (error) { if (error instanceof Refusal) throw Object.assign(new Error(JSON.stringify({ error: error.message })), { confirmedRefusal: error.status >= 400 && error.status < 500 }); throw error; }
  };
  // One executor instance for the loop's process, and a fresh request per merge the loop asks for, as `master run` wires it.
  const executor = { principal: principals.coordinator.id, instance: `soak-${randomUUID()}` };
  const merge: DaemonEffects['merge'] = work => mergeExecutor(config, snapshot, transport, executor, randomUUID(), github.gh(repository))(work);
  const effects: DaemonEffects = {
    agents: () => herdr.list(),
    herdr: () => ({ agents: herdr.list(), available: true }),
    panes: async () => ({ panes: herdr.paneList(), available: true }),
    recordSession: (work, handle) => api(principals.coordinator, 'POST', `work/${work.id}/session`, handle),
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    snapshot, dispatch, requestProof, approver, merge,
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
    exhaustedProofs: async () => [...abandoned.values()],
  };
  // The loop publishes the master's merge-queue settings each cycle they change (GY-330, GY-498,
  // GY-500, GY-516), exactly as daemonEffects wires it; the day records what was published, when.
  let publishedMergeQueue: string | null = null;
  const mergeQueuePosts: { at: number; settings: Record<string, number | boolean | readonly string[]> }[] = [];
  effects.publishMergeBatchSize = async () => {
    const settings = { batchSize: mergeBatchSize(config), optimistic: optimisticMergeEnabled(config), parallelTips: mergeParallelTips(config), rerunFailedChecks: rerunFailedChecks(config), optimisticExclude: optimisticExcludeGlobs(config) };
    const published = JSON.stringify(settings);
    if (published === publishedMergeQueue) return;
    mergeQueuePosts.push({ at: clock.now(), settings });
    await api(principals.coordinator, 'POST', 'merge-queue', settings);
    publishedMergeQueue = published;
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
  const violations: string[] = [], observed = new Set<string>(), failures: string[] = [], escalations: string[] = [], spent = new Set<string>(), actionKeys = new Set<string>();
  // GY-839: every false landing refusal the fault window produces, first seen per candidate head.
  const landingRefusals: { key: string; sha: string; elapsed: number }[] = [];
  // GY-498: the parallel-tip window as the day saw it — how many entries held a published tip at
  // once, which successor tips were chained onto a predecessor's, and every tip per entry, so the
  // test can watch the window fill, a failure isolate its entry, and the suffix rebuild without it.
  const windowSamples: { at: number; concurrent: number; keys: string[] }[] = [];
  const tipPublications: { key: string; tip: string; at: number; position: number }[] = [];
  const chainedTips = new Set<string>();
  let peakWindow = 0;
  const seenTips = new Set<string>();
  let released = 0, split = false, noticed = false, deploys = 0, cycles = 0, reportedDispatches = 0;
  const starved: string[] = [];
  // GY-691: the stuck-batch fault is a batch-plan fault (dissolution belongs to the batch plan,
  // GY-330), and the batch plan is what a master runs before it publishes a parallel-tip window
  // (GY-498). The main day therefore runs its stuck-batch stretch on the batch plan — pinning the
  // window the way the batch-plan units do — and restores the published window once the dissolved
  // head has re-predicted and published its own tip.
  let pinned: { tips: number; load: typeof engine.loadParallelTips } | null = null, restored = true;
  const jobsDue = async () => Number((await store.pool.query('SELECT count(*) AS due FROM jobs WHERE available_at<=now() AND (held_until IS NULL OR held_until<=now()) AND (locked_until IS NULL OR locked_until<now())')).rows[0].due);
  for (let elapsed = 0; elapsed <= options.hours * hour;) {
    const now = clock.now();
    // Scheduled events: releases, the file split on main, the deploys. The queue-only day runs with
    // the split past its end: the re-plan and its stale-tip flush are the main day's scenario, and
    // a queue of tips built before the split only ejects in a cascade the day cannot recover from.
    while (released < plan.items && elapsed >= released * releaseEveryMs) await engine.execute(principals.operator, 'ready', items[released++].id, {}, id());
    const splitAt = options.queued ? options.hours * hour + hour : plan.split.at;
    if (!split && elapsed >= splitAt) {
      split = true;
      const from = file(plan.split.item), successors = [`src/soak/item-${plan.split.item}-a.ts`, `src/soak/item-${plan.split.item}-b.ts`];
      const commit = github.commit(`Split ${from}\n\nGraphyard-Successor: ${from} -> ${successors.join(', ')}`, [...github.files.filter(path => path !== from), ...successors]);
      github.successions.push(...successors.map(to => ({ from, to, commit: commit.sha, similarity: 70 })));
    }
    // GY-839: while the window stands, GitHub answers every open candidate's compares without a
    // usable merge base; afterwards its answers carry the true one again. The queue-only day runs
    // with the window past its end: its fault is the bound candidates' recovery, which the main
    // day exercises, and a queue full of false landing refusals would only churn sync rounds.
    const blind = options.queued ? { from: options.hours * hour + hour, to: options.hours * hour + 2 * hour } : plan.blind;
    github.staleMergeBase = elapsed >= blind.from && elapsed < blind.to
      ? new Set([...github.prs.values()].filter(pr => pr.open).map(pr => pr.head)) : new Set<string>();
    // A change landed on main outside Graphyard, moving the base under candidates already pushed.
    if (!noticed && elapsed >= plan.notice) { noticed = true; github.commit('Add NOTICE to the base branch', [...github.files, 'NOTICE']); }
    // GY-691: ten minutes before the wedge can form the main day runs the batch plan the stuck-batch
    // dissolution belongs to, and restores the published window ten minutes after GitHub recovers,
    // once the dissolved head has re-predicted and published its own tip.
    if (mainDay) {
      if (!pinned && elapsed >= plan.stuckBatch.at - 10 * minute) {
        pinned = { tips: engine.parallelTips, load: engine.loadParallelTips };
        engine.parallelTips = 0; engine.loadParallelTips = async () => engine.parallelTips = 0;
        restored = false;
      }
      if (pinned && !restored && stuck && clock.now() >= stuck.at + plan.stuckBatch.forMs + 10 * minute) {
        restored = true;
        engine.loadParallelTips = pinned.load; engine.parallelTips = pinned.tips;
      }
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
    await producersTick(now);
    if (!deploying) {
      for (const act of pending.splice(0)) await act();
      await engine.reconcile();
      for (let guard = 0; guard < 200 && await jobsDue(); guard++) await processJob(engine, adapter);
      for (const item of await store.list()) {
        const sha = item.candidate?.sha, refused = (item.gates ?? []).flatMap(gate => gate.passed ? [] : gate.reasons)
          .find(reason => /would revert \d+ files? outside its planned files/.test(reason));
        if (sha && refused && !landingRefusals.some(entry => entry.key === item.key && entry.sha === sha)) landingRefusals.push({ key: item.key, sha, elapsed });
      }
      // GY-498: sample the window after the pass's publications, then apply a mid-day master-config
      // edit, which the cycle about to run publishes the way an operator's edit is published.
      if (options.queued) {
        const all = await store.list();
        const tipped = all.filter(item => item.stage !== 'done' && item.queue?.speculation && item.candidate
          && item.queue.speculation.tip === item.candidate.sha && item.queue.speculation.base === item.candidate.baseSha);
        if (tipped.length >= 2) {
          windowSamples.push({ at: elapsed, concurrent: tipped.length, keys: tipped.map(item => item.key) });
          for (const ahead of tipped) for (const behind of tipped) {
            if (ahead.key !== behind.key && github.contains(behind.queue!.speculation!.tip, ahead.queue!.speculation!.tip)) chainedTips.add(`${ahead.key}->${behind.key}`);
          }
        }
        for (const item of tipped) {
          if (seenTips.has(`${item.key}:${item.queue!.speculation!.tip}`)) continue;
          seenTips.add(`${item.key}:${item.queue!.speculation!.tip}`);
          const placement = queuePlacement(item, all.map(entry => entry.id === item.id ? item : entry), clock.now());
          tipPublications.push({ key: item.key, tip: item.queue!.speculation!.tip, at: elapsed, position: placement?.position ?? -1 });
        }
        if (options.queued.reconfigure && elapsed >= options.queued.reconfigure.at) {
          config.mergeQueue!.parallelTips = options.queued.reconfigure.window;
        }
        peakWindow = Math.max(peakWindow, tipped.length);
      }
      try {
        const result = await runCycle(config, state, effects, clock.now, launcher); cycles++;
        reportedDispatches += result.actions.filter(action => action.kind === 'dispatch' && action.state === 'done').length;
        escalations.push(...result.actions.filter(action => action.kind === 'escalation').map(action => action.detail));
        for (const watch of Object.values(state.approvals)) if (hand.has(watch.decision) && watch.exhaustedAt) spent.add(watch.decision);
        if (process.env.SOAK_TRACE) for (const action of result.actions) console.error(`+${Math.round(elapsed / minute)} ${action.kind} ${action.state} ${action.work ?? ''}: ${action.detail.slice(0, 300)}`);
      }
      catch (error) { failures.push(`${new Date(now).toISOString()}: ${error instanceof Error ? error.message : String(error)}`); }
      for (const key of Object.keys(state.actions)) actionKeys.add(key);
      // The interval between cycles is when a hand-off launch settles; the day's clock waits for
      // them so the world never acts on a half-finished launch.
      await launcher.idle();
      // Between cycles, as runDaemon runs it: the self-upgrade against the simulated checkout.
      checkout.dirty = elapsed >= plan.dirtyCheckout.from && elapsed < plan.dirtyCheckout.to;
      const upgraded = await selfUpgrade(state);
      upgrades.outcomes.push(upgraded.outcome);
      if (upgraded.outcome === 'failed') failures.push(`${new Date(now).toISOString()}: self-upgrade failed: ${upgraded.reason}`);
      if (upgraded.outcome === 'refused') refusalSamples.push({ keys: Object.keys(state.actions).filter(key => key.startsWith('upgrade:')).length, attempts: state.actions['upgrade:refused']?.attempts ?? 0 });
      // No observation job starves in steady state (GY-506): none finishes three times running without saving one.
      for (const job of await store.starvedJobs()) starved.push(`${new Date(now).toISOString()} (+${Math.round(elapsed / minute)} min) ${job.key} unobserved ${job.unobserved}: ${job.deferred_reason ?? job.error ?? 'no reason recorded'}`);
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
  const dissolutions = (await store.pool.query("SELECT w.document->>'key' AS key, e.payload FROM events e JOIN work_items w ON w.id=e.work_id WHERE e.kind='queue.batch-dissolved' AND e.work_id=ANY($1::uuid[]) ORDER BY e.seq", [items.map(item => item.id)])).rows as { key: string; payload: any }[];
  if (process.env.SOAK_TRACE) console.error(`landing: ${github.landingChecks} checks over ${github.landingBases.size} bases, ${github.ancestorCompares} ancestor compares, ${github.blindCompares} blind compares; false landing refusals: ${landingRefusals.map(entry => `${entry.key}@+${Math.round(entry.elapsed / minute)}min ${entry.sha.slice(0, 12)}`).join(', ') || 'none'}`);
  return { items, final, github, sessions, lost, violations, observed, failures, production, cycles, reportedDispatches, state, dayStart, herdr, hand, escalations, spent, producerRuns, abandoned, spentHead, actionKeys, upgrades, refusalSamples, checkout, landingRefusals, foreignPane,
    mergeQueuePosts, windowSamples, tipPublications, chainedTips, peakWindow, stuck, starved, dissolutions, config };
}

test('unit:soak-invariants-hold — a simulated day of the real loop: fifteen items delivered and every system invariant holding after every cycle', { timeout: 180_000 }, async () => {
  const began = performance.now();
  const { items, final, github, sessions, lost, violations, observed, failures, production, cycles, reportedDispatches, dayStart, state, producerRuns, abandoned, spentHead, actionKeys, upgrades, refusalSamples, checkout, herdr, landingRefusals, foreignPane, mergeQueuePosts, stuck, starved, dissolutions } = await simulateDay({ hours: Number(process.env.SOAK_HOURS ?? 24) });
  const undelivered = final.filter(item => item.stage !== 'done' || !item.delivery);
  assert.deepEqual(undelivered.map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease: a dead worker lapses, it is not refused');
  assert.deepEqual([...observed].sort(), [...systemInvariants].sort(), 'every invariant was observed, not merely left unread');
  // GY-691: no observation job starved at any point of the day, and the wedged head batch
  // dissolved exactly once — no flapping — and its item was still delivered.
  assert.deepEqual(starved, [], 'no observation job starves in steady state');
  assert.ok(stuck, 'the day wedged a head batch in testing with no published tip');
  assert.deepEqual(dissolutions.map(row => row.key), [stuck!.key], `the stuck batch dissolved once, and nothing else did: ${JSON.stringify(dissolutions)}`);
  const wedged = final.find(item => item.key === stuck!.key)!;
  assert.equal((wedged.queueHistory ?? []).filter(entry => entry.event === 'dissolved').length, 1, 'one dissolution on the head\'s queue history');
  assert.ok(wedged.stage === 'done' && wedged.delivery, 'the dissolved batch\'s head was delivered');
  // The day held what it was meant to: a merge about every fifteen minutes, the rework rounds, the deaths,
  // the deploys, the split, both merge states, auto-merge, and the failover.
  // One item broke main after its optimistic merge and was reverted and reopened, so it merged twice.
  assert.equal(github.merges.length, plan.items + 1, 'fifteen items merged, one of them twice');
  const gaps = github.merges.slice(1).map((entry, index) => entry.at - github.merges[index].at).sort((a, b) => a - b);
  assert.ok(Math.abs(gaps[Math.floor(gaps.length / 2)] - 15 * minute) <= 5 * minute, `a merge about every fifteen minutes: ${github.merges.map(entry => `${entry.key} +${Math.round((entry.at - dayStart) / minute)} min`).join(', ')}`);
  assert.ok(github.merges.some(entry => entry.key === items[plan.clean - 1].key && entry.state === 'CLEAN' && entry.mode === 'immediate'), `a CLEAN pull request merged at once: ${JSON.stringify(github.merges)}`);
  assert.ok(github.merges.some(entry => entry.key === items[plan.unstable - 1].key && entry.state === 'UNSTABLE' && entry.mode === 'immediate'), 'an UNSTABLE pull request merged at once');
  assert.ok(github.merges.some(entry => entry.key === items[plan.slowRecompute - 1].key && entry.mode === 'auto-merge'), 'one GitHub reported BLOCKED when asked was set to auto-merge, and GitHub merged it once it recomputed');
  assert.equal(final.reduce((total, item) => total + (item.pipeline?.reworkRounds ?? 0), 0), plan.rework.size + 3, 'three rework rounds from review, the reverted optimistic merge, the failed rerun, and the spent producer request');
  // GY-496: the killed runs relaunched without spending an attempt, the request stayed bounded, and
  // its spent head was escalated once and reworked once; the fresh head passed its proofs.
  const spentItem = final.find(item => item.key === items[plan.spentProducer - 1].key)!;
  assert.ok(spentHead && spentItem.candidate && spentItem.candidate.sha !== spentHead, `the spent head was replaced by a fresh one: ${spentHead} → ${spentItem.candidate?.sha}`);
  assert.equal(abandoned.size, 1, 'one producer request was spent');
  assert.deepEqual(producerRuns.map(run => run.resolution?.startsWith(`${lostRunReason}: `) ? 'lost' : 'counted'), [...Array(plan.lostRuns).fill('lost'), ...Array(sessionRetryLimit).fill('counted')], 'the killed runs spent no attempt; the failing runs spent them all');
  assert.ok(producerRuns.length <= requestAttemptLimit, 'relaunches stay bounded per request');
  assert.equal(spentItem.pipeline?.reworkRounds, 1, 'the spent head was reworked once');
  const proofEscalations = [...actionKeys].filter(key => key.startsWith(`escalation:proof-exhausted:${spentItem.key}:`));
  const reworks = [...actionKeys].filter(key => key.startsWith(`decision:rework:${spentItem.id}:${spentHead}:proof-exhausted`));
  assert.equal(proofEscalations.length, 1, `one escalation for the spent request: ${proofEscalations.join(', ')}`);
  assert.equal(reworks.length, 1, `one rework decision for the spent head: ${reworks.join(', ')}`);
  assert.deepEqual([...actionKeys].filter(key => key.startsWith('escalation:proof-workflow:')), [], 'the trusted workflow was never spent');
  assert.equal(sessions.filter(session => session.state === 'dead').length, plan.deaths.size, 'two workers died');
  // Every dispatch the launcher settled was reported by a later cycle (GY-616): one dispatch-done
  // per session, none lost between the hand-off and the drain.
  assert.equal(reportedDispatches, sessions.length, 'each settled dispatch launch was reported to a cycle');
  assert.equal(production.deploys.length, plan.deploys.length, 'two production deploys');
  assert.ok(final.find(item => item.key === items[plan.split.item - 1].key)!.plannedFiles.includes(`src/soak/item-${plan.split.item}-a.ts`), 'the split file re-planned its item onto the successors');
  const reviewed = final.find(item => item.key === items[plan.exhaustedReviewer - 1].key)!;
  assert.ok(reviewed.reviewFailovers?.some(failover => failover.profile === 'claude-reviewer' && failover.exhaustion === 'usage-limit' && failover.nextProfile === 'cursor-reviewer'), `the exhausted reviewer bot failed over to the next profile: ${JSON.stringify(reviewed.reviewFailovers)}`);
  // GY-500: disjoint items merged optimistically and infrastructure changes queued; the one that
  // broke main was reverted head-bound within one CI duration of its failing post-merge run, and
  // reopened once, while the main guard's reads and ledger writes stayed bounded per cycle.
  const ledger = async (kind: string) => (await store.pool.query(`SELECT kind, work_id, payload->'details' AS details, created_at FROM events WHERE kind LIKE $1 AND created_at >= $2 ORDER BY seq`, [kind, new Date(dayStart).toISOString()])).rows;
  const keyOf = (workId: string) => final.find(item => item.id === workId)?.key;
  const optimistic = (await ledger('optimistic.merged')).map(row => keyOf(row.work_id));
  const culprit = items[plan.breaksMain - 1].key;
  // Items land in the queue too while main is red or another optimistic merge touches their files.
  assert.ok(new Set(optimistic).size > plan.items / 2, `most items merged optimistically: ${optimistic.join(', ')}`);
  for (const n of plan.infrastructure) assert.ok(!optimistic.includes(items[n - 1].key), `${items[n - 1].key} changes shared infrastructure and queued`);
  assert.equal(optimistic.filter(key => key === culprit).length, 2, `${culprit} merged optimistically, and again after its rework round`);
  assert.deepEqual(github.reverts.map(entry => [entry.key, !!entry.merged]), [[culprit, true]], 'exactly one revert, of the culprit, and it landed');
  const [postMergeFailed] = (await ledger('optimistic.post-merge')).filter(row => keyOf(row.work_id) === culprit && row.details?.verdict === 'fail');
  assert.ok(postMergeFailed, `the culprit's post-merge run failed on main: ${JSON.stringify(await ledger('optimistic.post-merge'))}`);
  const failedAt = new Date(postMergeFailed.created_at).getTime();
  assert.ok(github.reverts[0].mergedAt! - failedAt <= 5 * minute, `the revert landed within one CI duration of the failure (${Math.round((github.reverts[0].mergedAt! - failedAt) / minute)} min)`);
  assert.equal((await ledger('optimistic.revert.merged')).length, 1, 'one merged revert on the ledger');
  assert.equal((await ledger('optimistic.revert.merged')).filter(row => row.details?.reopened?.source === 'optimistic-revert').length, 1, 'one reopen, with the failure attached');
  assert.ok(!github.commits.get(github.tip)!.broken, 'main is green at the end of the day');
  // The loop published its merge-queue settings exactly once for the whole day — on a change, not
  // every cycle (GY-330, GY-498, GY-500, GY-516) — and each setting reached the installation ledger.
  // (The stuck-batch stretch (GY-691) runs the batch plan by pinning the engine's window, as the
  // batch-plan units do; it publishes nothing.)
  assert.equal(mergeQueuePosts.length, 1, `one publication, not one per cycle: ${JSON.stringify(mergeQueuePosts)}`);
  assert.deepEqual(mergeQueuePosts[0].settings, { batchSize: 4, optimistic: true, optimisticExclude: [...defaultOptimisticExclude], parallelTips: 4, rerunFailedChecks: 1 });
  const published = await store.pool.query(`SELECT kind, payload FROM events WHERE kind LIKE 'merge-queue.%' AND created_at >= $1 ORDER BY seq`, [new Date(dayStart).toISOString()]);
  assert.deepEqual(published.rows.map(row => [row.kind, row.payload.previous]), [
    ['merge-queue.batch-size', null], ['merge-queue.parallel-tips', null], ['merge-queue.rerun-failed-checks', null], ['merge-queue.optimistic', null], ['merge-queue.optimistic-exclude', null],
  ], `each setting recorded once: ${JSON.stringify(published.rows)}`);
  assert.deepEqual(await ledger('optimistic.guard.failed'), [], 'the main guard never failed');
  const guardWrites = (await ledger('optimistic.guard')).length;
  assert.ok(guardWrites <= 2 * optimistic.length + 4, `the main guard writes its state only on a change (${guardWrites} rows for ${optimistic.length} optimistic merges)`);
  const busiest = Math.max(...github.reads.commitChecks.values());
  assert.ok(busiest <= 4, `the main guard reads at most a few commits' checks per cycle (${busiest})`);
  // GY-516: each flaky tip was rerun exactly once; the one whose rerun passed merged that tip with no
  // further round, and the one whose rerun failed again went back for one more and was still delivered.
  const flaky = { passes: items[plan.flaky.rerunPasses - 1].key, fails: items[plan.flaky.rerunFails - 1].key };
  assert.deepEqual(github.reruns.map(entry => entry.key).sort(), Object.values(flaky).sort(), `one rerun per flaky tip: ${JSON.stringify(github.reruns)}`);
  const passed = github.reruns.find(entry => entry.key === flaky.passes)!, failed = github.reruns.find(entry => entry.key === flaky.fails)!;
  // The tip whose rerun passed is the one that lands, or the reviewed head it carried is what the
  // landed tip was rebuilt from: a republication resets the branch to that head (GY-568) and its
  // CI passes afresh on the same patch, so the flake still costs no rework round.
  const rerunTipFrom = (final.find(item => item.key === flaky.passes)!.queueHistory ?? []).find(entry => entry.tip === passed.sha)?.from ?? passed.sha;
  assert.ok(github.contains(github.merges.find(entry => entry.key === flaky.passes)!.sha, rerunTipFrom), 'the tip whose rerun passed, or the reviewed head under it, is what landed');
  assert.equal(final.find(item => item.key === flaky.passes)!.pipeline?.reworkRounds ?? 0, 0, 'a flake whose rerun passed costs no rework round');
  assert.equal(final.find(item => item.key === flaky.fails)!.pipeline?.reworkRounds, 1, 'a tip that failed again after its rerun returned to its worker once');
  assert.ok(!github.contains(github.merges.find(entry => entry.key === flaky.fails)!.sha, failed.sha), 'and a new head, not the failed tip, landed');
  // GY-839: the landing check ran in the loop all day, over bases that moved under open candidates.
  // The three-way comparison from the merge base is what a candidate bound behind the tip was
  // judged by, and the fault window's blind answers are the only source of false landing refusals
  // the day has. Each held only the build gate and cleared on the exact head it named, before any
  // worker could react: no ejection, no sync round, no rework.
  assert.ok(github.landingChecks > 0, 'the landing check ran during the simulated day');
  assert.ok(github.landingBases.size >= plan.items, `the landing check judged moving bases (${github.landingBases.size})`);
  assert.ok(github.ancestorCompares > 0, `candidates bound behind the tip were compared from their merge base (${github.ancestorCompares} ancestor compares)`);
  assert.ok(github.blindCompares > 0, `the fault window answered compares without a usable merge base (${github.blindCompares} blind compares)`);
  assert.ok(landingRefusals.length >= 2, `the fault window caught every candidate bound behind it (${JSON.stringify(landingRefusals)})`);
  assert.ok(landingRefusals.every(entry => entry.elapsed >= plan.blind.from - minute && entry.elapsed <= plan.blind.to + minute),
    `a false landing refusal stood only inside the fault window: ${JSON.stringify(landingRefusals)}`);
  for (const entry of landingRefusals) {
    const landed = github.merges.find(merge => merge.key === entry.key);
    assert.ok(landed && github.contains(landed.sha, entry.sha), `${entry.key} landed the exact head its false refusal named (${entry.sha.slice(0, 12)})`);
  }
  assert.ok(sessions.every(session => session.syncs === 0), 'no worker was woken to sync what was never wrong');
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
  // GY-842 across the day: every pane the day's launches opened went somewhere — closed once, by
  // the step that ended its session or by the bounded sweep — the operator's own pane was never
  // touched, the previous day's backlog drained over successive bounded passes, and the drain
  // itself is what stands on the cursor.
  assert.equal(new Set(herdr.closed).size, herdr.closed.length, `no pane was closed twice: ${herdr.closed.join(', ')}`);
  assert.ok(!herdr.closed.includes(foreignPane), 'the pane Graphyard never launched is never closed');
  const reclaimed = herdr.closed.filter(pane => pane.includes(':left'));
  assert.equal(reclaimed.length, plan.leftovers, 'every leftover pane of the previous day is reclaimed');
  const passes = [...new Set(reclaimed.map(pane => herdr.closedAt.get(pane)))];
  assert.ok(passes.length >= 2, `the backlog drained over successive passes, not in one burst (${passes.length})`);
  // The bound paces every pass: however the backlog interleaves with the day's other panes, no
  // pass carries more than six of the leftovers, and the eight take several passes.
  const perPass = [...new Set(reclaimed.map(pane => herdr.closedAt.get(pane)))].map(at => reclaimed.filter(pane => herdr.closedAt.get(pane) === at).length);
  assert.ok(perPass.every(count => count <= 6), `a pass closes at most the bound of six (${perPass.join(', ')})`);
  const sweepStatus = state.actions['sweep:panes:status'];
  assert.match(sweepStatus?.detail ?? '', /0 standing agentless; the backlog has drained/, `the drain is what stands on the record (${sweepStatus?.detail?.slice(0, 200)})`);
  assert.doesNotMatch(sweepStatus?.detail ?? '', /the oldest is pane/, 'no oldest pane outlives the drained day');
  assert.ok(!state.actions['sweep:panes:attention'], 'the day never stood past the agentless attention bound');
  const seconds = (performance.now() - began) / 1000;
  assert.ok(seconds < 120, `the day runs well inside the three minutes the CI test job allows it (${seconds.toFixed(1)} s)`);
});

test('unit:soak-invariants-hold — the parallel-tip window validates several queue positions at once, a failing tip ejects only its own entry while the suffix rebuilds without it, and a mid-day window change is republished, with every system invariant holding', { timeout: 180_000 }, async () => {
  // GY-498: a queue-only day (the optimistic lane off, so every item goes through the queue),
  // released three minutes apart so the queue stays deeper than the window, with the window
  // reconfigured from 4 to 2 an hour and a quarter in. Item four is the one whose first tip fails
  // and keeps failing after its rerun, so the window must attribute the failure to it once the
  // tips ahead pass, eject it alone, and rebuild the tips behind it without it. The main day's
  // other faults (the blind compare window, the file split) stay out of this day: their recovery
  // is exercised there, and here they would only cascade ejections the queue re-queues in a loop.
  // This is the real loop, the real reconciliation job and the real guarded merge across the whole
  // day, so the window's behaviour is exercised as it repeats per cycle, head and entry — not as a
  // one-shot unit fixture.
  const began = performance.now();
  const reconfigure = { at: 75 * minute, window: 2 };
  const failTip = 4;
  const { items, final, github, sessions, violations, failures, lost, mergeQueuePosts, windowSamples, tipPublications, chainedTips, peakWindow, dayStart } =
    await simulateDay({ hours: 4, queued: { window: 4, reconfigure, failTip, releaseEveryMs: 3 * minute } });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  // The window held several published tips at once, and a successor's tip was chained onto the tip
  // of the entry ahead of it — the positions validate concurrently, not one head at a time.
  assert.ok(peakWindow >= 3, `several tips validated at once: ${JSON.stringify(windowSamples)}`);
  assert.ok(chainedTips.size >= 1, `successor tips built on the tip ahead: ${[...chainedTips].join(', ')}`);
  // The failing tip ejected its own entry, named the check, and is not the tip that landed: the
  // entry re-entered and was validated again on a rebuilt tip.
  const ejectee = final.find(item => item.key === items[failTip - 1].key)!;
  const ejection = (ejectee.queueHistory ?? []).find(entry => entry.event === 'ejected' && /Required CI check test did not pass on speculative tip [0-9a-f]{12}/.test(entry.reason ?? ''));
  assert.ok(ejection, `the failing tip ejected its entry: ${JSON.stringify((ejectee.queueHistory ?? []).map(entry => [entry.event, entry.reason]))}`);
  assert.match(ejection!.reason!, /rerun/, 'the rerun is named in the ejection');
  const failedTip = ejection!.tip!;
  assert.ok((ejectee.queueHistory ?? []).some((entry, index) => entry.event === 'enqueued' && index > (ejectee.queueHistory ?? []).indexOf(ejection!)), 'the ejected entry re-entered the queue');
  const landed = github.merges.filter(merge => merge.key === ejectee.key);
  assert.ok(landed.length >= 1 && landed.every(merge => !github.contains(merge.sha, failedTip)), 'what landed is a rebuilt tip, not the failed one');
  assert.ok(github.merges.every(merge => !github.contains(merge.sha, failedTip)), 'the failed tip never landed');
  // The suffix rebuilt: an entry that held a tip chained onto the failed tip later held — and
  // landed — a tip that does not contain it, so the tips behind the culprit were rebuilt without it.
  const successor = [...chainedTips].find(chaining => chaining.startsWith(`${ejectee.key}->`))?.split('->')[1];
  assert.ok(successor, `an entry behind the ejectee held a tip chained onto the failed tip: ${[...chainedTips].join(', ')}`);
  const successorTips = tipPublications.filter(publication => publication.key === successor).map(publication => publication.tip);
  assert.ok(successorTips.some(tip => github.contains(tip, failedTip)), 'its first tip was chained onto the failed tip');
  const successorLanded = github.merges.find(merge => merge.key === successor);
  assert.ok(successorLanded && !github.contains(successorLanded.sha, failedTip), 'the entry behind landed a tip rebuilt without the ejected entry');
  // The mid-day master-config edit was published once the loop next cycled, applied at once, and a
  // restarted control plane reads it back from the installation ledger; no tip after it was
  // published outside the narrowed window.
  assert.deepEqual(mergeQueuePosts.map(post => post.settings), [
    { batchSize: 4, optimistic: false, optimisticExclude: [...defaultOptimisticExclude], parallelTips: 4, rerunFailedChecks: 1 },
    { batchSize: 4, optimistic: false, optimisticExclude: [...defaultOptimisticExclude], parallelTips: 2, rerunFailedChecks: 1 },
  ], `the reconfiguration was published once, on its change: ${JSON.stringify(mergeQueuePosts)}`);
  assert.ok(mergeQueuePosts[1].at - dayStart >= reconfigure.at, 'the reconfiguration was published after the config edit');
  // The reconfiguration reached the installation ledger (a value the ledger already holds — the
  // default 4, published by an earlier day in this file — is not re-recorded, only applied).
  const tips = await store.pool.query(`SELECT payload FROM events WHERE kind='merge-queue.parallel-tips' ORDER BY seq`);
  assert.deepEqual(tips.rows.at(-1)!.payload.parallelTips, reconfigure.window, 'the narrowed window reached the installation ledger');
  assert.deepEqual(tips.rows.at(-1)!.payload.previous, 4, 'the ledger records the window it moved from');
  const late = tipPublications.filter(publication => publication.at >= reconfigure.at + 2 * minute);
  assert.ok(late.length >= 1, `the queue kept publishing under the narrowed window: ${JSON.stringify(tipPublications)}`);
  assert.ok(late.every(publication => publication.position < reconfigure.window), `every publication after the change sat inside the narrowed window: ${JSON.stringify(late)}`);
  assert.equal(engine.parallelTips, reconfigure.window, 'the control plane applies the master\'s window at once');
  assert.equal(await new Engine(store).loadParallelTips(), reconfigure.window, 'a restarted control plane reads the window back from the installation ledger');
  const status = await api(principals.coordinator, 'GET', 'status');
  assert.equal(status.mergeQueue.parallelTips, reconfigure.window, 'status reports the narrowed window');
  const seconds = (performance.now() - began) / 1000;
  assert.ok(seconds < 150, `the queue-only day runs inside its budget (${seconds.toFixed(1)} s)`);
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
