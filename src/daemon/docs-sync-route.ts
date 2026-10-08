// Concern: the docs-sync route of a confirmed base conflict (GY-566) — classify it once per head
// and base tip, hold the item while its docs-sync session runs (found by the session's own item and
// head, across base moves: GY-1423, re-classified on each: GY-1436), and log either route for the
// hotspot report.
import type { Work } from '../model.js';
import type { HerdrAgent } from '../master.js';
import { message, type DaemonActionKind, type DaemonState } from './state.js';
import type { FaultKind } from '../model/fault-classes.js';
import type { DaemonEffects } from './effects.js';
import { conflictRoute, docsSyncHoldDeadline, docsSyncHoldMs, docsSyncStallMs, docsSyncWatchFor, docsSyncWatchKey, docsSyncWatchSchema, routedConflictRetention, routedConflictSchema, routedConflictWindowMs, type DocsSyncWatch } from '../model/docs-sync.js';
import { docsSyncSessionName, docsSyncStoppedMs, type DocsSyncPlan } from '../docs-sync.js';
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
 * the conflict first being recorded on the head (GY-1434). A docs-sync is launched only before its
 * cutoff, docsSyncCutoffLeadMs ahead of that bound; one still running at the cutoff is stopped then,
 * so nothing it does lands later, and gives the conflict up once an observation taken since — the
 * step wakes one at once — shows the head unmoved. A push that landed before the cutoff is observed
 * and adopted, never reworked, and the rework is requested inside the bound rather than after
 * docsSyncMaxMs.
 *
 * GY-1436. A hold is never a bare skip: `hold` answers what the step must record. A standing hold
 * names its session, head, base and deadline, which the step records as the item's wait; it lasts
 * at most docsSyncHoldMs, the blocked bound, and past half of it is raised as attention naming the
 * session. A base tip that moved since the watch was classified is classified again for the new
 * head-and-base pair: a conflict there that is not docs-only ends the hold. A hold that ended —
 * session gone, stopped or past its bound — while no observation since shows the head unmoved is
 * `awaiting` that observation: the step wakes the item's observation job for it rather than wait
 * for one to arrive unprompted.
 */
/** GY-1434: how far ahead of the loop-owned rework's bound a docs-sync is stopped, so the observation its give-up waits for lands inside the bound. */
export const docsSyncCutoffLeadMs = 2 * 60_000;
export type DocsSyncHold =
  | { held: true; watch: DocsSyncWatch; deadline: string; wait: string }
  | { held: false; awaiting?: string };
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
  /** A routed conflict that ended up with a worker is counted as sent back: its session's, whatever base tip it was routed on (GY-1436). */
  const markRework = (work: string, head: string) => {
    state.conflicts = state.conflicts.map(entry => entry.work === work && entry.head === head && entry.route === 'docs-sync' ? { ...entry, route: 'rework' } : entry);
  };
  /** Close a docs-sync session's tab, if Herdr still lists it. */
  const stop = async (watch: DocsSyncWatch) => {
    const listed = watch.agentName ? (await sessions()).agents.find(agent => agent.name === watch.agentName) : undefined;
    if (listed?.pane_id) { try { await effects.closeSession(listed.pane_id); } catch { /* the session report closes it once the pane is gone */ } inventorySpent(); }
  };
  /** Close a docs-sync session's tab, if Herdr still lists it, give its registry session back, and remove its role file (GY-1433). */
  const settle = async (item: Work | undefined, watch: DocsSyncWatch, why: string) => {
    await stop(watch);
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
  /** The conflicted paths of this head and base: the loop's own merge where it can, else the control plane's record. */
  const conflicted = async (item: Work, head: string, base: string) => {
    const local = await effects.conflictPaths?.(item, head, base).catch(() => null) ?? null;
    return local?.length ? local : item.baseRefresh!.conflictPaths ?? null;
  };
  /** The standing hold, as the step records it: session, head, base and the deadline of its bound. */
  const standing = async (item: Work, key: string, watch: DocsSyncWatch, cutoff: number | null): Promise<DocsSyncHold> => {
    // The earlier of its own bound and the loop-owned rework's cutoff (GY-1434).
    const deadline = new Date(Math.min(docsSyncHoldDeadline(watch), cutoff ?? Infinity)).toISOString(), session = watch.agentName ?? 'unnamed';
    // Past half its bound without moving the head: raised once, naming the session, before the silence budget could (GY-1436).
    const stallKey = `escalation:docs-sync-stall:${key}`;
    if (clock - Date.parse(watch.launchedAt) >= docsSyncStallMs && !state.actions[stallKey])
      await note(stallKey, item, 'escalation', 'done', `${item.key}: docs-sync session ${session} has held the conflict of ${watch.head.slice(0, 12)} with base ${watch.base.slice(0, 12)} past half its ${docsSyncHoldMs / 60_000}-minute bound without moving the head; at ${deadline} the conflict returns to a worker (close the session to return it now)`);
    return { held: true, watch, deadline, wait: `${item.key}: rework decision held by docs-sync session ${session} on head ${watch.head.slice(0, 12)} against base ${watch.base.slice(0, 12)} until ${deadline}, the end of its ${docsSyncHoldMs / 60_000}-minute bound` };
  };
  /**
   * The docs-sync hold on the item's conflict, as the step records it. `observe` wakes the item's observation and
   * returns the fresh reading, or null when none landed this cycle (the step then wakes the job for the next).
   */
  const hold = async (item: Work, observe?: (item: Work) => Promise<Work | null>): Promise<DocsSyncHold> => {
    const refresh = item.baseRefresh!, head = refresh.from.sha, base = refresh.base;
    const found = docsSyncWatchFor(state.docsSyncs, item, head), key = found?.key ?? docsSyncWatchKey(item, head), watch = found?.watch;
    // GY-1434: the loop-owned rework's bound, which no docs-sync may outlast; it is stopped a lead ahead of it.
    const due = conflictReworkDue(item, clock), cutoff = due ? Date.parse(due.dueAt) - docsSyncCutoffLeadMs : null, bounded = cutoff !== null && clock >= cutoff;
    const boundReason = due ? `the conflict was first recorded on ${head.slice(0, 12)} at ${due.since}, and the loop requests its rework within ${conflictReworkBoundMs / 60_000} minutes of that (due at ${due.dueAt}), stopping a docs-sync ${docsSyncCutoffLeadMs / 60_000} minutes before` : '';
    const observedSince = (work: Work, at: string) => !!work.observation && Date.parse(work.observation.at) > Date.parse(at);
    if (!watch) {
      if (state.conflicts.some(entry => entry.work === item.key && entry.head === head && entry.base === base)) return { held: false };
      const paths = await conflicted(item, head, base);
      const routed = !effects.docsSync ? { route: 'rework' as const, reason: 'this loop has no docs-sync launcher' }
        : bounded ? { route: 'rework' as const, reason: `${boundReason}, so no docs-sync session is launched this late` }
        : conflictRoute(paths);
      state.conflicts = [...state.conflicts, routedConflictSchema.parse({ work: item.key, head, base, at: stamp, paths: (paths ?? []).slice(0, 200).map(path => path.slice(0, 500)), route: routed.route })].slice(-routedConflictRetention);
      await effects.persist(state);
      if (routed.route === 'rework') return { held: false };
      const plan: DocsSyncPlan = { key: item.key, pr: item.candidate!.pr, branch: item.candidate!.branch, baseBranch: config.baseBranch, head, base, paths: paths! };
      const actionKey = `docs-sync:${key}`;
      // GY-1430: the session this item and head name is already running, so the loop holds it again.
      const name = docsSyncSessionName(plan), running = (await sessions()).agents.find(agent => agent.name === name);
      if (running) {
        state.docsSyncs[key] = docsSyncWatchSchema.parse({ work: item.key, head, base, paths: plan.paths, agentName: name, pane: running.pane_id ?? null, launchedAt: stamp });
        await note(actionKey, item, 'decision', 'done', `Adopted docs-sync session ${name}, already running in Herdr for ${item.key} at ${head.slice(0, 12)}: ${routed.reason}; no rework decision is requested while it runs`);
        return standing(item, key, state.docsSyncs[key], cutoff);
      }
      try {
        const launched = await effects.docsSync!(item, plan); inventorySpent();
        state.docsSyncs[key] = docsSyncWatchSchema.parse({ work: item.key, head, base, paths: plan.paths, agentName: launched.agentName, pane: launched.pane, session: launched.session, launchedAt: stamp });
        await note(actionKey, item, 'decision', 'done', `Launched docs-sync session ${launched.agentName}${launched.account ? ` on ${launched.account}` : ''} for ${item.key}: ${routed.reason}; no rework decision is requested, and the approval is kept if the diff outside docs/ is unchanged`);
        return standing(item, key, state.docsSyncs[key], cutoff);
      } catch (error) {
        state.docsSyncs[key] = docsSyncWatchSchema.parse({ work: item.key, head, base, paths: plan.paths, agentName: null, pane: null, launchedAt: stamp, failed: `the docs-sync session could not be launched: ${message(error)}`.slice(0, 1000), settledAt: stamp });
        markRework(item.key, head);
        await note(actionKey, item, 'decision', 'failed', `Could not launch the docs-sync session for ${item.key}, so the conflict returns to a worker: ${message(error)}`);
        return { held: false };
      }
    }
    if (watch.failed) return { held: false };
    // GY-1436: the base tip moved since the watch was classified. The session keeps its identity
    // (GY-1423), but the conflict is the new pair's: one there that is not docs-only is a worker's.
    if (watch.base !== base && !watch.goneAt) {
      const paths = await conflicted(item, head, base), routed = conflictRoute(paths);
      if (routed.route === 'rework') {
        watch.failed = `the base moved from ${watch.base.slice(0, 12)} to ${base.slice(0, 12)} and its conflict with ${head.slice(0, 12)} is no longer docs-only: ${routed.reason}`.slice(0, 1000);
        watch.settledAt = stamp;
        await settle(item, watch, watch.failed);
        markRework(item.key, head);
        await note(`docs-sync:${key}`, item, 'decision', 'failed', `${item.key}: ${watch.failed}, so the docs-sync hold ends`, undefined, null);
        return { held: false };
      }
      watch.base = base; watch.paths = paths!;
      await effects.persist(state);
    }
    // At the cutoff the docs-sync is stopped first, so nothing it does lands after goneAt; only an
    // observation taken since, still on the reviewed head, shows it gave the conflict up. One that
    // pushed before the cutoff moved the head: its head is adopted and the sweep settles it.
    if (bounded) {
      if (!watch.goneAt) { watch.goneAt = stamp; await stop(watch); await effects.persist(state); }
      let seen = item;
      if (!observedSince(seen, watch.goneAt) && observe) seen = await observe(item) ?? item;
      const cutoffWait = { held: true as const, watch, deadline: due!.dueAt, wait: `${item.key}: docs-sync session ${watch.agentName ?? 'for it'} on head ${head.slice(0, 12)} against base ${watch.base.slice(0, 12)} was stopped at ${watch.goneAt}, its cutoff; the rework due at ${due!.dueAt} waits for an observation since showing the head unmoved` };
      if (seen.candidate?.sha !== head || (seen.observation && seen.observation.candidate.sha !== head)) return cutoffWait;
      if (!observedSince(seen, watch.goneAt)) return cutoffWait;
      watch.failed = `docs-sync session ${watch.agentName ?? 'for it'} was stopped at ${watch.goneAt} without having moved ${head.slice(0, 12)}, as an observation at ${seen.observation!.at} shows: ${boundReason}`.slice(0, 1000);
      watch.settledAt = stamp;
      await settle(item, watch, watch.failed);
      markRework(item.key, head);
      // GY-1541: the cutoff stop is the loop's own designed route (GY-1434), as the own-accord stop below is: no decision fault.
      await note(`docs-sync:${key}`, item, 'decision', 'failed', `${item.key}: ${watch.failed}, so the conflict returns to a worker`, undefined, null);
      return { held: false };
    }
    // A hold the loop found ended stays ended (GY-1436): a session Herdr lists working again before
    // the observation lands does not resurrect it, so its rework follows within the cycle, not at the bound.
    if (!watch.goneAt) {
      const seen = await sessions(), listed = watch.agentName ? seen.agents.find(agent => agent.name === watch.agentName) : undefined;
      // A runtime that stopped (idle or done) ended its turn: the session pushed, or aborted and stopped.
      if (listed && ['idle', 'done'].includes(listed.agent_status ?? '')) watch.stoppedAt ??= stamp; else if (listed) delete watch.stoppedAt;
      const stopping = !!listed && !!watch.stoppedAt && clock - Date.parse(watch.stoppedAt) >= docsSyncStoppedMs;
      if (clock < docsSyncHoldDeadline(watch) && !stopping && (listed || !seen.available)) { if (listed) await effects.persist(state); return standing(item, key, watch, cutoff); }
      // Gone, or past its bound: the push may not have been observed yet. Only an observation taken
      // after the loop found that, still on the reviewed head, shows the docs-sync gave up; the step
      // wakes the observation job for it (GY-1436) instead of holding until one arrives unprompted.
      watch.goneAt = stamp;
    }
    // How the hold ended is read at the moment the loop found it ended, whichever cycle settles it.
    const endedAt = Date.parse(watch.goneAt), overdue = endedAt >= docsSyncHoldDeadline(watch);
    const stopped = !!watch.stoppedAt && endedAt - Date.parse(watch.stoppedAt) >= docsSyncStoppedMs;
    if (!(item.observation && Date.parse(item.observation.at) > Date.parse(watch.goneAt))) { await effects.persist(state); return { held: false, awaiting: watch.goneAt }; }
    const aborted = !overdue && stopped;
    watch.failed = (overdue ? `the docs-sync session ran past its ${docsSyncHoldMs / 60_000}-minute bound without moving ${head.slice(0, 12)}`
      : aborted ? `docs-sync session ${watch.agentName} stopped without moving ${head.slice(0, 12)}`
      : `docs-sync session ${watch.agentName} ended without moving ${head.slice(0, 12)}`).slice(0, 1000);
    watch.settledAt = stamp;
    await settle(item, watch, watch.failed);
    markRework(item.key, head);
    await note(`docs-sync:${key}`, item, 'decision', 'failed', `${item.key}: ${watch.failed}, so the conflict returns to a worker`, undefined, aborted ? null : undefined);
    return { held: false };
  };
  /** Whether a docs-sync holds the item's conflict. */
  const holds = async (item: Work, observe?: (item: Work) => Promise<Work | null>) => (await hold(item, observe)).held;
  return { hold, holds, sweep };
}
