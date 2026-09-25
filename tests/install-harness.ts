import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeTransport, type Transport } from '../src/install/transport.js';
import type { InstallDependencies } from '../src/install/index.js';
import type { Provider } from '../src/install/types.js';

export const REPOSITORY = 'owner/project';
export const GRAPHYARD_APP_ID = 200_001;
export const CI_APP_ID = 15_368;
export const HEAD_SHA = 'a'.repeat(40);

export async function temporaryRepository(repository = REPOSITORY) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-install-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:${repository}.git`], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'project', scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } }));
  return root;
}

export const appKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
export const WEBHOOK_SECRET = 'webhook-secret-for-tests-0123456789';

export interface FakeState { installed: boolean; protection: any | null; deliveries: any[]; hookConfig: { url: string; secret?: string } | null }

export const RAILWAY_WORKSPACES = [{ id: 'ws-graphyard-0001', name: 'Graphyard' }, { id: 'ws-personal-0002', name: "Installer's Projects" }];

/** Provider CLI transcripts. `installed` switches every probe to the "already there" answer. */
export function providerResponses(provider: Provider, state: { installed: boolean; workdir: string; service: string; envFile?: string; workspaces?: { id: string; name: string }[] }) {
  const ps = JSON.stringify([{ Service: 'db', State: 'running' }, { Service: 'server', State: 'running' }]);
  const compose = [
    { match: 'docker version', result: '27.1.1' },
    { match: 'docker compose version', result: '2.29.0' },
    { match: `cat ${state.workdir}/server.env`, result: state.installed ? { stdout: state.envFile ?? '', stderr: '', code: 0 } : { stdout: '', stderr: 'No such file', code: 1 } },
    { match: 'compose --project-directory', result: state.installed ? ps : '' },
  ];
  if (provider === 'compose' || provider === 'docker-host') return compose;
  if (provider === 'hetzner') {
    // The fake becomes stateful at exactly the point a real project does: once the
    // server exists, every later describe answers with its address.
    let created = state.installed;
    return [
      { match: 'hcloud version', result: 'hcloud v1.49.0' },
      { match: 'hcloud context active', result: 'graphyard' },
      { match: 'hcloud server create', result: () => { created = true; return ''; } },
      { match: `hcloud server describe ${state.service}`, result: () => created ? JSON.stringify({ public_net: { ipv4: { ip: '203.0.113.10' } } }) : { stdout: '', stderr: 'server not found', code: 1 } },
      // cloud-init mounted the data volume; the installer refuses to deploy Postgres
      // onto a server whose attached disk never appeared.
      { match: 'findmnt', result: '/dev/disk/by-id/scsi-0HC_Volume_000000\n' },
      ...compose,
    ];
  }
  return [
    { match: 'railway --version', result: 'railway 3.11.0' },
    // The account's workspaces, as `railway whoami --json` reports them; one by default so a
    // plain install resolves the workspace on its own.
    { match: 'railway whoami --json', result: JSON.stringify({ name: 'installer', email: 'installer@example.test', workspaces: state.workspaces ?? RAILWAY_WORKSPACES.slice(0, 1) }) },
    { match: 'railway whoami', result: 'installer@example.test' },
    { match: 'railway status --json', result: state.installed ? JSON.stringify({ name: 'graphyard-owner-project', services: { edges: [{ node: { name: 'Postgres' } }, { node: { name: state.service } }] } }) : { stdout: '', stderr: 'no linked project', code: 1 } },
    { match: 'railway variables', result: state.installed ? (state.envFile ?? '{}') : '{}' },
    { match: 'railway domain', result: 'https://graphyard-owner-project.up.railway.app' },
  ];
}

export function githubResponses(state: FakeState, repository = REPOSITORY, branch = 'main') {
  return [
    { match: 'gh auth status', result: `Logged in to github.com account installer` },
    { match: `gh api repos/${repository}/commits/${branch}/check-runs`, result: JSON.stringify({ check_runs: [{ name: 'test', app: { id: CI_APP_ID, slug: 'github-actions' } }, { name: 'typecheck', app: { id: CI_APP_ID, slug: 'github-actions' } }] }) },
    { match: `gh api repos/${repository}/commits/${branch}`, result: JSON.stringify({ sha: HEAD_SHA }) },
    { match: '--method PUT', result: '{}' },
    { match: `gh api repos/${repository}/branches/${branch}/protection`, result: state.protection ? JSON.stringify(state.protection) : { stdout: '', stderr: 'Branch not protected', code: 1 } },
  ];
}

export const satisfiedProtection = (appId: number | null, reviewCount = 1) => ({
  // `strict` off is part of a satisfied branch: the merge queue supersedes "up to date".
  required_status_checks: { strict: false, checks: [{ context: 'test', app_id: null }, { context: 'typecheck', app_id: null }, ...(appId ? [{ context: 'Graphyard / merge', app_id: appId }] : [])] },
  enforce_admins: { enabled: true },
  // Conversation resolution off: the reviewer's verdict is the review gate, threads are its inputs.
  required_conversation_resolution: { enabled: false },
  required_pull_request_reviews: { required_approving_review_count: reviewCount, dismiss_stale_reviews: true, require_last_push_approval: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
});

export interface Harness {
  root: string;
  configHome: string;
  transport: ReturnType<typeof fakeTransport>;
  remotes: Map<string, ReturnType<typeof fakeTransport>>;
  state: FakeState;
  requests: { method: string; url: string; body?: string }[];
  deps: InstallDependencies;
  commandLines(): string[];
  allCommandLines(): string[];
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  provider: Provider;
  installed?: boolean;
  protection?: any | null;
  serverUrl?: string;
  envFile?: string;
  service?: string;
  workdir?: string;
  statusBody?: unknown;
  healthy?: boolean;
  repository?: string;
  deliveries?: any[];
  /** Reuse a previous harness's checkout and credential home to exercise a re-run. */
  root?: string;
  configHome?: string;
  /** Railway only: the workspaces the fake account belongs to (default: exactly one). */
  workspaces?: { id: string; name: string }[];
}

export async function harness(options: HarnessOptions): Promise<Harness> {
  const repository = options.repository ?? REPOSITORY;
  const reused = !!(options.root && options.configHome);
  const root = options.root ?? await temporaryRepository(repository);
  const configHome = options.configHome ?? await mkdtemp(join(tmpdir(), 'graphyard-config-'));
  const installId = repository.replace('/', '-');
  const service = options.service ?? `graphyard-${installId}`;
  const workdir = options.workdir ?? (options.provider === 'compose' ? `${configHome}/${installId}/compose` : `/opt/graphyard/${installId}`);
  const state: FakeState = { installed: !!options.installed, protection: options.protection ?? null, deliveries: options.deliveries ?? [], hookConfig: null };
  const responses = [...providerResponses(options.provider, { installed: state.installed, workdir, service, envFile: options.envFile, workspaces: options.workspaces }), ...githubResponses(state, repository)];
  const transport = fakeTransport({ responses });
  const remotes = new Map<string, ReturnType<typeof fakeTransport>>();
  const ssh = (host: string) => {
    if (!remotes.has(host)) remotes.set(host, fakeTransport({ responses }));
    return remotes.get(host)! as Transport;
  };
  const serverUrl = options.serverUrl ?? 'https://graphyard-owner-project.up.railway.app';
  const requests: { method: string; url: string; body?: string }[] = [];
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input); const method = String(init.method ?? 'GET');
    requests.push({ method, url, ...(init.body ? { body: String(init.body) } : {}) });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/healthz')) return options.healthy === false ? json(503, { ok: false }) : json(200, { ok: true });
    if (url.endsWith('/api/status')) return json(200, options.statusBody ?? { actor: { id: `${installId}-operator`, role: 'admin' }, repository, github: true, githubAppId: GRAPHYARD_APP_ID, githubInstallationId: 500 });
    if (url.includes('/app/installations/') && url.endsWith('/access_tokens')) return json(201, { token: 'installation-token-for-tests', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (url.endsWith('/app/hook/config') && method === 'PATCH') { state.hookConfig = JSON.parse(String(init.body)); return json(200, state.hookConfig); }
    if (url.endsWith('/app/hook/config')) return json(200, state.hookConfig ?? { url: '', content_type: 'json' });
    if (url.includes('/app/hook/deliveries')) return json(200, state.deliveries);
    if (url.includes('/check-runs') && method === 'POST') {
      state.deliveries = [{ id: 1, event: 'check_run', status_code: 202, delivered_at: new Date().toISOString() }, ...state.deliveries];
      return json(201, { id: 99 });
    }
    return json(404, { message: 'unexpected request' });
  }) as unknown as typeof fetch;

  const deps: InstallDependencies = {
    transport: transport as Transport, ssh, fetch: fetchImpl, configHome, sourceRoot: root,
    cliPath: join(root, 'package.json'), hostId: 'install-test-host',
    wait: async () => {}, now: () => Date.now(), log: () => {},
    githubApp: async request => request.reviewer
      ? { appId: GRAPHYARD_APP_ID + 1, slug: `${request.reviewer}-app`, installationId: 501, privateKey: appKey, webhookSecret: '', botUserId: 900_001 }
      : { appId: GRAPHYARD_APP_ID, slug: 'graphyard-owner-project', installationId: 500, privateKey: appKey, webhookSecret: WEBHOOK_SECRET },
    detectRuntimes: async () => [{ kind: 'claude', program: 'claude', path: '/usr/bin/claude', authenticated: true, reason: 'test runtime' }],
    detectHerdr: async () => ({ available: true, version: 'herdr 0.7.1', reason: 'available' }),
    registerProfiles: async request => ({
      repository: { connected: true, herdr: request.herdr.available, detail: 'test' },
      master: { configured: true, kind: request.masterKind, detail: 'test' },
      workers: request.workers.map(worker => ({ name: worker.name, principal: worker.principal, kind: worker.kind })),
      reviewers: request.reviewers,
    }),
  };

  return {
    root, configHome, transport, remotes, state, requests, deps,
    commandLines: () => transport.commands.map(command => [command.program, ...command.args].join(' ')),
    allCommandLines: () => [...transport.commands, ...[...remotes.values()].flatMap(remote => remote.commands)].map(command => [command.program, ...command.args].join(' ')),
    cleanup: async () => { if (reused) return; await rm(root, { recursive: true, force: true }); await rm(configHome, { recursive: true, force: true }); },
  };
}

export const allText = (harnessed: Harness, extra: string[] = []) => [
  ...harnessed.allCommandLines(),
  ...[...harnessed.transport.commands, ...[...harnessed.remotes.values()].flatMap(remote => remote.commands)].map(command => command.input ?? ''),
  ...[...harnessed.transport.files.values(), ...[...harnessed.remotes.values()].flatMap(remote => [...remote.files.values()])].map(file => file.content),
  ...harnessed.requests.map(request => `${request.method} ${request.url} ${request.body ?? ''}`),
  ...extra,
].join('\n');
