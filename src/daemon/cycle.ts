// Concern: one coordination cycle — the snapshot it reads, the order of its steps, and its measures.
import type { Work } from '../model.js';
import type { MasterConfig, WorkerProfile, HerdrAgent } from '../master.js';
import { cycleMetricsSchema, type CycleStepName, type DaemonAction, type DaemonActionKind, type DaemonState, emptyCycleSteps, message, pruneDaemonState } from './state.js';
import { reconcilePendingActions } from './reconcile.js';
import { setAsideFollowUpThreads } from './decisions.js';
import { actionableSubjects, latencyBudget, observeItemClock, stageMetrics, trackSilence } from './metrics.js';
import { profileHealth } from './sessions.js';
import { boundedPersist } from './liveness.js';
import { type DaemonEffects, record } from './effects.js';
import { closeStep } from './cycle-sessions.js';
import { scopeStep, successorStep } from './cycle-scope.js';
import { reclaimStep } from './cycle-reclaim.js';
import { dispatchStep } from './cycle-dispatch.js';
import { decisionStep } from './cycle-decisions.js';
import { deploymentStep, mergeStep, shepherdStep } from './cycle-delivery.js';
import { faultStep } from './faults.js';
import { doctorStep } from './doctor.js';
import { Timings, withTimings, withoutTimings } from '../master/timings.js';

/** How many session launches the launcher runs at once when master.json sets no `run.launchConcurrency` (GY-616). */
export const defaultLaunchConcurrency = 3;

/**
 * The session launcher beside the cycle (GY-616). A launch — a worker dispatch, an approver, a
 * failover relaunch — creates a Herdr pane and registers a session, which under memory pressure
 * costs eight seconds a call; run inline, a burst of them held every merge, decision and close
 * behind it. The cycle hands the launcher a request and moves on: the launcher runs up to
 * `concurrency` of them at once, queues the rest, and keeps what each one recorded for the next
 * cycle to report. A request whose key is already queued or running is not made twice, and the
 * resources a request holds (a worker profile) stay held from hand-off until it settles, so the
 * next cycle does not give the same profile to another item.
 */
export class Launcher {
  private readonly queue: { key: string; body: (sink: DaemonAction[]) => Promise<void> }[] = [];
  private readonly flying = new Map<string, string[]>();
  private readonly reports: DaemonAction[] = [];
  private readonly waiters: (() => void)[] = [];
  private running = 0;
  constructor(public concurrency: number = defaultLaunchConcurrency) {}
  /** Hands one launch over. False when a launch under the same key is already queued or running. */
  submit(key: string, holds: string[], body: (sink: DaemonAction[]) => Promise<void>) {
    if (this.flying.has(key)) return false;
    this.flying.set(key, holds);
    this.queue.push({ key, body });
    this.pump();
    return true;
  }
  /** Whether a launch under `key` is queued or running. */
  busy(key: string) { return this.flying.has(key); }
  /** The keys of every launch queued or running. */
  keys() { return [...this.flying.keys()]; }
  /** Every resource a queued or running launch holds. */
  held() { return new Set([...this.flying.values()].flat()); }
  /** Queued and running launches. */
  get pending() { return this.flying.size; }
  /** What the launches that settled since the last drain recorded, for the cycle to report. */
  drain() { return this.reports.splice(0); }
  /** Resolves once nothing is queued or running. */
  idle() { return this.flying.size ? new Promise<void>(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
  private pump() {
    while (this.running < Math.max(1, this.concurrency) && this.queue.length) {
      const { key, body } = this.queue.shift()!, sink: DaemonAction[] = [];
      this.running += 1;
      // A launch outlives the cycle that handed it over, so its calls are not that cycle's timings.
      void withoutTimings(() => Promise.resolve().then(() => body(sink))).catch(() => undefined).finally(() => {
        this.running -= 1;
        this.flying.delete(key);
        this.reports.push(...sink);
        if (!this.flying.size) for (const resolve of this.waiters.splice(0)) resolve();
        this.pump();
      });
    }
  }
}

/**
 * One coordination cycle: close finished sessions, reclaim the disk finished assignments hold,
 * dispatch claimable work to a healthy profile, shepherd reviews and proofs, invoke only the
 * guarded merge, verify the deployed SHA, and measure the stages. The cursor is persisted before and after every external action, so a kill between
 * them leaves an entry the next start reconciles against Graphyard instead of repeating.
 */
export async function runCycle(config: MasterConfig, state: DaemonState, unbounded: DaemonEffects, now: () => number = Date.now, launcher?: Launcher) {
  // Every step this cycle runs is timed, and every external call beneath it of a second or more is
  // recorded against the step it was made in (GY-377): the recorder is found through the async
  // context, so the dispatcher running beside the cycle in the same process keeps its own calls.
  const timings = new Timings(now);
  // Without a launcher the loop keeps across cycles (a single cycle, a test), the cycle is its own
  // and settles its launches after each step that makes them, as one cycle always did: the step's
  // launches run at once, bounded only by the profiles free for them, and are reported in the cycle.
  return withTimings(timings, () => cycle(config, state, unbounded, now, timings, launcher ?? new Launcher(Number.POSITIVE_INFINITY), !launcher));
}

async function cycle(config: MasterConfig, state: DaemonState, unbounded: DaemonEffects, now: () => number, timings: Timings, launcher: Launcher, settle: boolean) {
  const effects = serialPersist(boundedPersist(unbounded), unbounded);
  if (!settle) launcher.concurrency = config.run.launchConcurrency ?? defaultLaunchConcurrency;
  const startedAt = now();
  const read = await timings.step('snapshot', () => effects.snapshot());
  const readAt = now();
  // Filing runs in the dispatcher, beside this cycle: an approval it has not yet reconciled still
  // sets its threads aside, so the cycle never sends a head back over what that review filed.
  const snapshot = setAsideFollowUpThreads(read, await timings.step('follow-up threads', () => effects.followUpThreads?.(read.work, Number.isFinite(Date.parse(read.now)) ? Date.parse(read.now) : readAt).catch(() => undefined)));
  const observedAt = Date.parse(snapshot.now), clock = Number.isFinite(observedAt) ? observedAt : startedAt;
  // The same bound `master status` uses, from the read that produced this snapshot: containment
  // settlement may only be proposed while the local clock can be compared with the control plane.
  const clockOffset = { min: Math.round(startedAt - clock), max: Math.round(readAt - clock) };
  // What the launches handed over by earlier cycles recorded since the last one is this cycle's to report.
  const performed: DaemonAction[] = launcher.drain();
  // The merge queue batches by this loop's configuration; a failed publication is retried next cycle.
  if (effects.publishMergeBatchSize) await timings.step('merge queue', () => effects.publishMergeBatchSize!().catch(() => undefined));
  // A launch still queued or running is not interrupted: its `started` entry is its own to settle,
  // so it is kept out of the reconciliation a restart's leftovers get.
  const inFlight = launcher.keys().flatMap(key => state.actions[key]?.state === 'started' ? [[key, state.actions[key]] as const] : []);
  for (const [key] of inFlight) delete state.actions[key];
  const resumed = reconcilePendingActions(state, snapshot.work, clock);
  for (const [key, action] of inFlight) state.actions[key] = action;
  if (resumed.length) { performed.push(...resumed); await timings.step('reconcile', () => effects.persist(state)); }
  // One item's failure is that item's failed action, never the cycle's (GY-187). Each step handles
  // its items one at a time inside this: a throw — a malformed field, an effect that failed outside
  // its own try, a value no step anticipated — is recorded against the item it was handling, and
  // the step goes on to the next item. Only the cycle-wide reads (the snapshot, Herdr, credentials)
  // and a cursor that cannot be written fail the cycle. A body's result is passed back.
  const isolate = async <T>(kind: DaemonActionKind, item: Work | null, name: string, body: () => Promise<T>): Promise<T | undefined> => {
    try { return await body(); }
    catch (error) {
      const key = `isolated:${kind}:${item?.id ?? name}`;
      performed.push(await record(state, key, { kind, work: item?.key ?? null, principal: null, state: 'failed', epoch: item?.epoch ?? null,
        detail: `Handling ${name} in the ${kind} step threw, so only its own action failed and the cycle went on with every other item: ${message(error)}`,
        attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return undefined;
    }
  };
  // Where this cycle's time goes. Each `spent` closes the step that just ran with its wall time
  // and, of that, the time at least one child process was in flight (the runner's ledger, drained
  // at the boundary), so the cycle can say which step outgrew the interval and whether that step
  // was computing or waiting on Herdr, gh or git.
  const steps = emptyCycleSteps();
  let stepStartedAt = startedAt;
  const spent = (step: CycleStepName) => {
    const at = now(), ms = Math.max(0, at - stepStartedAt);
    steps[step].ms += ms; steps[step].childWaitMs += Math.min(ms, Math.max(0, Math.round(effects.childWaits?.() ?? 0)));
    stepStartedAt = at;
  };
  spent('observe');

  const agents = await timings.step('observe', () => effects.agents());
  const credentials = await timings.step('credentials', () => effects.credentials(config.workers));
  const open = snapshot.work.filter(item => item.stage !== 'done');
  const owns = (principal: string) => open.some(item => !!item.lease && item.lease.owner === principal && Date.parse(item.lease.expiresAt) > clock);
  /** The item a worker profile holds a live lease on, which a failure while handling that profile is recorded against. */
  const heldBy = (profile: WorkerProfile) => open.find(item => !!item.lease && item.lease.owner === profile.principal && Date.parse(item.lease.expiresAt) > clock) ?? null;

  /**
   * Hand one launch to the launcher and move on (GY-616). `key` is the cursor key the launch records
   * its `started` entry under, so a launch in flight is neither repeated nor reconciled as
   * interrupted; a throw is that launch's own failed action, reported with its result next cycle.
   */
  const launch = (kind: DaemonActionKind, item: Work | null, key: string, holds: string[], body: (sink: DaemonAction[]) => Promise<void>) => launcher.submit(key, holds, async sink => {
    try { await body(sink); }
    catch (error) {
      const failed = `isolated:${kind}:${item?.id ?? key}`;
      try {
        sink.push(await record(state, failed, { kind, work: item?.key ?? null, principal: null, state: 'failed', epoch: item?.epoch ?? null,
          detail: `The ${kind} launch for ${item?.key ?? key} threw, so only that launch failed: ${message(error)}`,
          attempts: (state.actions[failed]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      } catch { /* a cursor that cannot be written is the next cycle's failure */ }
    }
  });
  const cycle: Cycle = { config, state, effects, now, snapshot, clock, clockOffset, performed, isolate, agents, credentials, open, owns, heldBy, timings, launcher, launch, detached: !settle };
  /** A cycle that owns its launcher waits for what a step handed it; the loop's cycles never do. */
  const settleLaunches = async () => { if (settle && launcher.pending) { await timings.step('launches', () => launcher.idle()); performed.push(...launcher.drain()); } };
  await timings.step('close', () => closeStep(cycle));
  await settleLaunches();

  // A pane this cycle just closed frees its profile, so health is read after the closures.
  const health = profileHealth(config.workers, credentials, await timings.step('observe', () => effects.agents()), state, clock);

  spent('close');

  const { settled, budget } = await timings.step('scope', () => scopeStep(cycle));
  // 2c. Open items planning a file the base split or renamed are re-planned onto its successors.
  await timings.step('successors', () => successorStep(cycle));
  spent('decisions');

  const assessments = await timings.step('reclaim', () => reclaimStep(cycle));
  spent('close');

  const capacity = await timings.step('dispatch', () => dispatchStep(cycle, health, assessments));
  await settleLaunches();
  spent('dispatch');

  await timings.step('decisions', () => decisionStep(cycle, settled, assessments, capacity));
  await settleLaunches();
  spent('decisions');

  await timings.step('reviews and proofs', () => shepherdStep(cycle));
  spent('dispatch');

  await timings.step('merges', () => mergeStep(cycle));
  spent('merge');

  await timings.step('deployment verification', () => deploymentStep(cycle));
  // 7b. Classify what is wrong and file one item per recurring class (GY-173). It shares the
  //     deployment step's clock: it reads the same snapshot and makes at most one call per class.
  await timings.step('faults', () => faultStep(cycle, assessments));
  // 7c. The pipeline doctor (GY-711): the deterministic remedies every cycle, and one doctor run
  //     every `run.doctor.intervalMinutes`. It shares the deployment step's clock too.
  await timings.step('doctor', () => doctorStep(cycle));
  spent('deployment');

  await settleLaunches();

  // 8. Measure. Every cycle records stage p50/p90 whether or not it acted, what it could have
  //    acted on and how long the longest of those has waited, and the passage of every item it
  //    watches: ready→claim, ready→first push, approval→merge and how long a mergeable candidate
  //    stayed mergeable. All of it from the snapshot this cycle acted on, so no figure can
  //    disagree with the state that produced it.
  const measuredFrom = now();
  for (const item of snapshot.work) {
    const sample = observeItemClock(state, item, clock);
    if (sample) state.latency.push(sample);
  }
  const actionable = actionableSubjects(config, snapshot.work, clock, { assessments, approvals: state.approvals });
  const silence = trackSilence(state, actionable, performed, clock);
  const { stages, lead, production, postDeploy, postDeployFailures } = stageMetrics(snapshot.work, clock);
  // The cycle's duration, and of it the time at least one child was in flight: the difference is
  // the loop's own work, which is what the liveness bound is judged on (cycleCost).
  timings.add('measure', now() - measuredFrom);
  const durationMs = Math.max(0, Math.round(now() - startedAt));
  const childWaitMs = Math.min(durationMs, Object.values(steps).reduce((total, step) => total + step.childWaitMs, 0));
  const metrics = cycleMetricsSchema.parse({ cycle: state.cycle, at: new Date(clock).toISOString(), durationMs, childWaitMs, workMs: durationMs - childWaitMs, steps, timings: timings.report(), open: open.length, actions: performed.length,
    actionable: silence.actionable, idleMs: silence.longestIdleMs, stages, lead, production, postDeploy, postDeployFailures,
    scope: { count: budget.count, p50Ms: budget.p50Ms, p90Ms: budget.p90Ms }, scopeOpenMs: budget.longestOpenMs });
  state.metrics.push(metrics);
  state.cycle += 1;
  state.lastCycleAt = new Date(now()).toISOString();
  if (state.lock) state.lock = { ...state.lock, heartbeatAt: state.lastCycleAt };
  pruneDaemonState(state);
  await effects.persist(state);
  return { actions: performed, metrics, deployment: state.deployment, health, silence, budget: latencyBudget(state.latency), scope: budget };
}

/**
 * Cursor writes one at a time, in the order they were asked for. Launches run at once (GY-377), and
 * two writes racing each other could otherwise land the older state last — a kill right after would
 * leave a cursor missing the action the later write recorded. Launches outlive their cycle (GY-616),
 * so the order is kept per underlying effects, across cycles, not per cycle.
 */
const writeChains = new WeakMap<object, { writing: Promise<unknown> }>();
function serialPersist(effects: DaemonEffects, owner: object): DaemonEffects {
  let chain = writeChains.get(owner);
  if (!chain) writeChains.set(owner, chain = { writing: Promise.resolve() });
  const persist = (state: DaemonState) => { const write = chain!.writing.then(() => effects.persist(state)); chain!.writing = write.catch(() => {}); return write; };
  return new Proxy(effects, { get: (target, property, receiver) => property === 'persist' ? persist : Reflect.get(target, property, receiver) });
}

/** What every step of one cycle reads: the snapshot it acts on, the cursor, and the cycle's own bookkeeping. */
export interface Cycle {
  config: MasterConfig; state: DaemonState; effects: DaemonEffects; now: () => number;
  snapshot: Awaited<ReturnType<DaemonEffects['snapshot']>>; clock: number; clockOffset: { min: number; max: number };
  performed: DaemonAction[];
  isolate: <T>(kind: DaemonActionKind, item: Work | null, name: string, body: () => Promise<T>) => Promise<T | undefined>;
  agents: HerdrAgent[]; credentials: Awaited<ReturnType<DaemonEffects['credentials']>>; open: Work[];
  owns: (principal: string) => boolean; heldBy: (profile: WorkerProfile) => Work | null;
  /** This cycle's step and call timings (GY-377); a step may time a phase of its own inside it. */
  timings: Timings;
  /** The launcher beside the cycle (GY-616): what is in flight, and what it holds. */
  launcher: Launcher;
  /** Hands a launch to the launcher without waiting on it; false when one under `key` is already in flight. */
  launch: (kind: DaemonActionKind, item: Work | null, key: string, holds: string[], body: (sink: DaemonAction[]) => Promise<void>) => boolean;
  /** Whether launches outlive this cycle (the loop's launcher), or are settled within it (a cycle run on its own). */
  detached: boolean;
}
