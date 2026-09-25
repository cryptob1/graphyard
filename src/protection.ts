import { execFileSync } from 'node:child_process';
import { CHECK_NAME, nativeReviewRequired, reviewProviderOf, reviewProviders, type ReviewProvider, type Work } from './model.js';

export interface ReviewProtection { mode: 'native' | 'agent'; requiredApprovals: number; requireLastPushApproval: boolean; dismissStaleReviews: boolean }
export type ProtectionRun = (command: string, args: string[], input?: string) => string;
export const protectionRun: ProtectionRun = (command, args, input) => execFileSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });

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

// ---- GitHub's merge queue (GY-258) -------------------------------------------------------------
// GitHub executes merges and Graphyard only gates them: the base branch carries a merge queue whose
// merge groups must pass `Graphyard / merge`, bound to the control-plane App. Branch protection has
// no merge-queue setting, so the queue is a repository ruleset on the base branch that Graphyard
// writes by name and reads back through the branch's active rules.
export const mergeQueueRulesetName = 'Graphyard merge queue';
/** The ruleset Graphyard writes: a queue that builds and merges one entry at a time, and the App-bound required check. */
export function mergeQueueRuleset(config: { baseBranch: string; githubAppId: number }) {
  return {
    name: mergeQueueRulesetName, target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: [`refs/heads/${config.baseBranch}`], exclude: [] } },
    rules: [
      // One entry at a time: each merge group is exactly one authorized head on the base it lands on.
      { type: 'merge_queue', parameters: { check_response_timeout_minutes: 60, grouping_strategy: 'ALLGREEN', max_entries_to_build: 1, max_entries_to_merge: 1, merge_method: 'MERGE', min_entries_to_merge: 1, min_entries_to_merge_wait_minutes: 0 } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: CHECK_NAME, integration_id: config.githubAppId }] } },
    ],
  };
}
/**
 * Whether the base branch's active rules (GET /rules/branches/BRANCH) carry a merge queue and
 * require `Graphyard / merge` from the App; null when the rules could not be read.
 */
export function mergeQueueState(rules: unknown, githubAppId: number): { queue: boolean; requiredCheck: boolean } | null {
  if (!Array.isArray(rules)) return null;
  return {
    queue: rules.some((rule: any) => rule?.type === 'merge_queue'),
    requiredCheck: rules.some((rule: any) => rule?.type === 'required_status_checks' && Array.isArray(rule.parameters?.required_status_checks)
      && rule.parameters.required_status_checks.some((check: any) => check?.context === CHECK_NAME && check?.integration_id === githubAppId)),
  };
}
/** Where readProtection attaches the branch's active rules beside GitHub's protection document. */
const branchRules = Symbol.for('graphyard.branchRules');
/** Where readProtection attaches the repository's merge settings (GET repos/OWNER/REPO). */
const repositoryMerge = Symbol.for('graphyard.repositoryMerge');

// ---- Merge modes (GY-310) ----------------------------------------------------------------------
// GitHub offers merge queues only on organization-owned repositories; a user-owned repository
// answers the queue ruleset with HTTP 422. There GitHub merges through auto-merge instead, which
// Graphyard enables per pull request once every gate passes, so the repository must allow it.
export type MergeMode = 'queue' | 'auto-merge';
/** The repository settings the merge mode depends on; `queueRefused` records a 422 on the queue ruleset. */
export interface RepositoryMergeSettings { ownerType: string; allowAutoMerge: boolean; queueRefused?: boolean }
/** The merge settings of a repository document, or null when it does not say who owns the repository. */
export function repositoryMergeSettings(repository: unknown): RepositoryMergeSettings | null {
  const owner = (repository as any)?.owner?.type;
  return typeof owner === 'string' ? { ownerType: owner, allowAutoMerge: (repository as any).allow_auto_merge === true } : null;
}
/**
 * How GitHub merges on this repository: through a merge queue when the base branch already has one,
 * or the repository is organization-owned and GitHub did not refuse the queue ruleset; through
 * auto-merge otherwise. Unread settings keep the queue, the mode every earlier protection planned.
 */
export function mergeMode(settings: RepositoryMergeSettings | null, rules: unknown): MergeMode {
  if (Array.isArray(rules) && rules.some((rule: any) => rule?.type === 'merge_queue')) return 'queue';
  if (!settings) return 'queue';
  return settings.ownerType === 'Organization' && !settings.queueRefused ? 'queue' : 'auto-merge';
}
/** Whether a failed queue ruleset write is GitHub refusing merge queues on this repository (HTTP 422). */
export function queueRulesetRefused(detail: string) { return /\bHTTP 422\b|\(422\)|\b422 Unprocessable/i.test(detail); }
/** The `gh` arguments that let the repository auto-merge pull requests. */
export const enableAutoMergeArgs = (repository: string) => ['api', '--method', 'PATCH', `repos/${repository}`, '-F', 'allow_auto_merge=true'];

export function protectionPlan(current: any, config: { repository: string; baseBranch: string; githubAppId: number }, work: Work[], rules: unknown = current?.[branchRules], repository: RepositoryMergeSettings | null = current?.[repositoryMerge] ?? null) {
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
  const mode = mergeMode(repository, rules);
  // Auto-merge mode plans no queue ruleset: GitHub would refuse it, and the plan would never settle.
  const queue = mode === 'queue' ? mergeQueueState(rules, config.githubAppId) : null;
  const autoMerge = mode === 'auto-merge' ? { enabled: repository?.allowAutoMerge === true } : null;
  const changes = [
    ...(conversationResolution ? ['required_conversation_resolution true to false'] : []),
    ...(observed.requiredApprovals === protection.requiredApprovals ? [] : [`required_approving_review_count ${observed.requiredApprovals} to ${protection.requiredApprovals}`]),
    ...(observed.requireLastPushApproval === protection.requireLastPushApproval ? [] : [`require_last_push_approval ${observed.requireLastPushApproval} to ${protection.requireLastPushApproval}`]),
    ...(observed.dismissStaleReviews === protection.dismissStaleReviews ? [] : [`dismiss_stale_reviews ${observed.dismissStaleReviews} to ${protection.dismissStaleReviews}`]),
    ...(queue && !queue.queue ? [`merge queue on ${config.baseBranch}: none to ruleset "${mergeQueueRulesetName}"`] : []),
    ...(queue && !queue.requiredCheck ? [`merge queue required check ${CHECK_NAME}: missing to required from App ${config.githubAppId}`] : []),
    ...(autoMerge && !autoMerge.enabled ? [`allow_auto_merge false to true (${config.repository} cannot have a merge queue, so GitHub merges through auto-merge)`] : []),
  ];
  return { repository: config.repository, branch: config.baseBranch, mode: protection.mode, items, current: { ...observed, requireConversationResolution: conversationResolution }, desired: { ...protection, requireConversationResolution: false }, changes, blockers,
    // GitHub performs the merge through its queue (GY-258), or through auto-merge where the repository
    // cannot have one (GY-310); mergeQueue is null in auto-merge mode or when the branch rules were not read.
    mergeMode: mode,
    mergeQueue: queue ? { ...queue, ruleset: mergeQueueRuleset(config) } : null,
    autoMerge,
    consistent: !changes.length && !blockers.length,
    refusal: blockers.length ? `Branch protection is missing settings Graphyard cannot reconcile for you: ${blockers.join('; ')}` : null };
}

export function readProtection(config: { repository: string; baseBranch: string }, run: ProtectionRun = protectionRun) {
  const protection = JSON.parse(run('gh', ['api', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`]));
  // The merge queue lives in the branch's rules, not its protection; an unreadable answer leaves it unknown.
  let rules: unknown = null;
  try { rules = JSON.parse(run('gh', ['api', `repos/${config.repository}/rules/branches/${encodeURIComponent(config.baseBranch)}`])); } catch { rules = null; }
  // Who owns the repository decides whether it can have a merge queue at all.
  let settings: RepositoryMergeSettings | null = null;
  try { settings = repositoryMergeSettings(JSON.parse(run('gh', ['api', `repos/${config.repository}`]))); } catch { settings = null; }
  if (protection && typeof protection === 'object') {
    Object.defineProperty(protection, branchRules, { value: rules, enumerable: false });
    Object.defineProperty(protection, repositoryMerge, { value: settings, enumerable: false });
  }
  return protection;
}
/**
 * Onboarding's merge-mode step (GY-310): a repository that cannot have a merge queue merges through
 * auto-merge, so auto-merge is switched on where it is off. An organization repository is left for
 * `master protection --apply`, which writes the queue ruleset once the App publishes the check.
 */
export function ensureMergeMode(repository: string, run: ProtectionRun = protectionRun): { mode: MergeMode; enabled: boolean } {
  const settings = repositoryMergeSettings(JSON.parse(run('gh', ['api', `repos/${repository}`])));
  if (!settings) throw new Error(`GitHub did not report who owns ${repository}`);
  const mode = mergeMode(settings, null);
  if (mode === 'queue' || settings.allowAutoMerge) return { mode, enabled: false };
  run('gh', enableAutoMergeArgs(repository));
  return { mode, enabled: true };
}
/** Write Graphyard's merge-queue ruleset: replace the one it wrote before by name, or create it. */
export function applyMergeQueue(config: { repository: string; baseBranch: string; githubAppId: number }, run: ProtectionRun = protectionRun) {
  const existing = (JSON.parse(run('gh', ['api', `repos/${config.repository}/rulesets?includes_parents=false`])) as any[]).find(ruleset => ruleset?.name === mergeQueueRulesetName);
  run('gh', ['api', '--method', existing ? 'PUT' : 'POST', existing ? `repos/${config.repository}/rulesets/${existing.id}` : `repos/${config.repository}/rulesets`, '--input', '-'], JSON.stringify(mergeQueueRuleset(config)));
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
  let queueRefused = false;
  if (plan.mergeQueue && (!plan.mergeQueue.queue || !plan.mergeQueue.requiredCheck)) {
    try { applyMergeQueue(config, run); } catch (error: any) {
      // GitHub refused the queue ruleset (HTTP 422): this repository cannot have a merge queue, so it merges through auto-merge.
      if (!queueRulesetRefused(`${error?.message ?? ''}\n${error?.stderr ?? ''}`)) throw error;
      queueRefused = true;
    }
  }
  if (queueRefused || (plan.autoMerge && !plan.autoMerge.enabled)) run('gh', enableAutoMergeArgs(config.repository));
  const reviewChanges = plan.current.requireConversationResolution || plan.current.requiredApprovals !== plan.desired.requiredApprovals
    || plan.current.requireLastPushApproval !== plan.desired.requireLastPushApproval || plan.current.dismissStaleReviews !== plan.desired.dismissStaleReviews;
  if (reviewChanges && plan.current.requireConversationResolution) {
    // Conversation resolution has no subresource: the whole protection is written back as observed,
    // with the review settings as desired and conversation resolution off.
    run('gh', ['api', '--method', 'PUT', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`, '--input', '-'], JSON.stringify(conversationPayload(current, plan.desired)));
  } else if (reviewChanges) {
    // Only the review subresource changes; the App-bound check, the strict-off setting, and admin enforcement stay as observed.
    run('gh', ['api', '--method', 'PATCH', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection/required_pull_request_reviews`, '--input', '-'],
      JSON.stringify({ required_approving_review_count: plan.desired.requiredApprovals, require_last_push_approval: plan.desired.requireLastPushApproval, dismiss_stale_reviews: plan.desired.dismissStaleReviews }));
  }
  const reread = readProtection(config, run), settings: RepositoryMergeSettings | null = reread?.[repositoryMerge] ?? null;
  const verified = protectionPlan(reread, config, work, undefined, queueRefused ? { ownerType: settings?.ownerType ?? 'Organization', allowAutoMerge: settings?.allowAutoMerge === true, queueRefused } : settings);
  if (!verified.consistent) throw new Error(`GitHub did not report the reconciled protection; branch protection remains inconsistent with the open review policies: ${[...verified.changes, ...verified.blockers].join('; ')}`);
  return { ...verified, applied: true, result: `branch protection now matches the ${plan.mode} review policy of every open item${verified.mergeQueue ? `, and ${plan.branch} merges through GitHub's merge queue requiring ${CHECK_NAME}` : verified.autoMerge ? `, and ${plan.branch} merges through auto-merge requiring ${CHECK_NAME} (the repository cannot have a merge queue)` : ''}` };
}
