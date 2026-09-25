import { ChildProcessError, defaultChildRun } from './child-runner.js';
import { chmod, lstat, readFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { endedRuntimeStates, type RuntimeStates } from './model/sessions.js';
import { temporaryDirectories, underTestRunner } from './supervisor.js';

export type ApprovalMode = 'auto' | 'prompt';
/**
 * A runtime's no-approval startup contract. `args` are its flags (a flag followed by a bare word
 * takes that word as its value); `equivalents` are operator flags that already select the same
 * no-approval mode, so the recipe adds nothing beside them; `settable` are recipe flags whose
 * value an operator may choose because no value of them brings a prompt back (Codex's sandbox);
 * `aliases` map a short spelling onto its recipe flag; `permits` judges an operator's own value
 * of a recipe variable, which otherwise must equal the recipe's; `config` names the runtime's
 * generic `key=value` override flags and the keys whose value is pinned to the recipe's (Codex's
 * `-c approval_policy=…` would otherwise bring the approval prompt back past `--ask-for-approval`);
 * `trust` records the session's working directory as trusted where the runtime has no flag for it,
 * before the session starts, given the launch's arguments (Claude Code's folder-trust dialog).
 */
export interface LaunchRecipe { args: string[]; environment: Record<string, string>; prompts: string; tradeoff: string; trust?: (directory: string, environment: Record<string, string>, args: string[]) => Promise<FolderTrust>; equivalents?: string[]; settable?: string[]; aliases?: Record<string, string>; permits?: Record<string, (value: string) => boolean>; config?: { flags: string[]; pins: Record<string, string> } }
/** A permission document that answers nothing with "ask", at any depth: OpenCode's prompting value. */
export function asksNothing(value: string) {
  let document: unknown;
  try { document = JSON.parse(value); } catch { return false; }
  const asks = (node: unknown): boolean => node === 'ask' || (!!node && typeof node === 'object' && Object.values(node).some(asks));
  return !asks(document);
}

// Per-runtime startup contracts that remove the approval and workspace-trust prompts a freshly
// launched session blocks on. These are runtime CLI contracts, not Graphyard authority: a session
// that never asks can still only act inside its own assigned worktree and its own credentials.
export const nonInteractiveLaunch: Record<string, LaunchRecipe> = {
  claude: { args: ['--permission-mode', 'bypassPermissions'], environment: {}, equivalents: ['--dangerously-skip-permissions'], trust: trustClaudeFolder, prompts: 'tool-approval prompts on first use of each command class, and the folder-trust dialog in a folder it has not been trusted in',
    tradeoff: 'Claude Code stops classifying commands for this session and trusts its working directory without asking wherever that loads none of the repository\'s own Claude settings; everything the agent proposes runs without asking.' },
  codex: { args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'], environment: {}, equivalents: ['--dangerously-bypass-approvals-and-sandbox', '--yolo'], settable: ['--sandbox'], aliases: { '-a': '--ask-for-approval', '-s': '--sandbox' }, config: { flags: ['-c', '--config'], pins: { approval_policy: 'never' } }, prompts: 'directory-trust and per-command approval prompts',
    tradeoff: 'Codex never asks for approval; only its workspace-write sandbox still limits what a command can touch.' },
  cursor: { args: ['--force', '--trust'], environment: {}, prompts: "the 'Run Everything' approval and the fresh-worktree workspace-trust prompt",
    tradeoff: 'cursor-agent runs every command it proposes in the assigned worktree and trusts that worktree without asking.' },
  opencode: { args: [], environment: { OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","webfetch":"allow"}' }, permits: { OPENCODE_PERMISSION: asksNothing }, prompts: 'edit, bash, and webfetch permission prompts',
    tradeoff: 'opencode edits files, runs shell commands, and fetches URLs without asking.' },
  // Pi has no approval or trust prompt to suppress: every tool it has runs without asking.
  pi: { args: [], environment: {}, prompts: 'none: pi has no approval or workspace-trust prompts',
    tradeoff: 'pi runs every tool it proposes in the assigned worktree; it has no approval step to turn off.' },
  gemini: { args: ['--yolo'], environment: {}, prompts: 'per-tool approval prompts',
    tradeoff: 'Gemini CLI approves every tool call it proposes (YOLO mode) without asking.' },
  qwen: { args: ['--yolo'], environment: {}, prompts: 'per-tool approval prompts',
    tradeoff: 'Qwen Code approves every tool call it proposes (YOLO mode) without asking.' },
  copilot: { args: ['--allow-all-tools', '--allow-all-paths'], environment: {}, prompts: 'per-tool approval and path-access prompts',
    tradeoff: 'Copilot CLI runs every tool and reaches every path it proposes without asking.' },
  muse: { args: ['--approval-mode', 'never', '--trust-workspace'], environment: {}, prompts: 'approval and workspace-trust prompts',
    tradeoff: 'Muse never asks for approval and trusts the assigned worktree without asking.' },
};

/**
 * Claude Code asks "Do you trust the files in this folder?" the first time it starts in a folder
 * that neither it nor any ancestor has been trusted in, and `--permission-mode bypassPermissions`
 * does not skip that dialog: a worker in a fresh worktree outside the trusted checkout, or a
 * session under a fresh account home, would wait at it for a human. The dialog's "Yes, proceed"
 * records `hasTrustDialogAccepted` for the folder in the global config of the account the session
 * reads (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`).
 *
 * That record also lets Claude Code load the folder's own configuration — the repository's
 * checked-in `.claude/settings.json` with its hooks, its `.mcp.json` — under the session's
 * credentials, which the launcher never grants on its own (consent-prompt.ts). A
 * `settings.local.json` that git ignores there is the operator's or Graphyard's own (a worker's is
 * written by installWorkerHarness only into a worktree that ignores it); one git tracks or would
 * track is the repository's, and counts. So Graphyard records it only where it enables none of that: for a launch
 * whose `--setting-sources` leaves out `project`, as every session under
 * a repository that carries Claude settings is launched with its role file (master.ts
 * prepareSessionHarness), or for a folder that, with its ancestors, carries no such configuration.
 * A folder already trusted, itself or through an ancestor, launches as it is; any other launch is
 * refused, naming the runtime, the file and the fix, rather than started into the dialog (GY-184).
 *
 * The config is shared by every session of the account, so the record is a read-modify-write
 * under a lock beside it (`FILE.graphyard.lock`, a directory, taken over once stale), and is read
 * back after the rename: a running Claude Code that rewrote the file in between takes the record
 * with it, and the write is tried again. A config that cannot be read as JSON, locked or written
 * refuses the launch. Under the test runner only a config in the temporary directory is written: a
 * stubbed launch starts no runtime, and the operator's own config is never the suite's to edit.
 */
export interface FolderTrust { file: string; directory: string; written: boolean }
export const claudeConfigFile = (environment: Record<string, string> = {}) => {
  const home = environment.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  return home ? resolve(home, '.claude.json') : resolve(homedir(), '.claude.json');
};
const canonicalPath = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const ancestors = (path: string) => { const chain = [path]; while (dirname(chain[chain.length - 1]) !== chain[chain.length - 1]) chain.push(dirname(chain[chain.length - 1])); return chain; };
/** Whether a Claude Code launch loads the repository's checked-in settings: it does unless `--setting-sources` leaves `project` out. */
export const repositorySettingSources = ['project'] as const;
export function loadsRepositorySettings(args: string[]) {
  const named: string[][] = [];
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index].split(/=(.*)/s);
    if (flag === '--setting-sources') named.push((inline ?? args[index + 1] ?? '').split(',').map(source => source.trim()));
  }
  return !named.length || named.some(sources => sources.some(source => (repositorySettingSources as readonly string[]).includes(source)));
}
/** Whether git ignores `name` in `folder`: false for a tracked or unignored file, and outside a repository, so an unknown file counts as the repository's. */
const gitIgnores = (folder: string, name: string) => Promise.resolve(defaultChildRun('git', ['check-ignore', '--quiet', '--', name], { cwd: folder })).then(() => true, () => false);
/** The first repository-controlled Claude configuration the folder or an ancestor carries (never the account's own config home), or null. */
export async function repositoryClaudeConfig(folder: string, environment: Record<string, string> = {}) {
  const homes = new Set([resolve(homedir(), '.claude'), environment.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR].filter((home): home is string => !!home).map(canonicalPath));
  for (const path of ancestors(folder)) {
    const candidates = [...(homes.has(canonicalPath(resolve(path, '.claude'))) ? [] : ['.claude/settings.json', '.claude/settings.local.json']), '.mcp.json'];
    for (const name of candidates) if (existsSync(resolve(path, name)) && !(name === '.claude/settings.local.json' && await gitIgnores(path, name))) return resolve(path, name);
  }
  return null;
}
export const claudeTrustLockStaleMs = 30_000;
async function withConfigLock<T>(file: string, body: () => Promise<T>, waitMs = 10_000): Promise<T> {
  const lock = `${file}.graphyard.lock`, deadline = Date.now() + waitMs;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A launcher that died holding the lock leaves it behind; one older than any write takes is taken over.
      const held = await stat(lock).then(entry => Date.now() - entry.mtimeMs, () => 0);
      if (held > claudeTrustLockStaleMs) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`another launch has held ${lock} for ${Math.round(held / 1000)}s`);
      await new Promise(done => setTimeout(done, 25));
    }
  }
  try { return await body(); } finally { await rm(lock, { recursive: true, force: true }); }
}
export async function trustClaudeFolder(directory: string, environment: Record<string, string> = {}, args: string[] = []): Promise<FolderTrust> {
  const file = claudeConfigFile(environment), folder = canonicalPath(directory);
  if (underTestRunner() && !temporaryDirectories().some(temporary => canonicalPath(file).startsWith(`${temporary}${sep}`))) return { file, directory: folder, written: false };
  const refuse = (why: string) => new LaunchRefusedError('claude', `Graphyard refuses to launch the claude runtime in ${folder}: ${why}, so the session would stop at Claude Code's folder-trust dialog for a human.`);
  const read = async () => {
    let document: Record<string, any> = {};
    try { document = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw refuse(`its config ${file} could not be read as JSON (${error instanceof Error ? error.message : String(error)}); fix or remove it, then launch again`);
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw refuse(`its config ${file} is not a JSON object; fix or remove it, then launch again`);
    const projects: Record<string, any> = document.projects && typeof document.projects === 'object' ? document.projects : {};
    return { document, projects, trusted: ancestors(folder).some(path => projects[path]?.hasTrustDialogAccepted === true) };
  };
  if ((await read()).trusted) return { file, directory: folder, written: false };
  const carried = loadsRepositorySettings(args) ? await repositoryClaudeConfig(folder, environment) : null;
  if (carried) throw refuse(`the folder is not trusted in ${file}, and it carries the repository's own Claude configuration ${carried}, which this launch loads (no --setting-sources that leaves out ${repositorySettingSources.join(', ')}) and recording the folder as trusted would let run under the session's credentials. Launch it with --setting-sources user, or trust the folder once as the operator by starting Claude Code there`);
  for (let attempt = 1; ; attempt++) {
    try {
      const recorded = await withConfigLock(file, async () => {
        const { document, projects, trusted } = await read();
        if (trusted) return false;
        const staged = `${file}.graphyard-${randomUUID()}`;
        await writeFile(staged, `${JSON.stringify({ ...document, projects: { ...projects, [folder]: { ...projects[folder], hasTrustDialogAccepted: true } } }, null, 2)}\n`, { mode: 0o600 });
        await rename(staged, file);
        return true;
      });
      if ((await read()).trusted) return { file, directory: folder, written: recorded };
      if (attempt >= 3) throw refuse(`the folder's trust record in ${file} was overwritten ${attempt} times by another writer of that config`);
    } catch (error) {
      if (error instanceof LaunchRefusedError) throw error;
      throw refuse(`the folder could not be recorded as trusted in ${file} (${error instanceof Error ? error.message : String(error)}); fix the config's directory, then launch again`);
    }
  }
}

/**
 * Runtimes Graphyard accepts in a profile but cannot yet start unattended: none has both a known
 * flag or variable that suppresses its approval and trust prompts for an interactive session and a
 * command-line way to hand that session its first request (Kimi and Amp take a prompt only in a
 * one-shot mode that exits, so their request would have to be pasted, which a session may rightly
 * refuse). Each is refused before launch, naming the runtime, rather than started into a session
 * that waits for a keypress no one sends (GY-184). A runtime moves out of this list by gaining a
 * recipe above and a request contract in master.ts `launchRequestContracts`.
 */
export const refusedLaunchKinds = ['kimi', 'amp', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'kiro', 'droid', 'grok', 'hermes', 'kilo', 'qodercli', 'maki'] as const;
export class LaunchRefusedError extends Error { constructor(readonly kind: string, message?: string) {
  super(message ?? `Graphyard refuses to launch the ${kind} runtime: it has no non-interactive launch contract for ${kind} (no-approval flags and a first request on its command line), so the session would stop at its own approval or trust prompt or never receive its instruction. Choose a runtime with a launch recipe (${Object.keys(nonInteractiveLaunch).join(', ')}) for this profile or registry role.`);
} }
/** The runtime's launch recipe, or a refusal naming the runtime when there is none. */
export function assertLaunchRecipe(kind: string): LaunchRecipe {
  const recipe = nonInteractiveLaunch[kind];
  if (!recipe) throw new LaunchRefusedError(kind);
  return recipe;
}
/**
 * The launch contract a registry runtime brings with it (model/registry.ts): its own startup
 * arguments and environment are that runtime's no-approval mode, registered by the operator who
 * added it, so a kind Graphyard has no built-in recipe for still launches from it. A registry
 * contract that registers neither names no way past the runtime's prompts and is refused like a
 * runtime without a recipe, naming the runtime and the fix.
 */
/**
 * Where a registry runtime (GY-91) takes its first request: the argument `{request}` in its launch
 * contract's arguments stands for it, as `{home}` stands for the account home in its login
 * command, and master.ts `launchCommand` replaces it with the request file's text (`--message
 * {request}`, or a bare `{request}` for a positional prompt). It suppresses no prompt, so it never
 * counts as the contract's no-approval arguments; a runtime with a built-in request contract drops it.
 */
export const requestPlaceholder = '{request}';
export interface RegisteredLaunch { args: string[]; environment?: Record<string, string> }
export const registryContractRefusal = (kind: string) => `Graphyard refuses to launch the ${kind} runtime: its agent-registry launch contract registers no arguments or environment, so nothing suppresses its own approval or trust prompts and the session would wait for a human. Register the flags that start ${kind} without approvals with graphyard master registry runtime set NAME --kind ${kind} --arg=FLAG --reason REASON.`;
export function assertLaunchable(kind: string, registered: RegisteredLaunch | null = null) {
  if (nonInteractiveLaunch[kind]) return;
  if (!registered) throw new LaunchRefusedError(kind);
  if (!registered.args.some(argument => argument !== requestPlaceholder) && !Object.keys(registered.environment ?? {}).length) throw new LaunchRefusedError(kind, registryContractRefusal(kind));
}
/**
 * A profile with `approvals: "prompt"` would start its runtime without the recipe above and wait at
 * the runtime's own approval prompts for a human in the session tab. No launched session may wait
 * on a human (GY-184), so such a profile is refused before launch, naming the runtime and the fix;
 * the mode is still read so an existing master.json loads and says why it cannot launch.
 */
export const approvalOptOutRefusal = (kind: string) => `Graphyard refuses to launch the ${kind} runtime with approvals "prompt": the session would wait at its own approval prompts for a human in the session tab, and every launched session must run without asking. Set "approvals": "auto" on this profile.`;
export function assertNoApprovalOptOut(kind: string, approvals: ApprovalMode = 'auto') {
  if (approvals === 'prompt') throw new LaunchRefusedError(kind, approvalOptOutRefusal(kind));
}

/**
 * What each runtime's own session listing calls a session that has ended.
 *
 * Liveness reconciliation (`model/sessions.ts`) asks one question of a runtime — is this session
 * still holding its place — and the answer is the runtime's own vocabulary, so it belongs here with
 * the rest of the per-runtime startup contracts rather than in the rule. A runtime with no entry
 * gets the shared set: Herdr normalizes the coding runtimes onto the same states, and only a
 * runtime with terminal states of its own needs naming — a coding session that exited is simply
 * absent from `agent list`, which the `vanished` rule covers without any state at all. `idle`,
 * `done` and `blocked` are deliberately not ended anywhere: each is a live session waiting at its
 * prompt, and closing its handle would take away the attach command at the one moment somebody
 * needs it.
 */
export const runtimeEndedSessionStates: Record<string, readonly string[]> = {
  // Muse is the one runtime whose listing reports an exit rather than dropping the session.
  muse: [...endedRuntimeStates, 'exited-error', 'terminated'],
};
export const runtimeEndedStates: RuntimeStates = runtime => runtimeEndedSessionStates[runtime] ?? endedRuntimeStates;

/**
 * The runtime's no-approval mode merged into a profile's own arguments and environment. Recipe
 * flags the profile leaves out are added; ones it sets keep its value only where no value brings a
 * prompt back (`settable`), and otherwise must carry the recipe's value; a recipe variable the
 * profile sets must equal the recipe's or pass its `permits` check. An effective launch that could
 * still ask a human is not a launch: `refusal` names the runtime and the value, and `accountLaunch`
 * refuses it before any session starts (GY-184).
 */
export function launchPlan(kind: string | undefined, approvals: ApprovalMode = 'auto', agentArgs: string[] = [], environment: Record<string, string> = {}) {
  const recipe = kind ? nonInteractiveLaunch[kind] : undefined;
  const base = { approvals, args: [...agentArgs], environment: {} as Record<string, string>, applied: false, refusal: null as string | null, prompts: recipe?.prompts ?? null, tradeoff: recipe?.tradeoff ?? null };
  if (!recipe) return { ...base, reason: kind ? `Graphyard has no non-interactive launch contract for ${kind}; a session of it is refused at launch rather than left at its own approval prompt` : 'A launched session requires an agent kind' };
  if (approvals === 'prompt') return { ...base, reason: approvalOptOutRefusal(kind!), refusal: approvalOptOutRefusal(kind!) };
  const refuse = (setting: string) => { const refusal = `Graphyard refuses to launch the ${kind} runtime with ${setting}: that setting leaves the session able to stop at its own approval prompts for a human, and every launched session must run without asking. Remove it from the profile, or set the value Graphyard's ${kind} recipe uses.`; return { ...base, reason: refusal, refusal }; };
  // Every value the operator gives a recipe flag, in whichever spelling (`--flag value`,
  // `--flag=value`, an alias): a runtime may honour a later occurrence over an earlier one, so each
  // is checked, and a repeated flag with any value but the recipe's is refused.
  const valuesOf = (flag: string) => {
    const values: string[] = [];
    for (let index = 0; index < agentArgs.length; index++) {
      const [name, inline] = agentArgs[index].split(/=(.*)/s);
      if ((recipe.aliases?.[name] ?? name) === flag) values.push(inline ?? agentArgs[index + 1] ?? '');
    }
    return values;
  };
  const added: string[] = [];
  for (let index = 0; index < recipe.args.length; index++) {
    const flag = recipe.args[index], value = recipe.args[index + 1] !== undefined && !recipe.args[index + 1].startsWith('-') ? recipe.args[++index] : null;
    const present = value === null ? agentArgs.includes(flag) : valuesOf(flag).length > 0;
    if (!present) { added.push(flag, ...(value === null ? [] : [value])); continue; }
    const contrary = value === null || recipe.settable?.includes(flag) ? undefined : valuesOf(flag).find(given => given !== value);
    if (contrary !== undefined) return refuse(`${flag} ${contrary}`);
  }
  // A generic override (`-c key=value`, `--config=key=value`) of a pinned key must carry the pinned
  // value too, on every occurrence; TOML quoting around the value is the runtime's, not a new value.
  for (const flag of recipe.config?.flags ?? []) for (const setting of valuesOf(flag)) {
    const [key, given] = setting.split(/=(.*)/s).map(part => part?.trim().replace(/^(["'])(.*)\1$/s, '$2'));
    if (key in (recipe.config?.pins ?? {}) && given !== recipe.config!.pins[key]) return refuse(`${flag} ${setting}`);
  }
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(recipe.environment)) {
    if (!(name in environment)) { variables[name] = value; continue; }
    if (environment[name] !== value && !recipe.permits?.[name]?.(environment[name])) return refuse(`${name}=${environment[name]}`);
  }
  // A flag that already selects the no-approval mode stands in for the recipe, which adds nothing
  // beside it; the values checked above still may not contradict it.
  if (recipe.equivalents?.some(flag => agentArgs.includes(flag))) return { ...base, applied: true, reason: 'This profile already selects the runtime\'s no-approval mode; Graphyard added nothing' };
  const addedNothing = !added.length && Object.keys(variables).length === 0 && (recipe.args.length > 0 || Object.keys(recipe.environment).length > 0);
  return { ...base, args: [...added, ...agentArgs], environment: variables, applied: true, reason: addedNothing ? 'This profile already configures the runtime approval flags with no-approval values; Graphyard added nothing' : null };
}

export interface HarnessRule { rule: string; why: string }
export interface HarnessPlan { harness: string; file: string | null; allow: HarnessRule[]; deny: HarnessRule[]; manual: string | null; note: string }

/**
 * How Claude Code judges one shell command against a rule set: a matching deny wins, then a
 * matching allow; anything else is asked (and, under bypassPermissions, run). A compound command
 * is judged per part, so one denied part denies the whole and an allow needs every part allowed.
 * `*` matches any text; a trailing ` *` or the legacy `:*` also matches the bare prefix.
 */
export function bashRuleMatches(rule: string, command: string) {
  const body = /^Bash\((.*)\)$/s.exec(rule)?.[1];
  if (body === undefined || claudeRuleProblem(rule)) return false;
  const text = command.trim().replace(/\s+/g, ' ');
  const prefix = body.endsWith(':*') ? body.slice(0, -2) : body.endsWith(' *') ? body.slice(0, -2) : null;
  const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
  if (prefix !== null) return glob(prefix).test(text) || glob(`${prefix} *`).test(text);
  return glob(body).test(text);
}
/**
 * Why Claude Code would skip a rule, or null when it takes it. A skipped rule is worse than a
 * missing one: Claude Code stops the session on a "Settings Warning" dialog before it reads its
 * request (Herdr reports it blocked), and the dialog's only way on, "Continue", runs the session
 * without the rule — a deny that silently stops denying. So no generated rule may be one it skips:
 * `:*` is the legacy prefix marker and must end the rule (`Bash(git push * :**)` is refused as
 * "The :* pattern must be at the end"), and it needs a prefix before it.
 */
export function claudeRuleProblem(rule: string): string | null {
  const body = /^Bash\((.*)\)$/s.exec(rule)?.[1];
  if (body === undefined) return null;
  const marker = body.indexOf(':*');
  if (marker >= 0 && marker !== body.length - 2) return `${rule}: the :* pattern must be at the end`;
  if (marker === 0) return `${rule}: prefix cannot be empty before :*`;
  return null;
}
export type HarnessDecision = { decision: 'allow' | 'deny' | 'ask'; rule: HarnessRule | null };
const commandParts = (command: string) => command.split(/\s*(?:&&|\|\||;|\|)\s*/).map(part => part.trim()).filter(Boolean);
export function harnessDecision(plan: Pick<HarnessPlan, 'allow' | 'deny'>, command: string): HarnessDecision {
  const parts = commandParts(command);
  for (const part of parts) {
    const denied = plan.deny.find(entry => bashRuleMatches(entry.rule, part));
    if (denied) return { decision: 'deny', rule: denied };
  }
  const allowed = parts.map(part => plan.allow.find(entry => bashRuleMatches(entry.rule, part)));
  return parts.length && allowed.every(Boolean) ? { decision: 'allow', rule: allowed[0]! } : { decision: 'ask', rule: null };
}

/** The one GraphQL write a session may make: resolving a review thread (the master's audit, the reviewer's verdict). */
export const resolveThreadScript = (root: string) => resolve(root, 'scripts/resolve-thread.mjs');

// The master's own loop, and nothing else. A harness allowlist is a prompt policy, not an
// authority boundary: branch protection and Graphyard's required check remain the enforcement.
export function masterHarnessPlan(input: { harness: string; root: string; cliPath: string; repository: string; baseBranch: string; credentialHome: string }): HarnessPlan {
  const note = 'These rules remove operator keypresses from the master\'s own routine commands, including the GitHub administration flows the auto-mode classifier otherwise refuses as a permission grant, CI bypass, or self-modification. They grant no merge path and no credential read; the enforced merge boundary stays branch protection plus the App-bound Graphyard check.';
  if (input.harness === 'codex') return { harness: 'codex', file: null, allow: [], deny: [], note,
    manual: `# Add to $CODEX_HOME/config.toml (default ~/.codex/config.toml)\n[projects.${JSON.stringify(input.root)}]\ntrust_level = "trusted"\n` };
  if (input.harness !== 'claude') return { harness: input.harness, file: null, allow: [], deny: [], manual: null,
    note: `Graphyard generates harness permissions for Claude Code and trust configuration for Codex; ${input.harness} has no generated rules, so its own approval configuration applies.` };
  const cli = `node ${input.cliPath}`;
  const protection = `repos/${input.repository}/branches/${encodeURIComponent(input.baseBranch)}/protection`;
  const allow: HarnessRule[] = [
    { rule: `Bash(${cli} master:*)`, why: 'Run the master\'s own coordinator commands: status, dispatch, review, reviewer, protection, browser, harness, run, merge, and guide.' },
    { rule: `Bash(${cli} master review:*)`, why: 'The reviewer launcher. Listed on its own because the classifier reads launching a second agent as a permission grant; the launched reviewer holds a read-only, hour-long App token and no Graphyard credential.' },
    { rule: `Bash(${cli} master browser:*)`, why: 'The browser administration flows: App permission updates, installation acceptance, and protection reconciliation through the operator\'s own browser profile, each recorded, verified through the API, and written to the audit ledger. The flow invokes agent-browser itself, so this is the only rule the browser needs; the classifier otherwise refuses browser control as a permission grant.' },
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
    { rule: 'Bash(gh api user)', why: 'Name the GitHub identity an audit entry attributes an administration action to.' },
    { rule: `Bash(gh api ${protection}*)`, why: 'Read the managed base branch\'s protection and its subresources before and after reconciliation; the classifier otherwise refuses protection reads as CI-bypass reconnaissance.' },
    { rule: `Bash(gh api --method PATCH ${protection}/*)`, why: 'Reconcile one protection subresource (required reviews, required status checks) with the open review policies. A subresource PATCH cannot remove protection itself, and the App-bound check is re-verified before every guarded merge; the classifier otherwise refuses it as a CI bypass.' },
    { rule: 'Bash(gh api user/installations*)', why: 'Read the control-plane App\'s installation and the permissions it grants, before and after an installation acceptance. Installation writes have no API path the master may take directly; master browser installation-accept is the only one.' },
    { rule: 'Bash(gh api apps/*)', why: 'Read the permissions a public App record requests, to verify an App permission update.' },
    { rule: `Bash(node ${resolveThreadScript(input.root)}:*)`, why: 'Resolve a review thread the master has audited. The wrapper sends only resolveReviewThread, so it cannot merge or change protection.' },
    { rule: 'Bash(jq:*)', why: 'Filter the JSON that the commands above print, without leaving the session.' },
    { rule: 'Read(./.graphyard/master-actions/**)', why: 'Read the recorded steps, screenshots, and audit ledger of browser administration flows.' },
    { rule: 'Write(./.graphyard/profiles/**)', why: 'Write the worker and reviewer profile files the master installs with master worker add and master reviewer add.' },
    { rule: 'Edit(./.graphyard/profiles/**)', why: 'Revise those profile files; they contain no credential, only a path to one.' },
  ];
  const deny: HarnessRule[] = [
    { rule: 'Bash(gh pr merge:*)', why: 'Delivery happens only through graphyard master merge, which rechecks the exact candidate, every gate, and protection immediately before merging.' },
    { rule: 'Bash(gh pr review:*)', why: 'The master never posts a review verdict; independent review is launched, never performed.' },
    { rule: 'Bash(gh api *merge*)', why: 'A raw merge, merge-queue, or branch-merge call is an administrative merge bypass.' },
    { rule: 'Bash(gh api *pulls/*/reviews*)', why: 'Posting or dismissing a pull-request review through the API is the same verdict the master must never give.' },
    { rule: 'Bash(gh api *access_tokens*)', why: 'Minting an installation token is minting a credential; the master uses credentials only through the CLI.' },
    { rule: 'Bash(gh api graphql*)', why: 'GraphQL mutations can merge, approve, enable auto-merge, or rewrite rulesets; the audited-thread wrapper above is the only GraphQL path.' },
    { rule: 'Bash(gh api *DELETE*)', why: 'Deleting protection, a check, or an installation is never reconciliation, wherever the method flag sits in the command.' },
    { rule: 'Bash(gh api *PUT*)', why: 'Replacing whole branch protection could drop the App-bound check, and adding a repository to an installation is a grant; only subresource PATCHes and the recorded browser flows change those, wherever the method flag sits in the command.' },
    { rule: 'Bash(gh api *POST*)', why: 'The master creates nothing through the API: no review, comment, check run, or installation.' },
    { rule: 'Bash(agent-browser *)', why: 'The operator\'s browser profile is their identity and is driven only by the recorded master browser flows. A direct command would open that profile outside the three flows, and its cookies, state, restore, and auth-vault commands would export the operator\'s login; the recorded steps and screenshots under .graphyard/master-actions are the way to inspect what a flow saw.' },
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
  try { await defaultChildRun('git', ['check-ignore', '--quiet', '--', path], { cwd: root }); return true; }
  catch (error) { if (error instanceof ChildProcessError && error.status === 1) return false; throw new Error('Cannot verify that Git ignores the generated harness settings'); }
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
