import { z } from 'zod';
import type { Closure } from './closure.js';
import type { Work } from './work.js';

// ---------------------------------------------------------------------------
// Machine-filed backlog (GY-402).
//
// The loop files two kinds of backlog item on its own: the follow-ups an approved review names
// beyond the item's criteria (src/review-threads.ts) and the recurring fault classes (GY-173,
// model/fault-classes.ts). On 2026-09-25 the backlog held 170 follow-up items for 40 parents —
// one per approved head, every rework round, base refresh and re-review filing another — and
// nothing ever released, closed or merged them.
//
// Follow-ups are now one item per parent: a later approval appends its new findings to the
// parent's open follow-up item, deduplicated by path and finding text. A one-time migration folds
// the existing duplicates into each parent's oldest open item. And every machine-filed item is
// triaged: a triage run judges it within `triageDeadlineMs` and releases it with a priority,
// closes it with a reason, or merges it into another; a closure needs an independent approver.
// ---------------------------------------------------------------------------

/**
 * One follow-up finding as the parent's follow-up item holds it: the file it concerns, when known,
 * what is wrong, and where it was raised (a review thread's URL or ID), which is not part of its identity.
 */
export interface FollowUpEntry { path: string | null; text: string; ref?: string }
/** How many findings one follow-up item records structurally; its description names the count beyond. */
export const followUpEntriesMax = 500;
const entry = z.object({ path: z.string().min(1).max(1000).nullable(), text: z.string().min(1).max(2000), ref: z.string().min(1).max(1000).optional() }).strict();
/**
 * `origin.reviewFollowUps`: the parent a follow-up item collects findings for, and the union of the
 * findings every approval of that parent named. Unlike the other origins it grows: an approval of a
 * later head appends to it rather than filing a second item.
 */
export const reviewFollowUpsOriginSchema = z.object({ parent: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), findings: z.array(entry).max(followUpEntriesMax) }).strict();
export type ReviewFollowUpsOrigin = z.infer<typeof reviewFollowUpsOriginSchema>;
/** What `POST /api/work/ID/followups` appends: the findings of one approval of the parent. */
export const followUpAppendSchema = z.object({ findings: z.array(entry).min(1).max(200), reason: z.string().trim().min(1).max(2000) }).strict();

/** The title every review follow-up item carries (src/review-threads.ts followUpItem). */
const followUpTitle = /^Follow-ups from the approved review of ([A-Z][A-Z0-9]*-\d+)\b/;
const faultTitle = /^Recurring \S+ faults:/;
export type MachineKind = 'review-follow-up' | 'recurring-fault';
type Filed = Pick<Work, 'title'> & { origin?: Work['origin'] };

/** The parent a review follow-up item collects findings for: from its origin, or from the title items filed before the origin existed carry. */
export function followUpParent(work: Filed): string | null {
  return work.origin?.reviewFollowUps?.parent ?? followUpTitle.exec(work.title)?.[1] ?? null;
}
/** Which kind of machine-filed item this is, or null for an operator's own. */
export function machineKind(work: Filed): MachineKind | null {
  if (followUpParent(work)) return 'review-follow-up';
  if (work.origin?.faultClass || faultTitle.test(work.title)) return 'recurring-fault';
  return null;
}

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/**
 * The identity a finding is deduplicated on: its path and its text, where the text leaves out a
 * leading `path:line —` the reviewer repeats (so the same finding named on a later head at a moved
 * line is the same finding) and case, punctuation and spacing.
 */
export function followUpEntryKey(finding: FollowUpEntry) {
  const path = finding.path?.trim() ?? '';
  let text = finding.text.trim();
  if (path && text.replace(/^`/, '').startsWith(path)) text = text.replace(/^`?[^\s`]+`?(?::\d+)?\s*(?:[—–:-]+\s*)?/, '');
  return `${path.toLowerCase()}\u0000${normalized(text)}`;
}
/**
 * `existing` with each of `incoming` it does not already hold, in order, up to `followUpEntriesMax`;
 * `added` names only the new ones the result holds, and `dropped` counts the new ones past the bound
 * (GY-431: the description and the reported count never name a finding the item does not hold).
 */
export function mergeFollowUpEntries(existing: readonly FollowUpEntry[], incoming: readonly FollowUpEntry[]) {
  const seen = new Set(existing.map(followUpEntryKey)), added: FollowUpEntry[] = [];
  const room = Math.max(0, followUpEntriesMax - existing.length);
  let dropped = 0;
  for (const finding of incoming) {
    const key = followUpEntryKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    if (added.length >= room) { dropped++; continue; }
    added.push({ path: finding.path, text: finding.text, ...(finding.ref ? { ref: finding.ref } : {}) });
  }
  return { findings: [...existing, ...added].slice(0, followUpEntriesMax), added, dropped };
}

/**
 * The findings a follow-up item holds: its origin's, or for an item filed before the origin
 * existed, each numbered entry of its description (a thread's `N. ID — path:line by author…`, or
 * `N. Finding with no thread: …`).
 */
export function followUpEntries(work: Pick<Work, 'title' | 'description'> & { origin?: Work['origin'] }): FollowUpEntry[] {
  if (work.origin?.reviewFollowUps) return work.origin.reviewFollowUps.findings;
  const entries: FollowUpEntry[] = [];
  for (const line of (work.description ?? '').split('\n')) {
    const numbered = /^\d+\. (.+)$/.exec(line.trim());
    if (!numbered) continue;
    const body = numbered[1]!.replace(/^Finding with no thread: /, '');
    const thread = /^\S+ — (\S+?)(?::\d+)? by .*?: "(.*)"$/.exec(body);
    const path = thread ? thread[1]! : /^`?([\w.-]+(?:\/[\w.-]+)*\.\w+|[\w.-]+\/(?:[\w.-]+\/?)*)`?(?::\d+)?\s/.exec(body)?.[1] ?? null;
    entries.push({ path: path && path !== '(no' ? path.slice(0, 1000) : null, text: (thread ? thread[2]! || body : body).slice(0, 2000) });
  }
  return entries.slice(0, followUpEntriesMax);
}

const descriptionMax = 20000;
/** The description after `added` are appended: each on its own numbered line, and a count of any the description bound leaves out. */
export function appendedDescription(description: string, added: readonly FollowUpEntry[], heading: string) {
  if (!added.length) return description;
  const numbered = (description.match(/^\d+\. /gm) ?? []).length;
  const lines = added.map((finding, index) => `${numbered + index + 1}. ${!finding.path || finding.text.replace(/^`/, '').startsWith(finding.path) ? '' : `${finding.path}: `}${finding.text}${finding.ref ? ` (${finding.ref})` : ''}`);
  let text = `${description}\n\n${heading}\n${lines.join('\n')}`;
  if (text.length > descriptionMax) {
    const note = `\n… ${added.length} findings were added; the rest are listed in origin.reviewFollowUps (graphyard status).`;
    text = `${text.slice(0, descriptionMax - note.length)}${note}`;
  }
  return text;
}

/** Whether an item is still open: not delivered, not closed. */
const open = (work: Pick<Work, 'stage'>) => work.stage !== 'done';
const oldestFirst = (a: Pick<Work, 'createdAt' | 'key'>, b: Pick<Work, 'createdAt' | 'key'>) =>
  a.createdAt.localeCompare(b.createdAt) || Number(a.key.split('-')[1]) - Number(b.key.split('-')[1]);
/** The parent's open follow-up item findings are appended to: its oldest open one. */
export function openFollowUpItem<T extends Pick<Work, 'title' | 'stage' | 'createdAt' | 'key'> & { origin?: Work['origin'] }>(all: readonly T[], parent: string): T | null {
  return all.filter(item => open(item) && followUpParent(item) === parent).sort(oldestFirst)[0] ?? null;
}

/**
 * The one-time migration (GY-402): each parent's open follow-up items fold into its oldest open
 * one, which takes the union of their findings, and the others are closed as superseded by it,
 * naming it. Nothing is deleted. Items are changed in place; the result names each survivor with
 * the findings it gained and each item closed, for the caller to save and record.
 *
 * A leased item is being worked, so it is neither closed nor merged into: `deferred` names each
 * leased follow-up item that still has an open sibling, and a later pass restricted to their
 * `parents` folds them once their lease has ended (GY-431).
 */
export function mergeDuplicateFollowUps(all: Work[], actor: string, now: Date, parents?: ReadonlySet<string>) {
  const groups = new Map<string, Work[]>(), leased = new Map<string, Work[]>();
  for (const item of all) {
    const parent = open(item) ? followUpParent(item) : null;
    if (!parent || (parents && !parents.has(parent))) continue;
    const into = item.lease ? leased : groups;
    into.set(parent, [...into.get(parent) ?? [], item]);
  }
  const survivors: { work: Work; added: number; absorbed: string[]; dropped: number }[] = [], closed: Work[] = [];
  for (const [parent, items] of groups) {
    if (items.length < 2) continue;
    const [survivor, ...duplicates] = items.sort(oldestFirst);
    let findings = followUpEntries(survivor!);
    const before = findings.length;
    const addedAll: FollowUpEntry[] = [];
    let dropped = 0;
    for (const duplicate of duplicates) {
      const merged = mergeFollowUpEntries(findings, followUpEntries(duplicate));
      findings = merged.findings; addedAll.push(...merged.added); dropped += merged.dropped;
      const closure: Closure = { kind: 'duplicate', ref: survivor!.key, by: actor, at: now.toISOString(), from: duplicate.stage,
        reason: `Superseded by ${survivor!.key}, ${parent}'s one follow-up item, which now holds every finding of this one (GY-402 follow-up migration)` };
      Object.assign(duplicate, { closure, stage: 'done', stageEnteredAt: now.toISOString(), ready: false, queue: null, mergeAuthorization: null, reviewRequest: null, scopeRequest: null, blocker: null });
      closed.push(duplicate);
    }
    survivor!.origin = { ...survivor!.origin, reviewFollowUps: { parent, findings } };
    survivor!.description = appendedDescription(survivor!.description ?? '', addedAll, `Merged from ${duplicates.map(item => item.key).join(', ')} (the same parent's later follow-up items):`);
    survivors.push({ work: survivor!, added: findings.length - before, absorbed: duplicates.map(item => item.key), dropped });
  }
  const deferred: string[] = [];
  for (const [parent, items] of leased) {
    if (items.length + (groups.get(parent)?.length ? 1 : 0) > 1) deferred.push(...items.sort(oldestFirst).map(item => item.key));
  }
  return { merged: closed.length, survivors, closed, deferred };
}

// ---- Triage --------------------------------------------------------------------------------------

/** How long a machine-filed item may wait untriaged before the loop raises it as attention. */
export const triageDeadlineMs = 24 * 3_600_000;
export const triageOutcomes = ['release', 'close', 'merge'] as const;
/**
 * The triage agent's judgement of one machine-filed item, as the triage tool submits it and the
 * control plane re-validates it: release it at a priority; close it, either superseded by a named
 * delivered item (`ref`) or as not worth doing (`ref` absent); or merge it into another open item.
 */
export const triageJudgementSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('release'), priority: z.number().int().min(0).max(4), reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ outcome: z.literal('close'), ref: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional(), reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ outcome: z.literal('merge'), into: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), reason: z.string().trim().min(1).max(2000) }).strict(),
]);
export type TriageJudgement = z.infer<typeof triageJudgementSchema>;
/**
 * The triage record on the item. A release is applied as it is recorded; a closure or merge is
 * `proposed` until an independent approver approves the `close` decision the loop requests for it
 * (`applied`) or refuses it (`refused`, and the item is judged again).
 */
export interface TriageRecord { judgement: TriageJudgement; state: 'applied' | 'proposed' | 'refused'; by: string; at: string; runtime?: string; decision?: string | null; refusal?: string | null }
export const triageRecordSchema = z.object({ judgement: triageJudgementSchema, runtime: z.string().trim().min(1).max(200).optional() }).strict();

type Triageable = Pick<Work, 'title' | 'stage' | 'ready' | 'createdAt' | 'key'> & { origin?: Work['origin']; triage?: TriageRecord | null; closure?: Closure | null };
/** Whether a machine-filed item still waits for triage: unreleased in the backlog, with no judgement standing (a refused closure is judged again). */
export const untriaged = (work: Triageable) => !!machineKind(work) && work.stage === 'backlog' && !work.ready && (!work.triage || work.triage.state === 'refused');
/** The item's triage clock: filed, or last refused. */
const triageSince = (work: Triageable) => work.triage?.state === 'refused' ? work.triage.at : work.createdAt;
/** The machine-filed items untriaged past the deadline, oldest first. */
export function overdueTriage<T extends Triageable>(all: readonly T[], now: number): T[] {
  return all.filter(item => untriaged(item) && now - Date.parse(triageSince(item)) > triageDeadlineMs).sort(oldestFirst);
}

/** The attention an overdue item raises: it names the triage step, how long it has waited and how to see why it has not run. */
export function triageAttention(work: Triageable, now: number) {
  const hours = Math.floor((now - Date.parse(triageSince(work))) / 3_600_000);
  return `${work.key} is a machine-filed ${machineKind(work) === 'review-follow-up' ? 'review follow-up' : 'recurring-fault'} item untriaged for ${hours}h, past the ${triageDeadlineMs / 3_600_000}h bound: the triage step has not judged it (release with a priority, close with a reason, or merge into another item). The loop runs a triage session for it once run.research names the research account; check the loop's triage actions in graphyard master status.`;
}

/**
 * The backlog as the operator reads it: unreleased items they created, apart from the
 * machine-filed ones still waiting for triage and those triage has judged.
 */
export function backlogCounts(all: readonly Triageable[], now: number) {
  const backlog = all.filter(item => item.stage === 'backlog' && !item.ready);
  const machine = backlog.filter(item => !!machineKind(item));
  return { operator: backlog.length - machine.length, machineUntriaged: machine.filter(untriaged).length, machineProposed: machine.filter(item => item.triage?.state === 'proposed').length,
    overdue: overdueTriage(all, now).length };
}

/** The closure a triage judgement proposes, as the `close` decision carries it to the approver and the control plane applies it. */
export function triageClosure(judgement: TriageJudgement): { kind: 'superseded' | 'obsolete' | 'duplicate'; ref: string | null; reason: string } | null {
  if (judgement.outcome === 'release') return null;
  if (judgement.outcome === 'merge') return { kind: 'duplicate', ref: judgement.into, reason: `Merged into ${judgement.into} by triage: ${judgement.reason}`.slice(0, 2000) };
  return judgement.ref ? { kind: 'superseded', ref: judgement.ref, reason: `Already fixed by ${judgement.ref}: ${judgement.reason}`.slice(0, 2000) } : { kind: 'obsolete', ref: null, reason: `Not worth doing: ${judgement.reason}`.slice(0, 2000) };
}
