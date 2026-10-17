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

/** Where an operator-ruleset write saves its snapshots: the managed checkout's `.graphyard/protection-snapshots/`. */
export const protectionSnapshots = (root: string) => join(root, '.graphyard', 'protection-snapshots');

// ---- Operator rulesets (GY-1926) ---------------------------------------------------------------
// A base branch may be governed by the operator's own repository rulesets instead of classic
// protection, whose GET then answers 404 "Branch not protected": that means no classic protection,
// never an unprotected branch. Graphyard then writes no classic protection at all. It adds its two
// App-bound checks to the one operator ruleset that already requires checks on the base, and that
// write snapshots the ruleset first, re-reads and verifies it, and puts the snapshot back on any
// mismatch. Every other ruleset, and every other field of that one, stays as the operator wrote it.

/** One `gh` call, as the installer's GitHubCli makes it. */
export interface GhAnswer { stdout: string; stderr: string; code: number }
export type GhApi = (args: string[], options?: { input?: string; allowFailure?: boolean }) => Promise<GhAnswer>;
// The merge-writer ruleset is named so an install that still carries it never reads it as the operator's.
const graphyardRulesets: string[] = [mergeQueueRulesetName, 'Graphyard merge writer only'];
// Inherited rulesets are listed too: an organization ruleset governs the base exactly as a repository one does.
const rulesetsPage = (repository: string, page: number) => `repos/${repository}/rulesets?includes_parents=true&per_page=100&page=${page}`;
/** Whether a ruleset is the repository's own, so writable through its repository endpoint (a listing without source_type predates inheritance). */
const repositoryOwned = (ruleset: any) => (ruleset?.source_type ?? 'Repository') === 'Repository';

/** An fnmatch glob as a regular expression source: `*` within one segment, `**` then a slash zero or more directories, a bare `**` across them, `?`, `[set]`, `[!set]`/`[^set]` and `\\` escapes. */
function fnmatchSource(glob: string) {
  const literal = (char: string) => char.replace(/[.+^${}()|[\]\\*?\/-]/g, '\\$&');
  let source = '';
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at];
    if (char === '\\' && at + 1 < glob.length) source += literal(glob[++at]);
    // `**/` spans zero or more whole directories (File::FNM_PATHNAME), so `qa/**/*` matches `qa/foo` too.
    else if (char === '*' && glob[at + 1] === '*' && glob[at + 2] === '/') { source += '(?:[^/]*/)*'; at += 2; }
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
/** How many of the base's most recently updated pull requests are searched for the App's merge check. */
const publicationPulls = 30;
/**
 * Whether App APP has published Graphyard / merge where a pull request into BRANCH reads it: on the
 * branch's tip (a merge-queue run) or on the head of one of its most recently updated pull requests,
 * where GitHubClient.publish writes it. Only a run of that name from the App counts: its
 * install-verification check publishes independently of it. Any failed read refuses.
 */
async function mergeCheckPublished(api: GhApi, repository: string, branch: string, app: number) {
  const carries = async (ref: string) => {
    const answer = await confirmedGet(api, `repos/${repository}/commits/${ref}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&app_id=${app}&filter=all&per_page=100`, `the ${CHECK_NAME} runs on ${repository}@${ref}`);
    return (answer?.check_runs ?? []).some((run: any) => run?.name === CHECK_NAME && Number(run?.app?.id) === app);
  };
  if (await carries(branch)) return true;
  const pulls = await confirmedGet(api, `repos/${repository}/pulls?state=all&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=${publicationPulls}`, `the pull requests into ${repository}@${branch}`);
  const heads = new Set((Array.isArray(pulls) ? pulls : []).filter(pull => pull?.base?.ref === branch).map(pull => String(pull?.head?.sha ?? '')).filter(sha => /^[0-9a-f]{40}$/.test(sha)));
  for (const sha of heads) if (await carries(sha)) return true;
  return false;
}
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
    if (!await mergeCheckPublished(api, config.repository, config.baseBranch, config.githubAppId)) throw new Error(`App ${config.githubAppId} has not yet published ${CHECK_NAME} on ${config.baseBranch} or on the head of any of its ${publicationPulls} most recently updated pull requests, so requiring it in operator ruleset ${target.id} (${target.name}) would block every pull request; nothing was written. Once Graphyard has published it on a pull request into ${config.baseBranch}, rerun graphyard install --apply`);
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
