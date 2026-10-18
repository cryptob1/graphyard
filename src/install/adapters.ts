import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { fingerprint, Vault } from './secrets.js';
import { SERVER_CONTAINER_UID, shellQuote, type Transport } from './transport.js';
import { SERVER_PORT, type EnvValue, type PlanAction, type PreflightItem, type Provider } from './types.js';
import { checkoutRelease, cliRelease, defaultImageFor } from '../release.js';
import { hetznerQuote, spendConsent, type PriceQuote, type QuoteResult } from './pricing.js';
import { localAdapter } from './local.js';
import { buildIdentity, cliCommit } from '../protocol-version.js';

/**
 * The release image an install defaults to: the image the promotion published under the CLI's own
 * date version (.github/workflows/release-candidate.yml), or the `stable` channel from an unreleased checkout.
 */
export const DEFAULT_IMAGE = defaultImageFor(cliRelease());

export interface AdapterContext {
  provider: Provider;
  repository: string;
  installId: string;
  service: string;
  domain: string | null;
  image: string;
  workdir: string;
  sourceRoot: string;
  repoCheckout?: string | null;
  /** The common Git directory a linked-worktree checkout points at, mounted at its own host path so `/repo/.git` resolves inside the container (GY-1675). */
  repoGitDir?: string | null;
  sshHost: string | null;
  sshUser: string;
  /** Hetzner Cloud SSH key the created server is registered with; without one it is unreachable for key-only SSH. */
  sshKey: string | null;
  /** Railway workspace chosen with --workspace; null lets the installer resolve a single-workspace account. */
  workspace: string | null;
  serverType: string;
  /** False when no --server-type was given: a self-contained Hetzner host then takes the recommended type. */
  serverTypeExplicit: boolean;
  /** Concurrent agent sessions the machine is sized for: the workers plus one reviewer. */
  plannedAgents: number;
  location: string;
  databasePassword: string;
  /** The loopback port a Compose install publishes; its preflight moves it off a port another process holds (GY-1509). */
  port: number;
  /** The port was given with --port: preflight refuses it when taken instead of choosing another. */
  portExplicit?: boolean;
  /** Absolute path of an attached data disk; when set, Postgres stores its data there. */
  dataPath: string | null;
  /**
   * The Graphyard-owned directory the Railway CLI links, creates, and deploys from. Every
   * link-resolving railway command runs with this as its working directory, so an unrelated
   * `railway init` someone ran inside the managed checkout is never mistaken for the
   * Graphyard project, and `railway up` can never upload the managed repository's tree.
   */
  railwayDir: string;
  /** The self-contained host settings (GY-717); null for a server-only install. */
  host: import('./host.js').HostSettings | null;
  /** The local provider's cluster, unit and supervisor (GY-1500); absent for every other provider. */
  local?: import('./local.js').LocalSettings | null;
  /** `install --observe-only` (GY-1846): observation runs no provider command that prints variable values. */
  observeOnly?: boolean;
  /** The managed repository's checkout; a Railway upload under --observe-only refuses a source that is it. Defaults to the process cwd. */
  managedRoot?: string | null;
  /** The commit a Railway upload stamps as GRAPHYARD_BUILD_SHA (GY-1864); read from the source checkout, else GRAPHYARD_BUILD_SHA, when absent. */
  sourceCommit?: string | null;
  /**
   * App bind (GY-1908): Railway `applyVariables` must redeploy the serving SUCCESS deployment, not a
   * newer failed attempt (`railway redeploy` always targets latest), and must wait for that redeploy
   * to become SUCCESS before the bind records the App or changes the webhook.
   */
  preserveServingDeployment?: boolean;
  /** Spend consent for a server this install creates: a monthly cap, or the exact price confirmed. */
  spend: { maxMonthly: number | null; confirmPrice: number | null };
  wait: (ms: number) => Promise<void>;
  transport: Transport;
  ssh: (host: string, user?: string) => Transport;
  fetch: typeof fetch;
  vault: Vault;
}

export interface AdapterObservation {
  installed: boolean;
  /** The provider-side container of the deployment exists: the Railway project, the Hetzner server. */
  compute: boolean;
  database: boolean;
  app: boolean;
  url: string | null;
  /** Variable name to a comparable, never-secret marker: plain value, or `sha:<fingerprint>`. */
  variables: Record<string, string>;
  /** The variable listing was read in full: `variables` is the deployment's, not empty for want of a read (GY-1416). */
  variablesObserved?: boolean;
  detail: string[];
}

/** The single provider interface: everything the installer needs to reach a healthy server. */
export interface ProviderAdapter {
  provider: Provider;
  preflight(ctx: AdapterContext): Promise<PreflightItem[]>;
  observe(ctx: AdapterContext): Promise<AdapterObservation>;
  plan(ctx: AdapterContext, observation: AdapterObservation): PlanAction[];
  provision(ctx: AdapterContext, observation: AdapterObservation): Promise<void>;
  setEnv(ctx: AdapterContext, values: EnvValue[]): Promise<void>;
  /**
   * Sets only `values` on the running deployment, keeping every other variable, and redeploys it
   * (GY-1416 `master setup --apply`); with none, it only redeploys. Absent on an adapter whose
   * `setEnv` rewrites the whole environment (a Compose bundle): there `install --apply` applies it.
   */
  applyVariables?(ctx: AdapterContext, values: EnvValue[]): Promise<void>;
  deploy(ctx: AdapterContext): Promise<void>;
  url(ctx: AdapterContext): Promise<string>;
  health(ctx: AdapterContext, url: string): Promise<boolean>;
  logs(ctx: AdapterContext, lines?: number): Promise<string>;
}

export const emptyObservation = (): AdapterObservation => ({ installed: false, compute: false, database: false, app: false, url: null, variables: {}, detail: [] });

export async function httpHealth(ctx: AdapterContext, url: string) {
  try {
    const response = await ctx.fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return false;
    return (await response.json() as any)?.ok === true;
  } catch { return false; }
}

async function tool(ctx: AdapterContext, transport: Transport, program: string, args: string[], name: string, fix: string): Promise<PreflightItem> {
  const result = await transport.exec(program, args, { allowFailure: true, timeout: 60_000 });
  return result.code === 0
    ? { name, ok: true, detail: ctx.vault.scrub(result.stdout.trim().split('\n')[0] ?? 'available') }
    : { name, ok: false, detail: `${program} is missing or not authenticated`, fix };
}

// ---------------------------------------------------------------------------
// Shared Compose bundle: identical application topology on every self-hosted target.
// ---------------------------------------------------------------------------

export interface BundleFile { path: string; content: string; mode: number; /** The `UID:GID` the transport gives the file, so the container user can read it. */ owner?: string }

/** The GitHub private key is multi-line, and an env file cannot carry it: these move it into a mounted file. */
export const PRIVATE_KEY_FILE_VARIABLE = 'GITHUB_PRIVATE_KEY_FILE';
export const PRIVATE_KEY_CONTAINER_PATH = '/run/graphyard/github-private-key.pem';
const PRIVATE_KEY_BUNDLE_NAME = 'github-private-key.pem';
/** The main guard's revert approver App key (GY-1352), mounted the same way as the control-plane App's. */
export const REVERT_APPROVER_KEY_CONTAINER_PATH = '/run/graphyard/revert-approver-private-key.pem';
const mountedKeys = [
  { variable: 'GITHUB_PRIVATE_KEY', file: PRIVATE_KEY_FILE_VARIABLE, bundle: PRIVATE_KEY_BUNDLE_NAME, container: PRIVATE_KEY_CONTAINER_PATH },
  { variable: 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY', file: 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY_FILE', bundle: 'revert-approver-private-key.pem', container: REVERT_APPROVER_KEY_CONTAINER_PATH },
];

/**
 * `databasePort` publishes Postgres on the host's loopback only: a self-contained host restores a
 * migrated ledger into it with `graphyard db restore` before the server starts (GY-717).
 */
/**
 * The name the proxy serves and Caddy certifies. Without --domain a public IPv4 address is named
 * under sslip.io (1.2.3.4 -> 1-2-3-4.sslip.io), which resolves publicly to that address, so Caddy
 * still obtains a publicly trusted certificate and GitHub's webhook delivery (insecure_ssl 0) and
 * the installer's health check both verify it. A DNS name is served as it is.
 */
export function publicHostname(ctx: Pick<AdapterContext, 'domain'>, address: string) {
  if (ctx.domain) return ctx.domain;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address) ? `${address.replace(/\./g, '-')}.sslip.io` : address;
}

/** True when no publicly trusted certificate can be issued for this address without a domain: loopback, private or link-local. */
export function unroutableAddress(address: string | null | undefined) {
  if (!address || address === 'localhost') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
  if (!octets) return !address.includes('.');
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function composeBundle(ctx: AdapterContext, values: EnvValue[], publish: 'loopback' | 'proxy', options: { databasePort?: number; hostname?: string } = {}): BundleFile[] {
  // `GITHUB_PRIVATE_KEY` is a PEM that spans many lines, and docker compose reads an env file
  // as one `NAME=value` per line: every continuation line of a raw key would be refused as a
  // malformed variable name and the deploy would fail. The key is therefore written to its own
  // file, mounted into the server container read-only, and referenced through
  // `GITHUB_PRIVATE_KEY_FILE`, which the server reads natively; the revert approver's key likewise.
  const keys = mountedKeys.flatMap(mount => { const value = values.find(entry => entry.name === mount.variable && entry.value); return value ? [{ ...mount, value: value.value }] : []; });
  const environment = values
    .filter(value => !mountedKeys.some(mount => mount.variable === value.name))
    .map(value => {
      if (/[\r\n]/.test(value.value)) throw new Error(`${value.name} cannot be written to a Compose env file: its value spans multiple lines`);
      return `${value.name}=${value.value}`;
    });
  for (const key of keys) environment.push(`${key.file}=${key.container}`);
  const proxied = publish === 'proxy';
  const serverVolumes = [
    ...keys.map(key => `"./${key.bundle}:${key.container}:ro"`),
    ...(ctx.repoCheckout ? [`"${ctx.repoCheckout}:/repo"`] : []),
    ...(ctx.repoGitDir ? [`"${ctx.repoGitDir}:${ctx.repoGitDir}"`] : []),
  ];
  const files: BundleFile[] = [
    { path: `${ctx.workdir}/db.env`, mode: 0o600, content: `POSTGRES_USER=graphyard\nPOSTGRES_DB=graphyard\nPOSTGRES_PASSWORD=${ctx.databasePassword}\n` },
    { path: `${ctx.workdir}/server.env`, mode: 0o600, content: `${environment.join('\n')}\n` },
    { path: `${ctx.workdir}/compose.yaml`, mode: 0o644, content: `name: graphyard-${ctx.installId}
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    env_file: [db.env]
    volumes: ["${ctx.dataPath ? `${ctx.dataPath}/postgres` : 'graphyard-data'}:/var/lib/postgresql/data"]
${options.databasePort ? `    ports: ["127.0.0.1:${options.databasePort}:5432"]\n` : ''}    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U graphyard"]
      interval: 5s
      timeout: 3s
      retries: 40
  server:
    image: ${ctx.image}
    restart: unless-stopped
    env_file: [server.env]
${serverVolumes.length ? `    volumes: [${serverVolumes.join(', ')}]\n` : ''}    depends_on:
      db: { condition: service_healthy }
${proxied ? '    expose: ["' + SERVER_PORT + '"]' : `    ports: ["127.0.0.1:${ctx.port}:${SERVER_PORT}"]`}
${proxied ? `  proxy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data", "caddy-config:/config"]
    depends_on: [server]
` : ''}volumes:
${ctx.dataPath ? '' : '  graphyard-data: {}\n'}${proxied ? '  caddy-data: {}\n  caddy-config: {}\n' : ''}` },
  ];
  for (const key of keys) {
    // A bind mount keeps the host file's owner and mode, so the key must land as 0600 owned
    // by the container user itself: root:root 0600 (the SSH transports write as root) or a
    // local installer with a different uid would leave it unreadable inside the container,
    // and the server would restart forever on EACCES. A transport that cannot chown refuses
    // the install instead of deploying a server that cannot start.
    files.push({ path: `${ctx.workdir}/${key.bundle}`, mode: 0o600, owner: `${SERVER_CONTAINER_UID}:${SERVER_CONTAINER_UID}`, content: key.value });
  }
  // Caddy always serves a public name it obtains a trusted certificate for: never an internal
  // certificate, which GitHub's webhook delivery and the health check would both reject.
  if (proxied) {
    const hostname = options.hostname ?? ctx.domain;
    if (!hostname) throw new Error('The proxy needs a public hostname: pass --domain HOST');
    files.push({ path: `${ctx.workdir}/Caddyfile`, mode: 0o644, content: `${hostname} {\n\treverse_proxy server:${SERVER_PORT}\n}\n` });
  }
  return files;
}

/**
 * Docker names a container's endpoint that outlived the container: a reinstall after the
 * containers and data volume were removed failed with `endpoint with name
 * graphyard-…-db-1 already exists in network graphyard-…_default` (GY-1840). Only an
 * endpoint in this project's own network is read, so another project's state is never touched.
 */
export function staleComposeEndpoints(message: string, project: string) {
  const endpoints = new Map<string, { network: string; endpoint: string }>();
  for (const match of message.matchAll(/endpoint with name (\S+?) already exists in network (\S+?)(?=[\s'":,]|$)/g)) {
    const [, endpoint, network] = match;
    if (network === `${project.toLowerCase()}_default`) endpoints.set(`${network}/${endpoint}`, { network, endpoint });
  }
  return [...endpoints.values()];
}

async function composeUp(ctx: AdapterContext, transport: Transport, pull: boolean) {
  if (pull) await transport.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'pull', '--quiet'], { allowFailure: true, timeout: 900_000 });
  const up = () => transport.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'up', '-d', '--remove-orphans'], { timeout: 900_000 });
  try { await up(); }
  catch (error) {
    // A stale endpoint is cleared and compose up retried once; every other failure, and a
    // second failure, is reported as compose gave it.
    const stale = staleComposeEndpoints(error instanceof Error ? error.message : String(error), `graphyard-${ctx.installId}`);
    if (!stale.length) throw error;
    for (const { network, endpoint } of stale) await transport.exec('docker', ['network', 'disconnect', '-f', network, endpoint], { allowFailure: true, timeout: 120_000 });
    await up();
  }
}

export async function composeRunning(transport: Transport, ctx: AdapterContext) {
  const result = await transport.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'ps', '--format', 'json'], { allowFailure: true, timeout: 120_000 });
  if (result.code !== 0) return { database: false, app: false };
  const rows = result.stdout.split('\n').map(line => line.trim()).filter(Boolean).flatMap(line => { try { const parsed = JSON.parse(line); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return []; } });
  const running = (service: string) => rows.some((row: any) => row.Service === service && /running|healthy/i.test(String(row.State ?? row.Status ?? '')));
  return { database: running('db'), app: running('server') };
}

export async function readRemote(transport: Transport, path: string) {
  const result = await transport.exec('cat', [path], { allowFailure: true, timeout: 60_000 });
  return result.code === 0 ? result.stdout : null;
}

/** Observed env values map through the same marker, so drift compares without reading secrets. */
export function markersFromEnvFile(content: string) {
  const markers: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0 || line.startsWith('#')) continue;
    const name = line.slice(0, index).trim(); const value = line.slice(index + 1);
    markers[name] = variableMarker(name, value);
  }
  return markers;
}

function composeActions(ctx: AdapterContext, observation: AdapterObservation, label: string): PlanAction[] {
  return [
    { id: 'provider.provision.database', target: 'provider', title: `Start Postgres 17 with a durable volume on ${label}`, state: observation.database ? 'satisfied' : 'create', command: `docker compose --project-directory ${ctx.workdir} up -d db` },
    { id: 'provider.provision.app', target: 'provider', title: `Start the Graphyard application container (${ctx.image}) on ${label}`, state: observation.app ? 'satisfied' : 'create', command: `docker compose --project-directory ${ctx.workdir} up -d server` },
  ];
}

// ---------------------------------------------------------------------------
// compose — one machine, loopback only
// ---------------------------------------------------------------------------

/** How many ports, from SERVER_PORT upward, a Compose install tries before its preflight gives up. */
export const PORT_CANDIDATES = 20;

/** Whether 127.0.0.1:PORT can be bound on the transport's machine: a listener opened and closed again. */
export async function loopbackPortFree(transport: Transport, port: number) {
  const probe = `require('net').createServer().once('error',()=>process.exit(1)).listen(${port},'127.0.0.1',function(){this.close()})`;
  return (await transport.exec(process.execPath, ['-e', probe], { allowFailure: true, timeout: 30_000 })).code === 0;
}

/** The loopback port an existing Compose bundle publishes the server on, or null. */
export const publishedPort = (bundle: string | null) => {
  const match = bundle && new RegExp(`127\\.0\\.0\\.1:(\\d+):${SERVER_PORT}`).exec(bundle);
  return match ? Number(match[1]) : null;
};

/**
 * GY-1509: the port a Compose install publishes must be free, or be this install's own running
 * server. A taken port the operator did not choose moves to the first free one from SERVER_PORT
 * upward (PORT_CANDIDATES tried); ctx.port then carries it to the bundle, the URL and the record.
 */
export async function composePort(ctx: AdapterContext): Promise<PreflightItem> {
  const name = 'Server port';
  // The bundle a previous apply wrote is this install's state too: a run whose record predates the
  // port keeps the one its server already publishes.
  const published = publishedPort(await readRemote(ctx.transport, `${ctx.workdir}/compose.yaml`));
  if (!ctx.portExplicit && published) ctx.port = published;
  if (published === ctx.port && (await composeRunning(ctx.transport, ctx)).app) return { name, ok: true, detail: `127.0.0.1:${ctx.port} serves this installation` };
  if (await loopbackPortFree(ctx.transport, ctx.port)) return { name, ok: true, detail: `127.0.0.1:${ctx.port} is free` };
  const taken = ctx.port;
  if (ctx.portExplicit) return { name, ok: false, detail: `127.0.0.1:${taken} is taken by another process`, fix: 'Rerun with a free --port N, or without --port to let the installer choose one' };
  for (let port = SERVER_PORT; port < SERVER_PORT + PORT_CANDIDATES; port++) {
    if (port === taken || !await loopbackPortFree(ctx.transport, port)) continue;
    ctx.port = port;
    return { name, ok: true, detail: `127.0.0.1:${taken} is taken by another process; this installation publishes 127.0.0.1:${port}` };
  }
  return { name, ok: false, detail: `127.0.0.1:${SERVER_PORT}-${SERVER_PORT + PORT_CANDIDATES - 1} are all taken`, fix: 'Free one of those ports, or rerun with a free --port N' };
}

/**
 * The stamp a locally built image carries: the source checkout's release and commit. Without it
 * the Dockerfile's `0.0.0-dev`/`unknown` defaults win and /healthz reports `unreleased unknown`,
 * as the upgrade gate's compose install did after `graphyard upgrade` rebuilt its image (GY-1977).
 */
export function imageBuildArgs(sourceRoot: string) {
  const release = checkoutRelease(sourceRoot, process.env.GRAPHYARD_BUILD_REVISION || 'unknown');
  return ['--build-arg', `GRAPHYARD_VERSION=${release.version}`, '--build-arg', `GRAPHYARD_BUILD_REVISION=${release.revision}`];
}

export const composeAdapter: ProviderAdapter = {
  provider: 'compose',
  async preflight(ctx) {
    const items = [
      await tool(ctx, ctx.transport, 'docker', ['version', '--format', '{{.Server.Version}}'], 'Docker Engine', 'Install Docker Engine and start its daemon, then rerun the installer'),
      await tool(ctx, ctx.transport, 'docker', ['compose', 'version', '--short'], 'Docker Compose', 'Install the Docker Compose plugin (docker compose version), then rerun the installer'),
    ];
    if (items.every(item => item.ok)) items.push(await composePort(ctx));
    return items;
  },
  async observe(ctx) {
    const observation = emptyObservation();
    const environment = await readRemote(ctx.transport, `${ctx.workdir}/server.env`);
    if (environment === null) return observation;
    observation.installed = true;
    observation.variables = markersFromEnvFile(environment); observation.variablesObserved = true;
    const state = await composeRunning(ctx.transport, ctx);
    observation.database = state.database; observation.app = state.app;
    observation.url = state.app ? `http://127.0.0.1:${ctx.port}` : null;
    return observation;
  },
  plan(ctx, observation) {
    return [
      { id: 'provider.image', target: 'provider', title: `Build the Graphyard image ${ctx.image} from ${ctx.sourceRoot}`, state: 'update', command: ['docker build', ...imageBuildArgs(ctx.sourceRoot).map(arg => /\s/.test(arg) ? shellQuote(arg) : arg), '--tag', ctx.image, ctx.sourceRoot].join(' ') },
      ...composeActions(ctx, observation, 'this machine'),
    ];
  },
  async provision(ctx) {
    await ctx.transport.exec('docker', ['build', ...imageBuildArgs(ctx.sourceRoot), '--tag', ctx.image, ctx.sourceRoot], { timeout: 1_800_000 });
  },
  async setEnv(ctx, values) {
    for (const file of composeBundle(ctx, values, 'loopback')) await ctx.transport.putFile(file.path, file.content, file.mode, file.owner);
  },
  async deploy(ctx) { await composeUp(ctx, ctx.transport, false); },
  async url(ctx) { return `http://127.0.0.1:${ctx.port}`; },
  health: httpHealth,
  async logs(ctx, lines = 100) {
    const result = await ctx.transport.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'logs', '--tail', String(lines), 'server'], { allowFailure: true, timeout: 120_000 });
    return ctx.vault.scrub(result.stdout || result.stderr);
  },
};

// ---------------------------------------------------------------------------
// docker-host — the same bundle on a remote machine over SSH
// ---------------------------------------------------------------------------

function requireHost(ctx: AdapterContext) {
  // The transport always connects as `${--ssh-user}@${--ssh-host}`, so the hint must not suggest a USER@HOST value: following it would produce `root@user@host`.
  if (!ctx.sshHost) throw new Error('This provider needs --ssh-host HOST (and --ssh-user USER when the target is not root) before it can be reached');
  return ctx.ssh(ctx.sshHost, ctx.sshUser);
}

export const dockerHostAdapter: ProviderAdapter = {
  provider: 'docker-host',
  async preflight(ctx) {
    const items: PreflightItem[] = [
      { name: 'SSH target', ok: !!ctx.sshHost, detail: ctx.sshHost ? `${ctx.sshUser}@${ctx.sshHost}` : 'no target selected', fix: 'Pass --ssh-host HOST and, when it is not root, --ssh-user USER' },
      // A bare host address can only get an internal certificate from Caddy, and the
      // installer's own health check and GitHub's webhook delivery both reject that; a
      // missing domain is refused here instead of after a doomed health loop.
      { name: 'Public hostname', ok: !!ctx.domain, detail: ctx.domain ?? 'no domain selected; the health check and GitHub webhook delivery reject the internal certificate Caddy would issue for a bare host address', fix: `Pass --domain graphyard.example.com and point its A record at ${ctx.sshHost ?? 'this host'} for publicly trusted TLS` },
    ];
    if (!ctx.sshHost) return items;
    const remote = requireHost(ctx);
    items.push(await tool(ctx, remote, 'docker', ['version', '--format', '{{.Server.Version}}'], 'Remote Docker Engine', `Install Docker Engine on ${ctx.sshHost}: ssh ${ctx.sshUser}@${ctx.sshHost} 'curl -fsSL https://get.docker.com | sh'`));
    items.push(await tool(ctx, remote, 'docker', ['compose', 'version', '--short'], 'Remote Docker Compose', `Install the Docker Compose plugin on ${ctx.sshHost}`));
    return items;
  },
  async observe(ctx) {
    const observation = emptyObservation();
    if (!ctx.sshHost) return observation;
    const remote = requireHost(ctx);
    const environment = await readRemote(remote, `${ctx.workdir}/server.env`);
    if (environment === null) return observation;
    observation.installed = true;
    observation.variables = markersFromEnvFile(environment); observation.variablesObserved = true;
    const state = await composeRunning(remote, ctx);
    observation.database = state.database; observation.app = state.app;
    observation.url = state.app ? publicUrl(ctx) : null;
    return observation;
  },
  plan(ctx, observation) { return composeActions(ctx, observation, ctx.sshHost ? `${ctx.sshUser}@${ctx.sshHost}` : 'the selected Docker host'); },
  async provision(ctx) { await requireHost(ctx).exec('mkdir', ['-p', ctx.workdir, ...(ctx.dataPath ? [`${ctx.dataPath}/postgres`] : [])], { timeout: 60_000 }); },
  async setEnv(ctx, values) {
    const remote = requireHost(ctx);
    for (const file of composeBundle(ctx, values, 'proxy')) await remote.putFile(file.path, file.content, file.mode, file.owner);
  },
  async deploy(ctx) { await composeUp(ctx, requireHost(ctx), true); },
  async url(ctx) { return publicUrl(ctx); },
  health: httpHealth,
  async logs(ctx, lines = 100) {
    const result = await requireHost(ctx).exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'logs', '--tail', String(lines), 'server'], { allowFailure: true, timeout: 120_000 });
    return ctx.vault.scrub(result.stdout || result.stderr);
  },
};

function publicUrl(ctx: AdapterContext) {
  if (ctx.domain) return `https://${ctx.domain}`;
  if (ctx.sshHost) return `https://${ctx.sshHost}`;
  throw new Error('No domain or host is known for this installation');
}

// ---------------------------------------------------------------------------
// hetzner — create the machine, then run the same bundle on it
// ---------------------------------------------------------------------------

/**
 * Installs Docker and mounts the attached Hetzner volume at the data path, so the work
 * ledger survives rebuilding the server. The device only appears once the volume is
 * attached, which can happen after first boot, so the mount waits for it.
 */
export function cloudInit(ctx: AdapterContext) {
  const dataPath = ctx.dataPath ?? '/mnt/graphyard';
  return `#cloud-config
package_update: true
packages: [ca-certificates, curl]
runcmd:
  - [sh, -c, "install -m 0755 -d /etc/apt/keyrings"]
  - [sh, -c, "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc"]
  - [sh, -c, "echo \\"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable\\" > /etc/apt/sources.list.d/docker.list"]
  - [sh, -c, "apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"]
  - [systemctl, enable, --now, docker]
  - [sh, -c, "for attempt in $(seq 1 90); do device=$(ls /dev/disk/by-id/scsi-0HC_Volume_* 2>/dev/null | head -1); [ -n \\"$device\\" ] && break; sleep 2; done; mkdir -p ${dataPath}; if [ -n \\"$device\\" ]; then grep -q ' ${dataPath} ' /etc/fstab || echo \\"$device ${dataPath} ext4 discard,nofail,defaults 0 0\\" >> /etc/fstab; mount ${dataPath} || true; fi; mkdir -p ${dataPath}/postgres ${ctx.workdir}"]
`;
}

/** Cloud-init is still running when the server first answers SSH. */
async function waitForDocker(ctx: AdapterContext, remote: Transport, attempts = 90) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await remote.exec('docker', ['version', '--format', '{{.Server.Version}}'], { allowFailure: true, timeout: 60_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    if (result.code === 0) return;
    await ctx.wait(5_000);
  }
  throw new Error(`Docker did not become available on ${ctx.service}; inspect the server's cloud-init output`);
}

/**
 * Postgres must never silently fall back to the root disk: cloud-init mounts the attached
 * volume, but the attach is asynchronous and its `allowFailure` means a failed attach would
 * otherwise surface only as a ledger that evaporates on rebuild. Wait for the mount, try the
 * mount cloud-init prepared if the device appeared late, and refuse to deploy onto a server
 * whose data disk is missing.
 */
async function waitForDataVolume(ctx: AdapterContext, remote: Transport, attempts = 15) {
  if (!ctx.dataPath) return;
  const mounted = async () => {
    const result = await remote.exec('findmnt', ['-n', '-o', 'SOURCE', '--target', ctx.dataPath!], { allowFailure: true, timeout: 60_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    return result.code === 0 && !!result.stdout.trim();
  };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await mounted()) return;
    await ctx.wait(4_000);
  }
  const device = await remote.exec('sh', ['-c', 'ls /dev/disk/by-id/scsi-0HC_Volume_* 2>/dev/null | head -1'], { allowFailure: true, timeout: 60_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
  if (device.code === 0 && device.stdout.trim()) {
    await remote.exec('sh', ['-c', `mkdir -p ${shellQuote(ctx.dataPath)} && mount ${shellQuote(ctx.dataPath)}`], { allowFailure: true, timeout: 120_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    if (await mounted()) return;
  }
  throw new Error(`The data volume did not appear at ${ctx.dataPath} on ${ctx.service}, so Postgres would write to the root disk and lose the ledger on rebuild. Attach it with "hcloud volume attach ${ctx.service}-data --server ${ctx.service} --automount", then rerun graphyard install --apply.`);
}

const hetznerQuotes = new WeakMap<AdapterContext, QuoteResult>();
/** The price the Hetzner preflight read for this install, for the plan to show; null before preflight or on failure. */
export const quotedPrice = (ctx: AdapterContext): PriceQuote | null => hetznerQuotes.get(ctx)?.quote ?? null;

export const hetznerAdapter: ProviderAdapter = {
  provider: 'hetzner',
  async preflight(ctx) {
    const items = [await tool(ctx, ctx.transport, 'hcloud', ['version'], 'hcloud CLI', 'Install the hcloud CLI (brew install hcloud, or the archive for this platform from https://github.com/hetznercloud/cli/releases), then run: hcloud context create graphyard')];
    items.push(await tool(ctx, ctx.transport, 'hcloud', ['context', 'active'], 'Hetzner Cloud project', 'Run: hcloud context create graphyard, then paste a Read & Write API token from the Hetzner Cloud console (Security - API tokens) of the project this installation is billed to'));
    items.push({ name: 'Public hostname', ok: true, detail: ctx.domain ?? 'no domain selected; the server is served as <its IPv4 address>.sslip.io, a public name Caddy obtains a trusted certificate for' });
    // The installer reaches the server over key-authenticated SSH only (BatchMode, no
    // passwords). Without a key Hetzner sets a root password, and provisioning would wait
    // out the SSH attempts before blaming cloud-init for a server it cannot log into.
    items.push({ name: 'SSH key', ok: !!ctx.sshKey, detail: ctx.sshKey ?? 'no SSH key selected; without one the server is created with a root password that key-only SSH cannot use', fix: 'Pass --ssh-key NAME (hcloud ssh-key list prints the names)' });
    if (!items[0].ok || !items[1].ok) return items;
    // The price is read from the provider API and shown before anything is created; creating the
    // server needs the operator's consent to exactly that price (GY-717 AC-5).
    const exists = (await ctx.transport.exec('hcloud', ['server', 'describe', ctx.service, '-o', 'json'], { allowFailure: true, timeout: 120_000 })).code === 0;
    const quote = await hetznerQuote(ctx.transport, { location: ctx.location, agents: ctx.plannedAgents, explicit: ctx.serverTypeExplicit || !ctx.host ? ctx.serverType : null });
    hetznerQuotes.set(ctx, quote);
    if (quote.quote) ctx.serverType = quote.quote.serverType;
    items.push(spendConsent(quote, ctx.spend, exists));
    return items;
  },
  async observe(ctx) {
    const observation = emptyObservation();
    const described = await ctx.transport.exec('hcloud', ['server', 'describe', ctx.service, '-o', 'json'], { allowFailure: true, timeout: 120_000 });
    if (described.code !== 0) return observation;
    let address: string | null = null;
    try { address = JSON.parse(described.stdout)?.public_net?.ipv4?.ip ?? null; } catch { address = null; }
    observation.compute = true;
    observation.detail.push(address ? `Server ${ctx.service} exists at ${address}` : `Server ${ctx.service} exists`);
    if (!address) return observation;
    const remote = ctx.ssh(address, ctx.sshUser);
    const environment = await readRemote(remote, `${ctx.workdir}/server.env`);
    if (environment === null) return observation;
    observation.installed = true;
    observation.variables = markersFromEnvFile(environment); observation.variablesObserved = true;
    const state = await composeRunning(remote, ctx);
    observation.database = state.database; observation.app = state.app;
    observation.url = state.app ? `https://${publicHostname(ctx, address)}` : null;
    return observation;
  },
  plan(ctx, observation) {
    return [
      { id: 'provider.provision.server', target: 'provider', title: `Create Hetzner server ${ctx.service} (${ctx.serverType}, ${ctx.location}) with a Docker cloud-init and an attached data volume`, state: observation.compute ? 'satisfied' : 'create', command: `hcloud server create --name ${ctx.service} --type ${ctx.serverType} --location ${ctx.location} --image ubuntu-24.04${ctx.sshKey ? ` --ssh-key ${ctx.sshKey}` : ''}` },
      ...composeActions(ctx, observation, `Hetzner server ${ctx.service}`),
      { id: 'provider.tls', target: 'provider', title: `Terminate TLS for ${ctx.domain ?? '<server address>.sslip.io'} with Caddy and an automatic, publicly trusted certificate`, state: observation.app ? 'satisfied' : 'create' },
      { id: 'provider.backup', target: 'provider', title: `Schedule backups of the ${ctx.service}-data volume mounted at ${ctx.dataPath}; the work ledger lives only in Postgres`, state: 'update', command: `hcloud volume describe ${ctx.service}-data -o json` },
    ];
  },
  async provision(ctx, observation) {
    if (!observation.compute) {
      await ctx.transport.exec('hcloud', ['volume', 'create', '--name', `${ctx.service}-data`, '--size', '20', '--location', ctx.location, '--format', 'ext4'], { allowFailure: true, timeout: 600_000 });
      await ctx.transport.exec('hcloud', ['server', 'create', '--name', ctx.service, '--type', ctx.serverType, '--location', ctx.location, '--image', 'ubuntu-24.04', ...(ctx.sshKey ? ['--ssh-key', ctx.sshKey] : []), '--user-data-from-file', '-'], { input: cloudInit(ctx), timeout: 900_000 });
      await ctx.transport.exec('hcloud', ['volume', 'attach', `${ctx.service}-data`, '--server', ctx.service, '--automount'], { allowFailure: true, timeout: 600_000 });
    }
    const remote = ctx.ssh(await hetznerAddress(ctx), ctx.sshUser);
    await waitForDocker(ctx, remote);
    await waitForDataVolume(ctx, remote);
    await remote.exec('mkdir', ['-p', ctx.workdir, ...(ctx.dataPath ? [`${ctx.dataPath}/postgres`] : [])], { timeout: 120_000 });
  },
  async setEnv(ctx, values) {
    const address = await hetznerAddress(ctx);
    const remote = ctx.ssh(address, ctx.sshUser);
    for (const file of composeBundle(ctx, values, 'proxy', { hostname: publicHostname(ctx, address) })) await remote.putFile(file.path, file.content, file.mode, file.owner);
  },
  async deploy(ctx) { await composeUp(ctx, ctx.ssh(await hetznerAddress(ctx), ctx.sshUser), true); },
  async url(ctx) { return `https://${publicHostname(ctx, await hetznerAddress(ctx))}`; },
  health: httpHealth,
  async logs(ctx, lines = 100) {
    const remote = ctx.ssh(await hetznerAddress(ctx), ctx.sshUser);
    const result = await remote.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'logs', '--tail', String(lines), 'server'], { allowFailure: true, timeout: 120_000 });
    return ctx.vault.scrub(result.stdout || result.stderr);
  },
};

export async function hetznerAddress(ctx: AdapterContext) {
  const described = await ctx.transport.exec('hcloud', ['server', 'describe', ctx.service, '-o', 'json'], { timeout: 120_000 });
  const address = (() => { try { return JSON.parse(described.stdout)?.public_net?.ipv4?.ip ?? null; } catch { return null; } })();
  if (typeof address !== 'string' || !address) throw new Error(`Hetzner did not report a public address for ${ctx.service}`);
  return address;
}

// ---------------------------------------------------------------------------
// railway
// ---------------------------------------------------------------------------

export interface RailwayWorkspace { id: string; name: string }
export interface RailwayWorkspaceChoice {
  /** The workspace the project is created in; null when the CLI could not enumerate any. */
  selected: RailwayWorkspace | null;
  choices: RailwayWorkspace[];
  problem: string | null;
}

/**
 * `railway init` runs without a terminal here, and outside one the CLI refuses to guess between
 * workspaces: an account that belongs to more than one gets "--workspace required in
 * non-interactive mode". The installer therefore settles the workspace before the plan is
 * printed — from `--workspace`, or on its own when the account has exactly one — and reports
 * a choice it cannot make as a failed preflight item instead of a failed apply.
 */
export function chooseRailwayWorkspace(requested: string | null, choices: RailwayWorkspace[]): RailwayWorkspaceChoice {
  const names = choices.map(workspace => `${workspace.name} (${workspace.id})`).join(', ');
  if (requested) {
    const wanted = requested.trim();
    const selected = choices.find(workspace => workspace.id === wanted) ?? choices.find(workspace => workspace.name === wanted) ?? choices.find(workspace => workspace.name.toLowerCase() === wanted.toLowerCase());
    if (selected) return { selected, choices, problem: null };
    // An empty listing means the CLI did not enumerate workspaces; the value is passed through as given.
    if (!choices.length) return { selected: { id: wanted, name: wanted }, choices, problem: null };
    return { selected: null, choices, problem: `no workspace is named "${wanted}"; this account belongs to: ${names}` };
  }
  if (choices.length === 1) return { selected: choices[0], choices, problem: null };
  if (choices.length === 0) return { selected: null, choices, problem: null };
  return { selected: null, choices, problem: `this account belongs to ${choices.length} workspaces, and creating the project outside a terminal needs an explicit choice: ${names}` };
}

const railwayWorkspaces = new WeakMap<AdapterContext, RailwayWorkspaceChoice>();

async function resolveRailwayWorkspace(ctx: AdapterContext): Promise<RailwayWorkspaceChoice> {
  const cached = railwayWorkspaces.get(ctx);
  if (cached) return cached;
  const account = await ctx.transport.exec('railway', ['whoami', '--json'], { allowFailure: true, timeout: 60_000 });
  let choices: RailwayWorkspace[] = [];
  try {
    const parsed = account.code === 0 ? JSON.parse(account.stdout) : null;
    choices = (Array.isArray(parsed?.workspaces) ? parsed.workspaces : [])
      .map((workspace: any) => ({ id: String(workspace?.id ?? ''), name: String(workspace?.name ?? '') }))
      .filter((workspace: RailwayWorkspace) => workspace.id);
  } catch { choices = []; }
  const choice = chooseRailwayWorkspace(ctx.workspace, choices);
  railwayWorkspaces.set(ctx, choice);
  return choice;
}

const railwayInitArgs = (ctx: AdapterContext, workspace: RailwayWorkspace | null) => ['init', '--name', `graphyard-${ctx.installId}`, ...(workspace ? ['--workspace', workspace.id] : [])];

/**
 * Every railway command that resolves the linked project runs in the Graphyard link
 * directory, never in the process cwd: the process cwd is the managed repository checkout
 * (the runbook requires it), and a checkout that is already linked to the user's own
 * Railway project would otherwise be observed, provisioned, and deployed as if it were
 * Graphyard's. Account-level preflight commands (`--version`, `whoami`) read no link and
 * keep the ambient cwd.
 */
async function runRailway(ctx: AdapterContext, args: string[], options: { input?: string; timeout?: number; allowFailure?: boolean } = {}) {
  return ctx.transport.exec('railway', args, { ...options, cwd: ctx.railwayDir });
}

/** The native result of the last `railway up` an apply ran (GY-1864): its command, exit code and the CLI's scrubbed message. */
export interface RailwayUploadReceipt { step: 'provider.deploy'; command: string; cwd: string; code: number; ok: boolean; message: string; buildSha: string | null }
const railwayUploads = new WeakMap<AdapterContext, RailwayUploadReceipt[]>();
/** Every upload this context ran, oldest first. */
export const railwayUploadReceipts = (ctx: AdapterContext): RailwayUploadReceipt[] => [...(railwayUploads.get(ctx) ?? [])];

const insideOrEqual = (path: string, root: string) => { const away = relative(root, path); return away === '' || (!away.startsWith('..') && !isAbsolute(away)); };

/**
 * The `railway up` arguments for the Graphyard source. The CLI runs from the private link
 * directory, and without --path-as-root it uploads a path that is not its cwd relative to the
 * linked directory's repository and fails with "prefix not found"; with it, the named source
 * becomes the archive root. A source that is the cwd uploads exactly as it always did.
 */
export function railwayUploadArgs(ctx: Pick<AdapterContext, 'sourceRoot' | 'service' | 'railwayDir'>) {
  const args = ['up', ctx.sourceRoot, '--service', ctx.service, '--ci', '--detach'];
  return resolve(ctx.sourceRoot) === resolve(ctx.railwayDir) ? args : [...args, '--path-as-root'];
}

/** True when a checkout's tracked or unignored files differ from its HEAD: `railway up` would upload them. */
export function sourceTreeDirty(root: string, run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })): boolean {
  try { return run('git', ['-C', root, 'status', '--porcelain', '--untracked-files=normal']).trim() !== ''; }
  catch { return true; }
}

/**
 * The commit the uploaded source is at: an upload carries no Git metadata, so the served build
 * knows its commit only from GRAPHYARD_BUILD_SHA, which the upload stamps first. Null when the
 * source is a checkout with changes HEAD does not hold (the upload would carry them under HEAD's
 * name), or no checkout and this process has no build identity either; the upload then refuses.
 */
export function railwaySourceCommit(ctx: Pick<AdapterContext, 'sourceRoot' | 'sourceCommit'>, dirty = sourceTreeDirty): string | null {
  if (ctx.sourceCommit !== undefined) return ctx.sourceCommit;
  const head = cliCommit(ctx.sourceRoot);
  if (head) return dirty(ctx.sourceRoot) ? null : head;
  return buildIdentity().commit;
}

/**
 * Uploads the Graphyard source and records the CLI's own result. Under --observe-only the
 * managed repository's tree (the process cwd the runbook requires, or `ctx.managedRoot`) is
 * never the upload: a source that is it, or that contains it, is refused before anything runs.
 * A non-zero exit is the failed deploy step, carrying the exit code and the scrubbed message,
 * and it stops the apply.
 */
export async function railwayUpload(ctx: AdapterContext): Promise<RailwayUploadReceipt> {
  const managed = resolve(ctx.managedRoot ?? process.cwd());
  if (ctx.observeOnly && insideOrEqual(managed, resolve(ctx.sourceRoot))) {
    throw new Error(`provider.deploy refused: under --observe-only the upload source ${ctx.sourceRoot} is the managed repository's tree (${managed}); only the Graphyard source is uploaded`);
  }
  // Stamped before the upload, without a deploy of its own: the upload's build then serves its
  // commit at /healthz, and a rerun on a deployed app restamps and redeploys it. A source whose
  // commit is unknown is refused: the service would keep an earlier upload's stamp and serve it.
  const commit = railwaySourceCommit(ctx);
  if (!commit) throw new Error(`provider.deploy refused: the commit of the upload source ${ctx.sourceRoot} is unknown (no clean Git checkout and no GRAPHYARD_BUILD_SHA), so GRAPHYARD_BUILD_SHA cannot be set and the service would keep a previous upload's commit`);
  await runRailway(ctx, ['variables', '--service', ctx.service, '--skip-deploys', '--set', `GRAPHYARD_BUILD_SHA=${commit}`], { timeout: 300_000 });
  const args = railwayUploadArgs(ctx);
  const result = await runRailway(ctx, args, { allowFailure: true, timeout: 1_800_000 });
  const message = ctx.vault.scrub((result.code === 0 ? result.stdout.trim() || result.stderr.trim() : result.stderr.trim() || result.stdout.trim()).split('\n').filter(Boolean).slice(-8).join('\n').slice(-2000));
  const receipt: RailwayUploadReceipt = { step: 'provider.deploy', command: `railway ${args.join(' ')}`, cwd: ctx.railwayDir, code: result.code, ok: result.code === 0, message, buildSha: commit };
  railwayUploads.set(ctx, [...(railwayUploads.get(ctx) ?? []), receipt]);
  if (!receipt.ok) throw Object.assign(new Error(`provider.deploy failed: railway up exited with ${result.code}${message ? `: ${message}` : ''}`), { receipt });
  return receipt;
}

/** How long the health check waits for the uploaded build to be served: 200 × 3 s, ten minutes. */
const RAILWAY_SERVE_ATTEMPTS = 200;

/** A row from `railway deployment list --json` (newest first). */
export interface RailwayDeployment { id: string; status: string }

/**
 * The service's recent deployments, newest first. Null when the CLI cannot list them (too old, or
 * unlinked): app bind that preserves the serving deployment then refuses rather than guessing.
 */
export async function railwayDeploymentList(ctx: AdapterContext): Promise<RailwayDeployment[] | null> {
  const result = await runRailway(ctx, ['deployment', 'list', '--service', ctx.service, '--json', '--limit', '20'], { allowFailure: true, timeout: 180_000 });
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((entry: any) => ({ id: String(entry?.id ?? ''), status: String(entry?.status ?? '').toUpperCase() })).filter((entry: RailwayDeployment) => entry.id);
  } catch { return null; }
}

/**
 * `railway redeploy` always targets `latest_deployment`, not the serving one. When a newer failed
 * or crashed attempt exists while an older SUCCESS still serves, redeploying would rebuild that
 * failed source. Refuse before any variable write (GY-1908).
 */
export async function assertRailwayServingIsLatest(ctx: AdapterContext): Promise<void> {
  const list = await railwayDeploymentList(ctx);
  if (!list) throw new Error(`provider.applyVariables refused: the Railway CLI could not list deployments for ${ctx.service} (need a CLI that supports railway deployment list --json); app bind cannot tell whether latest is the serving deployment`);
  if (!list.length) throw new Error(`provider.applyVariables refused: ${ctx.service} has no Railway deployment to redeploy`);
  const latest = list[0]!;
  const serving = list.find(entry => entry.status === 'SUCCESS');
  if (!serving) throw new Error(`provider.applyVariables refused: ${ctx.service} has no SUCCESS deployment serving; latest is ${latest.id} (${latest.status})`);
  if (latest.id !== serving.id) {
    throw new Error(`provider.applyVariables refused: latest deployment ${latest.id} is ${latest.status}, while ${serving.id} (SUCCESS) is still serving; railway redeploy would rebuild the latest attempt rather than the live source. Remove or roll back the failed attempt, or wait until a SUCCESS is latest, then rerun`);
  }
}

/** The new deployment id `railway redeploy --json` prints, or null when the CLI printed none. */
export function parseRailwayRedeployId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout.trim() || 'null');
    const id = parsed && typeof parsed === 'object' ? parsed.id : null;
    return typeof id === 'string' && id ? id : null;
  } catch { return null; }
}

const railwayFailed = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);

/**
 * Wait until the redeployed deployment is SUCCESS. `railway redeploy` returns after the mutation;
 * without this wait the previous healthy instance still answers /healthz (GY-1908).
 */
export async function waitForRailwayRedeploy(ctx: AdapterContext, redeployedId: string | null): Promise<void> {
  let target = redeployedId;
  let served = target ? `deployment ${target} not listed yet` : 'no redeploy id';
  for (let attempt = 0; attempt < RAILWAY_SERVE_ATTEMPTS; attempt++) {
    const list = await railwayDeploymentList(ctx);
    if (!list) throw new Error(`provider.applyVariables failed: the Railway CLI could not list deployments for ${ctx.service} while waiting for the redeploy`);
    if (!target) {
      const pending = list.find(entry => entry.status !== 'SUCCESS' && entry.status !== 'REMOVED') ?? list[0];
      target = pending?.id ?? null;
    }
    const row = target ? list.find(entry => entry.id === target) : undefined;
    if (row?.status === 'SUCCESS') return;
    if (row && railwayFailed.has(row.status)) {
      throw new Error(`provider.applyVariables failed: redeployed deployment ${row.id} is ${row.status} while the previous instance may still be healthy; the App variables were written but are not served. Inspect: railway logs --service ${ctx.service}`);
    }
    served = row ? `deployment ${row.id} is ${row.status}` : target ? `deployment ${target} not listed yet` : 'no redeploy id';
    await ctx.wait(3_000);
  }
  throw new Error(`provider.applyVariables failed: ${ctx.service} still reports ${served} after the redeploy; the new instance did not become SUCCESS. Inspect: railway logs --service ${ctx.service}`);
}

/**
 * Railway's health is the uploaded build's, not the service's: `railway up --detach` returns once
 * the build is queued, and on a rerun the previous deployment keeps answering /healthz, so a
 * healthy answer alone would complete the apply while the new upload is still building or has
 * failed. After an upload, healthy means /healthz is ok and reports the commit that upload
 * stamped in GRAPHYARD_BUILD_SHA; while it reports another, the check waits, and when the wait
 * ends without it the deploy step fails, naming what is served instead.
 */
export async function railwayHealth(ctx: AdapterContext, url: string): Promise<boolean> {
  const sha = railwayUploadReceipts(ctx).at(-1)?.buildSha;
  if (!sha) return httpHealth(ctx, url);
  let served = 'no answer';
  for (let attempt = 0; attempt < RAILWAY_SERVE_ATTEMPTS; attempt++) {
    try {
      const response = await ctx.fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(15_000) });
      const body = response.ok ? await response.json() as any : null;
      const commit = typeof body?.commit === 'string' ? body.commit.toLowerCase() : null;
      if (body?.ok === true && commit === sha.toLowerCase()) return true;
      served = body?.ok === true ? `commit ${commit ?? 'null'}` : `HTTP ${response.status}`;
    } catch { served = 'no answer'; }
    await ctx.wait(3_000);
  }
  throw new Error(`provider.deploy failed: ${url} still serves ${served}, not the uploaded commit ${sha}; the upload's build failed or did not finish. Inspect: railway logs --service ${ctx.service}`);
}

export const railwayAdapter: ProviderAdapter = {
  provider: 'railway',
  async preflight(ctx) {
    const items = [
      await tool(ctx, ctx.transport, 'railway', ['--version'], 'Railway CLI', 'Install the Railway CLI (npm i -g @railway/cli)'),
      await tool(ctx, ctx.transport, 'railway', ['whoami'], 'Railway login', 'Run: railway login'),
    ];
    if (!items.every(item => item.ok)) return items;
    const workspace = await resolveRailwayWorkspace(ctx);
    const options = workspace.choices.map(choice => `"${choice.name}"`).join(' | ');
    items.push(workspace.problem
      ? { name: 'Railway workspace', ok: false, detail: workspace.problem, fix: `Rerun with --workspace ${options || 'NAME-OR-ID'} (railway whoami --json lists them)` }
      : { name: 'Railway workspace', ok: true, detail: workspace.selected ? `${workspace.selected.name} (${workspace.selected.id})${ctx.workspace ? '' : ', the only workspace of this account'}` : 'not enumerated by this Railway CLI; the account default is used' });
    return items;
  },
  async observe(ctx) {
    const observation = emptyObservation();
    const status = await runRailway(ctx, ['status', '--json'], { allowFailure: true, timeout: 180_000 });
    if (status.code !== 0) return observation;
    let services: string[] = [];
    try {
      const parsed = JSON.parse(status.stdout);
      services = (parsed?.services?.edges ?? []).map((edge: any) => String(edge?.node?.name ?? '')).filter(Boolean);
      observation.compute = true;
      observation.detail.push(`Linked to Railway project ${parsed?.name ?? 'unknown'}`);
    } catch { return observation; }
    observation.database = services.some(name => /postgres/i.test(name));
    observation.app = services.includes(ctx.service);
    if (!observation.app) return observation;
    // Every Railway variable listing prints values, and none prints names alone, so an
    // observation-only install (GY-1846) never runs one: the service's existence stands for an
    // installed deployment, and its variable names are reported unknown (variablesObserved false).
    if (ctx.observeOnly) {
      observation.installed = true;
      observation.detail.push(`Variables of ${ctx.service} not read (observation-only reads no values): their names are unknown`);
    }
    const variables = ctx.observeOnly ? null : await runRailway(ctx, ['variables', '--service', ctx.service, '--json'], { allowFailure: true, timeout: 180_000 });
    if (variables?.code === 0) {
      try {
        const parsed = JSON.parse(variables.stdout) as Record<string, string>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a variable listing');
        observation.installed = Object.keys(parsed).length > 0;
        for (const [name, value] of Object.entries(parsed)) observation.variables[name] = variableMarker(name, String(value));
        observation.variablesObserved = true;
      } catch { /* an unparsable listing is reported as no observed variables */ }
    }
    const domains = await runRailway(ctx, ['domain', '--service', ctx.service, '--json'], { allowFailure: true, timeout: 180_000 });
    if (domains.code === 0) {
      const found = /[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.exec(domains.stdout.replace(/https?:\/\//g, ''));
      if (found) observation.url = `https://${found[0]}`;
    }
    return observation;
  },
  plan(ctx, observation) {
    // Preflight ran first and settled the workspace; a plan built without it shows the bare command.
    const workspace = railwayWorkspaces.get(ctx) ?? chooseRailwayWorkspace(ctx.workspace, []);
    const commit = railwaySourceCommit(ctx);
    return [
      { id: 'provider.provision.project', target: 'provider', title: `Link or create the Railway project for ${ctx.repository}${workspace.selected ? ` in workspace ${workspace.selected.name}` : ''}, linked from ${ctx.railwayDir}`, state: observation.compute ? 'satisfied' : 'create', command: `railway ${railwayInitArgs(ctx, workspace.selected).join(' ')}`, ...(workspace.selected ? { values: [{ name: 'workspace', value: `${workspace.selected.name} (${workspace.selected.id})`, secret: false }] } : {}) },
      { id: 'provider.provision.database', target: 'provider', title: 'Add the managed Postgres database', state: observation.database ? 'satisfied' : 'create', command: 'railway add --database postgres' },
      { id: 'provider.provision.app', target: 'provider', title: `Add the ${ctx.service} application service built from the Graphyard checkout's root Dockerfile; every upload first sets GRAPHYARD_BUILD_SHA to ${commit ?? 'the source commit, which is unknown here, so the upload is refused'}`, state: observation.app ? 'satisfied' : 'create', command: `railway add --service ${ctx.service}`, values: [{ name: 'GRAPHYARD_BUILD_SHA', value: commit ?? 'unknown', secret: false }] },
    ];
  },
  async provision(ctx, observation) {
    // The link directory is created here rather than during preparation, so a refused apply
    // and every --plan still leave the machine untouched.
    await ctx.transport.exec('mkdir', ['-p', ctx.railwayDir], { timeout: 60_000 });
    if (!observation.compute) {
      const workspace = await resolveRailwayWorkspace(ctx);
      if (workspace.problem) throw new Error(`Railway workspace: ${workspace.problem}`);
      await runRailway(ctx, railwayInitArgs(ctx, workspace.selected), { timeout: 600_000 });
    }
    if (!observation.database) await runRailway(ctx, ['add', '--database', 'postgres'], { timeout: 600_000 });
    if (!observation.app) await runRailway(ctx, ['add', '--service', ctx.service], { timeout: 600_000 });
  },
  async setEnv(ctx, values) {
    const plain = values.filter(value => !value.secret);
    if (plain.length) await runRailway(ctx, ['variables', '--service', ctx.service, '--skip-deploys', ...plain.flatMap(value => ['--set', `${value.name}=${value.value}`])], { timeout: 300_000 });
    // Secrets go over standard input: a process argument is visible to every local process.
    for (const secret of values.filter(value => value.secret)) await runRailway(ctx, ['variable', 'set', '--service', ctx.service, '--skip-deploys', '--stdin', secret.name], { input: secret.value, timeout: 300_000 });
  },
  async applyVariables(ctx, values) {
    // Railway sets variables one by one and keeps the rest; the running build restarts once with
    // them all. App bind (GY-1908) uses this path so a bind never uploads source or stamps
    // GRAPHYARD_BUILD_SHA — only `install --apply`'s deploy does that. When preserving the serving
    // deployment, refuse a newer failed latest before any write, redeploy with --json, and wait for
    // that specific redeploy to become SUCCESS (plain `railway redeploy` returns after the mutation).
    if (ctx.preserveServingDeployment) await assertRailwayServingIsLatest(ctx);
    await railwayAdapter.setEnv(ctx, values);
    const redeploy = ['redeploy', '--service', ctx.service, '--yes', ...(ctx.preserveServingDeployment ? ['--json'] : [])];
    const result = await runRailway(ctx, redeploy, { timeout: 600_000 });
    if (ctx.preserveServingDeployment) await waitForRailwayRedeploy(ctx, parseRailwayRedeployId(result.stdout));
  },
  async deploy(ctx) {
    // The source is the Graphyard checkout the CLI runs from — never the process cwd, which
    // is the managed repository's tree: an implicit `railway up` there would build and
    // deploy the user's application (or its Nixpacks guess) as the Graphyard service.
    await railwayUpload(ctx);
  },
  async url(ctx) {
    const args = ['domain', '--service', ctx.service, '--port', String(SERVER_PORT), ...(ctx.domain ? [ctx.domain] : [])];
    const result = await runRailway(ctx, args, { timeout: 600_000 });
    const found = /[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.exec(`${result.stdout}\n${ctx.domain ?? ''}`.replace(/https?:\/\//g, ''));
    if (!found) throw new Error('Railway did not return an HTTPS domain for the service');
    return `https://${found[0]}`;
  },
  health: railwayHealth,
  async logs(ctx, lines = 100) {
    const result = await runRailway(ctx, ['logs', '--service', ctx.service, '--lines', String(lines)], { allowFailure: true, timeout: 180_000 });
    return ctx.vault.scrub(result.stdout || result.stderr);
  },
};

/**
 * Variables whose values are credentials: never echoed, only compared by fingerprint.
 *
 * `DATABASE_URL` is classified by its value rather than by its name, because the same name
 * holds both kinds of thing. On Railway the installer sets the shared reference
 * `${{Postgres.DATABASE_URL}}`, which carries no credential and compares as plain text — that
 * is what keeps a re-plan from reporting phantom drift. Any other value in it is a connection
 * string with a password, including the resolved one a provider reports back in place of the
 * reference it was given, and a password must never reach the plan.
 */
export const secretVariableNames = new Set(['GRAPHYARD_PRINCIPALS', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY']);
const providerReference = /^\$\{\{[^{}]+\}\}$/;
/** True for a shared reference such as `${{Postgres.DATABASE_URL}}`, which the provider resolves before reporting it back. */
export const isProviderReference = (value: string) => providerReference.test(value.trim());
export const carriesCredential = (name: string, value: string) => secretVariableNames.has(name) || (name === 'DATABASE_URL' && !providerReference.test(value.trim()));
export const variableMarker = (name: string, value: string) => carriesCredential(name, value) ? `sha:${fingerprint(value)}` : value;

export const adapters: Partial<Record<Provider, ProviderAdapter>> = {
  railway: railwayAdapter,
  hetzner: hetznerAdapter,
  'docker-host': dockerHostAdapter,
  compose: composeAdapter,
};

export const adapterFor = (provider: Provider) => {
  // Looked up when called: local.ts imports this module, so a record entry would read it before it is defined.
  const adapter = provider === 'local' ? localAdapter : adapters[provider];
  // `host` exists only as a self-contained install; src/install/host.ts wraps it.
  if (!adapter) throw new Error(`The ${provider} target is installed by the self-contained host adapter (src/install/host.ts)`);
  return adapter;
};
