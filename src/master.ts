import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { z } from 'zod';
import { assertRepository, discover, localDirectory, saveDiscovery } from './onboarding.js';
import { loadConnection, managedInstructions, serverOrigin } from './repository-setup.js';
import { dispatchOrder, dispatchOverlap, resourceConflicts, scopeBreadth } from './coordination.js';
import type { ConflictReport } from './conflicts.js';
import { mergeOrder } from './delegation.js';
import { launchPlan, masterHarnessPlan, writeHarnessPermissions, type HarnessPlan, type HarnessRule } from './harness.js';
import { CHECK_NAME, carriedApproval, deliveryState, deploySmokeRequired, describeQueueBinding, evidenceIndependenceRefusals, exhaustedReviewerProfiles, nativeReviewRequired, postDeployMs, productionLatencyMs, providerDelayAfterVerification, reviewerProfileFor, reviewProviderOf, rollbackGuidance, standingEscalations, type CarriedApproval, type QueueBindingReport, type Work } from './model.js';
import { containmentAttestation, containmentGraceMs, containmentSettlementRefusals, containmentVerificationSchema, type ContainmentVerification } from './quarantine.js';
import { probeSupervisorAbsence } from './containment-probe.js';
import { baseRefreshConflict, currentBaseRefreshCarry, pendingBaseRefresh, predictQueue, type QueuePlacement } from './merge-queue.js';
import { MERGE_PROTOCOL } from './protocol-version.js';
import { attentionLines, type ProductionReport } from './production-watch.js';
import { pipelineSpeed, pipelineSpeedSummary } from './pipeline-speed.js';

const safeEnvironment = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
    .refine(name => !name.startsWith('GRAPHYARD_'), 'GRAPHYARD_ variables are owned by the launcher and cannot be set in a worker profile')
    .refine(name => !/(TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|CREDENTIAL)/.test(name), 'Put secrets in the worker credential file or the agent runtime login, not master profile environment'),
  z.string().min(1).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Profile environment values cannot contain control characters'),
).default({});

export const agentKindSchema = z.enum(['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'maki', 'muse']);
const profileName = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
// 'auto' installs the runtime's own non-interactive startup contract; 'prompt' keeps the
// runtime's approval prompts and requires a human in the session tab.
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

export const workerProfileSchema = z.object({
  name: profileName,
  principal: z.string().trim().min(1).max(200),
  agentName: z.string().trim().min(1).max(100),
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
  agentName: z.string().trim().min(1).max(100),
  kind: agentKindSchema,
  agentArgs: z.array(z.string().max(1000)).max(30).default([]),
  approvals: approvalMode,
  environment: safeEnvironment,
  accounts: accountList,
}).strict();
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;

// A producer session runs one proof group on one exact head and submits evidence under its own
// producer principal. It is launched like a worker — its own credential file, runtime and
// environment — but never claims work: trust follows the principal's proof grants, and the
// control plane refuses its evidence as soon as that principal ever holds an assignment.
export const producerProfileSchema = z.object({
  name: profileName,
  principal: z.string().trim().min(1).max(200),
  agentName: z.string().trim().min(1).max(100),
  kind: agentKindSchema,
  credentialFile: z.string(),
  agentArgs: z.array(z.string().max(1000)).max(30).default([]),
  approvals: approvalMode,
  environment: safeEnvironment,
  accounts: accountList,
}).strict().superRefine((profile, context) => {
  if (!isAbsolute(profile.credentialFile)) context.addIssue({ code: 'custom', message: 'credentialFile must be absolute', path: ['credentialFile'] });
});
export type ProducerProfile = z.infer<typeof producerProfileSchema>;

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
  smokeWorkflow: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Name the trusted post-deployment smoke workflow file, such as deploy-smoke.yml').optional(),
  // Automatic dispatch at submit: how often the loop reads the control plane's review and
  // producer requests (the launch bound is 30 seconds from the request), which reviewer profile
  // answers a request when more than one is configured, and how long a producer session may run.
  dispatchIntervalSeconds: z.number().int().min(5).max(30).default(10),
  reviewerProfile: profileName.optional(),
  producerTimeoutMinutes: z.number().int().min(5).max(1440).default(120),
  // Worktree reclamation: how long an assignment worktree may sit untouched before its dependency
  // directories count as disposable, and the free space below which `master status` raises disk
  // pressure. Both are read from .graphyard/master.json on every cycle, so a host with a smaller
  // volume raises the threshold without restarting the loop.
  reclaimIdleHours: z.number().min(0.25).max(720).optional(),
  diskThresholdGb: z.number().min(0.1).max(10_000).optional(),
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
  masterAgentName: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  autoMerge: z.boolean().default(true),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  workers: z.array(workerProfileSchema).max(100).default([]),
  reviewer: reviewerIdentitySchema.optional(),
  reviewers: z.array(reviewerProfileSchema).max(20).default([]),
  producers: z.array(producerProfileSchema).max(20).default([]),
  // The agent environments profiles may launch on, discovered or created by master environments.
  environments: z.array(agentEnvironmentSchema).max(50).optional(),
  run: masterRunSchema.prefault({}),
  // The operator's own authenticated browser profile, used only by master browser flows.
  browser: masterBrowserSchema.optional(),
  // The master's own operator-agent identity, and the separate approver identity whose session
  // approves the master's two-party decisions (master autonomy). Paths only, never tokens.
  operatorAgent: agentIdentitySchema.optional(),
  approver: agentIdentitySchema.optional(),
}).strict();
export type MasterConfig = z.infer<typeof masterConfigSchema>;

export function assertMasterBinding(config: MasterConfig, status: any) {
  if (status.actor?.role !== 'coordinator') throw new Error('Master commands require the configured coordinator identity');
  if (typeof status.repository !== 'string' || status.repository.toLowerCase() !== config.repository.toLowerCase() || status.baseBranch !== config.baseBranch || status.githubAppId !== config.githubAppId) throw new Error('The Graphyard repository, managed base branch, or GitHub App changed; rerun master init before continuing');
}

const masterStart = '<!-- graphyard-master -->', masterEnd = '<!-- /graphyard-master -->';
export function managedMasterInstructions(existing: string) {
  const starts = existing.split(masterStart).length - 1, ends = existing.split(masterEnd).length - 1;
  if (starts !== ends || starts > 1 || starts === 1 && existing.indexOf(masterEnd) < existing.indexOf(masterStart)) throw new Error('Malformed or duplicate Graphyard master markers; resolve them before updating AGENTS.md');
  const section = `${masterStart}
## Graphyard master agent

The recommended coordinator is a dedicated, visible master-agent session. It does
not implement work, hold worker leases, submit evidence, or bypass gates. Run
\`graphyard master status\` at startup and after every material event. Graphyard is
the source of assignment and progression truth; Herdr supplies live session health.

Autonomy is the default: act without asking. The operator sets goals; agents make
every other call. Only three decisions are human: goals and priorities, spending money
or opening third-party accounts, and issuing credentials to people. Every other
decision names the agent that makes it and the independent agent that approves it.
Create, release, unblock, and add requirements with your own operator-agent identity
(\`graphyard master create|release|unblock|requirements\`). Request every other
decision (requirement rewrites, escalation resolution, \`manual:\` attestation,
rework, containment recovery, proof grants, and merge approval when automatic
merging is off) with \`graphyard master decide GY-N ACTION REASON\`, then launch the
independent approver with \`graphyard master approver GY-N DECISION\`. The server
refuses self-approval and any approver that held an assignment on the item or produced
its evidence. Never ask a human to run a command an agent identity may run: \`master
status\` names who resolves each attention item and the next command.

Dispatch only ready work with \`graphyard master dispatch GY-N PROFILE\`. The
worker must claim the item under its own identity and use the assigned worktree.
Treat prompt delivery as an invitation, never as ownership. Use durable handoffs
when an agent, provider account, machine, or context window changes.

Review and proof collection start on their own. When a candidate passes the build gate
the control plane records a review request and one producer request per proof group,
each bound to the exact head, base and policy revision, and \`graphyard master run\`
launches the configured reviewer profile and a producer session for each of them within
30 seconds, without a keystroke. A head change cancels those sessions and requests the
new head afresh unless the merge queue carried the approval or the proof. You handle
findings, rework and merges; you never launch reviews or producers by hand. \`master
status\` shows, per candidate, what is requested, what is running and since when, and
any launch the loop refused; \`graphyard master review GY-N [PROFILE]\` is the recovery
path for a refused reviewer launch once its cause is fixed. Never approve a candidate
yourself, and never submit evidence. Reconcile branch protection with
\`graphyard master protection\` after any review-policy change.

GitHub administration of the managed repository is yours, not the operator's:
control-plane App permission updates, acceptance of the installation permission
request they raise, and branch-protection reconciliation. Use the API first
(\`graphyard master protection --apply\`, \`gh api\` on protection and installations).
When GitHub only offers a page — App manifest confirmation, permission-request
acceptance, a sudo prompt — run \`graphyard master browser app-permissions\`,
\`graphyard master browser installation-accept\`, or \`graphyard master browser protection\`.
Each drives the operator's own authenticated browser profile headless, records every
step and screenshot under \`.graphyard/master-actions/\`, verifies the result through
the API, and appends an attributable audit entry. On a Confirm-access page the flow
triggers GitHub Mobile and reports the two-digit code in \`master status\`; approving
that prompt on their device, and the three human-only decisions above, are the only
operator interactions left. Never store, export, or reuse the profile's cookies
outside those flows.

Keep cycling: status, dispatch ready work, shepherd review and proof collection,
guarded merge, then deployment verification. Repeat until both conditions hold:
(1) every in-scope item is Done or has a genuinely external blocker recorded in
Graphyard; and (2) every merged change is deployed and live-verified against the exact
deployed release, or a genuinely external deployment blocker is recorded in Graphyard.
Verify each delivery with \`graphyard master verify-deployment GY-N\`: it refuses a
stale or local-only observation and records only the exact deployed release it observed.
Delivered work is immutable, so a deployment blocker is recorded as a follow-up work
item naming the delivered item, its merge commit, and the external cause;
\`master status\` keeps the delivery under \`pending\` until the release serves it.
An observed merge alone does not end the loop. Ordinary review findings, rework,
idle workers, and proof setup are not stopping conditions. Close finished agent
sessions as part of the cycle.

Check the automatic-merge preference in master status. When disabled, each merge
needs an approved merge decision: request it with \`graphyard master decide GY-N
merge\`, and \`graphyard master merge\` refuses a candidate the approver agent has not
approved. Otherwise routine merges may use \`graphyard master merge --all\`. The command
rechecks the exact current candidate, every configured gate, and GitHub state
immediately before merging. Unapproved decisions, stale observations, failures, and
changed commits remain blocking. Never use an administrative merge bypass, edit a candidate, or read a
worker credential. Read \`docs/master-agent.md\`
in Graphyard or run \`graphyard master guide\` for the complete operating loop.
${masterEnd}`;
  return starts ? existing.slice(0, existing.indexOf(masterStart)) + section + existing.slice(existing.indexOf(masterEnd) + masterEnd.length) : `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}\n${section}\n`;
}

export async function privateFile(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.mode & 0o077) throw new Error(`${file} must be a regular file with mode 0600`);
  return info;
}
export async function readCredentialFile(file: string) {
  await privateFile(file);
  const value = (await readFile(file, 'utf8')).trim();
  if (value.length < 32 || value.length > 10_000) throw new Error('Worker credential file must contain one valid token');
  return value;
}
async function readMasterConfig(root: string): Promise<MasterConfig> {
  const file = resolve(root, '.graphyard/master.json'); await privateFile(file);
  const config = masterConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  config.url = serverOrigin(config.url);
  const repositoryRoot = resolve(root), credentialFile = resolve(config.credentialFile);
  if (!isAbsolute(config.credentialFile) || credentialFile === repositoryRoot || credentialFile.startsWith(`${repositoryRoot}/`)) throw new Error('Master credential file must be outside the repository and use an absolute path');
  config.credentialFile = credentialFile;
  return config;
}
async function repositoryWorktrees(root: string) {
  let worktrees: string[];
  try {
    const records = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0');
    worktrees = records.filter(record => record.startsWith('worktree ')).map(record => resolve(record.slice('worktree '.length)));
  } catch { throw new Error('Cannot verify credential location because the complete Git worktree inventory is unavailable'); }
  if (!worktrees.length) throw new Error('Cannot verify credential location because Git returned an empty worktree inventory');
  // A registered worktree whose path is missing or hidden (a removed proof worktree, or one under
  // a /tmp this process cannot see) is compared by its registered path: it cannot be resolved,
  // but a target lexically inside it is still refused, and it never stops the loop.
  return Promise.all(worktrees.map(worktree => realpath(worktree).catch(() => worktree)));
}
export async function assertOutsideWorktrees(root: string, target: string, label: string) {
  const canonicalTarget = await realpath(target);
  const worktrees = await repositoryWorktrees(root);
  for (const worktree of worktrees) {
    const fromRoot = relative(worktree, canonicalTarget);
    const inside = fromRoot === '' || fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
    if (inside) throw new Error(`${label} must be outside every worktree of the repository`);
  }
}
export async function externalCredential(root: string, file: string, label: string) {
  if (!isAbsolute(file)) throw new Error(`${label} credential file must use an absolute path outside the repository`);
  await privateFile(file);
  await assertOutsideWorktrees(root, file, `${label} credential file`);
}
export async function loadMasterConfig(root: string): Promise<MasterConfig> {
  const config = await readMasterConfig(root);
  await externalCredential(root, config.credentialFile, 'Master');
  if (!isAbsolute(config.cliPath)) throw new Error('Master CLI path must be absolute');
  try { if (!(await lstat(config.cliPath)).isFile()) throw new Error(); } catch { throw new Error('Configured Graphyard CLI launcher is unavailable'); }
  return config;
}

export async function readWorkerCredential(root: string, file: string) {
  await externalCredential(root, file, 'Worker');
  return readCredentialFile(file);
}

export async function inspectWorkerCredentials(root: string, profiles: WorkerProfile[], probe?: EnvironmentProbe) {
  const health: Record<string, { available: boolean; reason: string | null }> = {};
  for (const profile of profiles) {
    if (profile.mode === 'existing') health[profile.name] = { available: true, reason: null };
    else try { await readWorkerCredential(root, profile.credentialFile!); health[profile.name] = { available: true, reason: null }; }
    catch (error) { health[profile.name] = { available: false, reason: error instanceof Error ? error.message : 'Worker credential is unavailable' }; }
  }
  return withAccountHealth(root, 'worker', profiles.filter(profile => profile.mode === 'launch'), health, probe);
}
// A profile's accounts are part of whether it can launch, so status and the durable loop read them
// with its credential: a profile none of whose accounts is logged in with quota left is unavailable.
async function withAccountHealth<T extends { available: boolean; reason: string | null }>(root: string, role: LaunchRole, profiles: { name: string; accounts?: string[] }[], health: Record<string, T>, probe?: EnvironmentProbe) {
  if (!profiles.some(profile => profile.accounts?.length)) return health;
  return inspectProfileAccounts(await readMasterConfig(root), role, profiles, health, probe);
}
export async function readProducerCredential(root: string, file: string) {
  await externalCredential(root, file, 'Producer');
  return readCredentialFile(file);
}
export async function inspectProducerCredentials(root: string, profiles: ProducerProfile[], probe?: EnvironmentProbe) {
  const health: Record<string, { available: boolean; reason: string | null }> = {};
  for (const profile of profiles) {
    try { await readProducerCredential(root, profile.credentialFile); health[profile.name] = { available: true, reason: null }; }
    catch (error) { health[profile.name] = { available: false, reason: error instanceof Error ? error.message : 'Producer credential is unavailable' }; }
  }
  return withAccountHealth(root, 'producer', profiles, health, probe);
}

export async function atomicPrivateWrite(file: string, value: unknown) {
  return atomicPrivateText(file, JSON.stringify(value, null, 2));
}
async function atomicPrivateText(file: string, value: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  // A master file that cannot be written because the host is out of room says so: the same
  // failure reported as an unexplained write error costs an investigation every time.
  try { await writeFile(temporary, value, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
  catch (error) { throw writeFailure(error, `Writing ${file}`); }
  await chmod(file, 0o600);
}

export async function setupMaster(root: string, input: { url: string; token: string; cliPath: string; hostId?: string; herdrWorkspace?: string; credentialDirectory?: string; autoMerge?: boolean; mergeMethod?: 'merge' | 'squash' | 'rebase'; run?: Partial<MasterRun>; browser?: MasterBrowser }, fetcher: typeof fetch = fetch) {
  const url = serverOrigin(input.url); const token = input.token.trim();
  const workerConnection = await loadConnection(root);
  if (workerConnection && workerConnection.url !== url) throw new Error('Worker connection uses another Graphyard server; migrate the repository connection before master setup');
  if (token.length < 32) throw new Error('Master initialization requires a coordinator credential over stdin');
  const detected = await discover(root);
  let response: Response;
  try { response = await fetcher(`${url}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error('Cannot reach Graphyard; master setup made no changes'); }
  if (!response.ok) throw new Error(`Graphyard rejected the coordinator credential (${response.status}); master setup made no changes`);
  const status = await response.json();
  if (status.actor?.role !== 'coordinator') throw new Error('Master setup requires a coordinator credential; worker, operator, producer, and reader credentials are not suitable');
  if (typeof status.repository !== 'string' || !status.repository) throw new Error('Master setup requires the control plane to be bound to a GitHub repository');
  if (typeof status.baseBranch !== 'string' || !status.baseBranch) throw new Error('Master setup requires the control plane to identify its managed base branch');
  if (!Number.isSafeInteger(status.githubAppId) || status.githubAppId <= 0) throw new Error('Master setup requires the control plane to identify its GitHub App');
  assertRepository(detected.repository, status.repository);
  if (!detected.repository) throw new Error('Master setup requires a recognized GitHub origin');
  try { if (!(await lstat(resolve(input.cliPath))).isFile()) throw new Error(); } catch { throw new Error('Master setup requires an existing Graphyard CLI launcher'); }
  let previous: MasterConfig | undefined;
  try { previous = await readMasterConfig(root); } catch (error: any) { if (error.code !== 'ENOENT' && !/ENOENT/.test(error.message)) throw error; }
  if (previous && (previous.url !== url || previous.repository.toLowerCase() !== detected.repository.toLowerCase())) throw new Error('Existing master configuration belongs to another server or repository');
  const repositoryName = detected.repository.split('/').at(-1)!.replace(/[^a-zA-Z0-9._-]/g, '-');
  const requestedCredentialDirectory = resolve(input.credentialDirectory ?? process.env.GRAPHYARD_CONFIG_HOME ?? resolve(homedir(), '.config/graphyard'), 'masters');
  if (requestedCredentialDirectory === resolve(root) || requestedCredentialDirectory.startsWith(`${resolve(root)}/`)) throw new Error('Coordinator credentials must be stored outside the managed repository');
  await mkdir(requestedCredentialDirectory, { recursive: true, mode: 0o700 });
  const credentialDirectory = await realpath(requestedCredentialDirectory);
  await assertOutsideWorktrees(root, credentialDirectory, 'Coordinator credential directory');
  const identity = createHash('sha256').update(`${url}\0${detected.repository}`).digest('hex').slice(0, 20);
  const credentialFile = resolve(credentialDirectory, `${identity}.token`);
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile, cliPath: resolve(input.cliPath), repository: detected.repository, baseBranch: status.baseBranch, githubAppId: status.githubAppId, hostId: input.hostId ?? previous?.hostId ?? hostname(), herdrWorkspace: input.herdrWorkspace ?? previous?.herdrWorkspace, masterAgentName: previous?.masterAgentName ?? `graphyard-master-${repositoryName}`, autoMerge: input.autoMerge ?? previous?.autoMerge ?? true, mergeMethod: input.mergeMethod ?? previous?.mergeMethod ?? 'merge', workers: previous?.workers ?? [], ...(previous?.reviewer ? { reviewer: previous.reviewer } : {}), reviewers: previous?.reviewers ?? [], producers: previous?.producers ?? [], run: { ...previous?.run, ...input.run }, ...(input.browser ?? previous?.browser ? { browser: input.browser ?? previous?.browser } : {}) });
  const instructionsFile = resolve(root, 'AGENTS.md');
  let existing = ''; let mode = 0o644;
  try { const info = await lstat(instructionsFile); if (!info.isFile()) throw new Error('Refusing to replace a non-regular AGENTS.md'); mode = info.mode & 0o777; existing = await readFile(instructionsFile, 'utf8'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const instructions = managedMasterInstructions(managedInstructions(existing, url));
  const directory = await localDirectory(root);
  await atomicPrivateText(credentialFile, token);
  await atomicPrivateWrite(resolve(directory, 'master.json'), config);
  const temporary = `${instructionsFile}.${randomUUID()}.tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(temporary, instructions, { mode, flag: 'wx' }); await rename(temporary, instructionsFile); await chmod(instructionsFile, mode);
  await saveDiscovery(root);
  // A permission the installed App lacks is announced here with its exact migration steps, not
  // discovered later as a 403 loop. It never blocks setup: master status keeps reporting it.
  const { attention, appPermissions, delegationLimits, production } = controlPlaneAttention(status);
  // Each installation fact keeps its own remedy: a permission shortfall is a GitHub migration, a
  // capacity variable is a deployment setting, and production lag is a deploy to confirm.
  const remedy = appPermissions?.missing?.length || status.appPermissions?.attention?.length ? 'Accept the GitHub App permission request (run graphyard github-setup --update-permissions on the machine holding .graphyard/github-app.json, or graphyard master browser app-permissions and installation-accept, for the exact steps)'
    : delegationLimits?.drift.length ? `Set ${delegationLimits.drift.map(entry => `${entry.variable}=${entry.required}`).join(' ')} on the deployment`
    : production?.incidents.length ? `Deploy main: ${production.attention[0] ?? production.incidents[0].reason}` : null;
  const profiles = 'graphyard master environments --apply to generate worker, reviewer and producer profiles from the logged-in agent accounts';
  const start = config.reviewer ? `run ${profiles}, then graphyard master start codex (or another supported agent kind)` : `run graphyard master reviewer setup to register the independent reviewer identity, then ${profiles}, then graphyard master start codex (or another supported agent kind)`;
  // Which agent accounts this machine has, and which are logged in; quota is read by master environments.
  const environmentDirectory = agentEnvironmentRoot();
  const environments = await Promise.all((await discoverAgentEnvironments(environmentDirectory).catch(() => [] as AgentEnvironment[])).map(async environment => {
    const health = await checkAgentEnvironment(environment, { quota: false });
    return { environment: environment.name, kind: environment.kind, home: environment.home, loggedIn: health.loggedIn, login: health.login };
  }));
  return { repository: config.repository, server: config.url, role: status.actor.role, autoMerge: config.autoMerge, workers: config.workers.length, run: config.run, browser: config.browser ?? null, config: '.graphyard/master.json', reviewer: config.reviewer ? `${config.reviewer.slug}[bot]` : null, attention,
    agentEnvironments: { directory: environmentDirectory, discovered: environments },
    next: `${remedy ? `${remedy}, then ${start}` : start[0].toUpperCase() + start.slice(1)}; give the master its agent identities once with graphyard master autonomy --admin-token-stdin --apply` };
}

export async function saveWorkerProfile(root: string, profileInput: unknown, verify: (token: string) => Promise<any>) {
  const profile = workerProfileSchema.parse(profileInput);
  const config = await loadMasterConfig(root);
  if (profile.credentialFile) {
    await externalCredential(root, profile.credentialFile, 'Worker');
    const status = await verify(await readCredentialFile(profile.credentialFile));
    if (status.actor?.role !== 'worker' || status.actor.id !== profile.principal) throw new Error('Worker credential does not match the profile principal and worker role');
  }
  if (config.workers.some(worker => worker.name === profile.name || worker.agentName === profile.agentName || worker.principal === profile.principal)) throw new Error('Worker profile name, agent name, and principal must be unique');
  config.workers.push(profile); await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), config);
  return { added: profile.name, principal: profile.principal, mode: profile.mode, workers: config.workers.length,
    launch: profile.mode === 'launch' ? agentLaunchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment) : null };
}

/**
 * A producer profile is verified the way a worker profile is — its credential authenticates
 * exactly the named principal in the producer role — and additionally kept apart from every
 * worker principal: evidence from an identity that implements is never trusted, so a shared
 * principal would only ever launch sessions whose evidence the control plane refuses.
 */
export async function saveProducerProfile(root: string, profileInput: unknown, verify: (token: string) => Promise<any>) {
  const profile = producerProfileSchema.parse(profileInput);
  const config = await loadMasterConfig(root);
  await externalCredential(root, profile.credentialFile, 'Producer');
  const status = await verify(await readCredentialFile(profile.credentialFile));
  if (status.actor?.role !== 'producer' || status.actor.id !== profile.principal) throw new Error('Producer credential does not match the profile principal and producer role');
  if (config.producers.some(item => item.name === profile.name || item.agentName === profile.agentName || item.principal === profile.principal)) throw new Error('Producer profile name, agent name, and principal must be unique');
  if (config.workers.some(item => item.agentName === profile.agentName) || config.reviewers.some(item => item.agentName === profile.agentName)) throw new Error('A worker or reviewer profile already uses that Herdr agent name');
  if (config.workers.some(item => item.principal === profile.principal)) throw new Error('A producer principal cannot also be a worker principal; the control plane refuses evidence from an implementer');
  config.producers.push(profile); await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), config);
  return { added: profile.name, principal: profile.principal, kind: profile.kind, proofs: Array.isArray(status.actor?.proofs) ? status.actor.proofs : [], producers: config.producers.length,
    launch: agentLaunchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment) };
}

/**
 * The settings the master may tune on its own: the loop and dispatch cadence, the workflows the
 * provider runs with its own secret, the deployment the loop verifies, which reviewer profile
 * answers first, the producer session budget, the quota ceiling, and a profile's account order.
 * Everything else — autoMerge, the merge method, server and repository binding, credential and
 * identity paths, the environment inventory — is onboarding's or the operator's: no CLI path
 * writes it, and the master's harness grants no direct edit of master.json, so flipping autoMerge
 * or re-pointing a credential can never be a routine master action.
 */
export const masterOwnedRunFields = ['intervalSeconds', 'dispatchIntervalSeconds', 'proofWorkflow', 'smokeWorkflow', 'deploymentUrl', 'deploymentShaField', 'reviewerProfile', 'producerTimeoutMinutes', 'quotaCeilingPercent'] as const;
const masterClearableRunFields = ['proofWorkflow', 'smokeWorkflow', 'deploymentUrl', 'reviewerProfile', 'quotaCeilingPercent'] as const;
export interface MasterOwnedSettings {
  intervalSeconds?: number | null; dispatchIntervalSeconds?: number | null; proofWorkflow?: string | null; smokeWorkflow?: string | null;
  deploymentUrl?: string | null; deploymentShaField?: string | null; reviewerProfile?: string | null; producerTimeoutMinutes?: number | null; quotaCeilingPercent?: number | null;
  accounts?: { profile: string; accounts: string[] }[];
}

/** The CLI's `master config FIELD=VALUE…` form: owned run fields, plus `accounts:PROFILE=a,b` (an empty value clears the pinned order). */
export function masterSettingsFromArgs(args: string[]): MasterOwnedSettings {
  const settings: MasterOwnedSettings = {}, accounts: NonNullable<MasterOwnedSettings['accounts']> = [];
  for (const arg of args) {
    const assignment = /^(accounts:[a-zA-Z0-9][a-zA-Z0-9._-]*|[a-zA-Z][a-zA-Z0-9]*)=(.*)$/.exec(arg);
    if (!assignment) throw new Error(`master config takes FIELD=VALUE assignments; "${arg}" is not one`);
    const [, field, raw] = assignment, value = raw.trim();
    if (field.startsWith('accounts:')) { accounts.push({ profile: field.slice('accounts:'.length), accounts: value ? value.split(',').map(name => name.trim()).filter(Boolean) : [] }); continue; }
    if (!(masterOwnedRunFields as readonly string[]).includes(field)) throw new Error(`master config changes only what the master owns (${masterOwnedRunFields.join(', ')} and accounts:PROFILE), never ${field}`);
    (settings as Record<string, unknown>)[field] = value === '' || value === 'null' ? null : /^[0-9]+$/.test(value) ? Number(value) : value;
  }
  return accounts.length ? { ...settings, accounts } : settings;
}

/**
 * The only configuration write a master session can reach: it applies the owned fields above to
 * the loaded configuration and revalidates the whole file through the master config schema before
 * writing it, exactly as the operator's own commands do. Unknown fields are refused by
 * `masterSettingsFromArgs` and again here, so an autoMerge flip or a credential re-point is
 * refused wherever it enters.
 */
export async function saveMasterSettings(root: string, changes: MasterOwnedSettings) {
  const config = await loadMasterConfig(root);
  const unknown = Object.keys(changes).filter(field => field !== 'accounts' && !(masterOwnedRunFields as readonly string[]).includes(field));
  if (unknown.length) throw new Error(`saveMasterSettings changes only what the master owns (${masterOwnedRunFields.join(', ')} and accounts), never ${unknown.join(', ')}`);
  const run: Record<string, unknown> = { ...config.run }, changed: string[] = [];
  for (const field of masterOwnedRunFields) {
    const value = changes[field];
    if (value === undefined) continue;
    if (value === null) {
      if (!(masterClearableRunFields as readonly string[]).includes(field)) throw new Error(`${field} is required; it can only be set, never cleared`);
      delete run[field];
    } else run[field] = value;
    changed.push(field);
  }
  if (changes.reviewerProfile && !config.reviewers.some(profile => profile.name === changes.reviewerProfile)) throw new Error(`No reviewer profile named ${changes.reviewerProfile}; the reviewer profile is the name of a configured reviewer`);
  for (const change of changes.accounts ?? []) {
    const missing = change.accounts.filter(name => !(config.environments ?? []).some(environment => environment.name === name));
    if (missing.length) throw new Error(`${change.profile}: ${missing.join(', ')} is not a configured agent environment; run master environments --apply`);
    const profile = [...config.workers, ...config.reviewers, ...config.producers].find(candidate => candidate.name === change.profile);
    if (!profile) throw new Error(`No worker, reviewer, or producer profile named ${change.profile}`);
    if (change.accounts.length) profile.accounts = change.accounts; else delete profile.accounts;
    changed.push(`accounts:${change.profile}`);
  }
  const parsed = masterConfigSchema.parse({ ...config, run });
  await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), parsed);
  return { changed, run: parsed.run, config: '.graphyard/master.json' };
}

/** Where agent environments live: one directory per account, named <agent>-<letter>. */
export function agentEnvironmentRoot(input?: string) {
  return resolve(input ?? process.env.GRAPHYARD_AGENT_ENVIRONMENTS ?? resolve(homedir(), '.coding_agents'));
}
const environmentDirectory = /^(claude|codex|opencode|cursor)(?:-([a-z0-9][a-z0-9_-]{0,30}))?$/;
export async function discoverAgentEnvironments(directory = agentEnvironmentRoot()): Promise<AgentEnvironment[]> {
  let entries: string[];
  try { entries = await readdir(directory); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  const found: AgentEnvironment[] = [];
  for (const name of entries) {
    const match = environmentDirectory.exec(name);
    if (!match) continue;
    const home = resolve(directory, name);
    try { if (!(await stat(home)).isDirectory()) continue; } catch { continue; }
    found.push(agentEnvironmentSchema.parse({ name, kind: match[1], home }));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
/** A new, empty environment for an agent CLI: the next free <agent>-<letter> directory, mode 0700. */
export async function createAgentEnvironment(directory: string, kind: EnvironmentKind, existing: AgentEnvironment[]) {
  const taken = new Set(existing.map(environment => environment.name));
  const letter = [...'abcdefghijklmnopqrstuvwxyz'].find(candidate => !taken.has(`${kind}-${candidate}`));
  if (!letter) throw new Error(`Every ${kind}-<letter> environment name is taken under ${directory}`);
  const home = resolve(directory, `${kind}-${letter}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  return agentEnvironmentSchema.parse({ name: `${kind}-${letter}`, kind, home });
}
/**
 * The one runtime setting a fresh environment needs before an unattended launch: Claude Code asks
 * once per config home to confirm the bypass-permissions mode every launch requests, and that
 * confirmation would hold a new session at a dialog nobody is watching.
 */
export async function prepareAgentEnvironment(environment: AgentEnvironment) {
  if (environment.kind !== 'claude') return [] as string[];
  const file = resolve(environment.home, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object; resolve it before preparing the environment`);
    settings = parsed;
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (settings.skipDangerousModePermissionPrompt === true) return [];
  await atomicPrivateText(file, `${JSON.stringify({ ...settings, skipDangerousModePermissionPrompt: true }, null, 2)}\n`);
  return [`${file}: skipDangerousModePermissionPrompt`];
}

export function loginCommand(environment: AgentEnvironment) {
  const home = shellQuote(environment.home);
  return { claude: `CLAUDE_CONFIG_DIR=${home} claude, then /login`, codex: `CODEX_HOME=${home} codex login`,
    opencode: `XDG_DATA_HOME=${home} opencode auth login`, cursor: `CURSOR_CONFIG_DIR=${home} cursor-agent login` }[environment.kind];
}

export interface AccountUsage { window: string; percent: number; resetsAt: string | null }
export interface EnvironmentHealth {
  name: string; kind: EnvironmentKind; home: string; variable: string; checkedAt: string;
  loggedIn: boolean; quota: 'available' | 'exhausted' | 'unknown'; usage: AccountUsage[];
  /** Launchable: logged in and not exhausted. Unknown quota is launchable; the runtime reports its own limit. */
  healthy: boolean; reason: string | null; note: string | null; login: string | null;
}
export interface EnvironmentProbe {
  fetch?: typeof fetch; now?: () => number; ceilingPercent?: number; timeoutMs?: number; cacheMs?: number;
  /** false reads only the login, never the provider: for reports that must not reach the network. */
  quota?: boolean;
}
export const defaultQuotaCeilingPercent = 95;
const healthCache = new Map<string, { at: number; health: EnvironmentHealth }>();

async function readJsonFile(file: string): Promise<any> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
const windowName = (minutes: number) => minutes >= 1440 && minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

// Claude Code keeps its subscription login in the environment's .credentials.json. The usage the
// provider meters against it is read from the same endpoint Claude Code's /usage reads; the token
// is sent only to its own provider and never leaves this function.
async function claudeAccount(environment: AgentEnvironment, probe: EnvironmentProbe, now: number) {
  const oauth = (await readJsonFile(resolve(environment.home, '.credentials.json')))?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object' || !(oauth.accessToken || oauth.refreshToken)) return { loggedIn: false, usage: [], note: null };
  if (probe.quota === false) return { loggedIn: true, usage: [], note: 'quota not read' };
  if (typeof oauth.accessToken !== 'string' || typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now) return { loggedIn: true, usage: [], note: 'the stored access token has expired; Claude Code refreshes it at launch, so quota is read on the next check' };
  try {
    const response = await (probe.fetch ?? fetch)('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(probe.timeoutMs ?? 5_000) });
    if (!response.ok) return { loggedIn: response.status !== 401 || !!oauth.refreshToken, usage: [], note: `the provider usage endpoint answered ${response.status}` };
    const body: any = await response.json();
    const usage = (['five_hour', 'seven_day'] as const).flatMap(key => typeof body?.[key]?.utilization === 'number'
      ? [{ window: key === 'five_hour' ? '5h' : '7d', percent: body[key].utilization, resetsAt: typeof body[key].resets_at === 'string' ? new Date(body[key].resets_at).toISOString() : null }] : []);
    return { loggedIn: true, usage, note: null };
  } catch (error) { return { loggedIn: true, usage: [], note: `the provider usage endpoint is unreachable: ${error instanceof Error ? error.message : 'unknown reason'}` }; }
}

// Codex records the provider's rate-limit windows in every session it writes; the newest record
// is the account's last reported usage.
async function newestCodexRateLimits(home: string) {
  const directories = async (directory: string) => { try { return (await readdir(directory)).filter(name => /^\d+$/.test(name)).sort().reverse().map(name => resolve(directory, name)); } catch { return []; } };
  const files: { file: string; modified: number }[] = [];
  for (const year of await directories(resolve(home, 'sessions'))) {
    for (const month of await directories(year)) {
      for (const day of await directories(month)) {
        for (const name of (await readdir(day).catch(() => [] as string[])).filter(entry => entry.endsWith('.jsonl'))) {
          const file = resolve(day, name);
          try { files.push({ file, modified: (await stat(file)).mtimeMs }); } catch { /* removed while listing */ }
        }
        if (files.length >= 5) break;
      }
      if (files.length >= 5) break;
    }
    if (files.length >= 5) break;
  }
  for (const { file } of files.sort((a, b) => b.modified - a.modified).slice(0, 5)) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.slice(-1_000_000).split('\n').reverse()) {
      if (!line.includes('"rate_limits"')) continue;
      let record: any; try { record = JSON.parse(line); } catch { continue; }
      const limits = record?.payload?.rate_limits ?? record?.payload?.info?.rate_limits ?? record?.rate_limits;
      if (limits && (limits.primary || limits.secondary)) return limits;
    }
  }
  return null;
}
async function codexAccount(environment: AgentEnvironment, probe: EnvironmentProbe) {
  const auth = await readJsonFile(resolve(environment.home, 'auth.json'));
  const loggedIn = !!auth && (typeof auth.tokens?.access_token === 'string' || typeof auth.OPENAI_API_KEY === 'string' && !!auth.OPENAI_API_KEY);
  if (!loggedIn || probe.quota === false) return { loggedIn, usage: [], note: loggedIn ? 'quota not read' : null, reached: false };
  const limits = await newestCodexRateLimits(environment.home);
  if (!limits) return { loggedIn, usage: [], note: 'no Codex session has reported rate limits for this account yet', reached: false };
  const usage = [limits.primary, limits.secondary].filter(window => window && typeof window.used_percent === 'number').map((window: any) => ({
    window: typeof window.window_minutes === 'number' ? windowName(window.window_minutes) : 'window', percent: window.used_percent,
    resetsAt: typeof window.resets_at === 'number' ? new Date(window.resets_at * 1000).toISOString() : null }));
  return { loggedIn, usage, note: null, reached: !!limits.rate_limit_reached_type };
}

export async function checkAgentEnvironment(environment: AgentEnvironment, probe: EnvironmentProbe = {}): Promise<EnvironmentHealth> {
  const now = probe.now?.() ?? Date.now(), ceiling = probe.ceilingPercent ?? defaultQuotaCeilingPercent;
  const cacheKey = `${environment.name}\0${environment.home}\0${ceiling}\0${probe.quota !== false}`, cached = healthCache.get(cacheKey);
  if (cached && now - cached.at >= 0 && now - cached.at < (probe.cacheMs ?? 30_000)) return cached.health;
  const account: { loggedIn: boolean; usage: AccountUsage[]; note: string | null; reached?: boolean } = environment.kind === 'claude' ? await claudeAccount(environment, probe, now)
    : environment.kind === 'codex' ? await codexAccount(environment, probe)
    : environment.kind === 'opencode' ? { loggedIn: Object.keys((await readJsonFile(resolve(environment.home, 'opencode/auth.json'))) ?? {}).length > 0, usage: [], note: 'OpenCode exposes no provider quota Graphyard can read; its providers report their own limits in the session' }
    : { loggedIn: (candidate => !!candidate && !!(candidate.userId || candidate.email))((await readJsonFile(resolve(environment.home, 'cli-config.json')))?.authInfo), usage: [], note: 'Cursor exposes no quota Graphyard can read; the session reports its own limit' };
  const future = (usage: AccountUsage) => !usage.resetsAt || Date.parse(usage.resetsAt) > now;
  const spent = account.usage.filter(usage => usage.percent >= ceiling && future(usage));
  const exhausted = spent.length > 0 || !!account.reached && account.usage.some(future);
  const quota = !account.loggedIn ? 'unknown' as const : exhausted ? 'exhausted' as const : account.usage.length ? 'available' as const : 'unknown' as const;
  const reason = !account.loggedIn ? `${environment.name} is not logged in`
    : exhausted ? `${environment.name} quota is exhausted (${(spent.length ? spent : account.usage).map(usage => `${usage.window} window at ${usage.percent}%${usage.resetsAt ? ` until ${usage.resetsAt}` : ''}`).join(', ')}; ceiling ${ceiling}%)` : null;
  const health: EnvironmentHealth = { name: environment.name, kind: environment.kind, home: environment.home, variable: environmentVariable[environment.kind], checkedAt: new Date(now).toISOString(),
    loggedIn: account.loggedIn, quota, usage: account.usage, healthy: !reason, reason, note: account.note, login: account.loggedIn ? null : loginCommand(environment) };
  healthCache.set(cacheKey, { at: now, health });
  return health;
}

export type LaunchRole = 'worker' | 'reviewer' | 'producer';
export interface AccountSkip { at: string; role: LaunchRole; profile: string; environment: string; reason: string; work: string | null }
/** Every account of a profile was skipped: the caller fails over to its next profile, or reports the skips. */
export class NoHealthyAccountError extends Error {
  readonly accountsExhausted = true;
  constructor(message: string, readonly skipped: AccountSkip[]) { super(message); }
}

// What the launch loop last observed about each environment, and the recent launches it skipped
// away from and why, kept beside the coordinator's other private state so master status can say it.
const environmentLogSchema = z.object({
  version: z.literal(1),
  environments: z.record(z.string(), z.any()).default({}),
  skipped: z.array(z.object({ at: z.string(), role: z.enum(['worker', 'reviewer', 'producer']), profile: z.string(), environment: z.string(), reason: z.string().max(500), work: z.string().nullable() }).strict()).max(50).default([]),
}).strict();
export type EnvironmentLog = { version: 1; environments: Record<string, EnvironmentHealth>; skipped: AccountSkip[] };
export function environmentLogPath(config: Pick<MasterConfig, 'credentialFile'>) {
  return resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.environments.json`);
}
export async function readEnvironmentLog(config: Pick<MasterConfig, 'credentialFile'>): Promise<EnvironmentLog> {
  try { return environmentLogSchema.parse(JSON.parse(await readFile(environmentLogPath(config), 'utf8'))) as EnvironmentLog; }
  catch { return { version: 1, environments: {}, skipped: [] }; }
}
export async function recordEnvironmentLog(config: Pick<MasterConfig, 'credentialFile'>, health: EnvironmentHealth[], skipped: AccountSkip[] = []) {
  if (!health.length && !skipped.length) return;
  const log = await readEnvironmentLog(config);
  for (const entry of health) log.environments[entry.name] = entry;
  log.skipped = [...log.skipped, ...skipped.map(entry => ({ ...entry, reason: entry.reason.slice(0, 500) }))].slice(-50);
  await atomicPrivateWrite(environmentLogPath(config), log);
}

/**
 * The account a launch runs on: the first of the profile's accounts that is logged in with quota
 * left. Every account passed over is recorded with its reason. A profile that names no accounts
 * launches exactly as configured, on whatever its environment variables select.
 */
export async function selectAccount(config: Pick<MasterConfig, 'environments' | 'credentialFile' | 'run'>, role: LaunchRole, profile: { name: string; accounts?: string[] }, probe: EnvironmentProbe & { work?: string } = {}) {
  if (!profile.accounts?.length) return { account: null, health: null, skipped: [] as AccountSkip[] };
  const at = new Date(probe.now?.() ?? Date.now()).toISOString();
  const checked: EnvironmentHealth[] = [], skipped: AccountSkip[] = [];
  for (const name of profile.accounts) {
    const environment = (config.environments ?? []).find(candidate => candidate.name === name);
    if (!environment) { skipped.push({ at, role, profile: profile.name, environment: name, reason: `${name} is not a configured agent environment; run master environments --apply`, work: probe.work ?? null }); continue; }
    const health = await checkAgentEnvironment(environment, { ...probe, ceilingPercent: probe.ceilingPercent ?? config.run.quotaCeilingPercent });
    checked.push(health);
    if (health.healthy) {
      await recordEnvironmentLog(config, checked, skipped).catch(() => {});
      return { account: environment, health, skipped };
    }
    skipped.push({ at, role, profile: profile.name, environment: name, reason: health.reason!, work: probe.work ?? null });
  }
  await recordEnvironmentLog(config, checked, skipped).catch(() => {});
  throw new NoHealthyAccountError(`No healthy agent account for ${role} profile ${profile.name}: ${skipped.map(entry => entry.reason).join('; ')}`, skipped);
}

/**
 * Each runtime's broadest non-interactive approval mode. Claude Code, Codex and Cursor already get
 * theirs from the launch contract; OpenCode's contract allows edit, bash and webfetch only, so its
 * other permissions (directories outside the worktree, repeated tool calls, subagents, …) would
 * still stop a session to ask, and are allowed here too.
 */
export const openCodeAllowAll = { '*': 'allow', edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow', doom_loop: 'allow' };
export function agentLaunchPlan(kind: string | undefined, approvals: 'auto' | 'prompt' = 'auto', agentArgs: string[] = [], environment: Record<string, string> = {}) {
  const plan = launchPlan(kind, approvals, agentArgs, environment);
  if (!plan.applied || kind !== 'opencode') return plan;
  return { ...plan, environment: { ...plan.environment, OPENCODE_PERMISSION: JSON.stringify(openCodeAllowAll) }, prompts: 'every permission prompt, including edits, shell commands, fetches, and paths outside the worktree',
    tradeoff: 'opencode edits files, runs shell commands, fetches URLs, and reaches outside its worktree without asking.' };
}

/**
 * What a session launches with once its account is chosen: the account's kind and home, the
 * profile's arguments when they belong to that runtime, and the runtime's broadest approval mode.
 * Codex keeps its workspace sandbox, so the paths and network access the role needs are added to it:
 * a worker commits into the repository's shared Git directory and pushes; a producer builds in a
 * detached worktree under the temporary directory.
 */
export function accountLaunch(profile: { kind?: string; approvals: 'auto' | 'prompt'; agentArgs: string[]; environment: Record<string, string> }, account: AgentEnvironment | null, reach: { writable?: string[] } = {}) {
  const kind = account?.kind ?? profile.kind;
  const plan = agentLaunchPlan(kind, profile.approvals, !account || account.kind === profile.kind ? profile.agentArgs : [], profile.environment);
  const environment: Record<string, string> = { ...plan.environment, ...profile.environment };
  if (account) {
    environment[environmentVariable[account.kind]] = account.home;
    // mise resolves installed runtimes under XDG_DATA_HOME; keep it on the operator's own install.
    if (account.kind === 'opencode') {
      const mise = process.env.MISE_DATA_DIR ?? resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local/share'), 'mise');
      if (existsSync(mise)) environment.MISE_DATA_DIR = mise;
    }
  }
  const extra = kind === 'codex' && plan.applied ? ['-c', 'sandbox_workspace_write.network_access=true', ...(reach.writable ?? []).flatMap(path => ['--add-dir', path])] : [];
  return { kind, args: [...plan.args, ...extra], environment, plan, account: account?.name ?? null };
}

/** The Git directory every worktree of the repository commits into. */
export function sharedGitDirectory(root: string) {
  try { return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

/**
 * Account health for every profile that names accounts, joined onto the credential health status
 * and the durable loop already read: a profile none of whose accounts can launch is unavailable,
 * with each account's reason.
 */
export async function inspectProfileAccounts<T extends { available: boolean; reason: string | null }>(config: Pick<MasterConfig, 'environments' | 'credentialFile' | 'run'>, role: LaunchRole, profiles: { name: string; accounts?: string[] }[], health: Record<string, T>, probe: EnvironmentProbe = {}) {
  const result: Record<string, T & { accounts?: { environment: string; healthy: boolean; reason: string | null; quota: string }[] }> = { ...health };
  for (const profile of profiles) {
    if (!profile.accounts?.length || result[profile.name]?.available === false) continue;
    const accounts: { environment: string; healthy: boolean; reason: string | null; quota: string }[] = [];
    for (const name of profile.accounts) {
      const environment = (config.environments ?? []).find(candidate => candidate.name === name);
      if (!environment) { accounts.push({ environment: name, healthy: false, reason: `${name} is not a configured agent environment`, quota: 'unknown' }); continue; }
      const checked = await checkAgentEnvironment(environment, { ...probe, ceilingPercent: probe.ceilingPercent ?? config.run.quotaCeilingPercent });
      accounts.push({ environment: name, healthy: checked.healthy, reason: checked.reason, quota: checked.quota });
    }
    const usable = accounts.some(account => account.healthy);
    result[profile.name] = { ...(result[profile.name] ?? { available: true, reason: null } as T), available: usable, reason: usable ? null : `No healthy agent account: ${accounts.map(account => account.reason).join('; ')}`, accounts };
  }
  return result;
}

/**
 * Prompt delivery the runtime visibly accepted. Herdr submits the prompt and reports whether the
 * agent left its idle state for it; a runtime that reported ready before its input was (OpenCode
 * does, while its UI loads) drops the text and stays idle, which Herdr answers as a stalled prompt.
 * A stalled prompt is delivered again after a pause; one still refused after every attempt fails
 * the launch, whose caller closes the session and launches afresh. Anything else Herdr refuses
 * fails at once.
 */
export const promptAttempts = 3, promptAcceptMs = 20_000, promptRetryPauseMs = 3_000;
export class PromptNotAcceptedError extends Error { readonly promptDropped = true; }
export function herdrErrorCode(error: unknown) {
  const text = [(error as any)?.herdrCode, (error as any)?.stdout, (error as any)?.stderr, (error as any)?.message].filter(value => value !== undefined && value !== null).map(String).join('\n');
  return (error as any)?.herdrCode ?? /"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? null;
}
export interface PromptDelivery { attempts?: number; acceptMs?: number; pauseMs?: number }
export function deliverPrompt(target: string, text: string, run?: (command: string, args: string[]) => string, options: PromptDelivery & { confirm?: 'inline' | 'follow' } = {}) {
  const attempts = options.attempts ?? promptAttempts, acceptMs = options.acceptMs ?? promptAcceptMs, pauseMs = options.pauseMs ?? promptRetryPauseMs;
  const accepted = ['--until', 'working', '--until', 'blocked', '--timeout', String(acceptMs)];
  const stalls: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Herdr takes options only after the prompt text; 'follow' submits it and then waits for the
      // agent to leave idle, which is the same confirmation for a caller whose text must come last.
      if (options.confirm === 'follow') { herdrJson(['agent', 'prompt', target, text], run); herdrJson(['agent', 'wait', target, ...accepted], run); }
      else herdrJson(['agent', 'prompt', target, text, '--wait', ...accepted], run);
      return { attempts: attempt, accepted: true as const };
    } catch (error) {
      const code = herdrErrorCode(error);
      if (code !== 'agent_prompt_stalled' && code !== 'timeout') throw error;
      stalls.push(code);
      if (attempt < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
    }
  }
  throw new PromptNotAcceptedError(`${target} did not visibly accept its prompt after ${attempts} deliveries (${stalls.join(', ')}); the session is closed and relaunched rather than left idle`);
}

/**
 * Onboarding for agent environments: discover the per-account homes (or create new ones), report
 * which are logged in and how much quota each has left, and generate the master's worker, reviewer
 * and producer profiles from the logged-in ones — no hand-written profile JSON.
 *
 * Every launch profile runs on the logged-in accounts, its own runtime's first, rotated so the
 * profiles spread across accounts. Worker and producer principals come from the credential files
 * the operator issued beside the coordinator's (workers/*.token, producers/*.token), each verified
 * against the control plane for its role before a profile uses it. One reviewer profile is
 * generated per logged-in account. Without apply nothing is written; the report is the plan.
 */
export async function setupAgentEnvironments(root: string, input: { directory?: string; create?: EnvironmentKind[]; apply?: boolean; probe?: EnvironmentProbe; verify: (token: string) => Promise<any> }) {
  const config = await loadMasterConfig(root);
  const directory = agentEnvironmentRoot(input.directory);
  const discovered = await discoverAgentEnvironments(directory);
  const created: string[] = [];
  for (const kind of input.create ?? []) {
    if (!input.apply) { created.push(`${kind} (a new ${kind}-<letter> directory under ${directory}; rerun with --apply)`); continue; }
    const environment = await createAgentEnvironment(directory, kind, discovered);
    discovered.push(environment); created.push(environment.name);
  }
  const prepared = input.apply ? (await Promise.all(discovered.map(environment => prepareAgentEnvironment(environment)))).flat() : [];
  const probe = { ...input.probe, ceilingPercent: input.probe?.ceilingPercent ?? config.run.quotaCeilingPercent };
  const health = await Promise.all(discovered.map(environment => checkAgentEnvironment(environment, probe)));
  const loggedIn = discovered.filter((_, index) => health[index].loggedIn);

  const next: MasterConfig = JSON.parse(JSON.stringify(config));
  next.environments = [...(config.environments ?? []).filter(existing => !discovered.some(found => found.name === existing.name)), ...discovered].sort((a, b) => a.name.localeCompare(b.name));
  // Same-runtime accounts first (the profile's own arguments apply to them), each list rotated so
  // consecutive profiles start on different accounts; the profile's current home, if it is one, leads.
  const accountsFor = (kind: string | undefined, index: number, home?: string) => {
    const rotate = (list: AgentEnvironment[]) => { if (!list.length) return list; const first = home ? list.findIndex(entry => entry.home === home) : -1; const start = first >= 0 ? first : index % list.length; return [...list.slice(start), ...list.slice(0, start)]; };
    return [...rotate(loggedIn.filter(entry => entry.kind === kind)), ...rotate(loggedIn.filter(entry => entry.kind !== kind))].map(entry => entry.name);
  };
  const same = (a?: string[], b?: string[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  const changes: { role: LaunchRole; profile: string; action: 'added' | 'accounts'; accounts: string[]; principal?: string }[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const agentNames = () => new Set([...next.workers, ...next.reviewers, ...next.producers].map(profile => profile.agentName));
  // A profile whose runtime has no environment support keeps launching exactly as configured.
  const supported = (kind?: string) => (environmentKinds as readonly string[]).includes(kind ?? '');
  const migrate = <P extends { name: string; kind?: string; environment: Record<string, string>; accounts?: string[] }>(role: LaunchRole, profile: P, index: number) => {
    if (!supported(profile.kind)) return;
    const variable = environmentVariable[profile.kind as EnvironmentKind];
    const generated = accountsFor(profile.kind, index, profile.environment[variable]);
    // An order already chosen is kept; accounts logged in since are appended to it.
    const accounts = profile.accounts?.length ? [...profile.accounts, ...generated.filter(name => !profile.accounts!.includes(name))] : generated;
    if (!accounts.length || same(profile.accounts, accounts)) return;
    // The account now supplies the home the profile used to pin by hand.
    if (profile.environment[variable] && loggedIn.some(entry => entry.home === profile.environment[variable])) delete profile.environment[variable];
    profile.accounts = accounts; changes.push({ role, profile: profile.name, action: 'accounts', accounts });
  };

  if (loggedIn.length) {
    next.workers.filter(profile => profile.mode === 'launch').forEach((profile, index) => migrate('worker', profile, index));
    next.producers.forEach((profile, index) => migrate('producer', profile, index));
    next.reviewers.forEach((profile, index) => migrate('reviewer', profile, index));
    const credentialHome = dirname(dirname(config.credentialFile));
    const issued = async (role: 'worker' | 'producer') => {
      const folder = resolve(credentialHome, `${role}s`);
      const files = (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith('.token')).sort().map(name => resolve(folder, name));
      const found: { file: string; principal: string }[] = [];
      for (const file of files) {
        if ([...next.workers, ...next.producers].some(profile => profile.credentialFile === file)) continue;
        try {
          await externalCredential(root, file, role === 'worker' ? 'Worker' : 'Producer');
          const status = await input.verify(await readCredentialFile(file));
          if (status.actor?.role !== role || typeof status.actor.id !== 'string') { skipped.push({ file, reason: `authenticates ${status.actor?.role ?? 'no'} role, not ${role}` }); continue; }
          found.push({ file, principal: status.actor.id });
        } catch (error) { skipped.push({ file, reason: error instanceof Error ? error.message : 'unreadable credential' }); }
      }
      return found;
    };
    const profileNameOf = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 80) || 'agent';
    for (const { file, principal } of await issued('worker')) {
      const name = profileNameOf(principal);
      if (next.workers.some(profile => profile.principal === principal || profile.name === name) || agentNames().has(name)) { skipped.push({ file, reason: `a profile already uses principal or name ${principal}` }); continue; }
      const index = next.workers.filter(profile => profile.mode === 'launch').length, accounts = accountsFor(undefined, index);
      const kind = next.environments.find(entry => entry.name === accounts[0])!.kind;
      next.workers.push(workerProfileSchema.parse({ name, principal, agentName: name, mode: 'launch', kind, credentialFile: file, accounts: accountsFor(kind, index) }));
      changes.push({ role: 'worker', profile: name, action: 'added', accounts: accountsFor(kind, index), principal });
    }
    for (const { file, principal } of await issued('producer')) {
      const name = profileNameOf(`produce-${principal}`);
      if (next.workers.some(profile => profile.principal === principal)) { skipped.push({ file, reason: `${principal} is also a worker principal; the control plane refuses evidence from an implementer` }); continue; }
      if (next.producers.some(profile => profile.principal === principal || profile.name === name) || agentNames().has(name)) { skipped.push({ file, reason: `a profile already uses principal or name ${principal}` }); continue; }
      const index = next.producers.length, accounts = accountsFor(undefined, index);
      const kind = next.environments.find(entry => entry.name === accounts[0])!.kind;
      next.producers.push(producerProfileSchema.parse({ name, principal, agentName: name, kind, credentialFile: file, accounts: accountsFor(kind, index) }));
      changes.push({ role: 'producer', profile: name, action: 'added', accounts: accountsFor(kind, index), principal });
    }
    for (const environment of loggedIn) {
      const name = profileNameOf(`review-${environment.name}`);
      if (next.reviewers.some(profile => profile.name === name) || agentNames().has(name)) continue;
      const accounts = [environment.name, ...accountsFor(environment.kind, 0).filter(entry => entry !== environment.name)];
      next.reviewers.push(reviewerProfileSchema.parse({ name, agentName: name, kind: environment.kind, accounts }));
      changes.push({ role: 'reviewer', profile: name, action: 'added', accounts });
    }
    // Automatic review answers with one profile and fails over to the rest.
    if (next.reviewers.length > 1 && !next.run.reviewerProfile) next.run.reviewerProfile = next.reviewers[0].name;
  }
  const parsed = masterConfigSchema.parse(next);
  if (input.apply) await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), parsed);
  const report = health.map(entry => ({ environment: entry.name, kind: entry.kind, home: entry.home, variable: entry.variable, loggedIn: entry.loggedIn, quota: entry.quota, usage: entry.usage, healthy: entry.healthy, reason: entry.reason, note: entry.note, login: entry.login }));
  const loggedOut = report.filter(entry => !entry.loggedIn);
  return { directory, applied: !!input.apply, environments: report, created, prepared, profiles: changes, skipped,
    counts: { environments: report.length, loggedIn: loggedIn.length, workers: parsed.workers.length, reviewers: parsed.reviewers.length, producers: parsed.producers.length },
    next: !report.length ? `No agent environments under ${directory}; rerun with --create claude (or codex, opencode, cursor) --apply, then log each one in`
      : !loggedIn.length ? `No environment is logged in; log in with: ${loggedOut.map(entry => entry.login).join(' ; ')}, then rerun master environments --apply`
      : !input.apply ? 'Rerun with --apply to write these environments and profiles to .graphyard/master.json'
      : loggedOut.length ? `Profiles use the ${loggedIn.length} logged-in environment(s). Log in the rest (${loggedOut.map(entry => entry.login).join(' ; ')}) and rerun master environments --apply to add them`
      : 'Every environment is logged in and every profile uses it; master run checks login and quota before each launch and fails over between them' };
}

/**
 * Replace a producer profile in place, under the same name, with the checks `add` makes: the new
 * credential authenticates exactly the new principal as a producer, and no other profile shares
 * its agent name or principal. A running `master run` adopts it on its next tick.
 */
export async function replaceProducerProfile(root: string, profileInput: unknown, verify: (token: string) => Promise<any>) {
  const profile = producerProfileSchema.parse(profileInput);
  const config = await loadMasterConfig(root);
  const index = config.producers.findIndex(item => item.name === profile.name);
  if (index < 0) throw new Error(`Unknown producer profile ${profile.name}; add it with master producer add`);
  await externalCredential(root, profile.credentialFile, 'Producer');
  const status = await verify(await readCredentialFile(profile.credentialFile));
  if (status.actor?.role !== 'producer' || status.actor.id !== profile.principal) throw new Error('Producer credential does not match the profile principal and producer role');
  const others = config.producers.filter((_, position) => position !== index);
  if (others.some(item => item.agentName === profile.agentName || item.principal === profile.principal)) throw new Error('Producer profile agent name and principal must be unique');
  if (config.workers.some(item => item.agentName === profile.agentName) || config.reviewers.some(item => item.agentName === profile.agentName)) throw new Error('A worker or reviewer profile already uses that Herdr agent name');
  if (config.workers.some(item => item.principal === profile.principal)) throw new Error('A producer principal cannot also be a worker principal; the control plane refuses evidence from an implementer');
  const previous = config.producers[index];
  config.producers[index] = profile; await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), config);
  return { replaced: profile.name, principal: { from: previous.principal, to: profile.principal }, agentName: { from: previous.agentName, to: profile.agentName }, kind: profile.kind,
    proofs: Array.isArray(status.actor?.proofs) ? status.actor.proofs : [], producers: config.producers.length, launch: launchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment) };
}

/** Remove a producer profile. Sessions it already launched stay in the ledger and settle as usual. */
export async function removeProducerProfile(root: string, name: string) {
  const config = await loadMasterConfig(root);
  const removed = config.producers.find(item => item.name === name);
  if (!removed) throw new Error(`Unknown producer profile ${name}`);
  config.producers = config.producers.filter(item => item.name !== name);
  await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), config);
  return { removed: name, principal: removed.principal, agentName: removed.agentName, producers: config.producers.length,
    next: config.producers.length ? 'master run adopts the change on its next tick' : 'No producer profile remains; producer requests wait until one is added with master producer add' };
}

/** `master producer add|replace FILE` and `master producer remove NAME`. */
export async function producerCommand(root: string, args: string[], verify: (token: string) => Promise<any>) {
  if ((args[0] === 'add' || args[0] === 'replace') && args[1]) return (args[0] === 'add' ? saveProducerProfile : replaceProducerProfile)(root, JSON.parse(await readFile(args[1], 'utf8')), verify);
  if (args[0] === 'remove' && args[1]) return removeProducerProfile(root, args[1]);
  throw new Error('Use master producer add FILE, master producer replace FILE, or master producer remove NAME');
}

/**
 * The master's own configuration, re-read by a running loop so a profile, workspace, run setting
 * or merge preference changed in .graphyard/master.json applies without a restart. What the loop
 * is bound to — server, repository, base branch, App, host, coordinator credential, CLI and
 * master agent — cannot change under it: such a change is refused by name and the loop keeps the
 * settings it loaded until it is restarted.
 */
export const masterBoundSettings = ['version', 'url', 'credentialFile', 'cliPath', 'repository', 'baseBranch', 'githubAppId', 'hostId', 'masterAgentName'] as const;
export function masterConfigChanges(current: MasterConfig, next: MasterConfig) {
  const flatten = (config: MasterConfig) => {
    const { run, ...rest } = config;
    return { ...rest, ...Object.fromEntries(Object.entries(run).map(([key, value]) => [`run.${key}`, value])) } as Record<string, unknown>;
  };
  const before = flatten(current), after = flatten(next);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
  return { changed, bound: changed.filter(key => (masterBoundSettings as readonly string[]).includes(key)) };
}
export interface ConfigReload { config: MasterConfig; changed: string[]; refused: string | null; at: string }
export function liveMasterConfig(root: string, initial: MasterConfig, load: (root: string) => Promise<MasterConfig> = loadMasterConfig, clock: () => number = Date.now) {
  const live = {
    current: initial,
    async reload(): Promise<ConfigReload> {
      const at = new Date(clock()).toISOString();
      let next: MasterConfig;
      try { next = await load(root); }
      catch (error) { return { config: live.current, changed: [], at, refused: `.graphyard/master.json could not be reloaded (${error instanceof Error ? error.message : String(error)}); the loop keeps the settings it last loaded` }; }
      const { changed, bound } = masterConfigChanges(live.current, next);
      if (bound.length) return { config: live.current, changed: [], at, refused: `.graphyard/master.json changes ${bound.join(', ')}, which a running master loop is bound to; restart master run to adopt ${bound.length === 1 ? 'it' : 'them'}. Until then the loop keeps its loaded settings, including every other change` };
      live.current = next;
      return { config: next, changed, refused: null, at };
    },
  };
  return live;
}
export type LiveMasterConfig = ReturnType<typeof liveMasterConfig>;

/**
 * The configured Herdr workspace, checked against Herdr's own inventory: a workspace closed since
 * `master init` makes every launch refuse, so status names it before a launch does.
 */
export function herdrWorkspaceHealth(config: Pick<MasterConfig, 'herdrWorkspace'>, run?: (command: string, args: string[]) => string) {
  if (!config.herdrWorkspace) return { workspace: null, exists: null as boolean | null, reason: null as string | null };
  let workspaces: any[];
  try { const listed = herdrJson(['workspace', 'list'], run); workspaces = Array.isArray(listed?.workspaces) ? listed.workspaces : []; }
  catch { return { workspace: config.herdrWorkspace, exists: null, reason: 'Herdr could not list workspaces, so the configured workspace is unverified' }; }
  const exists = workspaces.some(entry => entry?.workspace_id === config.herdrWorkspace);
  return { workspace: config.herdrWorkspace, exists, reason: exists ? null : `Herdr workspace ${config.herdrWorkspace} configured in .graphyard/master.json no longer exists (Herdr lists ${workspaces.map(entry => entry?.workspace_id).filter(Boolean).join(', ') || 'none'}); every launch into it will refuse. Set herdrWorkspace to a live workspace, or rerun master init --herdr-workspace ID` };
}

export type HerdrAgent = { name?: string; pane_id?: string; agent?: string; agent_status?: string; cwd?: string; foreground_cwd?: string; tokens?: Record<string, string> };
// Reviewer failover is a capacity decision the operator must see, not a silent retry.
function reviewState(work: Work) {
  if (reviewProviderOf(work.policy) !== 'agent') return null;
  const failedOver = (work.reviewFailovers ?? []).filter(failover => failover.sha === work.candidate?.sha
    && failover.baseSha === work.candidate?.baseSha && failover.policyRevision === work.policyRevision)
    .map(({ profile, runtime, exhaustion, reason, at, nextProfile }) => ({ profile, runtime, exhaustion, reason, at, nextProfile }));
  const active = reviewerProfileFor(work);
  return { provider: 'agent' as const, profile: active?.name ?? null, runtime: active?.runtime ?? null,
    exhausted: !active && !!work.policy.reviewerProfiles?.length && !!exhaustedReviewerProfiles(work).length, failedOver };
}
export interface ContainmentAssessment {
  key: string; id: string; epoch: number; owner: string; at: string;
  host: string | null; workspacePath: string | null;
  /** The exact scope unit and supervisor pid the launch recorded, when the supervisor reported them. */
  scope: { unit: string; pid: number } | null;
  settleable: boolean; refusals: string[]; attestation: string;
  verification: ContainmentVerification | null;
}

export type ContainmentPhase =
  | { state: 'live'; owner: string; epoch: number; expiresAt: string }
  | { state: 'grace'; lapsedAt: string; remainingMs: number }
  | { state: 'lapsed'; lapsedAt: string | null };
/**
 * Where a containment quarantine stands against its worker's lease. Every supervised launch
 * records one, so while its owner still holds the quarantined epoch's lease it is a session at
 * work, not something to act on. Once the lease lapses, the grace window runs from the later of
 * the lease and launch deadlines, and only then can supervisor absence be verified.
 */
export function containmentPhase(work: Work, now: number, graceMs = containmentGraceMs): ContainmentPhase | null {
  const quarantine = work.containmentQuarantine;
  if (!quarantine) return null;
  const lease = work.lease;
  if (lease && lease.owner === quarantine.owner && lease.epoch === quarantine.epoch && Date.parse(lease.expiresAt) > now)
    return { state: 'live', owner: lease.owner, epoch: lease.epoch, expiresAt: lease.expiresAt };
  const deadlines = [lease?.epoch === quarantine.epoch ? lease.expiresAt : undefined, quarantine.leaseExpiresAt, quarantine.launchExpiresAt]
    .map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite);
  if (!deadlines.length) return { state: 'lapsed', lapsedAt: null };
  const lapsed = Math.max(...deadlines), lapsedAt = new Date(lapsed).toISOString();
  return lapsed + graceMs > now ? { state: 'grace', lapsedAt, remainingMs: lapsed + graceMs - now } : { state: 'lapsed', lapsedAt };
}
/** Why a quarantined item cannot be dispatched: in progress by its live owner, or unverified containment. */
export function containmentHold(work: Work, now: number): string | null {
  const phase = containmentPhase(work, now);
  if (!phase) return null;
  if (phase.state === 'live') return `${work.key} is in progress by ${phase.owner} under lease epoch ${phase.epoch} (active until ${phase.expiresAt})`;
  return `Dispatch blocked by unverified worker containment from epoch ${work.containmentQuarantine!.epoch}`;
}

/** Quarantines this coordinator could verify: the registered host is the one it runs on. */
export function containmentQuarantines(work: Work[], hostId: string) {
  return work.filter(item => item.containmentQuarantine
    && item.workspaces.some(workspace => workspace.epoch === item.containmentQuarantine!.epoch && workspace.host === hostId));
}

/** Bound the local clock against the control plane with the read that produced the snapshot. */
export async function snapshotWithClock<T extends { now: string }>(read: () => Promise<T>, clock: () => number = Date.now) {
  const before = clock();
  const snapshot = await read();
  const after = clock();
  const server = Date.parse(snapshot.now);
  const bound = (value: number) => Number.isFinite(server) ? Math.round(value - server) : NaN;
  return { snapshot, clockOffset: { min: bound(before), max: bound(after) } };
}

/**
 * Verify on this host that a quarantined supervisor is gone, and say why not when it cannot.
 * The assessment is a proposal: the control plane re-evaluates the same refusals itself.
 */
export function verifyContainmentDeath(
  work: Work,
  options: { observedAt: string; hostId: string; clockOffset: { min: number; max: number }; localNow?: Date; probe?: typeof probeSupervisorAbsence },
): ContainmentAssessment {
  const quarantine = work.containmentQuarantine!;
  const workspace = work.workspaces.find(item => item.epoch === quarantine?.epoch) ?? null;
  const assessment: ContainmentAssessment = {
    key: work.key, id: work.id, epoch: quarantine?.epoch ?? work.epoch, owner: quarantine?.owner ?? '', at: quarantine?.at ?? '',
    host: workspace?.host ?? null, workspacePath: workspace?.path ?? null, scope: quarantine?.scope ?? null,
    settleable: false, refusals: [], attestation: containmentAttestation(work.key), verification: null,
  };
  if (!quarantine) return { ...assessment, refusals: ['No containment quarantine is recorded for this task'] };
  if (!workspace) return { ...assessment, refusals: [`Epoch ${quarantine.epoch} registered no workspace, so its supervisor has no verifiable host`] };
  if (workspace.host !== options.hostId)
    return { ...assessment, refusals: [`Epoch ${quarantine.epoch} is registered on host ${workspace.host}; automatic verification must run there`] };
  const bounded = (value: number) => Number.isInteger(value) && Math.abs(value) <= 86_400_000;
  if (!bounded(options.clockOffset.min) || !bounded(options.clockOffset.max))
    return { ...assessment, refusals: ['The control-plane clock could not be compared with this host'] };
  // The probe is told the exact scope the launch recorded, so it can hold everything that
  // scope still contains and attribute a neighbour's scope to its own live supervisor.
  const probe = (options.probe ?? probeSupervisorAbsence)({ key: work.key, epoch: quarantine.epoch, workspacePath: workspace.path, scope: quarantine.scope ?? null });
  const verification = containmentVerificationSchema.parse({ ...probe, host: options.hostId, observedAt: (options.localNow ?? new Date()).toISOString(), clockOffset: options.clockOffset });
  const refusals = containmentSettlementRefusals(work, verification, { now: Date.parse(options.observedAt) });
  return { ...assessment, settleable: !refusals.length, refusals, verification };
}
/** Verify every lapsed quarantine this host is responsible for, keyed by work id; a live worker's is not probed. */
export function assessContainment(work: Work[], options: { hostId: string; observedAt: string; clockOffset: { min: number; max: number }; probe?: typeof probeSupervisorAbsence }) {
  const assessments: Record<string, ContainmentAssessment> = {};
  for (const item of containmentQuarantines(work, options.hostId)) {
    if (containmentPhase(item, Date.parse(options.observedAt))?.state === 'live') continue;
    try { assessments[item.id] = verifyContainmentDeath(item, options); }
    catch (error) {
      assessments[item.id] = { key: item.key, id: item.id, epoch: item.containmentQuarantine!.epoch, owner: item.containmentQuarantine!.owner, at: item.containmentQuarantine!.at,
        host: options.hostId, workspacePath: item.workspaces.find(workspace => workspace.epoch === item.containmentQuarantine!.epoch)?.path ?? null, scope: item.containmentQuarantine!.scope ?? null,
        settleable: false, refusals: [`Host verification could not be completed: ${error instanceof Error ? error.message : String(error)}`],
        attestation: containmentAttestation(item.key), verification: null };
    }
  }
  return assessments;
}
/** The control-plane facts `GET /api/status` reports that are not about any one work item. */
export interface ControlPlaneStatus {
  appPermissions?: { app?: string; installationUrl?: string; verifiedAt?: string | null; error?: string | null; suspended?: boolean; missing?: { permission: string; required: string; features: string[] }[]; attention?: string[] } | null;
  heldJobs?: number;
  /** Capacity variables against the configured roster; a server before GY-59 reports none. */
  delegationLimits?: { limits?: Record<string, number>; deployed?: Record<string, string | null>; drift?: { variable: string; deployed: string | null; required: string; reason: string }[]; attention?: string[] } | null;
  /** The build the server runs and the merge protocol it speaks. */
  build?: { commit?: string | null; protocol?: number | null } | null;
  /** Production deployment observation for the base branch. */
  production?: Partial<ProductionReport> | null;
}
/**
 * Who resolves an attention item and the next command they run. `role` is an agent role
 * (master, approver, reviewer, control plane); `human` is true only for the human-only list,
 * and `humanOnly` then names which of those decisions it is.
 */
export interface AttentionOwner { role: 'master' | 'reviewer' | 'control plane' | 'human'; approvedBy: 'approver' | null; human: boolean; humanOnly: typeof humanOnlyDecisions[number] | null; next: string }
export interface AttentionItem extends AttentionOwner { subject: string; text: string }
export const agentOwner = (role: 'master' | 'reviewer' | 'control plane', next: string, approvedBy: 'approver' | null = null): AttentionOwner => ({ role, approvedBy, human: false, humanOnly: null, next });
export const humanOwner = (humanOnly: typeof humanOnlyDecisions[number], next: string): AttentionOwner => ({ role: 'human', approvedBy: null, human: true, humanOnly, next });
/** The owner of one installation attention line, by the source that raised it. */
export function installationOwner(source: 'app-permissions' | 'held-jobs' | 'delegation-limits' | 'production', text: string): AttentionOwner {
  // Reinstating a suspended App installation is an account decision on the operator's GitHub account.
  if (source === 'app-permissions') return /suspended/i.test(text) ? humanOwner('spending money or opening third-party accounts', 'Reinstate the suspended GitHub App installation from the account that owns it')
    : agentOwner('master', 'graphyard master browser app-permissions, then graphyard master browser installation-accept');
  if (source === 'held-jobs') return agentOwner('control plane', 'Nothing to run: held jobs resume once graphyard master browser installation-accept grants the permission');
  if (source === 'delegation-limits') { const assignment = /Set (\S+=\S+)/.exec(text)?.[1]; return agentOwner('master', assignment ? `Set ${assignment} on the deployment (Railway: railway variables --set ${assignment} --service graphyard), then redeploy` : 'Set the named capacity variable on the deployment, then redeploy'); }
  return agentOwner('master', 'Fix or trigger the deployment of the base branch with the configured provider, then graphyard master verify-deployment GY-N for each pending delivery');
}
/**
 * The owner of a work item's attention, from the same facts that raised it. Everything an agent
 * identity may run is routed to an agent: decisions a human used to make go to the master and
 * its independent approver through graphyard master decide.
 */
export function workAttentionOwner(work: Work, cause: 'containment-settleable' | 'containment-grace' | 'containment' | 'session' | 'proof-gap' | 'reviewer-exhausted' | 'launch-review' | 'launch-producer' | 'base-conflict' | 'gate'): AttentionOwner {
  const key = work.key;
  // Graphyard absorbs a moved base itself; a conflict is the one case it cannot, so the candidate
  // goes back to a worker for a fresh attempt rather than waiting for a refresh that cannot land.
  if (cause === 'base-conflict') return agentOwner('master', `graphyard master decide ${key} rework REASON, then graphyard master approver ${key} DECISION`, 'approver');
  if (cause === 'containment-settleable') return agentOwner('master', `graphyard master settle-containment ${key} REASON`);
  if (cause === 'containment-grace') return agentOwner('master', `Wait out the grace window, then graphyard master status verifies the host and graphyard master settle-containment ${key} REASON once settleable`);
  if (cause === 'containment') return agentOwner('master', `Stop the recorded supervisor on its host, then graphyard master decide ${key} ${work.stage === 'done' ? 'recover' : 'rework'} REASON and graphyard master approver ${key} DECISION`, 'approver');
  if (cause === 'session') return agentOwner('master', `herdr agent list to inspect the session; once the lease lapses, graphyard master dispatch ${key} PROFILE`);
  if (cause === 'proof-gap') return agentOwner('master', `graphyard master decide ${key} grant '{"principal":"PRODUCER","patterns":["${(work.proofGaps ?? [])[0] ?? 'PROOF'}"]}' REASON, then graphyard master approver ${key} DECISION`, 'approver');
  if (cause === 'reviewer-exhausted') return agentOwner('master', `graphyard master reviewer add FILE with a profile on another provider, then graphyard master review ${key}`);
  if (cause === 'launch-review') return agentOwner('master', `Fix the refusal reason, then graphyard master review ${key}`);
  if (cause === 'launch-producer') return agentOwner('master', 'Fix the refusal reason (graphyard master producer add FILE for a missing profile); the loop relaunches the producer on its own');
  const escalation = standingEscalations(work)[0];
  if (escalation) return agentOwner('master', `graphyard master decide ${key} resolve '{"trigger":"${escalation.trigger}"}' REASON, then graphyard master approver ${key} DECISION`, 'approver');
  // The owner follows the refusal the row shows: the first failing gate, then a bare blocker.
  const first = work.gates.find(gate => !gate.passed);
  const manual = first?.name === 'acceptance' ? /(manual:[\w./-]+)/.exec(first.reasons.join(' '))?.[1] : undefined;
  if (manual) return agentOwner('master', `graphyard master decide ${key} attest '{"proof":"${manual}"}' REASON, then graphyard master approver ${key} DECISION`, 'approver');
  if (first?.name === 'review') return agentOwner('reviewer', `The reviewer session judges it; graphyard master review ${key} relaunches a refused review`);
  if (first?.name === 'merge' && work.stage === 'merge') return agentOwner('master', `graphyard master merge ${key}`);
  if (work.blocker) return agentOwner('master', `Clear the cause, then graphyard master unblock ${key} REASON; a cause that needs money, a third-party account or a person's credential goes to the human`);
  return agentOwner('master', `graphyard diagnose ${key}`);
}
/**
 * Attention that belongs to the installation rather than to a work item: a declared App
 * permission the installation lacks, an unverifiable preflight, the jobs held on it, a
 * capacity variable that no longer covers the roster, and a base branch that production has
 * not deployed.
 */
export function controlPlaneAttention(status: ControlPlaneStatus | undefined) {
  const report = status?.appPermissions;
  const items: AttentionItem[] = [];
  const raise = (source: Parameters<typeof installationOwner>[0], text: string) => items.push({ subject: 'installation', text, ...installationOwner(source, text) });
  for (const text of report?.attention ?? []) raise('app-permissions', text);
  if (status?.heldJobs) raise('held-jobs', `${status.heldJobs} integration job${status.heldJobs === 1 ? ' is' : 's are'} held on that permission shortfall rather than retried; they resume on their own once the installation reports the permission`);
  for (const text of status?.delegationLimits?.attention ?? []) raise('delegation-limits', text);
  const production = status?.production ? productionSummary(status.production) : null;
  for (const text of production?.attention ?? []) raise('production', text);
  const attention = items.map(item => item.text);
  return { attention, attentionItems: items, appPermissions: report ? { app: report.app ?? null, installationUrl: report.installationUrl ?? null, verifiedAt: report.verifiedAt ?? null, error: report.error ?? null, suspended: report.suspended ?? false, missing: (report.missing ?? []).map(shortfall => ({ permission: shortfall.permission, required: shortfall.required, features: shortfall.features })) } : null, heldJobs: status?.heldJobs ?? 0,
    delegationLimits: status?.delegationLimits ? { limits: status.delegationLimits.limits ?? null, deployed: status.delegationLimits.deployed ?? null, drift: (status.delegationLimits.drift ?? []).map(entry => ({ variable: entry.variable, deployed: entry.deployed, required: entry.required, reason: entry.reason })) } : null,
    build: status?.build ? { commit: status.build.commit ?? null, protocol: status.build.protocol ?? null } : null, production };
}
/**
 * The production lag an operator reads first: what production serves, how far the base
 * branch is ahead of it, and the failing deployment reason when the provider reported one.
 */
export function productionSummary(report: Partial<ProductionReport>) {
  const incidents = (report.incidents ?? []).map(incident => ({ key: incident.key, mergeSha: incident.mergeSha, status: incident.status, reason: incident.reason, deploymentId: incident.deploymentId ?? null, since: incident.since }));
  const ahead = report.ahead ?? null;
  const summary = ahead ? ahead.by === 0 ? 'production serves the base branch tip' : `main is ${ahead.by} commit${ahead.by === 1 ? '' : 's'} ahead of production` : report.aheadError ?? 'production lag is unknown';
  return { provider: report.provider ?? null, observedAt: report.observedAt ?? null, serving: report.serving ?? null, running: report.running ?? null, aheadBy: ahead?.by ?? null, aheadCommits: ahead?.commits ?? [], summary,
    latestDeployment: report.latest ? { id: report.latest.id, status: report.latest.providerStatus, commit: report.latest.commit, createdAt: report.latest.createdAt, url: report.latest.url ?? null } : null,
    deployed: report.deployed ?? [], pending: report.pending ?? [], incidents, error: report.error ?? null,
    attention: attentionLines({ ahead, aheadError: report.aheadError ?? null, serving: report.serving ?? null, incidents: (report.incidents ?? []), error: report.error ?? null, latest: report.latest ?? null, provider: report.provider ?? null }) };
}
/*
 * Disk is a shared resource of the host, and assignment worktrees are the loop's largest consumer
 * of it: every attempt and every rework checks the repository out again, and a checkout that
 * installs its own dependencies costs about as much as the source it builds. Two halves keep that
 * bounded — one install shared by the worktrees that can use it, and a reclaimer that gives back
 * the installs of finished assignments.
 */

/**
 * The disposable artifacts inside an assignment worktree: dependency trees a package manager
 * recreates from the lockfile. Nothing else is ever removed — not a checkout, not its Git
 * metadata, never a branch, and never one of Graphyard's registered workspace records.
 */
export const dependencyDirectories = ['node_modules'] as const;
export const defaultReclaimIdleHours = 3, defaultDiskThresholdGb = 10;
export const reclaimIdleMs = (config: { run: Pick<MasterRun, 'reclaimIdleHours'> }) => (config.run.reclaimIdleHours ?? defaultReclaimIdleHours) * 3_600_000;
export const diskThresholdBytes = (config: { run: Pick<MasterRun, 'diskThresholdGb'> }) => (config.run.diskThresholdGb ?? defaultDiskThresholdGb) * 1e9;
export const lockfiles = ['package-lock.json'] as const;
export const worktreesDirectory = (root: string) => resolve(root, '.graphyard/worktrees');
const failureText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * A write that failed because there is no room left, said as exactly that. A full volume and an
 * exhausted user quota arrive as an errno on a direct write and as text in a child command's
 * output (`pwd: write error: Disk quota exceeded`); both are the same condition, and reporting
 * it as an unexplained command failure is what sends the next investigation to the wrong place.
 */
export function diskExhaustion(error: unknown): string | null {
  const record = error as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown } | null;
  const code = typeof record?.code === 'string' ? record.code : '';
  if (code === 'ENOSPC') return 'the volume is full (ENOSPC)';
  if (code === 'EDQUOT') return "the host's disk quota is exhausted (EDQUOT)";
  const text = [record?.message, record?.stderr, record?.stdout].filter(value => typeof value === 'string' || Buffer.isBuffer(value)).join('\n');
  if (/no space left on device/i.test(text)) return 'the volume is full (ENOSPC)';
  if (/disk quota exceeded/i.test(text)) return "the host's disk quota is exhausted (EDQUOT)";
  return null;
}
export const reclaimAdvice = 'the master loop reclaims the dependency directories of finished assignment worktrees on every cycle while free space is low; lower run.reclaimIdleHours in .graphyard/master.json to make more of them disposable, then retry';
/** The same failure, named by its cause when the cause is exhausted disk and left alone otherwise. */
export function writeFailure(error: unknown, action: string): Error {
  const cause = diskExhaustion(error);
  if (!cause) return error instanceof Error ? error : new Error(String(error));
  return Object.assign(new Error(`${action} failed because ${cause}: ${reclaimAdvice}`), { code: (error as { code?: string } | null)?.code ?? 'ENOSPC', cause: error });
}

/** Free space on the volume holding a path, as the kernel reports it to this user. */
export async function freeBytes(path: string): Promise<number | null> {
  try { const info = await statfs(path); return Number(info.bavail) * Number(info.bsize); } catch { return null; }
}

export interface WorktreeDependency { path: string; kind: 'directory' | 'link' }
export interface WorktreeEntry {
  path: string; name: string;
  /** The newest change under the worktree, ignoring the dependency trees an install rewrites. */
  activityAt: number;
  dependencies: WorktreeDependency[];
}
/**
 * The newest change inside a worktree, ignoring the dependency trees themselves. A linked
 * worktree keeps its index and refs in the main repository, so what changes here is the working
 * tree itself: the session's own edits, checkouts and build output, which is exactly the activity
 * the idle bound is about.
 */
export async function worktreeActivity(path: string, now = Date.now()) {
  const names = await readdir(path).catch(() => [] as string[]);
  const targets = [path, ...names.filter(name => !(dependencyDirectories as readonly string[]).includes(name)).map(name => resolve(path, name))];
  const times = await Promise.all(targets.map(target => lstat(target).then(info => info.mtimeMs).catch(() => 0)));
  // A timestamp ahead of the clock must not make a worktree look idle for ever.
  return Math.min(Math.max(0, ...times), now);
}
/** Every assignment worktree on this host and the dependency trees it is holding. */
export async function inventoryWorktrees(root: string, now = Date.now()): Promise<WorktreeEntry[]> {
  const base = worktreesDirectory(root);
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const worktrees = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const path = resolve(base, entry.name);
    const dependencies: WorktreeDependency[] = [];
    for (const name of dependencyDirectories) {
      const info = await lstat(resolve(path, name)).catch(() => null);
      if (info?.isSymbolicLink()) dependencies.push({ path: resolve(path, name), kind: 'link' });
      else if (info?.isDirectory()) dependencies.push({ path: resolve(path, name), kind: 'directory' });
    }
    return { path, name: entry.name, activityAt: await worktreeActivity(path, now), dependencies };
  }));
  return worktrees.sort((a, b) => a.name.localeCompare(b.name));
}

export type ReclaimDisposition = 'live' | 'recent' | 'idle' | 'superseded' | 'delivered';
export interface WorktreeReclaimCandidate {
  path: string; name: string; key: string | null; epoch: number | null; branch: string | null;
  disposition: ReclaimDisposition; disposable: boolean; idleMs: number; detail: string;
  dependencies: WorktreeDependency[];
}
/**
 * Which assignment worktrees hold disposable dependency trees. A worktree whose assignment is
 * finished — delivered, superseded by a later epoch, or untouched beyond the configured age —
 * can install again from its lockfile whenever it is needed; one whose attempt still holds the
 * lease is never touched. The decision is a pure function of the Graphyard snapshot and the
 * filesystem inventory, so the loop and `master status` always answer alike.
 */
export function planWorktreeReclaim(entries: WorktreeEntry[], work: Work[], options: { now: number; idleMs: number }): WorktreeReclaimCandidate[] {
  const minutes = (ms: number) => Math.floor(ms / 60_000);
  return entries.map(entry => {
    const owner = work.find(item => item.workspaces.some(space => resolve(space.path) === entry.path));
    const workspace = owner?.workspaces.find(space => resolve(space.path) === entry.path) ?? null;
    const idleMs = Math.max(0, options.now - entry.activityAt);
    const live = !!owner?.lease && owner.lease.epoch === workspace?.epoch && Date.parse(owner.lease.expiresAt) > options.now;
    const [disposition, detail]: [ReclaimDisposition, string] =
      live ? ['live', `${owner!.key} epoch ${workspace!.epoch} holds the lease until ${owner!.lease!.expiresAt}`]
      : owner && owner.stage === 'done' ? ['delivered', `${owner.key} is delivered; the attempt that used this worktree is finished`]
      : owner && workspace && workspace.epoch < owner.epoch ? ['superseded', `${owner.key} epoch ${workspace.epoch} was superseded by epoch ${owner.epoch}`]
      : idleMs >= options.idleMs ? ['idle', `Untouched for ${minutes(idleMs)} minutes, past the ${minutes(options.idleMs)}-minute idle bound`]
      : ['recent', `${owner ? `${owner.key} ` : 'An unregistered worktree '}changed ${minutes(idleMs)} minutes ago, inside the ${minutes(options.idleMs)}-minute idle bound`];
    return { path: entry.path, name: entry.name, key: owner?.key ?? null, epoch: workspace?.epoch ?? null, branch: workspace?.branch ?? null,
      disposition, disposable: disposition !== 'live' && disposition !== 'recent' && entry.dependencies.length > 0,
      idleMs, detail, dependencies: entry.dependencies };
  });
}
/** The only path the reclaimer may remove: a dependency tree one level inside an assignment worktree. */
function assertDisposable(base: string, target: string) {
  const worktree = dirname(target);
  if (!(dependencyDirectories as readonly string[]).includes(basename(target)) || dirname(worktree) !== base || worktree === base)
    throw new Error(`Refusing to remove ${target}: the reclaimer removes only ${dependencyDirectories.join(', ')} directly inside an assignment worktree`);
}

export interface WorktreeReclaimReport {
  root: string; at: string; applied: boolean; scanned: number; idleMs: number;
  removed: string[]; kept: { path: string; disposition: ReclaimDisposition; detail: string }[];
  freeBefore: number | null; freeAfter: number | null; freedBytes: number; errors: string[];
}
/**
 * Give the host back the dependency trees of finished assignments. The reclaimer removes nothing
 * else: a checkout keeps its files and its Git metadata, a branch keeps every commit it holds —
 * pushed or not — and Graphyard's registered workspace records are never written, so the disk is
 * freed without any assignment losing history the control plane still refers to.
 */
export async function reclaimWorktrees(root: string, work: Work[], options: { idleMs: number; now?: number; apply?: boolean }): Promise<WorktreeReclaimReport> {
  const now = options.now ?? Date.now(), apply = options.apply !== false, base = worktreesDirectory(root);
  const plan = planWorktreeReclaim(await inventoryWorktrees(root, now), work, { now, idleMs: options.idleMs });
  const freeBefore = await freeBytes(base);
  const removed: string[] = [], errors: string[] = [];
  for (const candidate of plan.filter(entry => entry.disposable)) {
    for (const dependency of candidate.dependencies) {
      try { assertDisposable(base, dependency.path); } catch (error) { errors.push(failureText(error)); continue; }
      if (!apply) { removed.push(dependency.path); continue; }
      try { await rm(dependency.path, { recursive: true, force: true }); removed.push(dependency.path); }
      catch (error) { errors.push(`${dependency.path}: ${writeFailure(error, 'Reclaiming a dependency directory').message}`); }
    }
  }
  const freeAfter = apply ? await freeBytes(base) : freeBefore;
  return { root, at: new Date(now).toISOString(), applied: apply, scanned: plan.length, idleMs: options.idleMs, removed,
    kept: plan.filter(entry => !entry.disposable).map(entry => ({ path: entry.path, disposition: entry.disposition, detail: entry.detail })),
    freeBefore, freeAfter, freedBytes: freeBefore === null || freeAfter === null ? 0 : Math.max(0, freeAfter - freeBefore), errors };
}

export interface DiskPressure { path: string; freeBytes: number | null; thresholdBytes: number; low: boolean; reclaimable: number; worktrees: number; unavailable: string | null }
/** Free space beside what a reclaim would give back, in the shape `master status` reports it. */
export function diskPressure(path: string, free: number | null, thresholdBytes: number, plan: WorktreeReclaimCandidate[]): DiskPressure {
  return { path, freeBytes: free, thresholdBytes, low: free !== null && free < thresholdBytes,
    reclaimable: plan.filter(entry => entry.disposable).length, worktrees: plan.length,
    unavailable: free === null ? `Free space on ${path} could not be read` : null };
}
const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
/**
 * The attention item that has to arrive before the volume fills: how much room is left, how much
 * of it finished worktrees are holding, and the one command that gives it back. It is raised on
 * the configured threshold rather than on the first failed write, so the master acts while
 * writes still succeed.
 */
export function diskPressureAttention(pressure: DiskPressure): AttentionItem[] {
  if (!pressure.low || pressure.freeBytes === null) return [];
  return [{ subject: 'disk', text: `${gigabytes(pressure.freeBytes)} free on ${pressure.path}, below the configured ${gigabytes(pressure.thresholdBytes)} threshold; ${pressure.reclaimable} of ${pressure.worktrees} assignment worktree(s) hold dependency directories a fresh install recreates. Reclaim them before the volume fills`,
    ...agentOwner('master', 'graphyard master run reclaims every cycle while free space is low (daemon.reclaim in master status says what it took back); lower run.reclaimIdleHours in .graphyard/master.json to make more of them disposable, and graphyard master run --once reclaims immediately when no loop is running') }];
}

/**
 * One dependency install, shared by every worktree that can use it. A fresh attempt must start
 * from a clean checkout of its exact head; what it must not do is spend another gigabyte, and the
 * first minutes of its session, on a private copy of dependencies it resolves identically.
 *
 * A worktree created under the repository already resolves the repository's own install by the
 * runtime's ordinary upward lookup, so the right answer there is to install nothing and say so. A
 * worktree outside it gets a mirror instead: a real directory of links, one per installed package,
 * so the repository's `node_modules/` ignore rule still covers it and the checkout stays clean.
 * Either way the install must answer for this exact head — the same lockfile, byte for byte — and a
 * worktree that already has an install of its own is reported and left exactly as it is.
 */
export const sharedInstallMarker = '.graphyard-shared';
export interface SharedDependency { name: string; source: string; how: 'reachable' | 'mirrored' }
export interface SharedDependencies { shared: SharedDependency[]; skipped: { name: string; reason: string }[] }
export async function shareDependencies(root: string, worktree: string): Promise<SharedDependencies> {
  const shared: SharedDependency[] = [], skipped: { name: string; reason: string }[] = [];
  for (const name of dependencyDirectories) {
    const own = resolve(worktree, name);
    if (await lstat(own).catch(() => null)) {
      const mirrored = await sharedInstallSource(own);
      if (mirrored) shared.push({ name, source: mirrored, how: 'mirrored' });
      else skipped.push({ name, reason: `The worktree already has its own ${name}; it is left exactly as it is` });
      continue;
    }
    // What the runtime would resolve from this worktree, before anything is created for it.
    const reachable = await reachableInstall(worktree, name);
    if (reachable) {
      const compatible = await compatibleInstall(dirname(reachable), worktree);
      if (compatible === true) shared.push({ name, source: reachable, how: 'reachable' });
      else skipped.push({ name, reason: compatible });
      continue;
    }
    const source = resolve(root, name);
    if (!(await lstat(source).catch(() => null))?.isDirectory()) { skipped.push({ name, reason: `No shared ${name} install is reachable from ${worktree}` }); continue; }
    const compatible = await compatibleInstall(root, worktree);
    if (compatible !== true) { skipped.push({ name, reason: compatible }); continue; }
    try {
      const entries = await readdir(source);
      await mkdir(own, { recursive: true });
      await Promise.all(entries.map(entry => symlink(resolve(source, entry), resolve(own, entry))));
      // Written last, so a half-made mirror is never mistaken for a complete one.
      await writeFile(resolve(own, sharedInstallMarker), `${source}\n`);
      shared.push({ name, source, how: 'mirrored' });
    } catch (error) {
      // A partial mirror would resolve some imports and fail others, which is worse than none.
      await rm(own, { recursive: true, force: true }).catch(() => {});
      skipped.push({ name, reason: writeFailure(error, `Sharing ${name} into ${worktree}`).message });
    }
  }
  return { shared, skipped };
}
/** The install the runtime resolves from a worktree by its ordinary upward lookup, if any. */
async function reachableInstall(worktree: string, name: string): Promise<string | null> {
  for (let directory = dirname(worktree), parent = dirname(directory); ; directory = parent, parent = dirname(directory)) {
    const candidate = resolve(directory, name);
    if ((await lstat(candidate).catch(() => null))?.isDirectory()) return candidate;
    if (parent === directory) return null;
  }
}
/** The install a worktree's dependency directory mirrors, or null when it is the worktree's own. */
export async function sharedInstallSource(target: string): Promise<string | null> {
  const marker = await readFile(resolve(target, sharedInstallMarker), 'utf8').catch(() => null);
  return marker?.trim() || null;
}
/** An install answers for a head only when that head resolves the same lockfile, byte for byte. */
async function compatibleInstall(installed: string, worktree: string): Promise<true | string> {
  for (const name of lockfiles) {
    const [a, b] = await Promise.all([readFile(resolve(installed, name)).catch(() => null), readFile(resolve(worktree, name)).catch(() => null)]);
    if (!a || !b) return `${name} is missing from ${installed} or from this head, so no existing install can be matched to it`;
    if (createHash('sha256').update(a).digest('hex') !== createHash('sha256').update(b).digest('hex')) return `${name} differs from the install at ${installed}, so this head installs its own dependencies`;
  }
  return true;
}

/**
 * The version-skew guard the broker runs before touching a merge. The CLI and the server
 * each declare the merge protocol they speak; a server behind the CLI — main merged, the
 * deployment never served it — is reported as exactly that, with both commits, instead of
 * the broker failing later on a reply shape it does not recognize. A server that reports no
 * protocol predates the exchange and is version 1.
 */
export function mergeProtocolSkew(status: { build?: { commit?: string | null; protocol?: number | null } | null } | undefined, cli: { commit: string | null; protocol?: number }): string | null {
  const serverProtocol = status?.build?.protocol ?? 1, cliProtocol = cli.protocol ?? MERGE_PROTOCOL;
  if (serverProtocol === cliProtocol) return null;
  const serverCommit = status?.build?.commit ?? 'an unknown commit', cliCommit = cli.commit ?? 'an unknown commit';
  return `server runs ${serverCommit}, CLI expects ${cliCommit}: deploy main first (server merge protocol ${serverProtocol}, CLI merge protocol ${cliProtocol}${serverProtocol < cliProtocol ? '; the deployment has not served the commit the CLI runs' : '; update the CLI checkout to the deployed commit'})`;
}
/** Sessions the local ledgers hold and the launches the dispatcher refused, as `master status` joins them onto each candidate's requests. */
export interface SessionRetryReport { requestId: string; attempts: number; limit: number; nextAt: string | null; exhausted: boolean; last: { state: string; resolution: string | null } | null }
export interface DispatchSessions { producers: { pending: any[]; completed: any[] }; failures: { requestId: string; kind: string; attempts: number; reason: string; at: string; nextAt: string }[]; retries?: SessionRetryReport[] }
const noSessions: DispatchSessions = { producers: { pending: [], completed: [] }, failures: [] };
/**
 * What is running for one candidate and since when: every open request the control plane
 * holds for the current head, the session (if any) launched for it, and the launch failure
 * standing against it, plus the last resolved requests so a re-request reads with its history.
 */
export function describeDispatch(work: Work, reviews: { pending: any[]; completed: any[] }, sessions: DispatchSessions, now: number) {
  const state = work.autoDispatch;
  if (!state) return null;
  const since = (at: string) => Math.max(0, now - Date.parse(at));
  const session = (records: any[], requestId: string) => {
    const record = [...records].reverse().find(entry => entry.requestId === requestId);
    return record ? { id: record.review ?? record.producer, profile: record.profile, agentName: record.agentName, state: record.state, attempt: record.attempt ?? 1, requestedAt: record.requestedAt, sinceMs: since(record.requestedAt), ...(record.verdict !== undefined ? { verdict: record.verdict } : {}), ...(record.outcome ? { outcome: record.outcome } : {}), resolution: record.resolution ?? null, attention: record.attention ?? null } : null;
  };
  const failure = (requestId: string) => sessions.failures.find(entry => entry.requestId === requestId) ?? null;
  // A session that failed or expired is relaunched for the same request on a widening interval;
  // the attempts so far and when the next one is due are reported beside the request.
  const retry = (requestId: string) => sessions.retries?.find(entry => entry.requestId === requestId) ?? null;
  const describe = (request: NonNullable<typeof state.review>, records: any[]) => ({ requestId: request.id, sha: request.sha, baseSha: request.baseSha, policyRevision: request.policyRevision, requestedAt: request.requestedAt, sinceMs: since(request.requestedAt), reason: request.reason,
    ...(request.group ? { group: request.group, proofs: request.proofs } : {}), session: session(records, request.id), failure: failure(request.id), retry: retry(request.id) });
  const reviewRecords = [...reviews.completed, ...reviews.pending], producerRecords = [...sessions.producers.completed, ...sessions.producers.pending];
  return { review: state.review ? describe(state.review, reviewRecords) : null, producers: state.producers.map(request => describe(request, producerRecords)),
    recent: state.history.slice(-5).map(request => ({ kind: request.kind, ...(request.group ? { group: request.group } : {}), sha: request.sha, state: request.state, resolution: request.resolution ?? null, resolvedAt: request.resolvedAt ?? null })) };
}
export function buildMasterStatus(snapshot: { work: Work[]; now: string }, profiles: WorkerProfile[], agents: HerdrAgent[], credentialHealth: Record<string, { available: boolean; reason: string | null }> = {}, containment: Record<string, ContainmentAssessment> = {}, reviews: { pending: any[]; completed: any[] } = { pending: [], completed: [] }, baseBranch = 'main', controlPlane?: ControlPlaneStatus, sessions: DispatchSessions = noSessions, candidateConflicts: { report: Record<string, ConflictReport>; available: boolean; reason: string | null } = { report: {}, available: false, reason: 'Candidate conflicts were not probed' }) {
  const now = Date.parse(snapshot.now);
  const scheduling = dispatchSchedule(snapshot.work, now);
  const installation = controlPlaneAttention(controlPlane);
  const workerSessions = profiles.map(profile => {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    const credential = credentialHealth[profile.name] ?? { available: true, reason: null };
    return { profile: profile.name, principal: profile.principal, agentName: profile.agentName, mode: profile.mode, state: agent?.agent_status ?? 'offline', pane: agent?.pane_id ?? null, cwd: agent?.foreground_cwd ?? agent?.cwd ?? null, contextPercent: agent?.tokens?.agent_watcher_context_pct ? Number(agent.tokens.agent_watcher_context_pct) : null, credential };
  });
  const placements = predictQueue(snapshot.work, now);
  const queueRows = placements.map(placement => queueRow(placement, describeQueueBinding(snapshot.work.find(work => work.id === placement.id)!, snapshot.work, new Date(now), placement)));
  const rows = snapshot.work.filter(work => work.stage !== 'done').map(work => {
    const placement = placements.find(entry => entry.id === work.id) ?? null;
    const active = !!work.lease && Date.parse(work.lease.expiresAt) > now;
    const profile = active ? profiles.find(item => item.principal === work.lease!.owner) : undefined;
    const session = profile ? workerSessions.find(item => item.profile === profile.name) : undefined;
    const first = work.gates.find(gate => !gate.passed);
    const freshObservation = !!work.observation && now - Date.parse(work.observation.at) >= 0 && now - Date.parse(work.observation.at) < 120_000;
    const activeMerge = !!work.mergeExecution && Date.parse(work.mergeExecution.expiresAt) > now;
    const mergeable = !activeMerge && freshObservation && work.stage === 'merge' && !!work.candidate && !!work.mergeAuthorization
      && work.mergeAuthorization.sha === work.candidate.sha && work.mergeAuthorization.baseSha === work.candidate.baseSha
      && work.mergeAuthorization.policyRevision === work.policyRevision
      && work.gates.every(gate => gate.passed) && !work.violations.length;
    const dwellMs = now - Date.parse(work.stageEnteredAt);
    const review = reviewState(work);
    const assessed = containment[work.id];
    const phase = containmentPhase(work, now);
    const quarantine = work.containmentQuarantine && phase
      ? { epoch: work.containmentQuarantine.epoch, owner: work.containmentQuarantine.owner, at: work.containmentQuarantine.at,
        // A live owner's containment is its running session; the grace window and settlement apply only once the lease lapses.
        phase: phase.state, lapsedAt: phase.state === 'live' ? null : phase.lapsedAt, graceRemainingMs: phase.state === 'grace' ? phase.remainingMs : null,
        hold: containmentHold(work, now)!,
        settleable: phase.state !== 'live' && (assessed?.settleable ?? false),
        refusals: phase.state === 'live' ? [containmentHold(work, now)!] : assessed?.refusals ?? ['Supervisor absence has not been verified on the registered host'],
        host: assessed?.host ?? work.workspaces.find(item => item.epoch === work.containmentQuarantine!.epoch)?.host ?? null,
        scope: work.containmentQuarantine.scope ?? null,
        // Each process the verification found holding the fence, with cmdline and cwd, so the
        // master reads what it would stop before it stops anything.
        held: assessed?.verification?.held ?? [],
        verifiedAt: assessed?.verification?.observedAt ?? null,
        // A refusal is only useful with the path that still works.
        attestation: phase.state === 'live' || assessed?.settleable ? null : containmentAttestation(work.key) }
      : null;
    const seconds = (ms: number) => `${Math.ceil(ms / 1000)}s`;
    const containmentAttention: [string, Parameters<typeof workAttentionOwner>[1]] | null = !quarantine || quarantine.phase === 'live' ? null
      : quarantine.settleable ? [`Containment quarantine from epoch ${quarantine.epoch} is verified settleable; run master settle-containment ${work.key}`, 'containment-settleable']
      : quarantine.phase === 'grace' ? [`Worker lease for epoch ${quarantine.epoch} lapsed at ${quarantine.lapsedAt}; containment grace window has ${seconds(quarantine.graceRemainingMs!)} remaining before supervisor absence can be verified`, 'containment-grace']
      : [`Containment quarantine from epoch ${quarantine.epoch} blocks dispatch: ${quarantine.lapsedAt ? `worker lease lapsed at ${quarantine.lapsedAt}, past the ${seconds(containmentGraceMs)} grace window; ` : ''}${quarantine.refusals[0]}`, 'containment'];
    const gaps = work.proofGaps ?? [];
    const held = scheduling.held.find(entry => entry.key === work.key) ?? null;
    const conflictReport = candidateConflicts.report[work.key];
    const conflicts = work.submission && work.candidate ? { candidates: (conflictReport?.conflicts ?? []).map(conflict => conflict.key), files: conflictReport?.conflicts ?? [], unprobed: conflictReport?.unprobed ?? [], probed: !!conflictReport && candidateConflicts.available } : null;
    const dispatch = describeDispatch(work, reviews, sessions, now);
    const baseRefresh = pendingBaseRefresh(work), baseConflict = baseRefreshConflict(work);
    const refreshCarry = currentBaseRefreshCarry(work);
    const stalledLaunch = [dispatch?.review, ...(dispatch?.producers ?? [])].find(request => request?.failure);
    const retrying = [dispatch?.review, ...(dispatch?.producers ?? [])].find(request => request?.retry && request.session && ['failed', 'expired'].includes(request.session.state));
    const [attention, cause]: [string | null, Parameters<typeof workAttentionOwner>[1] | null] = containmentAttention ? containmentAttention
      : active && (!session || !['working', 'idle'].includes(session.state)) ? [`Assigned worker session is ${session?.state ?? 'offline'}`, 'session']
      : gaps.length ? [`No principal is authorized to produce ${gaps.join(', ')}; grant the proof name before dispatch`, 'proof-gap']
      : review?.exhausted ? [`Every configured reviewer profile is exhausted for the current candidate (${review.failedOver.map(entry => `${entry.profile}: ${entry.exhaustion}`).join(', ')})`, 'reviewer-exhausted']
      : stalledLaunch ? [`Automatic ${stalledLaunch.failure!.kind} launch for ${work.key} refused ${stalledLaunch.failure!.attempts} time(s): ${stalledLaunch.failure!.reason}`, stalledLaunch.failure!.kind === 'review' ? 'launch-review' : 'launch-producer']
      : retrying ? [`${retrying.group ? `Producer session for ${retrying.group} proofs` : 'Reviewer session'} of ${work.key} ${retrying.session!.state} after attempt ${retrying.retry!.attempts} of ${retrying.retry!.limit}: ${retrying.session!.resolution ?? 'no reason recorded'}; ${retrying.retry!.exhausted ? 'no further automatic attempt' : `next attempt at ${retrying.retry!.nextAt}`}`, retrying.group ? 'launch-producer' : 'launch-review']
      : baseConflict ? [baseConflict, 'base-conflict']
      // An item the control plane is bringing onto a moved base is not waiting for anybody. It
      // used to be the commonest attention line on this list — one per open candidate, every
      // merge — and answering it cost a rework round for a change that was a clean fast-forward.
      : baseRefresh && !work.blocker ? [null, null]
      : work.blocker || dwellMs > 3_600_000 ? [first?.reasons[0] ?? `Work has remained at ${work.stage} for more than one hour`, 'gate'] : [null, null];
    const attentionOwner = cause ? workAttentionOwner(work, cause) : null;
    return { key: work.key, title: work.title, stage: work.stage, owner: active ? work.lease!.owner : null, profile: profile?.name ?? null, session: session?.state ?? null, refusal: first ? { gate: first.name, reason: first.reasons[0] } : null, mergeable, review, dispatch, proofGaps: gaps, containment: quarantine, attention, attentionOwner, queue: placement ? queueRows.find(row => row.key === work.key) ?? null : null,
      // What the control plane is doing, or last did, about a base branch that moved under this
      // candidate: nobody is asked for a round while `pending` is set.
      base: baseRefresh || baseConflict || refreshCarry ? { pending: baseRefresh, conflict: baseConflict,
        refreshed: refreshCarry ? { from: refreshCarry.from.sha, head: refreshCarry.to.sha, base: refreshCarry.to.baseSha,
          approval: { carried: refreshCarry.approval.carried, reason: refreshCarry.approval.reason },
          evidence: refreshCarry.evidence.map(entry => ({ proof: entry.proof, carried: entry.carried, reason: entry.reason })) } : null } : null,
      scope: scopeBreadth(work.plannedFiles), overlap: held ? { held: true, ahead: held.ahead, reason: held.reason } : { held: false, ahead: [], reason: null }, conflicts,
      // Execution versus wait so far, rework rounds and hand-offs, from the item's own timeline.
      speed: pipelineSpeed(work, now) };
  });
  const delivered = snapshot.work.filter(work => work.stage === 'done' && work.delivery && deploySmokeRequired(work.policy)).map(work => deliveredRow(work, now, baseBranch));
  // Merge-to-production over every delivery with an observed deployment, whether or not its
  // policy asked for a smoke proof, so the periodic measurement reads one number for the repository.
  const mergeToProduction = latencyPercentiles(snapshot.work.map(work => mergeToProductionMs(work)).filter((value): value is number => value !== null));
  // Submit→merge p50/p90 over every delivery with a recorded submission, judged against the
  // pipeline-speed target; the periodic measurement records this beside the production latency.
  const speed = pipelineSpeedSummary(snapshot.work, now);
  return { observedAt: snapshot.now,
    counts: { open: rows.length, ready: rows.filter(row => row.stage === 'ready').length, active: rows.filter(row => row.owner).length, attention: rows.filter(row => row.attention).length + installation.attention.length, proofAuthorityGaps: rows.filter(row => row.proofGaps.length).length, mergeable: rows.filter(row => row.mergeable).length, reviewsPending: reviews.pending.length, producersPending: sessions.producers.pending.length,
      dispatchRequested: rows.reduce((total, row) => total + (row.dispatch ? (row.dispatch.review ? 1 : 0) + row.dispatch.producers.length : 0), 0), dispatchRunning: rows.reduce((total, row) => total + (row.dispatch ? [row.dispatch.review, ...row.dispatch.producers].filter(request => request?.session?.state === 'pending').length : 0), 0), reviewFailover: rows.filter(row => row.review?.failedOver.length).length, queued: placements.length,
      quarantined: rows.filter(row => row.containment && row.containment.phase !== 'live').length, settleableQuarantines: rows.filter(row => row.containment?.settleable).length,
      awaitingSmoke: delivered.filter(row => row.state === 'awaiting-deployment' || row.state === 'awaiting-smoke').length, postDeployFailures: delivered.filter(row => row.state === 'delivered-with-failure').length },
    // Every attention item with the role that resolves it and the next command, work items first.
    attentionItems: [...rows.flatMap(row => row.attention && row.attentionOwner ? [{ subject: row.key, text: row.attention, ...row.attentionOwner }] : []), ...installation.attentionItems] as AttentionItem[],
    workers: workerSessions, reviews, producers: sessions.producers, work: rows, queue: queueRows, delivered, latency: { mergeToProduction }, speed, controlPlane: installation,
    schedule: scheduling, conflicts: { available: candidateConflicts.available, reason: candidateConflicts.reason, ...sequenceAdvice(rows.filter(row => row.conflicts).map(row => ({ key: row.key, conflicts: row.conflicts!.candidates }))) } };
}

/**
 * The dispatch plan the durable loop and `master dispatch` follow: ready items in the order they
 * would be offered (smallest planned scope first within a priority), the ones held behind a
 * claimed or unmerged item whose planned files they overlap, and the broad scopes that will
 * overlap nearly everything.
 */
export function dispatchSchedule(work: Work[], now: number) {
  const ready = work.filter(item => item.stage !== 'done' && item.ready && !item.blocker && !item.containmentQuarantine && !(item.lease && Date.parse(item.lease.expiresAt) > now) && (!item.submission || item.reworkRequested)).sort(dispatchOrder);
  const held = ready.flatMap(item => { const ahead = dispatchOverlap(item, work, now); return ahead.length ? [{ key: item.key, ahead, reason: `Held by planned-file overlap with ${describeOverlap(ahead)}; dispatch with --allow-overlap to override` }] : []; });
  const heldKeys = new Set(held.map(entry => entry.key));
  return { order: ready.map(item => ({ key: item.key, priority: item.priority, scope: scopeBreadth(item.plannedFiles), held: heldKeys.has(item.key) })), held,
    highConflict: ready.filter(item => scopeBreadth(item.plannedFiles).highConflict).map(item => ({ key: item.key, broad: scopeBreadth(item.plannedFiles).broad })) };
}
/** Fewest conflicts first: the order that forces the fewest re-integration rounds on the rest. */
export function sequenceAdvice(candidates: { key: string; conflicts: string[] }[]) {
  const sequence = [...candidates].sort((a, b) => a.conflicts.length - b.conflicts.length || a.key.localeCompare(b.key)).map(entry => entry.key);
  const conflicting = candidates.filter(entry => entry.conflicts.length);
  return { sequence, conflicting: conflicting.map(entry => ({ key: entry.key, conflicts: entry.conflicts })) };
}

/**
 * The second confidence layer, per delivered item that asked for it: what the release served, what
 * the trusted producer found, and — on a failure — exactly what to roll back. Failures stay listed;
 * nothing here ages out or is cleared by a later delivery.
 */
function deliveredRow(work: Work, now: number, baseBranch: string) {
  const { mergedAt, mergeSha, deployment, smoke } = work.delivery!;
  return { key: work.key, title: work.title, mergedAt, mergeSha, state: deliveryState(work)!,
    deployment: deployment ? { sha: deployment.sha, covers: deployment.covers, source: deployment.source, observedAt: deployment.observedAt } : null,
    smoke: smoke ? { result: smoke.result, sha: smoke.sha, producer: smoke.producer, at: smoke.at, executed: smoke.executed, skipped: smoke.skipped, url: smoke.url ?? null } : null,
    postDeployMs: postDeployMs(work, now), productionLatencyMs: productionLatencyMs(work), mergeToProductionMs: mergeToProductionMs(work), rollback: rollbackGuidance(work, baseBranch) };
}
/** Time from the accepted merge to the observed deployment covering it: merge-to-production latency. */
export function mergeToProductionMs(work: Work): number | null {
  const observedAt = work.delivery?.deployment?.observedAt;
  if (work.stage !== 'done' || !observedAt) return null;
  const value = Date.parse(observedAt) - Date.parse(work.delivery!.mergedAtRepository ?? work.delivery!.mergedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
/** Nearest-rank percentiles over the measured deliveries, for the periodic measurement. */
export function latencyPercentiles(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (percentile: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile / 100) - 1))] : 0;
  return { count: sorted.length, p50Ms: at(50), p90Ms: at(90) };
}

/**
 * One queue entry as the master reads it. `binding` says, per entry, whether its review and each
 * required proof bind the published tip exactly, were carried across a Graphyard-authored tip or a
 * tree-identical base advance, or must be produced afresh — and the recorded reason for each.
 */
function queueRow(placement: QueuePlacement, binding: QueueBindingReport | null) {
  return { key: placement.key, position: placement.position + 1, size: placement.size, predictedBase: placement.predictedBase,
    predictedTip: placement.tip, validated: placement.current, waitMs: placement.waitMs, waitMinutes: Math.floor(placement.waitMs / 60_000),
    enqueuedAt: placement.enqueuedAt, ahead: placement.predecessors, reasons: placement.reasons, binding };
}
export function herdrJson(args: string[], run: (command: string, args: string[]) => string = (command, commandArgs) => execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  const parsed = JSON.parse(run('herdr', args));
  if (parsed.error) throw Object.assign(new Error(`Herdr refused the operation: ${parsed.error.message ?? parsed.error}`), { herdrCode: typeof parsed.error.code === 'string' ? parsed.error.code : undefined });
  return parsed.result ?? parsed;
}
function herdrRun(args: string[], run: (command: string, args: string[]) => string = (command, commandArgs) => execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) { run('herdr', args); }
export function listHerdrAgents(run?: (command: string, args: string[]) => string): HerdrAgent[] { return herdrJson(['agent', 'list'], run).agents ?? []; }
export function observeHerdrAgents(run?: (command: string, args: string[]) => string) {
  try { return { agents: listHerdrAgents(run), available: true, reason: null }; }
  catch { return { agents: [] as HerdrAgent[], available: false, reason: 'Herdr session health is unavailable; Graphyard work state remains authoritative' }; }
}

export function waitForHerdrAgent(target: string, run?: (command: string, args: string[]) => string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let agent: any;
    try {
      const raw = herdrJson(['agent', 'get', target], run);
      agent = raw?.agent ?? raw;
    } catch (error) { lastError = error; }
    if (agent?.agent_status === 'blocked') throw new Error('Launched worker is blocked before it is ready for a prompt');
    if (['idle', 'done'].includes(agent?.agent_status)) return agent as HerdrAgent;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`Launched worker did not become visible in Herdr within ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

export function closeHerdrPane(pane: string, run?: (command: string, args: string[]) => string, timeoutMs = 5_000) {
  herdrJson(['pane', 'close', pane], run);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = herdrJson(['pane', 'list'], run);
    if (!Array.isArray(result.panes)) throw new Error('Herdr did not return a pane inventory after close');
    if (!result.panes.some((candidate: any) => candidate.pane_id === pane)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`Herdr still reports pane ${pane} after close`);
}

export function createdHerdrTab(result: any) {
  const pane = result?.root_pane?.pane_id ?? result?.pane_id ?? result?.pane?.id ?? result?.tab?.pane_id;
  const tab = result?.tab?.tab_id ?? result?.tab_id ?? result?.root_pane?.tab_id;
  if (typeof pane !== 'string' || !pane.trim()) throw Object.assign(new Error('Herdr did not return a valid new pane'), { herdrTab: typeof tab === 'string' && tab.trim() ? tab : undefined });
  return { pane, tab: typeof tab === 'string' && tab.trim() ? tab : undefined };
}

export function stopCreatedHerdrTab(pane: string | undefined, tab: string | undefined, run?: (command: string, args: string[]) => string, timeoutMs = 5_000) {
  if (pane) return closeHerdrPane(pane, run);
  if (!tab) throw new Error('Herdr did not identify the created tab, so cleanup cannot be confirmed');
  herdrJson(['tab', 'close', tab], run);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = herdrJson(['tab', 'list'], run);
    if (!Array.isArray(result.tabs)) throw new Error('Herdr did not return a tab inventory after close');
    if (!result.tabs.some((candidate: any) => candidate.tab_id === tab)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`Herdr still reports tab ${tab} after close`);
}

/**
 * The master's harness rules cover everything the master owns, not only the coordination loop:
 * tuning its own configuration through the CLI's owned fields (`master config` — a direct edit of
 * master.json would reach autoMerge and the credential and identity paths onboarding owns, so it
 * is not granted), restarting and reading the durable loop's exact unit, administering the
 * deployment it verifies, and re-running CI for a candidate. None of these reaches a merge, a
 * verdict, evidence, or a credential; the enforced boundaries are unchanged.
 */
function withMasterOwnedRules(plan: HarnessPlan, config: MasterConfig): HarnessPlan {
  if (plan.harness === 'codex') return { ...plan, manual: `${plan.manual}# The master's own commands reach GitHub, Graphyard, the deployment and its private state beside\n# its credential, so start it with its broadest approval mode (master start codex adds these):\n#   --ask-for-approval never --sandbox workspace-write -c sandbox_workspace_write.network_access=true --add-dir ${JSON.stringify(dirname(config.credentialFile))}\n` };
  if (plan.harness !== 'claude') return plan;
  const workflows = [config.run.proofWorkflow, config.run.smokeWorkflow].filter((name): name is string => !!name);
  const owned: HarnessRule[] = [
    { rule: 'Read(./.graphyard/master.json)', why: 'Read the master configuration the loop runs from: profiles, agent environments, run settings. It holds paths to credentials, never their values. Changing it goes through master config, which writes only the fields the master owns.' },
    { rule: 'Bash(systemctl --user restart graphyard-master.service)', why: 'Restart the durable loop after a configuration or CLI change; it resumes from its persisted cursors. The unit is exact, so no other unit can be named.' },
    { rule: 'Bash(systemctl --user start graphyard-master.service)', why: 'Start the durable loop when master status reports it is not running.' },
    { rule: 'Bash(systemctl --user stop graphyard-master.service)', why: 'Stop the durable loop before an upgrade; nothing is lost, its cursors are persisted before every action.' },
    { rule: 'Bash(systemctl --user status graphyard-master.service)', why: 'Read whether the durable loop is running.' },
    { rule: 'Bash(systemctl --user daemon-reload)', why: 'Reload the loop\'s user unit after it is edited.' },
    { rule: 'Bash(journalctl --user -u graphyard-master.service:*)', why: 'Read the loop\'s launch, failover and refusal log; the unit is pinned to the loop\'s own.' },
    { rule: 'Bash(railway status:*)', why: 'Read which release the deployment serves while verifying a delivery.' },
    { rule: 'Bash(railway logs:*)', why: 'Read deployment logs when a release does not serve a delivery.' },
    { rule: 'Bash(railway deployment:*)', why: 'List deployments and their commits to find the exact release to verify or redeploy.' },
    { rule: 'Bash(railway redeploy:*)', why: 'Redeploy the current release after an infrastructure failure; it builds only what the base branch already holds.' },
    { rule: 'Bash(gh run list:*)', why: 'Find the CI and workflow runs of a candidate or delivery.' },
    { rule: 'Bash(gh run view:*)', why: 'Read a run\'s jobs and logs when a gate reports a failing check.' },
    { rule: 'Bash(gh run watch:*)', why: 'Follow a run the loop is waiting on.' },
    { rule: 'Bash(gh run rerun:*)', why: 'Re-run a flaky or infrastructure-failed run on the same commit; the check still has to pass on that exact head.' },
    ...workflows.map(name => ({ rule: `Bash(gh workflow run ${name}:*)`, why: `Request the configured ${name} workflow by hand, as master run does; the provider runs it with its own trusted secret.` })),
  ];
  return { ...plan, allow: [...plan.allow, ...owned.filter(entry => !plan.allow.some(existing => existing.rule === entry.rule))] };
}

/**
 * Role-scoped harness rules for the sessions the master launches. The master's own rules live in
 * the repository's .claude/settings.local.json, and Claude Code loads that file for every session
 * started anywhere under the repository — assigned worktrees included — so a master deny such as
 * `git push` would otherwise refuse a worker's push to its own branch. Each Claude session the
 * master launches under a repository that carries project settings therefore starts with only the
 * operator's user settings plus its own role file (`--setting-sources user --settings FILE`), and
 * never the master's. Like the master's rules these are a prompt policy, not authority: the
 * lease, the session's own credential and branch protection remain the enforcement.
 */
export type SessionRole = 'worker' | 'reviewer' | 'producer';
export interface SessionHarnessInput { role: SessionRole; kind: string | undefined; cliPath: string; repository: string; baseBranch: string; credentialHome: string; credentialDirectories: string[]; branch?: string; pr?: number }
export function sessionHarnessPlan(input: SessionHarnessInput): HarnessPlan {
  if (input.kind !== 'claude') return { harness: input.kind ?? 'unknown', file: null, allow: [], deny: [], manual: null, note: `${input.kind ?? 'This runtime'} does not load the repository's Claude Code settings, so it inherits no master rule; its own approval configuration applies.` };
  const cli = `node ${input.cliPath}`;
  const secrets: HarnessRule[] = [
    ...[...new Set(input.credentialDirectories)].sort().map(directory => ({ rule: `Read(/${directory}/**)`, why: 'Graphyard credentials live here; the session uses its own through the CLI and never reads their bytes.' })),
    { rule: 'Read(./.graphyard/connection.json)', why: 'Holds an individual Graphyard credential.' },
    { rule: 'Read(./.graphyard/credentials.json)', why: 'Holds local principal credentials.' },
    { rule: 'Read(./.graphyard/github-app.json)', why: 'Holds the control-plane App private key.' },
    { rule: 'Read(**/*.pem)', why: 'App private keys are never read into a session transcript.' },
    { rule: 'Read(**/*.token)', why: 'Token files are never read into a session transcript.' },
    { rule: 'Bash(gh pr merge:*)', why: 'Delivery happens only through the guarded merge.' },
    // Scoped to the merge endpoints, not the word: a reviewer's verdict body often says "merge", and
    // in Claude Code a deny beats the allow for its one review call.
    { rule: 'Bash(gh api *pulls/*/merge*)', why: 'A raw pull-request merge call is an administrative merge bypass.' },
    { rule: 'Bash(gh api *repos/*/merges*)', why: 'A raw branch-merge call is an administrative merge bypass.' },
    { rule: 'Bash(gh api graphql*)', why: 'GraphQL reaches merge and merge-queue mutations; no session needs it.' },
    { rule: 'Bash(agent-browser *)', why: "The operator's browser profile is driven only by the master's recorded flows." },
  ];
  const noVerdict: HarnessRule[] = [
    { rule: 'Bash(gh pr review:*)', why: 'Only the independent reviewer posts a verdict.' },
    { rule: 'Bash(gh api *pulls/*/reviews*)', why: 'Only the independent reviewer posts a verdict.' },
  ];
  const noPush: HarnessRule[] = [
    { rule: 'Bash(git push:*)', why: 'This session implements nothing and pushes nothing.' },
    { rule: 'Bash(git commit:*)', why: 'This session changes nothing in the candidate.' },
    { rule: `Bash(${cli} claim:*)`, why: 'Claiming work would make this principal an implementer.' },
  ];
  let allow: HarnessRule[], deny: HarnessRule[];
  if (input.role === 'worker') {
    if (!input.branch) throw new Error('A worker harness names the assigned branch it may push');
    // The same worker rules installWorkerHarness writes into the worktree, plus the shared secret
    // and verdict denies: loaded through --settings they apply even though the worktree's own
    // settings file is not loaded.
    const worker = workerHarnessPlan({ cliPath: input.cliPath, branch: input.branch, baseBranch: input.baseBranch, credentialHome: input.credentialHome });
    const extra = [...secrets, ...noVerdict, { rule: `Bash(${cli} evidence:*)`, why: 'Implementation workers never submit trusted evidence.' }];
    allow = worker.allow;
    deny = [...worker.deny, ...extra.filter(entry => !worker.deny.some(existing => existing.rule === entry.rule))];
  } else if (input.role === 'reviewer') {
    allow = [
      { rule: 'Bash(gh pr diff:*)', why: 'Read the candidate diff.' },
      { rule: 'Bash(gh pr view:*)', why: 'Read the pull request and poll its mergeability before posting.' },
      ...(input.pr ? [{ rule: `Bash(gh api --method POST repos/${input.repository}/pulls/${input.pr}/reviews*)`, why: 'Post the one verdict this session was launched for; the master itself is denied every review call.' }] : []),
    ];
    deny = [...secrets, ...noPush,
      { rule: `Bash(${cli} evidence:*)`, why: 'A reviewer never submits evidence.' },
      { rule: 'Edit(./**)', why: 'The review session is read-only.' },
      { rule: 'Write(./**)', why: 'The review session is read-only.' },
    ];
  } else {
    allow = [
      { rule: `Bash(${cli} evidence:*)`, why: 'Submit the evidence of the proof group this session was launched for, under its own producer credential.' },
      { rule: `Bash(${cli} status:*)`, why: 'Read the acceptance criteria the proofs establish.' },
      { rule: 'Bash(git fetch:*)', why: 'Fetch the exact head.' },
      { rule: 'Bash(git worktree add:*)', why: 'Check the exact head out in a detached worktree of its own.' },
      { rule: 'Bash(git worktree remove:*)', why: 'Remove that worktree once every proof is submitted.' },
    ];
    deny = [...secrets, ...noPush, ...noVerdict];
  }
  return { harness: 'claude', file: null, allow, deny, manual: null, note: `Role-scoped ${input.role} rules; the session loads these and the operator's user settings, never the repository's project or local settings where the master's rules live.` };
}

/** Where a session's role file lives: beside the ledgers, ignored by Git, never inside a worktree it is launched for. */
export const sessionHarnessFile = (root: string, role: SessionRole, profile: string) => resolve(root, '.graphyard/harness', `${role}-${profile}.json`);
async function repositoryCarriesClaudeSettings(root: string) {
  for (const name of ['settings.json', 'settings.local.json']) {
    try { await lstat(resolve(root, '.claude', name)); return true; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}
/**
 * Writes the role file and returns the runtime arguments that load it instead of the repository's
 * settings. A Claude session under a repository that carries no project settings inherits nothing
 * and is launched with its profile arguments unchanged.
 */
export async function prepareSessionHarness(root: string, config: MasterConfig, input: Omit<SessionHarnessInput, 'cliPath' | 'repository' | 'baseBranch' | 'credentialHome' | 'credentialDirectories'> & { profile: string; credentialFiles?: string[] }) {
  const plan = sessionHarnessPlan({ ...input, cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome: dirname(dirname(config.credentialFile)),
    credentialDirectories: [dirname(config.credentialFile), ...(config.reviewer ? [dirname(config.reviewer.credentialFile)] : []), ...(input.credentialFiles ?? []).map(file => dirname(file))] });
  if (input.kind !== 'claude' || !await repositoryCarriesClaudeSettings(root)) return { plan, file: null, args: [] as string[] };
  const file = sessionHarnessFile(root, input.role, input.profile);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await atomicPrivateText(file, `${JSON.stringify({ permissions: { allow: plan.allow.map(entry => entry.rule), deny: plan.deny.map(entry => entry.rule) } }, null, 2)}\n`);
  return { plan, file, args: ['--setting-sources', 'user', '--settings', file] };
}
export async function startMaster(root: string, kind: WorkerProfile['kind'], agentArgs: string[], agents: HerdrAgent[], run?: (command: string, args: string[]) => string) {
  if (!kind) throw new Error('Choose a supported master agent kind');
  const config = await loadMasterConfig(root);
  if (agents.some(agent => agent.name === config.masterAgentName)) throw new Error(`Master agent ${config.masterAgentName} is already visible in Herdr`);
  // Installation, not operator memory: the harness the master runs under learns the master's own
  // commands before the session starts, so a routine status or review never waits on a keypress.
  const harness = await writeHarnessPermissions(root, masterHarness(root, config, kind), true);
  let pane: string | undefined, tabId: string | undefined;
  try {
    const created = createdHerdrTab(herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root, '--label', `Graphyard master · ${config.repository}`, '--env', 'GRAPHYARD_MASTER=1', '--no-focus'], run));
    pane = created.pane; tabId = created.tab;
    // The master runs with its runtime's broadest approval mode too; the harness rules above, not
    // runtime prompts, say what it may do. Codex's sandbox is widened to the private state the
    // master's own commands write beside its credential.
    const launch = accountLaunch({ kind, approvals: 'auto', agentArgs, environment: {} }, null, { writable: [dirname(config.credentialFile)] });
    herdrJson(['agent', 'start', config.masterAgentName, '--kind', kind, '--pane', created.pane, '--', ...launch.args], run);
    const prompt = `You are the dedicated Graphyard master agent for ${config.repository}. Do not implement product work, claim worker leases, submit evidence, weaken requirements, or bypass gates. Read AGENTS.md, run node ${config.cliPath} master guide, then run node ${config.cliPath} master status. Use Graphyard as assignment and progression truth and Herdr only for session health and control. Route ready work to configured worker profiles, require workers to claim for themselves, preserve handoffs, and invoke routine merge only through graphyard master merge after every exact-candidate gate passes. Act without asking: only goals and priorities, spending money or opening third-party accounts, and issuing credentials to people belong to the human. Create, release, unblock and add requirements with node ${config.cliPath} master create, release, unblock, or requirements; request every other decision with node ${config.cliPath} master decide GY-N ACTION REASON and launch its independent approver with node ${config.cliPath} master approver GY-N DECISION.${config.operatorAgent ? '' : ` Your operator-agent and approver identities are not provisioned yet; report that onboarding must run node ${config.cliPath} master autonomy --admin-token-stdin --apply once.`}`;
    const reviewInstruction = config.reviewer
      ? `Independent review and proof collection start on their own: when a candidate passes the build gate the control plane records a review request and producer requests bound to its exact head, and node ${config.cliPath} master run launches the reviewer identity ${config.reviewer.slug}[bot] and one producer session per proof group for them within 30 seconds. Read the findings, route rework, and merge; never launch reviews or producers by hand, never review a candidate yourself, and never submit evidence. master status shows what is running per candidate and since when, and node ${config.cliPath} master review GY-N is only the recovery path for a refused reviewer launch.`
      : `No reviewer identity is registered yet. Run node ${config.cliPath} master reviewer setup before routing work that needs independent review; once it is registered, master run launches reviews and producers for every submitted head on its own. Never approve a candidate yourself.`;
    const mergeInstruction = config.autoMerge
      ? 'Automatic routine merging is enabled. Use the guarded merge command when all gates pass.'
      : `Automatic merging is disabled, so every merge needs explicit operator approval given by an agent: request it with node ${config.cliPath} master decide GY-N merge REASON and launch the approver; master merge refuses a candidate without an approved merge decision. Never wait on a human for it.`;
    const administrationInstruction = config.browser
      ? `GitHub administration of ${config.repository} is yours: reconcile protection with node ${config.cliPath} master protection --apply, and when only a GitHub page can do it run node ${config.cliPath} master browser app-permissions, installation-accept, or protection, which drive the operator's browser profile ${config.browser.profile} headless, record every step, verify through the API, and append an audit entry. Report a pending sudo code from master status; the operator only approves it on their device. Never ask the operator to click through what those flows cover.`
      : `No browser profile is configured, so App permission updates, installation acceptance, and page-only protection changes still need the operator; ask them to rerun node ${config.cliPath} master init --browser-profile PROFILE so those become yours.`;
    deliverPrompt(config.masterAgentName, `${prompt} ${reviewInstruction} ${administrationInstruction} ${mergeInstruction}`, run, { confirm: 'follow' });
  } catch (error) {
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    if (pane || tabId || malformedTab) try { stopCreatedHerdrTab(pane, tabId ?? malformedTab, run); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Master startup failed'}; Herdr could not confirm cleanup of the created tab`); }
    throw error;
  }
  return { agentName: config.masterAgentName, kind, pane: pane!, status: 'started and prompted', focusChanged: false, harness };
}

type WorkerCommand = (command: string, args: string[], options?: any) => string | Buffer;
type PreparedWorker = { epoch: number; path: string; base: string; branch?: string; dependencies?: SharedDependencies };

export interface DispatchOptions { allowOverlap?: boolean; probe?: EnvironmentProbe; prompt?: PromptDelivery }
export const describeOverlap = (overlap: ReturnType<typeof dispatchOverlap>) => overlap.map(ahead => `${ahead.key} (${ahead.state}, ${ahead.stage}) on ${ahead.paths.join(', ')}`).join('; ');
export function assertDispatchable(work: Work, allWork: Work[], observedAt: string, options: DispatchOptions = {}) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now)) throw new Error('Dispatch requires a valid Graphyard snapshot clock');
  if (!work.ready || work.blocker) throw new Error('Dispatch requires released work without a blocker');
  const hold = containmentHold(work, now);
  if (hold) throw new Error(hold);
  const unfinished = work.dependencies.map(id => allWork.find(item => item.id === id)).filter(dependency => !dependency || dependency.stage !== 'done');
  if (unfinished.length) throw new Error(`Dispatch blocked by unfinished dependencies: ${unfinished.map(dependency => dependency?.key ?? 'unknown').join(', ')}`);
  if (work.lease && Date.parse(work.lease.expiresAt) > now) throw new Error(`Dispatch blocked by active owner ${work.lease.owner}`);
  if (work.submission && !work.reworkRequested) throw new Error('Dispatch requires operator-authorized rework for a submitted item');
  const conflicts = resourceConflicts(work, allWork, now);
  if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map(conflict => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
  // Planned-file overlap is a soft exclusive resource: advisory, with an operator override.
  const overlap = dispatchOverlap(work, allWork, now);
  if (overlap.length && !options.allowOverlap) throw new Error(`Dispatch held by planned-file overlap with ${describeOverlap(overlap)}; whichever lands second re-integrates the other. Wait for it to merge, or pass --allow-overlap to dispatch anyway`);
}

export async function dispatchWork(root: string, work: Work, profile: WorkerProfile, agents: HerdrAgent[], run?: (command: string, args: string[]) => string, allWork: Work[] = [work], prepare: (root: string, key: string, profileName: string) => Promise<PreparedWorker> = prepareWorkerLaunch, release: (root: string, key: string, epoch: number, profileName: string) => Promise<void> = releaseWorkerLaunch, agentTimeoutMs = 30_000, observedAt = new Date().toISOString(), options: DispatchOptions = {}) {
  assertDispatchable(work, allWork, observedAt, options);
  const config = await loadMasterConfig(root);
  let target = agents.find(agent => agent.name === profile.agentName);
  let selected: Awaited<ReturnType<typeof selectAccount>> | undefined, launched: ReturnType<typeof accountLaunch> | undefined, relaunched = 0;
  let harness: Awaited<ReturnType<typeof installWorkerHarness>> | null = null;
  let dependencies: PreparedWorker['dependencies'] | null = null;
  if (profile.mode === 'existing') {
    if (!target) throw new Error('Existing worker is not visible in Herdr');
    throw new Error('Existing sessions are observable but cannot be safely adopted for new work; use a launch profile so Graphyard supervises the agent process');
  } else {
    await readCredentialFile(profile.credentialFile!);
    if (target) throw new Error('Launch profile agent name is already visible in Herdr');
    // The account is chosen before anything is claimed: a profile whose accounts are all logged out
    // or out of quota claims nothing, and the refusal names every account it skipped and why.
    selected = await selectAccount(config, 'worker', profile, { ...options.probe, work: work.key });
    const launch = accountLaunch(profile, selected.account, { writable: [sharedGitDirectory(root)].filter((path): path is string => !!path) });
    launched = launch;
    // A prompt the runtime never accepted closes the session and releases the claim; the launch is
    // then made once more from a fresh claim, rather than leaving an idle session holding the item.
    for (let attempt = 1; ; attempt++) {
      try { ({ target, harness, dependencies } = await launchWorker(root, config, work, profile, launch, run, prepare, release, agentTimeoutMs, options.prompt)); break; }
      catch (error) { if (!(error instanceof PromptNotAcceptedError) || attempt >= 2) throw error; relaunched++; }
    }
  }
  const overlap = dispatchOverlap(work, allWork, Date.parse(observedAt));
  return { work: work.key, profile: profile.name, principal: profile.principal, agentName: profile.agentName, pane: target.pane_id ?? null, approvals: profile.approvals,
    launch: launched?.plan ?? agentLaunchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment), ownership: 'worker launcher claimed and is supervising the agent process', harness, dependencies,
    account: selected?.account ? { environment: selected.account.name, kind: selected.account.kind, quota: selected.health?.quota ?? null, skipped: selected.skipped } : null, relaunched,
    overlap: overlap.length ? { allowed: true, ahead: overlap, note: `Dispatched over a planned-file overlap with ${describeOverlap(overlap)}; expect a sync → review → proof round for whichever lands second` } : null };
}

async function launchWorker(root: string, config: MasterConfig, work: Work, profile: WorkerProfile, launch: ReturnType<typeof accountLaunch>, run: ((command: string, args: string[]) => string) | undefined, prepare: (root: string, key: string, profileName: string) => Promise<PreparedWorker>, release: (root: string, key: string, epoch: number, profileName: string) => Promise<void>, agentTimeoutMs: number, delivery?: PromptDelivery) {
  const prepared = await prepare(root, work.key, profile.name);
  // The worker's own rules go into its worktree before the session starts, so pushing its
  // branch and opening its pull request never wait on a keypress. A failure is reported, not fatal.
  const harness = await installWorkerHarness(config, { ...profile, kind: launch.kind as WorkerProfile['kind'] }, work.key, prepared).catch(error => ({ applied: false, reason: error instanceof Error ? error.message : 'Worker rules could not be written' }));
  const prompt = workerPrompt(config, work, profile, prepared.epoch, prepared.dependencies ?? null);
  // The worker loads its own role rules, never the master's: it may push its assigned branch.
  const sessionHarness = await prepareSessionHarness(root, config, { role: 'worker', kind: launch.kind, profile: profile.name, branch: prepared.branch ?? `graphyard/${work.key.toLowerCase()}-${prepared.epoch}`, credentialFiles: [profile.credentialFile!] });
  let pane: string | undefined, tabId: string | undefined;
  try {
    const tabArgs = ['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', prepared.path, '--label', `${work.key} · ${profile.agentName}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_TOKEN_FILE=${profile.credentialFile}`, '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, '--env', `GRAPHYARD_HERDR_AGENT_KIND=${launch.kind}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'];
    const created = createdHerdrTab(herdrJson(tabArgs, run)); pane = created.pane; tabId = created.tab;
    const supervised = [process.execPath, config.cliPath, 'watch', work.key, String(prepared.epoch), '--', launch.kind!, ...launch.args, ...sessionHarness.args].map(shellQuote).join(' ');
    herdrRun(['pane', 'run', pane, supervised], run);
    waitForHerdrAgent(pane, run, agentTimeoutMs);
    herdrJson(['agent', 'rename', pane, profile.agentName], run);
    deliverPrompt(profile.agentName, prompt, run, delivery);
    return { target: { name: profile.agentName, pane_id: pane, agent_status: 'working', cwd: prepared.path } as HerdrAgent, harness, dependencies: prepared.dependencies ?? null };
  } catch (error) {
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    if (pane || tabId || malformedTab) {
      try { stopCreatedHerdrTab(pane, tabId ?? malformedTab, run); }
      catch { throw new Error(`${error instanceof Error ? error.message : 'Worker launch failed'}; Herdr could not confirm pane shutdown, so Graphyard retained epoch ${prepared.epoch}`); }
    }
    try { await release(root, work.key, prepared.epoch, profile.name); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Worker launch failed'}; the pane was stopped but Graphyard could not release epoch ${prepared.epoch}`); }
    throw error;
  }
}
/**
 * Every launched session decides and acts on its own. The only way out without its result is a
 * recorded blocker that names the exact command that was blocked; a session that stops to ask for
 * confirmation or offers a menu of options is waiting on input, and the loop records it as failed.
 */
export function autonomousSession(outcome: string, blocker: string) {
  return `Decide and act on your own: ${outcome}. Never stop to ask a human for confirmation, never end your turn with a question, and never offer a menu of options to choose from; choose what the criteria and these instructions support and carry it out. `
    + `If a command you need is refused or cannot succeed, ${blocker}, naming the exact command that was blocked and its error, then stop. A session that ends waiting on input is recorded as failed with that reason.`;
}
export function workerPrompt(config: Pick<MasterConfig, 'cliPath'>, work: Pick<Work, 'key' | 'title'>, profile: Pick<WorkerProfile, 'principal'>, epoch: number, dependencies?: Pick<SharedDependencies, 'shared'> | null) {
  // A session that reinstalls dependencies it already has costs the host a gigabyte per attempt,
  // so the launcher says which trees are already there rather than leaving it to be guessed.
  const installed = dependencies?.shared.length ? `The assigned worktree needs no dependency install: ${dependencies.shared.map(entry => `${entry.name} ${entry.how === 'reachable' ? 'already resolves to' : 'is shared with'} the install at ${entry.source}`).join(', ')}, for this exact lockfile. Do not install dependencies again unless you change the lockfile. ` : '';
  return `Implement ${work.key}: ${work.title}. The Graphyard worker launcher has claimed this item under principal ${profile.principal}, created its assigned worktree, and placed this agent under lease supervision. Run node ${config.cliPath} status ${work.key} before editing. Work only in the current assigned worktree, satisfy the stated criteria without weakening them, open a PR, and submit it with complete as your last action: complete ends your lease and the supervisor then stops this session, which is the attempt ending, not lease loss. Stop immediately if the supervisor reports lease loss before you have submitted. Do not submit trusted evidence or merge the PR; the control plane requests the independent review and the proof producers for your exact head as soon as it passes the build gate, so ask nobody to launch them. `
    + installed
    + autonomousSession('implement the item, open the pull request and submit it with complete', `record a blocker with node ${config.cliPath} blocked ${work.key} ${epoch} REASON`);
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function workerEnvironment(config: MasterConfig, profile: WorkerProfile) {
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: profile.credentialFile, GRAPHYARD_HOST_ID: config.hostId };
  delete env.GRAPHYARD_TOKEN; delete env.GRAPHYARD_MASTER_TOKEN; delete env.GRAPHYARD_REQUEST_ID;
  return env;
}
const workerCommand: WorkerCommand = (command, args, options = {}) => execFileSync(command, args, { ...options, encoding: 'utf8', stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'] });

export async function releaseWorkerLaunch(root: string, key: string, epoch: number, profileName: string, run: WorkerCommand = workerCommand) {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  run(process.execPath, [config.cliPath, 'release', key, String(epoch)], { cwd: root, env: workerEnvironment(config, profile) });
}

export async function prepareWorkerLaunch(root: string, key: string, profileName: string, run: WorkerCommand = workerCommand): Promise<PreparedWorker> {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  const detected = await discover(root);
  if (!detected.repository) throw new Error('Worker launcher requires a recognized GitHub origin');
  assertRepository(detected.repository, config.repository);
  const env = workerEnvironment(config, profile);
  run('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${config.baseBranch}:refs/remotes/origin/${config.baseBranch}`], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = String(run('git', ['rev-parse', '--verify', `refs/remotes/origin/${config.baseBranch}`], { cwd: root, env })).trim();
  if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('Worker launcher could not resolve the current managed base branch');
  const claim = JSON.parse(String(run(process.execPath, [config.cliPath, 'claim', key], { cwd: root, env })));
  const claimedEpoch = Number.isSafeInteger(claim.epoch) && claim.epoch > 0 ? claim.epoch as number : null;
  try {
    if (claim.lease?.owner !== profile.principal || claimedEpoch === null) throw new Error('Worker launcher acquired an unexpected assignment identity');
    const workspace = JSON.parse(String(run(process.execPath, [config.cliPath, 'worktree', key, String(claimedEpoch), base], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] })));
    if (!workspace.path || !isAbsolute(workspace.path)) throw new Error('Worker launcher did not receive an assigned workspace');
    // The checkout is the attempt's; the dependency tree does not have to be. Sharing is a
    // convenience for the session that follows, so a refusal is reported, never fatal.
    const dependencies: SharedDependencies = await shareDependencies(root, workspace.path).catch(error => ({ shared: [], skipped: [{ name: dependencyDirectories[0], reason: failureText(error) }] }));
    return { epoch: claimedEpoch, path: workspace.path, base, dependencies, ...(typeof workspace.branch === 'string' && workspace.branch ? { branch: workspace.branch } : {}) };
  } catch (error) {
    if (claimedEpoch !== null) try { run(process.execPath, [config.cliPath, 'release', key, String(claimedEpoch)], { cwd: root, env }); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Workspace preparation failed'}; Graphyard could not release epoch ${claimedEpoch}`); }
    throw error;
  }
}

export function assertMergeCandidate(work: Work, observedAt?: string, executionOwner?: string) {
  const age = observedAt && work.observation ? Date.parse(observedAt) - Date.parse(work.observation.at) : 0;
  const fresh = !observedAt || !!work.observation && Number.isFinite(age) && age >= 0 && age < 120_000;
  const activeMerge = !!observedAt && !!work.mergeExecution && Date.parse(work.mergeExecution.expiresAt) > Date.parse(observedAt);
  const resumable = activeMerge && !!executionOwner && work.mergeExecution!.owner === executionOwner && !work.mergeExecution!.fenced
    && work.mergeExecution!.sha === work.candidate?.sha && work.mergeExecution!.baseSha === work.candidate?.baseSha
    && work.mergeExecution!.policyRevision === work.policyRevision;
  // An unresolved escalation, a standing blocking lead ruling, and trusted
  // evidence whose producer has since implemented the item each refuse delivery
  // in the broker as well as in the gate, so a stale snapshot can never present
  // such an item as selectable.
  if ((activeMerge && !resumable) || !fresh || standingEscalations(work).length || work.leadHold || evidenceIndependenceRefusals(work).length || work.stage !== 'merge' || !work.candidate || !work.mergeAuthorization || work.mergeAuthorization.sha !== work.candidate.sha || work.mergeAuthorization.baseSha !== work.candidate.baseSha || work.mergeAuthorization.policyRevision !== work.policyRevision || work.gates.some(gate => !gate.passed) || work.violations.length) throw new Error(`${work.key} does not have a current all-gates-passing merge authorization`);
  return { key: work.key, revision: work.revision, pr: work.candidate.pr, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision };
}
// Merge order is recomputed from current dependencies and conflicts on every
// batch; registration order carries no authority.
export function currentMergeCandidates(work: Work[], observedAt: string, executionOwner?: string) {
  const observed = Date.parse(observedAt);
  const order = mergeOrder(work, Number.isFinite(observed) ? observed : Date.now());
  const rank = (item: Work) => order.indexOf(item.key) + 1 || Number.MAX_SAFE_INTEGER;
  return work.filter(item => {
    try { assertMergeCandidate(item, observedAt, executionOwner); return true; }
    catch { return false; }
  }).sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}
export async function continueMergeBatch<T extends { key: string }, R>(items: T[], action: (item: T) => Promise<R>) {
  const results: (R | { key: string; result: 'refused'; reason: string })[] = [];
  for (const item of items) {
    try { results.push(await action(item)); }
    catch (error) { results.push({ key: item.key, result: 'refused', reason: error instanceof Error ? error.message : 'Merge attempt failed' }); }
  }
  return results;
}
type MergeExecution = { id: string; owner: string; sha: string; baseSha: string; policyRevision: number; authorizationRevision: number; issuedAt: string; expiresAt: string; verifiedAt?: string; committingAt?: string; clockOffset?: { min: number; max: number }; fenced?: { reason: string; at: string } | null };
export function assertMergeProtection(protection: any, config: MasterConfig, work: Work) {
  const nativeReview = nativeReviewRequired(work.policy);
  const reviews = protection?.required_pull_request_reviews;
  const checks = protection?.required_status_checks;
  // "Require branches to be up to date" cannot coexist with a merge queue: a queued tip is
  // deliberately behind the base branch while the entries ahead of it land. Graphyard replaces that
  // setting with a stronger binding of its own — every landing is a published speculative tip that
  // already contains its validated base, rechecked against the live base tree immediately before
  // the provider call — so it is required to be off rather than left to fail at the merge API.
  if (checks?.strict !== false) throw new Error(`${work.key} managed-branch protection still requires branches to be up to date; the merge queue supersedes that setting and no queued tip can land while it is enabled`);
  const protectedBranch = (!nativeReview || reviews?.required_approving_review_count >= 1 && reviews?.dismiss_stale_reviews === true && reviews?.require_last_push_approval === true)
    && protection?.enforce_admins?.enabled === true && protection?.allow_force_pushes?.enabled !== true && protection?.allow_deletions?.enabled !== true
    && Array.isArray(checks?.checks) && checks.checks.some((check: any) => check?.context === CHECK_NAME && check?.app_id === config.githubAppId);
  if (!protectedBranch) throw new Error(`${work.key} managed-branch protection changed after merge authorization; Graphyard refused the merge`);
}
/**
 * The real head of the managed base branch, read from `refs/heads/<base>`. A pull request's
 * `baseRefOid` is GitHub's cached view of the same ref, refreshed only when the pull request is
 * recomputed (a push to its head), so right after a predecessor merges it still names the
 * pre-merge base and would refuse every follower in the queue. The landing check therefore
 * never reads it: the server-side observation reads the ref (GY-57) and the broker does the same.
 */
export function readBaseTip(repository: string, baseBranch: string, run: (command: string, args: string[]) => string): string {
  const ref = JSON.parse(run('gh', ['api', `repos/${repository}/git/ref/heads/${baseBranch.split('/').map(encodeURIComponent).join('/')}`]));
  const tip = ref?.object?.sha;
  if (ref?.object?.type !== 'commit' || typeof tip !== 'string' || !/^[a-f0-9]{40}$/.test(tip)) throw new Error(`GitHub did not return a readable head for refs/heads/${baseBranch} of ${repository}`);
  return tip;
}
/**
 * The validated commit must still land its tested tree. Only a Graphyard-published speculative tip
 * may land, because publication is what proves the validated commit already contains its base. The
 * base branch must then still be exactly that base, or have advanced only through earlier queue
 * merges, which leave its tree untouched. Any other advance refuses the merge, naming both the
 * real base tip and the validated base with their trees. The base tip is `refs/heads/<base>` as
 * GitHub serves it now, never the pull request's cached `baseRefOid`.
 */
export function assertQueuedLanding(work: Work, authorization: { sha: string; baseSha: string }, baseBranch: string, repository: string, run: (command: string, args: string[]) => string): { baseTip: string; baseTree: string | null } {
  const speculation = work.queue?.speculation;
  if (!speculation || speculation.tip !== authorization.sha || speculation.base !== authorization.baseSha || !speculation.baseTree) throw new Error(`${work.key} has no published merge-queue tip for the authorized commit; the queue is the only path onto the base branch`);
  const baseTip = readBaseTip(repository, baseBranch, run);
  if (baseTip === authorization.baseSha) return { baseTip, baseTree: null };
  const commit = JSON.parse(run('gh', ['api', `repos/${repository}/commits/${baseTip}`]));
  const baseTree = commit?.commit?.tree?.sha;
  if (typeof baseTree !== 'string' || !/^[a-f0-9]{40}$/.test(baseTree)) throw new Error(`GitHub did not return a tree for ${baseBranch} head ${baseTip} of ${repository}`);
  if (baseTree !== speculation.baseTree) throw new Error(`${work.key} base branch ${baseBranch} advanced outside the merge queue: its head ${baseTip} (tree ${baseTree}) is not tree-identical to validated base ${authorization.baseSha} (tree ${speculation.baseTree}); the validated tip would no longer land its tested tree`);
  return { baseTip, baseTree };
}
/** The GitHub review states a re-post decision reads; anything else is a comment, not a verdict. */
const verdictStates = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'];
export type CarriedApprovalRepost = { posted: boolean; reviewId: number | null; reason: string };
/**
 * GitHub dismisses a stale review on any push to the branch, Graphyard's own mechanical tip
 * publication included, and a native review requirement then demands an approval after that
 * push. When the control plane carried the approval of H to its authored tip H', the master
 * re-posts that approval bound to H' — through the reviewer App that approved H, and only that
 * identity; never through the control-plane App — so the provider merge is not refused for a
 * review the record already accepts. A verdict the reviewer has since changed is never replaced.
 */
export async function repostCarriedApproval(config: MasterConfig, work: Work, carried: CarriedApproval, dependencies: {
  run: (command: string, args: string[]) => string;
  mint?: (credentialFile: string, repository: string) => Promise<{ token: string }>;
  fetcher?: typeof fetch;
}): Promise<CarriedApprovalRepost> {
  const candidate = work.candidate!;
  if (carried.provider !== 'github') return { posted: false, reviewId: null, reason: `the carried ${carried.provider} approval needs no native review re-post` };
  const identity = config.reviewer ? `${config.reviewer.slug}[bot]` : null;
  if (!identity || identity.toLowerCase() !== carried.reviewer.toLowerCase()) return { posted: false, reviewId: null, reason: `the approval of ${carried.originalSha.slice(0, 12)} was posted by ${carried.reviewer}, not by the bound reviewer App${identity ? ` ${identity}` : ''}; only the identity that approved it may re-post it, so the provider may still require a fresh native approval` };
  const reviews = JSON.parse(dependencies.run('gh', ['api', '--paginate', `repos/${config.repository}/pulls/${candidate.pr}/reviews`]));
  if (!Array.isArray(reviews)) throw new Error(`GitHub did not return a review list for ${work.key}`);
  const own = reviews.filter((review: any) => String(review?.user?.login ?? '').toLowerCase() === identity.toLowerCase() && verdictStates.includes(review?.state));
  const latest = own.at(-1);
  if (latest?.commit_id === candidate.sha && latest.state === 'APPROVED') return { posted: false, reviewId: Number(latest.id), reason: `${identity} already approved tip ${candidate.sha.slice(0, 12)}` };
  if (latest?.state === 'CHANGES_REQUESTED') throw new Error(`${work.key}: ${identity} requested changes after approving ${carried.originalSha.slice(0, 12)}; the carried approval is not re-posted over a changed verdict`);
  const original = carried.reviewId !== undefined ? own.find((review: any) => Number(review.id) === carried.reviewId) : own.find((review: any) => review.commit_id === carried.originalSha && review.state !== 'CHANGES_REQUESTED');
  if (!original || original.commit_id !== carried.originalSha) throw new Error(`${work.key}: the approval of ${carried.originalSha.slice(0, 12)} by ${identity} is no longer on the pull request; the carried binding cannot be re-posted`);
  const mint = dependencies.mint ?? (async (file: string, repository: string) => {
    const { mintReviewerToken, reviewerCredentialSchema } = await import('./reviewer.js');
    await privateFile(file);
    return mintReviewerToken(reviewerCredentialSchema.parse(JSON.parse(await readFile(file, 'utf8'))), repository, dependencies.fetcher);
  });
  const { token } = await mint(config.reviewer!.credentialFile, config.repository);
  const body = `Graphyard carried this identity's approval of ${carried.originalSha} (review ${carried.reviewId ?? 'n/a'}) to Graphyard-authored merge-queue tip ${candidate.sha}: ${carried.reason}. Re-posted by the reviewer App so branch protection sees the approval after the control plane's own tip publication.`;
  const response = await (dependencies.fetcher ?? fetch)(`https://api.github.com/repos/${config.repository}/pulls/${candidate.pr}/reviews`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ commit_id: candidate.sha, event: 'APPROVE', body }),
  });
  if (!response.ok) throw new Error(`The reviewer App could not re-post the carried approval for ${work.key} (${response.status})`);
  const posted: any = await response.json();
  if (posted?.state !== 'APPROVED' || posted?.commit_id !== candidate.sha || String(posted?.user?.login ?? '').toLowerCase() !== identity.toLowerCase() || !Number.isSafeInteger(posted?.id)) throw new Error(`GitHub did not record the re-posted approval for ${work.key} as ${identity} on ${candidate.sha.slice(0, 12)}`);
  return { posted: true, reviewId: posted.id, reason: `re-posted the carried approval of ${carried.originalSha.slice(0, 12)} as ${identity} on tip ${candidate.sha.slice(0, 12)}` };
}
export function githubProviderDelay(verifiedTime: number, serverDelayMs: number, response: string, providerToDatabaseOffsetMin = 0) {
  const header = /^Date:\s*(.+?)\r?$/gmi.exec(response);
  const githubTime = header ? Date.parse(header[1]) : Number.NaN;
  if (!Number.isFinite(verifiedTime) || !Number.isInteger(serverDelayMs) || serverDelayMs < 0 || !Number.isFinite(githubTime) || !Number.isFinite(providerToDatabaseOffsetMin)) throw new Error('GitHub did not provide a valid server time for merge ordering');
  // GitHub's Date and merged_at values have whole-second precision. Waiting from
  // the lower bound of GitHub's reported second remains conservative when the
  // database clock is ahead of GitHub's clock.
  // Delivery compares the lower bound of GitHub's whole-second merged_at interval,
  // translated into the database clock domain by offset.min.  Therefore the provider
  // clock must cross (database time - offset.min), not merely database time.
  const verifiedBoundary = Math.ceil((verifiedTime - providerToDatabaseOffsetMin + 1) / 1000) * 1000;
  return Math.max(serverDelayMs, verifiedBoundary - githubTime, 0);
}
function recordedVerification(execution: MergeExecution) {
  const verifiedAt = Date.parse(execution.verifiedAt ?? '');
  if (!Number.isFinite(verifiedAt) || !execution.clockOffset) throw Object.assign(new Error('Resumed merge execution carries an incomplete verification record'), { confirmedRefusal: true });
  return { executionId: execution.id, sha: execution.sha, verifiedAt: execution.verifiedAt!, providerDelayMs: providerDelayAfterVerification(verifiedAt, execution.clockOffset), clockOffset: execution.clockOffset };
}
export async function mergeWork(config: MasterConfig, work: Work, freshSnapshot: () => Promise<{ work: Work[]; now: string }>, acquire: (work: Work, authorization: ReturnType<typeof assertMergeCandidate>) => Promise<{ execution: MergeExecution }>, cancel: (work: Work, execution: MergeExecution, reason: string) => Promise<unknown>, verify: (work: Work, execution: MergeExecution) => Promise<{ executionId: string; sha: string; verifiedAt: string; providerDelayMs: number; clockOffset?: { min: number; max: number } }>, run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }), executionOwner?: string, commit?: (work: Work, execution: MergeExecution) => Promise<{ executionId: string; sha: string; committingAt: string }>, repost?: (work: Work, carried: CarriedApproval) => Promise<CarriedApprovalRepost>) {
  const before = await freshSnapshot(); const current = before.work.find(item => item.id === work.id);
  if (!current || current.revision !== work.revision) throw new Error(`${work.key} changed before GitHub verification; retry`);
  const authorization = assertMergeCandidate(current, before.now, executionOwner);
  // Only a recorded provider commit marks an unknown provider outcome: the broker may already
  // have called GitHub, so nothing is retried until observation reconciles the execution. A
  // verified execution that never reached the commit resumes below; the provider was not attempted.
  if (current.mergeExecution?.committingAt) return { key: authorization.key, pr: authorization.pr, sha: authorization.sha, method: config.mergeMethod, result: 'the provider commit was already recorded; Graphyard retained the execution until GitHub reconciles the provider outcome and refuses a new attempt until then' };
  // The pull request answers for its own head, base branch name and state; the base tip is read
  // from the ref itself inside assertQueuedLanding, because `baseRefOid` is a cached value.
  const pr = JSON.parse(run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefName,state,isDraft']));
  if (pr.headRefOid !== authorization.sha || pr.baseRefName !== config.baseBranch || pr.state !== 'OPEN' || pr.isDraft) throw new Error(`${work.key} changed on GitHub before merge`);
  assertQueuedLanding(current, authorization, config.baseBranch, config.repository, run);
  // An approval the control plane carried onto its authored tip is re-posted through the
  // reviewer App before any authority is acquired, so a native review requirement that GitHub
  // re-armed on the tip publication is met by the same identity that gave the approval.
  const carried = carriedApproval(current);
  const reposted = carried && repost ? await repost(current, carried) : null;
  const authorityBudgetStartedAt = performance.now();
  const after = await freshSnapshot(); const latest = after.work.find(item => item.id === work.id);
  if (!latest || latest.revision !== authorization.revision) throw new Error(`${work.key} changed after GitHub verification; retry`);
  const latestAuthorization = assertMergeCandidate(latest, after.now, executionOwner);
  const resumed = latest.mergeExecution && Date.parse(latest.mergeExecution.expiresAt) > Date.parse(after.now) && latest.mergeExecution.owner === executionOwner;
  const granted = resumed ? { execution: latest.mergeExecution } : await acquire(latest, latestAuthorization);
  if (!granted.execution || granted.execution.sha !== authorization.sha || granted.execution.baseSha !== authorization.baseSha || granted.execution.policyRevision !== authorization.policyRevision || !resumed && granted.execution.authorizationRevision !== authorization.revision) throw new Error(`${work.key} received an invalid merge execution authority`);
  const remainingAtSnapshot = Date.parse(granted.execution.expiresAt) - Date.parse(after.now);
  let providerStarted = false; let cancelled = false;
  let verificationStarted = false; let verificationCompleted = false;
  try {
    const lockedPr = JSON.parse(run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefName,state,isDraft']));
    if (lockedPr.headRefOid !== authorization.sha || lockedPr.baseRefName !== config.baseBranch || lockedPr.state !== 'OPEN' || lockedPr.isDraft) throw new Error(`${work.key} changed on GitHub after merge authority was acquired`);
    assertQueuedLanding(latest, authorization, config.baseBranch, config.repository, run);
    const remaining = remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt);
    if (!Number.isFinite(remaining) || remaining <= 90_000) throw new Error(`${work.key} merge execution does not remain valid for the provider timeout; refresh gate inputs and retry`);
    const protection = JSON.parse(run('gh', ['api', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`]));
    assertMergeProtection(protection, config, latest);
    // A broker that stopped between merge-verify and merge-commit resumes here holding a verified
    // execution. The verification is a durable fact of that execution — the record carries its
    // verifiedAt and bounded clock offset — so the resumed attempt rebuilds it rather than asking
    // the engine to verify again, which it refuses, and then runs the same clock wait, pre-commit
    // revalidation, transactional commit and pre-provider checks as a first attempt.
    verificationStarted = true; const verified = granted.execution.verifiedAt ? recordedVerification(granted.execution) : await verify(latest, granted.execution); verificationCompleted = true;
    const verifiedTime = Date.parse(verified.verifiedAt);
    if (verified.executionId !== granted.execution.id || verified.sha !== authorization.sha || !Number.isFinite(verifiedTime) || !Number.isInteger(verified.providerDelayMs) || verified.providerDelayMs < 0 || verified.providerDelayMs > 21_000
      || !verified.clockOffset || !Number.isFinite(verified.clockOffset.min) || !Number.isFinite(verified.clockOffset.max) || verified.clockOffset.min > verified.clockOffset.max || verified.clockOffset.max - verified.clockOffset.min > 20_000) throw new Error(`${work.key} received an invalid final GitHub gate verification`);
    // Delivery attribution accepts a merge only when GitHub's whole-second merged_at interval,
    // translated into the database clock by the verified offset bound, ends before the execution
    // expires. The remaining authority must therefore cover the provider timeout plus that
    // timestamp interval and the accepted offset width, or a slow but successful provider merge
    // just inside the deadline would be permanently classified as unauthorized.
    const providerReserve = 90_000 + 1000 + (verified.clockOffset.max - verified.clockOffset.min);
    const githubClock = run('gh', ['api', '--include', 'rate_limit']);
    const delay = githubProviderDelay(verifiedTime, verified.providerDelayMs, githubClock);
    if (delay > 21_000 || remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt) - delay <= providerReserve) throw new Error('Clock uncertainty leaves insufficient merge authority; refresh and retry');
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const remainingAfterProtection = remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt);
    if (!Number.isFinite(remainingAfterProtection) || remainingAfterProtection <= providerReserve) throw new Error(`${work.key} merge execution no longer has enough time for the provider call after verifying branch protection; retry`);
    // Verification and the provider call are separated by the clock-ordering
    // delay, and a lead escalation or blocking ruling can land inside it. The
    // last thing Graphyard reads before handing the merge to GitHub is the
    // record itself: the execution must still stand unfenced, and every gate
    // must still pass. Pinned inputs are not re-aged here, so this adds a
    // refusal for concerns raised mid-flight without adding a freshness race.
    const settled = await freshSnapshot(); const final = settled.work.find(item => item.id === work.id);
    const execution = final?.mergeExecution;
    if (!final || !execution || execution.id !== granted.execution.id || execution.fenced || Date.parse(execution.expiresAt) <= Date.parse(settled.now))
      throw new Error(`${work.key} merge execution was fenced, cancelled, or expired after final verification: ${execution?.fenced?.reason ?? 'execution is no longer current'}`);
    const refusals = [...standingEscalations(final).map(entry => `Unresolved ${entry.trigger} escalation: ${entry.reason}`),
      ...(final.leadHold ? [`Slice lead ${final.leadHold.leadId} ruled ${final.leadHold.action} under rule ${final.leadHold.ruleId}`] : []),
      ...final.gates.filter(gate => !gate.passed).flatMap(gate => gate.reasons), ...final.violations];
    if (refusals.length || !final.mergeAuthorization || final.mergeAuthorization.sha !== authorization.sha
      || final.mergeAuthorization.baseSha !== authorization.baseSha || final.mergeAuthorization.policyRevision !== authorization.policyRevision
      || final.candidate?.sha !== authorization.sha || final.candidate.baseSha !== authorization.baseSha)
      throw new Error(`${work.key} no longer passes every gate after final verification: ${refusals.join('; ') || 'merge authorization was invalidated'}`);
    if (!commit) throw new Error(`${work.key} merge broker commit callback is unavailable`);
    const committed = await commit(latest, granted.execution);
    const committingTime = Date.parse(committed.committingAt);
    if (committed.executionId !== granted.execution.id || committed.sha !== authorization.sha || !Number.isFinite(committingTime)) throw new Error(`${work.key} received an invalid provider commit authority`);
    // From this transactional boundary onward revocation refuses: the broker has won
    // serialization and must treat any provider error as an unknown merge outcome.
    providerStarted = true;
    // GitHub reports merged_at only to whole-second precision. Cross a provider-clock
    // boundary after the transactional commit so a fast successful merge cannot appear
    // to predate the authority that serialized it against revocation.
    const commitClock = run('gh', ['api', '--include', 'rate_limit']);
    const commitDelay = githubProviderDelay(committingTime, 0, commitClock, verified.clockOffset.min);
    if (commitDelay > 21_000 || remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt) - commitDelay <= providerReserve) throw new Error('Clock uncertainty leaves insufficient committed merge authority; wait for observation or expiry');
    if (commitDelay) await new Promise(resolve => setTimeout(resolve, commitDelay));
    // A suspended broker can resume after its execution expired: reconciliation then
    // clears the execution, the revocation window reopens, and this stale SHA could
    // merge before the asynchronously published GitHub check changes. Revalidate the
    // committed authority and its remaining lifetime immediately before the provider
    // mutation; the mutation is refused on any missing, fenced or expired authority. The base
    // branch is re-read from its ref for the same reason: a base that advanced outside the
    // queue during the wait would land a different tree than the one the tip was tested on.
    assertQueuedLanding(latest, authorization, config.baseBranch, config.repository, run);
    const preProvider = await freshSnapshot();
    const finalExecution = preProvider.work.find(item => item.id === work.id)?.mergeExecution;
    const remainingBeforeProvider = remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt);
    if (!finalExecution || finalExecution.id !== granted.execution.id || !finalExecution.committingAt || finalExecution.fenced
      || finalExecution.sha !== authorization.sha || Date.parse(finalExecution.expiresAt) <= Date.parse(preProvider.now)
      || !Number.isFinite(remainingBeforeProvider) || remainingBeforeProvider <= providerReserve)
      throw new Error(`${work.key} merge execution expired, was fenced or was superseded during the provider clock wait; the provider merge is refused${finalExecution?.fenced ? `: ${finalExecution.fenced.reason}` : ''}`);
    const provider = JSON.parse(run('gh', ['api', '--method', 'PUT', `repos/${config.repository}/pulls/${authorization.pr}/merge`, '-f', `sha=${authorization.sha}`, '-f', `merge_method=${config.mergeMethod}`]));
    if (provider.merged !== true || typeof provider.sha !== 'string') {
      await cancel(latest, granted.execution, provider.message || 'GitHub confirmed that it did not merge the candidate'); cancelled = true;
      throw new Error(provider.message || 'GitHub did not merge the candidate');
    }
  }
  catch (error) {
    if (!providerStarted && verificationStarted && !verificationCompleted && !(error as any)?.confirmedRefusal) throw new Error(`${error instanceof Error ? error.message : 'Final GitHub verification failed'}; the verification outcome is unknown, so Graphyard retained execution ${granted.execution.id} for an idempotent retry`);
    if (!providerStarted) try { await cancel(latest, granted.execution, error instanceof Error ? error.message : 'GitHub merge failed before provider invocation'); }
    catch { throw new Error(`${work.key} GitHub merge failed before provider invocation and Graphyard could not cancel execution ${granted.execution.id}`); }
    if (providerStarted && !cancelled) throw new Error(`${error instanceof Error ? error.message : 'GitHub merge call failed'}; the merge outcome is unknown, so Graphyard retained execution ${granted.execution.id} until observation or expiry`);
    throw error;
  }
  return { key: authorization.key, pr: authorization.pr, sha: authorization.sha, method: config.mergeMethod, result: 'merge requested; Graphyard will mark Done only after observing the merge', ...(reposted ? { carriedApproval: reposted } : {}) };
}

/**
 * One guarded merge attempt, with the idempotency keys that make an interrupted attempt safe to
 * repeat. The interactive command and the durable loop share it so neither can drift into a
 * different merge path.
 */
export function mergeExecutor(config: MasterConfig, snapshot: () => Promise<{ work: Work[]; now: string }>, mutation: (path: string, data: unknown, requestId?: string) => Promise<any>, executionOwner: string, outerRequest: string, run?: (command: string, args: string[]) => string) {
  const stepKey = (item: Work, step: string, executionId = '') => createHash('sha256').update(`${outerRequest}\0master-merge\0${item.id}\0${item.candidate?.sha ?? ''}\0${step}\0${executionId}`).digest('hex');
  return (item: Work) => mergeWork(config, item, snapshot,
    (latest, authorization) => mutation(`work/${latest.id}/merge-acquire`, { expectedRevision: authorization.revision, sha: authorization.sha, baseSha: authorization.baseSha, policyRevision: authorization.policyRevision }, stepKey(latest, 'acquire')),
    (latest, execution, reason) => mutation(`work/${latest.id}/merge-cancel`, { executionId: execution.id, reason }, stepKey(latest, 'cancel', execution.id)),
    (latest, execution) => mutation(`work/${latest.id}/merge-verify`, { executionId: execution.id }, stepKey(latest, 'verify', execution.id)), run, executionOwner,
    (latest, execution) => mutation(`work/${latest.id}/merge-commit`, { executionId: execution.id }, stepKey(latest, 'commit', execution.id)),
    (latest, carried) => repostCarriedApproval(config, latest, carried, { run: run ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 })) }));
}

// ---- Autonomy ----------------------------------------------------------------------------------
// Humans set goals; agents run the loop. Everything a human used to approve is either the master's
// own operator-agent capability (non-weakening intent) or a two-party decision that a separate
// approver agent approves. What stays human is this list, and nothing else.
export const humanOnlyDecisions = ['goals and priorities', 'spending money or opening third-party accounts', 'issuing credentials to people'] as const;
export const masterOperatorCapabilities = ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'policy:review-provider',
  'decision:resolve', 'decision:attest', 'decision:merge', 'decision:rework', 'decision:grant'] as const;
export const approverAgentCapabilities = ['decision:approve'] as const;
const autonomyReason = 'Master autonomy onboarding: agent identities for the master and its independent approver';

/** The two agent identities onboarding provisions, and where their credentials live. */
export function autonomyPlan(config: MasterConfig) {
  const name = config.repository.split('/').at(-1)!.replace(/[^a-zA-Z0-9._-]/g, '-');
  const directory = dirname(config.credentialFile), stem = basename(config.credentialFile, '.token');
  const scope = { repositories: [config.repository], workItems: ['*'] };
  return {
    operatorAgent: { id: config.operatorAgent?.id ?? `graphyard-master-${name}-operator`.slice(0, 100), displayName: `Graphyard master for ${config.repository}`.slice(0, 100), capabilities: [...masterOperatorCapabilities], scope,
      credentialFile: config.operatorAgent?.credentialFile ?? resolve(directory, `${stem}-operator.token`), role: 'Requests two-party decisions and applies non-weakening intent (create, release, unblock, add requirements) alone' },
    approver: { id: config.approver?.id ?? `graphyard-approver-${name}`.slice(0, 100), displayName: `Graphyard approver for ${config.repository}`.slice(0, 100), capabilities: [...approverAgentCapabilities], scope,
      credentialFile: config.approver?.credentialFile ?? resolve(directory, `${stem}-approver.token`), role: 'Approves the master\'s decisions from its own session; never requests, implements, or produces evidence' },
  };
}

/** Rules every master session gets on top of its loop rules: it cannot borrow another identity. */
const autonomyDeny = (credentialHome: string): HarnessRule[] => [
  { rule: 'Bash(*GRAPHYARD_TOKEN_FILE=*)', why: 'The master acts only as its own identities; pointing a command at the approver\'s or a worker\'s credential file would let one agent approve its own decision.' },
  { rule: 'Bash(*GRAPHYARD_APPROVER=*)', why: 'Only a launched approver session carries the approver marker; the master never claims it.' },
  { rule: `Edit(//${credentialHome}/**)`, why: 'Agent credentials are issued by onboarding and rotated through the API, never edited in place.' },
];
export function masterHarness(root: string, config: MasterConfig, harness: string) {
  const credentialHome = dirname(dirname(config.credentialFile));
  const plan = withMasterOwnedRules(masterHarnessPlan({ harness, root, cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome }), config);
  return plan.file ? { ...plan, deny: [...plan.deny, ...autonomyDeny(credentialHome)] } : plan;
}

/**
 * A worker session's own rules, written into its assigned worktree: it runs its item's commands,
 * pushes its assigned branch and opens the pull request without a keypress, and can never push
 * the base branch, force-push, rebase, merge, review, or read a credential.
 */
export function workerHarnessPlan(input: { cliPath: string; branch: string; baseBranch: string; credentialHome: string }): HarnessPlan {
  const cli = `node ${input.cliPath}`;
  const allow: HarnessRule[] = [
    ...['status', 'sync', 'complete', 'blocked', 'heartbeat', 'events', 'diagnose'].map(command => ({ rule: `Bash(${cli} ${command}:*)`, why: `The worker's own ${command} command on its claimed item; the server checks the lease epoch.` })),
    { rule: `Bash(git push origin ${input.branch})`, why: 'Push the assigned branch; Graphyard observes it as the candidate head.' },
    { rule: `Bash(git push -u origin ${input.branch})`, why: 'Publish the assigned branch the first time.' },
    { rule: `Bash(git push origin HEAD:${input.branch})`, why: 'Push the current head to the assigned branch.' },
    { rule: 'Bash(gh pr create:*)', why: 'Open the pull request the worker submits with complete.' },
    { rule: 'Bash(gh pr view:*)', why: 'Read the pull request number and state before submitting.' },
    { rule: 'Bash(gh pr checks:*)', why: 'Read CI results for the worker\'s own candidate.' },
    { rule: `Bash(git merge origin/${input.baseBranch})`, why: 'sync merges the base branch; the worker never rebases.' },
  ];
  const deny: HarnessRule[] = [
    { rule: 'Bash(git push *--force*)', why: 'History on a submitted branch is never rewritten; the review and proofs are bound to its heads.' },
    { rule: 'Bash(git push * -f*)', why: 'Short form of a force push.' },
    { rule: 'Bash(git push *+*)', why: 'A leading + refspec is a force push.' },
    { rule: `Bash(git push *:${input.baseBranch}*)`, why: 'The base branch moves only through the guarded merge.' },
    { rule: `Bash(git push origin ${input.baseBranch}*)`, why: 'The base branch moves only through the guarded merge.' },
    { rule: 'Bash(git rebase:*)', why: 'sync merges the base branch; a rebase would re-resolve files outside the planned files.' },
    { rule: 'Bash(gh pr merge:*)', why: 'Workers never merge; the control plane\'s merge gate decides.' },
    { rule: 'Bash(gh pr review:*)', why: 'Workers never review their own work.' },
    { rule: 'Bash(*GRAPHYARD_TOKEN_FILE=*)', why: 'A worker acts only as its own principal.' },
    { rule: `Read(//${input.credentialHome}/**)`, why: 'Credentials are used through the CLI, never read into a transcript.' },
    { rule: 'Read(**/*.token)', why: 'Token files are never read into a session transcript.' },
  ];
  return { harness: 'claude', file: '.claude/settings.local.json', allow, deny, manual: null, note: 'Worker rules for one assigned worktree: its own commands and its own branch. A harness rule is a prompt policy; branch protection, leases and the merge gate remain the enforcement.' };
}
/** Install the worker rules in a freshly prepared worktree, only where Git already ignores them. */
export async function installWorkerHarness(config: MasterConfig, profile: WorkerProfile, key: string, prepared: PreparedWorker) {
  if (profile.kind !== 'claude') return { applied: false, reason: `No generated worker rules for ${profile.kind}` };
  try { execFileSync('git', ['check-ignore', '--quiet', '--', '.claude/settings.local.json'], { cwd: prepared.path, stdio: 'ignore' }); }
  catch { return { applied: false, reason: 'The worktree does not ignore .claude/settings.local.json, so no rules were written into it' }; }
  const plan = workerHarnessPlan({ cliPath: config.cliPath, branch: `graphyard/${key.toLowerCase()}-${prepared.epoch}`, baseBranch: config.baseBranch, credentialHome: dirname(dirname(config.credentialFile)) });
  const written = await writeHarnessPermissions(prepared.path, plan, true);
  return { applied: written.applied, reason: null, added: written.added.length };
}

type AutonomyFetch = typeof fetch;
async function adminCall(config: MasterConfig, token: string, fetcher: AutonomyFetch, path: string, body?: unknown) {
  const response = await fetcher(`${config.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? 'unknown'}`);
  return result;
}
async function identityHolds(config: MasterConfig, file: string, id: string, fetcher: AutonomyFetch) {
  try { return (await adminCall(config, await readCredentialFile(file), fetcher, 'status')).actor?.id === id; } catch { return false; }
}
/**
 * Onboarding for autonomy: provision (or repair) the master's operator-agent identity and the
 * approver identity, store their credentials beside the coordinator's, record them in the
 * master configuration, and install the master's harness rules. The admin credential is read
 * once from stdin and never stored. Without `apply` it reports the plan and changes nothing.
 */
export async function setupAutonomy(root: string, input: { adminToken?: string; apply: boolean; harness?: string }, fetcher: AutonomyFetch = fetch) {
  const config = await loadMasterConfig(root);
  const plan = autonomyPlan(config);
  const identities = [plan.operatorAgent, plan.approver];
  const describe = identities.map(({ id, capabilities, credentialFile, role }) => ({ id, capabilities, credentialFile, role }));
  if (!input.apply) return { applied: false, identities: describe, humanOnly: humanOnlyDecisions, harness: await writeHarnessPermissions(root, masterHarness(root, config, input.harness ?? 'claude'), false),
    next: 'Rerun with --apply and the admin credential on stdin: graphyard master autonomy --admin-token-stdin --apply' };
  if (!input.adminToken || input.adminToken.length < 32) throw new Error('Autonomy setup needs the admin credential once, on stdin; it is used to provision the agent identities and is never stored');
  const status = await adminCall(config, input.adminToken, fetcher, 'status');
  if (status.actor?.role !== 'admin') throw new Error('Autonomy setup needs the admin credential; it provisions operator-agent identities, which only an admin may create');
  const existing: any[] = await adminCall(config, input.adminToken, fetcher, 'operator-agents');
  const changes: string[] = [];
  for (const identity of identities) {
    const current = existing.find(document => document.id === identity.id);
    if (current?.revokedAt) throw new Error(`${identity.id} was revoked; choose another identity in .graphyard/master.json or restore it through the operator-agent API`);
    const body = { capabilities: identity.capabilities, scope: identity.scope, reason: autonomyReason };
    // Compared as sets: the server stores these in jsonb, which keeps neither key nor entry order.
    const same = (left: string[] = [], right: string[] = []) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
    if (current && (!same(current.capabilities, identity.capabilities) || !same(current.scope?.repositories, identity.scope.repositories) || !same(current.scope?.workItems, identity.scope.workItems))) {
      await adminCall(config, input.adminToken, fetcher, `operator-agents/${encodeURIComponent(identity.id)}/configure`, { expectedRevision: current.revision, ...body });
      changes.push(`${identity.id}: capabilities set to ${identity.capabilities.join(', ')}`);
    }
    if (current && await identityHolds(config, identity.credentialFile, identity.id, fetcher)) continue;
    const token = randomBytes(32).toString('hex');
    if (current) await adminCall(config, input.adminToken, fetcher, `operator-agents/${encodeURIComponent(identity.id)}/rotate`, { token, transitionSeconds: 0, reason: autonomyReason });
    else await adminCall(config, input.adminToken, fetcher, 'operator-agents', { id: identity.id, displayName: identity.displayName, token, ...body });
    await atomicPrivateText(identity.credentialFile, token);
    await assertOutsideWorktrees(root, identity.credentialFile, `${identity.id} credential file`);
    changes.push(`${identity.id}: ${current ? 'credential rotated' : 'provisioned'}`);
  }
  const next = { ...config, operatorAgent: { id: plan.operatorAgent.id, credentialFile: plan.operatorAgent.credentialFile }, approver: { id: plan.approver.id, credentialFile: plan.approver.credentialFile } };
  await atomicPrivateWrite(resolve(await localDirectory(root), 'master.json'), masterConfigSchema.parse(next));
  const harness = await writeHarnessPermissions(root, masterHarness(root, next, input.harness ?? 'claude'), true);
  return { applied: true, identities: describe, changes, humanOnly: humanOnlyDecisions, harness,
    next: 'The master now creates, releases, unblocks and adds requirements with its operator-agent identity, and requests every other decision with graphyard master decide; graphyard master approver GY-N DECISION launches the independent approver session' };
}

export async function agentToken(root: string, config: MasterConfig, which: 'operatorAgent' | 'approver') {
  const identity = config[which];
  if (!identity) throw new Error(`No ${which === 'operatorAgent' ? 'master operator-agent' : 'approver'} identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply`);
  await externalCredential(root, identity.credentialFile, which === 'operatorAgent' ? 'Operator-agent' : 'Approver');
  return readCredentialFile(identity.credentialFile);
}

/**
 * Fill the binding a decision needs from the item's current state, so the master names the
 * decision and its reason and Graphyard supplies the exact revision or candidate it binds to.
 */
export function decisionInput(action: string, work: Work, input: Record<string, unknown>) {
  if (['release', 'unblock', 'resolve'].includes(action)) return { expectedRevision: work.revision, ...input };
  if (action === 'requirements') return { expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies, plannedFiles: work.plannedFiles, exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], ...input };
  if ((action === 'merge' || action === 'attest') && work.candidate) return { sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, ...(action === 'attest' ? { result: 'pass', executed: 1, skipped: 0 } : {}), ...input };
  if (action === 'rework' || action === 'recover') return { previousWorkerStopped: true, ...input };
  return input;
}
/** With automatic merging off, the guarded merge runs only for a candidate an approver agent approved. */
export function approvedMerge(work: Work, decisions: { action: string; state: string; input: any; approvedBy: string | null }[]) {
  return decisions.find(decision => decision.action === 'merge' && decision.state === 'applied' && !!work.candidate
    && decision.input.sha === work.candidate.sha && decision.input.baseSha === work.candidate.baseSha && decision.input.policyRevision === work.policyRevision) ?? null;
}

/**
 * With automatic merging off, an approver agent's merge decision for the exact candidate stands in
 * for the operator: a named item without one is refused, and `--all` keeps only approved ones.
 */
export async function approvedMerges(selected: Work[], decisions: (work: Work) => Promise<{ decisions: Parameters<typeof approvedMerge>[1] }>, single: boolean) {
  const approved: Work[] = [];
  for (const work of selected) {
    if (approvedMerge(work, (await decisions(work)).decisions)) approved.push(work);
    else if (single) throw new Error(`${work.key} has no approved merge decision for its current candidate; request one with graphyard master decide ${work.key} merge REASON`);
  }
  return approved;
}
/**
 * A roster rotation, previewed against the principals the server authenticates now. It may add
 * principals and rotate tokens; it may never drop a live principal or change its role. Tokens
 * are never read into the report.
 */
export function previewPrincipalRotation(live: { id: string; role: string; leases?: string[] }[], proposed: { id: string; role: string }[]) {
  const dropped = live.filter(principal => !proposed.some(next => next.id === principal.id));
  const changed = live.filter(principal => proposed.some(next => next.id === principal.id && next.role !== principal.role));
  const refusals = [...dropped.map(principal => `${principal.id} (${principal.role}${principal.leases?.length ? `, holding ${principal.leases.join(', ')}` : ''}) is live and would be dropped`),
    ...changed.map(principal => `${principal.id} would change role from ${principal.role} to ${proposed.find(next => next.id === principal.id)!.role}`)];
  return { kept: live.filter(principal => !dropped.includes(principal) && !changed.includes(principal)).map(principal => principal.id), added: proposed.filter(next => !live.some(principal => principal.id === next.id)).map(next => `${next.id} (${next.role})`), refusals, applicable: !refusals.length };
}
export async function readProposedRoster(root: string) {
  const file = resolve(root, '.graphyard/credentials.json'); await privateFile(file);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every(entry => typeof entry?.id === 'string' && typeof entry?.role === 'string')) throw new Error('.graphyard/credentials.json must be the principal array the deployment runs with');
  return parsed.map(entry => ({ id: entry.id as string, role: entry.role as string }));
}

/** Stop this host's master loop, if one runs, and start it again detached, logging beside the config. */
export async function restartMasterLoop(root: string, config: MasterConfig, lock: { pid: number; host: string; heartbeatAt: string } | null, options: { timeoutMs?: number } = {}) {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };
  let stopped: number | null = null;
  if (lock && lock.host !== config.hostId && Date.now() - Date.parse(lock.heartbeatAt) < 3 * config.run.intervalSeconds * 1000) throw new Error(`The master loop runs on ${lock.host} (pid ${lock.pid}); restart it on that host`);
  if (lock && lock.host === config.hostId && alive(lock.pid)) {
    process.kill(lock.pid, 'SIGTERM'); stopped = lock.pid;
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (alive(lock.pid)) {
      if (Date.now() > deadline) throw new Error(`Master loop pid ${lock.pid} did not stop within ${Math.round((options.timeoutMs ?? 30_000) / 1000)} seconds; it was not restarted`);
      await new Promise(done => setTimeout(done, 200));
    }
  }
  const log = resolve(await localDirectory(root), 'master-run.log');
  const { openSync } = await import('node:fs'); const { spawn } = await import('node:child_process');
  const output = openSync(log, 'a', 0o600);
  const child = spawn(process.execPath, [config.cliPath, 'master', 'run'], { cwd: root, detached: true, stdio: ['ignore', output, output] });
  child.unref();
  return { stopped, started: child.pid ?? null, log };
}

/**
 * Launch the independent approver session for one decision: its own Herdr tab, its own
 * credential by path, the approver marker, and a prompt to judge — never to implement.
 */
export async function launchApprover(root: string, work: Work, decision: string, kind: NonNullable<WorkerProfile['kind']>, agents: HerdrAgent[], run?: (command: string, args: string[]) => string) {
  const config = await loadMasterConfig(root);
  await agentToken(root, config, 'approver');
  const name = `graphyard-approver-${work.key.toLowerCase()}`;
  if (agents.some(agent => agent.name === name)) throw new Error(`Approver session ${name} is already visible in Herdr; let it finish or close it first`);
  const launch = agentLaunchPlan(kind, 'auto');
  const cli = `node ${config.cliPath}`;
  const prompt = `You are the independent Graphyard approver for ${config.repository}, acting as ${config.approver!.id}. Judge decision ${decision} on ${work.key}: run ${cli} master decisions ${work.key}, read the item with ${cli} status ${work.key}, its pull request and history, and weigh the requester's reason against the item's criteria and the operator's goals. If it is justified, run ${cli} master approve ${work.key} ${decision} "YOUR REASON". If not, do not approve; state the reason in this tab. Never approve a decision you requested, implemented, or produced evidence for; never edit, push, merge, review, or submit evidence. Stop when the decision is judged.`;
  let pane: string | undefined, tabId: string | undefined;
  try {
    const created = createdHerdrTab(herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root, '--label', `Approver · ${work.key}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_TOKEN_FILE=${config.approver!.credentialFile}`, '--env', 'GRAPHYARD_APPROVER=1', '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tabId = created.tab;
    herdrJson(['agent', 'start', name, '--kind', kind, '--pane', created.pane, '--', ...launch.args], run);
    deliverPrompt(name, prompt, run);
  } catch (error) {
    if (pane || tabId) try { stopCreatedHerdrTab(pane, tabId, run); } catch { /* the launch error below is the report */ }
    throw error;
  }
  return { agentName: name, work: work.key, decision, identity: config.approver!.id, pane: pane!, focusChanged: false };
}

export const autonomySubcommands = ['autonomy', 'create', 'release', 'unblock', 'requirements', 'decide', 'decisions', 'approve', 'approver', 'principals', 'restart', 'environments'] as const;
export interface AutonomyDependencies {
  coordinator: (path: string) => Promise<any>;
  readSecret: () => Promise<string>;
  agents: () => HerdrAgent[];
  daemonLock: () => Promise<{ pid: number; host: string; heartbeatAt: string } | null>;
  fetcher?: typeof fetch;
  run?: (command: string, args: string[], options?: any) => string | Buffer;
}
const words = (args: string[]) => args.join(' ').trim();
async function jsonArgument(value: string) { return JSON.parse(value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value); }
/**
 * The autonomy subcommands of `graphyard master`: onboarding the agent identities, the master's
 * own intent commands, two-party decisions, the approver session, roster rotation and the loop
 * restart. Each authenticates as the identity the command belongs to, never as another.
 */
export async function runAutonomyCommand(root: string, config: MasterConfig, id: string, args: string[], deps: AutonomyDependencies) {
  if (!(autonomySubcommands as readonly string[]).includes(id)) throw new Error(`Unknown autonomy command ${id}`);
  const fetcher = deps.fetcher ?? fetch;
  const call = async (token: string, path: string, body?: unknown) => {
    const response = await fetcher(`${config.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': process.env.GRAPHYARD_REQUEST_ID ?? randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
  };
  const operator = () => agentToken(root, config, 'operatorAgent');
  const item = async (key: string | undefined) => {
    if (!key) throw new Error(`Use master ${id} GY-N …`);
    const found = (await deps.coordinator('work-snapshot')).work.find((work: Work) => work.id === key || work.key === key);
    if (!found) throw new Error(`Unknown work item ${key}`); return found as Work;
  };
  const reason = (rest: string[]) => { const text = words(rest); if (!text) throw new Error(`master ${id} needs a REASON; every agent decision is attributable`); return text; };
  if (id === 'environments') {
    // The agent accounts sessions run on: discover or create them, report login and quota, and
    // with --apply generate profiles from the logged-in ones (see setupAgentEnvironments).
    const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const create = (value('--create') ?? '').split(',').filter(Boolean) as EnvironmentKind[];
    if (create.some(kind => !environmentKinds.includes(kind))) throw new Error(`master environments --create takes ${environmentKinds.join(', ')}`);
    return setupAgentEnvironments(root, { directory: value('--directory'), create, apply: args.includes('--apply'), verify: token => call(token, 'status') });
  }
  if (id === 'autonomy') {
    const apply = args.includes('--apply'), harness = args[args.indexOf('--harness') + 1];
    if (apply && !args.includes('--admin-token-stdin')) throw new Error('Use master autonomy --admin-token-stdin --apply so the admin credential is not stored in shell history');
    return setupAutonomy(root, { apply, adminToken: apply ? await deps.readSecret() : undefined, ...(args.includes('--harness') ? { harness } : {}) }, fetcher);
  }
  if (id === 'create') {
    if (!args[0]) throw new Error('Use master create FILE REASON');
    return call(await operator(), 'work', { ...await jsonArgument(`@${args[0]}`), reason: reason(args.slice(1)) });
  }
  if (id === 'release' || id === 'unblock') {
    const work = await item(args[0]);
    return call(await operator(), `work/${work.id}/${id === 'release' ? 'ready' : 'unblock'}`, { expectedRevision: work.revision, reason: reason(args.slice(1)) });
  }
  if (id === 'requirements') {
    const work = await item(args[0]); if (!args[1]) throw new Error('Use master requirements GY-N FILE REASON');
    return call(await operator(), `work/${work.id}/requirements`, { ...decisionInput('requirements', work, await jsonArgument(`@${args[1]}`)), reason: reason(args.slice(2)) });
  }
  if (id === 'decide') {
    const work = await item(args[0]); const action = args[1];
    if (!action) throw new Error('Use master decide GY-N ACTION [JSON|@FILE] REASON');
    const explicit = args[2] && /^[{@]/.test(args[2]);
    const input = explicit ? await jsonArgument(args[2]) : {};
    return call(await operator(), `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason: reason(args.slice(explicit ? 3 : 2)) });
  }
  if (id === 'decisions') return deps.coordinator(`work/${encodeURIComponent((await item(args[0])).id)}/decisions`);
  if (id === 'approve') {
    // The server refuses self-approval; this refuses the master's session before it asks.
    if (process.env.GRAPHYARD_MASTER === '1') throw new Error('The master never approves its own decisions; graphyard master approver GY-N DECISION launches the independent approver session');
    const file = process.env.GRAPHYARD_TOKEN_FILE;
    if (!file) throw new Error('master approve runs in an approver session, which carries its own credential file in GRAPHYARD_TOKEN_FILE');
    const token = await readCredentialFile(file);
    for (const own of [config.credentialFile, config.operatorAgent?.credentialFile]) if (own && token === await readCredentialFile(own).catch(() => null)) throw new Error('That is one of the master\'s own credentials; approvals come from the approver identity');
    const work = await item(args[0]); if (!args[1]) throw new Error('Use master approve GY-N DECISION REASON');
    return call(token, `work/${work.id}/approve`, { decision: args[1], reason: reason(args.slice(2)) });
  }
  if (id === 'approver') {
    const work = await item(args[0]); if (!args[1]) throw new Error('Use master approver GY-N DECISION [AGENT_KIND]');
    const kind = agentKindSchema.parse(args[2] ?? config.reviewers[0]?.kind ?? 'claude');
    return launchApprover(root, work, args[1], kind, deps.agents());
  }
  if (id === 'principals') {
    const live = (await deps.coordinator('principals')).principals;
    const preview = previewPrincipalRotation(live, await readProposedRoster(root));
    if (!args.includes('--apply')) return { ...preview, applied: false, next: preview.applicable ? 'Rerun with --apply to deploy the roster' : 'Restore every live principal in .graphyard/credentials.json; a rotation never drops one' };
    if (!preview.applicable) throw new Error(`Roster rotation refused: ${preview.refusals.join('; ')}`);
    const applier = resolve(root, 'scripts/provision-railway.mjs');
    try { await lstat(applier); } catch { throw new Error('This repository has no roster applier (scripts/provision-railway.mjs); deploy GRAPHYARD_PRINCIPALS with the configured provider'); }
    (deps.run ?? ((command, commandArgs, options) => execFileSync(command, commandArgs, options)))(process.execPath, [applier], { cwd: root, env: { ...process.env, GRAPHYARD_URL: config.url }, stdio: ['ignore', 'inherit', 'inherit'] });
    return { ...preview, applied: true, next: 'Redeploy the service so the roster takes effect, then graphyard master status' };
  }
  return restartMasterLoop(root, config, await deps.daemonLock());
}
