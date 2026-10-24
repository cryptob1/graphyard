// Concern: the long-running loop — cycle scheduling, config reload, the watchdog, and the restart onto a newly served commit.
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, rmSync } from 'node:fs';
import type { ConfigReload, MasterConfig } from '../master.js';
import { defaultChildRun } from '../child-runner.js';
import { carryUndeclared } from './state-cursor.js';
import { acquireDaemonLock, masterSummary, type DaemonAction, type DaemonState, message, storeAction } from './state.js';
import { boundedPersist, cycleFailureCeiling, describeFailingCall, loopLiveness, namedEffects, noteCycleFailure, noteCycleSuccess, noteUnhandled, watchdogPlan } from './liveness.js';
import type { DaemonEffects } from './effects.js';
import { Launcher, defaultLaunchConcurrency, runCycle } from './cycle.js';
import { awaitSupervisorRestart, detectLoopSupervisorUnit, restartEndedBySupervisorStop } from './loop-supervisor.js';
import { mergeWriterInFlight, mergeWriterSummary } from './cycle-merge-writer.js';
import { detachRuns } from '../runner/registry.js';
import { besideCursor } from './state-cursor.js';
import { deployRecordPath, readDeployRecord } from '../deploy-watch.js';
import { cliCommit } from '../protocol-version.js';
import { loopCodeRoot } from './checkout-state.js';

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
    mergeWriter: mergeWriterSummary(state.mergeWriter),
    release: state.release,
    profiles: state.profiles,
    config: state.config,
    master: masterSummary(state.master, now, masterAgent),
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
export function restartCause(config: Pick<MasterConfig, 'credentialFile' | 'cliPath'>, root: string, loaded: string | null, head = () => cliCommit(loopCodeRoot(config.cliPath, root))): string | null {
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
 * Supervised entry point. The process owns no lease and no credential beyond the coordinator token,
 * so a restart is always safe. A cycle that throws is recorded, logged and retried after a growing
 * delay; only a stop signal ends the loop. Between cycles, with no merge trial in flight, the loop
 * restarts through its unit when the deploy unit serves a commit it did not load.
 */
export async function runDaemon(config: MasterConfig, state: DaemonState, raw: DaemonEffects, options: { once?: boolean; intervalMs: number | (() => number); identity: { pid: number; host: string }; signals?: NodeJS.Signals[]; now?: () => number; log?: (line: string) => void;
  environment?: Record<string, string | undefined>;
  reload?: () => Promise<ConfigReload>;
  process?: Pick<NodeJS.Process, 'on' | 'off'>;
  /** The checkout whose deploy record names the serving commit; absent, the loop never restarts itself. */
  root?: string;
  restartLoop?: () => Promise<unknown>;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>; }) {
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
    const launcher = new Launcher(config.run.launchConcurrency ?? defaultLaunchConcurrency);
    try {
      while (!stopping) {
        let phase: 'reload' | 'cycle' = 'reload', wait = interval();
        try {
          if (options.reload) for (const action of await noteConfigReload(state, await options.reload().then(reload => { config = reload.config; return reload; }), effects.persist)) log(`[graphyard-master] ${action.kind} ${action.state}: ${action.detail}`);
          phase = 'cycle';
          const result = await runCycle(config, state, effects, now, launcher, log);
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
        }
        await notify('alive');
        // A restart would kill a merge trial in flight, so it waits for the trial to settle.
        const cause = options.root && !stopping && !mergeWriterInFlight(state) ? restartCause(config, options.root, state.release?.commit ?? null) : null;
        if (cause) {
          log(`[graphyard-master] restarting through the supervisor unit: ${cause}`);
          try { rmSync(loopRestartRequestPath(config), { force: true }); await (options.restartLoop ?? restartThroughUnit)(); }
          catch (error) { log(`[graphyard-master] the restart could not be asked: ${message(error)}`); }
        }
        if (options.once || stopping) break;
        try { await (options.delay ? options.delay(wait, waking.signal) : delay(wait, undefined, { signal: waking.signal })); } catch { /* woken to stop */ }
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

