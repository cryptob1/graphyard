// Concern: one coordination cycle — snapshot, close, dispatch, merge writer, persist, in that order.
import type { Work } from '../model.js';
import type { MasterConfig, WorkerProfile, HerdrAgent } from '../master.js';
import { assertDispatchable } from '../master.js';
import type { ExhaustionSignal } from '../model/capacity.js';
import { endedRuntimeStates } from '../model/sessions.js';
import { detectRuntimeExhaustion } from '../master/runtime-prompt.js';
import { dispatchSort } from '../coordination.js';
import type { CoordinationRounds } from '../server/work-view.js';
import { masterHandover } from '../master/master-session.js';
import { paneAlreadyGone } from '../request-settlement.js';
import { cycleMetricsSchema, emptyMasterSession, type DaemonAction, type DaemonActionKind, type DaemonState, message, pruneDaemonState } from './state.js';
import { dispatchKey, reconcilePendingActions } from './reconcile.js';
import { neededRework, reworkKey } from './rework.js';
import { hotspots } from './hotspots.js';
import { settledPurpose } from '../model/session-state.js';
import { profileHealth, clearProfileFailure, recordProfileFailure } from './sessions.js';
import { type DaemonEffects, record } from './effects.js';
import { mergeWriterStep } from './cycle-merge-writer.js';
import { syncProjectMemory } from '../project-memory.js';

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
  herdr: { agents: HerdrAgent[]; available: boolean };
  credentials: Awaited<ReturnType<DaemonEffects['credentials']>>;
  performed: DaemonAction[]; launcher: Launcher;
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
    const [snapshot, herdr] = await Promise.all([effects.snapshot(), Promise.resolve(effects.herdr ? effects.herdr() : effects.agents()).then(read => Array.isArray(read) ? { agents: read, available: true } : read)]);
    return { snapshot, herdr, credentials: await effects.credentials(config.workers) };
  }))!;
  const observed = Date.parse(read.snapshot.now), clock = Number.isFinite(observed) ? observed : now();
  const performed: DaemonAction[] = launches.drain();
  // A launch still in flight settles its own `started` entry; any other one is a restart's leftover, reconciled against the snapshot.
  const inFlight = launches.keys().flatMap(key => state.actions[key]?.state === 'started' ? [[key, state.actions[key]] as const] : []);
  for (const [key] of inFlight) delete state.actions[key];
  performed.push(...reconcilePendingActions(state, read.snapshot.work, clock));
  for (const [key, action] of inFlight) state.actions[key] = action;
  const cycle: Cycle = { config, state, effects, now, ...read, clock, performed, launcher: launches };

  await step('close', () => closeStep(cycle));
  await step('dispatch', () => dispatchStep(cycle));
  await step('merge writer', () => mergeWriterStep(cycle));
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
  for (const item of snapshot.work) for (const session of item.sessions ?? []) {
    if (session.state !== 'running' || session.host !== config.hostId) continue;
    const reason = sessionEnded(item, session, clock);
    if (reason) {
      const key = `close:${item.id}:${session.id}`;
      try {
        if (session.pane) await Promise.resolve(effects.closeSession(session.pane)).catch(error => { if (!paneAlreadyGone(error)) throw error; });
        await effects.recordSession?.(item, { id: session.id, kind: session.kind, principal: session.principal, runtime: session.runtime, host: session.host, subject: session.subject, state: 'finished', outcome: `closed by the loop: ${reason}`.slice(0, 500) });
        await note(cycle, key, 'close', item.key, 'done', `Closed ${session.id}${session.pane ? ` (pane ${session.pane})` : ''}: ${reason}`, session.principal);
      } catch (error) { await note(cycle, key, 'close', item.key, 'failed', `Could not close ${session.id}: ${message(error)}`, session.principal); }
      continue;
    }
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
  await effects.sweepCheckouts?.();
}

/**
 * A worker session whose Herdr status is idle with no recorded activity for the inactivity window is
 * re-prompted once with its own work; one still idle a whole window after that re-prompt is ended by
 * the close step (GY-2943): the pane closes, the attempt ends as stalled with its lease released and
 * the item dispatchable again, instead of idling under a live lease. A session that showed activity
 * after its re-prompt began a new quiet spell, and is re-prompted once again. The pane's screen is
 * judged against the session runtime's provider limit notices: one found goes on the attempt's end,
 * so the account it spent is held for the fleet's next selection (GY-2943 AC-1).
 */
async function stallStep(cycle: Cycle, item: Work, session: NonNullable<Work['sessions']>[number]) {
  const { config, state, effects, clock, herdr } = cycle;
  if (!effects.endStall || !effects.promptSession || session.kind !== 'implementation') return;
  const agent = herdr.agents.find(candidate => (session.pane && candidate.pane_id === session.pane) || (!!session.agentName && candidate.name === session.agentName));
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
 * Dispatch: each claimable item to a free worker profile, each head nothing can carry forward back
 * to a worker, the reviewer and producer sessions the dispatcher owes, and the master session when absent.
 */
async function dispatchStep(cycle: Cycle) {
  const { config, state, effects, snapshot, clock, herdr, credentials, launcher } = cycle;
  const open = snapshot.work.filter(item => item.stage !== 'done');
  const health = profileHealth(config.workers, credentials, herdr.agents, state, clock, snapshot.work);
  const taken = launcher.held();
  const hot = new Set(hotspots(open, clock).map(entry => entry.file));
  const claimable = dispatchSort(open.filter(item => { try { assertDispatchable(item, snapshot.work, snapshot.now); return true; } catch { return false; } }), hot, clock);
  for (const item of claimable) {
    const key = dispatchKey(item);
    if (launcher.busy(key) || (state.actions[key] && state.actions[key].state !== 'failed')) continue;
    const free = health.find(entry => entry.healthy && !taken.has(entry.profile.name));
    if (!free) break;
    taken.add(free.profile.name);
    launcher.submit(key, [free.profile.name], sink => launchWorker(cycle, item, key, free.profile, sink));
  }
  if (effects.rework) for (const item of open) {
    const rework = neededRework(item);
    if (!rework) continue;
    const key = reworkKey(item, rework.binding);
    if (state.actions[key]?.state === 'done') continue;
    try { await effects.rework(item, rework.reason, rework.binding); await note(cycle, key, 'judgement', item.key, 'done', `Returned ${item.key} to a worker: ${rework.reason}`); }
    catch (error) { await note(cycle, key, 'judgement', item.key, 'failed', `Could not return ${item.key} to a worker: ${message(error)}`); }
  }
  await effects.dispatchTick?.(snapshot);
  await masterSession(cycle, open);
}

/** One worker launch on the launcher: the claim is the worker's own, under its profile's principal. */
async function launchWorker(cycle: Cycle, item: Work, key: string, profile: WorkerProfile, sink: DaemonAction[]) {
  const { config, state, effects, snapshot, herdr, now } = cycle;
  const attempts = (state.actions[key]?.attempts ?? 0) + 1;
  const entry = (outcome: DaemonAction['state'], detail: string) => record(state, key, { kind: 'dispatch', work: item.key, principal: profile.principal, epoch: item.epoch, state: outcome, detail, attempts, cycle: state.cycle }, now(), effects.persist);
  await entry('started', `Dispatching ${item.key} to ${profile.name}`);
  try {
    const launched = await effects.dispatch(item, profile, herdr.agents, snapshot) as { pane?: string | null; epoch?: number } | undefined;
    // The session's handle is what the close step reads to end it once its attempt does.
    const pane = launched?.pane ?? null, attach = pane ? `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}` : null;
    await effects.recordSession?.(item, { id: `${profile.principal}:${launched?.epoch ?? item.epoch + 1}`, kind: 'implementation', principal: profile.principal, runtime: profile.kind ?? profile.mode, host: config.hostId,
      ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}), ...(pane && attach ? { pane, attach } : {}), subject: `${item.key}: ${item.title}`.slice(0, 300), state: 'running' })?.catch(() => undefined);
    clearProfileFailure(state, profile);
    sink.push(await entry('done', `Dispatched ${item.key} to ${profile.name}; the worker launcher claimed under ${profile.principal}`));
  } catch (error) {
    recordProfileFailure(state, profile, message(error), now());
    sink.push(await entry('failed', `Dispatch of ${item.key} to ${profile.name} failed: ${message(error)}; it is retried next cycle`));
  }
}

/** The loop's own master session: launched when Herdr shows none, adopted when it does; the cycle never prompts it.
 *  A pane that has stopped on its provider's usage or session limit is not a working master (GY-2949): the
 *  loop judges the pane's recent output with the same limit-notice reader workers use, holds the account
 *  until the notice's reset, closes the pane, and launches the role's next account in the same cycle — so a
 *  spent account cannot leave the master, and the blockers only it decides, idle for the rest of the window. */
async function masterSession(cycle: Cycle, open: Work[]) {
  const { config, state, effects, herdr } = cycle;
  const sessions = effects.masterSession;
  if (!sessions || !herdr.available) return;
  const master = state.master;
  const handle = herdr.agents.find(agent => agent.name === (master.agentName ?? config.masterAgentName));
  if (!handle) {
    submitMasterLaunch(cycle, open);
    return;
  }
  if (!master.agentName) state.master = { ...emptyMasterSession(), agentName: handle.name ?? config.masterAgentName, pane: handle.pane_id ?? null, startedAt: cycle.snapshot.now, adopted: true };
  await masterPaneFailover(cycle, handle, open);
}

/** The launch the absent or failed-over master session owes, handed to the launcher so a slow pane creation never stalls the cycle. The registry session the previous pane ran under is ended first, so the role's one slot frees for this launch. */
function submitMasterLaunch(cycle: Cycle, open: Work[]) {
  const { config, state, effects, launcher } = cycle;
  const sessions = effects.masterSession!;
  if (launcher.busy(masterLaunchKey)) return;
  launcher.submit(masterLaunchKey, [], async sink => {
    try {
      if (state.master.session && sessions.end) await sessions.end(state.master.session, 'the master session it recorded is gone from Herdr; the loop launches its replacement').catch(() => undefined);
      const launched = await sessions.launch(masterHandover({ work: open, cliPath: config.cliPath }));
      state.master = { ...emptyMasterSession(), ...launched, startedAt: new Date(cycle.now()).toISOString() };
      sink.push(await record(state, masterLaunchKey, { kind: 'session', work: null, principal: null, state: 'done', detail: `Launched the master session ${launched.agentName} in pane ${launched.pane}`, attempts: 1, cycle: state.cycle }, cycle.now(), effects.persist));
    } catch (error) {
      sink.push(await record(state, masterLaunchKey, { kind: 'session', work: null, principal: null, state: 'failed', detail: `The master session could not be launched; the next cycle tries again: ${message(error)}`, attempts: (state.actions[masterLaunchKey]?.attempts ?? 0) + 1, cycle: state.cycle }, cycle.now(), effects.persist));
    }
  });
}

/**
 * The pane judged for a stop its runtime already named (GY-2949): a provider limit notice holds the
 * session's account until the notice's reset (the effect workers' notices ride), and a pane whose
 * runtime exited names itself; either is treated as absent — the pane closes, and the role's next
 * account launches the master in the same cycle. A pane with ordinary output is adopted as today.
 */
async function masterPaneFailover(cycle: Cycle, handle: HerdrAgent, open: Work[]) {
  const { state, effects, clock } = cycle;
  const sessions = effects.masterSession!;
  const master = state.master;
  if (cycle.launcher.busy(masterLaunchKey)) return;
  const exited = endedRuntimeStates.includes(handle.agent_status ?? '');
  let notice: ExhaustionSignal | null = null;
  if (!exited) {
    const pane = master.pane ?? handle.pane_id ?? null;
    if (!pane) return;
    const screen = await Promise.resolve(effects.sessionScreen?.({ pane, agentName: master.agentName })).catch(() => null) ?? null;
    if (screen === null) return;
    notice = detectRuntimeExhaustion(screen, master.runtime, clock);
    if (!notice) return;
  }
  const reason = notice ? `its pane showed its provider's limit notice: ${notice.reason}` : `its pane's runtime reports ${handle.agent_status}, so the session is gone`;
  const key = 'master:failover';
  try {
    if (notice && master.account && sessions.exhaust) await sessions.exhaust(master.account, notice);
    if (handle.pane_id) await Promise.resolve(effects.closeSession(handle.pane_id)).catch(error => { if (!paneAlreadyGone(error)) throw error; });
    state.master = { ...master, agentName: null, pane: null, runtime: null, adopted: false, rotations: master.rotations + 1,
      lastEnd: { cause: notice ? 'exhausted' : 'exited', at: new Date(clock).toISOString(), detail: reason.slice(0, 500) },
      limitedUntil: notice?.resetsAt ?? null };
    await note(cycle, key, 'failover', null, 'done', `The master session ${master.agentName} is treated as absent (${reason}); the account it spent is held until its reset, and the master launches on the role's next account`);
  } catch (error) { await note(cycle, key, 'failover', null, 'failed', `Could not fail the master session over: ${message(error)}`); return; }
  submitMasterLaunch(cycle, open);
}
