// Concern: worker, reviewer and producer profiles, the master config schema, and profile session naming.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defaultChildRun } from '../child-runner.js';
import { pathScopeContains } from '../model/scope.js';
import { temporaryDirectories, underTestRunner } from '../supervisor.js';
import { defaultMergeBatchSize, defaultParallelTips, maxMergeBatchSize, maxParallelTips, mergeQueueInsights } from '../merge-queue.js';
import { defaultOptimisticMerge, defaultOptimisticExclude } from '../optimistic-merge.js';
import type { Work } from '../model/work.js';
import { diagnosticianSettingsSchema, narrowRoleRuntimeSchema, piRuntimeSchema } from '../runner/payloads.js';
import { researchSettingsSchema } from '../research.js';
import { sessionNameField, sessionNameLimit, assertSessionName, sessionNameDigestLength, SessionNameRefusedError } from '../session-name.js';
import { invariantThresholdsSchema } from '../model/invariants.js';
import { runtimeSandboxes } from '../worker-sandbox.js';
import { checkoutGitDirectory, checkoutGitProblem, checkoutWorktreeAdminDirectory, gitPointerAdminDirectory } from './checkout-git.js';
export { checkoutGitDirectory, checkoutGitProblem, checkoutWorktreeAdminDirectory } from './checkout-git.js';

const safeEnvironment = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
    .refine(name => !name.startsWith('GRAPHYARD_'), 'GRAPHYARD_ variables are owned by the launcher and cannot be set in a worker profile')
    .refine(name => !/(TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|CREDENTIAL)/.test(name), 'Put secrets in the worker credential file or the agent runtime login, not master profile environment'),
  z.string().min(1).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Profile environment values cannot contain control characters'),
).default({});

export const agentKindSchema = z.enum(['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'maki', 'muse']);
const profileName = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
// 'auto' installs the runtime's own non-interactive startup contract. 'prompt' would keep the
// runtime's approval prompts for a human in the session tab, so a profile that sets it is still
// read but refused at launch (GY-184, assertNoApprovalOptOut).
const approvalMode = z.enum(['auto', 'prompt']).default('auto');

// An agent environment is one isolated config and login home for one agent CLI account, such as
// ~/.coding_agents/claude-b. The Graphyard principal a profile claims under is independent of the
// provider account its session runs on: a profile names the accounts it may use, in failover order,
// and every launch runs on the first of them that is logged in and has provider quota left.
export const environmentKinds = ['claude', 'codex', 'opencode', 'cursor'] as const;
export type EnvironmentKind = typeof environmentKinds[number];
export const environmentVariable: Record<EnvironmentKind, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', opencode: 'XDG_DATA_HOME', cursor: 'CURSOR_CONFIG_DIR' };
export const agentEnvironmentSchema = z.object({
  name: profileName,
  kind: z.enum(environmentKinds),
  home: z.string().min(1).max(500).refine(isAbsolute, 'An agent environment home must be an absolute path'),
}).strict();
export type AgentEnvironment = z.infer<typeof agentEnvironmentSchema>;
const accountList = z.array(profileName).min(1).max(20).optional();
// How many sessions a reviewer or producer profile runs at once (GY-107): the fleet's review and
// proof capacity is declared here, per role, never implied by the one agent name a profile has.
// Absent means one, which keeps the profile's fixed session name; see profileConcurrency.
const sessionConcurrency = z.number().int().min(1).max(20).optional();

export const workerProfileSchema = z.object({
  name: profileName,
  principal: z.string().trim().min(1).max(200),
  agentName: sessionNameField,
  mode: z.enum(['existing', 'launch']),
  kind: agentKindSchema.optional(),
  credentialFile: z.string().optional(),
  agentArgs: z.array(z.string().max(1000)).max(30).default([]),
  approvals: approvalMode,
  environment: safeEnvironment,
  accounts: accountList,
}).strict().superRefine((profile, context) => {
  if (profile.mode === 'launch' && !profile.kind) context.addIssue({ code: 'custom', message: 'A launched worker requires kind', path: ['kind'] });
  if (profile.mode === 'launch' && !profile.credentialFile) context.addIssue({ code: 'custom', message: 'A launched worker requires credentialFile', path: ['credentialFile'] });
  if (profile.credentialFile && !isAbsolute(profile.credentialFile)) context.addIssue({ code: 'custom', message: 'credentialFile must be absolute', path: ['credentialFile'] });
});
export type WorkerProfile = z.infer<typeof workerProfileSchema>;

/**
 * Why a worker profile may not launch as configured, or null (GY-857). Every worker is launched
 * with writes confined to its assigned worktree — Claude Code through harness rules that deny
 * the coordinator checkout's own files, Codex through its workspace-write sandbox and the Git
 * directories granted beside it, opencode through `external_directory: "deny"` — so a profile
 * that turns its runtime's confinement off is refused when the launcher installs the worker's
 * harness, naming the setting. It is judged at launch and not at parse (GY-184's precedent): an
 * existing master.json keeps loading and says why the profile cannot start.
 */
export function workerConfinementRefusal(profile: { kind?: string; agentArgs?: readonly string[]; environment?: Record<string, string> }): string | null {
  const args = profile.agentArgs ?? [];
  const bypass = args.find(arg => ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo'].includes(arg));
  if (bypass) return `A worker profile cannot launch with ${bypass}: it turns the runtime's approval and write confinement off, and every worker is launched with writes confined to its assigned worktree. Remove it from the profile; the runtime's own recipe keeps the session unattended without it.`;
  if (profile.kind === 'codex') {
    for (let index = 0; index < args.length; index++) {
      const [flag, inline] = args[index].split(/=(.*)/s);
      if (flag !== '--sandbox' && flag !== '-s') continue;
      const value = inline ?? args[index + 1] ?? '';
      if (value !== 'workspace-write') return `A codex worker profile cannot set ${flag} ${value}: only the workspace-write sandbox confines the session's writes to its assigned worktree and the Git directories granted beside it. Remove the flag or set it to workspace-write.`;
    }
  }
  if (profile.kind === 'opencode' && !openCodeExternalDenied(profile.environment?.OPENCODE_PERMISSION)) {
    return `An opencode worker profile must set OPENCODE_PERMISSION to a JSON permission document whose "external_directory" is "deny": Graphyard's allow-all default would let the session edit paths outside its assigned worktree. Set the profile variable to {"edit":"allow","bash":"allow","webfetch":"allow","external_directory":"deny"}.`;
  }
  return null;
}
/** Whether an OPENCODE_PERMISSION document denies every external directory: absent, unparseable, `allow`, or an `ask` leaf all count as not denied. */
function openCodeExternalDenied(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  let document: unknown;
  try { document = JSON.parse(raw); } catch { return false; }
  const external = (document && typeof document === 'object' && !Array.isArray(document) ? (document as Record<string, unknown>).external_directory : undefined);
  const denied = (node: unknown): boolean => node === 'deny' || (!!node && typeof node === 'object' && !Array.isArray(node) && Object.values(node).every(denied));
  return denied(external);
}

// A reviewer session holds no Graphyard identity: it reads a candidate and posts one GitHub
// verdict with a short-lived reviewer-App token, so it needs no principal and no credential file.
export const reviewerProfileSchema = z.object({
  name: profileName,
  agentName: sessionNameField,
  kind: agentKindSchema,
  agentArgs: z.array(z.string().max(1000)).max(30).default([]),
  approvals: approvalMode,
  environment: safeEnvironment,
  accounts: accountList,
  concurrency: sessionConcurrency,
}).strict();
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;

// A producer session runs one proof group on one exact head and submits evidence under its own
// producer principal. It is launched like a worker — its own credential file, runtime and
// environment — but never claims work: trust follows the principal's proof grants, and the
// control plane refuses its evidence as soon as that principal ever holds an assignment.
export const producerProfileSchema = z.object({
  name: profileName,
  principal: z.string().trim().min(1).max(200),
  agentName: sessionNameField,
  kind: agentKindSchema,
  credentialFile: z.string(),
  agentArgs: z.array(z.string().max(1000)).max(30).default([]),
  approvals: approvalMode,
  environment: safeEnvironment,
  accounts: accountList,
  concurrency: sessionConcurrency,
}).strict().superRefine((profile, context) => {
  if (!isAbsolute(profile.credentialFile)) context.addIssue({ code: 'custom', message: 'credentialFile must be absolute', path: ['credentialFile'] });
});
export type ProducerProfile = z.infer<typeof producerProfileSchema>;

/**
 * Per-role concurrency (GY-107). Reviews and proofs used to serialise across the installation
 * because each role's profile had one fixed Herdr agent name, and a second launch was refused
 * while that name was visible. A profile now runs `concurrency` sessions at once (default 1).
 * A profile that runs one session keeps its fixed name, which every existing ledger, tab label
 * and failover path expects; one that runs more names each session for the request it answers
 * — the profile's name and the first 8 hex of the request id, with the attempt appended after
 * the first, or the session's own id for a launch by hand — so a second review on another item
 * starts while the first runs and the two never share a name. The name is composed inside the
 * runtime's limit (session-name.ts): the tail that tells the sessions apart is kept whole and a
 * profile name too long for it gives way to a digest, so a session is recognised as the
 * profile's by rebuilding its name from that tail rather than by prefix.
 */
export const profileConcurrency = (profile: { concurrency?: number }) => Math.max(1, profile.concurrency ?? 1);
function derivedSessionName(profile: { agentName: string }, tag: string, attempt: number) {
  // As suffixedSessionName composes a name, with the tail kept verbatim: it is hex and digits,
  // and the name starts with the profile's own (already launchable) name, so it needs no slug.
  const tail = `${tag}${attempt > 1 ? `-${attempt}` : ''}`, head = profile.agentName;
  if (head.length + tail.length + 1 <= sessionNameLimit) return assertSessionName(`${head}-${tail}`);
  const digest = createHash('sha256').update([head, tail].join('\u0000')).digest('hex').slice(0, sessionNameDigestLength);
  const shortened = head.slice(0, Math.max(1, sessionNameLimit - tail.length - sessionNameDigestLength - 2)).replace(/-+$/, '');
  return assertSessionName(`${shortened}-${digest}-${tail}`);
}
export function sessionAgentName(profile: { agentName: string; concurrency?: number }, session: { id: string; requestId?: string; attempt?: number }) {
  if (profileConcurrency(profile) === 1) return profile.agentName;
  const tag = (session.requestId ?? session.id).toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8).padEnd(8, '0');
  return derivedSessionName(profile, tag, session.attempt ?? 1);
}
/**
 * Whether a Herdr agent name is one of the profile's sessions: its fixed name, or a name this
 * launcher derived from it. The tail is read from the end of the name and anchored there
 * (GY-122): a name that ends in eight hex characters ends in its tag, with no attempt; only a
 * name that does not is read as a tag and an attempt. One pattern with an optional attempt used
 * to match from the first eight hex characters it found, so an all-digit tag (12345678,
 * 00000000) after a digest or any other hex run was read as that run's attempt and the session
 * went uncounted — one more than the limit could launch on the account. A tag is never read as
 * an attempt: an attempt is a small count (the ledgers cap it at 50), never eight digits. The
 * reading is the profile's when rebuilding the name from it gives the name back; a tail that
 * cannot be rebuilt into a launchable name is nobody's session.
 */
export function isProfileSession(profile: { agentName: string }, name: string | undefined) {
  if (!name) return false;
  if (name === profile.agentName) return true;
  const reading = /-([0-9a-f]{8})$/.exec(name) ?? /-([0-9a-f]{8})-([1-9]\d*)$/.exec(name);
  if (!reading) return false;
  try { return derivedSessionName(profile, reading[1], Number(reading[2] ?? 1)) === name; }
  catch (error) { if (error instanceof SessionNameRefusedError) return false; throw error; }
}
/**
 * The sessions a profile is running, counted against its limit: every Herdr agent that carries
 * one of its names, and every agent a pending ledger record of the profile names — the same
 * inventory the one-session rule read, so a session Herdr no longer lists frees its slot as it
 * did before, and the ledger's grace settles the record. `free` is how many more may launch.
 */
export function profileSessions(profile: { name: string; agentName: string; concurrency?: number }, agents: { name?: string }[], records: { profile: string; agentName: string; state: string }[] = []) {
  const pending = new Set(records.filter(record => record.state === 'pending' && record.profile === profile.name).map(record => record.agentName));
  const running = [...new Set(agents.map(agent => agent.name).filter((name): name is string => !!name && (isProfileSession(profile, name) || pending.has(name))))];
  const limit = profileConcurrency(profile);
  return { running, limit, free: Math.max(0, limit - running.length) };
}
/** The refusal a launch raises for a profile with no slot left; the one-session case reads as it always did. */
export function profileAtLimit(role: 'Reviewer' | 'Producer', profile: { name: string; agentName: string; concurrency?: number }, sessions: { running: string[]; limit: number }) {
  return sessions.limit === 1
    ? `${role} agent ${sessions.running[0] ?? profile.agentName} is already visible in Herdr; profile ${profile.name} runs one session at a time (concurrency 1)`
    : `${role} profile ${profile.name} is at its concurrency limit (${sessions.running.length} running, limit ${sessions.limit}: ${sessions.running.join(', ')}); raise concurrency in .graphyard/master.json or add a ${role.toLowerCase()} profile`;
}

export const reviewerIdentitySchema = z.object({
  appId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  slug: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/),
  credentialFile: z.string(),
  boundAt: z.string().min(1).max(40),
}).strict();
export type ReviewerIdentity = z.infer<typeof reviewerIdentitySchema>;

// Durable-loop settings. The daemon adds no credential of its own: a proof or smoke workflow is
// requested from the provider, which holds the trusted producer secret, and a deployment probe only reads.
export const masterRunSchema = z.object({
  intervalSeconds: z.number().int().min(5).max(900).default(20),
  proofWorkflow: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Name the trusted producer workflow file, such as acceptance.yml').optional(),
  deploymentUrl: z.string().url().max(500).optional(),
  deploymentShaField: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/).default('commit'),
  // The deployment provider's whole name for the production environment, read from GitHub
  // deployments when no deployment URL is configured. Railway names it `<project> / production`
  // (`graphyard / production`); unset, GRAPHYARD_PRODUCTION_ENVIRONMENT or `production` applies.
  productionEnvironment: z.string().trim().min(1).max(100).optional(),
  smokeWorkflow: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Name the trusted post-deployment smoke workflow file, such as deploy-smoke.yml').optional(),
  // Automatic dispatch at submit: how often the loop reads the control plane's review and
  // producer requests (the launch bound is 30 seconds from the request), which reviewer profile
  // answers a request when more than one is configured, and how long a producer session may run.
  dispatchIntervalSeconds: z.number().int().min(5).max(30).default(10),
  // How many session launches — worker dispatches, approvers, failover relaunches — the launcher
  // beside the loop's cycle runs at once (GY-616). The cycle hands launches over and never waits on
  // them; the rest queue. Each launch creates a Herdr pane, so this bounds the host's launch load.
  // Unset: 3 (`defaultLaunchConcurrency`).
  launchConcurrency: z.number().int().min(1).max(20).optional(),
  reviewerProfile: profileName.optional(),
  producerTimeoutMinutes: z.number().int().min(5).max(1440).default(120),
  /**
   * Automatic bot reviewers whose review of a head the reviewer launch waits for, so their inline
   * findings are open threads the reviewer judges in the same round rather than arriving after its
   * approval and costing a rework round each (GY-163). A bot with nothing to say posts no review,
   * so `awaitReviewersMinutes` bounds the wait from the review request; 0 turns it off.
   * Unset: the Codex connector, for 8 minutes (`defaultAwaitReviewers`). The duration is the
   * master's to tune (`master config awaitReviewersMinutes=0`, an empty value restores the
   * default). The login list stays the operator's, edited in .graphyard/master.json: it also
   * decides whose review threads are trusted grounds for automatic scope widening, so the master
   * cannot add a login whose findings would widen scope.
   */
  awaitReviewers: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  awaitReviewersMinutes: z.number().int().min(0).max(60).optional(),
  // How long a candidate's push-triggered acceptance run has before the loop dispatches the proof
  // workflow as a fallback, so a busy CI queue does not get a duplicate run per head; unset, 0.
  proofDispatchGraceMinutes: z.number().int().min(0).max(1440).optional(),
  // How long a launched reviewer or producer session may show no activity before the loop
  // re-prompts it once, and how long after that re-prompt a still-quiet session is recorded as
  // never started (see acknowledgeLaunch); default 90.
  acknowledgementSeconds: z.number().int().min(30).max(900).optional(),
  // The loop-launched master session (GY-898): how long one master session may run before the
  // loop rotates it (default 240 minutes; the 12h coordination maximum stays as the surfaced-only
  // safety bound, and a rotation defers while a guarded merge is in flight), and how long the
  // heartbeat fallback waits before it wakes a master that has had no material event (default 30).
  masterSessionMinutes: z.number().int().min(30).max(720).optional(),
  masterHeartbeatMinutes: z.number().int().min(5).max(240).optional(),
  // How long a launched runtime has to come up in its pane before the launch fails and closes it
  // (GY-413); default 60. A loaded host echoes the launch command slowly, which is a slow start.
  launchStartSeconds: z.number().int().min(10).max(600).optional(),
  // Worktree reclamation: how long an assignment worktree may sit untouched before its dependency
  // directories count as disposable, and the free space below which `master status` raises disk
  // pressure. Both are read from .graphyard/master.json on every cycle, so a host with a smaller
  // volume raises the threshold without restarting the loop.
  reclaimIdleHours: z.number().min(0.25).max(720).optional(),
  diskThresholdGb: z.number().min(0.1).max(10_000).optional(),
  // How many finished assignment worktrees one reclaim pass removes outright (GY-360; default 50),
  // so a large backlog drains over a few cycles without stalling any one of them.
  worktreeRemovalLimit: z.number().int().min(1).max(1000).optional(),
  // The managed worktree root every proof and review checkout is created under: an absolute path
  // on durable storage outside every worktree (default: the installation's data directory), the
  // free space setup and each launch require of its volume, and the size the root may reach before
  // `master status` asks for a reclaim — a user quota is invisible in the volume's free space.
  worktreeRoot: z.string().trim().min(1).max(1000).refine(isAbsolute, 'worktreeRoot must be an absolute path').optional(),
  worktreeRootMinFreeGb: z.number().min(0.1).max(10_000).optional(),
  worktreeRootBudgetGb: z.number().min(0.1).max(10_000).optional(),
  // An account whose provider usage reached this percentage of any window is skipped at launch:
  // a session started just below a hard limit would stall mid-task.
  quotaCeilingPercent: z.number().int().min(50).max(100).optional(),
  // The runtime of each narrow role (GY-169): `herdr`, a terminal session (what an absent setting
  // means), or `pi`, the headless runner (src/runner) — the approver, and the producer for the
  // unit proof group. `pi` names the environment wrapper and model those runs use.
  runtimes: narrowRoleRuntimeSchema.optional(),
  pi: piRuntimeSchema.optional(),
  // Research before build (GY-259): the cheap Pi session that briefs a feature before its worker
  // starts — its model (the Z.AI GLM flash model by default), time limit and token budget.
  research: researchSettingsSchema.optional(),
  // The diagnostician (GY-439): the headless Pi session that turns each recurring-fault item into
  // its root cause and a fix item — its model, stronger fallback model, time limit, the bound an
  // invariant violation stands before it is diagnosed, and the commands that read its log excerpts.
  diagnostician: diagnosticianSettingsSchema.optional(),
}).strict();
export type MasterRun = z.infer<typeof masterRunSchema>;

// The operator's own authenticated browser profile: a Chrome profile name (such as Default) or the
// path of a persistent profile directory. Used only by the enumerated master browser flows.
export const masterBrowserSchema = z.object({
  profile: z.string().trim().min(1).max(500),
  executable: z.string().trim().min(1).max(500).optional(),
}).strict();
export type MasterBrowser = z.infer<typeof masterBrowserSchema>;

export const agentIdentitySchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/), credentialFile: z.string().min(1).max(1000) }).strict();
/**
 * GY-516: the product default for `mergeQueue.rerunFailedChecks`, so every installation reruns a
 * failed required check once on the same sha before the failure ejects the entry; 0 disables it.
 */
export const defaultRerunFailedChecks = 1;
/** The most reruns per sha and check master config and the control plane accept. */
export const maxRerunFailedChecks = 3;
export const masterConfigSchema = z.object({
  version: z.literal(1),
  url: z.string(),
  credentialFile: z.string(),
  cliPath: z.string(),
  repository: z.string().min(1),
  baseBranch: z.string().min(1).max(200),
  githubAppId: z.number().int().positive(),
  hostId: z.string().trim().min(1).max(200),
  herdrWorkspace: z.string().trim().min(1).max(200).optional(),
  masterAgentName: sessionNameField,
  autoMerge: z.boolean().default(true),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  workers: z.array(workerProfileSchema).max(100).default([]),
  reviewer: reviewerIdentitySchema.optional(),
  reviewers: z.array(reviewerProfileSchema).max(20).default([]),
  producers: z.array(producerProfileSchema).max(20).default([]),
  // The agent environments profiles may launch on, discovered or created by master environments.
  environments: z.array(agentEnvironmentSchema).max(50).optional(),
  run: masterRunSchema.prefault({}),
  // The merge queue. `parallelTips` (GY-498) is how many queue positions are validated at once:
  // speculative tips for the first that many positions all published and CI'd concurrently, each
  // entry on its own tip, an entry whose tip and every tip ahead of it passed merging as soon as it
  // heads the queue (default 4). Since every entry has its own tip, `batchSize` (GY-330) no longer
  // batches validation; it only widens the observation band and the delivery/ejection wake depth.
  // `optimistic` (GY-500, default on): an entry whose files are disjoint from everything merged since
  // its base, touching no shared infrastructure, merges at once past the queue, and main is guarded
  // after the merge with automatic revert. false sends every entry through the queue.
  // The loop publishes all of these to the control plane on every change.
  // `optimisticExclude` (GY-503): the repository's own shared-infrastructure globs, master init
  // written with the product defaults; a change to an excluded path never merges optimistically.
  // `ciConcurrency` (GY-501): the repository's concurrent Actions job limit as the operator declares
  // it (GitHub does not report it); master protection compares it with parallelTips × jobs per run.
  mergeQueue: z.object({
    batchSize: z.number().int().min(1).max(maxMergeBatchSize).optional(),
    optimistic: z.boolean().optional(),
    parallelTips: z.number().int().min(1).max(maxParallelTips).optional(),
    ciConcurrency: z.number().int().min(1).max(10000).optional(),
    rerunFailedChecks: z.number().int().min(0).max(maxRerunFailedChecks).optional(),
    optimisticExclude: z.array(z.string().trim().min(1).max(200)
      .refine(glob => !glob.startsWith('/') && !/[\s\u0000-\u001f]/.test(glob) && !glob.split('/').some(segment => segment === '.' || segment === '..'),
        'Exclude globs are repository-relative, without . or .. segments, whitespace or control characters')).max(100).optional(),
  }).strict().optional(),
  // The operator's own authenticated browser profile, used only by master browser flows.
  browser: masterBrowserSchema.optional(),
  // The master's own operator-agent identity, and the separate approver identity whose session
  // approves the master's two-party decisions (master autonomy). Paths only, never tokens.
  operatorAgent: agentIdentitySchema.optional(),
  approver: agentIdentitySchema.optional(),
  // The system invariants' thresholds (GY-404, src/model/invariants.ts): every field optional,
  // each defaulting to the bound the loop checks every cycle.
  invariants: invariantThresholdsSchema.optional(),
}).strict();
export type MasterConfig = z.infer<typeof masterConfigSchema>;
/**
 * How many sessions the automatic reviewer profile runs when its `concurrency` is unset (GY-1072).
 * Every automatic review goes to the profile `run.reviewerProfile` names, so at the general
 * default of one the whole installation reviewed one candidate at a time, and one finished
 * session left in its pane held the only name and stalled every review behind it. The profile
 * `run.reviewerProfile` names therefore runs this many sessions unless it declares its own
 * concurrency; every other profile keeps the default of one.
 */
export const automaticReviewerConcurrency = 4;
/**
 * The config as the reviewer launchers and their readers count sessions: the automatic profile's unset
 * concurrency read as `automaticReviewerConcurrency`. `loadMasterConfig` applies it once at load
 * (GY-1075) and writers read `loadStoredMasterConfig`, so the default is never written back; it is
 * idempotent, so a caller handed a config built elsewhere may still apply it.
 */
export function withReviewerDefaults<T extends Pick<MasterConfig, 'reviewers' | 'run'>>(config: T): T {
  const automatic = config.run.reviewerProfile;
  if (!automatic || !config.reviewers.some(profile => profile.name === automatic && profile.concurrency === undefined)) return config;
  return { ...config, reviewers: config.reviewers.map(profile => profile.name === automatic && profile.concurrency === undefined ? { ...profile, concurrency: automaticReviewerConcurrency } : profile) };
}
/** The merge queue's batch size under this master config: `mergeQueue.batchSize`, or the default of 4. */
export function mergeBatchSize(config: Pick<MasterConfig, 'mergeQueue'> | null | undefined): number {
  return config?.mergeQueue?.batchSize ?? defaultMergeBatchSize;
}
/** Whether optimistic merge is on under this master config: `mergeQueue.optimistic`, on by default (GY-500). */
export function optimisticMergeEnabled(config: Pick<MasterConfig, 'mergeQueue'> | null | undefined): boolean {
  return config?.mergeQueue?.optimistic ?? defaultOptimisticMerge;
}

/** The parallel-tip window under this master config: `mergeQueue.parallelTips`, or the default of 4 (GY-498). */
export function mergeParallelTips(config: Pick<MasterConfig, 'mergeQueue'> | null | undefined): number {
  return config?.mergeQueue?.parallelTips ?? defaultParallelTips;
}

/** The recommended parallel-tips value onboarding writes into a new installation's master.json (GY-501): the product default every installation gets, never this repository's own config. */
export const onboardingParallelTips = defaultParallelTips;

/**
 * The merge queue as the control plane runs it (GY-330, GY-498): the batch size and parallel-tip
 * window the server reports it evaluates by (`/api/status` mergeQueue), else this master's own
 * configuration before the server reports one; the in-flight tips; throughput Insights.
 */
export function mergeQueueWindow(master: MasterConfig, coordinator?: any) {
  const running = coordinator?.mergeQueue;
  return { batchSize: Number.isSafeInteger(running?.batchSize) ? running.batchSize as number : mergeBatchSize(master),
    parallelTips: Number.isSafeInteger(running?.parallelTips) ? running.parallelTips as number : mergeParallelTips(master) };
}
export function mergeQueueStatus(master: MasterConfig, snapshot: { work: Work[]; now: string }, coordinator?: any) {
  const window = mergeQueueWindow(master, coordinator);
  return { ...window, configured: { batchSize: mergeBatchSize(master), parallelTips: mergeParallelTips(master) },
    ...mergeQueueInsights(snapshot.work, Date.parse(snapshot.now), window.parallelTips, Array.isArray(coordinator?.ciAppIds) ? coordinator.ciAppIds : null) };
}

/** Reruns of a failed required check per sha under this master config: `mergeQueue.rerunFailedChecks`, or the product default of 1. */
export function rerunFailedChecks(config: Pick<MasterConfig, 'mergeQueue'> | null | undefined): number {
  return config?.mergeQueue?.rerunFailedChecks ?? defaultRerunFailedChecks;
}

/** The repository's shared-infrastructure globs under this master config: `mergeQueue.optimisticExclude`, or the product defaults (GY-503). */
export function optimisticExcludeGlobs(config: Pick<MasterConfig, 'mergeQueue'> | null | undefined): string[] {
  return config?.mergeQueue?.optimisticExclude ?? [...defaultOptimisticExclude];
}

export function assertMasterBinding(config: MasterConfig, status: any) {
  if (status.actor?.role !== 'coordinator') throw new Error('Master commands require the configured coordinator identity');
  if (typeof status.repository !== 'string' || status.repository.toLowerCase() !== config.repository.toLowerCase() || status.baseBranch !== config.baseBranch || status.githubAppId !== config.githubAppId) throw new Error('The Graphyard repository, managed base branch, or GitHub App changed; rerun master init before continuing');
}

// ---- The coordinator checkout guard (GY-857) -----------------------------------------------------
//
// Worker confinement is one half of the containment; this is the other: nothing that runs
// Graphyard's own code — the master loop, an executor — may start, self-upgrade or restart from
// a coordinator checkout holding uncommitted work, because that is how unreviewed half-finished
// files reach the live loop (workers wrote them there by absolute path, and a restart loaded
// them). The checkout a process runs from is derived from the configured CLI launcher exactly as
// repository-setup links the plugin: `<root>/bin/graphyard.mjs`. `dirty` here means tracked
// files that differ from HEAD, or untracked files under the source paths — a scratch or ignored
// file is nobody's code.

/** The coordinator checkout the CLI launcher at `cliPath` runs from: `<root>/bin/graphyard.mjs`. */
export const coordinatorCheckoutRoot = (cliPath: string) => dirname(dirname(cliPath));
/** The checkout areas whose files the loop and the executors load; untracked files under them are uncommitted source, not scratch. */
export const coordinatorSourcePrefixes = ['src/', 'scripts/', 'bin/', 'tests/', 'docs/'];
export const coordinatorSourceFiles = ['package.json', 'package-lock.json', 'tsconfig.json'];
export const isCoordinatorSourcePath = (path: string) => coordinatorSourceFiles.includes(path) || coordinatorSourcePrefixes.some(prefix => path.startsWith(prefix));

/** How a coordinator checkout stands: its commit, and the paths that make it dirty. */
export interface CoordinatorCheckout { root: string; commit: string | null; /** Tracked files that differ from HEAD. */ modified: string[]; /** Untracked, not ignored files under the source paths. */ untracked: string[] }
export type CheckoutRun = (command: string, args: string[]) => Promise<string> | string;
/** The commit and porcelain status a checkout read produced; both verbatim (`-z`), never trimmed. */
export function parseCoordinatorCheckout(root: string, commitRead: string, status: string): CoordinatorCheckout {
  const commit = commitRead.trim() || null;
  const modified: string[] = [], untracked: string[] = [];
  // -z: entries verbatim and NUL-separated; a rename or copy carries its old path in a second field.
  const entries = status.split('\0');
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2), path = entry.slice(3);
    if (xy === '!!') continue;
    if (xy === '??') { if (isCoordinatorSourcePath(path)) untracked.push(path); continue; }
    if (xy.includes('R') || xy.includes('C')) index++;
    modified.push(path);
  }
  return { root, commit, modified, untracked };
}
const checkoutGitRun: CheckoutRun = (command, args) => defaultChildRun(command, args).then(output => String(output));
/** Reads how the checkout at `root` stands, through the asynchronous runner. An unreadable checkout (no git, no commit) is never dirty: it cannot be read as code either. */
export async function readCoordinatorCheckout(root: string, run: CheckoutRun = checkoutGitRun): Promise<CoordinatorCheckout> {
  const git = async (args: string[]) => String(await run('git', ['-C', root, ...args]));
  let commitRead: string;
  try { commitRead = await git(['rev-parse', 'HEAD']); }
  catch { return { root, commit: null, modified: [], untracked: [] }; }
  try { return parseCoordinatorCheckout(root, commitRead, await git(['status', '--porcelain', '-z', '--untracked-files=normal'])); }
  catch { return { root, commit: commitRead.trim() || null, modified: [], untracked: [] }; }
}
/** Every path that makes the checkout dirty: what a refusal names and what a lease match is judged on. */
export const dirtyCheckoutPaths = (checkout: CoordinatorCheckout) => checkout.commit ? [...checkout.modified, ...checkout.untracked] : [];
/**
 * Whether the guard judges this checkout at all. In production every checkout is judged; under
 * the test runner only one under the temporary directories is, so the suite — which runs from
 * the real checkout — tests the refusal with fixtures, and the real checkout's own scratch never
 * refuses a test's loop or executor.
 */
export function checkoutGuardApplies(root: string): boolean {
  if (!underTestRunner()) return true;
  const directory = resolve(root);
  return temporaryDirectories().some(temporary => directory === temporary || directory.startsWith(`${temporary}${sep}`));
}
/** The dirty paths, for the work snapshot's live leases whose planned files match them. */
export interface DirtyCheckoutLease { key: string; epoch: number; owner: string; paths: string[] }
export function dirtyCheckoutLeases(work: { key: string; lease?: { epoch: number; owner: string; expiresAt: string } | null; plannedFiles?: readonly string[] }[], paths: readonly string[], now: number = Date.now()): DirtyCheckoutLease[] {
  return work.flatMap(item => {
    if (!item.lease || Date.parse(item.lease.expiresAt) <= now) return [];
    const matched = paths.filter(path => (item.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)));
    return matched.length ? [{ key: item.key, epoch: item.lease.epoch, owner: item.lease.owner, paths: matched }] : [];
  });
}
/** Why `subject` refuses the checkout, or null when it is clean (or has no readable commit). */
export function coordinatorCheckoutRefusal(checkout: CoordinatorCheckout, subject: string): string | null {
  const dirty = dirtyCheckoutPaths(checkout);
  if (!checkout.commit || !dirty.length) return null;
  const named = dirty.slice(0, 8).join(', ');
  const paths = `dirty path(s): ${named}${dirty.length > 8 ? `; and ${dirty.length - 8} more` : ''}`;
  return `${subject} refuses to start, self-upgrade or restart from the coordinator checkout at ${checkout.root}: it holds uncommitted work at ${checkout.commit.slice(0, 12)} — ${checkout.modified.length} modified and ${checkout.untracked.length} untracked source ${paths}. It keeps running the last clean code; clean or stash these paths, then restart ${subject}`;
}
/** The refusal as `master status` raises it: the escalation also names which live leases' planned files the dirty paths match. */
export const dirtyCheckoutEscalation = (refusal: string, leases: DirtyCheckoutLease[]) => leases.length
  ? `${refusal}. The paths match the planned files of ${leases.length === 1 ? 'one live lease' : `${leases.length} live leases`}: ${leases.map(lease => `${lease.key} epoch ${lease.epoch} (${lease.owner}): ${lease.paths.join(', ')}`).join('; ')}`
  : refusal;

// ---- OS-level confinement of the coordinator checkout (GY-888) -----------------------------------
//
// GY-857's harness rules are a prompt policy, and shell commands (`cp`, `sed`, `git commit`,
// `git checkout`) never matched them: workers moved the coordinator checkout four times in one
// day through plain Bash. GY-888 makes the checkout unwritable at the OS level for every session
// the launcher starts — worker, reviewer, producer and approver — by carrying the confinement on
// the launch itself, in whatever the runtime supports:
//
// - a runtime whose filesystem sandbox leaves every ungranted path read-only (codex under
//   `workspace-write`, enforced by workerConfinementRefusal) IS the confinement: the checkout's
//   working tree is never among the granted paths;
// - every other runtime runs inside a bubblewrap mount namespace in which the coordinator checkout
//   is bind-mounted read-only, and only what the session's own work needs is re-exposed writable
//   on top: its own directory (the assigned worktree or allocated checkout) and the shared Git
//   areas a linked worktree writes — the object store, the session's own per-worktree admin (only
//   the whole `.git/worktrees` when the session creates worktrees of its own), the `graphyard/`
//   branch namespace with its reflogs, remote-tracking refs and FETCH_HEAD — never the checkout's
//   source tree, its index, or the refs of branches only the guarded merge moves. The namespace
//   unshares PIDs and mounts a fresh /proc, so another process's /proc/<pid>/root is not a route
//   back to the writable checkout;
//
// A launch that cannot apply the confinement is refused with the reason named, never started
// unconfined, exactly like a contained install (GY-174): install bubblewrap, or let the runtime
// carry a workspace-write sandbox. The master session is not among the confined roles — it runs
// the loop's own configuration and administration commands from the coordinator root, and is
// bound by its own harness rules instead.

/** How a launch keeps the coordinator checkout unwritable for the session it starts. */
export interface CoordinatorConfinement {
  /** Which mechanism applies: the runtime's own filesystem sandbox, or a read-only mount namespace. */
  mechanism: 'runtime-sandbox' | 'read-only-mount';
  /** Words placed before the runtime command to apply the confinement; empty for the runtime's own sandbox. */
  wrapper: readonly string[];
  /** What the confinement holds, for the launch record. */
  detail: string;
}

export interface ConfinementInput {
  kind: string;
  args: readonly string[];
  coordinatorRoot: string;
  /** The directory the runtime starts in — also the workspace root its own sandbox would grant (GY-888). */
  sessionDirectory: string;
  /** The directory the launch allocates for the session's own writes, re-exposed by the read-only mount; defaults to `sessionDirectory`. A terminal reviewer or producer starts from the coordinator root (`sessionDirectory`) while its allocated checkout is a directory beside it (GY-888, review finding): the mount re-exposes the allocated checkout, never the root it starts in. */
  allocatedDirectory?: string;
  /** Defaults to this host's platform. */
  platform?: string;
  /** The bubblewrap executable; null when it is known absent, the PATH lookup when unset. */
  bwrap?: string | null;
  /** Overrides the availability probe (tests); when absent, the probe runs once and is cached. */
  mountNamespaceWorks?: boolean;
  /** The session pushes and calls GitHub with a short-lived credential of its own (a worker's, GY-999; a reviewer's), so its session bus stays `/dev/null` instead of the keyring-only proxy that reaches the operator's login (GY-1039). */
  ownGitHubCredential?: boolean;
}
const withinCheckout = (path: string, root: string) => { const from = relative(root, path); return from !== '' && from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from); };
/** Whether `path` is a directory (or nothing); symlinks to directories count, as bwrap binds resolve them. */
const isDirectoryPath = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
/** The bubblewrap executable on this PATH, or null: the synchronous lookup a spawn wrapper needs. */
export const bwrapOnPath = (env: NodeJS.ProcessEnv = process.env): string | null => {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, 'bwrap');
    try { if (existsSync(candidate)) return candidate; } catch { /* an unreadable PATH entry is skipped */ }
  }
  return null;
};

/** The writable scope a launch's own runtime sandbox grants: the session's working directory (the sandbox's workspace root) and every `--add-dir`, resolved against it. */
const sandboxWritableScope = (args: readonly string[], sessionDirectory: string): string[] => {
  const scope: string[] = [resolve(sessionDirectory)];
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index].split(/=(.*)/s);
    if (flag !== '--add-dir') continue;
    const value = inline ?? args[index + 1];
    if (value) scope.push(resolve(sessionDirectory, value));
  }
  return scope;
};
/**
 * Whether the runtime's own workspace-write sandbox IS the confinement (GY-888): the sandbox
 * leaves every ungranted path read-only, which confines the checkout only while the checkout and
 * the Git directory it writes through (`checkoutGitDirectory`, which lies outside the checkout when
 * the coordinator itself is a linked worktree — GY-957, review finding) lie outside every path the
 * sandbox grants. A session whose working directory or an `--add-dir` would hold the checkout — a
 * terminal reviewer or producer runs from the coordinator root — cannot claim it, and carries the
 * read-only mount instead.
 */
const runtimeSandboxConfines = (input: ConfinementInput): boolean => {
  if (runtimeSandboxes[input.kind]?.mode([...input.args]) !== 'workspace-write') return false;
  const root = resolve(input.coordinatorRoot), git = checkoutGitDirectory(root);
  const own = resolve(input.sessionDirectory);
  const admin = sessionGitAdminDirectory(own, root);
  // What the sandbox may grant inside the checkout: the session's own worktree and its own worktree
  // admin directory — never the checkout itself. A session whose workspace IS the checkout root
  // therefore has no exemption at all.
  const exempt = [...(own !== root ? [own] : []), ...(admin && admin !== root ? [admin] : [])];
  const inside = (path: string, directory: string) => path === directory || withinCheckout(path, directory);
  const overlaps = (path: string, directory: string) => path === directory || withinCheckout(directory, path) || withinCheckout(path, directory);
  // A grant disqualifies when it touches the checkout or its Git administrative state outside the
  // exemption — a worker launch grants the common Git directory so the runtime can commit, and that
  // grant would leave coordinator refs, index and reflogs writable; such a launch carries the mount
  // wrapper, which re-exposes only the session's own Git paths (GY-888, GY-957 review findings).
  return !sandboxWritableScope(input.args, input.sessionDirectory).some(path =>
    (overlaps(path, root) || overlaps(path, git)) && !exempt.some(zone => inside(path, zone)));
};

/**
 * The linked-worktree administrative directory the session's own directory writes through, or null when
 * it is not a linked worktree of the coordinator checkout. A linked worktree points at its admin through
 * its `.git` file, so this reads the pointer rather than asking git, and pins it under the coordinator's
 * common worktrees area (`checkoutGitDirectory`), which is outside the checkout when the coordinator
 * itself is a linked worktree. Pinning one session's Git admin, instead of the whole worktrees area,
 * keeps concurrent assignments' worktree metadata unwritable to each other (GY-888). A reviewer's or
 * producer's allocated directory is a managed session checkout outside every worktree that holds its
 * linked worktree as the `checkout` child (install/worktree-root.ts sessionCheckout), so that child's
 * pointer is read too. The coordinator's own admin — its HEAD and index when it is a linked worktree —
 * is never the session's (GY-957, review finding).
 */
export const sessionGitAdminDirectory = (sessionDirectory: string, root: string): string | null => {
  const directory = resolve(sessionDirectory), checkout = resolve(root);
  if (directory === checkout) return null;
  const coordinatorAdmin = checkoutWorktreeAdminDirectory(checkout);
  const shared = join(checkoutGitDirectory(checkout), 'worktrees');
  for (const candidate of [directory, join(directory, 'checkout')]) {
    const gitDir = gitPointerAdminDirectory(candidate);
    if (gitDir && gitDir !== coordinatorAdmin && gitDir.startsWith(`${shared}${sep}`) && isDirectoryPath(gitDir)) return gitDir;
  }
  return null;
};

/**
 * The bubblewrap words that hide the host's process-launch channels under paths that exist: each
 * named directory is replaced by an empty one, and each bus socket by a device that no client can
 * connect to. Through the session bus a confined process could otherwise ask the user's systemd
 * manager (`systemd-run --user`) — or the system one over `/run/dbus` (`systemd-run --system`) — to
 * start a helper outside this mount namespace and write the underlying, writable coordinator
 * checkout, which a fresh `/proc` alone does not close (GY-888, review finding). Candidates that
 * would hide a protected path are dropped. Each candidate is named by its canonical real path
 * before deduplication: bubblewrap (up to 0.11) builds a mount point only where every path
 * component resolves inside the namespace, and a destination reached through an absolute symlink —
 * `/var/run` → `/run` on Debian-family hosts — resolves against its own staging root, where the
 * target does not exist, so the launch dies with "Can't mkdir". The canonical path also aliases
 * that pair to one mask, and hiding the real directory hides every symlink to it.
 *
 * When `secretsBus` names a live socket, each session-bus socket is replaced by it instead of by
 * `/dev/null`: the keyring-only proxy (`graphyard-secrets-bus.socket`, filtered in
 * `graphyard-secrets-bus-filter.service`) reaches only the read methods of the keyring holding the
 * operator's GitHub login, so `gh auth git-credential` works while systemd1 and every other bus name
 * stay unreachable. A session with a GitHub credential of its own gets no `secretsBus` (GY-1039).
 */
export const processLaunchMaskWords = (
  targets: { directories?: readonly string[]; busSockets?: readonly string[]; secretsBus?: string | null },
  protect: readonly string[],
): readonly string[] => {
  const hides = (path: string) => !protect.some(p => p === path || withinCheckout(p, path));
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  const directories = [...new Set((targets.directories ?? []).filter(path => isAbsolute(path) && isDirectoryPath(path) && hides(path)).map(canonical))];
  const sockets = [...new Set((targets.busSockets ?? []).filter(path => isAbsolute(path) && existsSync(path) && !isDirectoryPath(path) && hides(path)).map(canonical))];
  const proxy = targets.secretsBus && isAbsolute(targets.secretsBus) && isSocketPath(targets.secretsBus) ? canonical(targets.secretsBus) : '/dev/null';
  return [...directories.flatMap(path => ['--tmpfs', path]), ...sockets.flatMap(path => ['--ro-bind', proxy, path])];
};
export const isSocketPath = (path: string) => { try { return statSync(path).isSocket(); } catch { return false; } };
/** Where `graphyard-secrets-bus.socket` listens: `$GRAPHYARD_SECRETS_BUS`, else `graphyard-secrets-bus` in the user's runtime directory. */
export const secretsBusPath = (uid: number | undefined = process.getuid?.(), env: NodeJS.ProcessEnv = process.env): string | null =>
  env.GRAPHYARD_SECRETS_BUS || (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'graphyard-secrets-bus') : uid === undefined ? null : `/run/user/${uid}/graphyard-secrets-bus`);
/**
 * The host's own process-launch channels that exist here: the systemd manager directories and
 * session-bus sockets of the user's runtime directory (`/run/user/<uid>`, `$XDG_RUNTIME_DIR`) and
 * the system bus directory. Whether a candidate may be hidden is `processLaunchMaskWords`'s call.
 */
export const hostProcessLaunchTargets = (uid: number | undefined = process.getuid?.(), env: NodeJS.ProcessEnv = process.env): { directories: string[]; busSockets: string[]; secretsBus: string | null } => {
  const runtimeDirectories = [...new Set([uid === undefined ? null : `/run/user/${uid}`, env.XDG_RUNTIME_DIR || null]
    .filter((path): path is string => !!path && isAbsolute(path)).map(path => { try { return realpathSync(path); } catch { return path; } }))];
  const directories = [...runtimeDirectories.map(directory => join(directory, 'systemd')), '/run/dbus', '/var/run/dbus'];
  return { directories, busSockets: runtimeDirectories.map(directory => join(directory, 'bus')), secretsBus: secretsBusPath(uid, env) };
};

/**
 * The bubblewrap words that run a session with the coordinator checkout unwritable (GY-888): the
 * whole host exactly as it is, the checkout bind-mounted read-only over it, and only what the
 * session's own work needs re-exposed writable on top — bubblewrap applies each bind in order, so
 * the later ones shadow the read-only one. The shared Git paths and the checkout's FETCH_HEAD
 * resolve through `checkoutGitDirectory`/`checkoutWorktreeAdminDirectory`, so a coordinator that is
 * itself a linked worktree protects its real common Git directory instead of a `.git` pointer file
 * (GY-957, review finding); where that directory lies outside the checkout it is bound read-only
 * beside it, since `--ro-bind root root` alone would leave it writable under `--dev-bind / /`. The
 * namespace also unshares PIDs and mounts a fresh `/proc`, so another process's `/proc/<pid>/root`
 * is not a route back to the writable checkout (the escape `containedInstall` closes for installs),
 * and the host's process-launch channels are hidden so no command can start the write outside the
 * namespace; a session keeps the network and its own process tree. The wrapper ends with `--`, so
 * the runtime command follows it.
 */
export function readOnlyMountWrapper(input: { coordinatorRoot: string; sessionDirectory: string; bwrap?: string | null; ownGitHubCredential?: boolean }): readonly string[] {
  const root = resolve(input.coordinatorRoot), directory = resolve(input.sessionDirectory);
  const gitDir = checkoutGitDirectory(root);
  const adminDirectory = sessionGitAdminDirectory(directory, root);
  const sharedDirectories = [
    join(gitDir, 'objects'), ...(adminDirectory ? [adminDirectory] : [join(gitDir, 'worktrees')]), join(gitDir, 'refs', 'remotes'), join(gitDir, 'logs', 'refs', 'remotes'),
    join(gitDir, 'refs', 'heads', 'graphyard'), join(gitDir, 'logs', 'refs', 'heads', 'graphyard'),
  ].filter(isDirectoryPath);
  const fetchHead = join(checkoutWorktreeAdminDirectory(root) ?? gitDir, 'FETCH_HEAD');
  const shared = [...sharedDirectories, ...(existsSync(fetchHead) && !isDirectoryPath(fetchHead) ? [fetchHead] : [])];
  const own = withinCheckout(directory, root) ? [directory] : [];
  const bwrap = input.bwrap ?? 'bwrap';
  const masks = processLaunchMaskWords({ ...hostProcessLaunchTargets(), ...(input.ownGitHubCredential ? { secretsBus: null } : {}) }, [root, directory]);
  const externalGitDir = gitDir !== root && !withinCheckout(gitDir, root) && isDirectoryPath(gitDir) ? [gitDir] : [];
  // A session with no admin of its own re-exposes the whole worktrees area; when the coordinator is
  // itself a linked worktree its own admin (HEAD, index) lies there, so it is bound read-only again
  // after that re-exposure — only its FETCH_HEAD, bound after it, stays writable (GY-957, review finding).
  const coordinatorAdmin = checkoutWorktreeAdminDirectory(root);
  const protectAdmin = !adminDirectory && coordinatorAdmin && sharedDirectories.some(path => withinCheckout(coordinatorAdmin, path)) ? [coordinatorAdmin] : [];
  return [bwrap, '--unshare-pid', '--dev-bind', '/', '/', ...masks, '--proc', '/proc', '--ro-bind', root, root,
    ...externalGitDir.flatMap(path => ['--ro-bind', path, path]),
    ...[...sharedDirectories, ...own].flatMap(path => ['--bind', path, path]),
    ...protectAdmin.flatMap(path => ['--ro-bind', path, path]),
    ...shared.filter(path => !sharedDirectories.includes(path)).flatMap(path => ['--bind', path, path]), '--'];
}

/** The one refusal text for a launch whose coordinator confinement cannot be applied (GY-888): the head names the runtime and the checkout, `problem` says what is missing. */
export const confinementRefusalText = (kind: string, coordinatorRoot: string, problem: { platform?: string; bwrapMissing?: boolean; namespaces?: boolean; undetermined?: string; gitDirectory?: string }): string => {
  const head = `A ${kind} session cannot be launched with the coordinator checkout at ${coordinatorRoot} unwritable at the OS level`;
  if (problem.gitDirectory) return `${head}: the Git directory it writes through cannot be resolved — ${problem.gitDirectory}. Graphyard never starts a session unconfined; repair the checkout (git worktree repair) so its .git names its Git directory.`;
  if (problem.undetermined) return `${head}: ${problem.undetermined} Graphyard never starts a session unconfined; run the launcher through its own bin/graphyard.mjs from the checkout it serves, so every launch carries the confinement.`;
  const own = 'and the runtime carries no filesystem sandbox of its own';
  if (problem.platform) return `${head}: the read-only mount namespace it would run in needs Linux, this host is ${problem.platform}, ${own}. Graphyard never starts a session unconfined; run sessions on a Linux host or grant the runtime a workspace-write sandbox.`;
  if (problem.bwrapMissing) return `${head}: bubblewrap (bwrap) is not installed ${own}. Graphyard never starts a session unconfined; install bubblewrap (e.g. apt install bubblewrap) or grant the runtime a workspace-write sandbox.`;
  return `${head}: this host refuses the unprivileged namespaces bubblewrap needs, ${own}. Graphyard never starts a session unconfined; allow unprivileged user namespaces on this host or grant the runtime a workspace-write sandbox.`;
};

/** Whether bubblewrap can build the mount namespace here; a host may refuse unprivileged namespaces. Probed through the asynchronous runner once per executable and cached; the probe asks for the pid namespace and a fresh /proc too, because that is what the wrapper itself requires. */
export async function sessionMountNamespaceWorks(bwrap = 'bwrap'): Promise<boolean> {
  if (!mountNamespaceProbes.has(bwrap)) {
    const probe = defaultChildRun(bwrap, ['--unshare-pid', '--dev-bind', '/', '/', '--proc', '/proc', '--', 'true'], { timeoutMs: 20_000 })
      .then(value => { mountNamespaceAnswers.set(bwrap, true); return true; }, () => { mountNamespaceAnswers.set(bwrap, false); return false; });
    mountNamespaceProbes.set(bwrap, probe);
  }
  return mountNamespaceProbes.get(bwrap)!;
}
const mountNamespaceProbes = new Map<string, Promise<boolean>>();
const mountNamespaceAnswers = new Map<string, boolean>();
/** The last probed answer for `bwrap`, or undefined while none is known: the synchronous spawn wrapper refuses on false and lets bubblewrap itself fail on unknown. */
export const mountNamespaceProbeResult = (bwrap = 'bwrap'): boolean | undefined => mountNamespaceAnswers.get(bwrap);

/** Why a launch of `kind` cannot keep the coordinator checkout unwritable at the OS level, or null. A runtime sandbox of its own needs neither Linux nor bubblewrap — but only while the checkout lies outside every path the sandbox grants. */
export async function coordinatorConfinementRefusal(input: ConfinementInput): Promise<string | null> {
  const gitDirectory = checkoutGitProblem(input.coordinatorRoot);
  if (gitDirectory) return confinementRefusalText(input.kind, input.coordinatorRoot, { gitDirectory });
  if (runtimeSandboxConfines(input)) return null;
  const bwrap = input.bwrap !== undefined ? input.bwrap : bwrapOnPath();
  const platform = input.platform ?? process.platform;
  if (platform !== 'linux') return confinementRefusalText(input.kind, input.coordinatorRoot, { platform });
  if (!bwrap) return confinementRefusalText(input.kind, input.coordinatorRoot, { bwrapMissing: true });
  if (!(input.mountNamespaceWorks ?? await sessionMountNamespaceWorks(bwrap))) return confinementRefusalText(input.kind, input.coordinatorRoot, { namespaces: true });
  return null;
}

/**
 * The confinement a launch of `kind` carries, or null when there is no coordinator checkout to
 * confine (the launcher does not run from one). Throws the coordinatorConfinementRefusal reason
 * when the kind can carry none: a launch is never started unconfined. The shared Git paths are
 * re-exposed only where they already exist — the launcher prepares the missing ones
 * (launch.ts prepareConfinedGitPaths) before building the launch.
 */
export async function coordinatorConfinement(input: ConfinementInput): Promise<CoordinatorConfinement | null> {
  const gitDirectory = checkoutGitProblem(input.coordinatorRoot);
  if (gitDirectory) throw new Error(confinementRefusalText(input.kind, input.coordinatorRoot, { gitDirectory }));
  if (runtimeSandboxConfines(input))
    return { mechanism: 'runtime-sandbox', wrapper: [], detail: `the ${input.kind} workspace-write sandbox keeps every path but its granted workspace directories read-only, and the coordinator checkout at ${input.coordinatorRoot} lies outside every one of them` };
  const refusal = await coordinatorConfinementRefusal(input);
  if (refusal) throw new Error(refusal);
  const root = resolve(input.coordinatorRoot), directory = resolve(input.allocatedDirectory ?? input.sessionDirectory);
  const wrapper = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: directory, bwrap: input.bwrap ?? undefined, ownGitHubCredential: input.ownGitHubCredential });
  const reexposed = wrapper.filter((word, index) => index > 0 && wrapper[index - 1] === '--bind');
  return { mechanism: 'read-only-mount', wrapper,
    detail: `the coordinator checkout at ${root} is bind-mounted read-only for the session in a bubblewrap namespace whose /proc shows only the session's own processes; only ${reexposed.join(', ') || 'nothing'} are re-exposed writable, so no shell command can write, commit in or switch the checkout` };
}
