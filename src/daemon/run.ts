// Concern: the long-running loop — cycle scheduling, config reload, the watchdog and its summary.
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ConfigReload, MasterConfig } from '../master.js';
import type { HerdrAgent } from '../master/herdr.js';
import { defaultChildRun } from '../child-runner.js';
import { allocateManagedCheckout } from '../master/worktrees.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { loopScratchCheckout } from '../producer.js';
import { checkoutGuardApplies, coordinatorCheckoutRefusal, coordinatorCheckoutRoot, dirtyCheckoutEscalation, dirtyCheckoutLeases, dirtyCheckoutPaths, readCoordinatorCheckout, type CoordinatorCheckout } from '../master/profiles.js';
import { acquireDaemonLock, masterSummary, type DaemonAction, type DaemonState, message, storeAction, touchStanding } from './state.js';
import { faultClassPolicyFromEnv, type FaultClassPolicy } from '../model/fault-classes.js';
import { faultRecurrenceReport } from './faults.js';
import { diagnosisReport } from './diagnosis.js';
import { latencyBudget, silenceReport } from './metrics.js';
import { boundedPersist, cycleCost, cycleTimes, cycleDelay, cycleFailureCeiling, describeFailingCall, loopLiveness, namedEffects, noteCycleFailure, noteCycleSuccess, noteUnhandled, watchdogPlan } from './liveness.js';
import type { DaemonEffects } from './effects.js';
import { Launcher, defaultLaunchConcurrency, runCycle } from './cycle.js';
import { detailChanged } from './decisions.js';
import { describeSelfUpgrade, type SelfUpgradeOutcome } from './upgrade.js';
import { describeTimings } from '../master/timings.js';
import { stopDoctorRuns, doctorReport } from './doctor.js';
import { mainWatchSummary } from './main-watch.js';
import { shadowGateSummary } from './cycle-shadow.js';
import { mergeWriterSummary } from './cycle-merge-writer.js';
import { detachRuns } from '../runner/registry.js';
import type { LoopWake } from './loop-wake.js';

/**
 * The compact daemon view `master status` joins onto Graphyard truth. `faultPolicy` is the recurrence
 * rule the faults are reported under: the loop passes the one it files by (effects.faultClassPolicy),
 * so the reported window and threshold are the filing ones; absent, the environment's.
 */
export function daemonSummary(state: DaemonState, now: number, intervalMs: number, hostId?: string, faultPolicy: FaultClassPolicy = faultClassPolicyFromEnv(process.env)) {
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
    // The main watch (GY-1519): unknown commits on main, the newest, and whether promotion is frozen on one.
    mainWatch: mainWatchSummary(state.mainWatch),
    // The shadow merge gate's report (GY-1522): outcome counts, trial p50/p90 and the newest disagreements.
    shadowGate: shadowGateSummary(state.shadow),
    // The control-plane merge executor (GY-1524): the heads queued oldest first, the merge in flight, the last delivery and the newest refusals.
    mergeWriter: mergeWriterSummary(state.mergeWriter),
    // The release this process loaded, and what the between-cycles self-upgrade has done (GY-437).
    release: state.release,
    upgrade: state.upgrade,
    profiles: state.profiles,
    config: state.config,
    reclaim: state.reclaim,
    // The host's memory as the last cycle read it; while `low`, launches on this host are deferred (GY-612).
    memory: state.memory,
    // Every decision the loop has put to an approver and not yet seen applied and retired.
    approvals: Object.entries(state.approvals).map(([key, watch]) => ({ key, ...watch })),
    // The master session the loop launches, adopts, wakes and rotates (GY-898): the live handle,
    // its age against the configured budget, why the last one ended, and the last wake's causes.
    master: masterSummary(state.master, now),
    // Fault instances by class in the recurrence window, and the item each recurring class filed (GY-173).
    faults: faultRecurrenceReport(state, faultPolicy, now),
    // Required checks failing on the base head as well as on the candidates they hold (GY-528).
    baseFailures: Object.values(state.baseFailures),
    // Each diagnosis the diagnostician returned, and the fix item or covering item answering it (GY-439).
    diagnoses: diagnosisReport(state),
    // The system invariants as the last observation judged them (GY-404): one line per invariant, with its threshold and reading.
    invariants: { at: state.invariants.at, violated: state.invariants.report.filter(check => !check.holds).length, lines: state.invariants.report.map(check => check.line), checks: state.invariants.report },
    // The pipeline doctor as this cursor holds it (GY-711): whether a run is in flight right now —
    // which the control plane's posted runs cannot show, they settle only afterwards — and its
    // recent runs, newest first.
    doctor: doctorReport(state),
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

/**
 * A watchdog window too short for the configured interval is recorded once, not obeyed silently:
 * once per process start at most, and not again while the same refusal stands on the cursor.
 * Once the installed unit's window covers the interval — the alignment step rewrites a drifted
 * unit before it re-executes the loop (GY-916) — the standing refusal is cleared, so a mismatch is
 * converged rather than faulted at every start.
 */
export async function noteWatchdog(state: DaemonState, plan: ReturnType<typeof watchdogPlan>, at: string, persist: DaemonEffects['persist']) {
  if (!plan.refusal) {
    if (!plan.supervised || plan.windowMs === null) return [];
    const cleared = Object.entries(state.actions).filter(([key, action]) => key.startsWith('escalation:watchdog:') && action.state === 'failed')
      .map(([key, action]) => storeAction(state, key, { ...action, state: 'done', detail: `Cleared: the supervisor's watchdog window is now ${Math.round(plan.windowMs! / 1000)}s, longer than two cycle intervals; it was: ${action.detail}`, cycle: state.cycle, at }, 'action:config'));
    if (cleared.length) await persist(state);
    return cleared;
  }
  const key = `escalation:watchdog:${plan.windowMs}`;
  if (state.actions[key]?.state === 'failed') return [];
  const entry = storeAction(state, key, { kind: 'escalation', work: null, principal: null, state: 'failed', detail: plan.refusal, attempts: 1, epoch: null, cycle: state.cycle, at }, 'action:config');
  await persist(state);
  return [entry];
}

/**
 * Take back the headless runs a restart left running (GY-453): on the loop's start, and on every
 * later cycle any run no live process watches — one an executor left running when it stopped and
 * was not started again. An approver's run reports its record on the watch of the decision it
 * judges when it ends, as a run this loop launched would.
 */
export async function adoptHeadlessRuns(state: DaemonState, effects: DaemonEffects, log: (line: string) => void, when: 'start' | 'cycle' = 'start') {
  if (!effects.adoptRuns) return [];
  try {
    const adopted = await effects.adoptRuns();
    if (adopted.length) log(`[graphyard-master] adopted ${adopted.length} headless run(s) ${when === 'start' ? 'left running by a restart' : 'no live process was watching'}: ${adopted.map(run => `${run.name} (${run.role} for ${run.work}${run.live ? '' : ', ended while unwatched'})`).join(', ')}`);
    for (const run of adopted) {
      if (run.role !== 'approver') continue;
      run.settled.then(async record => {
        const watch = Object.values(state.approvals).find(entry => entry.agentName === run.name && entry.decision === run.subject);
        if (watch) { watch.run = record; await effects.persist(state); }
      }).catch(() => { /* the next cycle judges the decision from the control plane */ });
    }
    return adopted;
  } catch (error) { log(`[graphyard-master] could not adopt the headless runs a restart left: ${message(error)}`); return []; }
}

/**
 * GY-1480: the checkout the research scratch worktree is made from — the managed repository's own,
 * whose commit the loop's release names, never the Graphyard CLI checkout, which holds no such
 * commit when the managed repository is another one. Without a repository it is the CLI's checkout,
 * which is the managed repository when Graphyard manages itself.
 */
export const researchScratchSource = (config: Pick<MasterConfig, 'cliPath'>, repository?: string | null) => repository ? resolve(repository) : coordinatorCheckoutRoot(config.cliPath);

/**
 * The research scratch checkout under SOURCE's managed worktree root, holding a detached worktree
 * of RELEASE (a commit of SOURCE) when one can be made: the directory sessions start in, or null
 * when no scratch could be allocated.
 */
export async function openResearchScratch(source: string, config: MasterConfig, release: string | null, log: (line: string) => void): Promise<string | null> {
  try {
    // The path is the repository's, not this process's: a restarted loop takes up the scratch
    // the loop before it left, so the detached research runs registered there (GY-453) stay in a
    // directory that exists and are adopted from the registry they were written to.
    const stable = loopScratchCheckout(worktreeRoot(source, config));
    const scratch = existsSync(stable.directory) ? stable : await allocateManagedCheckout(source, config, 'approval', 'loop-scratch', '0'.repeat(40), '0'.repeat(8));
    if (!release) return scratch.directory;
    try {
      // A worktree the loop before left is moved onto this loop's release; the run registry
      // under its ignored .graphyard/ stays where it is.
      if (existsSync(scratch.worktree)) await defaultChildRun('git', ['-C', scratch.worktree, 'checkout', '--detach', '--force', '--quiet', release]);
      else await defaultChildRun('git', ['-C', source, 'worktree', 'add', '--detach', '--quiet', scratch.worktree, release]);
      return scratch.worktree;
    } catch (error) {
      log(`[graphyard-master] the research scratch checkout holds no worktree of ${release.slice(0, 12)}: ${message(error)}`);
      return scratch.directory;
    }
  } catch (error) {
    log(`[graphyard-master] research, triage and the diagnostician are off: no scratch checkout outside the coordinator checkout could be allocated: ${message(error)}`);
    return null;
  }
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
  process?: Pick<NodeJS.Process, 'on' | 'off'>;
  /** Reads how the coordinator checkout stands; defaults to reading it from the configured CLI launcher's root. */
  checkout?: () => CoordinatorCheckout | Promise<CoordinatorCheckout>;
  /** The managed repository's checkout the loop runs for; its research scratch is a worktree of it (GY-1480). Defaults to the CLI launcher's checkout. */
  repository?: string;
  /** The dispatcher's wake (GY-1490, loop-wake.ts): ends the sleep after a cycle as soon as the tick sees work the loop acts on. */
  wake?: Pick<LoopWake, 'sleep'> } ) {
  // Progress goes to stderr so stdout stays the machine-readable result the CLI prints.
  const now = options.now ?? Date.now, log = options.log ?? (line => console.error(line));
  const interval = () => typeof options.intervalMs === 'function' ? options.intervalMs() : options.intervalMs;
  const host = options.process ?? process;
  let stopping = false;
  // A supervisor's SIGTERM must land during the wait, not one whole interval later — and from the
  // first line, not after the awaited startup below (GY-1603): a stop received while the scratch
  // checkout opens or runs are adopted ends the loop before any cycle, rather than being missed.
  const waking = new AbortController();
  const stop = () => { stopping = true; waking.abort(); };
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  for (const signal of signals) host.on(signal, stop);
  const unlisten = () => { for (const signal of signals) host.off(signal, stop); };
  try {
    // GY-866: research and triage sessions have no checkout of their own, so they read the code they
    // judge from a scratch checkout of their own under the managed worktree root — a detached
    // worktree of the release this loop runs, when one can be made, so the session still reads real
    // code — never from the coordinator checkout: a session that works where it starts rewrites the
    // control plane's own code. A root that cannot hold the scratch leaves the loop without research
    // and triage rather than with sessions working in the coordinator checkout.
    // The diagnostician reads the repository from the same scratch checkout: it too is a session the
    // loop launches, and without the scratch it does not run at all.
    // A loop with neither has no scratch to place, so it needs no CLI launcher to place it from.
    const needsScratch = Boolean(raw.research) || 'diagnostician' in raw;
    const scratchDirectory = needsScratch ? await openResearchScratch(researchScratchSource(config, options.repository), config, raw.loadedRelease?.commit ?? null, log) : null;
    const scoped = new Proxy(raw, { get(target, property, receiver) {
      if (property === 'research') return target.research && scratchDirectory ? { ...target.research, cwd: scratchDirectory } : undefined;
      if (property === 'diagnostician') { const diagnostician = target.diagnostician; return diagnostician && scratchDirectory ? { ...diagnostician, cwd: scratchDirectory } : undefined; }
      return Reflect.get(target, property, receiver);
    } });
    const effects = boundedPersist(namedEffects(scoped));
    acquireDaemonLock(state, options.identity, now(), interval());
    // GY-437: the release is this process's, never the cursor's: a loop re-executed onto a moved
    // checkout must not report the release the process before it loaded.
    state.release = raw.loadedRelease ?? null;
    await effects.persist(state);
    // Under a supervisor that watches for keep-alives, a hung cycle is a restart rather than a
    // silent pipeline; a window that would restart a healthy loop is recorded and left to the
    // supervisor's configuration rather than worked around.
    const watchdog = watchdogPlan(options.environment ?? process.env, interval());
    for (const action of await noteWatchdog(state, watchdog, new Date(now()).toISOString(), effects.persist)) log(`[graphyard-master] ${action.kind} ${action.state}: ${action.detail}`);
    if (watchdog.supervised) { try { await effects.notify?.('ready'); } catch (error) { log(`[graphyard-master] supervisor notification failed: ${message(error)}`); } }
    await adoptHeadlessRuns(state, effects, log);
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
    // GY-857: the checkout guard. The modules this process imported were read from the coordinator
    // checkout at startup; when it holds uncommitted work, cycling would run unreviewed code and a
    // self-upgrade would move the checkout underneath it, so the loop refuses — at startup it never
    // becomes live at all, and between cycles it skips the upgrade and keeps running the release it
    // loaded. Either refusal is an escalation naming the dirty paths and which live leases' planned
    // files they match: those matches are the checkout's writes attributed to the attempts most
    // likely to have made them.
    const checkoutOf = async () => options.checkout?.() ?? await readCoordinatorCheckout(coordinatorCheckoutRoot(config.cliPath));
    const guard = coordinatorCheckoutGuard({ state: () => state, read: checkoutOf, agents: raw.agents, snapshot: raw.snapshot, persist: effects.persist, now, log, recover: effects.recoverHead });
    try {
      const startRefusal = await guard.start(raw.loadedRelease?.commit ?? null);
      if (startRefusal) {
        // The refused loop keeps its process for its supervisor — a crash would only be restarted
        // onto the same dirty checkout — and cycles nothing until it is restarted on a clean one.
        log(`[graphyard-master] the loop cycles nothing from a dirty coordinator checkout; clean or stash the paths it names, then restart it`);
        while (!stopping && !options.once) {
          if (watchdog.supervised) { try { await effects.notify?.('alive'); } catch (error) { log(`[graphyard-master] supervisor notification failed: ${message(error)}`); } }
          try { await delay(interval(), undefined, { signal: waking.signal }); } catch { /* woken to stop */ }
        }
      // A loop stopped during startup runs no cycle (GY-1603).
      } else while (!stopping) {
        let phase: 'reload' | 'cycle' = 'reload', wait: number, wakeable = false;
        try {
          if (options.reload) {
            for (const action of await noteConfigReload(state, await options.reload().then(reload => { config = reload.config; return reload; }), effects.persist)) log(`[graphyard-master] ${action.kind} ${action.state}: ${action.detail}`);
          }
          phase = 'cycle';
          if (cycles.length + failed.length) await adoptHeadlessRuns(state, effects, log, 'cycle');
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
          wakeable = true;
        } catch (error) {
          // The cycle failed; the loop did not. The counter advances, the cause is on the cursor, and
          // the next cycle waits longer for each consecutive failure so a fault is not hammered.
          const failure = await noteCycleFailure(state, error, phase, { now: now(), intervalMs: interval(), ceilingMs: cycleFailureCeiling(watchdog.windowMs), persist: effects.persist });
          failed.push({ cycle: failure.cycle, call: failure.call, reason: failure.reason, delayMs: failure.delayMs });
          log(`[graphyard-master] cycle ${failure.cycle} failed in ${describeFailingCall(failure)}: ${failure.reason}; ${state.failures.consecutive} consecutive failure(s), the next cycle runs in ${Math.round(failure.delayMs / 1000)}s at ${failure.nextAt}`);
          wait = failure.delayMs;
        }
        // GY-437: between cycles — never mid-cycle — align this checkout with the verified deployed
        // release. An alignment that re-executes the loop through its supervisor ends this process
        // here: the supervisor starts the next one on the code the checkout now holds.
        // GY-857: never while the checkout is dirty — the alignment would check out over work it
        // holds and re-execute the loop onto code no commit names.
        // GY-866: the guard reads the checkout every cycle, not only when an alignment is due.
        // The executor restart can wait minutes on held claims and re-registration: the watchdog is
        // fed on each poll so that wait is not mistaken for a hung loop (GY-916).
        const keepAlive = watchdog.supervised ? async () => { try { await effects.notify?.('alive'); } catch (error) { log(`[graphyard-master] supervisor notification failed: ${message(error)}`); } } : undefined;
        const selfUpgrade = effects.selfUpgrade;
        await guard.betweenCycles(stopping || !selfUpgrade ? undefined : current => selfUpgrade(current, keepAlive), stopping ? undefined : keepAlive, { stopping });
        // The keep-alive says the process is alive, which a failed cycle leaves true: the watchdog
        // is for a cycle that hangs, and a thrown one has just proved it did not.
        if (watchdog.supervised) { try { await effects.notify?.('alive'); } catch (error) { log(`[graphyard-master] supervisor notification failed: ${message(error)}`); } }
        if (options.once || stopping) break;
        // GY-1490: after a cycle that ran, the dispatcher wakes the sleep for work this loop acts on;
        // a failed cycle's backoff is never cut short, so a fault is still not hammered.
        if (wakeable && options.wake) {
          const sleptAt = now(), reasons = await options.wake.sleep(wait, waking.signal);
          if (reasons.length && !stopping) log(`[graphyard-master] woken ${Math.round(Math.max(0, wait - (now() - sleptAt)) / 1000)}s before the ${Math.round(wait / 1000)}s wait ended: ${reasons.join('; ')}`);
        } else try { await delay(wait, undefined, { signal: waking.signal }); } catch { /* woken to stop */ }
      }
    } finally {
      // Launches still in flight are let finish, so none is left `started` on the cursor, and what
      // they did is logged here since no next cycle will report it.
      if (launcher.pending) log(`[graphyard-master] waiting for ${launcher.pending} launch(es) in flight before stopping`);
      await launcher.idle();
      // A pipeline-doctor run in flight is cancelled and its outcome recorded before the lock is released (GY-711).
      await stopDoctorRuns();
      for (const action of launcher.drain()) log(`[graphyard-master] launch ${action.kind} ${action.state}: ${action.detail}`);
      // GY-866: the scratch checkout outlives the loop: research runs detached into it keep working
      // and the next loop adopts them from it.
      unlisten();
      host.off('unhandledRejection', onRejection); host.off('uncaughtException', onException);
      // Headless runs are detached (GY-453): the loop stops watching them and sends none of them a
      // signal, so a planned restart takes no run's attempt; the next loop adopts them.
      const left = detachRuns();
      log(`[graphyard-master] stopping: left ${left} headless run(s) running, detached, for the next loop to adopt`);
      state.lock = null;
      await effects.persist(state).catch(() => {});
    }
    return { cycles, failed, stopped: stopping };
  } catch (error) {
    // A startup that failed (another loop's lock, an unwritable cursor) leaves no listener behind.
    unlisten();
    throw error;
  }
}

const escalationKey = 'escalation:dirty-checkout';
/**
 * GY-857/GY-866: the coordinator checkout guard the loop runs at startup and after every cycle.
 * A tree holding uncommitted work, or a HEAD that moved away from the commit the loop runs, is
 * attention naming the paths, the HEAD, the live leases whose planned files the paths match and
 * the sessions whose panes point at the checkout — and the loop neither self-upgrades nor restarts
 * from it until it is clean and back at that commit. The commit the loop runs is the HEAD it
 * loaded its code from; every move its own alignment makes rewrites the expectation, and anything
 * else that moves HEAD under a running loop is drift — unless it moved forward (GY-1356): a clean,
 * detached HEAD that descends from the commit the loop runs and is on the base branch is adopted through `recover`, which
 * restarts the executors and re-executes the loop onto it, instead of pinning the loop to stale code.
 * One it cannot adopt by itself (GY-1359) is attention naming a restart onto that HEAD, never a rollback.
 */
export function coordinatorCheckoutGuard(deps: {
  state: () => DaemonState; read: () => Promise<CoordinatorCheckout>; agents: DaemonEffects['agents']; snapshot: DaemonEffects['snapshot'];
  persist: DaemonEffects['persist']; now: () => number; log: (line: string) => void; applies?: (root: string) => boolean; enrichMs?: number;
  recover?: DaemonEffects['recoverHead'];
}) {
  const applies = deps.applies ?? checkoutGuardApplies, enrichMs = deps.enrichMs ?? 10 * 60_000;
  let expectedHead: string | null = null, enriched: { refusal: string; detail: string; at: number } | null = null;
  // GY-1359: a HEAD the recovery found to be merged code moved forward, but could not adopt by itself
  // (no verified release serves it yet, no supervisor unit to re-execute through), keyed by commit to
  // why. Its remedy is a restart onto that HEAD; rolling the checkout back to stale code never is.
  const forward = new Map<string, string>();
  const headDrift = (checkout: CoordinatorCheckout) => {
    if (!checkout.commit || !expectedHead || checkout.commit === expectedHead) return null;
    const from = expectedHead.slice(0, 12), to = checkout.commit.slice(0, 12), unrecovered = forward.get(checkout.commit);
    return unrecovered
      ? `the master loop cannot recover onto the coordinator checkout at ${checkout.root} by itself: its HEAD moved from ${from} forward to ${to}, merged code, while the loop was running, and ${unrecovered}. It keeps running the code it loaded; leave the checkout at ${to} and restart the loop onto its own HEAD (systemctl --user restart graphyard-master)`
      : `the master loop refuses to restart or self-upgrade from the coordinator checkout at ${checkout.root}: its HEAD moved from ${from} to ${to} while the loop was running, so HEAD is not the commit it runs. It keeps running the code it loaded; either remedy ends this refusal (GY-1531): restore the checkout with git -C ${checkout.root} checkout --detach ${from} and restart the loop, or leave it at ${to} and restart the loop onto that HEAD (systemctl --user restart graphyard-master), which loads it`;
  };
  // The sessions working where they started, the ones to close first. Graphyard's own managed area
  // under `.graphyard/` is not the checkout's working files and is never named. An inventory that
  // cannot be read (Herdr down: `agents` answers null or throws) leaves the sessions unknown,
  // never the refusal unrecorded.
  const pointingSessions = async (checkoutRoot: string): Promise<string[] | null> => {
    const base = resolve(checkoutRoot), managed = `${base}${sep}.graphyard`;
    let agents: HerdrAgent[] | null;
    try { agents = (await deps.agents()) as HerdrAgent[] | null; } catch { agents = null; }
    if (!Array.isArray(agents)) return null;
    return agents.flatMap(agent => {
      const cwd = agent.cwd ? resolve(agent.cwd) : null;
      if (!cwd) return [];
      const inside = cwd === base || cwd.startsWith(`${base}${sep}`);
      if (!inside || cwd === managed || cwd.startsWith(`${managed}${sep}`)) return [];
      return [`${agent.name ?? agent.agent ?? 'an unnamed session'} (pane ${agent.pane_id ?? 'unknown'}, cwd ${agent.cwd})`];
    });
  };
  // GY-1356: a HEAD that moved forward onto merged code is recovered onto, never stood down on. A
  // recovery refused for a HEAD (not a descendant, not on the base branch, not detached) or failed
  // is tried once per HEAD and verified release (GY-1359: a release verified later serves it); the
  // drift the guard then reports stands until either moves or the loop is restarted.
  const unrecovered = new Set<string>();
  const recoverDrift = async (checkout: CoordinatorCheckout, keepAlive?: () => Promise<void>): Promise<SelfUpgradeOutcome | null> => {
    const from = expectedHead, to = checkout.commit, attempt = `${to} ${deps.state().deployment?.sha ?? ''}`;
    if (!deps.recover || !from || !to || unrecovered.has(attempt) || !applies(checkout.root) || coordinatorCheckoutRefusal(checkout, 'the master loop') || !headDrift(checkout)) return null;
    let recovered: SelfUpgradeOutcome;
    try { recovered = await deps.recover(deps.state(), from, to, keepAlive); }
    catch (error) { recovered = { outcome: 'failed', reason: message(error) }; }
    deps.log(`[graphyard-master] moved HEAD ${to.slice(0, 12)} (from ${from.slice(0, 12)}) ${recovered.outcome === 'upgraded' ? 'recovered' : 'not recovered'}: ${describeSelfUpgrade(recovered)}`);
    if (recovered.outcome !== 'upgraded') {
      unrecovered.add(attempt);
      if ((recovered.outcome === 'refused' || recovered.outcome === 'failed') && recovered.forward) forward.set(to, recovered.reason); else forward.delete(to);
      return null;
    }
    expectedHead = to;
    return recovered;
  };
  const escalate = async (checkout: CoordinatorCheckout) => {
    if (!applies(checkout.root)) return null;
    const refusal = coordinatorCheckoutRefusal(checkout, 'the master loop') ?? headDrift(checkout);
    if (!refusal) {
      enriched = null;
      // A checkout clean again and back at the commit the loop runs settles the attention it raised.
      const state = deps.state(), raised = state.actions[escalationKey];
      if (raised?.state === 'failed') {
        const detail = `the coordinator checkout at ${checkout.root} is clean again at ${(checkout.commit ?? 'an unreadable HEAD').slice(0, 12)}, the commit the loop runs`;
        storeAction(state, escalationKey, { ...raised, state: 'done', detail, cycle: state.cycle, at: new Date(deps.now()).toISOString() }, 'action:config');
        await deps.persist(state);
        // Said in the journal too (GY-1531): the remedy the refusal named ended it, visibly beside it.
        deps.log(`[graphyard-master] escalation done: ${detail}`);
      }
      return null;
    }
    // A standing refusal keeps the leases and sessions it named: the plane and the Herdr inventory
    // are read again when what the checkout holds changes, and at most every enrichMs while it does
    // not, never once per cycle.
    let detail: string;
    if (enriched && enriched.refusal === refusal && deps.now() - enriched.at < enrichMs) detail = enriched.detail;
    else {
      detail = refusal;
      try {
        const snapshot = await deps.snapshot();
        detail = dirtyCheckoutEscalation(refusal, dirtyCheckoutLeases(snapshot.work, dirtyCheckoutPaths(checkout), Date.parse(snapshot.now) || undefined));
      } catch { /* the refusal stands alone when the plane cannot be read */ }
      const pointing = await pointingSessions(checkout.root);
      if (!pointing) detail += ' The sessions whose panes point at it are unknown: the Herdr inventory could not be read.';
      else if (pointing.length) detail += ` ${pointing.length === 1 ? 'One session\'s pane still points at it' : `${pointing.length} sessions' panes still point at it`}: ${pointing.slice(0, 8).join('; ')}${pointing.length > 8 ? `; and ${pointing.length - 8} more` : ''}.`;
      enriched = { refusal, detail, at: deps.now() };
    }
    const state = deps.state(), existing = state.actions[escalationKey];
    if (detailChanged(existing, detail)) {
      storeAction(state, escalationKey, { kind: 'escalation', work: null, principal: null, state: 'failed', detail, attempts: (existing?.attempts ?? 0) + 1, epoch: null, cycle: state.cycle, at: new Date(deps.now()).toISOString() }, 'action:config');
      await deps.persist(state);
      deps.log(`[graphyard-master] escalation failed: ${detail}`);
    } else touchStanding(state, escalationKey, new Date(deps.now()).toISOString());
    return detail;
  };
  return {
    /** The startup read: the HEAD found here is the commit the loop runs. The refusal, or null. */
    async start(loaded: string | null) {
      const checkout = await deps.read();
      expectedHead = checkout.commit ?? loaded;
      return escalate(checkout);
    },
    /**
     * The between-cycles read, then the self-upgrade only when the checkout stands clean and at
     * the commit the loop runs. The loop's own alignment is the one move it sanctions.
     * `stopping`: the loop is ending this process (its supervisor's stop or restart), so the
     * self-upgrade is off and the next loop loads whatever HEAD the checkout holds — a HEAD that
     * moved is what that restart adopts, not drift to refuse (GY-1531: a loop stopping for its own
     * restart onto a forward HEAD recorded the refusal that restart was the remedy for). A dirty
     * tree still refuses: the next loop would refuse it at startup too.
     */
    async betweenCycles(selfUpgrade?: (state: DaemonState) => Promise<SelfUpgradeOutcome>, keepAlive?: () => Promise<void>, options: { stopping?: boolean } = {}) {
      const checkout = await deps.read();
      if (options.stopping && applies(checkout.root) && !coordinatorCheckoutRefusal(checkout, 'the master loop')) {
        const drift = headDrift(checkout);
        if (drift) {
          deps.log(`[graphyard-master] stopping with the coordinator checkout's HEAD at ${(checkout.commit ?? '').slice(0, 12)}, not ${(expectedHead ?? '').slice(0, 12)} the loop loaded: the next loop runs the checkout's HEAD, so no dirty-checkout refusal is recorded`);
          return { refusal: drift, upgraded: null };
        }
      }
      // A forward move adopted here settles any drift attention it raised, and is this cycle's upgrade.
      const recovered = selfUpgrade ? await recoverDrift(checkout, keepAlive) : null;
      if (recovered) { await escalate(checkout); return { refusal: null, upgraded: recovered }; }
      const refusal = await escalate(checkout);
      if (refusal || !selfUpgrade) return { refusal, upgraded: null };
      let upgraded: SelfUpgradeOutcome | null = null;
      try {
        upgraded = await selfUpgrade(deps.state());
        if (upgraded.outcome !== 'skipped') deps.log(`[graphyard-master] upgrade ${describeSelfUpgrade(upgraded)}`);
      } catch (error) { deps.log(`[graphyard-master] upgrade failed: ${message(error)}`); }
      // The loop's own alignment is never foreign drift. A pending upgrade has moved the checkout too:
      // only the restarts it owes wait (GY-916). An upgrade that failed, or threw, after its checkout
      // (an executor or self restart it could not make) still left HEAD at the target its cursor
      // records, so that HEAD is adopted as well; any other HEAD stays drift for the next cycle.
      if (upgraded?.outcome !== 'skipped') {
        const sanctioned = upgraded?.outcome === 'upgraded' || upgraded?.outcome === 'up-to-date' || upgraded?.outcome === 'pending';
        const cursor = deps.state().upgrade, targets = [cursor?.pending?.to, cursor?.last?.to];
        try {
          const aligned = await deps.read();
          if (aligned.commit && (sanctioned || targets.includes(aligned.commit))) expectedHead = aligned.commit;
        } catch { /* the next cycle's read reports what it finds */ }
      }
      return { refusal: null, upgraded };
    },
    expected: () => expectedHead,
  };
}
