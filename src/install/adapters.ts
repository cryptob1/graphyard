import { fingerprint, Vault } from './secrets.js';
import type { Transport } from './transport.js';
import { SERVER_PORT, type EnvValue, type PlanAction, type PreflightItem, type Provider } from './types.js';

export const DEFAULT_IMAGE = 'ghcr.io/cryptob1/graphyard:main';

export interface AdapterContext {
  provider: Provider;
  repository: string;
  installId: string;
  service: string;
  domain: string | null;
  image: string;
  workdir: string;
  sourceRoot: string;
  sshHost: string | null;
  sshUser: string;
  serverType: string;
  location: string;
  databasePassword: string;
  port: number;
  /** Absolute path of an attached data disk; when set, Postgres stores its data there. */
  dataPath: string | null;
  wait: (ms: number) => Promise<void>;
  transport: Transport;
  ssh: (host: string, user?: string) => Transport;
  fetch: typeof fetch;
  vault: Vault;
}

export interface AdapterObservation {
  installed: boolean;
  database: boolean;
  app: boolean;
  url: string | null;
  /** Variable name to a comparable, never-secret marker: plain value, or `sha:<fingerprint>`. */
  variables: Record<string, string>;
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
  deploy(ctx: AdapterContext): Promise<void>;
  url(ctx: AdapterContext): Promise<string>;
  health(ctx: AdapterContext, url: string): Promise<boolean>;
  logs(ctx: AdapterContext, lines?: number): Promise<string>;
}

export const emptyObservation = (): AdapterObservation => ({ installed: false, database: false, app: false, url: null, variables: {}, detail: [] });

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

export interface BundleFile { path: string; content: string; mode: number }

export function composeBundle(ctx: AdapterContext, values: EnvValue[], publish: 'loopback' | 'proxy'): BundleFile[] {
  const environment = values.map(value => `${value.name}=${value.value}`).join('\n');
  const proxied = publish === 'proxy';
  const files: BundleFile[] = [
    { path: `${ctx.workdir}/db.env`, mode: 0o600, content: `POSTGRES_USER=graphyard\nPOSTGRES_DB=graphyard\nPOSTGRES_PASSWORD=${ctx.databasePassword}\n` },
    { path: `${ctx.workdir}/server.env`, mode: 0o600, content: `${environment}\n` },
    { path: `${ctx.workdir}/compose.yaml`, mode: 0o644, content: `name: graphyard-${ctx.installId}
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    env_file: [db.env]
    volumes: ["${ctx.dataPath ? `${ctx.dataPath}/postgres` : 'graphyard-data'}:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U graphyard"]
      interval: 5s
      timeout: 3s
      retries: 40
  server:
    image: ${ctx.image}
    restart: unless-stopped
    env_file: [server.env]
    depends_on:
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
  // Without a registered domain Caddy issues an internal certificate: the endpoint is
  // encrypted but not publicly trusted, which the installer reports rather than hides.
  if (proxied) files.push({ path: `${ctx.workdir}/Caddyfile`, mode: 0o644, content: ctx.domain ? `${ctx.domain} {\n\treverse_proxy server:${SERVER_PORT}\n}\n` : `:443 {\n\ttls internal\n\treverse_proxy server:${SERVER_PORT}\n}\n` });
  return files;
}

async function composeUp(ctx: AdapterContext, transport: Transport, pull: boolean) {
  if (pull) await transport.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'pull', '--quiet'], { allowFailure: true, timeout: 900_000 });
  await transport.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'up', '-d', '--remove-orphans'], { timeout: 900_000 });
}

async function composeRunning(transport: Transport, ctx: AdapterContext) {
  const result = await transport.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'ps', '--format', 'json'], { allowFailure: true, timeout: 120_000 });
  if (result.code !== 0) return { database: false, app: false };
  const rows = result.stdout.split('\n').map(line => line.trim()).filter(Boolean).flatMap(line => { try { const parsed = JSON.parse(line); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return []; } });
  const running = (service: string) => rows.some((row: any) => row.Service === service && /running|healthy/i.test(String(row.State ?? row.Status ?? '')));
  return { database: running('db'), app: running('server') };
}

async function readRemote(transport: Transport, path: string) {
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

export const composeAdapter: ProviderAdapter = {
  provider: 'compose',
  async preflight(ctx) {
    return [
      await tool(ctx, ctx.transport, 'docker', ['version', '--format', '{{.Server.Version}}'], 'Docker Engine', 'Install Docker Engine and start its daemon, then rerun the installer'),
      await tool(ctx, ctx.transport, 'docker', ['compose', 'version', '--short'], 'Docker Compose', 'Install the Docker Compose plugin (docker compose version), then rerun the installer'),
    ];
  },
  async observe(ctx) {
    const observation = emptyObservation();
    const environment = await readRemote(ctx.transport, `${ctx.workdir}/server.env`);
    if (environment === null) return observation;
    observation.installed = true;
    observation.variables = markersFromEnvFile(environment);
    const state = await composeRunning(ctx.transport, ctx);
    observation.database = state.database; observation.app = state.app;
    observation.url = state.app ? `http://127.0.0.1:${ctx.port}` : null;
    return observation;
  },
  plan(ctx, observation) {
    return [
      { id: 'provider.image', target: 'provider', title: `Build the Graphyard image ${ctx.image} from ${ctx.sourceRoot}`, state: 'update', command: `docker build --tag ${ctx.image} ${ctx.sourceRoot}` },
      ...composeActions(ctx, observation, 'this machine'),
    ];
  },
  async provision(ctx) {
    await ctx.transport.exec('docker', ['build', '--tag', ctx.image, ctx.sourceRoot], { timeout: 1_800_000 });
  },
  async setEnv(ctx, values) {
    for (const file of composeBundle(ctx, values, 'loopback')) await ctx.transport.putFile(file.path, file.content, file.mode);
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
  if (!ctx.sshHost) throw new Error('This provider needs --ssh-host USER@HOST (or a provisioned server) before it can be reached');
  return ctx.ssh(ctx.sshHost, ctx.sshUser);
}

export const dockerHostAdapter: ProviderAdapter = {
  provider: 'docker-host',
  async preflight(ctx) {
    const items: PreflightItem[] = [{ name: 'SSH target', ok: !!ctx.sshHost, detail: ctx.sshHost ? `${ctx.sshUser}@${ctx.sshHost}` : 'no target selected', fix: 'Pass --ssh-host HOST and, when it is not root, --ssh-user USER' }];
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
    observation.variables = markersFromEnvFile(environment);
    const state = await composeRunning(remote, ctx);
    observation.database = state.database; observation.app = state.app;
    observation.url = state.app ? publicUrl(ctx) : null;
    return observation;
  },
  plan(ctx, observation) { return composeActions(ctx, observation, ctx.sshHost ? `${ctx.sshUser}@${ctx.sshHost}` : 'the selected Docker host'); },
  async provision(ctx) { await requireHost(ctx).exec('mkdir', ['-p', ctx.workdir, ...(ctx.dataPath ? [`${ctx.dataPath}/postgres`] : [])], { timeout: 60_000 }); },
  async setEnv(ctx, values) {
    const remote = requireHost(ctx);
    for (const file of composeBundle(ctx, values, 'proxy')) await remote.putFile(file.path, file.content, file.mode);
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

export const hetznerAdapter: ProviderAdapter = {
  provider: 'hetzner',
  async preflight(ctx) {
    const items = [await tool(ctx, ctx.transport, 'hcloud', ['version'], 'hcloud CLI', 'Install hcloud and run: hcloud context create graphyard')];
    items.push(await tool(ctx, ctx.transport, 'hcloud', ['context', 'active'], 'Hetzner Cloud project', 'Run: hcloud context create graphyard, then paste a project API token'));
    items.push({ name: 'Public hostname', ok: !!ctx.domain, detail: ctx.domain ?? 'no domain selected; Caddy will issue an internal certificate', fix: 'Pass --domain graphyard.example.com and point its A record at the created server for publicly trusted TLS' });
    return items;
  },
  async observe(ctx) {
    const observation = emptyObservation();
    const described = await ctx.transport.exec('hcloud', ['server', 'describe', ctx.service, '-o', 'json'], { allowFailure: true, timeout: 120_000 });
    if (described.code !== 0) return observation;
    let address: string | null = null;
    try { address = JSON.parse(described.stdout)?.public_net?.ipv4?.ip ?? null; } catch { address = null; }
    observation.detail.push(address ? `Server ${ctx.service} exists at ${address}` : `Server ${ctx.service} exists`);
    if (!address) return observation;
    const remote = ctx.ssh(address, ctx.sshUser);
    const environment = await readRemote(remote, `${ctx.workdir}/server.env`);
    if (environment === null) return observation;
    observation.installed = true;
    observation.variables = markersFromEnvFile(environment);
    const state = await composeRunning(remote, ctx);
    observation.database = state.database; observation.app = state.app;
    observation.url = state.app ? (ctx.domain ? `https://${ctx.domain}` : `https://${address}`) : null;
    return observation;
  },
  plan(ctx, observation) {
    return [
      { id: 'provider.provision.server', target: 'provider', title: `Create Hetzner server ${ctx.service} (${ctx.serverType}, ${ctx.location}) with a Docker cloud-init and an attached data volume`, state: observation.detail.length ? 'satisfied' : 'create', command: `hcloud server create --name ${ctx.service} --type ${ctx.serverType} --location ${ctx.location} --image ubuntu-24.04` },
      ...composeActions(ctx, observation, `Hetzner server ${ctx.service}`),
      { id: 'provider.tls', target: 'provider', title: ctx.domain ? `Terminate TLS for ${ctx.domain} with Caddy and automatic certificates` : 'Terminate TLS with a Caddy internal certificate (no public domain selected)', state: observation.app ? 'satisfied' : 'create' },
      { id: 'provider.backup', target: 'provider', title: `Schedule backups of the ${ctx.service}-data volume mounted at ${ctx.dataPath}; the work ledger lives only in Postgres`, state: 'update', command: `hcloud volume describe ${ctx.service}-data -o json` },
    ];
  },
  async provision(ctx, observation) {
    if (!observation.detail.length) {
      await ctx.transport.exec('hcloud', ['volume', 'create', '--name', `${ctx.service}-data`, '--size', '20', '--location', ctx.location, '--format', 'ext4'], { allowFailure: true, timeout: 600_000 });
      await ctx.transport.exec('hcloud', ['server', 'create', '--name', ctx.service, '--type', ctx.serverType, '--location', ctx.location, '--image', 'ubuntu-24.04', '--user-data-from-file', '-'], { input: cloudInit(ctx), timeout: 900_000 });
      await ctx.transport.exec('hcloud', ['volume', 'attach', `${ctx.service}-data`, '--server', ctx.service, '--automount'], { allowFailure: true, timeout: 600_000 });
    }
    const remote = ctx.ssh(await hetznerAddress(ctx), ctx.sshUser);
    await waitForDocker(ctx, remote);
    await remote.exec('mkdir', ['-p', ctx.workdir, ...(ctx.dataPath ? [`${ctx.dataPath}/postgres`] : [])], { timeout: 120_000 });
  },
  async setEnv(ctx, values) {
    const remote = ctx.ssh(await hetznerAddress(ctx), ctx.sshUser);
    for (const file of composeBundle(ctx, values, 'proxy')) await remote.putFile(file.path, file.content, file.mode);
  },
  async deploy(ctx) { await composeUp(ctx, ctx.ssh(await hetznerAddress(ctx), ctx.sshUser), true); },
  async url(ctx) { return ctx.domain ? `https://${ctx.domain}` : `https://${await hetznerAddress(ctx)}`; },
  health: httpHealth,
  async logs(ctx, lines = 100) {
    const remote = ctx.ssh(await hetznerAddress(ctx), ctx.sshUser);
    const result = await remote.exec('docker', ['compose', '--project-directory', ctx.workdir, '-f', `${ctx.workdir}/compose.yaml`, 'logs', '--tail', String(lines), 'server'], { allowFailure: true, timeout: 120_000 });
    return ctx.vault.scrub(result.stdout || result.stderr);
  },
};

async function hetznerAddress(ctx: AdapterContext) {
  const described = await ctx.transport.exec('hcloud', ['server', 'describe', ctx.service, '-o', 'json'], { timeout: 120_000 });
  const address = (() => { try { return JSON.parse(described.stdout)?.public_net?.ipv4?.ip ?? null; } catch { return null; } })();
  if (typeof address !== 'string' || !address) throw new Error(`Hetzner did not report a public address for ${ctx.service}`);
  return address;
}

// ---------------------------------------------------------------------------
// railway
// ---------------------------------------------------------------------------

export const railwayAdapter: ProviderAdapter = {
  provider: 'railway',
  async preflight(ctx) {
    return [
      await tool(ctx, ctx.transport, 'railway', ['--version'], 'Railway CLI', 'Install the Railway CLI (npm i -g @railway/cli)'),
      await tool(ctx, ctx.transport, 'railway', ['whoami'], 'Railway login', 'Run: railway login'),
    ];
  },
  async observe(ctx) {
    const observation = emptyObservation();
    const status = await ctx.transport.exec('railway', ['status', '--json'], { allowFailure: true, timeout: 180_000 });
    if (status.code !== 0) return observation;
    let services: string[] = [];
    try {
      const parsed = JSON.parse(status.stdout);
      services = (parsed?.services?.edges ?? []).map((edge: any) => String(edge?.node?.name ?? '')).filter(Boolean);
      observation.detail.push(`Linked to Railway project ${parsed?.name ?? 'unknown'}`);
    } catch { return observation; }
    observation.database = services.some(name => /postgres/i.test(name));
    observation.app = services.includes(ctx.service);
    if (!observation.app) return observation;
    const variables = await ctx.transport.exec('railway', ['variables', '--service', ctx.service, '--json'], { allowFailure: true, timeout: 180_000 });
    if (variables.code === 0) {
      try {
        const parsed = JSON.parse(variables.stdout) as Record<string, string>;
        observation.installed = Object.keys(parsed).length > 0;
        for (const [name, value] of Object.entries(parsed)) observation.variables[name] = variableMarker(name, String(value));
      } catch { /* an unparsable listing is reported as no observed variables */ }
    }
    const domains = await ctx.transport.exec('railway', ['domain', '--service', ctx.service, '--json'], { allowFailure: true, timeout: 180_000 });
    if (domains.code === 0) {
      const found = /[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.exec(domains.stdout.replace(/https?:\/\//g, ''));
      if (found) observation.url = `https://${found[0]}`;
    }
    return observation;
  },
  plan(ctx, observation) {
    return [
      { id: 'provider.provision.project', target: 'provider', title: `Link or create the Railway project for ${ctx.repository}`, state: observation.detail.length ? 'satisfied' : 'create', command: `railway init --name graphyard-${ctx.installId}` },
      { id: 'provider.provision.database', target: 'provider', title: 'Add the managed Postgres database', state: observation.database ? 'satisfied' : 'create', command: 'railway add --database postgres' },
      { id: 'provider.provision.app', target: 'provider', title: `Add the ${ctx.service} application service built from the repository Dockerfile`, state: observation.app ? 'satisfied' : 'create', command: `railway add --service ${ctx.service}` },
    ];
  },
  async provision(ctx, observation) {
    if (!observation.detail.length) await ctx.transport.exec('railway', ['init', '--name', `graphyard-${ctx.installId}`], { timeout: 600_000 });
    if (!observation.database) await ctx.transport.exec('railway', ['add', '--database', 'postgres'], { timeout: 600_000 });
    if (!observation.app) await ctx.transport.exec('railway', ['add', '--service', ctx.service], { timeout: 600_000 });
  },
  async setEnv(ctx, values) {
    const plain = values.filter(value => !value.secret);
    if (plain.length) await ctx.transport.exec('railway', ['variables', '--service', ctx.service, '--skip-deploys', ...plain.flatMap(value => ['--set', `${value.name}=${value.value}`])], { timeout: 300_000 });
    // Secrets go over standard input: a process argument is visible to every local process.
    for (const secret of values.filter(value => value.secret)) await ctx.transport.exec('railway', ['variable', 'set', '--service', ctx.service, '--skip-deploys', '--stdin', secret.name], { input: secret.value, timeout: 300_000 });
  },
  async deploy(ctx) { await ctx.transport.exec('railway', ['up', '--service', ctx.service, '--ci', '--detach'], { timeout: 1_800_000 }); },
  async url(ctx) {
    const args = ['domain', '--service', ctx.service, '--port', String(SERVER_PORT), ...(ctx.domain ? [ctx.domain] : [])];
    const result = await ctx.transport.exec('railway', args, { timeout: 600_000 });
    const found = /[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.exec(`${result.stdout}\n${ctx.domain ?? ''}`.replace(/https?:\/\//g, ''));
    if (!found) throw new Error('Railway did not return an HTTPS domain for the service');
    return `https://${found[0]}`;
  },
  health: httpHealth,
  async logs(ctx, lines = 100) {
    const result = await ctx.transport.exec('railway', ['logs', '--service', ctx.service, '--lines', String(lines)], { allowFailure: true, timeout: 180_000 });
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
export const secretVariableNames = new Set(['GRAPHYARD_PRINCIPALS', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET']);
const providerReference = /^\$\{\{[^{}]+\}\}$/;
export const carriesCredential = (name: string, value: string) => secretVariableNames.has(name) || (name === 'DATABASE_URL' && !providerReference.test(value.trim()));
export const variableMarker = (name: string, value: string) => carriesCredential(name, value) ? `sha:${fingerprint(value)}` : value;

export const adapters: Record<Provider, ProviderAdapter> = {
  railway: railwayAdapter,
  hetzner: hetznerAdapter,
  'docker-host': dockerHostAdapter,
  compose: composeAdapter,
};

export const adapterFor = (provider: Provider) => adapters[provider];
