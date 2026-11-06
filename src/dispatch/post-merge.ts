import { type Work } from '../model.js';
import { type DispatchRequest } from '../model/dispatch.js';
import { postMergeFindingsMax, type ReviewRecord } from '../reviewer.js';
import { parseFinding, postMergeFollowUp, postMergeRequestId, wholeFindings } from '../model/post-merge-review.js';
import { reviewedBeforeMerge } from '../model/risk-class.js';
import { riskOf } from '../model-boundary/risk-class.js';
import { blockingFindings, followUpFindingsOf } from '../review-cap.js';
import type { DispatchEffects } from './effects.js';
/** What the loop did with one post-merge verdict (GY-1525): the follow-up item per BLOCKING finding, the nits kept in memory, and a filing failure to retry. */
export type PostMergeOutcome = NonNullable<ReviewRecord['postMergeFollowUps']>;
/** The wait a normal-risk control-plane head's pre-merge review request reports (GY-1525): it merges on its trial and is reviewed after. */
export const postMergeWaitReason = 'normal-risk delta in control-plane mode: it merges on its trial and is reviewed after the merge, so no pre-merge reviewer session is launched';
/** Whether the item's pre-merge review request is answered by a post-merge review instead: a control-plane head whose merge delta reads normal (the one merge rule, model/gates.ts). */
export const reviewedAfterMerge = (work: Work) => work.observation?.source === 'control-plane' && !reviewedBeforeMerge(riskOf(work).risk);
/**
 * The dispatch request a post-merge review is launched under: one per delivered merge commit, bound
 * to nothing else. Its base is the merge commit's first parent, the tip the merge writer's ledger
 * merged onto; a delivery whose ledger names none leaves the launcher to read the parent from the
 * object store (reviewer.ts `postMergeBinding`). No provider: GitHub never answers it.
 */
export function postMergeRequest(work: Work): DispatchRequest {
  const mergeSha = work.delivery!.mergeSha;
  const baseSha = work.mergeLedger?.mergeSha === mergeSha && work.mergeLedger.baseTip ? work.mergeLedger.baseTip : unknownParent;
  return { id: postMergeRequestId(work.key, mergeSha), kind: 'review', sha: mergeSha, baseSha, policyRevision: work.policyRevision, pr: work.candidate?.pr ?? work.submission?.pr ?? 0,
    requestedAt: work.delivery!.mergedAt, reason: `post-merge review of ${work.key}'s normal-risk delta ${mergeSha.slice(0, 12)}`, state: 'requested' };
}
/** The base a post-merge request carries while the merge commit's first parent is not on the ledger. */
export const unknownParent = '0'.repeat(40);
/**
 * File one follow-up item through the API as the given credential (GY-1525 AC-4): created under
 * `requestId`, then released under `requestId:ready` so it is worked at once, as a defect a reviewer
 * judged blocking on shipped code should be. Both calls
 * replay under their keys, so a retry after a failed release creates nothing twice.
 */
export async function postFollowUpItem(base: string, token: string, body: unknown, requestId: string, post: typeof fetch = fetch): Promise<{ key: string }> {
  const call = async (path: string, key: string, payload: unknown) => {
    const response = await post(`${base.replace(/\/$/, '')}/api/work${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
    const result = await response.json().catch(() => ({})) as { id?: string; key?: string; revision?: number; error?: string };
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : JSON.stringify(result));
    return result;
  };
  const created = await call('', requestId, body);
  if (typeof created.key !== 'string' || typeof created.id !== 'string') throw new Error('the control plane created the follow-up without a key');
  // The operator agent releases at the revision it created (engine.ts demands it); a replayed creation returns that same revision.
  await call(`/${encodeURIComponent(created.id)}/ready`, `${requestId}:ready`, { ...(typeof created.revision === 'number' ? { expectedRevision: created.revision } : {}), reason: 'post-merge review finding: released by the loop' });
  return { key: created.key };
}
/**
 * File what a post-merge verdict found (GY-1525 AC-4): one follow-up item per BLOCKING line, planned
 * on the finding's file, keyed so a retried filing replays; every other finding to project memory.
 * A filing that fails is recorded with its reason and retried on the next tick for the findings not
 * yet filed; the delivered item is never reopened. Null when the record holds no verdict to file.
 */
export async function filePostMergeFollowUps(work: Work, record: ReviewRecord, effects: Pick<DispatchEffects, 'createWork' | 'recordFindings'>, now: Date): Promise<PostMergeOutcome | null> {
  if (!record.postMerge || !record.verdict) return null;
  const launch = work.reviewLaunch && (record.launch ? work.reviewLaunch.id === record.launch : work.reviewLaunch.head === record.sha) ? work.reviewLaunch : null;
  const body = launch?.verdict?.sha === record.sha ? launch.verdict.body : null;
  if (body === null) return null;
  const filed = [...(record.postMergeFollowUps?.filed ?? [])];
  // blockingFindings caps a body at ten; read line by line, every BLOCKING line is a finding.
  const lines = body.split('\n').flatMap(line => blockingFindings(line));
  // Every line is filed, never cut: at most postMergeFindingsMax per tick, the rest on the next ticks (`pending`).
  // `through` counts the lines filed in order, so the ledger lists only the most recent window of them.
  let through = record.postMergeFollowUps?.through ?? 0;
  let failure: string | undefined;
  let batch = 0;
  for (const [index, text] of lines.entries()) {
    const finding = text.slice(0, 300);
    // Completion is per line, not per wording: two distinct lines with the same text each get their own item.
    if (index < through || filed.some(entry => entry.index === index || (entry.index === undefined && entry.finding === finding))) continue;
    if (batch >= postMergeFindingsMax) break;
    if (!effects.createWork) { failure = 'no follow-up filer is wired; the finding stands on the verdict'; break; }
    try {
      const created = await effects.createWork(postMergeFollowUp(work, record.sha, parseFinding(text), index), `post-merge-follow-up:${work.key}:${record.sha}:${index}`);
      filed.push({ key: created.key, finding, index });
      if (index === through) through = index + 1;
      batch++;
    } catch (error) { failure = `filing the follow-up for "${finding.slice(0, 80)}" failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`.slice(0, 500); break; }
  }
  // Non-blocking findings stay retryable until project memory accepts them: a write failure must
  // not settle the count, or later ticks skip the verdict and the findings are never recorded.
  let memory = record.postMergeFollowUps?.memory;
  if (memory === undefined) {
    // Every finding that is no BLOCKING line: the body without those lines, read as a change request's
    // follow-ups are, but neither counted nor cut — the API bounds the verdict body, so every one is kept.
    const rest = body.split('\n').filter(line => !/^\s*(?:[-*]\s*)?\**BLOCKING\**\s*:/i.test(line)).join('\n');
    const nits = wholeFindings(rest, followUpFindingsOf(rest, Infinity));
    if (nits.length && effects.recordFindings) {
      try { await effects.recordFindings(work, record, nits); memory = nits.length; }
      catch (error) {
        const reason = `recording non-blocking findings in project memory failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`.slice(0, 500);
        failure = failure ? `${failure}; ${reason}`.slice(0, 500) : reason;
      }
    } else memory = nits.length;
  }
  const pending = lines.filter((_, index) => index >= through && !filed.some(entry => entry.index === index)).length;
  return { at: now.toISOString(), filed: filed.slice(-postMergeFindingsMax), through, ...(pending > 0 ? { pending } : {}), ...(memory !== undefined ? { memory } : {}), ...(failure ? { failure } : {}) };
}
