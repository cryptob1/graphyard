// Concern: the guarded merge — candidate checks, protection, queued landing and the merge executor.
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { mergeOrder } from '../delegation.js';
import { type Work, standingEscalations, evidenceIndependenceRefusals, nativeReviewRequired, CHECK_NAME, type CarriedApproval, providerDelayAfterVerification, carriedApproval } from '../model.js';
import { unresolvedThreadRefusal } from '../merge-queue.js';
import { missingBaseAncestry, missingAncestryReason } from '../merge-base-ancestry.js';
import type { MasterConfig } from './profiles.js';
import { privateFile } from './config.js';

/**
 * One merge executor instance: the coordinator principal and the instance minted for one daemon
 * process or one interactive `master merge` request (its request id, so a replay under
 * `GRAPHYARD_REQUEST_ID` is the same instance). The engine records the execution owner as
 * `principal#instance` (Engine.acquireMerge), so two executors under one credential never read
 * each other's execution as their own: the executor presents the same owner to
 * assertMergeCandidate and the same instance to every merge step.
 */
export interface MergeExecutor { principal: string; instance: string }
export const mergeExecutionOwner = (executor: MergeExecutor) => `${executor.principal}#${executor.instance}`;
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
export function assertMergeCandidate(work: Work, observedAt?: string, executionOwner?: string) {
  const age = observedAt && work.observation ? Date.parse(observedAt) - Date.parse(work.observation.at) : 0;
  const fresh = !observedAt || !!work.observation && Number.isFinite(age) && age >= 0 && age < 120_000;
  const activeMerge = !!observedAt && !!work.mergeExecution && Date.parse(work.mergeExecution.expiresAt) > Date.parse(observedAt);
  // Only the executor instance that acquired an execution resumes it. Another instance — the
  // daemon beside an interactive merge, or a second daemon — is not a candidate for this item
  // while it stands, and stands down here, before any authority is acquired or cancelled.
  const resumable = activeMerge && !!executionOwner && work.mergeExecution!.owner === executionOwner && !work.mergeExecution!.fenced
    && work.mergeExecution!.sha === work.candidate?.sha && work.mergeExecution!.baseSha === work.candidate?.baseSha
    && work.mergeExecution!.policyRevision === work.policyRevision;
  if (activeMerge && !resumable) throw new Error(`${work.key} does not have a current all-gates-passing merge authorization for this executor: merge execution ${work.mergeExecution!.id} is held by ${work.mergeExecution!.owner} until ${work.mergeExecution!.expiresAt}; this executor stands down without cancelling it`);
  // Unresolved review threads on a branch that requires conversation resolution are a merge
  // GitHub will refuse (GY-139): refused here, naming them, before any execution is issued.
  const threads = activeMerge ? null : unresolvedThreadRefusal(work);
  if (threads) throw new Error(`${work.key} was refused before any merge execution was issued: ${threads}`);
  // An unresolved escalation, a standing blocking lead ruling, and trusted
  // evidence whose producer has since implemented the item each refuse delivery
  // in the broker as well as in the gate, so a stale snapshot can never present
  // such an item as selectable.
  if (!fresh || standingEscalations(work).length || work.leadHold || evidenceIndependenceRefusals(work).length || work.stage !== 'merge' || !work.candidate || !work.mergeAuthorization || work.mergeAuthorization.sha !== work.candidate.sha || work.mergeAuthorization.baseSha !== work.candidate.baseSha || work.mergeAuthorization.policyRevision !== work.policyRevision || work.gates.some(gate => !gate.passed) || work.violations.length) throw new Error(`${work.key} does not have a current all-gates-passing merge authorization`);
  return { key: work.key, revision: work.revision, pr: work.candidate.pr, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision };
}
// Merge order is recomputed from current dependencies and conflicts on every
// batch; registration order carries no authority.
export function currentMergeCandidates(work: Work[], observedAt: string, executionOwner?: string) {
  const observed = Date.parse(observedAt);
  const order = mergeOrder(work, Number.isFinite(observed) ? observed : Date.now());
  const rank = (item: Work) => order.indexOf(item.key) + 1 || Number.MAX_SAFE_INTEGER;
  return work.filter(item => {
    try { assertMergeCandidate(item, observedAt, executionOwner); return true; }
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
type MergeExecution = { id: string; owner: string; sha: string; baseSha: string; policyRevision: number; authorizationRevision: number; issuedAt: string; expiresAt: string; verifiedAt?: string; committingAt?: string; clockOffset?: { min: number; max: number }; fenced?: { reason: string; at: string } | null };
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
export function githubProviderDelay(verifiedTime: number, serverDelayMs: number, response: string, providerToDatabaseOffsetMin = 0) {
  const header = /^Date:\s*(.+?)\r?$/gmi.exec(response);
  const githubTime = header ? Date.parse(header[1]) : Number.NaN;
  if (!Number.isFinite(verifiedTime) || !Number.isInteger(serverDelayMs) || serverDelayMs < 0 || !Number.isFinite(githubTime) || !Number.isFinite(providerToDatabaseOffsetMin)) throw new Error('GitHub did not provide a valid server time for merge ordering');
  // GitHub's Date and merged_at values have whole-second precision. Waiting from
  // the lower bound of GitHub's reported second remains conservative when the
  // database clock is ahead of GitHub's clock.
  // Delivery compares the lower bound of GitHub's whole-second merged_at interval,
  // translated into the database clock domain by offset.min.  Therefore the provider
  // clock must cross (database time - offset.min), not merely database time.
  const verifiedBoundary = Math.ceil((verifiedTime - providerToDatabaseOffsetMin + 1) / 1000) * 1000;
  return Math.max(serverDelayMs, verifiedBoundary - githubTime, 0);
}
/**
 * The engine's answer when a merge step was already taken on the execution: `already verified`
 * (merge-verify) and `already committed` (merge-commit), each a confirmed refusal that tells
 * the caller to retry with the original idempotency key. From any executor but the one holding
 * that key, it means the execution is being driven by someone else.
 */
export function stepAlreadyPerformed(error: unknown) {
  return !!(error as { confirmedRefusal?: boolean } | null)?.confirmedRefusal && /Merge execution was already (verified|committed)/.test(error instanceof Error ? error.message : String(error));
}
function recordedVerification(execution: MergeExecution) {
  const verifiedAt = Date.parse(execution.verifiedAt ?? '');
  if (!Number.isFinite(verifiedAt) || !execution.clockOffset) throw Object.assign(new Error('Resumed merge execution carries an incomplete verification record'), { confirmedRefusal: true });
  return { executionId: execution.id, sha: execution.sha, verifiedAt: execution.verifiedAt!, providerDelayMs: providerDelayAfterVerification(verifiedAt, execution.clockOffset), clockOffset: execution.clockOffset };
}
/** The engine's execution bound from its observation (engine.ts acquireMerge). */
const mergeExecutionWindowMs = 120_000;
/** The provider reserve (~92 s) plus the verify, protection and commit round trips before it. */
export const mergeWindowFloorMs = 108_000;
/** An observation older than this is re-read before a merge attempt acquires authority. */
export const mergeObservationFreshMs = 8_000;
const mergeObservationWaitSteps = 20;
const commitMarginMs = 5_000;
const observationAgeMs = (item: Work, now: string) => Date.parse(now) - Date.parse(item.observation?.at ?? '');
/** A gh failure that carries a GitHub 4xx status: GitHub answered and did not merge. */
export function definiteProviderRefusal(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\(HTTP (4\d\d)\)/.exec(message)?.[1];
  if (!status) return null;
  const line = message.split('\n').find(entry => entry.includes(`(HTTP ${status})`)) ?? '';
  return `${line.replace(/^gh:\s*/, '').trim() || `HTTP ${status}`}`.slice(0, 500);
}
/**
 * The latest `Graphyard / merge` run on the head must have succeeded before the provider is asked.
 * Only runs published by the control plane's own GitHub App count: branch protection binds the
 * required check to that App, so a same-named run from another App or workflow neither satisfies
 * nor defers the merge.
 */
export function assertMergeCheckPublished(payload: any, key: string, sha: string, appId: number) {
  // Read with `--paginate --slurp`, the answer is the list of pages; GitHub filters check runs by
  // name but not by App, so every page is read before the App's own runs are picked out.
  const pages = Array.isArray(payload) ? payload : [payload];
  if (!pages.length || pages.some(page => !Array.isArray(page?.check_runs))) throw new Error(`${key} merge deferred: GitHub's check runs on ${sha.slice(0, 12)} could not be read; retry`);
  const runs = pages.flatMap(page => page.check_runs).filter((entry: any) => entry?.name === CHECK_NAME && entry?.app?.id === appId)
    .sort((a: any, b: any) => Date.parse(b?.started_at ?? b?.completed_at ?? '') - Date.parse(a?.started_at ?? a?.completed_at ?? ''));
  const latest = runs[0];
  if (latest?.status !== 'completed' || latest?.conclusion !== 'success')
    throw new Error(`${key} merge deferred: GitHub does not yet show ${CHECK_NAME} as passed on ${sha.slice(0, 12)} (${latest ? `${latest.status}${latest.conclusion ? `/${latest.conclusion}` : ''}` : 'not published'}); retry once it is`);
}
export async function mergeWork(config: MasterConfig, work: Work, freshSnapshot: () => Promise<{ work: Work[]; now: string }>, acquire: (work: Work, authorization: ReturnType<typeof assertMergeCandidate>) => Promise<{ execution: MergeExecution }>, cancel: (work: Work, execution: MergeExecution, reason: string) => Promise<unknown>, verify: (work: Work, execution: MergeExecution) => Promise<{ executionId: string; sha: string; verifiedAt: string; providerDelayMs: number; clockOffset?: { min: number; max: number } }>, run: ChildRun = defaultChildRun, executionOwner?: string, commit?: (work: Work, execution: MergeExecution) => Promise<{ executionId: string; sha: string; committingAt: string }>, repost?: (work: Work, carried: CarriedApproval) => Promise<CarriedApprovalRepost>, refresh?: (work: Work) => Promise<unknown>) {
  let before = await freshSnapshot(); let current = before.work.find(item => item.id === work.id);
  if (!current || current.revision !== work.revision) throw new Error(`${work.key} changed before GitHub verification; retry`);
  // The engine bounds a merge execution by the GitHub observation it was granted on (two minutes
  // from observation.at), and the provider call needs about 92 s of it. An attempt that starts
  // on an observation already ~20 s old runs out of window after committing (GY-159, 2026-09-24),
  // so a fresh reading is asked for first and the attempt continues on it.
  if (refresh && !current.mergeExecution && observationAgeMs(current, before.now) > mergeObservationFreshMs) {
    const seen = current.observation?.at;
    await refresh(current);
    for (let step = 0; step < mergeObservationWaitSteps; step++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      before = await freshSnapshot(); current = before.work.find(item => item.id === work.id);
      if (!current || current.observation?.at !== seen) break;
    }
    if (!current || current.candidate?.sha !== work.candidate?.sha) throw new Error(`${work.key} changed while GitHub was re-read before merging; retry`);
  }
  const authorization = assertMergeCandidate(current, before.now, executionOwner);
  // Only a recorded provider commit marks an unknown provider outcome: the broker may already
  // have called GitHub, so nothing is retried until observation reconciles the execution. A
  // verified execution that never reached the commit resumes below; the provider was not attempted.
  if (current.mergeExecution?.committingAt) return { key: authorization.key, pr: authorization.pr, sha: authorization.sha, method: config.mergeMethod, result: 'the provider commit was already recorded; Graphyard retained the execution until GitHub reconciles the provider outcome and refuses a new attempt until then' };
  // The pull request answers for its own head, base branch name and state; the base tip is read
  // from the ref itself inside assertQueuedLanding, because `baseRefOid` is a cached value.
  const pr = JSON.parse(await run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefName,state,isDraft']));
  if (pr.headRefOid !== authorization.sha || pr.baseRefName !== config.baseBranch || pr.state !== 'OPEN' || pr.isDraft) throw new Error(`${work.key} changed on GitHub before merge`);
  await assertQueuedLanding(current, authorization, config.baseBranch, config.repository, run);
  // A head without the base tip in its history is refused before any approval is re-posted: GitHub
  // would dismiss it again as a merge-base change on this very attempt (GY-145).
  const unancestored = missingBaseAncestry(current);
  if (unancestored) throw new Error(`${work.key} merge refused: ${missingAncestryReason(unancestored)}`);
  // An approval the control plane carried onto its authored tip is re-posted through the
  // reviewer App before any authority is acquired, so a native review requirement that GitHub
  // re-armed on the tip publication is met by the same identity that gave the approval.
  const carried = carriedApproval(current);
  const reposted = carried && repost ? await repost(current, carried) : null;
  const authorityBudgetStartedAt = performance.now();
  const after = await freshSnapshot(); const latest = after.work.find(item => item.id === work.id);
  if (!latest || latest.revision !== authorization.revision) throw new Error(`${work.key} changed after GitHub verification; retry`);
  const latestAuthorization = assertMergeCandidate(latest, after.now, executionOwner);
  const resumed = latest.mergeExecution && Date.parse(latest.mergeExecution.expiresAt) > Date.parse(after.now) && latest.mergeExecution.owner === executionOwner;
  // No execution is acquired that cannot cover the provider call: it would only expire, or be
  // retained as an unknown outcome, and block the next attempt until it lapses.
  if (!resumed) {
    const window = Math.min(Date.parse(latest.observation?.at ?? '') + mergeExecutionWindowMs, Date.parse(after.now) + mergeExecutionWindowMs) - Date.parse(after.now);
    if (!(window >= mergeWindowFloorMs)) throw new Error(`${work.key} merge deferred: the GitHub observation leaves ${Number.isFinite(window) ? Math.round(window / 1000) : 0} s of merge window, under the ${mergeWindowFloorMs / 1000} s a provider call needs; retry on a fresh observation`);
  }
  const granted = resumed ? { execution: latest.mergeExecution } : await acquire(latest, latestAuthorization);
  if (!granted.execution || granted.execution.sha !== authorization.sha || granted.execution.baseSha !== authorization.baseSha || granted.execution.policyRevision !== authorization.policyRevision || !resumed && granted.execution.authorizationRevision !== authorization.revision) throw new Error(`${work.key} received an invalid merge execution authority`);
  const remainingAtSnapshot = Date.parse(granted.execution.expiresAt) - Date.parse(after.now);
  let providerStarted = false; let cancelled = false;
  let verificationStarted = false; let verificationCompleted = false;
  try {
    const lockedPr = JSON.parse(await run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefName,state,isDraft']));
    if (lockedPr.headRefOid !== authorization.sha || lockedPr.baseRefName !== config.baseBranch || lockedPr.state !== 'OPEN' || lockedPr.isDraft) throw new Error(`${work.key} changed on GitHub after merge authority was acquired`);
    await assertQueuedLanding(latest, authorization, config.baseBranch, config.repository, run);
    const remaining = remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt);
    if (!Number.isFinite(remaining) || remaining <= 90_000) throw new Error(`${work.key} merge execution does not remain valid for the provider timeout; refresh gate inputs and retry`);
    const protection = JSON.parse(await run('gh', ['api', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`]));
    assertMergeProtection(protection, config, latest);
    // A broker that stopped between merge-verify and merge-commit resumes here holding a verified
    // execution. The verification is a durable fact of that execution — the record carries its
    // verifiedAt and bounded clock offset — so the resumed attempt rebuilds it rather than asking
    // the engine to verify again, which it refuses, and then runs the same clock wait, pre-commit
    // revalidation, transactional commit and pre-provider checks as a first attempt.
    verificationStarted = true; const verified = granted.execution.verifiedAt ? recordedVerification(granted.execution) : await verify(latest, granted.execution); verificationCompleted = true;
    const verifiedTime = Date.parse(verified.verifiedAt);
    if (verified.executionId !== granted.execution.id || verified.sha !== authorization.sha || !Number.isFinite(verifiedTime) || !Number.isInteger(verified.providerDelayMs) || verified.providerDelayMs < 0 || verified.providerDelayMs > 21_000
      || !verified.clockOffset || !Number.isFinite(verified.clockOffset.min) || !Number.isFinite(verified.clockOffset.max) || verified.clockOffset.min > verified.clockOffset.max || verified.clockOffset.max - verified.clockOffset.min > 20_000) throw new Error(`${work.key} received an invalid final GitHub gate verification`);
    // Delivery attribution accepts a merge only when GitHub's whole-second merged_at interval,
    // translated into the database clock by the verified offset bound, ends before the execution
    // expires. The remaining authority must therefore cover the provider timeout plus that
    // timestamp interval and the accepted offset width, or a slow but successful provider merge
    // just inside the deadline would be permanently classified as unauthorized.
    const providerReserve = 90_000 + 1000 + (verified.clockOffset.max - verified.clockOffset.min);
    const githubClock = await run('gh', ['api', '--include', 'rate_limit']);
    const delay = githubProviderDelay(verifiedTime, verified.providerDelayMs, githubClock);
    if (delay > 21_000 || remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt) - delay <= providerReserve) throw new Error('Clock uncertainty leaves insufficient merge authority; refresh and retry');
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const remainingAfterProtection = remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt);
    // The margin covers the commit round trip and the post-commit clock wait, so a window that is
    // already too short is refused here, before commit, where the execution is released.
    if (!Number.isFinite(remainingAfterProtection) || remainingAfterProtection <= providerReserve + commitMarginMs) throw new Error(`${work.key} merge execution no longer has enough time for the provider call after verifying branch protection; retry`);
    // Verification and the provider call are separated by the clock-ordering
    // delay, and a lead escalation or blocking ruling can land inside it. The
    // last thing Graphyard reads before handing the merge to GitHub is the
    // record itself: the execution must still stand unfenced, and every gate
    // must still pass. Pinned inputs are not re-aged here, so this adds a
    // refusal for concerns raised mid-flight without adding a freshness race.
    const settled = await freshSnapshot(); const final = settled.work.find(item => item.id === work.id);
    const execution = final?.mergeExecution;
    if (!final || !execution || execution.id !== granted.execution.id || execution.fenced || Date.parse(execution.expiresAt) <= Date.parse(settled.now))
      throw new Error(`${work.key} merge execution was fenced, cancelled, or expired after final verification: ${execution?.fenced?.reason ?? 'execution is no longer current'}`);
    const refusals = [...standingEscalations(final).map(entry => `Unresolved ${entry.trigger} escalation: ${entry.reason}`),
      ...(final.leadHold ? [`Slice lead ${final.leadHold.leadId} ruled ${final.leadHold.action} under rule ${final.leadHold.ruleId}`] : []),
      ...final.gates.filter(gate => !gate.passed).flatMap(gate => gate.reasons), ...final.violations];
    if (refusals.length || !final.mergeAuthorization || final.mergeAuthorization.sha !== authorization.sha
      || final.mergeAuthorization.baseSha !== authorization.baseSha || final.mergeAuthorization.policyRevision !== authorization.policyRevision
      || final.candidate?.sha !== authorization.sha || final.candidate.baseSha !== authorization.baseSha)
      throw new Error(`${work.key} no longer passes every gate after final verification: ${refusals.join('; ') || 'merge authorization was invalidated'}`);
    // GitHub refuses the merge while the published `Graphyard / merge` check lags the gates it
    // reports (HTTP 405, GY-159 2026-09-24). Read it before committing, while a refusal still
    // releases the execution.
    assertMergeCheckPublished(JSON.parse(await run('gh', ['api', `repos/${config.repository}/commits/${authorization.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`, '--paginate', '--slurp'])), work.key, authorization.sha, config.githubAppId);
    if (!commit) throw new Error(`${work.key} merge broker commit callback is unavailable`);
    const committed = await commit(latest, granted.execution);
    const committingTime = Date.parse(committed.committingAt);
    if (committed.executionId !== granted.execution.id || committed.sha !== authorization.sha || !Number.isFinite(committingTime)) throw new Error(`${work.key} received an invalid provider commit authority`);
    // From this transactional boundary onward revocation refuses: the broker has won
    // serialization and must treat any provider error as an unknown merge outcome.
    providerStarted = true;
    // GitHub reports merged_at only to whole-second precision. Cross a provider-clock
    // boundary after the transactional commit so a fast successful merge cannot appear
    // to predate the authority that serialized it against revocation.
    const commitClock = await run('gh', ['api', '--include', 'rate_limit']);
    const commitDelay = githubProviderDelay(committingTime, 0, commitClock, verified.clockOffset.min);
    if (commitDelay > 21_000 || remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt) - commitDelay <= providerReserve) throw new Error('Clock uncertainty leaves insufficient committed merge authority; wait for observation or expiry');
    if (commitDelay) await new Promise(resolve => setTimeout(resolve, commitDelay));
    // A suspended broker can resume after its execution expired: reconciliation then
    // clears the execution, the revocation window reopens, and this stale SHA could
    // merge before the asynchronously published GitHub check changes. Revalidate the
    // committed authority and its remaining lifetime immediately before the provider
    // mutation; the mutation is refused on any missing, fenced or expired authority. The base
    // branch is re-read from its ref for the same reason: a base that advanced outside the
    // queue during the wait would land a different tree than the one the tip was tested on.
    await assertQueuedLanding(latest, authorization, config.baseBranch, config.repository, run);
    const preProvider = await freshSnapshot();
    const finalExecution = preProvider.work.find(item => item.id === work.id)?.mergeExecution;
    const remainingBeforeProvider = remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt);
    if (!finalExecution || finalExecution.id !== granted.execution.id || !finalExecution.committingAt || finalExecution.fenced
      || finalExecution.sha !== authorization.sha || Date.parse(finalExecution.expiresAt) <= Date.parse(preProvider.now)
      || !Number.isFinite(remainingBeforeProvider) || remainingBeforeProvider <= providerReserve)
      throw new Error(`${work.key} merge execution expired, was fenced or was superseded during the provider clock wait; the provider merge is refused${finalExecution?.fenced ? `: ${finalExecution.fenced.reason}` : ''}`);
    let answer: string;
    try { answer = await run('gh', ['api', '--method', 'PUT', `repos/${config.repository}/pulls/${authorization.pr}/merge`, '-f', `sha=${authorization.sha}`, '-f', `merge_method=${config.mergeMethod}`]); }
    catch (error) {
      // A 4xx answer is GitHub refusing the merge, not an unknown outcome: the execution is
      // released so the next attempt is not held until it lapses.
      const refusal = definiteProviderRefusal(error);
      if (refusal) { await cancel(latest, granted.execution, refusal); cancelled = true; throw new Error(`GitHub refused the merge of ${work.key}: ${refusal}`); }
      throw error;
    }
    const provider = JSON.parse(answer);
    if (provider.merged !== true || typeof provider.sha !== 'string') {
      await cancel(latest, granted.execution, provider.message || 'GitHub confirmed that it did not merge the candidate'); cancelled = true;
      throw new Error(provider.message || 'GitHub did not merge the candidate');
    }
  }
  catch (error) {
    // A confirmed refusal that says the step was already performed on this execution means
    // another executor — or an earlier attempt of this one, read from a stale snapshot — is
    // ahead of this attempt. The execution is theirs to finish: this executor stands down and
    // leaves it intact for its owner or for observation to reconcile. It never cancels an
    // execution it did not just acquire, whatever the refusal (GY-92).
    if (stepAlreadyPerformed(error)) throw new Error(`${work.key}: ${error instanceof Error ? error.message : 'merge step refused'}; another executor already performed that step on merge execution ${granted.execution.id}, so this executor stands down and leaves the execution intact`);
    if (!providerStarted && verificationStarted && !verificationCompleted && !(error as any)?.confirmedRefusal) throw new Error(`${error instanceof Error ? error.message : 'Final GitHub verification failed'}; the verification outcome is unknown, so Graphyard retained execution ${granted.execution.id} for an idempotent retry`);
    if (!providerStarted) try { await cancel(latest, granted.execution, error instanceof Error ? error.message : 'GitHub merge failed before provider invocation'); }
    catch { throw new Error(`${work.key} GitHub merge failed before provider invocation and Graphyard could not cancel execution ${granted.execution.id}`); }
    if (providerStarted && !cancelled) throw new Error(`${error instanceof Error ? error.message : 'GitHub merge call failed'}; the merge outcome is unknown, so Graphyard retained execution ${granted.execution.id} until observation or expiry`);
    throw error;
  }
  return { key: authorization.key, pr: authorization.pr, sha: authorization.sha, method: config.mergeMethod, result: 'merge requested; Graphyard will mark Done only after observing the merge', ...(reposted ? { carriedApproval: reposted } : {}) };
}

/**
 * One guarded merge attempt, with the idempotency keys that make an interrupted attempt safe to
 * repeat. The interactive command and the durable loop share it so neither can drift into a
 * different merge path.
 */
export function mergeExecutor(config: MasterConfig, snapshot: () => Promise<{ work: Work[]; now: string }>, mutation: (path: string, data: unknown, requestId?: string) => Promise<any>, executor: MergeExecutor, outerRequest: string, run?: ChildRun) {
  const stepKey = (item: Work, step: string, executionId = '') => createHash('sha256').update(`${outerRequest}\0master-merge\0${item.id}\0${item.candidate?.sha ?? ''}\0${step}\0${executionId}`).digest('hex');
  // Every step names the executor instance; the engine binds it to the principal and refuses a
  // step — cancel above all — from any other instance, so the owner the broker resumes on is
  // exactly the one the engine recorded.
  const instance = executor.instance;
  return (item: Work) => mergeWork(config, item, snapshot,
    (latest, authorization) => mutation(`work/${latest.id}/merge-acquire`, { expectedRevision: authorization.revision, sha: authorization.sha, baseSha: authorization.baseSha, policyRevision: authorization.policyRevision, executor: instance }, stepKey(latest, 'acquire')),
    (latest, execution, reason) => mutation(`work/${latest.id}/merge-cancel`, { executionId: execution.id, reason, executor: instance }, stepKey(latest, 'cancel', execution.id)),
    (latest, execution) => mutation(`work/${latest.id}/merge-verify`, { executionId: execution.id, executor: instance }, stepKey(latest, 'verify', execution.id)), run, mergeExecutionOwner(executor),
    (latest, execution) => mutation(`work/${latest.id}/merge-commit`, { executionId: execution.id, executor: instance }, stepKey(latest, 'commit', execution.id)),
    (latest, carried) => repostCarriedApproval(config, latest, carried, { run: run ?? defaultChildRun }),
    latest => mutation(`work/${latest.id}/resync`, {}, stepKey(latest, `refresh:${latest.observation?.at ?? ''}`)));
}
