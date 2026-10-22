import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeTransport, type BundleFileRecord, type Transport } from '../src/install/transport.js';
import type { InstallDependencies } from '../src/install/index.js';
import type { Provider } from '../src/install/types.js';
import { ensureDeployKey } from '../src/install/deploy-key.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

export const REPOSITORY = 'owner/project';
export const HEAD_SHA = 'a'.repeat(40);
/** The Graphyard source every harness install builds from: this checkout, never the managed repository, at a fixed commit. */
export const GRAPHYARD_SOURCE = fileURLToPath(new URL('..', import.meta.url));
export const GRAPHYARD_SOURCE_SHA = 'c'.repeat(40);

export async function temporaryRepository(repository = REPOSITORY) {
  const root = await temporaryDirectory('install');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:${repository}.git`], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'project', scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } }));
  return root;
}

/** An ed25519 public key as an OpenSSH line, the form ssh-keygen writes and `gh repo deploy-key list` answers (GY-2010). */
export function openSshPublicKey(comment: string) {
  const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const field = (value: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(value.length); return Buffer.concat([length, value]); };
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64')} ${comment}`;
}
/** The key pair the fake ssh-keygen writes on this machine; the private half is a placeholder ensureDeployKey never reads. */
export const DEPLOY_PUBLIC_KEY = openSshPublicKey('graphyard-merge-writer-install-test-host');

/** `deployKeys`: the deploy keys GitHub lists for the repository, which `gh repo deploy-key add` appends to. */
export interface FakeState { installed: boolean; deployKeys: { id: number; key: string; title: string }[] }

/** The Compose transcript. `installed` switches every probe to the "already there" answer; the local provider runs no provider CLI. */
export function providerResponses(provider: Provider, state: { installed: boolean; workdir: string; service: string; envFile?: string }) {
  if (provider !== 'compose') return [];
  const ps = JSON.stringify([{ Service: 'db', State: 'running' }, { Service: 'server', State: 'running' }]);
  return [
    { match: 'docker version', result: '27.1.1' },
    { match: 'docker compose version', result: '2.29.0' },
    { match: `cat ${state.workdir}/server.env`, result: state.installed ? { stdout: state.envFile ?? '', stderr: '', code: 0 } : { stdout: '', stderr: 'No such file', code: 1 } },
    { match: 'compose --project-directory', result: state.installed ? ps : '' },
  ];
}

/** The gh login's transcript: authenticated, and the repository's deploy keys (GY-2010). Nothing else on GitHub is read or written. */
export function githubResponses(state: FakeState, repository = REPOSITORY) {
  return [
    { match: 'gh auth status', result: `Logged in to github.com account installer` },
    { match: `gh repo deploy-key list -R ${repository}`, result: () => JSON.stringify(state.deployKeys) },
    { match: 'gh repo deploy-key add ', result: (line: string) => {
      const [, file, title] = /deploy-key add (\S+) .*--title (\S+)/.exec(line) ?? [];
      state.deployKeys.push({ id: state.deployKeys.length + 1, key: readFileSync(file, 'utf8').trim(), title });
      return '';
    } },
  ];
}
export interface Harness {
  root: string;
  configHome: string;
  transport: ReturnType<typeof fakeTransport>;
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
  serverUrl?: string;
  envFile?: string;
  service?: string;
  workdir?: string;
  /** GET /api/status's body, or a function answering it per request. */
  statusBody?: unknown;
  healthy?: boolean;
  /** The commit /healthz reports; the pinned Graphyard source's by default. */
  servedCommit?: string | null;
  repository?: string;
  /** Reuse a previous harness's checkout and credential home to exercise a re-run. */
  root?: string;
  configHome?: string;
  /** Transcript lines consulted before the provider's own (first match wins). */
  extraResponses?: { match: string; result: string | { stdout: string; stderr: string; code: number } | ((line: string, input?: string) => string | { stdout: string; stderr: string; code: number }) }[];
  /** The agent registry the fake server holds (GET /api/agent-registry/document). */
  registry?: any;
  /** Deploy keys GitHub already lists for the repository. */
  deployKeys?: FakeState['deployKeys'];
}

/**
 * The roster the fake deployment serves (GY-1879): the last GRAPHYARD_PRINCIPALS the transport was
 * handed, over standard input (local) or in a written env file (Compose).
 */
export function deployedRoster(transport: ReturnType<typeof fakeTransport>): { id: string; role: string; sessionKind?: string; proofs?: string[]; grants?: string[]; token: string }[] {
  const handed = [...transport.commands].reverse().find(command => command.args.includes('GRAPHYARD_PRINCIPALS') && command.input);
  if (handed) return JSON.parse(handed.input!);
  for (const file of [...transport.files.values()].reverse()) {
    const line = file.content.split('\n').find(entry => entry.startsWith('GRAPHYARD_PRINCIPALS='));
    if (line) return JSON.parse(line.slice('GRAPHYARD_PRINCIPALS='.length));
  }
  return [];
}

/** `cat` answering from FILES, what the installer wrote to the fixture's transport, as a real machine would. */
export const catFrom = (files: () => Map<string, BundleFileRecord>) => ({ match: 'cat /', result: (line: string) => files().get(line.slice(4))?.content ?? { stdout: '', stderr: 'No such file', code: 1 } });

export async function harness(options: HarnessOptions): Promise<Harness> {
  const repository = options.repository ?? REPOSITORY;
  const reused = !!(options.root && options.configHome);
  const root = options.root ?? await temporaryRepository(repository);
  const configHome = options.configHome ?? await temporaryDirectory('config');
  const installId = repository.replace('/', '-');
  const service = options.service ?? `graphyard-${installId}`;
  const workdir = options.workdir ?? (options.provider === 'compose' ? `${configHome}/${installId}/compose` : `${configHome}/${installId}`);
  const state: FakeState = { installed: !!options.installed, deployKeys: options.deployKeys ?? [] };
  const responses = [...(options.extraResponses ?? []), ...githubResponses(state, repository), ...providerResponses(options.provider, { installed: state.installed, workdir, service, envFile: options.envFile })];
  const transport = fakeTransport({ responses });
  const serverUrl = options.serverUrl ?? 'http://127.0.0.1:4310';
  const requests: { method: string; url: string; body?: string }[] = [];
  const registry = options.registry ?? { version: 1, revision: 0, updatedAt: null, runtimes: [], models: [], accounts: [], roles: [], sessions: [], refusals: [], lastMutation: null };
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input); const method = String(init.method ?? 'GET');
    requests.push({ method, url, ...(init.body ? { body: String(init.body) } : {}) });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/healthz')) return options.healthy === false ? json(503, { ok: false }) : json(200, { ok: true, commit: options.servedCommit === undefined ? GRAPHYARD_SOURCE_SHA : options.servedCommit });
    if (url.endsWith('/api/agent-registry/document')) return json(200, registry);
    // The served roster (GET /api/principals), as the control plane lists it: ids, roles, kinds, grants and proofs, never tokens.
    if (url.endsWith('/api/principals')) return json(200, { principals: deployedRoster(transport).map(principal => ({ id: principal.id, role: principal.role, sessionKind: principal.sessionKind ?? null, grants: principal.grants ?? [], proofs: principal.proofs ?? [], leases: [] })) });
    if (url.endsWith('/api/agent-registry/apply') && method === 'POST') return json(200, { applied: true });
    if (url.endsWith('/api/status')) return json(200, typeof options.statusBody === 'function' ? options.statusBody() : options.statusBody ?? { actor: { id: `${installId}-operator`, role: 'admin' }, repository });
    // Nothing else is served: a request to GitHub's API is recorded and refused, so a test can prove there was none.
    return json(404, { message: 'unexpected request' });
  }) as unknown as typeof fetch;

  const deps: InstallDependencies = {
    transport: transport as Transport, fetch: fetchImpl, configHome, sourceRoot: GRAPHYARD_SOURCE,
    cliPath: join(root, 'package.json'), hostId: 'install-test-host',
    wait: async () => {}, now: () => Date.now(), log: () => {},
    // The real deploy-key step, with ssh-keygen replaced by one that writes a fixed pair; gh is the recording transport's.
    ensureDeployKey: (installDir, repo, gh) => ensureDeployKey(installDir, repo, gh, { hostname: 'install-test-host', keygen: async args => {
      const file = args[args.indexOf('-f') + 1];
      await writeFile(file, 'placeholder private key: never read by the installer\n', { mode: 0o600 });
      await writeFile(`${file}.pub`, `${DEPLOY_PUBLIC_KEY}\n`, { mode: 0o600 });
      return { stdout: '', stderr: '', code: 0 };
    } }),
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
    root, configHome, transport, state, requests, deps,
    commandLines: () => transport.commands.map(command => [command.program, ...command.args].join(' ')),
    allCommandLines: () => transport.commands.map(command => [command.program, ...command.args].join(' ')),
    cleanup: async () => { if (reused) return; await rm(root, { recursive: true, force: true }); await rm(configHome, { recursive: true, force: true }); },
  };
}

export const allText = (harnessed: Harness, extra: string[] = []) => [
  ...harnessed.allCommandLines(),
  ...harnessed.transport.commands.map(command => command.input ?? ''),
  ...[...harnessed.transport.files.values()].map(file => file.content),
  ...harnessed.requests.map(request => `${request.method} ${request.url} ${request.body ?? ''}`),
  ...extra,
].join('\n');
