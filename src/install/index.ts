import { execFileSync } from 'node:child_process';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collectScanInput, detectDeploy, detectStack, discover, proposeDelivery } from '../onboarding.js';
import { parseRepositoryConfig, repositoryConfigFile } from '../model/documentation.js';
import { requiredPullRequestChecks, type DeliveryPolicy } from '../model/delivery-policy.js';
import { applyWiring, deploymentAdapters, observeReleaseWiring, wiringActions, type DeploymentAdapter, type DeploymentContext } from './deploy-target.js';
import { adapterFor, carriesCredential, isProviderReference, quotedPrice, variableMarker, type AdapterContext, type AdapterObservation, type ProviderAdapter, DEFAULT_IMAGE } from './adapters.js';
import { existingMachineAdapter, generateHostSecrets, hostLayout, hostPlan, hostTokenFile, installHostFleet, readHostSecrets, selfContainedAdapter, MIGRATE_SOURCE_VARIABLE, type HostFleetResult } from './host.js';
import { applyProtection, appClient, configureWebhook, detectCiAppIds, effectiveReviewCount, headSha, githubCli, installationClient, installationToken, protectionSatisfied, readProtection, GRAPHYARD_CHECKS, readWebhookConfig, repositoryInstallation, triggerDelivery, verifyDelivery, webhookUrlFor, CHECK_NAME, type AppFacts, type DeliveryProof } from './github.js';
import { detectHerdr, detectRuntimes, masterRuntime, reviewerProfiles, workerProfiles, type DetectedRuntime, type HerdrState, type ReviewerProfileDraft, type WorkerProfileDraft } from './runtimes.js';
import { generatedFilesAssignment, generatedManifestScript, type GeneratedFilesAssignment } from './generated-files.js';
import { delegationLimitAssignments, delegationLimitVariables } from './limits.js';
import { assertOutsideRepository, configHome, ensureTokens, fingerprint, installDirectory, installRecordSchema, plannedPrincipals, prepareInstallDirectory, principalOfRole, principalsVariable, readInstallRecord, tokenFile, workerPrincipals, writeInstallRecord, Vault, type InstallRecord } from './secrets.js';
import { AppStepPending, readAppFile, readSavedApp, readUninstalledApp, type SavedApp } from './manifest.js';
import { appRoles, importApp, listApps, publiclyReachable, reuseExistingApp, savedRegistrations, type AppCredentials, type AppRole, type SavedRegistration } from '../github-setup.js';
import { herdrBoundElsewhere, herdrPluginBinding, herdrRebindRefusal } from '../repository-setup.js';
import { localTransport, sshTransport, type Transport } from './transport.js';
import { durableCheckoutPreflight, underTestRunner } from '../supervisor.js';
import { installIdFor, providers, REDACTED, SERVER_PORT, type EnvValue, type InstallInputs, type InstallPlan, type PlanAction, type PlanDrift, type PlanValue, type PlannedPrincipal, type PreflightItem, type Provider } from './types.js';

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
  cliPath?: string;
  hostId?: string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  detectRuntimes?: (transport: Transport) => Promise<DetectedRuntime[]>;
  detectHerdr?: (transport: Transport) => Promise<HerdrState>;
  /** Runs the App-manifest browser flow and resolves once the human has confirmed. The registration credentials are written to `file`, which the installer keeps under the install directory, never inside a repository. */
  githubApp?: (request: { root: string; repository: string; origin: string; file: string; reviewer?: string; reuse?: AppPageReuse }) => Promise<AppFacts & { slug: string; botUserId?: number }>;
  registerProfiles?: (request: ProfileRequest) => Promise<ProfileRegistration>;
  runHerdr?: (args: string[]) => string;
  /** Test seam: exercise the orchestration against a scripted provider. */
  adapter?: ProviderAdapter;
  /** Where --migrate reads GRAPHYARD_MIGRATE_DATABASE_URL (process.env by default). */
  environment?: NodeJS.ProcessEnv;
  /** The Graphyard commit a self-contained host runs its loop and executors from (this checkout's HEAD by default). */
  graphyardRef?: string;
}

export interface ProfileRequest {
  root: string; url: string; cliPath: string; hostId: string; installDirectory: string;
  coordinatorToken: string; workerTokens: { principal: string; token: string }[];
  runtimes: DetectedRuntime[]; herdr: HerdrState; herdrRebind?: boolean;
  /** True on the registration before the App step: the master is configured with the App still pending. */
  appPending?: boolean;
  workers: WorkerProfileDraft[]; reviewers: ReviewerProfileDraft[]; masterKind: string | null;
  runHerdr?: (args: string[]) => string;
}

/**
 * What the install does with Herdr's `graphyard` plugin when it is already bound to another server
 * (GY-1413): `rebind` repoints it (`--herdr-rebind`), `skip` leaves Herdr untouched (`--no-herdr`).
 * Without either, a plugin bound elsewhere fails preflight instead of being silently repointed.
 */
export interface HerdrChoice { herdr?: 'rebind' | 'skip' }
/**
 * GY-1442: Apps already installed on the account that the install reuses instead of creating one
 * (`--reuse-app SLUG`, repeatable): each serves the role its saved registration on this host has.
 */
export interface ReuseChoice { reuseApps?: string[] }
export type InstallRequest = InstallInputs & HerdrChoice;
/** What the App page offers to reuse instead of creating an App, and the reuse itself. */
export interface AppPageReuse { slugs: string[]; adopt: (slug: string) => Promise<AppCredentials & { installationId: number }> }

/**
 * The install request the `install` command's flags describe. It lives beside `resumeCommand`,
 * which must print flags that parse back to the same request (GY-1413).
 */
export function installRequestFromArgs(args: string[]) {
  const { values } = parseArgs({ args, options: {
    provider: { type: 'string' }, repo: { type: 'string' }, plan: { type: 'boolean' }, apply: { type: 'boolean' },
    domain: { type: 'string' }, workers: { type: 'string' }, reviewer: { type: 'string' }, image: { type: 'string' },
    'producer-proof': { type: 'string', multiple: true }, 'base-branch': { type: 'string' }, 'review-policy': { type: 'string' },
    'required-check': { type: 'string', multiple: true }, 'review-count': { type: 'string' },
    'ssh-host': { type: 'string' }, 'ssh-user': { type: 'string' }, 'ssh-key': { type: 'string' }, 'server-name': { type: 'string' }, workspace: { type: 'string' },
    'server-type': { type: 'string' }, location: { type: 'string' }, port: { type: 'string' }, logs: { type: 'boolean' },
    target: { type: 'string' }, local: { type: 'boolean' }, migrate: { type: 'boolean' }, 'max-monthly': { type: 'string' }, 'confirm-price': { type: 'string' },
    'github-app': { type: 'string' }, 'reuse-app': { type: 'string', multiple: true },
    'create-environments': { type: 'boolean' }, 'herdr-rebind': { type: 'boolean' }, 'no-herdr': { type: 'boolean' },
  }, allowPositionals: false });
  if (values['herdr-rebind'] && values['no-herdr']) throw new Error('Choose either --herdr-rebind or --no-herdr');
  if (!values.repo) throw new Error('Use --repo OWNER/NAME');
  for (const slug of values['reuse-app'] ?? []) if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(slug)) throw new Error(`--reuse-app takes an App slug such as graphyard-owner-repo, not ${slug}`);
  // --target names a self-contained install (GY-717): an existing machine, or a Hetzner server it creates.
  if (values.target && values.provider) throw new Error('Use either --target host|hetzner (a self-contained host) or --provider (a server-only install)');
  if (values.target && !['host', 'hetzner'].includes(values.target)) throw new Error('Use --target host (an existing Linux machine) or --target hetzner (a server the installer creates)');
  const provider = values.target ?? values.provider;
  if (!provider || !providers.includes(provider as any)) throw new Error(`Use --provider ${providers.join('|')}, or --target host|hetzner`);
  const money = (flag: string, value: string) => { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${flag} takes an amount such as 19.52`); return parsed; };
  if (values.plan && values.apply) throw new Error('Choose either --plan or --apply');
  const reviewPolicy = values['review-policy'];
  if (reviewPolicy && !['github', 'agent'].includes(reviewPolicy)) throw new Error('Use --review-policy github or agent');
  // A count that silently became NaN would install a control plane with no worker principal
  // or an unusable port, so a non-numeric value stops the command instead.
  const count = (flag: string, value: string) => { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${flag} takes a whole number`); return parsed; };
  const request: InstallRequest & ReuseChoice = { repository: values.repo,
    ...(values['herdr-rebind'] ? { herdr: 'rebind' as const } : values['no-herdr'] ? { herdr: 'skip' as const } : {}), provider: provider as InstallRequest['provider'],
    ...(values.target || provider === 'host' ? { selfContained: true } : {}),
    ...(values.local ? { local: true } : {}), ...(values.migrate ? { migrate: true } : {}),
    ...(values['max-monthly'] ? { maxMonthly: money('max-monthly', values['max-monthly']) } : {}),
    ...(values['confirm-price'] ? { confirmPrice: money('confirm-price', values['confirm-price']) } : {}),
    ...(values['github-app'] ? { githubAppFile: values['github-app'] } : {}),
    ...(values['reuse-app']?.length ? { reuseApps: values['reuse-app'] } : {}),
    ...(values['base-branch'] ? { baseBranch: values['base-branch'] } : {}),
    ...(values.domain ? { domain: values.domain } : {}), ...(values.workers ? { workers: count('workers', values.workers) } : {}),
    ...(values.port ? { port: count('port', values.port) } : {}),
    ...(values.reviewer ? { reviewer: values.reviewer } : {}), ...(values.image ? { image: values.image } : {}),
    ...(values['producer-proof']?.length ? { producerProofs: values['producer-proof'] } : {}),
    ...(reviewPolicy ? { reviewPolicy: reviewPolicy as 'github' | 'agent' } : {}),
    ...(values['required-check']?.length ? { requiredChecks: values['required-check'] } : {}),
    ...(values['review-count'] ? { reviewCount: count('review-count', values['review-count']) } : {}),
    ...(values['ssh-host'] ? { sshHost: values['ssh-host'] } : {}), ...(values['ssh-user'] ? { sshUser: values['ssh-user'] } : {}),
    ...(values['ssh-key'] ? { sshKey: values['ssh-key'] } : {}),
    ...(values['server-name'] ? { serverName: values['server-name'] } : {}), ...(values.workspace ? { workspace: values.workspace } : {}),
    ...(values['server-type'] ? { serverType: values['server-type'] } : {}), ...(values.location ? { location: values.location } : {}),
    ...(values['create-environments'] ? { createEnvironments: true } : {}) };
  return { values, request };
}

export interface InstallSession {
  root: string; inputs: Required<Pick<InstallInputs, 'repository' | 'provider' | 'baseBranch'>> & InstallRequest & ReuseChoice;
  installId: string; directory: string; adapter: ProviderAdapter; context: AdapterContext;
  principals: PlannedPrincipal[]; tokens: Map<string, string>; vault: Vault;
  record: InstallRecord | null; reviewers: { name: string; appId: number; botUserId: number }[];
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
  /** The App registration this install reuses instead of the browser step, or why the named one cannot be. */
  savedApp: { app: SavedApp | null; error: string | null };
  /** Every App registration saved on this host (GY-1442): what --reuse-app and the App page's reuse choose from. */
  registrations: SavedRegistration[];
  /**
   * The repository's delivery model (GY-1102): the reviewed policy graphyard.json commits, or the
   * one a scan would propose when none is committed yet (`committed` false), with the adapter that
   * deploys its UAT and production environments.
   */
  delivery: { policy: DeliveryPolicy; committed: boolean; adapter: DeploymentAdapter; context: DeploymentContext };
}

/** The committed delivery policy, or the one `init --scan` would propose for this checkout. */
export async function repositoryDelivery(root: string): Promise<{ policy: DeliveryPolicy; committed: boolean }> {
  const { readFile } = await import('node:fs/promises');
  let text: string | null = null;
  try { text = await readFile(resolve(root, repositoryConfigFile), 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const committed = text === null ? undefined : parseRepositoryConfig(text).delivery;
  if (committed) return { policy: committed, committed: true };
  const input = await collectScanInput(root), stack = detectStack(input);
  return { policy: proposeDelivery(input, detectDeploy(input, stack), stack), committed: false };
}

const APP_HUMAN_STEP = 'Open the page the installer serves and prints (http://127.0.0.1:4311; it opens no browser), confirm the Graphyard GitHub App there, and install it on the managed repository; when GitHub asks to Confirm access, approve the GitHub Mobile prompt.';
const CORE_HUMAN_STEPS = [
  'Authenticate the provider CLI and GitHub CLI once (the installer prints the exact command when either is missing).',
  'Approve the printed plan before rerunning with --apply.',
];

export function repositoryRoot(cwd: string) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error('Run graphyard install from the checkout of the repository being managed'); }
}

/** The main checkout a linked worktree belongs to (the worktree itself otherwise), where github-setup saved the App. */
function mainCheckout(root: string) {
  try { return resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), '..'); }
  catch { return root; }
}

/**
 * The App registration an install reuses, so one command needs no browser click when the operator
 * already has the Graphyard App on this repository: the file named by --github-app, else this
 * installation's own saved registration, else the one `graphyard github-setup` saved in the
 * checkout. A registration for another repository is never reused; a named file that cannot be
 * used is a preflight failure rather than a silent fallback to the browser.
 */
async function findSavedApp(root: string, directory: string, inputs: InstallInputs, fetcher: typeof fetch): Promise<InstallSession['savedApp']> {
  const forRepository = (app: Pick<SavedApp, 'repository'> | null) => !!app && (app.repository ?? '').toLowerCase() === inputs.repository.toLowerCase();
  // A registration without its installation (the operator installed the App outside the setup
  // page, say from a phone) is completed from the App's own JWT before any App page opens (GY-1476).
  const installed = async (file: string): Promise<SavedApp | null> => {
    const app = await readUninstalledApp(file).catch(() => null);
    if (!app || !forRepository(app)) return null;
    const installationId = await repositoryInstallation(app.facts, inputs.repository, fetcher).catch(() => null);
    return installationId ? { file, repository: app.repository, facts: { ...app.facts, installationId }, detected: true } : null;
  };
  if (inputs.githubAppFile) {
    const file = resolve(inputs.githubAppFile);
    let app: SavedApp | null;
    try { app = await readSavedApp(file) ?? await installed(file); } catch (error: any) { return { app: null, error: `${file} is unreadable: ${error.code === 'ENOENT' ? 'no such file' : error.message}` }; }
    if (!app) return { app: null, error: `${file} holds no complete control-plane App registration (appId, installationId and privateKey)` };
    if (!forRepository(app)) return { app: null, error: `${file} registers the App for ${app.repository ?? 'no repository'}, not ${inputs.repository}` };
    return { app, error: null };
  }
  for (const file of [resolve(directory, 'github-app.json'), resolve(root, '.graphyard', 'github-app.json'), resolve(mainCheckout(root), '.graphyard', 'github-app.json')]) {
    const app = await readSavedApp(file).catch(() => null) ?? await installed(file);
    if (forRepository(app)) return { app, error: null };
  }
  return { app: null, error: null };
}

/** The App registrations saved on this host: every install directory under the config home (`app import`'s too), then the checkout's. */
export async function hostRegistrations(root: string, override?: string) {
  const home = configHome(override);
  const installs = await readdir(home, { withFileTypes: true }).then(entries => entries.filter(entry => entry.isDirectory()).map(entry => resolve(home, entry.name)).sort(), () => [] as string[]);
  return savedRegistrations([...installs, resolve(root, '.graphyard'), resolve(mainCheckout(root), '.graphyard')]);
}
export interface AppCommandDependencies {
  root: string; configHome?: string; fetcher?: typeof fetch;
  /** `gh` with the host's login: resolves stdout, rejects on a non-zero exit. */
  gh?: (args: string[]) => Promise<string>;
}
/**
 * `app import` and `app list` (GY-1451): reuse an App created elsewhere without GitHub sudo. The
 * install the App joins is the repository's (`--repo`, else the checkout's origin); its own
 * webhook, once installed, is the one a control-plane App may keep.
 */
export async function appCommand(args: string[], dependencies: AppCommandDependencies) {
  const [action, ...rest] = args;
  const { values } = parseArgs({ args: rest, options: { repo: { type: 'string' }, 'app-id': { type: 'string' }, 'key-file': { type: 'string' }, role: { type: 'string' } }, allowPositionals: false });
  const repository = values.repo ?? (await discover(dependencies.root)).repository;
  if (!repository) throw new Error('Use --repo OWNER/NAME, or run from a checkout whose origin is the managed repository');
  const directory = installDirectory(installIdFor(repository), dependencies.configHome);
  const record = await readInstallRecord(directory).catch(() => null);
  const webhookUrl = record?.url ? webhookUrlFor(record.url) : null;
  const fetcher = dependencies.fetcher ? { fetcher: dependencies.fetcher } : {};
  if (action === 'import') {
    if (!values['app-id'] || !values['key-file']) throw new Error('Use app import --app-id ID --key-file PEM [--role control-plane|reviewer|revert-approver]');
    const role = (values.role ?? 'control-plane') as AppRole;
    if (!appRoles.includes(role)) throw new Error(`--role takes ${appRoles.join(', ')}`);
    return importApp({ appId: Number(values['app-id']), keyFile: values['key-file'], role, repository, directory, webhookUrl, ...fetcher });
  }
  if (action === 'list') {
    if (values['app-id'] || values['key-file'] || values.role) throw new Error('app list takes only --repo');
    const gh = dependencies.gh ?? (async (args: string[]) => {
      const result = await githubCli(localTransport())(args, { allowFailure: true });
      if (result.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout).trim().split('\n')[0] || `exit ${result.code}`}`);
      return result.stdout;
    });
    return listApps({ repository, registrations: await hostRegistrations(dependencies.root, dependencies.configHome), webhookUrl, gh, ...fetcher });
  }
  throw new Error('Use app import --app-id ID --key-file PEM [--role ROLE], or app list');
}
/** The App --reuse-app names for ROLE, judged by the role its saved registration has. */
const reusedFor = (session: Pick<InstallSession, 'inputs' | 'registrations'>, role: AppRole) =>
  (session.inputs.reuseApps ?? []).find(slug => session.registrations.find(entry => entry.app.slug.toLowerCase() === slug.toLowerCase())?.role === role) ?? null;
/** `gh` on the install's transport (the host's login), resolving stdout or naming its failure. */
const ghText = (session: InstallSession) => async (args: string[]) => {
  const result = await githubCli(session.context.transport)(args, { allowFailure: true });
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 4).join(' ')} failed: ${(result.stderr || result.stdout).trim().split('\n')[0] || `exit ${result.code}`}`);
  return result.stdout;
};
/** Reuse SLUG as the ROLE App: read-only for the plan, adding the repository to its installation on apply. */
function reuseApp(session: InstallSession, slug: string, role: AppRole, webhookUrl: string | null, apply: boolean) {
  return reuseExistingApp({ slug, role, repository: session.inputs.repository, registrations: session.registrations, webhookUrl, gh: ghText(session), fetcher: session.deps.fetch, apply });
}
/** Every --reuse-app slug whose saved registration serves ROLE. One App serves each role, so more than one is refused, never silently dropped. */
export const reusedForRole = (slugs: readonly string[], registrations: readonly SavedRegistration[], role: AppRole) =>
  slugs.filter(slug => registrations.find(entry => entry.app.slug.toLowerCase() === slug.toLowerCase())?.role === role);
/** The --reuse-app preflight: every named App is saved here, fits a role this install fills, and passes reuseExistingApp's checks. */
async function reusePreflight(session: InstallSession, ghReady: boolean): Promise<PreflightItem[]> {
  const items: PreflightItem[] = [];
  for (const slug of session.inputs.reuseApps ?? []) {
    const name = `Reuse App ${slug}`;
    const saved = session.registrations.find(entry => entry.app.slug.toLowerCase() === slug.toLowerCase());
    const fix = 'Name an App whose registration an earlier install or github-setup saved on this host, or drop --reuse-app to register a new App in the browser';
    if (!saved) { items.push({ name, ok: false, detail: `no registration for App ${slug} is saved on this host${session.registrations.length ? `; saved: ${session.registrations.map(entry => entry.app.slug).join(', ')}` : ''}`, fix }); continue; }
    if (saved.role === 'reviewer' && !session.inputs.reviewer) { items.push({ name, ok: false, detail: `${slug} is a reviewer App and this install registers no reviewer`, fix: 'Add --reviewer NAME so the reused App serves as that reviewer' }); continue; }
    const sameRole = reusedForRole(session.inputs.reuseApps ?? [], session.registrations, saved.role);
    if (sameRole.length > 1) { items.push({ name, ok: false, detail: `--reuse-app names ${sameRole.length} ${saved.role} Apps (${sameRole.join(', ')}), and this install uses one ${saved.role} App`, fix: `Keep one --reuse-app for the ${saved.role} role` }); continue; }
    if (saved.role === 'control-plane' && session.inputs.githubAppFile) { items.push({ name, ok: false, detail: '--github-app and --reuse-app both name the control-plane App', fix: 'Keep one of them' }); continue; }
    if (!ghReady) { items.push({ name, ok: false, detail: 'adding the repository to the App\'s installation needs the GitHub CLI', fix: 'Authenticate gh (see the GitHub CLI check), then rerun' }); continue; }
    try {
      const reuse = await reuseApp(session, slug, saved.role, session.record?.url ? webhookUrlFor(session.record.url) : null, false);
      items.push({ name, ok: true, detail: `the ${saved.role} App ${saved.app.slug} (app ${saved.app.appId}) holds the permissions it needs and is installed on ${reuse.account}${reuse.selection === 'all' ? ' for every repository' : `; --apply adds ${session.inputs.repository} to that installation`}` });
    } catch (error) { items.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error), fix }); }
  }
  return items;
}
/** The page's reuse offer for ROLE: every App of that role saved on this host, reused on the page's choice. */
function pageReuse(session: InstallSession, role: AppRole, url: string): AppPageReuse | undefined {
  const slugs = session.registrations.filter(entry => entry.role === role).map(entry => entry.app.slug);
  return slugs.length ? { slugs, adopt: async slug => (await reuseApp(session, slug, role, role === 'control-plane' ? webhookUrlFor(url) : null, true)).app } : undefined;
}

export async function prepareInstall(cwd: string, rawInputs: InstallRequest & ReuseChoice, dependencies: InstallDependencies = {}, mode: 'plan' | 'apply' = 'apply'): Promise<InstallSession> {
  const provider = rawInputs.provider;
  if (!provider) throw new Error('Use --provider railway|hetzner|docker-host|compose, or --target host|hetzner');
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
  const principals = plannedPrincipals(installId, { workers: rawInputs.workers, producerProofs: rawInputs.producerProofs });
  const tokens = selfContained ? new Map<string, string>() : await ensureTokens(directory, principals, vault, false);
  const record = await readInstallRecord(directory);
  let generatedFiles: InstallSession['generatedFiles'];
  try { generatedFiles = { assignment: generatedFilesAssignment(root), error: null }; }
  catch (error: any) { generatedFiles = { assignment: null, error: error.message }; }
  const reviewPolicy = rawInputs.reviewPolicy ?? 'github';
  const delivery = await repositoryDelivery(root);
  const inputs = { ...rawInputs, provider, baseBranch: rawInputs.baseBranch ?? 'main' };
  const transport = dependencies.transport ?? localTransport();
  const ssh = dependencies.ssh ?? ((host: string, user = inputs.sshUser ?? 'root') => sshTransport(host, user, transport));
  // A self-hosted database password is generated once and reused, so re-apply never
  // rewrites a running database's credential out from under it. An installation that already
  // exists yields its real value here, which is what keeps drift reporting exact on re-apply.
  const databasePassword = selfContained ? '' : vault.add(await stableDatabasePassword(directory, false));
  const workdir = provider === 'compose' ? `${directory}/compose` : `/opt/graphyard/${installId}`;
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
    sshHost: inputs.sshHost ?? null, sshUser: inputs.sshUser ?? 'root',
    sshKey: inputs.sshKey ?? null,
    workspace: inputs.workspace ?? null,
    serverType: inputs.serverType ?? 'cx22', serverTypeExplicit: !!inputs.serverType, location: inputs.location ?? 'nbg1',
    plannedAgents: workers + 1,
    databasePassword, port: inputs.port ?? SERVER_PORT, portExplicit: inputs.port !== undefined, dataPath,
    railwayDir: `${directory}/railway`,
    host: selfContained ? {
      layout: hostLayout(installId, workdir, dataPath ?? `/var/lib/graphyard/${installId}`), local: !!inputs.local, workers, executors: 2,
      migrate: !!inputs.migrate, migrationSource, tokens, principals, claim: null, owner: null,
      ref: dependencies.graphyardRef ?? sourceCommit(dependencies.sourceRoot ?? fileURLToPath(new URL('../..', import.meta.url))),
      localCli: dependencies.cliPath ?? fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url)), localNode: process.execPath, localDirectory: directory, localRoot: root, localHost: dependencies.hostId ?? hostname(),
    } : null,
    spend: { maxMonthly: inputs.maxMonthly ?? null, confirmPrice: inputs.confirmPrice ?? null },
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
  const savedApp = await findSavedApp(root, directory, inputs, dependencies.fetch ?? fetch);
  const registrations = await hostRegistrations(root, dependencies.configHome);
  for (const entry of registrations) { vault.add(entry.app.privateKey); if (entry.app.webhookSecret) vault.add(entry.app.webhookSecret); }
  if (savedApp.app) { vault.add(savedApp.app.facts.privateKey); if (savedApp.app.facts.webhookSecret) vault.add(savedApp.app.facts.webhookSecret); }
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
    reviewers: record?.reviewers ?? [], mode, materialized, generatedFiles, savedApp, registrations,
    delivery: { ...delivery, adapter: deploymentAdapters[delivery.policy.deploy.adapter], context: deployment },
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
  session.context.databasePassword = session.vault.add(await stableDatabasePassword(session.directory, true));
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
async function stableDatabasePassword(directory: string, create: boolean) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const file = `${directory}/database.password`;
  try { const value = (await readFile(file, 'utf8')).trim(); if (value.length >= 32) return value; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (!create) return '';
  const password = randomBytes(24).toString('base64url');
  await writeFile(file, `${password}\n`, { mode: 0o600 });
  return password;
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export function coreEnv(session: InstallSession): EnvValue[] {
  const { context, inputs } = session;
  const databaseUrl = context.provider === 'railway' ? '${{Postgres.DATABASE_URL}}' : `postgres://graphyard:${context.databasePassword}@db:5432/graphyard`;
  const capacity = delegationLimitAssignments(session.principals);
  return [
    { name: 'HOST', value: '0.0.0.0', secret: false },
    { name: 'PORT', value: String(SERVER_PORT), secret: false },
    { name: 'DATABASE_URL', value: databaseUrl, secret: carriesCredential('DATABASE_URL', databaseUrl) },
    { name: 'GRAPHYARD_PRINCIPALS', value: principalsVariable(session.principals, session.tokens), secret: true },
    { name: 'GITHUB_REPOSITORY', value: inputs.repository, secret: false },
    { name: 'GITHUB_BASE_BRANCH', value: inputs.baseBranch, secret: false },
    { name: 'GRAPHYARD_REVIEWER_APPS', value: JSON.stringify(session.reviewers.map(reviewer => ({ id: reviewer.name, runtime: reviewer.name.replace(/-reviewer$/, ''), appId: reviewer.appId, botUserId: reviewer.botUserId }))), secret: false },
    // The capacity limits derived from the principal set being deployed; the server derives the
    // same values when they are unset, and an explicit value keeps the install predictable
    // across upgrades. A re-run after the roster changed reports the old values as drift.
    ...delegationLimitVariables.map(name => ({ name, value: capacity.variables[name], secret: false })),
    // The generated files the repository's manifest declares, so the regression guard exempts
    // a regenerated docs index instead of refusing it as an out-of-scope rewrite. A repository
    // that declares none leaves the variable unset, which is its correct deployment state.
    ...(session.generatedFiles.assignment ? [{ name: session.generatedFiles.assignment.variable, value: session.generatedFiles.assignment.value, secret: false }] : []),
  ];
}

export function githubEnv(facts: AppFacts, ciAppIds: number[]): EnvValue[] {
  return [
    { name: 'GITHUB_APP_ID', value: String(facts.appId), secret: false },
    { name: 'GITHUB_INSTALLATION_ID', value: String(facts.installationId), secret: false },
    { name: 'GITHUB_PRIVATE_KEY', value: facts.privateKey, secret: true },
    { name: 'GITHUB_WEBHOOK_SECRET', value: facts.webhookSecret, secret: true },
    { name: 'GITHUB_CI_APP_IDS', value: ciAppIds.join(','), secret: false },
  ];
}

/**
 * The main guard reverts a broken base through a second App, never the control plane's own
 * (GY-1352): the first reviewer App this install registered serves, read from its saved
 * registration. Without one the guard cannot revert unaided, and readiness says so.
 */
export async function revertApproverEnv(session: Pick<InstallSession, 'reviewers' | 'directory'>): Promise<EnvValue[]> {
  const source = await revertApproverSource(session);
  return source ? revertApproverFromFile(source) : [];
}
/** The registration the revert approver signs with: an App reused as the revert approver (GY-1451), else the first reviewer App. */
async function revertApproverSource(session: Pick<InstallSession, 'reviewers' | 'directory'>) {
  const reused = resolve(session.directory, REVERT_APPROVER_FILE);
  if ((await readAppFile(reused))?.privateKey) return reused;
  return session.reviewers[0] ? appCredentialFile(session, session.reviewers[0].name) : null;
}

/**
 * The revert approver variables from one saved App registration (the JSON the manifest flow or
 * `master reviewer bind` writes: appId, installationId, privateKey), or none when it holds no key.
 */
export async function revertApproverFromFile(file: string): Promise<EnvValue[]> {
  const app = await readAppFile(file);
  if (!app?.privateKey || app.privateKey === 'undefined') return [];
  return [
    { name: 'GRAPHYARD_REVERT_APPROVER_APP_ID', value: String(app.appId), secret: false },
    { name: 'GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID', value: String(app.installationId), secret: false },
    { name: 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY', value: app.privateKey, secret: true },
  ];
}

// ---------------------------------------------------------------------------
// Self-provisioning an existing installation (GY-1416)
//
// An installation deployed before the plan derived a variable never got it: production predates
// GY-1352, so its main guard had no revert approver although the reviewer App's registration sat
// on this host. A variable the plan derives from a credential saved here is never a human request.
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
 * Every variable an install session derives from credentials this host holds: the core variables
 * once every principal credential exists, the saved control-plane App registration, and the revert
 * approver from the reviewer App's registration (`revertApproverEnv`).
 */
export async function derivedVariables(session: InstallSession): Promise<DerivedVariable[]> {
  const saved = session.savedApp.app;
  return [
    ...(session.materialized ? derivedFrom(coreEnv(session), `the install plan's credentials under ${session.directory}`) : []),
    ...(saved ? derivedFrom(githubEnv(saved.facts, session.record?.github?.ciAppIds ?? []), `the control-plane App registration ${saved.file}`) : []),
    ...derivedFrom(await revertApproverEnv(session), `the revert approver App registration ${await revertApproverSource(session) ?? ''}`),
  ];
}

/** A variable is present when it, or its file-mounted twin (`…_PRIVATE_KEY_FILE`), is set. */
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
    next: !observation.app ? `The ${context.service} service was not observed on ${context.provider}; check the provider CLI's login and link (${context.railwayDir}), or name the service with --service NAME, then rerun`
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
 * The `gh` login a provider needs (GY-1412): `repo` for branch protection and CI discovery
 * everywhere, plus `admin:repo_hook` for a hosted provider. Compose observes GitHub by polling,
 * never through a webhook, so it needs no `admin:repo_hook`. A login whose scopes `gh` does not
 * list (a fine-grained token) is not refused for scopes it may hold.
 */
export function githubCliScopes(provider: Provider) { return provider === 'compose' ? ['repo'] : ['repo', 'admin:repo_hook']; }
export function githubCliPreflight(provider: Provider, status: { code: number; stdout: string; stderr?: string }, repository: string): PreflightItem {
  const needed = githubCliScopes(provider);
  const login = `gh auth login --scopes ${needed.join(',')}`;
  const note = provider === 'compose' ? '; compose polls GitHub, so it needs no admin:repo_hook' : '';
  if (status.code !== 0) return { name: 'GitHub CLI', ok: false, detail: 'gh is missing or not authenticated', fix: `Install GitHub CLI and run: ${login} (the account must administer ${repository})${note}` };
  const listed = /Token scopes:\s*(.*)/.exec(`${status.stdout}\n${status.stderr ?? ''}`)?.[1];
  const held = listed === undefined ? null : [...listed.matchAll(/[\w:-]+/g)].map(match => match[0]);
  const lacking = held ? needed.filter(scope => !held.includes(scope)) : [];
  if (lacking.length) return { name: 'GitHub CLI', ok: false, detail: `the gh login lacks scope ${lacking.join(', ')} (${provider} needs ${needed.join(', ')})${note}`, fix: `Run: gh auth refresh --scopes ${needed.join(',')}` };
  return { name: 'GitHub CLI', ok: true, detail: `authenticated for branch protection and CI discovery with ${held ? `scopes ${needed.join(', ')}` : 'unlisted scopes'}${note}` };
}

/**
 * A local Compose install serves loopback only, so GitHub can never deliver to it (GY-1474): its App
 * is registered without a webhook, the control plane polls GitHub, and every step that expects a
 * delivery is skipped rather than reported as failing.
 */
export const pollsGitHub = (provider: Provider) => provider === 'compose';
export function webhookPreflight(provider: Provider): PreflightItem | null {
  return pollsGitHub(provider) ? { name: 'GitHub webhook', ok: true, detail: `${provider} is local: the control plane polls GitHub and registers no webhook, so webhook configuration and delivery verification are skipped` } : null;
}
type WebhookProof = DeliveryProof & { skipped?: true };

export async function buildPlan(session: InstallSession): Promise<InstallPlan> {
  const { adapter, context, record } = session;
  const preflight = await adapter.preflight(context);
  const gh = githubCli(context.transport);
  const ghStatus = await gh(['auth', 'status'], { allowFailure: true });
  preflight.push(githubCliPreflight(context.provider, ghStatus, session.inputs.repository));
  const polling = webhookPreflight(context.provider);
  if (polling) preflight.push(polling);
  // The master loop runs from this checkout and its unit refuses a temporary directory: say so
  // before anything is created (GY-1457). A host install runs its loop on the host instead. The
  // test suite's checkouts are all temporary, so it checks durableCheckoutPreflight directly.
  if (!context.host && !underTestRunner()) preflight.push(durableCheckoutPreflight(session.root));
  // Branch protection is what makes `Graphyard / merge` a gate; a repository that cannot have it
  // fails here, before the App, the reviewer App and onboarding are done for nothing (GY-1413).
  const protectionGate = ghStatus.code === 0 ? await protectionAvailability(gh, session.inputs.repository, session.inputs.baseBranch) : null;
  if (protectionGate) preflight.push(protectionGate);
  const protectionHuman = protectionGate && !protectionGate.ok && protectionGate.fix?.startsWith('HUMAN:') ? protectionGate.fix : null;
  // A declared manifest the installer cannot read would deploy a server whose regression guard
  // exempts nothing, so it blocks --apply like any other preflight until the script is fixed.
  preflight.push(session.generatedFiles.error
    ? { name: 'Generated-file manifest', ok: false, detail: session.generatedFiles.error, fix: `Fix ${generatedManifestScript} so \`node ${generatedManifestScript} --manifest\` prints the generated files as JSON, then rerun` }
    : { name: 'Generated-file manifest', ok: true, detail: session.generatedFiles.assignment ? `declares ${session.generatedFiles.assignment.value}` : 'the repository declares no generated files' });
  if (session.inputs.githubAppFile) preflight.push(session.savedApp.error
    ? { name: 'GitHub App registration', ok: false, detail: session.savedApp.error, fix: 'Name the JSON the manifest flow saved for this repository with --github-app FILE, or omit --github-app to register the App in the browser' }
    : { name: 'GitHub App registration', ok: true, detail: `reusing app ${session.savedApp.app!.facts.appId} from ${session.savedApp.app!.file}` });
  preflight.push(...await reusePreflight(session, ghStatus.code === 0));
  const candidateModel = session.delivery.policy.mode === 'release-candidate';
  if (candidateModel) preflight.push(...await session.delivery.adapter.preflight(session.delivery.context));
  // Herdr's graphyard plugin, read before anything is planned around it: one already bound to
  // another server is repointed only with --herdr-rebind (GY-1413).
  const herdr = context.host ? null : await observeHerdr(session);
  const herdrTarget = record?.url ?? null;
  const herdrRelink = session.inputs.herdr !== 'skip' && herdrBoundElsewhere(herdr?.binding ?? null, herdrTarget) ? herdr!.binding!.bound : null;
  if (herdrRelink && session.inputs.herdr !== 'rebind') preflight.push({ name: 'Herdr plugin', ok: false, detail: herdrRebindRefusal(herdrRelink, herdrTarget ?? 'this installation'), fix: 'Rerun with --herdr-rebind to repoint the plugin at this installation, or --no-herdr to leave Herdr untouched' });
  const observation = preflight.every(item => item.ok) ? await adapter.observe(context) : { installed: false, compute: false, database: false, app: false, url: null, variables: {}, detail: ['provider preflight is incomplete; the installation was not inspected'] } as AdapterObservation;

  const core = coreEnv(session);
  const drift: PlanDrift[] = [];
  const actions: PlanAction[] = [];
  const existing = !!record || observation.installed;

  const host = context.host;
  actions.push({
    id: 'local.credentials', target: host ? 'host' : 'local', state: (host ? session.materialized : !!record) ? 'satisfied' : 'create',
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
  actions.push({ id: 'provider.env.core', target: 'provider', state: !observation.installed ? 'create' : coreDrift.length ? 'update' : 'satisfied', title: 'Set the control-plane variables on the application service', values: core.map(value => planValue(value, session.materialized)), drift: coreDrift });
  actions.push({ id: 'provider.deploy', target: 'provider', state: observation.app ? 'update' : 'create', title: 'Deploy the application and wait for it to become healthy' });
  actions.push({ id: 'provider.url', target: 'provider', state: observation.url ? 'satisfied' : 'create', title: context.domain ? `Bind ${context.domain} to the service over HTTPS` : 'Obtain the public HTTPS URL of the service', values: observation.url ? [{ name: 'url', value: observation.url, secret: false }] : [] });
  actions.push({ id: 'verify.health', target: 'graphyard', state: 'update', title: 'Verify GET /healthz returns {"ok":true}' });

  const appConfigured = !!record?.github;
  const saved = session.savedApp.app;
  const reusedApp = reusedFor(session, 'control-plane');
  if (reusedApp && !appConfigured) actions.push({ id: 'github.app', target: 'github', state: 'update', title: `Reuse the GitHub App ${reusedApp} already installed on the account: add ${session.inputs.repository} to its installation with the host's gh login and verify the App reaches it; no browser step` });
  else actions.push(appConfigured || !saved
    ? { id: 'github.app', target: 'github', state: appConfigured ? 'satisfied' : 'create', title: 'Register the Graphyard GitHub App through the manifest flow and install it on the managed repository', human: 'One browser confirmation: create the App, then choose the managed repository. GitHub returns the App ID, private key, and webhook secret directly to this machine.' }
    : { id: 'github.app', target: 'github', state: 'update', title: `Reuse the Graphyard GitHub App ${saved.facts.slug} (app ${saved.facts.appId}, installation ${saved.facts.installationId}) saved in ${saved.file}, after an installation token minted from it proves it still works; no browser step` });
  actions.push({ id: 'github.env', target: 'provider', state: appConfigured ? 'satisfied' : 'create', title: 'Write the App ID, installation ID, private key, and webhook secret to the server', values: [
    { name: 'GITHUB_APP_ID', value: record?.github ? String(record.github.appId) : saved ? String(saved.facts.appId) : '<from the App manifest flow>', secret: false },
    { name: 'GITHUB_INSTALLATION_ID', value: record?.github ? String(record.github.installationId) : saved ? String(saved.facts.installationId) : '<from the App installation>', secret: false },
    { name: 'GITHUB_PRIVATE_KEY', value: REDACTED, secret: true },
    { name: 'GITHUB_WEBHOOK_SECRET', value: REDACTED, secret: true, ...(record?.github ? { fingerprint: record.github.webhookFingerprint } : saved?.facts.webhookSecret ? { fingerprint: fingerprint(saved.facts.webhookSecret) } : { note: 'returned by the App manifest flow' }) },
  ] });
  actions.push(pollsGitHub(context.provider)
    ? { id: 'github.webhook', target: 'github', state: 'satisfied', title: 'Skipped: a local install registers no App webhook; the control plane polls GitHub' }
    : { id: 'github.webhook', target: 'github', state: appConfigured ? 'update' : 'create', title: `Point the App webhook at ${observation.url ? webhookUrlFor(observation.url) : '<service URL>/api/github/webhook'} with the shared secret the server holds` });
  actions.push({ id: 'github.ci-app-ids', target: 'github', state: record?.github?.ciAppIds.length ? 'satisfied' : 'create', title: `Detect the GitHub App IDs publishing checks on ${session.inputs.baseBranch} and set GITHUB_CI_APP_IDS`, values: record?.github?.ciAppIds.length ? [{ name: 'GITHUB_CI_APP_IDS', value: record.github.ciAppIds.join(','), secret: false }] : [] });

  const protection = preflight.some(item => item.name === 'GitHub CLI' && item.ok) ? await readProtection(gh, session.inputs.repository, session.inputs.baseBranch) : null;
  const protectionInputs = { repository: session.inputs.repository, branch: session.inputs.baseBranch, requiredChecks: session.requiredChecks, graphyardAppId: record?.github?.appId ?? null, reviewCount: session.reviewCount };
  const protectionOk = protectionSatisfied(protectionInputs, protection);
  // A branch that already demands more reviewers keeps its own count; the plan says so.
  const plannedReviews = effectiveReviewCount(protectionInputs, protection);
  const reviewPhrase = plannedReviews > session.reviewCount
    ? `${plannedReviews} approving review(s), the stricter count this branch already requires`
    : `at least ${session.reviewCount} approving review(s) for the ${session.reviewPolicy} review policy`;
  if (protection && !protectionOk) drift.push({ action: 'github.protection', field: 'branch protection', expected: `required checks ${[...session.requiredChecks, ...GRAPHYARD_CHECKS].join(', ')} with "up to date" off (a candidate merges on the base it was built on); at least ${session.reviewCount} approving review(s); admin enforcement; conversation resolution off (the reviewer's verdict is the review gate)`, observed: describeProtection(protection) });
  actions.push({ id: 'github.protection', target: 'github', state: protectionOk ? 'satisfied' : protection ? 'update' : 'create', ...(protectionHuman ? { human: protectionHuman } : {}), title: `Require status checks (${[...session.requiredChecks, ...GRAPHYARD_CHECKS].join(', ')}) with "require branches to be up to date" off, so a candidate merges on the base it was built on, ${reviewPhrase} and administrator enforcement, with conversation resolution off (the reviewer's verdict is the review gate), on ${session.inputs.baseBranch}` });
  // The release-candidate pipeline's environments (GY-1102): free wiring, then every UAT and
  // production resource the deployment adapter would create, cost-bearing ones marked human.
  if (candidateModel) {
    const ghReady = preflight.some(item => item.name === 'GitHub CLI' && item.ok);
    actions.push(...wiringActions(session.delivery.context, ghReady ? await observeReleaseWiring(gh, session.inputs.repository) : null));
    actions.push(...session.delivery.adapter.plan(session.delivery.context));
  }
  const reusedReviewer = reusedFor(session, 'reviewer');
  if (session.inputs.reviewer) actions.push({ id: 'github.reviewer', target: 'github', state: record?.reviewers.some(reviewer => reviewer.name === session.inputs.reviewer) ? 'satisfied' : 'create', title: `${reusedReviewer ? `Reuse the reviewer App ${reusedReviewer} as "${session.inputs.reviewer}" (the repository is added to its installation)` : `Register the reviewer App "${session.inputs.reviewer}"`}, add its identity to GRAPHYARD_REVIEWER_APPS, and set it as the main guard's revert approver (GRAPHYARD_REVERT_APPROVER_*)`, ...(reusedReviewer ? {} : { human: 'One additional browser confirmation, because a reviewer is a separate GitHub identity with no control-plane authority.' }) });

  actions.push({ id: 'verify.status', target: 'graphyard', state: 'update', title: 'Verify authenticated GET /api/status reports the admin actor, the managed repository, and the bound App' });
  // A local install has no webhook to deliver to, so its delivery check is skipped, not failed.
  actions.push(pollsGitHub(context.provider)
    ? { id: 'verify.webhook', target: 'graphyard', state: 'satisfied', title: 'Skipped: a local install registers no webhook, so there is no delivery to verify; the control plane polls GitHub' }
    : { id: 'verify.webhook', target: 'graphyard', state: 'update', title: 'Publish one neutral check run and confirm GitHub delivered it to the server.' });
  if (!host) {
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

  const reviewerBound = !!record?.reviewers.some(reviewer => reviewer.name === session.inputs.reviewer);
  const browserApps: Exclude<AppRole, 'revert-approver'>[] = [...(appConfigured || saved || reusedApp ? [] : ['control-plane' as const]), ...(session.inputs.reviewer && !reviewerBound && !reusedReviewer ? ['reviewer' as const] : [])];
  const plan: InstallPlan = {
    version: 1, repository: session.inputs.repository, provider: context.provider, installId: session.installId,
    installDirectory: session.directory, baseBranch: session.inputs.baseBranch, reviewPolicy: session.reviewPolicy,
    domain: context.domain, url: observation.url ?? record?.url ?? null, existing, secretsRedacted: true,
    preflight, principals: session.principals, actions, drift,
    humanSteps: [...(protectionHuman ? [protectionHuman] : []), CORE_HUMAN_STEPS[0], ...((saved || reusedApp) && !appConfigured ? [] : [APP_HUMAN_STEP]), ...CORE_HUMAN_STEPS.slice(1), ...(session.inputs.reviewer && !reusedReviewer ? [`Confirm the separate reviewer App "${session.inputs.reviewer}" in the browser.`] : []),
      ...(host ? ['After install, sign in once with the printed link and connect each agent account on the dashboard Agents page; nobody logs into the host.'] : []),
      ...(candidateModel ? ['Approve any UAT or production resource the plan marks as costing money before rerunning with --apply --create-environments; without that flag none is created.'] : [])],
    ...(host ? { host: hostPlan(context) } : {}),
    ...(context.provider === 'hetzner' ? { price: quotedPrice(context) } : {}),
    delivery: deliverySummary(session), browserApps,
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


/**
 * GitHub's answer for the base branch's protection, read before anything is created (GY-1413).
 * 404 (not protected yet) is fine: the plan creates it. 403 "Upgrade to GitHub Pro or make this
 * repository public" means a private repository on a free plan, which can never have branch
 * protection, so the merge gate is impossible — a human choice of public or paid, not an agent's.
 */
export async function protectionAvailability(gh: ReturnType<typeof githubCli>, repository: string, branch: string): Promise<PreflightItem> {
  const result = await gh(['api', `repos/${repository}/branches/${branch}/protection`], { allowFailure: true });
  const answer = `${result.stderr}\n${result.stdout}`;
  if (result.code !== 0 && /upgrade to github pro|make this repository public/i.test(answer)) return {
    name: 'Branch protection', ok: false,
    detail: `GitHub answered 403 "Upgrade to GitHub Pro or make this repository public" for ${repository}@${branch}: a private repository on a free plan cannot have branch protection, so "${CHECK_NAME}" can never be required and the merge gate is impossible`,
    fix: `HUMAN: make ${repository} public, or upgrade its GitHub plan (spending money is a human decision), then rerun the installer`,
  };
  if (result.code === 0) return { name: 'Branch protection', ok: true, detail: `${branch} is protected; the plan reconciles it` };
  // Only GitHub's 404 "Branch not protected" means unprotected. Any other failure (SSO, missing
  // admin rights, rate limit, 5xx, network) says nothing about the branch, so the preflight stops
  // here instead of deploying and failing later at github.protection.
  if (/branch not protected/i.test(answer)) return { name: 'Branch protection', ok: true, detail: `${branch} is not protected yet; the plan creates its protection` };
  const error = answer.trim().split('\n').filter(Boolean).at(-1) ?? `gh exited ${result.code}`;
  return {
    name: 'Branch protection', ok: false,
    detail: `GitHub did not answer the protection read for ${repository}@${branch}: ${error}. Its protection is unknown, so the merge gate cannot be planned`,
    fix: `gh api repos/${repository}/branches/${branch}/protection, fix what GitHub answers (the gh login must administer ${repository}, with SSO authorized), then rerun the installer`,
  };
}

/** Herdr on this machine and the server its graphyard plugin is bound to, when it is. */
async function observeHerdr(session: InstallSession) {
  const { deps, context } = session;
  const state = await (deps.detectHerdr ?? detectHerdr)(context.transport);
  if (!state.available || session.inputs.herdr === 'skip') return { state, binding: null };
  const run = deps.runHerdr ?? (async (args: string[]) => { const result = await context.transport.exec('herdr', args, { allowFailure: true, timeout: 30_000 }); return result.code === 0 ? result.stdout : ''; });
  return { state, binding: await herdrPluginBinding(run) };
}

/** The plan line for Herdr: link, keep, relink (named, with the server it is bound to now), or leave alone. */
function herdrAction(session: InstallSession, herdr: Awaited<ReturnType<typeof observeHerdr>> | null, relink: string | null, target: string | null): PlanAction {
  const steps = 'herdr plugin link, write the plugin config.json {url, worker token}, herdr plugin enable';
  if (session.inputs.herdr === 'skip') return { id: 'local.herdr', target: 'local', state: 'satisfied', title: 'Leave Herdr untouched (--no-herdr): the graphyard plugin is neither linked nor reconfigured' };
  if (!herdr?.state.available) return { id: 'local.herdr', target: 'local', state: 'satisfied', title: 'Herdr is not installed on this machine; nothing to link, and workers start from the CLI' };
  if (relink) return { id: 'local.herdr', target: 'local', state: 'update', title: `Relink Herdr's graphyard plugin, now bound to ${relink}, to ${target ?? 'this installation'} (${steps})${session.inputs.herdr === 'rebind' ? '; --herdr-rebind allows it' : '; refused without --herdr-rebind'}` };
  if (herdr.binding) return { id: 'local.herdr', target: 'local', state: 'satisfied', title: `Herdr's graphyard plugin is already bound to ${herdr.binding.bound}; it keeps that server` };
  return { id: 'local.herdr', target: 'local', state: 'create', title: `Link and enable Herdr's graphyard plugin for this repository (${steps})` };
}

function describeProtection(protection: any) {
  const checks = (protection?.required_status_checks?.checks ?? []).map((check: any) => `${check.context}${check.app_id ? ` (app ${check.app_id})` : ''}`);
  return `strict=${!!protection?.required_status_checks?.strict}; checks ${checks.join(', ') || 'none'}; reviews ${protection?.required_pull_request_reviews?.required_approving_review_count ?? 0}; enforce_admins=${!!protection?.enforce_admins?.enabled}; conversation_resolution=${!!protection?.required_conversation_resolution?.enabled}; force_pushes=${!!protection?.allow_force_pushes?.enabled}; deletions=${!!protection?.allow_deletions?.enabled}`;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface InstallSummary {
  repository: string; provider: Provider; installId: string; installDirectory: string;
  url: string; webhookUrl: string; check: string; reviewers: { name: string; appId: number; botUserId: number }[];
  principals: { id: string; role: string; fingerprint: string; tokenFile: string }[];
  github: { appId: number; installationId: number; slug: string; ciAppIds: number[] } | null;
  protection: string; health: boolean; status: { actor: string; role: string; repository: string; githubAppId: number | null };
  webhook: WebhookProof; profiles: ProfileRegistration; drift: PlanDrift[]; nextSteps: string[];
  /** The self-contained host: its units, runtimes, accounts and Herdr workspace (GY-717). */
  host?: HostFleetResult;
  /** The single-use dashboard sign-in for the admin; printed once, stored on the host only as a hash. */
  signIn?: string;
  release: { mode: 'release-candidate' | 'per-pr'; adapter: 'railway' | 'command'; created: string[]; pending: { id: string; command?: string; human?: string }[] };
}

/**
 * A provider command that fails now carries the provider's own diagnostic, which may quote a
 * value the installer piped into it, so the failure is scrubbed on the way out like every log
 * line and the summary.
 */
export async function applyInstall(session: InstallSession, plan: InstallPlan): Promise<InstallSummary> {
  try { return await performInstall(session, plan); }
  catch (error: any) {
    if (error instanceof InstallPaused) throw error;
    const message = session.vault.scrub(String(error?.message ?? error));
    throw message === error?.message ? error : new Error(message);
  }
}

/**
 * The App manifest flow's registration credentials (the App private key and webhook secret)
 * are stored beside the rest of the installation's secrets, under the install directory and
 * outside every Git checkout — the runbook's hard rule, which the default would otherwise
 * break by writing `<repository>/.graphyard/github-app.json`.
 */
const appCredentialFile = (session: Pick<InstallSession, 'directory'>, reviewer?: string) =>
  resolve(session.directory, reviewer ? `github-reviewer-${reviewer}.json` : 'github-app.json');
/** Where an App reused as the revert approver (`--reuse-app` of a revert-approver registration) is saved as this install's own. */
const REVERT_APPROVER_FILE = 'github-revert-approver.json';

async function performInstall(session: InstallSession, plan: InstallPlan): Promise<InstallSummary> {
  const { adapter, context, deps, vault } = session;
  if (session.mode !== 'apply') throw new Error('Apply requires a session prepared in apply mode; --plan sessions create nothing');
  const log = (line: string) => deps.log(vault.scrub(line));
  // The gate comes before anything is written, so "changed nothing" is literally true: at this
  // point not even a credential file exists yet for a first install.
  const blocked = plan.preflight.filter(item => !item.ok);
  if (blocked.length) throw new Error(`Preflight is incomplete; the installer changed nothing.\n${blocked.map(item => `- ${item.name}: ${item.detail}${item.fix ? `\n  ${item.fix.startsWith('HUMAN:') ? '' : 'Run: '}${item.fix}` : ''}`).join('\n')}`);
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
  record = { ...record, url, domain: context.domain, service: context.service, provider: context.provider, selfContained: !!context.host, migratedFrom, baseBranch: session.inputs.baseBranch, reviewPolicy: session.reviewPolicy, principals: session.principals.map(principal => ({ id: principal.id, role: principal.role, ...(principal.sessionKind ? { sessionKind: principal.sessionKind } : {}), ...(principal.proofs?.length ? { proofs: principal.proofs } : {}), fingerprint: fingerprint(session.tokens.get(principal.id)!) })), updatedAt: new Date(deps.now()).toISOString() };
  await writeInstallRecord(session.directory, record, vault);

  // The master's local configuration and the profiles come before the App step (GY-1413), so
  // `master environments` and `master harness` (setup-from-zero steps 8-9) run while a human
  // confirms the App; the registration after it binds the confirmed App.
  const early = !context.host && !record.github ? await registerProfiles(session, url, true) : null;

  // GitHub: the App manifest flow needs the live HTTPS origin, so it runs after the URL exists.
  let facts: Awaited<ReturnType<typeof resolveApp>>;
  try {
    facts = await resolveApp(session, url, record);
    vault.add(facts.privateKey); vault.add(facts.webhookSecret);
    if (session.inputs.reviewer && !session.reviewers.some(reviewer => reviewer.name === session.inputs.reviewer)) {
      const reusedReviewer = reusedFor(session, 'reviewer');
      const reviewerFacts = reusedReviewer ? await adoptApp(session, reusedReviewer, 'reviewer', url)
        : await deps.githubApp!({ root: session.root, repository: session.inputs.repository, origin: url, file: appCredentialFile(session, session.inputs.reviewer), reviewer: session.inputs.reviewer, reuse: pageReuse(session, 'reviewer', url) });
      if (!reviewerFacts.botUserId) throw new Error('GitHub did not return the reviewer bot identity; rerun the reviewer registration');
      if (reviewerFacts.appId === facts.appId) throw new Error('A reviewer App must be a different identity from the Graphyard control-plane App');
      session.reviewers = [...session.reviewers, { name: session.inputs.reviewer, appId: reviewerFacts.appId, botUserId: reviewerFacts.botUserId }];
      log(`Registered reviewer App ${session.inputs.reviewer} (app ${reviewerFacts.appId})`);
    }
    // A revert approver reused by --reuse-app (GY-1451) replaces the reviewer App in that seat; it is never the control plane's.
    const reusedApprover = reusedFor(session, 'revert-approver');
    if (reusedApprover && (await adoptApp(session, reusedApprover, 'revert-approver', url)).appId === facts.appId) throw new Error('The revert approver App must be a different identity from the Graphyard control-plane App');
  } catch (error) {
    if (!(error instanceof AppStepPending)) throw error;
    const pending = await pausedSummary(session, plan, url, health, early, error);
    vault.assertClean(JSON.stringify(pending), 'the paused installation summary');
    throw new InstallPaused(vault.scrub(error.message), vault.scrub(pending));
  }
  const gh = githubCli(context.transport);
  const ciApps = await detectCiAppIds(gh, session.inputs.repository, session.inputs.baseBranch, facts.appId);
  log(`CI App identities on ${session.inputs.baseBranch}: ${ciApps.map(app => `${app.slug} (${app.appId})`).join(', ') || 'none observed yet'}`);
  const revertApprover = await revertApproverEnv(session);
  for (const value of revertApprover) if (value.secret) vault.add(value.value);
  await adapter.setEnv(context, [...coreEnv(session), ...githubEnv(facts, ciApps.map(app => app.appId)), ...revertApprover]);
  await adapter.deploy(context);
  if (!await waitForHealth(session, url)) throw new Error('The service did not return to health after the GitHub credentials were written');

  const app = appClient(facts, deps.fetch);
  // An App registered for an origin GitHub cannot reach (loopback, private) has no hook, whatever
  // the provider: PATCHing its /app/hook/config 404s, so it is configured and proved like a local
  // install's, which is to say not at all (GY-1476).
  const webhookConfig = pollsGitHub(context.provider) ? null : await readWebhookConfig(app);
  const polling = pollsGitHub(context.provider) || (!publiclyReachable(url) && !webhookConfig?.url);
  // A GitHub App has one webhook. A reused App whose webhook still reaches a live installation keeps
  // it unless this install is the cutover (--migrate), so a trial host never takes an existing
  // installation's events away from it.
  const webhookElsewhere = facts.reused && !context.host?.migrate && webhookConfig?.url && webhookConfig.url !== webhookUrlFor(url) && await answersHealth(session, String(webhookConfig.url)) ? String(webhookConfig.url) : null;
  if (webhookElsewhere) log(`The App webhook stays with ${webhookElsewhere}, an installation that still answers; rerun with --migrate to move it here`);
  else if (polling) log('A local install registers no App webhook; the control plane polls GitHub');
  else {
    if (webhookConfig?.url !== webhookUrlFor(url)) log(`Repointing the App webhook to ${webhookUrlFor(url)}`);
    await configureWebhook(app, url, facts.webhookSecret);
  }

  const protectionInputs = { repository: session.inputs.repository, branch: session.inputs.baseBranch, requiredChecks: session.requiredChecks, graphyardAppId: facts.appId, reviewCount: session.reviewCount };
  const current = await readProtection(gh, session.inputs.repository, session.inputs.baseBranch);
  // The App-bound merge check is added only once Graphyard has published it; requiring a
  // context that does not exist yet would block every pull request on the repository.
  const mergeCheckExists = (current?.required_status_checks?.checks ?? []).some((check: any) => check.context === CHECK_NAME)
    || (await detectCiAppIds(gh, session.inputs.repository, session.inputs.baseBranch, null)).some(entry => entry.appId === facts.appId);
  const applied = protectionSatisfied(protectionInputs, current) ? null : await applyProtection(gh, { ...protectionInputs, graphyardAppId: mergeCheckExists ? facts.appId : null });
  const protectionDetail = applied
    ? `required checks ${applied.required_status_checks.checks.map(check => check.context).join(', ')} ("up to date" off: a candidate merges on the base it was built on); ${applied.required_pull_request_reviews.required_approving_review_count} approving review(s); admin enforcement`
    : `already matches the ${session.reviewPolicy} review policy`;

  // The release pipeline's free wiring, then the adapter's environments: paid ones only with
  // --create-environments, every other one left pending with its exact command.
  const release: InstallSummary['release'] = { mode: session.delivery.policy.mode, adapter: session.delivery.policy.deploy.adapter, created: [], pending: [] };
  if (release.mode === 'release-candidate') {
    release.created.push(...await applyWiring(gh, session.delivery.context));
    const provisioned = await session.delivery.adapter.provision(session.delivery.context, { createPaid: !!session.inputs.createEnvironments });
    release.created.push(...provisioned.created);
    release.pending = provisioned.pending.map(action => ({ id: action.id, ...(action.command ? { command: action.command } : {}), ...(action.human ? { human: action.human } : {}) }));
  }
  const releaseCreated = [...new Set([...(record.release?.created ?? []), ...release.created.filter(id => !id.startsWith('release.branches') && !id.startsWith('release.github'))])];
  record = { ...record, release: { adapter: release.adapter, created: releaseCreated } };

  const status = await authenticatedStatus(session, url);
  const installation = installationClient(facts, deps.fetch);
  const since = deps.now();
  let webhook: WebhookProof;
  if (polling) webhook = { delivered: false, skipped: true, statusCode: null, event: null, at: null, detail: 'skipped: a local install registers no webhook; the control plane polls GitHub' };
  else if (webhookElsewhere) webhook = { delivered: false, statusCode: null, event: null, at: null, detail: `the reused App's webhook still serves ${webhookElsewhere}; this installation receives no GitHub events until it is moved here with --migrate` };
  else try {
    await triggerDelivery(installation, session.inputs.repository, await headSha(gh, session.inputs.repository, session.inputs.baseBranch));
    webhook = await verifyDelivery(app, since, deps.wait);
  } catch (error: any) { webhook = { delivered: false, statusCode: null, event: null, at: null, detail: vault.scrub(`Could not publish the verification event: ${error.message}`) }; }

  const fleet = context.host && 'installFleet' in adapter
    ? await (adapter as ProviderAdapter & { installFleet: typeof installHostFleet }).installFleet(context, {
      url, adminToken: session.tokens.get(principalOfRole(session.principals, 'admin').id)!, coordinatorToken: session.tokens.get(principalOfRole(session.principals, 'coordinator').id)!,
      reviewer: session.inputs.reviewer ?? null, fetch: deps.fetch, log,
      cloneToken: vault.add((await installationToken(facts, deps.fetch)).token),
      github: { appId: facts.appId, installationId: facts.installationId, slug: facts.slug, privateKey: facts.privateKey, ...(facts.botUserId ? { botUserId: facts.botUserId } : {}) },
    })
    : null;
  const profiles = fleet ? fleet.profiles : await registerProfiles(session, url);
  record = installRecordSchema.parse({
    ...record,
    github: { appId: facts.appId, installationId: facts.installationId, slug: facts.slug, webhookFingerprint: fingerprint(facts.webhookSecret), ciAppIds: ciApps.map(entry => entry.appId) },
    reviewers: session.reviewers,
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
    url, webhookUrl: webhookUrlFor(url), check: CHECK_NAME, reviewers: session.reviewers,
    principals: session.principals.map(principal => ({ id: principal.id, role: principal.role, fingerprint: fingerprint(session.tokens.get(principal.id)!), tokenFile: context.host ? hostTokenFile(context.host.layout, principal.id) : tokenFile(session.directory, principal.id) })),
    github: { appId: facts.appId, installationId: facts.installationId, slug: facts.slug, ciAppIds: ciApps.map(entry => entry.appId) },
    protection: protectionDetail, health, status, webhook, profiles, drift: plan.drift,
    nextSteps: [...nextSteps(session, url, mergeCheckExists, webhook, profiles), ...release.pending.map(action => `${action.human ?? 'Pending'} Command: ${action.command}`)],
    release,
    ...(fleet ? { host: fleet } : {}),
    ...(context.host?.claim ? { signIn: `${url}/#claim=${context.host.claim}` } : {}),
  };
  const serialized = JSON.stringify(summary);
  vault.assertClean(serialized, 'the installation summary');
  return vault.scrub(summary);
}

/**
 * What `install --apply` completed when its App step timed out (GY-1413): the control plane is up
 * and healthy and stays running, the local profiles exist, and nothing GitHub-bound was written.
 */
export interface PausedInstall {
  complete: false; repository: string; provider: Provider; installId: string; installDirectory: string;
  url: string; health: boolean;
  completed: string[];
  github: { app: 'pending'; step: string; credentials: string };
  credentials: { principals: string; githubApp: string };
  stack: { running: true; detail: string; stop: string | null };
  profiles: ProfileRegistration | null;
  resume: string; nextSteps: string[];
}

/**
 * How long the App page is served (GY-1457): `graphyard up` sets GRAPHYARD_APP_WAIT_MS to its own
 * wait plus a minute, so the page outlives the browser drive's Confirm-access wait; otherwise 900 s.
 */
export function appStepWait(env: NodeJS.ProcessEnv) {
  const ms = Number(env.GRAPHYARD_APP_WAIT_MS);
  return Number.isSafeInteger(ms) && ms > 0 ? { timeoutMs: ms } : {};
}

/** The App step paused the install; `summary` is what it completed, printed as JSON before the exit. */
export class InstallPaused extends Error {
  constructor(message: string, readonly summary: PausedInstall) { super(message); }
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
  const flags: Record<keyof InstallRequest, string[]> = {
    provider: inputs.selfContained || inputs.provider === 'host' ? ['--target', inputs.provider] : ['--provider', inputs.provider],
    selfContained: [],
    repository: value('repo', inputs.repository),
    baseBranch: inputs.baseBranch !== 'main' ? value('base-branch', inputs.baseBranch) : [],
    domain: value('domain', inputs.domain), workers: value('workers', inputs.workers), port: value('port', inputs.port), reviewer: value('reviewer', inputs.reviewer),
    producerProofs: values('producer-proof', inputs.producerProofs),
    reviewPolicy: value('review-policy', inputs.reviewPolicy), reviewCount: value('review-count', inputs.reviewCount),
    requiredChecks: values('required-check', inputs.requiredChecks),
    sshHost: value('ssh-host', inputs.sshHost), sshUser: value('ssh-user', inputs.sshUser), sshKey: value('ssh-key', inputs.sshKey),
    workspace: value('workspace', inputs.workspace), image: value('image', inputs.image),
    serverName: value('server-name', inputs.serverName), serverType: value('server-type', inputs.serverType), location: value('location', inputs.location),
    local: flag('local', inputs.local), migrate: flag('migrate', inputs.migrate),
    maxMonthly: value('max-monthly', inputs.maxMonthly), confirmPrice: value('confirm-price', inputs.confirmPrice),
    githubAppFile: value('github-app', inputs.githubAppFile),
    createEnvironments: flag('create-environments', inputs.createEnvironments),
    herdr: inputs.herdr === 'rebind' ? ['--herdr-rebind'] : inputs.herdr === 'skip' ? ['--no-herdr'] : [],
  };
  return ['graphyard', 'install', ...Object.values(flags).flat(), ...values('reuse-app', inputs.reuseApps), '--apply'].join(' ');
}

async function pausedSummary(session: InstallSession, plan: InstallPlan, url: string, health: boolean, profiles: ProfileRegistration | null, pending: AppStepPending): Promise<PausedInstall> {
  const { context } = session;
  const before = plan.actions.slice(0, Math.max(0, plan.actions.findIndex(action => action.id === 'github.app'))).map(action => action.id);
  const controlPlaneApp = !pending.reviewer;
  const savedFile = controlPlaneApp ? pending.file : appCredentialFile(session);
  const resume = resumeCommand(session);
  const stop = context.provider === 'compose' ? `docker compose --project-directory ${context.workdir} down` : null;
  return {
    complete: false, repository: session.inputs.repository, provider: context.provider, installId: session.installId, installDirectory: session.directory,
    url, health,
    completed: [...before, ...(profiles?.master.configured ? ['local.profiles'] : []), ...(profiles?.repository.connected ? ['local.herdr'] : []), ...(controlPlaneApp ? [] : ['github.app'])],
    github: { app: 'pending', step: controlPlaneApp ? 'github.app' : 'github.reviewer', credentials: pending.saved ? `GitHub returned the ${controlPlaneApp ? 'App' : `reviewer App "${pending.reviewer}"`} registration to ${pending.file}; it is not installed on ${session.inputs.repository} yet` : `none saved: nobody confirmed the ${controlPlaneApp ? 'App' : `reviewer App "${pending.reviewer}"`}, so ${pending.file} was never written` },
    // A self-contained target's tokens were written on the host by its setEnv; this machine keeps fingerprints only.
    credentials: { principals: context.host ? `saved on the host under ${context.host.layout.tokensDirectory} (mode 0600); this machine keeps fingerprints only in ${session.directory}` : `saved under ${session.directory} (mode 0600)`, githubApp: controlPlaneApp ? (pending.saved ? `registration saved in ${savedFile}, installation pending` : 'not saved') : `saved in ${savedFile}` },
    stack: { running: true, detail: `the control plane keeps running at ${url}${stop ? ` (Compose project ${context.workdir})` : context.host ? ' on the host' : ''}`, stop },
    profiles,
    resume,
    nextSteps: [
      `A human confirms the ${controlPlaneApp ? 'Graphyard GitHub App' : `reviewer App "${pending.reviewer}"`} (docs/setup-from-zero.md step ${controlPlaneApp ? 4 : 5}), then run: ${resume}. It is idempotent and keeps everything above.`,
      ...(profiles?.master.configured ? ['graphyard master environments and graphyard master harness already work in this checkout (steps 8-9).'] : []),
      ...(stop ? [`To stop the control plane instead: ${stop}`] : []),
    ],
  };
}

function emptyRecord(session: InstallSession, url: string): InstallRecord {
  const at = new Date(session.deps.now()).toISOString();
  return installRecordSchema.parse({ version: 1, installId: session.installId, repository: session.inputs.repository, provider: session.context.provider, baseBranch: session.inputs.baseBranch, reviewPolicy: session.reviewPolicy, domain: session.context.domain, url, principals: [], github: null, reviewers: [], profiles: [], createdAt: at, updatedAt: at });
}

async function answersHealth(session: InstallSession, webhook: string) {
  try { return (await session.deps.fetch(`${new URL(webhook).origin}/healthz`, { signal: AbortSignal.timeout(15_000) })).ok; }
  catch { return false; }
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
  return { actor: String(body.actor.id), role: String(body.actor.role), repository: String(body.repository), githubAppId: body.githubAppId ?? null };
}

async function resolveApp(session: InstallSession, url: string, record: InstallRecord): Promise<AppFacts & { slug: string; botUserId?: number; reused?: boolean }> {
  const { deps } = session;
  const reused = reusedFor(session, 'control-plane');
  if (reused) {
    const facts = await adoptApp(session, reused, 'control-plane', url);
    if (record.github && record.github.appId !== facts.appId) deps.log(`GitHub App changed from ${record.github.appId} to ${facts.appId}`);
    return { ...facts, reused: true };
  }
  const saved = session.savedApp.app;
  if (saved) {
    // A saved registration is used only once GitHub mints an installation token from it, so a
    // deleted App or an uninstalled repository is found here rather than by the fleet.
    try {
      await installationToken(saved.facts, deps.fetch);
      const own = appCredentialFile(session);
      // An installation found through the App's JWT is recorded with the registration (GY-1476).
      if (saved.detected) { await writeFile(own, JSON.stringify({ ...JSON.parse(await readFile(saved.file, 'utf8')), installationId: saved.facts.installationId }, null, 2), { mode: 0o600 }); await chmod(own, 0o600); }
      else if (saved.file !== own) { await writeFile(own, await readFile(saved.file, 'utf8'), { mode: 0o600 }); await chmod(own, 0o600); }
      deps.log(`Reusing the GitHub App ${saved.facts.slug} (app ${saved.facts.appId}) from ${saved.file}; no browser step`);
      if (record.github && record.github.appId !== saved.facts.appId) deps.log(`GitHub App changed from ${record.github.appId} to ${saved.facts.appId}`);
      return { ...saved.facts, reused: true };
    } catch (error: any) {
      if (session.inputs.githubAppFile) throw new Error(`The GitHub App saved in ${saved.file} cannot authenticate to ${session.inputs.repository}: ${error.message}`);
      deps.log(`The GitHub App saved in ${saved.file} cannot authenticate (${error.message}); registering one in the browser instead`);
    }
  }
  if (!deps.githubApp) throw new Error('No GitHub App flow is available in this environment');
  const facts = await deps.githubApp({ root: session.root, repository: session.inputs.repository, origin: url, file: appCredentialFile(session), reuse: pageReuse(session, 'control-plane', url) });
  if (record.github && record.github.appId !== facts.appId) session.deps.log(`GitHub App changed from ${record.github.appId} to ${facts.appId}`);
  return facts;
}

/**
 * `--reuse-app` on apply (GY-1442): the repository is added to the App's installation, the App is
 * shown to reach it, and its registration is saved as this install's own, so a rerun reuses it.
 */
async function adoptApp(session: InstallSession, slug: string, role: AppRole, url: string): Promise<AppFacts & { slug: string; botUserId?: number }> {
  const reuse = await reuseApp(session, slug, role, role === 'control-plane' ? webhookUrlFor(url) : null, true);
  const own = role === 'revert-approver' ? resolve(session.directory, REVERT_APPROVER_FILE) : appCredentialFile(session, role === 'reviewer' ? session.inputs.reviewer : undefined);
  await writeFile(own, JSON.stringify({ ...reuse.app, ...(role === 'reviewer' ? { reviewer: session.inputs.reviewer } : {}) }, null, 2), { mode: 0o600 }); await chmod(own, 0o600);
  session.deps.log(`Reusing the ${role} App ${reuse.app.slug} (app ${reuse.app.appId}) from ${reuse.file}: ${reuse.added ? `added ${session.inputs.repository} to its installation ${reuse.app.installationId}` : `its installation ${reuse.app.installationId} covers every repository on ${reuse.account}`}; no browser step`);
  return { appId: reuse.app.appId, slug: reuse.app.slug, installationId: reuse.app.installationId, privateKey: reuse.app.privateKey, webhookSecret: reuse.app.webhookSecret ?? '', ...(reuse.app.botUserId ? { botUserId: reuse.app.botUserId } : {}) };
}

async function registerProfiles(session: InstallSession, url: string, appPending = false): Promise<ProfileRegistration> {
  const { context, deps } = session;
  const runtimes = await (deps.detectRuntimes ?? detectRuntimes)(context.transport);
  const herdr = session.inputs.herdr === 'skip' ? { available: false, version: null, reason: '--no-herdr: Herdr was left untouched' } : await (deps.detectHerdr ?? detectHerdr)(context.transport);
  const workerIds = workerPrincipals(session.principals).map(principal => principal.id);
  const workers = workerProfiles(session.installId, workerIds, runtimes, principal => tokenFile(session.directory, principal));
  const reviewers = reviewerProfiles(runtimes, session.inputs.reviewer ?? null);
  const master = masterRuntime(runtimes);
  const request: ProfileRequest = {
    root: session.root, url, cliPath: deps.cliPath ?? fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url)),
    hostId: deps.hostId ?? hostname(), installDirectory: session.directory,
    coordinatorToken: session.tokens.get(principalOfRole(session.principals, 'coordinator').id)!,
    workerTokens: workerIds.map(principal => ({ principal, token: session.tokens.get(principal)! })),
    runtimes, herdr, workers, reviewers, masterKind: master?.kind ?? null,
    herdrRebind: session.inputs.herdr === 'rebind', appPending,
    ...(deps.runHerdr ? { runHerdr: deps.runHerdr } : {}),
  };
  if (deps.registerProfiles) return deps.registerProfiles(request);
  const { registerLocalProfiles } = await import('./profiles.js');
  return registerLocalProfiles(request);
}

function nextSteps(session: InstallSession, url: string, mergeCheckExists: boolean, webhook: WebhookProof, profiles: ProfileRegistration) {
  const host = session.context.host;
  const steps = [
    host ? 'Open the signIn link once to sign in to the dashboard as the admin; it works a single time, then use Agents → Connect an account for each runtime.'
      : `Open ${url} and sign in with the credential in ${tokenFile(session.directory, principalOfRole(session.principals, 'admin').id)}.`,
    'Create the first work item: write it like examples/work.json and run "graphyard master create FILE"; the supervised master loop dispatches, reviews and merges it (docs/setup-from-zero.md step 12).',
  ];
  if (!session.reviewers.length && !session.inputs.reviewer) steps.push(`No reviewer App is registered, so no independent review can pass: rerun with --reviewer NAME (docs/setup-from-zero.md step 5).`);
  if (!mergeCheckExists) steps.push(`Rerun "graphyard install --provider ${session.context.provider} --repo ${session.inputs.repository} --apply" after Graphyard publishes "${CHECK_NAME}" on the first pull request, so branch protection can require the App-bound check.`);
  if (!webhook.delivered && !webhook.skipped) steps.push(`Webhook delivery is unconfirmed: ${webhook.detail}`);
  if (host) steps.push(`Everything runs on the host as the ${host.layout.user} account; nobody logs into it. Accounts start unconnected until connected from the dashboard.`);
  else if (!profiles.workers.length) steps.push('No authenticated agent runtime was found on this machine; sign in to a supported runtime and rerun --apply, or add a worker profile with "graphyard master worker add".');
  if (!session.principals.some(principal => principal.role === 'producer')) steps.push('No proof producer was created. Add one with --producer-proof NAME for each proof that CI may submit; a producer must never be given to an implementation worker.');
  steps.push('Never copy an admin, coordinator, or producer credential into a worker session.');
  return steps;
}
