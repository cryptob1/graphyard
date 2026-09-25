// Concern: worker, reviewer and producer profiles, the master config schema, and profile session naming.
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { defaultMergeBatchSize, maxMergeBatchSize } from '../merge-queue.js';
import { sessionNameField, sessionNameLimit, assertSessionName, sessionNameDigestLength, SessionNameRefusedError } from '../session-name.js';

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
  // How long a launched reviewer or producer session may show no activity before the loop
  // re-prompts it once, and how long after that re-prompt a still-quiet session is recorded as
  // never started (see acknowledgeLaunch); default 90.
  acknowledgementSeconds: z.number().int().min(30).max(900).optional(),
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
  // The merge queue (GY-330): how many consecutive entries one combined tip validates (default 4;
  // 1 validates every entry on its own tip). The loop publishes it to the control plane every change.
  mergeQueue: z.object({ batchSize: z.number().int().min(1).max(maxMergeBatchSize).optional() }).strict().optional(),
  // The operator's own authenticated browser profile, used only by master browser flows.
  browser: masterBrowserSchema.optional(),
  // The master's own operator-agent identity, and the separate approver identity whose session
  // approves the master's two-party decisions (master autonomy). Paths only, never tokens.
  operatorAgent: agentIdentitySchema.optional(),
  approver: agentIdentitySchema.optional(),
}).strict();
export type MasterConfig = z.infer<typeof masterConfigSchema>;
/** The merge queue's batch size under this master config: `mergeQueue.batchSize`, or the default of 4. */
export function mergeBatchSize(config: Pick<MasterConfig, 'mergeQueue'> | null | undefined): number {
  return config?.mergeQueue?.batchSize ?? defaultMergeBatchSize;
}

export function assertMasterBinding(config: MasterConfig, status: any) {
  if (status.actor?.role !== 'coordinator') throw new Error('Master commands require the configured coordinator identity');
  if (typeof status.repository !== 'string' || status.repository.toLowerCase() !== config.repository.toLowerCase() || status.baseBranch !== config.baseBranch || status.githubAppId !== config.githubAppId) throw new Error('The Graphyard repository, managed base branch, or GitHub App changed; rerun master init before continuing');
}
