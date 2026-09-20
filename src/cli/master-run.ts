import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { daemonExecutor, liveMasterConfig, mergeExecutor, type MasterConfig } from '../master.js';
import { daemonEffects, readDaemonState, runDaemon } from '../master-daemon.js';
import { dispatchEffects, dispatchReadTimeoutMs, readDispatchCursor, runAutoDispatch } from '../auto-dispatch.js';
import { coordinationViewHeader } from '../server/work-view.js';

/**
 * `master run`: the durable loop and automatic dispatch, on one host, under one credential.
 *
 * Both halves read the same bounded coordination view and write through the same coordinator
 * mutation — which is also what records the handle of every session the dispatcher launches, so a
 * reviewer or producer it starts is as visible as one an executor starts. The loop is no longer
 * the planner: the control plane computes the typed actions and executors run them
 * (docs/master-agent.md), and this stays for the hosts that run the daemon.
 */
export interface MasterLoopDeps {
  /** The coordinator's own status response, already bound to this master configuration. */
  coordinator: any;
  masterToken: string;
  api: (path: string, credential?: string, timeoutMs?: number, headers?: Record<string, string>) => Promise<any>;
  mutate: (path: string, data: unknown, requestId?: string, credential?: string) => Promise<any>;
  /** Refuses a server whose merge protocol this CLI does not speak; re-checked before every merge. */
  assertProtocol: (status: any) => void;
}

export async function runMasterLoop(root: string, master: MasterConfig, args: string[], deps: MasterLoopDeps) {
  const { coordinator, masterToken, api, mutate, assertProtocol } = deps;
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
  const coordinationSnapshot = (timeoutMs?: number) => api('work-snapshot', masterToken, timeoutMs, { [coordinationViewHeader]: 'coordination' });
  const executor = daemonExecutor(coordinator.actor.id);
  const effects = daemonEffects(root, current, { snapshot: () => coordinationSnapshot(), mutate, executor });
  const guardedMerge: typeof effects.merge = work => mergeExecutor(current(), () => api('work-snapshot'), mutate, executor, randomUUID())(work);
  // The loop outlives deployments: every guarded merge re-reads the server's protocol first.
  effects.merge = async work => { assertProtocol(await api('status')); return guardedMerge(work); };
  // Automatic dispatch runs beside the cycle on a shorter cadence; it stops with the daemon. It
  // carries the same mutation, so the sessions it launches record their durable handles.
  const dispatchCursor = await readDispatchCursor(root, master);
  const stopping = new AbortController();
  const daemonRun = runDaemon(master, state, effects, { once: values.once, intervalMs: values.interval ? intervalSeconds * 1000 : () => current().run.intervalSeconds * 1000, identity: { pid: process.pid, host: master.hostId }, reload }).finally(() => stopping.abort());
  const dispatchRun = runAutoDispatch(master, dispatchCursor, dispatchEffects(root, current, { snapshot: () => coordinationSnapshot(dispatchReadTimeoutMs), mutate }), { once: values.once, intervalMs: () => current().run.dispatchIntervalSeconds * 1000, signal: stopping.signal, reload });
  const [result, dispatched] = await Promise.all([daemonRun, dispatchRun]);
  return { repository: master.repository, coordinator: coordinator.actor.id, intervalSeconds, dispatchIntervalSeconds: master.run.dispatchIntervalSeconds, cycles: result.cycles.length, stopped: result.stopped ? 'signal' : 'completed', last: result.cycles.at(-1) ?? null,
    dispatch: { ticks: dispatched.ticks.length, launched: dispatched.ticks.reduce((total, tick) => total + tick.launched.length, 0), refused: dispatched.ticks.reduce((total, tick) => total + tick.refused.length, 0), last: dispatched.ticks.at(-1) ?? null } };
}
