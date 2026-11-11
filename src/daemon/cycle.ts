import { WorkerSandboxError } from '../worker-sandbox.js';
import type { RuntimeSession } from '../model/sessions.js';
import { sessionAgents } from '../session-inventory.js';
// Concern: one coordination cycle — snapshot, close, dispatch, merge writer, persist, in that order.
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { dataDirectory } from '../install/worktree-root.js';
import { sessionName } from '../session-name.js';
import type { Work } from '../model.js';
import type { MasterConfig, WorkerProfile } from '../master/profiles.js';
import { assertDispatchable, HeadlessWorkerExit, workerRunHandle, type WorkerRun } from '../master/dispatch.js';
import type { ExhaustionSignal } from '../model/capacity.js';
import { endedRuntimeStates } from '../model/sessions.js';
import { checkoutTrustLine } from '../harness.js';
import { detectRuntimeExhaustion } from '../master/runtime-prompt.js';
import { dispatchSort, inFlight, resourceConflicts, sharedResources } from '../coordination.js';
import { capacityRefusal } from '../fleet.js';
import type { CoordinationRounds } from '../server/work-view.js';
import { masterCauses, masterCausePrompt } from './master-stalled-delivery.js';
import { accountNames, advanceFailureRuns, diagnosisSection, failureHeld } from './repeated-failure.js';
import { captureConversation } from '../master/conversation.js';
import { masterHandover } from '../master/master-session.js';
import { herdrWorkspaceOf } from '../master/herdr.js';
import { launchGraceMs } from '../model/registry-sessions.js';
import { paneAlreadyGone } from '../request-settlement.js';
import { cycleMetricsSchema, emptyMasterSession, type DaemonAction, type DaemonActionKind, type DaemonState, message, pruneDaemonState, touchStanding } from './state.js';
import { dispatchKey, reconcilePendingActions } from './reconcile.js';
import { neededRework, reworkKey } from './rework.js';
import { dueHumanProofs } from '../model/human-proof.js';
import { hotspots } from './hotspots.js';
import { settledPurpose } from '../model/session-state.js';
import { loopOwnedRefusal, ownerHoldRefusal } from '../model/loop-owned.js';
import { attemptClaimedAt, attemptProgressFresh, attemptProgressWindowMs } from '../model/attempt-bound.js';
import { attemptBoundMs, attemptCeilingMs, boundMinutes } from '../master/attempt-bound.js';
import { backedOffAccounts, canaryOffer, canaryVerdict, profileHealth, recordLaunchFailure } from './sessions.js';
import { pinnedInstall, repinRuntime, type AgentRegistry, type CanaryOffer } from '../model/registry.js';
import { type DaemonEffects, record } from './effects.js';
import { mergeWriterStep } from './cycle-merge-writer.js';
import { batchGateStep } from './cycle-batch-gate.js';
import { workerLaunchHealth, earlyExitKey } from './worker-launch-health.js';
import { actionStallDelay, actionStallThreshold } from '../model/action-progress.js';
import { syncProjectMemory } from '../project-memory.js';
import { diskHeadroomStep } from './disk-headroom.js';
import { leftoversStep, tallyLeftovers } from './leftovers.js';
import { yardAlertStep } from './yard-alerts.js';
import { controlPlaneStep } from './control-plane.js';

/** How many session launches the launcher runs at once when master.json sets no `run.launchConcurrency` (GY-616). */
export const defaultLaunchConcurrency = 3;
/** The cycle's steps, in order: the cycle record names exactly these. */
export const cycleSteps = ['snapshot', 'close', 'dispatch', 'merge writer', 'persist'] as const;
export type CycleStep = typeof cycleSteps[number];
/** The one timeout every step runs under. */
export const stepTimeoutMs = (config: Pick<MasterConfig, 'run'>) => Math.max(60_000, config.run.intervalSeconds * 2_000);
/** The key the master session's launch is handed to the launcher under. */
export const masterLaunchKey = 'master:launch';

/**
 * The session launcher beside the cycle (GY-616): a launch creates a Herdr pane and registers a
 * session, which can take seconds, so the cycle hands it over and moves on. The launcher runs up to
 * `concurrency` launches at once, never two under one key, and keeps what each recorded for the next
 * cycle to report; the profiles a launch holds stay held until it settles.
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
  busy(key: string) { return this.flying.has(key); }
  keys() { return [...this.flying.keys()]; }
  held() { return new Set([...this.flying.values()].flat()); }
  get pending() { return this.flying.size; }
  drain() { return this.reports.splice(0); }
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

/** What every step of one cycle reads. */
export interface Cycle {
  config: MasterConfig; state: DaemonState; effects: DaemonEffects; now: () => number;
  snapshot: Awaited<ReturnType<DaemonEffects['snapshot']>>; clock: number;
  herdr: { agents: RuntimeSession[]; available: boolean };
  credentials: Awaited<ReturnType<DaemonEffects['credentials']>>;
  performed: DaemonAction[]; launcher: Launcher; reservedProfiles: Set<string>;
  /**
   * GY-3225: the roles whose launches this cycle's checkout-trust check refuses (the roles named by
   * `untrustedCheckoutRoles`), so neither a worker dispatch nor the master session launch opens a
   * pane for them; absent when it refused none.
   */
  checkoutTrustRefused?: ReadonlySet<string>;
  /** The loop's journal line writer: steps that settle beside the cycle log through it (GY-3141). */
  log: (line: string) => void;
}

/**
 * One coordination cycle: snapshot, close, dispatch, merge writer, persist. Each step runs under one
 * timeout; a step that fails is one log line and runs again next cycle. Only a snapshot that cannot be
 * read fails the cycle, since every later step acts on it. A cycle run without the loop's launcher
 * settles its own launches before it persists.
 */
export async function runCycle(config: MasterConfig, state: DaemonState, effects: DaemonEffects, now: () => number = Date.now, launcher?: Launcher, log: (line: string) => void = line => console.error(line)) {
  const own = !launcher, launches = launcher ?? new Launcher(Number.POSITIVE_INFINITY);
  if (!own) launches.concurrency = config.run.launchConcurrency ?? defaultLaunchConcurrency;
  const steps: CycleStep[] = [];
  const timeoutMs = stepTimeoutMs(config), stalled: string[] = [];
  const step = async <T>(name: CycleStep, body: () => Promise<T>): Promise<T | undefined> => {
    steps.push(name);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([body(), new Promise<never>((_, reject) => { timer = setTimeout(() => { stalled.push(name); reject(new Error(`it ran past its ${Math.round(timeoutMs / 1000)}s timeout`)); }, timeoutMs); timer.unref?.(); })]);
    } catch (error) {
      if (name === 'snapshot') throw error;
      log(`[graphyard-master] cycle ${state.cycle}: the ${name} step failed and runs again next cycle: ${message(error)}`);
      return undefined;
    } finally { clearTimeout(timer); }
  };

  const read = (await step('snapshot', async () => {
    const [snapshot, herdr] = await Promise.all([effects.snapshot(), Promise.resolve(effects.inventory ? effects.inventory().then(inventory => ({ agents: sessionAgents(inventory), available: inventory.available })) : effects.herdr ? effects.herdr() : effects.agents()).then(read => Array.isArray(read) ? { agents: read, available: true } : read)]);
    return { snapshot, herdr, credentials: await effects.credentials(config.workers) };
  }))!;
  const observed = Date.parse(read.snapshot.now), clock = Number.isFinite(observed) ? observed : now();
  const performed: DaemonAction[] = launches.drain();
  // A launch still in flight settles its own `started` entry; any other one is a restart's leftover, reconciled against the snapshot.
  const inFlight = launches.keys().flatMap(key => state.actions[key]?.state === 'started' ? [[key, state.actions[key]] as const] : []);
  for (const [key] of inFlight) delete state.actions[key];
  performed.push(...reconcilePendingActions(state, read.snapshot.work, clock));
  for (const [key, action] of inFlight) state.actions[key] = action;
  const cycle: Cycle = { config, state, effects, now, ...read, clock, performed, launcher: launches, reservedProfiles: launches.held(), log };

  if (!config.forPerson) await step('close', () => closeStep(cycle));
  await step('dispatch', async () => {
    await dispatchStep(cycle);
    if (!config.forPerson) for (const person of config.people ?? []) {
      // Release and review/proof dispatch are the install's, once a cycle: every scope shares that capacity, so priority decides across owners.
      const scopedConfig = { ...config, forPerson: person, masterAgentName: sessionName(config.masterAgentName, person) };
      state.personalMasters[person] ??= emptyMasterSession();
      const scopedState = { ...state, get master() { return state.personalMasters[person]; }, set master(value) { state.personalMasters[person] = value; } };
      await dispatchStep({ ...cycle, config: scopedConfig, state: scopedState, effects: { ...effects, release: undefined, dispatchTick: undefined, masterSession: effects.personalMasterSession?.(scopedConfig), persist: () => effects.persist(state) } });
    }
  });
  // GY-3119: the batch gate on main starts beside the cycle once the merge writer's step ran.
  if (!config.forPerson) await step('merge writer', () => mergeWriterStep(cycle).then(() => batchGateStep(cycle)));
  if (own) { await launches.idle(); performed.push(...launches.drain()); }
  await step('persist', async () => {
    state.projectMemory = await syncProjectMemory({ existing: state.projectMemory, work: read.snapshot.work, now: clock });
    // GY-3101: the stalled-yard alert, beside the persist it survives: the loop tells the operator directly when queued work can neither start nor merge.
    if (!config.forPerson) await yardAlertStep(cycle);
    // GY-3199, GY-3233: the control plane's own faults — a stuck upgrade, a stalled step — reported upstream once, and the daily staleness line.
    if (!config.forPerson) await controlPlaneStep(cycle, stalled);
    if (!config.forPerson) await leftoversStep(state, clock, effects.leftoverDisk, log);
  });
  const metrics = cycleMetricsSchema.parse({ cycle: state.cycle, at: new Date(clock).toISOString(), open: read.snapshot.work.filter(item => item.stage !== 'done').length, actions: performed.length, steps });
  state.metrics.push(metrics);
  state.cycle += 1;
  state.lastCycleAt = new Date(now()).toISOString();
  if (state.lock) state.lock = { ...state.lock, heartbeatAt: state.lastCycleAt };
  pruneDaemonState(state);
  await effects.persist(state);
  return { actions: performed, metrics };
}

/** Records one action on the cursor and reports it. */
const note = async (cycle: Cycle, key: string, kind: DaemonActionKind, work: string | null, outcome: DaemonAction['state'], detail: string, principal: string | null = null) =>
  cycle.performed.push(await record(cycle.state, key, { kind, work, principal, state: outcome, detail, attempts: (cycle.state.actions[key]?.attempts ?? 0) + 1, cycle: cycle.state.cycle }, cycle.now(), cycle.effects.persist));

/** Why a running session's item no longer needs it, or null while it does. */
function sessionEnded(item: Work, session: NonNullable<Work['sessions']>[number], clock: number): string | null {
  if (item.stage === 'done') return `${item.key} is done`;
  if (session.kind !== 'implementation') return null;
  const epoch = session.epoch ?? Number(/:(\d+)$/.exec(session.id)?.[1]);
  const lease = item.lease;
  if (!lease || lease.owner !== session.principal || lease.epoch !== epoch) return `${item.key}'s attempt ${epoch} has ended`;
  if (Date.parse(lease.expiresAt) <= clock) return `${item.key}'s lease for attempt ${epoch} lapsed`;
  return null;
}

/**
 * The attempt whose lapsed lease the control plane's reconciliation already cleared (GY-2956): the
 * item's current attempt, unsubmitted, still without a worker exhaustion on the record, ended
 * `expired` by that reconciliation — the coordination view's `attemptEnd` is the only witness the
 * record carries, the lease itself is gone. Returned as the lease the preservation acts through:
 * its epoch and owner, with a workspace of the attempt on this host for the work to be kept in.
 */
function reconciledAttempt(item: Work, hostId: string): Pick<NonNullable<Work['lease']>, 'epoch' | 'owner'> | null {
  const end = (item as Work & CoordinationRounds).attemptEnd;
  if (!end || end.end !== 'expired' || end.epoch !== item.epoch) return null;
  if ((item.capacity?.exhaustions ?? []).some(entry => entry.role === 'worker' && entry.epoch === end.epoch)) return null;
  const space = item.workspaces?.find(entry => entry.epoch === end.epoch && entry.host === hostId);
  return space ? { owner: space.owner, epoch: end.epoch } : null;
}

/** How long a done item's worktree with uncommitted files is kept after its last attempt ended. */
const finishedWorktreeKeepMs = 24 * 60 * 60 * 1000;

/** The ended attempts' worktrees on this host: no live lease and no running session holds their epoch. */
export function endedAttemptWorktrees(work: Work[], hostId: string, now: number) {
  return work.flatMap(item => (item.workspaces ?? []).filter(space => space.host === hostId
    && !(item.lease && item.lease.epoch === space.epoch && Date.parse(item.lease.expiresAt) > now)
    && !(item.sessions ?? []).some(handle => handle.kind === 'implementation' && handle.state === 'running' && (handle.epoch ?? Number(/:(\d+)$/.exec(handle.id)?.[1])) === space.epoch))
    .map(space => ({ item, space })));
}

/**
 * Close: end the sessions on this host whose item left the stage they were launched for, keep what
 * an attempt ended by a lapsed lease had not committed, ask the control plane to reconcile each
 * lease that lapsed with nothing submitted, and remove the worktrees of ended attempts.
 */
async function closeStep(cycle: Cycle) {
  const { config, state, effects, snapshot, clock } = cycle;
  for (const item of snapshot.work) if (item.stage === 'done') delete state.actions[earlyExitKey(item)];
  for (const item of snapshot.work) for (const session of item.sessions ?? []) {
    if (session.host !== config.hostId) continue;
    const key = `close:${item.id}:${session.id}`;
    if (session.state !== 'running' && (item.stage === 'done' || state.actions[key]?.state === 'done')) continue;
    const failure = item.stage === 'done' ? null : await workerLaunchHealth(cycle, item, session);
    // A reporter-finished handle can still own a pane. Diagnose it before the same idempotent close.
    if (session.state !== 'running' && !failure) continue;
    const reason = sessionEnded(item, session, clock) ?? (session.state !== 'running' ? failure : null);
    if (reason) {
      try {
        if (session.pane) await Promise.resolve(effects.closeSession(session.pane)).catch(error => { if (!paneAlreadyGone(error)) throw error; });
        if (session.pane) tallyLeftovers(state, 'panes');
        await effects.recordSession?.(item, { id: session.id, kind: session.kind, principal: session.principal, runtime: session.runtime, host: session.host, subject: session.subject, state: 'finished', outcome: failure ?? `closed by the loop: ${reason}`.slice(0, 500) });
        await note(cycle, key, 'close', item.key, 'done', `Closed ${session.id}${session.pane ? ` (pane ${session.pane})` : ''}: ${failure ?? reason}`, session.principal);
      } catch (error) { await note(cycle, key, 'close', item.key, 'failed', `Could not close ${session.id}: ${message(error)}`, session.principal); }
      continue;
    }
    await attemptBoundStep(cycle, item, session);
  }
  if (effects.reclaimLease) for (const item of snapshot.work) {
    if (item.stage === 'done' || item.submission) continue;
    const lease = item.lease;
    // GY-2953: a lease still on the record that lapsed is ended here, after the attempt's work is
    // kept. GY-2956: the control plane's own reconciliation clears a lapsed lease within one of its
    // ticks, long before this loop's next snapshot, so the attempt usually reaches it with no lease
    // at all — the attempt's `expired` end on the record is then the only witness, and the work is
    // kept all the same, or the redispatch silently starts from the shared base.
    const ended = lease ? (Date.parse(lease.expiresAt) <= clock ? lease : null)
      : effects.endExpiredLease ? reconciledAttempt(item, config.hostId) : null;
    if (!ended) continue;
    const key = `reclaim:lease:${item.id}:${ended.epoch}`;
    if (state.actions[key]?.state === 'done') continue;
    try {
      const kept = effects.endExpiredLease ? await effects.endExpiredLease(item, ended) : null;
      if (!kept && lease) await effects.reclaimLease(item);
      await note(cycle, key, 'reclaim', item.key, 'done', kept
        ? `${item.key}: epoch ${ended.epoch}'s lease lapsed with nothing submitted; its work is on the record for the redispatch's handoff (${kept.state}${kept.commit ? `, commit ${kept.commit.slice(0, 12)}` : ''}${kept.branch ? ` on ${kept.branch}` : ''})${lease ? ', and the lease is ended' : ', whose reconciliation the control plane had already recorded'}`
        : `${item.key}: the lease ${ended.owner} held under epoch ${ended.epoch} lapsed with nothing submitted; the control plane reconciles it`, ended.owner);
    }
    catch (error) { await note(cycle, key, 'reclaim', item.key, 'failed', `${item.key}: the lapsed lease could not be reconciled: ${message(error)}`, ended.owner); }
  }
  // GY-3191: Git keeps a tree its attempt left uncommitted files in; once the item is done and a day
  // has passed since its last attempt ended, nothing will resume that work, so the removal is forced.
  if (effects.removeWorktree) for (const { item, space } of endedAttemptWorktrees(snapshot.work, config.hostId, clock)) {
    const endedAt = Date.parse((item as Work & CoordinationRounds).attemptEnd?.endedAt ?? item.updatedAt);
    const force = item.stage === 'done' && clock - endedAt > finishedWorktreeKeepMs;
    const key = `worktree:${item.id}:${space.epoch}${force ? ':forced' : ''}`;
    // GY-3226: a failed removal is tried again on the next cycles, up to three attempts per key.
    const prior = state.actions[key];
    if (prior && (prior.state === 'done' || prior.attempts >= 3)) continue;
    try { if (await effects.removeWorktree(space.path, force)) { tallyLeftovers(state, 'worktrees'); await note(cycle, key, 'reclaim', item.key, 'done', `Removed ${item.key} epoch ${space.epoch}'s worktree ${space.path}: its attempt ended`); } }
    catch (error) { await note(cycle, key, 'reclaim', item.key, 'failed', `Could not remove ${item.key} epoch ${space.epoch}'s worktree ${space.path}: ${message(error)}`); }
  }
  // GY-2944: a review or proof session whose dispatch request is answered, whose item has left
  // the stage it was launched for, or whose pane Herdr no longer reports is over — and so is the
  // agent-registry session its launch ran under. The registry ends it with the reason (a vanished
  // pane names the pane), so a finished review or proof stops consuming its role's concurrency;
  // master status and master registry then show it ended, with that reason. The handle itself is
  // left to the session report and the reconcile passes, which own its relaunch.
  if (effects.releaseRegistrySession) for (const item of snapshot.work) for (const session of item.sessions ?? []) {
    if (session.state !== 'running' || session.host !== config.hostId || (session.kind !== 'review' && session.kind !== 'proof')) continue;
    const paneGone = !!session.pane && cycle.herdr.available && !cycle.herdr.agents.some(agent => agent.pane_id === session.pane);
    const reason = settledPurpose(item, session, clock)
      ?? (paneGone ? `the Herdr inventory no longer reports pane ${session.pane} (${session.agentName ?? session.id}), so its session is gone` : null);
    if (!reason) continue;
    const key = `release:${item.id}:${session.id}`;
    if (state.actions[key]?.state === 'done') continue;
    try {
      const ended = await effects.releaseRegistrySession({ key: item.key, id: session.id, kind: session.kind, head: session.head ?? null, pane: session.pane ?? null, agentName: session.agentName ?? null }, reason);
      await note(cycle, key, 'close', item.key, 'done', `Released ${session.id}'s agent-registry session (${ended ?? 'none recorded'}): ${reason}`, session.principal ?? null);
    } catch (error) { await note(cycle, key, 'close', item.key, 'failed', `Could not release ${session.id}'s agent-registry session: ${message(error)}`, session.principal ?? null); }
  }
  // GY-3188: a pane Graphyard launched is closed once its session has ended (its item done, or its
  // session no longer running) unless its agent is still working, and so is one whose runtime exited
  // in a worktree since removed. A live session's pane is never touched.
  const launched = new Set(snapshot.work.flatMap(item => (item.sessions ?? []).map(session => session.pane)));
  const ended = new Set<string>(), live = new Set<string>();
  const judge = (item: Work, session: NonNullable<Work['sessions']>[number]) => {
    if (!session.pane) return;
    launched.add(session.pane);
    if (item.stage === 'done' || session.state !== 'running') { if (!live.has(session.pane)) ended.add(session.pane); }
    else { live.add(session.pane); ended.delete(session.pane); }
  };
  for (const item of snapshot.work) for (const session of item.sessions ?? []) judge(item, session);
  const masters = new Set([state.master, ...Object.values(state.personalMasters)].map(master => master.pane));
  const managedRoots = [resolve(dataDirectory(), 'worktrees'), ...(config.run.worktreeRoot ? [resolve(config.run.worktreeRoot)] : [])];
  const recoveredItems = new Set<string>();
  if (cycle.herdr.available) for (const agent of cycle.herdr.agents) {
    const cwd = (agent.cwd ?? '').replace(/ \(deleted\)$/, '');
    const pane = agent.pane_id;
    if (!pane || masters.has(pane) || live.has(pane) || agent.agent_status === 'working') continue;
    if (!cwd.includes('/.graphyard/worktrees/') && !managedRoots.some(root => cwd.startsWith(root + sep))) continue;
    const gone = !existsSync(cwd), exited = !agent.agent || endedRuntimeStates.includes(agent.agent_status ?? '');
    const due = () => ended.has(pane) || (gone && exited && launched.has(pane));
    // Finished sessions disappear from coordination, and old launch actions are pruned.
    // Read only the leftover's item, once per cycle; never fetch the fleet's full history.
    if (!due() && effects.sessionHistory) {
      const key = [...cwd.matchAll(/(?:^|[/-])(GY-\d+)(?=[/-]|$)/gi)].at(-1)?.[1].toUpperCase();
      const item = snapshot.work.find(work => work.key === key || work.workspaces?.some(space => space.path === cwd));
      if (item && !recoveredItems.has(item.id)) {
        for (const session of await effects.sessionHistory(item)) judge(item, session);
        recoveredItems.add(item.id);
      }
    }
    if (live.has(pane) || !due()) continue;
    const why = ended.has(pane) ? 'its session has ended' : `its runtime exited and its worktree ${cwd} is removed`;
    try { await Promise.resolve(effects.closeSession(pane)).catch(error => { if (!paneAlreadyGone(error)) throw error; }); tallyLeftovers(state, 'panes'); await note(cycle, `pane:${pane}`, 'close', null, 'done', `Closed pane ${pane}: ${why}`); }
    catch (error) { await note(cycle, `pane:${pane}`, 'close', null, 'failed', `Could not close pane ${pane}: ${message(error)}`); }
  }
  await effects.sweepCheckouts?.();
  const orphans = await effects.stopOrphanedProcesses?.() ?? [];
  tallyLeftovers(state, 'processes', orphans.length);
  if (orphans.length) await note(cycle, `orphans:${state.cycle}`, 'reclaim', null, 'done', `Stopped ${orphans.join(', ')}: still running against a removed worktree`);
  const trials = await effects.stopOrphanTrials?.() ?? [];
  tallyLeftovers(state, 'trialContainers', trials.length);
  if (trials.length) await note(cycle, `trial-orphans:${state.cycle}`, 'reclaim', null, 'done', `Stopped ${trials.join(', ')}: a trial container whose checkout is gone or that outlived twice the trial deadline`);
  const leftovers = await effects.reclaimJobLeftovers?.() ?? [];
  tallyLeftovers(state, 'reclaimed', leftovers.length);
  if (leftovers.length) await note(cycle, `job-leftovers:${state.cycle}`, 'reclaim', null, 'done', `Removed ${leftovers.join(', ')}: left behind by jobs that have ended`);
  // GY-3122: with ended worktrees and settled checkouts gone, the volumes are measured against the floor.
  await diskHeadroomStep(cycle);
}

/**
 * The attempt bound (GY-2961): an attempt is a progress bound. Each cycle the loop reads the
 * attempt's worktree and records on the session handle what changed there — a new commit or
 * changed files — so the bound extends while the attempt progresses and every reader sees the
 * same progress: the server's renewal refusal counts it, master status names the remaining time,
 * and the launch brief states the stop it names. An attempt still progressing is stopped only at
 * its ceiling; one with neither a commit nor a changed file for the progress window past its
 * bound is stopped here: the pane closes, the uncommitted rest is kept for the successor (the
 * handoff a lapsed lease gets), and the capacity record releases the lease. True when the attempt
 * was ended here, so the stall step leaves it alone.
 */
async function attemptBoundStep(cycle: Cycle, item: Work, session: NonNullable<Work['sessions']>[number]): Promise<boolean> {
  const { config, effects, clock } = cycle;
  if (session.kind !== 'implementation' || !effects.endAttemptBound) return false;
  const epoch = session.epoch ?? Number(/:(\d+)$/.exec(session.id)?.[1]);
  const lease = item.lease;
  if (!lease || lease.owner !== session.principal || lease.epoch !== epoch || Date.parse(lease.expiresAt) <= clock) return false;
  const claimedAt = attemptClaimedAt(item, epoch);
  if (!claimedAt || !Number.isFinite(Date.parse(claimedAt))) return false;
  // The worktree reading, recorded when it changed: the progress the bound extends by, on the item
  // for every reader. A write that fails is next cycle's reading again.
  const space = item.workspaces?.find(entry => entry.epoch === epoch && entry.host === config.hostId);
  const reading = space ? await Promise.resolve(effects.worktreeState?.(space)).catch(() => null) ?? null : null;
  const changed = !!reading && (!session.workTree || session.workTree.head !== reading.head || session.workTree.dirty !== reading.dirty);
  if (reading && changed) {
    try {
      // The write names no epoch: a session write under the live lease is the holder's alone (engine.ts), and the handle's id already carries it.
      await effects.recordSession?.(item, { id: session.id, kind: session.kind, principal: session.principal, runtime: session.runtime, host: session.host, subject: session.subject, state: 'running',
        workTree: { ...reading, at: new Date(clock).toISOString() } });
      // The stall check below uses this snapshot too; progress in this cycle counts immediately.
      session.updatedAt = new Date(clock).toISOString();
    } catch { /* the reading stands for the next cycle */ }
  }
  const age = clock - Date.parse(claimedAt), bound = attemptBoundMs(config.run), ceiling = attemptCeilingMs(config.run);
  if (age < bound) return false;
  // Progress recorded this very cycle counts: the snapshot's handle may still be a cycle behind.
  if (age < ceiling && (changed || attemptProgressFresh(item, epoch, session.principal, claimedAt, clock))) return false;
  const why = age >= ceiling
    ? `it ran past the ${boundMinutes(ceiling)} ceiling with no submission, however steadily it progressed`
    : `it made no commit and no file change for ${boundMinutes(attemptProgressWindowMs)} past the ${boundMinutes(bound)} bound`;
  const key = `close:${item.id}:${session.id}`;
  try {
    if (session.pane) await Promise.resolve(effects.closeSession(session.pane)).catch(error => { if (!paneAlreadyGone(error)) throw error; });
    const kept = await effects.endAttemptBound(item, session, why);
    await effects.recordSession?.(item, { id: session.id, kind: session.kind, principal: session.principal, runtime: session.runtime, host: session.host, subject: session.subject, state: 'finished',
      outcome: `stopped by the attempt bound: ${why}`.slice(0, 500) });
    await note(cycle, key, 'close', item.key, 'done', `Ended ${session.id}${session.pane ? ` (pane ${session.pane})` : ''}: the attempt ${why}${kept?.state === 'committed' && kept.commit ? `; its uncommitted work is kept as ${kept.commit.slice(0, 12)}` : kept?.state === 'discarded' ? `; its uncommitted work could not be kept (${kept.detail ?? 'no detail'})` : ', and its worktree is as the attempt left it'}`, session.principal);
  }
  catch (error) { await note(cycle, key, 'close', item.key, 'failed', `Could not end ${session.id} at its attempt bound: ${message(error)}`, session.principal); }
  return true;
}

/** The cursor key of the standing checkout-trust attention line (GY-3225). */
export const checkoutTrustKey = 'checkout-trust';
/**
 * GY-3225: the roles whose every launch in this host's checkout the folder-trust step would
 * refuse — the checkout carries repository Claude configuration and the named accounts' configs do
 * not trust it, so the launch would stop at Claude Code's folder-trust dialog and the trust step
 * refuses it first (harness.ts trustClaudeFolder). One standing attention line names the accounts
 * and both remedies, and the roles' launches are held for the cycle — no relaunch, so no pane
 * opened per retry — until the check answers empty: the operator's trust record or the role's
 * arguments changed, and the launches go ahead again on their own.
 */
async function untrustedCheckoutRoles(cycle: Cycle): Promise<ReadonlySet<string>> {
  const { state, effects, clock } = cycle;
  const refusals = await Promise.resolve(effects.checkoutTrust?.()).catch(() => []);
  cycle.checkoutTrustRefused = new Set((refusals ?? []).map(entry => entry.role));
  if (!cycle.checkoutTrustRefused.size) {
    if (state.actions[checkoutTrustKey]) { delete state.actions[checkoutTrustKey]; await effects.persist(state); }
    return cycle.checkoutTrustRefused;
  }
  if (state.actions[checkoutTrustKey]?.state === 'failed') touchStanding(state, checkoutTrustKey, new Date(clock).toISOString());
  else await record(state, checkoutTrustKey, { kind: 'attention', work: null, principal: null, state: 'failed', detail: checkoutTrustLine(refusals!), attempts: 1, cycle: state.cycle }, cycle.now(), effects.persist);
  return cycle.checkoutTrustRefused;
}

/**
 * Dispatch: fill the pipeline from backlog (GY-2991), then each claimable item to a free worker
 * profile, each head nothing can carry forward back to a worker, the reviewer and producer
 * sessions the dispatcher owes, and the master session when absent.
 */
async function dispatchStep(cycle: Cycle) {
  const { config, state, effects, snapshot, clock, herdr, credentials, launcher } = cycle;
  if (effects.release) await releaseBacklog(cycle);
  advanceFailureRuns(state, snapshot.work, accountNames(config.workers));
  const open = snapshot.work.filter(item => item.stage !== 'done' && (item.owner ?? null) === (config.forPerson ?? null));
  const health = profileHealth(config.workers, credentials, herdr.agents, state, clock, snapshot.work);
  const taken = cycle.reservedProfiles;
  const hot = new Set(hotspots(open, clock).map(entry => entry.file));
  const claimable = dispatchSort(open.filter(item => { try { assertDispatchable(item, snapshot.work, snapshot.now); return true; } catch { return false; } }), hot, clock);
  const launched: Work[] = [];
  const registry = !state.diskHeadroom && effects.registry ? await effects.registry().catch(() => null) : null;
  let offers = registry ? await runtimeCanaries(cycle, registry.runtimes) : [];
  // GY-3149: a freed worker slot goes to the highest-priority waiting item. An item whose launch last waited
  // for a slot holds every lower-priority item back, and a launch waits for the higher-priority launches
  // of this cycle to settle before it asks the registry for a slot.
  const waiting = claimable.filter(item => state.actions[dispatchKey(item)]?.state === 'waiting').map(item => item.priority);
  const slotHeldAbove = waiting.length ? Math.min(...waiting) : Infinity;
  const ahead: { key: string; priority: number; done: Promise<void> }[] = [];
  // GY-3225: an untrusted checkout carrying repository Claude configuration holds the roles it
  // names for the cycle, with one standing attention line (untrustedCheckoutRoles).
  const refusedRoles = await untrustedCheckoutRoles(cycle);
  // GY-3122: below the disk floor no new worker starts; master status names the shortage.
  if (!state.diskHeadroom && !refusedRoles.has('worker')) for (const item of claimable) {
    // Two claimable items sharing an exclusive resource: the first goes, the other waits for it to land.
    if (launched.some(other => sharedResources(item, other).length)) continue;
    // GY-3104: a third equal failure holds the item for the master's decision.
    if (failureHeld(state.failureRuns[item.id])) continue;
    const incident = state.actions[earlyExitKey(item)];
    if (incident?.state === 'failed' && incident.attempts >= actionStallThreshold && clock - Date.parse(incident.at) < actionStallDelay(incident.attempts)) continue;
    const key = dispatchKey(item);
    if (launcher.busy(key) || state.actions[key]?.state === 'done') continue;
    if (item.priority > slotHeldAbove) continue;
    const free = health.find(entry => entry.healthy && !taken.has(entry.profile.name));
    if (!free) break;
    // GY-3103: a runtime whose launches of this item failed backs off for this item only; its accounts are excluded from the selection.
    const held = backedOffAccounts(state, registry, free.profile, item, clock);
    if (held.all) continue;
    taken.add(free.profile.name);
    // Each newer runtime version is offered to one launch at a time, the canary; the rest stay pinned.
    const canaries = offers;
    offers = [];
    for (const offer of canaries) state.canaries[offer.runtime] = { entry: offer.entry, version: offer.version, work: item.key, epoch: null, startedAt: new Date(clock).toISOString(), failed: null };
    const before = ahead.filter(entry => entry.priority < item.priority);
    let settled!: () => void;
    ahead.push({ key, priority: item.priority, done: new Promise<void>(resolve => { settled = resolve; }) });
    launcher.submit(key, [free.profile.name], async sink => {
      try {
        await Promise.all(before.map(entry => entry.done));
        if (before.some(entry => state.actions[entry.key]?.state === 'waiting')) return;
        await launchWorker(cycle, item, key, free.profile, sink, canaries, held.exclude);
      } finally { settled(); }
    });
    launched.push(item);
  }
  if (effects.rework) for (const item of open) {
    const rework = neededRework(item);
    if (!rework) continue;
    const key = reworkKey(item, rework.binding);
    if (state.actions[key]?.state === 'done') continue;
    try { await effects.rework(item, rework.reason, rework.binding); await note(cycle, key, 'judgement', item.key, 'done', `Returned ${item.key} to a worker: ${rework.reason}`); }
    catch (error) { await note(cycle, key, 'judgement', item.key, 'failed', `Could not return ${item.key} to a worker: ${message(error)}`); }
  }
  if (effects.askHumanProof) for (const item of open) for (const proof of dueHumanProofs(item)) {
    const key = `human-proof:${item.id}:${proof}:${item.candidate!.sha}:${item.policyRevision}`;
    if (state.actions[key]?.state === 'done') continue;
    try { await effects.askHumanProof(item, proof); await note(cycle, key, 'judgement', item.key, 'done', `Asked a person for ${proof} on ${item.candidate!.sha.slice(0, 12)}`); }
    catch (error) { await note(cycle, key, 'judgement', item.key, 'failed', `Could not ask a person for ${proof} on ${item.key}: ${message(error)}`); }
  }
  await effects.dispatchTick?.(snapshot);
  await masterSession(cycle, open);
}

/**
 * The loop keeps the pipeline full itself (GY-2991): while fewer items occupy it — claimed,
 * submitted, in review or merge, or released and not yet done — than its concurrency (one slot per
 * configured worker profile), it releases the backlog item with the highest priority, oldest first
 * on ties, whose dependencies are all done, recording the release decision under the loop's own
 * identity with the reason. A parked item — any standing blocker — never releases, nor an
 * owner-held or loop-owned item, whose release the control plane refuses, nor one sharing an
 * exclusive resource with an item in flight or released (`resourceConflicts`). Items the master wants
 * held are parked, not left in backlog, so backlog means "work this next"; `master release` stays
 * for an out-of-order pull. Each release takes its response's document, so the same cycle's
 * dispatch offers the item.
 */
async function releaseBacklog(cycle: Cycle) {
  const { config, effects, snapshot, clock } = cycle;
  let slots = config.workers.length - snapshot.work.filter(item => item.stage !== 'done' && (item.ready || inFlight(item, clock))).length;
  const identity = config.operatorAgent ? { id: config.operatorAgent.id, role: 'operator-agent' as const } : undefined;
  const candidates = snapshot.work
    .filter(item => item.criteria.length > 0 && item.stage !== 'done' && !item.ready && !item.blocker && !loopOwnedRefusal(item) && !ownerHoldRefusal(item, identity)
      && item.dependencies.every(dep => snapshot.work.find(entry => entry.id === dep)?.stage === 'done'))
    .sort((a, b) => Number(!!b.yardRepair) - Number(!!a.yardRepair) || a.priority - b.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const item of candidates) {
    // A yard repair (GY-3102) is released past the pipeline cap.
    if (slots <= 0 && !item.yardRepair) continue;
    // An item sharing an exclusive resource (a file path included) with one in flight or released waits until that one lands.
    if (resourceConflicts(item, snapshot.work, clock).length || snapshot.work.some(other => other.id !== item.id && other.stage !== 'done' && other.ready && sharedResources(item, other).length)) continue;
    const key = `release:${item.id}:${item.revision}`, inPipeline = snapshot.work.filter(entry => entry.stage !== 'done' && (entry.ready || inFlight(entry, clock))).length;
    try {
      const overCap = !!item.yardRepair && slots <= 0;
      const reason = overCap
        ? `${item.key} is a yard repair, so the loop releases it past the pipeline cap: ${inPipeline} item(s) in flight of concurrency ${config.workers.length} and every dependency of ${item.key} is done`
        : `The loop keeps the pipeline full: ${inPipeline} item(s) in flight of concurrency ${config.workers.length}, every dependency of ${item.key} is done, and backlog means work this next`;
      const released = await effects.release!(item, reason) as Work | undefined;
      const index = snapshot.work.findIndex(entry => entry.id === item.id);
      if (index >= 0 && released && typeof released === 'object' && 'ready' in released) snapshot.work[index] = released;
      if (!item.yardRepair) slots -= 1;
      await note(cycle, key, 'judgement', item.key, 'done', overCap
        ? `Released yard repair ${item.key} past the pipeline cap: ${inPipeline} item(s) in flight of concurrency ${config.workers.length} and every dependency is done`
        : `Released ${item.key} to keep the pipeline full: ${inPipeline} item(s) in flight of concurrency ${config.workers.length} and every dependency is done`, config.operatorAgent?.id ?? null);
    }
    catch (error) { await note(cycle, key, 'judgement', item.key, 'failed', `Could not release ${item.key} from backlog: ${message(error)}`, config.operatorAgent?.id ?? null); }
  }
}

/** One worker launch on the launcher: the claim is the worker's own, under its profile's principal. */
async function launchWorker(cycle: Cycle, item: Work, key: string, profile: WorkerProfile, sink: DaemonAction[], canaries: CanaryOffer[] = [], exclude: string[] = []) {
  let runtime: string | null = null;
  const { config, state, effects, snapshot, herdr, now } = cycle;
  // An offer this launch did not take is free for the next one.
  const settle = async (canary: { runtime: string; failed: string | null } | null | undefined, epoch: number | undefined, startedAt: string | null | undefined) => {
    for (const offer of canaries) {
      const claimed = state.canaries[offer.runtime];
      if (claimed?.work !== item.key || claimed.epoch !== null) continue;
      if (canary?.runtime !== offer.runtime) delete state.canaries[offer.runtime];
      else if (canary.failed) await failCanary(cycle, offer.runtime, `${item.key}: ${canary.failed}`);
      else state.canaries[offer.runtime] = { ...claimed, epoch: epoch ?? item.epoch + 1, startedAt: startedAt ?? new Date(now()).toISOString() };
    }
  };
  const attempts = (state.actions[key]?.attempts ?? 0) + 1;
  const entry = (outcome: DaemonAction['state'], detail: string) => record(state, key, { kind: 'dispatch', work: item.key, principal: profile.principal, epoch: item.epoch, state: outcome, detail, attempts, cycle: state.cycle }, now(), effects.persist);
  await entry('started', `Dispatching ${item.key} to ${profile.name}`);
  try {
    // Every run the dispatch starts is recorded on the item as it starts, a handed-off or failed one with how it ended (GY-3259).
    const onRun = async (run: WorkerRun) => effects.recordSession?.(item, workerRunHandle(item, profile, config.hostId, run));
    const launched = await effects.dispatch(item, profile, herdr.agents, snapshot, { diagnosis: diagnosisSection(state.failureRuns[item.id]), canaries, exclude, onRuntime: kind => { runtime = kind; }, onRun }) as { run?: string; epoch?: number; runtime?: string | null; initialHead?: string | null; runtimeStartedAt?: string | null; canary?: { runtime: string; failed: string | null } | null } | undefined;
    await settle(launched?.canary, launched?.epoch, launched?.runtimeStartedAt);
    // The session's handle is what the close step reads to end it once its attempt does: the run's, with when it started and from which commit.
    if (launched?.run && launched.epoch) await effects.recordSession?.(item, { ...workerRunHandle(item, profile, config.hostId, { epoch: launched.epoch, run: launched.run, runtime: launched.runtime ?? profile.kind ?? profile.mode, account: null, outcome: null }),
      ...(launched.runtimeStartedAt ? { runtimeStartedAt: launched.runtimeStartedAt } : {}), ...(launched.initialHead ? { initialHead: launched.initialHead } : {}) })?.catch(() => undefined);
    sink.push(await entry('done', `Dispatched ${item.key} to ${profile.name}; the worker launcher claimed under ${profile.principal}`));
  } catch (error) {
    await settle(null, undefined, undefined);
    const full = capacityRefusal(error);
    if (full) {
      sink.push(await entry('waiting', `Dispatch of ${item.key} waits for a worker slot, retried on the first cycle one frees: ${full}`));
      return;
    }
    if (error instanceof WorkerSandboxError) {
      sink.push(await entry('done', `Blocked ${item.key} until its sandbox is repaired: ${message(error)}`));
      return;
    }
    recordLaunchFailure(state, runtime, item, message(error), now());
    // A worker run that exited at once is the item's launch incident, as an early exit after its start is (GY-3104, worker-launch-health.ts).
    if (error instanceof HeadlessWorkerExit) {
      const previous = state.actions[earlyExitKey(item)];
      await record(state, earlyExitKey(item), { kind: 'dispatch', work: item.key, principal: profile.principal, epoch: error.epoch, state: 'failed', detail: `${item.key} epoch ${error.epoch}: ${error.message}`.slice(0, 500),
        attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    }
    sink.push(await entry('failed', `Dispatch of ${item.key} to ${profile.name} failed: ${message(error)}; it is retried next cycle`));
  }
}

/**
 * GY-3103: runtime canaries. Each cycle, every registry runtime whose launch PATH is led by a
 * versioned install (GY-3090) is compared with the newest version installed beside it. A newer one
 * is offered to exactly one worker launch while the fleet keeps launching on the pinned version.
 * A canary that submits, commits or runs longer than 60 s after its start switches the runtime by
 * a registry runtime.set with the reason; one that fails keeps the pinned version, is not retried
 * until a newer version appears, and wakes the master with its error.
 */
async function runtimeCanaries(cycle: Cycle, runtimes: AgentRegistry['runtimes']): Promise<CanaryOffer[]> {
  const { state, effects, snapshot, clock } = cycle;
  const offers: CanaryOffer[] = [];
  for (const runtime of runtimes) {
    const offer = canaryOffer(runtime), canary = state.canaries[runtime.name];
    if (!offer || canary?.entry !== offer.entry || (canary.epoch === null && clock - Date.parse(canary.startedAt ?? '') > 1_800_000)) {
      delete state.canaries[runtime.name];
      if (offer) offers.push(offer);
      continue;
    }
    if (canary.failed || canary.epoch === null) continue;
    const item = snapshot.work.find(entry => entry.key === canary.work);
    if (!item) { delete state.canaries[runtime.name]; continue; }
    const verdict = canaryVerdict(item, canary.epoch, clock);
    if (!verdict) continue;
    if (!verdict.passed) {
      const incident = state.actions[earlyExitKey(item)];
      await failCanary(cycle, runtime.name, incident?.epoch === canary.epoch ? incident.detail : `${item.key} epoch ${canary.epoch}: ${verdict.why}`);
      continue;
    }
    const reason = `Canary ${item.key} epoch ${canary.epoch} on ${runtime.name} ${canary.version} ${verdict.why}; ${runtime.name} now launches from ${canary.entry} instead of ${pinnedInstall(runtime)?.entry}`.slice(0, 500);
    try {
      await effects.setRuntime!(repinRuntime(runtime, canary.entry), reason);
      delete state.canaries[runtime.name];
      await note(cycle, `runtime-canary:${runtime.name}`, 'judgement', item.key, 'done', reason);
    } catch (error) { await note(cycle, `runtime-canary:${runtime.name}`, 'judgement', item.key, 'failed', `Could not switch ${runtime.name} to ${canary.version} after its canary passed: ${message(error)}`); }
  }
  return offers;
}
/** A failed canary keeps its runtime pinned and wakes the master with the error (masterCauses). */
async function failCanary(cycle: Cycle, runtime: string, error: string) {
  const canary = cycle.state.canaries[runtime];
  if (!canary) return;
  canary.failed = error.slice(0, 500);
  await note(cycle, `runtime-canary:${runtime}`, 'judgement', canary.work, 'failed', `The canary of ${runtime} ${canary.version} failed, so ${runtime} stays on its pinned version: ${error}`);
}

/** The loop's master: launched when absent, adopted when visible, woken once per changed shared-base cause.
 *  A pane that has stopped on its provider's usage or session limit is not a working master (GY-2949): the
 *  loop judges the pane's recent output with the same limit-notice reader workers use, holds the account
 *  until the notice's reset, closes the pane, and launches the role's next account in the same cycle — so a
 *  spent account cannot leave the master, and the blockers only it decides, idle for the rest of the window. */
async function masterSession(cycle: Cycle, open: Work[]) {
  const { config, state, effects, herdr } = cycle;
  const sessions = effects.masterSession;
  if (!sessions || !herdr.available) return;
  const causes = [...masterCauses(open, state.actions, state.failureRuns), ...(await sessions.pendingCauses?.(open) ?? [])];
  const current = new Set(causes.map(cause => cause.key));
  // A retrial temporarily replaces its refusal with an intent. Keep the same base's wake
  // while it runs, otherwise an unchanged failure would wake again after every retrial.
  for (const item of open) if (item.mergeLedger?.state === 'intent' && item.mergeLedger.head === item.candidate?.sha && item.mergeLedger.baseTip)
    current.add(`base:${item.mergeLedger.baseTip}`);
  for (const key of Object.keys(state.master.subjects)) if (!current.has(key)) delete state.master.subjects[key];
  const master = state.master;
  const handle = herdr.agents.find(agent => agent.name === (master.agentName ?? config.masterAgentName));
  const recoveryKey = config.forPerson ? `master:continuity:${config.forPerson}` : 'master:continuity';
  let recoveryFailed = false;
  let recoveryError: string | undefined;
  if ((!master.continuity && sessions.initialize && (handle || master.startedAt || master.account)) || (!handle && master.continuity)) {
    try {
      if (master.continuity) await captureConversation(master.continuity.current);
      else master.continuity = await sessions.initialize!(master, handle, Object.values(state.actions).filter(action => action.kind === 'wake' && action.state === 'done').map(action => action.detail));
      if (state.actions[recoveryKey]?.state === 'failed') await note(cycle, recoveryKey, 'session', null, 'done', 'Master continuity recovery succeeded');
      await effects.persist(state);
    } catch (error) {
      recoveryFailed = true;
      recoveryError = message(error);
      const detail = `Master continuity recovery failed; retrying next cycle and retaining its state: ${message(error)}`;
      if (state.actions[recoveryKey]?.detail !== detail) await note(cycle, recoveryKey, 'session', null, 'failed', detail);
      else touchStanding(state, recoveryKey, new Date(cycle.now()).toISOString());
    }
  }
  if (!handle) {
    await closeMigratedMasterPane(cycle);
    submitMasterLaunch(cycle, open, recoveryError);
    return;
  }
  if (!master.agentName) state.master = { ...master, agentName: handle.name ?? config.masterAgentName, pane: handle.pane_id ?? null, startedAt: cycle.snapshot.now, adopted: true };
  if (handle.pane_id) state.master.pane = handle.pane_id;
  if (!state.master.startedAt) state.master.startedAt = cycle.snapshot.now;
  if (!recoveryFailed && await masterPaneFailover(cycle, handle, open)) return;
  const changed = causes.filter(cause => !cause.quiet && state.master.subjects[cause.key] !== cause.digest);
  const target = handle.pane_id ?? state.master.pane ?? handle.name;
  const since = Date.parse(state.master.lastWake?.at ?? state.master.startedAt ?? cycle.snapshot.now);
  const heartbeat = !changed.length && open.length > 0 && cycle.now() - since >= (config.run.masterHeartbeatMinutes ?? 30) * 60_000;
  if ((!changed.length && !heartbeat) || !target || !sessions.wake) return;
  const prompt = changed.length ? masterCausePrompt(changed) : `Graphyard coordinator heartbeat: open in-scope work remains. Continue from node ${config.cliPath} master status, diagnose stalled work and advance typed agent actions with every gate intact. Act without asking for routine human approval.`;
  const key = config.forPerson ? `master:wake:${config.forPerson}` : 'master:wake';
  cycle.launcher.submit(key, [], async sink => {
    try {
      await sessions.wake!(target, prompt, state.master.continuity);
      for (const cause of changed) state.master.subjects[cause.key] = cause.digest;
      state.master.lastWake = { at: new Date(cycle.now()).toISOString(), causes: changed.map(cause => cause.key).slice(0, 20), heartbeat };
      sink.push(await record(state, key, { kind: 'wake', work: null, principal: null, state: 'done', detail: prompt, attempts: 1, cycle: state.cycle }, cycle.now(), effects.persist));
    } catch (error) { sink.push(await record(state, key, { kind: 'wake', work: null, principal: null, state: 'failed', detail: `Could not wake the master: ${message(error)}`, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, cycle.now(), effects.persist)); }
  });
}

/**
 * GY-3237: a master pane the Herdr migration left behind. While an install still records a private
 * instance, the pane the loop last launched may sit in the workspace that instance served — moved
 * away from, invisible to the current inventory, and unable to reach the main Herdr its
 * confinement never granted. It is closed through that instance once, so the private server
 * drains, its records are dropped, and the launch this cycle relaunches the master into the main
 * workspace with a confinement that reaches it. A pane in the current workspace, or one no
 * recorded instance can answer for, is left to the ordinary absent-pane path.
 */
async function closeMigratedMasterPane(cycle: Cycle) {
  const { config, state, effects } = cycle;
  const sessions = effects.masterSession;
  const pane = state.master.pane;
  const workspace = pane ? herdrWorkspaceOf(pane) : null;
  if (!sessions?.closeMigratedPane || !config.herdrInstance || !pane || !workspace || workspace === config.herdrWorkspace) return;
  const key = config.forPerson ? `master:migrate-pane:${config.forPerson}:${pane}` : `master:migrate-pane:${pane}`;
  if (cycle.state.actions[key]?.state === 'done') return;
  try {
    await sessions.closeMigratedPane(pane, config.herdrInstance);
  } catch (error) {
    if (!paneAlreadyGone(error)) {
      await note(cycle, key, 'failover', null, 'failed', `Could not close the master pane ${pane} the Herdr migration left in workspace ${workspace}: ${message(error)}`);
      return;
    }
  }
  state.master = { ...state.master, pane: null };
  await note(cycle, key, 'failover', null, 'done', `Closed the master pane ${pane} the Herdr migration left in workspace ${workspace}; the private server can drain and the master relaunches into workspace ${config.herdrWorkspace} with a confinement that reaches it`);
}

/**
 * Before a launch, every live master-role registry session of this host (and person) is ended, not
 * only the one the loop's state names (GY-3091): Herdr lists no master pane, so none of them runs.
 * A session the state does not name is spared inside its launch grace, since its pane may still be
 * starting. A failed end throws, so the launch records a failed action and the next cycle retries.
 */
async function endPreviousMasterSessions(cycle: Cycle, closedPane: string | null) {
  const { state, config, effects } = cycle;
  const sessions = effects.masterSession!;
  if (!sessions.end) return;
  const recorded = state.master.session;
  const live = sessions.live ? (await sessions.live()).filter(session => session.id === recorded || cycle.now() - Date.parse(session.selectedAt) >= launchGraceMs).map(session => session.id)
    : recorded ? [recorded] : [];
  const agent = state.master.agentName ?? config.masterAgentName, pane = closedPane ?? state.master.pane;
  for (const id of live) {
    const reason = id === recorded && pane ? `the master session's pane ${pane} is absent from Herdr's inventory; the loop launches its replacement`
      : `no pane in Herdr's inventory runs the master agent ${agent}${pane ? ` (the loop's last master pane ${pane} is absent)` : ''}; the loop launches its replacement`;
    try { await sessions.end(id, reason); }
    catch (error) { throw new Error(`Could not end the previous master registry session ${id} (${reason}): ${message(error)}`); }
  }
}

/** The launch the absent or failed-over master session owes, handed to the launcher so a slow pane creation never stalls the cycle. The registry session the previous pane ran under is ended first, so the role's one slot frees for this launch. */
function submitMasterLaunch(cycle: Cycle, open: Work[], recoveryError?: string, closedPane: string | null = null) {
  const { config, state, effects, launcher } = cycle;
  const sessions = effects.masterSession!;
  const launchKey = config.forPerson ? `${masterLaunchKey}:${config.forPerson}` : masterLaunchKey;
  // GY-3225: a checkout the folder-trust check refuses holds the master session's launch — one
  // standing attention line (untrustedCheckoutRoles) instead of a pane per refused retry.
  if (cycle.checkoutTrustRefused?.has('master')) return;
  if (launcher.busy(launchKey)) return;
  launcher.submit(launchKey, [], async sink => {
    try {
      await endPreviousMasterSessions(cycle, closedPane);
      const causes = [...masterCauses(open, state.actions, state.failureRuns), ...(await sessions.pendingCauses?.(open) ?? [])];
      const { recoveryFailures, ...oldMaster } = state.master;
      const failures = recoveryError ? [...recoveryFailures, { at: new Date(cycle.now()).toISOString(), error: recoveryError, master: oldMaster }] : recoveryFailures;
      const previous = recoveryError ? null : state.master.continuity;
      const recoveryHandoff = recoveryError ? `Previous native history is unreadable and has NOT been recovered. Recovery error: ${recoveryError}. Its history and original session provenance are retained in master.recoveryFailures; retry recovery from those references when readable. Continue current authoritative work without waiting for human approval.` : '';
      const launched = await sessions.launch([masterHandover({ work: open, cliPath: config.cliPath }), ...(recoveryError ? [recoveryHandoff] : []), ...(causes.some(cause => !cause.quiet) ? [masterCausePrompt(causes.filter(cause => !cause.quiet))] : [])].join('\n'), previous);
      const at = new Date(cycle.now()).toISOString();
      state.master = { ...emptyMasterSession(), ...launched, continuity: launched.continuity ?? previous, recoveryFailures: failures, startedAt: at,
        subjects: Object.fromEntries(causes.map(cause => [cause.key, cause.digest])),
        lastWake: causes.length ? { at, causes: causes.map(cause => cause.key).slice(0, 20), heartbeat: false } : null };
      sink.push(await record(state, launchKey, { kind: 'session', work: null, principal: null, state: 'done', detail: `Launched the master session ${launched.agentName} in pane ${launched.pane}`, attempts: 1, cycle: state.cycle }, cycle.now(), effects.persist));
    } catch (error) {
      sink.push(await record(state, launchKey, { kind: 'session', work: null, principal: null, state: 'failed', detail: `The master session could not be launched; the next cycle tries again: ${message(error)}`, attempts: (state.actions[launchKey]?.attempts ?? 0) + 1, cycle: state.cycle }, cycle.now(), effects.persist));
    }
  });
}

/**
 * The pane judged for a stop its runtime already named (GY-2949): a provider limit notice holds the
 * session's account until the notice's reset (the effect workers' notices ride), and a pane whose
 * runtime exited names itself; either is treated as absent — the pane closes, and the role's next
 * account launches the master in the same cycle. A pane with ordinary output is adopted as today.
 */
async function masterPaneFailover(cycle: Cycle, handle: RuntimeSession, open: Work[]) {
  const { state, effects, clock } = cycle;
  const sessions = effects.masterSession!;
  const master = state.master;
  if (cycle.launcher.busy(cycle.config.forPerson ? `${masterLaunchKey}:${cycle.config.forPerson}` : masterLaunchKey)) return;
  const exited = endedRuntimeStates.includes(handle.agent_status ?? '');
  let notice: ExhaustionSignal | null = null;
  const pane = handle.pane_id ?? master.pane ?? null;
  if (pane) {
    const screen = await Promise.resolve(effects.sessionScreen?.({ pane, agentName: master.agentName })).catch(() => null) ?? null;
    if (screen !== null) notice = detectRuntimeExhaustion(screen, master.runtime, clock);
  }
  // A pane Herdr reports as a bare shell (no agent) is gone once seen on two consecutive cycles.
  const bare = handle.agent === null && !exited;
  master.misses = bare ? master.misses + 1 : 0;
  if (!notice && !exited && !(bare && master.misses >= 2)) return;
  const reason = notice ? `its pane showed its provider's limit notice: ${notice.reason}` : bare ? 'its pane held a bare shell with no agent on two consecutive cycles, so the session is gone' : `its pane's runtime reports ${handle.agent_status}, so the session is gone`;
  const key = cycle.config.forPerson ? `master:failover:${cycle.config.forPerson}` : 'master:failover';
  try {
    if (notice && master.account && sessions.exhaust) await sessions.exhaust(master.account, notice);
    if (handle.pane_id) await Promise.resolve(effects.closeSession(handle.pane_id)).catch(error => { if (!paneAlreadyGone(error)) throw error; });
    state.master = { ...master, agentName: null, pane: null, runtime: null, adopted: false, rotations: master.rotations + 1, misses: 0,
      lastEnd: { cause: notice ? 'exhausted' : 'exited', at: new Date(clock).toISOString(), detail: reason.slice(0, 500) },
      limitedUntil: notice?.resetsAt ?? null };
    await note(cycle, key, 'failover', null, 'done', `The master session ${master.agentName} is treated as absent (${reason}); the account it spent is held until its reset, and the master launches on the role's next account`);
  } catch (error) { await note(cycle, key, 'failover', null, 'failed', `Could not fail the master session over: ${message(error)}`); return true; }
  submitMasterLaunch(cycle, open, undefined, pane);
  return true;
}
