import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { z } from 'zod';
import { assertRepository, discover, localDirectory, saveDiscovery } from './onboarding.js';
import { loadConnection, managedInstructions, serverOrigin } from './repository-setup.js';
import { resourceConflicts } from './coordination.js';
import { mergeOrder } from './delegation.js';
import { launchPlan, masterHarnessPlan, writeHarnessPermissions } from './harness.js';
import { CHECK_NAME, deliveryState, deploySmokeRequired, evidenceIndependenceRefusals, exhaustedReviewerProfiles, nativeReviewRequired, postDeployMs, productionLatencyMs, reviewerProfileFor, reviewProviderOf, rollbackGuidance, standingEscalations, type Work } from './model.js';
import { containmentAttestation, containmentSettlementRefusals, containmentVerificationSchema, type ContainmentVerification } from './quarantine.js';
import { probeSupervisorAbsence } from './supervisor.js';
import { predictQueue, type QueuePlacement } from './merge-queue.js';

const safeEnvironment = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
    .refine(name => !name.startsWith('GRAPHYARD_'), 'GRAPHYARD_ variables are owned by the launcher and cannot be set in a worker profile')
    .refine(name => !/(TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|CREDENTIAL)/.test(name), 'Put secrets in the worker credential file or the agent runtime login, not master profile environment'),
  z.string().min(1).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Profile environment values cannot contain control characters'),
).default({});

export const agentKindSchema = z.enum(['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'maki']);
const profileName = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
// 'auto' installs the runtime's own non-interactive startup contract; 'prompt' keeps the
// runtime's approval prompts and requires a human in the session tab.
const approvalMode = z.enum(['auto', 'prompt']).default('auto');

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
}).strict();
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;

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
}).strict();
export type MasterRun = z.infer<typeof masterRunSchema>;

// The operator's own authenticated browser profile: a Chrome profile name (such as Default) or the
// path of a persistent profile directory. Used only by the enumerated master browser flows.
export const masterBrowserSchema = z.object({
  profile: z.string().trim().min(1).max(500),
  executable: z.string().trim().min(1).max(500).optional(),
}).strict();
export type MasterBrowser = z.infer<typeof masterBrowserSchema>;

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
  run: masterRunSchema.prefault({}),
  // The operator's own authenticated browser profile, used only by master browser flows.
  browser: masterBrowserSchema.optional(),
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

Dispatch only ready work with \`graphyard master dispatch GY-N PROFILE\`. The
worker must claim the item under its own identity and use the assigned worktree.
Treat prompt delivery as an invitation, never as ownership. Use durable handoffs
when an agent, provider account, machine, or context window changes.

Independent review is launched, never performed by the master:
\`graphyard master review GY-N [PROFILE]\` verifies the exact candidate, launches the
bound reviewer identity read-only, and \`master status\` closes that session when the
verdict lands. Never approve a candidate yourself. Reconcile branch protection with
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
that prompt on their device, and decisions the docs mark human-only, are the only
operator interactions left. Never store, export, or reuse the profile's cookies
outside those flows.

Check the automatic-merge preference in master status. When disabled, wait for
explicit operator approval for each merge. Otherwise routine merges may use
\`graphyard master merge --all\`. The command rechecks the
exact current candidate, every configured gate, and GitHub state immediately before
merging. Human gates, stale observations, failures, and changed commits remain
blocking. Never use an administrative merge bypass, edit a candidate, or read a
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
  return Promise.all(worktrees.map(worktree => realpath(worktree)));
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

export async function inspectWorkerCredentials(root: string, profiles: WorkerProfile[]) {
  const health: Record<string, { available: boolean; reason: string | null }> = {};
  for (const profile of profiles) {
    if (profile.mode === 'existing') health[profile.name] = { available: true, reason: null };
    else try { await readWorkerCredential(root, profile.credentialFile!); health[profile.name] = { available: true, reason: null }; }
    catch (error) { health[profile.name] = { available: false, reason: error instanceof Error ? error.message : 'Worker credential is unavailable' }; }
  }
  return health;
}

export async function atomicPrivateWrite(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file); await chmod(file, 0o600);
}
async function atomicPrivateText(file: string, value: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(temporary, value, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); await chmod(file, 0o600);
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
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile, cliPath: resolve(input.cliPath), repository: detected.repository, baseBranch: status.baseBranch, githubAppId: status.githubAppId, hostId: input.hostId ?? previous?.hostId ?? hostname(), herdrWorkspace: input.herdrWorkspace ?? previous?.herdrWorkspace, masterAgentName: previous?.masterAgentName ?? `graphyard-master-${repositoryName}`, autoMerge: input.autoMerge ?? previous?.autoMerge ?? true, mergeMethod: input.mergeMethod ?? previous?.mergeMethod ?? 'merge', workers: previous?.workers ?? [], ...(previous?.reviewer ? { reviewer: previous.reviewer } : {}), reviewers: previous?.reviewers ?? [], run: { ...previous?.run, ...input.run }, ...(input.browser ?? previous?.browser ? { browser: input.browser ?? previous?.browser } : {}) });
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
  return { repository: config.repository, server: config.url, role: status.actor.role, autoMerge: config.autoMerge, workers: config.workers.length, run: config.run, browser: config.browser ?? null, config: '.graphyard/master.json', reviewer: config.reviewer ? `${config.reviewer.slug}[bot]` : null,
    next: config.reviewer ? `Run graphyard master start codex (or another supported agent kind), then add worker and reviewer profiles` : `Run graphyard master reviewer setup to register the independent reviewer identity, then graphyard master start codex (or another supported agent kind) and add worker and reviewer profiles` };
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
    launch: profile.mode === 'launch' ? launchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment) : null };
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
  settleable: boolean; refusals: string[]; attestation: string;
  verification: ContainmentVerification | null;
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
    host: workspace?.host ?? null, workspacePath: workspace?.path ?? null,
    settleable: false, refusals: [], attestation: containmentAttestation(work.key), verification: null,
  };
  if (!quarantine) return { ...assessment, refusals: ['No containment quarantine is recorded for this task'] };
  if (!workspace) return { ...assessment, refusals: [`Epoch ${quarantine.epoch} registered no workspace, so its supervisor has no verifiable host`] };
  if (workspace.host !== options.hostId)
    return { ...assessment, refusals: [`Epoch ${quarantine.epoch} is registered on host ${workspace.host}; automatic verification must run there`] };
  const bounded = (value: number) => Number.isInteger(value) && Math.abs(value) <= 86_400_000;
  if (!bounded(options.clockOffset.min) || !bounded(options.clockOffset.max))
    return { ...assessment, refusals: ['The control-plane clock could not be compared with this host'] };
  const probe = (options.probe ?? probeSupervisorAbsence)({ key: work.key, epoch: quarantine.epoch, workspacePath: workspace.path });
  const verification = containmentVerificationSchema.parse({ ...probe, host: options.hostId, observedAt: (options.localNow ?? new Date()).toISOString(), clockOffset: options.clockOffset });
  const refusals = containmentSettlementRefusals(work, verification, { now: Date.parse(options.observedAt) });
  return { ...assessment, settleable: !refusals.length, refusals, verification };
}
/** Verify every quarantine this host is responsible for, keyed by work id. */
export function assessContainment(work: Work[], options: { hostId: string; observedAt: string; clockOffset: { min: number; max: number }; probe?: typeof probeSupervisorAbsence }) {
  const assessments: Record<string, ContainmentAssessment> = {};
  for (const item of containmentQuarantines(work, options.hostId)) {
    try { assessments[item.id] = verifyContainmentDeath(item, options); }
    catch (error) {
      assessments[item.id] = { key: item.key, id: item.id, epoch: item.containmentQuarantine!.epoch, owner: item.containmentQuarantine!.owner, at: item.containmentQuarantine!.at,
        host: options.hostId, workspacePath: item.workspaces.find(workspace => workspace.epoch === item.containmentQuarantine!.epoch)?.path ?? null,
        settleable: false, refusals: [`Host verification could not be completed: ${error instanceof Error ? error.message : String(error)}`],
        attestation: containmentAttestation(item.key), verification: null };
    }
  }
  return assessments;
}
export function buildMasterStatus(snapshot: { work: Work[]; now: string }, profiles: WorkerProfile[], agents: HerdrAgent[], credentialHealth: Record<string, { available: boolean; reason: string | null }> = {}, containment: Record<string, ContainmentAssessment> = {}, reviews: { pending: any[]; completed: any[] } = { pending: [], completed: [] }, baseBranch = 'main') {
  const now = Date.parse(snapshot.now);
  const sessions = profiles.map(profile => {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    const credential = credentialHealth[profile.name] ?? { available: true, reason: null };
    return { profile: profile.name, principal: profile.principal, agentName: profile.agentName, mode: profile.mode, state: agent?.agent_status ?? 'offline', pane: agent?.pane_id ?? null, cwd: agent?.foreground_cwd ?? agent?.cwd ?? null, contextPercent: agent?.tokens?.agent_watcher_context_pct ? Number(agent.tokens.agent_watcher_context_pct) : null, credential };
  });
  const placements = predictQueue(snapshot.work, now);
  const rows = snapshot.work.filter(work => work.stage !== 'done').map(work => {
    const placement = placements.find(entry => entry.id === work.id) ?? null;
    const active = !!work.lease && Date.parse(work.lease.expiresAt) > now;
    const profile = active ? profiles.find(item => item.principal === work.lease!.owner) : undefined;
    const session = profile ? sessions.find(item => item.profile === profile.name) : undefined;
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
    const quarantine = work.containmentQuarantine
      ? { epoch: work.containmentQuarantine.epoch, owner: work.containmentQuarantine.owner, at: work.containmentQuarantine.at,
        settleable: assessed?.settleable ?? false,
        refusals: assessed?.refusals ?? ['Supervisor absence has not been verified on the registered host'],
        host: assessed?.host ?? work.workspaces.find(item => item.epoch === work.containmentQuarantine!.epoch)?.host ?? null,
        verifiedAt: assessed?.verification?.observedAt ?? null,
        // A refusal is only useful with the path that still works.
        attestation: assessed?.settleable ? null : containmentAttestation(work.key) }
      : null;
    const gaps = work.proofGaps ?? [];
    const attention = quarantine ? quarantine.settleable
      ? `Containment quarantine from epoch ${quarantine.epoch} is verified settleable; run master settle-containment ${work.key}`
      : `Containment quarantine from epoch ${quarantine.epoch} blocks dispatch: ${quarantine.refusals[0]}`
      : active && (!session || !['working', 'idle'].includes(session.state)) ? `Assigned worker session is ${session?.state ?? 'offline'}`
      : gaps.length ? `No principal is authorized to produce ${gaps.join(', ')}; grant the proof name before dispatch`
      : review?.exhausted ? `Every configured reviewer profile is exhausted for the current candidate (${review.failedOver.map(entry => `${entry.profile}: ${entry.exhaustion}`).join(', ')})`
      : work.blocker || dwellMs > 3_600_000 ? first?.reasons[0] ?? `Work has remained at ${work.stage} for more than one hour` : null;
    return { key: work.key, title: work.title, stage: work.stage, owner: active ? work.lease!.owner : null, profile: profile?.name ?? null, session: session?.state ?? null, refusal: first ? { gate: first.name, reason: first.reasons[0] } : null, mergeable, review, proofGaps: gaps, containment: quarantine, attention, queue: placement ? queueRow(placement) : null };
  });
  const delivered = snapshot.work.filter(work => work.stage === 'done' && work.delivery && deploySmokeRequired(work.policy)).map(work => deliveredRow(work, now, baseBranch));
  return { observedAt: snapshot.now,
    counts: { open: rows.length, ready: rows.filter(row => row.stage === 'ready').length, active: rows.filter(row => row.owner).length, attention: rows.filter(row => row.attention).length, proofAuthorityGaps: rows.filter(row => row.proofGaps.length).length, mergeable: rows.filter(row => row.mergeable).length, reviewsPending: reviews.pending.length, reviewFailover: rows.filter(row => row.review?.failedOver.length).length, queued: placements.length,
      quarantined: rows.filter(row => row.containment).length, settleableQuarantines: rows.filter(row => row.containment?.settleable).length,
      awaitingSmoke: delivered.filter(row => row.state === 'awaiting-deployment' || row.state === 'awaiting-smoke').length, postDeployFailures: delivered.filter(row => row.state === 'delivered-with-failure').length },
    workers: sessions, reviews, work: rows, queue: placements.map(queueRow), delivered };
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
    postDeployMs: postDeployMs(work, now), productionLatencyMs: productionLatencyMs(work), rollback: rollbackGuidance(work, baseBranch) };
}

function queueRow(placement: QueuePlacement) {
  return { key: placement.key, position: placement.position + 1, size: placement.size, predictedBase: placement.predictedBase,
    predictedTip: placement.tip, validated: placement.current, waitMs: placement.waitMs, waitMinutes: Math.floor(placement.waitMs / 60_000),
    enqueuedAt: placement.enqueuedAt, ahead: placement.predecessors, reasons: placement.reasons };
}
export function herdrJson(args: string[], run: (command: string, args: string[]) => string = (command, commandArgs) => execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  const parsed = JSON.parse(run('herdr', args));
  if (parsed.error) throw new Error(`Herdr refused the operation: ${parsed.error.message ?? parsed.error}`);
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

export function masterHarness(root: string, config: MasterConfig, harness: string) {
  return masterHarnessPlan({ harness, root, cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome: dirname(dirname(config.credentialFile)) });
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
    herdrJson(['agent', 'start', config.masterAgentName, '--kind', kind, '--pane', created.pane, '--', ...agentArgs], run);
    const prompt = `You are the dedicated Graphyard master agent for ${config.repository}. Do not implement product work, claim worker leases, submit evidence, weaken requirements, or bypass gates. Read AGENTS.md, run node ${config.cliPath} master guide, then run node ${config.cliPath} master status. Use Graphyard as assignment and progression truth and Herdr only for session health and control. Route ready work to configured worker profiles, require workers to claim for themselves, preserve handoffs, surface decisions that need the operator, and invoke routine merge only through graphyard master merge after every exact-candidate gate passes.`;
    const reviewInstruction = config.reviewer
      ? `Independent review runs under your own control: launch it with node ${config.cliPath} master review GY-N and let master status reconcile the verdict and close the session. The reviewer identity is ${config.reviewer.slug}[bot]; never review a candidate yourself.`
      : `No reviewer identity is registered yet. Run node ${config.cliPath} master reviewer setup before routing work that needs independent review, and never approve a candidate yourself.`;
    const mergeInstruction = config.autoMerge
      ? 'Automatic routine merging is enabled. Use the guarded merge command when all gates pass.'
      : 'Automatic merging is disabled. Wait for explicit operator approval for each merge. Do not invoke master merge or master merge --all without that approval; the operator can invoke the guarded command directly.';
    const administrationInstruction = config.browser
      ? `GitHub administration of ${config.repository} is yours: reconcile protection with node ${config.cliPath} master protection --apply, and when only a GitHub page can do it run node ${config.cliPath} master browser app-permissions, installation-accept, or protection, which drive the operator's browser profile ${config.browser.profile} headless, record every step, verify through the API, and append an audit entry. Report a pending sudo code from master status; the operator only approves it on their device. Never ask the operator to click through what those flows cover.`
      : `No browser profile is configured, so App permission updates, installation acceptance, and page-only protection changes still need the operator; ask them to rerun node ${config.cliPath} master init --browser-profile PROFILE so those become yours.`;
    herdrJson(['agent', 'prompt', config.masterAgentName, `${prompt} ${reviewInstruction} ${administrationInstruction} ${mergeInstruction}`], run);
  } catch (error) {
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    if (pane || tabId || malformedTab) try { stopCreatedHerdrTab(pane, tabId ?? malformedTab, run); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Master startup failed'}; Herdr could not confirm cleanup of the created tab`); }
    throw error;
  }
  return { agentName: config.masterAgentName, kind, pane: pane!, status: 'started and prompted', focusChanged: false, harness };
}

type WorkerCommand = (command: string, args: string[], options?: any) => string | Buffer;
type PreparedWorker = { epoch: number; path: string; base: string };

export function assertDispatchable(work: Work, allWork: Work[], observedAt: string) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now)) throw new Error('Dispatch requires a valid Graphyard snapshot clock');
  if (!work.ready || work.blocker) throw new Error('Dispatch requires released work without a blocker');
  if (work.containmentQuarantine) throw new Error(`Dispatch blocked by unverified worker containment from epoch ${work.containmentQuarantine.epoch}`);
  const unfinished = work.dependencies.map(id => allWork.find(item => item.id === id)).filter(dependency => !dependency || dependency.stage !== 'done');
  if (unfinished.length) throw new Error(`Dispatch blocked by unfinished dependencies: ${unfinished.map(dependency => dependency?.key ?? 'unknown').join(', ')}`);
  if (work.lease && Date.parse(work.lease.expiresAt) > now) throw new Error(`Dispatch blocked by active owner ${work.lease.owner}`);
  if (work.submission && !work.reworkRequested) throw new Error('Dispatch requires operator-authorized rework for a submitted item');
  const conflicts = resourceConflicts(work, allWork, now);
  if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map(conflict => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
}

export async function dispatchWork(root: string, work: Work, profile: WorkerProfile, agents: HerdrAgent[], run?: (command: string, args: string[]) => string, allWork: Work[] = [work], prepare: (root: string, key: string, profileName: string) => Promise<PreparedWorker> = prepareWorkerLaunch, release: (root: string, key: string, epoch: number, profileName: string) => Promise<void> = releaseWorkerLaunch, agentTimeoutMs = 30_000, observedAt = new Date().toISOString()) {
  assertDispatchable(work, allWork, observedAt);
  const config = await loadMasterConfig(root);
  let target = agents.find(agent => agent.name === profile.agentName);
  if (profile.mode === 'existing') {
    if (!target) throw new Error('Existing worker is not visible in Herdr');
    throw new Error('Existing sessions are observable but cannot be safely adopted for new work; use a launch profile so Graphyard supervises the agent process');
  } else {
    await readCredentialFile(profile.credentialFile!);
    if (target) throw new Error('Launch profile agent name is already visible in Herdr');
    const prepared = await prepare(root, work.key, profile.name);
    const prompt = `Implement ${work.key}: ${work.title}. The Graphyard worker launcher has claimed this item under principal ${profile.principal}, created its assigned worktree, and placed this agent under lease supervision. Run node ${config.cliPath} status ${work.key} before editing. Work only in the current assigned worktree, satisfy the stated criteria without weakening them, open a PR, and submit it with complete. Stop immediately if the supervisor reports lease loss. Do not submit trusted evidence or merge the PR.`;
    let pane: string | undefined, tabId: string | undefined;
    try {
      const launch = launchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment);
      const tabArgs = ['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', prepared.path, '--label', `${work.key} · ${profile.agentName}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_TOKEN_FILE=${profile.credentialFile}`, '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, '--env', `GRAPHYARD_HERDR_AGENT_KIND=${profile.kind}`, ...Object.entries({ ...launch.environment, ...profile.environment }).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'];
      const created = createdHerdrTab(herdrJson(tabArgs, run)); pane = created.pane; tabId = created.tab;
      const supervised = [process.execPath, config.cliPath, 'watch', work.key, String(prepared.epoch), '--', profile.kind!, ...launch.args].map(shellQuote).join(' ');
      herdrRun(['pane', 'run', pane, supervised], run);
      waitForHerdrAgent(pane, run, agentTimeoutMs);
      herdrJson(['agent', 'rename', pane, profile.agentName], run);
      herdrJson(['agent', 'prompt', profile.agentName, prompt], run);
      target = { name: profile.agentName, pane_id: pane, agent_status: 'idle', cwd: prepared.path };
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
  return { work: work.key, profile: profile.name, principal: profile.principal, agentName: profile.agentName, pane: target.pane_id ?? null, approvals: profile.approvals,
    launch: launchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment), ownership: 'worker launcher claimed and is supervising the agent process' };
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
    return { epoch: claimedEpoch, path: workspace.path, base };
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
type MergeExecution = { id: string; owner: string; sha: string; baseSha: string; policyRevision: number; authorizationRevision: number; issuedAt: string; expiresAt: string; verifiedAt?: string; committingAt?: string; fenced?: { reason: string; at: string } | null };
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
 * The validated commit must still land its tested tree. Only a Graphyard-published speculative tip
 * may land, because publication is what proves the validated commit already contains its base. The
 * base branch must then still be exactly that base, or have advanced only through earlier queue
 * merges, which leave its tree untouched. Any other advance refuses the merge.
 */
export function assertQueuedLanding(work: Work, authorization: { sha: string; baseSha: string }, baseRefOid: string, repository: string, run: (command: string, args: string[]) => string) {
  const speculation = work.queue?.speculation;
  if (!speculation || speculation.tip !== authorization.sha || speculation.base !== authorization.baseSha || !speculation.baseTree) throw new Error(`${work.key} has no published merge-queue tip for the authorized commit; the queue is the only path onto the base branch`);
  if (baseRefOid === authorization.baseSha) return;
  const commit = JSON.parse(run('gh', ['api', `repos/${repository}/commits/${baseRefOid}`]));
  if (commit?.commit?.tree?.sha !== speculation.baseTree) throw new Error(`${work.key} base branch advanced outside the merge queue; the validated tip would no longer land its tested tree`);
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
export async function mergeWork(config: MasterConfig, work: Work, freshSnapshot: () => Promise<{ work: Work[]; now: string }>, acquire: (work: Work, authorization: ReturnType<typeof assertMergeCandidate>) => Promise<{ execution: MergeExecution }>, cancel: (work: Work, execution: MergeExecution, reason: string) => Promise<unknown>, verify: (work: Work, execution: MergeExecution) => Promise<{ executionId: string; sha: string; verifiedAt: string; providerDelayMs: number; clockOffset?: { min: number; max: number } }>, run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }), executionOwner?: string, commit?: (work: Work, execution: MergeExecution) => Promise<{ executionId: string; sha: string; committingAt: string }>) {
  const before = await freshSnapshot(); const current = before.work.find(item => item.id === work.id);
  if (!current || current.revision !== work.revision) throw new Error(`${work.key} changed before GitHub verification; retry`);
  const authorization = assertMergeCandidate(current, before.now, executionOwner);
  if (current.mergeExecution?.verifiedAt) return { key: authorization.key, pr: authorization.pr, sha: authorization.sha, method: config.mergeMethod, result: 'final verification was already committed; Graphyard retained the execution and will reconcile a provider result or let it expire before a new attempt' };
  const pr = JSON.parse(run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefOid,baseRefName,state,isDraft']));
  if (pr.headRefOid !== authorization.sha || pr.baseRefName !== config.baseBranch || pr.state !== 'OPEN' || pr.isDraft) throw new Error(`${work.key} changed on GitHub before merge`);
  assertQueuedLanding(current, authorization, pr.baseRefOid, config.repository, run);
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
    const lockedPr = JSON.parse(run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefOid,baseRefName,state,isDraft']));
    if (lockedPr.headRefOid !== authorization.sha || lockedPr.baseRefName !== config.baseBranch || lockedPr.state !== 'OPEN' || lockedPr.isDraft) throw new Error(`${work.key} changed on GitHub after merge authority was acquired`);
    assertQueuedLanding(latest, authorization, lockedPr.baseRefOid, config.repository, run);
    const remaining = remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt);
    if (!Number.isFinite(remaining) || remaining <= 90_000) throw new Error(`${work.key} merge execution does not remain valid for the provider timeout; refresh gate inputs and retry`);
    const protection = JSON.parse(run('gh', ['api', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`]));
    assertMergeProtection(protection, config, latest);
    verificationStarted = true; const verified = await verify(latest, granted.execution); verificationCompleted = true;
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
    // mutation; the mutation is refused on any missing, fenced or expired authority.
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
  return { key: authorization.key, pr: authorization.pr, sha: authorization.sha, method: config.mergeMethod, result: 'merge requested; Graphyard will mark Done only after observing the merge' };
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
    (latest, execution) => mutation(`work/${latest.id}/merge-commit`, { executionId: execution.id }, stepKey(latest, 'commit', execution.id)));
}
