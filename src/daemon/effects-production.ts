// Concern: the production wiring of the cycle's effects — every read, launch and write the loop runs, bound to one coordinator process.
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type ChildRun, childRunner } from '../child-runner.js';
import type { Work } from '../model.js';
import { RefusedResponse } from '../model/refusal.js';
import { sweepManagedCheckouts } from '../producer.js';
import { endRegistrySlot, endRegistrySessionById } from '../master/registry-slot.js';
import { dispatchEffects, readDispatchCursor, runDispatchTick, type DispatchCursor } from '../auto-dispatch.js';
import { masterProfile, masterSessionEffects } from '../master/master-session.js';
import { type MasterConfig, agentToken, listHerdrAgents, closeHerdrPane, observeHerdrAgents, herdrJson, readSessionScreen, inspectWorkerCredentials, dispatchWork, preservePartialWork, removeAttemptWorktree, profileAccount, recordObservedExhaustion, sessionAccount } from '../master.js';
import { type DaemonState, writeDaemonState } from './state.js';
import { writeProjectMemory } from '../project-memory.js';
import { mergeRecordKey, mergeWriterReads } from './cycle-merge-writer.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { loopCodeRoot } from './checkout-state.js';
import { readRelease } from '../protocol-version.js';
import { loopRunAdoption } from './run-adoption.js';
import { refusedBodyDetail, type DaemonEffects } from './effects.js';
import { composeServer } from './compose-recovery.js';
import { installDirectory, readInstallRecord } from '../install/secrets.js';
import { installIdFor } from '../install/types.js';

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
    // The loop's one stall re-prompt (GY-2943), delivered to the session's pane as its runtime accepts prompts.
    promptSession: async (session, text) => { const target = session.pane ?? session.agentName; if (!target) throw new Error(`the session has neither a pane nor a runtime name to prompt`); await herdrJson(['agent', 'prompt', target, text], run); },
    // GY-2959: the reject key that answers a blocked session's own permission prompt, as the launcher answers a consent prompt.
    sessionKeys: async (session, keys) => { const target = session.pane ?? session.agentName; if (!target) throw new Error(`the session has neither a pane nor a runtime name to send keys to`); await herdrJson(['agent', 'send-keys', target, ...keys], run); },
    sessionScreen: session => session.pane || session.agentName ? readSessionScreen(session.pane ?? session.agentName!, run) : null,
    // GY-2943: the stalled attempt ends through the capacity record — `interrupted` when its pane
    // showed no provider limit notice, `quota` with the notice's reset when it did, so the account
    // the notice spent is held here (and rides every selection) before the item is dispatchable again.
    endStall: async (item, session, stall) => {
      const config = current();
      const profile = config.workers.find(candidate => candidate.principal === session.principal);
      const name = profile?.name ?? session.principal, epoch = session.epoch ?? Number(/:(\d+)$/.exec(session.id)?.[1]);
      const account = profile && Number.isFinite(epoch) ? (await sessionAccount(root, config, 'worker', profile.name, { work: item.key, epoch }))?.environment ?? null : null;
      if (stall.notice) await recordObservedExhaustion(config, account ?? profileAccount(name), { at: new Date().toISOString(), resetsAt: stall.notice.resetsAt, reason: stall.notice.reason, role: 'worker', profile: name, work: item.key }, undefined, {});
      await mutate(`work/${item.id}/capacity`, {
        event: 'exhausted', role: 'worker', epoch, ...(stall.notice ? {} : { cause: 'interrupted' }),
        profile: name, account, runtime: session.runtime,
        reason: `${stall.reason}${stall.notice ? ` on its provider's limit notice: ${stall.notice.reason}` : ''}`.slice(0, 500),
        resetsAt: stall.notice?.resetsAt ?? null,
        partialWork: { state: 'not-applicable', detail: 'the stalled attempt left its worktree as it stood; the redispatch starts from the shared base' },
      }, randomUUID());
    },
    // GY-2953: a lease a supervisor's time bound or a worker's silence ended without a submission
    // still holds the attempt's work in its worktree. Before the cleanup removes that tree, the
    // uncommitted rest is committed on the attempt's own branch and the capacity record that ends
    // the lease names the commit, so the redispatch's handoff advertises it instead of sending the
    // next worker back to the shared base to redo the attempt blind.
    endExpiredLease: async (item, lease) => {
      const space = item.workspaces?.find(entry => entry.epoch === lease.epoch);
      if (!space || space.host !== current().hostId) return null;
      const partialWork = await preservePartialWork(space.path, `${item.key} attempt ${lease.epoch} expired`, run);
      await mutate(`work/${item.id}/capacity`, {
        event: 'exhausted', role: 'worker', epoch: lease.epoch, cause: 'interrupted',
        profile: lease.owner.slice(0, 80), account: null, runtime: null,
        reason: 'was ended by its lapsed lease: nothing was submitted, and its uncommitted work was kept before the worktree cleanup',
        resetsAt: null, partialWork,
      }, randomUUID());
      return partialWork;
    },
    // GY-2961: the attempt bound's reading of the attempt's worktree — the HEAD commit and a
    // fingerprint of the uncommitted changes, so a change of either is the progress the bound
    // extends by. A worktree that cannot be read shows no progress, as a gone worktree should.
    worktreeState: async space => {
      const git = async (...args: string[]) => String(await run('git', ['-C', space.path, ...args], { timeoutMs: 30_000 })).trim();
      let head: string | null;
      try { head = (await git('rev-parse', 'HEAD')) || null; } catch { return null; }
      const dirty = await git('status', '--porcelain').then(out => out ? createHash('sha256').update(out).digest('hex').slice(0, 16) : null, () => null);
      return { head, dirty };
    },
    // GY-2961: the attempt bound's stop — the same preservation a lapsed lease gets (a successor
    // receives the diff), with the bound named on the capacity record that releases the lease. The
    // record is written even when this host holds no registered worktree to preserve from, so the
    // stop always ends the attempt it names.
    endAttemptBound: async (item, session, why) => {
      const config = current();
      const epoch = session.epoch ?? Number(/:(\d+)$/.exec(session.id)?.[1]);
      const space = Number.isSafeInteger(epoch) ? item.workspaces?.find(entry => entry.epoch === epoch) : undefined;
      const partialWork = space && space.host === config.hostId
        ? await preservePartialWork(space.path, `${item.key} attempt ${epoch} stopped at its attempt bound`, run)
        : { state: 'not-applicable' as const, detail: 'the bound stop found no registered worktree on this host to keep work from' };
      await mutate(`work/${item.id}/capacity`, {
        event: 'exhausted', role: 'worker', epoch, cause: 'interrupted',
        profile: session.principal.slice(0, 80), account: null, runtime: session.runtime?.slice(0, 40) ?? null,
        reason: `stopped by the attempt bound: ${why}`.slice(0, 500),
        resetsAt: null, partialWork,
      }, randomUUID());
      return partialWork;
    },
    // The agent-registry session a review or proof session ran under, ended when the close step
    // judges it over (GY-2944): the ledgers name it, the fleet client ends it.
    releaseRegistrySession: (session, reason) => endRegistrySlot(root, current(), session, reason),
    reclaimLease: work => mutate(`work/${work.id}/resync`, {}, randomUUID()),
    removeWorktree: path => removeAttemptWorktree(root, path, run),
    sweepCheckouts: () => sweepManagedCheckouts(root, current()),
    // GY-2966: the compose install this host recorded for the repository, whose server the loop starts when the control plane stays unreachable.
    composeServer: async () => {
      const directory = installDirectory(installIdFor(current().repository));
      return (await readInstallRecord(directory).catch(() => null))?.provider === 'compose' ? composeServer(join(directory, 'compose'), run) : null;
    },
    dispatch: (work, profile, agents, snapshot) => dispatchWork(root, work, profile, agents, run, snapshot.work, undefined, undefined, undefined, snapshot.now, { agents: () => listHerdrAgents(run) }),
    // The reviewer and producer sessions the dispatcher owes, over the cycle's own snapshot; a tick
    // still running past its step's timeout is not started twice.
    dispatchTick: snapshot => ticking ??= (async () => {
      cursor ??= await readDispatchCursor(root, current());
      return runDispatchTick(current(), cursor, dispatchEffects(root, current, { snapshot: async () => snapshot, mutate, run }));
    })().finally(() => { ticking = null; }),
    personalMasterSession: config => ({
      ...masterSessionEffects(root, () => config, run),
      end: (session, reason) => endRegistrySessionById(config, session, reason),
      exhaust: (account, notice) => recordObservedExhaustion(config, account, { at: new Date().toISOString(), reason: notice.reason, resetsAt: notice.resetsAt, role: 'master', profile: masterProfile, work: null }),
    }),
    masterSession: {
      ...masterSessionEffects(root, current, run),
      // GY-2949: the master pane's limit notice holds its account exactly as a worker's holds theirs,
      // so the role's next selection — the launch the same cycle makes — passes the spent account by.
      exhaust: async (account, notice) => {
        await recordObservedExhaustion(current(), account, { at: new Date().toISOString(), reason: notice.reason, resetsAt: notice.resetsAt, role: 'master', profile: masterProfile, work: null });
      },
      // The registry session the closed or vanished pane ran under is ended, so the role's one slot frees for the next account; the registry's end is idempotent.
      end: (session, reason) => endRegistrySessionById(current(), session, reason),
    },
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
