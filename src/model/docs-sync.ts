import { z } from 'zod';
import type { Work } from './work.js';
import type { ApprovalIdentity, CarriedApproval, CarriedProof, QueueCarry, RequiredApproval, TipMerge } from './carry.js';
import type { Evidence } from './evidence.js';

/**
 * GY-566. Docs-only conflicts are synced by the control plane, not reworked.
 *
 * Every item documents its change within a word budget, so items edit the same paragraphs of the
 * same few pages, and every merge on the base branch left the queued items behind it conflicting
 * there. Each such conflict used to cost a rework decision, an approver, a worker session, a new
 * review, new proofs and the queue position — for a conflict in prose. Now a conflict the control
 * plane's base refresh confirmed is classified by the paths that conflict:
 *
 * - confined to `docs/**\/*.md`: the loop launches one short docs-sync session on a reviewer-class
 *   account with a narrow prompt — merge the base into the item's branch, keep both sides' meaning,
 *   stay within the word budget, touch only the conflicted paragraphs, rerun the docs obligation
 *   check and the word-budget test, push. No rework decision is requested.
 * - anything else, or a docs-sync session that ended without moving the head: rework, as before.
 *
 * When the synced head is observed, the control plane records it as a base refresh of the reviewed
 * head and decides the carry itself (`docsSyncCarry`): the approval is kept when the change's own
 * diff outside `docs/` has the same patch-id on both sides of the merge, so the code the reviewer
 * judged is exactly the code that lands. Proofs run again on the synced head.
 */

/** A page the docs-sync may resolve: Markdown under docs/, at any depth. */
export const isDocsPage = (path: string) => /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path);
/** Whether a conflict is the docs-sync's: a known, non-empty set of paths, every one a docs page. */
export const docsOnlyConflict = (paths: readonly string[] | null | undefined): paths is string[] => !!paths?.length && paths.every(isDocsPage);
/** Outside `docs/`: what the approval kept across a docs-sync was given on. */
export const outsideDocs = (path: string) => !path.startsWith('docs/');

export type ConflictRoute = 'docs-sync' | 'rework';
/** Where a confirmed conflict goes: a docs-sync session when every conflicted path is a docs page, otherwise a worker. */
export function conflictRoute(paths: readonly string[] | null | undefined): { route: ConflictRoute; reason: string } {
  if (docsOnlyConflict(paths)) return { route: 'docs-sync', reason: `every conflicted path is a docs page (${paths.join(', ')}), so a docs-sync session resolves it on the item's branch` };
  if (!paths?.length) return { route: 'rework', reason: 'the conflicted paths are not known, so only a worker can resolve the conflict' };
  const code = paths.filter(path => !isDocsPage(path));
  return { route: 'rework', reason: `the conflict touches ${code.slice(0, 5).join(', ')}${code.length > 5 ? ` and ${code.length - 5} more` : ''} outside docs/**/*.md, so it returns to a worker` };
}

/**
 * The paths both sides of a merge changed since their merge base: every path that can conflict is
 * among them. The control plane records them with a confirmed conflict from GitHub's compares; the
 * loop narrows them with its own in-memory merge (`localConflictPaths`) where it can.
 */
export function overlappingPaths(head: readonly string[] | null, base: readonly string[] | null): string[] | null {
  if (!head || !base) return null;
  const changed = new Set(base);
  return [...new Set(head.filter(path => changed.has(path)))].sort();
}

/** What the control plane found when it adopted a docs-sync head (GY-566), recorded on the base refresh. */
export interface DocsSync {
  /** The paths recorded conflicting when the reviewed head could not be brought onto the base. */
  paths: string[] | null;
  /** The synced head as it was observed: the candidate it becomes. */
  to: { sha: string; baseSha: string };
  /** Patch-id of the reviewed head's own diff outside docs/, and of the synced head's; null when GitHub could not list one completely. */
  reviewed: string | null; synced: string | null;
}

/**
 * The docs-sync head an observation shows, or null (GY-566). The control plane's base refresh
 * confirmed a conflict of the reviewed head with a base tip and wrote nothing; the pull request
 * now has another head. It is recorded as that refresh's outcome — so its carry is decided — only
 * while no rework was requested (a worker's own sync is a new submission), outside the merge
 * queue, and for the same pull request.
 */
export function docsSyncAdoption(work: Work, observation: { candidate: { sha: string; baseSha: string; pr: number }; merged?: boolean; prState?: string }): { from: { sha: string; baseSha: string }; base: string; head: string; to: { sha: string; baseSha: string }; paths: string[] | null } | null {
  const candidate = work.candidate, refresh = work.baseRefresh;
  if (!work.submission || work.reworkRequested || work.queue || work.stage === 'done' || !candidate || !refresh) return null;
  if (!refresh.conflict || refresh.head !== null || refresh.restore || refresh.stale) return null;
  if (refresh.from.sha !== candidate.sha || refresh.from.baseSha !== candidate.baseSha || refresh.policyRevision !== work.policyRevision) return null;
  if (observation.merged || observation.prState === 'closed' || observation.candidate.pr !== candidate.pr || observation.candidate.sha === candidate.sha) return null;
  return { from: refresh.from, base: refresh.base, head: observation.candidate.sha, to: { sha: observation.candidate.sha, baseSha: observation.candidate.baseSha }, paths: refresh.conflictPaths ?? null };
}

const short = (sha: string) => sha.slice(0, 12);
/**
 * The carry across a docs-sync head (GY-566). The head must be a two-parent merge of exactly the
 * reviewed head and the base tip its conflict was confirmed on. The approval is kept when the
 * change's own diff outside docs/ has the same patch-id on both sides: the docs-sync resolved prose
 * and nothing the reviewer judged changed. Otherwise a fresh independent approval is required, and
 * the item still keeps its place: no rework round is spent. Evidence is never carried: the proofs
 * run again on the synced head, as they would on any head whose tree nobody proved.
 */
export function docsSyncCarry(input: { from: { sha: string; baseSha: string }; base: string; at: string; policyRevision: number; merge: TipMerge | null; docsSync: DocsSync;
  reviewedFiles: string[]; approval: ApprovalIdentity | null; proofs: { proof: string; evidence: Evidence | undefined }[] }): QueueCarry {
  const { from, docsSync, merge } = input, to = docsSync.to;
  const expected = new Set([from.sha, input.base]), parents = new Set(merge?.parents ?? []);
  const refusal = !merge || merge.from !== from.sha ? `docs-sync head ${short(to.sha)} was not described as a merge of the reviewed head ${short(from.sha)}`
    : parents.size !== expected.size || [...expected].some(sha => !parents.has(sha)) ? `docs-sync head ${short(to.sha)} has parents ${(merge.parents ?? []).map(short).join(', ') || 'none'} rather than exactly the reviewed head ${short(from.sha)} and base tip ${short(input.base)}, so it carries commits nobody reviewed`
    : !docsSync.reviewed || !docsSync.synced ? `the diff outside docs/ of ${short(from.sha)} or ${short(to.sha)} could not be listed completely, so it cannot be shown unchanged`
    : docsSync.reviewed !== docsSync.synced ? `the docs-sync changed the diff outside docs/ (patch-id ${short(docsSync.reviewed)} became ${short(docsSync.synced)})`
    : null;
  const approval: CarriedApproval | RequiredApproval = !input.approval ? { carried: false, reason: `no approval was bound to the reviewed head ${short(from.sha)}` }
    : refusal ? { carried: false, reason: `${refusal}; a fresh independent approval of ${short(to.sha)} is required` }
    : { ...input.approval, carried: true, originalSha: input.approval.sha, reason: `approval of ${short(from.sha)} by ${input.approval.reviewer} kept on docs-sync head ${short(to.sha)}: the diff outside docs/ is unchanged (patch-id ${short(docsSync.reviewed!)}); only docs pages were resolved` };
  const evidence: CarriedProof[] = input.proofs.map(({ proof }) => ({ proof, carried: false, reason: `the docs-sync head ${short(to.sha)} is a tree nobody proved; fresh evidence is required` }));
  return { from, to, policyRevision: input.policyRevision, at: input.at, predecessor: 'base branch', changedFiles: merge?.baseChanges ?? null, reviewedFiles: input.reviewedFiles, approval, evidence,
    ground: { rule: refusal ? 'diff changed' : 'diff unchanged', patchId: docsSync.reviewed, tipPatchId: docsSync.synced } };
}

// ---- The loop's record of routed conflicts ---------------------------------------------------

/** One docs-sync the loop started for a confirmed conflict, keyed by item, head and base tip. */
export const docsSyncWatchSchema = z.object({
  work: z.string().max(40), head: z.string().max(64), base: z.string().max(64), paths: z.array(z.string().max(500)).max(200),
  agentName: z.string().max(200).nullable(), pane: z.string().max(200).nullable(), session: z.string().max(200).nullable().default(null),
  launchedAt: z.string(),
  /** Why the docs-sync gave the conflict up to rework, or null while it runs or once it moved the head. */
  failed: z.string().max(1000).nullable().default(null),
  /** When the loop first found the session gone, or past its bound, while the head had not moved. */
  goneAt: z.string().optional(),
  settledAt: z.string().nullable().default(null),
}).strict();
export type DocsSyncWatch = z.infer<typeof docsSyncWatchSchema>;
/** One conflict the loop routed: the paths, and whether it went to a docs-sync session or back to a worker. */
export const routedConflictSchema = z.object({
  work: z.string().max(40), head: z.string().max(64), base: z.string().max(64), at: z.string(),
  paths: z.array(z.string().max(500)).max(200), route: z.enum(['docs-sync', 'rework']),
}).strict();
export type RoutedConflict = z.infer<typeof routedConflictSchema>;
/** Routed conflicts kept: a day's worth at the rate that prompted GY-566, several times over. */
export const routedConflictRetention = 500;
/** The window the hotspot report counts over, and how long a settled docs-sync record is kept. */
export const routedConflictWindowMs = 24 * 3_600_000;
export const docsSyncWatchKey = (item: Pick<Work, 'id'>, head: string, base: string) => `${item.id}:${head}:${base}`;
