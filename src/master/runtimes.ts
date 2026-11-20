// Concern: one adapter record per agent runtime kind — everything Graphyard knows of a runtime, in one place (GY-3034).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { asksNothing, trustAgyFolder, trustClaudeFolder, trustCodexFolder, verifyClaudeTrust, verifyCodexTrust, type LaunchRecipe } from '../harness.js';
import { endedRuntimeStates } from '../model/sessions.js';
import { claudeAccount, codexAccount, zaiAccount, type PlanReading } from './environment-quota.js';
import { defaultChildRun } from '../child-runner.js';
import { realRuntimeBinary } from '../runtime-binary.js';
import { underTestRunner } from '../runtime-environment.js';
import type { AccountUsage, EnvironmentProbe } from './environments.js';

/** An account home as a usage reader probes it: its kind and home, the plan derived for it and the one declared, and its named key file. */
export interface ProbedHome { name: string; kind: string; home: string; plan?: string | null; declaredPlan?: string | null; keyFile?: string; keyVariable?: string; model?: string }
/** What a usage reader reports of one account home: its login, the provider's usage windows, and a shared plan reading when it took one. */
export interface AccountReading { loggedIn: boolean; usage: AccountUsage[]; note: string | null; reached?: boolean; shared?: boolean; plan?: PlanReading;
  /** Why a logged-out reading is logged out, when the probe can say more than that. */
  loggedOutReason?: string;
  /** GY-3414: why a logged-in account still cannot run (its configured model is unavailable). */
  unready?: string;
  /** GY-3516: the fingerprint of the key the reading was taken with. */
  key?: string }
/**
 * Everything Graphyard knows of one runtime kind. Every field is optional but `kind`: a kind with
 * no `recipe` is still a kind profiles may name, and is refused at launch unless an agent-registry
 * contract brings its own no-approval arguments.
 *
 * - `recipe`: the no-approval startup contract (harness.ts `launchPlan`), with folder trust.
 * - `request`/`role`: where the session's first request and role file go on its command line (launch.ts).
 * - `screen`: the runtime's own start screen, so a slow start is told from a dead one.
 * - `endedStates`: what its session listing calls an ended session, beyond the shared set.
 * - `limitNotices`: the provider-authored usage-limit notices it prints; `zonelessBeijingResets` when those name Beijing's wall clock with no zone (Z.AI's).
 * - `home`: the login-home variable an account home is set on, and the runtime's own default home: the environment kinds.
 * - `usage`: reads an account home's login and provider quota; `sharedPlan` when its accounts share a Z.AI plan.
 * - `identity`: the login file whose provider ids name the subscription an account home is logged in to.
 * - `state`: the XDG base directories (with their defaults under HOME) the runtime keeps its session state in, and its own directory in each (GY-3303).
 */
export interface RuntimeAdapter {
  kind: string;
  recipe?: LaunchRecipe;
  /** `optional`: flags passed only when the installed runtime's `BEFORE --help` lists them (acceptedFlags). */
  headless?: { program?: string; before: string[]; flags: string[]; drop?: string[]; optional?: string[] };
  request?: (reference: string) => string;
  role?: (reference: string) => string;
  screen?: RegExp;
  endedStates?: readonly string[];
  limitNotices?: readonly RegExp[];
  zonelessBeijingResets?: boolean;
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
  // A free model's allowance (OpenCode's `429 FreeUsageLimitError`, `Free usage limit reached`) spends the account that runs it (GY-3302).
  /\bFreeUsageLimitError\b/,
];
/** Z.AI's 429 `Weekly/Monthly Limit Exhausted`, which the runtimes that speak to it print verbatim behind their own error labels (GY-973, GY-1817). */
const zaiLimitExhausted = /\b(?:weekly|monthly|daily|hourly|usage)(?:\/(?:weekly|monthly|daily|hourly))? limit exhausted\b/i;
/** The same notice inside Z.AI's own error envelope (`{"code":"1310","message":"Weekly/Monthly Limit Exhausted. …"}`), as pi prints it: the envelope, never the bare phrase an agent may write about it, is the provider speaking. */
const zaiLimitEnvelope = new RegExp(`"code"\\s*:\\s*"?\\d+"?\\s*,\\s*"message"\\s*:\\s*"${zaiLimitExhausted.source}`, 'i');

/**
 * GY-3414: an OpenCode account is logged in only when the runtime itself lists an authenticated
 * provider for its home: an `opencode/auth.json` that holds a key OpenCode does not take ran on the
 * free fallback model and failed every review while the file alone read as logged in. It is ready
 * only when `opencode models` lists its configured model: an installed OpenCode that dropped the
 * provider falls back to the free model too.
 */
async function opencodeAccount(environment: ProbedHome, probe: EnvironmentProbe, plan: { id: string | null; now: number }): Promise<AccountReading> {
  const reading = await zaiAccount(environment, probe, plan);
  const run = (probed: EnvironmentProbe['opencodeAuth'], args: string[]) => probed === undefined ? (underTestRunner() ? null : (home: string) => opencodeCommand(home, args)) : probed;
  const list = run(probe.opencodeAuth, ['auth', 'list']), models = run(probe.opencodeModels, ['models']);
  if (!reading.loggedIn) return reading;
  // A declared key file reaches OpenCode as an environment variable at launch, never through its store.
  if (list && !environment.keyFile) {
    const listed = await list(environment.home).then(output => output.split('\n').some(line => line.trim() && !/no authenticated integrations/i.test(line)) ? null : 'opencode auth list shows no authenticated provider',
      (error: Error) => `opencode auth list failed: ${error.message.split('\n')[0]!.slice(0, 200)}`);
    if (listed) return { loggedIn: false, usage: [], note: null, loggedOutReason: listed };
  }
  const model = environment.model;
  if (!models || !model) return reading;
  const available = await models(environment.home).then(output => output.split('\n').map(line => line.trim()).some(line => line === model || line.startsWith(`${model}/`)), () => false);
  return available ? reading : { ...reading, unready: `model unavailable: ${model}` };
}
/**
 * GY-3425: which of `flags` the installed `program` lists in its `BEFORE --help`, asked once per
 * launch or probe: an OpenCode that lacks `--standalone` exits with its usage text when given it.
 * A runtime whose help cannot be read accepts none of them.
 */
export async function acceptedFlags(program: string, before: readonly string[], flags: readonly string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  if (!flags.length) return [];
  const help = await defaultChildRun(program, [...before, '--help'], { env, timeoutMs: 30_000 }).then(String, () => '');
  const words = new Set(help.split(/[\s,=]+/));
  return flags.filter(flag => words.has(flag));
}
/** What OpenCode itself answers for a home: `--standalone` where it has one, or the host's background service answers with its own login. */
async function opencodeCommand(home: string, args: string[]) {
  const program = realRuntimeBinary('opencode'), env = { ...process.env, XDG_DATA_HOME: home };
  return String(await defaultChildRun(program, [...args, ...await acceptedFlags(program, ['run'], ['--standalone'], env)], { env, timeoutMs: 30_000 }));
}
export const opencodeAuthList = (home: string) => opencodeCommand(home, ['auth', 'list']);
export const opencodeModels = (home: string) => opencodeCommand(home, ['models']);
/** GY-3329: where cursor-agent keeps its sign-in on a host with no desktop keyring: `$XDG_CONFIG_HOME/cursor/auth.json`. */
export const cursorSignInFile = 'cursor/auth.json';
/** GY-3414: the file cursor-agent records its login in, under `CURSOR_CONFIG_DIR`: its `authInfo` names the signed-in user. */
export const cursorLoginFile = 'cli-config.json';
/** Cursor is logged in when cli-config.json in the account home names a signed-in user, or a keyring-less sign-in sits at `cursor/auth.json` (GY-3329). It exposes no quota. */
async function cursorAccount(environment: ProbedHome): Promise<AccountReading> {
  const config = await readFile(resolve(environment.home, cursorLoginFile), 'utf8').then(text => JSON.parse(text), () => null);
  const signIn = await readFile(resolve(environment.home, cursorSignInFile), 'utf8').then(text => text.trim(), () => '');
  const loggedIn = !!(config?.authInfo?.userId || config?.authInfo?.email) || !!signIn;
  return { loggedIn, usage: [], note: 'Cursor exposes no quota Graphyard can read; the session reports its own limit', ...(loggedIn ? {} : { loggedOutReason: `${resolve(environment.home, cursorLoginFile)} names no signed-in user` }) };
}
/**
 * GY-3329: the login-home variables an account's home is applied to beyond its home variable.
 * cursor-agent ignores `CURSOR_CONFIG_DIR` for its sign-in and reads it from
 * `$XDG_CONFIG_HOME/cursor/auth.json`, and a confined session has a private HOME and no
 * XDG_CONFIG_HOME, so a cursor account's home is its XDG config home too — applied per account,
 * over anything a runtime contract pinned to one account's home, so one cursor account never
 * reads another's sign-in.
 */
export function accountHomeEnvironment(kind: string | null | undefined, home: string | null | undefined): Record<string, string> {
  return kind === 'cursor' && home ? { XDG_CONFIG_HOME: home } : {};
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
    // Headless `-p` runs end with the result `… Switch to another model, or manage usage credits at https://claude.ai/settings/usage` (GY-3389).
    limitNotices: [...providerUsageErrors, /\bClaude AI usage limit reached\b/, /^.{0,160}\bmanage usage credits at https:\/\/claude\.ai\/settings\/usage\b/i],
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
    // GY-3329: the sign-in cursor-agent reads is `$XDG_CONFIG_HOME/cursor/auth.json`, so the
    // account's home is applied to XDG_CONFIG_HOME too (accountHomeEnvironment).
    home: { variable: 'CURSOR_CONFIG_DIR', default: home => resolve(home, '.cursor') },
    usage: environment => cursorAccount(environment),
    identity: { file: 'cli-config.json', ids: login => [login?.authInfo?.userId] },
  },
  opencode: {
    // GY-3414: OpenCode 2.x hands every command to a background service on the host's loopback
    // unless `--standalone`, and that service answers with its own login — none — whatever the
    // account's XDG_DATA_HOME, so the run fell back to the free model and stopped at once. An
    // OpenCode without it rejects the flag, so it is passed only where `run --help` lists it (GY-3425).
    headless: { before: ['run'], flags: ['--format', 'json'], optional: ['--standalone'] },
    recipe: { args: [], environment: { OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","webfetch":"allow"}' }, permits: { OPENCODE_PERMISSION: asksNothing }, prompts: 'edit, bash, and webfetch permission prompts',
      tradeoff: 'opencode edits files, runs shell commands, and fetches URLs without asking.' },
    request: reference => `--prompt ${reference}`,
    // OpenCode's own TUI never prints the capitalized word (GY-417): 1.18's start screen shows the
    // `Ask anything…` input prompt and a hint bar opening with `tab agents`.
    screen: /\btab agents\b|Ask anything…/,
    limitNotices: [...providerUsageErrors, zaiLimitExhausted], // OpenCode 1.18's `Weekly/Monthly Limit Exhausted` (GY-973)
    // Its Z.AI `provider.quota` error names `2026-11-20 12:49:15` with no zone, in Beijing time, as pi's does (GY-3495).
    zonelessBeijingResets: true,
    home: { variable: 'XDG_DATA_HOME', default: home => process.env.XDG_DATA_HOME ?? resolve(home, '.local/share') },
    usage: (environment, probe, { plan, now }) => opencodeAccount(environment, probe, { id: plan, now }),
    sharedPlan: true,
  },
  pi: {
    headless: { before: [], flags: ['-p'] },
    // Pi has no approval or trust prompt to suppress: every tool it has runs without asking.
    recipe: { args: [], environment: {}, prompts: 'none: pi has no approval or workspace-trust prompts',
      tradeoff: 'pi runs every tool it proposes in the assigned worktree; it has no approval step to turn off.' },
    request: reference => reference,
    limitNotices: [...providerUsageErrors, zaiLimitEnvelope], // pi on Z.AI: `Error: 429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. …"}` (GY-1817)
    // pi's 429 code 1310 names `2026-10-17 08:27:35` with no zone, in Beijing time (GY-3495).
    zonelessBeijingResets: true,
    usage: (environment, probe, { plan, now }) => opencodeAccount(environment, probe, { id: plan, now }),
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
