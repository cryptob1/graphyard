// Concern: one adapter record per agent runtime kind — everything Graphyard knows of a runtime, in one place (GY-3034).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { asksNothing, trustAgyFolder, trustClaudeFolder, trustCodexFolder, verifyClaudeTrust, verifyCodexTrust, type LaunchRecipe } from '../harness.js';
import { endedRuntimeStates } from '../model/sessions.js';
import { claudeAccount, codexAccount, readJsonFile, zaiAccount, type PlanReading } from './environment-quota.js';
import type { AccountUsage, EnvironmentProbe } from './environments.js';

/** An account home as a usage reader probes it: its kind and home, the plan derived for it and the one declared, and its named key file. */
export interface ProbedHome { name: string; kind: string; home: string; plan?: string | null; declaredPlan?: string | null; keyFile?: string; keyVariable?: string; model?: string }
/** What a usage reader reports of one account home: its login, the provider's usage windows, and a shared plan reading when it took one. */
export interface AccountReading { loggedIn: boolean; usage: AccountUsage[]; note: string | null; reached?: boolean; shared?: boolean; plan?: PlanReading }
/**
 * Everything Graphyard knows of one runtime kind. Every field is optional but `kind`: a kind with
 * no `recipe` is still a kind profiles may name, and is refused at launch unless an agent-registry
 * contract brings its own no-approval arguments.
 *
 * - `recipe`: the no-approval startup contract (harness.ts `launchPlan`), with folder trust.
 * - `request`/`role`: where the session's first request and role file go on its command line (launch.ts).
 * - `screen`: the runtime's own start screen, so a slow start is told from a dead one.
 * - `endedStates`: what its session listing calls an ended session, beyond the shared set.
 * - `limitNotices`: the provider-authored usage-limit notices it prints; `zonelessUtcResets` when those name a UTC wall clock with no zone.
 * - `home`: the login-home variable an account home is set on, and the runtime's own default home: the environment kinds.
 * - `usage`: reads an account home's login and provider quota; `sharedPlan` when its accounts share a Z.AI plan.
 * - `identity`: the login file whose provider ids name the subscription an account home is logged in to.
 * - `state`: the XDG base directories (with their defaults under HOME) the runtime keeps its session state in, and its own directory in each (GY-3303).
 */
export interface RuntimeAdapter {
  kind: string;
  recipe?: LaunchRecipe;
  headless?: { program?: string; before: string[]; flags: string[]; drop?: string[] };
  request?: (reference: string) => string;
  role?: (reference: string) => string;
  screen?: RegExp;
  endedStates?: readonly string[];
  limitNotices?: readonly RegExp[];
  zonelessUtcResets?: boolean;
  home?: { variable: string; default: (home: string) => string };
  usage?: (environment: ProbedHome, probe: EnvironmentProbe, context: { plan: string | null; now: number }) => Promise<AccountReading>;
  sharedPlan?: boolean;
  identity?: { file: string; ids: (login: any) => unknown[] };
  state?: { variables: Record<string, string>; directory: string };
}

/** The usage-limit messages the provider APIs themselves return, in a runtime's error output. */
export const providerUsageErrors: readonly RegExp[] = [
  /\b(?:you(?:'|’)?ve|you have) (?:hit|reached) your (?:\w+[- ]){0,3}limit\b/i,
  /\b(?:usage|rate) limit reached\b/i,
  /\breached your [\w .-]{0,40}usage limits?\b/i,
  /\busage limits? (?:has|have) been reached\b/i,
  /\bexceeded your (?:current )?(?:quota|usage|plan)\b/i,
  /\blimit reached\b.*\breset/i,
];
/** Z.AI's 429 `Weekly/Monthly Limit Exhausted`, which the runtimes that speak to it print verbatim behind their own error labels (GY-973, GY-1817). */
const zaiLimitExhausted = /\b(?:weekly|monthly|daily|hourly|usage)(?:\/(?:weekly|monthly|daily|hourly))? limit exhausted\b/i;
/** The same notice inside Z.AI's own error envelope (`{"code":"1310","message":"Weekly/Monthly Limit Exhausted. …"}`), as pi prints it: the envelope, never the bare phrase an agent may write about it, is the provider speaking. */
const zaiLimitEnvelope = new RegExp(`"code"\\s*:\\s*"?\\d+"?\\s*,\\s*"message"\\s*:\\s*"${zaiLimitExhausted.source}`, 'i');

/** Cursor keeps its login in cli-config.json and exposes no quota. */
async function cursorAccount(environment: ProbedHome): Promise<AccountReading> {
  const info = (await readJsonFile(resolve(environment.home, 'cli-config.json')))?.authInfo;
  return { loggedIn: !!info && !!(info.userId || info.email), usage: [], note: 'Cursor exposes no quota Graphyard can read; the session reports its own limit' };
}

// Per-runtime startup contracts that remove the approval and workspace-trust prompts a freshly
// launched session blocks on. These are runtime CLI contracts, not Graphyard authority: a session
// that never asks can still only act inside its own assigned worktree and its own credentials.
const builtInAdapters = {
  claude: {
    // `--output-format json`: the run ends with one `result` object carrying its reply and the tokens it used by model (GY-3289).
    headless: { before: [], flags: ['-p', '--output-format', 'json'] },
    recipe: { args: ['--permission-mode', 'bypassPermissions'], environment: {}, equivalents: ['--dangerously-skip-permissions'], trust: trustClaudeFolder, verify: verifyClaudeTrust, prompts: 'tool-approval prompts on first use of each command class, and the folder-trust dialog in a folder it has not been trusted in',
      tradeoff: 'Claude Code stops classifying commands for this session and trusts its working directory without asking wherever that loads none of the repository\'s own Claude settings; everything the agent proposes runs without asking.' },
    request: reference => reference,
    // Only Claude Code, which leaves AGENTS.md out under a role file, loads the launch authorization from a file.
    role: reference => `--append-system-prompt-file ${reference}`,
    screen: /Claude Code|Welcome to Claude|esc to interrupt|bypass permissions on|shift\+tab to cycle|for shortcuts|^\s*[∙✻✶✳✢]/m,
    limitNotices: [...providerUsageErrors, /\bClaude AI usage limit reached\b/],
    home: { variable: 'CLAUDE_CONFIG_DIR', default: home => resolve(home, '.claude') },
    usage: (environment, probe, { now }) => claudeAccount(environment, probe, now),
    identity: { file: '.claude.json', ids: login => [login?.oauthAccount?.accountUuid, login?.oauthAccount?.organizationUuid] },
  },
  codex: {
    // `--json`: events on standard output, the last a `turn.completed` with the tokens the turn used (GY-3289).
    headless: { before: ['exec'], flags: ['--skip-git-repo-check', '--json'], drop: ['--ask-for-approval', '-a'] },
    // No Codex flag skips its "Trust this folder?" dialog in a folder its config does not list, so
    // the folder is recorded trusted first (trustCodexFolder, GY-1306).
    recipe: { args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'], environment: {}, equivalents: ['--dangerously-bypass-approvals-and-sandbox', '--yolo'], settable: ['--sandbox'], aliases: { '-a': '--ask-for-approval', '-s': '--sandbox' }, config: { flags: ['-c', '--config'], pins: { approval_policy: 'never' } }, trust: trustCodexFolder, verify: verifyCodexTrust, prompts: 'directory-trust and per-command approval prompts',
      tradeoff: 'Codex never asks for approval; only its workspace-write sandbox still limits what a command can touch.' },
    request: reference => reference,
    screen: /\bCodex\b|esc to interrupt/,
    limitNotices: [...providerUsageErrors],
    home: { variable: 'CODEX_HOME', default: home => resolve(home, '.codex') },
    usage: (environment, probe) => codexAccount(environment, probe),
    identity: { file: 'auth.json', ids: login => [login?.tokens?.account_id] },
  },
  cursor: {
    headless: { program: 'cursor-agent', before: [], flags: ['-p', '--output-format', 'json'] },
    recipe: { program: 'agent', args: ['--force', '--trust'], environment: {}, prompts: "the 'Run Everything' approval and the fresh-worktree workspace-trust prompt",
      tradeoff: 'Cursor Agent (`agent`) runs every command it proposes in the assigned worktree and trusts that worktree without asking.' },
    request: reference => reference,
    screen: /\bCursor\b/,
    limitNotices: [...providerUsageErrors],
    home: { variable: 'CURSOR_CONFIG_DIR', default: home => resolve(home, '.cursor') },
    usage: environment => cursorAccount(environment),
    identity: { file: 'cli-config.json', ids: login => [login?.authInfo?.userId] },
  },
  opencode: {
    headless: { before: ['run'], flags: ['--format', 'json'] },
    recipe: { args: [], environment: { OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","webfetch":"allow"}' }, permits: { OPENCODE_PERMISSION: asksNothing }, prompts: 'edit, bash, and webfetch permission prompts',
      tradeoff: 'opencode edits files, runs shell commands, and fetches URLs without asking.' },
    request: reference => `--prompt ${reference}`,
    // OpenCode's own TUI never prints the capitalized word (GY-417): 1.18's start screen shows the
    // `Ask anything…` input prompt and a hint bar opening with `tab agents`.
    screen: /\btab agents\b|Ask anything…/,
    limitNotices: [...providerUsageErrors, zaiLimitExhausted], // OpenCode 1.18's `Weekly/Monthly Limit Exhausted` (GY-973)
    home: { variable: 'XDG_DATA_HOME', default: home => process.env.XDG_DATA_HOME ?? resolve(home, '.local/share') },
    usage: (environment, probe, { plan, now }) => zaiAccount(environment, probe, { id: plan, now }),
    sharedPlan: true,
  },
  pi: {
    headless: { before: [], flags: ['-p'] },
    // Pi has no approval or trust prompt to suppress: every tool it has runs without asking.
    recipe: { args: [], environment: {}, prompts: 'none: pi has no approval or workspace-trust prompts',
      tradeoff: 'pi runs every tool it proposes in the assigned worktree; it has no approval step to turn off.' },
    request: reference => reference,
    limitNotices: [...providerUsageErrors, zaiLimitEnvelope], // pi on Z.AI: `Error: 429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. …"}` (GY-1817)
    // pi's 429 code 1310 names `2026-10-17 08:27:35` with no zone, in UTC (GY-1817).
    zonelessUtcResets: true,
    usage: (environment, probe, { plan, now }) => zaiAccount(environment, probe, { id: plan, now }),
    sharedPlan: true,
  },
  gemini: {
    recipe: { args: ['--yolo'], environment: {}, prompts: 'per-tool approval prompts', tradeoff: 'Gemini CLI approves every tool call it proposes (YOLO mode) without asking.' },
    request: reference => `--prompt-interactive ${reference}`,
    screen: /\bGemini\b/,
  },
  qwen: {
    recipe: { args: ['--yolo'], environment: {}, prompts: 'per-tool approval prompts', tradeoff: 'Qwen Code approves every tool call it proposes (YOLO mode) without asking.' },
    request: reference => `--prompt-interactive ${reference}`,
  },
  copilot: {
    recipe: { args: ['--allow-all-tools', '--allow-all-paths'], environment: {}, prompts: 'per-tool approval and path-access prompts', tradeoff: 'Copilot CLI runs every tool and reaches every path it proposes without asking.' },
    request: reference => `--interactive ${reference}`,
  },
  muse: {
    headless: { before: ['exec'], flags: [] },
    recipe: { args: ['--approval-mode', 'never', '--trust-workspace'], environment: {}, prompts: 'approval and workspace-trust prompts', tradeoff: 'Muse never asks for approval and trusts the assigned worktree without asking.' },
    request: reference => reference,
    // Muse is the one runtime whose listing reports an exit rather than dropping the session.
    endedStates: [...endedRuntimeStates, 'exited-error', 'terminated'],
    // Muse locks and writes its sessions under `$XDG_DATA_HOME/muse` and its settings lock under `$XDG_CONFIG_HOME/muse`.
    state: { variables: { XDG_DATA_HOME: '.local/share', XDG_CONFIG_HOME: '.config' }, directory: 'muse' },
  },
  // Google Antigravity CLI (agy 1.2+): one flag auto-approves every tool permission request; no
  // flag skips its workspace-trust prompt, so the folder is recorded trusted first (trustAgyFolder).
  agy: {
    recipe: { args: ['--dangerously-skip-permissions'], environment: {}, trust: trustAgyFolder, prompts: "per-tool permission prompts, and the fresh-worktree workspace-trust prompt ('Do you trust the contents of this project?')",
      tradeoff: 'Antigravity CLI (`agy`) approves every tool permission request it proposes without asking and trusts the assigned worktree without asking.' },
    request: reference => `--prompt-interactive ${reference}`,
    limitNotices: [...providerUsageErrors, /\bIndividual quota reached\b(?=.*\b(?:upgrade your subscription|resets? in)\b)/i], // GY-1135
  },
  // Kinds a profile may name with no built-in contract: launched only through an agent-registry contract.
  devin: {}, cline: {}, omp: {}, mastracode: {}, kimi: {}, kiro: {}, droid: {}, amp: {}, grok: {}, hermes: {}, kilo: {}, qodercli: {}, maki: {},
} satisfies Record<string, Omit<RuntimeAdapter, 'kind'>>;

export type RuntimeKind = keyof typeof builtInAdapters;
type WithHome<K extends RuntimeKind> = typeof builtInAdapters[K] extends { home: object } ? K : never;
export type EnvironmentKind = { [K in RuntimeKind]: WithHome<K> }[RuntimeKind];
/** Every runtime kind a profile may name: the one list the profile schema, the environment kinds and the launch tables read. */
export const runtimeKinds = Object.keys(builtInAdapters) as [RuntimeKind, ...RuntimeKind[]];
/** The kinds whose account homes Graphyard creates, probes and selects: those whose adapter names a login home. */
export const environmentKinds = runtimeKinds.filter(kind => 'home' in builtInAdapters[kind]) as [EnvironmentKind, ...EnvironmentKind[]];

const adapters = new Map<string, RuntimeAdapter>(Object.entries(builtInAdapters).map(([kind, adapter]) => [kind, { kind, ...adapter } as RuntimeAdapter]));
/** The adapter for `kind`, or undefined for a kind Graphyard knows nothing of. */
/** The remedy for a session stuck on its runtime's first-run screen, or null when the screen is not one. */
export const runtimeAdapter = (kind: string | null | undefined): RuntimeAdapter | undefined => kind ? adapters.get(kind) : undefined;
/** Every adapter, built-in and registered. */
export const runtimeAdapters = (): RuntimeAdapter[] => [...adapters.values()];
/** Adds or replaces one runtime's adapter: every launch, resume and usage lookup reads it from then on. */
export function registerRuntimeAdapter(adapter: RuntimeAdapter) { adapters.set(adapter.kind, adapter); }
/**
 * GY-3303: where a confined session of `kind` keeps its own state: each XDG base directory its
 * adapter names, from the launch environment or under HOME, and the runtime's own directory in
 * each — only those directories are writable to it, never the whole base directory.
 */
export function runtimeStateRoots(kind: string, environment: NodeJS.ProcessEnv): { variables: Record<string, string>; writable: string[] } {
  const state = runtimeAdapter(kind)?.state;
  if (!state) return { variables: {}, writable: [] };
  const home = environment.HOME || homedir();
  const variables = Object.fromEntries(Object.entries(state.variables).map(([name, fallback]) => {
    const value = environment[name];
    return [name, value && isAbsolute(value) ? value : join(home, fallback)];
  }));
  return { variables, writable: Object.values(variables).map(root => join(root, state.directory)) };
}
/** The login-home variable of every adapter that names one. */
export const runtimeHomeVariables = () => runtimeAdapters().flatMap(adapter => adapter.home ? [adapter.home.variable] : []);

/**
 * The provider login an account home holds (GY-1573), as its kind and a digest of the provider's own
 * ids, so two homes logged in to one subscription read alike and nothing identifying leaves the host.
 * A runtime whose adapter names no identity file (OpenCode and Pi name no single login) and an
 * API-key login naming no account read null: unknown, which holds nothing. A login file that exists
 * but cannot be read or parsed just now (a runtime mid-write) reads undefined: the login has not been
 * seen to change.
 */
export async function adapterIdentity(kind: string, home: string, digest: (ids: string[]) => string): Promise<string | null | undefined> {
  const identity = runtimeAdapter(kind)?.identity;
  if (!identity) return null;
  let login: any;
  try { login = JSON.parse(await readFile(resolve(home, identity.file), 'utf8')); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
  const ids = identity.ids(login);
  if (!ids.every(id => typeof id === 'string' && id.trim() || typeof id === 'number')) return null;
  return `${kind}:${digest(ids.map(String))}`;
}
