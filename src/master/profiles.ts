// Concern: worker, reviewer and producer profiles, the master config schema, and profile session naming.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defaultChildRun } from '../child-runner.js';
import { pathScopeContains } from '../model/scope.js';
import { temporaryDirectories, underTestRunner } from '../supervisor.js';
import { decompositionSettingsSchema, diagnosticianSettingsSchema, narrowRoleRuntimeSchema, piRuntimeSchema } from '../runner/payloads.js';
import { researchSettingsSchema } from '../research.js';
import { doctorSettingsSchema } from './doctor-settings.js';
import { candidateSettingsSchema, mergeWriterSettingsSchema, shadowGateSettingsSchema } from './merge-writer-settings.js';
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

/**
 * GY-1960: a schema that keeps the fields it does not know. The files one version writes are read
 * by others: a rollback, or a CLI pinned to the held release, opens a file a newer version wrote,
 * and a writer that dropped fields it did not set lost them for good (GY-1918). `forwardTolerant`
 * rebuilds `schema` so every object in it keeps unknown keys — zod 4 encodes `.strict()` as a
 * `never` catchall and `.passthrough()` as an `unknown` one, so each object node is cloned with the
 * `unknown` catchall — while every declared field still validates and defaults, and the wrappers
 * around them (optionals, defaults, refinements, transforms, records, unions, lazies) are carried
 * across. An unknown key then round-trips read and write unchanged, and a file a newer version
 * wrote parses here instead of failing it. The rebuilt schema keeps its own type — a ZodObject
 * stays one, shape included — so readers of the schema see exactly what they saw. A key a version
 * declared and later retired is not unknown: schemas keep dropping those on purpose (master
 * config's mergeQueue, GY-1264). A schema marked with `keepStrict` is a closed selection and stays
 * as it was.
 */
export function forwardTolerant<T extends z.ZodTypeAny>(schema: T): T {
  return tolerateSchema(schema, new Map()) as T;
}

const keptStrict = new WeakSet<object>();
/** Marks `schema` as a closed selection `forwardTolerant` leaves strict: a key it does not declare is refused, not kept. */
export function keepStrict<T extends z.ZodTypeAny>(schema: T): T {
  keptStrict.add(schema);
  return schema;
}

function tolerateSchema(schema: unknown, seen: Map<unknown, unknown>): any {
  if (!schema || typeof schema !== 'object' || !(schema as any)._zod?.def || keptStrict.has(schema)) return schema;
  if (seen.has(schema)) return seen.get(schema);
  const def = (schema as any)._zod.def;
  let rebuilt: unknown;
  switch (def.type) {
    case 'object': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      rebuilt = (schema as any).clone({ ...def, shape: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, tolerateSchema(value, seen)])), catchall: z.unknown() });
      break;
    }
    case 'optional': case 'nullable': case 'default': case 'prefault': case 'readonly': case 'catch':
      rebuilt = (schema as any).clone({ ...def, innerType: tolerateSchema(def.innerType, seen) }); break;
    case 'array': rebuilt = (schema as any).clone({ ...def, element: tolerateSchema(def.element, seen) }); break;
    case 'record': rebuilt = (schema as any).clone({ ...def, valueType: tolerateSchema(def.valueType, seen) }); break;
    case 'tuple': rebuilt = (schema as any).clone({ ...def, items: def.items.map((item: unknown) => tolerateSchema(item, seen)), ...(def.rest ? { rest: tolerateSchema(def.rest, seen) } : {}) }); break;
    case 'union': rebuilt = (schema as any).clone({ ...def, options: def.options.map((option: unknown) => tolerateSchema(option, seen)) }); break;
    case 'intersection': rebuilt = (schema as any).clone({ ...def, left: tolerateSchema(def.left, seen), right: tolerateSchema(def.right, seen) }); break;
    case 'pipe': rebuilt = (schema as any).clone({ ...def, in: tolerateSchema(def.in, seen) }); break;
    case 'lazy':
      // Registered before its getter can run, so a recursive schema reaches itself through the map.
      rebuilt = (schema as any).clone({ ...def, getter: () => tolerateSchema(def.getter(), seen) });
      seen.set(schema, rebuilt);
      return rebuilt;
    default: return schema; // leaves (strings, numbers, literals) have nothing to keep
  }
  seen.set(schema, rebuilt);
  return rebuilt;
}

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
  // GY-1302, GY-1488: the minimum gap between the loop's dispatches of .github/workflows/release-candidate.yml
  // with promote=true, made as soon as the base branch has moved past the last promoted SHA and the
  // last cut and no candidate is in validation. Unset: 10 (`defaultPromoteEveryMinutes`); 0 turns it off.
  promoteEveryMinutes: z.number().int().min(0).max(10080).optional(),
  // GY-1398: how long the deployment step reuses its last verified release observation while every
  // delivery is already served and none is pending, instead of reading GitHub every cycle. Unset: 15
  // (`defaultDeploymentReuseMinutes`); 0 reads live every cycle.
  deploymentReuseMinutes: z.number().int().min(0).max(1440).optional(),
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
  // Worktree reclamation: idle hours before dependencies count as disposable, and free space
  // threshold for disk pressure. Both read from .graphyard/master.json on every cycle.
  reclaimIdleHours: z.number().min(0.25).max(720).optional(),
  diskThresholdGb: z.number().min(0.1).max(10_000).optional(),
  // How many finished assignment worktrees one reclaim pass removes outright (GY-360; default 50),
  // so a large backlog drains over a few cycles without stalling any one of them.
  worktreeRemovalLimit: z.number().int().min(1).max(1000).optional(),
  // Managed worktree root for proof and review checkouts: absolute path outside worktrees,
  // required free space, and max size before master status asks for a reclaim.
  worktreeRoot: z.string().trim().min(1).max(1000).refine(isAbsolute, 'worktreeRoot must be an absolute path').optional(),
  worktreeRootMinFreeGb: z.number().min(0.1).max(10_000).optional(),
  worktreeRootBudgetGb: z.number().min(0.1).max(10_000).optional(),
  // An account whose usage reached this percentage of any window is skipped at launch: a session started just below a hard limit would stall mid-task.
  quotaCeilingPercent: z.number().int().min(50).max(100).optional(),
  // The runtime of each narrow role (GY-169): `herdr` terminal session, or `pi` headless runner
  // (the approver and unit proof producer). `pi` names the wrapper and model those runs use.
  // A closed selection: only the narrow roles choose a runtime, so a key naming any other role is refused.
  runtimes: keepStrict(narrowRoleRuntimeSchema).optional(),
  pi: piRuntimeSchema.optional(),
  // Research before build (GY-259): the cheap Pi session that briefs a feature before its worker
  // starts — its model (the Z.AI GLM flash model by default), time limit and token budget.
  research: researchSettingsSchema.optional(),
  decomposition: decompositionSettingsSchema.optional(), // splitting broad items before first dispatch (GY-1126): size bounds and run time limit; it runs on run.research's account
  // The pipeline doctor (GY-711): headless Pi session fixing stuck work every intervalMinutes (5 by default).
  doctor: doctorSettingsSchema.optional(),
  // The diagnostician (GY-439): headless Pi session turning each recurring-fault item into its root
  // cause and fix item — its model, fallback, time limit, bound and log-reading commands.
  diagnostician: diagnosticianSettingsSchema.optional(),
  shadowGate: shadowGateSettingsSchema.optional(),
  mergeWriter: mergeWriterSettingsSchema.optional(), // the control-plane merge executor's deploy key and re-trial bound (GY-1524)
  candidates: candidateSettingsSchema.optional(), // when the loop cuts release candidates itself in control-plane mode (GY-1526): every N merges or M idle minutes
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
// GY-516: default for mergeQueue.rerunFailedChecks (reruns failed check once on same sha; 0 disables).
export const defaultRerunFailedChecks = 1;
// The most reruns per sha and check master config and the control plane accept.
export const maxRerunFailedChecks = 3;
/**
 * Who reviews and merges (GY-1501). `autonomous`, the default every existing install keeps: the
 * reviewer App reviews and the master's operator-agent and approver identities decide. `supervised`,
 * where `up --local` starts: the operator reviews each pull request on GitHub (a non-author approval of
 * the exact head) and GitHub auto-merge merges it; the loop launches no reviewer, approver or
 * escalation session and the master claims no autonomy. `master promote` promotes it (GY-1502).
 */
export const supervisionModes = ['autonomous', 'supervised'] as const;
export type Supervision = typeof supervisionModes[number];
export const promotionCommand = 'graphyard master promote --admin-token-stdin (after graphyard master reviewer setup and master reviewer add)';
export const masterConfigSchema = forwardTolerant(z.object({
  version: z.literal(1),
  // Absent is autonomous, so every existing master.json loads and is written back unchanged.
  supervision: z.enum(supervisionModes).optional(),
  // The operator's own GitHub login (supervised mode): a candidate it authored cannot be independently approved by it.
  operatorLogin: z.string().trim().min(1).max(100).optional(),
  url: z.string(),
  credentialFile: z.string(),
  cliPath: z.string(),
  repository: z.string().min(1),
  baseBranch: z.string().min(1).max(200),
  // APP_PENDING (0) while `install --apply` still waits at its App step (GY-1413); the real id once confirmed.
  githubAppId: z.number().int().nonnegative(),
  hostId: z.string().trim().min(1).max(200),
  herdrWorkspace: z.string().trim().min(1).max(200).optional(),
  // This install's own Herdr instance (GY-1511), when the host's default one serves another install:
  // every herdr call the install makes carries its XDG_CONFIG_HOME and --session (master/herdr.ts).
  herdrInstance: z.object({ configHome: z.string().trim().min(1).max(500).refine(isAbsolute, 'must be absolute'), session: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) }).strict().optional(),
  masterAgentName: sessionNameField,
  autoMerge: z.boolean().default(true),
  // Review rounds before only a blocking finding stands against it (GY-1118; default 3).
  reviewRoundCap: z.number().int().min(1).max(20).optional(),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  workers: z.array(workerProfileSchema).max(100).default([]),
  reviewer: reviewerIdentitySchema.optional(),
  reviewers: z.array(reviewerProfileSchema).max(20).default([]),
  producers: z.array(producerProfileSchema).max(20).default([]),
  // The agent environments profiles may launch on, discovered or created by master environments.
  environments: z.array(agentEnvironmentSchema).max(50).optional(),
  run: masterRunSchema.prefault({}),
  // `mergeQueue.rerunFailedChecks` (GY-516): reruns of a failed required check per sha; the loop
  // publishes it to the control plane on every change.
  // Retired keys are still accepted so an existing master.json loads, but parsing drops them
  // (GY-1264): nothing reads them, and every writer re-parses before it saves, so the next master
  // init or profile change removes them from the file instead of leaving inert settings an operator
  // would trust. `optimistic` and `optimisticExclude` retired with optimistic merge (GY-1233);
  // `batchSize`, `parallelTips` and `ciConcurrency` with Graphyard's own merge queue (GY-1236):
  // GitHub merges each passing candidate, so no speculative tip is batched or validated in parallel.
  mergeQueue: z.object({
    batchSize: z.unknown().optional(),
    optimistic: z.unknown().optional(),
    parallelTips: z.unknown().optional(),
    ciConcurrency: z.unknown().optional(),
    rerunFailedChecks: z.number().int().min(0).max(maxRerunFailedChecks).optional(),
    optimisticExclude: z.unknown().optional(),
  }).strict().transform(({ optimistic: _optimistic, optimisticExclude: _optimisticExclude, batchSize: _batchSize, parallelTips: _parallelTips, ciConcurrency: _ciConcurrency, ...kept }) => kept).optional(),
  // The operator's own authenticated browser profile, used only by master browser flows.
  browser: masterBrowserSchema.optional(),
  // The master's operator-agent identity and the approver identity for its two-party decisions. Paths only, never tokens.
  operatorAgent: agentIdentitySchema.optional(),
  approver: agentIdentitySchema.optional(),
  // GY-1855: install that receives uncleared loop-step stall filings; absent files into this install (slow-loop precedent).
  upstream: z.object({
    url: z.string().min(1).max(500),
    credentialFile: z.string().min(1).max(1000).refine(isAbsolute, 'upstream.credentialFile must be absolute'),
  }).strict().optional(),
  // The system invariants' thresholds (GY-404, src/model/invariants.ts), each defaulting to the loop's bound.
  invariants: invariantThresholdsSchema.optional(),
  // Delivery-speed p90 targets master status judges (GY-1232); unset keeps 2h ready→merged, 8h merged→production.
  deliverySpeed: z.object({ readyToMergedP90Ms: z.number().int().positive().max(30 * 86_400_000).optional(), mergedToProductionP90Ms: z.number().int().positive().max(30 * 86_400_000).optional() }).strict().optional(),
// GY-1960: master.json is forward-tolerant — fields a newer version wrote that this one does not
// declare parse and are written back unchanged, so a rollback or a held-CLI snapshot opens the file.
}).strict());
export type MasterConfig = z.infer<typeof masterConfigSchema>;
/** Sessions `run.reviewerProfile`'s profile runs at unset concurrency (GY-1072); other reviewer profiles keep one. */
export const automaticReviewerConcurrency = 4;
/** Sessions a producer profile runs at unset concurrency (GY-1113): at one, proofs queued an hour for a slot. */
export const automaticProducerConcurrency = 4;
/**
 * The config as the launchers and their readers count sessions: unset concurrency read as the role's
 * automatic default. `loadMasterConfig` applies it once at load (GY-1075) and writers read
 * `loadStoredMasterConfig`, so a default is never written back; idempotent, so any caller may apply it.
 */
export function withReviewerDefaults<T extends Pick<MasterConfig, 'reviewers' | 'run'>>(config: T): T {
  const automatic = config.run.reviewerProfile;
  if (!automatic || !config.reviewers.some(profile => profile.name === automatic && profile.concurrency === undefined)) return config;
  return { ...config, reviewers: config.reviewers.map(profile => profile.name === automatic && profile.concurrency === undefined ? { ...profile, concurrency: automaticReviewerConcurrency } : profile) };
}
export function withProducerDefaults<T extends Pick<MasterConfig, 'producers'>>(config: T): T {
  if (!config.producers.some(profile => profile.concurrency === undefined)) return config;
  return { ...config, producers: config.producers.map(profile => profile.concurrency === undefined ? { ...profile, concurrency: automaticProducerConcurrency } : profile) };
}
/**
 * The config as a supervised install runs it (GY-1501): no reviewer App, operator-agent or approver
 * identity, whatever master.json still records, so the loop launches no approver or escalation
 * session and the master requests no two-party decision; its reviewer answers in control-plane mode
 * (GY-1978), which needs a profile, not an App. Autonomous configs pass unchanged.
 */
export function withSupervision<T extends { supervision?: Supervision; reviewer?: unknown; operatorAgent?: unknown; approver?: unknown }>(config: T): T {
  if (config.supervision !== 'supervised') return config;
  const { reviewer: _reviewer, operatorAgent: _operatorAgent, approver: _approver, ...kept } = config;
  return kept as T;
}
export const withRoleDefaults = <T extends Pick<MasterConfig, 'reviewers' | 'producers' | 'run'> & { supervision?: Supervision; reviewer?: unknown; operatorAgent?: unknown; approver?: unknown }>(config: T): T => withSupervision(withProducerDefaults(withReviewerDefaults(config)));
/** Reruns of a failed required check per sha under this master config: `mergeQueue.rerunFailedChecks`, or the product default of 1. */
export function rerunFailedChecks(config: Pick<MasterConfig, 'mergeQueue'> | null | undefined): number {
  return config?.mergeQueue?.rerunFailedChecks ?? defaultRerunFailedChecks;
}

/**
 * The master config's githubAppId while the install's App step is still pending (GY-1413): the
 * master's local configuration (`master environments`, `master harness`) is usable before a human
 * confirms the App, bound to a server that reports no App either. Any real id stays strict.
 */
export const APP_PENDING = 0;

export function assertMasterBinding(config: MasterConfig, status: any) {
  if (status.actor?.role !== 'coordinator') throw new Error('Master commands require the configured coordinator identity');
  const appBound = config.githubAppId === APP_PENDING ? status.githubAppId === null || status.githubAppId === undefined : status.githubAppId === config.githubAppId;
  if (typeof status.repository !== 'string' || status.repository.toLowerCase() !== config.repository.toLowerCase() || status.baseBranch !== config.baseBranch || !appBound) throw new Error(config.githubAppId === APP_PENDING && Number.isSafeInteger(status.githubAppId)
    ? `The control plane now has GitHub App ${status.githubAppId} but this master was configured while the App step was pending; rerun graphyard install --apply (or master init) to bind it`
    : 'The Graphyard repository, managed base branch, or GitHub App changed; rerun master init before continuing');
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

// The OS-level confinement of the coordinator checkout (GY-888) lives in ./confinement.ts;
// these re-export it, so every existing import keeps working.
export { bwrapOnPath, sessionGitAdminDirectory, processLaunchMaskWords, isSocketPath, secretsBusPath, hostProcessLaunchTargets, readOnlyMountWrapper, confinementRefusalText, sessionMountNamespaceWorks, mountNamespaceProbeResult, coordinatorConfinementRefusal, coordinatorConfinement, type CoordinatorConfinement, type ConfinementInput } from './confinement.js';
