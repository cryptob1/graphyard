// Concern: the guarded merge — candidate checks, protection, queued landing and the merge executor.
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { mergeOrder } from '../delegation.js';
import { type Work, standingEscalations, evidenceIndependenceRefusals, nativeReviewRequired, CHECK_NAME, type CarriedApproval, carriedApproval } from '../model.js';
import { conversationProtectionRefusal } from '../merge-queue.js';
import { onOptimisticLane, optimisticLandingRefusal } from '../optimistic-merge.js';
import { missingBaseAncestry, missingAncestryReason } from '../merge-base-ancestry.js';
import type { MasterConfig } from './profiles.js';
import { privateFile } from './config.js';

/**
 * One merge executor instance: the coordinator principal and the instance minted for one daemon
 * process or one interactive `master merge` request (its request id, so a replay under
 * `GRAPHYARD_REQUEST_ID` is the same instance). The engine records who requested a merge as
 * `principal#instance` (Engine.requestEnqueue); GitHub performs the merge itself.
 */
export interface MergeExecutor { principal: string; instance: string }
/**
 * The durable loop's executor instance, minted once per daemon process: an execution this loop
 * acquires is resumed by this loop alone, and an interactive `master merge` under the same
 * credential — or a second loop — stands down from it.
 */
export const daemonExecutor = (principal: string): MergeExecutor => ({ principal, instance: `daemon-${randomUUID()}` });
/** Where an observed merge sits with no valid execution behind it: the violation the engine records. */
export const unauthorizedMergeViolation = 'Merge observed without a prior authorization for this candidate';
/** True for an item held at the merge stage by an observed merge no execution authorized (GY-92). */
export const mergedWithoutAuthorization = (work: Work) => work.stage !== 'done' && !!work.observation?.merged && work.violations.includes(unauthorizedMergeViolation);
export function assertMergeCandidate(work: Work, observedAt?: string) {
  const age = observedAt && work.observation ? Date.parse(observedAt) - Date.parse(work.observation.at) : 0;
  const fresh = !observedAt || !!work.observation && Number.isFinite(age) && age >= 0 && age < 120_000;
  // Unresolved review threads never refuse a merge by themselves; a branch that still requires
  // conversation resolution (protection drift) is a merge GitHub will refuse, so that is refused
  // here, naming the threads, before GitHub is asked to merge.
  const threads = conversationProtectionRefusal(work);
  if (threads) throw new Error(`${work.key} was refused before GitHub was asked to merge it: ${threads}`);
  // An unresolved escalation, a standing blocking lead ruling, and trusted
  // evidence whose producer has since implemented the item each refuse delivery
  // in the broker as well as in the gate, so a stale snapshot can never present
  // such an item as selectable.
  if (!fresh || standingEscalations(work).length || work.leadHold || evidenceIndependenceRefusals(work).length || work.stage !== 'merge' || !work.candidate || !work.mergeAuthorization || work.mergeAuthorization.sha !== work.candidate.sha || work.mergeAuthorization.baseSha !== work.candidate.baseSha || work.mergeAuthorization.policyRevision !== work.policyRevision || work.gates.some(gate => !gate.passed) || work.violations.length) throw new Error(`${work.key} does not have a current all-gates-passing merge authorization`);
  return { key: work.key, revision: work.revision, pr: work.candidate.pr, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision };
}
// Merge order is recomputed from current dependencies and conflicts on every
// batch; registration order carries no authority.
export function currentMergeCandidates(work: Work[], observedAt: string) {
  const observed = Date.parse(observedAt);
  const order = mergeOrder(work, Number.isFinite(observed) ? observed : Date.now());
  const rank = (item: Work) => order.indexOf(item.key) + 1 || Number.MAX_SAFE_INTEGER;
  return work.filter(item => {
    try { assertMergeCandidate(item, observedAt); return true; }
    catch { return false; }
  }).sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}
export async function continueMergeBatch<T extends { key: string }, R>(items: T[], action: (item: T) => Promise<R>) {
  const results: (R | { key: string; result: 'refused'; reason: string })[] = [];
  for (const item of items) {
    try { results.push(await action(item)); }
    catch (error) { results.push({ key: item.key, result: 'refused', reason: error instanceof Error ? error.message : 'Merge attempt failed' }); }
  }
  return results;
}
export function assertMergeProtection(protection: any, config: MasterConfig, work: Work) {
  const nativeReview = nativeReviewRequired(work.policy);
  const reviews = protection?.required_pull_request_reviews;
  const checks = protection?.required_status_checks;
  // "Require branches to be up to date" cannot coexist with a merge queue: a queued tip is
  // deliberately behind the base branch while the entries ahead of it land. Graphyard replaces that
  // setting with a stronger binding of its own — every landing is a published speculative tip that
  // already contains its validated base, rechecked against the live base tree immediately before
  // the provider call — so it is required to be off rather than left to fail at the merge API.
  if (checks?.strict !== false) throw new Error(`${work.key} managed-branch protection still requires branches to be up to date; the merge queue supersedes that setting and no queued tip can land while it is enabled`);
  const protectedBranch = (!nativeReview || reviews?.required_approving_review_count >= 1 && reviews?.dismiss_stale_reviews === true && reviews?.require_last_push_approval === true)
    && protection?.enforce_admins?.enabled === true && protection?.allow_force_pushes?.enabled !== true && protection?.allow_deletions?.enabled !== true
    && Array.isArray(checks?.checks) && checks.checks.some((check: any) => check?.context === CHECK_NAME && check?.app_id === config.githubAppId);
  if (!protectedBranch) throw new Error(`${work.key} managed-branch protection changed after merge authorization; Graphyard refused the merge`);
}
/**
 * The real head of the managed base branch, read from `refs/heads/<base>`. A pull request's
 * `baseRefOid` is GitHub's cached view of the same ref, refreshed only when the pull request is
 * recomputed (a push to its head), so right after a predecessor merges it still names the
 * pre-merge base and would refuse every follower in the queue. The landing check therefore
 * never reads it: the server-side observation reads the ref (GY-57) and the broker does the same.
 */
export async function readBaseTip(repository: string, baseBranch: string, run: ChildRun): Promise<string> {
  const ref = JSON.parse(await run('gh', ['api', `repos/${repository}/git/ref/heads/${baseBranch.split('/').map(encodeURIComponent).join('/')}`]));
  const tip = ref?.object?.sha;
  if (ref?.object?.type !== 'commit' || typeof tip !== 'string' || !/^[a-f0-9]{40}$/.test(tip)) throw new Error(`GitHub did not return a readable head for refs/heads/${baseBranch} of ${repository}`);
  return tip;
}
/**
 * The validated commit must still land its tested tree. Only a Graphyard-published speculative tip
 * may land, because publication is what proves the validated commit already contains its base. The
 * base branch must then still be exactly that base, or have advanced only through earlier queue
 * merges, which leave its tree untouched. Any other advance refuses the merge, naming both the
 * real base tip and the validated base with their trees. The base tip is `refs/heads/<base>` as
 * GitHub serves it now, never the pull request's cached `baseRefOid`.
 */
export async function assertQueuedLanding(work: Work, authorization: { sha: string; baseSha: string }, baseBranch: string, repository: string, run: ChildRun): Promise<{ baseTip: string; baseTree: string | null }> {
  const speculation = work.queue?.speculation;
  if (!speculation || speculation.tip !== authorization.sha || speculation.base !== authorization.baseSha || !speculation.baseTree) throw new Error(`${work.key} has no published merge-queue tip for the authorized commit; the queue is the only path onto the base branch`);
  const baseTip = await readBaseTip(repository, baseBranch, run);
  if (baseTip === authorization.baseSha) return { baseTip, baseTree: null };
  const commit = JSON.parse(await run('gh', ['api', `repos/${repository}/commits/${baseTip}`]));
  const baseTree = commit?.commit?.tree?.sha;
  if (typeof baseTree !== 'string' || !/^[a-f0-9]{40}$/.test(baseTree)) throw new Error(`GitHub did not return a tree for ${baseBranch} head ${baseTip} of ${repository}`);
  if (baseTree !== speculation.baseTree) throw new Error(`${work.key} base branch ${baseBranch} advanced outside the merge queue: its head ${baseTip} (tree ${baseTree}) is not tree-identical to validated base ${authorization.baseSha} (tree ${speculation.baseTree}); the validated tip would no longer land its tested tree`);
  return { baseTip, baseTree };
}
/** The GitHub review states a re-post decision reads; anything else is a comment, not a verdict. */
const verdictStates = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'];
export type CarriedApprovalRepost = { posted: boolean; reviewId: number | null; reason: string };
/**
 * GitHub dismisses a stale review on any push to the branch, Graphyard's own mechanical tip
 * publication included, and a native review requirement then demands an approval after that
 * push. When the control plane carried the approval of H to its authored tip H', the master
 * re-posts that approval bound to H' — through the reviewer App that approved H, and only that
 * identity; never through the control-plane App — so the provider merge is not refused for a
 * review the record already accepts. A verdict the reviewer has since changed is never replaced.
 */
export async function repostCarriedApproval(config: MasterConfig, work: Work, carried: CarriedApproval, dependencies: {
  run: ChildRun;
  mint?: (credentialFile: string, repository: string) => Promise<{ token: string }>;
  fetcher?: typeof fetch;
}): Promise<CarriedApprovalRepost> {
  const candidate = work.candidate!;
  if (carried.provider !== 'github') return { posted: false, reviewId: null, reason: `the carried ${carried.provider} approval needs no native review re-post` };
  const identity = config.reviewer ? `${config.reviewer.slug}[bot]` : null;
  if (!identity || identity.toLowerCase() !== carried.reviewer.toLowerCase()) return { posted: false, reviewId: null, reason: `the approval of ${carried.originalSha.slice(0, 12)} was posted by ${carried.reviewer}, not by the bound reviewer App${identity ? ` ${identity}` : ''}; only the identity that approved it may re-post it, so the provider may still require a fresh native approval` };
  const reviews = JSON.parse(await dependencies.run('gh', ['api', '--paginate', `repos/${config.repository}/pulls/${candidate.pr}/reviews`]));
  if (!Array.isArray(reviews)) throw new Error(`GitHub did not return a review list for ${work.key}`);
  const own = reviews.filter((review: any) => String(review?.user?.login ?? '').toLowerCase() === identity.toLowerCase() && verdictStates.includes(review?.state));
  const latest = own.at(-1);
  if (latest?.commit_id === candidate.sha && latest.state === 'APPROVED') return { posted: false, reviewId: Number(latest.id), reason: `${identity} already approved tip ${candidate.sha.slice(0, 12)}` };
  if (latest?.state === 'CHANGES_REQUESTED') throw new Error(`${work.key}: ${identity} requested changes after approving ${carried.originalSha.slice(0, 12)}; the carried approval is not re-posted over a changed verdict`);
  const original = carried.reviewId !== undefined ? own.find((review: any) => Number(review.id) === carried.reviewId) : own.find((review: any) => review.commit_id === carried.originalSha && review.state !== 'CHANGES_REQUESTED');
  if (!original || original.commit_id !== carried.originalSha) throw new Error(`${work.key}: the approval of ${carried.originalSha.slice(0, 12)} by ${identity} is no longer on the pull request; the carried binding cannot be re-posted`);
  const mint = dependencies.mint ?? (async (file: string, repository: string) => {
    const { mintReviewerToken, reviewerCredentialSchema } = await import('../reviewer.js');
    await privateFile(file);
    return mintReviewerToken(reviewerCredentialSchema.parse(JSON.parse(await readFile(file, 'utf8'))), repository, dependencies.fetcher);
  });
  const { token } = await mint(config.reviewer!.credentialFile, config.repository);
  // The approval binds the very commit it was given on when GitHub dismissed it for a merge-base
  // change on an unchanged head, or when the reviewed head was republished as the tip itself;
  // the recorded reason says which.
  const body = carried.originalSha === candidate.sha
    ? `Graphyard restored this identity's approval of ${candidate.sha} (review ${carried.reviewId ?? 'n/a'}) to the commit it was given on: ${carried.reason}. Re-posted by the reviewer App so branch protection sees the approval of the same commit again.`
    : `Graphyard carried this identity's approval of ${carried.originalSha} (review ${carried.reviewId ?? 'n/a'}) to Graphyard-authored merge-queue tip ${candidate.sha}: ${carried.reason}. Re-posted by the reviewer App so branch protection sees the approval after the control plane's own tip publication.`;
  const response = await (dependencies.fetcher ?? fetch)(`https://api.github.com/repos/${config.repository}/pulls/${candidate.pr}/reviews`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ commit_id: candidate.sha, event: 'APPROVE', body }),
  });
  if (!response.ok) throw new Error(`The reviewer App could not re-post the carried approval for ${work.key} (${response.status})`);
  const posted: any = await response.json();
  if (posted?.state !== 'APPROVED' || posted?.commit_id !== candidate.sha || String(posted?.user?.login ?? '').toLowerCase() !== identity.toLowerCase() || !Number.isSafeInteger(posted?.id)) throw new Error(`GitHub did not record the re-posted approval for ${work.key} as ${identity} on ${candidate.sha.slice(0, 12)}`);
  return { posted: true, reviewId: posted.id, reason: `re-posted the carried approval of ${carried.originalSha.slice(0, 12)} as ${identity} on tip ${candidate.sha.slice(0, 12)}` };
}
/**
 * What a guarded merge is bound to: the candidate head, its base, the policy revision, the published
 * queue tip or the optimistic lane (GY-500) and the all-gates authorization for exactly those. The whole-document revision is not
 * part of it: observations, bookkeeping and dispatch records bump the revision constantly, and a
 * merge refused for an unrelated write lost every race to its own background refreshes (GY-192).
 * Anything that changes what would be merged changes this binding and still refuses.
 */
export function mergeBinding(work: Work) {
  const speculation = work.queue?.speculation;
  return JSON.stringify([work.candidate?.sha ?? null, work.candidate?.baseSha ?? null, work.candidate?.pr ?? null, work.policyRevision,
    speculation?.tip ?? null, speculation?.base ?? null, speculation?.baseTree ?? null, work.optimistic?.head ?? null, work.optimistic?.baseTip ?? null,
    work.mergeAuthorization?.sha ?? null, work.mergeAuthorization?.baseSha ?? null, work.mergeAuthorization?.policyRevision ?? null]);
}
/**
 * A refusal that only says the record moved between two reads of the same attempt: nothing about
 * the candidate was judged, so it is retried at once on a fresh read rather than backed off.
 */
export function transientMergeRace(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /(changed (before|after) GitHub verification|Task changed before (the merge was requested|merge execution)); retry\b/.test(text);
}
/** What the merge step reports: the request GitHub now holds, or the merge GitHub already performed. */
export type MergeOutcome = { key: string; pr: number; sha: string; result: string; pending?: boolean; enqueued?: boolean; merged?: boolean; mergeSha?: string; carriedApproval?: CarriedApprovalRepost };
/**
 * The merge step (GY-258). GitHub executes merges; Graphyard only gates them. The step re-reads the
 * item, confirms every gate still passes for exactly the candidate, and records the coordinator's
 * request that GitHub merge it. The control plane's App then publishes `Graphyard / merge` on that
 * head and enqueues the pull request in GitHub's merge queue (auto-merge where the base branch has
 * none), and dequeues it if authorization is withdrawn. The outcome is pending until the merged
 * observation, from which the delivery is recorded; no Graphyard code calls the merge endpoint.
 */
export async function mergeWork(config: MasterConfig, work: Work, freshSnapshot: () => Promise<{ work: Work[]; now: string }>, enqueue: (work: Work, authorization: ReturnType<typeof assertMergeCandidate>) => Promise<{ enqueue?: { sha: string; at: string } }>, run: ChildRun = defaultChildRun, repost?: (work: Work, carried: CarriedApproval) => Promise<CarriedApprovalRepost>): Promise<MergeOutcome> {
  const before = await freshSnapshot(); const current = before.work.find(item => item.id === work.id);
  // The attempt is bound to what it merges, not to the revision it was read at (GY-192).
  if (!current || mergeBinding(current) !== mergeBinding(work)) throw new Error(`${work.key} changed before GitHub verification; retry`);
  if (current.observation?.merged && current.candidate) return { key: current.key, pr: current.candidate.pr, sha: current.candidate.sha, merged: true, ...(current.observation.mergeSha ? { mergeSha: current.observation.mergeSha } : {}),
    result: 'GitHub shows the pull request merged; Graphyard records the delivery from that observation' };
  const authorization = assertMergeCandidate(current, before.now);
  // The pull request answers for its own head, base branch name and state; the base tip is read
  // from the ref itself inside assertQueuedLanding, because `baseRefOid` is a cached value.
  const pr = JSON.parse(await run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefName,state,isDraft']));
  if (pr.headRefOid !== authorization.sha || pr.baseRefName !== config.baseBranch || pr.state !== 'OPEN' || pr.isDraft) throw new Error(`${work.key} changed on GitHub before merge`);
  // An entry on its optimistic lane (GY-500) lands its own head past the queue: the base must still
  // stand where its disjointness was judged, and its own base is an ancestor of that tip, so the
  // merge base GitHub computes is the one it was approved on.
  const optimistic = onOptimisticLane(current, authorization);
  if (optimistic) {
    const refusal = optimisticLandingRefusal(current, await readBaseTip(config.repository, config.baseBranch, run));
    if (refusal) throw new Error(`${work.key} merge refused: ${refusal}`);
  } else await assertQueuedLanding(current, authorization, config.baseBranch, config.repository, run);
  // A head without the base tip in its history is refused before any approval is re-posted: GitHub
  // would dismiss it again as a merge-base change (GY-145). An optimistic head keeps its own merge base.
  if (!optimistic) {
    const unancestored = missingBaseAncestry(current);
    if (unancestored) throw new Error(`${work.key} merge refused: ${missingAncestryReason(unancestored)}`);
  }
  // An approval the control plane carried onto its authored tip is re-posted through the reviewer
  // App first, so a native review requirement GitHub re-armed on the tip does not hold the queue.
  const carried = carriedApproval(current);
  const reposted = carried && repost ? await repost(current, carried) : null;
  const after = await freshSnapshot(); const latest = after.work.find(item => item.id === work.id);
  if (!latest || mergeBinding(latest) !== mergeBinding(current)) throw new Error(`${work.key} changed after GitHub verification; retry`);
  let latestAuthorization: ReturnType<typeof assertMergeCandidate>;
  try { latestAuthorization = assertMergeCandidate(latest, after.now); }
  catch (error) { throw new Error(`${work.key} changed after GitHub verification and no longer qualifies: ${error instanceof Error ? error.message : String(error)}`); }
  const requested = await enqueue(latest, latestAuthorization);
  if (requested.enqueue?.sha !== authorization.sha) throw new Error(`${work.key} merge request was not recorded for ${authorization.sha.slice(0, 12)}`);
  return { key: authorization.key, pr: authorization.pr, sha: authorization.sha, pending: true, enqueued: true,
    result: `merge requested for ${authorization.sha.slice(0, 12)}: the control plane publishes ${CHECK_NAME} on it and enqueues pull request #${authorization.pr} in GitHub's merge queue; GitHub performs the merge and Graphyard marks Done only after observing it`,
    ...(reposted ? { carriedApproval: reposted } : {}) };
}

/**
 * One merge step, with the idempotency key that makes an interrupted request safe to repeat. The
 * interactive command and the durable loop share it so neither can drift into a different path.
 */
export function mergeExecutor(config: MasterConfig, snapshot: () => Promise<{ work: Work[]; now: string }>, mutation: (path: string, data: unknown, requestId?: string) => Promise<any>, executor: MergeExecutor, outerRequest: string, run?: ChildRun) {
  const stepKey = (item: Work, step: string) => createHash('sha256').update(`${outerRequest}\0master-merge\0${item.id}\0${item.candidate?.sha ?? ''}\0${step}`).digest('hex');
  return (item: Work) => mergeWork(config, item, snapshot,
    (latest, authorization) => mutation(`work/${latest.id}/merge-acquire`, { enqueue: true, expectedRevision: authorization.revision, sha: authorization.sha, baseSha: authorization.baseSha, policyRevision: authorization.policyRevision, ...(latest.queue?.speculation?.tip ? { queueTip: latest.queue.speculation.tip } : {}), executor: executor.instance }, stepKey(latest, 'enqueue')),
    run, (latest, carried) => repostCarriedApproval(config, latest, carried, { run: run ?? defaultChildRun }));
}
