import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConnection, hostIdSchema } from '../repository-setup.js';
import { readCredentialFile } from '../master.js';
import { isConfirmedCoordinationRefusal } from '../quarantine.js';
import { packageVersion } from '../release.js';
import { cliCommit } from '../protocol-version.js';

/** How long one CLI request waits (2026-09-27: the full work snapshot reached 19 MB and ~31 s, so a 30 s bound failed every read of it, including workers' sync and complete; GY-864 bounds those reads). */
export const cliRequestTimeoutMs = 120_000;
/** How long the per-invocation release probe waits for /healthz before the invocation proceeds unread: an unreachable or slow health endpoint is not evidence of skew (GY-1960). */
export const releaseProbeTimeoutMs = 5_000;
const commitPattern = /^[0-9a-f]{40}$/i;

/** The refusal a CLI and a server at different releases name: both releases, and the remedy (GY-1960). */
export const versionSkewMessage = (cliRelease: string, serverRelease: string) => `CLI ${cliRelease} and server ${serverRelease} differ: run graphyard upgrade`;

/** What each side of a CLI request runs: the stamped release version, and the commit an unreleased build runs. */
export interface ReleaseIdentity { version: string; released: boolean; commit: string | null }

/**
 * Why this CLI refuses its server, or null. A server that names no release says nothing about
 * skew, so the invocation proceeds as before — that is what keeps a stub, an old plane, or a
 * probe that timed out from refusing anything. A released CLI (a stamped GRAPHYARD_VERSION)
 * compares versions: equal versions behave as today. An unreleased build compares the commit it
 * runs against the server's, falling back to versions when either commit is unknown; the loop's
 * own exchange keeps its separate MERGE_PROTOCOL check (src/protocol-version.ts).
 */
export function releaseSkew(cli: ReleaseIdentity, server: { version?: unknown; commit?: unknown } | null): string | null {
  if (!server) return null;
  const serverVersion = typeof server.version === 'string' && server.version.trim() ? server.version.trim() : null;
  if (!serverVersion) return null;
  if (!cli.released) {
    const raw = typeof server.commit === 'string' ? server.commit.trim().toLowerCase() : null;
    const serverCommit = raw && commitPattern.test(raw) ? raw : null;
    if (cli.commit && serverCommit) return cli.commit === serverCommit ? null : versionSkewMessage(`commit ${cli.commit}`, `commit ${serverCommit}`);
  }
  return cli.version === serverVersion ? null : versionSkewMessage(cli.version, serverVersion);
}

/** This CLI's own release: the stamped version when the build carries one, else the commit of the checkout this file runs from. */
const thisRelease = (): ReleaseIdentity => ({
  version: process.env.GRAPHYARD_VERSION || packageVersion,
  released: !!process.env.GRAPHYARD_VERSION,
  commit: cliCommit(fileURLToPath(new URL('../../', import.meta.url))),
});

/** The release /healthz serves — no credential needed — or null when it cannot be read or names none. */
const readServerRelease = async (base: string): Promise<{ version?: unknown; commit?: unknown } | null> => {
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/healthz`, { signal: AbortSignal.timeout(releaseProbeTimeoutMs) });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === 'object' ? body : null;
  } catch { return null; }
};

export type Connection = Awaited<ReturnType<typeof loadConnection>>;

/**
 * What every command module receives: the parsed invocation, the resolved server and
 * credential, and the authenticated request helper. Command modules never read
 * `process.argv` or the connection file themselves.
 */
export interface CliContext {
  /** The command word, its first positional, and everything after it. */
  command: string; id: string | undefined; args: string[];
  /** Every argument after the command word, for commands that parse their own flags. */
  rest: string[];
  /** The Graphyard origin this invocation talks to. */
  base: string;
  /** The repository's connection file, or null for commands that must never read it. */
  connection: Connection | null;
  /** Authenticated request against `base`; GET without a body, POST with one. */
  api(path: string, data?: unknown, requestId?: string): Promise<any>;
  print(value: unknown): void;
  individualToken(): Promise<string | undefined>;
  individualHostId(): string;
  activeCliPath(): Promise<string>;
  /** GRAPHYARD_REPOSITORY_ROOT when set, else the Git toplevel of the current working directory. */
  repositoryRoot(): string;
}

export const cliPath = fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url));

/**
 * Resolve the connection and credential for one invocation. The master and the host
 * attestor never use the repository's connection file: each has a credential of its own,
 * read-only and named by its own configuration, precisely so the identity that invokes it
 * cannot choose which credential, or which server, it verifies against.
 */
export async function createContext(command: string, id: string | undefined, args: string[], readsConnection: boolean): Promise<CliContext> {
  let connection: Connection = null;
  if (readsConnection) try { connection = await loadConnection(process.cwd()); } catch { console.error('Invalid or insecure Graphyard connection file. Inspect local configuration; credential values are omitted.'); process.exit(1); }
  const base = process.env.GRAPHYARD_URL ?? connection?.url ?? 'http://127.0.0.1:4310';
  let savedToken: string | undefined;
  try { if (connection && new URL(base).origin === connection.url) savedToken = connection.token; } catch { /* request validation reports an invalid URL */ }
  let resolvedToken: string | undefined; let tokenResolved = false;
  let ownRelease: ReleaseIdentity | null = null;
  let releaseProbe: Promise<{ version?: unknown; commit?: unknown } | null> | null = null;
  const individualToken = async () => {
    if (!tokenResolved) {
      resolvedToken = process.env.GRAPHYARD_TOKEN_FILE ? await readCredentialFile(resolve(process.env.GRAPHYARD_TOKEN_FILE)) : process.env.GRAPHYARD_TOKEN ?? savedToken;
      tokenResolved = true;
    }
    return resolvedToken;
  };
  const api = async (path: string, data?: unknown, requestId = process.env.GRAPHYARD_REQUEST_ID ?? randomUUID()) => {
    // GY-1960: once per invocation the CLI reads the release /healthz serves and refuses a skewed
    // pair by name, instead of sending a request the server's schemas answer as a bare 400.
    ownRelease ??= thisRelease();
    const skew = releaseSkew(ownRelease, await (releaseProbe ??= readServerRelease(base)));
    if (skew) throw new Error(skew);
    const token = await individualToken();
    if (!token) throw new Error('Set GRAPHYARD_TOKEN to your individual credential');
    const response = await fetch(`${base}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(cliRequestTimeoutMs) });
    const body = await response.json();
    if (!response.ok) {
      // 'Invalid input' is what a request this server's schema predates reads as. When the server
      // answers at a release other than this CLI's — including one it moved to after the read
      // above — that answer is the skew, and it is named as the skew instead.
      if (response.status === 400 && body && typeof body === 'object' && (body as any).error === 'Invalid input') {
        const skewNow = releaseSkew(ownRelease, await readServerRelease(base));
        if (skewNow) { const named: any = new Error(skewNow); named.status = 400; throw named; }
      }
      const error = new Error(JSON.stringify(body)); (error as any).confirmedRefusal = isConfirmedCoordinationRefusal(response.status, body); (error as any).status = response.status; throw error;
    }
    return body;
  };
  return {
    command, id, args, rest: process.argv.slice(3), base, connection, api,
    print: value => console.log(JSON.stringify(value, null, 2)),
    individualToken,
    individualHostId: () => hostIdSchema.parse(process.env.GRAPHYARD_HOST_ID ?? connection?.hostId ?? hostname()),
    activeCliPath: async () => {
      const selected = process.env.GRAPHYARD_CLI ?? cliPath;
      if (!selected.trim()) throw new Error('GRAPHYARD_CLI must name an existing launcher');
      try {
        const path = await realpath(resolve(selected));
        if (!(await stat(path)).isFile()) throw new Error();
        return path;
      } catch { throw new Error('The active Graphyard CLI launcher is unavailable; select an existing launcher'); }
    },
    // GY-866: a session started in its own checkout is handed the coordinator's root by its launch.
    repositoryRoot: () => process.env.GRAPHYARD_REPOSITORY_ROOT?.trim() ? resolve(process.env.GRAPHYARD_REPOSITORY_ROOT) : execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
  };
}

/** Read the whole of stdin as one credential, refusing oversized input before it is kept. */
export async function readSecretFromStdin(limit: number, tooLarge = 'Token input is too large') {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > limit) throw new Error(tooLarge); }
  return input.trim();
}

/**
 * The one item a command names, by id or display key, read alone through `GET /api/work/:id`
 * (GY-1377): never the whole fleet, whose download a heartbeat would repeat on every renewal.
 * An absent id or a 404 is the same refusal the fleet lookup gave.
 */
export async function resolveWork(api: CliContext['api'], id: string | undefined): Promise<any> {
  if (!id) throw new Error(`Unknown work item ${id}`);
  try { return await api(`work/${encodeURIComponent(id)}`); } catch (error: any) {
    if (error?.status === 404) throw new Error(`Unknown work item ${id}`);
    throw error;
  }
}
