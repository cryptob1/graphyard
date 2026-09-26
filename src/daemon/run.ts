// Concern: the long-running loop — cycle scheduling, config reload, the watchdog and its summary.
import { setTimeout as delay } from 'node:timers/promises';
import type { ConfigReload, MasterConfig } from '../master.js';
import { acquireDaemonLock, type DaemonAction, type DaemonState, message, storeAction } from './state.js';
import { faultClassPolicyFromEnv } from '../model/fault-classes.js';
import { faultRecurrenceReport } from './faults.js';
import { diagnosisReport } from './diagnosis.js';
import { latencyBudget, silenceReport } from './metrics.js';
import { boundedPersist, cycleCost, cycleTimes, cycleDelay, cycleFailureCeiling, describeFailingCall, loopLiveness, namedEffects, noteCycleFailure, noteCycleSuccess, noteUnhandled, watchdogPlan } from './liveness.js';
import type { DaemonEffects } from './effects.js';
import { Launcher, defaultLaunchConcurrency, runCycle } from './cycle.js';
import { describeTimings } from '../master/timings.js';

/** The compact daemon view `master status` joins onto Graphyard truth. */
export function daemonSummary(state: DaemonState, now: number, intervalMs: number, hostId?: string) {
  const lastCycleAt = state.lastCycleAt ? Date.parse(state.lastCycleAt) : Number.NaN;
  const lagMs = Number.isFinite(lastCycleAt) ? now - lastCycleAt : null;
  const recent = Object.entries(state.actions).map(([key, action]) => ({ key, ...action })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const liveness = loopLiveness(state, now, intervalMs, hostId);
  return {
    // A loop inside a failed-cycle backoff is running: it announced when its next cycle is due.
    running: !!state.lock && lagMs !== null && (lagMs < Math.max(3 * intervalMs, 120_000) || liveness.state === 'running' || liveness.state === 'slow'),
    // Whether the loop is cycling at all, on the two-interval bound, with the restart command.
    liveness,
    // Failed cycles and the process-level events the loop survived (GY-119).
    failures: state.failures,
    // What it could act on and the longest any of those has waited, and the latency budgets.
    silence: silenceReport(state.silence, now),
    budget: latencyBudget(state.latency),
    lock: state.lock, cycle: state.cycle, lastCycleAt: state.lastCycleAt, lagMs,
    unresolved: recent.filter(action => action.state === 'started' || action.state === 'indeterminate'),
    escalations: recent.filter(action => action.kind === 'escalation').slice(0, 20),
    actions: recent.slice(0, 40),
    metrics: state.metrics.at(-1) ?? null,
    // Where the last cycle's time went, against the interval and the liveness bound it is judged
    // on: its own work, its child waits, and the step behind each, so a long cycle is a step to
    // shorten or a provider to look at, never a loop to restart.
    cost: cycleCost(state.metrics.at(-1) ?? null, intervalMs),
    // The cycle's usual wall time, p50 and p95 over the last 30 minutes (GY-616).
    cycleTime: cycleTimes(state.metrics, now),
    deployment: state.deployment,
    profiles: state.profiles,
    config: state.config,
    reclaim: state.reclaim,
    // Every decision the loop has put to an approver and not yet seen applied and retired.
    approvals: Object.entries(state.approvals).map(([key, watch]) => ({ key, ...watch })),
    // Fault instances by class in the recurrence window, and the item each recurring class filed (GY-173).
    faults: faultRecurrenceReport(state, faultClassPolicyFromEnv(process.env), now),
    // Each diagnosis the diagnostician returned, and the fix item or covering item answering it (GY-439).
    diagnoses: diagnosisReport(state),
    // The system invariants as the last cycle judged them (GY-404): one line per invariant, with its threshold and reading.
    invariants: { at: state.invariants.at, violated: state.invariants.report.filter(check => !check.holds).length, lines: state.invariants.report.map(check => check.line), checks: state.invariants.report },
  };
}

/**
 * Adopt a reloaded master.json into the running loop, or record why it was refused. A refusal is
 * an escalation naming the stale setting, written once per distinct reason; an adoption names what
 * changed. Either way the loop keeps cycling on the settings it holds.
 */
export async function noteConfigReload(state: DaemonState, reload: ConfigReload, persist: DaemonEffects['persist']) {
  const previous = state.config;
  state.config = { at: reload.at, changed: reload.changed.slice(0, 100), refused: reload.refused?.slice(0, 1000) ?? null };
  const noted: DaemonAction[] = [];
  if (reload.refused && previous?.refused !== state.config.refused) {
    // A refused reload is a configuration fault, whatever kind of action reports it.
    noted.push(storeAction(state, `escalation:config:${reload.at}`, { kind: 'escalation', work: null, principal: null, state: 'failed', detail: state.config.refused!, attempts: 1, epoch: null, cycle: state.cycle, at: reload.at }, 'action:config'));
  }
  if (reload.changed.length) {
    noted.push(storeAction(state, `config:${reload.at}`, { kind: 'config', work: null, principal: null, state: 'done', detail: `Adopted .graphyard/master.json changes without a restart: ${reload.changed.join(', ')}`, attempts: 1, epoch: null, cycle: state.cycle, at: reload.at }));
  }
  if (noted.length || previous?.refused !== state.config.refused) await persist(state);
  return noted;
}

/** A watchdog window too short for the configured interval is recorded once, not obeyed silently. */
export async function noteWatchdog(state: DaemonState, plan: ReturnType<typeof watchdogPlan>, at: string, persist: DaemonEffects['persist']) {
  if (!plan.refusal) return [];
  const key = `escalation:watchdog:${plan.windowMs}`;
  if (state.actions[key]) return [];
  const entry = storeAction(state, key, { kind: 'escalation', work: null, principal: null, state: 'failed', detail: plan.refusal, attempts: 1, epoch: null, cycle: state.cycle, at }, 'action:config');
  await persist(state);
  return [entry];
}

/**
 * Supervised entry point. The process owns no lease and no credential beyond the coordinator token,
 * so a restart is always safe: it reconciles the cursor against Graphyard and keeps cycling.
 *
 * A cycle that throws does not end the process (GY-119). The rejection — a control-plane read that
 * timed out, a runtime call that failed, a reload that could not be parsed — fails that cycle: it is
 * recorded on the cursor with the cycle number and the call it escaped from, logged, and the next
 * cycle runs after a delay that grows with the consecutive count. An unhandled rejection or uncaught
 * exception anywhere in the process is caught here, logged with its origin, counted on the cursor,
 * and survived. Only a stop signal ends the loop; the supervisor's restart is reserved for a process
 * that hangs, which its watchdog detects.
 */
export async function runDaemon(config: MasterConfig, state: DaemonState, raw: DaemonEffects, options: { once?: boolean; intervalMs: number | (() => number); identity: { pid: number; host: string }; signals?: NodeJS.Signals[]; now?: () => number; log?: (line: string) => void;
  /** The process supervisor's environment, for the watchdog keep-alive; defaults to this process's. */
  environment?: Record<string, string | undefined>;
  /** Re-reads .graphyard/master.json before each cycle, so profiles, workspace, run settings and autoMerge apply without a restart. */
  reload?: () => Promise<ConfigReload>;
  /** The process whose unhandled rejections and uncaught exceptions the loop catches; defaults to this one. */
  process?: Pick<NodeJS.Process, 'on' | 'off'> } ) {
  // Progress goes to stderr so stdout stays the machine-readable result the CLI prints.
  const now = options.now ?? Date.now, log = options.log ?? (line => console.error(line));
  const interval = () => typeof options.intervalMs === 'function' ? options.intervalMs() : options.intervalMs;
  const effects = boundedPersist(namedEffects(raw)), host = options.process ?? process;
  acquireDaemonLock(state, options.identity, now(), interval());
  await effects.persist(state);
  // Under a supervisor that watches for keep-alives, a hung cycle is a restart rather than a
  // silent pipeline; a window that would restart a healthy loop is recorded and left to the
  // supervisor's configuration rather than worked around.
  const watchdog = watchdogPlan(options.environment ?? process.env, interval());
  for (const action of await noteWatchdog(state, watchdog, new Date(now()).toISOString(), effects.persist)) log(`[graphyard-master] ${action.kind} ${action.state}: ${action.detail}`);
  if (watchdog.supervised) { try { await effects.notify?.('ready'); } catch (error) { log(`[graphyard-master] supervisor notification failed: ${message(error)}`); } }
  let stopping = false;
  // A supervisor's SIGTERM must land during the wait, not one whole interval later.
  const waking = new AbortController();
  const stop = () => { stopping = true; waking.abort(); };
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  for (const signal of signals) host.on(signal, stop);
  // A detached promise that rejects — in the dispatcher beside this loop, an approver watch, a
  // Herdr read nobody awaited — would otherwise end the process. It is counted and survived; the
  // cursor write is best-effort, since the handler runs outside any cycle's own persistence.
  const unhandled = (origin: 'unhandledRejection' | 'uncaughtException') => (error: unknown) => {
    const entry = noteUnhandled(state, error, origin, now());
    log(`[graphyard-master] ${origin} caught at the process level during cycle ${entry.cycle} (${state.failures.unhandled} so far); the loop keeps running: ${entry.reason}`);
    effects.persist(state).catch(() => {});
  };
  const onRejection = unhandled('unhandledRejection'), onException = unhandled('uncaughtException');
  host.on('unhandledRejection', onRejection); host.on('uncaughtException', onException);
  const cycles: { cycle: number; actions: number; durationMs: number; childWaitMs: number }[] = [], failed: { cycle: number; call: string | null; reason: string; delayMs: number }[] = [];
  // Session launches run beside the cycles, never inside one (GY-616): a cycle hands a launch over
  // and moves on, and the next cycle reports what it did. The launcher outlives every cycle.
  const launcher = new Launcher(config.run.launchConcurrency ?? defaultLaunchConcurrency);
  try {
    do {
      let phase: 'reload' | 'cycle' = 'reload', wait: number;
      try {
        if (options.reload) {
          for (const action of await noteConfigReload(state, await options.reload().then(reload => { config = reload.config; return reload; }), effects.persist)) log(`[graphyard-master] ${action.kind} ${action.state}: ${action.detail}`);
        }
        phase = 'cycle';
        const result = await runCycle(config, state, effects, now, launcher);
        // The end of a run of failures is written at once, so `master status` stops naming it.
        const recovered = noteCycleSuccess(state);
        if (recovered) await effects.persist(state);
        cycles.push({ cycle: result.metrics.cycle, actions: result.actions.length, durationMs: result.metrics.durationMs, childWaitMs: result.metrics.childWaitMs ?? 0 });
        for (const action of result.actions) log(`[graphyard-master] cycle ${result.metrics.cycle} ${action.kind} ${action.state}: ${action.detail}`);
        // Both halves of every cycle: what it could act on, and what it did about it — and where its
        // time went: its three slowest steps and its slowest external call (GY-377).
        log(`[graphyard-master] cycle ${result.metrics.cycle} complete in ${result.metrics.durationMs}ms (${result.metrics.childWaitMs ?? 0}ms waiting on child processes); ${result.metrics.open} open, ${result.silence.actionable} actionable, ${result.actions.length} action(s)${result.silence.longest && result.silence.longestIdleMs > 0 ? `, longest wait ${Math.round(result.silence.longestIdleMs / 1000)}s on ${result.silence.longest.detail}` : ''}${recovered ? `; recovered after ${recovered} failed cycle(s)` : ''}${result.metrics.timings ? `; ${describeTimings(result.metrics.timings)}` : ''}`);
        // The configured interval is the idle cadence; while anything is actionable the loop comes
        // back inside the responsive window so ready work cannot sit out a long interval.
        wait = cycleDelay(interval(), result.silence);
      } catch (error) {
        // The cycle failed; the loop did not. The counter advances, the cause is on the cursor, and
        // the next cycle waits longer for each consecutive failure so a fault is not hammered.
        const failure = await noteCycleFailure(state, error, phase, { now: now(), intervalMs: interval(), ceilingMs: cycleFailureCeiling(watchdog.windowMs), persist: effects.persist });
        failed.push({ cycle: failure.cycle, call: failure.call, reason: failure.reason, delayMs: failure.delayMs });
        log(`[graphyard-master] cycle ${failure.cycle} failed in ${describeFailingCall(failure)}: ${failure.reason}; ${state.failures.consecutive} consecutive failure(s), the next cycle runs in ${Math.round(failure.delayMs / 1000)}s at ${failure.nextAt}`);
        wait = failure.delayMs;
      }
      // The keep-alive says the process is alive, which a failed cycle leaves true: the watchdog
      // is for a cycle that hangs, and a thrown one has just proved it did not.
      if (watchdog.supervised) { try { await effects.notify?.('alive'); } catch (error) { log(`[graphyard-master] supervisor notification failed: ${message(error)}`); } }
      if (options.once || stopping) break;
      try { await delay(wait, undefined, { signal: waking.signal }); } catch { /* woken to stop */ }
    } while (!stopping);
  } finally {
    // Launches still in flight are let finish, so none is left `started` on the cursor, and what
    // they did is logged here since no next cycle will report it.
    if (launcher.pending) log(`[graphyard-master] waiting for ${launcher.pending} launch(es) in flight before stopping`);
    await launcher.idle();
    for (const action of launcher.drain()) log(`[graphyard-master] launch ${action.kind} ${action.state}: ${action.detail}`);
    for (const signal of signals) host.off(signal, stop);
    host.off('unhandledRejection', onRejection); host.off('uncaughtException', onException);
    state.lock = null;
    await effects.persist(state).catch(() => {});
  }
  return { cycles, failed, stopped: stopping };
}
