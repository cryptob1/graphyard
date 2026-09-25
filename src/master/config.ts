// Concern: loading, validating and saving the master config, its credential files and profiles, and live reload.
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, realpath, chmod, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute, dirname, basename, relative, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { defaultChildRun } from '../child-runner.js';
import { sessionName } from '../session-name.js';
import { discover, assertRepository, localDirectory, saveDiscovery } from '../onboarding.js';
import { serverOrigin, loadConnection, managedInstructions } from '../repository-setup.js';
import { launchPlan } from '../harness.js';
import { type LoopSupervisorHost, type LoopSupervisorInstallation, installLoopSupervisor, loopUnitName, unsupervisedInstruction, loopSupervisionAttention } from '../supervisor.js';
import { type FilesystemProbe, worktreeRoot, verifyWorktreeRoot, worktreeRootMinFreeBytes } from '../install/worktree-root.js';
import { type AgentEnvironment, type MasterBrowser, type MasterConfig, masterConfigSchema, type MasterRun, type ProducerProfile, producerProfileSchema, type WorkerProfile, workerProfileSchema } from './profiles.js';
import { managedMasterInstructions } from './instructions.js';
import { agentEnvironmentRoot, agentLaunchPlan, checkAgentEnvironment, discoverAgentEnvironments, type EnvironmentProbe, inspectProfileAccounts, type LaunchRole } from './environments.js';
import { controlPlaneAttention } from './attention.js';
import { writeFailure } from './worktrees.js';

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
export async function atomicPrivateText(file: string, value: string) {
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
