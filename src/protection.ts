import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHECK_NAME } from './model.js';
import { LANDABLE_CHECK } from './landable-check.js';

export type ProtectionRun = (command: string, args: string[], input?: string) => string;
export const protectionRun: ProtectionRun = (command, args, input) => execFileSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });

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
