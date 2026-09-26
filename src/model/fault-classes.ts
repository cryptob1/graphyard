import { z } from 'zod';
import { isClosed } from './closure.js';
import { standingCapacity } from './capacity.js';
import { scopeRefusalBlocker } from './scope.js';
// Types only from work.ts: work.ts reaches this module through the origin schema (interventions.ts),
// so a value import back would read work.ts before it has evaluated.
import type { EscalationTrigger, Work } from './work.js';

// ---------------------------------------------------------------------------
// Fault classes (GY-173).
//
// A recurring fault used to be fixed one instance at a time: a session that never started was
// re-prompted, a scope request answered, a stale observation re-read — and the next instance of
// the same cause arrived an hour later, handled by hand again. Noticing that several symptoms
// share a cause was a coordinator's memory, not product behaviour. Here every attention item,
// escalation and pipeline fault the loop records carries a class from one shipped catalogue;
// master status and the dashboard group open problems by class with a count; and a class that
// recurs past the threshold becomes one structural backlog item, which later instances link to.
// This module is browser-safe: the dashboard classifies with it too.
// ---------------------------------------------------------------------------

export const faultClasses = ['session-liveness', 'review-convergence', 'decision', 'scope', 'overlap-hold', 'observation', 'deployment', 'configuration',
  'containment', 'merge', 'proof', 'capacity', 'resources', 'loop', 'human-decision', 'stalled-gate', 'unclassified'] as const;
export type FaultClass = typeof faultClasses[number];

/** What each class means: the shared cause its instances point at. */
export const faultClassMeaning: Record<FaultClass, string> = {
  'session-liveness': 'a session that did not start, stopped, went quiet, ran past its bound or lost its lease',
  'review-convergence': 'a review that does not settle: conflicting or dismissed verdicts, a review nobody obtains, a security concern',
  'decision': 'a two-party decision refused, stale, unanswered or without an approver, or an escalation that outgrew its context',
  'scope': 'work that needs files outside its plannedFiles, rewrites files outside them, or weakens its requirements',
  'overlap-hold': 'work held behind overlapping work past the hold bound',
  'observation': 'a read of GitHub or of a check that is paused, stale or silent',
  'deployment': 'a merged change production does not serve, or a claim unverified against the release',
  'configuration': 'a permission, variable, setup step, executor or sandbox rule the installation lacks',
  'containment': 'a containment fence on a lapsed attempt waiting to be verified or settled',
  'merge': 'a candidate that cannot land cleanly: a base conflict, a contaminated branch, an unauthorized or reverted merge',
  'proof': 'a proof nobody may produce, a producer that cannot run, an evidence conflict or a timing-dependent check',
  'capacity': 'a provider account out of quota or a role starved of slots',
  'resources': 'a host resource at its bound: disk, a session ledger, a registered resource',
  'loop': 'the master loop or the dispatcher not cycling, failing cycles, or missing its budget',
  'human-decision': 'a wait on one of the three decisions only a human may make',
  'stalled-gate': 'an item holding a failing gate with nothing moving it',
  'unclassified': 'an attention line no catalogue entry recognises; a recurrence means the catalogue needs an entry',
};

/**
 * The catalogue: every fault kind the product raises, listed under exactly one class.
 * `tests/fault-classes.test.ts` asserts no kind is listed twice and every source's kinds are here.
 */
export const faultCatalogue = {
  'session-liveness': ['session', 'launch-review', 'launch-producer', 'consent-hold', 'overlong-session', 'unanswered-request', 'stuck-request', 'escalation:lease-loss',
    'action:close', 'action:dispatch', 'action:session', 'action:preserve'],
  'review-convergence': ['merge-base-dismissed', 'unobtainable-review', 'review-conflict', 'escalation:security-concern', 'action:review'],
  'decision': ['approver-launch', 'decision-refused', 'decision-stale', 'decision-unanswered', 'owed-decision', 'agent-request', 'context-overflow', 'intervention-pattern',
    'action:decision', 'action:escalation'],
  'scope': ['scope-request', 'scope-violation', 'escalation:requirement-weakening', 'action:scope'],
  'overlap-hold': ['hold-overdue'],
  'observation': ['github-budget', 'integration-job', 'action:refresh'],
  'deployment': ['production', 'throughput', 'action:deployment', 'action:smoke'],
  'configuration': ['app-permissions', 'held-jobs', 'delegation-limits', 'unrunnable-remedy', 'fleet', 'setup', 'executor', 'generated-files', 'installation', 'sandbox-blocker', 'action:config'],
  'containment': ['containment-settleable', 'containment-grace', 'containment', 'action:settle'],
  'merge': ['base-conflict', 'merged-unauthorized', 'merged-reverted', 'contaminated', 'merge-refused', 'action:merge'],
  'proof': ['proof-gap', 'timing-failure', 'escalation:evidence-policy-conflict', 'action:proof'],
  'capacity': ['reviewer-exhausted', 'role-capacity', 'concurrency-starved', 'action:failover', 'action:capacity'],
  'resources': ['disk-pressure', 'resource-bound', 'ledger-refusal', 'action:reclaim'],
  'loop': ['loop-liveness', 'loop-cost', 'loop-failures', 'loop-silence', 'delivery-budget', 'loop-cursor', 'dispatch-failures', 'action:fault'],
  'human-decision': ['human-request', 'sudo', 'action:human'],
  'stalled-gate': ['gate', 'blocker', 'stalled-item', 'stalled-action', 'actorless'],
  'unclassified': ['unclassified'],
} as const satisfies Record<FaultClass, readonly string[]>;
export type FaultKind = typeof faultCatalogue[FaultClass][number];

export const faultKinds: FaultKind[] = faultClasses.flatMap(name => [...faultCatalogue[name]]);
const classByKind = new Map<string, FaultClass>(faultClasses.flatMap(name => faultCatalogue[name].map(kind => [kind, name] as const)));
/** The one class a kind belongs to; a kind the catalogue does not list is unclassified. */
export function faultClassOf(kind: string): FaultClass { return classByKind.get(kind) ?? 'unclassified'; }
export const isFaultKind = (kind: string): kind is FaultKind => classByKind.has(kind);
/** The escalation kind for a trigger: every trigger is in the catalogue. */
export const escalationFaultKind = (trigger: EscalationTrigger) => `escalation:${trigger}` as FaultKind;

/** Anything carrying a fault class: an attention item, an escalation, a pipeline fault. */
export interface Classified { kind: FaultKind; faultClass: FaultClass }
export const classified = (kind: FaultKind): Classified => ({ kind, faultClass: faultClassOf(kind) });

/**
 * Attention lines built where no kind is set are recognised by what they say: the subject a
 * builder always uses, or the fixed wording of its sentence. The order matters only where two
 * could both match; the first wins.
 */
const signatures: [FaultKind, (subject: string, text: string) => boolean][] = [
  ['resource-bound', (subject, text) => subject.startsWith('resource:') || /is held by a registered resource at its bound/.test(text)],
  ['ledger-refusal', (_, text) => /cannot be requested because the .+ refused the write/.test(text)],
  ['disk-pressure', subject => subject === 'disk'],
  ['scope-request', (_, text) => /needs files outside plannedFiles/.test(text)],
  ['consent-hold', (_, text) => /is awaiting consent/.test(text)],
  ['review-conflict', (_, text) => /^Review of \S+ head \S+ \(PR #\d+\) is conflicted/.test(text)],
  ['unobtainable-review', (_, text) => /cannot obtain a review of/.test(text)],
  ['decision-refused', (_, text) => /^Decision \S+ \(\S+\) was refused/.test(text)],
  ['decision-stale', (_, text) => /^Decision \S+ \(\S+\) is stale/.test(text)],
  ['decision-unanswered', (_, text) => /^Decision \S+ \(\S+\) is unanswered/.test(text)],
  ['approver-launch', (_, text) => /is awaiting an approver for/.test(text)],
  ['stalled-action', (_, text) => /action is stalled, not retrying/.test(text)],
  ['stalled-item', (_, text) => /has held its \S+ gate for .+ with no action named/.test(text)],
  ['actorless', (_, text) => /no rework request and no named wait/.test(text)], ['unanswered-request', (_, text) => /has stood unanswered for/.test(text)],
  ['stuck-request', (_, text) => /^\S+ request \S+ on \S+ \(session \S+\) is pending/.test(text)],
  ['overlong-session', (_, text) => /past the .+ maximum for its role/.test(text)],
  ['context-overflow', (_, text) => /escalation context for \S+ assembled to/.test(text)],
  ['timing-failure', (_, text) => /^Required CI check .+ failed on .*timing-dependent/.test(text)],
  ['agent-request', (_, text) => /recorded a \S+ on \S+ .+ ago and released/.test(text)],
  ['owed-decision', (_, text) => /no executor may run it; .+ has been owed for/.test(text)],
  ['generated-files', (_, text) => /generated-file manifest|GRAPHYARD_GENERATED_FILES/.test(text)],
  ['github-budget', subject => subject === 'github'],
  ['intervention-pattern', subject => subject === 'interventions'],
  ['throughput', subject => subject === 'throughput'],
  ['executor', (subject, text) => subject === 'executors' || /^Nothing can run \S+: |^Every declared executor slot on this host is down/.test(text)],
  ['setup', subject => subject === 'setup'],
  ['dispatch-failures', subject => subject === 'dispatch'],
  ['loop-cursor', (subject, text) => subject === 'loop' && /cursor cannot be read/.test(text)],
  ['loop-liveness', subject => subject === 'loop'],
  ['installation', subject => subject === 'installation'],
];

/** The kind of one attention line: the kind its builder set, else the one its wording names. */
export function attentionKind(item: { subject: string; text: string; kind?: string | null; human?: boolean }): FaultKind {
  if (item.kind && isFaultKind(item.kind)) return item.kind;
  if (item.subject === 'installation' && item.human) return 'sudo';
  return signatures.find(([, match]) => match(item.subject, item.text))?.[0] ?? 'unclassified';
}
/** Every attention item with its kind and class set. */
export function classifyAttention<T extends { subject: string; text: string; kind?: string | null; human?: boolean }>(items: T[]): (T & Classified)[] {
  return items.map(item => ({ ...item, ...classified(attentionKind(item)) }));
}

/** Open problems grouped by class with a count, largest first; each group names its subjects. */
export interface FaultGroup { faultClass: FaultClass; count: number; meaning: string; kinds: Partial<Record<FaultKind, number>>; subjects: string[] }
export function groupFaults(items: readonly { subject: string; kind: FaultKind; faultClass: FaultClass }[]): FaultGroup[] {
  const groups = new Map<FaultClass, FaultGroup>();
  for (const item of items) {
    const group = groups.get(item.faultClass) ?? { faultClass: item.faultClass, count: 0, meaning: faultClassMeaning[item.faultClass], kinds: {}, subjects: [] };
    group.count += 1; group.kinds[item.kind] = (group.kinds[item.kind] ?? 0) + 1;
    if (!group.subjects.includes(item.subject)) group.subjects.push(item.subject);
    groups.set(item.faultClass, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || faultClasses.indexOf(a.faultClass) - faultClasses.indexOf(b.faultClass));
}

/** One fault standing on a work item, read from the item's own record. */
export interface FaultObservation extends Classified { subject: string; text: string }
const observe = (kind: FaultKind, subject: string, text: string): FaultObservation => ({ ...classified(kind), subject, text: text.slice(0, 500) });
/**
 * The faults an open item's own record shows: its standing escalations, a lapsed containment
 * fence, a human-only park, a live attempt's open scope request, a proof nobody may produce, a spent provider
 * account, its out-of-scope violations and its blocker. The dashboard and the loop read the same.
 */
export function workFaults(work: Work, now: number): FaultObservation[] {
  if (work.stage === 'done' || isClosed(work)) return [];
  const found: FaultObservation[] = [];
  const escalations = work.escalations ?? (work.escalation ? [work.escalation] : []);
  for (const escalation of escalations) found.push(observe(escalationFaultKind(escalation.trigger), work.key, `${escalation.trigger} escalation: ${escalation.reason}`));
  if (work.containmentQuarantine && !(work.lease && Date.parse(work.lease.expiresAt) > now)) found.push(observe('containment', work.key, `Containment quarantine from epoch ${work.containmentQuarantine.epoch} holds ${work.key}`));
  if (work.humanRequest && !work.humanRequest.answer) found.push(observe('human-request', work.key, `${work.key} is parked on a human-only decision: ${work.humanRequest.needed}`));
  if (work.scopeRequest && work.lease?.epoch === work.scopeRequest.epoch && Date.parse(work.lease.expiresAt) > now) /* an expired attempt's request is moot (owed-report's rule) */ found.push(observe('scope-request', work.key, `${work.key} needs files outside plannedFiles: ${work.scopeRequest.paths.join(', ')}`));
  if (work.proofGaps?.length) found.push(observe('proof-gap', work.key, `No principal is authorized to produce ${work.proofGaps.join(', ')}`));
  if (standingCapacity(work).length) found.push(observe('role-capacity', work.key, `${work.key} waits on a provider account out of quota`));
  if (work.violations.length) found.push(observe('scope-violation', work.key, work.violations[0]));
  const restated = /* a blocker restating a typed fault is that fault: a human-only park's wait, a refused scope request */ (work.humanRequest && !work.humanRequest.answer) || (work.scopeRequest && work.blocker?.startsWith(scopeRefusalBlocker));
  if (work.blocker && !restated) found.push(observe(/sandbox|refused path|--add-dir|Operation not permitted/i.test(work.blocker) ? 'sandbox-blocker' : 'blocker', work.key, work.blocker));
  return found;
}

// ---------------------------------------------------------------------------
// Recurrence: one structural item per recurring class (AC-2).
// ---------------------------------------------------------------------------

export interface FaultClassPolicy { threshold: number; windowHours: number }
export const faultClassPolicyDefaults: FaultClassPolicy = { threshold: 3, windowHours: 24 };
export const faultClassPolicyVariables = { threshold: 'GRAPHYARD_FAULT_CLASS_THRESHOLD', windowHours: 'GRAPHYARD_FAULT_CLASS_WINDOW_HOURS' } as const;
export function faultClassPolicyFromEnv(env: Record<string, string | undefined>): FaultClassPolicy {
  const read = (name: string, fallback: number) => { const value = Number(env[name]); return Number.isInteger(value) && value > 0 ? value : fallback; };
  return { threshold: read(faultClassPolicyVariables.threshold, faultClassPolicyDefaults.threshold), windowHours: read(faultClassPolicyVariables.windowHours, faultClassPolicyDefaults.windowHours) };
}

/**
 * One instance of a fault as the loop recorded it: first seen at `at`, standing until `lastSeenAt`,
 * and linked to the item that stands for its class once one does.
 */
export const faultInstanceSchema = z.object({
  id: z.string().max(400), kind: z.string().max(100), faultClass: z.enum(faultClasses),
  subject: z.string().max(200), text: z.string().max(500),
  at: z.string(), lastSeenAt: z.string(),
  linkedTo: z.string().max(50).nullable().default(null),
  /** Standing when the loop's record began (GY-374): the installation's state then, never counted as a recurrence. */
  baseline: z.boolean().optional(),
}).strict();
export type FaultInstance = z.infer<typeof faultInstanceSchema>;

/** Where an item came from when the loop filed it for a recurring class; it is the class the item closes. */
export const faultClassOriginSchema = z.object({
  class: z.enum(faultClasses),
  threshold: z.number().int().positive(), windowHours: z.number().int().positive(), count: z.number().int().nonnegative(),
  instances: z.array(z.object({ id: z.string().max(400), kind: z.string().max(100), subject: z.string().max(200), at: z.string() }).strict()).max(100).default([]),
  detectedAt: z.string(),
}).strict();
export type FaultClassOrigin = z.infer<typeof faultClassOriginSchema>;

/** The class an item records that it closes, when it names one. */
export const closesFaultClass = (work: Pick<Work, 'origin'>): FaultClass | null => work.origin?.faultClass?.class ?? null;
/** The open item that names `faultClass` as its class, if any. */
export function openFaultClassItem(work: readonly Work[], faultClass: FaultClass): Work | null {
  return work.find(item => item.stage !== 'done' && !isClosed(item) && closesFaultClass(item) === faultClass) ?? null;
}

export interface ClassRecurrence { faultClass: FaultClass; count: number; recent: FaultInstance[]; unlinked: FaultInstance[]; item: Work | null; file: boolean }
/**
 * Every class with an instance inside the window. A class files an item when the instances in the
 * window that no item accounts for yet reach the threshold and no open item names the class; with
 * an open item, every instance not yet linked is linked to it instead, however many there are.
 * Instances linked to an item that has since closed stay counted by it, never by a second one, and
 * a `baseline` instance (standing when the record began, GY-374) is no occurrence in the window.
 */
export function recurringClasses(instances: readonly FaultInstance[], work: readonly Work[], policy: FaultClassPolicy, now: number): ClassRecurrence[] {
  const from = now - policy.windowHours * 3_600_000;
  return faultClasses.flatMap(faultClass => {
    const all = instances.filter(entry => entry.faultClass === faultClass);
    const recent = all.filter(entry => Date.parse(entry.at) >= from && Date.parse(entry.at) <= now && !entry.linkedTo && !entry.baseline);
    const item = openFaultClassItem(work, faultClass);
    const unlinked = item ? all.filter(entry => !entry.linkedTo) : recent;
    if (!unlinked.length) return [];
    return [{ faultClass, count: recent.length, recent, unlinked, item, file: !item && recent.length >= policy.threshold }];
  });
}

/** Problems the control plane's status reports beside any item (App permissions, integration jobs, production lag and
 *  incidents, a GitHub pause, unserved executors): the dashboard groups them with the items' faults, as master status does. */
export function statusFaults(status: any): FaultObservation[] {
  if (!status) return [];
  const lines = (value: unknown): string[] => Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string') : [];
  const found: FaultObservation[] = [];
  if (!status.github) found.push(observe('setup', 'github', 'GitHub is not connected, so nothing can merge'));
  for (const line of lines(status.appPermissions?.attention)) found.push(observe('app-permissions', 'installation', line));
  if (status.heldJobs > 0) found.push(observe('held-jobs', 'installation', `${status.heldJobs} integration job(s) held on a permission shortfall`));
  for (const line of lines(status.delegationLimits?.attention)) found.push(observe('delegation-limits', 'installation', line)); for (const line of lines(status.production?.attention)) found.push(observe('production', 'installation', line));
  if (status.githubBudget?.paused) found.push(observe('github-budget', 'github', `GitHub requests are paused until ${status.githubBudget.paused.until}`));
  else for (const job of Array.isArray(status.jobs) ? status.jobs.filter((job: any) => job?.error) : []) found.push(observe('integration-job', job?.work_id ?? 'github', `A GitHub update failed: ${job?.error ?? 'no reason recorded'}`));
  for (const entry of Array.isArray(status.executors?.attention) ? status.executors.attention : []) found.push(observe('executor', 'executors', String(entry?.text ?? entry?.kind ?? 'an action no executor serves')));
  return found;
}

/** The backlog item one recurring class files: the class, its frequency and every instance as evidence. */
export function faultClassItem(recurrence: Pick<ClassRecurrence, 'faultClass' | 'recent'>, policy: FaultClassPolicy, now: number) {
  const { faultClass, recent } = recurrence, at = new Date(now).toISOString();
  const subjects = [...new Set(recent.map(entry => entry.subject))];
  const origin: FaultClassOrigin = { class: faultClass, threshold: policy.threshold, windowHours: policy.windowHours, count: recent.length, detectedAt: at,
    instances: recent.slice(0, 100).map(({ id, kind, subject, at: seen }) => ({ id, kind, subject, at: seen })) };
  // Goals, spending and credentials stay a human's however often asked: this class removes only the avoidable waits.
  const human = faultClass === 'human-decision';
  const description = [
    `The master loop filed this item itself: ${recent.length} ${faultClass} faults in ${policy.windowHours} hours (threshold ${policy.threshold}). The class means ${faultClassMeaning[faultClass]}.`,
    human ? `These waits are on decisions only a human may make (goals and priorities, money or accounts, credentials for people), and this item does not move any of them to an agent or weaken that boundary. What it replaces is handling each wait by hand: find the waits that were avoidable — asked again for something already decided, asked for a decision the item did not need, or left unanswered because nobody was told — and remove those, so each human decision is asked for once, when it is needed, with what the human needs to make it. Later instances of the class are linked to this item rather than filed again.` : `Fixing these one instance at a time is what this item replaces: find the cause the instances share and remove it, so the product handles the case itself. Later instances of the class are linked to this item rather than filed again. Whether the class stays quiet after this ships is not evidence this item can carry: the loop keeps counting it, and a recurrence past the threshold after delivery files a new item.`,
    `Subjects affected: ${subjects.join(', ')}.`,
    'Instances (the evidence):',
    ...recent.slice(0, 100).map(entry => `- ${entry.at} ${entry.kind} on ${entry.subject}: ${entry.text}`),
  ].join('\n\n');
  return {
    title: `Recurring ${faultClass} faults: ${recent.length} in ${policy.windowHours} hours`.slice(0, 200), description: description.slice(0, 20000), type: 'bug' as const, priority: human ? 2 : 1,
    criteria: [{ id: 'AC-1', text: human ? 'Each instance listed on this item is judged necessary (a goals, money or credentials decision the item needed) or avoidable, with the reason; every avoidable wait is reproduced against the base and shown not to recur against the candidate, by a test the change adds; and a test shows every necessary decision is still refused to every agent and answered only in the human\'s own session' : `The shared cause of the recurring ${faultClass} faults is found and removed at the candidate: each instance listed on this item is reproduced against the base and shown not to recur against the candidate, by a test the change adds`, proofs: [`manual:fault-class-${faultClass}`] }],
    origin: { faultClass: origin },
    reason: `The ${faultClass} fault class recurred past its threshold (${recent.length} ≥ ${policy.threshold} in ${policy.windowHours} hours) and no open item names it`,
  };
}
