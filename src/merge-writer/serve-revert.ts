// Concern: the merge writer's answer to a served commit that fails live verification (GY-2990) —
// revert only the item that broke it, and file that item's re-land. Delivered work is immutable,
// so nothing is undone in history: when the served commit fails a required case and the last
// verified commit passed, the merges between them name their items (each merge's ledger record,
// else the `Merge GY-N` subject the writer gave it); the culprit is the one whose own `e2e:`
// proof names the failing case, else the newest of those merges. The revert is a commit on the
// base tip that takes exactly that merge back out, made without a worktree like the trial's own
// merges, and rides the writer's normal trial and push. The loop files one `Re-land GY-N` item
// carrying the original criteria plus the failing case, linked to GY-N and the failing serve.
import type { Work } from '../model.js';
import { e2eProofsOf, failureIsBase, trialFailureReason, type MergeTrialRun } from './executor.js';
import { trialAuthor } from './trial.js';

/** One git call in the coordinator's object store: the arguments after `git -C <root>` (and the environment, for the revert's author), the child's stdout. */
export type ServeRevertGit = (args: string[], env?: Record<string, string>) => Promise<string>;

/** The failing serve: the served commit and the required case it failed, as the serve pass recorded it. */
export interface ServeFailure { serve: string; failingCase: string; failingStep: string | null; failingReason: string | null }
/** One merge commit between the last verified commit (exclusive) and the served commit (inclusive), oldest first. */
export interface ServeRangeMerge { sha: string; subject: string }

const fullSha = /^[0-9a-f]{40}$/;

/**
 * The merge commits on the first-parent chain from `lastVerified` (exclusive) to `served`
 * (inclusive), oldest first. Throws when either end is unknown to the checkout, so the caller —
 * the loop step, whose failure runs again next cycle — waits for the fetch that names them.
 */
export async function serveRangeMerges(git: ServeRevertGit, lastVerified: string, served: string): Promise<ServeRangeMerge[]> {
  const out = (await git(['log', '--first-parent', '--reverse', '--merges', '--format=%H%x00%s', `${lastVerified.toLowerCase()}..${served.toLowerCase()}`, '--'])).split('\n');
  return out.map(line => line.trim()).filter(Boolean).map(line => {
    const tab = line.indexOf('\0');
    const sha = (tab < 0 ? line : line.slice(0, tab)).trim().toLowerCase(), subject = tab < 0 ? '' : line.slice(tab + 1);
    if (!fullSha.test(sha)) throw new Error(`git log answered no merge sha in ${line.slice(0, 80)}`);
    return { sha, subject };
  });
}

/** The item a merge commit landed for: its ledger's merge sha first, else the `Merge GY-N` subject the writer gave it. */
export function serveMergeOwner(merge: ServeRangeMerge, work: readonly Work[]): Work | null {
  const ledged = work.find(item => item.mergeLedger?.mergeSha?.toLowerCase() === merge.sha);
  if (ledged) return ledged;
  const key = /^Merge (GY-\d+)\b/.exec(merge.subject)?.[1]?.toUpperCase();
  return key ? work.find(item => item.key.toUpperCase() === key) ?? null : null;
}

/**
 * The merge that broke the serve: the one whose item's own `e2e:` proof names the failing case
 * (an `e2e:NAME` proof is the case file `e2e/cases/NAME.json`, so `e2e:<case>` is the case), else
 * the newest of the merges in range. Null when no merge in range names a known item.
 */
export function selectServeCulprit(merges: readonly ServeRangeMerge[], work: readonly Work[], failingCase: string): { item: Work; mergeSha: string } | null {
  const owned = merges.map(merge => ({ merge, item: serveMergeOwner(merge, work) })).filter(entry => entry.item) as { merge: ServeRangeMerge; item: Work }[];
  if (!owned.length) return null;
  const named = owned.find(({ item }) => e2eProofsOf(item).some(proof => proof.slice(4) === failingCase));
  const { merge, item } = named ?? owned[owned.length - 1]!;
  return { item, mergeSha: merge.sha };
}

/**
 * The commit that takes exactly `mergeSha` back out of `baseTip`, made without a worktree: the
 * three-way merge of the tip with the merge's first parent against the merge itself (`--merge-base`
 * is the merge, what `git revert -m 1` applies), committed with the merge writer's author. A conflicted revert names
 * its paths instead — the loop holds it, since no trial can judge a commit that was never made.
 */
export async function revertMergeCommit(git: ServeRevertGit, input: { mergeSha: string; baseTip: string; subject: string }): Promise<{ revertSha: string } | { conflict: string[] }> {
  const mergeSha = input.mergeSha.toLowerCase(), baseTip = input.baseTip.toLowerCase();
  if (!fullSha.test(mergeSha) || !fullSha.test(baseTip)) throw new Error('A serve revert names the merge and the base tip by their full 40-hex shas');
  let out: string;
  try { out = (await git(['merge-tree', '--write-tree', '--merge-base', mergeSha, baseTip, `${mergeSha}^1`])).split('\0')[0]!.trim(); }
  catch (error) {
    // Exit 1 is a conflicted merge, like the trial's own (trial.ts `trialMerge`): the tree id,
    // then the conflicted paths, then the informational messages.
    if ((error as { status?: number | null }).status !== 1 || typeof (error as { stdout?: unknown }).stdout !== 'string') throw error;
    const [, ...rest] = String((error as { stdout?: unknown }).stdout).split('\0');
    const end = rest.indexOf('');
    return { conflict: [...new Set(rest.slice(0, end < 0 ? rest.length : end))].filter(Boolean) };
  }
  if (!fullSha.test(out)) throw new Error(`git merge-tree answered no tree for the revert of ${mergeSha.slice(0, 12)}`);
  const email = `${trialAuthor}@users.noreply.invalid`;
  const revertSha = (await git(['commit-tree', out, '-p', baseTip, '-m', `Revert "${input.subject}"\n\nThis reverts commit ${mergeSha}.`],
    { GIT_AUTHOR_NAME: trialAuthor, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: trialAuthor, GIT_COMMITTER_EMAIL: email })).trim().toLowerCase();
  if (!fullSha.test(revertSha)) throw new Error(`git commit-tree answered no revert commit for ${mergeSha.slice(0, 12)}`);
  return { revertSha };
}

/** The title of the follow-up the loop files for a reverted item. */
export const relandTitle = (item: Pick<Work, 'key'>) => `Re-land ${item.key}`;
/** What the loop files for a reverted item (`POST /api/work` as the master's operator-agent identity). */
export interface RelandInput { title: string; type: Work['type']; priority: number; description: string; criteria: { id: string; text: string; proofs: string[] }[]; dependencies: string[]; reason: string }

/**
 * The `Re-land GY-N` item for a reverted merge: the original criteria carried over, plus the
 * failing case as a criterion of its own, linked to GY-N by dependency and to the failing serve
 * in the description. A carried criterion keeps its id, text and proofs; a bootstrap deferral is
 * not carried — the re-land satisfies everything now, it does not re-defer it.
 */
export function relandItemFor(original: Work, input: ServeFailure & { mergeSha: string; baseBranch: string }): RelandInput {
  const used = new Set(original.criteria.map(criterion => criterion.id));
  let next = original.criteria.length + 1;
  while (used.has(`AC-${next}`)) next++;
  const step = input.failingStep ? ` (${input.failingStep})` : '', reason = input.failingReason ? `: ${input.failingReason}` : '';
  return {
    title: `${relandTitle(original)}${original.title ? `: ${original.title}` : ''}`.slice(0, 200),
    type: original.type, priority: original.priority,
    description: [
      `Re-land of ${original.key}${original.title ? ` ("${original.title}")` : ''}: the merge writer reverted its merge ${input.mergeSha.slice(0, 12)} from ${input.baseBranch} after the served commit ${input.serve.slice(0, 12)} failed the required E2E case "${input.failingCase}"${step}${reason}.`,
      `This item carries ${original.key}'s criteria plus that failing case, and is linked to ${original.key} and the failing serve. Land the change again with the case passing.`,
    ].join('\n\n').slice(0, 20000),
    criteria: [...original.criteria.map(criterion => ({ id: criterion.id, text: criterion.text, proofs: [...criterion.proofs] })),
      { id: `AC-${next}`, text: `The served app passes the required case "${input.failingCase}"${step}, fixed at its cause rather than skipped or weakened`.slice(0, 2000), proofs: [`e2e:${input.failingCase}`] }],
    dependencies: [original.id],
    reason: `The served commit ${input.serve.slice(0, 12)} failed the required case "${input.failingCase}", so ${original.key}'s merge ${input.mergeSha.slice(0, 12)} was reverted; this re-lands it with the case as a criterion`.slice(0, 2000),
  };
}

/** The ports the serve revert runs through: the checkout's git, the writer's normal trial and leased push, and the loop's filing of the re-land. */
export interface ServeRevertPorts {
  git: ServeRevertGit;
  /** The build and tests on the revert commit, with the culprit's proofs counted — the writer's normal trial. */
  trial(revertSha: string, files: readonly string[], item: Pick<Work, 'key' | 'criteria'> & { type?: Work['type'] }): Promise<MergeTrialRun>;
  /** The leased push of the revert commit onto the tip it was trialled on. */
  push(revertSha: string, baseTip: string): Promise<'pushed' | 'rejected'>;
  /** Files the re-land item; answers what the control plane filed, or null when this loop cannot file. */
  file(input: RelandInput): Promise<{ key?: string } | null>;
}

/** What one serve revert came to. */
export type ServeRevertResult =
  | { outcome: 'reverted'; culprit: Work; mergeSha: string; revertSha: string; reland: string | null }
  | { outcome: 'held'; culprit: Work; mergeSha: string; reason: string }
  | { outcome: 'retry'; culprit: Work; mergeSha: string; revertSha: string; reason: string }
  | { outcome: 'already-reverted'; culprit: Work; mergeSha: string }
  | { outcome: 'unattributed'; merges: string[] }
  | { outcome: 'up-to-date' };

/** Why the revert's trial fails it: the base's own failure retries, anything else holds. */
const revertTrialVerdict = (run: MergeTrialRun): { retry: string } | { held: string } | null => {
  if (failureIsBase(run)) return { retry: 'the base tip fails the same checks, so the revert proves nothing yet' };
  const failed = trialFailureReason({ run });
  return failed ? { held: failed } : null;
};

/** The revert commit's trial and leased push: pass, a held trial failure, or a retry (a failing base, or a push the base move rejected). */
export async function trialAndPushRevert(ports: Pick<ServeRevertPorts, 'trial' | 'push'>,
  input: { revertSha: string; files: readonly string[]; item: Pick<Work, 'key' | 'criteria'> & { type?: Work['type'] }; baseTip: string; culpritKey: string; mergeSha: string }): Promise<{ ok: true } | { held: string } | { retry: string }> {
  const verdict = revertTrialVerdict(await ports.trial(input.revertSha, input.files, input.item));
  if (verdict && 'retry' in verdict) return { retry: verdict.retry };
  if (verdict) return { held: `the revert of ${input.culpritKey}'s merge ${input.mergeSha.slice(0, 12)} failed its trial: ${verdict.held}` };
  if (await ports.push(input.revertSha, input.baseTip) !== 'pushed') return { retry: `the leased push of the revert of ${input.culpritKey}'s merge was rejected; the base moved` };
  return { ok: true };
}

/**
 * One serve revert, end to end: the merges since the last verified commit, the culprit among
 * them, its revert commit on `baseTip`, the normal trial and the leased push, and the filed
 * re-land. A revert the trial fails is held with its reason; a push the base move rejects is
 * retried, never held. A merge named by `alreadyReverted` stays reverted: reverting it again
 * would re-apply its change onto its own revert and oscillate main while the serve keeps
 * failing. A filing that fails (or a loop that cannot file) still stands on the pushed revert:
 * the re-land rides as null and the loop files it from the recorded revert.
 */
export async function runServeRevert(ports: ServeRevertPorts, input: ServeFailure & { lastVerified: string; baseTip: string; baseBranch: string; work: readonly Work[]; alreadyReverted?: readonly string[] }): Promise<ServeRevertResult> {
  const merges = await serveRangeMerges(ports.git, input.lastVerified, input.serve);
  if (!merges.length) return { outcome: 'up-to-date' };
  const culprit = selectServeCulprit(merges, input.work, input.failingCase);
  if (!culprit) return { outcome: 'unattributed', merges: merges.map(merge => merge.sha) };
  if (input.alreadyReverted?.some(sha => sha.toLowerCase() === culprit.mergeSha)) return { outcome: 'already-reverted', culprit: culprit.item, mergeSha: culprit.mergeSha };
  const subject = merges.find(merge => merge.sha === culprit.mergeSha)?.subject ?? `Merge ${culprit.item.key}`;
  const revert = await revertMergeCommit(ports.git, { mergeSha: culprit.mergeSha, baseTip: input.baseTip, subject });
  if ('conflict' in revert) return { outcome: 'held', culprit: culprit.item, mergeSha: culprit.mergeSha,
    reason: `the revert of ${culprit.item.key}'s merge ${culprit.mergeSha.slice(0, 12)} does not apply cleanly on ${input.baseTip.slice(0, 12)}: ${revert.conflict.slice(0, 20).join(', ')}` };
  const files = (await ports.git(['diff', '--name-only', input.baseTip, revert.revertSha])).split('\n').map(line => line.trim()).filter(Boolean);
  const decided = await trialAndPushRevert(ports, { revertSha: revert.revertSha, files, item: culprit.item, baseTip: input.baseTip, culpritKey: culprit.item.key, mergeSha: culprit.mergeSha });
  if ('retry' in decided) return { outcome: 'retry', culprit: culprit.item, mergeSha: culprit.mergeSha, revertSha: revert.revertSha, reason: decided.retry };
  if ('held' in decided) return { outcome: 'held', culprit: culprit.item, mergeSha: culprit.mergeSha, reason: decided.held };
  const reland = relandItemFor(culprit.item, { ...input, mergeSha: culprit.mergeSha });
  let filed: { key?: string } | null = null;
  try { filed = await ports.file(reland); } catch { filed = null; }
  return { outcome: 'reverted', culprit: culprit.item, mergeSha: culprit.mergeSha, revertSha: revert.revertSha, reland: filed?.key ?? null };
}
