import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Work } from '../src/model.js';
import { classifyAttention } from '../src/model/fault-classes.js';
// Namespace imports for what GY-1345 adds, so a run against the base fails its cases rather than the module's load.
import * as blockerClass from '../src/model/blocker-class.js';
import * as faultsStep from '../src/daemon/faults.js';
import { dispatchFailureBlockAfter, noteDispatchFailure } from '../src/daemon/dispatch-failures.js';
import { dispatchFailureAttention } from '../src/auto-dispatch.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { actionableSubjects, cycleCost, daemonEffects, emptyDaemonState, loopAttention, loopLiveness, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { reworkWokenObservationMaxAgeMs } from '../src/daemon/decisions.js';
import { RefusedResponse } from '../src/model/refusal.js';
import { noteCycleFailure, type CycleCost } from '../src/daemon/liveness.js';
// A namespace import for what GY-1355 adds, so a run against the base fails its cases rather than the module's load.
import * as livenessModule from '../src/daemon/liveness.js';
import type { CycleMetrics } from '../src/daemon/state.js';
import { Timings, timedCall, withTimings } from '../src/master/timings.js';
import { checkInvariants, emptyInvariantRecord } from '../src/model/invariants.js';
import * as deploymentModule from '../src/daemon/deployment.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { readCoordinatorCheckout } from '../src/master/profiles.js';
// A namespace import for what GY-1356 adds, so a run against the base fails its cases rather than the module's load.
import * as upgradeModule from '../src/daemon/upgrade.js';

// GY-1092 names this file for its proof: manual:fault-class-loop. The master loop filed ten loop
// faults in a day, and they share one cause: the loop recorded as its own failure a wait that
// belonged to someone it cannot move.
//
// - Nine were action:diagnosis faults, one per recurring-fault item (GY-1083 … GY-1091): the
//   diagnostician's provider answered every run with its weekly limit. GY-2186 retired the
//   diagnostician and every loop-filed item, so those replays are gone with it.
// - One is loop-silence on GY-727: its head bc00115a held unit:reconcile-tick-bounded recorded as
//   not exercising AC-2, so no producer would ever be launched for it, and only the rework decision
//   could move it. The silence measure still counted the proof as the loop's own to produce and,
//   after 437 minutes, said nothing had acted. The rework decision is the subject now.
//
// Each instance is replayed below against what the loop does; each test fails on the base.

// The 2026-09/10 instants are recorded ledger instances and explicit nows handed to the folds, upgrades and checkout guards; slowPlane's Date.now() runs under the cycle tests' mock.timers clock, and the checkout guards' snapshots hold no work, so the Date.now() stamping their now meets no lease.
const silenceInstance = { id: 'loop-silence|GY-727|2026-10-01T16:02:06.353Z', kind: 'loop-silence', subject: 'GY-727', at: '2026-10-01T16:02:06.353Z' };
const minute = 60_000, hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [], run: { proofWorkflow: 'acceptance.yml' } });
}
function item(key: string, at: number, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: iso(at - 3 * hour), updatedAt: iso(at), stageEnteredAt: iso(at - hour), ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}

// ---- GY-727: a proof only a rework decision can move -----------------------------------------

const silentAt = Date.parse('2026-10-01T16:02:06.353Z');
const head = 'bc00115a30efdd0e97af316cd80ed7e8e518a655', base = '070161c467b01c8472593159f46a1bff75b43ec9';
const record = (proof: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), proof, sha: head, baseSha: base, result: 'pass', trusted: true, policyRevision: 2,
  skipped: 0, executed: 3, producer: 'graphyard-acceptance', at: '2026-09-27T05:40:00.000Z', ...extra });
/** GY-727 as it stood: submitted at bc00115a, its unit request long past the producer timeout, one proof recorded as not exercising AC-2. */
function gy727(unexercised: boolean): Work {
  return item('GY-727', silentAt, {
    stage: 'build', ready: true, epoch: 5, policyRevision: 2,
    criteria: [{ id: 'AC-1', text: 'reads once', proofs: ['unit:reconcile-reads-open-items-once'] }, { id: 'AC-2', text: 'tick bounded', proofs: ['unit:reconcile-tick-bounded'] }] as Work['criteria'],
    submission: { epoch: 5, pr: 338, submittedAt: '2026-09-27T05:10:00.000Z' } as unknown as Work['submission'],
    candidate: { sha: head, baseSha: base, pr: 338 } as unknown as Work['candidate'],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] },
      { name: 'acceptance', passed: false, reasons: ['AC-2: unit:reconcile-tick-bounded needs trusted passing evidence'] }] as Work['gates'],
    evidence: [record('unit:reconcile-reads-open-items-once'),
      record('unit:reconcile-tick-bounded', unexercised ? { trusted: false, unexercised: 'unit:reconcile-tick-bounded does not exercise AC-2: it passed against the tree with "Batches yield if they exceed reconcileBatchMs time" removed',
        exercise: { result: 'pass', executed: 3, behaviour: 'Batches yield if they exceed reconcileBatchMs time. Exercise: removed batch time limit check.', criterion: 'AC-2' } } : { trusted: false })] as unknown as Work['evidence'],
    autoDispatch: { review: null, history: [], producers: [{ id: '02337aa21d3feea7d575d1a00f3ea23a', pr: 338, sha: head, baseSha: base, kind: 'producer', group: 'unit', state: 'requested',
      proofs: ['unit:reconcile-reads-open-items-once', 'unit:reconcile-tick-bounded'], reason: 'no trusted evidence binds bc00115a30ef', requestedAt: '2026-09-27T05:12:55.795Z', policyRevision: 2 }] } as unknown as Work['autoDispatch'],
  });
}
test(`manual:fault-class-loop — ${silenceInstance.id}: a proof recorded as not exercising its criterion is the rework decision's wait, not the loop's silence`, () => {
  const master = config();
  const subjects = actionableSubjects(master, [gy727(true)], silentAt).map(subject => subject.key);
  assert.ok(!subjects.includes('proof:GY-727'), subjects.join(', '));
  // The wait stays named: the decision subject is on the inventory the loop keeps, for the master
  // session's wake, while no proof subject is invented for it. (GY-1980 removed the silence bound
  // the instance was filed under; whether the whole pipeline has gone still is the progress
  // watchdog's judgement, not a per-subject wait.)
  assert.ok(subjects.includes('decision:GY-727'), subjects.join(', '));
});

// ---- GY-1266: three loop faults on 2026-10-05 ---------------------------------------------------
//
// GY-1266 names this file for its proof too. Its three instances share one cause: under GitHub
// delivery a merge burst moved the base under every open candidate, and the loop answered each
// head that then needed rework by waking its observation and waiting for one under two minutes old.
// The wake lands within the cycle, but the next cycle reads it one 300s interval later, so every
// landed observation was stale again: the wake was sent again — each a server reconcile of 3-14s,
// one after another in the decisions step — and no rework was ever requested.
//
// - loop-cost on loop: cycle 12245 spent 336s of 375s in the decisions step, past the interval.
// - loop-silence on GY-1132: nothing acted for 81 minutes on a head whose rework was never
//   requested; the silence named its missing proofs, which under GitHub delivery nobody produces.
// - action:diagnosis on GY-1252 (a recurring item closed while it was diagnosed, recorded as the
//   loop's failed action) is retired with the diagnostician (GY-2186) and replayed no more.

const gy1266Instances = [
  { id: 'loop-silence|GY-1132|2026-10-05T05:25:42.725Z', kind: 'loop-silence', subject: 'GY-1132' },
  { id: 'loop-cost|loop|2026-10-05T06:10:59.591Z', kind: 'loop-cost', subject: 'loop' },
];
const burstClock = Date.parse('2026-10-05T04:04:00.000Z'), intervalMs = 300_000, head1266 = 'a'.repeat(40), base1266 = 'b'.repeat(40);
/** A loop as the incident ran it: a reviewer App, an operator-agent's decisions, and the 300s interval. */
function burstConfig(run: Record<string, unknown> = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: iso(burstClock - hour) },
    reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], producers: [], run: { intervalSeconds: intervalMs / 1000, ...run } });
}
/** A submitted head a changes-requested verdict stands against, last observed at `observedAt`: it needs rework. */
function reworkHead(key: string, observedAt: number, overrides: Partial<Work> = {}): Work {
  const observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: head1266, baseSha: base1266, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'independent-reviewer', sha: head1266, state: 'CHANGES_REQUESTED' }], protected: true, mergeable: true, merged: false,
    mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: iso(observedAt), prState: 'open', draft: false, baseTip: base1266, baseTipContained: true };
  return item(key, observedAt, { criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', ready: true, epoch: 1,
    submission: { epoch: 1, pr: 42 }, candidate: { sha: head1266, baseSha: base1266, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, observation,
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], ...overrides } as Partial<Work>);
}
/**
 * The merge burst, replayed: each 300s cycle ten more heads need rework, last observed three
 * minutes before they did. A wake costs the 8s server reconcile a resync measured that morning, and
 * its observation lands 30s after it is sent, as a prioritized wake does.
 */
const wave = 10;
/** The body the loop's production effects send to the server for `call`. */
async function sent(call: (effects: DaemonEffects) => Promise<unknown>) {
  const bodies: Record<string, unknown>[] = [];
  const live = daemonEffects('/nonexistent/gy-1266', burstConfig(), { snapshot: async () => ({ work: [], now: iso(burstClock) }),
    mutate: async (_path, data) => { bodies.push(data as Record<string, unknown>); return {}; }});
  await call(live);
  return bodies[0] ?? {};
}
async function replayBurst(cycles: number) {
  const config = burstConfig(), state = emptyDaemonState(config);
  const heads: { key: string; observedAt: number }[] = [];
  const landing = new Map<string, number>(), requested: string[] = [], wakes: { key: string; cycle: number }[] = [];
  const decisions = new Map<string, { id: string; action: string; state: string }[]>();
  let now = burstClock, cycle = 0;
  const snapshot = () => ({ work: heads.map(head => reworkHead(head.key, landing.has(head.key) && landing.get(head.key)! <= now ? landing.get(head.key)! : head.observedAt)), now: iso(now), jobs: [] });
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => snapshot(),
    closeSession: () => {}, dispatch: async () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
    // The wake goes through the loop's own effects, to a server that serves a prioritized wake ahead
    // of the polled backlog; the burst's backlog served no other wake inside the replay (GY-612's,
    // sent unprioritized at 06:23, had still not landed at 06:44).
    wakeObservation: async work => {
      wakes.push({ key: work.key, cycle });
      const resync = await sent(live => live.wakeObservation!(work));
      // GY-1286: a wake that asks for no tick (`wait: false`) is answered once the job is woken.
      now += resync.wait === false ? 500 : 8_000;
      if (resync.prioritized === true) landing.set(work.key, now + 30_000);
    },
    decide: async (work, action) => { requested.push(work.key); const id = randomUUID(); decisions.set(work.id, [...decisions.get(work.id) ?? [], { id, action, state: 'requested' }]); return { id }; },
    decisions: async work => ({ decisions: decisions.get(work.id) ?? [] }) as never,
    approver: async work => ({ agentName: `graphyard-approver-${work.key.toLowerCase()}`, pane: `pane-${work.key}` }),
    persist: async () => {},
  } as DaemonEffects;
  const results = [];
  for (cycle = 0; cycle < cycles; cycle++) {
    now = burstClock + cycle * intervalMs;
    for (let index = 0; index < wave; index++) heads.push({ key: `GY-${2000 + cycle * wave + index}`, observedAt: now - 3 * minute });
    results.push(await runCycle(config, state, effects, () => now));
  }
  return { results, requested, wakes, heads };
}

test(`manual:fault-class-loop — ${gy1266Instances[1].id}: a merge burst's rework heads are decided from the observation the loop woke, so wakes stop repeating and the decisions step fits the interval`, async () => {
  const { results, requested, wakes, heads } = await replayBurst(6);
  for (const result of results) {
    const cost = cycleCost(result.metrics, intervalMs)!;
    assert.ok(cost.withinInterval, `cycle ${result.metrics.cycle} spent ${cost.workMs}ms of work against the ${intervalMs}ms interval: ${cost.breakdown}`);
  }
  // One wake per head, never one per head per cycle: the reading a wake brought in is decided from
  // (within reworkWokenObservationMaxAgeMs; a request still standing past that is observed afresh).
  for (let cycle = 0; cycle * intervalMs < reworkWokenObservationMaxAgeMs; cycle++)
    assert.deepEqual(wakes.filter(wake => wake.cycle === cycle).map(wake => wake.key), heads.slice(cycle * wave, (cycle + 1) * wave).map(head => head.key), `cycle ${cycle} wakes only the heads new to it`);
  assert.deepEqual([...new Set(requested)].sort(), heads.slice(0, 5 * wave).map(head => head.key).sort(), 'every head woken before the last cycle has its rework requested');
});

test(`manual:fault-class-loop — ${gy1266Instances[0].id}: no head waits for a rework the loop never requests`, async () => {
  const { requested, heads } = await replayBurst(6);
  // A rework head is requested on the cycle after its wake: none of the burst's heads is left
  // without a request, so none can sit unowned the way the filed instance's head did.
  assert.deepEqual([...new Set(requested)].sort(), heads.slice(0, 5 * wave).map(head => head.key).sort(), 'every burst head has its rework requested');
});

test(`manual:fault-class-loop — ${gy1266Instances[0].id}: GitHub delivery being the only delivery, a missing proof is nobody's to produce, so it is no subject of the loop's silence and no workflow is requested for it`, async () => {
  const at = Date.parse('2026-10-05T05:25:42.725Z');
  const gy1132 = reworkHead('GY-1132', at - minute, { gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }],
    observation: { ...reworkHead('GY-1132', at - minute).observation!, reviews: [] } } as Partial<Work>);
  const master = burstConfig({ proofWorkflow: 'acceptance.yml' });
  const subjects = actionableSubjects(master, [gy1132], at).map(subject => subject.key);
  assert.ok(!subjects.includes('proof:GY-1132'), subjects.join(', '));
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [gy1132], now: iso(at), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(at), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
    persist: async () => {} } as unknown as DaemonEffects;
  await runCycle(master, emptyDaemonState(master), effects, () => at);
});

// ---- GY-1286: three more loop faults on 2026-10-05 ----------------------------------------------
//
// GY-1286 names this file for its proof too (the GY-1234 instance, which needs the control plane's
// store, is replayed in tests/loop-faults-dispatch-wake.test.ts). The three instances share one
// cause: the loop waited, serially, on control-plane writes that could not finish inside it.
//
// - loop-cost on loop: cycle 12285 spent 319s of its own work in the decisions step against the
//   300s interval, and cycle 12293, after GY-1266 was loaded, 365s. Its slow calls were rework
//   `decide` requests and observation wakes (`resync`), each running into its 30s timeout, one
//   after another: a wake waited on the server's reconcile ticks, and a decision request on the
//   server's lock. The step now has a budget and hands what is left to the next cycle, which
//   reaches it first, and a wake waits on no tick.
// - loop-silence on GY-1135: 28 minutes on "missing trusted evidence" for a head under GitHub
//   delivery, which no producer serves. The base already clears it: GY-1266 counts no proof under
//   GitHub delivery. It recurred because the loop process that raised it (started 06:36Z) still
//   ran the code from before GY-1266's merge at 08:03Z until its upgrade went through at 08:35Z.
//   The test below pins it.
// - loop-silence on GY-1234: see tests/loop-faults-dispatch-wake.test.ts.

const gy1286Instances = [
  { id: 'loop-cost|loop|2026-10-05T08:21:38.779Z', kind: 'loop-cost', subject: 'loop' },
  { id: 'loop-silence|GY-1135|2026-10-05T08:25:25.831Z', kind: 'loop-silence', subject: 'GY-1135' },
  { id: 'loop-silence|GY-1234|2026-10-05T08:35:58.217Z', kind: 'loop-silence', subject: 'GY-1234' },
];
/** The 30s request timeout every slow call of cycles 12285 and 12293 ran into. */
const requestTimeoutMs = 30_000;
/**
 * Cycle 12293's backlog, replayed: twelve rework heads observed three minutes ago, whose rework
 * waits for a wake, and twelve observed moments ago, whose decision requests each time out after 30s. The server answers a wake at once when it asks for no tick, and after a 30s tick wait
 * otherwise, as it did that morning.
 */
async function replaySlowServer(cycles: number, attesting = 0) {
  const config = burstConfig(), state = emptyDaemonState(config);
  const fresh = Array.from({ length: 12 }, (_, index) => `GY-${3000 + index}`), stale = Array.from({ length: 12 }, (_, index) => `GY-${3100 + index}`);
  const attested = Array.from({ length: attesting }, (_, index) => `GY-${3200 + index}`);
  const decided: { key: string; cycle: number; action: string }[] = [], woken: { key: string; cycle: number; body: Record<string, unknown> }[] = [];
  let now = burstClock, cycle = 0;
  const snapshot = () => ({ work: [...stale.map(key => reworkHead(key, burstClock - 3 * minute)), ...fresh.map(key => reworkHead(key, now - 30_000)), ...attested.map(key => attestHead(key, now - 30_000))], now: iso(now), jobs: [] });
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => snapshot(),
    closeSession: () => {}, dispatch: async () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
    wakeObservation: async work => {
      const body = await sent(live => live.wakeObservation!(work));
      woken.push({ key: work.key, cycle, body });
      now += body.wait === false ? 500 : requestTimeoutMs;
    },
    decide: async (work, action) => { decided.push({ key: work.key, cycle, action }); now += requestTimeoutMs; throw new Error('The operation was aborted due to timeout'); },
    decisions: async () => ({ decisions: [] }) as never,
    approver: async work => ({ agentName: `graphyard-approver-${work.key.toLowerCase()}`, pane: `pane-${work.key}` }),
    persist: async () => {},
  } as DaemonEffects;
  const results = [], deferred: string[][] = [];
  for (cycle = 0; cycle < cycles; cycle++) {
    now = burstClock + cycle * intervalMs;
    results.push(await runCycle(config, state, effects, () => now));
    deferred.push([...state.decisionsDeferred]);
  }
  return { results, decided, woken, deferred, fresh, stale, attested };
}
/** A head whose only refusal left is a `manual:` proof no producer may run: the loop's attestation pass requests it. */
function attestHead(key: string, observedAt: number): Work {
  return reworkHead(key, observedAt, { stage: 'acceptance', reworkRequested: false, criteria: [{ id: 'AC-1', text: 'Attested', proofs: ['manual:attested'] }],
    observation: { ...reworkHead(key, observedAt).observation!, reviews: [{ reviewer: 'independent-reviewer', sha: head1266, state: 'APPROVED' }] },
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'acceptance', passed: false, reasons: ['AC-1: manual:attested needs trusted passing evidence on the current candidate'] }] } as Partial<Work>);
}

test(`manual:fault-class-loop — ${gy1286Instances[0].id}: decision requests that each run into the 30s timeout no longer carry the decisions step past the interval`, async () => {
  const { results } = await replaySlowServer(4);
  for (const result of results) {
    const cost = cycleCost(result.metrics, intervalMs)!;
    assert.ok(cost.withinInterval, `cycle ${result.metrics.cycle} spent ${cost.workMs}ms of work against the ${intervalMs}ms interval: ${cost.breakdown}`);
  }
});

test(`manual:fault-class-loop — ${gy1286Instances[0].id}: what the step puts off is reached first on the next cycle, so every head is still requested`, async () => {
  const { results, decided, deferred, fresh } = await replaySlowServer(4);
  assert.ok(deferred[0].length, 'the first cycle runs out of budget and puts items off');
  const first = decided.filter(entry => entry.cycle === 1).map(entry => entry.key);
  assert.equal(first[0], deferred[0].find(key => fresh.includes(key)), 'the next cycle starts with what the last one put off');
  assert.deepEqual([...new Set(decided.map(entry => entry.key))].sort(), [...fresh].sort(), 'every fresh head has its rework requested within four cycles');
  const note = results[0].actions.find(action => action.detail.startsWith('The decisions step spent its'));
  assert.match(note?.detail ?? '', /120s budget; \d+ item\(s\) wait for the next cycle/);
});

test(`manual:fault-class-loop — ${gy1286Instances[0].id}: attestations reached only after the rework pass spent the budget are still requested, the oldest put off first`, async () => {
  // The review of the first fix: the attestation pass ran after the rework pass on the same clock,
  // in snapshot order, so under a sustained slow server it found the budget spent every cycle and
  // put every attestation off for good. Each pass now reaches the oldest item it put off first.
  const { decided, deferred, attested } = await replaySlowServer(4, 3);
  assert.deepEqual(deferred[0].filter(key => attested.includes(key)), attested.slice(1), `past the budget the pass reaches its first attestation and puts the rest off: ${JSON.stringify(deferred[0])}`);
  const first = attested.map(key => decided.find(entry => entry.action === 'attest' && entry.key === key));
  assert.deepEqual(first.map(entry => entry?.cycle), [0, 1, 2], `each cycle requests the oldest attestation put off, so none waits for good: ${JSON.stringify(decided.filter(entry => entry.action === 'attest'))}`);
});

test(`manual:fault-class-loop — ${gy1286Instances[0].id}: an observation wake asks for no reconcile tick, so it costs the step no tick wait`, async () => {
  const body = await sent(live => live.wakeObservation!(reworkHead('GY-3100', burstClock)));
  assert.deepEqual(body, { prioritized: true, wait: false });
  const { woken, stale } = await replaySlowServer(1);
  assert.deepEqual(woken.map(entry => entry.key).sort(), [...stale].sort(), 'every stale head is woken in the first cycle');
});

test(`manual:fault-class-loop — ${gy1286Instances[1].id}: a head under GitHub delivery missing a proof no producer serves is no subject of the loop's silence`, () => {
  // GY-1135 at 08:25: its rework head 8b364f91 submitted at 08:04, build and review passing, the
  // required test check failing while its failed jobs reran, unit:agy-quota-notice-detected unproduced.
  const at = Date.parse(gy1286Instances[1].id.split('|')[2]);
  const gates = [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
    { name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate; rerun: its failed jobs are rerunning (workflow run 37281344467)'] },
    { name: 'merge', passed: true, reasons: [] }, { name: 'github-delivery', passed: true, reasons: [] }];
  const gy1135 = reworkHead('GY-1135', at - 21 * minute, { criteria: [{ id: 'AC-1', text: 'Notice detected', proofs: ['unit:agy-quota-notice-detected'] }], gates,
    observation: { ...reworkHead('GY-1135', at - 21 * minute).observation!, reviews: [] } } as Partial<Work>);
  const master = burstConfig({ proofWorkflow: 'acceptance.yml' });
  const subjects = actionableSubjects(master, [gy1135], at);
  assert.ok(!subjects.some(subject => subject.kind === 'proof'), JSON.stringify(subjects));
});

// ---- GY-1355: the loop-cost lines named the coarse 'deployment' bucket for the faults step ------
//
// GY-1355 names this file for its proof too, beside the GY-1336 lineage. Cycles 12621 and 12624 on
// 2026-10-06 spent 450s and 781s of their own work, past the 300s interval (and, for 12624, the
// 600s liveness bound). The cycle folds four timed steps — deployment verification, faults, triage
// and doctor — into the one coarse 'deployment' bucket, and the loop-cost attention named that
// bucket: "The deployment step is the slowest … shorten the deployment step". Its own timings
// (metrics.timings) say the faults step's observation took 372.1s/577.9s and the release-landing
// verification 8.7s/8.4s, so GY-1354 was filed against the wrong step. Replayed in the production
// shape, as the cursor recorded it.

const gy1355Instances = [
  { cycle: 12621, at: '2026-10-06T01:52:51.656Z', workMs: 450_000, faults: 372_072, verification: 8_681, deployment: 381_934, decisions: 58_862 },
  { cycle: 12624, at: '2026-10-06T02:10:30.000Z', workMs: 781_000, faults: 577_948, verification: 8_414, deployment: 587_055, decisions: 148_184 },
];
const productionIntervalMs = 300_000;
function productionCycle(entry: typeof gy1355Instances[number], timings = true): CycleMetrics {
  const observe = entry.workMs - entry.deployment - entry.decisions, zero = { ms: 0, childWaitMs: 0 };
  return { cycle: entry.cycle, at: entry.at, durationMs: entry.workMs, childWaitMs: 0, workMs: entry.workMs, open: 4, actions: 59,
    steps: { observe: { ms: observe, childWaitMs: 0 }, close: zero, decisions: { ms: entry.decisions, childWaitMs: 0 }, dispatch: zero, merge: zero, deployment: { ms: entry.deployment, childWaitMs: 0 } },
    ...(timings ? { timings: { totalMs: entry.workMs, calls: [], slowCalls: 37, steps: [{ step: 'snapshot', ms: observe }, { step: 'decisions', ms: entry.decisions },
      { step: 'deployment verification', ms: entry.verification }, { step: 'faults', ms: entry.faults }, { step: 'triage', ms: 400 }, { step: 'doctor', ms: entry.deployment - entry.faults - entry.verification - 400 }] } } : {}) } as CycleMetrics;
}
const costLine = (cost: CycleCost) => loopAttention({ liveness: { state: 'running', lagMs: 1_000, stalledAfterMs: 2 * productionIntervalMs, cycle: cost.cycle, lock: null, detail: '', restart: '', cost }, cost })
  .find(entry => entry.kind === 'loop-cost');

for (const entry of gy1355Instances) {
  test(`manual:fault-class-loop — GY-1355 cycle ${entry.cycle}: the loop-cost attention names the faults step, never deployment as the step to shorten`, () => {
    const cost = cycleCost(productionCycle(entry), productionIntervalMs)!;
    assert.equal(cost.slowest?.step, 'deployment', 'the coarse bucket is still the slowest bucket, and the breakdown keeps it');
    const line = costLine(cost);
    assert.ok(line, 'the cycle past its interval raises the loop-cost line');
    assert.match(line.text, new RegExp(`The faults step is the slowest timed step, at ${Math.round(entry.faults / 1000)}s`));
    assert.match(line.next ?? '', /shorten the faults step rather than restarting/);
    for (const text of [line.text, line.next ?? '']) {
      assert.doesNotMatch(text, /[Tt]he deployment step/, text);
      assert.doesNotMatch(text, /shorten the deployment/, text);
    }
  });
}

test('unit:loop-cost-timed-step-attribution — the slowest timed step names the loop-cost line whenever the cycle recorded timings; the coarse bucket only without them', () => {
  const [entry] = gy1355Instances;
  const timed = cycleCost(productionCycle(entry), productionIntervalMs)!;
  assert.deepEqual(timed.culprit, { step: 'faults', ms: entry.faults, timed: true, phrase: 'the faults step' });
  assert.deepEqual(timed.slowestSteps[0], { step: 'faults', ms: entry.faults }, 'the same step slowCycleAttention names');
  // A slow cycle, still inside it: the liveness detail and its advice name the timed step too.
  const lock = { id: 'loop', pid: process.pid, host: 'machine-a', startedAt: entry.at, heartbeatAt: entry.at };
  const slow = loopLiveness({ lock, cycle: entry.cycle + 1, lastCycleAt: entry.at, metrics: [productionCycle(gy1355Instances[1])] }, Date.parse(entry.at) + 700_000, productionIntervalMs, 'machine-a');
  assert.equal(slow.state, 'slow');
  assert.match(slow.detail, /the faults step is the one to shorten/);
  assert.match(loopAttention({ liveness: slow })[0].next ?? '', /shorten the faults step/);
  // A cycle recorded before timings existed falls back to the bucket.
  const untimed = cycleCost(productionCycle(entry, false), productionIntervalMs)!;
  assert.equal(untimed.culprit?.step, 'deployment');
  assert.equal(untimed.culprit?.timed, false);
});

test('unit:deployment-bucket-rollup-named — a coarse bucket reported as slowest is named as the roll-up it is, never as the release-landing verification', () => {
  for (const entry of gy1355Instances) {
    const line = costLine(cycleCost(productionCycle(entry, false), productionIntervalMs)!)!;
    assert.match(line.text, new RegExp(`The deployment bucket is the slowest, at ${Math.round(entry.deployment / 1000)}s of work; it rolls up the deployment verification, faults, triage and doctor steps, so no one step inside it is named`));
    assert.match(line.next ?? '', /shorten the deployment bucket, which rolls up the deployment verification, faults, triage and doctor steps/);
    assert.doesNotMatch(`${line.text} ${line.next}`, /[Tt]he deployment step/);
  }
  // Every coarse bucket has its roll-up named.
  assert.deepEqual(Object.keys(livenessModule.cycleBucketSteps ?? {}), ['observe', 'close', 'decisions', 'dispatch', 'merge', 'deployment']);
});

// ---- GY-1345: one plane-wide control-plane window files five loop faults ------------------------
//
// GY-1345 names this file for its proof too. From 01:39 to 02:01Z on 2026-10-06 the production
// control plane answered writes 502 "Application failed to respond", reads in 1-21s, and the
// dispatcher's ticks ran into their 30s timeout. The loop counted each consequence as its own failure:
// (2) dispatch: six ticks timed out in a row and raised the standing dispatch-failures line;
// (4) loop: cycle 12621's faults step read the slow plane for 372s, past the 300s interval.
// (The diagnosis refusals (1) and (3) and the loop class's own failed filing (5) are retired with
// the diagnostician and the filings, GY-2186.) Each replayed instance is below; each test fails on
// the base, where it opens a loop-class fault instance.

const gy1345Instances = [
  { id: 'dispatch-failures|dispatch|2026-10-06T01:44:37.500Z', kind: 'dispatch-failures', subject: 'dispatch', at: '2026-10-06T01:44:37.500Z' },
  { id: 'loop-cost|loop|2026-10-06T01:52:51.656Z', kind: 'loop-cost', subject: 'loop', at: '2026-10-06T01:52:51.656Z' },
];
/** The refusals and the timeout, word for word as the window recorded them. */
const decide502 = 'Graphyard refused work/0e2e01dc-cbd9-4d41-9b88-4f917acb7bb5/decisions (502): {"status":"error","code":502,"message":"Application failed to respond","request_id":"JKn5sxMXSLKpQMhF9fVATg"}';
const file502 = 'Graphyard refused work (502): {"status":"error","code":502,"message":"Application failed to respond","request_id":"ZLTChWnfSliwZLfq0_TJvA"}';
const tickTimeout = 'The operation was aborted due to timeout';
const { itemSpecificPlaneError } = blockerClass;
const planeWideFailure = (text: string | null) => blockerClass.planeWideFailure(text);
const faultObservationBudgetMs = (intervalMs: number) => faultsStep.faultObservationBudgetMs(intervalMs);

test(`unit:plane-wide-dispatch-tick-not-counted — ${gy1345Instances[0].id}: ticks timing out on the plane raise no dispatch-failures line; an item-specific tick failure still does`, () => {
  const at = gy1345Instances[0].at;
  const timedOut = { consecutiveFailures: 6, lastSuccessAt: '2026-10-06T02:00:08.805Z', lastFailure: { at: '2026-10-06T02:01:31.908Z', reason: tickTimeout } };
  // The master still sees that nothing launches, but as the outage (GY-1344's plane-unavailable, deployment class), never a dispatch-failures loop fault.
  for (const reason of [tickTimeout, decide502])
    assert.deepEqual(classifyAttention(dispatchFailureAttention({ ...timedOut, lastFailure: { at, reason } })).map(line => [line.kind, line.faultClass]), [['plane-unavailable', 'deployment']], reason);
  const own = dispatchFailureAttention({ ...timedOut, lastFailure: { at, reason: 'Herdr refused agent start: workspace w1V not found' } });
  assert.deepEqual(classifyAttention(own).map(line => [line.subject, line.kind, line.faultClass]), [['dispatch', 'dispatch-failures', 'loop']]);
  const persisting = dispatchFailureAttention({ ...timedOut, lastFailure: { at, reason: `the dispatch cursor could not be persisted: ${tickTimeout}`, field: 'lastTick.reasons[0]' } });
  assert.equal(persisting.length, 1, 'a tick that could not persist names its own field and stands');
  // An item's dispatch failing on the plane never counts toward the dispatch-failure blocker; its own cause still does.
  const state = emptyDaemonState(config());
  for (let epoch = 0; epoch < 2 * dispatchFailureBlockAfter; epoch++) assert.equal(noteDispatchFailure(state, { id: 'work-GY-9', key: 'GY-9', epoch }, tickTimeout, at).count, 0);
  assert.equal(state.dispatchFailures['work-GY-9'], undefined);
  const counts = [0, 1, 2].map(epoch => noteDispatchFailure(state, { id: 'work-GY-9', key: 'GY-9', epoch }, 'fatal: worktree already holds branch graphyard/gy-9-1', at).count);
  assert.deepEqual(counts, [1, 2, dispatchFailureBlockAfter]);
  assert.equal(noteDispatchFailure(state, { id: 'work-GY-9', key: 'GY-9', epoch: 3 }, decide502, at).count, 0, 'a plane-wide failure meanwhile neither counts nor ends the item\'s own run');
  assert.equal((state.dispatchFailures as Record<string, { count: number }>)['work-GY-9'].count, dispatchFailureBlockAfter);
});

test(`unit:plane-wide-dispatch-tick-not-counted — ${gy1345Instances[0].id}: an item's dispatch failing on the plane cools no profile, while its own cause still does`, async () => {
  const master = masterConfigSchema.parse({ ...burstConfig(), workers: [{ name: 'builder', principal: 'worker-a', agentName: 'agent-builder', mode: 'launch', kind: 'claude', credentialFile: '/outside/builder.token' }] });
  const at = Date.parse(gy1345Instances[0].at), work = item('GY-9', at, { stage: 'build', ready: true, epoch: 1 } as Partial<Work>);
  const cycleWith = async (failure: string) => {
    const state = emptyDaemonState(master);
    const effects = { agents: () => [], credentials: async (profiles: { name: string }[]) => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: [work], now: iso(at) }), closeSession: () => {}, dispatch: async () => { throw new Error(failure); },
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(at), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, persist: async () => {} } as unknown as DaemonEffects;
    await runCycle(master, state, effects, () => at);
    return state;
  };
  for (const failure of [decide502, tickTimeout]) {
    const state = await cycleWith(failure);
    assert.equal(state.actions[`dispatch:${work.id}:1`]?.state, 'failed', failure);
    assert.equal(state.profiles['builder'], undefined, `no profile cool-off for ${failure}`);
    assert.match(state.actions[`dispatch:${work.id}:1`].detail, /plane-wide control-plane failure, which cools no profile/);
  }
  const own = await cycleWith('Herdr refused agent start: workspace w1V not found');
  assert.ok(own.profiles['builder']?.cooldownUntil, 'an item-specific failure still cools the profile');
});

test('unit:plane-wide-failure-shapes — one recognizer reads every shape the window produced as the plane\'s, and an item-specific HTTP 500 as the item\'s', () => {
  for (const text of [decide502, file502, tickTimeout, 'Application failed to respond', 'HTTP 502 Bad Gateway', 'Graphyard refused work/x/session (503): upstream', 'HTTP 504',
    '{"status":504,"message":"timeout"}', 'connect ECONNREFUSED 10.0.0.1:443', 'read ECONNRESET', 'socket hang up', `server GET status: ${tickTimeout}`, 'the database is out of memory'])
    assert.equal(planeWideFailure(text), true, text);
  for (const text of ['Graphyard refused work/x/decide (500): {"status":500,"message":"Internal server error"}', 'Graphyard refused work/x/decide (409): Task revision changed (now 2)',
    'Graphyard refused work/x/decide (403): not permitted', 'The operation was aborted', 'spawn ENOMEM', 'FATAL ERROR: JavaScript heap out of memory', null, ''])
    assert.equal(planeWideFailure(text), false, String(text));
  // itemSpecificPlaneError is unchanged: a 500 the item's own request met stays the item's, whatever else the text says.
  assert.equal(itemSpecificPlaneError('Graphyard refused work/x/decide (500): {"status":500,"message":"Internal server error"}'), true);
  assert.equal(itemSpecificPlaneError(`HTTP 500 then ${tickTimeout}`), true, 'the timeout shape does not change what the blocker probe reads as item-specific');
  assert.equal(itemSpecificPlaneError(`(500) and ${decide502}`), false);
});

// Cycle 12621 replayed: the control plane's status answered in 21.3s and the attention master status
// adds, which reads every open item, in 350.8s — the 372.1s the faults step spent.
const slowStatusMs = 21_300, slowAttentionMs = 350_800;
/** Run `running` to its end on the mocked clock, a step at a time. */
async function drive<T>(running: Promise<T>, stepMs = 500): Promise<T> {
  let settled = false;
  running.then(() => { settled = true; }, () => { settled = true; });
  for (let turns = 0; !settled && turns < 20_000; turns++) { await new Promise(resolve => setImmediate(resolve)); if (!settled) mock.timers.tick(stepMs); }
  return running;
}
type PlaneReads = { attention: number; inFlight?: number; maxInFlight?: number };
function slowPlane(reads: PlaneReads, attentionMs = () => slowAttentionMs) {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [item('GY-9', Date.now(), { stage: 'build', ready: true })], now: iso(Date.now()), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(Date.now()), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
    controlPlane: () => new Promise(resolve => setTimeout(() => resolve({}), slowStatusMs)),
    reportedAttention: () => {
      reads.attention += 1; reads.inFlight = (reads.inFlight ?? 0) + 1; reads.maxInFlight = Math.max(reads.maxInFlight ?? 0, reads.inFlight);
      return new Promise(resolve => setTimeout(() => { reads.inFlight! -= 1; resolve({ items: [{ subject: 'GY-9', text: 'GY-9 escalation context overflows', kind: 'context-overflow' }] }); }, attentionMs()));
    },
    persist: async () => {},
  } as unknown as DaemonEffects;
}

test(`unit:fault-observation-budget — ${gy1345Instances[1].id}: a plane answering slower than the bound no longer carries the faults step past the interval`, async () => {
  const at = Date.parse(gy1345Instances[1].at) - 464_000;
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at });
  try {
    const master = burstConfig(), state = emptyDaemonState(master), reads = { attention: 0 };
    const result = await drive(runCycle(master, state, slowPlane(reads), () => Date.now()));
    const cost = cycleCost(result.metrics, intervalMs)!;
    assert.ok(cost.withinInterval, `the cycle spent ${cost.workMs}ms of work against the ${intervalMs}ms interval: ${cost.breakdown}`);
    assert.ok(result.metrics.steps!.deployment.ms <= faultObservationBudgetMs(intervalMs) + 1_000, `the faults step stopped at its ${faultObservationBudgetMs(intervalMs)}ms budget: ${result.metrics.steps!.deployment.ms}ms`);
    assert.equal(reads.attention, 1);
    assert.match(state.actions['faults:deferred']?.detail ?? '', /spent its 60s observation budget before the attention master status adds answered/);
    assert.equal(state.actions['faults:deferred'].faultClass, undefined);
  } finally { mock.timers.reset(); }
});

test('unit:fault-observation-budget — the step stops reading, marks the cycle partial so nothing standing ends, and later cycles take the read in flight once it lands rather than starting another', async () => {
  const at = Date.parse(gy1345Instances[1].at);
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at });
  try {
    const master = burstConfig(), state = emptyDaemonState(master), reads: PlaneReads = { attention: 0 };
    let attentionMs = 1_000;
    const effects = slowPlane(reads, () => attentionMs);
    await drive(runCycle(master, state, effects, () => Date.now()));
    const standing = Object.keys(state.faults.open).filter(key => key.startsWith('context-overflow|GY-9'));
    assert.equal(standing.length, 1, `the fast observation opens the fault the attention shows: ${JSON.stringify(state.faults.open)}`);
    const observedAt = state.faults.observedAt;
    // The plane slows: past the budget the attention read is left unread.
    attentionMs = slowAttentionMs;
    mock.timers.tick(intervalMs);
    const before = Date.now();
    await drive(runCycle(master, state, effects, () => Date.now()));
    assert.ok(Date.now() - before <= faultObservationBudgetMs(intervalMs) + 5_000, `the cycle did not wait for the read: ${Date.now() - before}ms`);
    assert.deepEqual(Object.keys(state.faults.open).filter(key => key.startsWith('context-overflow|GY-9')), standing, 'an unread source ends no standing fault');
    assert.equal(state.faults.observedAt, observedAt, 'the cut observation does not count as one');
    assert.equal(faultsStep.observationReadsPending(state), 1, 'the cut read is kept in flight');
    // The next cycle, inside faultObservationIntervalMs of the cut one, observes again: it takes the read in flight, and does not wait on it.
    mock.timers.tick(30_000);
    const again = Date.now();
    await drive(runCycle(master, state, effects, () => Date.now()));
    assert.ok(Date.now() - again <= slowStatusMs + 5_000, `a cycle finding the read in flight waits only on its own status read, not its budget again: ${Date.now() - again}ms`);
    assert.equal(reads.attention, 2, 'the next cycle starts no second read while the first is in flight');
    assert.match(state.actions['faults:deferred'].detail, /takes the answer of the read still in flight once it lands rather than starting another/);
    // Cycles go on at the actionable cadence until the read lands; the cycle that takes its answer observes fully.
    for (let cycles = 0; cycles < 12 && !/^The faults step observed every source/.test(state.actions['faults:deferred'].detail); cycles++) {
      mock.timers.tick(30_000);
      await drive(runCycle(master, state, effects, () => Date.now()));
    }
    assert.equal(reads.attention, 2, 'the answer of the read in flight is taken, not read again');
    assert.match(state.actions['faults:deferred'].detail, /^The faults step observed every source within its budget/);
    assert.notEqual(state.faults.observedAt, observedAt, 'the answer taken counts as an observation');
    assert.equal(faultsStep.observationReadsPending(state), 0, 'a taken answer frees its slot');
  } finally { mock.timers.reset(); }
});

test(`unit:fault-observation-budget — ${gy1345Instances[1].id}: cycles every 30s against a plane answering in ${slowAttentionMs / 1000}s keep at most one observation read in flight, and every cycle stays within its interval`, async () => {
  const at = Date.parse(gy1345Instances[1].at);
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at });
  try {
    const master = burstConfig(), state = emptyDaemonState(master), reads: PlaneReads = { attention: 0 }, effects = slowPlane(reads);
    const started = Date.now();
    while (Date.now() - started < 30 * minute) {
      const result = await drive(runCycle(master, state, effects, () => Date.now()));
      assert.ok(cycleCost(result.metrics, intervalMs)!.withinInterval, `cycle ${state.cycle} past its interval`);
      assert.ok(faultsStep.observationReadsPending(state) <= 2, 'at most one read per source is pending');
      mock.timers.tick(30_000);
    }
    assert.equal(reads.maxInFlight, 1, `never more than one attention read in flight (${reads.attention} started over 30 minutes)`);
    // One read per landing, plus the one still in flight: about one every 350s, not one every cycle.
    assert.ok(reads.attention <= Math.ceil(30 * minute / slowAttentionMs) + 1, `${reads.attention} reads in 30 minutes`);
  } finally { mock.timers.reset(); }
});

// ---- GY-1344: five loop faults in one control-plane outage on 2026-10-06 ------------------------
//
// GY-1344 names this file for its proof too. Between about 01:39 and 02:01Z the control plane
// answered nothing — Railway's 502 "Application failed to respond", or no answer before the
// request's 30s timeout — and the loop counted every consequence of that one condition as a loop
// fault of its own:
// (2) the dispatcher failed three ticks in a row on reads the plane did not answer;
// (4) cycle 12621 spent 450s, 372s of it in the faults step (inside the coarse 'deployment' bucket), waiting on reads that timed out.
// (The diagnosis decides (1) and (3) and the loop class's own refused filing (5) are retired with
// the diagnostician and the filings, GY-2186.) The plane not answering is one condition: what met
// it is retried with no fault, the dispatcher's and failed cycles' lines name the outage
// (deployment class), and time on requests it did not answer is not the loop's own work.

const gy1344Instances = [
  { id: 'dispatch-failures|dispatch|2026-10-06T01:44:37.500Z', kind: 'dispatch-failures', subject: 'dispatch', at: '2026-10-06T01:44:37.500Z' },
  { id: 'loop-cost|loop|2026-10-06T01:52:51.656Z', kind: 'loop-cost', subject: 'loop', at: '2026-10-06T01:52:51.656Z' },
];
/** Railway's answer for an application that does not respond, as the loop's operator-agent requests receive it. */
const railwayBody = { status: 'error', code: 502, message: 'Application failed to respond', request_id: 'x' };
const railway = (path: string) => new RefusedResponse(`Graphyard refused ${path} (502): ${JSON.stringify(railwayBody)}`, 502, railwayBody);
const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
/** A loop's effects with nothing to do but what each replay adds. */
function quietEffects(at: () => number, work: () => Work[], extra: Partial<DaemonEffects> = {}): DaemonEffects {
  return { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: work(), now: iso(at()), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(at()), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
    persist: async () => {}, ...extra } as DaemonEffects;
}

test(`manual:fault-class-loop — ${gy1344Instances[0].id}: dispatcher ticks failing on a control plane that does not answer are the outage, not a loop fault`, () => {
  for (const reason of ['The operation was aborted due to timeout', `Graphyard refused work-snapshot (502): ${JSON.stringify(railwayBody)}`]) {
    const lines = classifyAttention(dispatchFailureAttention({ consecutiveFailures: 3, lastSuccessAt: '2026-10-06T01:39:02.000Z', lastFailure: { at: gy1344Instances[0].at, reason } }));
    assert.equal(lines.length, 1, 'the master still sees that nothing is being launched');
    assert.equal(lines[0].kind, 'plane-unavailable', reason);
    assert.equal(lines[0].faultClass, 'deployment', 'one outage, counted in the class of a production that does not answer');
  }
  // A tick that fails for any other reason is still the dispatcher's own fault.
  const own = classifyAttention(dispatchFailureAttention({ consecutiveFailures: 3, lastSuccessAt: null, lastFailure: { at: gy1344Instances[0].at, reason: 'herdr: command not found' } }));
  assert.equal(own[0].kind, 'dispatch-failures');
  assert.equal(own[0].faultClass, 'loop');
});

/**
 * Cycle 12621, replayed: the faults step's observation reads (GY-1355: the production timings put
 * the 372s in the faults step, not the deployment verification, which took 8.7s) each run into the
 * 30s request timeout while the plane does not answer, twelve of them; the server is asked through
 * the same timed call the loop's effects make, so the cycle measures what it waited on.
 */
async function replayOutageCycle(answer: 'timeout' | 'slow') {
  let now = Date.parse(gy1344Instances[1].at) - 450_000;
  const master = burstConfig(), state = emptyDaemonState(master);
  const effects = quietEffects(() => now, () => [], {
    controlPlane: async () => {
      for (let read = 0; read < 12; read++) await timedCall('server', 'GET status', async () => { now += 31_000; if (answer === 'timeout') throw timedOut(); return new Response('{}', { status: 200 }); }, () => now).catch(() => undefined);
      if (answer === 'timeout') throw timedOut();
      return {};
    },
  } as Partial<DaemonEffects>);
  return { result: await runCycle(master, state, effects, () => now), state };
}

test(`manual:fault-class-loop — ${gy1344Instances[1].id}: a cycle's time on requests the plane did not answer is not the loop's own work`, async () => {
  const { result } = await replayOutageCycle('timeout');
  const cost = cycleCost(result.metrics, intervalMs)!;
  assert.ok(cost.durationMs > intervalMs, `the cycle still took ${cost.durationMs}ms in all`);
  assert.ok(cost.withinInterval, `its own work fits the interval: ${cost.breakdown}`);
  assert.equal(cost.planeWaitMs, 12 * 31_000);
  assert.match(cost.breakdown, /372s in flight on the control plane/);
});

// GY-1562 reverses the stance this case held under GY-1344 ("a server that answers slowly is still the loop's cost"):
// cycle-p90 (GY-1537) judges workMs, and a plane answering in 8–17 s pushed it over its bound with no loop work to shorten.
test(`integration:loop-faults-slow-answers-not-loop-cost — ${gy1344Instances[1].id}: a cycle crawling on a slow-answering plane files no loop-cost fault, and the plane's slowness stays visible`, async () => {
  const { result, state } = await replayOutageCycle('slow');
  const cost = cycleCost(result.metrics, intervalMs)!;
  assert.ok(cost.durationMs > intervalMs, `the cycle still took ${cost.durationMs}ms in all`);
  assert.ok(cost.withinInterval, `answered requests in flight are the plane's time, not the loop's work: ${cost.breakdown}`);
  assert.equal(cost.planeWaitMs, 12 * 31_000, 'the slow answers are recorded as plane wait');
  assert.match(cost.breakdown, /372s in flight on the control plane/);
  const calls = result.metrics.timings!.calls;
  assert.ok(calls.length > 0 && calls.every(call => call.kind === 'server' && call.name === 'GET status' && call.ms === 31_000), 'each slow answer is a recorded slow server call');
  assert.equal(result.metrics.timings!.slowCalls, 12);
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'loop-cost'), [], 'no loop-cost fault');
  assert.equal(loopAttention({ liveness: { state: 'running', lagMs: 1_000, stalledAfterMs: 2 * intervalMs, cycle: cost.cycle, lock: null, detail: '', restart: '', cost }, cost }).filter(line => line.kind === 'loop-cost').length, 0, 'and no loop-cost attention');
});

test(`integration:loop-faults-plane-unavailable — ${gy1344Instances[1].id}: a plane that times out, refuses or answers 502–504 is still the outage: its wait is left out of the loop's work and it raises plane-unavailable, never a loop fault`, async () => {
  const { result } = await replayOutageCycle('timeout');
  const cost = cycleCost(result.metrics, intervalMs)!;
  assert.equal(cost.planeWaitMs, 12 * 31_000);
  assert.ok(cost.withinInterval, cost.breakdown);
  for (const error of [railway('work-snapshot'), timedOut(), new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })]) {
    const master = config(), state = emptyDaemonState(master);
    for (let attempt = 0; attempt < 3; attempt++) await noteCycleFailure(state, error, 'cycle', { now: Date.parse('2026-10-06T01:45:00.000Z') + attempt * minute, intervalMs, persist: async () => {} });
    assert.deepEqual(state.faults.instances.map(entry => [entry.kind, entry.faultClass]), [['plane-unavailable', 'deployment']], String(error));
  }
});

test('unit:cycle-p90-slow-answered-plane-holds — cycle 13964 replayed: 95.8 s of wall time, 12.1 s on children and the rest in flight on 2xx control-plane answers, holds cycle-p90; the same cycle working for itself violates', async () => {
  const cycleAt = Date.parse('2026-10-08T22:29:05.802Z');
  let now = cycleAt - 95_846;
  const answers = [17_583, 14_349, 13_265, 11_282, 3_597, 12_569, 14_627];
  const effects = quietEffects(() => now, () => [], {
    controlPlane: async () => {
      for (const ms of answers) await timedCall('server', 'POST work/:id/session', async () => { now += ms; return new Response('{}', { status: 200 }); }, () => now);
      return {};
    },
  } as Partial<DaemonEffects>);
  const { metrics } = await runCycle(burstConfig(), emptyDaemonState(burstConfig()), effects, () => now);
  assert.equal(metrics.planeWaitMs, answers.reduce((sum, ms) => sum + ms, 0), 'every answered request\'s in-flight window is plane wait');
  assert.ok(metrics.workMs! < 30_000, `the loop's own work: ${metrics.workMs}ms`);
  const window = (workMs: number) => Array.from({ length: 29 }, (_, index) => ({ at: iso(cycleAt - index * 2 * minute), durationMs: 95_846, workMs }));
  const p90 = (workMs: number) => checkInvariants(emptyInvariantRecord(), { work: [], now: cycleAt, metrics: window(workMs) }).find(entry => entry.invariant === 'cycle-p90')!;
  assert.equal(p90(metrics.workMs!).holds, true, p90(metrics.workMs!).line);
  assert.equal(p90(83_739).holds, false, 'the workMs the cycle recorded before GY-1562 violated');
});

test('unit:plane-wait-in-flight-successes — timedCall records the in-flight window of every server request the plane answered, as a Response of any status or any other value; other kinds record none', async () => {
  let clock = 0;
  const timings = new Timings(() => clock);
  await withTimings(timings, async () => {
    await timedCall('server', 'GET work-snapshot', async () => { clock += 8_000; return new Response('{}', { status: 200 }); }, () => clock);
    await timedCall('server', 'POST work/:id/session', async () => { clock += 4_000; return new Response('{}', { status: 409 }); }, () => clock);
    await timedCall('server', 'GET status', async () => { clock += 2_000; return { ok: true }; }, () => clock);
    await timedCall('github', 'gh api graphql', async () => { clock += 5_000; return {}; }, () => clock);
  });
  assert.equal(timings.planeWaitMs(), 14_000);
  const report = timings.report();
  assert.equal(report.planeWaitMs, 14_000);
  assert.deepEqual(report.calls.map(call => [call.kind, call.ms]), [['server', 8_000], ['github', 5_000], ['server', 4_000], ['server', 2_000]], 'each is still a recorded slow call');
  const fast = new Timings(() => clock);
  await withTimings(fast, () => timedCall('server', 'GET status', async () => { clock += 40; return {}; }, () => clock));
  assert.equal(fast.report().planeWaitMs, 40, 'a fast answer is plane time too, and no slow call');
  assert.equal(fast.report().slowCalls, 0);
});

test('unit:plane-wait-outage-unchanged — unanswered requests (timed out, refused, 502–504) still record plane wait, overlapping in-flight windows merged once, and the error still reaches the caller', async () => {
  let clock = 0;
  const timings = new Timings(() => clock);
  const pending: Promise<unknown>[] = [];
  await withTimings(timings, async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    // Two requests in flight together from 0 to 30 s: one times out, one gets a proxy's 504.
    pending.push(timedCall('server', 'GET status', async () => { await held; throw timedOut(); }, () => clock).catch(error => error));
    pending.push(timedCall('server', 'GET work-snapshot', async () => { await held; return new Response('', { status: 504 }); }, () => clock));
    clock = 30_000; release();
    const [error, response] = await Promise.all(pending);
    assert.equal((error as DOMException).name, 'TimeoutError');
    assert.equal((response as Response).status, 504);
    await assert.rejects(timedCall('server', 'POST work/:id/decide', async () => { clock += 10_000; throw railway('work/x/decide'); }, () => clock), RefusedResponse);
  });
  assert.equal(timings.planeWaitMs(), 40_000, 'the overlapping 30 s counted once, then the refused 10 s');
});

test('manual:fault-class-loop — GY-1344: failed cycles that met a control plane not answering are counted once, as the outage', async () => {
  const master = config(), state = emptyDaemonState(master);
  for (let attempt = 0; attempt < 3; attempt++) await noteCycleFailure(state, railway('work-snapshot'), 'cycle', { now: Date.parse('2026-10-06T01:45:00.000Z') + attempt * minute, intervalMs, persist: async () => {} });
  assert.deepEqual(state.faults.instances.map(entry => [entry.kind, entry.faultClass]), [['plane-unavailable', 'deployment']]);
});

// ---- GY-1354: the deployment step dominating cycle cost --------------------------------------------
//
// GY-1354 names this file for its proof too, beside the GY-1336 lineage. Two loop-cost instances on
// 2026-10-06 had the same shape: the deployment step's inline release-landing verification took most
// of a cycle already past the 300s interval.
// (1) cycle 12621: 450s of its own work, 381.9s of it in the deployment step;
// (2) cycle 12624: 781s of its own work — past the 600s two-interval liveness bound — and 8.5s
//     waiting on children, 587.1s of its work in the deployment step.
// The step's reads now share a per-cycle budget (deploymentStepBudgetMs); a verification still
// running at the bound stays in flight and a later cycle takes its answer. GY-1355 found the
// production timings put most of those seconds in the faults step inside the coarse 'deployment'
// bucket; the attribution case below replays the shape AC-2 names, a cycle whose slowest timed
// step is the release-landing verification itself, and the replay bounds that step either way.

const gy1354Instances = [
  { id: 'loop-cost|loop|2026-10-06T01:52:51.656Z', kind: 'loop-cost', subject: 'loop', at: '2026-10-06T01:52:51.656Z', cycle: 12621, workMs: 450_000, childWaitMs: 0, deploymentMs: 381_900 },
  { id: 'loop-cost|loop|2026-10-06T02:10:48.978Z', kind: 'loop-cost', subject: 'loop', at: '2026-10-06T02:10:48.978Z', cycle: 12624, workMs: 781_000, childWaitMs: 8_500, deploymentMs: 587_100 },
];
/** The cycle as it was measured: the deployment step's work and the rest spread over the other steps. */
function measuredCycle(instance: typeof gy1354Instances[number]) {
  const rest = instance.workMs - instance.deploymentMs, share = (part: number) => ({ ms: Math.round(rest * part), childWaitMs: 0 });
  const steps = { observe: share(0.2), close: share(0.1), decisions: share(0.3), dispatch: share(0.2), merge: share(0.2), deployment: { ms: instance.deploymentMs + instance.childWaitMs, childWaitMs: instance.childWaitMs } };
  const timings = { totalMs: instance.workMs, calls: [], slowCalls: 0, steps: [{ step: 'snapshot', ms: steps.observe.ms }, { step: 'decisions', ms: steps.decisions.ms }, { step: 'deployment verification', ms: instance.deploymentMs }] };
  return { cycle: instance.cycle, at: instance.at, durationMs: instance.workMs + instance.childWaitMs, childWaitMs: instance.childWaitMs, workMs: instance.workMs, steps, timings } as unknown as DaemonState['metrics'][number];
}

test('manual:fault-class-loop — GY-1354 lists two instances, and both are replayed', () => {
  assert.deepEqual(gy1354Instances.map(entry => entry.cycle), [12621, 12624]);
});

for (const instance of gy1354Instances) {
  test(`unit:loop-cost-deployment-attribution — ${instance.id}: the loop-cost line names the deployment step and its share of the cycle`, () => {
    const cost = cycleCost(measuredCycle(instance), intervalMs)!;
    assert.equal(cost.withinInterval, false);
    assert.equal(cost.withinLivenessBound, instance.cycle === 12621);
    assert.equal(cost.slowest?.step, 'deployment');
    const share = Math.round(100 * instance.deploymentMs / instance.workMs);
    assert.ok(share >= 60, `the 12621/12624 shape: deployment at ${share}% of a cycle past the interval`);
    const lines = loopAttention({ liveness: { state: 'running', lagMs: 0, stalledAfterMs: 2 * intervalMs, cycle: instance.cycle, lock: null, detail: '', restart: '', cost }, cost });
    const line = lines.find(entry => entry.kind === 'loop-cost' || /on its own work/.test(entry.text))!;
    assert.match(line.text, new RegExp(`Cycle ${instance.cycle} spent ${Math.round(instance.workMs / 1000)}s on its own work`));
    assert.equal(livenessModule.culpritShare?.(cost), share);
    assert.match(line.text, new RegExp(`The deployment verification step is the slowest timed step, at ${Math.round(instance.deploymentMs / 1000)}s. It is ${share}% of the cycle's own work`));
    assert.match(line.next ?? '', /shorten the deployment verification step/);
  });

  test(`manual:loop-cost-cycle-replay — ${instance.id}: a verification taking the ${instance.deploymentMs / 1000}s it took no longer carries the cycle past the interval, and the delivery is still verified served`, async () => {
    const at = Date.parse(instance.at) - instance.workMs;
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at });
    try {
      const master = burstConfig(), state = emptyDaemonState(master), sha = 'c'.repeat(40);
      const delivered = { ...item('GY-1350', at, { stage: 'done' } as Partial<Work>), delivery: { mergedAt: iso(at - hour), mergeSha: sha, authorizationRevision: 1 } } as unknown as Work;
      let reads = 0;
      const effects = quietEffects(() => Date.now(), () => [delivered], {
        observeDeployment: () => { reads++; return new Promise(resolve => setTimeout(() => resolve({ source: 'endpoint', sha, at: iso(Date.now()), reason: null, deployed: ['GY-1350'], pending: [], requests: 0, derived: 1, retained: 0 }), instance.deploymentMs)); },
      });
      const started = Date.now();
      while (state.deployment?.sha !== sha && Date.now() - started < 30 * minute) {
        const result = await drive(runCycle(master, state, effects, () => Date.now()));
        const cost = cycleCost(result.metrics, intervalMs)!;
        assert.ok(cost.withinInterval && cost.withinLivenessBound, `cycle ${result.metrics.cycle} fits: ${cost.breakdown}`);
        assert.ok(result.metrics.steps!.deployment.ms <= deploymentModule.deploymentStepBudgetMs(intervalMs) + faultObservationBudgetMs(intervalMs) + 2_000, `the deployment step is bounded: ${result.metrics.steps!.deployment.ms}ms`);
        assert.deepEqual(loopAttention({ liveness: { state: 'running', lagMs: 0, stalledAfterMs: 2 * intervalMs, cycle: result.metrics.cycle, lock: null, detail: '', restart: '', cost }, cost }).filter(line => /on its own work/.test(line.text)), [], 'no loop-cost line');
        mock.timers.tick(30_000);
      }
      assert.equal(reads, 1, 'one verification, carried across cycles');
      assert.deepEqual(state.deployment?.deployed, ['GY-1350'], 'the delivery is verified served once its verification lands');
    } finally { mock.timers.reset(); }
  });
}

// ---- GY-1356: the coordinator HEAD moved forward under the running loop -------------------------
//
// At 2026-10-06T05:31:54.601Z the loop recorded escalation:dirty-checkout: its checkout's HEAD had
// moved from fc04aa78f209 (the commit it loaded) to c67ed34548f2 (GY-1338's merge, a descendant) while
// it ran. The guard refused restart and self-upgrade on any move, so the loop stood down on stale
// code and every later merge stayed inert. A clean, detached descendant that the base branch holds is
// now recovered onto: the loop re-executes itself onto it. Any other move —
// an unmerged feature-branch head among them — stays drift.

/**
 * A real repository whose origin is itself: the loaded commit, a descendant touching loaded code that
 * main holds, a sibling that is no descendant, and a descendant main does not hold (a feature head).
 */
async function divergence() {
  const root = await temporaryDirectory('gy-1356'), git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main'); git('config', 'user.email', 'loop@example.com'); git('config', 'user.name', 'loop'); git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const version = 0;\n'); git('add', '.'); git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const version = 1;\n'); git('commit', '--quiet', '-am', 'loaded');
  const loaded = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const version = 2;\n'); git('commit', '--quiet', '-am', 'GY-1338 merged');
  const successor = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', root);
  git('checkout', '--quiet', '--detach', successor);
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const version = 4;\n'); git('commit', '--quiet', '-am', 'feature, never merged');
  const unmerged = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '--detach', base);
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const version = 3;\n'); git('commit', '--quiet', '-am', 'foreign');
  const foreign = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '--detach', loaded);
  return { root, git, loaded, successor, foreign, unmerged };
}
/** GY-1359: the deployment step verified a delivery served by `sha`, the trigger a recovery waits on. */
function serving(state: DaemonState, sha: string) {
  state.deployment = { source: 'github-deployment', sha, at: '2026-10-06T05:30:00.000Z', reason: null, deployed: ['GY-1338'], pending: [] };
  return state;
}
function recoveringGuard(root: string, state: DaemonState, options: { restartSelf?: () => Promise<void> } = {}) {
  const restarts = { self: 0, recovers: 0 };
  const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8' });
  const guard = coordinatorCheckoutGuard({
    state: () => state, read: () => readCoordinatorCheckout(root), agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(Date.now()) }),
    persist: async () => {}, now: () => Date.parse('2026-10-06T05:31:54.601Z'), log: () => {}, applies: () => true,
    recover: (current, from, to) => {
      restarts.recovers++;
      return upgradeModule.recoverMovedHead(config(), current, from, to, { root, run, now: () => Date.parse('2026-10-06T05:31:54.601Z'),
        restartSelf: options.restartSelf ?? (async () => { restarts.self++; }) });
    },
  });
  return { guard, restarts };
}
const skippedUpgrade = async () => ({ outcome: 'skipped' as const, reason: 'no delivered item is verified deployed yet' });

test('unit:upgrade-head-divergence-recovers — a HEAD moved forward to a descendant under the running loop is recovered onto: the loop re-executes, with no drift escalation', async () => {
  assert.equal(typeof upgradeModule.recoverMovedHead, 'function', 'the loop has a recovery for a moved HEAD');
  const repo = await divergence();
  const state = serving(emptyDaemonState(config()), repo.successor);
  const { guard, restarts } = recoveringGuard(repo.root, state);
  assert.equal(await guard.start(repo.loaded), null);
  assert.equal(guard.expected(), repo.loaded);
  // The divergence: something other than the loop's own alignment moves HEAD to GY-1338's merge.
  repo.git('checkout', '--quiet', '--detach', repo.successor);
  const { refusal, upgraded } = await guard.betweenCycles(skippedUpgrade);
  assert.equal(refusal, null, 'the loop does not refuse restart on a forward move');
  assert.equal(upgraded?.outcome, 'upgraded');
  assert.equal(restarts.self, 1, 'the loop re-executes itself onto the successor');
  assert.equal(guard.expected(), repo.successor, 'the successor is now the commit the loop runs');
  assert.equal(state.actions['escalation:dirty-checkout'], undefined, 'no escalation:dirty-checkout is recorded');
  assert.equal(state.actions['upgrade:recovered']?.state, 'done');
  assert.deepEqual(state.upgrade.last && [state.upgrade.last.from, state.upgrade.last.to, state.upgrade.last.self], [repo.loaded, repo.successor, true]);
  // Three more cycles at the adopted HEAD: no escalation, no further restart.
  for (let cycle = 0; cycle < 3; cycle++) assert.equal((await guard.betweenCycles(skippedUpgrade)).refusal, null);
  assert.equal(restarts.self, 1);
  assert.equal(state.actions['escalation:dirty-checkout'], undefined, 'three consecutive cycles record no escalation');
});

test('unit:upgrade-head-divergence-recovers — drift raised before the recovery is settled by it', async () => {
  const repo = await divergence();
  const state = serving(emptyDaemonState(config()), repo.successor);
  const { guard, restarts } = recoveringGuard(repo.root, state);
  await guard.start(repo.loaded);
  repo.git('checkout', '--quiet', '--detach', repo.successor);
  // A cycle with the self-upgrade unavailable only reports the drift.
  assert.match((await guard.betweenCycles()).refusal ?? '', /moved from/);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed');
  assert.equal((await guard.betweenCycles(skippedUpgrade)).upgraded?.outcome, 'upgraded');
  assert.equal(restarts.self, 1);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done', 'the recovery settles the attention the drift raised');
});

// ---- GY-1531: the stop before a restart is no drift, and the restart's adoption is said ---------
//
// Instance 2026-10-08T04:11:19Z: the operator moved the coordinator checkout's HEAD forward onto main
// (3192ee7c -> 6f0f2413) and restarted the loop with systemctl. The loop, already stopping for that
// restart, ran its between-cycles read with the self-upgrade off and recorded escalation:dirty-
// checkout — "refuses to restart or self-upgrade" — for the very HEAD the restart then loaded 20s
// later; the start settled it silently, so the journal held the refusal and never the remedy.

test('manual:coordinator-checkout-restored-and-loop-restarted — a loop stopping records no dirty-checkout refusal for a moved HEAD, which the restart adopts, and says so when a standing one ends', async () => {
  for (const move of ['forward', 'foreign'] as const) {
    const repo = await divergence(), lines: string[] = [];
    const state = serving(emptyDaemonState(config()), repo.successor);
    const guard = coordinatorCheckoutGuard({ state: () => state, read: () => readCoordinatorCheckout(repo.root), agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(Date.now()) }),
      persist: async () => {}, now: () => Date.parse('2026-10-08T04:11:19.754Z'), log: line => lines.push(line), applies: () => true });
    assert.equal(await guard.start(repo.loaded), null);
    repo.git('checkout', '--quiet', '--detach', move === 'forward' ? repo.successor : repo.foreign);
    // The supervisor's stop (a restart) has reached the loop: the self-upgrade is off, the loop is ending.
    const { refusal, upgraded } = await guard.betweenCycles(undefined, undefined, { stopping: true });
    assert.match(refusal ?? '', /moved from/, `${move}: the drift is still reported to the caller`);
    assert.equal(upgraded, null);
    assert.equal(state.actions['escalation:dirty-checkout'], undefined, `${move}: no escalation:dirty-checkout is recorded by a loop that is stopping`);
    assert.ok(lines.some(line => /stopping with the coordinator checkout's HEAD at .*the next loop runs the checkout's HEAD, so no dirty-checkout refusal is recorded/.test(line)), `${move}: the stop says why: ${lines.join(' | ')}`);
    // The restarted loop loads the checkout's HEAD: that HEAD is the commit it runs, with nothing to refuse.
    const restarted = coordinatorCheckoutGuard({ state: () => state, read: () => readCoordinatorCheckout(repo.root), agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(Date.now()) }),
      persist: async () => {}, now: () => Date.parse('2026-10-08T04:11:39.126Z'), log: line => lines.push(line), applies: () => true });
    assert.equal(await restarted.start(repo.git('rev-parse', 'HEAD')), null, `${move}: the restarted loop refuses nothing`);
    assert.equal(restarted.expected(), move === 'forward' ? repo.successor : repo.foreign, `${move}: the checkout's HEAD is the commit the restarted loop runs`);
    assert.equal((await restarted.betweenCycles(skippedUpgrade)).refusal, null);
    assert.equal(state.actions['escalation:dirty-checkout'], undefined);
  }
});

test('manual:coordinator-checkout-restored-and-loop-restarted — a dirty tree still refuses while the loop stops, and the remedy a standing drift refusal names ends it audibly', async () => {
  const repo = await divergence(), lines: string[] = [];
  const state = serving(emptyDaemonState(config()), repo.successor);
  const deps = { state: () => state, read: () => readCoordinatorCheckout(repo.root), agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(Date.now()) }), persist: async () => {}, now: () => Date.parse('2026-10-08T01:09:13.454Z'), log: (line: string) => lines.push(line), applies: () => true };
  const guard = coordinatorCheckoutGuard(deps);
  await guard.start(repo.loaded);
  // Instance 2026-10-08T01:09:13Z: HEAD moved sideways, not forward, while the loop ran (not stopping).
  repo.git('checkout', '--quiet', '--detach', repo.foreign);
  const drift = (await guard.betweenCycles(skippedUpgrade)).refusal ?? '';
  assert.match(drift, /refuses to restart or self-upgrade/);
  assert.match(drift, new RegExp(`restore the checkout with git -C ${repo.root} checkout --detach ${repo.loaded.slice(0, 12)} and restart the loop, or leave it at ${repo.foreign.slice(0, 12)} and restart the loop onto that HEAD \\(systemctl --user restart graphyard-master\\)`), 'the refusal names both remedies');
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed');
  // Uncommitted work on top: stopping or not, the tree refuses — the next loop would refuse it at startup too.
  writeFileSync(join(repo.root, 'src', 'loop.ts'), 'export const version = 9;\n');
  const dirty = (await guard.betweenCycles(undefined, undefined, { stopping: true })).refusal ?? '';
  assert.match(dirty, /uncommitted|dirty|holds/i, `the dirty tree refuses while stopping: ${dirty}`);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed');
  assert.match(state.actions['escalation:dirty-checkout']?.detail ?? '', /src\/loop\.ts/, 'the standing refusal names the dirty path');
  // The first remedy: the checkout restored to the loaded commit, the work dropped.
  repo.git('checkout', '--quiet', '--', 'src/loop.ts');
  repo.git('checkout', '--quiet', '--detach', repo.loaded);
  assert.equal((await guard.betweenCycles(skippedUpgrade)).refusal, null);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done', 'the restore ends the refusal');
  assert.ok(lines.some(line => line.startsWith('[graphyard-master] escalation done: the coordinator checkout at') && line.includes(`is clean again at ${repo.loaded.slice(0, 12)}, the commit the loop runs`)), `the clearance is in the journal: ${lines.join(' | ')}`);
  // The second remedy, from a standing refusal: leave HEAD where it moved and restart the loop onto it.
  repo.git('checkout', '--quiet', '--detach', repo.foreign);
  assert.match((await guard.betweenCycles(skippedUpgrade)).refusal ?? '', /refuses to restart/);
  const restarted = coordinatorCheckoutGuard({ ...deps, now: () => Date.parse('2026-10-08T01:09:22.000Z') });
  assert.equal(await restarted.start(repo.foreign), null, 'the restarted loop runs the checkout\'s HEAD');
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done', 'the restart ends the refusal');
  assert.equal(state.actions['escalation:dirty-checkout']?.at, '2026-10-08T01:09:22.000Z');
  assert.equal(lines.filter(line => line.startsWith('[graphyard-master] escalation done:')).length, 2);
});

test('unit:upgrade-head-divergence-recovers — a move that is not a clean detached descendant on the base branch still stands down, and is tried once', async () => {
  for (const move of ['foreign', 'dirty', 'branch', 'unmerged'] as const) {
    const repo = await divergence();
    const state = serving(emptyDaemonState(config()), repo.successor);
    const { guard, restarts } = recoveringGuard(repo.root, state);
    await guard.start(repo.loaded);
    if (move === 'foreign') repo.git('checkout', '--quiet', '--detach', repo.foreign);
    // A session whose pane points at the checkout detaches it onto its feature-branch head: a clean descendant, but unreviewed.
    else if (move === 'unmerged') repo.git('checkout', '--quiet', '--detach', repo.unmerged);
    else if (move === 'branch') repo.git('checkout', '--quiet', '-B', 'side', repo.successor);
    else { repo.git('checkout', '--quiet', '--detach', repo.successor); writeFileSync(join(repo.root, 'src', 'loop.ts'), 'export const version = 9;\n'); }
    for (let cycle = 0; cycle < 2; cycle++) {
      const { refusal, upgraded } = await guard.betweenCycles(skippedUpgrade);
      assert.ok(refusal, `${move}: the guard still refuses`);
      if (move !== 'dirty') assert.equal(upgraded, null);
    }
    assert.equal(restarts.self, 0, `${move}: nothing restarts onto it`);
    assert.equal(restarts.recovers, move === 'dirty' ? 0 : 1, `${move}: a dirty tree is never offered, a refused HEAD is tried once`);
    assert.equal(guard.expected(), repo.loaded);
    assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed', `${move}: the drift is attention`);
  }
});

// ---- GY-1359: a forward move is classified by ancestry ------------------------------------------
//
// The recovery adopts merged code once a verified release serves it. A forward move it cannot adopt
// by itself is attention naming a restart onto the checkout's own HEAD; only dirty, non-detached and
// non-forward states keep the rollback refusal, and none of them reaches the self-upgrade.

test('unit:coordinator-non-forward-drift-still-refused — a dirty tree, a branch HEAD or a move the loaded commit is not an ancestor of refuses the self-upgrade, naming the paths or the HEAD', async () => {
  for (const move of ['foreign', 'dirty', 'branch'] as const) {
    const repo = await divergence();
    const state = serving(emptyDaemonState(config()), repo.successor);
    const { guard, restarts } = recoveringGuard(repo.root, state);
    let upgrades = 0;
    const selfUpgrade = async () => { upgrades++; return skippedUpgrade(); };
    await guard.start(repo.loaded);
    if (move === 'foreign') repo.git('checkout', '--quiet', '--detach', repo.foreign);
    else if (move === 'branch') repo.git('checkout', '--quiet', '-B', 'side', repo.successor);
    else { repo.git('checkout', '--quiet', '--detach', repo.successor); writeFileSync(join(repo.root, 'src', 'loop.ts'), 'export const version = 9;\n'); }
    for (let cycle = 0; cycle < 2; cycle++) {
      const { refusal, upgraded } = await guard.betweenCycles(selfUpgrade);
      assert.ok(refusal, `${move}: the guard refuses`);
      // A dirty checkout is the one refusal the self-upgrade runs through: the loop restarts onto a held snapshot.
      if (move !== 'dirty') assert.equal(upgraded, null, `${move}: nothing is upgraded`);
      if (move === 'dirty') assert.match(refusal, /src\/loop\.ts/, 'the dirty paths are named');
      else {
        const head = (move === 'foreign' ? repo.foreign : repo.successor).slice(0, 12);
        assert.match(refusal, new RegExp(`moved from ${repo.loaded.slice(0, 12)} to ${head}`), `${move}: the HEAD is named`);
        assert.match(refusal, new RegExp(`checkout --detach ${repo.loaded.slice(0, 12)}`), `${move}: a non-forward or branch move keeps the rollback remedy`);
      }
    }
    if (move !== 'dirty') assert.equal(upgrades, 0, `${move}: the self-upgrade never runs`);
    assert.equal(restarts.self, 0, `${move}: nothing re-executes`);
    assert.equal(guard.expected(), repo.loaded);
    assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed', `${move}: the refusal is attention`);
  }
});

test('unit:forward-drift-escalation-names-restart — a forward move no verified release serves yet is attention naming a restart onto its own HEAD, and is recovered once a release serves it', async () => {
  const repo = await divergence();
  const state = emptyDaemonState(config());
  const { guard, restarts } = recoveringGuard(repo.root, state);
  await guard.start(repo.loaded);
  repo.git('checkout', '--quiet', '--detach', repo.successor);
  const successor = repo.successor.slice(0, 12), loaded = repo.loaded.slice(0, 12);
  for (let cycle = 0; cycle < 2; cycle++) {
    const { refusal, upgraded } = await guard.betweenCycles(skippedUpgrade);
    assert.equal(upgraded, null);
    assert.match(refusal ?? '', new RegExp(`moved from ${loaded} forward to ${successor}`));
    assert.match(refusal ?? '', /no delivered item is verified deployed yet/);
    assert.match(refusal ?? '', new RegExp(`leave the checkout at ${successor} and restart the loop onto its own HEAD`));
    assert.doesNotMatch(refusal ?? '', /checkout --detach/, 'never a rollback to the stale loaded commit');
  }
  assert.equal(restarts.recovers, 1, 'one attempt per HEAD and release');
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed');
  serving(state, repo.successor);
  assert.equal((await guard.betweenCycles(skippedUpgrade)).upgraded?.outcome, 'upgraded', 'a release verified later is retried');
  assert.equal(restarts.self, 1);
  assert.equal(guard.expected(), repo.successor);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done');
});

test('unit:forward-drift-escalation-names-restart — a forward move the loop cannot re-execute onto (no supervisor unit) names a restart, never a rollback', async () => {
  const repo = await divergence();
  const state = serving(emptyDaemonState(config()), repo.successor);
  const { guard, restarts } = recoveringGuard(repo.root, state, { restartSelf: async () => { throw new Error('this loop runs under no graphyard-master supervisor unit, so it cannot re-execute itself'); } });
  await guard.start(repo.loaded);
  repo.git('checkout', '--quiet', '--detach', repo.successor);
  const { refusal, upgraded } = await guard.betweenCycles(skippedUpgrade);
  assert.equal(upgraded, null);
  assert.match(refusal ?? '', /no graphyard-master supervisor unit/);
  assert.match(refusal ?? '', new RegExp(`restart the loop onto its own HEAD`));
  assert.doesNotMatch(refusal ?? '', /checkout --detach/);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed');
  assert.equal(guard.expected(), repo.loaded, 'the loop still runs the code it loaded');
});