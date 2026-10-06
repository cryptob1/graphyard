// Concern: fault classification (GY-173) — what the cycle saw standing wrong, classified, and one
// structural item filed per recurring class.
import { createHash } from 'node:crypto';
import type { Work } from '../model.js';
import { classified, classifyAttention, faultClasses, faultClassItem, faultClassPolicyFromEnv, recurringClasses, standingScopeRequest, statusFaults, trackFaults, workFaults, type FaultClassPolicy, type FaultKind, type FaultObservation } from '../model/fault-classes.js';
import { buildMasterStatus, diskThresholdBytes, type AttentionItem, type ContainmentAssessment, type ControlPlaneStatus, type HerdrAgent, type MasterConfig } from '../master.js';
import { worktreeRootMinFreeBytes } from '../install/worktree-root.js';
import { hostMemoryAttention } from '../master-resources.js';
import { qualifyTimingFailures, type CheckAnnotations } from '../cli/timing-failures.js';
import { type DaemonAction, type DaemonState, faultActionKey, message } from './state.js';
import { readyToRetry } from './sessions.js';
import { type DaemonEffects, record } from './effects.js';
import { actionableIntervalMs, loopAttention } from './liveness.js';
import { planeWideRefusal } from '../model/blocker-class.js';
import { daemonSummary } from './run.js';
import { baseFailureAttention } from './cycle-base-failures.js';
import type { Cycle } from './cycle.js';
import { budgetedPage, docsHeadroom, docsHeadroomText, docsTrimItem, docsWords, openDocsTrimItem, repositoryConfigFile, repositoryDocsBudget, type DocsHeadroom, type DocsWordBudget, type DocsWordCount } from '../model/documentation.js';
import { agentOwner } from '../master/attention.js';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { diagnosisStep, standingFaultClassItem } from './diagnosis.js';
import { candidateKey } from './reconcile.js';
import { checkInvariants, invariantFaultKind, invariantFaults } from '../model/invariants.js';
import { baseRefreshConflict } from '../merge-queue.js';
import { mergeBaseDismissal } from '../merge-base-ancestry.js';
import { containmentGraceMs, containmentPhase } from '../model/containment.js';
import { openAction } from '../model/next-action.js';
import { masterTurnWaitBoundMs } from './decisions.js';

/** The attention `master status` adds after buildMasterStatus, and its final attribution over the whole list. */
export interface ReportedAttention { items: AttentionItem[]; attribute?: (status: { work: any[]; attentionItems: AttentionItem[] }) => AttentionItem[];
  /** The documentation word budget's headroom on the base branch (GY-574), when it could be counted. */
  docs?: { base: string; headroom: DocsHeadroom } | null }
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
  /** The loop puts a rule-refused scope request to the independent approver (GY-176), so that refusal is still being decided (GY-1085). */
  scopeRoutes?: boolean;
}
/**
 * What this cycle saw standing wrong, classified (GY-173): every open item's own faults
 * (escalations, fences, parks, scope requests, proof gaps, spent accounts, violations, blockers);
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
  const routes = sources.scopeRoutes ?? true;
  // A fence the loop settled — this cycle's reclaim step included — is gone, though the snapshot the cycle began with still shows it (GY-1299).
  const work = snapshot.map(item => fenceSettled(state, item) ? { ...item, containmentQuarantine: null } : item);
  const byKey = new Map(work.map(item => [item.key, item]));
  const own = work.flatMap(item => workFaults(item, now, routes)).filter(fault => !(containmentKinds.has(fault.kind) && containmentInMotion(byKey.get(fault.subject), now)));
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
    const reclaim = state.reclaim, below = (free: number | null | undefined, bound: number) => free !== null && free !== undefined && free < bound;
    if (reclaim && (below(reclaim.freeBytes, diskThresholdBytes(config)) || below(reclaim.rootFreeBytes, worktreeRootMinFreeBytes(config))))
      derived.push({ ...classified('disk-pressure'), subject: 'disk', text: `Free space below its configured bound at the last reclaim (${reclaim.at})` });
    // A host below its memory floor defers every launch on it (GY-612): one instance for the whole dip. A fault is its
    // wording, and the attention item's text names consumers whose ranking moves from cycle to cycle, so this wording
    // carries none of it — the attention item keeps the moving detail, and the instance stands until memory recovers.
    for (const item of hostMemoryAttention(state.memory)) derived.push({ ...classified('memory-pressure'), subject: item.subject, text: 'Host memory is below its floor: new session launches on this host are deferred until it recovers (the memory attention item names the current top consumers)' });
  }
  // The reported attention names each unserved executor kind on the item it holds, and master status already derived its installation
  // lines from the same status: the status's copy of those lines is not a second fault (distinct faults of one kind stay distinct).
  const derivedKinds = new Set(derived.map(fault => `${fault.kind}|${fault.subject}`));
  if (sources.status || sources.jobs?.length) derived.push(...statusFaults({ github: true, ...sources.status, jobs: sources.jobs ?? [] }).filter(fault => !(sources.reported && fault.kind === 'executor') && !derivedKinds.has(`${fault.kind}|${fault.subject}`)));
  // A scope request the product is still settling (standingScopeRequest) is no fault however its attention line reads: the snapshot may
  // predate the rule's decision this cycle took, so the line can still name a refusal the approver is about to judge (GY-1085).
  const settling = new Set(work.filter(item => item.scopeRequest && !standingScopeRequest(item, now, routes)).map(item => item.key));
  const shown = new Set([...own.map(fault => `${fault.subject}|${fault.kind}`), ...[...settling].map(key => `${key}|scope-request`)]);
  return [...own, ...derived.filter(fault => ![fault.kind, ...(restatements[fault.kind] ?? []), ...(fenceLines.has(fault) ? ['containment'] : [])].some(kind => shown.has(`${fault.subject}|${kind}`)))];
}
/** Whether the loop recorded the settlement of the item's standing fence: its settle action for the fence's epoch is done. */
const fenceSettled = (state: Pick<DaemonState, 'actions'>, item: Work) =>
  !!item.containmentQuarantine && state.actions[`settle:${item.id}:${item.containmentQuarantine.epoch}`]?.state === 'done';
/** The kinds a lapsed fence is counted under: the item's own record, and the settle or hold line master status derives for it. */
const containmentKinds: ReadonlySet<FaultKind> = new Set<FaultKind>(['containment', 'containment-settleable']);
/** How long a lapsed containment fence may wait, past its grace window, for the loop to verify and settle it before it counts as a containment fault (GY-1299). */
export const containmentSettleWaitBoundMs = 10 * 60_000;
/**
 * GY-1299. Whether a containment fence is still in motion: its owner's lease has lapsed and the
 * fence is inside its grace window or within `containmentSettleWaitBoundMs` after it. The reclaim
 * step probes the host and settles a verified-dead fence on its own (settleQuarantine; cycleFaults
 * reads a fence whose settle action is done as gone, even in the cycle that settled it), so a fence
 * that recent is a step the loop is already taking, not a fault: on 5 October 2026 GY-1147 counted
 * 11s past its grace window and autosettled 28s later, and GY-1289 counted twice for one fence —
 * once as verified settleable while its grace window still ran, once as a hold 90s later, in the
 * very cycle that settled it. Neither kind counts inside the bound, so a fence the loop settles
 * opens no instance, and one standing past it counts once, as the item's own `containment` fault
 * (the settleable line restates it). A fence with no deadline to date it counts at once.
 */
export function containmentInMotion(work: Work | undefined, now: number): boolean {
  const phase = work ? containmentPhase(work, now) : null;
  if (!phase || phase.state === 'live') return false;
  if (phase.state === 'grace') return true;
  return !!phase.lapsedAt && now - Date.parse(phase.lapsedAt) - containmentGraceMs <= containmentSettleWaitBoundMs;
}
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
/** How long a confirmed base conflict may stand on a head before it counts as a merge fault (GY-1129). */
export const baseConflictWaitBoundMs = 30 * 60_000;
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
  if (action?.kind !== 'escalate' || action.inputs.kind !== 'escalate' || action.inputs.trigger === 'containment') return false;
  const decision = action.needsHuman?.decision;
  if (!decision || !text.includes(decision)) return false;
  const row = (work!.actionQueue?.actions ?? []).find(entry => entry.kind === action.kind && entry.binding === action.binding);
  const since = row?.requestedAt ? Date.parse(row.requestedAt) : Number.NaN;
  return Number.isFinite(since) && now - since <= masterTurnWaitBoundMs;
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
/**
 * The timing-dependent check failures `master status` names (qualifyTimingFailures), for the loop to
 * track as the timing-failure class (GY-173): the unqualified gate line they replace is never counted,
 * so without them a failure on the clock could never recur to the loop and file its structural item.
 */
export async function timingFaultAttention(work: Work[], repository: string, annotations: CheckAnnotations): Promise<AttentionItem[]> {
  const none = { work: [], attentionItems: [], counts: { attention: 0 } } as unknown as Parameters<typeof qualifyTimingFailures>[0];
  return (await qualifyTimingFailures(none, work, repository, annotations)).attentionItems;
}
/**
 * A check run's annotations, read once: a completed run's annotations do not change, and the loop
 * would otherwise read every failed required check of every open candidate again each cycle. A read
 * that fails is not kept, so the next cycle reads it again.
 */
export function onceAnnotations(read: CheckAnnotations, bound = 200): CheckAnnotations {
  const kept = new Map<number, ReturnType<CheckAnnotations>>();
  return checkRunId => {
    let entry = kept.get(checkRunId);
    if (!entry) {
      if (kept.size >= bound) kept.delete(kept.keys().next().value!);
      entry = read(checkRunId);
      kept.set(checkRunId, entry);
      entry.catch(() => { if (kept.get(checkRunId) === entry) kept.delete(checkRunId); });
    }
    return entry;
  };
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
 * One structural item per recurring class (AC-2). A class whose unaccounted instances in the window
 * reach the threshold, with no open item naming it, gets one backlog item filed as the master's
 * operator-agent identity, listing the instances; while that item is open, every later instance is
 * linked to it instead of filing another. Nothing is filed below the threshold.
 */
export async function fileRecurringFaultClasses(state: DaemonState, effects: DaemonEffects, work: Work[], clock: number, now: () => number, performed: DaemonAction[], budget?: FilingBudget) {
  const policy = effects.faultClassPolicy ?? faultClassPolicyFromEnv(process.env);
  for (const recurrence of recurringClasses(state.faults.instances, work, policy, clock, standingFaultClassItem)) {
    if (recurrence.item) { for (const instance of recurrence.unlinked) instance.linkedTo = recurrence.item.key; continue; }
    if (!recurrence.file || !effects.fileFaultClass) continue;
    const key = faultActionKey(recurrence.faultClass), previous = state.actions[key];
    if (previous && previous.state !== 'done' && !readyToRetry(previous, state.cycle)) continue;
    // GY-1357: a filing the step's remaining budget cannot fit is carried, untouched, to the next cycle, which recounts the class and files it then.
    if (budget && !budget.fits()) { budget.carried.push(`the ${recurrence.faultClass} class filing`); continue; }
    const attempts = previous?.state === 'done' ? 1 : (previous?.attempts ?? 0) + 1;
    // The same instances always file under the same key, so a retry after a lost reply returns the item already filed.
    const idempotency = `fault-class:${recurrence.faultClass}:${createHash('sha256').update(recurrence.recent.map(entry => entry.id).sort().join(',')).digest('hex').slice(0, 32)}`;
    await record(state, key, { kind: 'fault', work: null, principal: null, state: 'started', detail: `Filing one item for the recurring ${recurrence.faultClass} fault class: ${recurrence.count} instances in ${policy.windowHours} hours`, attempts, cycle: state.cycle }, now(), effects.persist);
    try {
      const filed = await spend(budget, () => effects.fileFaultClass!(faultClassItem(recurrence, policy, clock), idempotency));
      for (const instance of recurrence.recent) instance.linkedTo = filed.key;
      work.push(filed);
      performed.push(await record(state, key, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} for the recurring ${recurrence.faultClass} fault class (${recurrence.count} ≥ ${policy.threshold} in ${policy.windowHours} hours), linking ${recurrence.recent.length} instance(s); later instances link to it`, attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      // GY-1344: a control plane that did not answer refused nothing about the filing; it is retried on the backoff and is no loop fault.
      // GY-1345: nor is any plane-wide refusal (a 502-504 body, a call timed out): the retry files under the same idempotency key.
      const unanswered = planeWideRefusal(error);
      performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the item for the recurring ${recurrence.faultClass} fault class${unanswered ? ' (the control plane did not answer, so it is filed on a later cycle)' : ''}: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist, unanswered ? null : undefined));
    }
  }
}
/** The budget a commit configures and its pages' words. */
export interface DocsBudgetCount { budget: DocsWordBudget; pages: DocsWordCount }
/** The last count per tree: the base branch moves far less often than the loop cycles. */
const docsCounts = new Map<string, DocsBudgetCount | null>();
/**
 * The documentation word budget the project's graphyard.json configures at `ref` in the checkout at
 * `root`, and the words per page it counts there, read from Git so the count is the base branch's
 * whatever the checkout has out. Null when the project keeps no budget there, or when unreadable.
 */
export async function docsWordCountAt(root: string, ref: string, run: ChildRun = defaultChildRun): Promise<DocsBudgetCount | null> {
  const git = async (...args: string[]) => await run('git', args, { cwd: root, timeoutMs: 30_000 });
  try {
    const tree = (await git('rev-parse', '--verify', '--quiet', `${ref}^{tree}`)).trim();
    if (docsCounts.has(tree)) return docsCounts.get(tree)!;
    const remember = (count: DocsBudgetCount | null) => {
      if (docsCounts.size >= 8) docsCounts.delete(docsCounts.keys().next().value!);
      docsCounts.set(tree, count);
      return count;
    };
    // `<mode> <type> <sha> <size>\t<path>` per file; the budget comes from the committed configuration beside the pages.
    const files = (await git('ls-tree', '-r', '-l', tree)).split('\n').map(line => line.match(/^\S+ blob \S+\s+(\d+)\t(.+)$/)).filter(match => !!match).map(match => ({ path: match![2], size: Number(match![1]) }));
    const budget = files.some(file => file.path === repositoryConfigFile) ? repositoryDocsBudget(await git('show', `${tree}:${repositoryConfigFile}`)) : null;
    if (!budget) return remember(null);
    const pages = files.filter(file => budgetedPage(file.path, budget));
    if (!pages.length) return null;
    // Every page in one `git show`, split by those sizes.
    const blobs = Buffer.from(await git('show', ...pages.map(page => `${tree}:${page.path}`)), 'utf8'), count: DocsWordCount = {};
    let at = 0;
    for (const page of pages) { count[page.path] = docsWords(blobs.subarray(at, at + page.size).toString('utf8')); at += page.size; }
    if (at !== blobs.length) return null;
    return remember({ budget, pages: count });
  } catch { return null; }
}
/**
 * The documentation word budget's headroom on the base branch (GY-574), against the budget the
 * project's graphyard.json configures there: its origin copy when the checkout has one, else the
 * local branch. A project that configures no budget is not monitored. A set within 3% of the budget
 * is an attention line for the master (`master status` and the loop read it through
 * reportedAttention), and the loop files the one trim item for it (fileDocsTrim).
 */
export async function docsHeadroomStatus(root: string, baseBranch: string, count: (root: string, ref: string) => Promise<DocsBudgetCount | null> | DocsBudgetCount | null = docsWordCountAt): Promise<{ docs: { base: string; headroom: DocsHeadroom } | null; attention: AttentionItem[] }> {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    const counted = await count(root, ref);
    if (!counted) continue;
    const headroom = docsHeadroom(counted.pages, counted.budget), text = docsHeadroomText(headroom, ref);
    return { docs: { base: ref, headroom }, attention: text ? [{ subject: 'docs', text, kind: 'resource-bound', faultClass: 'resources', ...agentOwner('master', 'The loop files one trim item for it (a docs-trim bug naming the largest pages); dispatch it ahead of items that add documentation') }] : [] };
  }
  return { docs: null, attention: [] };
}
/** The loop's action key for the documentation trim item (GY-574). */
export const docsTrimActionKey = 'fault:docs-headroom';
/** The loop's last action for the trim item opened a filing episode that no restoration has closed. */
const docsTrimEpisodeOpen = (action: DaemonAction | undefined) => action?.state === 'done' && action.detail.startsWith('Filed ');
/**
 * The documentation within 3% of its word budget on the base branch files one trim item (GY-574),
 * as the operator-agent, naming the largest pages. One saturation episode files once (review finding
 * 1 on 2639e4d6): the filing stands on the loop cursor until the first counted set with its headroom
 * records its restoration, so a trim item that closed or merged and a total that drifted file nothing
 * more — only restored headroom lets a later saturation file again. A set with its headroom files
 * nothing, and neither does a loop without the operator-agent identity.
 */
export async function fileDocsTrim(state: DaemonState, effects: Pick<DaemonEffects, 'fileFaultClass' | 'persist'>, work: Work[], docs: ReportedAttention['docs'], now: () => number, performed: DaemonAction[], budget?: FilingBudget) {
  const previous = state.actions[docsTrimActionKey];
  if (!docs?.headroom.saturated) {
    if (docs && docsTrimEpisodeOpen(previous))
      performed.push(await record(state, docsTrimActionKey, { kind: 'fault', work: null, principal: null, state: 'done', detail: `Documentation headroom restored on ${docs.base} (${docs.headroom.total} of ${docs.headroom.budget} words); the next saturation may file again`, attempts: previous!.attempts, cycle: state.cycle }, now(), effects.persist));
    return;
  }
  if (!effects.fileFaultClass || openDocsTrimItem(work) || docsTrimEpisodeOpen(previous)) return;
  if (previous && previous.state !== 'done' && !readyToRetry(previous, state.cycle)) return;
  if (budget && !budget.fits()) { budget.carried.push('the documentation trim filing'); return; }
  const attempts = previous?.state === 'done' ? 1 : (previous?.attempts ?? 0) + 1;
  // One key per base and total, so a retry after a lost reply returns the item already filed.
  const idempotency = `docs-headroom:${docs.base}:${docs.headroom.total}`;
  await record(state, docsTrimActionKey, { kind: 'fault', work: null, principal: null, state: 'started', detail: `Filing one item to restore documentation headroom: ${docs.headroom.total} of ${docs.headroom.budget} words on ${docs.base}`, attempts, cycle: state.cycle }, now(), effects.persist);
  try {
    // The trim item goes through the same operator-agent intent route as a fault-class item; it names no class.
    const filed = await spend(budget, () => effects.fileFaultClass!(docsTrimItem(docs.headroom, docs.base), idempotency));
    work.push(filed);
    performed.push(await record(state, docsTrimActionKey, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} to restore documentation headroom (${docs.headroom.total} of ${docs.headroom.budget} words on ${docs.base}); nothing more is filed until headroom is restored`, attempts, cycle: state.cycle }, now(), effects.persist));
  } catch (error) {
    performed.push(await record(state, docsTrimActionKey, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the documentation trim item: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist,
      planeWideRefusal(error) ? null : undefined));
  }
}
/** The recurrences `master status` reports under daemon.faults: per class, the window's count and the item standing for it. */
export function faultRecurrenceReport(state: Pick<DaemonState, 'faults'>, policy: FaultClassPolicy, now: number) {
  const instances = state.faults.instances;
  const linked = (faultClass: string) => [...new Set(instances.filter(entry => entry.faultClass === faultClass && entry.linkedTo).map(entry => entry.linkedTo!))];
  return { policy, recorded: instances.length, standing: Object.keys(state.faults.open).length,
    classes: faultClasses.flatMap(faultClass => {
      const from = now - policy.windowHours * 3_600_000, inWindow = instances.filter(entry => entry.faultClass === faultClass && Date.parse(entry.at) >= from);
      return inWindow.length ? [{ faultClass, instances: inWindow.length, unlinked: inWindow.filter(entry => !entry.linkedTo).length, items: linked(faultClass), latest: inWindow.at(-1)!.at }] : [];
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
 * GY-1357: what one filing or decision request of the faults step is taken to cost before the loop
 * has timed one. On 2026-10-06 each re-read the work snapshot (3.3-4.9s) and some asked for a
 * decision (about 4s), and run after the observation with no bound they held the step at 100-150s.
 */
export const faultFilingEstimateMs = 10_000;
/** The recent filings' own costs, per loop state: the slowest of them is what the next one is expected to take. */
const filingCosts = new WeakMap<object, number[]>();
/**
 * The rest of the faults step's budget, after the observation: a filing (a recurring class's item,
 * the documentation trim item) or a diagnosis's move (its fix's filing, its decision request, its
 * approver) starts only while what remains fits the slowest recent one — never more than half the
 * budget, so a plane that once answered slowly does not carry every filing for ever. One that does
 * not fit is carried, untouched: the next cycle recounts it from the same records and files it then,
 * under the same idempotency key, so nothing is dropped or filed twice.
 */
export interface FilingBudget { fits: () => boolean; spend: <T>(body: () => Promise<T>) => Promise<T>; carried: string[] }
export function filingBudget(owner: object, deadline: number, budgetMs: number, now: () => number): FilingBudget {
  let costs = filingCosts.get(owner);
  if (!costs) filingCosts.set(owner, costs = []);
  const recent = costs, expected = () => Math.min(Math.round(budgetMs / 2), recent.length ? Math.max(...recent) : faultFilingEstimateMs);
  return { carried: [], fits: () => deadline - now() >= expected(),
    async spend(body) {
      const started = now();
      try { return await body(); } finally { recent.push(Math.max(0, now() - started)); if (recent.length > 8) recent.shift(); }
    } };
}
const spend = <T>(budget: FilingBudget | undefined, body: () => Promise<T>) => budget ? budget.spend(body) : body();
/**
 * The cycle the diagnoses move on in, inside the faults step's budget: each move runs only while it
 * fits (FilingBudget), and the work snapshot a refused decision is decided afresh from is read at
 * most once per step and shared, never once per class — or, past what the budget fits, is the cycle's own.
 */
function budgetedCycle(cycle: Cycle, budget: FilingBudget): Cycle {
  let fresh: ReturnType<DaemonEffects['snapshot']> | undefined;
  const effects: DaemonEffects = Object.create(cycle.effects, { snapshot: { value: () => fresh ??= budget.fits() ? cycle.effects.snapshot() : Promise.resolve(cycle.snapshot) } });
  const isolate: Cycle['isolate'] = async (kind, item, name, body) => {
    if (!budget.fits()) { budget.carried.push(name); return undefined; }
    return cycle.isolate(kind, item, name, () => budget.spend(body));
  };
  return { ...cycle, effects, isolate };
}
/**
 * Step 7b: classify what this cycle saw standing wrong and file one item per recurring class.
 * Standing faults are observed at most once per faultObservationIntervalMs; failed actions are noted as
 * they happen, so every cycle still ends silent failing runs and files a class that reached its threshold.
 * A read that fails makes the cycle partial: faults its source would have shown were not
 * observed, so none standing ends this cycle (and none reopens as a new instance next cycle).
 * A Herdr that cannot be read lists no sessions, which would make every live lease a missing
 * session: the kinds read from its inventory are neither opened nor ended that cycle.
 */
export async function faultStep(cycle: Cycle, assessments: Record<string, ContainmentAssessment>) {
  const { config, state, effects, now, snapshot, clock, performed, agents, credentials } = cycle;
  // The cadence is the loop's own time, as the reads it spaces out are: the snapshot's clock need not move between cycles.
  const policy = effects.faultClassPolicy ?? faultClassPolicyFromEnv(process.env), last = state.faults.observedAt ? Date.parse(state.faults.observedAt) : Number.NaN, local = now();
  const budgetMs = faultObservationBudgetMs(config.run.intervalSeconds * 1000), deadline = local + budgetMs, unreadSources: string[] = [];
  const filings = filingBudget(state, deadline, budgetMs, now);
  if (local >= last && local - last < faultObservationIntervalMs) { // a local clock that went back observes again
    endFailingRuns(state, policy, clock);
    await fileRecurringFaultClasses(state, effects, snapshot.work, clock, now, performed, filings);
    return noteCarried(cycle, filings.carried);
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
    const read = await withinBudget(state, 'attention', () => effects.reportedAttention!(snapshot.work, controlPlane, { agents: seen, available: herdrRead.available, approvals: summary.approvals, loop: self, now: new Date(clock).toISOString() })
      .then(value => ({ value, failed: false }), error => ({ value: { items: [{ subject: 'loop', text: `The loop could not read the attention master status adds to classify it: ${message(error)}`, kind: 'loop-failures' } as AttentionItem] } as ReportedAttention, failed: true })), deadline, now);
    if (read === unread) unreadSources.push('the attention master status adds');
    else { reported = read.value; if (read.failed) partial = true; }
  }
  // A source the budget cut is unread: the cycle is partial, and the next cycle observes again (taking the read in flight) rather than waiting out the interval.
  if (unreadSources.length) { partial = true; state.faults.observedAt = lastObservedAt; }
  await noteObservationBudget(cycle, budgetMs, unreadSources);
  // The loop's own health lines, as master status puts them first: its cost, silence and delivery budget. The loop reading
  // them is cycling, so its liveness is not in question here, and a failed cycle is noted once as it happens (noteCycleFailure).
  const loop = [...loopAttention({ liveness: { ...summary.liveness, state: 'running' }, silence: summary.silence, budget: summary.budget, cost: summary.cost }), ...baseFailureAttention(summary.baseFailures, config.baseBranch)];
  endFailingRuns(state, policy, clock);
  // The system invariants (GY-404): properties of the running pipeline no per-item gate can see,
  // judged on each observation over the same snapshot; each violation is one fault of its class below.
  const invariants = checkInvariants(state.invariants, { work: snapshot.work, now: clock, thresholds: config.invariants, metrics: state.metrics, approvals: state.approvals, docsSyncs: state.docsSyncs,
    agents: herdrRead.available ? seen : null, build: controlPlane?.build?.commit ?? null });
  trackFaults(state.faults, [...cycleFaults(state, snapshot.work, clock, { config, agents: seen, credentials, containment: assessments, status: controlPlane, jobs: snapshot.jobs, reported: reported?.items, attribute: reported?.attribute, loop, herdrUnavailable: !herdrRead.available, scopeRoutes: !!effects.decide && !!effects.approver }), ...invariantFaults(invariants)],
    new Date(clock).toISOString(), partial || (herdrRead.available ? false : new Set<string>([...herdrFaultKinds, invariantFaultKind('lingering-sessions')])));
  // GY-1357: the filings and the diagnoses' moves share what the observation left of the budget.
  await fileRecurringFaultClasses(state, effects, snapshot.work, clock, now, performed, filings);
  await fileDocsTrim(state, effects, snapshot.work, reported?.docs, now, performed, filings);
  // 7c. Each recurring-fault item filed (this cycle included) and each invariant violation past its
  //     bound gets its diagnosis, and each diagnosis moves on by one decision (GY-439). A plane too slow
  //     to be observed within the budget would only time out the diagnoses' requests too: they wait for the next cycle.
  if (!unreadSources.length) await diagnosisStep(budgetedCycle(cycle, filings));
  await noteCarried(cycle, filings.carried);
}

const carriedNone = 'The faults step fitted every filing and decision request in its budget';
/** Record what the step carried to the next cycle, so the journal says it was bounded rather than lost; a cycle that carries nothing supersedes the last carry once. */
async function noteCarried(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'performed'>, carried: string[]) {
  const { state, effects, now, performed } = cycle, key = 'faults:carried', standing = state.actions[key];
  if (!carried.length) {
    if (standing && !standing.detail.startsWith(carriedNone)) performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'done', attempts: standing.attempts + 1, cycle: state.cycle, detail: `${carriedNone}; nothing was carried` }, now(), effects.persist, null));
    return;
  }
  performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'done', attempts: (standing?.attempts ?? 0) + 1, cycle: state.cycle,
    detail: `The faults step's budget did not fit ${carried.length} filing(s) or decision request(s), so they are carried to the next cycle rather than run inline: ${carried.slice(0, 8).join('; ')}${carried.length > 8 ? `; and ${carried.length - 8} more` : ''}` }, now(), effects.persist, null));
}

/** Record a cut observation, so the journal and `master status` say the step was bounded rather than blind; a full one supersedes the last cut once. */
async function noteObservationBudget(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'performed'>, budgetMs: number, unreadSources: string[]) {
  const { state, effects, now, performed } = cycle, key = 'faults:deferred', standing = state.actions[key];
  if (!unreadSources.length) {
    if (standing && !standing.detail.startsWith(observedWithin)) performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'done', attempts: standing.attempts + 1, cycle: state.cycle, detail: `${observedWithin}; nothing was left unread` }, now(), effects.persist, null));
    return;
  }
  performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'done', attempts: (standing?.attempts ?? 0) + 1, cycle: state.cycle,
    detail: `The faults step spent its ${Math.round(budgetMs / 1000)}s observation budget before ${unreadSources.join(' and ')} answered, so the cycle is partial: nothing standing ends on what went unread, the diagnoses wait, and a later cycle takes the answer of the read still in flight once it lands rather than starting another` }, now(), effects.persist, null));
}
