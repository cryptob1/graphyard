import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConnection, hostIdSchema } from '../repository-setup.js';
import { readCredentialFile } from '../master.js';
import { isConfirmedCoordinationRefusal } from '../quarantine.js';

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
  /** The Git toplevel of the current working directory. */
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
  const individualToken = async () => {
    if (!tokenResolved) {
      resolvedToken = process.env.GRAPHYARD_TOKEN_FILE ? await readCredentialFile(resolve(process.env.GRAPHYARD_TOKEN_FILE)) : process.env.GRAPHYARD_TOKEN ?? savedToken;
      tokenResolved = true;
    }
    return resolvedToken;
  };
  const api = async (path: string, data?: unknown, requestId = process.env.GRAPHYARD_REQUEST_ID ?? randomUUID()) => {
    const token = await individualToken();
    if (!token) throw new Error('Set GRAPHYARD_TOKEN to your individual credential');
    const response = await fetch(`${base}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
    const body = await response.json();
    if (!response.ok) { const error = new Error(JSON.stringify(body)); (error as any).confirmedRefusal = isConfirmedCoordinationRefusal(response.status, body); throw error; }
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
    repositoryRoot: () => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
  };
}

/** Read the whole of stdin as one credential, refusing oversized input before it is kept. */
export async function readSecretFromStdin(limit: number, tooLarge = 'Token input is too large') {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > limit) throw new Error(tooLarge); }
  return input.trim();
}
