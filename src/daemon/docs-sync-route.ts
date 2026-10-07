// Concern: the docs-sync route of a confirmed base conflict (GY-566) — classify it once per head
// and base tip, hold the item while its docs-sync session runs (found by the session's own item and
// head, across base moves: GY-1423), and log either route for the hotspot report.
import type { Work } from '../model.js';
import type { HerdrAgent } from '../master.js';
import { message, type DaemonActionKind, type DaemonState } from './state.js';
import type { FaultKind } from '../model/fault-classes.js';
import type { DaemonEffects } from './effects.js';
import { conflictRoute, docsSyncWatchFor, docsSyncWatchKey, docsSyncWatchSchema, routedConflictRetention, routedConflictSchema, routedConflictWindowMs, type DocsSyncWatch } from '../model/docs-sync.js';
import { docsSyncMaxMs, docsSyncSessionName, docsSyncStoppedMs, type DocsSyncPlan } from '../docs-sync.js';
import { conflictReworkBoundMs, conflictReworkDue } from '../model/approval.js';

/**
 * The decision step's docs-sync route. A confirmed conflict of the current head is classified once
 * per head and base tip, and logged for the hotspot report. One confined to docs pages goes to a
 * docs-sync session instead of a rework decision; `holds` is true while that session holds the
 * item. The session is found by its own identity — item and head, as it is named — so a base tip
 * that moves while it runs leaves it holding the item rather than launching it a second time
 * (GY-1423). A session of that name already visible in Herdr when the loop holds no watch for it —
 * the watch was lost to a restart, or written by a loop that keyed it by base tip — is adopted, not
 * launched again and refused (GY-1430). A docs-sync that ends — its pane gone, or its runtime
 * stopped for docsSyncStoppedMs, as its instruction says it stops when it aborts — or runs past its
 * bound while an observation taken since still shows the same head gave the conflict up, and the
 * rework decision follows as before, as it does for every conflict that touches anything else. One
 * that stopped of its own accord took the route its instruction names, so it is no decision fault;
 * one that vanished or ran past its bound still is.
 *
 * On a system-driven item the rework is the loop's own round, due within conflictReworkBoundMs of
 * the conflict first being recorded on the head (GY-1434): a docs-sync is launched only inside that
 * bound, and one that has not moved the head when it passes gives the conflict up in the same cycle,
 * so the rework is requested then rather than after docsSyncMaxMs.
 */
export function docsSyncRoute({ config, state, effects, snapshot, sessions, note, inventorySpent, stamp, clock }: {
  config: { baseBranch: string };
  state: DaemonState;
  effects: Pick<DaemonEffects, 'conflictPaths' | 'docsSync' | 'docsSyncSettled' | 'persist' | 'closeSession' | 'endRegistrySession'>;
  snapshot: { work: Work[] };
  sessions: () => Promise<{ agents: HerdrAgent[]; available: boolean }>;
  note: (key: string, item: Work, kind: DaemonActionKind, outcome: 'done' | 'failed', detail: string, at?: number, faultKind?: FaultKind | null) => Promise<unknown>;
  inventorySpent: () => void;
  stamp: string;
  clock: number;
}) {
  /** A routed conflict that ended up with a worker is counted as sent back. */
  const markRework = (work: string, head: string, base: string) => {
    state.conflicts = state.conflicts.map(entry => entry.work === work && entry.head === head && entry.base === base ? { ...entry, route: 'rework' } : entry);
  };
  /** Close a docs-sync session's tab, if Herdr still lists it, give its registry session back, and remove its role file (GY-1433). */
  const settle = async (item: Work | undefined, watch: DocsSyncWatch, why: string) => {
    const listed = watch.agentName ? (await sessions()).agents.find(agent => agent.name === watch.agentName) : undefined;
    if (listed?.pane_id) { try { await effects.closeSession(listed.pane_id); } catch { /* the session report closes it once the pane is gone */ } inventorySpent(); }
    if (watch.session && effects.endRegistrySession) { await effects.endRegistrySession(watch.session, why.slice(0, 500)).catch(() => undefined); watch.session = null; }
    await effects.docsSyncSettled?.({ key: watch.work, head: watch.head }).catch(() => undefined);
    await effects.persist(state);
  };
  // A docs-sync whose item moved off the reviewed head succeeded (the control plane adopted the
  // synced head) or was overtaken; either way its session is done. Records are kept a day.
  const sweep = async () => {
    for (const [key, watch] of Object.entries(state.docsSyncs)) {
      const item = snapshot.work.find(entry => entry.key === watch.work);
      if (!watch.settledAt && (!item || item.stage === 'done' || item.candidate?.sha !== watch.head)) { watch.settledAt = stamp; await settle(item, watch, `the docs-sync of ${watch.work} moved its head off ${watch.head.slice(0, 12)}`); }
      if (watch.settledAt && clock - Date.parse(watch.settledAt) > routedConflictWindowMs) delete state.docsSyncs[key];
    }
  };
  const holds = async (item: Work): Promise<boolean> => {
    const refresh = item.baseRefresh!, head = refresh.from.sha, base = refresh.base;
    const found = docsSyncWatchFor(state.docsSyncs, item, head), key = found?.key ?? docsSyncWatchKey(item, head), watch = found?.watch;
    // GY-1434: the loop-owned rework's bound, which no docs-sync may outlast.
    const due = conflictReworkDue(item, clock), bounded = !!due && clock >= Date.parse(due.dueAt);
    const boundReason = due ? `the conflict was first recorded on ${head.slice(0, 12)} at ${due.since}, and the loop requests its rework within ${conflictReworkBoundMs / 60_000} minutes of that (due at ${due.dueAt})` : '';
    if (!watch) {
      if (state.conflicts.some(entry => entry.work === item.key && entry.head === head && entry.base === base)) return false;
      const local = await effects.conflictPaths?.(item, head, base).catch(() => null) ?? null;
      const paths = local?.length ? local : refresh.conflictPaths ?? null;
      const routed = !effects.docsSync ? { route: 'rework' as const, reason: 'this loop has no docs-sync launcher' }
        : bounded ? { route: 'rework' as const, reason: `${boundReason}, so no docs-sync session is launched past it` }
        : conflictRoute(paths);
      state.conflicts = [...state.conflicts, routedConflictSchema.parse({ work: item.key, head, base, at: stamp, paths: (paths ?? []).slice(0, 200).map(path => path.slice(0, 500)), route: routed.route })].slice(-routedConflictRetention);
      await effects.persist(state);
      if (routed.route === 'rework') return false;
      const plan: DocsSyncPlan = { key: item.key, pr: item.candidate!.pr, branch: item.candidate!.branch, baseBranch: config.baseBranch, head, base, paths: paths! };
      const actionKey = `docs-sync:${key}`;
      // GY-1430: the session this item and head name is already running, so the loop holds it again.
      const name = docsSyncSessionName(plan), running = (await sessions()).agents.find(agent => agent.name === name);
      if (running) {
        state.docsSyncs[key] = docsSyncWatchSchema.parse({ work: item.key, head, base, paths: plan.paths, agentName: name, pane: running.pane_id ?? null, launchedAt: stamp });
        await note(actionKey, item, 'decision', 'done', `Adopted docs-sync session ${name}, already running in Herdr for ${item.key} at ${head.slice(0, 12)}: ${routed.reason}; no rework decision is requested while it runs`);
        return true;
      }
      try {
        const launched = await effects.docsSync!(item, plan); inventorySpent();
        state.docsSyncs[key] = docsSyncWatchSchema.parse({ work: item.key, head, base, paths: plan.paths, agentName: launched.agentName, pane: launched.pane, session: launched.session, launchedAt: stamp });
        await note(actionKey, item, 'decision', 'done', `Launched docs-sync session ${launched.agentName}${launched.account ? ` on ${launched.account}` : ''} for ${item.key}: ${routed.reason}; no rework decision is requested, and the approval is kept if the diff outside docs/ is unchanged`);
        return true;
      } catch (error) {
        state.docsSyncs[key] = docsSyncWatchSchema.parse({ work: item.key, head, base, paths: plan.paths, agentName: null, pane: null, launchedAt: stamp, failed: `the docs-sync session could not be launched: ${message(error)}`.slice(0, 1000), settledAt: stamp });
        markRework(item.key, head, base);
        await note(actionKey, item, 'decision', 'failed', `Could not launch the docs-sync session for ${item.key}, so the conflict returns to a worker: ${message(error)}`);
        return false;
      }
    }
    if (watch.failed) return false;
    // Past the rework's bound the docs-sync gives the conflict up at once: the request that follows
    // waits for a fresh observation of the head and is bound to it, so a push it missed is not reworked.
    if (bounded) {
      watch.failed = `docs-sync session ${watch.agentName ?? 'for it'} had not moved ${head.slice(0, 12)} when the rework's bound passed: ${boundReason}`.slice(0, 1000);
      watch.settledAt = stamp;
      await settle(item, watch, watch.failed);
      markRework(item.key, head, watch.base);
      await note(`docs-sync:${key}`, item, 'decision', 'failed', `${item.key}: ${watch.failed}, so the conflict returns to a worker`);
      return false;
    }
    const seen = await sessions(), listed = watch.agentName ? seen.agents.find(agent => agent.name === watch.agentName) : undefined;
    const overdue = clock - Date.parse(watch.launchedAt) >= docsSyncMaxMs;
    // A runtime that stopped (idle or done) ended its turn: the session pushed, or aborted and stopped.
    if (listed && ['idle', 'done'].includes(listed.agent_status ?? '')) watch.stoppedAt ??= stamp; else if (listed) delete watch.stoppedAt;
    const stopped = !!listed && !!watch.stoppedAt && clock - Date.parse(watch.stoppedAt) >= docsSyncStoppedMs;
    if (!overdue && !stopped && (listed || !seen.available)) { if (listed) await effects.persist(state); return true; }
    // Gone, or past its bound: the push may not have been observed yet. Only an observation taken
    // after the loop found that, still on the reviewed head, shows the docs-sync gave up.
    watch.goneAt ??= stamp;
    if (!(item.observation && Date.parse(item.observation.at) > Date.parse(watch.goneAt))) { await effects.persist(state); return true; }
    const aborted = !overdue && stopped;
    watch.failed = (overdue ? `the docs-sync session ran past ${docsSyncMaxMs / 60_000} minutes without moving ${head.slice(0, 12)}`
      : aborted ? `docs-sync session ${watch.agentName} stopped without moving ${head.slice(0, 12)}`
      : `docs-sync session ${watch.agentName} ended without moving ${head.slice(0, 12)}`).slice(0, 1000);
    watch.settledAt = stamp;
    await settle(item, watch, watch.failed);
    markRework(item.key, head, watch.base);
    await note(`docs-sync:${key}`, item, 'decision', 'failed', `${item.key}: ${watch.failed}, so the conflict returns to a worker`, undefined, aborted ? null : undefined);
    return false;
  };
  return { holds, sweep };
}
