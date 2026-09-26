// Concern: the repair lane (GY-406) — the one sanctioned merge past Graphyard's own merge path.
//
// When the merge path itself breaks, a fix to it cannot pass through it. The repair lane lets the
// control-plane GitHub App merge such a fix with the ruleset bypass `master protection --apply`
// gives it (src/protection.ts repairBypassActor), and only when every condition below holds. Each
// condition that is missing refuses the merge by name; every merge it makes is audited and stays
// on master status until the next normal merge proves the merge path healthy again.
import type { Work } from '../model.js';
import type { AttentionItem } from './attention.js';

/** The merge path: where a fault can stop every merge, so where a repair item's plannedFiles must stay. */
export const mergePath = ['src/github.ts', 'src/merge-queue.ts', 'src/model/queue.ts', 'src/daemon/', '.github/workflows/'] as const;
export const withinMergePath = (path: string) => !path.includes('..') && mergePath.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
/** How long the normal guarded merge must have been refused or pending before the lane may bypass it. */
export const repairStallMs = 15 * 60_000;
export const repairDecisionAction = 'repair-merge';

/** Why an item may not carry `"repair": "merge-path"`, or null when it may (or carries no repair). */
export function repairScopeRefusal(item: Pick<Work, 'plannedFiles'> & { repair?: string; key?: string }): string | null {
  if (!item.repair) return null;
  const subject = item.key ?? 'A repair item';
  if (!item.plannedFiles.length) return `${subject} carries "repair": "merge-path" but names no plannedFiles; a merge-path repair plans only files within the merge path (${mergePath.join(', ')})`;
  const outside = item.plannedFiles.filter(path => !withinMergePath(path));
  return outside.length ? `${subject} carries "repair": "merge-path" but plans files outside the merge path (${mergePath.join(', ')}): ${outside.join(', ')}` : null;
}

/** The merge-path location a decision reason names — the fault it repairs — or null when it names none. */
export function namedMergePathFault(reason: string): string | null {
  const paths = reason.match(/(?:\.github\/workflows\/|src\/)[\w./-]*/g) ?? [];
  return paths.map(path => path.replace(/[.,;:)]+$/, '')).find(withinMergePath) ?? null;
}

/** What the normal guarded merge of the item's current head has done: refused or pending since `since`, or nothing yet. */
export interface NormalMergeState { state: 'refused' | 'pending' | 'none'; since: string | null; detail: string | null }
export interface RepairDecision { id: string; action: string; state: string; input: any; reason: string; requestedBy: string; approvedBy: string | null }
export const repairConditions = ['repair-item', 'merge-path-scope', 'candidate', 'required-checks', 'decision', 'fault-named', 'normal-merge-stalled'] as const;
export type RepairCondition = typeof repairConditions[number];
export type RepairLaneVerdict =
  | { allowed: true; sha: string; pr: number; decision: RepairDecision; fault: string; bypassed: NormalMergeState }
  | { allowed: false; condition: RepairCondition; refusal: string };

const refuse = (condition: RepairCondition, refusal: string): RepairLaneVerdict => ({ allowed: false, condition, refusal: `Repair lane refused (${condition}): ${refusal}` });

/**
 * Whether the repair lane may merge this item's current head with the App's bypass. Every
 * condition must hold: the item is a merge-path repair; its plannedFiles stay within the merge
 * path; its required CI checks passed on the exact head; an independent approver agent approved a
 * `repair-merge` decision naming that head, whose reason names the merge-path fault; and the
 * normal guarded merge of that head has been refused or pending for at least fifteen minutes.
 */
export function repairLaneVerdict(work: Work, decisions: RepairDecision[], normal: NormalMergeState, now: number): RepairLaneVerdict {
  if (work.repair !== 'merge-path') return refuse('repair-item', `${work.key} does not carry "repair": "merge-path"; the repair lane merges nothing else`);
  const scope = repairScopeRefusal(work);
  if (scope) return refuse('merge-path-scope', scope);
  const candidate = work.candidate;
  if (!candidate || !work.submission) return refuse('candidate', `${work.key} has no submitted candidate to merge`);
  if (work.stage === 'done') return refuse('candidate', `${work.key} is already delivered`);
  if (work.observation?.candidate?.sha !== candidate.sha) return refuse('required-checks', `GitHub has not been observed at ${work.key}'s head ${candidate.sha.slice(0, 12)}`);
  const test = work.gates.find(gate => gate.name === 'test');
  if (!test?.passed) return refuse('required-checks', `the required CI checks of ${work.key} have not passed on head ${candidate.sha.slice(0, 12)}: ${test?.reasons.join('; ') || 'the test gate has not been evaluated'}`);
  const named = decisions.filter(decision => decision.action === repairDecisionAction && decision.input?.sha === candidate.sha);
  const approved = named.filter(decision => decision.state === 'applied' && !!decision.approvedBy && decision.approvedBy !== decision.requestedBy);
  if (!approved.length) return refuse('decision', named.length
    ? `no independent approver agent has approved a ${repairDecisionAction} decision for head ${candidate.sha.slice(0, 12)} (${named.map(decision => `${decision.id} is ${decision.state}`).join(', ')})`
    : `no ${repairDecisionAction} decision names head ${candidate.sha.slice(0, 12)}; request one with graphyard master decide ${work.key} ${repairDecisionAction} REASON naming the merge-path fault, then graphyard master approver ${work.key} DECISION`);
  const decision = approved.find(entry => namedMergePathFault(entry.reason));
  if (!decision) return refuse('fault-named', `the approved ${repairDecisionAction} decision ${approved[0].id} does not name the merge-path fault; its reason must name the broken location (one of ${mergePath.join(', ')})`);
  if (normal.state === 'none' || !normal.since) return refuse('normal-merge-stalled', `the normal guarded merge of ${candidate.sha.slice(0, 12)} has not been refused or left pending; the repair lane is only for a merge path that is not merging`);
  const stalled = now - Date.parse(normal.since);
  if (!(stalled >= repairStallMs)) return refuse('normal-merge-stalled', `the normal guarded merge has been ${normal.state} for ${Math.max(0, Math.floor(stalled / 60_000))} minute(s) since ${normal.since}; the repair lane waits ${repairStallMs / 60_000}`);
  return { allowed: true, sha: candidate.sha, pr: work.submission.pr, decision, fault: namedMergePathFault(decision.reason)!, bypassed: normal };
}

/**
 * The normal guarded merge of the item's current head, as the control plane recorded it: pending
 * since the coordinator asked GitHub to merge exactly this head (`merge.enqueue.requested`), or
 * refused since the item reached the merge stage with its merge gate failing — whichever is older.
 */
export function normalMergeState(work: Work, request: { sha: string; at: string } | null): NormalMergeState {
  const head = work.candidate?.sha;
  const gate = work.gates.find(entry => entry.name === 'merge');
  const refused = work.stage === 'merge' && gate && !gate.passed ? { since: work.stageEnteredAt, detail: gate.reasons.join('; ') } : null;
  const queued = work.observation?.githubQueue;
  const pending = head && request?.sha === head ? { since: request.at, detail: queued?.refused?.reason ?? (queued ? `GitHub reports ${queued.mode}${queued.mergeStateStatus ? ` (${queued.mergeStateStatus})` : ''}` : 'GitHub has not merged it') } : null;
  const older = [refused && { state: 'refused' as const, ...refused }, pending && { state: 'pending' as const, ...pending }].filter(entry => !!entry && !!entry.since)
    .sort((a, b) => Date.parse(a!.since) - Date.parse(b!.since))[0];
  return older ? { state: older.state, since: older.since, detail: older.detail || null } : { state: 'none', since: null, detail: null };
}

/**
 * One repair-lane merge (AC-3): appended to the ledger as `repair.merged` before GitHub is asked to
 * merge, and kept on the delivered item as `repairLane`.
 */
export interface RepairAudit {
  at: string; item: string; pr: number; head: string;
  decision: string; requestedBy: string; approver: string; fault: string;
  /** The normal guarded merge the lane bypassed: refused or pending, since when, and its last detail. */
  bypassed: NormalMergeState;
}
export const repairAuditEvent = 'repair.merged';
export function repairAudit(work: Work, verdict: Extract<RepairLaneVerdict, { allowed: true }>, at: string): RepairAudit {
  return { at, item: work.key, pr: verdict.pr, head: verdict.sha, decision: verdict.decision.id, requestedBy: verdict.decision.requestedBy,
    approver: verdict.decision.approvedBy!, fault: verdict.fault, bypassed: verdict.bypassed };
}

/**
 * Every repair-lane delivery the merge path has not yet proven healthy after: no item delivered
 * through the normal guarded merge has merged since it.
 */
export function unprovenRepairs(work: Pick<Work, 'key' | 'stage' | 'delivery' | 'repairLane'>[]) {
  const delivered = work.filter(item => item.stage === 'done' && item.delivery?.mergedAt);
  const lastNormal = Math.max(-Infinity, ...delivered.filter(item => !item.repairLane).map(item => Date.parse(item.delivery!.mergedAt)).filter(Number.isFinite));
  return delivered.filter(item => item.repairLane && Date.parse(item.delivery!.mergedAt) >= lastNormal).map(item => ({ ...item.repairLane!, mergedAt: item.delivery!.mergedAt }));
}

/** One master status attention item per repair-lane merge not yet followed by a normal merge. */
export function repairLaneAttention(work: Pick<Work, 'key' | 'stage' | 'delivery' | 'repairLane'>[]): AttentionItem[] {
  return unprovenRepairs(work).map(entry => ({ subject: entry.item,
    text: `${entry.item} PR #${entry.pr} (head ${entry.head.slice(0, 12)}) was merged through the repair lane at ${entry.mergedAt}, bypassing a normal guarded merge ${entry.bypassed.state} since ${entry.bypassed.since}${entry.bypassed.detail ? ` (${entry.bypassed.detail})` : ''}, on decision ${entry.decision} requested by ${entry.requestedBy} and approved by ${entry.approver} for the fault in ${entry.fault}. The merge path is unproven until the next normal merge succeeds`,
    role: 'master' as const, approvedBy: null, human: false, humanOnly: null,
    next: 'Watch the next item through the normal guarded merge; this clears once one merges. If none merges, the repair did not fix the merge path: file a follow-up merge-path repair' }));
}
