import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHECK_NAME, nativeReviewRequired, reviewProviderOf, reviewProviders, type ReviewProvider, type Work } from './model.js';
import { LANDABLE_CHECK } from './landable-check.js';

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

export interface WorkflowFile { path: string; text: string }

/** The managed repository's GitHub Actions workflows, read from the checkout the command runs in. */
export function readWorkflows(root = process.cwd()): WorkflowFile[] {
  const directory = join(root, '.github', 'workflows');
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  return names.filter(name => /\.ya?ml$/.test(name)).sort().map(name => ({ path: `.github/workflows/${name}`, text: readFileSync(join(directory, name), 'utf8') }));
}

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
/** The lines of the block a `key:` line at `indent` opens, or its inline value. */
function yamlBlock(lines: string[], key: string, indent: number) {
  const start = lines.findIndex(line => line.startsWith(`${' '.repeat(indent)}${key}:`) && !line.startsWith(`${' '.repeat(indent + 1)}`));
  if (start < 0) return null;
  const inline = lines[start].slice(indent + key.length + 1).replace(/\s+#.*$/, '').trim();
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (line.length - line.trimStart().length <= indent) break;
    body.push(line);
  }
  return { inline, body };
}

/**
 * A line-level reading of the workflow shapes that decide run cancellation: whether pull requests
 * trigger it, its jobs (the check-run names a branch requires), and its concurrency settings, top
 * level and per job. It reads only these keys and is no general YAML parser.
 */
export function readWorkflow(text: string) {
  const lines = text.split(/\r?\n/);
  const trigger = yamlBlock(lines, 'on', 0) ?? yamlBlock(lines, '"on"', 0) ?? yamlBlock(lines, "'on'", 0);
  const triggers = trigger ? [...`${trigger.inline}\n${trigger.body.filter(line => /^ {2}[\w-]+:/.test(line) || /^ {2}- /.test(line)).join('\n')}`.matchAll(/[\w-]+/g)].map(match => match[0]) : [];
  const concurrencyOf = (block: string[], indent: number) => {
    const found = yamlBlock(block, 'concurrency', indent);
    if (!found) return null;
    const field = (name: string) => { const line = found.body.find(entry => entry.trimStart().startsWith(`${name}:`)); return line === undefined ? null : unquote(line.trimStart().slice(name.length + 1)); };
    return found.inline ? { group: unquote(found.inline), cancelInProgress: null } : { group: field('group'), cancelInProgress: field('cancel-in-progress') };
  };
  const jobsBlock = yamlBlock(lines, 'jobs', 0)?.body ?? [];
  const jobs = jobsBlock.flatMap((line, index) => {
    const id = line.match(/^ {2}([\w-]+):\s*$/)?.[1];
    if (!id) return [];
    const end = jobsBlock.findIndex((next, at) => at > index && /^ {2}\S/.test(next));
    const body = jobsBlock.slice(index + 1, end < 0 ? undefined : end);
    const name = body.find(entry => /^ {4}name:/.test(entry));
    return [{ id, name: name ? unquote(name.replace(/^ {4}name:/, '')) : id, concurrency: concurrencyOf(body, 4) }];
  });
  return { pullRequest: triggers.some(name => name === 'pull_request' || name === 'pull_request_target'), push: triggers.includes('push'), concurrency: concurrencyOf(lines, 0), jobs };
}

const cancels = (concurrency: { cancelInProgress: string | null } | null) => !!concurrency?.cancelInProgress && concurrency.cancelInProgress !== 'false';
export const CI_CONCURRENCY_ADVICE = 'add a concurrency group per pull request with cancel-in-progress for pull_request events, so a run for a superseded head stops holding an Actions runner';

/**
 * Advisories, never blockers: each required check whose pull-request workflow keeps running for a
 * superseded head. Every base refresh and rework push then adds a full run while the older ones
 * still hold the repository's concurrent-runner limit, and every item waits in Test behind them.
 */
export function ciConcurrencyAdvisories(checks: string[], workflows: WorkflowFile[]) {
  return [...new Set(checks)].sort().flatMap(check => workflows.flatMap(({ path, text }) => {
    const workflow = readWorkflow(text);
    const job = workflow.pullRequest ? workflow.jobs.find(entry => entry.name === check || entry.id === check) : undefined;
    if (!job || cancels(workflow.concurrency) || cancels(job.concurrency)) return [];
    return [`Required check ${check} runs in ${path} (job ${job.id}), which never cancels superseded pull-request runs; ${CI_CONCURRENCY_ADVICE}`];
  }));
}

// ---- GitHub's merge queue (GY-258) -------------------------------------------------------------
// GitHub executes merges and Graphyard only gates them: the base branch carries a merge queue whose
// merge groups must pass `Graphyard / merge`, bound to the control-plane App. Branch protection has
// no merge-queue setting, so the queue is a repository ruleset on the base branch that Graphyard
// writes by name and reads back through the branch's active rules.
export const mergeQueueRulesetName = 'Graphyard merge queue';
/**
 * The repair lane's bypass (GY-406): the control-plane App, and nobody else, may merge a pull
 * request past this ruleset's queue — in pull-request mode only, so it never pushes to the base
 * branch. Classic protection (required checks, reviews, enforce_admins) is untouched and still
 * binds the App; the lane decides when the App may use the bypass (src/master/repair-lane.ts).
 */
export const repairBypassActor = (githubAppId: number) => ({ actor_id: githubAppId, actor_type: 'Integration' as const, bypass_mode: 'pull_request' as const });
/**
 * The checks Graphyard's App publishes that GitHub requires, bound to that App: the merge gate and
 * the landability verdict (GY-887), which every candidate head and merge group commit carries, so
 * GitHub enforces what Graphyard decided beside the repository's own CI.
 */
export const GRAPHYARD_CHECKS = [CHECK_NAME, LANDABLE_CHECK] as const;
/** The ruleset Graphyard writes: a queue that builds and merges one entry at a time, the App-bound required check, and the repair lane's one bypass actor. */
export function mergeQueueRuleset(config: { baseBranch: string; githubAppId: number }) {
  return {
    name: mergeQueueRulesetName, target: 'branch', enforcement: 'active',
    bypass_actors: [repairBypassActor(config.githubAppId)],
    conditions: { ref_name: { include: [`refs/heads/${config.baseBranch}`], exclude: [] } },
    rules: [
      // One entry at a time: each merge group is exactly one authorized head on the base it lands on.
      { type: 'merge_queue', parameters: { check_response_timeout_minutes: 60, grouping_strategy: 'ALLGREEN', max_entries_to_build: 1, max_entries_to_merge: 1, merge_method: 'MERGE', min_entries_to_merge: 1, min_entries_to_merge_wait_minutes: 0 } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: GRAPHYARD_CHECKS.map(context => ({ context, integration_id: config.githubAppId })) } },
    ],
  };
}
// ---- Merge-writer-only base branch (GY-1715) ---------------------------------------------------
// Under the control-plane merger Graphyard's merge writer is the only executor, so setup protects the
// base branch with a ruleset that refuses every creation, push, force push and deletion of it from every actor —
// administrators included, which classic protection cannot promise — and lets deploy keys alone
// bypass it. Setup applies it only while the merge writer's key is the repository's one read-write deploy key.
export const mainWriteRulesetName = 'Graphyard merge writer only';
/** GitHub's deploy-key bypass names no single key (its actor_id must be null); it covers every deploy key on the repository. */
export const deployKeyBypassActor = { actor_id: null, actor_type: 'DeployKey' as const, bypass_mode: 'always' as const };
export function mainWriteRuleset(baseBranch: string) {
  return {
    name: mainWriteRulesetName, target: 'branch', enforcement: 'active',
    bypass_actors: [deployKeyBypassActor],
    conditions: { ref_name: { include: [`refs/heads/${baseBranch}`], exclude: [] } },
    rules: [{ type: 'creation' }, { type: 'update', parameters: { update_allows_fetch_and_merge: false } }, { type: 'non_fast_forward' }, { type: 'deletion' }],
  };
}
/** Whether a ruleset document (GET repos/OWNER/REPO/rulesets/ID) already enforces exactly `mainWriteRuleset(BASE)`, so applying it again would change nothing. */
export function mainWriteRulesetCurrent(ruleset: any, baseBranch: string): boolean {
  if (!ruleset || typeof ruleset !== 'object') return false;
  const desired = mainWriteRuleset(baseBranch);
  const actors = (list: any) => (Array.isArray(list) ? list : []).map((actor: any) => `${actor?.actor_type}:${actor?.actor_id ?? null}:${actor?.bypass_mode}`).sort();
  const rules = (list: any) => (Array.isArray(list) ? list : []).map((rule: any) => `${rule?.type}:${JSON.stringify(rule?.type === 'update' ? { update_allows_fetch_and_merge: Boolean(rule?.parameters?.update_allows_fetch_and_merge) } : {})}`).sort();
  const refs = (conditions: any) => [...(conditions?.ref_name?.include ?? [])].sort().join(',') + '|' + [...(conditions?.ref_name?.exclude ?? [])].sort().join(',');
  return ruleset.target === desired.target && ruleset.enforcement === desired.enforcement
    && JSON.stringify(actors(ruleset.bypass_actors)) === JSON.stringify(actors(desired.bypass_actors))
    && JSON.stringify(rules(ruleset.rules)) === JSON.stringify(rules(desired.rules))
    && refs(ruleset.conditions) === refs(desired.conditions);
}
/**
 * Whether the base branch's active rules (GET /rules/branches/BRANCH) carry a merge queue and
 * require every Graphyard check (`Graphyard / merge` and `graphyard/landable`) from the App; null
 * when the rules could not be read.
 */
export function mergeQueueState(rules: unknown, githubAppId: number): { queue: boolean; requiredCheck: boolean } | null {
  if (!Array.isArray(rules)) return null;
  return {
    queue: rules.some((rule: any) => rule?.type === 'merge_queue'),
    requiredCheck: GRAPHYARD_CHECKS.every(context => rules.some((rule: any) => rule?.type === 'required_status_checks' && Array.isArray(rule.parameters?.required_status_checks)
      && rule.parameters.required_status_checks.some((check: any) => check?.context === context && check?.integration_id === githubAppId))),
  };
}
/**
 * Whether a ruleset document (GET repos/OWNER/REPO/rulesets/ID) carries exactly the repair lane's
 * bypass: one actor, the App, as an Integration, in pull_request mode. Null when it was not read.
 */
export function repairBypassState(ruleset: unknown, githubAppId: number): { actors: unknown[]; exact: boolean } | null {
  const actors = (ruleset as any)?.bypass_actors;
  if (!Array.isArray(actors)) return null;
  const wanted = repairBypassActor(githubAppId);
  return { actors, exact: actors.length === 1 && Number(actors[0]?.actor_id) === wanted.actor_id && actors[0]?.actor_type === wanted.actor_type && actors[0]?.bypass_mode === wanted.bypass_mode };
}
/** Where readProtection attaches Graphyard's merge-queue ruleset document, as GitHub returns it. */
const queueRulesetDocument = Symbol.for('graphyard.queueRuleset');
/** Attach Graphyard's merge-queue ruleset document to a protection document, as readProtection does. */
export function withQueueRuleset<T extends object>(protection: T, ruleset: unknown): T {
  Object.defineProperty(protection, queueRulesetDocument, { value: ruleset, enumerable: false, configurable: true });
  return protection;
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
/** The repository settings the merge mode depends on, as GitHub's repository document reports them. */
export interface RepositoryMergeSettings { ownerType: string; allowAutoMerge: boolean }
/** The merge settings of a repository document, or null when it does not say who owns the repository. */
export function repositoryMergeSettings(repository: unknown): RepositoryMergeSettings | null {
  const owner = (repository as any)?.owner?.type;
  return typeof owner === 'string' ? { ownerType: owner, allowAutoMerge: (repository as any).allow_auto_merge === true } : null;
}
/**
 * How GitHub merges on this repository: through a merge queue when the base branch already has one;
 * through auto-merge when the repository is user-owned, or organization-owned with auto-merge
 * already allowed — `allow_auto_merge` is the persistent record of a queue ruleset GitHub refused
 * with HTTP 422 (GY-350), which every 422 fallback writes, so a later plan, apply or install reads
 * the settled mode back from GitHub instead of retrying the refused ruleset; through the queue
 * otherwise. Unread settings keep the queue, the mode every earlier protection planned.
 */
export function mergeMode(settings: RepositoryMergeSettings | null, rules: unknown): MergeMode {
  if (Array.isArray(rules) && rules.some((rule: any) => rule?.type === 'merge_queue')) return 'queue';
  if (!settings) return 'queue';
  if (settings.ownerType !== 'Organization') return 'auto-merge';
  return settings.allowAutoMerge ? 'auto-merge' : 'queue';
}
/** Whether a failed queue ruleset write is GitHub refusing merge queues on this repository (HTTP 422). */
export function queueRulesetRefused(detail: string) { return /\bHTTP 422\b|\(422\)|\b422 Unprocessable/i.test(detail); }
/** The `gh` arguments that let the repository auto-merge pull requests. */
export const enableAutoMergeArgs = (repository: string) => ['api', '--method', 'PATCH', `repos/${repository}`, '-F', 'allow_auto_merge=true'];

/** Attach repository merge settings to a protection document, as readProtection does, for protectionPlan to read. */
export function withMergeSettings<T extends object>(protection: T, settings: RepositoryMergeSettings | null): T {
  Object.defineProperty(protection, repositoryMerge, { value: settings, enumerable: false, configurable: true });
  return protection;
}

export function protectionPlan(current: any, config: { repository: string; baseBranch: string; githubAppId: number }, work: Work[], rules: unknown = current?.[branchRules], workflows: WorkflowFile[] = readWorkflows()) {
  const operator: any[] | null | undefined = current?.[operatorRulesetsKey];
  if (operator?.length) return operatorRulesetPlan(current, config, work, rules, workflows, operator);
  const { protection, items } = requiredReviewProtection(work);
  const reviews = current?.required_pull_request_reviews, checks = current?.required_status_checks;
  const observed = { requiredApprovals: Number(reviews?.required_approving_review_count ?? 0), requireLastPushApproval: reviews?.require_last_push_approval === true, dismissStaleReviews: reviews?.dismiss_stale_reviews === true };
  const blockers = [
    // A candidate that merges cleanly is reviewed, proven and merged on the base it was built on
    // (GY-191), so GitHub's "require branches to be up to date" setting must stay off (see assertMergeProtection).
    ...(checks?.strict === false ? [] : ['Require branches to be up to date before merging is enabled; Graphyard requires it off']),
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
  // The landability verdict (GY-887) is required beside the merge gate. Unlike the merge gate, which
  // must already be bound before anything is reconciled, it is a change the apply makes itself.
  const landable = Array.isArray(checks?.checks) && checks.checks.some((check: any) => check?.context === LANDABLE_CHECK && check?.app_id === config.githubAppId);
  const repository: RepositoryMergeSettings | null = current?.[repositoryMerge] ?? null, mode = mergeMode(repository, rules);
  // Auto-merge mode plans no queue ruleset: GitHub would refuse it, and the plan would never settle.
  const queue = mode === 'queue' ? mergeQueueState(rules, config.githubAppId) : null;
  const autoMerge = mode === 'auto-merge' ? { enabled: repository?.allowAutoMerge === true } : null;
  // The repair lane's bypass lives on the queue ruleset; an unread ruleset leaves it unknown. In
  // auto-merge mode no ruleset holds the App back, so the lane needs no bypass there.
  const bypass = queue ? repairBypassState(current?.[queueRulesetDocument], config.githubAppId) : null;
  const repairBypass = queue ? { ruleset: mergeQueueRulesetName, actor: repairBypassActor(config.githubAppId), configured: bypass ? bypass.exact : null, observed: bypass?.actors ?? null } : null;
  const changes = [
    ...(conversationResolution ? ['required_conversation_resolution true to false'] : []),
    ...(landable ? [] : [`required check ${LANDABLE_CHECK}: missing to required from App ${config.githubAppId}`]),
    ...(observed.requiredApprovals === protection.requiredApprovals ? [] : [`required_approving_review_count ${observed.requiredApprovals} to ${protection.requiredApprovals}`]),
    ...(observed.requireLastPushApproval === protection.requireLastPushApproval ? [] : [`require_last_push_approval ${observed.requireLastPushApproval} to ${protection.requireLastPushApproval}`]),
    ...(observed.dismissStaleReviews === protection.dismissStaleReviews ? [] : [`dismiss_stale_reviews ${observed.dismissStaleReviews} to ${protection.dismissStaleReviews}`]),
    ...(queue && !queue.queue ? [`merge queue on ${config.baseBranch}: none to ruleset "${mergeQueueRulesetName}"`] : []),
    ...(queue && !queue.requiredCheck ? [`merge queue required check ${GRAPHYARD_CHECKS.join(' and ')}: missing to required from App ${config.githubAppId}`] : []),
    ...(repairBypass?.configured === false ? [`repair lane bypass on "${mergeQueueRulesetName}": ${JSON.stringify(repairBypass.observed)} to only App ${config.githubAppId} (Integration, pull_request)`] : []),
    ...(autoMerge && !autoMerge.enabled ? [`allow_auto_merge false to true (${config.repository} cannot have a merge queue, so GitHub merges through auto-merge)`] : []),
  ];
  const requiredChecks = work.filter(item => item.stage !== 'done').flatMap(item => item.policy.checks);
  const advisories = ciConcurrencyAdvisories(requiredChecks, workflows);
  return { repository: config.repository, branch: config.baseBranch, mode: protection.mode, items, current: { ...observed, requireConversationResolution: conversationResolution }, desired: { ...protection, requireConversationResolution: false }, landableCheck: landable, changes, blockers, advisories,
    // GitHub performs the merge through its queue (GY-258); null when the branch rules were not read.
    mergeQueue: queue ? { ...queue, ruleset: mergeQueueRuleset(config) } : null,
    // Or through auto-merge where the repository cannot have a queue (GY-310); mergeQueue is then null.
    mergeMode: mode, autoMerge,
    // The one sanctioned merge bypass (GY-406): the App, pull-request mode, on the queue ruleset only.
    repairBypass,
    consistent: !changes.length && !blockers.length,
    refusal: blockers.length ? `Branch protection is missing settings Graphyard cannot reconcile for you: ${blockers.join('; ')}` : null };
}

/** Where readProtection attaches the operator rulesets governing the base (null: the listing failed with classic protection present). */
const operatorRulesetsKey = Symbol.for('graphyard.operatorRulesets');
/** Set on the empty document readProtection answers when GitHub reports the base has no classic protection. */
const classicMissingKey = Symbol.for('graphyard.classicMissing');
/** Attach the operator rulesets governing the base, as readProtection does, for protectionPlan to read. */
export function withOperatorRulesets<T extends object>(protection: T, rulesets: any[] | null, classicMissing = false): T {
  Object.defineProperty(protection, operatorRulesetsKey, { value: rulesets, enumerable: false, configurable: true });
  if (classicMissing) Object.defineProperty(protection, classicMissingKey, { value: true, enumerable: false, configurable: true });
  return protection;
}

/**
 * The plan for a base branch an operator ruleset governs (GY-1926): it names every governing ruleset,
 * and its only change is AC-2's add of the Graphyard checks to the one ruleset requiring checks.
 * It never proposes a classic protection write, a queue ruleset or a review-setting change there.
 */
function operatorRulesetPlan(current: any, config: { repository: string; baseBranch: string; githubAppId: number }, work: Work[], rules: unknown, workflows: WorkflowFile[], operator: any[]) {
  const { protection, items } = requiredReviewProtection(work);
  const { target, refusal: ambiguous } = rulesetTarget(operator, config.baseBranch);
  const missing = target ? missingGraphyardChecks(target, config.githubAppId) : [];
  const refusal = ambiguous ?? (missing.length ? inheritedRefusal(target, config.baseBranch) : null);
  const changes = missing.map(entry => `operator ruleset ${target.id} (${target.name}) required check ${entry.context}: missing to required from App ${entry.integration_id}`);
  const classicPresent = !current?.[classicMissingKey];
  const requiredChecks = work.filter(item => item.stage !== 'done').flatMap(item => item.policy.checks);
  const advisories = [
    ...(classicPresent ? [`${config.baseBranch} also has classic protection; an operator ruleset governs it, so Graphyard leaves the classic protection as it is`] : []),
    ...(target && describeRuleset(target).strict ? [`Operator ruleset ${target.id} requires branches to be up to date (strict); Graphyard leaves the operator's strict policy as it is`] : []),
    ...ciConcurrencyAdvisories(requiredChecks, workflows),
  ];
  const blockers = refusal ? [refusal] : [];
  return { repository: config.repository, branch: config.baseBranch, governance: 'operator-ruleset' as const, mode: protection.mode, items,
    classicProtection: classicPresent ? 'present, never written while an operator ruleset governs the base' : 'none (GitHub answered 404 Branch not protected)',
    operatorRulesets: operator.map(describeRuleset), effectiveRules: rules ?? null, target: target ? { id: target.id, name: target.name } : null,
    current: { requiredApprovals: 0, requireLastPushApproval: false, dismissStaleReviews: false, requireConversationResolution: false }, desired: { ...protection, requireConversationResolution: false },
    landableCheck: !!target && !missing.some(entry => entry.context === LANDABLE_CHECK), changes, blockers, advisories,
    mergeQueue: null, mergeMode: mergeMode(current?.[repositoryMerge] ?? null, rules), autoMerge: null, repairBypass: null,
    consistent: !changes.length && !blockers.length, refusal: refusal ? `Branch protection cannot be reconciled through the operator rulesets: ${refusal}` : null };
}

export function readProtection(config: { repository: string; baseBranch: string }, run: ProtectionRun = protectionRun) {
  // A 404 "Branch not protected" means no classic protection (GY-1926), never an error or an
  // unprotected branch: operator rulesets may govern it. Any other failed answer still refuses.
  let answer: string | null;
  try { answer = run('gh', ['api', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`]); }
  catch (error: any) { if (!classicAbsent(`${error?.stderr ?? ''}\n${error?.message ?? ''}`)) throw error; answer = null; }
  const protection = answer === null ? {} : JSON.parse(answer);
  // The merge queue lives in the branch's rules, not its protection; an unreadable answer leaves it unknown.
  // Both failures are kept: where an operator ruleset governs the base they refuse below (GY-1926).
  let rules: unknown = null, rulesFailure: unknown = null;
  try { rules = JSON.parse(run('gh', ['api', `repos/${config.repository}/rules/branches/${encodeURIComponent(config.baseBranch)}`])); } catch (error) { rules = null; rulesFailure = error; }
  // Who owns the repository decides whether it can have a merge queue at all.
  let repository: any = null, repositoryFailure: unknown = null;
  try { repository = JSON.parse(run('gh', ['api', `repos/${config.repository}`])); } catch (error) { repository = null; repositoryFailure = error; }
  const settings = repositoryMergeSettings(repository);
  let listed: any[] | null = null, listing: unknown = null;
  try {
    listed = [];
    for (let page = 1; ; page++) {
      // Inherited (organization or enterprise) rulesets govern the base as much as the repository's own (GY-1926).
      const entries = JSON.parse(run('gh', ['api', `repos/${config.repository}/rulesets?includes_parents=true${page > 1 ? `&per_page=30&page=${page}` : ''}`]));
      listed.push(...(Array.isArray(entries) ? entries : []));
      if (!Array.isArray(entries) || entries.length < 30) break;
    }
  } catch (error) { listed = null; listing = error; }
  // The queue ruleset's bypass actors are only on the ruleset's own document.
  let queueRuleset: unknown = null;
  try {
    const found = listed?.find(ruleset => ruleset?.name === mergeQueueRulesetName && repositoryOwned(ruleset));
    if (found?.id) queueRuleset = JSON.parse(run('gh', ['api', `repos/${config.repository}/rulesets/${found.id}`]));
  } catch { queueRuleset = null; }
  // With no classic protection, an unread listing would leave the branch's governance unknown.
  if (!listed && answer === null) throw new Error(`${config.repository}@${config.baseBranch} has no classic protection, and GitHub did not answer its rulesets listing (${failureLine(listing)}), so which rulesets govern it is unknown`);
  const operator = listed ? readOperatorRulesetsSync(config, run, listed, repository ? repository.default_branch ?? null : undefined, repositoryFailure) : null;
  if (operator?.length && rulesFailure) throw new Error(`Operator ruleset(s) ${operator.map(ruleset => `${ruleset.id} (${ruleset.name})`).join(', ')} govern ${config.repository}@${config.baseBranch}, and GitHub did not answer its effective rules (${failureLine(rulesFailure)}), so no protection change can be planned; rerun`);
  if (protection && typeof protection === 'object') {
    Object.defineProperty(protection, branchRules, { value: rules, enumerable: false });
    withMergeSettings(protection, settings);
    withQueueRuleset(protection, queueRuleset);
    withOperatorRulesets(protection, operator, answer === null);
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

/**
 * The required status checks a write sets: every observed one as it is, with `graphyard/landable`
 * bound to the App (GY-887) in place of any entry of that name another producer could satisfy.
 */
export function requiredStatusChecks(current: any, githubAppId: number) {
  const observed = (current?.required_status_checks?.checks ?? []).map((check: any) => ({ context: String(check.context), app_id: check.app_id ?? null }));
  return [...observed.filter((check: { context: string }) => check.context !== LANDABLE_CHECK), { context: LANDABLE_CHECK, app_id: githubAppId }];
}
const logins = (list: any[] | undefined, field: 'login' | 'slug') => (list ?? []).map((entry: any) => entry[field]);
/**
 * The whole protection a PUT writes when conversation resolution has to be switched off — GitHub
 * has no subresource for that one setting — with every other observed setting kept as it is and
 * the review settings as desired.
 */
export function conversationPayload(current: any, desired: ReviewProtection, githubAppId: number) {
  const reviews = current?.required_pull_request_reviews, dismissal = reviews?.dismissal_restrictions, bypass = reviews?.bypass_pull_request_allowances, restrictions = current?.restrictions;
  return {
    required_status_checks: { strict: current?.required_status_checks?.strict === true, checks: requiredStatusChecks(current, githubAppId) },
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

/** Where an operator-ruleset write saves its snapshots: the managed checkout's `.graphyard/protection-snapshots/`. */
export const protectionSnapshots = (root: string) => join(root, '.graphyard', 'protection-snapshots');

export async function applyProtection(config: { repository: string; baseBranch: string; githubAppId: number }, work: Work[], run: ProtectionRun = protectionRun, workflows: WorkflowFile[] = readWorkflows(), options: { snapshots?: string; now?: number } = {}) {
  const current = readProtection(config, run);
  const plan = protectionPlan(current, config, work, undefined, workflows);
  if (plan.blockers.length) throw new Error(plan.refusal!);
  if ('governance' in plan) {
    // An operator ruleset governs the base: its add is the only write, and classic protection is never written.
    const written = await applyOperatorRulesetAdd(ghApiFromRun(run), { ...config, snapshots: options.snapshots ?? protectionSnapshots(process.cwd()), now: options.now ?? Date.now() });
    return { ...protectionPlan(readProtection(config, run), config, work, undefined, workflows), ...written };
  }
  if (!plan.changes.length) return { ...plan, applied: false, result: 'branch protection already matches every open review policy' };
  if (current?.[operatorRulesetsKey] === null) throw new Error(`GitHub did not answer the rulesets listing of ${config.repository}, so whether an operator ruleset governs ${config.baseBranch} is unknown; Graphyard writes no classic protection until it is known, so rerun`);
  let queueRefused = false;
  if (plan.mergeQueue && (!plan.mergeQueue.queue || !plan.mergeQueue.requiredCheck || plan.repairBypass?.configured === false)) {
    try { applyMergeQueue(config, run); } catch (error: any) {
      // GitHub refused the queue ruleset (HTTP 422): this repository cannot have a merge queue, so it
      // merges through auto-merge. Switching auto-merge on records the settled mode in the repository
      // itself (GY-350): the verify below re-plans from it, and no later plan or apply retries the write.
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
    run('gh', ['api', '--method', 'PUT', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`, '--input', '-'], JSON.stringify(conversationPayload(current, plan.desired, config.githubAppId)));
  } else if (reviewChanges) {
    // Only the review subresource changes; the App-bound check, the strict-off setting, and admin enforcement stay as observed.
    run('gh', ['api', '--method', 'PATCH', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection/required_pull_request_reviews`, '--input', '-'],
      JSON.stringify({ required_approving_review_count: plan.desired.requiredApprovals, require_last_push_approval: plan.desired.requireLastPushApproval, dismiss_stale_reviews: plan.desired.dismissStaleReviews }));
  }
  if (!plan.landableCheck && !(reviewChanges && plan.current.requireConversationResolution)) {
    // The landability verdict joins the required checks (GY-887): every observed check is kept, and strict stays as observed (off).
    // If the branch had no required_status_checks subresource, GitHub returns 404 on PATCH; PUT the whole protection payload instead (GY-1050).
    if (!current?.required_status_checks) {
      run('gh', ['api', '--method', 'PUT', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`, '--input', '-'],
        JSON.stringify(conversationPayload(current, plan.desired, config.githubAppId)));
    } else {
      run('gh', ['api', '--method', 'PATCH', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection/required_status_checks`, '--input', '-'],
        JSON.stringify({ strict: current?.required_status_checks?.strict === true, checks: requiredStatusChecks(current, config.githubAppId) }));
    }
  }
  const reread = readProtection(config, run);
  const verified = protectionPlan(reread, config, work, undefined, workflows);
  if (!verified.consistent) throw new Error(`GitHub did not report the reconciled protection; branch protection remains inconsistent with the open review policies: ${[...verified.changes, ...verified.blockers].join('; ')}`);
  return { ...verified, applied: true, result: `branch protection now matches the ${plan.mode} review policy of every open item${verified.mergeQueue ? `, and ${plan.branch} merges through GitHub's merge queue requiring ${GRAPHYARD_CHECKS.join(' and ')}; the queue's only bypass actor is App ${config.githubAppId} in pull-request mode, for the audited repair lane` : verified.autoMerge ? `, and ${plan.branch} merges through auto-merge requiring ${GRAPHYARD_CHECKS.join(' and ')} (the repository cannot have a merge queue)` : ''}` };
}

// ---- Operator rulesets (GY-1926) ---------------------------------------------------------------
// A base branch may be governed by the operator's own repository rulesets instead of classic
// protection, whose GET then answers 404 "Branch not protected": that means no classic protection,
// never an unprotected branch. Graphyard then writes no classic protection at all. It adds its two
// App-bound checks to the one operator ruleset that already requires checks on the base, and that
// write snapshots the ruleset first, re-reads and verifies it, and puts the snapshot back on any
// mismatch. Every other ruleset, and every other field of that one, stays as the operator wrote it.

/** One `gh` call, as the installer's GitHubCli makes it; `ghApiFromRun` adapts the master's synchronous runner. */
export interface GhAnswer { stdout: string; stderr: string; code: number }
export type GhApi = (args: string[], options?: { input?: string; allowFailure?: boolean }) => Promise<GhAnswer>;
export const ghApiFromRun = (run: ProtectionRun): GhApi => async (args, options = {}) => {
  try { return { stdout: run('gh', args, options.input), stderr: '', code: 0 }; }
  catch (error: any) { return { stdout: String(error?.stdout ?? ''), stderr: `${error?.stderr ?? ''}\n${error?.message ?? ''}`.trim(), code: Number.isInteger(error?.status) && error.status !== 0 ? error.status : 1 }; }
};
/** GitHub's answer for a classic-protection GET on a branch that has none. */
export const classicAbsent = (detail: string) => /Branch not protected/i.test(detail);
const graphyardRulesets: string[] = [mergeQueueRulesetName, mainWriteRulesetName];
// Inherited rulesets are listed too: an organization ruleset governs the base exactly as a repository one does.
const rulesetsPage = (repository: string, page: number) => `repos/${repository}/rulesets?includes_parents=true&per_page=100&page=${page}`;
/** Whether a ruleset is the repository's own, so writable through its repository endpoint (a listing without source_type predates inheritance). */
const repositoryOwned = (ruleset: any) => (ruleset?.source_type ?? 'Repository') === 'Repository';

/** An fnmatch glob as a regular expression source: `*` within one segment, `**` across them, `?`, `[set]`, `[!set]`/`[^set]` and `\\` escapes. */
function fnmatchSource(glob: string) {
  const literal = (char: string) => char.replace(/[.+^${}()|[\]\\*?\/-]/g, '\\$&');
  let source = '';
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at];
    if (char === '\\' && at + 1 < glob.length) source += literal(glob[++at]);
    else if (char === '*') { if (glob[at + 1] === '*') { source += '.*'; at++; } else source += '[^/]*'; }
    else if (char === '?') source += '[^/]';
    else if (char === '[') {
      let end = at + 1;
      if (glob[end] === '!' || glob[end] === '^') end++;
      if (glob[end] === ']') end++;
      while (end < glob.length && glob[end] !== ']') end++;
      // An unclosed bracket is a literal, as fnmatch reads it.
      if (end >= glob.length) { source += literal(char); continue; }
      let body = glob.slice(at + 1, end), negated = false;
      if (body[0] === '!' || body[0] === '^') { negated = true; body = body.slice(1); }
      let set = '';
      for (let index = 0; index < body.length; index++) {
        if (body[index + 1] === '-' && index + 2 < body.length) { set += `${literal(body[index])}-${literal(body[index + 2])}`; index += 2; }
        else set += literal(body[index]);
      }
      source += negated ? `[^/${set}]` : `[${set}]`;
      at = end;
    } else source += literal(char);
  }
  return source;
}
/** A ref_name pattern as GitHub matches it: `~ALL`, `~DEFAULT_BRANCH`, or an fnmatch glob over `refs/heads/…`. */
export function refPatternMatches(pattern: string, branch: string, defaultBranch: string | null) {
  if (pattern === '~ALL') return true;
  if (pattern === '~DEFAULT_BRANCH') return !!defaultBranch && branch === defaultBranch;
  return new RegExp(`^${fnmatchSource(pattern.replace(/^refs\/heads\//, ''))}$`).test(branch);
}
/** Whether an active branch ruleset document's conditions include BRANCH. */
export function rulesetGovernsBranch(ruleset: any, branch: string, defaultBranch: string | null) {
  const ref = ruleset?.conditions?.ref_name;
  if ((ruleset?.target ?? 'branch') !== 'branch' || ruleset?.enforcement !== 'active' || !ref) return false;
  const matches = (list: unknown) => (Array.isArray(list) ? list : []).some(pattern => refPatternMatches(String(pattern), branch, defaultBranch));
  return matches(ref.include) && !matches(ref.exclude);
}
const checksRule = (ruleset: any) => (Array.isArray(ruleset?.rules) ? ruleset.rules : []).find((rule: any) => rule?.type === 'required_status_checks');
const checksOf = (ruleset: any): { context: string; integration_id?: number }[] => checksRule(ruleset)?.parameters?.required_status_checks ?? [];
/** What a plan names per operator ruleset: id, required checks with integration ids, strict policy, conditions and bypass actors. */
export function describeRuleset(ruleset: any) {
  const rule = checksRule(ruleset);
  return { id: ruleset.id, name: ruleset.name, source: `${ruleset.source_type ?? 'Repository'}${ruleset.source ? ` ${ruleset.source}` : ''}`, enforcement: ruleset.enforcement, requiredStatusChecks: checksOf(ruleset).map(check => ({ context: check.context, integrationId: check.integration_id ?? null })),
    strict: rule ? rule.parameters?.strict_required_status_checks_policy === true : null, conditions: ruleset.conditions ?? null, bypassActors: ruleset.bypass_actors ?? null };
}
export interface OperatorRulesets { rulesets: any[]; effectiveRules: unknown }
const operatorListed = (listed: any) => !graphyardRulesets.includes(listed?.name) && (listed?.target ?? 'branch') === 'branch' && (listed?.enforcement ?? 'active') === 'active';
/** The operator rulesets governing BRANCH, as full documents, from the listing pages and documents a reader fetched. */
const governing = (documents: any[], branch: string, defaultBranch: string | null) => documents.filter(document => !graphyardRulesets.includes(document?.name) && rulesetGovernsBranch(document, branch, defaultBranch));

/** A GET that must answer: its JSON (null for a 2xx without a document), or a refusal naming WHAT and GitHub's answer. */
async function confirmedGet(api: GhApi, path: string, what: string) {
  const answer = await api(['api', path], { allowFailure: true });
  if (answer.code !== 0) throw new Error(`GitHub did not answer ${what} (gh api ${path} exited ${answer.code}: ${`${answer.stderr}\n${answer.stdout}`.trim().split('\n')[0]}); confirm the gh login administers the repository, then rerun`);
  try { return JSON.parse(answer.stdout); } catch { return null; }
}
/**
 * Every active repository ruleset whose conditions include BRANCH, as full documents, and the branch's
 * effective rules. Any failed read refuses, naming it: an unknown ruleset set must never read as none.
 */
export async function readOperatorRulesets(api: GhApi, repository: string, branch: string): Promise<OperatorRulesets> {
  const listed: any[] = [];
  for (let page = 1; ; page++) {
    const rulesets = await confirmedGet(api, rulesetsPage(repository, page), `page ${page} of the rulesets of ${repository}`);
    const entries = Array.isArray(rulesets) ? rulesets : [];
    listed.push(...entries);
    if (entries.length < 100) break;
  }
  const candidates = listed.filter(operatorListed);
  const defaultBranch = candidates.length ? (await confirmedGet(api, `repos/${repository}`, `the repository ${repository}`))?.default_branch ?? null : null;
  const documents = [];
  for (const entry of candidates) documents.push(await confirmedGet(api, `repos/${repository}/rulesets/${entry.id}`, `ruleset ${entry.id} of ${repository}`));
  const rulesets = governing(documents, branch, defaultBranch);
  const effectiveRules = rulesets.length ? await confirmedGet(api, `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`, `the effective rules of ${repository}@${branch}`) : null;
  return { rulesets, effectiveRules };
}
const failureLine = (error: any) => String(error?.stderr || error?.message || error).trim().split('\n')[0];
const namesDefaultBranch = (document: any) => [...(document?.conditions?.ref_name?.include ?? []), ...(document?.conditions?.ref_name?.exclude ?? [])].includes('~DEFAULT_BRANCH');
/**
 * The synchronous read readProtection makes from the listing it already holds; a failed document read
 * refuses, and so does an unread default branch (undefined) that a ruleset's ~DEFAULT_BRANCH needs.
 */
function readOperatorRulesetsSync(config: { repository: string; baseBranch: string }, run: ProtectionRun, listed: any[], defaultBranch: string | null | undefined, repositoryFailure: unknown) {
  const documents = listed.filter(operatorListed).map(entry => {
    try { return JSON.parse(run('gh', ['api', `repos/${config.repository}/rulesets/${entry.id}`])); }
    catch (error: any) { throw new Error(`GitHub did not answer ruleset ${entry.id} of ${config.repository}: ${failureLine(error)}`); }
  });
  const unresolved = defaultBranch === undefined ? documents.filter(document => !graphyardRulesets.includes(document?.name) && namesDefaultBranch(document)) : [];
  if (unresolved.length) throw new Error(`GitHub did not answer the repository ${config.repository} (${failureLine(repositoryFailure)}), so whether operator ruleset(s) ${unresolved.map(document => `${document.id} (${document.name})`).join(', ')}, which target ~DEFAULT_BRANCH, govern ${config.baseBranch} is unknown; rerun`);
  return governing(documents, config.baseBranch, defaultBranch ?? null);
}

/** The one operator ruleset that already requires checks on the base, or a refusal naming each candidate. */
export function rulesetTarget(rulesets: any[], branch: string): { target: any; refusal: null } | { target: null; refusal: string } {
  const name = (ruleset: any) => `${ruleset.id} (${ruleset.name})`;
  const carrying = rulesets.filter(ruleset => checksOf(ruleset).length > 0);
  if (carrying.length === 1) return { target: carrying[0], refusal: null };
  return { target: null, refusal: carrying.length
    ? `Several operator rulesets require status checks on ${branch}: ${carrying.map(name).join(', ')}; Graphyard adds its checks to exactly one, so merge their required checks into one ruleset, then rerun`
    : `No operator ruleset governing ${branch} requires status checks (governing: ${rulesets.map(name).join(', ') || 'none'}); add a required_status_checks rule to the one Graphyard should extend, then rerun` };
}
/** Null when TARGET is the repository's own ruleset, else why Graphyard cannot write it: an inherited ruleset is edited only where it is defined. */
export function inheritedRefusal(target: any, branch: string) {
  return repositoryOwned(target) ? null : `Operator ruleset ${target.id} (${target.name}), which requires status checks on ${branch}, is inherited from ${target.source_type}${target.source ? ` ${target.source}` : ''}; Graphyard writes rulesets only through the repository's own endpoint and never falls back to classic protection, so add or retire the check in that ${String(target.source_type).toLowerCase()} ruleset yourself, then rerun`;
}
const sameCheck = (left: { context: string; integration_id?: number | null }, right: { context: string; integration_id?: number | null }) => left.context === right.context && (left.integration_id ?? null) === (right.integration_id ?? null);
const graphyardEntries = (githubAppId: number) => GRAPHYARD_CHECKS.map(context => ({ context, integration_id: githubAppId }));
/** The Graphyard entries the ruleset still lacks, bound to the App. */
export const missingGraphyardChecks = (ruleset: any, githubAppId: number) => graphyardEntries(githubAppId).filter(entry => !checksOf(ruleset).some(check => sameCheck(check, entry)));

/** A ruleset document's writable fields: the PUT body, and what a digest and a verification compare. */
export function rulesetBody(ruleset: any) {
  return { name: ruleset?.name, target: ruleset?.target, enforcement: ruleset?.enforcement, bypass_actors: ruleset?.bypass_actors, conditions: ruleset?.conditions, rules: ruleset?.rules };
}
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => (value as any)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}` : JSON.stringify(value ?? null);
export const rulesetDigest = (ruleset: any) => createHash('sha256').update(canonical(rulesetBody(ruleset))).digest('hex');
/** The body with ENTRIES added to (or, with remove, the one entry taken from) its required_status_checks rule; every other field as it was. */
function editChecks(body: ReturnType<typeof rulesetBody>, edit: (checks: any[]) => any[]) {
  return { ...body, rules: body.rules.map((rule: any) => rule?.type === 'required_status_checks' ? { ...rule, parameters: { ...rule.parameters, required_status_checks: edit(rule.parameters.required_status_checks) } } : rule) };
}

export const snapshotFormat = 'graphyard-ruleset-snapshot-v1';
export interface RulesetSnapshot { format: typeof snapshotFormat; repository: string; branch: string; rulesetId: number; takenAt: string; digest: string; document: any }
async function saveSnapshot(directory: string, input: { repository: string; branch: string; document: any; now: number }) {
  const takenAt = new Date(input.now).toISOString();
  const snapshot: RulesetSnapshot = { format: snapshotFormat, repository: input.repository, branch: input.branch, rulesetId: input.document.id, takenAt, digest: rulesetDigest(input.document), document: input.document };
  await mkdir(directory, { recursive: true });
  const file = join(directory, `ruleset-${input.document.id}-${takenAt.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`);
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { file, digest: snapshot.digest };
}
const rulesetPath = (repository: string, id: number) => `repos/${repository}/rulesets/${id}`;
async function putRuleset(api: GhApi, repository: string, id: number, body: unknown) {
  const answer = await api(['api', '--method', 'PUT', rulesetPath(repository, id), '--input', '-'], { input: JSON.stringify(body), allowFailure: true });
  if (answer.code !== 0) throw new Error(`GitHub refused PUT ${rulesetPath(repository, id)} (exited ${answer.code}: ${`${answer.stderr}\n${answer.stdout}`.trim().split('\n')[0]})`);
}
async function readRuleset(api: GhApi, repository: string, id: number) {
  const document = await confirmedGet(api, rulesetPath(repository, id), `ruleset ${id} of ${repository}`);
  if (!document || document.id !== id) throw new Error(`GitHub answered ruleset ${id} of ${repository} with another document; rerun`);
  // A login that cannot administer the repository is answered without bypass actors, and a PUT of that body would clear them.
  if (!Array.isArray(document.bypass_actors) || !document.conditions || !Array.isArray(document.rules)) throw new Error(`GitHub answered ruleset ${id} of ${repository} without its bypass actors, conditions or rules, so a write would change them; the gh login must administer ${repository}`);
  return document;
}

/** The rules a branch-rules answer should hold after EDIT: ruleset ID's required checks edited, every other rule and its provenance as read before. */
function expectedEffective(before: any[], id: number, edit: (checks: any[]) => any[]) {
  return before.map(rule => rule?.ruleset_id === id && rule?.type === 'required_status_checks' ? { ...rule, parameters: { ...rule.parameters, required_status_checks: edit(rule.parameters?.required_status_checks ?? []) } } : rule);
}
/** Null when AFTER holds exactly EXPECTED's rules (in any order), else what is missing and what is unexpected. */
function effectiveMismatch(expected: any[], after: unknown, describe: string) {
  if (!Array.isArray(after)) return `the effective rules of the base read back as ${JSON.stringify(after)}, not a list of rules`;
  const remaining = after.map(canonical), missing: string[] = [];
  for (const rule of expected.map(canonical)) { const at = remaining.indexOf(rule); if (at < 0) missing.push(rule); else remaining.splice(at, 1); }
  return missing.length || remaining.length ? `the effective rules of the base differ from those read before the write by more than ${describe}: missing ${missing.join(', ') || 'nothing'}; unexpected ${remaining.join(', ') || 'nothing'}` : null;
}
const effectivePath = (repository: string, branch: string) => `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`;

/**
 * Snapshot ruleset ID's fresh document and write it with an edit. PREPARE judges the fresh document
 * itself, so every precondition binds to what is written: it refuses by throwing, answers null when
 * there is nothing to write, or answers the edit. The branch's effective rules are read before the
 * write, and after it the ruleset and the effective rules must both differ by exactly that edit; on
 * any mismatch the snapshot is put back and its digest verified, and the refusal reports both.
 */
async function writeRulesetEdit(api: GhApi, input: { repository: string; branch: string; id: number; snapshots: string; now: number; describe: string; prepare: (fresh: any) => ((checks: any[]) => any[]) | null }) {
  // Every governing ruleset is read again just before the write: if another one has since come to
  // require checks, the target is no longer the unique one, and the write refuses rather than proceed.
  const again = await readOperatorRulesets(api, input.repository, input.branch);
  const { target, refusal } = rulesetTarget(again.rulesets, input.branch);
  if (!target) throw new Error(`The operator rulesets on ${input.repository}@${input.branch} changed after they were read: ${refusal}; nothing was written`);
  if (target.id !== input.id) throw new Error(`The operator rulesets on ${input.repository}@${input.branch} changed after they were read: ruleset ${target.id} (${target.name}), not ${input.id}, now requires its checks; nothing was written, so rerun`);
  const fresh = await readRuleset(api, input.repository, input.id);
  const edit = input.prepare(fresh);
  if (!edit) return null;
  const before = await confirmedGet(api, effectivePath(input.repository, input.branch), `the effective rules of ${input.repository}@${input.branch}`);
  if (!Array.isArray(before) || !before.some(rule => rule?.ruleset_id === input.id && rule?.type === 'required_status_checks')) throw new Error(`The effective rules of ${input.repository}@${input.branch} do not show ruleset ${input.id}'s required checks, so a write to it cannot be verified; nothing was written`);
  const snapshot = await saveSnapshot(input.snapshots, { repository: input.repository, branch: input.branch, document: fresh, now: input.now });
  const expected = editChecks(rulesetBody(fresh), edit);
  let mismatch: string | null = null;
  try {
    await putRuleset(api, input.repository, input.id, expected);
    const reread = await readRuleset(api, input.repository, input.id);
    if (canonical(rulesetBody(reread)) !== canonical(expected)) mismatch = `ruleset ${input.id} reads back ${JSON.stringify(rulesetBody(reread))}, not the snapshot with only ${input.describe}`;
    else mismatch = effectiveMismatch(expectedEffective(before, input.id, edit), await confirmedGet(api, effectivePath(input.repository, input.branch), `the effective rules of ${input.repository}@${input.branch}`), input.describe);
  } catch (error: any) { mismatch = error.message; }
  if (!mismatch) return { ruleset: input.id, snapshot: snapshot.file, digest: snapshot.digest, written: rulesetBody(expected) };
  const rollback = await restoreDocument(api, input.repository, fresh).then(digest => `rolled ruleset ${input.id} back to ${snapshot.file}; it reads back digest ${digest}, ${digest === snapshot.digest ? 'equal to' : 'NOT equal to'} the snapshot's ${snapshot.digest}`, (error: any) => `rolling ruleset ${input.id} back to ${snapshot.file} failed: ${error.message}`);
  throw new Error(`Writing ${input.describe} to ruleset ${input.id} did not verify: ${mismatch}; ${rollback}`);
}
/** PUT a saved document back to its ruleset and answer the digest it reads back with. */
async function restoreDocument(api: GhApi, repository: string, document: any) {
  await putRuleset(api, repository, document.id, rulesetBody(document));
  return rulesetDigest(await readRuleset(api, repository, document.id));
}

export interface RulesetWriteConfig { repository: string; baseBranch: string; githubAppId: number; snapshots: string; now: number }
/** AC-2's add: both Graphyard checks from the App joined to the one operator ruleset requiring checks on the base. Writes nothing when both stand. */
export async function applyOperatorRulesetAdd(api: GhApi, config: RulesetWriteConfig) {
  const { rulesets } = await readOperatorRulesets(api, config.repository, config.baseBranch);
  const { target, refusal } = rulesetTarget(rulesets, config.baseBranch);
  if (!target) throw new Error(refusal!);
  const standing = { applied: false, ruleset: target.id, result: `operator ruleset ${target.id} (${target.name}) already requires ${GRAPHYARD_CHECKS.join(' and ')} from App ${config.githubAppId}; nothing was written` };
  const missing = missingGraphyardChecks(target, config.githubAppId);
  if (!missing.length) return standing;
  const inherited = inheritedRefusal(target, config.baseBranch);
  if (inherited) throw new Error(inherited);
  // Requiring a check the App has never published would block every pull request, so the add waits for it.
  if (missing.some(entry => entry.context === CHECK_NAME)) {
    // Only a run named Graphyard / merge from the App counts: its install-verification check publishes independently of it.
    const published = await confirmedGet(api, `repos/${config.repository}/commits/${config.baseBranch}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&app_id=${config.githubAppId}&filter=all&per_page=100`, `the ${CHECK_NAME} runs on ${config.repository}@${config.baseBranch}`);
    if (!(published?.check_runs ?? []).some((run: any) => run?.name === CHECK_NAME && Number(run?.app?.id) === config.githubAppId)) throw new Error(`App ${config.githubAppId} has not yet published ${CHECK_NAME} on ${config.baseBranch}, so requiring it in operator ruleset ${target.id} (${target.name}) would block every pull request; nothing was written. Once Graphyard has published it on a pull request, rerun graphyard master protection --apply`);
  }
  const written = await writeRulesetEdit(api, { repository: config.repository, branch: config.baseBranch, id: target.id, snapshots: config.snapshots, now: config.now,
    describe: missing.map(entry => `${entry.context}@${entry.integration_id}`).join(' and ') + ' added',
    prepare: fresh => {
      // The fresh document decides: it must still carry the required-checks rule, and what it already has is not added again.
      if (!checksRule(fresh)) throw new Error(`Operator ruleset ${target.id} (${target.name}) no longer requires status checks on ${config.baseBranch}; rerun`);
      return missingGraphyardChecks(fresh, config.githubAppId).length ? checks => [...checks, ...graphyardEntries(config.githubAppId).filter(entry => !checks.some(check => sameCheck(check, entry)))] : null;
    } });
  if (!written) return standing;
  return { applied: true, ...written, added: missing, result: `operator ruleset ${target.id} (${target.name}) now requires ${GRAPHYARD_CHECKS.join(' and ')} from App ${config.githubAppId}; every other rule, condition, bypass actor and check is unchanged, and the snapshot taken before the write is ${written.snapshot}` };
}

/** CONTEXT@INTEGRATION, the integration a number (or `any` for a check any source may satisfy). */
export function parseRetiredCheck(value: string) {
  const at = value.lastIndexOf('@'), context = value.slice(0, at), integration = value.slice(at + 1);
  if (at <= 0 || !(integration === 'any' || /^\d+$/.test(integration))) throw new Error(`--retire takes CONTEXT@INTEGRATION (an integration id, or any), not ${value}`);
  return { context, integration_id: integration === 'any' ? null : Number(integration) };
}
/** The latest run of CHECK on SHA's check runs, by GitHub's run id. */
const latestRun = (runs: any[], check: { context: string; integration_id?: number | null }) => runs.filter(run => run?.name === check.context && (check.integration_id == null || Number(run?.app?.id) === check.integration_id)).sort((left, right) => Number(right.id) - Number(left.id))[0];
/**
 * AC-3's retire: one named non-Graphyard check leaves the base's operator ruleset, only when that
 * ruleset already requires both Graphyard checks from the App and, on the proof pull request's exact
 * head, the latest run of each Graphyard check and of every check that stays required succeeded.
 */
export async function retireOperatorRulesetCheck(api: GhApi, config: RulesetWriteConfig & { check: { context: string; integration_id: number | null }; proof: number }) {
  const label = `${config.check.context}@${config.check.integration_id ?? 'any'}`;
  const refuse = (reason: string) => { throw new Error(`Refusing to retire ${label}: ${reason}`); };
  if ((GRAPHYARD_CHECKS as readonly string[]).includes(config.check.context)) refuse(`${config.check.context} is one of Graphyard's own checks`);
  const { rulesets } = await readOperatorRulesets(api, config.repository, config.baseBranch);
  const { target, refusal } = rulesetTarget(rulesets, config.baseBranch);
  if (!target) return refuse(refusal!);
  const inherited = inheritedRefusal(target, config.baseBranch);
  if (inherited) refuse(inherited);
  // The ruleset's requirements, judged on the discovered document and again on the fresh one the write edits.
  const judge = (document: any) => {
    const missing = missingGraphyardChecks(document, config.githubAppId);
    if (missing.length) refuse(`operator ruleset ${target.id} does not yet require ${missing.map(entry => entry.context).join(' and ')} from App ${config.githubAppId}; run master protection --apply first`);
    if (!checksOf(document).some(check => sameCheck(check, config.check))) refuse(`operator ruleset ${target.id} does not require ${label}`);
  };
  judge(target);
  const pull = async () => confirmedGet(api, `repos/${config.repository}/pulls/${config.proof}`, `pull request #${config.proof} of ${config.repository}`);
  const before = await pull(), sha = String(before?.head?.sha ?? '');
  if (!/^[0-9a-f]{40}$/.test(sha)) refuse(`pull request #${config.proof} has no readable head`);
  if (before?.base?.ref !== config.baseBranch) refuse(`pull request #${config.proof} targets ${before?.base?.ref}, not ${config.baseBranch}`);
  const runs: any[] = [];
  for (let page = 1; ; page++) {
    const answer = await confirmedGet(api, `repos/${config.repository}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`, `page ${page} of the check runs on ${sha}`);
    const entries = Array.isArray(answer?.check_runs) ? answer.check_runs : [];
    runs.push(...entries);
    if (entries.length < 100) break;
  }
  /** Every check DOCUMENT keeps after the removal must have succeeded on the proof head. */
  const prove = (document: any) => {
    const unproven = checksOf(document).filter(check => !sameCheck(check, config.check)).flatMap(check => { const run = latestRun(runs, check); return run?.status === 'completed' && run?.conclusion === 'success' ? [] : [`${check.context}@${check.integration_id ?? 'any'} ${run ? `reads ${run.status}/${run.conclusion}` : 'has no run'}`]; });
    if (unproven.length) refuse(`on #${config.proof}'s head ${sha} the latest run of ${unproven.join('; ')}`);
  };
  prove(target);
  if (String((await pull())?.head?.sha ?? '') !== sha) refuse(`pull request #${config.proof}'s head moved from ${sha} while its runs were read; rerun`);
  const written = await writeRulesetEdit(api, { repository: config.repository, branch: config.baseBranch, id: target.id, snapshots: config.snapshots, now: config.now, describe: `${label} removed`,
    prepare: fresh => { judge(fresh); prove(fresh); return checks => checks.filter(check => !sameCheck(check, config.check)); } });
  return { retired: label, proof: { pullRequest: config.proof, head: sha }, ...written!, result: `operator ruleset ${target.id} (${target.name}) no longer requires ${label}; the snapshot taken before the write is ${written!.snapshot}` };
}

/** `master protection --restore SNAPSHOT`: PUT the saved document back to its ruleset and verify the digest. */
export async function restoreRulesetSnapshot(api: GhApi, config: { repository: string }, file: string) {
  let snapshot: RulesetSnapshot;
  try { snapshot = JSON.parse(await readFile(file, 'utf8')); } catch (error: any) { throw new Error(`The ruleset snapshot ${file} cannot be read: ${error.message}`); }
  if (snapshot?.format !== snapshotFormat || !Number.isSafeInteger(snapshot.rulesetId) || snapshot.document?.id !== snapshot.rulesetId) throw new Error(`${file} is not a ${snapshotFormat} ruleset snapshot`);
  if (snapshot.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error(`The ruleset snapshot ${file} is for ${snapshot.repository}, not ${config.repository}`);
  if (rulesetDigest(snapshot.document) !== snapshot.digest) throw new Error(`The ruleset snapshot ${file} does not match its own digest ${snapshot.digest}; it was changed after it was taken`);
  const observed = await restoreDocument(api, snapshot.repository, snapshot.document);
  if (observed !== snapshot.digest) throw new Error(`Ruleset ${snapshot.rulesetId} was written from ${file} but reads back digest ${observed}, not the snapshot's ${snapshot.digest}`);
  return { restored: true, verified: true, ruleset: snapshot.rulesetId, snapshot: file, digest: observed };
}
