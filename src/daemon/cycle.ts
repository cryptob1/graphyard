// Concern: one coordination cycle — the snapshot it reads and the order of its steps.
import type { Work } from '../model.js';
import type { MasterConfig, WorkerProfile, HerdrAgent } from '../master.js';
import { cycleMetricsSchema, type DaemonAction, type DaemonActionKind, type DaemonState, message, pruneDaemonState } from './state.js';
import { dispatchKey, reconcilePendingActions } from './reconcile.js';
import { reworkStep, type ExhaustedProof } from './rework.js';
import { actionableSubjects } from './subjects.js';
import { profileHealth } from './sessions.js';
import { boundedPersist } from './liveness.js';
import { type DaemonEffects, record } from './effects.js';
import { closeStep } from './cycle-sessions.js';
import { masterSessionStep } from './cycle-master.js';
import { reclaimStep } from './cycle-reclaim.js';
import { dispatchStep } from './cycle-dispatch.js';
import { baseFailureStep } from './cycle-base-failures.js';
import { deploymentStep, mergeStep, shepherdStep } from './cycle-delivery.js';
import { checkInvariants } from '../model/invariants.js';
import { mergeWriterStep } from './cycle-merge-writer.js';
import { syncProjectMemory } from '../project-memory.js';

/** How many session launches the launcher runs at once when master.json sets no `run.launchConcurrency` (GY-616). */
export const defaultLaunchConcurrency = 3;

/**
 * The session launcher beside the cycle (GY-616). A launch — a worker dispatch, a failover
 * relaunch — creates a Herdr pane and registers a session, which under memory pressure
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
      void Promise.resolve().then(() => body(sink)).catch(() => undefined).finally(() => {
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
 * guarded merge and verify the deployed SHA. A step that fails is logged and runs again next cycle. The cursor is persisted before and after every external action, so a kill between
 * them leaves an entry the next start reconciles against Graphyard instead of repeating.
 */
export async function runCycle(config: MasterConfig, state: DaemonState, unbounded: DaemonEffects, now: () => number = Date.now, launcher?: Launcher, log: (line: string) => void = line => console.error(line)) {
  // Without a launcher the loop keeps across cycles (a single cycle, a test), the cycle is its own
  // and settles its launches after each step that makes them, as one cycle always did: the step's
  // launches run at once, bounded only by the profiles free for them, and are reported in the cycle.
  return cycle(config, state, unbounded, now, launcher ?? new Launcher(Number.POSITIVE_INFINITY), !launcher, log);
}

async function cycle(config: MasterConfig, state: DaemonState, unbounded: DaemonEffects, now: () => number, launcher: Launcher, settle: boolean, log: (line: string) => void) {
  // Every pane a step of this cycle closes, so a later step reading the same cycle-start inventory
  // never closes it again (GY-980).
  const closedPanes = new Set<string>();
  const effects = trackClosedPanes(serialPersist(boundedPersist(unbounded), unbounded), closedPanes);
  if (!settle) launcher.concurrency = config.run.launchConcurrency ?? defaultLaunchConcurrency;
  const startedAt = now();
  const read = await effects.snapshot();
  const readAt = now();
  const snapshot = read;
  const observedAt = Date.parse(snapshot.now), clock = Number.isFinite(observedAt) ? observedAt : startedAt;
  // The same bound `master status` uses, from the read that produced this snapshot: containment
  // settlement may only be proposed while the local clock can be compared with the control plane.
  const clockOffset = { min: Math.round(startedAt - clock), max: Math.round(readAt - clock) };
  // What the launches handed over by earlier cycles recorded since the last one is this cycle's to report.
  const performed: DaemonAction[] = launcher.drain();
  // The merge queue batches by this loop's configuration; a failed publication is retried next cycle.
  if (effects.publishMergeSettings) await effects.publishMergeSettings().catch(() => undefined);
  // A launch still queued or running is not interrupted: its `started` entry is its own to settle,
  // so it is kept out of the reconciliation a restart's leftovers get.
  const inFlight = launcher.keys().flatMap(key => state.actions[key]?.state === 'started' ? [[key, state.actions[key]] as const] : []);
  for (const [key] of inFlight) delete state.actions[key];
  const resumed = reconcilePendingActions(state, snapshot.work, clock);
  for (const [key, action] of inFlight) state.actions[key] = action;
  if (resumed.length) { performed.push(...resumed); await effects.persist(state); }
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
        detail: `Handling ${name} in the ${kind} step threw, so it is retried next cycle: ${message(error)}`,
        attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return undefined;
    }
  };
  const agents = await effects.agents();
  const credentials = await effects.credentials(config.workers);
  const open = snapshot.work.filter(item => item.stage !== 'done');
  const owns = (principal: string) => open.some(item => !!item.lease && item.lease.owner === principal && Date.parse(item.lease.expiresAt) > clock);
  /** The item a worker profile holds a live lease on, which a failure while handling that profile is recorded against. */
  const heldBy = (profile: WorkerProfile) => open.find(item => !!item.lease && item.lease.owner === profile.principal && Date.parse(item.lease.expiresAt) > clock) ?? null;

  let exhausted: Promise<ExhaustedProof[]> | undefined;
  const exhaustedProofs = () => exhausted ??= effects.exhaustedProofs?.().catch(() => []) ?? Promise.resolve([]);
  /**
   * Hand one launch to the launcher and move on (GY-616). `key` is the cursor key the launch records
   * its `started` entry under, so a launch in flight is neither repeated nor reconciled as
   * interrupted; a throw is that launch's own failed action, reported with its result next cycle.
   */
  const launch = (kind: DaemonActionKind, item: Work | null, key: string, holds: string[], body: (sink: DaemonAction[]) => Promise<void>) => launcher.submit(key, holds, async sink => {
    try { await body(sink); }
    catch (error) {
      const failed = `isolated:${kind}:${item?.id ?? key}`;
      const why = `The ${kind} launch for ${item?.key ?? key} threw, so only that launch failed: ${message(error)}`;
      try {
        sink.push(await record(state, failed, { kind, work: item?.key ?? null, principal: null, state: 'failed', epoch: item?.epoch ?? null,
          detail: why,
          attempts: (state.actions[failed]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      } catch { /* a cursor that cannot be written is the next cycle's failure */ }
      // The launch's own `started` entry is what holds the cycle off the same work until it settles,
      // and a body that threw after recording it, before settling it itself, left it started until a
      // restart reconciled it (GY-714). It is settled failed here for the same throw, so the cursor
      // is truthful now and the gates that read the key see a failure they can retry.
      const started = state.actions[key];
      if (started?.state === 'started') {
        try {
          sink.push(await record(state, key, { kind: started.kind, work: started.work, principal: started.principal, epoch: started.epoch, state: 'failed',
            detail: `${why} Its own started entry is settled failed for that throw, so no restart is needed to reconcile it`,
            attempts: started.attempts, cycle: state.cycle }, now(), effects.persist));
        } catch { /* a cursor that cannot be written is the next cycle's failure */ }
      }
    }
  });
  const cycle: Cycle = { config, state, effects, now, snapshot, clock, clockOffset, performed, isolate, agents, credentials, open, owns, heldBy, launcher, launch, detached: !settle, baseFailed: new Map(), exhaustedProofs, closedPanes };
  /**
   * One step of the cycle. A step that throws or times out is one log line naming the step and the
   * error; the cycle goes on with its other steps and the step runs again next cycle. Nothing is
   * classified, remedied or escalated.
   */
  const step = async <T>(name: string, body: () => Promise<T>): Promise<T | undefined> => {
    try { return await body(); }
    catch (error) { log(`[graphyard-master] cycle ${state.cycle}: the ${name} step failed and runs again next cycle: ${message(error)}`); return undefined; }
  };
  /** A cycle that owns its launcher waits for what a step handed it; the loop's cycles never do. */
  const settleLaunches = async () => { if (settle && launcher.pending) { await launcher.idle(); performed.push(...launcher.drain()); } };
  await step('close', () => closeStep(cycle));
  await settleLaunches();

  // A pane this cycle just closed frees its profile, so health is read after the closures.
  const health = profileHealth(config.workers, credentials, await effects.agents(), state, clock, snapshot.work);

  // 1m. The loop's own master session (GY-898): launch, adopt, supervise, rotate, wake. Isolated
  //     like every step: a failed launch or wake is its own action, and the cycle goes on.
  await step('master session', () => masterSessionStep(cycle));
  await settleLaunches();



  await step('reclaim', () => reclaimStep(cycle));

  // 3a. A required check that fails on the base head too is set aside before anything decides on
  //     the item (GY-528).
  cycle.baseFailed = await step('base failures', () => baseFailureStep(cycle)) ?? new Map();

  await step('dispatch', () => dispatchStep(cycle, health));
  await settleLaunches();

  // 4c. A head nothing can carry forward goes back to a worker at once, with the master's own identity.
  await step('rework', () => reworkStep(cycle));

  await step('reviews and proofs', () => shepherdStep(cycle));

  await step('merges', () => mergeStep(cycle));
  // 6b'. The control-plane merge executor (GY-1524): open intents reconciled, then one head trial-merged,
  //      tested and pushed with the deploy key beside the cycle; active only under the control-plane merger.
  await step('merge writer', () => cycle.isolate('merge', null, 'merge writer', () => mergeWriterStep(cycle)));

  await step('deployment verification', () => deploymentStep(cycle));
  // 7b. The system invariants (GY-404): properties of the running pipeline no per-item gate can see, one `master status` line each.
  await step('invariants', async () => checkInvariants(state.invariants, { work: snapshot.work, now: clock, thresholds: config.invariants, agents, build: state.deployment?.sha ?? null }));
  // 7e. Setup (GY-1416): derived deployment variables the deployment lacks are set by the loop, never asked of a human.
  if (effects.selfProvision) await step('setup', () => cycle.isolate('config', null, 'setup self-provision', () => effects.selfProvision!()));

  await settleLaunches();

  // 8. What the cycle could have acted on, from the snapshot it acted on.
  // GY-1890: the dispatch step's own saturation report answers whether any launch profile was free
  // when it dispatched. With none free a claimable item's wait is the fleet's slot capacity, so its
  // subject is a capacity one; the master session's wake reads the kinds, so a held fleet reads as
  // the capacity wait it is. The flag is the step's own stop (`saturatedFleet` in the launch step),
  // not a recomputation beside it, so what reclasses a subject is what the step decided.
  const actionable = actionableSubjects(config, snapshot.work, clock, { baseFailed: cycle.baseFailed, fleetHeld: cycle.fleetHeld, launching: item => launcher.busy(dispatchKey(item)) });
  const metrics = cycleMetricsSchema.parse({ cycle: state.cycle, at: new Date(clock).toISOString(), open: open.length, actions: performed.length, actionable: actionable.length });
  state.metrics.push(metrics);
  state.cycle += 1;
  state.lastCycleAt = new Date(now()).toISOString();
  if (state.lock) state.lock = { ...state.lock, heartbeatAt: state.lastCycleAt };
  // GY-1125 / GY-1144: project memory is synchronized per cycle from settled work and merges.
  // It is bounded by retention caps (retainedMemoryNotes=20, retainedMemoryChanges=30), and effects.persist mirrors .graphyard/project-memory.json only when
  // state.projectMemory actually changes, ensuring no redundant disk writes occur per cycle.
  state.projectMemory = await syncProjectMemory({
    existing: state.projectMemory,
    work: snapshot.work,
    now: clock,
  });
  pruneDaemonState(state);
  await effects.persist(state);
  return { actions: performed, metrics, deployment: state.deployment, health, actionable };
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

/** Records every pane closed through `closeSession` into `closed`, once the close returns. */
function trackClosedPanes(effects: DaemonEffects, closed: Set<string>): DaemonEffects {
  const closeSession = async (pane: string) => { await effects.closeSession(pane); closed.add(pane); };
  return new Proxy(effects, { get: (target, property, receiver) => property === 'closeSession' ? closeSession : Reflect.get(target, property, receiver) });
}

/** What every step of one cycle reads: the snapshot it acts on, the cursor, and the cycle's own bookkeeping. */
export interface Cycle {
  config: MasterConfig; state: DaemonState; effects: DaemonEffects; now: () => number;
  snapshot: Awaited<ReturnType<DaemonEffects['snapshot']>>; clock: number; clockOffset: { min: number; max: number };
  performed: DaemonAction[];
  isolate: <T>(kind: DaemonActionKind, item: Work | null, name: string, body: () => Promise<T>) => Promise<T | undefined>;
  agents: HerdrAgent[]; credentials: Awaited<ReturnType<DaemonEffects['credentials']>>; open: Work[];
  owns: (principal: string) => boolean; heldBy: (profile: WorkerProfile) => Work | null;
  /** Per item id, the required checks that fail on the base head too (GY-528): no rework is requested for them. */
  baseFailed: Map<string, Set<string>>;
  /** The producer requests the dispatcher stopped attempting (GY-496), read once per cycle for the proof and rework steps. */
  exhaustedProofs: () => Promise<ExhaustedProof[]>;
  /** The launcher beside the cycle (GY-616): what is in flight, and what it holds. */
  launcher: Launcher;
  /** Hands a launch to the launcher without waiting on it; false when one under `key` is already in flight. */
  launch: (kind: DaemonActionKind, item: Work | null, key: string, holds: string[], body: (sink: DaemonAction[]) => Promise<void>) => boolean;
  /** Whether launches outlive this cycle (the loop's launcher), or are settled within it (a cycle run on its own). */
  detached: boolean;
  /** GY-1890: the dispatch step stopped on a saturated fleet this cycle — no launch profile free while work is claimable, by `saturatedFleet`. The measure reads this, the step's own decision, to name a claimable item's wait a capacity subject instead of a dispatch one. Absent where the step never stopped. */
  fleetHeld?: boolean;
  /** The panes this cycle's steps have closed so far: the cycle-start inventory still lists them. */
  closedPanes: Set<string>;
}
