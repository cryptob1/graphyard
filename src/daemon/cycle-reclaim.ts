// Concern: cycle step 3 — reclaim disk, bounded resources and dead sessions' quarantines.
import { describeReclaim, paneReclaimStatus, agentlessPaneAttentionBound } from '../master-resources.js';
import { diskThresholdBytes, containmentPhase } from '../master.js';
import { worktreeRootMinFreeBytes } from '../install/worktree-root.js';
import { gigabytes, message, reclaimIntervalMs, reclaimSummarySchema } from './state.js';
import { readyToRetry } from './sessions.js';
import { detailChanged } from './decisions.js';
import { launchAppearanceMs, preserveInterruptedAttempt, record } from './effects.js';
import type { Cycle } from './cycle.js';
import type { Work } from '../model.js';
import type { SessionHandle } from '../model/sessions.js';
import type { ContainmentAssessment } from '../master.js';
import { closablePane, endedScopeStates } from '../quarantine.js';
import { paneAlreadyGone } from '../request-settlement.js';
import type { DaemonAction, DaemonState } from './state.js';
import type { DaemonEffects } from './effects.js';

/**
 * Session cleanup for a worker whose supervisor scope has ended (GY-189). `watch` exiting leaves
 * the launch pane behind, the pane's own shell still sitting in the worktree; nothing runs there any
 * more, so the pane is closed, once. Only a pane the host probe found to be the recorded session's
 * idle shell in this item's worktree is closed, whatever the session ledger (which the worker can
 * write) names; a pane whose scope is still live, or whose shell runs anything, is left alone.
 *
 * Settlement may have excused that very shell, so until the close is recorded done the item's
 * assessment is withdrawn from `assessments` and the fence stays up for a later cycle. A pane closed
 * this cycle is probed again once it is gone, since the shell may have started something after the
 * first probe counted its children: only that fresh assessment may lower the fence. Closing is safe
 * to repeat, so a close a restart interrupted (`started`, then `indeterminate`) is simply retried.
 */
export async function closeEndedWorkerPanes(state: DaemonState, effects: DaemonEffects, open: Work[], assessments: Record<string, ContainmentAssessment>,
  observed: { now: string; clockOffset: { min: number; max: number } }, now: () => number, performed: DaemonAction[]) {
  const closed: Work[] = [];
  for (const item of open) {
    const assessment = assessments[item.id], quarantine = item.containmentQuarantine, recorded = assessment?.verification?.recordedScope;
    if (!quarantine || !assessment?.verification) continue;
    // A launch that recorded a scope has its pane closed only once that scope ended (GY-189); one
    // whose runtime never started may have recorded none, and its pane's idle shell is proven by
    // Herdr and the process table instead (GY-413, closablePane).
    const scopeEnded = !!quarantine.scope && !!recorded && recorded.unit === quarantine.scope.unit && recorded.pid === quarantine.scope.pid && endedScopeStates.includes(recorded.activeState);
    if (quarantine.scope && !scopeEnded) continue;
    const pane = closablePane(item, assessment.verification);
    if (!pane) continue;
    const epoch = quarantine.epoch, key = `close:ended-scope:${item.id}:${epoch}:${pane}`, previous = state.actions[key];
    if (previous?.state === 'done') continue;
    delete assessments[item.id];
    const interrupted = previous?.state === 'started' || previous?.state === 'indeterminate';
    if (!interrupted && !readyToRetry(previous, state.cycle)) continue;
    const attempts = (previous?.attempts ?? 0) + 1, why = scopeEnded ? `its supervisor scope ${recorded!.unit} is ${recorded!.activeState}` : 'its launch recorded no supervisor scope and its pane shell runs nothing';
    const entry = (outcome: 'started' | 'done' | 'failed', detail: string) => record(state, key, { kind: 'close', work: item.key, principal: quarantine.owner, epoch, state: outcome, detail, attempts, cycle: state.cycle }, now(), effects.persist);
    try {
      await entry('started', `Closing pane ${pane} of ${item.key} epoch ${epoch}: ${why}`);
      let gone = false;
      try { await effects.closeSession(pane); } catch (error) { if (!paneAlreadyGone(error)) throw error; gone = true; }
      performed.push(await entry('done', `${gone ? 'Pane was already gone' : 'Closed pane'} ${pane} of ${item.key} epoch ${epoch}: ${why}, so its shell no longer lingers in the worktree`));
      closed.push(item);
    } catch (error) {
      try { performed.push(await entry('failed', `Could not close pane ${pane} of ${item.key} epoch ${epoch} (${why}): ${message(error)}; the containment quarantine stays until it is closed`)); } catch { /* recorded next cycle */ }
    }
  }
  if (!closed.length || !effects.containment) return;
  let fresh: Record<string, ContainmentAssessment> = {};
  try { fresh = await effects.containment(closed, observed); } catch { /* re-probed next cycle */ }
  // A shell still exiting after its pane closed, or a probe that failed, is left to the next
  // cycle's probe, which settles or escalates it; the pre-close assessment is never used.
  for (const item of closed) if (fresh[item.id]?.settleable) assessments[item.id] = fresh[item.id];
}

/**
 * How many agentless launched panes one pass closes, so a backlog drains over cycles rather than
 * in one burst of closes (GY-842).
 */
export const paneSweepLimit = 6;

/**
 * 3c. Leftover agentless panes are reclaimed (GY-842). Every launch records its pane on the item
 * (GY-172); a runtime that exits leaves its pane behind as a bare shell holding a pty, and Herdr
 * held 584 of them on 26 September 2026 while the host throttled. Each cycle this sweep closes a
 * bounded number: panes a Graphyard session recorded, holding no agent, whose session has ended on
 * the record or whose worktree no longer exists, once they have stood agentless past
 * `launchAppearanceMs` — so a launch whose runtime has not yet started is never taken for one that
 * exited. It never touches a pane Graphyard did not launch (only recorded pane ids are matched), a
 * pane with an agent in it, or a pane whose worktree holds a live lease. What the host holds is
 * reported with it — the pane count, the agentless Graphyard panes and the oldest — and attention
 * is raised once agentless panes pass the bound.
 */
export async function reclaimLaunchedPanes(cycle: Cycle) {
  const { config, state, effects, now, clock, snapshot, performed, isolate, agents, open } = cycle;
  // The inventory and the close are local to this host, so only the handles this host's launchers
  // recorded are matched or counted: a finished handle another host recorded that happens to name
  // this host's pane coordinate would otherwise make a local pane another launch's target, and its
  // counts would not be this host's (GY-842). The implementation-session close (1g) filters the
  // same way.
  const recorded = new Map<string, { item: Work; handle: SessionHandle }>();
  for (const item of snapshot.work) for (const handle of item.sessions ?? []) if (handle.pane && handle.host === config.hostId) recorded.set(handle.pane, { item, handle });
  // Whether a live lease is worked in the worktree `cwd` names (…/worktrees/GY-N-EPOCH).
  const workedHere = (cwd: string | undefined) => !!cwd && open.some(item => !!item.lease && Date.parse(item.lease.expiresAt) > clock
    && cwd.replace(/ \(deleted\)$/, '').endsWith(`/${item.key}-${item.lease.epoch}`));
  const agentless: { pane: string; name: string | undefined; cwd: string | undefined; item: Work; handle: SessionHandle }[] = [];
  for (const agent of agents) {
    if (!agent.pane_id || agent.agent) continue; // a pane with an agent in it is a live session, whatever its state
    const hit = recorded.get(agent.pane_id);
    if (!hit || workedHere(agent.cwd)) continue; // never a pane Graphyard did not launch, nor one whose worktree holds a live lease
    const ended = hit.handle.state !== 'running', worktreeGone = !!agent.cwd && / \(deleted\)\s*$/.test(agent.cwd);
    if (!ended && !worktreeGone) continue;
    agentless.push({ pane: agent.pane_id, name: agent.name, cwd: agent.cwd, ...hit });
  }
  let closed = 0;
  for (const { pane, name, cwd, item, handle } of agentless) {
    if (closed >= paneSweepLimit) break;
    const key = `sweep:pane:${pane}`, previous = state.actions[key];
    if (previous?.state === 'done') continue;
    const ended = handle.state !== 'running', why = ended ? `its ${handle.kind} session ${handle.id} is ${handle.state}` : `its worktree (${cwd}) no longer exists`;
    if (!previous) {
      // A runtime that has not started yet looks the same, so nothing closes on the first sighting.
      await record(state, key, { kind: 'close', work: item.key, principal: null, state: 'started', detail: `Pane ${pane} of ${item.key}${name ? ` (${name})` : ''} holds no agent and ${why}; it is closed if that stands in ${Math.round(launchAppearanceMs / 1000)}s`, attempts: 1, cycle: state.cycle }, now(), effects.persist);
      continue;
    }
    if (now() - Date.parse(previous.at) < launchAppearanceMs) continue;
    await isolate('close', item, pane, async () => {
      let gone = false;
      try { await effects.closeSession(pane); } catch (error) { if (!paneAlreadyGone(error)) throw error; gone = true; }
      closed += 1;
      performed.push(await record(state, key, { kind: 'close', work: item.key, principal: null, state: 'done',
        detail: `${gone ? 'Pane was already gone; reclaimed' : 'Closed agentless pane'} ${pane} of ${item.key}${name ? ` (${name})` : ''}: ${why}, and it stood agentless past the launch bound`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    });
  }
  // What the host holds, on the record for `master status` to show, with attention past the bound.
  // A host holding nothing agentless records nothing until it once held some: a quiet installation
  // stays quiet, and a drained backlog is recorded as drained instead of standing reported.
  const inventory = await effects.panes?.().catch(() => null) ?? null;
  const status = paneReclaimStatus(inventory?.available ? inventory.panes : null, snapshot.work, agents, now(), config.hostId);
  const counts = `Herdr reports ${status.panes ?? 'an unknown number of'} pane(s) on this host, ${status.launched} opened by Graphyard launch(es), ${status.agentless} standing agentless${status.oldest ? `; the oldest is pane ${status.oldest.pane} of ${status.oldest.work} (${status.oldest.kind}), launched ${status.oldest.launchedAt}` : ''}`;
  const statusKey = 'sweep:panes:status';
  const previous = state.actions[statusKey], previousAgentless = Number(/(\d+) standing agentless/.exec(previous?.detail ?? '')?.[1] ?? 0);
  const drained = status.agentless === 0 && previousAgentless > 0;
  if ((status.agentless > 0 && (closed || detailChanged(previous, counts))) || drained) performed.push(await record(state, statusKey, { kind: 'close', work: null, principal: null, state: 'done', detail: `Pane sweep: ${counts}${drained ? '; the backlog has drained, and no pane stands agentless' : ''}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  const attentionKey = 'sweep:panes:attention';
  if (status.attention) {
    if (detailChanged(state.actions[attentionKey], status.attention.text)) performed.push(await record(state, attentionKey, { kind: 'escalation', work: null, principal: null, state: 'done', detail: status.attention.text, attempts: 1, cycle: state.cycle }, now(), effects.persist));
  } else if (state.actions[attentionKey] && !state.actions[attentionKey].detail.includes('back under the')) {
    performed.push(await record(state, attentionKey, { kind: 'escalation', work: null, principal: null, state: 'done', detail: `${counts}; back under the ${agentlessPaneAttentionBound}-pane attention bound`, attempts: (state.actions[attentionKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  }
}

/** Step 3: reclaim disk, the loop's own bounded resources, and the items whose sessions died. */
export async function reclaimStep(cycle: Cycle) {
  const { config, state, effects, now, snapshot, clock, clockOffset, performed, isolate, agents, open } = cycle;
  // 3. Reclaim the disk the finished assignments are holding, before anything asks for more of
  //    it. Every attempt and every rework checks the repository out again, so without this step
  //    the host fills and the loop starts failing at whatever it happens to write next. A
  //    finished worktree is removed with `git worktree remove` (GY-360), a bounded number per
  //    pass and never a dirty or unpushed one; the dependency directories of the rest go next.
  //    Branches and Graphyard's registered workspace records are never touched.
  //    Scanning the worktree directory is not free, so it keeps to its own interval — except
  //    while the last scan found free space below the configured threshold, when the host needs
  //    every cycle it can get rather than a cadence.
  const reclaimedAt = state.reclaim ? Date.parse(state.reclaim.at) : Number.NaN;
  const below = (free: number | null | undefined, bound: number) => free !== null && free !== undefined && free < bound;
  const pressed = below(state.reclaim?.freeBytes, diskThresholdBytes(config)) || below(state.reclaim?.rootFreeBytes, worktreeRootMinFreeBytes(config));
  //    A worktree backlog larger than one pass's bound drains on consecutive cycles, not intervals.
  const backlog = (state.reclaim?.treeBacklog ?? 0) > 0;
  if (effects.reclaim && (pressed || backlog || !(Number.isFinite(reclaimedAt) && clock - reclaimedAt < reclaimIntervalMs))) {
    try {
      const report = await effects.reclaim(snapshot.work);
      state.reclaim = reclaimSummarySchema.parse({ at: report.at, scanned: report.scanned, removed: report.removed.length, kept: report.kept.length,
        freedBytes: report.freedBytes, freeBytes: report.freeAfter === null ? null : Math.max(0, Math.round(report.freeAfter)), errors: [...report.errors, ...(report.trees?.errors ?? []), ...(report.checkouts?.errors ?? [])].map(entry => entry.slice(0, 500)).slice(0, 20),
        checkouts: report.checkouts?.removed.length ?? 0, rootFreeBytes: report.checkouts?.freeBytes == null ? null : Math.max(0, Math.round(report.checkouts.freeBytes)),
        trees: report.trees?.removed.length ?? 0, treeBacklog: report.trees?.backlog ?? 0 });
      const trees = report.trees?.removed.length ?? 0;
      if (report.trees && (trees || report.trees.errors.length)) {
        const kept = report.trees.kept.filter(entry => !entry.reason.startsWith('Git refused'));
        performed.push(await record(state, `reclaim:trees:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: report.trees.errors.length ? 'failed' : 'done',
          detail: `Removed ${trees} finished worktree(s) with git worktree remove${report.trees.backlog ? `; ${report.trees.backlog} more are reclaimable and go on the next cycle (at most ${report.trees.limit} per cycle)` : ''}${kept.length ? `; ${kept.length} kept as dirty, unpushed or unregistered with Git, first ${kept[0].path}: ${kept[0].reason}` : ''}${report.trees.errors.length ? `; ${report.trees.errors.length} could not be removed: ${report.trees.errors[0]}` : ''}`,
          attempts: 1, cycle: state.cycle }, now(), effects.persist));
      }
      const orphans = report.checkouts?.removed.length ?? 0, failures = report.errors.length + (report.checkouts?.errors.length ?? 0);
      if (orphans && !report.removed.length && !failures) {
        performed.push(await record(state, `reclaim:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: 'done',
          detail: `Reclaimed ${orphans} ephemeral checkout(s) no live session owned from ${report.checkouts!.root}, ${gigabytes(report.checkouts!.freeBytes)} free there`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      } else if (report.checkouts?.errors.length && !report.removed.length && !report.errors.length) {
        performed.push(await record(state, `reclaim:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: 'failed',
          detail: `Reclaimed ${orphans} ephemeral checkout(s) from ${report.checkouts.root}; ${report.checkouts.errors.length} could not be removed: ${report.checkouts.errors[0]}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      } else if (report.removed.length || report.errors.length) {
        performed.push(await record(state, `reclaim:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: report.errors.length ? 'failed' : 'done',
          detail: `Reclaimed ${report.removed.length} dependency director${report.removed.length === 1 ? 'y' : 'ies'} from ${report.scanned} assignment worktree(s), ${gigabytes(report.freedBytes)} recovered, ${gigabytes(report.freeAfter)} free${orphans ? `; ${orphans} ephemeral checkout(s) no live session owned removed from ${report.checkouts!.root}` : ''}${report.errors.length ? `; ${report.errors.length} could not be removed: ${report.errors[0]}` : ''}`,
          attempts: 1, cycle: state.cycle }, now(), effects.persist));
      } else await effects.persist(state);
    } catch (error) {
      performed.push(await record(state, `reclaim:${new Date(clock).toISOString()}`, { kind: 'reclaim', work: null, principal: null, state: 'failed', detail: `Worktree reclamation failed: ${message(error)}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 3a. Reclaim the loop's own bounded resources (GY-132): ledger records, agent names and
  //     session slots, each within the bound docs/master-agent.md documents, recorded when it took any.
  if (effects.reclaimResources) {
    try {
      const inventory = await effects.herdr?.();
      const report = await effects.reclaimResources(snapshot.work, inventory ? (inventory.available ? inventory.agents : null) : agents);
      const detail = describeReclaim(report);
      if (detail) performed.push(await record(state, `reclaim:resources:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: report.errors.length ? 'failed' : 'done', detail, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, `reclaim:resources:${new Date(clock).toISOString()}`, { kind: 'reclaim', work: null, principal: null, state: 'failed', detail: `Resource reclaim failed: ${message(error)}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 3b. Reclaim the items whose sessions died. A supervised launch fences its worker in a scope
  //     unit; when that session dies the fence outlives it and the item cannot be claimed again
  //     until somebody settles the quarantine. This host is the only one that can verify the
  //     supervisor is gone, so it does: the probe is the same one `master settle-containment`
  //     runs, the control plane re-evaluates every refusal itself, and an unverifiable signal is
  //     recorded as an escalation rather than settled. A live worker's quarantine is never touched.
  const assessments = await effects.containment?.(snapshot.work, { now: snapshot.now, clockOffset }) ?? {};
  await closeEndedWorkerPanes(state, effects, open, assessments, { now: snapshot.now, clockOffset }, now, performed);
  // 3c. Reclaim the panes its ended launches left agentless (GY-842), and report what the host holds.
  await reclaimLaunchedPanes(cycle);
  for (const item of open.filter(candidate => candidate.containmentQuarantine && containmentPhase(candidate, clock)?.state === 'lapsed')) await isolate('settle', item, item.key, async () => {
    const epoch = item.containmentQuarantine!.epoch;
    const assessment = assessments[item.id];
    const key = `settle:${item.id}:${epoch}`;
    if (!assessment) return;
    if (!assessment.settleable) {
      const escalationKey = `escalation:containment:${item.id}:${epoch}`;
      const detail = `${item.key}: containment quarantine from epoch ${epoch} cannot be settled automatically: ${assessment.refusals.join('; ')}`;
      if (detailChanged(state.actions[escalationKey], detail)) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, epoch, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    if (!effects.settleContainment) return;
    const previous = state.actions[key];
    if (previous && (previous.state === 'done' || !readyToRetry(previous, state.cycle))) return;
    // A supervisor verified gone with the lease lapsed is a worker killed outright — the whole
    // tree stopped, or the host rebooted. Its partial work goes on the record before the fence is
    // lowered, so the item is offered again only once the next attempt can be told where it is.
    await preserveInterruptedAttempt(state, effects, item, epoch, config.workers.find(profile => profile.principal === item.containmentQuarantine!.owner), `ended without submitting: its lease lapsed and its supervisor (pid ${assessment.scope?.pid ?? 'unknown'}) is verified gone on ${assessment.host ?? 'this host'}`, now, performed);
    await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'started', detail: `Settling the verified-dead containment quarantine of ${item.key} epoch ${epoch}`, attempts: (previous?.attempts ?? 0) + 1, epoch, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.settleContainment(item, assessment);
      performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'done', detail: `Settled the containment quarantine of ${item.key} epoch ${epoch}: its supervisor is verified gone on ${assessment.host ?? 'this host'}, so the item can be claimed again`, attempts: state.actions[key].attempts, epoch, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'failed', detail: `Containment settlement refused for ${item.key} epoch ${epoch}: ${message(error)}`, attempts: state.actions[key].attempts, epoch, cycle: state.cycle }, now(), effects.persist));
    }
  });
  return assessments;
}
