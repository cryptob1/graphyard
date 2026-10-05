// Concern: cycle step 3 — reclaim disk, bounded resources and dead sessions' quarantines.
import { describeReclaim, paneReclaimStatus, agentlessPaneAttentionBound, finishedSessionGraceMs } from '../master-resources.js';
import { diskThresholdBytes, containmentPhase } from '../master.js';
import { worktreeRootMinFreeBytes } from '../install/worktree-root.js';
import { actionDetailMax, gigabytes, message, reclaimIntervalMs, reclaimSummarySchema } from './state.js';
import { readyToRetry } from './sessions.js';
import { boundDetail, detailChanged } from './decisions.js';
import { launchAppearanceMs, preserveInterruptedAttempt, record } from './effects.js';
import type { Cycle } from './cycle.js';
import type { Work } from '../model.js';
import type { SessionHandle } from '../model/sessions.js';
import type { ContainmentAssessment } from '../master.js';
import { containmentQuarantines } from '../master.js';
import { type ContainmentObservation, containmentClock, unmeasured } from '../master/containment.js';
import { closablePane, endedScopeStates, leaseLapsedEnding, loopEndedAttempt } from '../quarantine.js';
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
  observed: ContainmentObservation, now: () => number, performed: DaemonAction[]) {
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
 * What blocks a containment settlement, without what each cycle measures: the clock read's round
 * trip and which read took it (GY-1044). An intermittently failing timed read alternates between
 * the timed and the snapshot read, and neither flip nor number is a new cause.
 */
export function containmentRefusalCause(detail: string) {
  return unmeasured(detail).replace(/the (?:timed|snapshot) read of the control-plane clock took/g, 'the read of the control-plane clock took');
}
/** Room the measured round trip and read source take beyond their masked form. */
const measuredRoom = 32;
/**
 * A containment escalation's detail as it is stored: whole while its cause fits the detail bound
 * with room for the measurement, else the cause alone, bounded. Masking before truncating keeps two
 * cycles' stored forms comparable: truncating first moves the cut with the number's width (GY-1044).
 */
export function containmentEscalationDetail(detail: string) {
  const cause = containmentRefusalCause(detail);
  return cause.length <= actionDetailMax - measuredRoom ? detail : boundDetail(cause);
}

/** What a settle action refused only by the plane's own state says, so the next cycle can tell it from a refusal the host caused (GY-1155). */
const transientRetry = 'retried next cycle with a fresh probe';
/**
 * Why a settlement POST was refused only transiently, or null when the refusal is the host's: the
 * plane answering 5xx — Railway's 502 "Application failed to respond" among them — or refusing
 * nothing but a verification that went stale on its way there. A pid or epoch that happens to
 * read 5xx is no status, and a stale verification refused beside any other cause is not transient.
 */
export function transientSettlementRefusal(error: unknown) {
  const text = message(error);
  if ((error as { confirmedRefusal?: unknown })?.confirmedRefusal === false || /Application failed to respond/.test(text)
    || /(?:\bHTTP\/?[\d.]*\s+|"(?:status|code|statusCode)"\s*:\s*)5\d\d\b|\(5\d\d\):|^5\d\d [A-Z]/.test(text)) return 'the control plane answered 5xx';
  const refused = /Automatic containment settlement refused: (.*?)\. Confirm the previous worker is stopped/s.exec(text)?.[1];
  const stale = /Host verification is older than \d+s; verify the host again/g;
  return refused && stale.test(refused) && !refused.replace(stale, '').replace(/[;\s]/g, '') ? 'the host verification went stale before the plane judged it' : null;
}
/**
 * Whether a containment settlement is due this cycle: never once done, at once after a transient
 * refusal (the next cycle probes afresh), and on the widening action backoff after any other.
 */
export function settleDue(previous: DaemonAction | undefined, cycle: number) {
  if (!previous) return true;
  if (previous.state === 'done') return false;
  return previous.state === 'failed' && previous.detail.includes(transientRetry) ? cycle > previous.cycle : readyToRetry(previous, cycle);
}
/**
 * Lower a verified-dead containment fence: the autosettle POST, recorded as the item's settle
 * action. A fence already gone from the record — its supervisor settled it after the probe — is
 * done, and a refusal the plane caused is marked to be retried on the next cycle.
 */
export async function settleQuarantine(cycle: Cycle, item: Work, assessment: ContainmentAssessment, judged: Work = item) {
  const { state, effects, now, performed } = cycle;
  const epoch = assessment.epoch, key = `settle:${item.id}:${epoch}`, attempts = (state.actions[key]?.attempts ?? 0) + 1;
  await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'started', detail: `Settling the verified-dead containment quarantine of ${item.key} epoch ${epoch}`, attempts, epoch, cycle: state.cycle }, now(), effects.persist);
  const settled = (detail: string) => record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'done', detail, attempts, epoch, cycle: state.cycle }, now(), effects.persist);
  try {
    await effects.settleContainment!(judged, assessment);
    performed.push(await settled(`Settled the containment quarantine of ${item.key} epoch ${epoch}: its supervisor is verified gone on ${assessment.host ?? 'this host'}, so the item can be claimed again`));
    return true;
  } catch (error) {
    if (/Containment quarantine is missing, superseded, or does not match/.test(message(error))) {
      performed.push(await settled(`The containment quarantine of ${item.key} epoch ${epoch} was already lowered when the loop settled it: its supervisor is verified gone on ${assessment.host ?? 'this host'}`));
      return true;
    }
    const transient = transientSettlementRefusal(error);
    performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'failed', detail: `Containment settlement refused for ${item.key} epoch ${epoch}${transient ? ` (${transient}, so it is ${transientRetry})` : ''}: ${message(error)}`, attempts, epoch, cycle: state.cycle }, now(), effects.persist));
    return false;
  }
}

/** How long the loop waits, across the actions of one cycle that ended attempts, for the supervisors it stopped to be verified gone (GY-1155). */
export const endedFenceWaitMs = 10_000;
/** The deadline each cycle's ended-attempt waits share, so a cycle ending several fenced attempts stalls one bound, not one per attempt. */
const endedFenceDeadlines = new WeakMap<Cycle, number>();
/** How the loop ended an attempt: the preserve it recorded (the reason its exhaustion reads), or its close of a submitted attempt's session (the outcome). */
export type AttemptEnding = { epoch: number; owner: string; preserved?: string; closed?: string };
/**
 * The item as the record reads once the loop has ended an attempt (GY-1155): the lease the ending
 * released, and the loop's own record of the ending, which the snapshot the cycle began with does
 * not carry yet. It is what this host judges the settlement with; the plane judges its own record.
 */
export function endedRecord(item: Work, ending: AttemptEnding, at: string): Work {
  const { epoch, owner } = ending, id = `${owner}:${epoch}`;
  const exhaustions = item.capacity?.exhaustions ?? [];
  const preserved = ending.preserved && !exhaustions.some(entry => entry.role === 'worker' && entry.epoch === epoch)
    ? [...exhaustions, { role: 'worker' as const, epoch, cause: 'interrupted' as const, profile: owner, account: null, runtime: null, reason: ending.preserved.slice(0, 500), resetsAt: null, partialWork: { state: 'not-applicable' as const }, at, owner, recordedBy: 'graphyard-loop' }]
    : exhaustions;
  const sessions = item.sessions ?? [], handle = sessions.find(entry => entry.id === id);
  return {
    ...item,
    lease: item.lease?.epoch === epoch ? null : item.lease,
    capacity: { exhaustions: preserved, escalations: item.capacity?.escalations ?? [] },
    sessions: ending.closed ? [...sessions.filter(entry => entry.id !== id), { ...(handle ?? { id, kind: 'implementation', principal: owner, epoch: null }), state: 'finished', outcome: ending.closed.slice(0, 500), endedAt: handle?.endedAt ?? at } as SessionHandle] : sessions,
  };
}
/**
 * Settle the fence of an attempt the loop has just ended, in that same action (GY-1155), judged on
 * the record the ending wrote. The host is probed until the stopped supervisor is verified gone,
 * within a bound the cycle's endings share; a fence still held at the bound, or refused, is left to the reclaim step, which
 * retries it on later cycles without the grace window.
 */
export async function settleEndedAttemptFence(cycle: Cycle, item: Work, ending: AttemptEnding, wait: { boundMs: number; pollMs: number } = { boundMs: endedFenceWaitMs, pollMs: 500 }) {
  const { state, effects, config, clockOffset, snapshot, now } = cycle;
  if (item.containmentQuarantine?.epoch !== ending.epoch || item.containmentQuarantine.owner !== ending.owner) return false;
  if (!effects.containment || !effects.settleContainment || !containmentQuarantines([item], config.hostId).length) return false;
  if (!settleDue(state.actions[`settle:${item.id}:${ending.epoch}`], state.cycle)) return false;
  const ended = endedRecord(item, ending, new Date(now()).toISOString());
  const measured = await containmentClock(clockOffset, effects.controlPlaneClock);
  const observed: ContainmentObservation = { now: snapshot.now, clockOffset: measured.clockOffset, clockRoundTripMs: measured.roundTripMs, clockSource: measured.source };
  const deadline = endedFenceDeadlines.get(cycle) ?? Date.now() + wait.boundMs;
  endedFenceDeadlines.set(cycle, deadline);
  for (;;) {
    let assessment: ContainmentAssessment | undefined;
    try { assessment = (await effects.containment([ended], observed))[item.id]; } catch { return false; }
    if (assessment?.settleable) {
      if (!await settleQuarantine(cycle, item, assessment, ended)) return false;
      // The fence is gone from the record, so this cycle's later steps — dispatch, the faults pass — read it gone too.
      item.containmentQuarantine = null;
      return true;
    }
    if (!assessment || Date.now() + wait.pollMs > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, wait.pollMs));
  }
}

/**
 * How many leftover panes one pass closes, so a backlog drains over cycles rather than in one burst
 * of closes (GY-842). Twelve a pass drains 300 in 25 closing cycles: under an hour even at
 * two-minute cycles, with the first cycle spent on sightings (GY-980).
 */
export const paneSweepLimit = 12;

/**
 * The item key and attempt epoch a Graphyard worktree path names (…/.graphyard/worktrees/GY-N-EPOCH,
 * or anywhere beneath it), or null for any other directory. A worktree removed under its shell
 * reads with Linux's ` (deleted)` suffix, which is kept apart as `deleted`.
 */
export function graphyardWorktree(cwd: string | undefined): { key: string; epoch: number; deleted: boolean } | null {
  const match = /\/\.graphyard\/worktrees\/([A-Za-z][A-Za-z0-9]*-\d+)-(\d+)(?:\/[^]*?)?( \(deleted\))?\s*$/.exec(cwd ?? '');
  return match ? { key: match[1], epoch: Number(match[2]), deleted: !!match[3] } : null;
}

/**
 * 3c. Leftover panes are reclaimed (GY-842, GY-980). Every launch records its pane on the item
 * (GY-172); a runtime that exits leaves its pane behind as a bare shell holding a pty, and Herdr
 * held 584 of them on 26 September 2026 while the host throttled, and 85 on 30 September that the
 * record never ended or never named. Each cycle this sweep closes a bounded number of:
 *
 * - agentless panes standing in a Graphyard worktree (…/.graphyard/worktrees/GY-N-EPOCH, present or
 *   deleted), recorded or not, whatever their record says: a session that ended, a launch whose
 *   runtime exited at start, whose handle stayed 'running', or whose pane was never recorded leaves
 *   exactly this;
 * - agent panes a Graphyard session recorded, still named for it, whose session has ended and
 *   whose item and epoch hold no live lease — an idle finished agent nothing tracks any more.
 *
 * An agentless pane is closed once it has stood so past `launchAppearanceMs`, so a launch whose
 * runtime has not yet started is never taken for one that exited; an agent pane once it has stood
 * so past `finishedSessionGraceMs`. It never touches an agentless pane outside a Graphyard worktree
 * (the operator's own shells, the coordinator checkout, review and producer checkouts, whose panes
 * the session-end steps close), a pane whose worktree's exact item and epoch holds a live lease, or
 * an agent pane whose item and epoch does. What the host holds is reported with it — the pane
 * count, the agentless Graphyard panes and the oldest — and attention is raised once agentless
 * panes pass the bound.
 */
export async function reclaimLaunchedPanes(cycle: Cycle) {
  const { config, state, effects, now, clock, snapshot, performed, isolate, agents, open, closedPanes } = cycle;
  // The inventory and the close are local to this host, so only the handles this host's launchers
  // recorded are matched or counted: a finished handle another host recorded that happens to name
  // this host's pane coordinate would otherwise make a local pane another launch's target, and its
  // counts would not be this host's (GY-842). The implementation-session close (1g) filters the
  // same way.
  const recorded = new Map<string, { item: Work; handle: SessionHandle }>();
  for (const item of snapshot.work) for (const handle of item.sessions ?? []) if (handle.pane && handle.host === config.hostId) recorded.set(handle.pane, { item, handle });
  // Whether that exact item and attempt epoch holds a live lease.
  const leased = (key: string, epoch: number | null | undefined) => epoch != null && open.some(item => item.key === key && !!item.lease && item.lease.epoch === epoch && Date.parse(item.lease.expiresAt) > clock);
  // Whether a live lease is worked in the worktree `cwd` names (…/worktrees/GY-N-EPOCH).
  const workedHere = (cwd: string | undefined) => {
    const tree = graphyardWorktree(cwd);
    if (tree) return leased(tree.key, tree.epoch);
    return !!cwd && open.some(item => !!item.lease && Date.parse(item.lease.expiresAt) > clock && cwd.replace(/ \(deleted\)$/, '').endsWith(`/${item.key}-${item.lease.epoch}`));
  };
  const agentless: { pane: string; name: string | undefined; key: string; item: Work | null; why: string; boundMs: number }[] = [];
  for (const agent of agents) {
    // Never a pane whose worktree holds a live lease, nor one an earlier step of this cycle closed.
    if (!agent.pane_id || closedPanes.has(agent.pane_id) || workedHere(agent.cwd)) continue;
    const hit = recorded.get(agent.pane_id), tree = graphyardWorktree(agent.cwd);
    if (agent.agent) {
      // An agent in the pane is a live session unless the record says it is Graphyard's, ended, and
      // its item and epoch hold no live lease: an idle finished agent is closed after its grace.
      // Pane coordinates are reused, so the agent must be named, and named for that very session:
      // a handle or an agent without a name identifies nobody, and its occupant is left alone.
      if (!hit || hit.handle.state === 'running' || !hit.handle.agentName || !agent.name || hit.handle.agentName !== agent.name) continue;
      if (leased(hit.item.key, hit.handle.epoch ?? tree?.epoch)) continue;
      agentless.push({ pane: agent.pane_id, name: agent.name, key: hit.item.key, item: hit.item, boundMs: finishedSessionGraceMs,
        why: `still holds its ${agent.agent} agent, though its ${hit.handle.kind} session ${hit.handle.id} is ${hit.handle.state} and ${hit.item.key}${hit.handle.epoch != null ? ` epoch ${hit.handle.epoch}` : ''} holds no live lease` });
      continue;
    }
    // An agentless pane outside Graphyard's worktrees — the operator's own shells, the coordinator
    // checkout, a review or producer checkout — is never the sweep's, whatever its record says: the
    // session-end steps close the panes Graphyard launched there.
    if (!tree) continue;
    const ended = !!hit && hit.handle.state !== 'running', worktreeGone = tree.deleted;
    if (hit && (ended || worktreeGone)) {
      agentless.push({ pane: agent.pane_id, name: agent.name, key: hit.item.key, item: hit.item, boundMs: launchAppearanceMs,
        why: ended ? `holds no agent and its ${hit.handle.kind} session ${hit.handle.id} is ${hit.handle.state}` : `holds no agent and its worktree (${agent.cwd}) no longer exists` });
    } else {
      // A bare shell in a Graphyard worktree whose item and epoch hold no live lease: the launch
      // that opened it is over, whether its handle stayed 'running' or it was never recorded.
      const item = hit?.item ?? snapshot.work.find(candidate => candidate.key === tree.key) ?? null;
      agentless.push({ pane: agent.pane_id, name: agent.name, key: tree.key, item, boundMs: launchAppearanceMs,
        why: `holds no agent in the worktree of ${tree.key} epoch ${tree.epoch}, which holds no live lease${hit ? `, though its ${hit.handle.kind} session ${hit.handle.id} is still recorded running` : ' and no Graphyard session recorded it'}` });
    }
  }
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
  //     The clock is bounded by a light timed read taken just before the probe, not by the
  //     snapshot's read: that read takes seconds on a loaded plane, and a bound that wide refused
  //     every automatic settlement as unmeasurable (GY-811). Should the timed read fail, the
  //     snapshot's bounds stand and the refusal names their round trip. The read is taken only
  //     when a quarantine here could settle — registered on this host and past its grace window —
  //     so a cycle with nothing to settle, or only fences still in grace, never pays for it.
  //     The bound is only as good as the clock that stamps the `Date` header: behind a proxy or
  //     edge (Railway's, say) that is the hop that answers, which must keep time with the plane.
  //     A quarantine refused for a cause other than the clock still costs one read a cycle; the
  //     read is kept, since judging it with the snapshot's wider bound would add a clock refusal
  //     and change its escalation's cause on alternate cycles (GY-1044).
  // GY-1155: an attempt the loop ended on its own record is settled once its supervisor is gone,
  //     without waiting out the grace window, so its fence is assessable too.
  const settling = (item: Work) => containmentPhase(item, clock)?.state === 'lapsed' || loopEndedAttempt(item);
  const assessable = effects.containment && containmentQuarantines(snapshot.work, config.hostId).some(settling);
  const measured = assessable ? await containmentClock(clockOffset, effects.controlPlaneClock) : null;
  const observed: ContainmentObservation = measured ? { now: snapshot.now, clockOffset: measured.clockOffset, clockRoundTripMs: measured.roundTripMs, clockSource: measured.source } : { now: snapshot.now, clockOffset };
  const assessments = await effects.containment?.(snapshot.work, observed) ?? {};
  await closeEndedWorkerPanes(state, effects, open, assessments, observed, now, performed);
  // 3c. Reclaim the panes its ended launches left agentless (GY-842), and report what the host holds.
  await reclaimLaunchedPanes(cycle);
  for (const item of open.filter(candidate => candidate.containmentQuarantine && settling(candidate))) await isolate('settle', item, item.key, async () => {
    const epoch = item.containmentQuarantine!.epoch;
    const assessment = assessments[item.id];
    const key = `settle:${item.id}:${epoch}`;
    if (!assessment) return;
    if (!assessment.settleable) {
      const escalationKey = `escalation:containment:${item.id}:${epoch}`;
      const detail = containmentEscalationDetail(`${item.key}: containment quarantine from epoch ${epoch} cannot be settled automatically: ${assessment.refusals.join('; ')}`);
      // The refusal names each cycle's measured round trip and the read that took it, which
      // differ every cycle: the escalation is recorded again only when what blocks the settlement
      // changes, not the measurement.
      const previous = state.actions[escalationKey];
      if (detailChanged(previous && { detail: containmentRefusalCause(previous.detail) }, containmentRefusalCause(detail))) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, epoch, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    if (!effects.settleContainment || !settleDue(state.actions[key], state.cycle)) return;
    // A supervisor verified gone with the lease lapsed is a worker killed outright — the whole
    // tree stopped, or the host rebooted. Its partial work goes on the record before the fence is
    // lowered, so the item is offered again only once the next attempt can be told where it is.
    await preserveInterruptedAttempt(state, effects, item, epoch, config.workers.find(profile => profile.principal === item.containmentQuarantine!.owner), `${leaseLapsedEnding} and its supervisor (pid ${assessment.scope?.pid ?? 'unknown'}) is verified gone on ${assessment.host ?? 'this host'}`, now, performed);
    await settleQuarantine(cycle, item, assessment);
  });
  return assessments;
}
