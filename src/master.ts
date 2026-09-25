import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { childRunner, defaultChildRun, defaultChildTimeoutMs, type BoundChildRun, type ChildRun, type ChildRunOptions } from './child-runner.js';
export { childRunner, defaultChildRun, type ChildRun, type ChildRunOptions } from './child-runner.js';
import { assertSessionName, distinctSessionName, nameForLaunch, sessionName, sessionNameDigestLength, sessionNameField, sessionNameLimit, sessionNameRefusal, SessionNameRefusedError } from './session-name.js';
export { assertSessionName, distinctSessionName, nameForLaunch, sessionName, sessionNameDigestLength, sessionNameDistinguisher, sessionNameDistinguisherLimit, sessionNameLimit, sessionNameRefusal, SessionNameRefusedError, sessionNameRule, suffixedSessionName } from './session-name.js';
import { assertRepository, discover, localDirectory, saveDiscovery } from './onboarding.js';
import { launchAuthorization, loadConnection, managedInstructions, serverOrigin } from './repository-setup.js';
import { broadScopeRefusals, describeChain, dispatchHold, dispatchHoldBoundMs, dispatchOrder, dispatchOverlap, dispatchable, effectiveConcurrency, inFlight, resourceConflicts, scopeBreadth, type DispatchHold } from './coordination.js';
import type { ConflictReport } from './conflicts.js';
import { blockedPath, environmentBlocked, grantWorkerPaths, verifyWorkerSandbox, workerPaths, writablePaths, type SandboxExec } from './worker-sandbox.js';
import { mergeOrder } from './delegation.js';
import { assertLaunchable, assertNoApprovalOptOut, LaunchRefusedError, nonInteractiveLaunch, requestPlaceholder, harnessDecision, launchPlan, masterHarnessPlan, writeHarnessPermissions, type HarnessPlan, type HarnessRule, type RegisteredLaunch } from './harness.js';
import { withAutonomyContract } from './autonomy.js';
import { capacityRetryAt, describeCapacity, standingCapacity, type CapacityAccount, type CapacityRole, type PartialWork } from './model/capacity.js';
import { answerCommand, humanDecisionLabel, openHumanRequests, parkedOnHuman } from './model/human-request.js';
import { automatableProof } from './model/mechanical-proofs.js';
import { CHECK_NAME, carriedApproval, closedHistory, isClosed, escalationTriggers, deliveryState, deploySmokeRequired, describeQueueBinding, evidenceIndependenceRefusals, exhaustedReviewerProfiles, implementerIdentities, nativeReviewRequired, postDeployMs, productionLatencyMs, providerDelayAfterVerification, reviewerProfileFor, reviewProviderOf, rollbackGuidance, standingEscalations, type CarriedApproval, type QueueBindingReport, type Work } from './model.js';
import { containmentAttestation, containmentGraceMs, containmentSettlementRefusals, containmentVerificationSchema, type ContainmentVerification } from './quarantine.js';
import { probeSupervisorAbsence, type SupervisorProbe } from './containment-probe.js';
import { consentHoldAttention, consentHoldMs, detectConsentPrompt, sameConsentPrompt, settingsWarning, writeConsentHold, type ConsentAnswer, type ConsentHold, type ConsentPrompt } from './consent-prompt.js';
import { installLoopSupervisor, loopSupervisionAttention, loopUnitName, unsupervisedInstruction, type LoopSupervisorHost, type LoopSupervisorInstallation } from './supervisor.js';
import { baseRefreshConflict, branchContamination, currentBaseRefreshCarry, currentRestore, pendingBaseRefresh, pendingRestore, predictQueue, refusedReconciliation, restoredApproval, unpublishableEntry, unresolvedThreadRefusal, type QueuePlacement } from './merge-queue.js';
import { MERGE_PROTOCOL } from './protocol-version.js';
import { mergeBaseDismissal, mergeBaseDismissalAttention, missingAncestryReason, missingBaseAncestry } from './merge-base-ancestry.js';
import { attentionLines, type ProductionReport } from './production-watch.js';
import { allocateSessionCheckout, inspectWorktreeRoot, reclaimCommand, removeSessionCheckout, verifyWorktreeRoot, worktreeRoot, worktreeRootBudgetBytes, worktreeRootConcerns, worktreeRootMinFreeBytes, type CheckoutReclaimReport, type FilesystemProbe, type SessionCheckout, type WorktreeRootHealth } from './install/worktree-root.js';
import { pipelineSpeed, pipelineSpeedSummary } from './pipeline-speed.js';
import { fleetRoleHealth, selectFleetSession, type FleetLaunchAccount, type FleetProbe } from './fleet.js';
import type { FleetView } from './model/registry.js';
import { contextFingerprint, escalationAction, followPrecedent, handleEscalation, type EscalationContext } from './model/escalation-context.js';

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
30 seconds, without a keystroke, except that a reviewer launch first waits, up to
\`run.awaitReviewersMinutes\` (default 8, 0 disables) from the request, for the automatic
bot reviewers in \`run.awaitReviewers\` (default the Codex connector) to review the
head, so their findings are judged in the same round; the wait is named in \`master
status\`, and a failed GitHub read, or one unanswered within 5 seconds, launches at once. A head change cancels those
sessions and requests the new head afresh unless the merge queue carried the
approval or the proof. You handle
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

Items are system-driven unless created with \`"systemDriven": false\`: for them
\`graphyard master run\` dispatches, launches review and proof producers, requests
merge decisions and performs the guarded merge, and the master CLI refuses those hand
actions, naming the loop step. The loop drives an item created \`"systemDriven": false\`
the same way; opting out only also allows the hand actions, so check master status
for the loop's pending decision or merge before taking one and never request a second.
Check the automatic-merge preference in master status. When disabled, each merge needs
an approved merge decision, which the loop requests; a hand
\`graphyard master decide GY-N merge\` is only for an opted-out item the loop has not
requested it for, and \`graphyard master merge\` refuses a candidate the approver agent
has not approved. Otherwise opted-out items may also use \`graphyard master merge --all\`. The guarded merge rechecks the exact current
candidate, every configured gate, and GitHub state immediately before merging. Unapproved decisions, stale observations, failures, and
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
    const records = (await defaultChildRun('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root })).split('\0');
    worktrees = records.filter(record => record.startsWith('worktree ')).map(record => resolve(record.slice('worktree '.length)));
  } catch { throw new Error('Cannot verify credential location because the complete Git worktree inventory is unavailable'); }
  if (!worktrees.length) throw new Error('Cannot verify credential location because Git returned an empty worktree inventory');
  // A registered worktree whose path is missing or hidden (a removed proof worktree, or one under
  // a mount this process cannot see) is compared by its registered path: it cannot be resolved,
  // but a target lexically inside it is still refused, and it never stops the loop.
  return Promise.all(worktrees.map(worktree => realpath(worktree).catch(() => worktree)));
}
/**
 * Where a path is, or would be created: a target that does not exist yet is judged by its nearest
 * existing ancestor, so a directory can be refused before anything is written into a worktree.
 */
async function canonicalLocation(target: string) {
  const missing: string[] = [];
  for (let current = resolve(target); ; current = dirname(current)) {
    try { return resolve(await realpath(current), ...missing); }
    catch (error: any) { if (error?.code !== 'ENOENT' || dirname(current) === current) throw error; missing.unshift(basename(current)); }
  }
}
export async function assertOutsideWorktrees(root: string, target: string, label: string, options: { create?: boolean } = {}) {
  const canonicalTarget = options.create ? await canonicalLocation(target) : await realpath(target);
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
  // A profile that names no accounts can still be held by an exhaustion one of its own sessions
  // reported (GY-89), so the log is read for those too; only a named account needs the configuration.
  const named = profiles.some(profile => profile.accounts?.length);
  let config: MasterConfig;
  try { config = await readMasterConfig(root); } catch (error) { if (named) throw error; return health; }
  return inspectProfileAccounts(config, role, profiles, health, probe);
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

export async function setupMaster(root: string, input: { url: string; token: string; cliPath: string; hostId?: string; herdrWorkspace?: string; credentialDirectory?: string; autoMerge?: boolean; mergeMethod?: 'merge' | 'squash' | 'rebase'; run?: Partial<MasterRun>; browser?: MasterBrowser;
  /** Install the loop's supervisor (GY-114). Explicit, never implied: only `master init` passes it. */
  installSupervisor?: boolean;
  /** Replace an installed unit that runs a different loop; `master init --replace-supervisor`. */
  replaceSupervisor?: boolean }, fetcher: typeof fetch = fetch, dependencies: { probe?: FilesystemProbe; supervisorHost?: LoopSupervisorHost } = {}) {
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
  // The managed worktree root is verified before anything is written. Every proof and review
  // checkout is created under it, so a root inside a worktree, on a tmpfs, or on a volume without
  // the configured room is refused here, with the reason, rather than found out mid-proof.
  const managedRoot = worktreeRoot(root, { repository: detected.repository, run: { ...previous?.run, ...input.run } });
  await assertOutsideWorktrees(root, managedRoot, 'The managed worktree root', { create: true });
  const verifiedRoot = await verifyWorktreeRoot(managedRoot, { minFreeBytes: worktreeRootMinFreeBytes({ run: { ...previous?.run, ...input.run } }), probe: dependencies.probe });
  const requestedCredentialDirectory = resolve(input.credentialDirectory ?? process.env.GRAPHYARD_CONFIG_HOME ?? resolve(homedir(), '.config/graphyard'), 'masters');
  if (requestedCredentialDirectory === resolve(root) || requestedCredentialDirectory.startsWith(`${resolve(root)}/`)) throw new Error('Coordinator credentials must be stored outside the managed repository');
  await mkdir(requestedCredentialDirectory, { recursive: true, mode: 0o700 });
  const credentialDirectory = await realpath(requestedCredentialDirectory);
  await assertOutsideWorktrees(root, credentialDirectory, 'Coordinator credential directory');
  const identity = createHash('sha256').update(`${url}\0${detected.repository}`).digest('hex').slice(0, 20);
  const credentialFile = resolve(credentialDirectory, `${identity}.token`);
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile, cliPath: resolve(input.cliPath), repository: detected.repository, baseBranch: status.baseBranch, githubAppId: status.githubAppId, hostId: input.hostId ?? previous?.hostId ?? hostname(), herdrWorkspace: input.herdrWorkspace ?? previous?.herdrWorkspace, masterAgentName: previous?.masterAgentName ?? sessionName('graphyard-master', repositoryName), autoMerge: input.autoMerge ?? previous?.autoMerge ?? true, mergeMethod: input.mergeMethod ?? previous?.mergeMethod ?? 'merge', workers: previous?.workers ?? [], ...(previous?.reviewer ? { reviewer: previous.reviewer } : {}), reviewers: previous?.reviewers ?? [], producers: previous?.producers ?? [], run: { ...previous?.run, ...input.run }, ...(input.browser ?? previous?.browser ? { browser: input.browser ?? previous?.browser } : {}) });
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
  /**
   * The loop's supervisor is installed here, by setup, rather than left to a guide somebody may
   * follow end to end and still finish with an unsupervised loop (GY-114). The unit is written
   * from this installation's own checkout, launcher and interval, enabled so it returns after a
   * reboot, and started now; a second run of setup finds the same content and changes nothing.
   *
   * A host that cannot be given one is told so, with what its operator must run instead. Neither
   * outcome fails setup: the configuration is already written, and an install that refused here
   * would leave the master with no configuration at all rather than with an honest gap.
   *
   * Installing it is an explicit operator action and never a side effect: it happens only when
   * the caller passed `installSupervisor: true`, which `master init` does and nothing else — not
   * a library caller that omitted the option, not the test suite, not a worker, reviewer or
   * producer checkout. The installer itself refuses, by name, a WorkingDirectory that is not this
   * configured coordinator checkout on a durable path, an installed unit that runs a different
   * loop unless `replaceSupervisor` was passed, and any test-suite reach outside the temporary
   * directory. A refusal is reported like every other outcome and never fails setup.
   * `master status` verifies supervision on the host itself either way.
   */
  const supervisor: LoopSupervisorInstallation | null = input.installSupervisor === true ? await installLoopSupervisor(
    { root, cliPath: config.cliPath, repository: config.repository, intervalSeconds: config.run.intervalSeconds }, dependencies.supervisorHost ?? {}, { replace: input.replaceSupervisor === true },
  ).catch(error => ({ supported: false, unit: loopUnitName, unitPath: null, installed: false, enabled: null, active: null, linger: null, wrote: 'none' as const, refused: null, performed: [],
    reason: `Installing the loop's supervisor failed: ${error instanceof Error ? error.message : String(error)}`,
    instruction: unsupervisedInstruction({ root, cliPath: config.cliPath }) })) : null;
  // A permission the installed App lacks is announced here with its exact migration steps, not
  // discovered later as a 403 loop. It never blocks setup: master status keeps reporting it.
  const { attention, appPermissions, delegationLimits, production } = controlPlaneAttention(status);
  // A loop nothing restarts is an installation fact like any other, so it is stated where the rest
  // are — in the same words `master status` will keep using — rather than left for whoever
  // eventually notices the silence. A refused install is stated with what the operator runs.
  const supervision = !supervisor ? [] : supervisor.wrote === 'refused' ? [`${supervisor.reason}: ${supervisor.instruction}`] : loopSupervisionAttention(supervisor).map(gap => `${gap.text}: ${gap.next}`);
  attention.push(...supervision);
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
    worktreeRoot: { path: verifiedRoot.path, freeBytes: verifiedRoot.freeBytes, minFreeBytes: verifiedRoot.minFreeBytes, configured: !!config.run.worktreeRoot },
    agentEnvironments: { directory: environmentDirectory, discovered: environments },
    // What setup installed for the loop, in the words of the commands it ran.
    supervisor: supervisor ? { supported: supervisor.supported, unit: supervisor.unit, unitPath: supervisor.unitPath, installed: supervisor.installed, enabled: supervisor.enabled,
      active: supervisor.active, linger: supervisor.linger, state: supervisor.wrote, refused: supervisor.refused, performed: supervisor.performed, reason: supervisor.reason, instruction: supervisor.instruction } : null,
    next: `${supervision.length ? `${supervision[0]}. Then ${remedy ? `${remedy}, then ${start}` : start}` : remedy ? `${remedy}, then ${start}` : start[0].toUpperCase() + start.slice(1)}; give the master its agent identities once with graphyard master autonomy --admin-token-stdin --apply` };
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
 * answers first, the producer session budget, how long a reviewer launch waits for bot reviews,
 * the quota ceiling, and a profile's account order.
 * Everything else — autoMerge, the merge method, server and repository binding, credential and
 * identity paths, the environment inventory — is onboarding's or the operator's: no CLI path
 * writes it, and the master's harness grants no direct edit of master.json, so flipping autoMerge
 * or re-pointing a credential can never be a routine master action.
 */
export const masterOwnedRunFields = ['intervalSeconds', 'dispatchIntervalSeconds', 'proofWorkflow', 'smokeWorkflow', 'deploymentUrl', 'deploymentShaField', 'productionEnvironment', 'reviewerProfile', 'producerTimeoutMinutes', 'awaitReviewersMinutes', 'acknowledgementSeconds', 'quotaCeilingPercent'] as const;
const masterClearableRunFields = ['proofWorkflow', 'smokeWorkflow', 'deploymentUrl', 'productionEnvironment', 'reviewerProfile', 'awaitReviewersMinutes', 'quotaCeilingPercent'] as const;
export interface MasterOwnedSettings {
  intervalSeconds?: number | null; dispatchIntervalSeconds?: number | null; proofWorkflow?: string | null; smokeWorkflow?: string | null;
  deploymentUrl?: string | null; deploymentShaField?: string | null; productionEnvironment?: string | null; reviewerProfile?: string | null; producerTimeoutMinutes?: number | null; awaitReviewersMinutes?: number | null; acknowledgementSeconds?: number | null; quotaCeilingPercent?: number | null;
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
/**
 * Why a launch passed an account over. Only `exhausted` — a quota read as spent, or one a session
 * itself reported — is the provider's capacity and waits for a reset. A logged-out account or a
 * name that is not a configured environment is something a master fixes in one command, so it must
 * keep reading as a launch that went wrong rather than as a wait (GY-89).
 */
export type AccountSkipCause = 'exhausted' | 'logged-out' | 'unconfigured';
export interface AccountSkip { at: string; role: LaunchRole; profile: string; environment: string; reason: string; work: string | null; cause: AccountSkipCause }
/** Every account of a profile was skipped: the caller fails over to its next profile, or reports the skips. */
export class NoHealthyAccountError extends Error {
  /** Fail over to the next profile: true for every reason an account was passed over. */
  readonly accountsExhausted = true;
  /** This profile has no capacity left: true only when every account it skipped was spent. */
  readonly capacityExhausted: boolean;
  constructor(message: string, readonly skipped: AccountSkip[]) {
    super(message);
    this.capacityExhausted = skipped.length > 0 && skipped.every(skip => skip.cause === 'exhausted');
  }
}

// What the launch loop last observed about each environment, and the recent launches it skipped
// away from and why, kept beside the coordinator's other private state so master status can say it.
const environmentLogSchema = z.object({
  version: z.literal(1),
  environments: z.record(z.string(), z.any()).default({}),
  skipped: z.array(z.object({ at: z.string(), role: z.enum(['worker', 'reviewer', 'producer']), profile: z.string(), environment: z.string(), reason: z.string().max(500), work: z.string().nullable(),
    // Logs written before GY-89 carry no cause; they read as the exhaustion the flag then meant.
    cause: z.enum(['exhausted', 'logged-out', 'unconfigured']).default('exhausted') }).strict()).max(50).default([]),
  // Accounts a session exhausted mid-work (GY-89), by environment name, each held until its reset.
  // The account each profile's latest launch selected, by `role:profile`, so an exhausted session can be traced to its account.
  selected: z.record(z.string(), z.object({ environment: z.string().nullable(), kind: z.string().nullable(), at: z.string(), work: z.string().nullable() }).strict()).default({}),
  exhausted: z.record(z.string(), z.object({ at: z.string(), until: z.string(), resetsAt: z.string().nullable(), reason: z.string().max(500), role: z.enum(['worker', 'reviewer', 'producer']), profile: z.string(), work: z.string().nullable() }).strict()).default({}),
}).strict();
/**
 * An account a running session exhausted. The provider's own usage endpoint may lag behind the
 * session that hit the limit, and OpenCode and Cursor expose no quota to read at all, so what a
 * session printed is kept here and every launch skips the account until `until`: the reset time
 * the notice named, or an hour when it named none.
 */
export interface ObservedExhaustion { at: string; until: string; resetsAt: string | null; reason: string; role: LaunchRole; profile: string; work: string | null }
export const unknownResetHoldMs = 3_600_000;
export interface AccountSelection { environment: string | null; kind: string | null; at: string; work: string | null }
export type EnvironmentLog = { version: 1; environments: Record<string, EnvironmentHealth>; skipped: AccountSkip[]; selected: Record<string, AccountSelection>; exhausted: Record<string, ObservedExhaustion> };
/** A profile that names no accounts launches on whatever its own environment selects; its exhaustion is held under this name. */
export const profileAccount = (profile: string) => `profile:${profile}`;
export const selectionKey = (role: LaunchRole, profile: string) => `${role}:${profile}`;
export function environmentLogPath(config: Pick<MasterConfig, 'credentialFile'>) {
  return resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.environments.json`);
}
export async function readEnvironmentLog(config: Pick<MasterConfig, 'credentialFile'>): Promise<EnvironmentLog> {
  try { return environmentLogSchema.parse(JSON.parse(await readFile(environmentLogPath(config), 'utf8'))) as EnvironmentLog; }
  catch { return { version: 1, environments: {}, skipped: [], selected: {}, exhausted: {} }; }
}
/** Record that a session exhausted `environment` mid-work, so no launch selects it before it resets. */
export async function recordObservedExhaustion(config: Pick<MasterConfig, 'credentialFile'>, environment: string, observed: Omit<ObservedExhaustion, 'until'>, now = Date.now()) {
  const log = await readEnvironmentLog(config);
  const reset = observed.resetsAt ? Date.parse(observed.resetsAt) : Number.NaN;
  const entry: ObservedExhaustion = { ...observed, reason: observed.reason.slice(0, 500), until: new Date(Number.isFinite(reset) && reset > now ? reset : now + unknownResetHoldMs).toISOString() };
  log.exhausted = { ...Object.fromEntries(Object.entries(log.exhausted).filter(([, held]) => Date.parse(held.until) > now)), [environment]: entry };
  await atomicPrivateWrite(environmentLogPath(config), log);
  return entry;
}
/** The accounts still held by an observed exhaustion at `now`. */
export async function observedExhaustions(config: Pick<MasterConfig, 'credentialFile'>, now = Date.now()): Promise<Record<string, ObservedExhaustion>> {
  const log = await readEnvironmentLog(config);
  return Object.fromEntries(Object.entries(log.exhausted ?? {}).filter(([, held]) => Date.parse(held.until) > now));
}
export const describeObservedExhaustion = (environment: string, held: ObservedExhaustion) =>
  `${environment} exhausted its quota mid-session at ${held.at} (${held.reason}); ${held.resetsAt ? `it resets ${held.resetsAt}` : `its reset time is unknown, so it is tried again after ${held.until}`}`;
export async function recordEnvironmentLog(config: Pick<MasterConfig, 'credentialFile'>, health: EnvironmentHealth[], skipped: AccountSkip[] = [], selection?: { key: string } & AccountSelection) {
  if (!health.length && !skipped.length && !selection) return;
  const log = await readEnvironmentLog(config);
  if (selection) { const { key, ...selected } = selection; log.selected = { ...log.selected, [key]: selected }; }
  for (const entry of health) log.environments[entry.name] = entry;
  log.skipped = [...log.skipped, ...skipped.map(entry => ({ ...entry, reason: entry.reason.slice(0, 500) }))].slice(-50);
  await atomicPrivateWrite(environmentLogPath(config), log);
}

/**
 * The account a launch runs on: the first of the profile's accounts that is logged in with quota
 * left. Every account passed over is recorded with its reason. A profile that names no accounts
 * launches exactly as configured, on whatever its environment variables select.
 *
 * When the control plane's agent registry defines the role, the registry decides instead: the
 * control plane chooses the first eligible account of the role — placed on this host, logged in,
 * within quota, under its session and concurrency limits — and records the choice and its reason
 * (see fleet.ts). The profile then supplies only the Graphyard identity the session acts under.
 * A role the registry does not define yet launches from the profile's own accounts, as before.
 */
export type LaunchAccount = AgentEnvironment | FleetLaunchAccount;
export interface LaunchSelection { account: LaunchAccount | null; health: EnvironmentHealth | null; skipped: AccountSkip[]; /** Gives a registry session back when the launch it was chosen for failed. */ release?: (reason: string) => Promise<void> }
export async function selectAccount(config: Pick<MasterConfig, 'environments' | 'credentialFile' | 'run'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>, role: LaunchRole, profile: { name: string; accounts?: string[]; principal?: string }, probe: FleetProbe = {}): Promise<LaunchSelection> {
  const fleet = await selectFleetSession(config, role, profile, probe);
  if (fleet) {
    await recordEnvironmentLog(config, fleet.health ? [fleet.health] : [], fleet.skipped).catch(() => {});
    return fleet;
  }
  const at = new Date(probe.now?.() ?? Date.now()).toISOString();
  const checked: EnvironmentHealth[] = [], skipped: AccountSkip[] = [];
  const held = await observedExhaustions(config, probe.now?.() ?? Date.now());
  if (!profile.accounts?.length) {
    const own = held[profileAccount(profile.name)];
    if (own) {
      const skip: AccountSkip = { at, role, profile: profile.name, environment: profileAccount(profile.name), reason: describeObservedExhaustion(`${profile.name}'s own account`, own), work: probe.work ?? null, cause: 'exhausted' };
      await recordEnvironmentLog(config, [], [skip]).catch(() => {});
      throw new NoHealthyAccountError(`No healthy agent account for ${role} profile ${profile.name}: ${skip.reason}`, [skip]);
    }
    await recordEnvironmentLog(config, [], [], { key: selectionKey(role, profile.name), environment: null, kind: null, at, work: probe.work ?? null }).catch(() => {});
    return { account: null, health: null, skipped: [] as AccountSkip[] };
  }
  for (const name of profile.accounts) {
    const environment = (config.environments ?? []).find(candidate => candidate.name === name);
    if (!environment) { skipped.push({ at, role, profile: profile.name, environment: name, reason: `${name} is not a configured agent environment; run master environments --apply`, work: probe.work ?? null, cause: 'unconfigured' }); continue; }
    // What a session itself reported outranks the provider's usage read, which may lag or not exist.
    if (held[name]) { skipped.push({ at, role, profile: profile.name, environment: name, reason: describeObservedExhaustion(name, held[name]), work: probe.work ?? null, cause: 'exhausted' }); continue; }
    const health = await checkAgentEnvironment(environment, { ...probe, ceilingPercent: probe.ceilingPercent ?? config.run.quotaCeilingPercent });
    checked.push(health);
    if (health.healthy) {
      await recordEnvironmentLog(config, checked, skipped, { key: selectionKey(role, profile.name), environment: environment.name, kind: environment.kind, at, work: probe.work ?? null }).catch(() => {});
      return { account: environment, health, skipped };
    }
    // `checkAgentEnvironment` reports exactly two faults: not logged in, or quota spent.
    skipped.push({ at, role, profile: profile.name, environment: name, reason: health.reason!, work: probe.work ?? null, cause: health.loggedIn ? 'exhausted' : 'logged-out' });
  }
  await recordEnvironmentLog(config, checked, skipped).catch(() => {});
  throw new NoHealthyAccountError(`No healthy agent account for ${role} profile ${profile.name}: ${skipped.map(entry => entry.reason).join('; ')}`, skipped);
}

/**
 * Run a launch on the session that was just chosen, and give that session back the moment
 * anything after the choice fails. Everything past selection can fail — a credential mismatch, a
 * token mint, a session harness, a Herdr tab, a prompt the runtime never took — and a session
 * that never ran would otherwise count against its account and its role for as long as the
 * request it answers stands: two hours for a reviewer, a day for a producer.
 */
export async function onSelectedSession<T>(selected: LaunchSelection, failed: string, launch: () => Promise<T>): Promise<T> {
  try { return await launch(); }
  catch (error) { await selected.release?.(`${failed}: ${failureText(error).slice(0, 300)}`); throw error; }
}

/**
 * Each runtime's broadest non-interactive approval mode. Claude Code, Codex and Cursor already get
 * theirs from the launch contract; OpenCode's contract allows edit, bash and webfetch only, so its
 * other permissions (directories outside the worktree, repeated tool calls, subagents, …) would
 * still stop a session to ask, and are allowed here too.
 */
export const openCodeAllowAll = { '*': 'allow', edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow', doom_loop: 'allow' };
/**
 * An operator's own OpenCode permission document that asks nothing (the recipe's `permits`) is laid
 * over the allow-all rather than replacing it: a key it leaves out (`external_directory`,
 * `doom_loop`, …) keeps Graphyard's `allow` instead of falling back to OpenCode's default, which asks.
 */
function openCodePermission(operator: string | undefined) {
  if (operator === undefined) return JSON.stringify(openCodeAllowAll);
  const document: unknown = JSON.parse(operator);
  return document && typeof document === 'object' && !Array.isArray(document) ? JSON.stringify({ ...openCodeAllowAll, ...document }) : operator;
}
export function agentLaunchPlan(kind: string | undefined, approvals: 'auto' | 'prompt' = 'auto', agentArgs: string[] = [], environment: Record<string, string> = {}) {
  const plan = launchPlan(kind, approvals, agentArgs, environment);
  if (!plan.applied || kind !== 'opencode') return plan;
  return { ...plan, environment: { ...plan.environment, OPENCODE_PERMISSION: openCodePermission(environment.OPENCODE_PERMISSION) }, prompts: 'every permission prompt, including edits, shell commands, fetches, and paths outside the worktree',
    tradeoff: 'opencode edits files, runs shell commands, fetches URLs, and reaches outside its worktree without asking.' };
}

/**
 * What a session launches with once its account is chosen: the account's kind and home, the
 * profile's arguments when they belong to that runtime, and the runtime's broadest approval mode.
 * Codex keeps its workspace sandbox, so the paths and network access the role needs are added to it:
 * a worker commits into the repository's shared Git directory and pushes; a producer builds in a
 * detached worktree under the managed worktree root, and is given its own session directory there
 * and nothing beside it.
 */
export function accountLaunch(profile: { kind?: string; approvals: 'auto' | 'prompt'; agentArgs: string[]; environment: Record<string, string> }, account: LaunchAccount | null, reach: { writable?: string[] } = {}) {
  // A registry account carries its runtime's launch contract: what to start, its own startup
  // arguments, the variable that selects the login home, and the flag that selects its model.
  const contract = account && 'fleet' in account ? account.fleet.contract : null;
  const kind = account?.kind ?? profile.kind;
  const own = !account || account.kind === profile.kind ? profile.agentArgs : [];
  const model = contract?.modelFlag && account && 'fleet' in account && account.fleet.modelId && !own.includes(contract.modelFlag) && !contract.args.includes(contract.modelFlag) ? [contract.modelFlag, account.fleet.modelId] : [];
  // An approvals opt-out is refused, naming the runtime, before any session starts (GY-184).
  assertNoApprovalOptOut(kind ?? 'unnamed', profile.approvals);
  const plan = agentLaunchPlan(kind, profile.approvals, [...(contract?.args ?? []), ...model, ...own], { ...contract?.environment, ...profile.environment });
  // So is an effective launch whose own arguments or environment still let the runtime ask.
  if (plan.refusal) throw new LaunchRefusedError(kind ?? 'unnamed', plan.refusal);
  // The plan's variables come last: they are the recipe's, where the profile set none, or the
  // profile's own OpenCode permissions laid over the allow-all.
  const environment: Record<string, string> = { ...contract?.environment, ...profile.environment, ...plan.environment };
  if (account) {
    const variable = contract ? contract.homeVariable : environmentVariable[account.kind as EnvironmentKind];
    if (variable && account.home) environment[variable] = account.home;
    // mise resolves installed runtimes under XDG_DATA_HOME; keep it on the operator's own install.
    if (variable === 'XDG_DATA_HOME' && account.home) {
      const mise = process.env.MISE_DATA_DIR ?? resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local/share'), 'mise');
      if (existsSync(mise)) environment.MISE_DATA_DIR = mise;
    }
  }
  const extra = kind === 'codex' && plan.applied ? ['-c', 'sandbox_workspace_write.network_access=true', ...(reach.writable ?? []).flatMap(path => ['--add-dir', path])] : [];
  return { kind, args: [...plan.args, ...extra], environment, plan, account: account?.name ?? null, contract };
}

/** The Git directory every worktree of the repository commits into. */
export async function sharedGitDirectory(root: string) {
  try { return (await defaultChildRun('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root })).trim() || null; }
  catch { return null; }
}

/**
 * Account health for every profile that names accounts, joined onto the credential health status
 * and the durable loop already read: a profile none of whose accounts can launch is unavailable,
 * with each account's reason.
 */
export interface ProfileAccountHealth { environment: string; healthy: boolean; reason: string | null; quota: string; resetsAt: string | null }
export async function inspectProfileAccounts<T extends { available: boolean; reason: string | null }>(config: Pick<MasterConfig, 'environments' | 'credentialFile' | 'run'> & Partial<Pick<MasterConfig, 'url' | 'hostId'>>, role: LaunchRole, profiles: { name: string; accounts?: string[] }[], health: Record<string, T>, probe: EnvironmentProbe = {}) {
  const result: Record<string, T & { accounts?: ProfileAccountHealth[] }> = { ...health };
  const now = probe.now?.() ?? Date.now(), held = await observedExhaustions(config, now);
  // A role the agent registry defines is judged from the registry: every profile of the role
  // launches on the same ordered accounts, so they share one answer.
  const fleet = await fleetRoleHealth(config, role, probe).catch(() => null);
  for (const profile of profiles) {
    if (fleet) {
      if (result[profile.name]?.available !== false) result[profile.name] = { ...(result[profile.name] ?? { available: true, reason: null } as T), available: fleet.available, reason: fleet.reason, accounts: fleet.accounts };
      continue;
    }
    if (result[profile.name]?.available === false) continue;
    if (!profile.accounts?.length) {
      const own = held[profileAccount(profile.name)];
      if (own) result[profile.name] = { ...(result[profile.name] ?? { available: true, reason: null } as T), available: false, reason: `No healthy agent account: ${describeObservedExhaustion(`${profile.name}'s own account`, own)}`,
        accounts: [{ environment: profileAccount(profile.name), healthy: false, reason: describeObservedExhaustion(`${profile.name}'s own account`, own), quota: 'exhausted', resetsAt: own.resetsAt }] };
      continue;
    }
    const accounts: ProfileAccountHealth[] = [];
    for (const name of profile.accounts) {
      const environment = (config.environments ?? []).find(candidate => candidate.name === name);
      if (!environment) { accounts.push({ environment: name, healthy: false, reason: `${name} is not a configured agent environment`, quota: 'unknown', resetsAt: null }); continue; }
      if (held[name]) { accounts.push({ environment: name, healthy: false, reason: describeObservedExhaustion(name, held[name]), quota: 'exhausted', resetsAt: held[name].resetsAt }); continue; }
      const checked = await checkAgentEnvironment(environment, { ...probe, ceilingPercent: probe.ceilingPercent ?? config.run.quotaCeilingPercent });
      // The reset that matters is the latest among the spent windows: the account launches again only when all of them have.
      const ceiling = probe.ceilingPercent ?? config.run.quotaCeilingPercent ?? defaultQuotaCeilingPercent;
      const resets = checked.quota === 'exhausted' ? checked.usage.filter(usage => usage.percent >= ceiling).map(usage => usage.resetsAt ? Date.parse(usage.resetsAt) : Number.NaN).filter(value => Number.isFinite(value) && value > now) : [];
      accounts.push({ environment: name, healthy: checked.healthy, reason: checked.reason, quota: checked.quota, resetsAt: resets.length ? new Date(Math.max(...resets)).toISOString() : null });
    }
    const usable = accounts.some(account => account.healthy);
    result[profile.name] = { ...(result[profile.name] ?? { available: true, reason: null } as T), available: usable, reason: usable ? null : `No healthy agent account: ${accounts.map(account => account.reason).join('; ')}`, accounts };
  }
  return result;
}

/**
 * Whether a role has any account left. A role is out of capacity only when every launch profile
 * it has is unavailable for one reason — each of its accounts is spent — so a logged-out account
 * or an unreadable credential, which somebody can fix now, never reads as a wait for a reset.
 */
export interface RoleCapacity { role: CapacityRole; exhausted: boolean; accounts: CapacityAccount[]; retryAt: string | null }
export function roleCapacity(role: CapacityRole, profiles: { name: string }[], health: Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }>): RoleCapacity {
  const spent = profiles.map(profile => ({ profile, accounts: health[profile.name]?.accounts ?? [], available: health[profile.name]?.available !== false }));
  const exhausted = spent.length > 0 && spent.every(entry => !entry.available && entry.accounts.length > 0 && entry.accounts.every(account => account.quota === 'exhausted'));
  const accounts: CapacityAccount[] = exhausted ? spent.flatMap(entry => entry.accounts.map(account => ({ account: account.environment, profile: entry.profile.name, resetsAt: account.resetsAt, reason: (account.reason ?? 'quota exhausted').slice(0, 500) }))) : [];
  return { role, exhausted, accounts, retryAt: capacityRetryAt(accounts) };
}

/**
 * Keep what an interrupted attempt had not committed. The work is committed on the attempt's own
 * branch in its own worktree — never pushed, never stashed (the stash is shared by every
 * worktree) — so the next attempt can read or cherry-pick it and nothing of it is lost. Only when
 * it cannot be committed is the worktree reset, and the record says discarded: an attempt never
 * ends with changes that are neither kept nor gone.
 */
export async function preservePartialWork(path: string, label: string, run: ChildRun = childRunner({ timeoutMs: 60_000 })): Promise<PartialWork> {
  const git = async (...args: string[]) => (await run('git', ['-C', path, ...args])).trim();
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => undefined);
  const described = { path, ...(branch && branch !== 'HEAD' ? { branch } : {}) };
  if (!await git('status', '--porcelain')) return { state: 'clean', commit: await git('rev-parse', 'HEAD'), ...described, detail: 'the worktree held no uncommitted change; every commit of the attempt is on its branch' };
  try {
    await git('add', '-A');
    await git('-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@localhost', 'commit', '--no-verify', '-m', `WIP: ${label}`);
    return { state: 'committed', commit: await git('rev-parse', 'HEAD'), ...described, detail: 'uncommitted changes were committed on the attempt branch, unpushed' };
  } catch (error) {
    await git('reset', '--hard'); await git('clean', '-fd');
    return { state: 'discarded', commit: await git('rev-parse', 'HEAD'), ...described, detail: `uncommitted changes could not be committed and were discarded: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) };
  }
}

/**
 * The instruction a launched session starts on, as the session's own first request.
 *
 * `herdr agent prompt` types its text into the running session through bracketed paste, and a
 * coding agent treats pasted text as untrusted data rather than as a request from its operator —
 * correctly, against prompt injection — so a session launched that way often ends its first turn
 * having refused to act (GY-93). Every runtime Graphyard launches takes an initial prompt on its
 * own command line instead, where it is the user's own first message: Claude Code, Codex and
 * Cursor as a positional argument after their flags, OpenCode through `--prompt`. A runtime with
 * no such contract keeps the paste, and the record says so.
 *
 * What is typed into the pane is short and constant-size (GY-121). Herdr types a launch command
 * into an interactive shell keystroke by keystroke and the shell redraws the line as it grows, so
 * a multi-kilobyte request took the whole start bound to echo under host load and the runtime was
 * declared dead before it existed. The request and the role authorization are written to files
 * inside the session's own checkout directory instead (`.graphyard/launch/NAME.request` and
 * `NAME.role`, mode 0600, removed with the checkout), and the command line references them by
 * their shared stem, `GY=DIR/.graphyard/launch/NAME;`: the role file through the runtime's own
 * flag (`--append-system-prompt-file "$GY.role"`), the request through the shell's own
 * substitution (`"$(cat "$GY.request")"`), which the interactive POSIX shell expands before the
 * runtime starts, so the text is still the runtime's own first argument and never a paste. The
 * typed line holds only the runtime, its flags and one path, and is bounded by
 * `launchCommandLimit` whatever the request is.
 */
export const launchRequestContracts: Record<string, (reference: string) => string> = {
  claude: reference => reference, codex: reference => reference, cursor: reference => reference, opencode: reference => `--prompt ${reference}`,
  pi: reference => reference, muse: reference => reference, gemini: reference => `--prompt-interactive ${reference}`, qwen: reference => `--prompt-interactive ${reference}`, copilot: reference => `--interactive ${reference}`,
};
export { requestPlaceholder };
/** How a runtime loads the launch authorization from a file; only Claude Code, which leaves AGENTS.md out under a role file, needs one. */
export const launchRoleContracts: Record<string, (reference: string) => string> = { claude: reference => `--append-system-prompt-file ${reference}` };
export type RequestDelivery = 'request' | 'paste';
export const launchDelivery = (kind: string | undefined, args: string[] = []): RequestDelivery => kind && (launchRequestContracts[kind] || args.includes(requestPlaceholder)) ? 'request' : 'paste';
/**
 * A session's instruction is its own first request, on the runtime's command line, never a paste
 * (GY-93): a runtime without a way to take it there is refused before launch, naming the runtime
 * and the fix, rather than started and handed text it may rightly treat as untrusted (GY-184).
 */
export const requestContractRefusal = (kind: string) => `Graphyard refuses to launch the ${kind} runtime: it has no way to take the session's first request on its command line, and a launched session's instruction is never pasted into it. Register where ${kind} takes its first prompt with graphyard master registry runtime set NAME --kind ${kind} --arg=${requestPlaceholder} (or --arg=FLAG --arg=${requestPlaceholder}) --reason REASON.`;
/** The most bytes a launch command line may hold: the runtime, its flags and two file paths, never the request. */
export const launchCommandLimit = 512;
export const launchDirectory = (directory: string) => resolve(directory, '.graphyard/launch');
/** The session's launch files: `stem` is `DIR/.graphyard/launch/NAME`, and each file present is `STEM.role` or `STEM.request` (and `STEM.launch`, the runtime's words, for a line that would exceed the bound). */
export interface LaunchFiles { stem: string; role: string | null; request: string | null }
/** A word for the pane's shell: bare when it needs no quoting, single-quoted otherwise. */
export const shellWord = (value: string) => /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
/** The shell variable the command line binds to the stem, so each file is referenced once and the line stays short. */
export const launchVariable = 'GY';
const roleReference = `"$${launchVariable}.role"`, requestReference = `"$(cat "$${launchVariable}.request")"`, launchScriptReference = `"$${launchVariable}.launch"`;
/**
 * Writes the session's request and role authorization where its command line reads them: private
 * files under the checkout's own `.graphyard/launch/`, holding the exact text, replaced on every
 * launch under the same name and removed with the checkout.
 */
export function writeLaunchFiles(directory: string, name: string, text: { role?: string | null; request?: string | null }): LaunchFiles {
  const folder = launchDirectory(directory);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stem = resolve(folder, name);
  const write = (suffix: string, value: string | null | undefined) => {
    if (value === null || value === undefined) return null;
    writeFileSync(`${stem}.${suffix}`, value, { mode: 0o600 }); chmodSync(`${stem}.${suffix}`, 0o600);
    return `${stem}.${suffix}`;
  };
  return { stem, role: write('role', text.role), request: write('request', text.request) };
}
/** The command line typed into the pane: the stem binding, then `prefix` (a supervisor), the runtime, its arguments and the file references. */
export function launchCommand(kind: string, args: string[], files: LaunchFiles, prefix: string[] = []) {
  const role = files.role ? launchRoleContracts[kind]?.(roleReference) : undefined;
  const own = launchRequestContracts[kind];
  const request = files.request && own ? own(requestReference) : undefined;
  // A registry runtime's request goes where its contract places `{request}`; a built-in one drops the marker.
  const placed = args.map(argument => argument !== requestPlaceholder ? shellWord(argument) : files.request && !own ? requestReference : null).filter((word): word is string => word !== null);
  const binding = role || request || placed.includes(requestReference) ? [`${launchVariable}=${shellWord(files.stem)};`] : [];
  const runtime = [...prefix.map(shellWord), kind, ...placed, ...(role ? [role] : []), ...(request ? [request] : [])].join(' ');
  let command = [...binding, runtime].join(' ');
  // The runtime's flags can name long paths (a producer's checkout and the shared Git directory as
  // Codex writable roots), so a line over the bound moves them into `STEM.launch`, beside the other
  // launch files, and the typed line only binds the stem and sources it: the pane's own shell still
  // starts the runtime on the same words, and the request is still its first argument. Only a stem
  // too long to leave room for that is refused.
  if (Buffer.byteLength(command) > launchCommandLimit) {
    command = `${launchVariable}=${shellWord(files.stem)}; . ${launchScriptReference}`;
    if (Buffer.byteLength(command) <= launchCommandLimit) { writeFileSync(`${files.stem}.launch`, `${runtime}\n`, { mode: 0o600 }); chmodSync(`${files.stem}.launch`, 0o600); return command; }
  }
  const bytes = Buffer.byteLength(command);
  if (bytes > launchCommandLimit) throw new Error(`the launch command line is ${bytes} bytes, over the ${launchCommandLimit}-byte bound; it holds only the path of the session's launch files, so shorten the repository path or the managed worktree root: ${command.slice(0, 160)}…`);
  return command;
}

/**
 * The start bound reads the pane rather than guessing against a clock (GY-121). Herdr's `agent
 * get` names the runtime occupying the pane and whether it is ready; the pane's text shows the
 * runtime's own screen — its banner, its spinner over the request it is already working on —
 * before Herdr classifies it, or the launch command still echoing, or the runtime's own error.
 * The producers this item was filed for died exactly there: Claude Code was on screen with its
 * spinner while Herdr still reported it `unknown` at 30 s, and the launcher closed a live session.
 *
 * A runtime seen ready within `agentStartTimeoutMs` has started: Herdr reports it `idle` or
 * `done`, or `working` for a session already at work on its own request — or Herdr reports the
 * runtime under the pane, whatever it makes of its state, and the runtime's screen is showing:
 * that session is adopted, never closed. A runtime still to be prompted must be reported idle.
 * One that is *starting* at the bound — its process exists under the pane but nothing of it is on
 * screen yet, or its banner is on screen before Herdr sees a process — is given until
 * `agentStartCeilingMs`; one that is absent at the bound never started; one `blocked` before it
 * is ready sits at a dialog no launcher answers and is refused at once, as before. Every refusal
 * names which case it saw and the pane's last non-empty line, bounded, so the operator reads
 * `command still echoing`, the dialog, or the runtime's own words rather than Herdr's
 * `agent_not_found`.
 */
export const agentStartTimeoutMs = 30_000, agentStartCeilingMs = 120_000, startPollMs = 500, paneLineLimit = 200;
export const startedStates = ['idle', 'done', 'working'], promptableStates = ['idle', 'done'];
/**
 * The runtime's own screen, per kind: its banner, its status line, or its spinner at the start of a
 * line (Claude Code's `∙ ✻ ✶ ✳ ✢` over the request it is working on). Nothing here matches the
 * echoed launch command — lowercase runtime names, no spaces inside `bypassPermissions` — or a
 * shell prompt, whose `❯` some shells draw at the start of a line too.
 */
export const runtimeScreens: Record<string, RegExp> = {
  claude: /Claude Code|Welcome to Claude|esc to interrupt|bypass permissions on|shift\+tab to cycle|for shortcuts|^\s*[∙✻✶✳✢]/m,
  codex: /\bCodex\b|esc to interrupt/, cursor: /\bCursor\b/, opencode: /\bOpenCode\b/, gemini: /\bGemini\b/,
};
export type StartState = 'ready' | 'starting' | 'absent' | 'blocked' | 'consent';
export interface StartObservation { state: StartState; agent: HerdrAgent | null; detail: string; line: string; prompt?: ConsentPrompt }
export interface StartBounds { timeoutMs?: number; ceilingMs?: number; pollMs?: number; clock?: () => number; /** The pause between polls; a test's advances a virtual clock, the process's awaits a timer. */ wait?: (ms: number) => void | Promise<void>; /** The states that count as ready; `startedStates` unless the runtime is still to be prompted. */ readyStates?: string[];
  /** Whether a session stopped on a consent prompt the launcher does not answer is held for a human (a worker, whose supervisor bounds the hold) rather than refused. */ holdConsent?: boolean }
export class SessionStartError extends Error {
  constructor(readonly startCase: 'never started' | 'still starting' | 'blocked' | 'awaiting consent', readonly pane: string, readonly screen: string, readonly waitedMs: number, message: string) { super(message); }
}
/**
 * How many times the launcher answers one allow-listed prompt before it treats the prompt as one it
 * cannot answer, and how long an answered dialog is given to close before it is answered again — a
 * second keystroke into a dialog that was already closing would land in the runtime's input.
 */
export const consentAnswerAttempts = 2, consentSettleMs = 5_000;
/**
 * A runtime's own safety prompt, read off a blocked session's screen (GY-197).
 *
 * Runtimes keep some prompts beyond every approval flag they take — Claude Code asks before an
 * `rm` whose target it cannot resolve even under `--dangerously-skip-permissions` — and a session
 * that stops on one waits for a person no one will be. The loop answers the shapes it knows with
 * the answer that does nothing: a Yes/No (or proceed/cancel) menu whose "yes" runs a destructive
 * command is declined, and the session is then told how to carry on without that command. Any
 * other prompt is `unknown`, and the loop fails the attempt on it rather than waiting.
 */
export interface RuntimePrompt {
  /** `destructive-command` is a known shape with a safe answer; `unknown` is everything else a blocked screen shows. */
  kind: 'destructive-command' | 'unknown';
  /** The prompt's own words, collapsed to one line and bounded, as the record quotes it. */
  text: string;
  /** The keys that choose the non-destructive answer, and that answer's label; null for an unknown prompt. */
  keys: string[] | null; answer: string | null;
}
export const runtimePromptTextLimit = 400;
const menuOption = /^\s*(?:[❯>›▶→]\s*)?(\d)[.)]\s+(.+?)\s*$/;
const affirmative = /^(?:yes|proceed|continue|allow|run|approve)\b/i, negative = /^(?:no|cancel|deny|decline|reject|abort)\b/i;
/** Words that make a prompt's "yes" destructive: a deletion, move or overwrite the runtime would not run unasked. */
export const destructivePrompt = /\b(?:dangerous|destructive|rm|rmdir|unlink|delete|deletion|remove|mv|overwrite|force|irreversible|wipe|truncate)\b/i;
const collapse = (lines: string[]) => {
  const text = lines.map(entry => entry.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ');
  return text.length > runtimePromptTextLimit ? `${text.slice(0, runtimePromptTextLimit - 1)}…` : text;
};
/**
 * The prompt a blocked session's screen shows. Only the bottom of the screen is read — the last
 * menu on it and the lines just above that menu — so a command the session ran earlier and that
 * scrolled up cannot make the current prompt look destructive. Null when there is no screen.
 */
export function classifyRuntimePrompt(screen: string | null | undefined): RuntimePrompt | null {
  if (screen === null || screen === undefined) return null;
  const lines = screen.split('\n').map(entry => entry.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trimEnd());
  const filled = lines.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.trim());
  if (!filled.length) return null;
  // The last run of numbered options is the prompt's menu; the prompt is the lines above it.
  let end = -1;
  for (let at = filled.length - 1; at >= 0; at--) if (menuOption.test(filled[at].entry)) { end = at; break; }
  if (end >= 0) {
    let start = end;
    while (start > 0 && menuOption.test(filled[start - 1].entry)) start--;
    const options = filled.slice(start, end + 1).map(({ entry }) => { const [, number, label] = menuOption.exec(entry)!; return { number, label }; });
    const question = filled.slice(Math.max(0, start - 8), start).map(({ entry }) => entry);
    const text = collapse([...question, ...options.map(option => `${option.number}. ${option.label}`)]);
    const yes = options.find(option => affirmative.test(option.label)), no = options.find(option => negative.test(option.label));
    if (yes && no && destructivePrompt.test(question.join(' '))) return { kind: 'destructive-command', text, keys: [no.number], answer: `${no.number}. ${no.label}` };
    return { kind: 'unknown', text, keys: null, answer: null };
  }
  const tail = filled.slice(-4).map(({ entry }) => entry);
  // An inline yes/no question, such as `Proceed? [y/N]`, is declined with `n`.
  if (/[[(]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[\])]/i.test(tail.at(-1) ?? '') && destructivePrompt.test(tail.join(' '))) return { kind: 'destructive-command', text: collapse(tail), keys: ['n', 'Enter'], answer: 'n' };
  return { kind: 'unknown', text: collapse(tail), keys: null, answer: null };
}
/** The one instruction a session gets after the loop declined its destructive-command prompt: carry on with a safe alternative. */
export function continueAfterDecline(key: string, prompt: Pick<RuntimePrompt, 'text' | 'answer'>, directory: string | null) {
  const where = directory ? `explicit paths inside your worktree ${directory}` : 'explicit paths inside your own checkout';
  return `Graphyard answered your runtime's destructive-command prompt for you with "${prompt.answer}", because no person will answer it: "${prompt.text}". Continue ${key} without that command. `
    + `Use a safe alternative that needs no confirmation: name ${where}, or create a scratch directory with mktemp -d and remove only that directory by its exact path. `
    + 'Never give rm or mv a glob or a variable as its target outside a directory you created with mktemp -d. Do not stop or ask anyone; carry on with your task.';
}

/** The pane's terminal as text, unwrapped; null when Herdr cannot read it. */
export async function readPaneScreen(pane: string, run: ChildRun = defaultChildRun, lines = 40) {
  try { return String(await run('herdr', ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(lines)])); } catch { return null; }
}
/** The pane's last non-empty line, bounded for a record. */
export function paneLastLine(text: string | null, limit = paneLineLimit) {
  const line = (text ?? '').split('\n').map(entry => entry.replace(/\s+/g, ' ').trim()).filter(Boolean).at(-1) ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
/** Whether the pane's last line is the launch command itself — typed, or still being typed — and not yet answered: it opens with the stem binding and names the runtime. */
export const commandEchoing = (line: string, command: string) => !!line && (line.includes(command.slice(0, 24)) || (line.includes(`${launchVariable}=`) && line.includes(` ${command.replace(/^GY=\S+; /, '').split(' ')[0]}`)));
export async function observeStart(pane: string, kind: string, command: string, run?: ChildRun, readyStates = startedStates): Promise<StartObservation> {
  let agent: HerdrAgent | null = null;
  try { const raw = await herdrJson(['agent', 'get', pane], run); agent = raw?.agent ?? raw ?? null; } catch { agent = null; }
  // A runtime Herdr sees `working` is at work on its request. Any other state is read off the
  // screen too: a runtime stopped on a first-run consent prompt is `idle` to Herdr, just as a
  // started one is, and has not read its request (GY-130).
  if (agent?.agent === kind && agent.agent_status === 'working' && readyStates.includes('working')) return { state: 'ready', agent, detail: `Herdr reports the ${kind} runtime working`, line: '' };
  const screen = await readPaneScreen(pane, run), last = paneLastLine(screen, Infinity), line = paneLastLine(screen);
  const prompt = detectConsentPrompt(screen);
  if (prompt) return { state: 'consent', agent, detail: `the ${kind} runtime is awaiting consent on a ${prompt.kind} prompt`, line, prompt };
  // A runtime stopped on its own settings warning has not started either, whatever Herdr reports,
  // and is refused at once with the rules it named rather than the dialog's key hint.
  const warning = settingsWarning(screen);
  if (warning) return { state: 'blocked', agent, detail: warning, line };
  // An unread pane rules nothing out: an idle runtime may be sitting on a consent prompt, so it is
  // polled again until a read shows its screen, never taken as ready without one.
  if (screen === null && agent?.agent === kind && readyStates.includes(agent.agent_status ?? '')) return { state: 'starting', agent, detail: `Herdr reports the ${kind} runtime ${agent.agent_status} but its pane could not be read, so a consent prompt is not ruled out`, line };
  if (agent?.agent === kind && readyStates.includes(agent.agent_status ?? '')) return { state: 'ready', agent, detail: `Herdr reports the ${kind} runtime ${agent.agent_status}`, line: '' };
  const showing = screen !== null && !!runtimeScreens[kind]?.test(screen);
  if (agent?.agent === kind && agent.agent_status === 'blocked') return { state: 'blocked', agent, detail: 'Herdr reports it blocked', line };
  // Herdr sees the runtime's process and its screen is showing: a session at work that Herdr has
  // not classified yet, adopted rather than closed — unless it is still to be prompted, when only
  // Herdr's idle counts.
  if (agent?.agent === kind && showing && readyStates.includes('working')) return { state: 'ready', agent, detail: `the ${kind} runtime is on screen while Herdr reports it ${agent.agent_status ?? 'unknown'}`, line };
  if (agent?.agent === kind) return { state: 'starting', agent, detail: `the ${kind} runtime process exists under the pane, Herdr reports it ${agent.agent_status ?? 'unknown'}${showing ? ', its screen showing' : ''}`, line };
  if (showing) return { state: 'starting', agent: null, detail: `the ${kind} banner is on screen`, line };
  return { state: 'absent', agent: null, line, detail: commandEchoing(last, command) ? 'command still echoing' : agent?.agent ? `the pane holds ${agent.agent}, not ${kind}` : 'no runtime under the pane' };
}
export async function awaitRuntimeStart(pane: string, kind: string, command: string, run?: ChildRun, bounds: StartBounds = {}) {
  const timeoutMs = bounds.timeoutMs ?? agentStartTimeoutMs, ceilingMs = Math.max(timeoutMs, bounds.ceilingMs ?? agentStartCeilingMs), pollMs = bounds.pollMs ?? startPollMs;
  // The poll pause is awaited on the event loop, never spun on Atomics.wait: a launch that takes
  // the whole ceiling holds up only the launcher (GY-125).
  const clock = bounds.clock ?? Date.now, wait = bounds.wait ?? ((ms: number) => sleep(ms));
  const startedAt = clock();
  const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
  let extended: string | null = null;
  const consent: ConsentAnswer[] = [];
  for (;;) {
    const observed = await observeStart(pane, kind, command, run, bounds.readyStates), waitedMs = clock() - startedAt;
    if (observed.state === 'ready') return { ...observed, waitedMs, extended, consent, awaiting: null };
    if (observed.state === 'consent') {
      const prompt = observed.prompt!, rule = prompt.rule;
      // Answers are counted per dialog, not per rule: a second dialog the same rule matches (a
      // crash-report question after a usage-statistics one) gets its own bounded attempts.
      const answered = consent.filter(answer => answer.rule === rule?.id && sameConsentPrompt({ kind: answer.kind, prompt: answer.prompt }, prompt));
      const answeredAt = answered.at(-1)?.at;
      if (answeredAt && clock() - Date.parse(answeredAt) < consentSettleMs && waitedMs < ceilingMs) { await wait(pollMs); continue; }
      // An allow-listed prompt is answered with its least-privilege option, and the answer is
      // recorded; the start bound keeps running, so a prompt that returns is not answered forever.
      if (rule && prompt.keys && answered.length < consentAnswerAttempts && waitedMs < ceilingMs) {
        await herdrRun(['pane', 'send-keys', pane, ...prompt.keys], run);
        consent.push({ rule: rule.id, kind: prompt.kind, prompt: prompt.text, answer: rule.answer, keys: prompt.keys, at: new Date(clock()).toISOString() });
        await wait(pollMs);
        continue;
      }
      const why = rule ? `the launcher answered it ${consentAnswerAttempts} times and it is still showing` : `it is outside the launcher's consent allow-list`;
      // A session held for a human is reported, not refused: it has not taken its request, and it
      // is never counted as started. Everything else refuses the launch with the prompt's own text.
      if (bounds.holdConsent) return { ...observed, waitedMs, extended, consent, awaiting: { prompt: prompt.text, kind: prompt.kind, why } };
      throw new SessionStartError('awaiting consent', pane, prompt.text, waitedMs, `the ${kind} runtime is awaiting consent in pane ${pane} on a ${prompt.kind} prompt, and ${why}: "${prompt.text}"`);
    }
    const quoted = observed.line ? `; the pane last showed: "${observed.line}"` : '; the pane showed nothing';
    if (observed.state === 'blocked') throw new SessionStartError('blocked', pane, observed.line, waitedMs, `the ${kind} runtime is blocked before it is ready in pane ${pane} (${observed.detail})${quoted}`);
    if (waitedMs >= timeoutMs && observed.state !== 'starting') throw new SessionStartError('never started', pane, observed.line, waitedMs, `the ${kind} runtime never started within ${seconds(timeoutMs)} in pane ${pane} (${observed.detail})${quoted}`);
    if (waitedMs >= ceilingMs) throw new SessionStartError('still starting', pane, observed.line, waitedMs, `the ${kind} runtime was still starting after ${seconds(ceilingMs)} in pane ${pane} (${observed.detail})${quoted}`);
    if (waitedMs >= timeoutMs) extended ??= `${observed.detail} at ${seconds(timeoutMs)}; waiting up to ${seconds(ceilingMs)}`;
    await wait(pollMs);
  }
}

/**
 * Start a session on its request: its files are written, the short command line is typed into the
 * pane, and the pane is read until the runtime is ready (awaitRuntimeStart), when Herdr's record
 * of it takes the session's name. A runtime with no way to take its request on the command line is
 * refused before anything is typed (GY-184); the paste delivery below is only for the loop's
 * re-prompt and the reviewer's reminder, never a session's instruction.
 *
 * The name goes in before the runtime does. A name the runtime would refuse — too long, or built
 * from characters it does not take — is refused here as that refusal, naming the limit, the name
 * attempted and the command that retries the launch, rather than reaching the caller as whatever
 * the runtime says about its arguments (GY-101).
 */
export interface SessionStart extends PromptDelivery, StartBounds { directory: string; role?: string | null; prefix?: string[]; confirm?: 'inline' | 'follow'; retry?: string; contract?: RegisteredLaunch | null;
  /** The pane's working directory, where the runtime starts (`directory` unless the tab opened elsewhere), and the environment its tab carries: what the runtime's `trust` step records the folder in. */ cwd?: string; environment?: Record<string, string> }
export async function startAgentSession(name: string, kind: string, pane: string, args: string[], text: string, run: ChildRun | undefined, options: SessionStart) {
  assertSessionName(name, options.retry);
  // A runtime Graphyard cannot start without its own approval prompts is refused here, before
  // anything is typed, rather than launched into a session that waits for a keypress (GY-184).
  // A registry runtime's own launch contract is its recipe when it registers one.
  assertLaunchable(kind, options.contract);
  const delivery = launchDelivery(kind, args);
  if (delivery !== 'request') throw new LaunchRefusedError(kind, requestContractRefusal(kind));
  // A runtime whose trust prompt no flag suppresses has its working directory recorded as trusted
  // first, or the launch is refused naming it (GY-184): nothing is typed into a session that would wait.
  const trust = await nonInteractiveLaunch[kind]?.trust?.(options.cwd ?? options.directory, options.environment ?? {}, args);
  // Every session carries the autonomy contract: in its role file when the runtime loads one,
  // otherwise at the start of its first request (GY-184).
  const carried = withAutonomyContract(!!launchRoleContracts[kind], { request: text, role: options.role });
  text = carried.request;
  const files = writeLaunchFiles(options.directory, name, { role: carried.role, request: text });
  const command = launchCommand(kind, args, files, options.prefix);
  await herdrRun(['pane', 'run', pane, command], run);
  const started = await awaitRuntimeStart(pane, kind, command, run, { ...options, readyStates: startedStates });
  let named = true;
  try { await herdrJson(['agent', 'rename', pane, name], run); }
  catch (error) {
    // A runtime whose own naming rules are narrower than the ones checked above says so in its
    // refusal; that is a refused name too, and it is reported as one rather than as a failed start.
    if (nameRefusedByRuntime(error)) throw new SessionNameRefusedError(name, `the runtime refused it: ${herdrErrorText(error).split('\n')[0].slice(0, 200)}`, options.retry ?? null);
    // A held session is still named so a human can find it, but a runtime that will not take the
    // name before its dialog is answered does not turn the hold into a failed start.
    // The hold records it unnamed, so the watch supervisor retries the name before it clears.
    if (!started.awaiting) throw error;
    named = false;
  }
  // The request is already the runtime's own first argument, so nothing waits to be pasted: a
  // session held on a consent dialog reads it once the dialog is answered.
  return { delivery, command, files, trust: trust ?? null, consent: started.consent, awaiting: started.awaiting ? { ...started.awaiting, request: null as string | null, named } : undefined,
    started: { state: started.awaiting ? 'awaiting consent' as const : 'started' as const, detail: started.detail, waitedMs: started.waitedMs, extended: started.extended } };
}

/**
 * Prompt delivery the runtime visibly accepted. Herdr submits the prompt and reports whether the
 * agent left its idle state for it; a runtime that reported ready before its input was (OpenCode
 * does, while its UI loads) drops the text and stays idle, which Herdr answers as a stalled prompt.
 * A stalled prompt is delivered again after a pause; one still refused after every attempt fails
 * the launch, whose caller closes the session and launches afresh. Anything else Herdr refuses
 * fails at once. Since GY-93 this is the path for a runtime without a request contract, for the
 * loop's one re-prompt of a session that has not taken up its request, and for the reviewer's
 * retry to post a verdict it already judged.
 */
export const promptAttempts = 3, promptAcceptMs = 20_000, promptRetryPauseMs = 3_000;
export class PromptNotAcceptedError extends Error { readonly promptDropped = true; }
export function herdrErrorCode(error: unknown) {
  const text = [(error as any)?.herdrCode, (error as any)?.stdout, (error as any)?.stderr, (error as any)?.message].filter(value => value !== undefined && value !== null).map(String).join('\n');
  return (error as any)?.herdrCode ?? /"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? null;
}
/** Everything a Herdr failure said, whichever stream it said it on. */
export function herdrErrorText(error: unknown) {
  return [(error as any)?.stdout, (error as any)?.stderr, error instanceof Error ? error.message : error].filter(value => value !== undefined && value !== null && value !== '').map(String).join('\n');
}
/** A runtime refusing the name it was given, rather than failing to start the session it names. */
export function nameRefusedByRuntime(error: unknown) {
  return /\b(?:agent|session) name\b|\binvalid (?:agent |session )?name\b/i.test(herdrErrorText(error));
}
export interface PromptDelivery { attempts?: number; acceptMs?: number; pauseMs?: number }
export async function deliverPrompt(target: string, text: string, run?: ChildRun, options: PromptDelivery & { confirm?: 'inline' | 'follow' } = {}) {
  const attempts = options.attempts ?? promptAttempts, acceptMs = options.acceptMs ?? promptAcceptMs, pauseMs = options.pauseMs ?? promptRetryPauseMs;
  const accepted = ['--until', 'working', '--until', 'blocked', '--timeout', String(acceptMs)];
  const stalls: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Herdr takes options only after the prompt text; 'follow' submits it and then waits for the
      // agent to leave idle, which is the same confirmation for a caller whose text must come last.
      if (options.confirm === 'follow') { await herdrJson(['agent', 'prompt', target, text], run); await herdrJson(['agent', 'wait', target, ...accepted], run); }
      else await herdrJson(['agent', 'prompt', target, text, '--wait', ...accepted], run);
      return { attempts: attempt, accepted: true as const };
    } catch (error) {
      const code = herdrErrorCode(error);
      if (code !== 'agent_prompt_stalled' && code !== 'timeout') throw error;
      stalls.push(code);
      // The pause is awaited on the event loop: nothing else in the process waits with it.
      if (attempt < attempts) await sleep(pauseMs);
    }
  }
  throw new PromptNotAcceptedError(`${target} did not visibly accept its prompt after ${attempts} deliveries (${stalls.join(', ')}); the session is closed and relaunched rather than left idle`);
}

/**
 * Whether a launched session has taken up its request, judged from what Herdr shows and nothing
 * the session says (GY-93).
 *
 * A session that refused its request ends its only turn within seconds and then sits still:
 * `done`, a screen that no longer changes. A session at work is seen `working` or `blocked`, or —
 * while a long command runs, which Herdr reports as `idle` for Claude Code — with a screen that
 * keeps changing under its timer and output. A refusal is often caught `working` too, for the
 * seconds its answer takes, so one sighting proves nothing: the session is *acknowledged* once
 * activity has been seen across `sustainedActivityMs`, once it is `blocked` (an approval or
 * question UI: it reached a tool call), or once its result exists.
 *
 * A session still quiet `acknowledgementSeconds` after its launch is re-prompted exactly once,
 * with its request, and the record says when. The re-prompt starts the activity window afresh,
 * so the seconds a second refusal takes cannot acknowledge the session either; a sighting that is
 * not active ends the window too, so activity counts only across consecutive sightings and a
 * single later screen change cannot complete a window a refusal opened. What the loop then
 * records — never started, or finished without its result — is decided where each ledger settles
 * the session, from `acknowledgedAt` and `repromptedAt`, and no sooner than `settlementDue` allows.
 */
export const defaultAcknowledgementSeconds = 90, sustainedActivityMs = 30_000;
export const acknowledgementMs = (config: { run: Pick<MasterRun, 'acknowledgementSeconds'> }) => (config.run.acknowledgementSeconds ?? defaultAcknowledgementSeconds) * 1000;
export interface LaunchAcknowledgement { requestedAt: string; acknowledgedAt?: string; repromptedAt?: string; activeSince?: string; screen?: string }
export type SessionActivity = 'awaiting acknowledgement' | 'running';
export const sessionActivity = (record: Pick<LaunchAcknowledgement, 'acknowledgedAt'>): SessionActivity => record.acknowledgedAt ? 'running' : 'awaiting acknowledgement';
export const activeStates = ['working', 'blocked'];
export const screenDigest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
/** The session's terminal, as text; null when Herdr cannot read it. */
export async function readSessionScreen(target: string, run: ChildRun = defaultChildRun, lines = 80): Promise<string | null> {
  try { return String(await run('herdr', ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(lines)])); } catch { return null; }
}
/** How a session's screen is read when the judgement needs it: a stub in a test, one Herdr read in the process. */
export type ScreenReader = () => string | null | Promise<string | null>;
const screenDecoration = /^[\s─━═╌┄┈│┃╭╮╰╯┌┐└┘├┤=_*·•-]*$|^[❯⏵✻✶✳✢·]|bypass permissions on|shift\+tab to cycle|for shortcuts|esc to interrupt|\? for help/;
/** The session's own last words: the tail of its screen without the runtime's frame, bounded for a ledger record. */
export function sessionWords(text: string | null, limit = 400) {
  const lines = (text ?? '').split('\n').map(line => line.trim()).filter(line => line && !screenDecoration.test(line));
  const words = lines.slice(-8).join(' ').replace(/\s+/g, ' ').trim();
  return words.length > limit ? `…${words.slice(-limit)}` : words;
}
export async function acknowledgeLaunch(record: LaunchAcknowledgement, agent: Pick<HerdrAgent, 'agent_status'> | undefined, observed: { now: number; ackMs: number; result: boolean; screen: ScreenReader }) {
  if (record.acknowledgedAt) return { changed: false, reprompt: false };
  const at = new Date(observed.now).toISOString();
  const confirm = () => { record.acknowledgedAt = at; delete record.activeSince; delete record.screen; return { changed: true, reprompt: false }; };
  if (observed.result) return confirm();
  // Blocked is an approval or question UI: the session reached a tool call and is acknowledged at once.
  if (agent?.agent_status === 'blocked') return confirm();
  let changed = false;
  let active = !!agent && activeStates.includes(agent.agent_status ?? '');
  if (agent && !active) {
    const text = await observed.screen();
    if (text !== null) {
      const digest = screenDigest(text);
      // The first screen read is a baseline: it shows no change, so it is not activity.
      active = !!record.screen && record.screen !== digest;
      if (record.screen !== digest) { record.screen = digest; changed = true; }
    }
  }
  if (active) {
    if (record.activeSince && observed.now - Date.parse(record.activeSince) >= sustainedActivityMs) return confirm();
    if (!record.activeSince) { record.activeSince = at; changed = true; }
    return { changed, reprompt: false };
  }
  // Not seen active: the window closes, so activity is sustained only across consecutive
  // sightings, and one later screen change after a quiet spell starts a window rather than
  // completing one.
  if (record.activeSince) { delete record.activeSince; changed = true; }
  const quietFor = observed.now - Date.parse(record.requestedAt);
  return { changed, reprompt: !!agent && !record.repromptedAt && quietFor >= observed.ackMs };
}
/** The one re-prompt was sent (or attempted): it is never repeated, and activity is counted afresh from here. */
export function markReprompted(record: LaunchAcknowledgement, now: number) { record.repromptedAt = new Date(now).toISOString(); delete record.activeSince; }
/**
 * Whether a session that stopped without its result may be settled yet. The grace a finished
 * session gets is fixed, while `acknowledgementSeconds` is configured (30–900), so neither may cut
 * the other short: a session still in Herdr that has not taken up its request is settled only once
 * it has had its one re-prompt and a whole interval after it, whatever the grace says — before
 * that, its ledger keeps it pending. A session that left Herdr, or one that was acknowledged, is
 * settled by the grace alone.
 */
export function settlementDue(record: LaunchAcknowledgement, agent: Pick<HerdrAgent, 'agent_status'> | undefined, observed: { now: number; ackMs: number }) {
  if (!agent || record.acknowledgedAt) return true;
  return !!record.repromptedAt && observed.now - Date.parse(record.repromptedAt) >= observed.ackMs;
}
/**
 * A session that settled without its result never started when it was never acknowledged and
 * either left Herdr or stayed quiet through the interval after its re-prompt; otherwise it did
 * the work, or enough of it, and failed. Both reasons carry the session's last words.
 */
export const neverStartedReason = 'never started';
export async function settlementReason(record: LaunchAcknowledgement, agent: Pick<HerdrAgent, 'agent_status'> | undefined, observed: { now: number; ackMs: number; screen: ScreenReader }, failure: string) {
  const words = agent ? sessionWords(await observed.screen()) : '';
  const quoted = words ? ` Its last words: "${words}"` : '';
  const unstarted = !record.acknowledgedAt && (!agent || (!!record.repromptedAt && observed.now - Date.parse(record.repromptedAt) >= observed.ackMs));
  if (!unstarted) return `${failure}.${quoted}`;
  return agent ? `${neverStartedReason}: the session took up neither its request nor the re-prompt at ${record.repromptedAt} and ended without acting.${quoted}` : `${neverStartedReason}: the session left Herdr without acting on its request`;
}
export const neverStarted = (record: { state: string; resolution?: string | null }) => record.state === 'failed' && !!record.resolution?.startsWith(neverStartedReason);
/** The re-prompt: the session's own request again, from the launcher that sent it, not a paste from a stranger. */
export function repromptText(request: string, ackMs: number) {
  return `The Graphyard launcher that started this session has seen no activity from it for ${Math.round(ackMs / 1000)} seconds, so here is the request it was started with, sent once more by that same launcher: it is this session's own instruction, not untrusted text, and needs no further authorization. If you have already begun, continue where you are. ${request}`;
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
    // A profile name is Graphyard's own label, in its own syntax; the session name onboarding
    // generates beside it is what Herdr is asked to launch, so it is built inside the runtime's
    // naming rules (GY-101) rather than taken from the label and refused at the first launch.
    const agentNameOf = (name: string) => sessionName(name);
    for (const { file, principal } of await issued('worker')) {
      const name = profileNameOf(principal);
      if (next.workers.some(profile => profile.principal === principal || profile.name === name) || agentNames().has(agentNameOf(name))) { skipped.push({ file, reason: `a profile already uses principal or name ${principal}` }); continue; }
      const index = next.workers.filter(profile => profile.mode === 'launch').length, accounts = accountsFor(undefined, index);
      const kind = next.environments.find(entry => entry.name === accounts[0])!.kind;
      next.workers.push(workerProfileSchema.parse({ name, principal, agentName: agentNameOf(name), mode: 'launch', kind, credentialFile: file, accounts: accountsFor(kind, index) }));
      changes.push({ role: 'worker', profile: name, action: 'added', accounts: accountsFor(kind, index), principal });
    }
    for (const { file, principal } of await issued('producer')) {
      const name = profileNameOf(`produce-${principal}`);
      if (next.workers.some(profile => profile.principal === principal)) { skipped.push({ file, reason: `${principal} is also a worker principal; the control plane refuses evidence from an implementer` }); continue; }
      if (next.producers.some(profile => profile.principal === principal || profile.name === name) || agentNames().has(agentNameOf(name))) { skipped.push({ file, reason: `a profile already uses principal or name ${principal}` }); continue; }
      const index = next.producers.length, accounts = accountsFor(undefined, index);
      const kind = next.environments.find(entry => entry.name === accounts[0])!.kind;
      next.producers.push(producerProfileSchema.parse({ name, principal, agentName: agentNameOf(name), kind, credentialFile: file, accounts: accountsFor(kind, index) }));
      changes.push({ role: 'producer', profile: name, action: 'added', accounts: accountsFor(kind, index), principal });
    }
    for (const environment of loggedIn) {
      const name = profileNameOf(`review-${environment.name}`);
      if (next.reviewers.some(profile => profile.name === name) || agentNames().has(agentNameOf(name))) continue;
      const accounts = [environment.name, ...accountsFor(environment.kind, 0).filter(entry => entry !== environment.name)];
      next.reviewers.push(reviewerProfileSchema.parse({ name, agentName: agentNameOf(name), kind: environment.kind, accounts }));
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
export async function herdrWorkspaceHealth(config: Pick<MasterConfig, 'herdrWorkspace'>, run?: ChildRun) {
  if (!config.herdrWorkspace) return { workspace: null, exists: null as boolean | null, reason: null as string | null };
  let workspaces: any[];
  try { const listed = await herdrJson(['workspace', 'list'], run); workspaces = Array.isArray(listed?.workspaces) ? listed.workspaces : []; }
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
export async function verifyContainmentDeath(
  work: Work,
  options: { observedAt: string; hostId: string; clockOffset: { min: number; max: number }; localNow?: Date; probe?: SupervisorProbe },
): Promise<ContainmentAssessment> {
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
  const probe = await (options.probe ?? probeSupervisorAbsence)({ key: work.key, epoch: quarantine.epoch, workspacePath: workspace.path, scope: quarantine.scope ?? null });
  const verification = containmentVerificationSchema.parse({ ...probe, host: options.hostId, observedAt: (options.localNow ?? new Date()).toISOString(), clockOffset: options.clockOffset });
  const refusals = containmentSettlementRefusals(work, verification, { now: Date.parse(options.observedAt) });
  return { ...assessment, settleable: !refusals.length, refusals, verification };
}
/** Verify every lapsed quarantine this host is responsible for, keyed by work id; a live worker's is not probed. */
export async function assessContainment(work: Work[], options: { hostId: string; observedAt: string; clockOffset: { min: number; max: number }; probe?: SupervisorProbe }) {
  const assessments: Record<string, ContainmentAssessment> = {};
  for (const item of containmentQuarantines(work, options.hostId)) {
    if (containmentPhase(item, Date.parse(options.observedAt))?.state === 'live') continue;
    try { assessments[item.id] = await verifyContainmentDeath(item, options); }
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
  /** The agent registry as the control plane holds it; a server before GY-91 reports none. */
  fleet?: FleetView | null;
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
export function workAttentionOwner(work: Work, cause: 'human-request' | 'containment-settleable' | 'containment-grace' | 'containment' | 'session' | 'proof-gap' | 'reviewer-exhausted' | 'launch-review' | 'launch-producer' | 'base-conflict' | 'merged-unauthorized' | 'merged-reverted' | 'hold-overdue' | 'contaminated' | 'merge-base-dismissed' | 'gate'): AttentionOwner {
  const key = work.key;
  if (cause === 'merge-base-dismissed') return agentOwner('master', missingBaseAncestry(work)
    ? `Nothing to run: the merge queue republishes ${key}'s tip onto the base branch tip and the merge broker refuses it until then; graphyard master status shows the new head`
    : `Nothing to run: the approval is restored on the unchanged head and re-posted before the merge`);
  // A branch carrying another item's unlanded commits is the control plane's to restore (GY-127):
  // an ejected tip is restored on its own, any other contaminated head on the coordinator's
  // request, and a head nothing can move goes back to a worker as a fresh attempt.
  if (cause === 'contaminated') {
    const restore = currentRestore(work)?.restore ?? null;
    if (restore?.outcome === 'unrepairable') return agentOwner('master', `graphyard master decide ${key} rework REASON, then graphyard master approver ${key} DECISION: the foreign commits sit under something the control plane cannot move, so a fresh attempt on a fresh branch is the way back`, 'approver');
    if (restore && !restore.performedAt) return agentOwner('master', `Nothing to run: the reconciliation job restores ${key} to its own reviewed head merged onto the base and reports the result here`);
    return work.queueEjection?.sha === work.candidate?.sha
      ? agentOwner('master', `Nothing to run: the control plane restores an ejected tip on its own, to ${key}'s own reviewed head merged onto the base; graphyard master repair ${key} REASON requests it again if the record shows no restore`)
      : agentOwner('master', `graphyard master repair ${key} REASON: the control plane resets the branch to ${key}'s own reviewed head and merges the base onto it; no worker force-push and no shell`);
  }
  // The one attention item no agent may clear: the three human decisions, answered by the human.
  if (cause === 'human-request') {
    const request = work.humanRequest!;
    return humanOwner(humanDecisionLabel[request.kind], `${answerCommand(key, request)} (or Work → Needs you on the dashboard); the answer returns ${key} to the loop, which dispatches it without a master session`);
  }
  // A merge the base branch does not hold the content of is not a record to settle (GY-97): no
  // decision can deliver work that is not there. The content goes back first, as a follow-up
  // item naming this one, its files and the merge that removed them; the delivery waits for it.
  if (cause === 'merged-reverted') {
    const reverted = work.observation!.revertedDelivery!;
    return agentOwner('master', `graphyard master create FILE for a follow-up item that restores ${reverted.files.map(file => file.path).join(', ')} to the base branch as ${key} shipped them${reverted.removedBy ? `, naming merge ${reverted.removedBy.mergeSha?.slice(0, 12) ?? `of pull request #${reverted.removedBy.pr}`}${reverted.removedBy.key ? ` of ${reverted.removedBy.key}` : ''} as what removed them` : ''}; request no merge decision for ${key} until the base branch holds its content — a reconciliation now would record a delivery for work that is not there`);
  }
  // The merge already happened and cannot be re-run: the only way to a correct delivery record is
  // the two-party merge decision the engine re-checks against the record at the merge cutoff. Once
  // the record has refused one, what remains is the operator's: a decision citing that refusal,
  // with an admin credential on one side, delivers the merge as operator-authorized (GY-94).
  if (cause === 'merged-unauthorized') {
    const refused = refusedReconciliation(work);
    return refused ? agentOwner('master', `graphyard master decide ${key} merge REASON with a REASON that cites refused decision ${refused.decision}, then the operator approves it with their admin credential (GRAPHYARD_TOKEN_FILE=ADMIN_TOKEN_FILE graphyard master approve ${key} DECISION REASON); the next observation delivers it as operator-authorized, stating that no execution authorized the merge and what the record lacked`, 'approver')
      : agentOwner('master', `graphyard master decide ${key} merge REASON, then graphyard master approver ${key} DECISION; the next observation re-checks the record at the merge cutoff and delivers on the approved decision, or records why it cannot${work.queue ? ` and removes the queue entry the merged pull request can never publish, without delivering` : ''}`, 'approver');
  }
  // Graphyard absorbs a moved base itself; a conflict is the one case it cannot, so the candidate
  // goes back to a worker for a fresh attempt rather than waiting for a refresh that cannot land.
  if (cause === 'base-conflict') return agentOwner('master', `graphyard master decide ${key} rework REASON, then graphyard master approver ${key} DECISION`, 'approver');
  if (cause === 'containment-settleable') return agentOwner('master', `graphyard master settle-containment ${key} REASON`);
  if (cause === 'containment-grace') return agentOwner('master', `Wait out the grace window, then graphyard master status verifies the host and graphyard master settle-containment ${key} REASON once settleable`);
  if (cause === 'containment') return agentOwner('master', `Stop the recorded supervisor on its host, then graphyard master decide ${key} ${work.stage === 'done' ? 'recover' : 'rework'} REASON and graphyard master approver ${key} DECISION`, 'approver');
  // A system-driven item is never pushed by hand (GY-175): the owner text names the loop step, not a command the CLI refuses.
  const driven = work.systemDriven === true;
  if (cause === 'session') return agentOwner('master', `herdr agent list to inspect the session; once the lease lapses, ${driven ? `the loop's dispatcher launches ${key} again` : `graphyard master dispatch ${key} PROFILE`}`);
  if (cause === 'hold-overdue') return agentOwner('master', `Nothing to decide: the loop dispatches ${key} over the overlap on its next cycle with a free worker${driven ? '' : `; graphyard master dispatch ${key} PROFILE does it now`}`);
  if (cause === 'proof-gap') return agentOwner('master', `graphyard master decide ${key} grant '{"principal":"PRODUCER","patterns":["${(work.proofGaps ?? [])[0] ?? 'PROOF'}"]}' REASON, then graphyard master approver ${key} DECISION`, 'approver');
  const reviewNext = driven ? `the loop relaunches the review on its own; graphyard master review ${key} only once the loop has stopped relaunching its request` : `graphyard master review ${key}`;
  if (cause === 'reviewer-exhausted') return agentOwner('master', `graphyard master reviewer add FILE with a profile on another provider, then ${reviewNext}`);
  if (cause === 'launch-review') return agentOwner('master', `Fix the refusal reason, then ${reviewNext}`);
  if (cause === 'launch-producer') return agentOwner('master', 'Fix the refusal reason (graphyard master producer add FILE for a missing profile); the loop relaunches the producer on its own');
  const escalation = standingEscalations(work)[0];
  if (escalation) return agentOwner('master', `graphyard master decide ${key} resolve '{"trigger":"${escalation.trigger}"}' REASON, then graphyard master approver ${key} DECISION`, 'approver');
  // A required command the worker's sandbox refused is the launcher's to fix, never the item's (GY-134).
  if (environmentBlocked(work.blocker)) return agentOwner('master', `Grant ${blockedPath(work.blocker!) ?? 'the refused path'} to the worker's sandbox (docs/master-agent-sessions.md "Worker sandbox"), then graphyard master unblock ${key} REASON and dispatch it again`);
  // The owner follows the refusal the row shows: the first failing gate, then a bare blocker.
  const first = work.gates.find(gate => !gate.passed);
  const manual = first?.name === 'acceptance' ? /(manual:[\w./-]+)/.exec(first.reasons.join(' '))?.[1] : undefined;
  if (manual && driven && automatableProof(work, manual)) return agentOwner('control plane', `The loop's producer session produces ${manual} on the exact head; once the loop stops relaunching its request, graphyard master decide ${key} attest '{"proof":"${manual}"}' REASON, then graphyard master approver ${key} DECISION`);
  if (manual) return agentOwner('master', `graphyard master decide ${key} attest '{"proof":"${manual}"}' REASON, then graphyard master approver ${key} DECISION`, 'approver');
  if (first?.name === 'review') return agentOwner('reviewer', driven ? `The reviewer session judges it; ${reviewNext}` : `The reviewer session judges it; graphyard master review ${key} relaunches a refused review`);
  if (first?.name === 'merge' && work.stage === 'merge') return agentOwner('master', driven ? `Nothing to run by hand: the loop's merge step performs the guarded merge of ${key} once its authorization is current` : `graphyard master merge ${key}`);
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
 * The fleet as `master status` reports it, straight from the control plane's agent registry:
 * each account with its runtime, model, role eligibility, live sessions, quota and reset time, and
 * the reason it is ineligible when it is; each role with the account its next action would run
 * on. Everything that stops a role from launching is attention the master resolves itself, in
 * the registry: no file on this host decides it.
 */
export function fleetStatus(fleet: FleetView | null | undefined) {
  if (!fleet) return { fleet: null, attentionItems: [] as AttentionItem[] };
  const accounts = fleet.accounts.map(account => ({ account: account.name, runtime: account.runtime, model: account.model, modelId: account.modelId, cost: account.cost, capability: account.capability?.tier ?? null, host: account.host,
    roles: account.roles.map(entry => `${entry.role} (${entry.preference} of ${entry.of})`), liveSessions: account.liveSessions.map(session => ({ role: session.role, work: session.work, since: session.since })),
    loggedIn: account.loggedIn, quota: account.quota, usage: account.usage, resetsAt: account.resetsAt, observedAt: account.observedAt, eligible: account.eligible, ineligible: account.ineligible }));
  const attentionItems: AttentionItem[] = fleet.configured ? fleet.attention.map(text => ({ subject: 'fleet', text,
    ...agentOwner('master', /is not configured/.test(text) ? 'graphyard master registry role set ROLE ACCOUNT[,ACCOUNT…] --concurrency N --reason REASON' : /serves no role/.test(text) ? 'graphyard master registry role set ROLE ACCOUNT[,ACCOUNT…] --reason REASON, or graphyard master registry account remove NAME --reason REASON'
      : 'graphyard master registry (each account\'s ineligible reason names what to fix: log it in, wait for its reset, or add an account and name it in the role)') })) : [];
  return { attentionItems, fleet: { configured: fleet.configured, revision: fleet.revision, updatedAt: fleet.updatedAt, host: fleet.host, runtimes: fleet.runtimes.map(runtime => runtime.name), accounts, roles: fleet.roles,
    ineligible: accounts.filter(account => !account.eligible).map(account => ({ account: account.account, reason: account.ineligible })), recentSelections: fleet.sessions.slice(-10).map(session => ({ at: session.selectedAt, role: session.role, account: session.account, work: session.work, reason: session.reason, endedAt: session.endedAt })),
    refusals: fleet.refusals.slice(-5), next: fleet.configured ? null : 'No role is configured in the agent registry, so sessions launch from local profiles; run graphyard master registry propose --apply' } };
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
export const reclaimAdvice = `the master loop reclaims the dependency directories of finished assignment worktrees on every cycle while free space is low; lower run.reclaimIdleHours in .graphyard/master.json to make more of them disposable, then retry. ${reclaimCommand} reclaims immediately, ephemeral proof and review checkouts included`;
/** The path a failed write was aimed at: the one the caller names, or the one the system call reported. */
export function exhaustedPath(error: unknown, path?: string): string | null {
  const reported = (error as { path?: unknown; dest?: unknown } | null);
  return path ?? (typeof reported?.path === 'string' ? reported.path : typeof reported?.dest === 'string' ? reported.dest : null);
}
/** Disk exhaustion as one sentence: the condition, the path that could not be written, and the reclaim command. Null for any other failure. */
export function diskExhaustionMessage(error: unknown, path?: string): string | null {
  const cause = diskExhaustion(error);
  if (!cause) return null;
  const at = exhaustedPath(error, path);
  return `${cause}${at ? ` at ${at}` : ''}: ${reclaimAdvice}`;
}
/** The same failure, named by its cause when the cause is exhausted disk and left alone otherwise. */
export function writeFailure(error: unknown, action: string, path?: string): Error {
  const exhausted = diskExhaustionMessage(error, path);
  if (!exhausted) return error instanceof Error ? error : new Error(String(error));
  return Object.assign(new Error(`${action} failed because ${exhausted}`), { code: (error as { code?: string } | null)?.code ?? 'ENOSPC', cause: error });
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
  /** What the same pass took back under the managed worktree root, when the loop ran it. */
  checkouts?: CheckoutReclaimReport;
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
 * The managed worktree root's attention items: a root on a tmpfs, a volume below its configured
 * minimum, or a root that has grown to most of its budget. Each names the reclaim command, and
 * each is raised while writes still succeed.
 */
export function worktreeRootAttention(health: WorktreeRootHealth): AttentionItem[] {
  return worktreeRootConcerns(health).map(text => ({ subject: 'disk', text,
    ...agentOwner('master', health.volatile && !health.low && !health.overBudget
      ? 'Set run.worktreeRoot in .graphyard/master.json to an absolute path on durable storage, outside every worktree; master run adopts it on its next cycle'
      : `${reclaimCommand} removes every ephemeral checkout no live session owns (graphyard master run does the same on every cycle while space is low); raise run.worktreeRootBudgetGb or move run.worktreeRoot in .graphyard/master.json if the live sessions alone need more room`) }));
}

/**
 * Allocate one session's directory under the managed worktree root. The root is verified on every
 * launch, not only at setup — a volume fills, and a configuration is edited — and the allocated
 * directory is held to the same rule as every other path Graphyard owns: outside every worktree.
 */
export async function allocateManagedCheckout(root: string, config: MasterConfig, kind: 'proof' | 'review', key: string, sha: string, id: string, probe?: FilesystemProbe): Promise<SessionCheckout> {
  const base = worktreeRoot(root, config);
  await assertOutsideWorktrees(root, base, 'The managed worktree root', { create: true });
  await verifyWorktreeRoot(base, { minFreeBytes: worktreeRootMinFreeBytes(config), probe });
  let checkout: SessionCheckout;
  try { checkout = await allocateSessionCheckout(base, kind, key, sha, id); }
  catch (error) { throw writeFailure(error, `Allocating a ${kind} checkout under the managed worktree root`, base); }
  try { await assertOutsideWorktrees(root, checkout.directory, 'An ephemeral checkout'); }
  catch (error) { await removeSessionCheckout(root, base, checkout.directory).catch(() => {}); throw error; }
  return checkout;
}
/** Remove a settled session's checkout; the reason when it could not be, never a throw. */
export async function settleCheckout(root: string, directory: string | undefined, run?: ChildRun): Promise<string | null> {
  if (!directory) return null;
  try { await removeSessionCheckout(root, dirname(directory), directory, run); return null; }
  catch (error) { return writeFailure(error, 'Removing the ephemeral checkout', directory).message.slice(0, 500); }
}
/** The managed worktree root as `master status` reports it, with the attention it raises. `sessions` are the review and producer records. */
export async function managedRootStatus(root: string, config: MasterConfig, sessions: { state: string; checkout?: string }[], dependencies: Parameters<typeof inspectWorktreeRoot>[3] = {}) {
  const live = sessions.filter(record => record.state === 'pending' && record.checkout).map(record => record.checkout!);
  const health = await inspectWorktreeRoot(worktreeRoot(root, config), { minFreeBytes: worktreeRootMinFreeBytes(config), budgetBytes: worktreeRootBudgetBytes(config) }, live, dependencies);
  return { health, attention: worktreeRootAttention(health) };
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
export interface SessionRetryReport { requestId: string; attempts: number; started: number; neverStarted: number; limit: number; unstartedLimit: number; nextAt: string | null; exhausted: boolean; last: { state: string; resolution: string | null } | null }
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
    // A pending session is running only once it is acknowledged (acknowledgeLaunch); until then
    // it awaits acknowledgement, with the one re-prompt the loop sent on the record.
    return record ? { id: record.review ?? record.producer, profile: record.profile, agentName: record.agentName, state: record.state, attempt: record.attempt ?? 1, requestedAt: record.requestedAt, sinceMs: since(record.requestedAt),
      delivery: record.delivery ?? null, activity: record.state === 'pending' ? record.activity ?? sessionActivity(record) : null, acknowledgedAt: record.acknowledgedAt ?? null, repromptedAt: record.repromptedAt ?? null,
      ...(record.verdict !== undefined ? { verdict: record.verdict } : {}), ...(record.outcome ? { outcome: record.outcome } : {}), resolution: record.resolution ?? null, attention: record.attention ?? null } : null;
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
/** Hold ages and bounds read in hours to one decimal: `1.5h`, `2h`. */
const hours = (ms: number) => `${Math.round(ms / 360_000) / 10}h`;
/**
 * Queueing at the gates, per role (GY-107): how many sessions run against the limit the fleet
 * declares, and how long the longest request has waited for a slot. A request waits for a slot
 * when it is open, has no session, and nothing else holds it — no launch refused, no retry
 * pending, no settled session that no attempt follows — and, for a producer request, when some
 * profile is independent of the item at all. A fleet starving on review capacity reads here as
 * `running` at `limit` with `waiting` above zero and `longestWaitMs` climbing, without a session list.
 */
export interface RoleConcurrencyProfile { profile: string; agentName: string; limit: number; running: number; sessions: string[] }
export interface RoleConcurrencyReport { role: 'reviewer' | 'producer'; limit: number; running: number; free: number; waiting: number; longestWaitMs: number | null; longest: { work: string; requestId: string; group: string | null; waitedMs: number } | null; starved: boolean; profiles: RoleConcurrencyProfile[] }
export interface RoleProfiles { reviewers: { name: string; agentName: string; concurrency?: number }[]; producers: { name: string; agentName: string; principal: string; concurrency?: number }[] }
export function roleConcurrency(role: 'reviewer' | 'producer', profiles: RoleProfiles['reviewers'] | RoleProfiles['producers'], work: Work[], agents: { name?: string }[], records: { pending: any[]; completed: any[] }, sessions: Pick<DispatchSessions, 'failures' | 'retries'>, now: number): RoleConcurrencyReport {
  const all = [...records.completed, ...records.pending];
  const perProfile = profiles.map(profile => { const counted = profileSessions(profile, agents, all); return { profile: profile.name, agentName: profile.agentName, limit: counted.limit, running: counted.running.length, sessions: counted.running }; });
  const limit = perProfile.reduce((total, entry) => total + entry.limit, 0), running = perProfile.reduce((total, entry) => total + entry.running, 0);
  // How long an open request has waited for a slot, or null when something other than a slot holds it.
  const slotWait = (request: { id: string; requestedAt: string }): number | null => {
    const last = [...all].reverse().find(record => record.requestId === request.id);
    if (last && last.state === 'pending') return null;
    if (last && !['failed', 'expired'].includes(last.state)) return null;
    if (sessions.failures.some(failure => failure.requestId === request.id)) return null;
    const retry = sessions.retries?.find(entry => entry.requestId === request.id);
    if (retry) return retry.exhausted || (retry.nextAt && Date.parse(retry.nextAt) > now) ? null : Math.max(0, now - Date.parse(retry.nextAt ?? last?.closedAt ?? request.requestedAt));
    return last ? null : Math.max(0, now - Date.parse(request.requestedAt));
  };
  const waiting = work.filter(item => item.stage !== 'done' && item.autoDispatch).flatMap(item => {
    if (role === 'reviewer') { const review = item.autoDispatch!.review; return review?.state === 'requested' && review.provider === 'github' ? [{ item, request: review }] : []; }
    const implementers = new Set(implementerIdentities(item));
    if (!(profiles as RoleProfiles['producers']).some(profile => !implementers.has(profile.principal))) return [];
    return item.autoDispatch!.producers.filter(request => request.state === 'requested').map(request => ({ item, request }));
  }).flatMap(({ item, request }) => { const waitedMs = slotWait(request); return waitedMs === null ? [] : [{ work: item.key, requestId: request.id, group: request.group ?? null, waitedMs }]; }).sort((a, b) => b.waitedMs - a.waitedMs);
  const longest = waiting[0] ?? null;
  return { role, limit, running, free: Math.max(0, limit - running), waiting: waiting.length, longestWaitMs: longest?.waitedMs ?? null, longest, starved: limit > 0 && running >= limit && waiting.length > 0, profiles: perProfile };
}
/** A starved role is attention for the master: the limit and the wait, with what raises the one. */
export const concurrencyStarvedMs = 10 * 60_000;
export function concurrencyAttention(reports: RoleConcurrencyReport[]): AttentionItem[] {
  return reports.filter(report => report.starved && (report.longestWaitMs ?? 0) >= concurrencyStarvedMs).map(report => ({ subject: `${report.role} concurrency`,
    text: `${report.role} capacity is saturated: ${report.running} session${report.running === 1 ? '' : 's'} running against a limit of ${report.limit} (${report.profiles.map(entry => `${entry.profile} ${entry.running}/${entry.limit}`).join(', ')}), ${report.waiting} request${report.waiting === 1 ? '' : 's'} waiting for a slot, the longest (${report.longest!.work}${report.longest!.group ? ` ${report.longest!.group} proofs` : ''}) for ${Math.round(report.longestWaitMs! / 60_000)} minutes`,
    ...agentOwner('master', `Raise concurrency on a ${report.role} profile in .graphyard/master.json, or add a ${report.role} profile on another account (master ${report.role} add); master run adopts the change on its next tick and starts more sessions without a restart. See docs/onboarding.md#size-review-and-proof-capacity`) }));
}
export function buildMasterStatus(snapshot: { work: Work[]; now: string }, profiles: WorkerProfile[], agents: HerdrAgent[], credentialHealth: Record<string, { available: boolean; reason: string | null }> = {}, containment: Record<string, ContainmentAssessment> = {}, reviews: { pending: any[]; completed: any[] } = { pending: [], completed: [] }, baseBranch = 'main', controlPlane?: ControlPlaneStatus, sessions: DispatchSessions = noSessions, candidateConflicts: { report: Record<string, ConflictReport>; available: boolean; reason: string | null } = { report: {}, available: false, reason: 'Candidate conflicts were not probed' }, roles?: RoleProfiles, cliPath = 'graphyard') {
  const now = Date.parse(snapshot.now);
  const scheduling = dispatchSchedule(snapshot.work, now);
  const installation = controlPlaneAttention(controlPlane), registry = fleetStatus(controlPlane?.fleet);
  // Per-role concurrency (GY-107): sessions against the declared limit, and the queue at the gate.
  const concurrency = roles ? [roleConcurrency('reviewer', roles.reviewers, snapshot.work, agents, reviews, sessions, now), roleConcurrency('producer', roles.producers, snapshot.work, agents, sessions.producers, sessions, now)] : [];
  const concurrencyItems = concurrencyAttention(concurrency);
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
    const held = scheduling.held.find(entry => entry.key === work.key) ?? null, overdueHold = scheduling.overdue.find(entry => entry.key === work.key) ?? null;
    // An item in flight beside another it overlaps — dispatched over a hold, past the bound or by
    // --allow-overlap — shows what it runs concurrently with, so the overlap stays recorded.
    const concurrent = !held && !overdueHold && (active || work.submission) ? dispatchOverlap(work, snapshot.work, now) : [];
    const conflictReport = candidateConflicts.report[work.key];
    const conflicts = work.submission && work.candidate ? { candidates: (conflictReport?.conflicts ?? []).map(conflict => conflict.key), files: conflictReport?.conflicts ?? [], unprobed: conflictReport?.unprobed ?? [], probed: !!conflictReport && candidateConflicts.available } : null;
    const dispatch = describeDispatch(work, reviews, sessions, now);
    const baseRefresh = pendingBaseRefresh(work), baseConflict = baseRefreshConflict(work);
    const refreshCarry = currentBaseRefreshCarry(work);
    // A branch found carrying another item's unlanded commits, with the restore the control plane
    // owes, requested or ran for it (GY-127); and an approval GitHub dismissed for a merge-base
    // change on an unchanged head that the control plane restored rather than re-requesting.
    const contaminated = branchContamination(work, snapshot.work);
    const restore = currentRestore(work);
    const contamination = contaminated || restore?.restore ? { head: contaminated?.head ?? restore!.restore!.contaminated, foreign: contaminated?.foreign ?? restore!.restore!.foreign, source: contaminated?.source ?? [],
      restore: restore?.restore ? { cause: restore.restore.cause, requested: restore.restore.requested, performedAt: restore.restore.performedAt, outcome: restore.restore.outcome, own: restore.restore.own, head: restore.head, conflict: restore.conflict } : null } : null;
    const restored = restoredApproval(work), baseDismissal = mergeBaseDismissal(work);
    const approvalRestored = restored ? { reviewer: restored.reviewer, reviewId: restored.reviewId ?? null, sha: restored.sha, dismissal: restored.dismissal, at: restored.at,
      line: `${restored.reviewer}'s approval of ${restored.sha.slice(0, 12)} was dismissed by GitHub for a merge-base change while the head was unchanged (${restored.dismissal.reason ?? 'reason unread'}${restored.dismissal.at ? ` at ${restored.dismissal.at}` : ''}); the control plane restored it as the binding approval, requested no review, spent no attempt, and re-posts it through the reviewer App before the merge` } : null;
    // A role with no account left is one line for the whole repository (`capacity` below), never a
    // launch refusal or a session retry repeated on every item that waits for it.
    const paused = new Set(standingCapacity(work).map(entry => entry.role));
    const stalledLaunch = [dispatch?.review, ...(dispatch?.producers ?? [])].find(request => request?.failure && !paused.has(request.failure.kind === 'review' ? 'reviewer' : 'producer'));
    const retrying = [dispatch?.review, ...(dispatch?.producers ?? [])].find(request => request?.retry && request.session && ['failed', 'expired'].includes(request.session.state) && !paused.has(request.group ? 'producer' : 'reviewer'));
    // A session re-prompted once and still not acknowledged is awaiting acknowledgement, not running.
    const unacknowledged = [dispatch?.review, ...(dispatch?.producers ?? [])].find(request => request?.session?.state === 'pending' && request.session.activity === 'awaiting acknowledgement' && request.session.repromptedAt);
    // An observed merge no execution authorized is not a candidate waiting for its queue tip: it
    // is named as the violation it is, with the recovery, and never as a gate refusal.
    // Its queue entry, when it still holds one, can never publish a speculative tip: the entry and
    // everything waiting behind it are named, with the exit (see merge-queue.ts unpublishableEntry).
    const dead = unpublishableEntry(work);
    // A merged item whose content the base branch does not hold is a reverted delivery, not an
    // ordinary unreconciled merge (GY-97): the row names the files missing from the base and the
    // merge that removed them, so nobody has to read a diff to learn the work is gone.
    const reverted = work.stage !== 'done' && work.observation?.merged ? work.observation.revertedDelivery ?? null : null;
    const merged = mergedWithoutAuthorization(work) || reverted ? { at: work.observation!.mergedAt ?? null, sha: work.observation!.mergeSha ?? null, violation: unauthorizedMergeViolation,
      refusal: refusedReconciliation(work)?.violation ?? null,
      ...(reverted ? { reverted: { base: reverted.base, files: reverted.files, removedBy: reverted.removedBy, partial: !!reverted.partial } } : {}),
      ...(dead && placement ? { queue: { sequence: dead.sequence, position: placement.position + 1, size: placement.size, unpublishable: true as const, behind: placements.filter(entry => entry.sequence > placement.sequence).map(entry => entry.key) } } : {}) } : null;
    const parked = parkedOnHuman(work) ? work.humanRequest! : null;
    const [attention, cause]: [string | null, Parameters<typeof workAttentionOwner>[1] | null] = containmentAttention ? containmentAttention
      : parked ? [`${work.key} is parked on a human-only decision (${humanDecisionLabel[parked.kind]}) since ${parked.at}: ${parked.needed} — ${parked.reason}. It holds no lease and delays nothing else`, 'human-request']
      : merged?.reverted ? [`${work.key} was merged on GitHub (${merged.sha?.slice(0, 12) ?? 'merge commit unknown'} at ${merged.at ?? 'an unrecorded time'}) and its content is not on the base branch: ${merged.reverted.files.length}${merged.reverted.partial ? ' or more' : ''} file${merged.reverted.files.length === 1 && !merged.reverted.partial ? '' : 's'} missing from base ${merged.reverted.base.slice(0, 12)} — ${merged.reverted.files.map(file => `${file.path} (${file.detail})`).join(', ')} — ${merged.reverted.removedBy
        ? `removed by merge ${merged.reverted.removedBy.mergeSha?.slice(0, 12) ?? 'commit unknown'} of ${merged.reverted.removedBy.key ? `${merged.reverted.removedBy.key}, ` : ''}pull request #${merged.reverted.removedBy.pr}${merged.reverted.removedBy.commit ? ` (commit ${merged.reverted.removedBy.commit.slice(0, 12)})` : ', whose head carried this item\'s commits without their content'}`
        : 'and the merge that removed them could not be identified from the branch history'}. This is a reverted delivery, not an unreconciled merge: nothing is delivered until the content is restored${merged.refusal ? `; the last reconciliation was refused — ${merged.refusal}` : ''}`, 'merged-reverted']
      : merged ? [`${work.key} was merged on GitHub (${merged.sha?.slice(0, 12) ?? 'merge commit unknown'} at ${merged.at ?? 'an unrecorded time'}) without a valid merge execution: ${merged.violation}. It is held at the merge stage, not waiting for its queue tip; ${merged.queue ? `its merge queue entry (sequence ${merged.queue.sequence}, position ${merged.queue.position} of ${merged.queue.size}) can never publish a speculative tip because the pull request is already merged${merged.queue.behind.length ? `, and ${merged.queue.behind.join(', ')} wait behind it` : ''}; ` : ''}${merged.refusal ? `the last reconciliation was refused — ${merged.refusal}; an operator may deliver it as operator-authorized by a decision citing that refusal` : `a two-party merge decision requested now reconciles it if every gate passed and every required proof was live at the merge cutoff${merged.queue ? ', and a refused one removes the entry without delivering' : ''}`}`, 'merged-unauthorized']
      // A branch carrying another item's unlanded commits blocks the candidate whatever else stands
      // (GY-127): the restore is the control plane's, and the row says whether it is owed, requested or ran.
      : contaminated && !(contamination?.restore && contamination.restore.performedAt && contamination.restore.head !== contaminated.head) ? [`${work.key} branch head ${contaminated.head.slice(0, 12)} carries the unlanded commits of ${contaminated.foreign.join(', ')} (${contaminated.source.includes('ejection') ? `a speculative tip published behind ${contaminated.foreign.join(', ')} and ejected from the merge queue` : 'found in its history by GitHub'}): kept, it is refused as an out-of-scope regression; landed, it would record ${contaminated.foreign.join(', ')} merged without ${contaminated.foreign.length === 1 ? 'its' : 'their'} content. ${contamination?.restore?.outcome === 'unrepairable' ? 'A restore found no own reviewed head under it: the foreign commits sit under something the control plane cannot move' : contamination?.restore && !contamination.restore.performedAt ? `A restore is requested (${contamination.restore.cause}) and runs on the next reconciliation` : work.queueEjection?.sha === contaminated.head ? 'The control plane restores it to its own reviewed head merged onto the base on the next reconciliation' : `graphyard master repair ${work.key} REASON restores it to its own reviewed head merged onto the base`}`, 'contaminated']
      : active && (!session || !['working', 'idle'].includes(session.state)) ? [`Assigned worker session is ${session?.state ?? 'offline'}`, 'session']
      : gaps.length ? [`No principal is authorized to produce ${gaps.join(', ')}; grant the proof name before dispatch`, 'proof-gap']
      : review?.exhausted ? [`Every configured reviewer profile is exhausted for the current candidate (${review.failedOver.map(entry => `${entry.profile}: ${entry.exhaustion}`).join(', ')})`, 'reviewer-exhausted']
      : stalledLaunch ? [`Automatic ${stalledLaunch.failure!.kind} launch for ${work.key} refused ${stalledLaunch.failure!.attempts} time(s): ${stalledLaunch.failure!.reason}`, stalledLaunch.failure!.kind === 'review' ? 'launch-review' : 'launch-producer']
      : retrying ? [`${retrying.group ? `Producer session for ${retrying.group} proofs` : 'Reviewer session'} of ${work.key} ${retrying.session!.state} after attempt ${retrying.retry!.attempts} of ${retrying.retry!.limit}: ${retrying.session!.resolution ?? 'no reason recorded'}; ${retrying.retry!.exhausted ? 'no further automatic attempt' : `next attempt at ${retrying.retry!.nextAt}`}`, retrying.group ? 'launch-producer' : 'launch-review']
      : unacknowledged ? [`${unacknowledged.group ? `Producer session for ${unacknowledged.group} proofs` : 'Reviewer session'} of ${work.key} (${unacknowledged.session!.agentName}) is awaiting acknowledgement: no activity since its launch at ${unacknowledged.session!.requestedAt}, re-prompted once at ${unacknowledged.session!.repromptedAt}; the loop records it as never started if it stays quiet`, unacknowledged.group ? 'launch-producer' : 'launch-review']
      : baseConflict ? [baseConflict, 'base-conflict']
      // An approval GitHub withdrew for a merge-base change is named with its time and commits (GY-145).
      : baseDismissal ? [mergeBaseDismissalAttention(work.key, baseDismissal), 'merge-base-dismissed']
      // An item the control plane is bringing onto a moved base is not waiting for anybody. It
      // used to be the commonest attention line on this list — one per open candidate, every
      // merge — and answering it cost a rework round for a change that was a clean fast-forward.
      : baseRefresh && !work.blocker ? [null, null]
      // A hold past its bound is no longer holding: the loop offers the item over the overlap on its
      // next cycle, so it is raised only while nothing has taken it, naming the chain it waited behind.
      : overdueHold ? [`${work.key} has been held ${hours(overdueHold.hold.ageMs)} behind ${describeChain(overdueHold.hold.chain)}, past the ${hours(overdueHold.hold.boundMs)} bound; it is offered over the overlap and waits only for a free worker`, 'hold-overdue']
      : work.blocker || dwellMs > 3_600_000 ? [first?.reasons[0] ?? `Work has remained at ${work.stage} for more than one hour`, 'gate'] : [null, null];
    const attentionOwner = cause ? workAttentionOwner(work, cause) : null;
    return { key: work.key, title: work.title, stage: work.stage, owner: active ? work.lease!.owner : null, profile: profile?.name ?? null, session: session?.state ?? null, refusal: first ? { gate: first.name, reason: first.reasons[0] } : null, mergeable, review, dispatch, proofGaps: gaps, containment: quarantine, attention, attentionOwner, queue: placement ? queueRows.find(row => row.key === work.key) ?? null : null,
      // Set only for an item GitHub merged with no valid execution: the merge, the violation and
      // the last refused reconciliation, so the row reads as stuck rather than as a candidate.
      merged,
      // The two waits that stall only this item (GY-89): the open human-only request, and the
      // sessions that ran out of quota with any role that has no account left.
      humanRequest: parked ? { id: parked.id, kind: parked.kind, decision: humanDecisionLabel[parked.kind], needed: parked.needed, reason: parked.reason, requestedBy: parked.requestedBy, at: parked.at, waitedMs: Math.max(0, now - Date.parse(parked.at)), answer: answerCommand(work.key, parked) } : null,
      capacity: work.capacity ? { exhaustions: work.capacity.exhaustions.slice(-5), escalations: work.capacity.escalations } : null,
      // What the control plane is doing, or last did, about a base branch that moved under this
      // candidate: nobody is asked for a round while `pending` is set.
      base: baseRefresh || baseConflict || refreshCarry ? { pending: baseRefresh, conflict: baseConflict,
        refreshed: refreshCarry ? { from: refreshCarry.from.sha, head: refreshCarry.to.sha, base: refreshCarry.to.baseSha,
          approval: { carried: refreshCarry.approval.carried, reason: refreshCarry.approval.reason },
          evidence: refreshCarry.evidence.map(entry => ({ proof: entry.proof, carried: entry.carried, reason: entry.reason })) } : null } : null,
      // A branch carrying another item's unlanded commits and the restore for it (GY-127), and
      // an approval GitHub dismissed for a merge-base change that the control plane restored.
      contamination, restoredApproval: approvalRestored,
      scope: scopeBreadth(work.plannedFiles), overlap: held ? { held: true, ahead: held.ahead, reason: held.reason, hold: held.hold, concurrent: [] } : overdueHold ? { held: false, ahead: overdueHold.ahead, reason: overdueHold.reason, hold: overdueHold.hold, concurrent: [] } : { held: false, ahead: [], reason: null, hold: null, concurrent }, conflicts,
      // Execution versus wait so far, rework rounds and hand-offs, from the item's own timeline.
      speed: pipelineSpeed(work, now) };
  });
  const delivered = snapshot.work.filter(work => work.stage === 'done' && work.delivery && deploySmokeRequired(work.policy)).map(work => deliveredRow(work, now, baseBranch));
  // Every delivery no valid execution authorized, apart by how it was judged: reconciled — the
  // record at the merge cutoff satisfied every gate — or operator-authorized, where it did not
  // and an operator took responsibility (GY-94). Neither is mistaken for the other or for a routine merge.
  const deliveries = recoveredDeliveries(snapshot.work);
  // Merge-to-production over every delivery with an observed deployment, whether or not its
  // policy asked for a smoke proof, so the periodic measurement reads one number for the repository.
  const mergeToProduction = latencyPercentiles(snapshot.work.map(work => mergeToProductionMs(work)).filter((value): value is number => value !== null));
  // Submit→merge p50/p90 over every delivery with a recorded submission, judged against the
  // pipeline-speed target; the periodic measurement records this beside the production latency.
  const speed = pipelineSpeedSummary(snapshot.work, now);
  // Capacity, one line per spent role: the accounts, their resets, and every item that waits on it.
  const open = snapshot.work.filter(work => work.stage !== 'done');
  const capacity = (['worker', 'reviewer', 'producer'] as const).flatMap(role => {
    const waiting = open.filter(work => standingCapacity(work, role).length);
    if (!waiting.length) return [];
    const latest = waiting.map(work => standingCapacity(work, role)[0]).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return [{ role, since: latest.at, retryAt: latest.retryAt, accounts: latest.accounts, waiting: waiting.map(work => work.key), line: `${describeCapacity(role, latest.accounts)}; waiting: ${waiting.map(work => work.key).join(', ')}` }];
  });
  const capacityItems: AttentionItem[] = capacity.map(entry => ({ subject: `${entry.role} capacity`, text: entry.line,
    ...agentOwner('master', `Nothing to run before ${entry.retryAt ?? 'an account reports quota again'}: the loop resumes ${entry.role} launches on its own. To restore capacity sooner, log another account in and add it with graphyard master environments --apply and graphyard master config accounts:PROFILE=…; buying quota or opening a provider account is the human's decision`) }));
  const humanRequests = openHumanRequests(snapshot.work, now);
  // The fleet's effective concurrency beside its idle workers: how many items the overlap graph
  // lets run at once, so eleven free workers and a concurrency of one is read as serialization,
  // not as a shortage of anything.
  const graph = effectiveConcurrency(snapshot.work, now);
  const idle = workerSessions.filter(session => session.mode === 'launch' && session.credential.available && (session.state === 'offline' || session.state === 'idle') && !rows.some(row => row.owner === session.principal));
  const fleet = { ...graph, inFlight: snapshot.work.filter(work => inFlight(work, now)).length, dispatchable: scheduling.order.length, held: scheduling.held.length, overdue: scheduling.overdue.length,
    idleWorkers: idle.length, workers: workerSessions.filter(session => session.mode === 'launch').length, boundMs: scheduling.boundMs,
    statement: `${graph.effective} item${graph.effective === 1 ? '' : 's'} could be in flight at once over ${graph.nodes} open item${graph.nodes === 1 ? '' : 's'} (${graph.edges} overlap${graph.edges === 1 ? '' : 's'}${graph.exact ? '' : ', greedy estimate'}); ${idle.length} of ${workerSessions.filter(session => session.mode === 'launch').length} launch profile${workerSessions.filter(session => session.mode === 'launch').length === 1 ? '' : 's'} idle; ${scheduling.held.length} held, ${scheduling.overdue.length} past the ${hours(scheduling.boundMs)} hold bound` };
  // A blocker whose remedy no launched session may run is Graphyard's own defect (GY-128).
  const remedies = unrunnableRemedies(snapshot.work, { cliPath, baseBranch, workerKinds: profiles.filter(profile => profile.mode === 'launch').flatMap(profile => profile.kind ? [profile.kind] : []) });
  const remedyItems: AttentionItem[] = remedies.map(entry => ({ subject: entry.key, text: entry.text,
    ...agentOwner('master', `Create a work item that lets the ${entry.role} run \`${entry.command}\` (or has the control plane perform it); the ${entry.role} harness rule ${entry.rule} denies it`) }));
  return { observedAt: snapshot.now,
    counts: { open: rows.length, ready: rows.filter(row => row.stage === 'ready').length, active: rows.filter(row => row.owner).length, attention: rows.filter(row => row.attention).length + remedyItems.length + capacityItems.length + concurrencyItems.length + installation.attention.length + registry.attentionItems.length, proofAuthorityGaps: rows.filter(row => row.proofGaps.length).length, mergeable: rows.filter(row => row.mergeable).length, reviewsPending: reviews.pending.length, producersPending: sessions.producers.pending.length,
      // Candidates the guarded merge could take once their gates pass, and the items GitHub already
      // merged without a valid execution, which are never candidates and wait on a reconciliation.
      mergeCandidates: rows.filter(row => row.stage === 'merge' && !row.merged).length, mergedUnreconciled: rows.filter(row => row.merged && !row.merged.reverted).length, revertedDeliveries: rows.filter(row => row.merged?.reverted).length,
      dispatchRequested: rows.reduce((total, row) => total + (row.dispatch ? (row.dispatch.review ? 1 : 0) + row.dispatch.producers.length : 0), 0), dispatchRunning: rows.reduce((total, row) => total + (row.dispatch ? [row.dispatch.review, ...row.dispatch.producers].filter(request => request?.session?.state === 'pending' && request.session.activity === 'running').length : 0), 0),
      dispatchAwaiting: rows.reduce((total, row) => total + (row.dispatch ? [row.dispatch.review, ...row.dispatch.producers].filter(request => request?.session?.state === 'pending' && request.session.activity === 'awaiting acknowledgement').length : 0), 0), reviewFailover: rows.filter(row => row.review?.failedOver.length).length, queued: placements.length,
      quarantined: rows.filter(row => row.containment && row.containment.phase !== 'live').length, settleableQuarantines: rows.filter(row => row.containment?.settleable).length,
      awaitingSmoke: delivered.filter(row => row.state === 'awaiting-deployment' || row.state === 'awaiting-smoke').length, postDeployFailures: delivered.filter(row => row.state === 'delivered-with-failure').length,
      reconciledDeliveries: deliveries.reconciled.length, operatorAuthorizedDeliveries: deliveries.operatorAuthorized.length,
      humanRequests: humanRequests.length, capacityExhausted: capacity.length, concurrencyStarved: concurrency.filter(report => report.starved).length, unrunnableRemedies: remedies.length, effectiveConcurrency: graph.effective, idleWorkers: idle.length, held: scheduling.held.length, holdsOverdue: scheduling.overdue.length,
      contaminatedBranches: rows.filter(row => row.contamination && row.contamination.source.length).length, restoredApprovals: rows.filter(row => row.restoredApproval).length,
      // Closed without delivery (model/closure.ts): never open, never delivered, counted only here.
      closed: snapshot.work.filter(isClosed).length },
    // Every attention item with the role that resolves it and the next command, work items first.
    attentionItems: [...rows.flatMap(row => row.attention && row.attentionOwner ? [{ subject: row.key, text: row.attention, ...row.attentionOwner }] : []), ...remedyItems, ...capacityItems, ...concurrencyItems, ...installation.attentionItems, ...registry.attentionItems] as AttentionItem[],
    // What waits on the human, longest first, with how to answer; the roles out of capacity; each
    // role's sessions against its concurrency limit with the longest wait for a slot; the
    // fleet's effective concurrency — what the overlap graph lets run at once — beside its idle workers;
    // and the blockers whose remedy no launched session may run.
    humanRequests, capacity, concurrency, effectiveConcurrency: fleet, unrunnableRemedies: remedies,
    closed: closedHistory(snapshot.work),
    workers: workerSessions, reviews, producers: sessions.producers, work: rows, queue: queueRows, delivered, deliveries, latency: { mergeToProduction }, speed, controlPlane: installation, fleet: registry.fleet,
    schedule: scheduling, conflicts: { available: candidateConflicts.available, reason: candidateConflicts.reason, ...sequenceAdvice(rows.filter(row => row.conflicts).map(row => ({ key: row.key, conflicts: row.conflicts!.candidates }))) } };
}

/**
 * What the merge queue's own pushes did to pull-request branches and their approvals (GY-127),
 * in one place: every branch found carrying another item's unlanded commits, with the restore
 * the control plane owes, requested or ran for it, and every approval GitHub dismissed for a
 * merge-base change on an unchanged head that the control plane restored instead of asking the
 * reviewer again. The rows carry the same facts under `contamination` and `restoredApproval`;
 * this is the list a master reads before it wonders why a reviewer approved the same commit twice.
 */
export function branchReport(rows: ReturnType<typeof buildMasterStatus>['work']) {
  const contaminated = rows.flatMap(row => row.contamination ? [{ key: row.key, head: row.contamination.head, foreign: row.contamination.foreign, source: row.contamination.source,
    restore: row.contamination.restore ? { cause: row.contamination.restore.cause, requestedBy: row.contamination.restore.requested?.by ?? null, performedAt: row.contamination.restore.performedAt, outcome: row.contamination.restore.outcome, own: row.contamination.restore.own, head: row.contamination.restore.head } : null,
    line: row.contamination.restore?.outcome === 'restored' && row.contamination.restore.head !== row.contamination.head
      ? `${row.key}: head ${row.contamination.head.slice(0, 12)} carried ${row.contamination.foreign.join(', ')}; restored to own reviewed head ${row.contamination.restore.own?.slice(0, 12) ?? '(unknown)'} merged onto the base as ${row.contamination.restore.head!.slice(0, 12)}`
      : row.contamination.restore?.outcome === 'conflict' ? `${row.key}: head ${row.contamination.head.slice(0, 12)} carried ${row.contamination.foreign.join(', ')}; reset to own reviewed head ${row.contamination.restore.own?.slice(0, 12) ?? '(unknown)'}, whose merge onto the base conflicts and is the worker's`
      : row.contamination.restore?.outcome === 'unrepairable' ? `${row.key}: head ${row.contamination.head.slice(0, 12)} carries ${row.contamination.foreign.join(', ')} under something the control plane cannot move; request rework`
      : row.contamination.restore ? `${row.key}: head ${row.contamination.head.slice(0, 12)} carries ${row.contamination.foreign.join(', ')}; a ${row.contamination.restore.cause} restore is requested and runs on the next reconciliation`
      : `${row.key}: head ${row.contamination.head.slice(0, 12)} carries ${row.contamination.foreign.join(', ')}; ${row.attention ?? 'a restore is owed'}` }] : []);
  const restoredApprovals = rows.flatMap(row => row.restoredApproval ? [{ key: row.key, reviewer: row.restoredApproval.reviewer, sha: row.restoredApproval.sha, reason: row.restoredApproval.dismissal.reason, at: row.restoredApproval.at, line: `${row.key}: ${row.restoredApproval.line}` }] : []);
  return { contaminated, restoredApprovals };
}
/**
 * The dispatch plan the durable loop and `master dispatch` follow: ready items in the order they
 * would be offered (smallest planned scope first within a priority), the ones held behind a
 * claimed or unmerged item whose changed files (or, before a candidate, planned files) they
 * overlap, with the age of each hold and the chain it waits behind, the holds past the bound —
 * offered over the overlap — and the broad scopes that will overlap nearly everything.
 */
export function dispatchSchedule(work: Work[], now: number, boundMs = dispatchHoldBoundMs) {
  const ready = work.filter(item => dispatchable(item, now)).sort(dispatchOrder);
  const holds = ready.flatMap(item => { const hold = dispatchHold(item, work, now, boundMs); return hold ? [{ key: item.key, ahead: hold.ahead, hold, reason: holdReason(hold) }] : []; });
  const held = holds.filter(entry => !entry.hold.overdue), overdue = holds.filter(entry => entry.hold.overdue);
  const heldKeys = new Set(held.map(entry => entry.key)), overdueKeys = new Set(overdue.map(entry => entry.key));
  return { order: ready.map(item => ({ key: item.key, priority: item.priority, scope: scopeBreadth(item.plannedFiles), held: heldKeys.has(item.key), overdue: overdueKeys.has(item.key) })), held, overdue,
    highConflict: ready.filter(item => scopeBreadth(item.plannedFiles).highConflict).map(item => ({ key: item.key, broad: scopeBreadth(item.plannedFiles).broad })), boundMs };
}
/** The one sentence a hold reads as, before and after the bound: who is ahead, on which files, since when, and what lifts it. */
export function holdReason(hold: DispatchHold) {
  const chain = hold.chain.length > hold.ahead.length ? `; the chain it waits behind: ${describeChain(hold.chain)}` : '';
  return hold.overdue
    ? `Held by planned-file overlap with ${describeOverlap(hold.ahead)} since ${hold.since} (${hours(hold.ageMs)}), past the ${hours(hold.boundMs)} bound${chain}; dispatched over the overlap: whichever lands second re-integrates the other`
    : `Held by planned-file overlap with ${describeOverlap(hold.ahead)} since ${hold.since} (${hours(hold.ageMs)} of the ${hours(hold.boundMs)} bound)${chain}; dispatch with --allow-overlap to override, or the bound lifts it`;
}
/** Fewest conflicts first: the order that forces the fewest re-integration rounds on the rest. */
export function sequenceAdvice(candidates: { key: string; conflicts: string[] }[]) {
  const sequence = [...candidates].sort((a, b) => a.conflicts.length - b.conflicts.length || a.key.localeCompare(b.key)).map(entry => entry.key);
  const conflicting = candidates.filter(entry => entry.conflicts.length);
  return { sequence, conflicting: conflicting.map(entry => ({ key: entry.key, conflicts: entry.conflicts })) };
}

/**
 * The deliveries that did not come through an authorized merge execution, each with the decision
 * it rests on. A reconciled delivery cites the pre-merge snapshot that satisfied every gate; an
 * operator-authorized one states that no execution authorized the merge, names the operator and
 * both reasons, and lists what the record lacked. The item's own `delivery` carries the same
 * record under `reconciliation` or `operatorAuthorization`; the ledger keeps `merge.reconciled` or
 * `merge.operator-authorized`.
 */
export function recoveredDeliveries(work: Work[]) {
  const done = work.filter(item => item.stage === 'done' && item.delivery) as (Work & { delivery: NonNullable<Work['delivery']> & { reconciliation?: any; operatorAuthorization?: any } })[];
  const cite = (item: typeof done[number], record: any) => ({ key: item.key, title: item.title, mergeSha: item.delivery.mergeSha, mergedAt: item.delivery.mergedAt, decision: record.decision as string,
    requestedBy: record.requestedBy as string, approvedBy: record.approvedBy as string, reason: record.reason as string, approvalReason: record.approvalReason as string, cutoff: record.cutoff as string, snapshotRevision: record.snapshotRevision as number });
  return {
    reconciled: done.filter(item => item.delivery.reconciliation).map(item => ({ ...cite(item, item.delivery.reconciliation), authorization: 'reconciled' as const, judgement: item.delivery.reconciliation.judgement as string })),
    operatorAuthorized: done.filter(item => item.delivery.operatorAuthorization).map(item => ({ ...cite(item, item.delivery.operatorAuthorization), authorization: 'operator' as const, execution: null,
      operator: item.delivery.operatorAuthorization.operator as string, refusedDecision: item.delivery.operatorAuthorization.refusedDecision as string, unmet: item.delivery.operatorAuthorization.unmet as string[], judgement: item.delivery.operatorAuthorization.judgement as string })),
  };
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
    enqueuedAt: placement.enqueuedAt, ahead: placement.predecessors, skipped: placement.skipped ?? [], passedOver: placement.passedOver ?? null, reasons: placement.reasons, binding };
}
/**
/**
 * Every Herdr call the coordinator makes. `run` is the asynchronous runner (child-runner.ts) —
 * or a test's stub — and is always awaited: a session start that takes its whole thirty-second
 * bound, or the start bound's 120-second ceiling (awaitRuntimeStart), delays only the launch
 * that asked for it, never the cycle's reads beside it (GY-125).
 *
 * Every call is also bounded (GY-114): a runtime that accepts a call and never answers must fail
 * that step rather than hold it, so the cycle records the failure, moves past it, and the process
 * still answers the SIGTERM its supervisor sends. The bound is the same 90s the runner applies to
 * every child, and it sits above every inner wait Herdr is asked for (a 30s `agent start`, three
 * 20s prompt deliveries), so it can only fire on a runtime that has stopped answering.
 */
export const agentRuntimeTimeoutMs = defaultChildTimeoutMs;
export const agentRuntimeRun = (timeoutMs: number = agentRuntimeTimeoutMs): BoundChildRun => childRunner({ timeoutMs });
export async function herdrJson(args: string[], run: ChildRun = defaultChildRun) {
  const parsed = JSON.parse(await run('herdr', args));
  if (parsed.error) throw Object.assign(new Error(`Herdr refused the operation: ${parsed.error.message ?? parsed.error}`), { herdrCode: typeof parsed.error.code === 'string' ? parsed.error.code : undefined });
  return parsed.result ?? parsed;
}
async function herdrRun(args: string[], run: ChildRun = defaultChildRun) { await run('herdr', args); }
export async function listHerdrAgents(run?: ChildRun): Promise<HerdrAgent[]> { return (await herdrJson(['agent', 'list'], run)).agents ?? []; }
export async function observeHerdrAgents(run?: ChildRun) {
  try { return { agents: await listHerdrAgents(run), available: true, reason: null }; }
  catch { return { agents: [] as HerdrAgent[], available: false, reason: 'Herdr session health is unavailable; Graphyard work state remains authoritative' }; }
}

export async function closeHerdrPane(pane: string, run?: ChildRun, timeoutMs = 5_000) {
  await herdrJson(['pane', 'close', pane], run);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await herdrJson(['pane', 'list'], run);
    if (!Array.isArray(result.panes)) throw new Error('Herdr did not return a pane inventory after close');
    if (!result.panes.some((candidate: any) => candidate.pane_id === pane)) return;
    await sleep(100);
  }
  throw new Error(`Herdr still reports pane ${pane} after close`);
}

export function createdHerdrTab(result: any) {
  const pane = result?.root_pane?.pane_id ?? result?.pane_id ?? result?.pane?.id ?? result?.tab?.pane_id;
  const tab = result?.tab?.tab_id ?? result?.tab_id ?? result?.root_pane?.tab_id;
  if (typeof pane !== 'string' || !pane.trim()) throw Object.assign(new Error('Herdr did not return a valid new pane'), { herdrTab: typeof tab === 'string' && tab.trim() ? tab : undefined });
  return { pane, tab: typeof tab === 'string' && tab.trim() ? tab : undefined };
}

export async function stopCreatedHerdrTab(pane: string | undefined, tab: string | undefined, run?: ChildRun, timeoutMs = 5_000) {
  if (pane) return closeHerdrPane(pane, run);
  if (!tab) throw new Error('Herdr did not identify the created tab, so cleanup cannot be confirmed');
  await herdrJson(['tab', 'close', tab], run);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await herdrJson(['tab', 'list'], run);
    if (!Array.isArray(result.tabs)) throw new Error('Herdr did not return a tab inventory after close');
    if (!result.tabs.some((candidate: any) => candidate.tab_id === tab)) return;
    await sleep(100);
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
    { rule: 'Bash(systemctl --user enable --now graphyard-master.service)', why: 'Re-enable and start the loop\'s own supervisor when master status reports the unit installed but disabled; without it nothing restarts the loop after a crash or a reboot. The unit is exact, so no other unit can be enabled.' },
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
export interface SessionHarnessInput { role: SessionRole; kind: string | undefined; cliPath: string; repository: string; baseBranch: string; credentialHome: string; credentialDirectories: string[]; branch?: string; pr?: number;
  /** The detached checkout Graphyard allocated for a reviewer session under the managed worktree root. */
  checkout?: string }
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
      // Surrounding code is read from a detached checkout under the managed worktree root, which
      // Graphyard allocates for the session and removes when it ends.
      ...(input.checkout ? [{ rule: 'Bash(git fetch:*)', why: 'Fetch the exact head under review.' },
        { rule: `Bash(git worktree add --detach ${input.checkout}:*)`, why: 'Check the exact head out, read-only, in the checkout Graphyard allocated for this session.' }] : []),
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
 * and is launched with its profile arguments unchanged. Loading only the user settings also leaves
 * out the repository's AGENTS.md, so such a session carries the launch authorization written there
 * (repository-setup.ts launchAuthorization) as its role text, loaded from the session's role file.
 */
export async function prepareSessionHarness(root: string, config: MasterConfig, input: Omit<SessionHarnessInput, 'cliPath' | 'repository' | 'baseBranch' | 'credentialHome' | 'credentialDirectories'> & { profile: string; credentialFiles?: string[] }) {
  const plan = sessionHarnessPlan({ ...input, cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome: dirname(dirname(config.credentialFile)),
    credentialDirectories: [dirname(config.credentialFile), ...(config.reviewer ? [dirname(config.reviewer.credentialFile)] : []), ...(input.credentialFiles ?? []).map(file => dirname(file))] });
  if (input.kind !== 'claude' || !await repositoryCarriesClaudeSettings(root)) return { plan, file: null, args: [] as string[], role: null as string | null };
  const file = sessionHarnessFile(root, input.role, input.profile);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await atomicPrivateText(file, `${JSON.stringify({ permissions: { allow: plan.allow.map(entry => entry.rule), deny: plan.deny.map(entry => entry.rule) } }, null, 2)}\n`);
  // The authorization is the session's role text: startAgentSession writes it to the session's
  // role file and the command line loads that file (GY-121), never the text itself.
  return { plan, file, args: ['--setting-sources', 'user', '--settings', file], role: launchAuthorization.replace(/\s+/g, ' ') as string | null };
}
export async function startMaster(root: string, kind: WorkerProfile['kind'], agentArgs: string[], agents: HerdrAgent[], run?: ChildRun) {
  if (!kind) throw new Error('Choose a supported master agent kind');
  const config = await loadMasterConfig(root);
  const masterRetry = `graphyard master start ${kind}, once masterAgentName in .graphyard/master.json is a name Herdr can launch`;
  const name = nameForLaunch(masterRetry, () => config.masterAgentName);
  if (agents.some(agent => agent.name === name)) throw new Error(`Master agent ${name} is already visible in Herdr`);
  // Installation, not operator memory: the harness the master runs under learns the master's own
  // commands before the session starts, so a routine status or review never waits on a keypress.
  const harness = await writeHarnessPermissions(root, masterHarness(root, config, kind), true);
  let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined;
  try {
    // The master runs with its runtime's broadest approval mode too; the harness rules above, not
    // runtime prompts, say what it may do. Codex's sandbox is widened to the private state the
    // master's own commands write beside its credential, and its tab carries the recipe's variables.
    const launch = accountLaunch({ kind, approvals: 'auto', agentArgs, environment: {} }, null, { writable: [dirname(config.credentialFile)] });
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root, '--label', `Graphyard master · ${config.repository}`, '--env', 'GRAPHYARD_MASTER=1', ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tabId = created.tab;
    const prompt = `You are the dedicated Graphyard master agent for ${config.repository}. Do not implement product work, claim worker leases, submit evidence, weaken requirements, or bypass gates. Read AGENTS.md, run node ${config.cliPath} master guide, then run node ${config.cliPath} master status. Use Graphyard as assignment and progression truth and Herdr only for session health and control. Route ready work to configured worker profiles, require workers to claim for themselves, preserve handoffs, and leave dispatch, review, proof production and routine merge of system-driven items (every item not created with "systemDriven": false) to node ${config.cliPath} master run, whose loop performs each; the master CLI refuses those hand actions on them. The loop drives an item created with "systemDriven": false the same way; opting out only also allows those hand actions, so take one only where master status shows the loop has not, and merge by hand only through graphyard master merge after every exact-candidate gate passes. Act without asking: only goals and priorities, spending money or opening third-party accounts, and issuing credentials to people belong to the human. Create, release, unblock and add requirements with node ${config.cliPath} master create, release, unblock, or requirements; request every other decision with node ${config.cliPath} master decide GY-N ACTION REASON and launch its independent approver with node ${config.cliPath} master approver GY-N DECISION.${config.operatorAgent ? '' : ` Your operator-agent and approver identities are not provisioned yet; report that onboarding must run node ${config.cliPath} master autonomy --admin-token-stdin --apply once.`}`;
    const reviewInstruction = config.reviewer
      ? `Independent review and proof collection start on their own: when a candidate passes the build gate the control plane records a review request and producer requests bound to its exact head, and node ${config.cliPath} master run launches the reviewer identity ${config.reviewer.slug}[bot] and one producer session per proof group for them within 30 seconds. Read the findings, route rework, and merge; never launch reviews or producers by hand, never review a candidate yourself, and never submit evidence. master status shows what is running per candidate and since when, and node ${config.cliPath} master review GY-N is only the recovery of a review request the loop has stopped relaunching: its session settled without answering it, its automatic sessions are exhausted, or its launch reached the dispatch failure limit with no request-review row still queued; on a system-driven item it is refused before then.`
      : `No reviewer identity is registered yet. Run node ${config.cliPath} master reviewer setup before routing work that needs independent review; once it is registered, master run launches reviews and producers for every submitted head on its own. Never approve a candidate yourself.`;
    const mergeInstruction = config.autoMerge
      ? `Automatic routine merging is enabled. The loop's merge step performs the guarded merge of every item when all gates pass; node ${config.cliPath} master merge is also allowed only for an item created with "systemDriven": false.`
      : `Automatic merging is disabled, so every merge needs explicit operator approval given by an agent. For every item the loop requests the merge decision, launches its approver and merges on the approval. Only for an item created with "systemDriven": false, and only when master status shows no merge decision the loop requested for it, may you request it with node ${config.cliPath} master decide GY-N merge REASON and launch the approver; master merge refuses a candidate without an approved merge decision. Never wait on a human for it.`;
    const administrationInstruction = config.browser
      ? `GitHub administration of ${config.repository} is yours: reconcile protection with node ${config.cliPath} master protection --apply, and when only a GitHub page can do it run node ${config.cliPath} master browser app-permissions, installation-accept, or protection, which drive the operator's browser profile ${config.browser.profile} headless, record every step, verify through the API, and append an audit entry. Report a pending sudo code from master status; the operator only approves it on their device. Never ask the operator to click through what those flows cover.`
      : `No browser profile is configured, so App permission updates, installation acceptance, and page-only protection changes are not yet yours: master status records that as a setup attention item owned by the operator, naming node ${config.cliPath} master init --token-stdin --browser-profile PROFILE as what makes them yours. Never ask the operator for it in chat; leave that item to master status and keep routing the rest of the work.`;
    // The master starts on its own request too; a runtime without that contract is prompted
    // after start, with the text last and the confirmation following it.
    ({ delivery } = await startAgentSession(name, kind, created.pane, launch.args, `${prompt} ${reviewInstruction} ${administrationInstruction} ${mergeInstruction}`, run, { directory: root, confirm: 'follow', retry: masterRetry, environment: launch.environment }));
  } catch (error) {
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    if (pane || tabId || malformedTab) try { await stopCreatedHerdrTab(pane, tabId ?? malformedTab, run); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Master startup failed'}; Herdr could not confirm cleanup of the created tab`); }
    throw error;
  }
  return { agentName: name, kind, pane: pane!, status: delivery === 'request' ? 'started on its request' : 'started and prompted', delivery, focusChanged: false, harness };
}

/** The launcher's own runner: the CLI as a child, and git. `stdio` is honoured for the streams a child may inherit; the rest is captured. */
type WorkerCommand = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: ('ignore' | 'pipe' | 'inherit')[] }) => string | Buffer | Promise<string | Buffer>;
type PreparedWorker = { epoch: number; path: string; base: string; branch?: string; dependencies?: SharedDependencies };
/** Claims the item and builds its worktree; `claimBy` is a hand dispatch's claim deadline (prepareWorkerLaunch). */
type WorkerPreparer = (root: string, key: string, profileName: string, run?: WorkerCommand, claimBy?: number) => Promise<PreparedWorker>;

/**
 * `sandbox` runs the launch's sandbox probe (GY-134). The worktree prepareWorkerLaunch creates is
 * always probed; a worktree an injected preparer supplies is probed only when a runner is given.
 */
export interface DispatchOptions {
  allowOverlap?: boolean; holdBoundMs?: number; probe?: EnvironmentProbe; prompt?: PromptDelivery; start?: StartBounds; sandbox?: SandboxExec;
  /** A hand dispatch's deadline on this host's clock: past it the item's backed-off dispatch row is the executor's again, so the launch claims nothing (GY-175). */
  claimBy?: number;
}
/** Refuses a hand launch past its `claimBy`: the item's backed-off dispatch action is the executor's again, so the launch claims nothing. */
export function assertClaimDeadline(key: string, claimBy: number | undefined, now = Date.now()) {
  if (claimBy !== undefined && now >= claimBy)
    throw new Error(`${key}: the hand launch did not reach its lease claim before the item's backed-off dispatch action is offered to the executor again, so it claims nothing; the loop's dispatcher launches the item`);
}
export const describeOverlap = (overlap: ReturnType<typeof dispatchOverlap>) => overlap.map(ahead => `${ahead.key} (${ahead.state}, ${ahead.stage}) on ${ahead.paths.join(', ')}`).join('; ');
export function assertDispatchable(work: Work, allWork: Work[], observedAt: string, options: DispatchOptions = {}) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now)) throw new Error('Dispatch requires a valid Graphyard snapshot clock');
  if (parkedOnHuman(work)) throw new Error(`Dispatch waits on a human-only decision (${humanDecisionLabel[work.humanRequest!.kind]}); ${answerCommand(work.key, work.humanRequest!)} resumes it`);
  if (!work.ready || work.blocker) throw new Error('Dispatch requires released work without a blocker');
  const fenced = containmentHold(work, now);
  if (fenced) throw new Error(fenced);
  const unfinished = work.dependencies.map(id => allWork.find(item => item.id === id)).filter(dependency => !dependency || dependency.stage !== 'done');
  if (unfinished.length) throw new Error(`Dispatch blocked by unfinished dependencies: ${unfinished.map(dependency => dependency?.key ?? 'unknown').join(', ')}`);
  if (work.lease && Date.parse(work.lease.expiresAt) > now) throw new Error(`Dispatch blocked by active owner ${work.lease.owner}`);
  if (work.submission && !work.reworkRequested) throw new Error('Dispatch requires operator-authorized rework for a submitted item');
  const conflicts = resourceConflicts(work, allWork, now);
  if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map(conflict => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
  // Overlap is a soft exclusive resource: advisory, bounded in time, with an operator override.
  const hold = dispatchHold(work, allWork, now, options.holdBoundMs);
  if (hold && !hold.overdue && !options.allowOverlap) throw new Error(`Dispatch held by planned-file overlap with ${describeOverlap(hold.ahead)}; whichever lands second re-integrates the other. Held since ${hold.since} (${hours(hold.ageMs)} of the ${hours(hold.boundMs)} bound)${hold.chain.length > hold.ahead.length ? `; the chain it waits behind: ${describeChain(hold.chain)}` : ''}. Wait for it to merge, or pass --allow-overlap to dispatch anyway`);
  return hold;
}

export async function dispatchWork(root: string, work: Work, profile: WorkerProfile, agents: HerdrAgent[], run?: ChildRun, allWork: Work[] = [work], prepare: WorkerPreparer = prepareWorkerLaunch, release: (root: string, key: string, epoch: number, profileName: string) => Promise<void> = releaseWorkerLaunch, agentTimeoutMs = 30_000, observedAt = new Date().toISOString(), options: DispatchOptions = {}) {
  assertDispatchable(work, allWork, observedAt, options);
  const config = await loadMasterConfig(root);
  let target = agents.find(agent => agent.name === profile.agentName);
  let selected: Awaited<ReturnType<typeof selectAccount>> | undefined, launched: ReturnType<typeof accountLaunch> | undefined, relaunched = 0;
  let harness: Awaited<ReturnType<typeof installWorkerHarness>> | null = null;
  let dependencies: PreparedWorker['dependencies'] | null = null;
  let delivery: RequestDelivery | null = null, sandbox: ReturnType<typeof verifyWorkerSandbox> | null = null;
  let started: 'started' | 'awaiting consent' = 'started', consent: { answered: ConsentAnswer[]; awaiting: ConsentHold | null } = { answered: [], awaiting: null };
  if (profile.mode === 'existing') {
    if (!target) throw new Error('Existing worker is not visible in Herdr');
    throw new Error('Existing sessions are observable but cannot be safely adopted for new work; use a launch profile so Graphyard supervises the agent process');
  } else {
    await readCredentialFile(profile.credentialFile!);
    if (target) throw new Error('Launch profile agent name is already visible in Herdr');
    // A profile that cannot launch without a human at its prompts is refused before any account is chosen.
    assertNoApprovalOptOut(profile.kind ?? 'unnamed', profile.approvals);
    // The account is chosen before anything is claimed: a profile whose accounts are all logged out
    // or out of quota claims nothing, and the refusal names every account it skipped and why.
    selected = await selectAccount(config, 'worker', profile, { ...options.probe, work: work.key });
    // The Git directories the worker writes are granted once its worktree exists (launchWorker).
    // A launch refused for its effective arguments gives the chosen session back at once (GY-184).
    const chosen = selected;
    const launch = await onSelectedSession(chosen, `worker launch for ${work.key} failed`, async () => accountLaunch(profile, chosen.account));
    launched = launch;
    // A prompt the runtime never accepted closes the session and releases the claim; the launch is
    // then made once more from a fresh claim, rather than leaving an idle session holding the item.
    for (let attempt = 1; ; attempt++) {
      try {
        assertClaimDeadline(work.key, options.claimBy);
        ({ target, harness, dependencies, delivery, sandbox, started, consent } = await launchWorker(root, config, work, profile, launch, run, prepare, release, agentTimeoutMs, options.prompt, options.start, options.sandbox ?? (prepare === prepareWorkerLaunch ? 'host' : null), options.claimBy)); break; }
      catch (error) {
        if (error instanceof PromptNotAcceptedError && attempt < 2) { relaunched++; continue; }
        // The registry session chosen for this launch never ran; its account is free again at once.
        await selected.release?.(`worker launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`);
        throw error;
      }
    }
  }
  const hold = dispatchHold(work, allWork, Date.parse(observedAt), options.holdBoundMs);
  return { work: work.key, profile: profile.name, principal: profile.principal, agentName: profile.agentName, pane: target.pane_id ?? null, approvals: profile.approvals,
    launch: launched?.plan ?? agentLaunchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment), ownership: 'worker launcher claimed and is supervising the agent process', harness, dependencies, delivery, sandbox,
    // `awaiting consent` is not a started session: the runtime has not read its request (GY-130).
    started, consent: { answered: consent.answered, awaiting: consent.awaiting ? { prompt: consent.awaiting.prompt, kind: consent.awaiting.kind, pane: consent.awaiting.pane, attach: consent.awaiting.attach, releaseAt: consent.awaiting.releaseAt, attention: consentHoldAttention(consent.awaiting) } : null },
    account: selected?.account ? { environment: selected.account.name, kind: selected.account.kind, quota: selected.health?.quota ?? null, skipped: selected.skipped } : null, relaunched,
    // The overlap a dispatch went over is recorded with the dispatch: by operator override, or
    // because the hold outlived its bound — the note says which, and the chain the item waited behind.
    overlap: hold ? { allowed: true, ahead: hold.ahead, hold, note: `Dispatched over a planned-file overlap with ${describeOverlap(hold.ahead)}${hold.overdue ? ` after a hold of ${hours(hold.ageMs)}, past the ${hours(hold.boundMs)} bound${hold.chain.length > hold.ahead.length ? `, behind ${describeChain(hold.chain)}` : ''}` : ' by operator override'}; expect a sync → review → proof round for whichever lands second` } : null };
}

export const herdrAttach = (pane: string, workspace?: string | null) => `herdr pane attach ${pane}${workspace ? ` --workspace ${workspace}` : ''}`;
export function consentHold(config: Pick<MasterConfig, 'herdrWorkspace'>, key: string, epoch: number, agentName: string, pane: string, awaiting: { prompt: string; kind: ConsentHold['kind']; request?: string | null; named?: boolean }, now = Date.now()): ConsentHold {
  return { key, epoch, agentName, pane, attach: herdrAttach(pane, config.herdrWorkspace), prompt: awaiting.prompt, kind: awaiting.kind, since: new Date(now).toISOString(), releaseAt: new Date(now + consentHoldMs).toISOString(), ...(awaiting.request ? { request: awaiting.request } : {}), ...(awaiting.named === false ? { named: false } : {}) };
}

async function launchWorker(root: string, config: MasterConfig, work: Work, profile: WorkerProfile, launch: ReturnType<typeof accountLaunch>, run: ChildRun | undefined, prepare: WorkerPreparer, release: (root: string, key: string, epoch: number, profileName: string) => Promise<void>, agentTimeoutMs: number, delivery?: PromptDelivery, start?: StartBounds, sandboxProbe: SandboxExec | 'host' | null = null, claimBy?: number) {
  const prepared = await prepare(root, work.key, profile.name, undefined, claimBy);
  // The worker writes its worktree, the worktree's own Git admin directory and the shared one;
  // each is granted to the runtime's sandbox, and the grant is proved below before anything starts.
  const paths = workerPaths(prepared.path);
  const writable = writablePaths({ ...paths, commonDir: paths.commonDir ?? await sharedGitDirectory(root) });
  const args = grantWorkerPaths(launch.kind, launch.args, writable, prepared.path);
  // The worker's own rules go into its worktree before the session starts, so pushing its
  // branch and opening its pull request never wait on a keypress. A failure is reported, not fatal.
  const harness = await installWorkerHarness(config, { ...profile, kind: launch.kind as WorkerProfile['kind'] }, work.key, prepared).catch(error => ({ applied: false, reason: error instanceof Error ? error.message : 'Worker rules could not be written' }));
  const prompt = workerPrompt(config, work, profile, prepared.epoch, prepared.dependencies ?? null);
  // The worker loads its own role rules, never the master's: it may push its assigned branch.
  const sessionHarness = await prepareSessionHarness(root, config, { role: 'worker', kind: launch.kind, profile: profile.name, branch: prepared.branch ?? `graphyard/${work.key.toLowerCase()}-${prepared.epoch}`, credentialFiles: [profile.credentialFile!] });
  let pane: string | undefined, tabId: string | undefined, sandbox: ReturnType<typeof verifyWorkerSandbox> | null = null;
  try {
    // A sandbox that cannot write them is a launch failure naming the path, not a worker that
    // fails at its first sync; the claim is released below like any other failed launch.
    if (sandboxProbe) sandbox = verifyWorkerSandbox({ ...launch, args }, prepared.path, writable, sandboxProbe === 'host' ? undefined : sandboxProbe);
    const tabArgs = ['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', prepared.path, '--label', `${work.key} · ${profile.agentName}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_TOKEN_FILE=${profile.credentialFile}`, '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, '--env', `GRAPHYARD_HERDR_AGENT_KIND=${launch.kind}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'];
    const created = createdHerdrTab(await herdrJson(tabArgs, run)); pane = created.pane; tabId = created.tab;
    // The instruction is the session's own first request, on the runtime's command line under
    // the supervisor, read from the request file in the worktree (GY-121); only a runtime without
    // that contract is prompted after.
    const started = await startAgentSession(profile.agentName, launch.kind!, pane, [...args, ...sessionHarness.args], prompt, run,
      { ...delivery, ...start, timeoutMs: start?.timeoutMs ?? agentTimeoutMs, directory: prepared.path, role: sessionHarness.role, prefix: [process.execPath, config.cliPath, 'watch', work.key, String(prepared.epoch), '--'], holdConsent: true, contract: launch.contract, environment: launch.environment });
    // A worker stopped on a prompt the launcher does not answer is held for a human rather than
    // closed: its record beside the launch files is what master status raises and what the watch
    // supervisor bounds, releasing the slot once `consentHoldMs` passes with the prompt unanswered.
    const hold = started.awaiting ? consentHold(config, work.key, prepared.epoch, profile.agentName, pane, started.awaiting) : null;
    if (hold) writeConsentHold(started.files.stem, hold);
    return { target: { name: profile.agentName, pane_id: pane, agent_status: hold ? 'blocked' : 'working', cwd: prepared.path } as HerdrAgent, harness, dependencies: prepared.dependencies ?? null, delivery: started.delivery, sandbox,
      started: started.started.state, consent: { answered: started.consent, awaiting: hold } };
  } catch (error) {
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    if (pane || tabId || malformedTab) {
      try { await stopCreatedHerdrTab(pane, tabId ?? malformedTab, run); }
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
/**
 * A runtime keeps some prompts beyond every approval flag it takes — Claude Code asks before an `rm`
 * whose target it cannot resolve, even with its permission checks skipped — and a session stopped
 * on one waits for a person (GY-197). Worker and producer requests say how to never trigger it.
 */
export const destructivePromptGuidance = 'Avoid any command that triggers your runtime\'s destructive-operation prompt, which waits for a person and no person will answer it: never give rm or mv a glob or a variable as its target (such as DIR/* or "$DIR") outside a directory you created yourself with mktemp -d. Name explicit paths inside your worktree instead, and for scratch files create a directory with mktemp -d and remove only that directory by its exact path. ';
export function workerPrompt(config: Pick<MasterConfig, 'cliPath'>, work: Pick<Work, 'key' | 'title'> & Partial<Pick<Work, 'capacity' | 'humanRequests'>>, profile: Pick<WorkerProfile, 'principal'>, epoch: number, dependencies?: Pick<SharedDependencies, 'shared'> | null) {
  // A session that reinstalls dependencies it already has costs the host a gigabyte per attempt,
  // so the launcher says which trees are already there rather than leaving it to be guessed.
  const installed = dependencies?.shared.length ? `The assigned worktree needs no dependency install: ${dependencies.shared.map(entry => `${entry.name} ${entry.how === 'reachable' ? 'already resolves to' : 'is shared with'} the install at ${entry.source}`).join(', ')}, for this exact lockfile. Do not install dependencies again unless you change the lockfile. ` : '';
  return `Implement ${work.key}: ${work.title}. The Graphyard worker launcher has claimed this item under principal ${profile.principal}, created its assigned worktree, and placed this agent under lease supervision. Run node ${config.cliPath} status ${work.key} before editing. Work only in the current assigned worktree, satisfy the stated criteria without weakening them, open a PR, and submit it with complete as your last action: complete ends your lease and the supervisor then stops this session, which is the attempt ending, not lease loss. Stop immediately if the supervisor reports lease loss before you have submitted. Do not submit trusted evidence or merge the PR; the control plane requests the independent review and the proof producers for your exact head as soon as it passes the build gate, so ask nobody to launch them. `
    + installed
    + destructivePromptGuidance
    + resumedAttempt(work)
    + `If the item cannot continue without a decision only a human may make — ${humanOnlyDecisions.join('; ')} — do not wait and do not write it as a blocker: record it with node ${config.cliPath} park ${work.key} ${epoch} KIND NEEDED -- REASON (KIND is goals-and-priorities, money-or-accounts or credentials-for-people; NEEDED is the exact thing the human must provide), which ends your lease and parks the item for the human, then stop. `
    + autonomousSession('implement the item, open the pull request and submit it with complete', `record a blocker with node ${config.cliPath} blocked ${work.key} ${epoch} REASON`);
}

/** What the previous attempt left for this one: the work an exhausted session had not committed, and a human's answer. */
function resumedAttempt(work: Partial<Pick<Work, 'capacity' | 'humanRequests'>>) {
  const interrupted = work.capacity?.exhaustions.filter(entry => entry.role === 'worker').at(-1);
  // Why the attempt ended: a spent provider account, or a worker killed or gone without submitting (GY-105).
  const ended = interrupted?.cause === 'interrupted' ? `${interrupted.reason.replace(/\.\s*$/, '')}` : 'stopped when its provider account ran out of quota';
  const kept = interrupted?.partialWork.commit && interrupted.partialWork.state !== 'discarded'
    ? `The previous attempt (epoch ${interrupted.epoch}) ${ended}; its work is kept as commit ${interrupted.partialWork.commit}${interrupted.partialWork.branch ? ` on local branch ${interrupted.partialWork.branch}` : ''}${interrupted.partialWork.path ? ` (worktree ${interrupted.partialWork.path})` : ''}. Read it with git log and git show, and bring what is sound into your branch with git cherry-pick or git merge instead of redoing it. `
    : interrupted?.partialWork.state === 'discarded' ? `The previous attempt (epoch ${interrupted.epoch}) ${ended}; its uncommitted changes could not be committed and were discarded (${interrupted.partialWork.detail ?? 'no detail recorded'}), so nothing of them is left to read${interrupted.partialWork.branch ? `; its committed work is on local branch ${interrupted.partialWork.branch}` : ''}. ` : '';
  const answered = work.humanRequests?.at(-1)?.answer?.outcome === 'provided' ? work.humanRequests.at(-1)! : null;
  return kept + (answered ? `An earlier attempt asked the human for ${answered.needed} (${humanDecisionLabel[answered.kind]}); the human answered: ${answered.answer!.text}. Continue from that answer. ` : '');
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function workerEnvironment(config: MasterConfig, profile: WorkerProfile) {
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: profile.credentialFile, GRAPHYARD_HOST_ID: config.hostId };
  delete env.GRAPHYARD_TOKEN; delete env.GRAPHYARD_MASTER_TOKEN; delete env.GRAPHYARD_REQUEST_ID;
  return env;
}
// A worker launch runs the Graphyard CLI to claim and to build the assigned worktree, which on a
// large repository is the slowest thing the dispatcher waits on; it is bounded well above the
// runtime bound, so a slow checkout is never mistaken for a hung one (GY-114).
export const workerLaunchTimeoutMs = 600_000;
const workerCommand: WorkerCommand = (command, args, options = {}) => defaultChildRun(command, args, { cwd: options.cwd, env: options.env, timeoutMs: workerLaunchTimeoutMs, stdout: options.stdio?.[1] === 'inherit' ? 'inherit' : 'capture', stderr: options.stdio?.[2] === 'inherit' ? 'inherit' : 'capture' });

export async function releaseWorkerLaunch(root: string, key: string, epoch: number, profileName: string, run: WorkerCommand = workerCommand) {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  await run(process.execPath, [config.cliPath, 'release', key, String(epoch)], { cwd: root, env: workerEnvironment(config, profile) });
}

/**
 * `claimBy` is a hand dispatch's deadline on this host's clock (GY-175): it is checked again
 * immediately before the lease claim, after the credential read, discovery and base fetch, so a
 * backed-off dispatch row the executor may claim by then never meets a second launch at the claim.
 */
export async function prepareWorkerLaunch(root: string, key: string, profileName: string, run: WorkerCommand = workerCommand, claimBy?: number): Promise<PreparedWorker> {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  const detected = await discover(root);
  if (!detected.repository) throw new Error('Worker launcher requires a recognized GitHub origin');
  assertRepository(detected.repository, config.repository);
  const env = workerEnvironment(config, profile);
  await run('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${config.baseBranch}:refs/remotes/origin/${config.baseBranch}`], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = String(await run('git', ['rev-parse', '--verify', `refs/remotes/origin/${config.baseBranch}`], { cwd: root, env })).trim();
  if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('Worker launcher could not resolve the current managed base branch');
  assertClaimDeadline(key, claimBy);
  const claim = JSON.parse(String(await run(process.execPath, [config.cliPath, 'claim', key], { cwd: root, env })));
  const claimedEpoch = Number.isSafeInteger(claim.epoch) && claim.epoch > 0 ? claim.epoch as number : null;
  try {
    if (claim.lease?.owner !== profile.principal || claimedEpoch === null) throw new Error('Worker launcher acquired an unexpected assignment identity');
    const workspace = JSON.parse(String(await run(process.execPath, [config.cliPath, 'worktree', key, String(claimedEpoch), base], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] })));
    if (!workspace.path || !isAbsolute(workspace.path)) throw new Error('Worker launcher did not receive an assigned workspace');
    // The checkout is the attempt's; the dependency tree does not have to be. Sharing is a
    // convenience for the session that follows, so a refusal is reported, never fatal.
    const dependencies: SharedDependencies = await shareDependencies(root, workspace.path).catch(error => ({ shared: [], skipped: [{ name: dependencyDirectories[0], reason: failureText(error) }] }));
    return { epoch: claimedEpoch, path: workspace.path, base, dependencies, ...(typeof workspace.branch === 'string' && workspace.branch ? { branch: workspace.branch } : {}) };
  } catch (error) {
    if (claimedEpoch !== null) try { await run(process.execPath, [config.cliPath, 'release', key, String(claimedEpoch)], { cwd: root, env }); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Workspace preparation failed'}; Graphyard could not release epoch ${claimedEpoch}`); }
    throw error;
  }
}

/**
 * One merge executor instance: the coordinator principal and the instance minted for one daemon
 * process or one interactive `master merge` request (its request id, so a replay under
 * `GRAPHYARD_REQUEST_ID` is the same instance). The engine records the execution owner as
 * `principal#instance` (Engine.acquireMerge), so two executors under one credential never read
 * each other's execution as their own: the executor presents the same owner to
 * assertMergeCandidate and the same instance to every merge step.
 */
export interface MergeExecutor { principal: string; instance: string }
export const mergeExecutionOwner = (executor: MergeExecutor) => `${executor.principal}#${executor.instance}`;
/**
 * The durable loop's executor instance, minted once per daemon process: an execution this loop
 * acquires is resumed by this loop alone, and an interactive `master merge` under the same
 * credential — or a second loop — stands down from it.
 */
export const daemonExecutor = (principal: string): MergeExecutor => ({ principal, instance: `daemon-${randomUUID()}` });
/** Where an observed merge sits with no valid execution behind it: the violation the engine records. */
export const unauthorizedMergeViolation = 'Merge observed without a prior authorization for this candidate';
/** True for an item held at the merge stage by an observed merge no execution authorized (GY-92). */
export const mergedWithoutAuthorization = (work: Work) => work.stage !== 'done' && !!work.observation?.merged && work.violations.includes(unauthorizedMergeViolation);
export function assertMergeCandidate(work: Work, observedAt?: string, executionOwner?: string) {
  const age = observedAt && work.observation ? Date.parse(observedAt) - Date.parse(work.observation.at) : 0;
  const fresh = !observedAt || !!work.observation && Number.isFinite(age) && age >= 0 && age < 120_000;
  const activeMerge = !!observedAt && !!work.mergeExecution && Date.parse(work.mergeExecution.expiresAt) > Date.parse(observedAt);
  // Only the executor instance that acquired an execution resumes it. Another instance — the
  // daemon beside an interactive merge, or a second daemon — is not a candidate for this item
  // while it stands, and stands down here, before any authority is acquired or cancelled.
  const resumable = activeMerge && !!executionOwner && work.mergeExecution!.owner === executionOwner && !work.mergeExecution!.fenced
    && work.mergeExecution!.sha === work.candidate?.sha && work.mergeExecution!.baseSha === work.candidate?.baseSha
    && work.mergeExecution!.policyRevision === work.policyRevision;
  if (activeMerge && !resumable) throw new Error(`${work.key} does not have a current all-gates-passing merge authorization for this executor: merge execution ${work.mergeExecution!.id} is held by ${work.mergeExecution!.owner} until ${work.mergeExecution!.expiresAt}; this executor stands down without cancelling it`);
  // Unresolved review threads on a branch that requires conversation resolution are a merge
  // GitHub will refuse (GY-139): refused here, naming them, before any execution is issued.
  const threads = activeMerge ? null : unresolvedThreadRefusal(work);
  if (threads) throw new Error(`${work.key} was refused before any merge execution was issued: ${threads}`);
  // An unresolved escalation, a standing blocking lead ruling, and trusted
  // evidence whose producer has since implemented the item each refuse delivery
  // in the broker as well as in the gate, so a stale snapshot can never present
  // such an item as selectable.
  if (!fresh || standingEscalations(work).length || work.leadHold || evidenceIndependenceRefusals(work).length || work.stage !== 'merge' || !work.candidate || !work.mergeAuthorization || work.mergeAuthorization.sha !== work.candidate.sha || work.mergeAuthorization.baseSha !== work.candidate.baseSha || work.mergeAuthorization.policyRevision !== work.policyRevision || work.gates.some(gate => !gate.passed) || work.violations.length) throw new Error(`${work.key} does not have a current all-gates-passing merge authorization`);
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
export async function readBaseTip(repository: string, baseBranch: string, run: ChildRun): Promise<string> {
  const ref = JSON.parse(await run('gh', ['api', `repos/${repository}/git/ref/heads/${baseBranch.split('/').map(encodeURIComponent).join('/')}`]));
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
export async function assertQueuedLanding(work: Work, authorization: { sha: string; baseSha: string }, baseBranch: string, repository: string, run: ChildRun): Promise<{ baseTip: string; baseTree: string | null }> {
  const speculation = work.queue?.speculation;
  if (!speculation || speculation.tip !== authorization.sha || speculation.base !== authorization.baseSha || !speculation.baseTree) throw new Error(`${work.key} has no published merge-queue tip for the authorized commit; the queue is the only path onto the base branch`);
  const baseTip = await readBaseTip(repository, baseBranch, run);
  if (baseTip === authorization.baseSha) return { baseTip, baseTree: null };
  const commit = JSON.parse(await run('gh', ['api', `repos/${repository}/commits/${baseTip}`]));
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
  run: ChildRun;
  mint?: (credentialFile: string, repository: string) => Promise<{ token: string }>;
  fetcher?: typeof fetch;
}): Promise<CarriedApprovalRepost> {
  const candidate = work.candidate!;
  if (carried.provider !== 'github') return { posted: false, reviewId: null, reason: `the carried ${carried.provider} approval needs no native review re-post` };
  const identity = config.reviewer ? `${config.reviewer.slug}[bot]` : null;
  if (!identity || identity.toLowerCase() !== carried.reviewer.toLowerCase()) return { posted: false, reviewId: null, reason: `the approval of ${carried.originalSha.slice(0, 12)} was posted by ${carried.reviewer}, not by the bound reviewer App${identity ? ` ${identity}` : ''}; only the identity that approved it may re-post it, so the provider may still require a fresh native approval` };
  const reviews = JSON.parse(await dependencies.run('gh', ['api', '--paginate', `repos/${config.repository}/pulls/${candidate.pr}/reviews`]));
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
  // The approval binds the very commit it was given on when GitHub dismissed it for a merge-base
  // change on an unchanged head, or when the reviewed head was republished as the tip itself;
  // the recorded reason says which.
  const body = carried.originalSha === candidate.sha
    ? `Graphyard restored this identity's approval of ${candidate.sha} (review ${carried.reviewId ?? 'n/a'}) to the commit it was given on: ${carried.reason}. Re-posted by the reviewer App so branch protection sees the approval of the same commit again.`
    : `Graphyard carried this identity's approval of ${carried.originalSha} (review ${carried.reviewId ?? 'n/a'}) to Graphyard-authored merge-queue tip ${candidate.sha}: ${carried.reason}. Re-posted by the reviewer App so branch protection sees the approval after the control plane's own tip publication.`;
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
/**
 * The engine's answer when a merge step was already taken on the execution: `already verified`
 * (merge-verify) and `already committed` (merge-commit), each a confirmed refusal that tells
 * the caller to retry with the original idempotency key. From any executor but the one holding
 * that key, it means the execution is being driven by someone else.
 */
export function stepAlreadyPerformed(error: unknown) {
  return !!(error as { confirmedRefusal?: boolean } | null)?.confirmedRefusal && /Merge execution was already (verified|committed)/.test(error instanceof Error ? error.message : String(error));
}
function recordedVerification(execution: MergeExecution) {
  const verifiedAt = Date.parse(execution.verifiedAt ?? '');
  if (!Number.isFinite(verifiedAt) || !execution.clockOffset) throw Object.assign(new Error('Resumed merge execution carries an incomplete verification record'), { confirmedRefusal: true });
  return { executionId: execution.id, sha: execution.sha, verifiedAt: execution.verifiedAt!, providerDelayMs: providerDelayAfterVerification(verifiedAt, execution.clockOffset), clockOffset: execution.clockOffset };
}
/** The engine's execution bound from its observation (engine.ts acquireMerge). */
const mergeExecutionWindowMs = 120_000;
/** The provider reserve (~92 s) plus the verify, protection and commit round trips before it. */
export const mergeWindowFloorMs = 108_000;
/** An observation older than this is re-read before a merge attempt acquires authority. */
export const mergeObservationFreshMs = 8_000;
const mergeObservationWaitSteps = 20;
const commitMarginMs = 5_000;
const observationAgeMs = (item: Work, now: string) => Date.parse(now) - Date.parse(item.observation?.at ?? '');
/** A gh failure that carries a GitHub 4xx status: GitHub answered and did not merge. */
export function definiteProviderRefusal(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\(HTTP (4\d\d)\)/.exec(message)?.[1];
  if (!status) return null;
  const line = message.split('\n').find(entry => entry.includes(`(HTTP ${status})`)) ?? '';
  return `${line.replace(/^gh:\s*/, '').trim() || `HTTP ${status}`}`.slice(0, 500);
}
/**
 * The latest `Graphyard / merge` run on the head must have succeeded before the provider is asked.
 * Only runs published by the control plane's own GitHub App count: branch protection binds the
 * required check to that App, so a same-named run from another App or workflow neither satisfies
 * nor defers the merge.
 */
export function assertMergeCheckPublished(payload: any, key: string, sha: string, appId: number) {
  // Read with `--paginate --slurp`, the answer is the list of pages; GitHub filters check runs by
  // name but not by App, so every page is read before the App's own runs are picked out.
  const pages = Array.isArray(payload) ? payload : [payload];
  if (!pages.length || pages.some(page => !Array.isArray(page?.check_runs))) throw new Error(`${key} merge deferred: GitHub's check runs on ${sha.slice(0, 12)} could not be read; retry`);
  const runs = pages.flatMap(page => page.check_runs).filter((entry: any) => entry?.name === CHECK_NAME && entry?.app?.id === appId)
    .sort((a: any, b: any) => Date.parse(b?.started_at ?? b?.completed_at ?? '') - Date.parse(a?.started_at ?? a?.completed_at ?? ''));
  const latest = runs[0];
  if (latest?.status !== 'completed' || latest?.conclusion !== 'success')
    throw new Error(`${key} merge deferred: GitHub does not yet show ${CHECK_NAME} as passed on ${sha.slice(0, 12)} (${latest ? `${latest.status}${latest.conclusion ? `/${latest.conclusion}` : ''}` : 'not published'}); retry once it is`);
}
export async function mergeWork(config: MasterConfig, work: Work, freshSnapshot: () => Promise<{ work: Work[]; now: string }>, acquire: (work: Work, authorization: ReturnType<typeof assertMergeCandidate>) => Promise<{ execution: MergeExecution }>, cancel: (work: Work, execution: MergeExecution, reason: string) => Promise<unknown>, verify: (work: Work, execution: MergeExecution) => Promise<{ executionId: string; sha: string; verifiedAt: string; providerDelayMs: number; clockOffset?: { min: number; max: number } }>, run: ChildRun = defaultChildRun, executionOwner?: string, commit?: (work: Work, execution: MergeExecution) => Promise<{ executionId: string; sha: string; committingAt: string }>, repost?: (work: Work, carried: CarriedApproval) => Promise<CarriedApprovalRepost>, refresh?: (work: Work) => Promise<unknown>) {
  let before = await freshSnapshot(); let current = before.work.find(item => item.id === work.id);
  if (!current || current.revision !== work.revision) throw new Error(`${work.key} changed before GitHub verification; retry`);
  // The engine bounds a merge execution by the GitHub observation it was granted on (two minutes
  // from observation.at), and the provider call needs about 92 s of it. An attempt that starts
  // on an observation already ~20 s old runs out of window after committing (GY-159, 2026-09-24),
  // so a fresh reading is asked for first and the attempt continues on it.
  if (refresh && !current.mergeExecution && observationAgeMs(current, before.now) > mergeObservationFreshMs) {
    const seen = current.observation?.at;
    await refresh(current);
    for (let step = 0; step < mergeObservationWaitSteps; step++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      before = await freshSnapshot(); current = before.work.find(item => item.id === work.id);
      if (!current || current.observation?.at !== seen) break;
    }
    if (!current || current.candidate?.sha !== work.candidate?.sha) throw new Error(`${work.key} changed while GitHub was re-read before merging; retry`);
  }
  const authorization = assertMergeCandidate(current, before.now, executionOwner);
  // Only a recorded provider commit marks an unknown provider outcome: the broker may already
  // have called GitHub, so nothing is retried until observation reconciles the execution. A
  // verified execution that never reached the commit resumes below; the provider was not attempted.
  if (current.mergeExecution?.committingAt) return { key: authorization.key, pr: authorization.pr, sha: authorization.sha, method: config.mergeMethod, result: 'the provider commit was already recorded; Graphyard retained the execution until GitHub reconciles the provider outcome and refuses a new attempt until then' };
  // The pull request answers for its own head, base branch name and state; the base tip is read
  // from the ref itself inside assertQueuedLanding, because `baseRefOid` is a cached value.
  const pr = JSON.parse(await run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefName,state,isDraft']));
  if (pr.headRefOid !== authorization.sha || pr.baseRefName !== config.baseBranch || pr.state !== 'OPEN' || pr.isDraft) throw new Error(`${work.key} changed on GitHub before merge`);
  await assertQueuedLanding(current, authorization, config.baseBranch, config.repository, run);
  // A head without the base tip in its history is refused before any approval is re-posted: GitHub
  // would dismiss it again as a merge-base change on this very attempt (GY-145).
  const unancestored = missingBaseAncestry(current);
  if (unancestored) throw new Error(`${work.key} merge refused: ${missingAncestryReason(unancestored)}`);
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
  // No execution is acquired that cannot cover the provider call: it would only expire, or be
  // retained as an unknown outcome, and block the next attempt until it lapses.
  if (!resumed) {
    const window = Math.min(Date.parse(latest.observation?.at ?? '') + mergeExecutionWindowMs, Date.parse(after.now) + mergeExecutionWindowMs) - Date.parse(after.now);
    if (!(window >= mergeWindowFloorMs)) throw new Error(`${work.key} merge deferred: the GitHub observation leaves ${Number.isFinite(window) ? Math.round(window / 1000) : 0} s of merge window, under the ${mergeWindowFloorMs / 1000} s a provider call needs; retry on a fresh observation`);
  }
  const granted = resumed ? { execution: latest.mergeExecution } : await acquire(latest, latestAuthorization);
  if (!granted.execution || granted.execution.sha !== authorization.sha || granted.execution.baseSha !== authorization.baseSha || granted.execution.policyRevision !== authorization.policyRevision || !resumed && granted.execution.authorizationRevision !== authorization.revision) throw new Error(`${work.key} received an invalid merge execution authority`);
  const remainingAtSnapshot = Date.parse(granted.execution.expiresAt) - Date.parse(after.now);
  let providerStarted = false; let cancelled = false;
  let verificationStarted = false; let verificationCompleted = false;
  try {
    const lockedPr = JSON.parse(await run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefName,state,isDraft']));
    if (lockedPr.headRefOid !== authorization.sha || lockedPr.baseRefName !== config.baseBranch || lockedPr.state !== 'OPEN' || lockedPr.isDraft) throw new Error(`${work.key} changed on GitHub after merge authority was acquired`);
    await assertQueuedLanding(latest, authorization, config.baseBranch, config.repository, run);
    const remaining = remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt);
    if (!Number.isFinite(remaining) || remaining <= 90_000) throw new Error(`${work.key} merge execution does not remain valid for the provider timeout; refresh gate inputs and retry`);
    const protection = JSON.parse(await run('gh', ['api', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`]));
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
    const githubClock = await run('gh', ['api', '--include', 'rate_limit']);
    const delay = githubProviderDelay(verifiedTime, verified.providerDelayMs, githubClock);
    if (delay > 21_000 || remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt) - delay <= providerReserve) throw new Error('Clock uncertainty leaves insufficient merge authority; refresh and retry');
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const remainingAfterProtection = remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt);
    // The margin covers the commit round trip and the post-commit clock wait, so a window that is
    // already too short is refused here, before commit, where the execution is released.
    if (!Number.isFinite(remainingAfterProtection) || remainingAfterProtection <= providerReserve + commitMarginMs) throw new Error(`${work.key} merge execution no longer has enough time for the provider call after verifying branch protection; retry`);
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
    // GitHub refuses the merge while the published `Graphyard / merge` check lags the gates it
    // reports (HTTP 405, GY-159 2026-09-24). Read it before committing, while a refusal still
    // releases the execution.
    assertMergeCheckPublished(JSON.parse(await run('gh', ['api', `repos/${config.repository}/commits/${authorization.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`, '--paginate', '--slurp'])), work.key, authorization.sha, config.githubAppId);
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
    const commitClock = await run('gh', ['api', '--include', 'rate_limit']);
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
    await assertQueuedLanding(latest, authorization, config.baseBranch, config.repository, run);
    const preProvider = await freshSnapshot();
    const finalExecution = preProvider.work.find(item => item.id === work.id)?.mergeExecution;
    const remainingBeforeProvider = remainingAtSnapshot - (performance.now() - authorityBudgetStartedAt);
    if (!finalExecution || finalExecution.id !== granted.execution.id || !finalExecution.committingAt || finalExecution.fenced
      || finalExecution.sha !== authorization.sha || Date.parse(finalExecution.expiresAt) <= Date.parse(preProvider.now)
      || !Number.isFinite(remainingBeforeProvider) || remainingBeforeProvider <= providerReserve)
      throw new Error(`${work.key} merge execution expired, was fenced or was superseded during the provider clock wait; the provider merge is refused${finalExecution?.fenced ? `: ${finalExecution.fenced.reason}` : ''}`);
    let answer: string;
    try { answer = await run('gh', ['api', '--method', 'PUT', `repos/${config.repository}/pulls/${authorization.pr}/merge`, '-f', `sha=${authorization.sha}`, '-f', `merge_method=${config.mergeMethod}`]); }
    catch (error) {
      // A 4xx answer is GitHub refusing the merge, not an unknown outcome: the execution is
      // released so the next attempt is not held until it lapses.
      const refusal = definiteProviderRefusal(error);
      if (refusal) { await cancel(latest, granted.execution, refusal); cancelled = true; throw new Error(`GitHub refused the merge of ${work.key}: ${refusal}`); }
      throw error;
    }
    const provider = JSON.parse(answer);
    if (provider.merged !== true || typeof provider.sha !== 'string') {
      await cancel(latest, granted.execution, provider.message || 'GitHub confirmed that it did not merge the candidate'); cancelled = true;
      throw new Error(provider.message || 'GitHub did not merge the candidate');
    }
  }
  catch (error) {
    // A confirmed refusal that says the step was already performed on this execution means
    // another executor — or an earlier attempt of this one, read from a stale snapshot — is
    // ahead of this attempt. The execution is theirs to finish: this executor stands down and
    // leaves it intact for its owner or for observation to reconcile. It never cancels an
    // execution it did not just acquire, whatever the refusal (GY-92).
    if (stepAlreadyPerformed(error)) throw new Error(`${work.key}: ${error instanceof Error ? error.message : 'merge step refused'}; another executor already performed that step on merge execution ${granted.execution.id}, so this executor stands down and leaves the execution intact`);
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
export function mergeExecutor(config: MasterConfig, snapshot: () => Promise<{ work: Work[]; now: string }>, mutation: (path: string, data: unknown, requestId?: string) => Promise<any>, executor: MergeExecutor, outerRequest: string, run?: ChildRun) {
  const stepKey = (item: Work, step: string, executionId = '') => createHash('sha256').update(`${outerRequest}\0master-merge\0${item.id}\0${item.candidate?.sha ?? ''}\0${step}\0${executionId}`).digest('hex');
  // Every step names the executor instance; the engine binds it to the principal and refuses a
  // step — cancel above all — from any other instance, so the owner the broker resumes on is
  // exactly the one the engine recorded.
  const instance = executor.instance;
  return (item: Work) => mergeWork(config, item, snapshot,
    (latest, authorization) => mutation(`work/${latest.id}/merge-acquire`, { expectedRevision: authorization.revision, sha: authorization.sha, baseSha: authorization.baseSha, policyRevision: authorization.policyRevision, executor: instance }, stepKey(latest, 'acquire')),
    (latest, execution, reason) => mutation(`work/${latest.id}/merge-cancel`, { executionId: execution.id, reason, executor: instance }, stepKey(latest, 'cancel', execution.id)),
    (latest, execution) => mutation(`work/${latest.id}/merge-verify`, { executionId: execution.id, executor: instance }, stepKey(latest, 'verify', execution.id)), run, mergeExecutionOwner(executor),
    (latest, execution) => mutation(`work/${latest.id}/merge-commit`, { executionId: execution.id, executor: instance }, stepKey(latest, 'commit', execution.id)),
    (latest, carried) => repostCarriedApproval(config, latest, carried, { run: run ?? defaultChildRun }),
    latest => mutation(`work/${latest.id}/resync`, {}, stepKey(latest, `refresh:${latest.observation?.at ?? ''}`)));
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
 * pushes its assigned branch and opens the pull request without a keypress, and is denied pushing
 * the base branch, force-pushing, deleting a ref, rebasing, merging, reviewing and reading a
 * credential, in every spelling a rule names; a spelling no rule names is unmatched, not denied.
 *
 * The one history rewrite it may make goes through `restore-branch GY-N EPOCH`, never a raw push:
 * the recovery of an ejected or contaminated tip resets the assigned branch to the item's reviewed
 * head, syncs it onto the base and pushes, and the rework the control plane authorizes must be
 * executable by the session it dispatches (GY-128). A permission glob cannot say "this ref and no
 * other", and a Claude worker runs under bypassPermissions, where a command no rule matches runs.
 * So every raw `--force*` push is denied, the lease push included, and the CLI makes the one lease
 * push itself: to the branch registered for the caller's live lease, conditional on the tip it
 * fetched (`--force-with-lease=refs/heads/BRANCH:TIP`), so it replaces only what it saw.
 */
/** Every character an empty-source refspec's name can start with as typed: a ref name's first character, a quote, or an expansion. */
export const emptySourceStarts = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...'_.-/@\'"$`{~'];
export function workerHarnessPlan(input: { cliPath: string; branch: string; baseBranch: string; credentialHome: string }): HarnessPlan {
  const cli = `node ${input.cliPath}`;
  const allow: HarnessRule[] = [
    ...['status', 'sync', 'restore-branch', 'complete', 'blocked', 'heartbeat', 'events', 'diagnose'].map(command => ({ rule: `Bash(${cli} ${command}:*)`, why: `The worker's own ${command} command on its claimed item; the server checks the lease epoch.` })),
    { rule: `Bash(git push origin ${input.branch})`, why: 'Push the assigned branch; Graphyard observes it as the candidate head.' },
    { rule: `Bash(git push -u origin ${input.branch})`, why: 'Publish the assigned branch the first time.' },
    { rule: `Bash(git push origin HEAD:${input.branch})`, why: 'Push the current head to the assigned branch.' },
    { rule: 'Bash(git fetch origin)', why: 'Read the remote tips restore-branch and sync compare against.' },
    { rule: 'Bash(git reset --hard *)', why: 'Move the assigned branch back to the reviewed head before sync; it changes only this worktree.' },
    { rule: 'Bash(gh pr create:*)', why: 'Open the pull request the worker submits with complete.' },
    { rule: 'Bash(gh pr view:*)', why: 'Read the pull request number and state before submitting.' },
    { rule: 'Bash(gh pr checks:*)', why: 'Read CI results for the worker\'s own candidate.' },
    { rule: `Bash(git merge origin/${input.baseBranch})`, why: 'sync merges the base branch; the worker never rebases.' },
  ];
  // Every rewrite, in each spelling a rule can name: `--force`, `--force-with-lease` (bare or
  // `=REF:SHA`) and `--force-if-includes` alike, and the abbreviations git accepts for them. The
  // lease push of the assigned branch is restore-branch's, which checks the ref itself; no rule may
  // end in `:*` or ` *` where the bare prefix would match an allowed push, because Claude Code reads
  // both as "this prefix, with or without more". Nor may `:*` stand anywhere but at the end: Claude
  // Code skips such a rule and stops the session on a settings warning before it starts
  // (claudeRuleProblem), so the empty-source refspec is spelled once per character its name can
  // start with (` :g*`, ` :r*`, …), plus the bare ` :` that pushes every matching branch. Each rule
  // also has a twin for a push behind git's global options (`git -C DIR push`, `git -c KEY=VALUE push`).
  const push: [string, string][] = [
    ['*--force*', 'A raw force push, the lease form included, could rewrite any ref: a glob cannot limit it to the assigned branch. The one restoration push is restore-branch.'],
    ['*--f*', 'Any abbreviation git accepts for --force, --force-with-lease or --force-if-includes.'],
    ['-f*', 'Short form of a force push.'],
    ['* -f*', 'Short form of a force push.'],
    ['*-*f *', 'A force flag bundled with other short flags (-uf).'],
    ['*-*f', 'A force flag bundled with other short flags, last on the line.'],
    ['*+*', 'A leading + refspec is a force push.'],
    ['*--mirror*', 'Mirroring rewrites every ref on the remote.'],
    ['*--m*', 'An abbreviation of --mirror.'],
    ['*--all*', 'The worker pushes its assigned branch, never every branch.'],
    ['*--al*', 'An abbreviation of --all.'],
    ['*--delete*', 'Deleting a remote ref is never part of an attempt.'],
    ['*--de*', 'An abbreviation of --delete.'],
    ['*--pru*', 'Pruning deletes every remote ref the local side lacks.'],
    ['-d*', 'Short form of deleting a remote ref, alone or first in a bundle (-du).'],
    ['* -d*', 'Short form of deleting a remote ref, alone or first in a bundle (-du).'],
    ['*-*d *', 'A delete flag bundled with other short flags (-ud).'],
    ['*-*d', 'A delete flag bundled with other short flags, last on the line.'],
    ...emptySourceStarts.map((start): [string, string] => [`* :${start}*`, 'An empty source refspec deletes the ref it names, whatever the name.']),
    ['* :', 'A bare ":" refspec pushes every matching branch, the base branch included.'],
    [`*:${input.baseBranch}*`, 'The base branch moves only through the guarded merge.'],
    [`origin ${input.baseBranch}*`, 'The base branch moves only through the guarded merge.'],
    [`* ${input.baseBranch}`, 'The base branch moves only through the guarded merge.'],
    [`* ${input.baseBranch} *`, 'The base branch moves only through the guarded merge.'],
    [`*refs/heads/${input.baseBranch}*`, 'The base branch moves only through the guarded merge, in its full ref spelling too.'],
  ];
  const deny: HarnessRule[] = [
    ...push.flatMap(([form, why]) => [{ rule: `Bash(git push ${form})`, why }, { rule: `Bash(git -* push ${form})`, why: `${why} Also behind git's global options.` }]),
    { rule: 'Bash(git rebase:*)', why: 'sync merges the base branch; a rebase would re-resolve files outside the planned files.' },
    { rule: 'Bash(gh pr merge:*)', why: 'Workers never merge; the control plane\'s merge gate decides.' },
    { rule: 'Bash(gh pr review:*)', why: 'Workers never review their own work.' },
    { rule: 'Bash(*GRAPHYARD_TOKEN_FILE=*)', why: 'A worker acts only as its own principal.' },
    { rule: `Read(//${input.credentialHome}/**)`, why: 'Credentials are used through the CLI, never read into a transcript.' },
    { rule: 'Read(**/*.token)', why: 'Token files are never read into a session transcript.' },
  ];
  return { harness: 'claude', file: '.claude/settings.local.json', allow, deny, manual: null, note: 'Worker rules for one assigned worktree: its own commands and its own branch. A harness rule is a prompt policy; branch protection, leases and the merge gate remain the enforcement.' };
}
/**
 * How a worker restores its assigned branch after an ejected or contaminated tip, as the exact
 * commands a rework reason carries: fetch, reset to the item's reviewed head, sync onto the base,
 * restore-branch (the lease push of the leased branch), complete. Every one is permitted by the
 * worker's own harness, so the rework the control plane authorizes is carried out by the attempt it
 * dispatches, with no human shell.
 */
export function branchRestoration(input: { cliPath: string; key: string; epoch: number; pr: number; reviewedHead: string }) {
  const cli = `node ${input.cliPath}`;
  return ['git fetch origin', `git reset --hard ${input.reviewedHead}`, `${cli} sync ${input.key}`, `${cli} restore-branch ${input.key} ${input.epoch}`, `${cli} complete ${input.key} ${input.epoch} ${input.pr}`];
}
/**
 * The shell commands a blocker names: each backtick-quoted command line, or, in a blocker that
 * quotes none, each `git push …` clause. The worker's blocker instruction asks for the exact
 * command that was refused, so this is where it is written.
 */
export function blockerCommands(text: string) {
  const quoted = [...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1].trim()).filter(command => /^[a-z][\w.-]*\s+\S/.test(command));
  const found = quoted.length ? quoted : [...text.matchAll(/\bgit push\b[^\n;,'"]*/g)].map(match => match[0].replace(/\s+(?:was|were|is|failed|fails|because|but)\b.*$/, '').trim().replace(/[.:]$/, ''));
  return [...new Set(found)];
}
export interface UnrunnableRemedy { key: string; epoch: number; command: string; role: 'worker'; rule: string; why: string; deniedBy: { role: string; rule: string }[]; text: string }
/**
 * A blocker whose remedy no session Graphyard launches may run is a defect of Graphyard, not a
 * wait on a human shell (GY-128): Graphyard authorized work that none of its own sessions can
 * carry out. Every command a blocker names is judged against each launched role's harness —
 * the item's worker on its assigned branch, reviewer, producer and master — and reported when
 * every one of them denies it, naming the command, the role that would need it (the worker that
 * raised the blocker) and the rule in that role's harness that denies it.
 */
export function unrunnableRemedies(work: Work[], input: { cliPath: string; baseBranch: string; repository?: string; workerKinds?: string[] }): UnrunnableRemedy[] {
  const shared = { cliPath: input.cliPath, repository: input.repository ?? 'OWNER/REPOSITORY', baseBranch: input.baseBranch, credentialHome: '/graphyard-credentials', credentialDirectories: [] as string[] };
  const others = [
    { role: 'reviewer', plan: sessionHarnessPlan({ ...shared, role: 'reviewer', kind: 'claude' }) },
    { role: 'producer', plan: sessionHarnessPlan({ ...shared, role: 'producer', kind: 'claude' }) },
    { role: 'master', plan: masterHarnessPlan({ ...shared, harness: 'claude', root: '/repository' }) },
  ];
  // A worker runtime other than Claude loads no generated rules, so a rework dispatched to it may
  // run the command: only when every configured worker runtime denies it is the remedy unrunnable.
  const workerKinds = [...new Set(input.workerKinds?.length ? input.workerKinds : ['claude'])];
  if (workerKinds.some(kind => kind !== 'claude')) return [];
  return work.filter(item => item.stage !== 'done' && item.blocker).flatMap(item => {
    const epoch = item.workspaces.at(-1)?.epoch ?? item.epoch;
    const branch = item.workspaces.at(-1)?.branch ?? `graphyard/${item.key.toLowerCase()}-${epoch}`;
    const worker = sessionHarnessPlan({ ...shared, role: 'worker', kind: 'claude', branch });
    return blockerCommands(item.blocker!).flatMap(command => {
      const own = harnessDecision(worker, command);
      if (own.decision !== 'deny') return [];
      const deniedBy = others.map(({ role, plan }) => ({ role, judged: harnessDecision(plan, command) }));
      if (deniedBy.some(entry => entry.judged.decision !== 'deny')) return [];
      return [{ key: item.key, epoch, command, role: 'worker' as const, rule: own.rule!.rule, why: own.rule!.why,
        deniedBy: deniedBy.map(entry => ({ role: entry.role, rule: entry.judged.rule!.rule })),
        text: `${item.key}'s blocker names \`${command}\`, which no session Graphyard launches may run: the worker that needs it is denied by its harness rule ${own.rule!.rule} (${own.rule!.why}), and ${deniedBy.map(entry => `the ${entry.role} by ${entry.judged.rule!.rule}`).join(', ')}. This is a Graphyard defect, not a wait on a human shell` }];
    });
  });
}
/** Install the worker rules in a freshly prepared worktree, only where Git already ignores them. */
export async function installWorkerHarness(config: MasterConfig, profile: WorkerProfile, key: string, prepared: PreparedWorker) {
  if (profile.kind !== 'claude') return { applied: false, reason: `No generated worker rules for ${profile.kind}` };
  try { await defaultChildRun('git', ['check-ignore', '--quiet', '--', '.claude/settings.local.json'], { cwd: prepared.path }); }
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
export function approvedMerge<T extends { action: string; state: string; input: any; approvedBy: string | null }>(work: Work, decisions: T[]): T | null {
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
/**
 * One session name per decision, not per item. An item takes several decisions in its life — rework
 * after a verdict, rework after a base conflict, a merge approval — and an approver stops when it
 * has judged, leaving its tab listed. Named per item, that finished tab refused the launch of the
 * next decision's approver until somebody closed it by hand.
 *
 * Per decision and inside the runtime's limit, both (GY-101): the fixed prefix and an eight-
 * character decision fragment left four characters for the key, so every key from GY-10 up built a
 * 33-character name no runtime would take and no approver could be launched at all. The key is
 * kept whole now and the decision id takes what the limit leaves.
 */
/**
 * Two decisions whose fragments match are one session: the second launch is refused as already
 * visible, or adopted as the first decision's approver. So the full role word is kept only while it
 * leaves at least `approverDistinguisher` characters of the decision id (one collision in ~16
 * million per pair, against one in 65,536 at the four the generic floor accepts); past that the
 * role word gives way to `gy-approver`, which affords the full eight for any key up to GY-12345678.
 */
export const approverDistinguisher = 6;
export const approverSessionName = (work: Pick<Work, 'key'>, decision: string) =>
  distinctSessionName(sessionNameLimit - sessionName('graphyard-approver', work.key).length - 1 >= approverDistinguisher ? ['graphyard-approver'] : ['gy-approver'], work.key, decision);
export async function launchApprover(root: string, work: Work, decision: string, explicitKind: NonNullable<WorkerProfile['kind']> | undefined, agents: HerdrAgent[], run?: ChildRun, probe: FleetProbe = {}) {
  const config = await loadMasterConfig(root);
  await agentToken(root, config, 'approver');
  const retry = `graphyard master approver ${work.key} ${decision} [AGENT_KIND]`;
  const name = nameForLaunch(retry, () => approverSessionName(work, decision));
  if (agents.some(agent => agent.name === name)) throw new Error(`Approver session ${name} is already visible in Herdr; let it finish or close it first`);
  // The approver's runtime and account come from the registry's approver role. An explicit
  // AGENT_KIND is the operator's override; an installation whose registry has no approver role
  // yet runs the approver on its first reviewer profile's runtime. No runtime is assumed.
  const selected = explicitKind ? null : await selectFleetSession(config, 'approver', { name, principal: config.approver!.id }, { ...probe, work: work.key });
  // Nothing here names a runtime: the role's account decides, then the operator's own argument,
  // then a runtime this installation already configured for another session.
  const kind = selected?.account.kind ?? explicitKind ?? config.reviewers[0]?.kind ?? config.workers[0]?.kind;
  // A launch refused for its runtime gives the chosen session back at once (GY-184).
  const plan = () => {
    if (!kind) throw new Error('No runtime is configured for the approver: name accounts for the approver role with graphyard master registry role set approver ACCOUNT[,ACCOUNT…] --reason REASON, or pass AGENT_KIND');
    return accountLaunch({ kind, approvals: 'auto', agentArgs: [], environment: {} }, selected?.account ?? null);
  };
  let launch: ReturnType<typeof accountLaunch>;
  try { launch = plan(); }
  catch (error) { await selected?.release(`approver launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`); throw error; }
  const cli = `node ${config.cliPath}`;
  let delivery: RequestDelivery | undefined;
  const prompt = `You are the independent Graphyard approver for ${config.repository}, acting as ${config.approver!.id}. Judge decision ${decision} on ${work.key}: run ${cli} master decisions ${work.key}, read the item with ${cli} status ${work.key}, its pull request and history, and weigh the requester's reason against the item's criteria and the operator's goals. If it is justified, run ${cli} master approve ${work.key} ${decision} "YOUR REASON". If not, record the refusal: run ${cli} master refuse ${work.key} ${decision} "YOUR REASON" — a decline is recorded, never expressed by exiting. Never approve a decision you requested, implemented, or produced evidence for; never edit, push, merge, review, or submit evidence. Stop when the decision is judged.`;
  let pane: string | undefined, tabId: string | undefined;
  try {
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root, '--label', `Approver · ${work.key}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_TOKEN_FILE=${config.approver!.credentialFile}`, '--env', 'GRAPHYARD_APPROVER=1', '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tabId = created.tab;
    ({ delivery } = await startAgentSession(name, kind, created.pane, launch.args, prompt, run, { directory: root, retry, contract: launch.contract, environment: launch.environment }));
  } catch (error) {
    if (pane || tabId) try { await stopCreatedHerdrTab(pane, tabId, run); } catch { /* the launch error below is the report */ }
    await selected?.release(`approver launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`);
    throw error;
  }
  return { agentName: name, work: work.key, decision, identity: config.approver!.id, pane: pane!, delivery, focusChanged: false,
    account: selected ? { environment: selected.account.name, kind, reason: selected.selection.reason, skipped: selected.skipped } : null };
}

/**
 * A context the handler received is what the control plane assembled: the fingerprint covers
 * every byte but itself, so a document altered or abridged on the way is refused before it is judged.
 */
export function verifiedContext(context: EscalationContext) {
  const { fingerprint, ...document } = context;
  if (contextFingerprint(document) !== fingerprint) throw new Error(`The escalation context for ${context.key} does not match its fingerprint ${fingerprint}; fetch it again from the control plane`);
  return context;
}
/**
 * Spawn a judging session for one escalation (GY-90). It is a fresh master: its whole input is
 * the assembled context, written to one private file, and the escalation inside it. It holds no
 * loop state, reads nothing else, and records its decision with `master decide … --precedent
 * --context`, so the ledger carries the reason, the precedent it relied on and what it saw; with
 * no precedent to cite it decides without `--precedent`, and the ledger records that (GY-138).
 */
export async function launchEscalationHandler(root: string, config: MasterConfig, context: EscalationContext, kind: NonNullable<WorkerProfile['kind']>, agents: HerdrAgent[], run?: ChildRun) {
  await agentToken(root, config, 'operatorAgent');
  const escalationRetry = `graphyard master escalation ${context.key} ${context.escalation.trigger} ${kind}`;
  const name = nameForLaunch(escalationRetry, () => distinctSessionName(['graphyard-escalation', 'graphyard-esc', 'gy-esc'], context.key, context.escalation.trigger));
  if (agents.some(agent => agent.name === name)) throw new Error(`Escalation handler ${name} is already visible in Herdr; let it finish or close it first`);
  const directory = resolve(await localDirectory(root), 'escalations'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, `${context.key}-${context.escalation.trigger}-${context.fingerprint.slice(0, 12)}.json`);
  await atomicPrivateWrite(file, context);
  const launch = agentLaunchPlan(kind, 'auto');
  const cli = `node ${config.cliPath}`;
  const prompt = `You are a Graphyard escalation handler spawned for the ${context.escalation.trigger} escalation on ${context.key} in ${config.repository}, acting as ${config.operatorAgent!.id}. Your entire input is the file ${file}: the context the control plane assembled for this decision — the repository's own operating rules and policy, the current goals and priorities, the item (requirements, the standing refusal, the candidate, its typed history) and precedent (earlier ${escalationAction} decisions with their reasons and outcomes). Read that file and nothing else: do not run status, events or any other read, do not open the repository, and hold no state beyond it. Decide whether the ${context.escalation.trigger} escalation should be resolved, following the precedent that applies and saying which. If it should, run ${cli} master decide ${context.key} ${escalationAction} '{"trigger":"${context.escalation.trigger}"}' --precedent DECISION_ID[,DECISION_ID] --context ${context.fingerprint} "YOUR REASON" exactly once, citing only ids listed in precedent.detail; when precedent.detail lists no decision that applies, leave out --precedent and the control plane records that no precedent was available — never invent an id. An independent approver judges it. If it should not, request nothing and state the reason in this tab. Never edit, push, merge, review, approve or submit evidence. Stop when the decision is recorded or declined.`;
  let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined;
  try {
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root, '--label', `Escalation · ${context.key}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', 'GRAPHYARD_ESCALATION_HANDLER=1', '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tabId = created.tab;
    // The instruction is the session's own first request (GY-93), never pasted into it: a handler
    // that refused a pasted prompt would record no decision and leave the escalation standing.
    ({ delivery } = await startAgentSession(name, kind, created.pane, launch.args, prompt, run, { directory: root, retry: escalationRetry, environment: launch.environment }));
  } catch (error) {
    if (pane || tabId) try { await stopCreatedHerdrTab(pane, tabId, run); } catch { /* the launch error below is the report */ }
    throw error;
  }
  return { agentName: name, work: context.key, trigger: context.escalation.trigger, fingerprint: context.fingerprint, context: file, identity: config.operatorAgent!.id, pane: pane!, delivery, focusChanged: false };
}

export const broadScopeFlag = '--allow-broad-scope';
/**
 * Where planned files are set — `master create`, `master requirements`, `master scope` — a
 * root-level directory scope is refused with the narrower paths it should name (AC-2 of GY-112),
 * unless the command carries --allow-broad-scope: the exception is then written into the audited
 * reason, naming the scopes, so it is explicit and attributable to the identity that set it. A
 * revision is judged on the scopes it introduces; one the item already carries is not re-refused.
 */
export function guardBroadScope(input: { plannedFiles?: string[]; title?: string; description?: string; criteria?: { text: string }[] }, reason: string, options: { allow: boolean; command: string; existing?: string[] }) {
  const refusals = broadScopeRefusals(input.plannedFiles ?? [], [input.title ?? '', input.description ?? '', ...(input.criteria ?? []).map(criterion => criterion.text)]).filter(refusal => !options.existing?.includes(refusal.scope));
  if (!refusals.length) return reason;
  if (!options.allow) throw new Error(`${options.command} refused a high-conflict scope: ${refusals.map(refusal => refusal.reason).join('; ')}. Pass ${broadScopeFlag} to record the exception in the audited reason instead`);
  return `Broad scope exception (${refusals.map(refusal => refusal.scope).join(', ')}) recorded with ${broadScopeFlag}: ${reason}`;
}
export const autonomySubcommands = ['autonomy', 'create', 'release', 'unblock', 'requirements', 'repair', 'decide', 'decisions', 'approve', 'approver', 'principals', 'restart', 'environments', 'context', 'escalation'] as const;
export interface AutonomyDependencies {
  coordinator: (path: string) => Promise<any>;
  readSecret: () => Promise<string>;
  agents: () => HerdrAgent[] | Promise<HerdrAgent[]>;
  daemonLock: () => Promise<{ pid: number; host: string; heartbeatAt: string } | null>;
  fetcher?: typeof fetch;
  /** Runs the roster applier; the default is the asynchronous runner with the applier's output passed through. */
  run?: (command: string, args: string[], options?: ChildRunOptions) => string | Buffer | Promise<string | Buffer>;
  /**
   * Refuses a `decide` the caller does not own (GY-175), judged on the exact work document and
   * snapshot clock the decision is then built from, so a later read cannot move the item under it.
   */
  assertDecision?: (work: Work, action: string, input: unknown, now: number) => void | Promise<void>;
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
  const snapshotItem = async (key: string | undefined) => {
    if (!key) throw new Error(`Use master ${id} GY-N …`);
    const snapshot = await deps.coordinator('work-snapshot'), found = snapshot.work.find((work: Work) => work.id === key || work.key === key);
    if (!found) throw new Error(`Unknown work item ${key}`); return { work: found as Work, now: Date.parse(snapshot.now) };
  };
  const item = async (key: string | undefined) => (await snapshotItem(key)).work;
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
  const allowBroad = args.includes(broadScopeFlag); args = args.filter(argument => argument !== broadScopeFlag);
  if (id === 'create') {
    if (!args[0]) throw new Error(`Use master create FILE [${broadScopeFlag}] REASON`);
    const input = await jsonArgument(`@${args[0]}`);
    return call(await operator(), 'work', { ...input, reason: guardBroadScope(input, reason(args.slice(1)), { allow: allowBroad, command: 'master create' }) });
  }
  if (id === 'release' || id === 'unblock') {
    const work = await item(args[0]);
    return call(await operator(), `work/${work.id}/${id === 'release' ? 'ready' : 'unblock'}`, { expectedRevision: work.revision, reason: reason(args.slice(1)) });
  }
  if (id === 'repair') {
    // The coordinator's own request (GY-127): the control plane resets a branch found carrying
    // another item's unlanded commits to the item's own reviewed head and merges the base onto it.
    // The command records the request; the reconciliation job runs it and master status reports it.
    const work = await item(args[0]);
    const contamination = branchContamination(work, (await deps.coordinator('work-snapshot')).work as Work[]);
    if (!contamination) throw new Error(`${work.key} head ${work.candidate?.sha.slice(0, 12) ?? '(none)'} carries no other item's unlanded commits; there is nothing to repair`);
    if (pendingRestore(work)) throw new Error(`A repair of ${work.key} is already requested; graphyard master status reports it under contamination.restore`);
    return call(await readCredentialFile(config.credentialFile), `work/${work.id}/repair`, { reason: reason(args.slice(1)) });
  }
  if (id === 'requirements') {
    const work = await item(args[0]); if (!args[1]) throw new Error(`Use master requirements GY-N FILE [${broadScopeFlag}] REASON`);
    const input = decisionInput('requirements', work, await jsonArgument(`@${args[1]}`)) as { plannedFiles?: string[]; criteria?: { text: string }[] };
    return call(await operator(), `work/${work.id}/requirements`, { ...input, reason: guardBroadScope({ ...input, title: work.title, description: work.description }, reason(args.slice(2)), { allow: allowBroad, command: 'master requirements', existing: work.plannedFiles }) });
  }
  if (id === 'decide') {
    const { work, now } = await snapshotItem(args[0]); const action = args[1];
    if (!action) throw new Error('Use master decide GY-N ACTION [JSON|@FILE] [--precedent ID[,ID]] [--context FINGERPRINT] REASON');
    // A handler cites the decisions it followed and the fingerprint of the context it judged from.
    const flags: Record<string, string> = {}; const rest: string[] = [];
    for (let index = 2; index < args.length; index++) {
      if (args[index] === '--precedent' || args[index] === '--context') { flags[args[index].slice(2)] = args[++index] ?? ''; continue; }
      rest.push(args[index]);
    }
    const explicit = rest[0] && /^[{@]/.test(rest[0]);
    const input = explicit ? await jsonArgument(rest[0]) : {};
    await deps.assertDecision?.(work, action, input, now);
    return call(await operator(), `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason: reason(rest.slice(explicit ? 1 : 0)),
      ...(flags.precedent ? { precedent: flags.precedent.split(',').map(value => value.trim()).filter(Boolean) } : {}), ...(flags.context ? { context: flags.context } : {}) });
  }
  if (id === 'context' || id === 'escalation') {
    // The assembled context, read from the control plane by key and nothing else — no snapshot,
    // no status; `escalation` then spawns a fresh handler on it: the built-in precedent rule in
    // this process, or a judging session of KIND.
    if (!args[0]) throw new Error(`Use master ${id} GY-N [TRIGGER] [--budget N]${id === 'escalation' ? ' [precedent|AGENT_KIND]' : ''}`);
    const rest: string[] = []; let budget: string | undefined;
    for (let index = 1; index < args.length; index++) { if (args[index] === '--budget') budget = args[++index]; else rest.push(args[index]); }
    const trigger = rest.find(value => (escalationTriggers as readonly string[]).includes(value));
    const params = new URLSearchParams(); if (trigger) params.set('trigger', trigger); if (budget) params.set('budget', budget);
    const context = verifiedContext(await deps.coordinator(`work/${encodeURIComponent(args[0])}/context${params.size ? `?${params}` : ''}`));
    if (id === 'context') return context;
    const handler = rest.find(value => value !== trigger) ?? 'precedent';
    if (handler === 'precedent') return handleEscalation(context, followPrecedent, async request => call(await operator(), `work/${encodeURIComponent(context.key)}/decide`, request));
    return launchEscalationHandler(root, config, context, agentKindSchema.parse(handler), await deps.agents());
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
    return launchApprover(root, work, args[1], args[2] ? agentKindSchema.parse(args[2]) : undefined, await deps.agents());
  }
  if (id === 'principals') {
    const live = (await deps.coordinator('principals')).principals;
    const preview = previewPrincipalRotation(live, await readProposedRoster(root));
    if (!args.includes('--apply')) return { ...preview, applied: false, next: preview.applicable ? 'Rerun with --apply to deploy the roster' : 'Restore every live principal in .graphyard/credentials.json; a rotation never drops one' };
    if (!preview.applicable) throw new Error(`Roster rotation refused: ${preview.refusals.join('; ')}`);
    const applier = resolve(root, 'scripts/provision-railway.mjs');
    try { await lstat(applier); } catch { throw new Error('This repository has no roster applier (scripts/provision-railway.mjs); deploy GRAPHYARD_PRINCIPALS with the configured provider'); }
    await (deps.run ?? defaultChildRun)(process.execPath, [applier], { cwd: root, env: { ...process.env, GRAPHYARD_URL: config.url }, stdout: 'inherit', stderr: 'inherit' });
    return { ...preview, applied: true, next: 'Redeploy the service so the roster takes effect, then graphyard master status' };
  }
  return restartMasterLoop(root, config, await deps.daemonLock());
}
