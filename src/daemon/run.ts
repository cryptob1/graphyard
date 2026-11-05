// Concern: the long-running loop — cycle scheduling, config reload, the watchdog, and the restart onto a newly served commit.
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigReload } from '../master/config.js';
import type { MasterConfig } from '../master/profiles.js';
import { defaultChildRun } from '../child-runner.js';
import { carryUndeclared } from './state.js';
import { acquireDaemonLock, masterSummary, type DaemonAction, type DaemonState, message, storeAction } from './state.js';
import { boundedPersist, cycleFailureCeiling, describeFailingCall, loopLiveness, namedEffects, noteCycleFailure, noteCycleSuccess, noteUnhandled, watchdogPlan } from './liveness.js';
import type { DaemonEffects } from './effects.js';
import { Launcher, defaultLaunchConcurrency, runCycle } from './cycle.js';
import { awaitSupervisorRestart, detectLoopSupervisorUnit, restartEndedBySupervisorStop } from '../install/loop-unit.js';
import { cancelMergeWriterTrials, mergeWriterInFlight, mergeWriterSummary } from './cycle-merge-writer.js';
import { detachRuns } from '../runner/registry.js';
import { besideCursor } from './state.js';
import { deployRecordPath, readDeployRecord } from '../deploy-watch.js';
import { cliCommit } from '../protocol-version.js';
import { deployUnitOf } from '../install/units.js';
import { activeCliRoot } from '../install/cli-release.js';
import { loopCodeRoot } from './checkout-state.js';
import { noteControlPlane } from './compose-recovery.js';

/** The line the loop logs for each action a cycle took; the tests that pin a logged failure build it from here. */
export const actionLine = (cycle: number, action: Pick<DaemonAction, 'kind' | 'state' | 'detail'>) => `[graphyard-master] cycle ${cycle} ${action.kind} ${action.state}: ${action.detail}`;

/** The compact daemon view `master status` joins onto Graphyard truth. */
export function daemonSummary(state: DaemonState, now: number, intervalMs: number, hostId?: string, masterAgent?: { agent_status?: string }) {
  const lastCycleAt = state.lastCycleAt ? Date.parse(state.lastCycleAt) : Number.NaN;
  const lagMs = Number.isFinite(lastCycleAt) ? now - lastCycleAt : null;
  const recent = Object.entries(state.actions).map(([key, action]) => ({ key, ...action })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const liveness = loopLiveness(state, now, intervalMs, hostId);
  return {
    running: !!state.lock && lagMs !== null && (lagMs < Math.max(3 * intervalMs, 120_000) || liveness.state === 'running'),
    liveness, failures: state.failures,
    lock: state.lock, cycle: state.cycle, lastCycleAt: state.lastCycleAt, lagMs,
    actions: recent.slice(0, 40),
    metrics: state.metrics.at(-1) ?? null,
    mergeWriter: mergeWriterSummary(state.mergeWriter, now),
    release: state.release,
    launchBackoff: state.launchBackoff,
    canaries: state.canaries,
    config: state.config,
    master: masterSummary(state.master, now, masterAgent),
    controlPlane: state.controlPlane,
  };
}

/** Adopt a reloaded master.json into the running loop, or record why it was refused. */
export async function noteConfigReload(state: DaemonState, reload: ConfigReload, persist: DaemonEffects['persist']) {
  const previous = state.config;
  state.config = carryUndeclared(previous, { at: reload.at, changed: reload.changed.slice(0, 100), refused: reload.refused?.slice(0, 1000) ?? null });
  const noted: DaemonAction[] = [];
  if (reload.refused && previous?.refused !== state.config.refused) noted.push(storeAction(state, `config:refused:${reload.at}`, { kind: 'config', work: null, principal: null, state: 'failed', detail: state.config.refused!, attempts: 1, epoch: null, cycle: state.cycle, at: reload.at }));
  if (reload.workspace) noted.push(storeAction(state, `config:herdr-workspace:${reload.at}`, { kind: 'config', work: null, principal: null, state: 'done', detail: `Switched herdrWorkspace from ${reload.workspace.from} to ${reload.workspace.to}: ${reload.workspace.reason}`, attempts: 1, epoch: null, cycle: state.cycle, at: reload.at }));
  if (reload.changed.length) noted.push(storeAction(state, `config:${reload.at}`, { kind: 'config', work: null, principal: null, state: 'done', detail: `Adopted .graphyard/master.json changes without a restart: ${reload.changed.join(', ')}`, attempts: 1, epoch: null, cycle: state.cycle, at: reload.at }));
  if (noted.length || previous?.refused !== state.config.refused) await persist(state);
  return noted;
}

/** Take back the headless runs a restart left running (GY-453). */
export async function adoptHeadlessRuns(effects: DaemonEffects, log: (line: string) => void) {
  if (!effects.adoptRuns) return [];
  try {
    const adopted = await effects.adoptRuns();
    if (adopted.length) log(`[graphyard-master] adopted ${adopted.length} headless run(s): ${adopted.map(run => `${run.name} (${run.role} for ${run.work})`).join(', ')}`);
    return adopted;
  } catch (error) { log(`[graphyard-master] could not adopt the headless runs a restart left: ${message(error)}`); return []; }
}

/** The request a confined master files with `master restart`: the loop restarts through its unit once it reads it. */
export const loopRestartRequestPath = (config: Pick<MasterConfig, 'credentialFile'>) => besideCursor(config, 'loop-restart');

/**
 * Why the loop should restart now, or null: the deploy unit serves a commit other than the one this
 * process loaded and the checkout holds it, so a restart loads it; or a confined master filed a
 * restart request. `head` reads the commit the loop's code checkout holds. The record is the
 * control plane's own regardless of which repository it names (GY-2955): an install managing a
 * different repository still restarts its loop onto the revision the upgrade served.
 */
export function restartCause(config: Pick<MasterConfig, 'credentialFile' | 'cliPath'>, root: string, loaded: string | null, head = () => cliCommit(activeCliRoot(loopCodeRoot(config.cliPath, root)))): string | null {
  if (existsSync(loopRestartRequestPath(config))) return 'a master restart was requested';
  const serving = readDeployRecord(deployRecordPath(root))?.tip ?? null;
  return serving && loaded && serving !== loaded && head() === serving ? `the deploy unit serves ${serving.slice(0, 12)}, not ${loaded.slice(0, 12)} this loop loaded` : null;
}

/** `systemctl --user --no-block restart` of the unit this loop runs under, ended by the stop it causes. */
export async function restartThroughUnit() {
  const unit = detectLoopSupervisorUnit();
  if (!unit) throw new Error('this loop runs under no graphyard-master supervisor unit, so it cannot restart itself through one');
  try { await awaitSupervisorRestart(() => defaultChildRun('systemctl', ['--user', '--no-block', 'restart', unit])); }
  catch (error) { if (!restartEndedBySupervisorStop(error)) throw error; }
}

/**
 * GY-3148: how long a restart the deploy unit's served release owes may wait for the merge trials
 * in flight to settle on their own. Past the bound the loop cancels the trials (no head refused,
 * each stays queued) and restarts anyway, so a newly served release is adopted within minutes even
 * while merge trials run — with concurrent per-head trials the writer is otherwise never idle.
 */
export const releaseAdoptionBoundMs = 5 * 60_000;

/** What runs in the deploy unit (GY-3136): the commit its watch process loaded, and whether a deploy pass is in progress (any process besides the watch). */
export interface DeployUnitProcess { unit: string; commit: string | null; busy: boolean }

/**
 * Reads the deploy unit beside this loop's unit from its cgroup: each process's command line, the
 * watch's being `upgrade --watch`; the process running `<root>/src/cli.ts` loaded the commit `root`
 * holds. Any other process (git, npm, docker, install) is a deploy pass at work. Null outside systemd.
 */
export function readDeployUnitProcess(read: (file: string) => string = file => readFileSync(file, 'utf8'), commitOf: (root: string) => string | null = cliCommit): DeployUnitProcess | null {
  try {
    const own = read('/proc/self/cgroup').match(/^0::(\/.*\/)(graphyard-master[^/\s]*\.service)(?:\/.*)?$/m);
    if (!own) return null;
    const unit = deployUnitOf({ master: own[2] });
    let commit: string | null = null, busy = false;
    for (const pid of read(`/sys/fs/cgroup${own[1]}${unit}/cgroup.procs`).split('\n').filter(Boolean)) {
      let args: string[];
      try { args = read(`/proc/${pid}/cmdline`).split('\0'); } catch { continue; }
      if (!(args.includes('upgrade') && args.includes('--watch'))) { busy = true; continue; }
      const cli = args.find(arg => arg.endsWith('/src/cli.ts'));
      if (cli) commit = commitOf(dirname(dirname(cli)));
    }
    return { unit, commit, busy };
  } catch { return null; }
}

/**
 * Why the deploy unit should restart now, or null (GY-3136): its watch runs older code than the
 * commit it last served and no deploy pass is in progress, so a restart loads the served code —
 * the deploy-watch twin of restartCause. Once per served commit: `restarted` names the commits
 * already restarted for, so a unit that still runs old code after its restart is not restarted again.
 */
export function deployRestartCause(root: string, running: DeployUnitProcess | null, restarted: (serving: string) => boolean): { serving: string; reason: string } | null {
  const serving = readDeployRecord(deployRecordPath(root))?.tip ?? null;
  if (!serving || !running?.commit || running.busy || running.commit === serving || restarted(serving)) return null;
  return { serving, reason: `${running.unit} runs ${running.commit.slice(0, 12)}, older code than ${serving.slice(0, 12)} it serves` };
}

/**
 * Supervised entry point. The process owns no lease and no credential beyond the coordinator token,
 * so a restart is always safe. A cycle that throws is recorded, logged and retried after a growing
 * delay; only a stop signal ends the loop. Between cycles the loop restarts through its unit when
 * the deploy unit serves a commit it did not load: it waits for a merge trial in flight to settle,
 * but only within `releaseAdoptionBoundMs`, past which it cancels the trials and restarts anyway
 * (GY-3148); the next loop adopts those trials from their recorded ledger state.
 */
export async function runDaemon(config: MasterConfig, state: DaemonState, raw: DaemonEffects, options: { once?: boolean; intervalMs: number | (() => number); identity: { pid: number; host: string }; signals?: NodeJS.Signals[]; now?: () => number; log?: (line: string) => void;
  environment?: Record<string, string | undefined>;
  reload?: () => Promise<ConfigReload>;
  process?: Pick<NodeJS.Process, 'on' | 'off'>;
  /** The checkout whose deploy record names the serving commit; absent, the loop never restarts itself. */
  root?: string;
  restartLoop?: () => Promise<unknown>;
  /** Reads what runs in the deploy unit (GY-3136); defaults to its cgroup. */
  deployUnit?: () => DeployUnitProcess | null;
  restartDeploy?: (unit: string) => Promise<unknown>;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * The control plane's event ledger, newest first. Polled during the wait: an event another actor
   * wrote (a submission, a verdict, an unblock, a release) ends the wait, so the next stage starts
   * at once; a burst is one wake, and the interval stays the upper bound.
   */
  events?: { read: () => Promise<{ seq: string | number; actor: string }[]>; self: string; pollMs?: number }; }) {
  const now = options.now ?? Date.now, log = options.log ?? (line => console.error(line));
  const interval = () => typeof options.intervalMs === 'function' ? options.intervalMs() : options.intervalMs;
  const host = options.process ?? process;
  let stopping = false;
  const waking = new AbortController();
  const stop = () => { stopping = true; waking.abort(); };
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  for (const signal of signals) host.on(signal, stop);
  const unlisten = () => { for (const signal of signals) host.off(signal, stop); };
  try {
    const effects = boundedPersist(namedEffects(raw));
    acquireDaemonLock(state, options.identity, now(), interval());
    state.release = carryUndeclared(state.release, raw.loadedRelease ?? null);
    await effects.persist(state);
    const watchdog = watchdogPlan(options.environment ?? process.env, interval());
    if (watchdog.refusal) log(`[graphyard-master] ${watchdog.refusal}`);
    const notify = async (beat: 'ready' | 'alive') => { if (!watchdog.supervised) return; try { await effects.notify?.(beat); } catch (error) { log(`[graphyard-master] supervisor notification failed: ${message(error)}`); } };
    await notify('ready');
    await adoptHeadlessRuns(effects, log);
    const unhandled = (origin: 'unhandledRejection' | 'uncaughtException') => (error: unknown) => {
      const entry = noteUnhandled(state, error, origin, now());
      log(`[graphyard-master] ${origin} caught at the process level during cycle ${entry.cycle} (${state.failures.unhandled} so far); the loop keeps running: ${entry.reason}`);
      effects.persist(state).catch(() => {});
    };
    const onRejection = unhandled('unhandledRejection'), onException = unhandled('uncaughtException');
    host.on('unhandledRejection', onRejection); host.on('uncaughtException', onException);
    const cycles: { cycle: number; actions: number }[] = [], failed: { cycle: number; call: string | null; reason: string; delayMs: number }[] = [];
    const pause = (ms: number) => options.delay ? options.delay(ms, waking.signal) : delay(ms, undefined, { signal: waking.signal });
    let seen: number | null = null;
    // GY-3148: when the loop first saw the restart cause while merge trials were in flight; null while no wait is running.
    let restartWaitedFrom: number | null = null;
    // True when another actor wrote an event since the last read; the first read only sets the mark.
    const fresh = async () => {
      try {
        const rows = await options.events!.read(), newest = Math.max(0, ...rows.map(row => Number(row.seq)));
        const woke = seen !== null && rows.some(row => Number(row.seq) > seen! && row.actor !== options.events!.self);
        seen = Math.max(seen ?? 0, newest);
        return woke;
      } catch { return false; }
    };
    const sleep = async (ms: number) => {
      if (!options.events) return pause(ms);
      const end = Date.now() + ms;
      if (seen === null) await fresh();
      while (!stopping && Date.now() < end) {
        await pause(Math.min(end - Date.now(), options.events.pollMs ?? 2_000));
        if (!stopping && await fresh()) return;
      }
    };
    const launcher = new Launcher(config.run.launchConcurrency ?? defaultLaunchConcurrency);
    try {
      while (!stopping) {
        let phase: 'reload' | 'cycle' = 'reload', wait = interval();
        try {
          if (options.reload) for (const action of await noteConfigReload(state, await options.reload().then(reload => { config = reload.config; return reload; }), effects.persist)) log(`[graphyard-master] ${action.kind} ${action.state}: ${action.detail}`);
          phase = 'cycle';
          const result = await runCycle(config, state, effects, now, launcher, log);
          await noteControlPlane(state, null, now(), effects.composeServer, log);
          const recovered = noteCycleSuccess(state);
          if (recovered) await effects.persist(state);
          cycles.push({ cycle: result.metrics.cycle, actions: result.actions.length });
          for (const action of result.actions) log(actionLine(result.metrics.cycle, action));
          log(`[graphyard-master] cycle ${result.metrics.cycle} complete with ${result.metrics.open} open and ${result.actions.length} action(s)${recovered ? `; recovered after ${recovered} failed cycle(s)` : ''}`);
        } catch (error) {
          const failure = await noteCycleFailure(state, error, phase, { now: now(), intervalMs: interval(), ceilingMs: cycleFailureCeiling(watchdog.windowMs), persist: effects.persist });
          failed.push({ cycle: failure.cycle, call: failure.call, reason: failure.reason, delayMs: failure.delayMs });
          log(`[graphyard-master] cycle ${failure.cycle} failed in ${describeFailingCall(failure)}: ${failure.reason}; ${state.failures.consecutive} consecutive failure(s), the next cycle runs in ${Math.round(failure.delayMs / 1000)}s`);
          wait = failure.delayMs;
          await noteControlPlane(state, { ...failure, answered: typeof (error as { status?: unknown })?.status === 'number' }, now(), effects.composeServer, log);
          if (state.controlPlane) await effects.persist(state).catch(() => {});
        }
        await notify('alive');
        const deploy = options.root && !stopping ? (options.deployUnit ?? readDeployUnitProcess)() : null;
        const deployCause = deploy && deployRestartCause(options.root!, deploy, serving => state.actions[`deploy-unit-restart:${serving}`]?.state === 'done');
        if (deploy && deployCause) {
          const { serving, reason } = deployCause;
          log(`[graphyard-master] restarting ${deploy.unit}: ${reason}`);
          let detail = `Restarted ${deploy.unit} through systemd: ${reason}`, outcome: 'done' | 'failed' = 'done';
          try { await (options.restartDeploy ?? (unit => defaultChildRun('systemctl', ['--user', '--no-block', 'restart', unit])))(deploy.unit); }
          catch (error) { outcome = 'failed'; detail = `Could not restart ${deploy.unit} (${reason}): ${message(error)}`; log(`[graphyard-master] ${detail}`); }
          storeAction(state, `deploy-unit-restart:${serving}`, { kind: 'deployment', work: null, principal: null, state: outcome, detail: detail.slice(0, 1000), attempts: 1, epoch: null, cycle: state.cycle, at: new Date(now()).toISOString() });
          await effects.persist(state).catch(() => {});
        }
        // A restart would kill a merge trial in flight, so it waits for the trial to settle — but
        // only within `releaseAdoptionBoundMs` (GY-3148): with concurrent per-head trials the
        // writer is never idle, so a loop that waited forever ran old code beside the release the
        // deploy unit already serves. Past the bound the loop cancels its running trials — each
        // settles at once, no head refused — and restarts anyway; the next loop adopts those trials
        // from their recorded ledger state, as it already adopts the batch gate and headless runs.
        const cause = options.root && !stopping ? restartCause(config, options.root, state.release?.commit ?? null) : null;
        const trialsInFlight = mergeWriterInFlight(state);
        if (!cause || !trialsInFlight) restartWaitedFrom = null;
        if (cause && (!trialsInFlight || now() - (restartWaitedFrom ??= now()) >= releaseAdoptionBoundMs)) {
          const checkpointed = trialsInFlight ? cancelMergeWriterTrials(state, 'the loop restarts onto the release the deploy unit now serves') : [];
          log(`[graphyard-master] restarting through the supervisor unit${checkpointed.length ? `, checkpointing the merge trial(s) of ${checkpointed.join(', ')} that could not settle inside the bound` : ''}: ${cause}`);
          try { rmSync(loopRestartRequestPath(config), { force: true }); await (options.restartLoop ?? restartThroughUnit)(); }
          catch (error) { log(`[graphyard-master] the restart could not be asked: ${message(error)}`); }
        }
        if (options.once || stopping) break;
        try { await sleep(wait); } catch { /* woken to stop */ }
      }
    } finally {
      if (launcher.pending) log(`[graphyard-master] waiting for ${launcher.pending} launch(es) in flight before stopping`);
      await launcher.idle();
      for (const action of launcher.drain()) log(`[graphyard-master] launch ${action.kind} ${action.state}: ${action.detail}`);
      unlisten();
      host.off('unhandledRejection', onRejection); host.off('uncaughtException', onException);
      log(`[graphyard-master] stopping: left ${detachRuns()} headless run(s) running, detached, for the next loop to adopt`);
      state.lock = null;
      await effects.persist(state).catch(() => {});
    }
    return { cycles, failed, stopped: stopping };
  } catch (error) {
    unlisten();
    throw error;
  }
}

