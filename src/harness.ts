import { execFileSync } from 'node:child_process';
import { chmod, lstat, readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';

export type ApprovalMode = 'auto' | 'prompt';
export interface LaunchRecipe { args: string[]; environment: Record<string, string>; prompts: string; tradeoff: string }

// Per-runtime startup contracts that remove the approval and workspace-trust prompts a freshly
// launched session blocks on. These are runtime CLI contracts, not Graphyard authority: a session
// that never asks can still only act inside its own assigned worktree and its own credentials.
export const nonInteractiveLaunch: Record<string, LaunchRecipe> = {
  claude: { args: ['--permission-mode', 'bypassPermissions'], environment: {}, prompts: 'tool-approval prompts on first use of each command class',
    tradeoff: 'Claude Code stops classifying commands for this session; everything the agent proposes runs without asking.' },
  codex: { args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'], environment: {}, prompts: 'directory-trust and per-command approval prompts',
    tradeoff: 'Codex never asks for approval; only its workspace-write sandbox still limits what a command can touch.' },
  cursor: { args: ['--force', '--trust'], environment: {}, prompts: "the 'Run Everything' approval and the fresh-worktree workspace-trust prompt",
    tradeoff: 'cursor-agent runs every command it proposes in the assigned worktree and trusts that worktree without asking.' },
  opencode: { args: [], environment: { OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","webfetch":"allow"}' }, prompts: 'edit, bash, and webfetch permission prompts',
    tradeoff: 'opencode edits files, runs shell commands, and fetches URLs without asking.' },
};

export function launchPlan(kind: string | undefined, approvals: ApprovalMode = 'auto', agentArgs: string[] = [], environment: Record<string, string> = {}) {
  const recipe = kind ? nonInteractiveLaunch[kind] : undefined;
  const base = { approvals, args: [...agentArgs], environment: {} as Record<string, string>, applied: false, prompts: recipe?.prompts ?? null, tradeoff: recipe?.tradeoff ?? null };
  if (!recipe) return { ...base, reason: kind ? `Graphyard has no non-interactive launch contract for ${kind}; the session may block on its own approval prompt` : 'A launched session requires an agent kind' };
  if (approvals === 'prompt') return { ...base, reason: 'This profile opted out; a human must answer the runtime approval prompts in the session tab' };
  // An operator who already configured the runtime's approval flags keeps exactly those arguments.
  const overridden = recipe.args.some(argument => argument.startsWith('-') && agentArgs.includes(argument)) || Object.keys(recipe.environment).some(name => name in environment);
  if (overridden) return { ...base, reason: 'This profile already configures the runtime approval flags; Graphyard added nothing' };
  return { ...base, args: [...recipe.args, ...agentArgs], environment: { ...recipe.environment }, applied: true, reason: null };
}

export interface HarnessRule { rule: string; why: string }
export interface HarnessPlan { harness: string; file: string | null; allow: HarnessRule[]; deny: HarnessRule[]; manual: string | null; note: string }

// The master's own loop, and nothing else. A harness allowlist is a prompt policy, not an
// authority boundary: branch protection and Graphyard's required check remain the enforcement.
export function masterHarnessPlan(input: { harness: string; root: string; cliPath: string; repository: string; credentialHome: string }): HarnessPlan {
  const note = 'These rules remove operator keypresses from the master\'s own routine commands. They grant no merge path and no credential read; the enforced merge boundary stays branch protection plus the App-bound Graphyard check.';
  if (input.harness === 'codex') return { harness: 'codex', file: null, allow: [], deny: [], note,
    manual: `# Add to $CODEX_HOME/config.toml (default ~/.codex/config.toml)\n[projects.${JSON.stringify(input.root)}]\ntrust_level = "trusted"\n` };
  if (input.harness !== 'claude') return { harness: input.harness, file: null, allow: [], deny: [], manual: null,
    note: `Graphyard generates harness permissions for Claude Code and trust configuration for Codex; ${input.harness} has no generated rules, so its own approval configuration applies.` };
  const cli = `node ${input.cliPath}`;
  const allow: HarnessRule[] = [
    { rule: `Bash(${cli} master:*)`, why: 'Run the master\'s own coordinator commands: status, dispatch, review, reviewer, protection, harness, run, merge, and guide.' },
    { rule: `Bash(${cli} status:*)`, why: 'Read control-plane and work-item status without an operator keypress.' },
    { rule: `Bash(${cli} diagnose:*)`, why: 'Explain a refusing gate for an item the master is routing.' },
    { rule: `Bash(${cli} events:*)`, why: 'Read the immutable history the master reports from.' },
    { rule: `Bash(${cli} list)`, why: 'List every open work item when reporting the board to the operator.' },
    { rule: `Bash(${cli} next)`, why: 'List claimable work before dispatch.' },
    { rule: 'Bash(herdr:*)', why: 'Observe and control the sessions the master launched; Herdr never changes Graphyard ownership.' },
    { rule: 'Bash(gh pr view:*)', why: 'Read the pull request behind a candidate.' },
    { rule: 'Bash(gh pr list:*)', why: 'Find the pull request for an item.' },
    { rule: 'Bash(gh pr diff:*)', why: 'Read the candidate diff while routing or triaging a review.' },
    { rule: 'Bash(gh pr checks:*)', why: 'Read CI results for a candidate.' },
    { rule: `Bash(node ${resolve(input.root, 'scripts/resolve-thread.mjs')}:*)`, why: 'Resolve a review thread the master has audited. The wrapper sends only resolveReviewThread, so it cannot merge or change protection.' },
    { rule: 'Bash(jq:*)', why: 'Filter the JSON that the commands above print, without leaving the session.' },
    { rule: 'Write(./.graphyard/profiles/**)', why: 'Write the worker and reviewer profile files the master installs with master worker add and master reviewer add.' },
    { rule: 'Edit(./.graphyard/profiles/**)', why: 'Revise those profile files; they contain no credential, only a path to one.' },
  ];
  const deny: HarnessRule[] = [
    { rule: 'Bash(gh pr merge:*)', why: 'Delivery happens only through graphyard master merge, which rechecks the exact candidate, every gate, and protection immediately before merging.' },
    { rule: 'Bash(gh api:*)', why: 'Raw API calls could merge, change branch protection, or mint credentials. The master\'s routine reads and thread resolution are covered above.' },
    { rule: 'Bash(git push:*)', why: 'The master implements nothing and pushes nothing.' },
    { rule: `Read(//${input.credentialHome}/**)`, why: 'Coordinator, worker, and reviewer credentials live here; the master uses them through the CLI and never reads their bytes.' },
    { rule: 'Read(./.graphyard/connection.json)', why: 'Holds an individual Graphyard credential.' },
    { rule: 'Read(./.graphyard/credentials.json)', why: 'Holds local principal credentials.' },
    { rule: 'Read(./.graphyard/github-app.json)', why: 'Holds the control-plane App private key.' },
    { rule: 'Read(**/*.pem)', why: 'App private keys are never read into a session transcript.' },
    { rule: 'Read(**/*.token)', why: 'Token files are never read into a session transcript.' },
    { rule: 'Bash(cat:*)', why: 'Reading files goes through the Read tool, where the credential rules above apply.' },
  ];
  return { harness: 'claude', file: '.claude/settings.local.json', allow, deny, manual: null, note };
}

async function ignoredByGit(root: string, path: string) {
  try { execFileSync('git', ['check-ignore', '--quiet', '--', path], { cwd: root, stdio: 'ignore' }); return true; }
  catch (error: any) { if (error.status === 1) return false; throw new Error('Cannot verify that Git ignores the generated harness settings'); }
}
async function assertIgnored(root: string, path: string) {
  if (await ignoredByGit(root, path)) return;
  const file = resolve(root, '.gitignore');
  let existing = ''; try { existing = await readFile(file, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(file, `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}${path}\n`);
  if (!await ignoredByGit(root, path)) throw new Error(`Machine-specific harness settings must be ignored by Git; add ${path} to .gitignore`);
}

const missing = (rules: HarnessRule[], present: unknown) => rules.filter(entry => !(Array.isArray(present) ? present : []).includes(entry.rule));
export async function writeHarnessPermissions(root: string, plan: HarnessPlan, apply = false) {
  if (!plan.file) return { harness: plan.harness, file: null, applied: false, added: [], manual: plan.manual, note: plan.note };
  const file = resolve(root, plan.file);
  if (isAbsolute(plan.file) || !file.startsWith(`${resolve(root)}/`)) throw new Error('Harness settings must stay inside the managed repository');
  let settings: any = {};
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error('Refusing to replace non-regular harness settings');
    settings = JSON.parse(await readFile(file, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Existing harness settings are not a JSON object; resolve them before generating rules');
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const permissions = settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions) ? settings.permissions : {};
  const addedAllow = missing(plan.allow, permissions.allow), addedDeny = missing(plan.deny, permissions.deny);
  const added = [...addedAllow.map(entry => ({ list: 'allow' as const, ...entry })), ...addedDeny.map(entry => ({ list: 'deny' as const, ...entry }))];
  if (!apply) return { harness: plan.harness, file: plan.file, applied: false, added, manual: plan.manual, note: plan.note };
  // Operator-added entries are never removed; generation only adds the master's own rules.
  const next = { ...settings, permissions: { ...permissions, allow: [...(permissions.allow ?? []), ...addedAllow.map(entry => entry.rule)], deny: [...(permissions.deny ?? []), ...addedDeny.map(entry => entry.rule)] } };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await assertIgnored(root, plan.file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file); await chmod(file, 0o600);
  return { harness: plan.harness, file: plan.file, applied: true, added, manual: plan.manual, note: plan.note };
}
