// Concern: the docs-sync route of a confirmed base conflict (GY-566) — classify it once per head
// and base tip, hold the item while its docs-sync session runs, and log either route for the hotspot report.
import type { Work } from '../model.js';
import type { HerdrAgent } from '../master.js';
import { message, type DaemonActionKind, type DaemonState } from './state.js';
import type { DaemonEffects } from './effects.js';
import { conflictRoute, docsSyncWatchKey, docsSyncWatchSchema, routedConflictRetention, routedConflictSchema, routedConflictWindowMs, type DocsSyncWatch } from '../model/docs-sync.js';
import { docsSyncMaxMs, type DocsSyncPlan } from '../docs-sync.js';

/**
 * The decision step's docs-sync route. A confirmed conflict of the current head is classified once
 * per head and base tip, and logged for the hotspot report. One confined to docs pages goes to a
 * docs-sync session instead of a rework decision; `holds` is true while that session holds the
 * item. A docs-sync that ends — or runs past its bound — while an observation taken since still
 * shows the same head gave the conflict up, and the rework decision follows as before, as it does
 * for every conflict that touches anything else.
 */
export function docsSyncRoute({ config, state, effects, snapshot, sessions, note, inventorySpent, stamp, clock }: {
  config: { baseBranch: string };
  state: DaemonState;
  effects: Pick<DaemonEffects, 'conflictPaths' | 'docsSync' | 'persist' | 'closeSession' | 'endRegistrySession'>;
  snapshot: { work: Work[] };
  sessions: () => Promise<{ agents: HerdrAgent[]; available: boolean }>;
  note: (key: string, item: Work, kind: DaemonActionKind, outcome: 'done' | 'failed', detail: string) => Promise<unknown>;
  inventorySpent: () => void;
  stamp: string;
  clock: number;
}) {
  /** A routed conflict that ended up with a worker is counted as sent back. */
  const markRework = (work: string, head: string, base: string) => {
    state.conflicts = state.conflicts.map(entry => entry.work === work && entry.head === head && entry.base === base ? { ...entry, route: 'rework' } : entry);
  };
  /** Close a docs-sync session's tab, if Herdr still lists it, and give its registry session back. */
  const settle = async (item: Work, watch: DocsSyncWatch, why: string) => {
    const listed = watch.agentName ? (await sessions()).agents.find(agent => agent.name === watch.agentName) : undefined;
    if (listed?.pane_id) { try { await effects.closeSession(listed.pane_id); } catch { /* the session report closes it once the pane is gone */ } inventorySpent(); }
    if (watch.session && effects.endRegistrySession) { await effects.endRegistrySession(watch.session, why.slice(0, 500)).catch(() => undefined); watch.session = null; }
    await effects.persist(state);
  };
  // A docs-sync whose item moved off the reviewed head succeeded (the control plane adopted the
  // synced head) or was overtaken; either way its session is done. Records are kept a day.
  const sweep = async () => {
    for (const [key, watch] of Object.entries(state.docsSyncs)) {
      const item = snapshot.work.find(entry => entry.key === watch.work);
      if (!watch.settledAt && (!item || item.stage === 'done' || item.candidate?.sha !== watch.head)) { watch.settledAt = stamp; if (item) await settle(item, watch, `the docs-sync of ${watch.work} moved its head off ${watch.head.slice(0, 12)}`); }
      if (watch.settledAt && clock - Date.parse(watch.settledAt) > routedConflictWindowMs) delete state.docsSyncs[key];
    }
  };
  const holds = async (item: Work): Promise<boolean> => {
    const refresh = item.baseRefresh!, head = refresh.from.sha, base = refresh.base, key = docsSyncWatchKey(item, head, base);
    const watch = state.docsSyncs[key];
    if (!watch) {
      if (state.conflicts.some(entry => entry.work === item.key && entry.head === head && entry.base === base)) return false;
      const local = await effects.conflictPaths?.(item, head, base).catch(() => null) ?? null;
      const paths = local?.length ? local : refresh.conflictPaths ?? null;
      const routed = effects.docsSync ? conflictRoute(paths) : { route: 'rework' as const, reason: 'this loop has no docs-sync launcher' };
      state.conflicts = [...state.conflicts, routedConflictSchema.parse({ work: item.key, head, base, at: stamp, paths: (paths ?? []).slice(0, 200).map(path => path.slice(0, 500)), route: routed.route })].slice(-routedConflictRetention);
      await effects.persist(state);
      if (routed.route === 'rework') return false;
      const plan: DocsSyncPlan = { key: item.key, pr: item.candidate!.pr, branch: item.candidate!.branch, baseBranch: config.baseBranch, head, base, paths: paths! };
      const actionKey = `docs-sync:${key}`;
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
    const seen = await sessions(), listed = watch.agentName ? seen.agents.find(agent => agent.name === watch.agentName) : undefined;
    const overdue = clock - Date.parse(watch.launchedAt) >= docsSyncMaxMs;
    if (!overdue && (listed || !seen.available)) return true;
    // Gone, or past its bound: the push may not have been observed yet. Only an observation taken
    // after the loop found that, still on the reviewed head, shows the docs-sync gave up.
    watch.goneAt ??= stamp;
    if (!(item.observation && Date.parse(item.observation.at) > Date.parse(watch.goneAt))) { await effects.persist(state); return true; }
    watch.failed = (overdue ? `the docs-sync session ran past ${docsSyncMaxMs / 60_000} minutes without moving ${head.slice(0, 12)}` : `docs-sync session ${watch.agentName} ended without moving ${head.slice(0, 12)}`).slice(0, 1000);
    watch.settledAt = stamp;
    await settle(item, watch, watch.failed);
    markRework(item.key, head, base);
    await note(`docs-sync:${key}`, item, 'decision', 'failed', `${item.key}: ${watch.failed}, so the conflict returns to a worker`);
    return false;
  };
  return { holds, sweep };
}
