// Concern: `graphyard master run` — wiring the durable loop and automatic dispatch to their effects.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { daemonExecutor, liveMasterConfig, mergeExecutor } from '../../master.js';
import { daemonEffects, readDaemonState, retriedSnapshot, runDaemon } from '../../master-daemon.js';
import { dispatchEffects, dispatchReadTimeoutMs, readDispatchCursor, runAutoDispatch } from '../../auto-dispatch.js';
import { coordinationViewHeader } from '../../server/work-view.js';
import { unhandled, type MasterSession } from './session.js';
import { timedApi } from '../../master/timings.js';
import { codeReloadReason } from '../../master-resources.js';

/** The durable coordination loop and the dispatcher beside it, until stopped. */
export async function loopCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, master, masterToken, masterApi, masterMutation, coordinator, assertProtocol } = session;
  if (id === 'run') {
    const { values } = parseArgs({ args, options: { once: { type: 'boolean' }, interval: { type: 'string' } }, allowPositionals: false });
    const intervalSeconds = values.interval ? Number(values.interval) : master.run.intervalSeconds;
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 900) throw new Error('Use master run --interval with whole seconds between 5 and 900');
    // A coordinator credential is the daemon's entire authority; anything broader could satisfy a gate the loop must wait on.
    if (coordinator.actor.role !== 'coordinator') throw new Error('The durable master loop requires a coordinator credential; operator, producer, and worker credentials are refused');
    if (coordinator.actor.proofs?.length) throw new Error('The durable master loop refuses a credential that is also allowed to produce evidence');
    assertProtocol(coordinator);
    const state = await readDaemonState(root, master);
    // The cycle and the dispatcher poll the bounded coordination view (by header, so an older
    // server answers with whole documents); the guarded merge re-reads the full documents.
    const live = liveMasterConfig(root, master), current = () => live.current, reload = () => live.reload();
    const coordinationSnapshot = (timeoutMs?: number) => masterApi('work-snapshot', masterToken, timeoutMs, { [coordinationViewHeader]: 'coordination' });
    const executor = daemonExecutor(coordinator.actor.id);
    const effects = daemonEffects(root, current, { snapshot: retriedSnapshot(() => coordinationSnapshot()), mutate: masterMutation, executor });
    // The guarded merge's reads and writes are timed against the cycle that made them (GY-377);
    // daemonEffects times its own.
    const timedRead = timedApi(masterApi), timedMutation = timedApi(masterMutation, 'POST');
    const guardedMerge: typeof effects.merge = work => mergeExecutor(current(), () => timedRead('work-snapshot'), timedMutation, executor, randomUUID())(work);
    // The loop outlives deployments: every guarded merge re-reads the server's protocol first.
    effects.merge = async work => { assertProtocol(await timedRead('status')); return guardedMerge(work); };
    // Automatic dispatch runs beside the cycle on a shorter cadence; it stops with the daemon.
    const dispatchCursor = await readDispatchCursor(root, master);
    const stopping = new AbortController();
    const daemonRun = runDaemon(master, state, effects, { once: values.once, intervalMs: values.interval ? intervalSeconds * 1000 : () => current().run.intervalSeconds * 1000, identity: { pid: process.pid, host: master.hostId }, reload,
      codeReload: () => codeReloadReason(root, process.pid) }).finally(() => stopping.abort());
    const dispatchRun = runAutoDispatch(master, dispatchCursor, dispatchEffects(root, current, { snapshot: () => coordinationSnapshot(dispatchReadTimeoutMs) }), { once: values.once, intervalMs: () => current().run.dispatchIntervalSeconds * 1000, signal: stopping.signal, reload });
    const [result, dispatched] = await Promise.all([daemonRun, dispatchRun]);
    // A loop reloading onto new code must end for its supervisor to start the new revision: a handle
    // left open (a pooled socket, a timer) would otherwise hold it until the watchdog noticed.
    if (result.reloading) setTimeout(() => process.exit(0), 5_000).unref();
    // A cycle that threw was recorded and retried in-process (GY-119); it is reported here, never as an exit.
    return print({ repository: master.repository, coordinator: coordinator.actor.id, intervalSeconds, dispatchIntervalSeconds: master.run.dispatchIntervalSeconds, cycles: result.cycles.length, failedCycles: result.failed.length, stopped: result.stopped ? 'signal' : result.reloading ? 'reloading' : 'completed', ...(result.reloading ? { reloading: result.reloading } : {}), last: result.cycles.at(-1) ?? null, lastFailure: result.failed.at(-1) ?? null,
      dispatch: { ticks: dispatched.ticks.length, launched: dispatched.ticks.reduce((total, tick) => total + tick.launched.length, 0), refused: dispatched.ticks.reduce((total, tick) => total + tick.refused.length, 0), last: dispatched.ticks.at(-1) ?? null } });
  }
  return unhandled;
}
