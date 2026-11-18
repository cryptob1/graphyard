// Host-level account state shared by every install using the same login home: locked live
// session records for concurrency, and the latest real request with its next check time.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChildProcessError, runChild } from './child-runner.js';

/** Where the host's account records live; `GRAPHYARD_HOST_ACCOUNTS` moves it (the test runner isolates it from the real home). */
export const hostAccountsVariable = 'GRAPHYARD_HOST_ACCOUNTS';
export const hostAccountsRoot = (environment: NodeJS.ProcessEnv = process.env) => environment[hostAccountsVariable] ?? join(homedir(), '.gy', 'accounts');

/** One account's records are keyed by its login home: the path itself, made safe for a file name. */
export const hostAccountKey = (home: string) => `${home.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'home'}-${createHash('sha256').update(home).digest('hex').slice(0, 8)}`;
const accountDirectory = (home: string) => join(hostAccountsRoot(), hostAccountKey(home));

/** What one live session's record names: the install holding it, and what it holds it for. */
export interface HostAccountSession { install: string; pid: number; at: string; role: string; work: string | null; account: string }
interface HeldRecord { fd: number; path: string; install: string }
const held = new Map<string, HeldRecord>(); // by registry session id, this process's own records

// flock locks the inherited open file description, as the verification slots do: the launcher
// process keeps the fd, and the kernel releases the lock on its death, across namespaces.
async function lock(fd: number): Promise<boolean> {
  try { await runChild('flock', ['--exclusive', '--nonblock', '3'], { extraFds: [fd] }); return true; }
  catch (error) {
    if (error instanceof ChildProcessError && error.status === 1 && !error.timedOut) return false;
    throw error;
  }
}
const ownerOf = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; } };

/**
 * Register this install's live session on the account that lives at `home` (GY-3333): a locked
 * `session-<id>` file the calling process holds until the session ends. `clear` removes it — the
 * registry session's end calls it — and the kernel drops it if the process dies first. Best-effort:
 * null when the account names no home or the shared directory cannot be written, in which case the
 * install behaves as it did before any record was shared.
 */
export async function registerHostAccountSession(id: string, home: string | null, session: Omit<HostAccountSession, 'pid'>): Promise<{ clear: () => void } | null> {
  if (!home || held.has(id)) return null;
  let pending: string;
  try {
    const directory = accountDirectory(home);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    pending = join(directory, `session-${id}.${randomUUID()}.pending`);
  } catch { return null; }
  let fd: number;
  try { fd = openSync(pending, 'wx+'); } catch { return null; }
  const path = join(accountDirectory(home), `session-${id}`);
  try {
    writeFileSync(fd, JSON.stringify({ ...session, pid: process.pid }));
    // The record appears with its lock already held, so a reader never counts a session whose
    // holder is gone: the launcher takes the lock before the rename, and loses it only by dying.
    const locked = await lock(fd);
    if (!locked) throw new Error('a new host account session record is already locked');
    renameSync(pending, path);
  } catch {
    try { closeSync(fd); } catch { /* already closed */ }
    try { rmSync(pending, { force: true }); } catch { /* nothing to clean */ }
    return null;
  }
  held.set(id, { fd, path, install: session.install });
  return { clear: () => clearHostAccountSession(id) };
}

/** End this process's registration of registry session `id`, if it holds one; another holder's record is untouched. */
export function clearHostAccountSession(id: string) {
  const record = held.get(id);
  if (!record) return;
  held.delete(id);
  // Renamed away before the fd closes, so no reader counts a freed record on the way past.
  const tomb = `${record.path}.freed-${randomUUID()}`;
  try { renameSync(record.path, tomb); } catch { /* already gone */ }
  try { closeSync(record.fd); } catch { /* already closed */ }
  try { rmSync(tomb, { force: true }); } catch { /* the next read reaps it */ }
}

/** Clear this process's records for `install` whose registry session is no longer live, however its control plane ended it. */
export function clearEndedHostAccountSessions(install: string, live: ReadonlySet<string>) {
  for (const [id, record] of [...held]) if (record.install === install && !live.has(id)) clearHostAccountSession(id);
}

/** Every session record still locked on the account at `home` — this host's live sessions on it, whichever install holds them. A record whose holder died is reaped on the way past. */
export async function hostAccountSessions(home: string): Promise<HostAccountSession[]> {
  let names: string[];
  try { names = readdirSync(accountDirectory(home)); } catch { return []; }
  const sessions: HostAccountSession[] = [];
  for (const name of names) {
    if (!name.startsWith('session-') || name.includes('.')) continue;
    const path = join(accountDirectory(home), name);
    let fd: number;
    try { fd = openSync(path, 'r+'); } catch { continue; } // removed since the listing
    try {
      if (await lock(fd)) {
        // The holder is gone: the kernel dropped its lock, so the session is over. Renamed away
        // before this fd closes, no later reader counts it on the way past.
        const tomb = `${path}.freed-${randomUUID()}`;
        try { renameSync(path, tomb); } catch { /* already gone */ }
        try { rmSync(tomb, { force: true }); } catch { /* the next sweep takes it */ }
        continue;
      }
      const owner = ownerOf<HostAccountSession>(path);
      if (owner) sessions.push(owner);
    } catch { /* an unreadable record holds nothing */ } finally { closeSync(fd); }
  }
  return sessions;
}

/** The last real request on this login, shared by all installs on the host. */
export interface HostAccountCheck { key?: import('./model/registry.js').AccountKey | null; at: string; nextCheck: string; quota: import('./model/registry.js').QuotaObservation }
export function hostAccountCheck(home: string): HostAccountCheck | null {
  return ownerOf<HostAccountCheck>(join(accountDirectory(home), 'check.json'));
}
export function recordHostAccountCheck(home: string, check: HostAccountCheck) {
  const directory = accountDirectory(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'check.json'), pending = `${path}.${randomUUID()}.pending`;
  writeFileSync(pending, JSON.stringify(check), { mode: 0o600 });
  renameSync(pending, path);
}
