import { z } from 'zod';
import { isDelivered, type Closure } from './closure.js';
import type { Work } from './work.js';

// ---------------------------------------------------------------------------
// Machine-filed backlog (GY-402).
//
// The loop files recurring fault classes (GY-173, model/fault-classes.ts) as backlog items on its
// own. Until GY-1249 it also filed the follow-ups an approved review named beyond the item's
// criteria: on 2026-10-05 they made 48 of 90 open items and about a third of merges. Review
// findings worth fixing are now fixed on the same pull request and nits are not filed, so no code
// path creates a follow-up item; the ones already filed are still recognised here and triaged.
// Every machine-filed item is triaged: a triage run judges it within `triageDeadlineMs` and
// releases it with a priority, closes it with a reason, or merges it into another; a closure
// needs an independent approver.
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
 * findings every approval of that parent named, as filed before GY-1249. Unlike the other origins it
 * grows: a triage merge of another follow-up item into it appends that item's findings.
 */
export const reviewFollowUpsOriginSchema = z.object({ parent: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), findings: z.array(entry).max(followUpEntriesMax) }).strict();
export type ReviewFollowUpsOrigin = z.infer<typeof reviewFollowUpsOriginSchema>;
/** The title every review follow-up item carried while they were filed (before GY-1249). */
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
/** `existing` with each of `incoming` it does not already hold, in order; `added` names the new ones. */
export function mergeFollowUpEntries(existing: readonly FollowUpEntry[], incoming: readonly FollowUpEntry[]) {
  const seen = new Set(existing.map(followUpEntryKey)), added: FollowUpEntry[] = [];
  for (const finding of incoming) {
    const key = followUpEntryKey(finding);
    if (seen.has(key)) continue;
    seen.add(key); added.push({ path: finding.path, text: finding.text, ...(finding.ref ? { ref: finding.ref } : {}) });
  }
  return { findings: [...existing, ...added].slice(0, followUpEntriesMax), added };
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
/**
 * The loop withdrawing a closure it proposed (GY-1632): the proposal recorded at `triageAt` no longer holds — a
 * recurrence after the delivered fix landed was linked to the item — so it returns to triage, refused with `reason`.
 */
export const triageWithdrawalSchema = z.object({ withdraw: z.object({ triageAt: z.string().datetime(), reason: z.string().trim().min(1).max(2000) }).strict() }).strict();

const oldestFirst = (a: Pick<Work, 'createdAt' | 'key'>, b: Pick<Work, 'createdAt' | 'key'>) =>
  a.createdAt.localeCompare(b.createdAt) || Number(a.key.split('-')[1]) - Number(b.key.split('-')[1]);
type Triageable = Pick<Work, 'title' | 'stage' | 'ready' | 'createdAt' | 'key'> & { origin?: Work['origin']; triage?: TriageRecord | null; closure?: Closure | null };
/** Whether a machine-filed item still waits for triage: unreleased in the backlog, with no judgement standing (a refused closure is judged again). */
export const untriaged = (work: Triageable) => !!machineKind(work) && work.stage === 'backlog' && !work.ready && (!work.triage || work.triage.state === 'refused');
/** The item's triage clock: filed, or last refused. */
const triageSince = (work: Triageable) => work.triage?.state === 'refused' ? work.triage.at : work.createdAt;
/** The machine-filed items untriaged past the deadline, oldest first; a follow-up whose parent has not shipped is not yet due (GY-845). */
export function overdueTriage<T extends Triageable>(all: readonly T[], now: number): T[] {
  return all.filter(item => untriaged(item) && !awaitsParent(item, all) && now - Date.parse(triageSince(item)) > triageDeadlineMs).sort(oldestFirst);
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

// ---- Follow-ups held on their parent (GY-845, retired by GY-1249) ----------------------------------
//
// From GY-845 to GY-1249 an approval's findings on an unshipped parent were held on it
// (`pendingFollowUps`) and filed as one follow-up item once it shipped. Nothing holds or files them
// any more; stored items carrying the field still load, and it is never read for a decision.

/** `pendingFollowUps` as items stored before GY-1249 carry it: read so they still load, never written. */
export interface PendingFollowUps {
  findings: FollowUpEntry[]; at: string;
  filing?: { key: string; count: number; at: string } | null;
  filed?: { item: string; at: string } | null;
  dropped?: { reason: string; at: string } | null;
}
export type Parent = Pick<Work, 'key' | 'stage'> & Partial<Pick<Work, 'delivery'>> & { closure?: Closure | null; pendingFollowUps?: PendingFollowUps | null };
/** Whether a parent has shipped: delivered. */
export function hasShipped(parent: Parent) {
  return isDelivered(parent);
}
/** Whether a follow-up item's parent has not shipped yet: triage never judges it until it does. */
export function awaitsParent(item: Filed, all: readonly Parent[]) {
  const parent = followUpParent(item), found = parent ? all.find(entry => entry.key === parent) : undefined;
  return !!found && !hasShipped(found);
}
