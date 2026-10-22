// Concern: cycle step 3 — reclaim disk, bounded resources, lapsed leases and leftover panes.
import { describeReclaim, describeStandingTmpPass, tmpPassErrors, graphyardWorktree, paneReclaimStatus, agentlessPaneAttentionBound, finishedSessionGraceMs } from '../master-resources.js';
import { diskThresholdBytes } from '../master.js';
import { worktreeRootMinFreeBytes } from '../install/worktree-root.js';
import { actionDetailMax, gigabytes, message, reclaimIntervalMs, reclaimSummarySchema, standingTmpKey } from './state.js';
import { readyToRetry } from './sessions.js';
import { boundDetail, detailChanged } from './text.js';
import { launchAppearanceMs, record } from './effects.js';
import type { Cycle } from './cycle.js';
import type { Work } from '../model.js';
import type { SessionHandle } from '../model/sessions.js';
import { paneAlreadyGone } from '../request-settlement.js';
import { planeUnavailable } from '../model/refusal.js';
import { unsubmittedAttempt, unsubmittedAttemptText, workerReclaimBoundMs } from '../model/attempt-bound.js';
import { checkPaneStillBelongs, endWorkerAttempt } from './cycle-resume.js';
import type { DaemonAction, DaemonState } from './state.js';
import type { DaemonEffects } from './effects.js';
import { carriedCall, recordCarried, stepCallCarried, withinStepBudget } from './step-budget.js';

export { standingTmpKey };
/** The most attempts an action row holds (storeAction clamps to the schema's bound): past it a run's count reads as a floor. */
const actionAttemptsMax = 1000;
/**
 * How many leftover panes one pass closes, so a backlog drains over cycles rather than in one burst
 * of closes (GY-842). Twelve a pass drains 300 in 25 closing cycles: under an hour even at
 * two-minute cycles, with the first cycle spent on sightings (GY-980).
 */
export const paneSweepLimit = 12;

export { graphyardWorktree } from '../master-resources.js';

/**
 * 3c. Leftover panes are reclaimed (GY-842, GY-980, GY-1533). Every launch records its pane on the
 * item (GY-172); a runtime that exits leaves its pane behind as a bare shell holding a pty, and
 * Herdr held 584 of them on 26 September 2026 while the host throttled, 85 on 30 September that the
 * record never ended or never named, and 246 on 7 October that stood for over a day because the
 * sweep read `herdr agent list`, which never carries a bare shell: only `herdr pane list` does.
 * Each cycle this sweep closes a bounded number of:
 *
 * - agentless panes standing in a Graphyard worktree (…/.graphyard/worktrees/GY-N-EPOCH, present or
 *   deleted), recorded or not, whatever their record says: a session that ended, a launch whose
 *   runtime exited at start, whose handle stayed 'running', or whose pane was never recorded leaves
 *   exactly this. The candidates are the pane inventory's: every pane it reports with no agent;
 * - agent panes a Graphyard session recorded, still named for it, whose session has ended and
 *   whose item and epoch hold no live lease — an idle finished agent nothing tracks any more. The
 *   agent inventory names them.
 *
 * An agentless pane is closed once it has stood so past `launchAppearanceMs`, so a launch whose
 * runtime has not yet started is never taken for one that exited; an agent pane once it has stood
 * so past `finishedSessionGraceMs`. It never touches an agentless pane outside a Graphyard worktree
 * (the operator's own shells, the coordinator checkout, review and producer checkouts, whose panes
 * the session-end steps close), a pane whose worktree's exact item and epoch holds a live lease, a
 * pane a live lease's own session record names (GY-1801: after a rekey the superseded record keeps
 * the pane the claimed record runs in), an agent pane whose item and epoch does, or the worktree of
 * an attempt whose end is not on the record yet (GY-1801: its lease is either live or still to be
 * classed, and the attempt-ending steps close its pane with the end). A pane inventory that cannot
 * be read sweeps no agentless pane. What the host holds is reported with it — the pane count, the
 * agentless Graphyard panes and the oldest — and attention is raised once agentless panes pass the
 * bound.
 */
export async function reclaimLaunchedPanes(cycle: Cycle) {
  const { config, state, effects, now, clock, snapshot, performed, isolate, agents, open, closedPanes } = cycle;
  // The pane inventory is read once, for the candidates and for the count: every pane the host's
  // runtime holds, with its cwd and whether an agent runs in it (GY-1533).
  const inventory = effects.panes ? await carriedCall(cycle, 'reclaim', 'reclaim', 'panes', () => effects.panes!(), () => null).catch(() => null) : null;
  const panes = inventory?.available ? inventory.panes : null;
  // The inventory and the close are local to this host, so only the handles this host's launchers
  // recorded are matched or counted: a finished handle another host recorded that happens to name
  // this host's pane coordinate would otherwise make a local pane another launch's target, and its
  // counts would not be this host's (GY-842). The implementation-session close (1g) filters the
  // same way.
  const recorded = new Map<string, { item: Work; handle: SessionHandle }>();
  for (const item of snapshot.work) for (const handle of item.sessions ?? []) if (handle.pane && handle.host === config.hostId) recorded.set(handle.pane, { item, handle });
  // Whether that exact item and attempt epoch holds a live lease.
  const leased = (key: string, epoch: number | null | undefined) => epoch != null && open.some(item => item.key === key && !!item.lease && item.lease.epoch === epoch && Date.parse(item.lease.expiresAt) > clock);
  // Whether the pane is the one a live lease's own claimed session runs in (GY-1801), on this host:
  // the record keyed `owner:epoch` of the lease's epoch. A rekey leaves the superseded record the
  // same pane, so the claimed record's pane is what is held; an earlier round's finished handle, or
  // one another host recorded, names a pane coordinate that may since belong to another launch.
  const paneLeased = (pane: string | null | undefined) => !!pane && open.some(item => !!item.lease && Date.parse(item.lease.expiresAt) > clock
    && (item.sessions ?? []).some(handle => handle.pane === pane && handle.host === config.hostId && handle.id === `${item.lease!.owner}:${item.lease!.epoch}`));
  // Whether the worktree's exact item and epoch names an attempt that still stands (GY-1801): no end
  // of it is on the record, so the lease it held is either live or still to be classed, and its pane
  // is not the sweep's — whatever the lease in this cycle's snapshot reads.
  const standingAttempt = (key: string, epoch: number) => {
    const item = snapshot.work.find(candidate => candidate.key === key);
    const attempts = item?.pipeline?.attempts;
    return !!attempts?.some(entry => entry.epoch === epoch && entry.endedAt == null);
  };
  // Whether a live lease is worked in the worktree `cwd` names (…/worktrees/GY-N-EPOCH).
  const workedHere = (cwd: string | undefined) => {
    const tree = graphyardWorktree(cwd);
    if (tree) return leased(tree.key, tree.epoch);
    return !!cwd && open.some(item => !!item.lease && Date.parse(item.lease.expiresAt) > clock && cwd.replace(/ \(deleted\)$/, '').endsWith(`/${item.key}-${item.lease.epoch}`));
  };
  // A pane with an agent in it, by either inventory: the pane list names the agent kind, the agent
  // list the session. Either is a live session, never an agentless candidate.
  const withAgent = new Set(agents.filter(agent => !!agent.agent && !!agent.pane_id).map(agent => agent.pane_id!));
  const agentless: { pane: string; name: string | undefined; key: string; item: Work | null; why: string; boundMs: number }[] = [];
  for (const agent of agents) {
    // Never a pane whose worktree holds a live lease, whose record a live lease names, nor one an
    // earlier step of this cycle closed.
    if (!agent.pane_id || !agent.agent || closedPanes.has(agent.pane_id) || workedHere(agent.cwd) || paneLeased(agent.pane_id)) continue;
    const hit = recorded.get(agent.pane_id), tree = graphyardWorktree(agent.cwd);
    // An agent in the pane is a live session unless the record says it is Graphyard's, ended, and
    // its item and epoch hold no live lease: an idle finished agent is closed after its grace.
    // Pane coordinates are reused, so the agent must be named, and named for that very session:
    // a handle or an agent without a name identifies nobody, and its occupant is left alone.
    if (!hit || hit.handle.state === 'running' || !hit.handle.agentName || !agent.name || hit.handle.agentName !== agent.name) continue;
    if (leased(hit.item.key, hit.handle.epoch ?? tree?.epoch)) continue;
    agentless.push({ pane: agent.pane_id, name: agent.name, key: hit.item.key, item: hit.item, boundMs: finishedSessionGraceMs,
      why: `still holds its ${agent.agent} agent, though its ${hit.handle.kind} session ${hit.handle.id} is ${hit.handle.state} and ${hit.item.key}${hit.handle.epoch != null ? ` epoch ${hit.handle.epoch}` : ''} holds no live lease` });
  }
  // The bare shells: every pane the inventory holds with no agent in it, by the pane list's own
  // word and the agent list's. The agent list never carries one (GY-1533), so nothing here is
  // judged from it.
  for (const pane of panes ?? []) {
    if (!pane.pane_id || pane.agent || withAgent.has(pane.pane_id) || closedPanes.has(pane.pane_id) || workedHere(pane.cwd) || paneLeased(pane.pane_id)) continue;
    const hit = recorded.get(pane.pane_id), tree = graphyardWorktree(pane.cwd);
    // An agentless pane outside Graphyard's worktrees — the operator's own shells, the coordinator
    // checkout, a review or producer checkout — is never the sweep's, whatever its record says: the
    // session-end steps close the panes Graphyard launched there.
    if (!tree) continue;
    const name = hit?.handle.agentName ?? undefined;
    const ended = !!hit && hit.handle.state !== 'running', worktreeGone = tree.deleted;
    // A pane whose worktree's attempt still stands (GY-1801) is that attempt's own hold — the lease
    // it held is either live or still to be classed, and the loop's attempt-ending steps close it
    // with the end. What remains closes on its bound: a finished record's session, a pane whose
    // worktree is gone, or a bare shell whose launch is over, whether its handle stayed 'running'
    // or it was never recorded.
    if (!standingAttempt(tree.key, tree.epoch)) {
      if (hit && (ended || worktreeGone)) {
        agentless.push({ pane: pane.pane_id, name, key: hit.item.key, item: hit.item, boundMs: launchAppearanceMs,
          why: ended ? `holds no agent and its ${hit.handle.kind} session ${hit.handle.id} is ${hit.handle.state}` : `holds no agent and its worktree (${pane.cwd}) no longer exists` });
      } else {
        const item = hit?.item ?? snapshot.work.find(candidate => candidate.key === tree.key) ?? null;
        agentless.push({ pane: pane.pane_id, name, key: tree.key, item, boundMs: launchAppearanceMs,
          why: `holds no agent in the worktree of ${tree.key} epoch ${tree.epoch}, which holds no live lease${hit ? `, though its ${hit.handle.kind} session ${hit.handle.id} is still recorded running` : ' and no Graphyard session recorded it'}` });
      }
    }
  }
  // A sighting whose pane is no longer a candidate — another step or the operator closed it, it
  // gained a live lease or an agent, or it left the inventory — starts over: its row would otherwise
  // stand in the cursor forever, and a later pane at that coordinate would close without its bound.
  const candidates = new Set(agentless.map(entry => `sweep:pane:${entry.pane}`));
  const lapsed = Object.keys(state.actions).filter(key => key.startsWith('sweep:pane:') && state.actions[key].state === 'waiting' && !candidates.has(key));
  for (const key of lapsed) delete state.actions[key];
  if (lapsed.length) await effects.persist(state);
  let closed = 0;
  for (const { pane, name, key: work, item, why, boundMs } of agentless) {
    if (closed >= paneSweepLimit) break;
    const key = `sweep:pane:${pane}`, previous = state.actions[key];
    if (previous?.state === 'done') continue;
    if (!previous) {
      // A runtime that has not started yet looks the same, so nothing closes on the first sighting.
      // The sighting is a wait, not an effect in flight: a `started` entry would be reconciled as
      // interrupted on the next cycle, restarting the bound and costing the drain a cycle.
      await record(state, key, { kind: 'close', work, principal: null, state: 'waiting', detail: `Pane ${pane} of ${work}${name ? ` (${name})` : ''} ${why}; it is closed if that stands in ${Math.round(boundMs / 1000)}s`, attempts: 1, cycle: state.cycle }, now(), effects.persist);
      continue;
    }
    if (now() - Date.parse(previous.at) < boundMs) continue;
    await isolate('close', item, pane, async () => {
      let gone = false;
      try { await effects.closeSession(pane); } catch (error) { if (!paneAlreadyGone(error)) throw error; gone = true; }
      closed += 1;
      performed.push(await record(state, key, { kind: 'close', work, principal: null, state: 'done',
        detail: `${gone ? 'Pane was already gone; reclaimed' : 'Closed leftover pane'} ${pane} of ${work}${name ? ` (${name})` : ''}: it ${why}, and stood so past its ${Math.round(boundMs / 1000)}s bound`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    });
  }
  // What the host holds, on the record for `master status` to show, with attention past the bound.
  // A host holding nothing agentless records nothing until it once held some: a quiet installation
  // stays quiet, and a drained backlog is recorded as drained instead of standing reported.
  // The first sighting of each standing shell dates the unrecorded ones, so the oldest is the
  // longest-standing pane whether or not a session recorded it.
  const sighted: Record<string, string> = {};
  for (const [key, action] of Object.entries(state.actions)) if (key.startsWith('sweep:pane:') && action.state === 'waiting') sighted[key.slice('sweep:pane:'.length)] = action.at;
  // The reading is the host's after this pass: a pane closed here no longer stands, so the
  // inventory is read again once anything closed, and a drained backlog reads as drained now.
  const after = closed && effects.panes ? await carriedCall(cycle, 'reclaim', 'reclaim', 'panes', () => effects.panes!(), () => null).catch(() => null) : inventory;
  const status = paneReclaimStatus(after?.available ? after.panes : null, snapshot.work, agents, now(), config.hostId, sighted);
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

/** Step 3: reclaim disk, the loop's own bounded resources, lapsed leases and leftover panes. */
export const reclaimStep = (cycle: Cycle) => withinStepBudget(cycle, 'reclaim', ['panes', 'closeSession', 'reclaim', 'herdr', 'reclaimResources', 'reclaimLease', 'preserveWork', 'reportCapacity'], reclaimStepWithin); // GY-1774: every call the step makes — the disk and resource reclaims, the inventories, every pane close — is bounded
async function reclaimStepWithin(cycle: Cycle) {
  const { config, state, effects, now, snapshot, clock, performed, isolate, agents, open } = cycle;
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
      const report = await carriedCall(cycle, 'reclaim', 'reclaim', 'reclaim', () => effects.reclaim!(snapshot.work, clock), error => { throw error; });
      state.reclaim = reclaimSummarySchema.parse({ at: report.at, scanned: report.scanned, removed: report.removed.length, kept: report.kept.length,
        freedBytes: report.freedBytes, freeBytes: report.freeAfter === null ? null : Math.max(0, Math.round(report.freeAfter)), errors: [...report.errors, ...(report.trees?.errors ?? []), ...(report.checkouts?.errors ?? [])].map(entry => entry.slice(0, 500)).slice(0, 20),
        checkouts: report.checkouts?.removed.length ?? 0, checkoutsOffVolume: (report.checkouts as { sharesVolume?: boolean } | undefined)?.sharesVolume === false ? report.checkouts?.removed.length ?? 0 : 0, rootFreeBytes: report.checkouts?.freeBytes == null ? null : Math.max(0, Math.round(report.checkouts.freeBytes)),
        trees: report.trees?.removed.length ?? 0, treeBacklog: report.trees?.backlog ?? 0 });
      const trees = report.trees?.removed.length ?? 0;
      if (report.trees && (trees || report.trees.errors.length)) {
        // A tree this pass's errors name is reported there; one held from an earlier refusal is kept like a dirty one (GY-1515).
        const kept = report.trees.kept.filter(entry => !report.trees!.errors.some(error => error.startsWith(`${entry.path}: `)));
        performed.push(await record(state, `reclaim:trees:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: report.trees.errors.length ? 'failed' : 'done',
          detail: `Removed ${trees} finished worktree(s) with git worktree remove${report.trees.backlog ? `; ${report.trees.backlog} more are reclaimable and go on the next cycle (at most ${report.trees.limit} per cycle)` : ''}${kept.length ? `; ${kept.length} kept as dirty, unpushed, unregistered or refused by Git, first ${kept[0].path}: ${kept[0].reason}` : ''}${report.trees.errors.length ? `; ${report.trees.errors.length} could not be removed: ${report.trees.errors[0]}` : ''}`,
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
      // GY-1774: a reclaim carried past the step's bound is recorded on the step's row by the call itself; the next cycle reclaims again, joining it.
      if (!stepCallCarried(error)) performed.push(await record(state, `reclaim:${new Date(clock).toISOString()}`, { kind: 'reclaim', work: null, principal: null, state: 'failed', detail: `Worktree reclamation failed: ${message(error)}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 3a. Reclaim the loop's own bounded resources (GY-132): ledger records, agent names and
  //     session slots, each within the bound docs/master-agent.md documents, recorded when it took any.
  if (effects.reclaimResources) {
    try {
      const inventory = effects.herdr ? await carriedCall(cycle, 'reclaim', 'reclaim', 'herdr', () => effects.herdr!(), error => { throw error; }) : undefined;
      const report = await carriedCall(cycle, 'reclaim', 'reclaim', 'reclaimResources', () => effects.reclaimResources!(snapshot.work, inventory ? (inventory.available ? inventory.agents : null) : agents), error => { throw error; });
      const detail = describeReclaim(report);
      if (detail) performed.push(await record(state, `reclaim:resources:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: report.errors.length ? 'failed' : 'done', detail, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      // A /tmp pass that removed 0 while the inode bound stands is recorded too (GY-1600), never dropped
      // as a pass with nothing to say. One row stands for the whole run of such passes, its attempts
      // the passes in it, so a bound that stands for days holds one row, not one per cycle crowding
      // the ledger's bound; the run's row is filed under its last pass once a pass ends it. A row's
      // attempts stop at their bound, so from that pass on the count is stated as a floor, never
      // as a number it no longer holds. The /tmp pass's own errors fail it, another resource's do
      // not, and the resources row above already carries their fault.
      const standing = describeStandingTmpPass(report), run = state.actions[standingTmpKey];
      if (standing) {
        const passes = Math.min((run?.attempts ?? 0) + 1, actionAttemptsMax);
        const count = passes >= actionAttemptsMax ? `${actionAttemptsMax} or more passes in a row` : `Pass ${passes} in a row`;
        performed.push(await record(state, standingTmpKey, { kind: 'reclaim', work: null, principal: null, state: tmpPassErrors(report).length ? 'failed' : 'done',
          detail: boundDetail(passes > 1 ? `${count}: ${standing}` : standing), attempts: passes, cycle: state.cycle }, now(), effects.persist));
      } else if (run && report.tmpPass) {
        state.actions[`reclaim:tmp:${run.at}`] = run;
        delete state.actions[standingTmpKey];
      }
    } catch (error) {
      if (!stepCallCarried(error)) performed.push(await record(state, `reclaim:resources:${new Date(clock).toISOString()}`, { kind: 'reclaim', work: null, principal: null, state: 'failed', detail: `Resource reclaim failed: ${message(error)}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 3a'. Stop renewing an attempt past its no-submission bound (GY-1460).
  await stopUnboundedAttempts(cycle);
  // 3a''. A lease that lapsed with nothing submitted is cleared by the control plane's own
  //      reconciliation (GY-1984): the loop asks for it with one resync, this cycle.
  if (effects.reclaimLease) for (const item of open) {
    const lease = item.lease;
    if (!lease || item.submission || Date.parse(lease.expiresAt) > clock) continue;
    await isolate('reclaim', item, item.key, async () => {
      await effects.reclaimLease!(item);
      performed.push(await record(state, `reclaim:lease:${item.id}:${lease.epoch}`, { kind: 'reclaim', work: item.key, principal: lease.owner, state: 'done',
        detail: `${item.key}: the lease ${lease.owner} held under epoch ${lease.epoch} lapsed at ${lease.expiresAt} with nothing submitted; the loop asked the control plane to reconcile it`, attempts: 1, epoch: lease.epoch, cycle: state.cycle }, now(), effects.persist));
    });
  }

  // 3c. Reclaim the panes its ended launches left agentless (GY-842), and report what the host holds.
  await reclaimLaunchedPanes(cycle);
}

/** The loop's record that it stopped renewing an attempt's lease (GY-1460). */
export const unboundedAttemptKey = (item: { id: string }, epoch: number) => `unbounded:${item.id}:${epoch}`;
/**
 * 3a'. An attempt holding its lease past the reclaim bound (`workerReclaimBoundMs`: one further
 * worker bound after the stalled-gate fault) with still no submission and no submission progress
 * inside the cadence stops being renewed (GY-1460). Its renewals come from the attempt's watch
 * supervisor, which a live session keeps alive for ever, so the loop ends the attempt through the
 * reclaim path a stalled attempt takes (`endWorkerAttempt`, as the idle bound does): what it left
 * is kept on its branch, the attempt ends on the record and its supervisor stops on the ended
 * lease, so the item returns to the queue with its worktree kept. An end that cannot be made is recorded failed and retried on the action
 * backoff; the fault keeps standing meanwhile.
 */
export async function stopUnboundedAttempts(cycle: Cycle) {
  const { config, state, effects, now, clock, agents, performed, isolate, open } = cycle;
  for (const item of open) {
    const attempt = unsubmittedAttempt(item, clock);
    if (!attempt?.reclaim || !attempt.live) continue;
    const profile = config.workers.find(worker => worker.principal === attempt.owner);
    if (!profile) continue;
    await isolate('session', item, item.key, async () => {
      const key = unboundedAttemptKey(item, attempt.epoch), previous = state.actions[key];
      if (previous?.state === 'done' || (previous && !readyToRetry(previous, state.cycle))) return;
      const attempts = (previous?.attempts ?? 0) + 1;
      const entry = (outcome: DaemonAction['state'], detail: string) => record(state, key, { kind: 'session', work: item.key, principal: attempt.owner, epoch: attempt.epoch, state: outcome, detail: detail.slice(0, actionDetailMax), attempts, cycle: state.cycle }, now(), effects.persist);
      // The pane this attempt's own handle records, and only while that pane is still its session (GY-852).
      const handleId = `${attempt.owner}:${attempt.epoch}`, recorded = item.sessions?.find(handle => handle.kind === 'implementation' && handle.id === handleId)?.pane ?? undefined;
      const pane = recorded && agents.some(agent => agent.pane_id === recorded) && !checkPaneStillBelongs(item, handleId, recorded) ? recorded : null;
      const held = `held its lease past the ${workerReclaimBoundMs / 60_000}-minute reclaim bound without a submission (claimed at ${attempt.claimedAt})`;
      try {
        const next = await endWorkerAttempt(cycle, item, profile, attempt.epoch, pane, held, `ended without submitting: it ${held}`, { stopFirst: true });
        performed.push(await entry('done', `${item.key} epoch ${attempt.epoch} (${attempt.owner}) ${held}; the loop stopped renewing it: ${next}, with its worktree kept`));
      } catch (error) {
        if (stepCallCarried(error)) return recordCarried(cycle, key, { kind: 'session', work: item.key, principal: attempt.owner, epoch: attempt.epoch }, error, `Ending ${item.key} epoch ${attempt.epoch} past its reclaim bound`);
        performed.push(await entry('failed', `${unsubmittedAttemptText(attempt)}; but the loop could not end the attempt: ${message(error)}`));
      }
    });
  }
}
