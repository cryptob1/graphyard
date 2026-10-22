// Concern: fault classification (GY-173) — what the cycle saw standing wrong, classified; instances recorded; and each recurring class one master-status attention line (GY-2186, no work item filed).
import type { Work } from '../model.js';
import { classified, classifyAttention, faultClasses, faultClassPolicyFromEnv, recurringClasses, statusFaults, trackFaults, unboundedAttemptKey, workFaults, type FaultClass, type FaultClassPolicy, type FaultKind, type FaultObservation } from '../model/fault-classes.js';
import { buildMasterStatus, diskThresholdBytes, type AttentionItem, type ContainmentAssessment, type ControlPlaneStatus, type HerdrAgent, type MasterConfig } from '../master.js';
import { worktreeRootMinFreeBytes } from '../install/worktree-root.js';
import { hostMemoryAttention } from '../master-resources.js';
import { judgeWorktreeDisk, standingDiskLine, worktreePassOf, worktreeVolumeWording } from '../master/worktree-disk.js';
import { type DaemonAction, type DaemonState, message } from './state.js';
export { unboundedAttemptKey };
import type { UnsubmittedAttempt } from '../model/attempt-bound.js';
import { type DaemonEffects, record } from './effects.js';
import { actionableIntervalMs, loopAttention } from './liveness.js';
import { daemonSummary } from './run.js';
import { baseFailureAttention } from './cycle-base-failures.js';
import { agentOwner } from '../master/attention.js';
import type { Cycle } from './cycle.js';
import { checkInvariants, invariantFaultKind, invariantFaults } from '../model/invariants.js';
import { baseRefreshConflict } from '../merge-queue.js';
import { mergeBaseDismissal } from '../merge-base-ancestry.js';
import { containmentInMotion, containmentSettleWaitBoundMs } from '../model/containment.js';
import { openAction } from '../model/next-action.js';
import { carriedDecision } from '../model/concerns.js';
import { masterTurnWaitBoundMs } from './decisions.js';
import { blockedAttemptMarker } from '../model/capacity.js';
import { credentialBlockedMarker } from '../worker-credential.js';
import { baseConflictWaitBoundMs } from '../cli/actorless-submissions.js';
export { baseConflictWaitBoundMs };

/** The attention `master status` adds after buildMasterStatus, and its final attribution over the whole list. */
export interface ReportedAttention { items: AttentionItem[]; attribute?: (status: { work: any[]; attentionItems: AttentionItem[] }) => AttentionItem[] }
/** What the cycle already read that faults are derived from, beside the items' own records. */
export interface FaultSources {
  config?: MasterConfig; agents?: HerdrAgent[]; credentials?: Record<string, { available: boolean; reason: string | null }>;
  containment?: Record<string, ContainmentAssessment>;
  /** The control plane's status as the loop read it, and the integration jobs on the coordination read. */
  status?: (ControlPlaneStatus & Record<string, unknown>) | null; jobs?: { work_id?: string; error?: string | null }[];
  /** What `master status` adds after `buildMasterStatus`, as the loop read it this cycle (see DaemonEffects.reportedAttention). */
  reported?: AttentionItem[];
  /** The report's final attribution (ReportedAttention.attribute), run over the derived and reported lines together. */
  attribute?: ReportedAttention['attribute'];
  /** The loop's own health lines (loopAttention over this cycle's daemonSummary), which master status puts first. */
  loop?: AttentionItem[];
  /** Herdr could not be read this cycle: every kind read from its inventory (herdrFaultKinds) goes unobserved. */
  herdrUnavailable?: boolean;
  /** What is disposable now over the current worktree inventory (GY-1784): null when the plan could not be read, absent when the loop has no reading of it. */
  worktreeReclaimable?: number | null;
}
/**
 * What this cycle saw standing wrong, classified (GY-173): every open item's own faults
 * (escalations, fences, parks, proof gaps, spent accounts, violations, blockers);
 * the attention `master status` derives from the same snapshot, Herdr and containment reads
 * (session liveness, review convergence, base conflicts, overlap holds, merge violations, installation
 * sources); the status-level problems (App permissions, held or failed integration jobs, a GitHub
 * pause, unserved executors, no GitHub connection); and disk below its bound. Each has a stable
 * subject, so a fault that keeps standing is one instance; one that clears and returns is another.
 * The lines go through the report's own attribution first, so a symptom the report names as its
 * cause (a full ledger, a resource at its bound) is tracked as that cause alone: a resource at its
 * bound is one fault on its own subject, however many subjects it holds (GY-1272). A derived line that
 * restates a fault the item's own record shows (the same kind, or a kind in `restatements`) is that
 * fault, so it is not counted twice; a different fault of the same class on the item is its own
 * instance. Nor is the one-hour dwell line (`gate`) or containment grace window (`containment-grace`) counted,
 * nor a lapsed fence the loop is still settling (containmentInMotion) or the owed line restating its escalation (owedContainmentLine), nor an escalation inside the master's turn (owedEscalationInMotion), nor a line whose `inMotionUntil` has not passed (GY-1315), which are the ordinary pace of work — a gate nothing moves is `stalled-item`. Failed actions are not read here:
 * the action history retains failures long after they stopped mattering, so each is noted once, as it happens, by storeAction.
 */
export function cycleFaults(state: DaemonState, snapshot: Work[], now: number, sources: FaultSources = {}): FaultObservation[] {
  // A fence the loop settled — this cycle's reclaim step included — is gone, though the snapshot the cycle began with still shows it (GY-1299).
  const work = snapshot.map(item => fenceSettled(state, item) ? { ...item, containmentQuarantine: null } : item);
  const byKey = new Map(work.map(item => [item.key, item]));
  // An attempt inside the loop's own reclaim bound is the record's to name, not this step's to count (attemptReclaimInMotion, GY-1557).
  const recorded = work.flatMap(item => workFaults(item, now, attempt => attemptReclaimInMotion(state, item, attempt))).filter(fault => !(containmentKinds.has(fault.kind) && containmentInMotion(byKey.get(fault.subject), now)));
  // A blocker inside its actor's turn is not counted, nor is a derived line restating it (`shown` below keeps it).
  const own = recorded.filter(fault => !(fault.kind === 'blocker' && blockerInMotion(byKey.get(fault.subject), now)));
  const derived: FaultObservation[] = [], attributed: FaultObservation[] = [];
  // The owed lines that restate a standing fence's escalation (owedContainmentLine): past the settle bound they are the item's own `containment` fault.
  const fenceLines = new Set<FaultObservation>();
  const { config } = sources;
  if (config) {
    let status: { work: any[]; attentionItems: AttentionItem[] } = { work: [], attentionItems: [] };
    try {
      status = buildMasterStatus({ work, now: new Date(now).toISOString() }, config.workers, sources.agents ?? [], sources.credentials ?? {}, sources.containment ?? {}, undefined, config.baseBranch, sources.status ?? undefined);
    } catch (error) {
      derived.push({ ...classified('loop-failures'), subject: 'loop', text: `The loop could not derive this cycle's attention to classify it: ${message(error)}`.slice(0, 500) });
    }
    const listed = { work: status.work, attentionItems: [...(sources.loop ?? []), ...status.attentionItems, ...(sources.reported ?? [])] };
    for (const item of classifyAttention(sources.attribute ? sources.attribute(listed) : listed.attentionItems))
      if (item.kind !== 'gate' && item.kind !== 'containment-grace' && !(sources.herdrUnavailable && herdrFaultKinds.has(item.kind))
        && !(containmentKinds.has(item.kind) && containmentInMotion(byKey.get(item.subject), now))
        && !(item.kind === 'base-conflict' && baseConflictInMotion(byKey.get(item.subject), now))
        && !(item.kind === 'merge-base-dismissed' && mergeBaseDismissalInMotion(byKey.get(item.subject), now))
        && !(item.kind === 'stalled-step' && reworkDecisionInMotion(byKey.get(item.subject), now))
      && !(item.kind === 'session' && sessionEndInMotion(state, byKey.get(item.subject), now))
        && !(item.kind === 'owed-decision' && owedReworkLine(byKey.get(item.subject), item.text) && reworkDecisionInMotion(byKey.get(item.subject), now))
        && !(item.kind === 'owed-decision' && owedEscalationInMotion(byKey.get(item.subject), item.text, now))
        && !(item.kind === 'owed-decision' && owedContainmentLine(byKey.get(item.subject), item.text) && !standingFence(byKey.get(item.subject), now))
        && !(item.inMotionUntil && Date.parse(item.inMotionUntil) > now))
        if (item.kind === 'resource-bound' && item.resource) attributed.push({ kind: item.kind, faultClass: item.faultClass, subject: `resource:${item.resource}`, text: item.text.slice(0, 500) });
        else {
          const fault: FaultObservation = { kind: item.kind, faultClass: item.faultClass, subject: item.subject, text: item.text.slice(0, 500) };
          if (item.kind === 'owed-decision' && owedContainmentLine(byKey.get(item.subject), item.text)) fenceLines.add(fault);
          derived.push(fault);
        }
    // GY-1272: a symptom the report attributes to a registered resource is that resource's one fault, on the resource's own subject:
    // one spent GitHub budget holding five subjects at once was six instances of its class. The resource's own line stands for it,
    // and where none was listed the first symptom does.
    for (const fault of attributed) if (!derived.some(other => other.kind === fault.kind && other.subject === fault.subject)) derived.push(fault);
    // The worktree volume at the last reclaim, judged as the registry reading judges it (GY-1784): a low reading the pass answered — current
    // and drained, the volume above its floor — raises nothing, and one whose fault stands is still low inside the recovery band.
    const reclaim = state.reclaim, below = (free: number | null | undefined, bound: number) => free !== null && free !== undefined && free < bound;
    if (reclaim) {
      const judged = judgeWorktreeDisk({ freeBytes: reclaim.freeBytes, thresholdBytes: diskThresholdBytes(config), pass: worktreePassOf(reclaim), standing: standingDiskLine(state.faults.open, 'disk-pressure'), reclaimable: sources.worktreeReclaimable }, now);
      if (judged.low && !judged.answered)
        derived.push({ ...classified('disk-pressure'), subject: 'disk', text: `${worktreeVolumeWording}below its configured bound at the last reclaim (${reclaim.at})` });
      // The managed root's own minimum is its own condition, judged on the root's reading alone: the worktree volume's recovery band never holds it open.
      if (below(reclaim.rootFreeBytes, worktreeRootMinFreeBytes(config)))
        derived.push({ ...classified('disk-pressure'), subject: 'disk', text: `Managed worktree root free space is below its minimum at the last reclaim (${reclaim.at})` });
    }
    // A host below its memory floor defers every launch on it (GY-612): one instance for the whole dip. A fault is its
    // wording, and the attention item's text names consumers whose ranking moves from cycle to cycle, so this wording
    // carries none of it — the attention item keeps the moving detail, and the instance stands until memory recovers.
    for (const item of hostMemoryAttention(state.memory)) derived.push({ ...classified('memory-pressure'), subject: item.subject, text: 'Host memory is below its floor: new session launches on this host are deferred until it recovers (the memory attention item names the current top consumers)' });
  }
  // The reported attention names each unserved executor kind on the item it holds, and master status already derived its installation
  // lines from the same status: the status's copy of those lines is not a second fault (distinct faults of one kind stay distinct).
  const derivedKinds = new Set(derived.map(fault => `${fault.kind}|${fault.subject}`));
  if (sources.status || sources.jobs?.length) derived.push(...statusFaults({ github: true, ...sources.status, jobs: sources.jobs ?? [] }).filter(fault => !(sources.reported && fault.kind === 'executor') && !derivedKinds.has(`${fault.kind}|${fault.subject}`)));
  const shown = new Set(recorded.map(fault => `${fault.subject}|${fault.kind}`));
  return [...own, ...derived.filter(fault => ![fault.kind, ...(restatements[fault.kind] ?? []), ...(fenceLines.has(fault) ? ['containment'] : [])].some(kind => shown.has(`${fault.subject}|${kind}`)))];
}
/**
 * GY-1863. Whether a finished worker session the status attention names is still inside the loop's
 * own recovery for exactly that state: the sessions step ends such an attempt itself — the orphan
 * watch needs two observations (the lease advancing past the one first seen with the session gone)
 * and the gone-worker preserve establishes the same way, both tracked under the item's id in
 * `state.orphans` and `state.absences`. A `session` line standing inside that establishment is the
 * machinery working, the ordinary pace of work as containmentInMotion is; on 17 October 2026
 * GY-1860's session counted at 03:59:33Z, two minutes before the same machinery's preserve ended
 * its attempt. Once the records are gone — the attempt ended, or the machinery stood down without
 * ending it — the line counts again, as the failed recovery it is. The grace is bounded like
 * containmentInMotion's: an establishment that outlives `sessionEndMotionBoundMs` (a stop or a
 * preserve that keeps failing) stops hiding the line, whose own failed escalation or preserve
 * action still surfaces beside it.
 */
export const sessionEndMotionBoundMs = 30 * 60_000;
export function sessionEndInMotion(state: Pick<DaemonState, 'orphans' | 'absences'>, work: Pick<Work, 'id'> | undefined, now: number): boolean {
  const seen = work ? state.orphans[work.id] ?? state.absences[work.id] : undefined;
  return !!seen && now - Date.parse(seen.firstSeenAt) <= sessionEndMotionBoundMs;
}
/**
 * GY-1403. Whether an item's blocker is still in motion: it was raised within `masterTurnWaitBoundMs`
 * of now. It is dated by the record the `blocked` report writes in the same transaction that ends
 * the attempt — the worker's `interrupted` exhaustion for the item's current epoch, whose reason
 * carries the blocked-attempt marker — because `capacity` is kept by the coordination view the loop
 * reads, where the pipeline timeline is dropped. A blocker is handed on at once — the loop's blocker
 * step re-probes a routine class every cycle and hands any other to the master, whose turn moves the
 * remedy — so one that recent is the ordinary pace of work, as an owed escalation is
 * (owedEscalationInMotion). On 7 October 2026 GY-1292's blocker counted 100s after it was raised;
 * the master requested the requirements decision that applied the operator's approved revision of
 * its AC-1 within four minutes, and the item was unblocked in thirty. A blocker the record cannot
 * date (one no `blocked` report of this epoch raised) counts at once, as before.
 */
export function blockerInMotion(work: Work | undefined, now: number): boolean {
  if (!work?.blocker) return false;
  const raised = (work.capacity?.exhaustions ?? []).filter(record => record.role === 'worker' && record.cause === 'interrupted' && record.epoch === work.epoch
    && (record.reason.startsWith(`${blockedAttemptMarker}${work.epoch}:`) || record.reason.startsWith(`${credentialBlockedMarker} on epoch ${work.epoch}:`))).at(-1);
  const since = raised ? Date.parse(raised.at) : Number.NaN;
  return Number.isFinite(since) && now - since <= masterTurnWaitBoundMs;
}
/**
 * GY-1557. Whether an attempt held past the worker bound without a submission (one workFaults
 * would observe) is still in motion: the loop's own remedy ends it at the reclaim bound
 * (`workerReclaimBoundMs`, cycle-reclaim.ts stopUnboundedAttempts), one further bound after the
 * record first names it, so an attempt inside that bound is the ordinary pace of work — on
 * 8 October 2026 GY-1549 counted at 0 minutes past the worker bound, an hour before the remedy's
 * turn. Past it, an attempt the loop ended this cycle is gone though the snapshot the cycle began
 * with still shows its lease (the rule a settled fence keeps, `fenceSettled`); one it could not end
 * counts, as the failed end is recorded. A lapsed lease belongs to the lapse-and-containment path,
 * whose fence counts under its own kinds.
 */
export function attemptReclaimInMotion(state: Pick<DaemonState, 'actions' | 'cycle'>, work: Pick<Work, 'id'>, attempt: UnsubmittedAttempt): boolean {
  if (!attempt.reclaim || !attempt.live) return true;
  const ended = state.actions[unboundedAttemptKey(work, attempt.epoch)];
  return ended?.state === 'done' && ended.cycle === state.cycle;
}
/** Whether the loop recorded the settlement of the item's standing fence: its settle action for the fence's epoch is done. */
const fenceSettled = (state: Pick<DaemonState, 'actions'>, item: Work) =>
  !!item.containmentQuarantine && state.actions[`settle:${item.id}:${item.containmentQuarantine.epoch}`]?.state === 'done';
/** The kinds a lapsed fence is counted under: the item's own record, and the settle or hold line master status derives for it. */
const containmentKinds: ReadonlySet<FaultKind> = new Set<FaultKind>(['containment', 'containment-settleable']);
export { containmentSettleWaitBoundMs };
export { containmentInMotion };
/**
 * GY-1337. Whether an owed line names the item's containment escalation: its open action escalates
 * the `containment` trigger and the line carries that action's own owed decision (`needsHuman.decision`,
 * "resolving GY-N's containment refusal"). It restates the fence, not a separate judgement, so it
 * is counted as the fence is: never while the fence is in motion (containmentInMotion) or settled
 * this cycle, and past the settle bound as the item's own `containment` fault, not a second one.
 * On 5 October 2026 GY-1329's line counted as an `owed-decision` 15s after its lease lapsed, inside
 * the grace window that kept the fence itself from counting.
 */
export function owedContainmentLine(work: Work | undefined, text: string): boolean {
  const action = work && openAction(work);
  const decision = action?.kind === 'escalate' && action.inputs.kind === 'escalate' && action.inputs.trigger === 'containment' ? action.needsHuman?.decision : undefined;
  return !!decision && text.includes(decision);
}
/** Whether the item still holds a fence the loop is not settling: standing and past containmentInMotion's bound. */
const standingFence = (work: Work | undefined, now: number) => !!work?.containmentQuarantine && !containmentInMotion(work, now);
/**
 * GY-1269. Whether an owed line names the item's rework decision: its open action is `request-rework`
 * and the line carries that action's own owed decision (`needsHuman.decision`), the phrase
 * `humanNeededActions` puts in the action's row and `humanNeededAttention` reports. The phrase is
 * read from the item, not restated here, so rewording it in concerns.ts or the line around it in
 * owed-report.ts cannot silently disarm the rework guard. A concern carried beside the action
 * (a standing escalation) is owed under its own decision, so its line is not this one and counts at once.
 */
export function owedReworkLine(work: Work | undefined, text: string): boolean {
  const action = work && openAction(work);
  const decision = action?.kind === 'request-rework' ? action.needsHuman?.decision : undefined;
  return !!decision && text.includes(decision);
}
/** How long a rework decision (a new head owed by `request-rework`) may stay owed before it counts as a decision fault (GY-1251). */
export const reworkDecisionWaitBoundMs = 30 * 60_000;
/**
 * GY-1251. Whether the rework decision an item owes is still in motion: its open action is
 * `request-rework` and the queue row for that action was requested within `reworkDecisionWaitBoundMs`.
 * The loop requests that decision and supervises its approver session on its own (cycle-decisions
 * step 4c), so a new head owed for minutes after a failed CI rerun or a reviewer's changes is the
 * ordinary rework round, not a decision fault (GY-1168, GY-1244, GY-1238, GY-1062, GY-1124 on
 * 5 October 2026: each counted 15s to 4m after the action was computed). A rework owed past the
 * bound counts, as does one with no queue row to date it; an owed escalation is never in motion here.
 */
export function reworkDecisionInMotion(work: Work | undefined, now: number): boolean {
  const action = work && openAction(work);
  if (action?.kind !== 'request-rework') return false;
  const row = (work!.actionQueue?.actions ?? []).find(entry => entry.kind === action.kind && entry.binding === action.binding);
  const since = row?.requestedAt ? Date.parse(row.requestedAt) : Number.NaN;
  return Number.isFinite(since) && now - since <= reworkDecisionWaitBoundMs;
}
/**
 * GY-1346. Whether an owed line names the item's own escalation — any trigger but `containment`,
 * which is counted as its fence is (owedContainmentLine) — and the master's turn to resolve it is
 * still running: the queue row for that escalate action was requested within `masterTurnWaitBoundMs`.
 * The loop wakes the master on the changed item and the master resolves the escalation or asks an
 * approver to, so an escalation owed for minutes is that turn, not a decision fault: on 6 October
 * 2026 GY-1335's requirement-weakening line counted 3m after its row was queued, 31s after the master
 * had asked for the resolve decision. Past the bound it counts, as does a row with no instant to date it.
 */
export function owedEscalationInMotion(work: Work | undefined, text: string, now: number): boolean {
  const action = work && openAction(work);
  if (!action) return false;
  const inTurn = (at: string | null | undefined) => { const since = at ? Date.parse(at) : Number.NaN; return Number.isFinite(since) && now - since <= masterTurnWaitBoundMs; };
  const decision = action.kind === 'escalate' && action.inputs.kind === 'escalate' && action.inputs.trigger !== 'containment' ? action.needsHuman?.decision : undefined;
  if (decision && text.includes(decision)) {
    const row = (work!.actionQueue?.actions ?? []).find(entry => entry.kind === action.kind && entry.binding === action.binding);
    return inTurn(row?.requestedAt);
  }
  // GY-1374: an escalation the control plane raised while the item is worked is carried beside the
  // running action, with no queue row of its own, and its line is owed from the escalation's own
  // instant (humanNeededActions). It is the same master's turn: GY-1373's lease-loss counted 25s in.
  return (action.carried ?? []).some(concern => concern.trigger !== 'containment' && text.includes(carriedDecision(work!.key, concern.trigger)) && inTurn(concern.at));
}
/** How long an approval dismissed for a merge-base change may stay in motion before it counts as a review-convergence fault (GY-1140). */
export const mergeBaseDismissalWaitBoundMs = 30 * 60_000;
/**
 * GY-1140. Whether a merge-base dismissal is still in motion: GitHub dismissed the approval of the
 * current candidate because the merge base changed, and that dismissal is inside `mergeBaseDismissalWaitBoundMs`.
 * The control plane handles this on its own (it restores the approval on the unchanged head, or
 * requests a fresh review of a head that lacks the base tip), so the dismissal
 * is a step in motion, not a review-convergence fault (GY-1136, counted 2.4 minutes after dismissal).
 * A dismissal that stands past the bound counts.
 */
export function mergeBaseDismissalInMotion(work: Work | undefined, now: number): boolean {
  if (!work?.candidate) return false;
  const dismissal = mergeBaseDismissal(work);
  if (!dismissal?.at) return false;
  const since = Date.parse(dismissal.at);
  return Number.isFinite(since) && now - since <= mergeBaseDismissalWaitBoundMs;
}
/**
 * GY-1129. Whether a base refresh conflict is still in motion: the candidate has a confirmed conflict
 * with the base branch, first found on this head within `baseConflictWaitBoundMs` (the time the loop takes
 * to return the item and decide its rework). The control plane requests and approves that rework on
 * its own, so a conflict that recent is a step it is already handling, not a merge fault (GY-501,
 * GY-1073, GY-417 on 3 October 2026: each counted within minutes of the conflict). `reworkRequested`
 * plays no part: a conflict still standing past the bound counts as a merge fault whether or not rework
 * was requested. The bound runs from the first conflict on this head (`conflictSince`, GY-1200), not
 * from the latest refresh: each refresh onto a new base tip re-records the conflict, and on a base that
 * moves more often than the bound an unhandled conflict would otherwise never count.
 */
export function baseConflictInMotion(work: Work | undefined, now: number): boolean {
  if (!work?.candidate) return false;
  if (!baseRefreshConflict(work)) return false;
  const since = work.baseRefresh?.conflictSince ?? work.baseRefresh?.at;
  return !!since && now - Date.parse(since) <= baseConflictWaitBoundMs;
}
/** The kinds read from Herdr's session inventory: an unreadable Herdr lists none, so they go unobserved rather than read as missing sessions. */
export const herdrFaultKinds: ReadonlySet<FaultKind> = new Set<FaultKind>(['session', 'overlong-session', 'concurrency-starved']);
/**
 * The derived lines that restate a fault the item's own record holds under another kind: a fence's settle or grace line
 * is the fence, an exhausted reviewer is the item's spent account, a missing session is its lost lease, and a gate with
 * no action named is the blocker holding it. A derived line of the item's own kind always restates it.
 */
export const restatements: Partial<Record<FaultKind, FaultKind[]>> = {
  'containment-settleable': ['containment'], 'containment-grace': ['containment'], 'reviewer-exhausted': ['role-capacity'], 'session': ['escalation:lease-loss'], 'stalled-item': ['blocker', 'sandbox-blocker', 'workflow-permission'],
};
/**
 * A failing run ends when its action succeeds (noteActionOutcome), and also when the loop no longer
 * keeps the action's row or the row has not been attempted again within the recurrence window: a
 * one-shot failure (a timestamped refusal, a terminal action) never records the success that would
 * end it, and a run left standing would keep its instance past the retention bound for ever. The
 * action failing again after that opens a new instance.
 */
export function endFailingRuns(state: Pick<DaemonState, 'actions' | 'faults'>, policy: FaultClassPolicy, now: number) {
  const from = now - policy.windowHours * 3_600_000;
  for (const action of Object.keys(state.faults.failing)) {
    const row = state.actions[action];
    if (!row || row.state === 'done' || !(Date.parse(row.at) >= from)) delete state.faults.failing[action];
  }
}
/**
 * One master-status attention line per recurring class (GY-2186). A class whose instances in the
 * policy window reach the policy threshold reads as one attention line naming the class, the count,
 * the window and the latest instance. The faults step files no work item for any class, whatever
 * the count: the master reads the line and removes the cause the instances share.
 */
export function recurringFaultAttention(state: Pick<DaemonState, 'faults'>, policy: FaultClassPolicy, now: number): AttentionItem[] {
  return recurringClasses(state.faults.instances, policy, now)
    .filter(recurrence => recurrence.count >= policy.threshold)
    .map(recurrence => {
      const latest = recurrence.recent.at(-1)!;
      return { subject: `fault:${recurrence.faultClass}`, text: `${recurrence.faultClass} recurred ${recurrence.count} times in the last ${policy.windowHours} hours, latest at ${latest.at}: ${latest.text}`.slice(0, 1000),
        ...agentOwner('master', 'Find and remove the cause the instances share; the loop files no item for a recurring class') };
    });
}
/** The recurrences `master status` reports under daemon.faults: per class, the window's count and its latest instance. */
export function faultRecurrenceReport(state: Pick<DaemonState, 'faults'>, policy: FaultClassPolicy, now: number) {
  const instances = state.faults.instances;
  return { policy, recorded: instances.length, standing: Object.keys(state.faults.open).length,
    classes: faultClasses.flatMap(faultClass => {
      const from = now - policy.windowHours * 3_600_000, inWindow = instances.filter(entry => entry.faultClass === faultClass && Date.parse(entry.at) >= from);
      return inWindow.length ? [{ faultClass, instances: inWindow.length, latest: inWindow.at(-1)!.at }] : [];
    }).sort((a, b) => b.instances - a.instances) };
}

/**
 * How often the loop reads the sources standing faults are observed from: the control plane's status, the attention
 * `master status` adds and Herdr's inventory. They cost API and filesystem reads, and a fault that stands is one instance
 * however often it is seen, so a cycle inside this interval of the last observation reads none of them. A fault that
 * stood and cleared between two observations goes unseen, which counts nothing early toward a class.
 */
export const faultObservationIntervalMs = 60_000;
/**
 * GY-1345: what the observation of standing faults may spend before it stops reading. Its reads are
 * the control plane's status and the attention `master status` adds, which reads every open item;
 * while the plane answered in 1-21s on 2026-10-06 they took 372s of cycle 12621, past the 300s
 * interval (loop-cost). Like the decisions step's budget (GY-1286), a fifth of the interval, never
 * under the 30s actionable cadence: a read still unanswered at the bound is left in flight, the
 * cycle is partial, so nothing standing ends on what went unread, and the next cycle observes again.
 */
export const faultObservationBudgetMs = (intervalMs: number) => Math.max(actionableIntervalMs, Math.round(intervalMs * 0.2));
const unread = Symbol('unread');
type Observed<T> = { value: T; failed: boolean };
/**
 * The observation's reads still in flight, per loop state and source. A read the budget cut keeps
 * running with nothing to stop it, so a cycle that finds one here starts no other: at the 30s
 * actionable cadence a 350s read would otherwise stack a dozen full-plane reads on the plane already
 * too slow to answer one. Nor does that cycle wait on it again: it takes the answer if it has landed
 * and is otherwise partial at once, so only the cycle that asked spends the budget and a slow window
 * does not stretch every cycle to it (cycle-p90). An answer that lands between cycles is kept until
 * a cycle takes it; one taken leaves the slot free for the next observation's read.
 */
const observing = new WeakMap<object, Map<string, Promise<Observed<unknown>>>>();
/** The pending read of `source`, or `read()` started now (`started`); never more than one per loop state and source. */
function singleFlight<T>(owner: object, source: string, read: () => Promise<Observed<T>>) {
  let reads = observing.get(owner);
  if (!reads) observing.set(owner, reads = new Map());
  const pending = reads.get(source) as Promise<Observed<T>> | undefined;
  if (pending) return { pending, started: false };
  const started = read();
  reads.set(source, started);
  return { pending: started, started: true };
}
/** How many of the observation's reads `owner` has in flight or answered but not yet taken. */
export function observationReadsPending(owner: object) { return observing.get(owner)?.size ?? 0; }
/**
 * The source's answer, or `unread` when the deadline passes first — at once for a read an earlier cycle
 * started that has not landed. The read is single-flight across cycles, and a taken answer frees its
 * slot. `read` settles its own failure into `failed`, so a read left behind rejects nowhere.
 */
async function withinBudget<T>(owner: object, source: string, read: () => Promise<Observed<T>>, deadline: number, now: () => number): Promise<Observed<T> | typeof unread> {
  const { pending, started } = singleFlight(owner, source, read), remaining = started ? deadline - now() : 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof unread>(resolve => { timer = setTimeout(() => resolve(unread), Math.max(0, remaining)); });
  try {
    const answer = await Promise.race([pending, expired]);
    if (answer !== unread && observing.get(owner)?.get(source) === pending) observing.get(owner)!.delete(source);
    return answer;
  } finally { clearTimeout(timer); }
}
const observedWithin = 'The faults step observed every source within its budget';
/**
 * Step 7b: classify what this cycle saw standing wrong and record its instances. Standing faults are
 * observed at most once per faultObservationIntervalMs; failed actions are noted as they happen, so
 * every cycle still ends silent failing runs. The step files no work item (GY-2186): a recurring
 * class is one master-status attention line (recurringFaultAttention), and the loop launches no
 * diagnostician. A read that fails makes the cycle partial: faults its source would have shown were not
 * observed, so none standing ends this cycle (and none reopens as a new instance next cycle).
 * A Herdr that cannot be read lists no sessions, which would make every live lease a missing
 * session: the kinds read from its inventory are neither opened nor ended that cycle.
 */
export async function faultStep(cycle: Cycle, assessments: Record<string, ContainmentAssessment>) {
  const { config, state, effects, now, snapshot, clock, performed, agents, credentials } = cycle;
  // The cadence is the loop's own time, as the reads it spaces out are: the snapshot's clock need not move between cycles.
  const policy = effects.faultClassPolicy ?? faultClassPolicyFromEnv(process.env), last = state.faults.observedAt ? Date.parse(state.faults.observedAt) : Number.NaN, local = now();
  const budgetMs = faultObservationBudgetMs(config.run.intervalSeconds * 1000), deadline = local + budgetMs, unreadSources: string[] = [];
  if (local >= last && local - last < faultObservationIntervalMs) { // a local clock that went back observes again
    return endFailingRuns(state, policy, clock);
  }
  const lastObservedAt = state.faults.observedAt;
  state.faults.observedAt = new Date(local).toISOString();
  let partial = false, reported: ReportedAttention | undefined;
  const herdrRead = effects.herdr ? await Promise.resolve(effects.herdr()).catch(() => ({ agents: [] as HerdrAgent[], available: false })) : { agents, available: true };
  const seen = herdrRead.available ? herdrRead.agents : [];
  const status = effects.controlPlane ? await withinBudget(state, 'status', () => effects.controlPlane!().then(value => ({ value, failed: false }), () => ({ value: null, failed: true })), deadline, now) : null;
  if (status === unread) unreadSources.push("the control plane's status");
  else if (status?.failed) partial = true;
  const controlPlane = status === unread ? null : status?.value ?? null;
  const summary = daemonSummary(state, clock, config.run.intervalSeconds * 1000, config.hostId, policy);
  if (controlPlane && effects.reportedAttention) {
    // The loop reading its own cursor is cycling (GY-1379): the lag since its last completed cycle is the cycle under way, or the
    // restart before it, which the loop-cost lines and the supervisor answer — the executor-liveness reading never counts it as a stall.
    const self = { ...summary.liveness, state: 'running' as const, self: true };
    const read = await withinBudget(state, 'attention', () => effects.reportedAttention!(snapshot.work, controlPlane, { agents: seen, available: herdrRead.available, approvals: summary.approvals, loop: self, now: new Date(clock).toISOString(),
      // GY-2015: the writer's own summary, so a trial refusal its queue holds reads as its motion in the lines this cycle counts.
      mergeWriter: summary.mergeWriter })
      .then(value => ({ value, failed: false }), error => ({ value: { items: [{ subject: 'loop', text: `The loop could not read the attention master status adds to classify it: ${message(error)}`, kind: 'loop-failures' } as AttentionItem] } as ReportedAttention, failed: true })), deadline, now);
    if (read === unread) unreadSources.push('the attention master status adds');
    else { reported = read.value; if (read.failed) partial = true; }
  }
  // A source the budget cut is unread: the cycle is partial, and the next cycle observes again (taking the read in flight) rather than waiting out the interval.
  if (unreadSources.length) { partial = true; state.faults.observedAt = lastObservedAt; }
  await noteObservationBudget(cycle, budgetMs, unreadSources);
  // The loop's own health lines, as master status puts them first: its cost and delivery budget. The loop reading
  // them is cycling, so its liveness is not in question here, and a failed cycle is noted once as it happens (noteCycleFailure).
  const loop = [...loopAttention({ liveness: { ...summary.liveness, state: 'running' }, budget: summary.budget, cost: summary.cost }), ...baseFailureAttention(summary.baseFailures, config.baseBranch)];
  endFailingRuns(state, policy, clock);
  // The system invariants (GY-404): properties of the running pipeline no per-item gate can see,
  // judged on each observation over the same snapshot; each violation is one fault of its class below.
  const invariants = checkInvariants(state.invariants, { work: snapshot.work, now: clock, thresholds: config.invariants, metrics: state.metrics, approvals: state.approvals, docsSyncs: state.docsSyncs,
    agents: herdrRead.available ? seen : null, build: controlPlane?.build?.commit ?? null });
  const worktreeReclaimable = effects.worktreeReclaimable ? await effects.worktreeReclaimable(snapshot.work, clock).catch(() => null) : undefined;
  trackFaults(state.faults, [...cycleFaults(state, snapshot.work, clock, { config, agents: seen, credentials, containment: assessments, status: controlPlane, jobs: snapshot.jobs, reported: reported?.items, attribute: reported?.attribute, loop, herdrUnavailable: !herdrRead.available, worktreeReclaimable }), ...invariantFaults(invariants)],
    new Date(clock).toISOString(), partial || (herdrRead.available ? false : new Set<string>([...herdrFaultKinds, invariantFaultKind('lingering-sessions')])));
}

/** Record a cut observation, so the journal and `master status` say the step was bounded rather than blind; a full one supersedes the last cut once. */
async function noteObservationBudget(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'performed'>, budgetMs: number, unreadSources: string[]) {
  const { state, effects, now, performed } = cycle, key = 'faults:deferred', standing = state.actions[key];
  if (!unreadSources.length) {
    if (standing && !standing.detail.startsWith(observedWithin)) performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'done', attempts: standing.attempts + 1, cycle: state.cycle, detail: `${observedWithin}; nothing was left unread` }, now(), effects.persist, null));
    return;
  }
  performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'done', attempts: (standing?.attempts ?? 0) + 1, cycle: state.cycle,
    detail: `The faults step spent its ${Math.round(budgetMs / 1000)}s observation budget before ${unreadSources.join(' and ')} answered, so the cycle is partial: nothing standing ends on what went unread, and a later cycle takes the answer of the read still in flight once it lands rather than starting another` }, now(), effects.persist, null));
}
