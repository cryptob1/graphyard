// Concern: fault classification (GY-173) — what the cycle saw standing wrong, classified, and one
// structural item filed per recurring class.
import { createHash } from 'node:crypto';
import type { Work } from '../model.js';
import { classified, classifyAttention, faultClasses, faultClassItem, faultClassPolicyFromEnv, recurringClasses, statusFaults, trackFaults, workFaults, type FaultClassPolicy, type FaultKind, type FaultObservation } from '../model/fault-classes.js';
import { buildMasterStatus, diskThresholdBytes, type AttentionItem, type ContainmentAssessment, type ControlPlaneStatus, type HerdrAgent, type MasterConfig } from '../master.js';
import { worktreeRootMinFreeBytes } from '../install/worktree-root.js';
import { qualifyTimingFailures, type CheckAnnotations } from '../cli/timing-failures.js';
import { type DaemonAction, type DaemonState, faultActionKey, message } from './state.js';
import { readyToRetry } from './sessions.js';
import { type DaemonEffects, record } from './effects.js';
import { loopAttention } from './liveness.js';
import { daemonSummary } from './run.js';
import type { Cycle } from './cycle.js';

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
 * cause (a full ledger, a resource at its bound) is tracked as that cause alone. A derived line that
 * restates a fault the item's own record shows (the same kind, or a kind in `restatements`) is that
 * fault, so it is not counted twice; a different fault of the same class on the item is its own
 * instance. Nor is the one-hour dwell line (`gate`) counted, which is the ordinary pace of work — a
 * gate nothing moves is `stalled-item`. Failed actions are not read here: the action history
 * retains failures long after they stopped mattering, so each is noted once, as it happens, by storeAction.
 */
export function cycleFaults(state: DaemonState, work: Work[], now: number, sources: FaultSources = {}): FaultObservation[] {
  const own = work.flatMap(item => workFaults(item, now));
  const derived: FaultObservation[] = [];
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
      if (item.kind !== 'gate' && !(sources.herdrUnavailable && herdrFaultKinds.has(item.kind))) derived.push({ kind: item.kind, faultClass: item.faultClass, subject: item.subject, text: item.text.slice(0, 500) });
    const reclaim = state.reclaim, below = (free: number | null | undefined, bound: number) => free !== null && free !== undefined && free < bound;
    if (reclaim && (below(reclaim.freeBytes, diskThresholdBytes(config)) || below(reclaim.rootFreeBytes, worktreeRootMinFreeBytes(config))))
      derived.push({ ...classified('disk-pressure'), subject: 'disk', text: `Free space below its configured bound at the last reclaim (${reclaim.at})` });
  }
  // The reported attention names each unserved executor kind on the item it holds, and master status already derived its installation
  // lines from the same status: the status's copy of those lines is not a second fault (distinct faults of one kind stay distinct).
  const derivedKinds = new Set(derived.map(fault => `${fault.kind}|${fault.subject}`));
  if (sources.status || sources.jobs?.length) derived.push(...statusFaults({ github: true, ...sources.status, jobs: sources.jobs ?? [] }).filter(fault => !(sources.reported && fault.kind === 'executor') && !derivedKinds.has(`${fault.kind}|${fault.subject}`)));
  const shown = new Set(own.map(fault => `${fault.subject}|${fault.kind}`));
  return [...own, ...derived.filter(fault => ![fault.kind, ...(restatements[fault.kind] ?? [])].some(kind => shown.has(`${fault.subject}|${kind}`)))];
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
  'containment-settleable': ['containment'], 'containment-grace': ['containment'], 'reviewer-exhausted': ['role-capacity'], 'session': ['escalation:lease-loss'], 'stalled-item': ['blocker', 'sandbox-blocker'],
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
export async function fileRecurringFaultClasses(state: DaemonState, effects: DaemonEffects, work: Work[], clock: number, now: () => number, performed: DaemonAction[]) {
  const policy = effects.faultClassPolicy ?? faultClassPolicyFromEnv(process.env);
  for (const recurrence of recurringClasses(state.faults.instances, work, policy, clock)) {
    if (recurrence.item) { for (const instance of recurrence.unlinked) instance.linkedTo = recurrence.item.key; continue; }
    if (!recurrence.file || !effects.fileFaultClass) continue;
    const key = faultActionKey(recurrence.faultClass), previous = state.actions[key];
    if (previous && previous.state !== 'done' && !readyToRetry(previous, state.cycle)) continue;
    const attempts = previous?.state === 'done' ? 1 : (previous?.attempts ?? 0) + 1;
    // The same instances always file under the same key, so a retry after a lost reply returns the item already filed.
    const idempotency = `fault-class:${recurrence.faultClass}:${createHash('sha256').update(recurrence.recent.map(entry => entry.id).sort().join(',')).digest('hex').slice(0, 32)}`;
    await record(state, key, { kind: 'fault', work: null, principal: null, state: 'started', detail: `Filing one item for the recurring ${recurrence.faultClass} fault class: ${recurrence.count} instances in ${policy.windowHours} hours`, attempts, cycle: state.cycle }, now(), effects.persist);
    try {
      const filed = await effects.fileFaultClass(faultClassItem(recurrence, policy, clock), idempotency);
      for (const instance of recurrence.recent) instance.linkedTo = filed.key;
      work.push(filed);
      performed.push(await record(state, key, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} for the recurring ${recurrence.faultClass} fault class (${recurrence.count} ≥ ${policy.threshold} in ${policy.windowHours} hours), linking ${recurrence.recent.length} instance(s); later instances link to it`, attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the item for the recurring ${recurrence.faultClass} fault class: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
    }
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
  if (local >= last && local - last < faultObservationIntervalMs) { // a local clock that went back observes again
    endFailingRuns(state, policy, clock);
    return fileRecurringFaultClasses(state, effects, snapshot.work, clock, now, performed);
  }
  state.faults.observedAt = new Date(local).toISOString();
  let partial = false, reported: ReportedAttention | undefined;
  const herdrRead = effects.herdr ? await Promise.resolve(effects.herdr()).catch(() => ({ agents: [] as HerdrAgent[], available: false })) : { agents, available: true };
  const seen = herdrRead.available ? herdrRead.agents : [];
  const controlPlane = effects.controlPlane ? await effects.controlPlane().catch(() => { partial = true; return null; }) : null;
  const summary = daemonSummary(state, clock, config.run.intervalSeconds * 1000, config.hostId, policy);
  if (controlPlane && effects.reportedAttention) reported = await effects.reportedAttention(snapshot.work, controlPlane, { agents: seen, available: herdrRead.available, approvals: summary.approvals, loop: summary.liveness, now: new Date(clock).toISOString() })
    .catch(error => { partial = true; return { items: [{ subject: 'loop', text: `The loop could not read the attention master status adds to classify it: ${message(error)}`, kind: 'loop-failures' } as AttentionItem] }; });
  // The loop's own health lines, as master status puts them first: its cost, silence and delivery budget. The loop reading
  // them is cycling, so its liveness is not in question here, and a failed cycle is noted once as it happens (noteCycleFailure).
  const loop = loopAttention({ liveness: { ...summary.liveness, state: 'running' }, silence: summary.silence, budget: summary.budget, cost: summary.cost });
  endFailingRuns(state, policy, clock);
  trackFaults(state.faults, cycleFaults(state, snapshot.work, clock, { config, agents: seen, credentials, containment: assessments, status: controlPlane, jobs: snapshot.jobs, reported: reported?.items, attribute: reported?.attribute, loop, herdrUnavailable: !herdrRead.available }),
    new Date(clock).toISOString(), partial || (herdrRead.available ? false : herdrFaultKinds));
  await fileRecurringFaultClasses(state, effects, snapshot.work, clock, now, performed);
}
