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
import { budgetedPage, docsHeadroom, docsHeadroomText, docsTrimItem, docsWords, openDocsTrimItem, type DocsHeadroom, type DocsWordCount } from '../model/documentation.js';
import { agentOwner } from '../master/attention.js';
import { defaultChildRun, type ChildRun } from '../child-runner.js';

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
/** The last count per tree: the base branch moves far less often than the loop cycles. */
const docsCounts = new Map<string, DocsWordCount>();
/**
 * Words per budgeted page (README.md and docs/**\/*.md) at `ref` in the checkout at `root`, read
 * from Git so the count is the base branch's whatever the checkout has out; null when unreadable.
 */
export async function docsWordCountAt(root: string, ref: string, run: ChildRun = defaultChildRun): Promise<DocsWordCount | null> {
  const git = async (...args: string[]) => await run('git', args, { cwd: root, timeoutMs: 30_000 });
  try {
    const tree = (await git('rev-parse', '--verify', '--quiet', `${ref}^{tree}`)).trim();
    const known = docsCounts.get(tree);
    if (known) return known;
    // `<mode> blob <sha> <size>\t<path>` per page, then every blob in one `git show`, split by those sizes.
    const pages = (await git('ls-tree', '-r', '-l', tree, '--', 'README.md', 'docs')).split('\n').map(line => line.match(/^\S+ blob \S+\s+(\d+)\t(.+)$/)).filter(match => !!match && budgetedPage(match[2])).map(match => ({ path: match![2], size: Number(match![1]) }));
    if (!pages.length) return null;
    const blobs = Buffer.from(await git('show', ...pages.map(page => `${tree}:${page.path}`)), 'utf8'), count: DocsWordCount = {};
    let at = 0;
    for (const page of pages) { count[page.path] = docsWords(blobs.subarray(at, at + page.size).toString('utf8')); at += page.size; }
    if (at !== blobs.length) return null;
    if (docsCounts.size >= 8) docsCounts.delete(docsCounts.keys().next().value!);
    docsCounts.set(tree, count);
    return count;
  } catch { return null; }
}
/**
 * The documentation word budget's headroom on the base branch (GY-574): its origin copy when the
 * checkout has one, else the local branch. A set within 3% of the budget is an attention line for the
 * master (`master status` and the loop read it through reportedAttention), and the loop files the one
 * trim item for it (fileDocsTrim).
 */
export async function docsHeadroomStatus(root: string, baseBranch: string, count: (root: string, ref: string) => Promise<DocsWordCount | null> | DocsWordCount | null = docsWordCountAt): Promise<{ docs: { base: string; headroom: DocsHeadroom } | null; attention: AttentionItem[] }> {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    const pages = await count(root, ref);
    if (!pages) continue;
    const headroom = docsHeadroom(pages), text = docsHeadroomText(headroom, ref);
    return { docs: { base: ref, headroom }, attention: text ? [{ subject: 'docs', text, kind: 'resource-bound', faultClass: 'resources', ...agentOwner('master', 'The loop files one trim item for it (a docs-trim bug naming the largest pages); dispatch it ahead of items that add documentation') }] : [] };
  }
  return { docs: null, attention: [] };
}
/** The loop's action key for the documentation trim item (GY-574). */
export const docsTrimActionKey = 'fault:docs-headroom';
/**
 * The documentation within 3% of its word budget on the base branch files one trim item (GY-574),
 * as the operator-agent, naming the largest pages; while that item is open nothing more is filed.
 * A set with its headroom files nothing, and neither does a loop without the operator-agent identity.
 */
export async function fileDocsTrim(state: DaemonState, effects: Pick<DaemonEffects, 'fileFaultClass' | 'persist'>, work: Work[], docs: ReportedAttention['docs'], now: () => number, performed: DaemonAction[]) {
  if (!docs?.headroom.saturated || !effects.fileFaultClass || openDocsTrimItem(work)) return;
  const previous = state.actions[docsTrimActionKey];
  if (previous && previous.state !== 'done' && !readyToRetry(previous, state.cycle)) return;
  const attempts = previous?.state === 'done' ? 1 : (previous?.attempts ?? 0) + 1;
  // One key per base and total, so a retry after a lost reply returns the item already filed.
  const idempotency = `docs-headroom:${docs.base}:${docs.headroom.total}`;
  await record(state, docsTrimActionKey, { kind: 'fault', work: null, principal: null, state: 'started', detail: `Filing one item to restore documentation headroom: ${docs.headroom.total} of ${docs.headroom.budget} words on ${docs.base}`, attempts, cycle: state.cycle }, now(), effects.persist);
  try {
    // The trim item goes through the same operator-agent intent route as a fault-class item; it names no class.
    const filed = await effects.fileFaultClass(docsTrimItem(docs.headroom, docs.base), idempotency);
    work.push(filed);
    performed.push(await record(state, docsTrimActionKey, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} to restore documentation headroom (${docs.headroom.total} of ${docs.headroom.budget} words on ${docs.base}); nothing more is filed while it is open`, attempts, cycle: state.cycle }, now(), effects.persist));
  } catch (error) {
    performed.push(await record(state, docsTrimActionKey, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the documentation trim item: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
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
 * Step 7b: classify what this cycle saw standing wrong and file one item per recurring class.
 * A read that fails makes the cycle partial: faults its source would have shown were not
 * observed, so none standing ends this cycle (and none reopens as a new instance next cycle).
 * A Herdr that cannot be read lists no sessions, which would make every live lease a missing
 * session: the kinds read from its inventory are neither opened nor ended that cycle.
 */
export async function faultStep(cycle: Cycle, assessments: Record<string, ContainmentAssessment>) {
  const { config, state, effects, now, snapshot, clock, performed, agents, credentials } = cycle;
  let partial = false, reported: ReportedAttention | undefined;
  const herdrRead = effects.herdr ? await Promise.resolve(effects.herdr()).catch(() => ({ agents: [] as HerdrAgent[], available: false })) : { agents, available: true };
  const seen = herdrRead.available ? herdrRead.agents : [];
  const controlPlane = effects.controlPlane ? await effects.controlPlane().catch(() => { partial = true; return null; }) : null;
  const summary = daemonSummary(state, clock, config.run.intervalSeconds * 1000, config.hostId);
  if (controlPlane && effects.reportedAttention) reported = await effects.reportedAttention(snapshot.work, controlPlane, { agents: seen, available: herdrRead.available, approvals: summary.approvals, loop: summary.liveness, now: new Date(clock).toISOString() })
    .catch(error => { partial = true; return { items: [{ subject: 'loop', text: `The loop could not read the attention master status adds to classify it: ${message(error)}`, kind: 'loop-failures' } as AttentionItem] }; });
  // The loop's own health lines, as master status puts them first: its cost, silence and delivery budget. The loop reading
  // them is cycling, so its liveness is not in question here, and a failed cycle is noted once as it happens (noteCycleFailure).
  const loop = loopAttention({ liveness: { ...summary.liveness, state: 'running' }, silence: summary.silence, budget: summary.budget, cost: summary.cost });
  endFailingRuns(state, effects.faultClassPolicy ?? faultClassPolicyFromEnv(process.env), clock);
  trackFaults(state.faults, cycleFaults(state, snapshot.work, clock, { config, agents: seen, credentials, containment: assessments, status: controlPlane, jobs: snapshot.jobs, reported: reported?.items, attribute: reported?.attribute, loop, herdrUnavailable: !herdrRead.available }),
    new Date(clock).toISOString(), partial || (herdrRead.available ? false : herdrFaultKinds));
  await fileRecurringFaultClasses(state, effects, snapshot.work, clock, now, performed);
  await fileDocsTrim(state, effects, snapshot.work, reported?.docs, now, performed);
}
