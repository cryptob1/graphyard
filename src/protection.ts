import { execFileSync } from 'node:child_process';
import { CHECK_NAME, nativeReviewRequired, reviewProviderOf, reviewProviders, type ReviewProvider, type Work } from './model.js';

export interface ReviewProtection { mode: 'native' | 'agent'; requiredApprovals: number; requireLastPushApproval: boolean; dismissStaleReviews: boolean }
export type ProtectionRun = (command: string, args: string[], input?: string) => string;
const protectionRun: ProtectionRun = (command, args, input) => execFileSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });

// One branch cannot satisfy both review policies at once, so a mixed set of open items refuses
// instead of silently leaving one of them unenforceable. The split is the model's own
// nativeReviewRequired: only `github` needs GitHub's approval count; `codex` and `agent` both
// need it at zero so Graphyard's identity-bound gate decides.
export function requiredReviewProtection(work: Work[]) {
  const open = work.filter(item => item.stage !== 'done' && item.policy.review);
  const items = Object.fromEntries(reviewProviders.map(provider => [provider, open.filter(item => reviewProviderOf(item.policy) === provider).map(item => item.key).sort()])) as Record<ReviewProvider, string[]>;
  const native = open.filter(item => nativeReviewRequired(item.policy)).map(item => item.key).sort();
  const gated = open.filter(item => !nativeReviewRequired(item.policy)).map(item => `${item.key} (${reviewProviderOf(item.policy)})`).sort();
  if (native.length && gated.length) throw new Error(`Branch protection cannot match both open review policies: ${native.join(', ')} require a native GitHub approval and ${gated.join(', ')} require the native approval count to be zero. Move the open items onto one review provider, then reconcile protection.`);
  const protection: ReviewProtection = gated.length
    ? { mode: 'agent', requiredApprovals: 0, requireLastPushApproval: false, dismissStaleReviews: true }
    : { mode: 'native', requiredApprovals: 1, requireLastPushApproval: true, dismissStaleReviews: true };
  return { protection, items };
}

export function protectionPlan(current: any, config: { repository: string; baseBranch: string; githubAppId: number }, work: Work[]) {
  const { protection, items } = requiredReviewProtection(work);
  const reviews = current?.required_pull_request_reviews, checks = current?.required_status_checks;
  const observed = { requiredApprovals: Number(reviews?.required_approving_review_count ?? 0), requireLastPushApproval: reviews?.require_last_push_approval === true, dismissStaleReviews: reviews?.dismiss_stale_reviews === true };
  const blockers = [
    // The merge queue lands published speculative tips that are deliberately behind the base branch,
    // so GitHub's "require branches to be up to date" setting must stay off (see assertMergeProtection).
    ...(checks?.strict === false ? [] : ['Require branches to be up to date before merging is enabled; the merge queue requires it off']),
    ...(Array.isArray(checks?.checks) && checks.checks.some((check: any) => check?.context === CHECK_NAME && check?.app_id === config.githubAppId) ? [] : [`Required check ${CHECK_NAME} is not bound to Graphyard App ${config.githubAppId}`]),
    ...(current?.enforce_admins?.enabled === true ? [] : ['Administrator enforcement is disabled']),
    ...(current?.allow_force_pushes?.enabled === true ? ['Force pushes are allowed on the managed base branch'] : []),
    ...(current?.allow_deletions?.enabled === true ? ['Deletion of the managed base branch is allowed'] : []),
    ...(reviews?.require_code_owner_reviews ? ['Required CODEOWNERS approval is not represented by any Graphyard review policy; define an explicit ownership-review policy before reconciling'] : []),
  ];
  // The review gate is the configured reviewer's verdict on the exact head plus required CI:
  // unresolved review threads are that reviewer's inputs, never a merge blocker, so the desired
  // protection does not require conversation resolution. A branch that still does lets GitHub
  // refuse a merge every Graphyard gate passed, over a bot's thread the reviewer already judged.
  const conversationResolution = current?.required_conversation_resolution?.enabled === true;
  const changes = [
    ...(conversationResolution ? ['required_conversation_resolution true to false'] : []),
    ...(observed.requiredApprovals === protection.requiredApprovals ? [] : [`required_approving_review_count ${observed.requiredApprovals} to ${protection.requiredApprovals}`]),
    ...(observed.requireLastPushApproval === protection.requireLastPushApproval ? [] : [`require_last_push_approval ${observed.requireLastPushApproval} to ${protection.requireLastPushApproval}`]),
    ...(observed.dismissStaleReviews === protection.dismissStaleReviews ? [] : [`dismiss_stale_reviews ${observed.dismissStaleReviews} to ${protection.dismissStaleReviews}`]),
  ];
  return { repository: config.repository, branch: config.baseBranch, mode: protection.mode, items, current: { ...observed, requireConversationResolution: conversationResolution }, desired: { ...protection, requireConversationResolution: false }, changes, blockers,
    consistent: !changes.length && !blockers.length,
    refusal: blockers.length ? `Branch protection is missing settings Graphyard cannot reconcile for you: ${blockers.join('; ')}` : null };
}

export function readProtection(config: { repository: string; baseBranch: string }, run: ProtectionRun = protectionRun) {
  return JSON.parse(run('gh', ['api', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`]));
}

const logins = (list: any[] | undefined, field: 'login' | 'slug') => (list ?? []).map((entry: any) => entry[field]);
/**
 * The whole protection a PUT writes when conversation resolution has to be switched off — GitHub
 * has no subresource for that one setting — with every other observed setting kept as it is and
 * the review settings as desired.
 */
export function conversationPayload(current: any, desired: ReviewProtection) {
  const reviews = current?.required_pull_request_reviews, dismissal = reviews?.dismissal_restrictions, bypass = reviews?.bypass_pull_request_allowances, restrictions = current?.restrictions;
  return {
    required_status_checks: { strict: current?.required_status_checks?.strict === true, checks: (current?.required_status_checks?.checks ?? []).map((check: any) => ({ context: String(check.context), app_id: check.app_id ?? null })) },
    enforce_admins: current?.enforce_admins?.enabled === true,
    required_pull_request_reviews: { required_approving_review_count: desired.requiredApprovals, dismiss_stale_reviews: desired.dismissStaleReviews, require_code_owner_reviews: reviews?.require_code_owner_reviews === true, require_last_push_approval: desired.requireLastPushApproval,
      ...(dismissal ? { dismissal_restrictions: { users: logins(dismissal.users, 'login'), teams: logins(dismissal.teams, 'slug'), apps: logins(dismissal.apps, 'slug') } } : {}),
      // A PUT that omits the bypass list clears it; whoever may bypass the review requirement now still may.
      ...(bypass ? { bypass_pull_request_allowances: { users: logins(bypass.users, 'login'), teams: logins(bypass.teams, 'slug'), apps: logins(bypass.apps, 'slug') } } : {}) },
    restrictions: restrictions ? { users: logins(restrictions.users, 'login'), teams: logins(restrictions.teams, 'slug'), apps: logins(restrictions.apps, 'slug') } : null,
    required_conversation_resolution: false,
    required_linear_history: current?.required_linear_history?.enabled === true,
    allow_force_pushes: current?.allow_force_pushes?.enabled === true,
    allow_deletions: current?.allow_deletions?.enabled === true,
    block_creations: current?.block_creations?.enabled === true,
    lock_branch: current?.lock_branch?.enabled === true,
    allow_fork_syncing: current?.allow_fork_syncing?.enabled === true,
  };
}

export async function applyProtection(config: { repository: string; baseBranch: string; githubAppId: number }, work: Work[], run: ProtectionRun = protectionRun) {
  const current = readProtection(config, run);
  const plan = protectionPlan(current, config, work);
  if (plan.blockers.length) throw new Error(plan.refusal!);
  if (!plan.changes.length) return { ...plan, applied: false, result: 'branch protection already matches every open review policy' };
  if (plan.current.requireConversationResolution) {
    // Conversation resolution has no subresource: the whole protection is written back as observed,
    // with the review settings as desired and conversation resolution off.
    run('gh', ['api', '--method', 'PUT', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`, '--input', '-'], JSON.stringify(conversationPayload(current, plan.desired)));
  } else {
    // Only the review subresource changes; the App-bound check, the strict-off setting, and admin enforcement stay as observed.
    run('gh', ['api', '--method', 'PATCH', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection/required_pull_request_reviews`, '--input', '-'],
      JSON.stringify({ required_approving_review_count: plan.desired.requiredApprovals, require_last_push_approval: plan.desired.requireLastPushApproval, dismiss_stale_reviews: plan.desired.dismissStaleReviews }));
  }
  const verified = protectionPlan(readProtection(config, run), config, work);
  if (!verified.consistent) throw new Error(`GitHub did not report the reconciled protection; branch protection remains inconsistent with the open review policies: ${[...verified.changes, ...verified.blockers].join('; ')}`);
  return { ...verified, applied: true, result: `branch protection now matches the ${plan.mode} review policy of every open item` };
}
