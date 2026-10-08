// Concern: `graphyard master run` — wiring the durable loop and automatic dispatch to their effects.
import { parseArgs } from 'node:util';
import { liveMasterConfig } from '../../master.js';
import { daemonEffects, readDaemonState, retriedSnapshot, runDaemon } from '../../master-daemon.js';
import { dispatchEffects, dispatchReadTimeoutMs, readDispatchCursor, runAutoDispatch } from '../../auto-dispatch.js';
import { coordinationViewHeader } from '../../server/work-view.js';
import { loopPresenceHeader, loopSupervisionHeader } from '../../model/executor-presence.js';
import { LoopWake, loopWakeSubjects } from '../../daemon/loop-wake.js';
import { unhandled, type MasterSession } from './session.js';

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
    // server answers with whole documents). GitHub merges; the loop runs no merge of its own.
    const live = liveMasterConfig(root, master), current = () => live.current, reload = () => live.reload();
    // Each read also names the loop to the control plane (GY-916), which then knows the merger lives,
    // and who reviews and merges (GY-1501), which the dashboard's Setup checklist reads.
    const loopInterval = () => values.interval ? intervalSeconds : current().run.intervalSeconds;
    const coordinationSnapshot = (timeoutMs?: number) => masterApi('work-snapshot', masterToken, timeoutMs, { [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: String(loopInterval()), [loopSupervisionHeader]: current().supervision ?? 'autonomous' });
    const effects = daemonEffects(root, current, { snapshot: retriedSnapshot(() => coordinationSnapshot()), mutate: masterMutation });
    // Automatic dispatch runs beside the cycle on a shorter cadence; it stops with the daemon. Its
    // snapshot fetch is bounded by the tick's own read bound, which grows while ticks fail (GY-1373).
    const dispatchCursor = await readDispatchCursor(root, master);
    const stopping = new AbortController();
    // GY-1490: the dispatcher's tick wakes the loop's sleep for anything new its next cycle acts on,
    // never sooner than one dispatch interval after the cycle before.
    const wake = new LoopWake(() => current().run.dispatchIntervalSeconds * 1000);
    const daemonRun = runDaemon(master, state, effects, { once: values.once, intervalMs: values.interval ? intervalSeconds * 1000 : () => current().run.intervalSeconds * 1000, identity: { pid: process.pid, host: master.hostId }, reload, repository: root, wake }).finally(() => stopping.abort());
    const dispatching = { ...dispatchEffects(root, current, { snapshot: (timeoutMs = dispatchReadTimeoutMs) => coordinationSnapshot(timeoutMs) }),
      observeLoopSubjects: (work: Parameters<typeof loopWakeSubjects>[0], agents: Parameters<typeof loopWakeSubjects>[3], clock: number) => { wake.observe(loopWakeSubjects(work, current(), clock, agents)); } };
    const dispatchRun = runAutoDispatch(master, dispatchCursor, dispatching, { once: values.once, intervalMs: () => current().run.dispatchIntervalSeconds * 1000, signal: stopping.signal, reload });
    const [result, dispatched] = await Promise.all([daemonRun, dispatchRun]);
    // A cycle that threw was recorded and retried in-process (GY-119); it is reported here, never as an exit.
    return print({ repository: master.repository, coordinator: coordinator.actor.id, intervalSeconds, dispatchIntervalSeconds: master.run.dispatchIntervalSeconds, cycles: result.cycles.length, failedCycles: result.failed.length, stopped: result.stopped ? 'signal' : 'completed', last: result.cycles.at(-1) ?? null, lastFailure: result.failed.at(-1) ?? null,
      dispatch: { ticks: dispatched.ticks.length, launched: dispatched.ticks.reduce((total, tick) => total + tick.launched.length, 0), refused: dispatched.ticks.reduce((total, tick) => total + tick.refused.length, 0), last: dispatched.ticks.at(-1) ?? null } });
  }
  return unhandled;
}
