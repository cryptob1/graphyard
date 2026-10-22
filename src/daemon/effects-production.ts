// Concern: the production wiring of the cycle's effects — every read, launch and write the loop runs, bound to one coordinator process.
import { randomUUID } from 'node:crypto';
import { type ChildRun, childRunner } from '../child-runner.js';
import type { Work } from '../model.js';
import { RefusedResponse } from '../model/refusal.js';
import { sweepManagedCheckouts } from '../producer.js';
import { dispatchEffects, readDispatchCursor, runDispatchTick, type DispatchCursor } from '../auto-dispatch.js';
import { masterSessionEffects } from '../master/master-session.js';
import { type MasterConfig, agentToken, listHerdrAgents, closeHerdrPane, observeHerdrAgents, inspectWorkerCredentials, deliverPrompt, dispatchWork, removeAttemptWorktree } from '../master.js';
import { type DaemonState, writeDaemonState } from './state.js';
import { writeProjectMemory } from '../project-memory.js';
import { mergeRecordKey, mergeWriterReads } from './cycle-merge-writer.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { loopCodeRoot } from './checkout-state.js';
import { readRelease } from '../protocol-version.js';
import { loopRunAdoption } from './run-adoption.js';
import { promptTarget, refusedBodyDetail, type DaemonEffects } from './effects.js';

/** Effects bound to the real coordinator process; `config` may be a live source the loop reloads. */
export function daemonEffects(root: string, source: MasterConfig | (() => MasterConfig), deps: {
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  mutate: (path: string, data: unknown, requestId?: string) => Promise<any>;
  /** The child runner; a test's stub, or the process's own bounded asynchronous runner. */
  run?: ChildRun;
  fetcher?: typeof fetch;
}): DaemonEffects {
  const current = typeof source === 'function' ? source : () => source;
  const run = deps.run ?? childRunner({ timeoutMs: 90_000 });
  const fetcher = deps.fetcher ?? fetch;
  const mutate = deps.mutate;
  /** One call as the master's own operator-agent identity — the identity that applies its decisions. */
  const asOperatorAgent = async (path: string, body: unknown) => {
    const config = current();
    const token = await agentToken(root, config, 'operatorAgent');
    const response = await fetcher(`${config.url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    let result: any; try { result = JSON.parse(text); } catch { result = response.ok ? undefined : { text: text.slice(0, 200) }; }
    if (!response.ok) throw new RefusedResponse(`Graphyard refused ${path} (${response.status}): ${refusedBodyDetail(result)}`, response.status, result);
    return result;
  };
  const rework: DaemonEffects['rework'] = (work, reason, binding) => asOperatorAgent(`work/${work.id}/rework`, { reason, previousWorkerStopped: true, ...(binding ? { binding } : {}) });
  // The shared project memory (GY-1125) is mirrored to its own file only when it changed.
  let writtenMemory: string | null = null;
  const persist = async (state: DaemonState) => {
    const memory = state.projectMemory ? JSON.stringify(state.projectMemory) : null;
    if (memory && memory !== writtenMemory) await writeProjectMemory(root, state.projectMemory).then(() => { writtenMemory = memory; }, () => {});
    return writeDaemonState(current(), state);
  };
  let cursor: DispatchCursor | null = null, ticking: Promise<unknown> | null = null;
  return Object.defineProperties({
    snapshot: deps.snapshot,
    agents: () => listHerdrAgents(run).catch(() => []),
    herdr: async () => { const runtime = await observeHerdrAgents(run); return { agents: runtime.agents, available: runtime.available }; },
    credentials: profiles => inspectWorkerCredentials(root, profiles),
    closeSession: pane => closeHerdrPane(pane, run),
    recordSession: (work, handle) => mutate(`work/${work.id}/session`, handle),
    reclaimLease: work => mutate(`work/${work.id}/resync`, {}, randomUUID()),
    removeWorktree: path => removeAttemptWorktree(root, path, run),
    sweepCheckouts: () => sweepManagedCheckouts(root, current()),
    dispatch: (work, profile, agents, snapshot) => dispatchWork(root, work, profile, agents, run, snapshot.work, undefined, undefined, undefined, snapshot.now, { agents: () => listHerdrAgents(run) }),
    // The reviewer and producer sessions the dispatcher owes, over the cycle's own snapshot; a tick
    // still running past its step's timeout is not started twice.
    dispatchTick: snapshot => ticking ??= (async () => {
      cursor ??= await readDispatchCursor(root, current());
      return runDispatchTick(current(), cursor, dispatchEffects(root, current, { snapshot: async () => snapshot, mutate, run }));
    })().finally(() => { ticking = null; }),
    masterSession: masterSessionEffects(root, current, run),
    promptSession: async (agent, text) => { await deliverPrompt(promptTarget(agent), text, run); },
    // The executor merges in this checkout's object store, pushes with the install's deploy key alone and records each step as the coordinator under one key per (step, commits).
    get mergeWriter() { const config = current(); return mergeWriterReads(config, root, run, { base: worktreeRoot(root, config), record: (work, event) => mutate(`work/${work.id}/merge-record`, event, mergeRecordKey(work, event)), merger: async () => 'control-plane' as const }); },
    adoptRuns: loopRunAdoption(root, current, deps.fetcher),
    // Rework exists only while the live configuration names the master's operator-agent identity.
    get rework() { return current().operatorAgent ? rework : undefined; },
    // The release this process loaded: the checkout its code comes from, read once at startup.
    loadedRelease: readRelease(loopCodeRoot(current().cliPath, root)),
    notify: async state => { await run('systemd-notify', state === 'ready' ? ['--ready'] : ['WATCHDOG=1']); },
    persist,
  } satisfies DaemonEffects, {});
}
