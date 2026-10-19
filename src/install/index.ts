import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { link, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collectScanInput, detectDeploy, detectStack, discover, proposeDelivery } from '../onboarding.js';
import { parseRepositoryConfig, repositoryConfigFile } from '../model/documentation.js';
import { requiredPullRequestChecks, type DeliveryPolicy } from '../model/delivery-policy.js';
import { deploymentAdapters, wiringActions, type DeploymentAdapter, type DeploymentContext } from './deploy-target.js';
import { adapterFor, carriesCredential, hetznerAddress, publishedPort, readRemote, isProviderReference, quotedPrice, variableMarker, type AdapterContext, type AdapterObservation, type ProviderAdapter, DEFAULT_IMAGE } from './adapters.js';
import { asUser, existingMachineAdapter, generateHostSecrets, SIGNIN_CLAIM_VARIABLE, hostHerdrOnly, hostLayout, hostProfilesOnly, hostPlan, hostDeployKeyFile, hostRemote, hostTokenFile, installHostFleet, readHostSecrets, selfContainedAdapter, MIGRATE_SOURCE_VARIABLE, type HostFleetResult } from './host.js';
import { githubCli, type GitHubCli } from './github.js';
import { DEPLOY_KEY_FILE, ensureDeployKey, registerDeployKey } from './deploy-key.js';
import { detectHerdr, detectRuntimes, masterRuntime, workerProfiles, type DetectedRuntime, type HerdrState, type ReviewerProfileDraft, type WorkerProfileDraft } from './runtimes.js';
import { generatedFilesAssignment, generatedManifestScript, type GeneratedFilesAssignment } from './generated-files.js';
import { repositoryPolicyAssignment } from '../model/repository-policy.js';
import { applicationProblems, caseIdsOf, projectDeliveryAssignment, projectDeliveryVariable } from '../project-applications.js';
import { delegationLimitAssignments, delegationLimitVariables } from './limits.js';
import { assertOutsideRepository, ensureTokens, fingerprint, installDirectory, installRecordSchema, plannedPrincipals, prepareInstallDirectory, principalOfRole, principalRecords, principalsVariable, readInstallRecord, reconcileRoster, recordedRoster, tokenFile, workerPrincipals, writeInstallRecord, Vault, type InstallRecord, type RosterPrincipal } from './secrets.js';
import { herdrBoundElsewhere, herdrPluginBinding, herdrRebindRefusal } from '../repository-setup.js';
import { herdrViaEnv, installHerdrInstance, type HerdrInstance } from '../master/herdr.js';
import { HerdrSetupFailure } from '../herdr-host.js';
import { localTransport, sshTransport, type Transport } from './transport.js';
import { localDatabaseVariable, localSettings, type LocalSupervisor } from './local.js';
import { localPaths } from './local-runtime.js';
import { durableCheckoutPreflight, loopStopTimeoutSeconds, underTestRunner } from '../supervisor.js';
import { installIdFor, providers, REDACTED, SERVER_PORT, type EnvValue, type InstallInputs, type InstallPlan, type PlanAction, type PlanDrift, type PlanValue, type PreflightItem, type Provider } from './types.js';

export * from './types.js';
export { adapterFor, type ProviderAdapter } from './adapters.js';

export interface ProfileRegistration {
  repository: { connected: boolean; herdr: boolean; detail: string };
  master: { configured: boolean; kind: string | null; detail: string };
  workers: { name: string; principal: string; kind: string }[];
  reviewers: ReviewerProfileDraft[];
}

export interface InstallDependencies {
  transport?: Transport;
  ssh?: (host: string, user?: string) => Transport;
  fetch?: typeof fetch;
  configHome?: string;
  sourceRoot?: string;
  /** The commit a Railway upload stamps as GRAPHYARD_BUILD_SHA; read from sourceRoot's checkout when absent. */
  sourceCommit?: string | null;
  cliPath?: string;
  hostId?: string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  detectRuntimes?: (transport: Transport) => Promise<DetectedRuntime[]>;
  detectHerdr?: (transport: Transport) => Promise<HerdrState>;
  /** Generates (when absent) and registers the merge writer's deploy key; ensureDeployKey through the transport's gh by default. */
  ensureDeployKey?: (installDir: string, repository: string, gh: GitHubCli) => Promise<string>;
  registerProfiles?: (request: ProfileRequest) => Promise<ProfileRegistration>;
  runHerdr?: (args: string[]) => string;
  /** Test seam: exercise the orchestration against a scripted provider. */
  adapter?: ProviderAdapter;
  /** Where --migrate reads GRAPHYARD_MIGRATE_DATABASE_URL (process.env by default). */
  environment?: NodeJS.ProcessEnv;
  /** The Graphyard commit a self-contained host runs its loop from (this checkout's HEAD by default). */
  graphyardRef?: string;
  /** How the local provider keeps its runtime alive (a systemd user unit by default); a test runs it in-process. */
  localSupervisor?: LocalSupervisor;
}

export interface ProfileRequest {
  root: string; url: string; cliPath: string; hostId: string; installDirectory: string;
  coordinatorToken: string; workerTokens: { principal: string; token: string }[];
  runtimes: DetectedRuntime[]; herdr: HerdrState; herdrRebind?: boolean;
  /** GY-1511: this install's own Herdr instance, where the plugin is linked instead of the host's default one. */
  herdrInstance?: HerdrInstance | null;
  workers: WorkerProfileDraft[]; reviewers: ReviewerProfileDraft[]; masterKind: string | null;
  runHerdr?: (args: string[]) => string;
}

/**
 * What the install does with Herdr's `graphyard` plugin when it is already bound to another server
 * (GY-1413): `rebind` repoints it (`--herdr-rebind`), `skip` leaves Herdr untouched (`--no-herdr`),
 * and `instance` (`--herdr-instance`, GY-1511) links it in this install's own Herdr instance, never
 * touching the default one. Without any, a plugin bound elsewhere fails preflight instead of being
 * silently repointed; `graphyard up` answers that with `--herdr-instance`.
 */
export interface HerdrChoice { herdr?: 'rebind' | 'skip' | 'instance' }
/**
 * GY-1851: `--fresh-cursor`, which `graphyard up` passes when it re-issues an install's credentials
 * onto a fresh database: a self-contained host's master loop is stopped, its cursor archived beside
 * itself, and the loop started again, on the host where it runs. Other installs run no loop here.
 */
export interface FreshCursorChoice { freshCursor?: boolean }
/**
 * GY-1846: observation-only install of an existing repository (`--observe-only`). The control
 * plane may be deployed, but nothing the managed repository or its product owns is changed — no
 * release ref, branch protection, auto-merge or merge queue, App, worker principal, profile,
 * supervisor unit, master loop, Herdr link, deploy key or product deployment — and Railway
 * variables are never read by value. Implies --no-herdr; the plan lists each held action.
 */
export interface ObserveOnlyChoice { observeOnly?: boolean }
export type InstallRequest = InstallInputs & HerdrChoice;

/**
 * The install request the `install` command's flags describe. It lives beside `resumeCommand`,
 * which must print flags that parse back to the same request (GY-1413).
 */
export function installRequestFromArgs(args: string[]) {
  const { values } = parseArgs({ args, options: {
    provider: { type: 'string' }, repo: { type: 'string' }, plan: { type: 'boolean' }, apply: { type: 'boolean' },
    domain: { type: 'string' }, workers: { type: 'string' }, image: { type: 'string' },
    'producer-proof': { type: 'string', multiple: true }, 'base-branch': { type: 'string' }, 'review-policy': { type: 'string' },
    'required-check': { type: 'string', multiple: true }, 'review-count': { type: 'string' },
    'ssh-host': { type: 'string' }, 'ssh-user': { type: 'string' }, 'ssh-key': { type: 'string' }, 'server-name': { type: 'string' }, workspace: { type: 'string' },
    'server-type': { type: 'string' }, location: { type: 'string' }, port: { type: 'string' }, logs: { type: 'boolean' },
    target: { type: 'string' }, local: { type: 'boolean' }, migrate: { type: 'boolean' }, 'max-monthly': { type: 'string' }, 'confirm-price': { type: 'string' },
    'create-environments': { type: 'boolean' }, 'herdr-rebind': { type: 'boolean' }, 'no-herdr': { type: 'boolean' }, 'herdr-instance': { type: 'boolean' }, 'herdr-only': { type: 'boolean' }, 'profiles-only': { type: 'boolean' }, 'fresh-cursor': { type: 'boolean' },
    'observe-only': { type: 'boolean' },
  }, allowPositionals: false });
  if ([values['herdr-rebind'], values['no-herdr'], values['herdr-instance']].filter(Boolean).length > 1) throw new Error('Choose one of --herdr-rebind, --no-herdr or --herdr-instance');
  if (!values.repo) throw new Error('Use --repo OWNER/NAME');
  // --target names a self-contained install (GY-717): an existing machine, or a Hetzner server it creates.
  if (values.target && values.provider) throw new Error('Use either --target host|hetzner (a self-contained host) or --provider (a server-only install)');
  if (values.target && !['host', 'hetzner'].includes(values.target)) throw new Error('Use --target host (an existing Linux machine) or --target hetzner (a server the installer creates)');
  const provider = values.target ?? values.provider;
  if (!provider || !providers.includes(provider as any)) throw new Error(`Use --provider ${providers.join('|')}, or --target host|hetzner`);
  // Observation-only (GY-1846) changes nothing the managed repository or its product owns, so
  // every flag that asks for such a change is refused; --no-herdr is implied.
  if (values['observe-only']) {
    const changes = observeOnlyConflicts(values, provider);
    if (changes.length) throw new Error(`--observe-only changes nothing the repository owns, so it cannot be combined with ${changes.join(', ')}`);
  }
  const money = (flag: string, value: string) => { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${flag} takes an amount such as 19.52`); return parsed; };
  if (values.plan && values.apply) throw new Error('Choose either --plan or --apply');
  const reviewPolicy = values['review-policy'];
  if (reviewPolicy && !['github', 'agent'].includes(reviewPolicy)) throw new Error('Use --review-policy github or agent');
  // A count that silently became NaN would install a control plane with no worker principal
  // or an unusable port, so a non-numeric value stops the command instead.
  const count = (flag: string, value: string) => { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${flag} takes a whole number`); return parsed; };
  const request: InstallRequest & ObserveOnlyChoice & FreshCursorChoice = { repository: values.repo,
    ...(values['herdr-rebind'] ? { herdr: 'rebind' as const } : values['no-herdr'] ? { herdr: 'skip' as const } : values['herdr-instance'] ? { herdr: 'instance' as const } : {}), provider: provider as InstallRequest['provider'],
    ...(values.target || provider === 'host' ? { selfContained: true } : {}),
    ...(values.local ? { local: true } : {}), ...(values.migrate ? { migrate: true } : {}),
    ...(values['max-monthly'] ? { maxMonthly: money('max-monthly', values['max-monthly']) } : {}),
    ...(values['confirm-price'] ? { confirmPrice: money('confirm-price', values['confirm-price']) } : {}),
    ...(values['fresh-cursor'] ? { freshCursor: true } : {}),
    ...(values['base-branch'] ? { baseBranch: values['base-branch'] } : {}),
    ...(values.domain ? { domain: values.domain } : {}), ...(values.workers ? { workers: count('workers', values.workers) } : {}),
    ...(values.port ? { port: count('port', values.port) } : {}),
    ...(values.image ? { image: values.image } : {}),
    ...(values['producer-proof']?.length ? { producerProofs: values['producer-proof'] } : {}),
    ...(reviewPolicy ? { reviewPolicy: reviewPolicy as 'github' | 'agent' } : {}),
    ...(values['required-check']?.length ? { requiredChecks: values['required-check'] } : {}),
    ...(values['review-count'] ? { reviewCount: count('review-count', values['review-count']) } : {}),
    ...(values['ssh-host'] ? { sshHost: values['ssh-host'] } : {}), ...(values['ssh-user'] ? { sshUser: values['ssh-user'] } : {}),
    ...(values['ssh-key'] ? { sshKey: values['ssh-key'] } : {}),
    ...(values['server-name'] ? { serverName: values['server-name'] } : {}), ...(values.workspace ? { workspace: values.workspace } : {}),
    ...(values['server-type'] ? { serverType: values['server-type'] } : {}), ...(values.location ? { location: values.location } : {}),
    ...(values['create-environments'] ? { createEnvironments: true } : {}),
    ...(values['observe-only'] ? { observeOnly: true, herdr: 'skip' as const } : {}) };
  return { values, request };
}

/**
 * The `install` flags that redeploy a recorded installation's server at `image` (GY-1962, `graphyard
 * upgrade`): its repository, provider or target, base branch, service, domain and host, and the
 * choices the record carries — its installer-created workers and producer grants, review policy
 * or observation-only mode — so the full apply plans the roster it has and revokes nothing.
 * An installation with no installer-created worker was applied with --observe-only. The record keeps
 * no Railway workspace, so an account in several workspaces names it again with `workspace`.
 */
export function redeployArguments(record: InstallRecord, image: string, workspace: string | null = null) {
  if (workspace && record.provider !== 'railway') throw new Error(`--workspace names a Railway installation's workspace; ${record.repository} is installed on ${record.provider}`);
  const host = record.deployment;
  const installer = record.principals.filter(principal => principal.source !== 'principal');
  const workers = installer.filter(principal => principal.role === 'worker' && principal.id.startsWith(`${record.installId}-worker-`)).length;
  const proofs = installer.find(principal => principal.role === 'producer' && principal.id === `${record.installId}-ci`)?.proofs ?? [];
  const mode = !workers ? ['--observe-only'] : ['--workers', String(workers), ...proofs.flatMap(proof => ['--producer-proof', proof])];
  return ['--repo', record.repository, ...(record.selfContained ? ['--target', record.provider === 'hetzner' ? 'hetzner' : 'host'] : ['--provider', record.provider]),
    '--base-branch', record.baseBranch, ...(record.service ? ['--server-name', record.service] : []), ...(record.domain ? ['--domain', record.domain] : []),
    ...(host?.sshHost ? ['--ssh-host', host.sshHost, '--ssh-user', host.sshUser] : []), ...(host?.port ? ['--port', String(host.port)] : []),
    ...(host?.local ? ['--local'] : []), ...(workspace ? ['--workspace', workspace] : []), '--review-policy', record.reviewPolicy, ...mode, '--image', image, '--apply'];
}

function observeOnlyConflicts(values: Record<string, string | boolean | string[] | undefined>, provider: string) {
  const given = (name: string) => Array.isArray(values[name]) ? (values[name] as string[]).length > 0 : !!values[name];
  return [...['workers', 'producer-proof', 'create-environments', 'migrate', 'herdr-rebind', 'herdr-instance', 'herdr-only', 'profiles-only'].filter(given).map(name => `--${name}`),
    ...(values.target || provider === 'host' ? ['--target'] : []),
    // The local provider runs the control plane as a systemd user unit on this machine, a supervisor unit observation-only never installs.
    ...(provider === 'local' ? ['--provider local'] : [])];
}

/** The reason every action an observation-only install (GY-1846) leaves to a later full install carries. */
export const OBSERVE_ONLY_HELD = 'held by observation-only (--observe-only)';
const held = (action: Omit<PlanAction, 'state' | 'held'>, reason: string): PlanAction => ({ ...action, state: 'held', held: `${OBSERVE_ONLY_HELD}: ${reason}` });

export interface InstallSession {
  root: string; inputs: Required<Pick<InstallInputs, 'repository' | 'provider' | 'baseBranch'>> & InstallRequest & ObserveOnlyChoice & FreshCursorChoice;
  installId: string; directory: string; adapter: ProviderAdapter; context: AdapterContext;
  /** The roster this apply deploys: the plan's principals reconciled with the recorded roster (GY-1879, `reconcileRoster`). */
  principals: RosterPrincipal[]; tokens: Map<string, string>; vault: Vault;
  record: InstallRecord | null;
  mode: 'plan' | 'apply';
  /** True once every principal credential exists on disk, so fingerprints are real. */
  materialized: boolean;
  deps: Required<Pick<InstallDependencies, 'fetch' | 'now' | 'wait' | 'log'>> & InstallDependencies;
  reviewPolicy: 'github' | 'agent'; requiredChecks: string[]; reviewCount: number;
  /**
   * The managed repository's generated-file manifest, derived once at preparation: the
   * assignment the installer sets beside GRAPHYARD_PRINCIPALS (null when the repository declares
   * none), or the refusal a declared manifest that failed or did not parse produced.
   */
  generatedFiles: { assignment: GeneratedFilesAssignment | null; error: string | null };
  /**
   * The managed repository's graphyard.json `risk`, `review` and `e2e` policy (GY-1843) as the
   * GRAPHYARD_REPOSITORY_POLICY assignment the installer sets beside GRAPHYARD_PRINCIPALS: the
   * runtime image carries no repository, so without it the deployed gates judge by the generic
   * default. Or the refusal a declaration that does not parse produced. Absent on sessions built
   * before it existed.
   */
  repositoryPolicy?: { assignment: ReturnType<typeof repositoryPolicyAssignment> | null; error: string | null };
  /**
   * The repository's delivery model (GY-1102): the reviewed policy graphyard.json commits, or the
   * one a scan would propose when none is committed yet (`committed` false), with the adapter that
   * deploys its UAT and production environments.
   */
  delivery: { policy: DeliveryPolicy; committed: boolean; adapter: DeploymentAdapter; context: DeploymentContext; merger?: InstallRecord['merger'] };
}

/**
 * The merger an install proposes its delivery under (GY-1833, GY-1901): a new install's control plane
 * merges; an existing one keeps the merger its record names, so a GitHub-merger install, or one whose
 * record predates the field, keeps its model. Observation-only reads none.
 */
export const installMerger = (record: InstallRecord | null, observeOnly: boolean): InstallRecord['merger'] => observeOnly ? null : record ? record.merger : 'control-plane';

/**
 * The committed delivery policy, or the one `init --scan` would propose for this checkout under
 * `merger` (GY-1901: a new install's control-plane merger proposes the local mode).
 */
export async function repositoryDelivery(root: string, merger: string | null = null): Promise<{ policy: DeliveryPolicy; committed: boolean }> {
  const { readFile } = await import('node:fs/promises');
  let text: string | null = null;
  try { text = await readFile(resolve(root, repositoryConfigFile), 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  let committed: DeliveryPolicy | undefined;
  try { committed = text === null ? undefined : parseRepositoryConfig(text).delivery; }
  catch (error: any) { throw new Error(Array.isArray(error?.issues) ? error.issues.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error.message); }
  const input = await collectScanInput(root);
  // A committed binding names a case file the checkout must hold, as init checks it (GY-1901).
  const unknownCases = committed ? applicationProblems(committed, caseIdsOf(input.files)) : [];
  if (unknownCases.length) throw new Error(unknownCases.join('; '));
  if (committed) return { policy: committed, committed: true };
  const stack = detectStack(input);
  return { policy: proposeDelivery(input, detectDeploy(input, stack), stack, { merger }), committed: false };
}

const CORE_HUMAN_STEPS = [
  'Authenticate the provider CLI and GitHub CLI once (the installer prints the exact command when either is missing).',
  'Approve the printed plan before rerunning with --apply.',
];

export function repositoryRoot(cwd: string) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error('Run graphyard install from the checkout of the repository being managed'); }
}





/**
 * The base branch an install without `--base-branch` uses: `master` when the checkout's remote has
 * `origin/master` and no `origin/main`, else null for the `main` default. `remoteBranches` is
 * `git branch -r` output, read as whole names: `origin/main-old` is not `origin/main`, and the
 * `origin/HEAD -> origin/main` line names its target.
 */
export function detectedBaseBranch(remoteBranches: string): 'master' | null {
  const names = new Set(remoteBranches.split('\n').flatMap(line => line.trim().split(/\s+->\s+/)).map(name => name.trim()).filter(Boolean));
  return !names.has('origin/main') && names.has('origin/master') ? 'master' : null;
}
/**
 * What a compose install mounts for the server to read submitted heads from (GY-1675): the checkout at
 * `/repo`. Run from a linked worktree, that is the main checkout the worktree belongs to (the parent of
 * the common Git directory), never the worktree itself: a worker's worktree is reclaimed with its
 * attempt, and a server whose /repo was reclaimed could observe no submitted head (GY-2054). A checkout
 * whose `.git` is a file naming a directory outside it that is not a linked worktree of a checkout (a
 * submodule) mounts that Git directory's common directory at its own host path too, so git inside the
 * container follows the pointer to the object store and refs. A checkout with no `.git` mounts nothing.
 */
export function composeCheckoutMounts(root: string): { repoCheckout: string | null; repoGitDir: string | null } {
  const dotGit = resolve(root, '.git');
  if (!existsSync(dotGit)) return { repoCheckout: null, repoGitDir: null };
  if (statSync(dotGit).isDirectory()) return { repoCheckout: root, repoGitDir: null };
  let common: string;
  try { common = resolve(execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
  catch (error: any) { throw new Error(`${root} is a linked worktree whose main repository could not be read (${error?.message ?? 'git rev-parse failed'}); run the compose install from a checkout whose Git directory is reachable`); }
  // A linked worktree's common directory is its main checkout's own .git directory.
  const main = resolve(common, '..');
  if (resolve(main, '.git') === common && existsSync(common) && statSync(common).isDirectory()) return { repoCheckout: main, repoGitDir: null };
  // A worktree's own gitdir lives under the common directory's worktrees/, so that one mount covers both.
  return { repoCheckout: root, repoGitDir: common };
}

export async function prepareInstall(cwd: string, rawInputs: InstallRequest & ObserveOnlyChoice, dependencies: InstallDependencies = {}, mode: 'plan' | 'apply' = 'apply'): Promise<InstallSession> {
  const provider = rawInputs.provider;
  if (!provider) throw new Error('Use --provider railway|hetzner|docker-host|compose|local, or --target host|hetzner');
  // Observation-only (GY-1846) registers no deploy key and leaves Herdr untouched, whoever builds the request.
  if (rawInputs.observeOnly) {
    if (provider === 'host' || provider === 'local' || rawInputs.selfContained || rawInputs.migrate || rawInputs.createEnvironments) throw new Error('--observe-only deploys only the control plane and installs no supervisor unit: it cannot install a self-contained host or the local provider\'s systemd unit, migrate, or create environments');
    rawInputs = { ...rawInputs, herdr: 'skip' };
  }
  // A self-contained install puts the whole of Graphyard on one machine: an existing one (host) or
  // a Hetzner server it creates (GY-717).
  const selfContained = provider === 'host' || !!rawInputs.selfContained;
  if (selfContained && provider !== 'host' && provider !== 'hetzner') throw new Error('A self-contained install targets host (an existing machine) or hetzner (a server it creates)');
  if (rawInputs.migrate && !selfContained) throw new Error('--migrate moves an installation onto a self-contained host; use it with --target host or --target hetzner');
  if (rawInputs.local && provider !== 'host') throw new Error('--local installs the host target on this machine; use it with --target host');
  const installId = installIdFor(rawInputs.repository);
  const root = repositoryRoot(cwd);
  const detected = await discover(root);
  if (detected.repository && detected.repository.toLowerCase() !== rawInputs.repository.toLowerCase()) throw new Error(`This checkout is ${detected.repository}; rerun from ${rawInputs.repository} or correct --repo`);
  const vault = new Vault();
  const directory = installDirectory(installId, dependencies.configHome);
  // Preparing inspects; it never creates, in either mode. `--apply` has to be able to refuse
  // on a failed preflight having changed nothing, so the credential directory, the tokens and
  // the database password are minted by `materializeInstall` after that gate — not here.
  assertOutsideRepository(directory, root);
  const record = await readInstallRecord(directory);
  // Observation-only plans no worker principal (nor a producer, a standing CI credential). The
  // recorded roster is reconciled in, never rewritten (GY-1879): a principal `graphyard principal
  // add` registered, or one an earlier apply registered that observation-only cannot plan, keeps
  // its entry and its credential.
  const principals = reconcileRoster(plannedPrincipals(installId, { workers: rawInputs.workers, producerProofs: rawInputs.producerProofs })
    .filter(principal => !rawInputs.observeOnly || (principal.role !== 'worker' && principal.role !== 'producer')), recordedRoster(record), { observeOnly: !!rawInputs.observeOnly });
  const tokens = selfContained ? new Map<string, string>() : await ensureTokens(directory, principals, vault, false);
  let generatedFiles: InstallSession['generatedFiles'];
  try { generatedFiles = { assignment: generatedFilesAssignment(root), error: null }; }
  catch (error: any) { generatedFiles = { assignment: null, error: error.message }; }
  let repositoryPolicy: InstallSession['repositoryPolicy'];
  try {
    const text = await readFile(resolve(root, repositoryConfigFile), 'utf8').catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
    repositoryPolicy = { assignment: repositoryPolicyAssignment(text === null ? null : JSON.parse(text)), error: null };
  } catch (error: any) { repositoryPolicy = { assignment: null, error: `${repositoryConfigFile}'s risk, review and e2e policy does not parse: ${error.message}` }; }
  const reviewPolicy = rawInputs.reviewPolicy ?? 'github';
  // A new install, or a retry of one whose record names the control-plane merger, proposes the local mode;
  // a committed policy is its own choice and ignores this.
  const merger = installMerger(record, !!rawInputs.observeOnly);
  const delivery = await repositoryDelivery(root, merger).catch((error: any) => { throw new Error(`${repositoryConfigFile}'s delivery policy cannot be installed: ${error.message}. Correct it (docs/delivery.md#managed-repositories), then rerun`); });
  let detectedBase = rawInputs.baseBranch;
  if (!detectedBase && existsSync(resolve(root, '.git'))) {
    try { detectedBase = detectedBaseBranch(execFileSync('git', ['-C', root, 'branch', '-r'], { encoding: 'utf8' })) ?? undefined; } catch {}
  }
  const inputs = { ...rawInputs, provider, baseBranch: detectedBase ?? 'main' };
  // A compose server observes submitted heads from the operator's checkout, mounted at /repo; no other provider can mount it.
  const { repoCheckout, repoGitDir } = provider === 'compose' ? composeCheckoutMounts(root) : { repoCheckout: null, repoGitDir: null };
  const transport = dependencies.transport ?? localTransport();
  const ssh = dependencies.ssh ?? ((host: string, user = inputs.sshUser ?? 'root') => sshTransport(host, user, transport));
  // A self-hosted database password is generated once and reused, so re-apply never
  // rewrites a running database's credential out from under it. An installation that already
  // exists yields its real value here, which is what keeps drift reporting exact on re-apply.
  // The local provider keeps it beside its cluster, in the 0700 postgres directory initdb reads it from.
  const passwordFile = provider === 'local' ? localPaths(directory).passwordFile : undefined;
  const databasePassword = selfContained ? '' : vault.add(await stableDatabasePassword(directory, false, passwordFile));
  const workdir = provider === 'compose' ? `${directory}/compose` : provider === 'local' ? directory : `/opt/graphyard/${installId}`;
  const dataPath = provider === 'hetzner' ? '/mnt/graphyard' : provider === 'host' ? `/var/lib/graphyard/${installId}` : null;
  const workers = Math.min(Math.max(inputs.workers ?? 1, 1), 20);
  const migrationSource = inputs.migrate ? (dependencies.environment ?? process.env)[MIGRATE_SOURCE_VARIABLE] || null : null;
  if (migrationSource) vault.add(migrationSource);
  const context: AdapterContext = {
    provider, repository: inputs.repository, installId,
    service: inputs.serverName ?? `graphyard-${installId}`,
    domain: inputs.domain ?? null,
    image: inputs.image ?? (provider === 'compose' ? `graphyard-local:${installId}` : DEFAULT_IMAGE),
    workdir,
    sourceRoot: dependencies.sourceRoot ?? fileURLToPath(new URL('../..', import.meta.url)),
    repoCheckout, repoGitDir,
    sshHost: inputs.sshHost ?? null, sshUser: inputs.sshUser ?? 'root',
    sshKey: inputs.sshKey ?? null,
    workspace: inputs.workspace ?? null,
    serverType: inputs.serverType ?? 'cx22', serverTypeExplicit: !!inputs.serverType, location: inputs.location ?? 'nbg1',
    plannedAgents: workers + 1,
    databasePassword, port: inputs.port ?? SERVER_PORT, portExplicit: inputs.port !== undefined, dataPath,
    railwayDir: `${directory}/railway`,
    host: selfContained ? {
      layout: hostLayout(installId, workdir, dataPath ?? `/var/lib/graphyard/${installId}`), local: !!inputs.local, workers,
      migrate: !!inputs.migrate, migrationSource, tokens, principals, claim: null, owner: null,
      ref: dependencies.graphyardRef ?? sourceCommit(dependencies.sourceRoot ?? fileURLToPath(new URL('../..', import.meta.url))),
      localCli: dependencies.cliPath ?? fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url)), localNode: process.execPath, localDirectory: directory, localRoot: root, localHost: dependencies.hostId ?? hostname(),
    } : null,
    local: provider === 'local' ? await localSettings(directory, installId, dependencies.localSupervisor) : null,
    spend: { maxMonthly: inputs.maxMonthly ?? null, confirmPrice: inputs.confirmPrice ?? null },
    observeOnly: !!inputs.observeOnly,
    // The repository this install manages: the observe-only upload guard refuses it as the source.
    managedRoot: root,
    ...(dependencies.sourceCommit !== undefined ? { sourceCommit: dependencies.sourceCommit } : {}),
    wait: dependencies.wait ?? ((ms: number) => new Promise(accept => setTimeout(accept, ms))),
    transport, ssh, fetch: dependencies.fetch ?? fetch, vault,
  };
  // The host keeps its own credentials: an earlier apply's are read back from it, never regenerated.
  if (selfContained) {
    const stored = await readHostSecrets(context, principals);
    for (const [principal, token] of stored.tokens) tokens.set(principal, token);
    context.databasePassword = stored.databasePassword;
    context.host!.secretsUnreadable = stored.unreadable;
  }
  const materialized = tokens.size === principals.length && !!context.databasePassword;
  const adapter = dependencies.adapter ?? (selfContained ? selfContainedAdapter(provider === 'host' ? existingMachineAdapter : adapterFor(provider)) : adapterFor(provider));
  const deployment: DeploymentContext = {
    repository: inputs.repository, installId, baseBranch: inputs.baseBranch, policy: delivery.policy,
    railwayDir: `${directory}/release-railway`, workspace: inputs.workspace ?? null, transport,
    created: record?.release?.created ?? [], createEnvironments: !!inputs.createEnvironments,
  };
  // Only a reviewed, committed split reaches branch protection; until `init --scan --apply` records
  // one, protection keeps the checks discovery proposes. An explicit --required-check always wins.
  const requiredChecks = inputs.requiredChecks?.length ? inputs.requiredChecks
    : delivery.committed ? requiredPullRequestChecks(delivery.policy) : detected.proposedChecks;
  return {
    root, inputs, installId, directory, adapter, context, principals, tokens, vault, record,
    mode, materialized, generatedFiles, repositoryPolicy,
    delivery: { ...delivery, adapter: deploymentAdapters[delivery.policy.deploy.adapter], context: deployment, merger },
    reviewPolicy, requiredChecks,
    reviewCount: reviewPolicy === 'agent' ? 0 : Math.max(0, inputs.reviewCount ?? 1),
    deps: { fetch: dependencies.fetch ?? fetch, now: dependencies.now ?? Date.now, wait: dependencies.wait ?? ((ms: number) => new Promise(accept => setTimeout(accept, ms))), log: dependencies.log ?? (() => {}), ...dependencies },
  };
}

/**
 * Creates what an installation owns on this machine: the credential directory, one token per
 * principal, and the self-hosted database password. It runs only after the preflight gate has
 * passed, so a refused `--apply` leaves the machine exactly as it found it. Idempotent — an
 * existing installation keeps every credential it already has.
 */
export async function materializeInstall(session: InstallSession): Promise<InstallSession> {
  if (session.mode !== 'apply') throw new Error('Apply requires a session prepared in apply mode; --plan sessions create nothing');
  if (session.context.host) {
    // A self-contained install writes its credentials on the host (the adapter's setEnv), never
    // here: this machine keeps only the install record. The sign-in claim is new on every apply.
    await prepareInstallDirectory(session.directory, session.root);
    generateHostSecrets(session.context);
    session.materialized = session.tokens.size === session.principals.length && !!session.context.databasePassword;
    return session;
  }
  if (session.materialized) return session;
  await prepareInstallDirectory(session.directory, session.root);
  for (const [principal, token] of await ensureTokens(session.directory, session.principals, session.vault, true)) session.tokens.set(principal, token);
  session.context.databasePassword = session.vault.add(await stableDatabasePassword(session.directory, true, session.context.local?.paths.passwordFile));
  session.materialized = session.tokens.size === session.principals.length && !!session.context.databasePassword;
  if (!session.materialized) throw new Error(`Could not generate one credential per principal under ${session.directory}`);
  return session;
}

/** The commit this Graphyard checkout is at, which a self-contained host runs; `main` when it cannot be read. */
function sourceCommit(root: string) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'main'; }
  catch { return 'main'; }
}

/** Generated once and reused: a re-apply must not lock a running database out of itself. */
async function stableDatabasePassword(directory: string, create: boolean, file = `${directory}/database.password`) {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  try { const value = (await readFile(file, 'utf8')).trim(); if (value.length >= 32) return value; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (!create) return '';
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString('base64url');
  await writeFile(file, `${password}\n`, { mode: 0o600 });
  return password;
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export function coreEnv(session: InstallSession): EnvValue[] {
  const { context, inputs } = session;
  // The local provider serves loopback only, on its own port, against the cluster it runs (GY-1500).
  const local = context.provider === 'local';
  const databaseUrl = context.provider === 'railway' ? '${{Postgres.DATABASE_URL}}' : local ? localDatabaseVariable(context) : `postgres://graphyard:${context.databasePassword}@db:5432/graphyard`;
  const capacity = delegationLimitAssignments(session.principals);
  return [
    { name: 'HOST', value: local ? '127.0.0.1' : '0.0.0.0', secret: false },
    { name: 'PORT', value: String(local ? context.port : SERVER_PORT), secret: false },
    { name: 'DATABASE_URL', value: databaseUrl, secret: carriesCredential('DATABASE_URL', databaseUrl) },
    { name: 'GRAPHYARD_PRINCIPALS', value: principalsVariable(session.principals, session.tokens), secret: true },
    { name: 'GITHUB_REPOSITORY', value: inputs.repository, secret: false },
    { name: 'GITHUB_BASE_BRANCH', value: inputs.baseBranch, secret: false },
    { name: 'GRAPHYARD_REVIEWER_APPS', value: JSON.stringify((session.record?.reviewers ?? []).map(reviewer => ({ id: reviewer.name, runtime: reviewer.name.replace(/-reviewer$/, ''), appId: reviewer.appId, botUserId: reviewer.botUserId }))), secret: false },
    // The capacity limits derived from the principal set being deployed; the server derives the
    // same values when they are unset, and an explicit value keeps the install predictable
    // across upgrades. A re-run after the roster changed reports the old values as drift.
    ...delegationLimitVariables.map(name => ({ name, value: capacity.variables[name], secret: false })),
    // The generated files the repository's manifest declares, so the regression guard exempts
    // a regenerated docs index instead of refusing it as an out-of-scope rewrite. A repository
    // that declares none leaves the variable unset, which is its correct deployment state.
    ...(session.generatedFiles.assignment ? [{ name: session.generatedFiles.assignment.variable, value: session.generatedFiles.assignment.value, secret: false }] : []),
    // The repository's sensitive paths, review timing and pending-outcome rule (GY-1843): the image
    // carries no graphyard.json, so the deployed gates read them from here.
    ...(session.repositoryPolicy?.assignment ? [{ name: session.repositoryPolicy.assignment.variable, value: session.repositoryPolicy.assignment.value, secret: false }] : []),
    // The delivery defaults, applications and case bindings (GY-1901), which /api/status shows as project.delivery:
    // the committed policy when graphyard.json has one, else the scan's proposal so a fresh up serves them before
    // onboarding commits the file (the control plane image carries no checkout).
    { name: projectDeliveryVariable, value: projectDeliveryAssignment(session.delivery.policy).value, secret: false },
    ...(context.repoCheckout ? [{ name: 'GRAPHYARD_REPOSITORY_ROOT', value: '/repo', secret: false }] : []),
  ];
}

// ---------------------------------------------------------------------------
// Self-provisioning an existing installation (GY-1416)
//
// An installation deployed before the plan derived a variable never got it. A variable the plan
// derives from a credential saved on this host is never a human request.
// `master setup` finds each one the running deployment lacks and, with --apply, sets exactly those
// through the provider adapter — secrets over stdin, never printed — with one audit entry each.
// ---------------------------------------------------------------------------

/** A variable the install plan derives from a credential saved on this host, and which credential. */
export interface DerivedVariable extends EnvValue { source: string }
/** One variable `master setup --apply` set: never its value, only its fingerprint. */
export interface SelfProvisionAudit { at: string; variable: string; secret: boolean; fingerprint: string; source: string; provider: Provider; service: string }
export interface SelfProvisionReport {
  provider: Provider; service: string; mode: 'plan' | 'apply';
  /** The service and its variables were read, so `missing` is exact; false when either could not be (nothing is then applied). */
  observed: boolean;
  /** The adapter sets a subset of variables in place (`applyVariables`); without it `install --apply` sets them with the rest. */
  canApply: boolean;
  missing: (PlanValue & { source: string })[];
  set: string[];
  /** Variables an earlier run set whose redeploy failed: this run redeployed them (or, planning, owes it). */
  redeployed: string[]; pendingRedeploy: string[];
  audit: SelfProvisionAudit[]; next: string | null;
}
/**
 * What an applying run staged and has not yet finished, kept between runs: variables set on the
 * deployment whose redeploy has not succeeded, and audit entries for variables set but not yet
 * written to the audit log. The next run redeploys the one and writes the other.
 */
export interface PendingSetup { redeploy: string[]; audit: SelfProvisionAudit[] }
export interface PendingRedeploy { read(): Promise<PendingSetup>; write(staged: PendingSetup): Promise<void> }
export const derivedFrom = (values: EnvValue[], source: string): DerivedVariable[] => values.map(value => ({ ...value, source }));

/**
 * Every variable an install session derives from credentials this host holds: the core variables,
 * once every principal credential exists. No GitHub App variable is ever derived (GY-2010).
 */
export async function derivedVariables(session: InstallSession): Promise<DerivedVariable[]> {
  return session.materialized ? derivedFrom(coreEnv(session), `the install plan's credentials under ${session.directory}`) : [];
}

/** A variable is present when it, or its file-mounted twin (`…_FILE`), is set. */
const presentOn = (variables: Record<string, string>, name: string) => variables[name] !== undefined || variables[`${name}_FILE`] !== undefined;

/**
 * Plan, or with `apply` set, the derived variables the running deployment lacks. Only absent
 * variables are touched: a present one, whatever its value, is the deployment's own (drift is
 * `install --plan`'s to report). The report and every audit entry carry fingerprints, never a secret.
 */
export async function selfProvision(target: { adapter: ProviderAdapter; context: AdapterContext }, derived: DerivedVariable[],
  options: { apply: boolean; audit?: (entry: SelfProvisionAudit) => Promise<void>; now?: () => number; pending?: PendingRedeploy }): Promise<SelfProvisionReport> {
  const { adapter, context } = target, vault = context.vault;
  for (const value of derived) if (value.secret) vault.add(value.value);
  const observation = await adapter.observe(context);
  // A listing that failed reads as no variables: applying from it would overwrite every live value.
  const observed = observation.app && observation.variablesObserved === true;
  const canApply = typeof adapter.applyVariables === 'function';
  // The first occurrence of a name wins.
  const first = derived.filter((value, index) => derived.findIndex(other => other.name === value.name) === index);
  const missing = !observed ? [] : first.filter(value => value.value !== '' && !presentOn(observation.variables, value.name));
  const staged = canApply && observed ? await options.pending?.read() ?? { redeploy: [], audit: [] } : { redeploy: [], audit: [] };
  const pending = staged.redeploy;
  const report: SelfProvisionReport = {
    provider: context.provider, service: context.service, mode: options.apply ? 'apply' : 'plan', observed, canApply,
    missing: missing.map(value => ({ ...planValue(value, true), source: value.source })), set: [], redeployed: [], pendingRedeploy: pending, audit: [],
    next: !observation.app ? `The ${context.service} service was not observed on ${context.provider}; check the provider CLI's login and link (${context.railwayDir}), or name the service with --server-name NAME, then rerun`
      : !observed ? `The ${context.service} service's variables could not be read on ${context.provider}; nothing is applied from an unread listing. Rerun once the provider CLI lists them`
      : !missing.length && !pending.length && !staged.audit.length ? null
      : !canApply ? `The ${context.provider} adapter rewrites the whole environment: graphyard install --provider ${context.provider} --repo ${context.repository} --apply sets these with the rest`
      : options.apply ? null : 'graphyard master setup --apply',
  };
  if (options.apply && canApply && (missing.length || pending.length || staged.audit.length)) {
    const at = new Date((options.now ?? Date.now)()).toISOString();
    const entries = missing.map((value): SelfProvisionAudit => ({ at, variable: value.name, secret: value.secret, fingerprint: fingerprint(value.value), source: value.source, provider: context.provider, service: context.service }));
    // Staged before the writes: variables set but never redeployed read as present on the next run,
    // which then redeploys them, and an audit entry not yet written is written by the next run.
    const audits = [...staged.audit, ...entries], redeploy = [...new Set([...pending, ...missing.map(value => value.name)])];
    if (redeploy.length) {
      await options.pending?.write({ redeploy, audit: audits });
      // With no values, applyVariables only redeploys.
      await adapter.applyVariables!(context, missing.map(({ name, value, secret }) => ({ name, value, secret })));
      await options.pending?.write({ redeploy: [], audit: audits });
    }
    report.redeployed = pending; report.pendingRedeploy = [];
    // Each entry leaves the staged set once written, so a failed append neither loses nor repeats one.
    for (const [index, entry] of audits.entries()) {
      await options.audit?.(entry);
      await options.pending?.write({ redeploy: [], audit: audits.slice(index + 1) });
      report.audit.push(entry);
    }
    report.set = missing.map(value => value.name);
  }
  vault.assertClean(JSON.stringify(report), 'the setup report');
  return vault.scrub(report);
}

/**
 * The deployment a host names without an install record (one provisioned by hand, as production
 * was): the provider, its service and the directory its CLI is linked from.
 */
export function deploymentTarget(input: { provider: Provider; repository: string; service: string; linkDirectory: string; workspace?: string | null; transport?: Transport; fetch?: typeof fetch }): { adapter: ProviderAdapter; context: AdapterContext } {
  const transport = input.transport ?? localTransport(), installId = installIdFor(input.repository);
  const context: AdapterContext = {
    provider: input.provider, repository: input.repository, installId, service: input.service, domain: null, image: DEFAULT_IMAGE,
    workdir: `/opt/graphyard/${installId}`, sourceRoot: fileURLToPath(new URL('../..', import.meta.url)), sshHost: null, sshUser: 'root', sshKey: null,
    workspace: input.workspace ?? null, serverType: 'cx22', serverTypeExplicit: false, plannedAgents: 2, location: 'nbg1', databasePassword: '', port: SERVER_PORT, dataPath: null,
    railwayDir: input.linkDirectory, host: null, spend: { maxMonthly: null, confirmPrice: null }, wait: ms => new Promise(accept => setTimeout(accept, ms)),
    transport, ssh: (host, user = 'root') => sshTransport(host, user, transport), fetch: input.fetch ?? fetch, vault: new Vault(),
  };
  return { adapter: adapterFor(input.provider), context };
}

const PENDING = 'generated on apply';
const planValue = (value: EnvValue, materialized: boolean): PlanValue => value.secret
  ? { name: value.name, value: REDACTED, secret: true, ...(materialized ? { fingerprint: fingerprint(value.value) } : { note: PENDING }) }
  : { name: value.name, value: value.value, secret: false };

function variableDrift(session: InstallSession, action: string, values: EnvValue[], observed: Record<string, string>): PlanDrift[] {
  if (!Object.keys(observed).length) return [];
  return values.flatMap(value => {
    // A credential this machine has not generated yet cannot be compared to a running one.
    if (value.secret && !session.materialized) return [];
    const expected = variableMarker(value.name, value.value);
    const current = observed[value.name];
    // Both sides are markers for anything carrying a credential, so drift is reportable
    // verbatim: an observed value only ever reaches the plan as `sha:<fingerprint>`.
    if (current === undefined) return [{ action, field: value.name, expected, observed: 'absent' }];
    // A shared reference such as `${{Postgres.DATABASE_URL}}` is resolved by Railway before
    // its CLI reports it — `variables --json` and `--kv` both return the resolved connection
    // string (checked against a live project), and no CLI surface returns the raw template.
    // The only comparison that never reads that credential is presence: a fingerprinted
    // observed value is the reference doing its job, not drift. The residual blind spot is
    // accepted and bounded: a literal connection string in the reference's place is
    // indistinguishable from a resolved one, so --plan cannot flag it; DATABASE_URL is the
    // only variable the installer ever sets as a reference, and the verification steps after
    // apply are what prove the deployed server is actually serving this installation.
    if (expected !== current && isProviderReference(value.value) && current.startsWith('sha:')) return [];
    return current === expected ? [] : [{ action, field: value.name, expected, observed: current }];
  });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * The `gh` login an install needs (GY-1412, GY-2010): `repo`, on an account that administers the
 * repository, for every provider. A full install registers the merge writer's deploy key with it;
 * `--observe-only` (GY-1862) reads the release refs with it and writes nothing. A login whose
 * scopes `gh` does not list (a fine-grained token) is not refused for scopes it may hold.
 */
export const GITHUB_CLI_SCOPES = ['repo'] as const;
export function githubCliPreflight(provider: Provider, status: { code: number; stdout: string; stderr?: string }, repository: string): PreflightItem {
  const needed = [...GITHUB_CLI_SCOPES];
  if (status.code !== 0) return { name: 'GitHub CLI', ok: false, detail: 'gh is missing or not authenticated', fix: `Install GitHub CLI and run: gh auth login --scopes ${needed.join(',')} (the account must administer ${repository})` };
  const listed = /Token scopes:\s*(.*)/.exec(`${status.stdout}\n${status.stderr ?? ''}`)?.[1];
  const held = listed === undefined ? null : [...listed.matchAll(/[\w:-]+/g)].map(match => match[0]);
  const lacking = held ? needed.filter(scope => !held.includes(scope)) : [];
  if (lacking.length) return { name: 'GitHub CLI', ok: false, detail: `the gh login lacks scope ${lacking.join(', ')} (${provider} needs ${needed.join(', ')})`, fix: `Run: gh auth refresh --scopes ${needed.join(',')}` };
  return { name: 'GitHub CLI', ok: true, detail: `authenticated for the deploy key and the release wiring with ${held ? `scopes ${needed.join(', ')}` : 'unlisted scopes'}` };
}

/**
 * The plan's step for the merge writer's deploy key (GY-1551, GY-2010), the only credential a full
 * install gives Graphyard on GitHub: generated beside the install (on the host for a self-contained
 * one, whose private half never leaves it) and registered read-write through the gh login.
 */
function deployKeyAction(session: InstallSession): PlanAction {
  const { context, inputs } = session;
  const title = 'Generate the merge writer\'s deploy key';
  if (inputs.observeOnly) return held({ id: 'github.deploy-key', target: 'github', title: `${title} and register it on ${inputs.repository}` }, 'no deploy key is generated or registered, so the merge writer cannot push');
  if (context.host) return { id: 'github.deploy-key', target: 'host', state: 'update', title: `${title} on the host (${hostDeployKeyFile(context.host.layout, session.installId)}, mode 0600; its private half never leaves the host) when absent, register its public half read-write on ${inputs.repository} through this machine's gh login unless already listed, and clone the managed checkout over SSH with it` };
  const file = resolve(session.directory, DEPLOY_KEY_FILE);
  return { id: 'github.deploy-key', target: 'github', state: existsSync(file) ? 'update' : 'create', title: `${title} (${file}, mode 0600) when absent and register it read-write on ${inputs.repository} through the gh login unless already listed; the merge writer pushes ${inputs.baseBranch} with it, and no GitHub App, webhook or branch protection is set up` };
}

export async function buildPlan(session: InstallSession): Promise<InstallPlan> {
  const { adapter, context, record } = session;
  const preflight = await adapter.preflight(context);
  const gh = githubCli(context.transport);
  const observeOnly = !!session.inputs.observeOnly;
  const candidateModel = session.delivery.policy.mode === 'release-candidate';
  // gh registers the deploy key and creates a candidate model's release wiring; observe-only still
  // refuses a signed-out caller (GY-1862). Every one needs only the `repo` scope.
  preflight.push(githubCliPreflight(context.provider, await gh(['auth', 'status'], { allowFailure: true }), session.inputs.repository));
  // The master loop runs from this checkout and its unit refuses a temporary directory: say so
  // before anything is created (GY-1457). A host install runs its loop on the host instead. The
  // test suite's checkouts are all temporary, so it checks durableCheckoutPreflight directly.
  if (!context.host && !underTestRunner()) preflight.push(durableCheckoutPreflight(session.root));
  // A declared manifest the installer cannot read would deploy a server whose regression guard
  // exempts nothing, so it blocks --apply like any other preflight until the script is fixed.
  preflight.push(session.generatedFiles.error
    ? { name: 'Generated-file manifest', ok: false, detail: session.generatedFiles.error, fix: `Fix ${generatedManifestScript} so \`node ${generatedManifestScript} --manifest\` prints the generated files as JSON, then rerun` }
    : { name: 'Generated-file manifest', ok: true, detail: session.generatedFiles.assignment ? `declares ${session.generatedFiles.assignment.value}` : 'the repository declares no generated files' });
  // Deploying the generic default over a declaration that does not parse would silently weaken every gate.
  if (session.repositoryPolicy?.error) preflight.push({ name: 'Repository policy', ok: false, detail: session.repositoryPolicy.error, fix: `Correct the risk, review and e2e sections of ${repositoryConfigFile} (docs/delivery.md), then rerun` });
  if (candidateModel) preflight.push(...await session.delivery.adapter.preflight(session.delivery.context));
  // Herdr's graphyard plugin, read before anything is planned around it: one already bound to
  // another server is repointed only with --herdr-rebind (GY-1413).
  const herdr = context.host ? null : await observeHerdr(session);
  const herdrTarget = record?.url ?? null;
  const herdrRelink = session.inputs.herdr !== 'skip' && herdrBoundElsewhere(herdr?.binding ?? null, herdrTarget) ? herdr!.binding!.bound : null;
  if (herdrRelink && session.inputs.herdr !== 'rebind') preflight.push({ name: 'Herdr plugin', ok: false, detail: herdrRebindRefusal(herdrRelink, herdrTarget ?? 'this installation'), fix: 'Rerun with --herdr-instance to give this installation its own Herdr instance, --herdr-rebind to repoint the plugin at it, or --no-herdr to leave Herdr untouched' });
  const observation = preflight.every(item => item.ok) ? await adapter.observe(context) : { installed: false, compute: false, database: false, app: false, url: null, variables: {}, detail: ['provider preflight is incomplete; the installation was not inspected'] } as AdapterObservation;

  // The deployed roster is reconciled, not replaced (GY-1879): an existing installation's workers
  // and producers stay in session.principals with their credentials, so observation-only revokes none.

  const core = coreEnv(session);
  const drift: PlanDrift[] = [];
  const actions: PlanAction[] = [];
  const existing = !!record || observation.installed;

  const host = context.host;
  actions.push({
    id: 'local.credentials', target: host ? 'host' : 'local', state: (host ? session.materialized : observeOnly ? session.materialized || !!record : !!record) ? 'satisfied' : 'create',
    title: host ? `Generate one credential per principal on the host under ${host.layout.tokensDirectory} (mode 0600); this machine keeps fingerprints only` : `Generate one credential per principal under ${session.directory} (mode 0600) and never write it to the repository`,
    values: session.principals.map(principal => {
      const token = session.tokens.get(principal.id);
      // The declared kind rides beside the role: the operator row reads "(human)", the agents
      // "(ai)", and a principal the running deployment left undeclared is named as such so the
      // plan shows the repair an apply performs.
      const undeclaredDeployed = record?.principals.some(deployed => deployed.id === principal.id
        && deployed.role === 'admin' && deployed.sessionKind !== 'human');
      const role = `${principal.role}${principal.proofs?.length ? ` limited to ${principal.proofs.join(', ')}` : ''}${principal.sessionKind ? ` (${principal.sessionKind})` : ''}${undeclaredDeployed ? '; deployed without a sessionKind, this apply declares it human' : ''}`;
      return { name: principal.id, value: REDACTED, secret: true, note: token ? role : `${role}; ${PENDING}`, ...(token ? { fingerprint: fingerprint(token) } : {}) };
    }),
  });
  actions.push(...adapter.plan(context, observation));

  const coreDrift = variableDrift(session, 'provider.env.core', core, observation.variables);
  drift.push(...coreDrift);
  const namesUnknown = observation.installed && observation.variablesObserved !== true && observeOnly;
  actions.push({ id: 'provider.env.core', target: 'provider', state: !observation.installed ? 'create' : coreDrift.length || namesUnknown ? 'update' : 'satisfied', title: `Set the control-plane variables on the application service${namesUnknown ? '; the deployed variable names are unknown (observation-only reads no values), so every one is written again and no drift is reported' : ''}`, values: core.map(value => planValue(value, session.materialized)), drift: coreDrift });
  actions.push({ id: 'provider.deploy', target: 'provider', state: observation.app ? 'update' : 'create', title: 'Deploy the application and wait for it to become healthy' });
  actions.push({ id: 'provider.url', target: 'provider', state: observation.url ? 'satisfied' : 'create', title: context.domain ? `Bind ${context.domain} to the service over HTTPS` : 'Obtain the public HTTPS URL of the service', values: observation.url ? [{ name: 'url', value: observation.url, secret: false }] : [] });
  actions.push({ id: 'verify.health', target: 'graphyard', state: 'update', title: 'Verify GET /healthz returns {"ok":true}' });
  actions.push(deployKeyAction(session));

  // The release-candidate pipeline's environments (GY-1102): free wiring, then every UAT and
  // production resource the deployment adapter would create, cost-bearing ones marked human.
  if (candidateModel) {
    const wiring = wiringActions(session.delivery.context);
    const environments = session.delivery.adapter.plan(session.delivery.context);
    if (observeOnly) actions.push(...wiring.map(action => action.state === 'satisfied' ? action : held(action, action.id === 'release.branches' ? 'missing release refs are not created' : 'missing GitHub environments are not created')),
      ...environments.map(action => action.state === 'satisfied' ? action : held(action, `the ${session.delivery.policy.deploy.adapter} product deployment adapter does not run`)));
    else actions.push(...wiring, ...environments);
  }

  actions.push({ id: 'verify.status', target: 'graphyard', state: 'update', title: 'Verify authenticated GET /api/status reports the admin actor and the managed repository' });
  if (!host && observeOnly) actions.push(
    held({ id: 'local.workers', target: 'local', title: 'Generate worker principals and their credentials' }, 'no worker principal is installed'),
    held({ id: 'local.profiles', target: 'local', title: 'Register master, reviewer, and worker profiles for authenticated agent runtimes on this machine' }, 'no profile, supervisor unit or master loop is installed or started'),
    held({ id: 'local.herdr', target: 'local', title: "Link and enable Herdr's graphyard plugin for this repository" }, 'Herdr is left untouched'));
  else if (!host) {
    actions.push({ id: 'local.profiles', target: 'local', state: record?.profiles.length ? 'satisfied' : 'create', title: 'Register master, reviewer, and worker profiles for authenticated agent runtimes on this machine' });
    actions.push(herdrAction(session, herdr, herdrRelink, herdrTarget));
    if (herdrRelink) drift.push({ action: 'local.herdr', field: 'Herdr graphyard plugin url', expected: herdrTarget ?? 'this installation', observed: herdrRelink });
  }

  // Moving an installation onto a host changes its provider on purpose; that is the migration, not drift.
  if (record && record.provider !== context.provider && !host?.migrate) drift.push({ action: 'local.credentials', field: 'provider', expected: context.provider, observed: record.provider });
  if (record && record.repository.toLowerCase() !== session.inputs.repository.toLowerCase()) drift.push({ action: 'local.credentials', field: 'repository', expected: session.inputs.repository, observed: record.repository });
  if (record && (record.domain ?? null) !== (context.domain ?? null)) drift.push({ action: 'provider.url', field: 'domain', expected: context.domain ?? 'provider-assigned', observed: record.domain ?? 'provider-assigned' });
  // An install deployed before principals declared a session kind keeps its operator undeclared,
  // and the server treats an undeclared session as never human (delegation.ts `sessionKind`):
  // its human-only requests park with nobody able to answer them. The roster this plan writes
  // declares the operator human, so --apply repairs the deployment; the plan names the drift
  // instead of silently rewriting the operator's identity.
  for (const deployed of record?.principals ?? []) {
    if (deployed.role !== 'admin') continue;
    const planned = session.principals.find(principal => principal.id === deployed.id);
    if (!planned || planned.sessionKind !== 'human' || deployed.sessionKind === 'human') continue;
    drift.push({ action: 'local.credentials', field: 'sessionKind', expected: `${planned.id} declared sessionKind human`,
      observed: `${deployed.id} declares ${deployed.sessionKind ? `sessionKind ${deployed.sessionKind}` : 'no sessionKind'}; human-only requests have no one who can answer them` });
  }

  const plan: InstallPlan = {
    version: 1, repository: session.inputs.repository, provider: context.provider, installId: session.installId,
    installDirectory: session.directory, baseBranch: session.inputs.baseBranch, reviewPolicy: session.reviewPolicy,
    domain: context.domain, url: observation.url ?? record?.url ?? null, existing, secretsRedacted: true,
    preflight, principals: session.principals, actions, drift,
    humanSteps: [...CORE_HUMAN_STEPS,
      ...(host ? ['After install, sign in once with the printed link and connect each agent account on the dashboard Agents page; nobody logs into the host.'] : []),
      ...(candidateModel ? ['Approve any UAT or production resource the plan marks as costing money before rerunning with --apply --create-environments; without that flag none is created.'] : [])],
    ...(host ? { host: hostPlan(context) } : {}),
    ...(context.provider === 'hetzner' ? { price: quotedPrice(context) } : {}),
    delivery: deliverySummary(session), ...(observeOnly ? { observeOnly: true } : {}),
  };
  const serialized = JSON.stringify(plan);
  session.vault.assertClean(serialized, 'the installation plan');
  return session.vault.scrub(plan);
}

function deliverySummary(session: InstallSession): InstallPlan['delivery'] {
  const { policy, committed } = session.delivery;
  return { mode: policy.mode, committed, preMerge: requiredPullRequestChecks(policy),
    perCandidate: policy.mode === 'per-pr' ? [] : policy.mergeGate.perCandidate.map(entry => entry.check), adapter: policy.deploy.adapter };
}



/** This install's own Herdr instance under --herdr-instance (GY-1511), else null: the host's default instance. */
export function ownHerdrInstance(session: Pick<InstallSession, 'installId' | 'inputs'>) {
  return session.inputs.herdr === 'instance' ? installHerdrInstance(session.installId) : null;
}
/**
 * `install --target host --herdr-only` (GY-1511): Herdr on an installed self-contained host set up
 * again and its instance recorded, nothing else applied. `graphyard up` runs it on every run, as it
 * sets Herdr up on this machine for every other provider; a step that cannot finish is reported by
 * name in `herdrFailure`.
 */
export async function installHerdrOnly(session: InstallSession) {
  if (!session.context.host) throw new Error('--herdr-only sets Herdr up on a self-contained host (--target host or hetzner); for any other install, graphyard up sets Herdr up on this machine');
  const url = session.record?.url;
  if (!url) throw new Error(`--herdr-only needs an installed host, and no install of ${session.inputs.repository} is recorded here; run install --apply first`);
  // It writes the host's Herdr state, so it holds the apply lock like every apply (GY-1876).
  const release = await acquireApplyLock(session.directory, session.deps.now());
  try { return { herdr: await hostHerdrOnly(session.context, url), herdrFailure: null }; }
  catch (error) { if (!(error instanceof HerdrSetupFailure)) throw error; return { herdr: null, herdrFailure: { step: error.step, message: session.vault.scrub(error.message) } }; }
  finally { await release(); }
}
/**
 * `install --target host --profiles-only` (GY-1850): the reviewer and worker profiles written on an
 * installed self-contained host, nothing else applied (with --apply, as every write). `graphyard up`'s accounts step runs it there,
 * as it runs `master environments --apply` on this machine for every other provider.
 */
export async function installProfilesOnly(session: InstallSession) {
  // The write runs on the host, so a --plan session (any run without --apply) refuses before any transport.
  if (session.mode !== 'apply') throw new Error('--profiles-only writes the profiles on the host; pass --apply (--plan sessions change nothing)');
  if (!session.context.host) throw new Error('--profiles-only writes the profiles on a self-contained host (--target host or hetzner); for any other install, run graphyard master environments --apply in the configured checkout');
  if (!session.record?.url) throw new Error(`--profiles-only needs an installed host, and no install of ${session.inputs.repository} is recorded here; run install --apply first`);
  const release = await acquireApplyLock(session.directory, session.deps.now());
  try { const { host, report } = await hostProfilesOnly(session.context); return { host, profiles: report }; }
  finally { await release(); }
}
/** Herdr on this machine and the server its graphyard plugin is bound to, when it is. */
async function observeHerdr(session: InstallSession) {
  const { deps, context } = session;
  const state = await (deps.detectHerdr ?? detectHerdr)(context.transport);
  if (!state.available || session.inputs.herdr === 'skip') return { state, binding: null };
  const run = deps.runHerdr ?? (async (args: string[]) => { const call = herdrViaEnv(args, ownHerdrInstance(session)); const result = await context.transport.exec(call.command, call.args, { allowFailure: true, timeout: 30_000 }); return result.code === 0 ? result.stdout : ''; });
  return { state, binding: await herdrPluginBinding(run) };
}

/** The plan line for Herdr: link, keep, relink (named, with the server it is bound to now), or leave alone. */
function herdrAction(session: InstallSession, herdr: Awaited<ReturnType<typeof observeHerdr>> | null, relink: string | null, target: string | null): PlanAction {
  const steps = 'herdr plugin link, write the plugin config.json {url, worker token}, herdr plugin enable';
  if (session.inputs.herdr === 'skip') return { id: 'local.herdr', target: 'local', state: 'satisfied', title: 'Leave Herdr untouched (--no-herdr): the graphyard plugin is neither linked nor reconfigured' };
  const own = ownHerdrInstance(session);
  if (own && herdr?.state.available && !herdr.binding) return { id: 'local.herdr', target: 'local', state: 'create', title: `Link and enable Herdr's graphyard plugin in this installation's own Herdr instance (XDG_CONFIG_HOME ${own.configHome}, session ${own.session}); the default instance is not touched (${steps})` };
  if (!herdr?.state.available) return { id: 'local.herdr', target: 'local', state: 'satisfied', title: 'Herdr is not installed on this machine; nothing to link, and workers start from the CLI' };
  if (relink) return { id: 'local.herdr', target: 'local', state: 'update', title: `Relink Herdr's graphyard plugin, now bound to ${relink}, to ${target ?? 'this installation'} (${steps})${session.inputs.herdr === 'rebind' ? '; --herdr-rebind allows it' : '; refused without --herdr-rebind'}` };
  if (herdr.binding) return { id: 'local.herdr', target: 'local', state: 'satisfied', title: `Herdr's graphyard plugin is already bound to ${herdr.binding.bound}; it keeps that server` };
  return { id: 'local.herdr', target: 'local', state: 'create', title: `Link and enable Herdr's graphyard plugin for this repository (${steps})` };
}


// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface InstallSummary {
  repository: string; provider: Provider; installId: string; installDirectory: string;
  url: string;
  principals: { id: string; role: string; fingerprint: string; tokenFile: string }[];
  /** The merge writer's deploy key (GY-2010): its private key file, on the host for a self-contained install; null for --observe-only. */
  deployKey: string | null;
  health: boolean; status: { actor: string; role: string; repository: string };
  profiles: ProfileRegistration; drift: PlanDrift[]; nextSteps: string[];
  /** The self-contained host: its units, runtimes, accounts and Herdr workspace (GY-717). */
  host?: HostFleetResult;
  /** GY-1851 (`--fresh-cursor`): the host's loop restarted on a fresh cursor; the old one's archive, or null when it had none. */
  freshCursor?: HostCursorReset;
  /** The single-use dashboard sign-in for the admin; printed once, stored on the host only as a hash. */
  signIn?: string;
  release: { mode: 'local' | 'release-candidate' | 'per-pr'; adapter: 'railway' | 'command'; created: string[]; pending: { id: string; command?: string; human?: string }[] };
  /** `--observe-only` (GY-1846): every action the plan held, which a later full install performs. */
  held?: { id: string; title: string; held: string }[];
}

/** GY-1851: what resetHostCursor did on the host: the loop unit it restarted and the old cursor's archive. */
export interface HostCursorReset { host: string; unit: string; archived: { file: string; cycle: number } | null }

/**
 * GY-1851: start a self-contained host's master loop on a fresh cursor. The loop holds its cursor in
 * memory and writes it again as it stops, and `systemctl --user enable --now` leaves a running loop
 * running, so the unit is stopped first (systemd waits out its shutdown write), the cursor its
 * master.json names is then set aside beside itself (`NAME.daemon.archived-STAMP.json`, never
 * deleted), and the unit is started again, reading no cursor at all. A cursor written again after
 * the stop means another loop still runs on it, and fails the apply naming it.
 */
export async function resetHostCursor(remote: Transport, checkout: string, fleet: Pick<HostFleetResult, 'host' | 'units'>, now = new Date()): Promise<HostCursorReset> {
  const host = fleet.host, unit = fleet.units.find(entry => entry.role === 'master loop')?.name;
  if (!unit) throw new Error(`the install on ${host} reports no master loop unit, so its cursor cannot be reset`);
  const credentialFile = JSON.parse(await readRemote(remote, `${checkout}/.graphyard/master.json`) ?? 'null')?.credentialFile;
  if (typeof credentialFile !== 'string') throw new Error(`${checkout}/.graphyard/master.json on ${host} records no coordinator credential file, so the loop's cursor cannot be found`);
  const cursor = credentialFile.replace(/(\.token)?$/, '.daemon.json');
  const systemctl = async (verb: 'stop' | 'start') => {
    const result = await asUser(remote, checkout, 'systemctl', ['--user', verb, unit], { allowFailure: true, timeout: (loopStopTimeoutSeconds + 60) * 1000 });
    if (result.code !== 0) throw new Error(`systemctl --user ${verb} ${unit} on ${host} exited ${result.code}: ${(result.stderr || result.stdout).trim().split('\n').slice(-1)[0] ?? ''}`);
  };
  await systemctl('stop');
  const text = await readRemote(remote, cursor);
  let archived: HostCursorReset['archived'] = null;
  if (text !== null) {
    let cycle = 0;
    try { const value = Number(JSON.parse(text)?.cycle); cycle = Number.isSafeInteger(value) && value > 0 ? value : 0; } catch { /* an unreadable cursor is archived all the same */ }
    const file = cursor.replace(/\.json$/, `.archived-${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.json`);
    const moved = await asUser(remote, checkout, 'mv', ['-n', '--', cursor, file], { allowFailure: true, timeout: 60_000 });
    if (moved.code !== 0) throw new Error(`archiving the master loop's cursor ${cursor} on ${host} failed: ${moved.stderr.trim()}`);
    archived = { file, cycle };
  }
  if (await readRemote(remote, cursor) !== null) throw new Error(`the master loop's cursor ${cursor} on ${host} was written again after ${unit} stopped, so another loop still runs on the old database's cursor; stop it, then apply again`);
  await systemctl('start');
  return { host, unit, archived };
}

/**
 * The roster this apply reconciled was read before it took the lock. A `graphyard principal` edit that
 * held the lock in between changed install.json, so this apply refuses rather than deploy a roster
 * missing that edit's entry (GY-1879); planning again reconciles with it.
 */
async function refuseMovedRoster(session: InstallSession) {
  const roster = (record: InstallRecord | null) => JSON.stringify(record?.principals ?? []);
  const current = await readInstallRecord(session.directory).catch(() => null);
  if (roster(current) !== roster(session.record ?? null)) throw new Error(`The principal roster in ${session.directory}/install.json changed after this apply was planned (a graphyard principal add or remove ran); this apply wrote nothing. Run install --apply again to reconcile with it`);
}

/**
 * A provider command that fails now carries the provider's own diagnostic, which may quote a
 * value the installer piped into it, so the failure is scrubbed on the way out like every log
 * line and the summary.
 */
export async function applyInstall(session: InstallSession, plan: InstallPlan): Promise<InstallSummary> {
  try {
    refuseUnready(session, plan);
    await prepareInstallDirectory(session.directory, session.root);
    const release = await acquireApplyLock(session.directory, session.deps.now());
    try { await refuseMovedRoster(session); return await performInstall(session, plan); } finally { await release(); }
  } catch (error: any) {
    const message = session.vault.scrub(String(error?.message ?? error));
    throw message === error?.message ? error : new Error(message);
  }
}

/**
 * The gate comes before anything is written, so "changed nothing" is literally true: at this point
 * not even the install directory, its lock or a credential file exists yet for a first install.
 */
function refuseUnready(session: InstallSession, plan: InstallPlan) {
  if (session.mode !== 'apply') throw new Error('Apply requires a session prepared in apply mode; --plan sessions create nothing');
  const blocked = plan.preflight.filter(item => !item.ok);
  if (blocked.length) throw new Error(`Preflight is incomplete; the installer changed nothing.\n${blocked.map(item => `- ${item.name}: ${item.detail}${item.fix ? `\n  ${item.fix.startsWith('HUMAN:') ? '' : 'Run: '}${item.fix}` : ''}`).join('\n')}`);
}

/** The exclusive lock an `install --apply` holds on its installation directory for the whole apply (GY-1876). */
export const applyLockFile = (directory: string) => resolve(directory, 'apply.lock');
const processAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };
/**
 * Which process runs under `pid` now, so a pid the system has since reused names a different one:
 * the boot and the kernel's start tick on Linux, the start time `ps` reports elsewhere; null when
 * neither can be read.
 */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (ticks) return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${ticks}`;
  } catch {}
  if (process.platform === 'linux') return null;
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || null; } catch { return null; }
}
/**
 * A holder on another machine cannot be probed, so only one on this machine whose process is gone
 * is stale: its pid runs nothing, or runs a process started after the one that took the lock.
 */
function liveHolder(text: string): { pid: number; host: string; startedAt: string } | null {
  let holder: any;
  try { holder = JSON.parse(text); } catch { return null; }
  if (!Number.isSafeInteger(holder?.pid) || holder.pid <= 0 || typeof holder.host !== 'string') return null;
  if (holder.host !== hostname()) return holder;
  if (!processAlive(holder.pid)) return null;
  if (typeof holder.process !== 'string') return holder;
  const running = processStart(holder.pid);
  return running === null || running === holder.process ? holder : null;
}

/** Pauses for tests between the steps that race: after the standing lock is read, and after the reclaim token is taken. */
export type ApplyLockPauses = { readStale?: () => Promise<void>; tookToken?: () => Promise<void> };

/**
 * Takes the apply lock, or refuses naming the pid that holds it, before this apply writes anything
 * under the directory or to GitHub, the vault or the provider. The lock is published whole with
 * link(), which never replaces. A lock left by a process that is gone is reclaimed under a token
 * named by that lock's own bytes and taken with link(), so exactly one apply reclaims each stale
 * lock; the token's holder re-reads the lock and only then renames its own over it, so the lock
 * path is never absent and no live holder's lock is ever moved (a token whose holder is gone is
 * superseded by one named for both). Answers the release, which removes only this apply's own lock.
 */
export async function acquireApplyLock(directory: string, now: number, pauses: ApplyLockPauses = {}): Promise<() => Promise<void>> {
  const file = applyLockFile(directory);
  const content = `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date(now).toISOString(), process: processStart(process.pid) ?? undefined, nonce: randomBytes(8).toString('hex') })}\n`;
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const release = async () => { if (await readFile(file, 'utf8').catch(() => null) === content) await unlink(file).catch(() => {}); };
  const refuse = (holder: { pid: number; host: string; startedAt: string }, what: string) =>
    new Error(`Another install --apply (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}) ${what} the lock ${file}, so this apply wrote nothing; let it finish, then apply again`);
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await link(temporary, file); return release; } catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
      const standing = await readFile(file, 'utf8').catch(() => null);
      if (standing === null) continue;
      const holder = liveHolder(standing);
      if (holder) throw refuse(holder, 'holds');
      await pauses.readStale?.();
      // The reclaim token for exactly this stale lock; a token whose holder is gone is superseded.
      const chain = [standing], superseded: string[] = [];
      let token: string | null = null;
      for (let generation = 0; generation < 5 && !token; generation++) {
        const name = `${file}.${createHash('sha256').update(chain.join('\0')).digest('hex').slice(0, 16)}.reclaim`;
        try { await link(temporary, name); token = name; break; } catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
        const claimed = await readFile(name, 'utf8').catch(() => null);
        if (claimed === null) continue;
        const reclaimer = liveHolder(claimed);
        if (reclaimer) throw refuse(reclaimer, 'is reclaiming');
        chain.push(claimed);
        superseded.push(name);
      }
      if (!token) continue;
      try {
        await pauses.tookToken?.();
        // Only this token's holder may replace the stale lock, and its dead owner cannot, so it is
        // still exactly what was read unless another apply already reclaimed it.
        if (await readFile(file, 'utf8').catch(() => null) !== standing) continue;
        await rename(temporary, file);
        for (const name of superseded) await unlink(name).catch(() => {});
        return release;
      } finally { await unlink(token).catch(() => {}); }
    }
  } finally { await unlink(temporary).catch(() => {}); }
  throw new Error(`Could not take the lock ${file}: other applies kept taking it; apply again`);
}

async function performInstall(session: InstallSession, plan: InstallPlan): Promise<InstallSummary> {
  const { adapter, context, deps, vault } = session;
  const log = (line: string) => deps.log(vault.scrub(line));
  await materializeInstall(session);

  const observation = await adapter.observe(context);
  log(`Provisioning ${context.provider} for ${session.inputs.repository}`);
  await adapter.provision(context, observation);
  await adapter.setEnv(context, coreEnv(session));
  await adapter.deploy(context);
  const url = await adapter.url(context);
  log(`Service URL: ${url}`);
  const health = await waitForHealth(session, url);
  if (!health) throw new Error(`The service at ${url} did not become healthy. Inspect: graphyard install --provider ${context.provider} --repo ${session.inputs.repository} --logs`);

  let record = session.record ?? emptyRecord(session, url);
  const migratedFrom = context.host?.migrate && session.record && (session.record.provider !== context.provider || !session.record.selfContained)
    ? { provider: session.record.provider, at: new Date(deps.now()).toISOString(), principals: session.record.principals.map(principal => ({ id: principal.id, fingerprint: principal.fingerprint })) }
    : record.migratedFrom;
  // The cutover: the host's credentials were generated there, so no credential of the old
  // installation — above all its coordinator's — authenticates to the new server.
  if (migratedFrom) for (const principal of session.principals) {
    if (migratedFrom.principals.some(old => old.fingerprint === fingerprint(session.tokens.get(principal.id)!))) throw new Error(`The host reuses a credential of the old installation (${principal.id}); the old loop would keep its leases`);
  }
  record = { ...record, url, domain: context.domain, service: context.service, provider: context.provider, selfContained: !!context.host, migratedFrom, baseBranch: session.inputs.baseBranch, reviewPolicy: session.reviewPolicy, merger: session.delivery.merger ?? record.merger, principals: principalRecords(session.principals, session.tokens), updatedAt: new Date(deps.now()).toISOString() };
  await writeInstallRecord(session.directory, record, vault);

  const observeOnly = !!session.inputs.observeOnly;
  const gh = githubCli(context.transport);
  // The merge writer's deploy key (GY-2010): the only credential Graphyard holds on GitHub. A host
  // generates its own (installHostFleet); every other full install generates it here.
  const ensure = deps.ensureDeployKey ?? ((installDir: string, repository: string, cli: GitHubCli) => ensureDeployKey(installDir, repository, cli));
  const deployKey = observeOnly || context.host ? null : await ensure(session.directory, session.inputs.repository, gh);
  if (deployKey) log(`Deploy key ${deployKey} is registered read-write on ${session.inputs.repository} for the merge writer`);

  // The adapter's environments: paid ones only with --create-environments, every other one left
  // pending with its exact command, beside the free wiring the operator runs once.
  const release: InstallSummary['release'] = { mode: session.delivery.policy.mode, adapter: session.delivery.policy.deploy.adapter, created: [], pending: [] };
  if (release.mode === 'release-candidate' && !observeOnly) {
    const provisioned = await session.delivery.adapter.provision(session.delivery.context, { createPaid: !!session.inputs.createEnvironments });
    release.created.push(...provisioned.created);
    release.pending = [...wiringActions(session.delivery.context), ...provisioned.pending].map(action => ({ id: action.id, ...(action.command ? { command: action.command } : {}), ...(action.human ? { human: action.human } : {}) }));
  }
  const releaseCreated = [...new Set([...(record.release?.created ?? []), ...release.created.filter(id => !id.startsWith('release.branches') && !id.startsWith('release.github'))])];
  record = { ...record, release: { adapter: release.adapter, created: releaseCreated } };

  const status = await authenticatedStatus(session, url);
  const fleet = context.host && 'installFleet' in adapter
    ? await (adapter as ProviderAdapter & { installFleet: typeof installHostFleet }).installFleet(context, {
      url, adminToken: session.tokens.get(principalOfRole(session.principals, 'admin').id)!, coordinatorToken: session.tokens.get(principalOfRole(session.principals, 'coordinator').id)!,
      fetch: deps.fetch, log,
      registerDeployKey: async (publicKey, title) => {
        const file = resolve(session.directory, 'host-deploy-key.pub');
        await writeFile(file, publicKey.endsWith('\n') ? publicKey : `${publicKey}\n`, { mode: 0o600 });
        await registerDeployKey(file, session.inputs.repository, gh, title);
      },
    })
    : null;
  const freshCursor = fleet && session.inputs.freshCursor ? await resetHostCursor(await hostRemote(context), context.host!.layout.checkout, fleet) : null;
  const profiles = fleet ? fleet.profiles : observeOnly ? observedProfiles() : await registerProfiles(session, url);
  record = installRecordSchema.parse({
    ...record,
    deployment: { sshHost: context.sshHost, sshUser: context.sshUser, local: !!context.host?.local, port: context.provider === 'compose' ? context.port : null, image: session.inputs.image ?? null },
    profiles: [
      ...(profiles.master.configured ? [{ name: 'master', principal: principalOfRole(session.principals, 'coordinator').id, kind: profiles.master.kind ?? 'unknown', role: 'master' as const }] : []),
      ...profiles.workers.map(worker => ({ name: worker.name, principal: worker.principal, kind: worker.kind, role: 'worker' as const })),
      ...profiles.reviewers.map(reviewer => ({ name: reviewer.name, principal: reviewer.name, kind: reviewer.runtime, role: 'reviewer' as const })),
    ],
    updatedAt: new Date(deps.now()).toISOString(),
  });
  await writeInstallRecord(session.directory, record, vault);

  const summary: InstallSummary = {
    repository: session.inputs.repository, provider: context.provider, installId: session.installId, installDirectory: session.directory,
    url,
    principals: session.principals.map(principal => ({ id: principal.id, role: principal.role, fingerprint: fingerprint(session.tokens.get(principal.id)!), tokenFile: context.host ? hostTokenFile(context.host.layout, principal.id) : tokenFile(session.directory, principal.id) })),
    deployKey: deployKey ?? fleet?.deployKey ?? null,
    health, status, profiles, drift: plan.drift,
    nextSteps: observeOnly ? observeOnlySteps(session, url, plan) : [...nextSteps(session, url, profiles), ...release.pending.map(action => `${action.human ?? 'Pending'} Command: ${action.command}`)],
    release,
    ...(observeOnly ? { held: plan.actions.filter(action => action.state === 'held').map(action => ({ id: action.id, title: action.title, held: action.held! })) } : {}),
    ...(fleet ? { host: fleet } : {}), ...(freshCursor ? { freshCursor } : {}),
    ...(context.host?.claim ? { signIn: `${url}/#claim=${context.host.claim}` } : {}),
  };
  const serialized = JSON.stringify(summary);
  vault.assertClean(serialized, 'the installation summary');
  return vault.scrub(summary);
}


/** A shell word: plain when it needs no quoting, otherwise single-quoted. */
const shellWord = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The exact command that resumes this install: every input it was given, rerun with --apply, so the
 * rerun targets the same server, SSH identity and spend consent (GY-1413). `installRequestFromArgs`
 * parses it back to the same request; the record below makes a new input a compile error until it is
 * serialized here.
 */
export function resumeCommand(session: Pick<InstallSession, 'inputs'>) {
  const { inputs } = session;
  const value = (name: string, given: string | number | undefined | null) => given === undefined || given === null || given === '' ? [] : [`--${name}`, shellWord(String(given))];
  const values = (name: string, given: string[] | undefined) => (given ?? []).flatMap(item => value(name, item));
  const flag = (name: string, given: boolean | undefined) => given ? [`--${name}`] : [];
  const flags: Partial<Record<keyof InstallRequest, string[]>> = {
    provider: inputs.selfContained || inputs.provider === 'host' ? ['--target', inputs.provider] : ['--provider', inputs.provider],
    selfContained: [],
    repository: value('repo', inputs.repository),
    baseBranch: inputs.baseBranch !== 'main' ? value('base-branch', inputs.baseBranch) : [],
    domain: value('domain', inputs.domain), workers: value('workers', inputs.workers), port: value('port', inputs.port),
    producerProofs: values('producer-proof', inputs.producerProofs),
    reviewPolicy: value('review-policy', inputs.reviewPolicy), reviewCount: value('review-count', inputs.reviewCount),
    requiredChecks: values('required-check', inputs.requiredChecks),
    sshHost: value('ssh-host', inputs.sshHost), sshUser: value('ssh-user', inputs.sshUser), sshKey: value('ssh-key', inputs.sshKey),
    workspace: value('workspace', inputs.workspace), image: value('image', inputs.image),
    serverName: value('server-name', inputs.serverName), serverType: value('server-type', inputs.serverType), location: value('location', inputs.location),
    local: flag('local', inputs.local), migrate: flag('migrate', inputs.migrate),
    maxMonthly: value('max-monthly', inputs.maxMonthly), confirmPrice: value('confirm-price', inputs.confirmPrice),
    createEnvironments: flag('create-environments', inputs.createEnvironments),
    herdr: inputs.herdr === 'rebind' ? ['--herdr-rebind'] : inputs.herdr === 'skip' ? ['--no-herdr'] : inputs.herdr === 'instance' ? ['--herdr-instance'] : [],
  };
  return ['graphyard', 'install', ...Object.values(flags).flat(), ...flag('observe-only', inputs.observeOnly), ...flag('fresh-cursor', inputs.freshCursor), '--apply'].join(' ');
}


/**
 * `graphyard principal add|remove` (GY-1879): deploy `roster`, the installation's recorded roster
 * with one entry upserted or removed, as the one variable it renders. The deployment is handed
 * GRAPHYARD_PRINCIPALS alone where its adapter merges (`applyVariables`: Railway, local); a bundle
 * adapter (Compose, a host) is rewritten with every other value as it stands. The record then
 * keeps the roster, a removed principal's credential leaves this machine, and the served control
 * plane's roster is read back, as the admin, until it shows the change. With `changed` false
 * nothing is written and the roster is only read back.
 */
export async function applyRosterChange(session: InstallSession, record: InstallRecord, roster: RosterPrincipal[], change: { id: string; changed: boolean; entry: RosterPrincipal | null }) {
  const { adapter, context, deps, vault } = session;
  if (!record.url) throw new Error(`The installation record under ${session.directory} names no server URL; rerun graphyard install --apply first`);
  if (context.host) {
    if (context.host.secretsUnreadable) throw new Error(`The host's credentials could not be read (${context.host.secretsUnreadable}); the roster is not edited blind`);
    context.host.principals = roster;
    generateHostSecrets(context);
    // A roster edit mints no sign-in claim: the deployed claim hash rides through deployedBundle,
    // so an unredeemed dashboard link keeps working and only GRAPHYARD_PRINCIPALS changes.
    context.host.claim = null;
  } else {
    // An unchanged add mints nothing: the deployment keeps the credential it holds, so a lost token file is refused, not replaced.
    const standing = change.changed ? roster.filter(principal => principal.id !== change.id) : roster;
    for (const [principal, token] of await ensureTokens(session.directory, standing, vault, false)) session.tokens.set(principal, token);
    if (change.entry && !change.changed && !session.tokens.has(change.id)) throw new Error(`No credential is saved for ${change.id} under ${session.directory}, though the deployment serves it unchanged; nothing was minted or written. To issue it a new credential, run graphyard principal remove ${change.id}, then add it again`);
    const missing = standing.filter(principal => !session.tokens.has(principal.id));
    if (missing.length) throw new Error(`No credential is saved for ${missing.map(principal => principal.id).join(', ')} under ${session.directory}; rerun graphyard install --apply before editing the roster`);
    if (change.entry && change.changed) for (const [principal, token] of await ensureTokens(session.directory, [change.entry], vault, true)) session.tokens.set(principal, token);
  }
  session.principals = roster;
  const merges = typeof adapter.applyVariables === 'function';
  let deployment: { provider: Provider; service: string; variables: string[]; rewritten: boolean } | null = null;
  if (change.changed) {
    const principals = coreEnv(session).filter(value => value.name === 'GRAPHYARD_PRINCIPALS');
    // A Compose bundle keeps the port its server publishes; an older record does not name it.
    if (context.provider === 'compose') context.port = publishedPort(await readRemote(context.transport, `${context.workdir}/compose.yaml`)) ?? context.port;
    if (merges) await adapter.applyVariables!(context, principals);
    else { await adapter.setEnv(context, [...(await deployedBundle(session)).filter(value => value.name !== 'GRAPHYARD_PRINCIPALS'), ...principals]); await adapter.deploy(context); }
    deployment = { provider: context.provider, service: context.service, variables: ['GRAPHYARD_PRINCIPALS'], rewritten: !merges };
    await writeInstallRecord(session.directory, { ...record, principals: principalRecords(roster, session.tokens), updatedAt: new Date(deps.now()).toISOString() }, vault);
    if (!change.entry && context.host) await (await hostRemote(context)).exec('rm', ['-f', hostTokenFile(context.host.layout, change.id)]);
    else if (!change.entry) await rm(tokenFile(session.directory, change.id), { force: true });
  }
  const admin = principalOfRole(roster, 'admin');
  const target = `${record.url.replace(/\/$/, '')}/api/principals`;
  const read = async (url: string) => {
    const response = await deps.fetch(url, { headers: { Authorization: `Bearer ${session.tokens.get(admin.id)}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    return response?.ok ? await response.json().catch(() => null) : null;
  };
  const proofs = change.entry?.proofs ?? [];
  let readback: { url: string; principal: { id: string; role: string; sessionKind: string | null; grants: string[] } | null; principals: number; proofAuthority?: string[] } | null = null;
  for (let attempt = 0; attempt < 40 && !readback; attempt++) {
    const served = (await read(target))?.principals;
    const listed = Array.isArray(served) ? served.find((principal: { id: string }) => principal.id === change.id) : undefined;
    // GY-1998: --proof counts as restored only once the grant record Graphyard authorizes from holds every pattern.
    // The server seeds a producer's record once and never re-seeds it, so a revoked pattern stays revoked: a record
    // that lacks a requested pattern is refused with the explicit grant that restores it, never reported as restored.
    const authority = proofs.length && listed ? ((await read(`${record.url.replace(/\/$/, '')}/api/proof-grants`))?.authorities ?? [])
      .find((entry: { principalId: string; source: string }) => entry.principalId === change.id && entry.source === 'grant') : undefined;
    const missing = authority ? proofs.filter(pattern => !(authority.patterns ?? []).includes(pattern)) : [];
    if (missing.length) throw new Error(`${change.id} is served with its roster entry, but its recorded proof grant holds ${authority.patterns?.join(', ') || 'no pattern'}, not ${missing.join(', ')}: Graphyard seeds a producer's grant once and never re-seeds it from GRAPHYARD_PRINCIPALS, so a revoked pattern stays revoked. To restore it, run graphyard grants grant ${change.id} ${missing.join(',')} REASON, then rerun this command: it changes nothing and reads the grant back`);
    if (Array.isArray(served) && (change.entry ? listed && servedAs(listed, change.entry) && (!proofs.length || authority) : !listed)) readback = { url: target, principal: listed ? { id: listed.id, role: listed.role, sessionKind: listed.sessionKind ?? null, grants: listed.grants ?? [] } : null, principals: served.length, ...(authority ? { proofAuthority: authority.patterns } : {}) };
    else await deps.wait(3000);
  }
  if (!readback) throw new Error(`${target} still ${change.entry ? `does not list ${change.id} as ${change.entry.role} with grants ${(change.entry.grants ?? []).join(', ') || 'none'}${change.entry.proofs?.length ? ` and proofs ${change.entry.proofs.join(', ')}` : ''}` : `lists ${change.id}`} after two minutes; the redeploy may still be in progress. Rerun the same command: it changes nothing and reads the roster back again`);
  return vault.scrub({ action: change.entry ? 'add' as const : 'remove' as const, repository: record.repository, installDirectory: session.directory, principal: change.entry ? { id: change.entry.id, role: change.entry.role, sessionKind: change.entry.sessionKind ?? null, grants: change.entry.grants ?? [], ...(change.entry.proofs?.length ? { proofs: change.entry.proofs } : {}) } : { id: change.id }, changed: change.changed, deployment, readback,
    ...(change.entry && !context.host ? { tokenFile: tokenFile(session.directory, change.entry.id) } : {}) });
}

/** The served entry carries the requested role, session kind and grants: an entry still served from before the change does not count as read back. */
const servedAs = (listed: { role?: string; sessionKind?: string | null; grants?: string[] }, entry: RosterPrincipal) => listed.role === entry.role
  && (listed.sessionKind ?? null) === (entry.sessionKind ?? null) && [...(listed.grants ?? [])].sort().join(',') === [...(entry.grants ?? [])].sort().join(',');

/** The GitHub App and revert-approver variables a deployment from before GY-2010 may still carry. */
const LEGACY_APP_VARIABLE = /^(GITHUB_(APP_ID|INSTALLATION_ID|PRIVATE_KEY(_FILE)?|WEBHOOK_SECRET|CI_APP_IDS)|GRAPHYARD_REVERT_APPROVER_\w+)$/;
/**
 * The environment a bundle deployment (Compose, a Docker host, a self-contained host) runs now, read
 * from its server.env, so a roster edit rewrites the bundle with every other value as deployed (any
 * operator setting included) and without a pull-request-era App's variables.
 */
async function deployedBundle(session: InstallSession): Promise<EnvValue[]> {
  const { context } = session;
  const transport = context.host ? await hostRemote(context) : context.provider === 'docker-host' ? context.ssh(context.sshHost!, context.sshUser)
    : context.provider === 'hetzner' ? context.ssh(await hetznerAddress(context), context.sshUser) : context.transport;
  const text = await readRemote(transport, `${context.workdir}/server.env`);
  if (text === null) throw new Error(`${context.workdir}/server.env could not be read; the roster is not edited blind. Rerun graphyard install --apply`);
  const values: EnvValue[] = [];
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0 || line.startsWith('#')) continue;
    const name = line.slice(0, index).trim(), value = line.slice(index + 1);
    // A pull-request-era App's variables are dropped, never carried into the rewrite (GY-2010).
    if (!LEGACY_APP_VARIABLE.test(name)) values.push({ name, value, secret: name !== SIGNIN_CLAIM_VARIABLE });
  }
  return values;
}

function emptyRecord(session: InstallSession, url: string): InstallRecord {
  const at = new Date(session.deps.now()).toISOString();
  return installRecordSchema.parse({ version: 1, installId: session.installId, repository: session.inputs.repository, provider: session.context.provider, baseBranch: session.inputs.baseBranch, reviewPolicy: session.reviewPolicy, domain: session.context.domain, url, principals: [], github: null, reviewers: [], profiles: [], createdAt: at, updatedAt: at });
}


async function waitForHealth(session: InstallSession, url: string, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await session.adapter.health(session.context, url)) return true;
    await session.deps.wait(3_000);
  }
  return false;
}

async function authenticatedStatus(session: InstallSession, url: string) {
  const admin = principalOfRole(session.principals, 'admin');
  const token = session.tokens.get(admin.id)!;
  const response = await session.deps.fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Authenticated /api/status failed (${response.status}); the server did not accept the generated admin credential`);
  const body = await response.json() as any;
  if (body?.actor?.role !== 'admin') throw new Error('The generated admin credential did not authenticate as an admin actor');
  if (String(body?.repository ?? '').toLowerCase() !== session.inputs.repository.toLowerCase()) throw new Error('The server is bound to a different repository than the one being installed');
  return { actor: String(body.actor.id), role: String(body.actor.role), repository: String(body.repository) };
}




async function registerProfiles(session: InstallSession, url: string): Promise<ProfileRegistration> {
  const { context, deps } = session;
  const runtimes = await (deps.detectRuntimes ?? detectRuntimes)(context.transport);
  const herdr = session.inputs.herdr === 'skip' ? { available: false, version: null, reason: '--no-herdr: Herdr was left untouched' } : await (deps.detectHerdr ?? detectHerdr)(context.transport);
  const workerIds = workerPrincipals(session.principals).map(principal => principal.id);
  const workers = workerProfiles(session.installId, workerIds, runtimes, principal => tokenFile(session.directory, principal));
  const master = masterRuntime(runtimes);
  const request: ProfileRequest = {
    root: session.root, url, cliPath: deps.cliPath ?? fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url)),
    hostId: deps.hostId ?? hostname(), installDirectory: session.directory,
    coordinatorToken: session.tokens.get(principalOfRole(session.principals, 'coordinator').id)!,
    workerTokens: workerIds.map(principal => ({ principal, token: session.tokens.get(principal)! })),
    runtimes, herdr, workers, reviewers: [], masterKind: master?.kind ?? null,
    herdrRebind: session.inputs.herdr === 'rebind', herdrInstance: ownHerdrInstance(session),
    ...(deps.runHerdr ? { runHerdr: deps.runHerdr } : {}),
  };
  return deps.registerProfiles ? deps.registerProfiles(request) : (await import('./profiles.js')).registerLocalProfiles(request);
}

/** Observation-only registers no profile and touches no Herdr (GY-1846). */
function observedProfiles(): ProfileRegistration {
  return { repository: { connected: false, herdr: false, detail: `${OBSERVE_ONLY_HELD}: the repository is not connected and Herdr is left untouched` },
    master: { configured: false, kind: null, detail: `${OBSERVE_ONLY_HELD}: no master profile, supervisor unit or master loop is installed` }, workers: [], reviewers: [] };
}

/** This install's own command with --observe-only and the flags it implied dropped, as a --plan (GY-1846). */
export function fullPlanCommand(session: Pick<InstallSession, 'inputs'>) {
  const { observeOnly: _observeOnly, herdr: _herdr, ...inputs } = session.inputs;
  return resumeCommand({ inputs: inputs as InstallSession['inputs'] }).replace(/ --apply$/, ' --plan');
}

function observeOnlySteps(session: InstallSession, url: string, plan: InstallPlan) {
  const heldIds = plan.actions.filter(action => action.state === 'held').map(action => action.id);
  return [
    `Open ${url} and sign in with the credential in ${tokenFile(session.directory, principalOfRole(session.principals, 'admin').id)}.`,
    `Observation-only: the control plane is deployed and nothing ${session.inputs.repository} or its product owns was changed. Held for a later full install: ${heldIds.join(', ')}.`,
    `Rerun "${fullPlanCommand(session)}" (this install's inputs without --observe-only) to see what the full install would change before applying it.`,
  ];
}

function nextSteps(session: InstallSession, url: string, profiles: ProfileRegistration) {
  const host = session.context.host;
  const steps = [
    host ? 'Open the signIn link once to sign in to the dashboard as the admin; it works a single time, then use Agents → Connect an account for each runtime.'
      : `Open ${url} and sign in with the credential in ${tokenFile(session.directory, principalOfRole(session.principals, 'admin').id)}.`,
    'Create the first work item: write it like examples/work.json and run "graphyard master create FILE"; the supervised master loop dispatches, reviews and merges it (docs/setup-from-zero.md step 12).',
  ];
  steps.push(`The merge writer trial-merges each submitted head and pushes ${session.inputs.baseBranch} with the deploy key alone; no GitHub App, webhook, pull request or branch protection is involved, and reviews run as control-plane reviewer sessions (graphyard master environments --apply writes their profiles).`);
  if (host) steps.push(`Everything runs on the host as the ${host.layout.user} account; nobody logs into it. Accounts start unconnected until connected from the dashboard.`);
  else if (!profiles.workers.length) steps.push('No authenticated agent runtime was found on this machine; sign in to a supported runtime and rerun --apply, or add a worker profile with "graphyard master worker add".');
  if (!session.principals.some(principal => principal.role === 'producer')) steps.push('No proof producer was created. Add one with --producer-proof NAME for each proof that CI may submit; a producer must never be given to an implementation worker.');
  steps.push('Never copy an admin, coordinator, or producer credential into a worker session.');
  return steps;
}
