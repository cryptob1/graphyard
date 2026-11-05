import type { RuntimeSession } from '../model/sessions.js';
import { sessionAgents } from '../session-inventory.js';
// Concern: one coordination cycle — snapshot, close, dispatch, merge writer, persist, in that order.
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { dataDirectory } from '../install/worktree-root.js';
import { sessionName } from '../session-name.js';
import type { Work } from '../model.js';
import type { MasterConfig, WorkerProfile } from '../master/profiles.js';
import { assertDispatchable } from '../master/dispatch.js';
import type { ExhaustionSignal } from '../model/capacity.js';
import { endedRuntimeStates } from '../model/sessions.js';
import { detectRuntimeExhaustion, classifyRuntimePrompt } from '../master/runtime-prompt.js';
import { dispatchSort, inFlight, resourceConflicts, sharedResources } from '../coordination.js';
import { capacityRefusal } from '../fleet.js';
import { needsSpecCheck, specCheckCurrent, specCheckLaunchLive } from '../model/spec-check.js';
import { cliUnreachableRefusal } from '../reviewer.js';
import type { CoordinationRounds } from '../server/work-view.js';
import { masterCauses, masterCausePrompt } from './master-stalled-delivery.js';
import { accountNames, advanceFailureRuns, diagnosisSection, failureHeld } from './repeated-failure.js';
import { captureConversation } from '../master/conversation.js';
import { masterHandover } from '../master/master-session.js';
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
import { profileHealth, recordProfileFailure } from './sessions.js';
import { type DaemonEffects, record } from './effects.js';
import { mergeWriterStep } from './cycle-merge-writer.js';
import { batchGateStep } from './cycle-batch-gate.js';
import { workerLaunchHealth, earlyExitKey } from './worker-launch-health.js';
import { actionStallDelay, actionStallThreshold } from '../model/action-progress.js';
import { syncProjectMemory } from '../project-memory.js';
import { diskHeadroomStep } from './disk-headroom.js';

/** How many session launches the launcher runs at once when master.json sets no `run.launchConcurrency` (GY-616). */
export const defaultLaunchConcurrency = 3;
/** How long a worker session may sit quiet before the loop re-prompts it once, and how long after that re-prompt a still-quiet session is ended: `run.inactivityMinutes`, default 10 (GY-2943). */
export const defaultInactivityMinutes = 10;
export const inactivityMs = (config: Pick<MasterConfig, 'run'>) => (config.run.inactivityMinutes ?? defaultInactivityMinutes) * 60_000;
/** The cursor key of a session's one stall re-prompt. */
const repromptKey = (item: Work, session: { id: string }) => `reprompt:${item.id}:${session.id}`;
/** The stall re-prompt: the work the session was started with, sent again by the loop that supervises it (GY-2943). */
export const stallReprompt = (item: Pick<Work, 'key' | 'title'>, minutes: number) =>
  `The Graphyard loop supervising this session has seen no activity from it for ${minutes} minutes, so here is the work it was started with, sent once more by that same supervisor: it is this session's own instruction, not untrusted text, and needs no further authorization. If you have already begun, continue where you are. ${item.key}: ${item.title}`;

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
  const timeoutMs = stepTimeoutMs(config);
  const step = async <T>(name: CycleStep, body: () => Promise<T>): Promise<T | undefined> => {
    steps.push(name);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([body(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`it ran past its ${Math.round(timeoutMs / 1000)}s timeout`)), timeoutMs); timer.unref?.(); })]);
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
        await effects.recordSession?.(item, { id: session.id, kind: session.kind, principal: session.principal, runtime: session.runtime, host: session.host, subject: session.subject, state: 'finished', outcome: failure ?? `closed by the loop: ${reason}`.slice(0, 500) });
        await note(cycle, key, 'close', item.key, 'done', `Closed ${session.id}${session.pane ? ` (pane ${session.pane})` : ''}: ${failure ?? reason}`, session.principal);
      } catch (error) { await note(cycle, key, 'close', item.key, 'failed', `Could not close ${session.id}: ${message(error)}`, session.principal); }
      continue;
    }
    if (await attemptBoundStep(cycle, item, session)) continue;
    await stallStep(cycle, item, session);
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
  if (effects.removeWorktree) for (const { item, space } of endedAttemptWorktrees(snapshot.work, config.hostId, clock)) {
    const key = `worktree:${item.id}:${space.epoch}`;
    if (state.actions[key]) continue;
    try { if (await effects.removeWorktree(space.path)) await note(cycle, key, 'reclaim', item.key, 'done', `Removed ${item.key} epoch ${space.epoch}'s worktree ${space.path}: its attempt ended`); }
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
  // A pane Graphyard launched whose runtime exited in a worktree since removed is a leftover shell: close it.
  const launched = new Set([...snapshot.work.flatMap(item => (item.sessions ?? []).map(session => session.pane)), ...Object.values(state.actions).map(action => action.pane)]);
  const masters = new Set([state.master, ...Object.values(state.personalMasters)].map(master => master.pane));
  const recoveredItems = new Set<string>();
  if (cycle.herdr.available) for (const agent of cycle.herdr.agents) {
    const cwd = (agent.cwd ?? '').replace(/ \(deleted\)$/, '');
    if (!agent.pane_id || masters.has(agent.pane_id) || (agent.agent && !endedRuntimeStates.includes(agent.agent_status ?? ''))) continue;
    const managedRoots = [resolve(dataDirectory(), 'worktrees'), ...(config.run.worktreeRoot ? [resolve(config.run.worktreeRoot)] : [])];
    const managed = managedRoots.some(root => cwd.startsWith(root + sep));
    if ((!cwd.includes('/.graphyard/worktrees/') && !managed) || existsSync(cwd)) continue;
    // Finished sessions disappear from coordination, and old launch actions are pruned.
    // Read only the leftover's item, once per cycle; never fetch the fleet's full history.
    if (!launched.has(agent.pane_id) && effects.sessionHistory) {
      const key = [...cwd.matchAll(/(?:^|[/-])(GY-\d+)(?=[/-]|$)/gi)].at(-1)?.[1].toUpperCase();
      const item = snapshot.work.find(work => work.key === key || work.workspaces?.some(space => space.path === cwd));
      if (item && !recoveredItems.has(item.id)) {
        for (const session of await effects.sessionHistory(item)) launched.add(session.pane);
        recoveredItems.add(item.id);
      }
    }
    if (!launched.has(agent.pane_id)) continue;
    try { await Promise.resolve(effects.closeSession(agent.pane_id)).catch(error => { if (!paneAlreadyGone(error)) throw error; }); await note(cycle, `pane:${agent.pane_id}`, 'close', null, 'done', `Closed pane ${agent.pane_id}: its runtime exited and its worktree ${cwd} is removed`); }
    catch (error) { await note(cycle, `pane:${agent.pane_id}`, 'close', null, 'failed', `Could not close pane ${agent.pane_id}: ${message(error)}`); }
  }
  await effects.sweepCheckouts?.();
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

/**
 * A worker session whose Herdr status is idle with no recorded activity for the inactivity window is
 * re-prompted once with its own work; one still idle a whole window after that re-prompt is ended by
 * the close step (GY-2943): the pane closes, the attempt ends as stalled with its lease released and
 * the item dispatchable again, instead of idling under a live lease. A session that showed activity
 * after its re-prompt began a new quiet spell, and is re-prompted once again. The pane's screen is
 * judged against the session runtime's provider limit notices: one found goes on the attempt's end,
 * so the account it spent is held for the fleet's next selection (GY-2943 AC-1). A session that has
 * stopped, whose pane already carries a recognised limit notice, ends at once on it — no window is
 * waited (GY-2962).
 *
 * A session Herdr reports `blocked` is not idle but stopped on its runtime's own prompt (GY-2959):
 * the loop reads it off the pane, answers it once with the reject key — the decline that leaves the
 * worker inside its worktree — and one still blocked a whole window after that answer ends as
 * stalled naming the prompt. One that unblocked after the key is left alone, and answers a new
 * prompt with a fresh key.
 */
async function stallStep(cycle: Cycle, item: Work, session: NonNullable<Work['sessions']>[number]) {
  const { config, state, effects, clock, herdr } = cycle;
  if (!herdr.available || !effects.endStall || !effects.promptSession || session.kind !== 'implementation') return;
  const agent = herdr.agents.find(candidate => (session.pane && candidate.pane_id === session.pane) || (!!session.agentName && candidate.name === session.agentName));
  const reject = `reject:${item.id}:${session.id}`;
  if (agent?.agent_status === 'blocked') return blockedPromptStep(cycle, item, session, reject, effects.endStall);
  // The prompt the last key answered is gone, so a new one gets its own answer.
  delete state.actions[reject];
  // GY-2962: a session that has stopped, whose pane's last lines carry a recognised provider limit
  // notice, ends at once — the notice is its provider saying the account is spent, so no inactivity
  // window is waited: the pane closes, the attempt ends on the notice with the account held for its
  // reset, and the item dispatches again. One still working is left to the windows below.
  if (agent?.agent_status !== 'working') {
    const screen = session.pane || session.agentName ? await Promise.resolve(effects.sessionScreen?.(session)).catch(() => null) ?? null : null;
    const notice = screen !== null ? detectRuntimeExhaustion(screen, session.runtime, clock) : null;
    if (notice) {
      const key2 = `close:${item.id}:${session.id}`;
      try {
        if (session.pane) await Promise.resolve(effects.closeSession(session.pane)).catch(error => { if (!paneAlreadyGone(error)) throw error; });
        await effects.endStall(item, session, { reason: 'the session stopped', notice });
        await effects.recordSession?.(item, { id: session.id, kind: session.kind, principal: session.principal, runtime: session.runtime, host: session.host, subject: session.subject, state: 'finished',
          outcome: `the session stopped on its provider's limit notice: ${notice.reason}`.slice(0, 500) });
        await note(cycle, key2, 'close', item.key, 'done', `Ended ${session.id}${session.pane ? ` (pane ${session.pane})` : ''}: stopped on its provider's limit notice, the account held until its reset (${notice.reason})`, session.principal);
      } catch (error) { await note(cycle, key2, 'close', item.key, 'failed', `Could not end ${session.id} on its limit notice: ${message(error)}`, session.principal); }
      return;
    }
  }
  if (agent?.agent_status !== 'idle' || !(clock - Date.parse(session.updatedAt) >= inactivityMs(config))) return;
  const key = repromptKey(item, session), quiet = Math.round(inactivityMs(config) / 60_000);
  const reprompted = state.actions[key]?.state === 'done' ? Date.parse(state.actions[key].at) : null;
  if (reprompted !== null && Date.parse(session.updatedAt) <= reprompted) {
    if (clock - reprompted < inactivityMs(config)) return;
    const key2 = `close:${item.id}:${session.id}`;
    try {
      const screen = session.pane || session.agentName ? await Promise.resolve(effects.sessionScreen?.(session)).catch(() => null) ?? null : null;
      const notice = screen !== null ? detectRuntimeExhaustion(screen, session.runtime, clock) : null;
      if (session.pane) await Promise.resolve(effects.closeSession(session.pane)).catch(error => { if (!paneAlreadyGone(error)) throw error; });
      await effects.endStall(item, session, { reason: 'stalled: no activity after the re-prompt', notice });
      await effects.recordSession?.(item, { id: session.id, kind: session.kind, principal: session.principal, runtime: session.runtime, host: session.host, subject: session.subject, state: 'finished',
        outcome: `stalled: no activity after the re-prompt${notice ? `; its provider's limit notice holds the account: ${notice.reason}` : ''}`.slice(0, 500) });
      await note(cycle, key2, 'close', item.key, 'done', `Ended ${session.id}${session.pane ? ` (pane ${session.pane})` : ''}: stalled: no activity after the re-prompt${notice ? `; its provider's limit notice holds the account (${notice.reason})` : ''}`, session.principal);
    } catch (error) { await note(cycle, key2, 'close', item.key, 'failed', `Could not end stalled ${session.id}: ${message(error)}`, session.principal); }
    return;
  }
  try {
    await effects.promptSession(session, stallReprompt(item, quiet));
    await note(cycle, key, 'wake', item.key, 'done', `Re-prompted quiet ${session.id} with its own work after ${quiet} minutes without activity`, session.principal);
  } catch (error) { await note(cycle, key, 'wake', item.key, 'failed', `Could not re-prompt quiet ${session.id}: ${message(error)}`, session.principal); }
}

/**
 * A session blocked on its runtime's own prompt (GY-2959): the loop reads it off the pane and
 * answers it once with the reject key — the decline that leaves the worker inside its worktree —
 * recording the answer, so the key is sent once per blocked episode and never twice. A session
 * still blocked a whole inactivity window after the answer ends as stalled naming the prompt: the
 * pane closes, the lease releases, and the item dispatches again (a provider limit notice on the
 * pane holds the account, as an idle stall's does). One whose screen shows nothing the loop can
 * answer still gets its window, anchored at the cycle the block was first seen.
 */
async function blockedPromptStep(cycle: Cycle, item: Work, session: NonNullable<Work['sessions']>[number], key: string, endStall: NonNullable<DaemonEffects['endStall']>) {
  const { config, state, effects, clock } = cycle;
  const answered = state.actions[key]?.state === 'done' ? Date.parse(state.actions[key].at) : null;
  if (answered !== null) {
    if (clock - answered < inactivityMs(config)) return;
    const key2 = `close:${item.id}:${session.id}`;
    try {
      const screen = await Promise.resolve(effects.sessionScreen?.(session)).catch(() => null) ?? null;
      const prompt = screen !== null ? classifyRuntimePrompt(screen, clock) : null;
      const notice = screen !== null ? detectRuntimeExhaustion(screen, session.runtime, clock) : null;
      const text = prompt?.text ?? 'the pane showed no prompt the loop could read';
      if (session.pane) await Promise.resolve(effects.closeSession(session.pane)).catch(error => { if (!paneAlreadyGone(error)) throw error; });
      await endStall(item, session, { reason: `stalled at a runtime prompt: ${text}`, notice });
      await effects.recordSession?.(item, { id: session.id, kind: session.kind, principal: session.principal, runtime: session.runtime, host: session.host, subject: session.subject, state: 'finished',
        outcome: `stalled at a runtime prompt: ${text}${notice ? `; its provider's limit notice holds the account: ${notice.reason}` : ''}`.slice(0, 500) });
      await note(cycle, key2, 'close', item.key, 'done', `Ended ${session.id}${session.pane ? ` (pane ${session.pane})` : ''}: stalled at a runtime prompt: ${text}`, session.principal);
    } catch (error) { await note(cycle, key2, 'close', item.key, 'failed', `Could not end ${session.id} stalled at its runtime prompt: ${message(error)}`, session.principal); }
    return;
  }
  try {
    const screen = await Promise.resolve(effects.sessionScreen?.(session)).catch(() => null) ?? null;
    const prompt = screen !== null ? classifyRuntimePrompt(screen, clock) : null;
    if (prompt?.keys?.length && effects.sessionKeys) await effects.sessionKeys(session, prompt.keys);
    await note(cycle, key, 'wake', item.key, 'done', prompt?.keys?.length
      ? `Answered ${session.id}'s runtime prompt with its reject key (${prompt.answer}): "${prompt.text}"`
      : `${session.id} is blocked on a runtime prompt the loop cannot answer ("${prompt?.text ?? 'none read off the pane'}"); one window before its attempt ends stalled`, session.principal);
  } catch (error) { await note(cycle, key, 'wake', item.key, 'failed', `Could not answer ${session.id}'s runtime prompt: ${message(error)}`, session.principal); }
}

/**
 * Dispatch: fill the pipeline from backlog (GY-2991), then each claimable item to a free worker
 * profile, each head nothing can carry forward back to a worker, the reviewer and producer
 * sessions the dispatcher owes, the spec check each released feature owes before any of that
 * (GY-2992), and the master session when absent.
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
  // GY-3122: below the disk floor no new worker starts; master status names the shortage.
  if (!state.diskHeadroom) for (const item of claimable) {
    // Two claimable items sharing an exclusive resource: the first goes, the other waits for it to land.
    if (launched.some(other => sharedResources(item, other).length)) continue;
    // GY-3104: a third equal failure holds the item for the master's decision.
    if (failureHeld(state.failureRuns[item.id])) continue;
    const incident = state.actions[earlyExitKey(item)];
    if (incident?.state === 'failed' && incident.attempts >= actionStallThreshold && clock - Date.parse(incident.at) < actionStallDelay(incident.attempts)) continue;
    const key = dispatchKey(item);
    if (launcher.busy(key) || state.actions[key]?.state === 'done') continue;
    const free = health.find(entry => entry.healthy && !taken.has(entry.profile.name));
    if (!free) break;
    taken.add(free.profile.name);
    launcher.submit(key, [free.profile.name], sink => launchWorker(cycle, item, key, free.profile, sink));
    launched.push(item);
  }
  // The spec check a released feature owes before dispatch (GY-2992): one fresh-context reviewer
  // session per owed check. The hold itself is assertDispatchable's; the launch runs while the item
  // is released and unblocked and no check stands and no launch is live on the item — one session
  // A launched checker's pane closes once a snapshot read after its launch shows no live launch on
  // the item — its report landed or its launch expired — or the item done; the pane then leaves
  // the record, so it closes once. The item is looked up across every owner's scope, as the
  // actions are shared by them all.
  // GY-2994: a checker that ended while its launch stands — its pane gone, or a BLOCKED: line on
  // it — posted no report; it closes too, its reason is recorded for master status, and the
  // launch below relaunches it this cycle rather than when the launch expires an hour on.
  for (const [key, action] of Object.entries(state.actions)) {
    if (!key.startsWith('spec-check:') || !action.pane) continue;
    const item = snapshot.work.find(entry => entry.key === action.work && entry.stage !== 'done');
    if (item && Date.parse(snapshot.now) < Date.parse(action.at)) continue;
    // A stale or pre-binding action closes only its own pane; it cannot end today's launch.
    const current = item && action.specCheckLaunch === item.specCheckLaunch?.id && !!action.specCheckLaunch;
    const ended = current && specCheckLaunchLive(item, clock) ? await specCheckEnded(cycle, action.pane) : null;
    if (current && specCheckLaunchLive(item, clock) && !ended) continue;
    try {
      await Promise.resolve(effects.closeSession(action.pane)).catch(error => { if (!paneAlreadyGone(error)) throw error; });
      if (ended) await record(state, specCheckEndedKey(item!), { kind: 'attention', work: item!.key, principal: null, state: 'failed', attempts: 1, cycle: state.cycle,
        detail: `${item!.key}'s spec-check session (${action.pane}) ended without a report: ${ended}; it is relaunched` }, cycle.now(), effects.persist);
      await record(state, key, { ...action, pane: undefined, at: undefined, detail: `Closed ${action.work}'s spec-check session (${action.pane}): ${ended ? `it ended without a report: ${ended}` : item ? 'its launch no longer stands' : 'the item is done'}` }, cycle.now(), effects.persist);
    } catch (error) { await note(cycle, `close:${key}`, 'close', action.work, 'failed', `Could not close ${action.work}'s spec-check session (${action.pane}): ${message(error)}`); }
  }
  // per check, and the report's arrival (or a launch that stands) ends the launching. The key names
  // the revision judged and the last launch, so a revision's re-check, or a relaunch after a
  // launch expired unreported, is a fresh action. One launch flies at a time: each reads Herdr and
  // the review ledger afresh, so the reviewer profile's concurrency bounds the checkers.
  if (effects.launchSpecCheck && !launcher.keys().some(key => key.startsWith('spec-check:'))) for (const item of open) {
    if (!item.ready || item.blocker) continue;
    if (item.lease && Date.parse(item.lease.expiresAt) > clock) continue;
    if (!needsSpecCheck(item) || specCheckCurrent(item) || (specCheckLaunchLive(item, clock) && !state.actions[specCheckEndedKey(item)])) continue;
    const key = `spec-check:${item.id}:${item.policyRevision}:${item.specCheckLaunch?.id ?? ''}`;
    // Only a launch that registered ends the launching: a started one a restart cut off before its
    // registration (resumed as indeterminate) launches again, since a launch registers before any session starts.
    if (launcher.busy(key) || state.actions[key]?.state === 'done') continue;
    // GY-2995: a launch whose sandbox could not reach the CLI its prompt names is refused before
    // any session starts; attention names it while the refusal stands, and no launch is retried
    // in a loop. The check runs each cycle, so a restored CLI launches again on its own.
    const cliRefusal = cliUnreachableRefusal(config);
    if (cliRefusal) {
      const refused = `spec-check-cli-refused:${item.id}`;
      if (state.actions[refused]?.state === 'failed') touchStanding(state, refused, new Date(clock).toISOString());
      else await record(state, refused, { kind: 'attention', work: item.key, principal: null, state: 'failed', attempts: 1, cycle: state.cycle, detail: `${item.key}'s spec check is not launched: ${cliRefusal}` }, cycle.now(), effects.persist);
      continue;
    }
    launcher.submit(key, [], sink => launchSpecChecker(cycle, item, key, sink));
    break;
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

/** The record of a spec-check launch whose session ended without a report (GY-2994): master status names it, and it frees the item for a relaunch. */
export const specCheckEndedKey = (item: { id: string; specCheckLaunch?: { id: string } | null }) => `spec-check-ended:${item.id}:${item.specCheckLaunch?.id ?? ''}`;

/** Why a checker's session ended without posting, or null while it runs: Herdr no longer reports its pane, or its pane shows a BLOCKED: line. */
async function specCheckEnded(cycle: Cycle, pane: string): Promise<string | null> {
  if (cycle.herdr.available && !cycle.herdr.agents.some(agent => agent.pane_id === pane)) return `Herdr no longer reports pane ${pane}`;
  const screen = await Promise.resolve(cycle.effects.sessionScreen?.({ pane, agentName: null })).catch(() => null) ?? '';
  const blocked = [...screen.matchAll(/^[\s⏺●•>*-]*(BLOCKED:\s*[^\s,].*)$/gm)].at(-1); // not the prompt's own "starting BLOCKED:, naming"
  return blocked ? blocked[1].trim().slice(0, 500) : null;
}

/** One spec check launch on the launcher (GY-2992): the effect starts the reviewer session and registers it on the item, so the next cycle launches no second. */
async function launchSpecChecker(cycle: Cycle, item: Work, key: string, sink: DaemonAction[]) {
  const { state, effects, now } = cycle;
  const attempts = (state.actions[key]?.attempts ?? 0) + 1;
  const entry = (outcome: DaemonAction['state'], detail: string, pane?: string | null, specCheckLaunch?: string) => record(state, key, { kind: 'review', work: item.key, principal: null, state: outcome, detail, attempts, cycle: state.cycle, ...(pane ? { pane, specCheckLaunch } : {}) }, now(), effects.persist);
  await entry('started', `Launching ${item.key}'s spec check`);
  try {
    const launched = await effects.launchSpecCheck!(item);
    sink.push(await entry('done', `Launched ${item.key}'s spec check: a fresh-context reviewer restates the item and names its gaps before a worker starts`, launched?.pane, launched?.launch));
    // A headless check that ended without an accepted report frees its item for a relaunch, as an ended pane does (GY-2994).
    if (launched?.settled) void launched.settled.then(failure => failure ? record(state, specCheckEndedKey({ id: item.id, specCheckLaunch: { id: launched.launch } }), { kind: 'attention', work: item.key, principal: null, state: 'failed', attempts: 1, cycle: state.cycle,
      detail: `${item.key}'s headless spec check ended without a report: ${failure}; it is relaunched` }, now(), effects.persist) : undefined).catch(() => {});
  } catch (error) {
    sink.push(await entry('failed', `Spec check launch of ${item.key} failed: ${message(error)}; it is retried next cycle`));
  }
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
  if (slots <= 0) return;
  const identity = config.operatorAgent ? { id: config.operatorAgent.id, role: 'operator-agent' as const } : undefined;
  const candidates = snapshot.work
    .filter(item => item.stage !== 'done' && !item.ready && !item.blocker && !loopOwnedRefusal(item) && !ownerHoldRefusal(item, identity)
      && item.dependencies.every(dep => snapshot.work.find(entry => entry.id === dep)?.stage === 'done'))
    .sort((a, b) => a.priority - b.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const item of candidates) {
    if (slots <= 0) break;
    // An item sharing an exclusive resource (a file path included) with one in flight or released waits until that one lands.
    if (resourceConflicts(item, snapshot.work, clock).length || snapshot.work.some(other => other.id !== item.id && other.stage !== 'done' && other.ready && sharedResources(item, other).length)) continue;
    const key = `release:${item.id}:${item.revision}`, inPipeline = snapshot.work.filter(entry => entry.stage !== 'done' && (entry.ready || inFlight(entry, clock))).length;
    try {
      const released = await effects.release!(item, `The loop keeps the pipeline full: ${inPipeline} item(s) in flight of concurrency ${config.workers.length}, every dependency of ${item.key} is done, and backlog means work this next`) as Work | undefined;
      const index = snapshot.work.findIndex(entry => entry.id === item.id);
      if (index >= 0 && released && typeof released === 'object' && 'ready' in released) snapshot.work[index] = released;
      slots -= 1;
      await note(cycle, key, 'judgement', item.key, 'done', `Released ${item.key} to keep the pipeline full: ${inPipeline} item(s) in flight of concurrency ${config.workers.length} and every dependency is done`, config.operatorAgent?.id ?? null);
    }
    catch (error) { await note(cycle, key, 'judgement', item.key, 'failed', `Could not release ${item.key} from backlog: ${message(error)}`, config.operatorAgent?.id ?? null); }
  }
}

/** One worker launch on the launcher: the claim is the worker's own, under its profile's principal. */
async function launchWorker(cycle: Cycle, item: Work, key: string, profile: WorkerProfile, sink: DaemonAction[]) {
  const { config, state, effects, snapshot, herdr, now } = cycle;
  const attempts = (state.actions[key]?.attempts ?? 0) + 1;
  const entry = (outcome: DaemonAction['state'], detail: string) => record(state, key, { kind: 'dispatch', work: item.key, principal: profile.principal, epoch: item.epoch, state: outcome, detail, attempts, cycle: state.cycle }, now(), effects.persist);
  await entry('started', `Dispatching ${item.key} to ${profile.name}`);
  try {
    const launched = await effects.dispatch(item, profile, herdr.agents, snapshot, { diagnosis: diagnosisSection(state.failureRuns[item.id]) }) as { pane?: string | null; epoch?: number; runtime?: string | null; initialHead?: string | null; runtimeStartedAt?: string | null } | undefined;
    // The session's handle is what the close step reads to end it once its attempt does.
    const pane = launched?.pane ?? null, attach = pane ? `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}` : null;
    await effects.recordSession?.(item, { id: `${profile.principal}:${launched?.epoch ?? item.epoch + 1}`, kind: 'implementation', principal: profile.principal, runtime: launched?.runtime ?? profile.kind ?? profile.mode, host: config.hostId,
      ...(launched?.runtimeStartedAt ? { runtimeStartedAt: launched.runtimeStartedAt } : {}),
      ...(launched?.initialHead ? { initialHead: launched.initialHead } : {}),
      ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}), ...(pane && attach ? { pane, attach } : {}), subject: `${item.key}: ${item.title}`.slice(0, 300), state: 'running' })?.catch(() => undefined);
    sink.push(await entry('done', `Dispatched ${item.key} to ${profile.name}; the worker launcher claimed under ${profile.principal}`));
  } catch (error) {
    const full = capacityRefusal(error);
    if (full) {
      sink.push(await entry('waiting', `Dispatch of ${item.key} waits for a worker slot, retried on the first cycle one frees: ${full}`));
      return;
    }
    recordProfileFailure(state, profile, message(error), now());
    sink.push(await entry('failed', `Dispatch of ${item.key} to ${profile.name} failed: ${message(error)}; it is retried next cycle`));
  }
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
  if (!notice && !exited) return;
  const reason = notice ? `its pane showed its provider's limit notice: ${notice.reason}` : `its pane's runtime reports ${handle.agent_status}, so the session is gone`;
  const key = cycle.config.forPerson ? `master:failover:${cycle.config.forPerson}` : 'master:failover';
  try {
    if (notice && master.account && sessions.exhaust) await sessions.exhaust(master.account, notice);
    if (handle.pane_id) await Promise.resolve(effects.closeSession(handle.pane_id)).catch(error => { if (!paneAlreadyGone(error)) throw error; });
    state.master = { ...master, agentName: null, pane: null, runtime: null, adopted: false, rotations: master.rotations + 1,
      lastEnd: { cause: notice ? 'exhausted' : 'exited', at: new Date(clock).toISOString(), detail: reason.slice(0, 500) },
      limitedUntil: notice?.resetsAt ?? null };
    await note(cycle, key, 'failover', null, 'done', `The master session ${master.agentName} is treated as absent (${reason}); the account it spent is held until its reset, and the master launches on the role's next account`);
  } catch (error) { await note(cycle, key, 'failover', null, 'failed', `Could not fail the master session over: ${message(error)}`); return true; }
  submitMasterLaunch(cycle, open, undefined, pane);
  return true;
}
