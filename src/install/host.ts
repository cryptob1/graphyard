import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { composeBundle, composeRunning, emptyObservation, hetznerAddress, httpHealth, markersFromEnvFile, readRemote, type AdapterContext, type AdapterObservation, type BundleFile, type ProviderAdapter } from './adapters.js';
import { fingerprint, generateToken, workerPrincipals } from './secrets.js';
import { shellQuote, type Transport } from './transport.js';
import { REDACTED, type EnvValue, type PlanAction, type PlannedPrincipal, type PreflightItem } from './types.js';
import { packageVersion } from '../release.js';
import { proposedConcurrency, proposedRuntimes } from '../model/registry-proposal.js';
import type { AgentRegistry, FleetAccountInput, FleetModel, FleetRole, FleetRoleName, FleetRuntime } from '../model/registry.js';
import type { ProfileRegistration } from './index.js';

/**
 * The self-contained Graphyard host (GY-717).
 *
 * One machine runs everything: Postgres and the server (the release image, built on the host when
 * the registry does not have it, as system units, so they come back after a reboot with nobody
 * logged in), and — under one dedicated `graphyard` account
 * with lingering enabled — Herdr, the master loop, the executors and every agent runtime. Sessions no
 * longer compete with the operator's own processes, and the dashboard reaches Herdr on the same
 * machine, so the session viewer needs no relay.
 *
 * Every credential Graphyard generates lives on the host under the account's
 * `~/.config/graphyard/<install>/` (directory 0700, files 0600): the principal tokens, the database
 * password, and one login home per agent account. The operator's machine keeps only the install
 * record (fingerprints, never values). The cloud provisioning token is used by the installer on the
 * operator's machine and never reaches the host. Agent accounts are connected from the dashboard
 * (Settings › Agents › Connect an account, GY-409): a pasted API key is sealed in the browser to the
 * host's own key and opened only by the host's executor; a subscription runs the runtime's own login
 * there and the dashboard shows its URL and code — the operator never logs into the machine. The
 * executors create each connected account's login home under `<install>/accounts`, because the
 * graphyard user manager carries GRAPHYARD_AGENT_ENVIRONMENTS pointing there.
 */

export const HOST_USER = 'graphyard';
export const HOST_HOME = `/home/${HOST_USER}`;
export const GRAPHYARD_SOURCE = 'https://github.com/cryptob1/graphyard.git';
/** The database port published on the host's loopback only, for `graphyard db restore` during a migration. */
export const HOST_DATABASE_PORT = 5432;
/** The variable holding the SHA-256 of the one-time dashboard sign-in claim; the claim itself is printed once and never stored. */
export const SIGNIN_CLAIM_VARIABLE = 'GRAPHYARD_SIGNIN_CLAIM';
/** The old database a `--migrate` reads, from the environment only: a connection string carries a password. */
export const MIGRATE_SOURCE_VARIABLE = 'GRAPHYARD_MIGRATE_DATABASE_URL';

export interface HostLayout {
  user: string; home: string;
  /** ~graphyard/.config/graphyard/<install>: every credential on the host. */
  configDirectory: string; tokensDirectory: string; accountsDirectory: string; migrationDirectory: string; profilesDirectory: string;
  /** <install>/github: the App key and the credential helper workers push and open pull requests with. */
  githubDirectory: string;
  /** The Compose bundle (server.env, db.env, compose.yaml, Caddyfile) the system units run. */
  workdir: string;
  /** Postgres data: the attached volume on Hetzner, /var/lib/graphyard/<install> on an existing machine. */
  dataPath: string;
  /** The Graphyard checkout the loop and executors run from, and its CLI. */
  graphyard: string; cli: string;
  /** The managed repository's checkout: the loop's working directory, where worktrees are made. */
  checkout: string;
  systemUnitDirectory: string; userUnitDirectory: string;
  herdr: string;
}

export function hostLayout(installId: string, workdir: string, dataPath: string): HostLayout {
  const configDirectory = `${HOST_HOME}/.config/graphyard/${installId}`;
  return {
    user: HOST_USER, home: HOST_HOME, configDirectory,
    tokensDirectory: `${configDirectory}/tokens`, accountsDirectory: `${configDirectory}/accounts`,
    migrationDirectory: `${configDirectory}/migration`, profilesDirectory: `${configDirectory}/profiles`,
    githubDirectory: `${configDirectory}/github`,
    workdir, dataPath,
    graphyard: `${HOST_HOME}/graphyard`, cli: `${HOST_HOME}/graphyard/bin/graphyard.mjs`,
    checkout: `${HOST_HOME}/code/${installId}`,
    systemUnitDirectory: '/etc/systemd/system', userUnitDirectory: `${HOST_HOME}/.config/systemd/user`,
    herdr: `${HOST_HOME}/.local/bin/herdr`,
  };
}

export const hostTokenFile = (layout: HostLayout, principal: string) => `${layout.tokensDirectory}/${principal}.token`;
/**
 * The graphyard user manager's environment: GRAPHYARD_AGENT_ENVIRONMENTS puts every login home the
 * executors create for a dashboard connect under `<install>/accounts`, and GRAPHYARD_CONFIG_HOME
 * keeps the credentials `master init` and the reviewer setup write inside `<install>/` too.
 */
export const hostEnvironmentFile = (layout: HostLayout) => `${layout.home}/.config/environment.d/graphyard.conf`;
export const hostEnvironment = (layout: HostLayout) => ({ GRAPHYARD_AGENT_ENVIRONMENTS: layout.accountsDirectory, GRAPHYARD_CONFIG_HOME: layout.configDirectory });
export const hostDatabasePasswordFile = (layout: HostLayout) => `${layout.configDirectory}/database.password`;

// ---------------------------------------------------------------------------
// Agent runtimes and how each account is connected from the dashboard
// ---------------------------------------------------------------------------

/**
 * How the dashboard connects an account: a provider of GY-409's Settings › Agents connect flow, by
 * its id there. `api-key` is pasted once, sealed in the browser to the host's public key, relayed as
 * ciphertext and opened by the host's executor only; `login` runs the runtime's own sign-in on the
 * host and shows its URL and device or one-time code in the dashboard. `file` is where, inside the
 * account's login home, the host writes the credential (mode 0600).
 */
export interface HostConnection { provider: string; label: string; method: 'api-key' | 'login'; file: string; dashboard: string }
export interface HostRuntime { kind: 'claude' | 'codex' | 'opencode' | 'pi'; program: string; package: string; connections: HostConnection[] }

export const CONNECT_PATH = 'Settings › Agents › Connect an account';
const connection = (provider: string, label: string, method: HostConnection['method'], file: string): HostConnection => ({ provider, label, method, file, dashboard: `${CONNECT_PATH} › ${label}` });
const zai = connection('z.ai', 'z.ai (GLM coding plan)', 'api-key', 'opencode/auth.json');
const piZai = connection('pi-zai', 'Pi (z.ai key)', 'api-key', 'auth.json');

/** Each connection is a provider of the connect flow (src/fleet.ts connectProviders) for the same runtime, writing the file named here. */
export const hostRuntimes: readonly HostRuntime[] = [
  { kind: 'claude', program: 'claude', package: '@anthropic-ai/claude-code', connections: [connection('claude', 'Claude (subscription)', 'login', '.credentials.json'), connection('anthropic-api', 'Anthropic API', 'api-key', 'settings.json')] },
  { kind: 'codex', program: 'codex', package: '@openai/codex', connections: [connection('chatgpt', 'ChatGPT / Codex (subscription)', 'login', 'auth.json'), connection('openai-api', 'OpenAI API', 'api-key', 'auth.json')] },
  { kind: 'opencode', program: 'opencode', package: 'opencode-ai', connections: [zai] },
  { kind: 'pi', program: 'pi', package: '@mariozechner/pi-coding-agent', connections: [piZai] },
];

const contractFor = (kind: string): FleetRuntime => {
  const runtime = proposedRuntimes.find(entry => entry.name === kind);
  if (!runtime) throw new Error(`No launch contract is proposed for ${kind}`);
  return structuredClone(runtime) as FleetRuntime;
};

export interface HostAccount {
  name: string; runtime: string;
  /** The account's login home on the host, handed to the runtime through its home variable. */
  home: string; homeVariable: string;
  /** Where the runtime keeps this account's credential once connected: mode 0600, inside the install's config directory. */
  credentialFile: string;
  connections: HostConnection[];
  /** The account was already in the installation's registry and moves onto this host. */
  moved: boolean;
}

/**
 * The first account of each runtime a fresh installation connects: `claude-a`, `codex-a`,
 * `opencode-a` — the name and login home the host's executor gives the first connect of that runtime
 * under `<install>/accounts` — and `pi-a`, the PI_CODING_AGENT_DIR of the first Pi (z.ai key) connect.
 */
export const defaultAccountName = (kind: string) => `${kind}-a`;

/**
 * The accounts the host holds: every registry account of a runtime the host installs, moved to a
 * login home here, or — for a registry with none — one account per runtime.
 */
export function hostAccounts(layout: HostLayout, registry: Pick<AgentRegistry, 'accounts'> | null): HostAccount[] {
  const existing = (registry?.accounts ?? []).filter(account => hostRuntimes.some(runtime => runtime.kind === account.runtime));
  const entries = existing.length ? existing.map(account => ({ name: account.name, runtime: account.runtime, moved: true }))
    : hostRuntimes.map(runtime => ({ name: defaultAccountName(runtime.kind), runtime: runtime.kind, moved: false }));
  return entries.map(entry => {
    const runtime = hostRuntimes.find(candidate => candidate.kind === entry.runtime)!;
    const contract = contractFor(runtime.kind).launch;
    const home = `${layout.accountsDirectory}/${entry.name}`;
    return { ...entry, home, homeVariable: contract.homeVariable!, credentialFile: `${home}/${contract.loginFile}`, connections: runtime.connections };
  });
}

/**
 * The registry change that places the accounts on this host: runtimes and models the registry lacks,
 * every account at its new login home, and — for a registry with no roles yet — the proposed roles.
 * Pi is proposed for the approver and producer roles only, as everywhere else (GY-169).
 */
export function hostRegistryChange(current: Pick<AgentRegistry, 'runtimes' | 'models' | 'accounts' | 'roles'>, accounts: (HostAccount & { login?: HostLogin })[], host: string, workers: number) {
  const kinds = [...new Set(accounts.map(account => account.runtime))];
  const runtimes = kinds.filter(kind => !current.runtimes.some(runtime => runtime.name === kind)).map(contractFor);
  const models: FleetModel[] = [];
  const modelFor = (account: HostAccount) => current.accounts.find(entry => entry.name === account.name)?.model ?? `${account.runtime}-default`;
  for (const account of accounts) {
    const name = modelFor(account);
    if (!current.models.some(model => model.name === name) && !models.some(model => model.name === name)) models.push({ name, id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } } as FleetModel);
  }
  const placed: FleetAccountInput[] = accounts.map(account => {
    const before = current.accounts.find(entry => entry.name === account.name);
    // A moved account whose login could not come along stays registered (its history and roles
    // keep their name) but is disabled until it is connected again from the dashboard.
    const reconnect = account.login === 'connect';
    const note = reconnect ? `Moved to ${host}; its login was not on the installing machine — connect it again in ${CONNECT_PATH}` : before?.note;
    return { name: account.name, runtime: account.runtime, model: modelFor(account), credential: { host, home: account.home }, enabled: reconnect ? false : before?.enabled ?? true, maxSessions: before?.maxSessions ?? null, ...(note ? { note: note.slice(0, 500) } : {}) };
  });
  const narrow: Partial<Record<string, readonly FleetRoleName[]>> = { pi: ['approver', 'producer'] };
  const roles: FleetRole[] = current.roles.length ? [] : (['worker', 'reviewer', 'producer', 'approver', 'escalation-handler'] as FleetRoleName[]).map(role => ({
    name: role,
    accounts: accounts.filter(account => !narrow[account.runtime] || narrow[account.runtime]!.includes(role)).map(account => account.name),
    concurrency: role === 'worker' ? Math.max(1, workers) : proposedConcurrency[role],
  })).filter(role => role.accounts.length);
  return { runtimes, models, accounts: placed, roles, reason: `graphyard install: place the agent accounts on the self-contained host ${host}` };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export interface HostUnit { name: string; scope: 'system' | 'user'; path: string; role: string }

const templateDirectory = fileURLToPath(new URL('../../deploy/systemd/', import.meta.url));
const template = (name: string) => readFileSync(`${templateDirectory}${name}`, 'utf8');

/** The packaged units (deploy/systemd/), rendered for this install. */
export function hostUnitFiles(installId: string, layout: HostLayout, owner: string): (BundleFile & HostUnit)[] {
  const render = (name: string) => template(name).replaceAll('@WORKDIR@', layout.workdir).replaceAll('@INSTALL@', installId).replaceAll('@USER@', layout.user).replaceAll('@HERDR@', layout.herdr);
  return [
    ...(['graphyard-postgres.service', 'graphyard-server.service', 'graphyard-proxy.service'] as const).map(name => ({ name, scope: 'system' as const, path: `${layout.systemUnitDirectory}/${name}`, content: render(name), mode: 0o644, role: name.replace(/^graphyard-|\.service$/g, '') })),
    { name: 'graphyard-herdr.service', scope: 'user', path: `${layout.userUnitDirectory}/graphyard-herdr.service`, content: render('graphyard-herdr.service'), mode: 0o644, owner, role: 'herdr' },
  ];
}

/** The loop and executor units: written by `master init` and `graphyard-executor.mjs --install` on the host, from the same templates as a workstation (GY-114, GY-105). */
export function supervisedUnits(layout: HostLayout, executors: number): HostUnit[] {
  return [
    { name: 'graphyard-master.service', scope: 'user', path: `${layout.userUnitDirectory}/graphyard-master.service`, role: 'master loop' },
    ...Array.from({ length: executors }, (_, index) => ({ name: `graphyard-executor@${index + 1}.service`, scope: 'user' as const, path: `${layout.userUnitDirectory}/graphyard-executor@.service`, role: `executor slot ${index + 1}` })),
  ];
}

// ---------------------------------------------------------------------------
// Settings and secrets
// ---------------------------------------------------------------------------

export interface HostSettings {
  layout: HostLayout;
  /** `--local`: the installer runs on the host itself. */
  local: boolean;
  workers: number;
  executors: number;
  migrate: boolean;
  /** The old database URL (GRAPHYARD_MIGRATE_DATABASE_URL); registered with the vault, never printed. */
  migrationSource: string | null;
  /** The same map as the install session's: every principal credential, generated in memory and written only to the host. */
  tokens: Map<string, string>;
  principals: PlannedPrincipal[];
  /** The one-time dashboard sign-in claim for this apply; null in a plan. */
  claim: string | null;
  /** Why an earlier apply's credentials on the host could not be read back; apply refuses to generate new ones while it is set. */
  secretsUnreadable?: string | null;
  /** `UID:GID` of the graphyard account, resolved on the host once it exists. */
  owner: string | null;
  /** Where the loop, executors and restore run the Graphyard CLI from: this installer's own commit. */
  ref: string;
  /** Where the installer's own CLI is, for the migration's backup on this machine. */
  localCli: string;
  localNode: string;
  /** The operator machine's install directory, for the migration's backup file. */
  localDirectory: string;
  /** This machine's executor host id: a moved account whose login home is here brings its login along. */
  localHost: string;
}

/** How a moved account's login reached the host: copied from this machine, or to be connected again from the dashboard. */
export type HostLogin = 'copied' | 'connect';

export const claimHash = (claim: string) => createHash('sha256').update(claim).digest('hex');
export const newClaim = () => randomBytes(24).toString('base64url');

/** The host's own transport: the machine itself with --local, SSH otherwise. */
export async function hostRemote(ctx: AdapterContext): Promise<Transport> {
  if (ctx.provider === 'hetzner') return ctx.ssh(await hetznerAddress(ctx), ctx.sshUser);
  if (ctx.host?.local) return ctx.transport;
  if (!ctx.sshHost) throw new Error('--target host needs --ssh-host HOST (or --local on the host itself)');
  return ctx.ssh(ctx.sshHost, ctx.sshUser);
}

/**
 * Reads the credentials an earlier apply wrote on the host, so a re-apply never rotates them. A host
 * not created yet yields none, and so does a file the host says does not exist; apply generates
 * those after the preflight gate. Any other outcome — a failed SSH exec, a refused read, a file that
 * holds no credential — is `unreadable`: apply then refuses to generate anything, since a fresh
 * database password would lock the server out of the Postgres an earlier apply initialised.
 */
export async function readHostSecrets(ctx: AdapterContext, principals: PlannedPrincipal[]) {
  const tokens = new Map<string, string>();
  const layout = ctx.host!.layout;
  let remote: Transport;
  try { remote = await hostRemote(ctx); } catch { return { tokens, databasePassword: '', unreadable: null }; }
  const unreadable: string[] = [];
  const read = async (path: string) => {
    let result: { stdout: string; stderr: string; code: number };
    try { result = await remote.exec('cat', [path], { allowFailure: true, timeout: 60_000 }); }
    catch (error) { unreadable.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); return ''; }
    if (result.code !== 0) {
      if (!/No such file/i.test(result.stderr)) unreadable.push(`${path}: exit ${result.code} ${result.stderr.trim()}`.trim());
      return '';
    }
    const value = result.stdout.trim();
    if (value.length >= 32 && !/\s/.test(value)) return value;
    unreadable.push(`${path}: holds no credential`);
    return '';
  };
  for (const principal of principals) { const token = await read(hostTokenFile(layout, principal.id)); if (token) tokens.set(principal.id, ctx.vault.add(token)); }
  const databasePassword = await read(hostDatabasePasswordFile(layout));
  if (!databasePassword) {
    const postgresDir = `${layout.dataPath}/postgres`;
    const check = await remote.exec('test', ['-f', `${postgresDir}/PG_VERSION`], { allowFailure: true, timeout: 60_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    if (check.code === 0) unreadable.push(`${hostDatabasePasswordFile(layout)}: missing on a host with existing Postgres data at ${postgresDir}`);
  }
  // Paths only: a failed read's stderr never carries the file's content, and the vault scrubs what it knows.
  return { tokens, databasePassword: databasePassword ? ctx.vault.add(databasePassword) : '', unreadable: unreadable.length ? ctx.vault.scrub(unreadable.join('; ')) : null };
}

/** Generates what the host is missing, in memory; the host setEnv writes it there with mode 0600. */
export function generateHostSecrets(ctx: AdapterContext) {
  const host = ctx.host!;
  if (host.secretsUnreadable) throw new Error(`The host's existing credentials could not be read, so none is generated (a new database password would lock the server out of its Postgres): ${host.secretsUnreadable}. Fix the host's reachability or the file and apply again.`);
  for (const principal of host.principals) if (!host.tokens.has(principal.id)) host.tokens.set(principal.id, ctx.vault.add(generateToken()));
  if (!ctx.databasePassword) ctx.databasePassword = ctx.vault.add(randomBytes(24).toString('base64url'));
  host.claim = newClaim();
}

// ---------------------------------------------------------------------------
// Running things on the host
// ---------------------------------------------------------------------------

/** As the graphyard account, with its user manager's bus, from `cwd`. */
export function asUser(remote: Transport, cwd: string, program: string, args: string[], options: { input?: string; allowFailure?: boolean; timeout?: number } = {}) {
  const script = `export HOME=${shellQuote(HOST_HOME)} XDG_RUNTIME_DIR=/run/user/$(id -u) PATH="${HOST_HOME}/.local/bin:$PATH"; cd "$0" && exec "$@"`;
  return remote.exec('runuser', ['-u', HOST_USER, '--', 'sh', '-c', script, cwd, program, ...args], { timeout: 900_000, ...options });
}

/**
 * Idempotent machine preparation, run as root: Docker, Node 24, git, gh and bubblewrap (with the
 * unprivileged user namespaces it needs, checked by running it) when missing, the graphyard
 * account with lingering (so its user units run without a login), and the private directories.
 */
export function bootstrapScript(layout: HostLayout) {
  const q = shellQuote;
  return [
    'set -eu',
    'command -v curl >/dev/null || (apt-get update && apt-get install -y curl ca-certificates)',
    'command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh)',
    'systemctl enable --now docker',
    `node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null || (curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs)`,
    'command -v git >/dev/null || apt-get install -y git',
    // Workers open their pull requests with gh; the host's wrapper (hostGithubFiles) authenticates it.
    'command -v gh >/dev/null || (apt-get update && apt-get install -y gh)',
    // Worktree dependency installs and non-Actions unit proofs run under bubblewrap, which refuses
    // without it; Ubuntu 24.04 also restricts the unprivileged user namespaces it needs by default.
    'command -v bwrap >/dev/null || apt-get install -y bubblewrap',
    `if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then echo 'kernel.apparmor_restrict_unprivileged_userns=0' > /etc/sysctl.d/60-graphyard-bwrap.conf && sysctl -q -w kernel.apparmor_restrict_unprivileged_userns=0; fi`,
    'bwrap --unshare-user --ro-bind / / true',
    `id -u ${HOST_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${HOST_USER}`,
    `loginctl enable-linger ${HOST_USER}`,
    `install -d -m 0700 -o ${HOST_USER} -g ${HOST_USER} ${[`${HOST_HOME}/.config`, `${HOST_HOME}/.config/environment.d`, `${HOST_HOME}/.config/graphyard`, layout.configDirectory, layout.tokensDirectory, layout.accountsDirectory, layout.migrationDirectory, layout.profilesDirectory, layout.githubDirectory, layout.userUnitDirectory, `${HOST_HOME}/code`].map(q).join(' ')}`,
    `install -d -m 0755 ${q(layout.workdir)} ${q(`${layout.dataPath}/postgres`)}`,
  ].join('\n');
}

async function resolveOwner(ctx: AdapterContext, remote: Transport) {
  const host = ctx.host!;
  if (host.owner) return host.owner;
  const id = async (flag: string) => (await remote.exec('id', [flag, HOST_USER], { allowFailure: true, timeout: 60_000 })).stdout.trim();
  const [uid, gid] = [await id('-u'), await id('-g')];
  host.owner = /^\d+$/.test(uid) && /^\d+$/.test(gid) ? `${uid}:${gid}` : `${HOST_USER}:${HOST_USER}`;
  return host.owner;
}

/** Every file a host setEnv writes: the Compose bundle, the units, and the credentials (0600, owned by graphyard). */
export function hostFiles(ctx: AdapterContext, values: EnvValue[], owner: string): BundleFile[] {
  const host = ctx.host!;
  const layout = host.layout;
  const environment = [...values, ...(host.claim ? [{ name: SIGNIN_CLAIM_VARIABLE, value: claimHash(host.claim), secret: false }] : [])];
  return [
    ...composeBundle(ctx, environment, 'proxy', { databasePort: HOST_DATABASE_PORT }),
    ...hostUnitFiles(ctx.installId, layout, owner),
    { path: hostEnvironmentFile(layout), content: `${Object.entries(hostEnvironment(layout)).map(([name, value]) => `${name}=${value}`).join('\n')}\n`, mode: 0o644, owner },
    ...host.principals.map(principal => ({ path: hostTokenFile(layout, principal.id), content: `${host.tokens.get(principal.id) ?? ''}\n`, mode: 0o600, owner })),
    { path: hostDatabasePasswordFile(layout), content: `${ctx.databasePassword}\n`, mode: 0o600, owner },
  ];
}

// ---------------------------------------------------------------------------
// Migration: moving an existing installation onto the host
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The workers' GitHub credential
// ---------------------------------------------------------------------------

/** The Graphyard App the host's workers push and open pull requests as. */
export interface HostGithubApp { appId: number; installationId: number; slug: string; botUserId?: number; privateKey: string }

const credentialHelperSource = fileURLToPath(new URL('../../deploy/host/graphyard-github-credential.mjs', import.meta.url));
export const hostGithubKeyFile = (layout: HostLayout) => `${layout.githubDirectory}/app-private-key.pem`;
export const hostCredentialHelper = (layout: HostLayout) => `${layout.githubDirectory}/graphyard-github-credential.mjs`;
/** The gh every account on the host runs first on its PATH; it execs the packaged gh. */
export const HOST_GH_WRAPPER = '/usr/local/bin/gh';

/** A gh that sets GH_TOKEN from the credential helper when the caller can read it and has none of its own. */
export function ghWrapper(helper: string, gh = '/usr/bin/gh') {
  return [
    '#!/bin/sh',
    '# Graphyard self-contained host (GY-717): gh authenticated with a one-hour App installation token.',
    `if [ -z "\${GH_TOKEN:-}" ] && [ -r ${shellQuote(helper)} ]; then`,
    `  GH_TOKEN="$(node ${shellQuote(helper)} token)" || exit 1`,
    '  export GH_TOKEN',
    'fi',
    `exec ${shellQuote(gh)} "$@"`,
    '',
  ].join('\n');
}

/**
 * What gives the graphyard account a GitHub credential with nobody logging into the host: the App
 * key and its facts (0600, in <install>/github), the helper that mints narrowed one-hour
 * installation tokens from them, and the gh wrapper. git is pointed at the helper by
 * `hostGitConfig`, so a worker's `git push` and `gh pr create` both work on a fresh host.
 */
export function hostGithubFiles(layout: HostLayout, repository: string, app: HostGithubApp, owner: string): BundleFile[] {
  return [
    { path: `${layout.githubDirectory}/app.json`, content: `${JSON.stringify({ appId: app.appId, installationId: app.installationId, repository }, null, 2)}\n`, mode: 0o600, owner },
    { path: hostGithubKeyFile(layout), content: app.privateKey.endsWith('\n') ? app.privateKey : `${app.privateKey}\n`, mode: 0o600, owner },
    { path: hostCredentialHelper(layout), content: readFileSync(credentialHelperSource, 'utf8'), mode: 0o600, owner },
    { path: HOST_GH_WRAPPER, content: ghWrapper(hostCredentialHelper(layout)), mode: 0o755 },
  ];
}

/** The graphyard account's global git settings: the credential helper for github.com, and the App's bot as the commit identity. */
export function hostGitConfig(layout: HostLayout, app: Pick<HostGithubApp, 'slug' | 'botUserId'>): [string, string][] {
  const bot = `${app.slug}[bot]`;
  return [
    ['credential.https://github.com.helper', `!node ${hostCredentialHelper(layout)}`],
    ['user.name', bot],
    ['user.email', `${app.botUserId ? `${app.botUserId}+` : ''}${bot}@users.noreply.github.com`],
  ];
}

export const migrationSteps = [
  { id: 'migrate.freeze', title: 'Stop the old master loop and its executors on this machine' },
  { id: 'migrate.fence', title: `Fence the old database named by ${MIGRATE_SOURCE_VARIABLE} (graphyard db fence): new sessions are read-only and every open one is ended, so the old server, its webhooks and any session still running against it can no longer write after the backup` },
  { id: 'migrate.backup', title: `Take a verified logical backup of the old database named by ${MIGRATE_SOURCE_VARIABLE} (graphyard db backup, then db verify)` },
  { id: 'migrate.copy', title: 'Copy the backup to the host (mode 0600, graphyard account)' },
  { id: 'migrate.restore', title: 'Restore it into the host Postgres before the server starts (graphyard db restore)' },
  { id: 'migrate.cutover', title: 'Start the server on the restored ledger with credentials generated on the host: the old coordinator token is not among them, so the old loop is refused every lease' },
  { id: 'migrate.reregister', title: 'Re-register executors (they register on start) and move every registry account onto the host, with its login when it is on this machine' },
] as const;

const restoredMarker = (layout: HostLayout) => `${layout.migrationDirectory}/restored`;

async function freezeOldLoop(ctx: AdapterContext) {
  const local = ctx.transport;
  // Stop the old server first to prevent new writes via webhooks and API calls after the backup.
  await local.exec('systemctl', ['stop', 'graphyard-server.service'], { allowFailure: true, timeout: 180_000 });
  await local.exec('systemctl', ['--user', 'disable', '--now', 'graphyard-master.service'], { allowFailure: true, timeout: 180_000 });
  await local.exec('systemctl', ['--user', 'stop', 'graphyard-executor@*.service'], { allowFailure: true, timeout: 900_000 });
  const state = await local.exec('systemctl', ['--user', 'is-active', 'graphyard-master.service'], { allowFailure: true, timeout: 60_000 });
  if (state.stdout.trim() === 'active') throw new Error('The old master loop is still running on this machine after systemctl --user disable --now graphyard-master.service; stop it, then rerun graphyard install --migrate --apply');
}

/** Backup (verified) on this machine, restore on the host; runs once, before the server starts. */
async function migrateLedger(ctx: AdapterContext, remote: Transport) {
  const host = ctx.host!;
  const layout = host.layout;
  if ((await remote.exec('test', ['-f', restoredMarker(layout)], { allowFailure: true, timeout: 60_000 })).code === 0) return;
  const source = host.migrationSource;
  if (!source) throw new Error(`--migrate needs the old database in ${MIGRATE_SOURCE_VARIABLE}`);
  await freezeOldLoop(ctx);
  const local = ctx.transport;
  const migration = `${host.localDirectory}/migration`;
  const file = `${migration}/backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await local.exec('mkdir', ['-p', '-m', '0700', migration], { timeout: 60_000 });
  // The connection string reaches `db fence` and `db backup` on standard input, never as an argument.
  const withDatabase = (command: string) => `DATABASE_URL="$(cat)"; export DATABASE_URL; exec "$0" "$1" ${command} "$2"`;
  // Every old writer is fenced before the snapshot, wherever it runs: the old server keeps serving
  // reads (and errors on writes) until its operator retires it, and nothing it accepts is lost.
  const fence = (release: boolean) => local.exec('sh', ['-c', `DATABASE_URL="$(cat)"; export DATABASE_URL; exec "$0" "$1" db fence${release ? ' --release' : ''}`, host.localNode, host.localCli], { input: source, timeout: 300_000 });
  await fence(false);
  let backup: string;
  try {
    await local.exec('sh', ['-c', withDatabase('db backup'), host.localNode, host.localCli, file], { input: source, timeout: 1_800_000 });
    await local.exec('sh', ['-c', withDatabase('db verify'), host.localNode, host.localCli, file], { input: source, timeout: 600_000 });
    // Read the file from this machine's disk rather than through a command's output buffer: a grown
    // ledger exceeds the transport's exec cap, while db verify and db restore already hold the whole
    // file in memory, so the copy to the host can too.
    backup = await readFile(file, 'utf8');
    const target = `${layout.migrationDirectory}/backup.json`;
    await remote.putFile(target, backup, 0o600, host.owner ?? undefined);
    const hostDatabase = `postgres://graphyard:${ctx.databasePassword}@127.0.0.1:${HOST_DATABASE_PORT}/graphyard`;
    await asUser(remote, layout.graphyard, 'sh', ['-c', `DATABASE_URL="$(cat)"; export DATABASE_URL; exec node "$0" db restore "$1"`, layout.cli, target], { input: hostDatabase, timeout: 1_800_000 });
  } catch (error) {
    // Nothing has cut over yet: lift the fence so a failed migration leaves the old installation
    // writable (its loop restarts with systemctl --user enable --now graphyard-master.service).
    await fence(true).catch(() => undefined);
    throw error;
  }
  let digest = '';
  try { digest = String(JSON.parse(backup)?.digest ?? ''); } catch { digest = ''; }
  await remote.putFile(restoredMarker(layout), `${JSON.stringify({ restoredAt: new Date().toISOString(), digest })}\n`, 0o600, host.owner ?? undefined);
}

/** The confinement workerConfinementRefusal requires of an opencode worker: no edits outside its worktree. */
export const OPENCODE_WORKER_PERMISSION = '{"edit":"allow","bash":"allow","webfetch":"allow","external_directory":"deny"}';

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

async function unitStates(remote: Transport, names: string[]) {
  const result = await remote.exec('systemctl', ['is-active', ...names], { allowFailure: true, timeout: 60_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
  const lines = result.stdout.split('\n');
  return Object.fromEntries(names.map((name, index) => [name, (lines[index] ?? '').trim() || 'unknown']));
}

const publicUrl = (ctx: AdapterContext, address: string) => ctx.domain ? `https://${ctx.domain}` : `https://${address}`;

/** An existing Linux machine: reached as root over SSH (or --local), prepared by the bootstrap script. */
export const existingMachineAdapter: ProviderAdapter = {
  provider: 'host',
  async preflight(ctx) {
    const items: PreflightItem[] = [];
    if (!ctx.host?.local) items.push({ name: 'SSH target', ok: !!ctx.sshHost, detail: ctx.sshHost ? `${ctx.sshUser}@${ctx.sshHost}` : 'no target selected', fix: 'Pass --ssh-host HOST, or --local when this installer runs on the host itself' });
    items.push({ name: 'Public hostname', ok: true, detail: ctx.domain ?? 'no domain selected; Caddy will issue an internal certificate', ...(ctx.domain ? {} : { fix: `Pass --domain graphyard.example.com and point its A record at ${ctx.sshHost ?? 'this host'}` }) });
    if (!ctx.host?.local && !ctx.sshHost) return items;
    const remote = await hostRemote(ctx);
    const whoami = await remote.exec('id', ['-u'], { allowFailure: true, timeout: 60_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    items.push(whoami.code === 0 && whoami.stdout.trim() === '0'
      ? { name: 'Host access', ok: true, detail: `root on ${remote.description}` }
      : { name: 'Host access', ok: false, detail: whoami.code === 0 ? `connected as uid ${whoami.stdout.trim()}, but preparing the machine (packages, the graphyard account, system units) needs root` : `could not run a command on ${remote.description}`, fix: 'Connect as root (--ssh-user root, the default) with key-based SSH' });
    const systemd = await remote.exec('systemctl', ['--version'], { allowFailure: true, timeout: 60_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    items.push(systemd.code === 0 ? { name: 'systemd', ok: true, detail: systemd.stdout.trim().split('\n')[0] ?? 'available' } : { name: 'systemd', ok: false, detail: 'systemctl is not available; the host target supervises everything with systemd', fix: 'Use a Linux distribution with systemd (Ubuntu 24.04 is tested)' });
    return items;
  },
  async observe(ctx) {
    const observation = emptyObservation();
    let remote: Transport;
    try { remote = await hostRemote(ctx); } catch { return observation; }
    observation.compute = true;
    const environment = await readRemote(remote, `${ctx.workdir}/server.env`);
    if (environment === null) return observation;
    observation.installed = true;
    observation.variables = markersFromEnvFile(environment);
    const state = await composeRunning(remote, ctx);
    observation.database = state.database; observation.app = state.app;
    observation.url = state.app ? publicUrl(ctx, ctx.sshHost ?? 'localhost') : null;
    return observation;
  },
  plan() { return []; },
  async provision() { /* the machine exists; the self-contained layer prepares it */ },
  async setEnv() { throw new Error('The host target writes its bundle through the self-contained adapter'); },
  async deploy() { throw new Error('The host target deploys through the self-contained adapter'); },
  async url(ctx) { return publicUrl(ctx, ctx.sshHost ?? 'localhost'); },
  health: httpHealth,
  async logs() { return ''; },
};

/** What the plan shows about the host: every unit, runtime, credential path and dashboard connection. */
export interface HostPlan {
  user: string;
  configDirectory: string;
  checkout: string;
  units: HostUnit[];
  runtimes: { kind: string; program: string; package: string }[];
  credentials: { path: string; mode: '0600'; holds: string }[];
  accounts: HostAccount[];
  herdr: { unit: string; binary: string; workspace: string };
  sessionViewer: 'local';
  migration: { id: string; title: string }[] | null;
}

export function hostPlan(ctx: AdapterContext): HostPlan {
  const host = ctx.host!;
  const layout = host.layout;
  const accounts = hostAccounts(layout, null);
  return {
    user: layout.user, configDirectory: layout.configDirectory, checkout: layout.checkout,
    units: [...hostUnitFiles(ctx.installId, layout, `${HOST_USER}:${HOST_USER}`).map(({ name, scope, path, role }) => ({ name, scope, path, role })), ...supervisedUnits(layout, host.executors)],
    runtimes: hostRuntimes.map(runtime => ({ kind: runtime.kind, program: runtime.program, package: runtime.package })),
    credentials: [
      ...host.principals.map(principal => ({ path: hostTokenFile(layout, principal.id), mode: '0600' as const, holds: `${principal.role} credential of ${principal.id}` })),
      { path: hostDatabasePasswordFile(layout), mode: '0600', holds: 'the Postgres password' },
      { path: hostGithubKeyFile(layout), mode: '0600', holds: 'the GitHub App key workers\' one-hour push and pull request tokens are minted from' },
      ...accounts.map(account => ({ path: account.credentialFile, mode: '0600' as const, holds: `the ${account.runtime} login of account ${account.name}, written when it is connected from the dashboard` })),
    ],
    accounts,
    herdr: { unit: 'graphyard-herdr.service', binary: layout.herdr, workspace: `graphyard-${ctx.installId}` },
    sessionViewer: 'local',
    migration: host.migrate ? migrationSteps.map(step => ({ ...step })) : null,
  };
}

function hostActions(ctx: AdapterContext, observation: AdapterObservation): PlanAction[] {
  const plan = hostPlan(ctx);
  const host = ctx.host!;
  const state = observation.installed ? 'update' as const : 'create' as const;
  const actions: PlanAction[] = [
    { id: 'host.bootstrap', target: 'host', state, title: `Prepare the machine: Docker, Node 24, git, gh and bubblewrap when missing, the ${HOST_USER} account with lingering, and ${plan.configDirectory} (mode 0700)`, command: 'sh -c <bootstrap script>' },
    { id: 'host.credentials', target: 'host', state, title: `Write every Graphyard credential on the host only, mode 0600, owned by ${HOST_USER}; the provisioning token never leaves this machine`, values: plan.credentials.map(entry => ({ name: entry.path, value: REDACTED, secret: true, note: entry.holds })) },
    { id: 'host.graphyard', target: 'host', state, title: `Check out Graphyard at ${host.ref} in ${host.layout.graphyard} for the loop, the executors and restores`, command: `git clone ${GRAPHYARD_SOURCE} ${host.layout.graphyard}` },
    { id: 'host.image', target: 'host', state, title: `Pull the server image ${ctx.image}; when the registry does not have it, build it on the host from ${host.layout.graphyard} at ${host.ref}`, command: `docker image inspect ${ctx.image} || docker build --tag ${ctx.image} ${host.layout.graphyard}` },
    ...plan.units.filter(unit => unit.scope === 'system').map(unit => ({ id: `host.unit.${unit.role}`, target: 'host' as const, state, title: `Supervise ${unit.role} with the system unit ${unit.path} (Restart=always, starts at boot)`, command: `systemctl enable --now ${unit.name}` })),
    ...(host.migrate ? migrationSteps.map(step => ({ id: step.id, target: 'host' as const, state: 'create' as const, title: step.title })) : []),
    { id: 'host.runtimes', target: 'host', state, title: `Install the agent runtimes: ${plan.runtimes.map(runtime => `${runtime.kind} (${runtime.package})`).join(', ')}`, command: `npm install -g ${plan.runtimes.map(runtime => runtime.package).join(' ')}` },
    { id: 'host.herdr', target: 'host', state, title: `Install Herdr for ${HOST_USER}, supervise its server with the user unit ${host.layout.userUnitDirectory}/graphyard-herdr.service, and create the workspace ${plan.herdr.workspace}` },
    { id: 'host.checkout', target: 'host', state, title: `Clone ${ctx.repository} into ${plan.checkout}, the loop's working directory, with a one-hour GitHub App installation token passed on standard input (never stored)` },
    { id: 'host.github', target: 'host', state, title: `Give workers a GitHub credential without anyone logging in: git's credential helper and the gh wrapper (${HOST_GH_WRAPPER}) mint one-hour App installation tokens narrowed to ${ctx.repository} (Contents and Pull requests write) from ${hostGithubKeyFile(host.layout)}; commits are made as the App's bot` },
    { id: 'host.environment', target: 'host', state, title: `Point the ${HOST_USER} user manager at ${host.layout.accountsDirectory} for login homes and ${host.layout.configDirectory} for credentials (${hostEnvironmentFile(host.layout)})` },
    { id: 'host.master', target: 'host', state, title: `Configure the master loop with the coordinator credential (master init --token-stdin) and supervise it as ${host.layout.userUnitDirectory}/graphyard-master.service` },
    { id: 'host.executors', target: 'host', state, title: `Supervise ${host.executors} executor slot(s) as graphyard-executor@N.service user units; the resident executor registers the host's connect key and serves every dashboard connect` },
    ...(host.migrate
      ? [{ id: 'host.accounts', target: 'host' as const, state, title: `Move every registry account of an installed runtime onto this host at ${host.layout.accountsDirectory}/<account> (mode 0700), copying its login (0600) when it is on this machine; any other is disabled until connected again in ${CONNECT_PATH}` }]
      : [{ id: 'host.accounts', target: 'host' as const, state, title: `Create ${host.layout.accountsDirectory} (mode 0700): each account connected from the dashboard gets its login home there (${plan.accounts.map(account => account.home).join(', ')} first) and is registered in the agent registry when its smoke prompt passes` }]),
    ...hostRuntimes.map(runtime => ({ id: `dashboard.connect.${runtime.kind}`, target: 'graphyard' as const, state: 'create' as const,
      title: `Connect ${runtime.kind} in ${CONNECT_PATH}: ${runtime.connections.map(entry => `${entry.label} (${entry.method === 'api-key' ? 'paste the key once; the browser seals it to the host, the server keeps only ciphertext and never returns it' : 'the host runs the provider\'s own sign-in and the dashboard shows its URL and code'}; the host writes ${entry.file}, mode 0600)`).join('; ')}`,
      human: 'Connected in the dashboard after install; nobody logs into the host.' })),
    { id: 'host.session-viewer', target: 'host', state: 'satisfied', title: 'Session viewer: Herdr runs on the same machine as the dashboard, so sessions are reached locally and no relay is provisioned' },
    { id: 'host.signin', target: 'graphyard', state: 'create', title: 'Print one single-use dashboard sign-in link for the admin; only its SHA-256 is stored on the host' },
  ];
  return actions;
}

export interface HostFleetRequest {
  url: string; adminToken: string; coordinatorToken: string; reviewer: string | null;
  /** A one-hour GitHub App installation token for cloning the managed repository; used on standard input, never stored. */
  cloneToken: string;
  /** The Graphyard App, whose key the host keeps (0600) so workers can push and open pull requests. */
  github: HostGithubApp;
  fetch: typeof fetch; log: (line: string) => void;
}

export interface HostFleetResult {
  host: string;
  units: (HostUnit & { active: string })[];
  runtimes: { kind: string; path: string | null }[];
  accounts: (HostAccount & { login: HostLogin | null })[];
  herdrWorkspace: string | null;
  sessionViewer: 'local';
  profiles: ProfileRegistration;
}

/** The last lines of a failed host command, with every known secret cut out. */
const failure = (ctx: AdapterContext, result: { stdout: string; stderr: string }) => ctx.vault.scrub((result.stderr || result.stdout).trim().split('\n').slice(-3).join(' '));

/**
 * A moved account's login, brought along when its home is on this machine: only the runtime's own
 * login file (never the rest of the home), read here and written on the host at mode 0600.
 */
async function copyLogin(ctx: AdapterContext, remote: Transport, account: HostAccount, source: { host: string; home: string | null } | undefined, owner: string): Promise<HostLogin> {
  const host = ctx.host!;
  const file = account.credentialFile.slice(account.home.length + 1);
  if (!source?.home || source.host !== host.localHost) return 'connect';
  const read = await ctx.transport.exec('cat', [`${source.home}/${file}`], { allowFailure: true, timeout: 60_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
  if (read.code !== 0 || !read.stdout.trim()) return 'connect';
  ctx.vault.add(read.stdout.trim());
  const directory = account.credentialFile.slice(0, account.credentialFile.lastIndexOf('/'));
  if (directory !== account.home) await remote.exec('install', ['-d', '-m', '0700', '-o', HOST_USER, '-g', HOST_USER, directory], { timeout: 60_000 });
  await remote.putFile(account.credentialFile, read.stdout, 0o600, owner);
  return 'copied';
}

/**
 * Everything after the server is healthy and GitHub is connected: runtimes, Herdr, the managed
 * checkout, the loop and executors, account homes, and the registry placing each account here.
 */
export async function installHostFleet(ctx: AdapterContext, request: HostFleetRequest): Promise<HostFleetResult> {
  const host = ctx.host!;
  const layout = host.layout;
  const remote = await hostRemote(ctx);
  const owner = await resolveOwner(ctx, remote);
  const hostName = (await remote.exec('hostname', [], { allowFailure: true, timeout: 60_000 })).stdout.trim() || ctx.sshHost || ctx.service;

  await remote.exec('npm', ['install', '-g', ...hostRuntimes.map(runtime => runtime.package)], { timeout: 1_800_000 });
  const runtimes: HostFleetResult['runtimes'] = [];
  for (const runtime of hostRuntimes) {
    const located = await remote.exec('sh', ['-c', `command -v ${runtime.program}`], { allowFailure: true, timeout: 60_000 });
    runtimes.push({ kind: runtime.kind, path: located.code === 0 ? located.stdout.trim().split('\n')[0] || null : null });
  }

  await asUser(remote, HOST_HOME, 'sh', ['-c', `[ -x ${shellQuote(layout.herdr)} ] || curl -fsSL https://herdr.dev/install.sh | sh`]);
  await asUser(remote, HOST_HOME, 'systemctl', ['--user', 'daemon-reload']);
  await asUser(remote, HOST_HOME, 'systemctl', ['--user', 'enable', '--now', 'graphyard-herdr.service']);

  // Workers push and open pull requests as the App: its key and the token helper go to <install>/github
  // (0600), gh is wrapped to take its token from the helper, and git is pointed at the helper.
  ctx.vault.add(request.github.privateKey);
  for (const file of hostGithubFiles(layout, ctx.repository, request.github, owner)) await remote.putFile(file.path, file.content, file.mode, file.owner);
  for (const [name, value] of hostGitConfig(layout, request.github)) await asUser(remote, HOST_HOME, 'git', ['config', '--global', name, value]);

  // A private repository needs a credential the graphyard account does not hold: the App's
  // installation token arrives on standard input and reaches git through a one-shot credential
  // helper, so it is never an argument, never in the remote URL and never written to disk.
  const clone = `[ -d "$1/.git" ] || { GIT_TOKEN="$(cat)"; export GIT_TOKEN; git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f' clone --quiet "$2" "$1"; }`;
  const cloned = await asUser(remote, HOST_HOME, 'sh', ['-c', clone, 'managed-checkout', layout.checkout, `https://github.com/${ctx.repository}.git`], { input: request.cloneToken, allowFailure: true });
  if (cloned.code !== 0) throw new Error(`Cloning ${ctx.repository} into ${layout.checkout} on ${hostName} failed: ${failure(ctx, cloned)}`);

  const label = `graphyard-${ctx.installId}`;
  const workspaceIn = (text: string) => {
    try {
      const parsed = JSON.parse(text); const result = parsed?.result ?? parsed;
      const listed = Array.isArray(result?.workspaces) ? result.workspaces.find((entry: any) => entry?.label === label) : result?.workspace ?? result;
      return typeof listed?.workspace_id === 'string' ? listed.workspace_id : null;
    } catch { return null; }
  };
  let herdrWorkspace = workspaceIn((await asUser(remote, HOST_HOME, layout.herdr, ['workspace', 'list'], { allowFailure: true })).stdout);
  if (!herdrWorkspace) herdrWorkspace = workspaceIn((await asUser(remote, HOST_HOME, layout.herdr, ['workspace', 'create', '--cwd', layout.checkout, '--label', label], { allowFailure: true })).stdout);

  // The user manager's environment: login homes under <install>/accounts, credentials under <install>/.
  const environment = Object.entries(hostEnvironment(layout)).map(([name, value]) => `${name}=${value}`);
  await asUser(remote, HOST_HOME, 'systemctl', ['--user', 'set-environment', ...environment]);
  await remote.exec('install', ['-d', '-m', '0700', '-o', HOST_USER, '-g', HOST_USER, layout.accountsDirectory], { timeout: 60_000 });

  // The installation's registry decides the accounts: the ones it already has move here, with their
  // login when it is on this machine. A fresh installation registers none: each account joins the
  // registry when it is connected from the dashboard and its smoke prompt passes (GY-409).
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await request.fetch(`${request.url}${path}`, { ...init, headers: { Authorization: `Bearer ${request.adminToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${response.status}`);
    return response.json() as Promise<any>;
  };
  const current: AgentRegistry = await api('/api/agent-registry/document');
  const moved = current.accounts.some(account => hostRuntimes.some(runtime => runtime.kind === account.runtime));
  const accounts: HostFleetResult['accounts'] = [];
  for (const account of hostAccounts(layout, current)) {
    if (!account.moved) { accounts.push({ ...account, login: null }); continue; }
    await remote.exec('install', ['-d', '-m', '0700', '-o', HOST_USER, '-g', HOST_USER, account.home], { timeout: 60_000 });
    const before = current.accounts.find(entry => entry.name === account.name)?.credential;
    accounts.push({ ...account, login: await copyLogin(ctx, remote, account, before ? { host: before.host, home: before.home ?? null } : undefined, owner) });
  }
  if (moved) {
    const change = hostRegistryChange(current, accounts.map(account => ({ ...account, login: account.login ?? undefined })), hostName, host.workers);
    await api('/api/agent-registry/apply', { method: 'POST', body: JSON.stringify(change), headers: { 'Idempotency-Key': `install-host-${fingerprint(JSON.stringify(change))}` } });
  }

  // The loop: master init writes .graphyard/master.json and the supervised user unit (GY-114), and
  // keeps its copy of the coordinator credential inside <install>/ (GRAPHYARD_CONFIG_HOME). A loop
  // that cannot be set up fails the install rather than reporting success.
  const masterInit = await asUser(remote, layout.checkout, 'env', [...environment, 'node', layout.cli, 'master', 'init', '--url', request.url, '--token-stdin', '--host-id', hostName, '--cli-path', layout.cli, ...(herdrWorkspace ? ['--herdr-workspace', herdrWorkspace] : [])], { input: request.coordinatorToken, allowFailure: true });
  if (masterInit.code !== 0) throw new Error(`master init did not complete on ${hostName}: ${failure(ctx, masterInit)}`);
  await asUser(remote, layout.checkout, 'systemctl', ['--user', 'enable', '--now', 'graphyard-master.service']);
  const executors = await asUser(remote, layout.checkout, 'env', [...environment, 'node', `${layout.graphyard}/scripts/graphyard-executor.mjs`, '--install', '--count', String(host.executors)], { allowFailure: true });
  if (executors.code !== 0) throw new Error(`Installing ${host.executors} executor unit(s) on ${hostName} failed: ${failure(ctx, executors)}`);

  // One worker profile per worker principal, each with its own credential file on the host.
  const workers: ProfileRegistration['workers'] = [];
  const launchable = hostRuntimes.filter(runtime => runtime.kind !== 'pi');
  for (const [index, principal] of workerPrincipals(host.principals).entries()) {
    const runtime = launchable[index % launchable.length];
    const profile = { name: `${runtime.kind}-${index + 1}`, principal: principal.id, agentName: `${ctx.installId}-${runtime.kind}-${index + 1}`, mode: 'launch', kind: runtime.kind, credentialFile: hostTokenFile(layout, principal.id), agentArgs: [], environment: runtime.kind === 'opencode' ? { OPENCODE_PERMISSION: OPENCODE_WORKER_PERMISSION } : {} };
    const file = `${layout.profilesDirectory}/${profile.name}.json`;
    await remote.putFile(file, `${JSON.stringify(profile, null, 2)}\n`, 0o600, owner);
    const added = await asUser(remote, layout.checkout, 'node', [layout.cli, 'master', 'worker', 'add', file], { allowFailure: true });
    if (added.code === 0 || /already/i.test(`${added.stderr}${added.stdout}`)) workers.push({ name: profile.name, principal: principal.id, kind: runtime.kind });
  }

  const system = hostUnitFiles(ctx.installId, layout, owner).filter(unit => unit.scope === 'system');
  const systemStates = await unitStates(remote, system.map(unit => unit.name));
  const userUnits = [{ name: 'graphyard-herdr.service', scope: 'user' as const, path: `${layout.userUnitDirectory}/graphyard-herdr.service`, role: 'herdr' }, ...supervisedUnits(layout, host.executors)];
  const userState = await asUser(remote, HOST_HOME, 'systemctl', ['--user', 'is-active', ...userUnits.map(unit => unit.name)], { allowFailure: true });
  const userLines = userState.stdout.split('\n');
  const units = [
    ...system.map(({ name, scope, path, role }) => ({ name, scope, path, role, active: systemStates[name] })),
    ...userUnits.map((unit, index) => ({ ...unit, active: (userLines[index] ?? '').trim() || 'unknown' })),
  ];
  return {
    host: hostName, units, runtimes, accounts, herdrWorkspace, sessionViewer: 'local',
    profiles: {
      repository: { connected: true, herdr: !!herdrWorkspace, detail: herdrWorkspace ? `Herdr workspace ${herdrWorkspace} on ${hostName}` : 'Herdr is installed but no workspace could be created' },
      master: { configured: true, kind: null, detail: `the loop runs as graphyard-master.service on ${hostName}` },
      workers, reviewers: [],
    },
  };
}

/**
 * The server image must exist on the host before its unit starts. When the registry has no such
 * image (the release was never published, or the pull is denied), the host builds it from its own
 * Graphyard checkout, which provision placed at the installer's commit, so one command still ends
 * in a running server.
 */
export async function ensureServerImage(ctx: AdapterContext, remote: Transport) {
  const present = await remote.exec('docker', ['image', 'inspect', '--format', '{{.Id}}', ctx.image], { allowFailure: true, timeout: 120_000 });
  if (present.code === 0) return 'pulled' as const;
  const source = ctx.host!.layout.graphyard;
  const built = await remote.exec('docker', ['build', '--build-arg', `GRAPHYARD_VERSION=${packageVersion}`, '--build-arg', `GRAPHYARD_BUILD_REVISION=${ctx.host!.ref}`, '--tag', ctx.image, source], { allowFailure: true, timeout: 1_800_000 });
  if (built.code !== 0) throw new Error(`The server image ${ctx.image} could not be pulled, and building it from ${source} at ${ctx.host!.ref} failed: ${failure(ctx, built)}`);
  return 'built' as const;
}

/**
 * Wraps a provider adapter that yields a machine (the Hetzner one, or an existing machine) with the
 * self-contained layer: bootstrap, the bundle and credentials written on the host, system units in
 * place of `docker compose up`, and a migrated ledger restored before the server first starts.
 */
export function selfContainedAdapter(base: ProviderAdapter): ProviderAdapter & { installFleet: typeof installHostFleet } {
  return {
    ...base,
    async preflight(ctx) {
      const items = await base.preflight(ctx);
      if (ctx.host?.migrate) items.push(ctx.host.migrationSource
        ? { name: 'Migration source', ok: true, detail: `${MIGRATE_SOURCE_VARIABLE} is set; the old database is backed up and restored onto the host` }
        : { name: 'Migration source', ok: false, detail: `--migrate reads the old database from ${MIGRATE_SOURCE_VARIABLE}, which is not set`, fix: `Export ${MIGRATE_SOURCE_VARIABLE} with the old installation's DATABASE_URL (it is read from the environment only), then rerun` });
      return items;
    },
    plan(ctx, observation) { return [...base.plan(ctx, observation), ...hostActions(ctx, observation)]; },
    async provision(ctx, observation) {
      await base.provision(ctx, observation);
      const remote = await hostRemote(ctx);
      await remote.exec('sh', ['-c', bootstrapScript(ctx.host!.layout)], { timeout: 1_800_000 });
      await resolveOwner(ctx, remote);
      const layout = ctx.host!.layout;
      await asUser(remote, HOST_HOME, 'sh', ['-c', `[ -d "$1/.git" ] || git clone ${shellQuote(GRAPHYARD_SOURCE)} "$1"; cd "$1" && git fetch --quiet origin && git checkout --quiet "$2" && npm ci --no-audit --no-fund`, 'graphyard-checkout', layout.graphyard, ctx.host!.ref]);
    },
    async setEnv(ctx, values) {
      const remote = await hostRemote(ctx);
      const owner = await resolveOwner(ctx, remote);
      for (const file of hostFiles(ctx, values, owner)) {
        // Every file bound for the host passes the vault's check first, except the ones that exist to hold a credential.
        if (!file.path.startsWith(ctx.host!.layout.configDirectory) && !/\/(server|db)\.env$|github-private-key\.pem$/.test(file.path)) ctx.vault.assertClean(file.content, file.path);
        await remote.putFile(file.path, file.content, file.mode, file.owner);
      }
    },
    async deploy(ctx) {
      const remote = await hostRemote(ctx);
      await remote.exec('systemctl', ['daemon-reload'], { timeout: 120_000 });
      await remote.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'pull', '--quiet'], { allowFailure: true, timeout: 900_000 });
      await ensureServerImage(ctx, remote);
      await remote.exec('systemctl', ['enable', '--now', 'graphyard-postgres.service'], { timeout: 300_000 });
      for (let attempt = 0; attempt < 60; attempt++) {
        const ready = await remote.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'exec', '-T', 'db', 'pg_isready', '-U', 'graphyard'], { allowFailure: true, timeout: 60_000 });
        if (ready.code === 0) break;
        await ctx.wait(2_000);
      }
      if (ctx.host!.migrate) await migrateLedger(ctx, remote);
      await remote.exec('systemctl', ['enable', 'graphyard-server.service', 'graphyard-proxy.service'], { timeout: 120_000 });
      // A restart picks up a rewritten environment; on a first deploy it simply starts them.
      await remote.exec('systemctl', ['restart', 'graphyard-server.service', 'graphyard-proxy.service'], { timeout: 300_000 });
    },
    async logs(ctx, lines = 100) {
      const result = await (await hostRemote(ctx)).exec('journalctl', ['-u', 'graphyard-server.service', '-n', String(lines), '--no-pager'], { allowFailure: true, timeout: 120_000 });
      return ctx.vault.scrub(result.stdout || result.stderr);
    },
    installFleet: installHostFleet,
  };
}

