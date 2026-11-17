// Concern: GY-3333 — an agent account is a host-level resource. One machine runs several Graphyard
// installs that point at the same login homes (~/.coding_agents/NAME), and each install's registry
// counts that account's live sessions and quota holds only for itself. The records here are the
// shared truth beside those homes, in the style of the machine-wide trial slots under ~/.gy: a live
// session is a locked file its install's launcher process holds (the kernel drops the lock — and so
// the session — when that process dies, so nothing leaks), and an account one install marks
// exhausted until a time is read by every install until that time. Each install keeps its own
// registry and roles; only the session count and the quota state are shared. No daemon, no new
// service, no new setting: an install alone on a host, or a host whose shared directory cannot be
// written, behaves exactly as before.
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

/** An account one install marked exhausted: it holds every install until `until`, and names who marked it and why. */
export interface HostAccountExhaustion { by: string; reason: string; at: string; until: string; /** Whether the provider named the reset (`named`) or the marking install assumed one (`guessed`). */ session: 'named' | 'guessed' }
/**
 * The hold a limit notice places, as a host record carries it: until the reset the provider named,
 * or for the hour every executor assumes when it named none (`unknownResetHoldMs`, written out to
 * keep this module free of the master's import cycle).
 */
const unnamedResetHoldMs = 3_600_000;
export const exhaustionHold = (resetsAt: string | null, now: number): { until: string; session: 'named' | 'guessed' } => {
  const reset = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return Number.isFinite(reset) && reset > now ? { until: resetsAt!, session: 'named' } : { until: new Date(now + unnamedResetHoldMs).toISOString(), session: 'guessed' };
};

/**
 * Record beside the login home that this install holds the account exhausted until `until`
 * (GY-3333): the account's quota state is shared by every install on the host, so a limit one
 * install's session reported is not rediscovered by another install's session. A later mark
 * replaces an earlier one; a mark whose time has passed is read by nobody.
 */
export function markHostAccountExhausted(home: string, mark: HostAccountExhaustion) {
  const directory = accountDirectory(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'exhausted.json'), pending = `${path}.${randomUUID()}.pending`;
  writeFileSync(pending, JSON.stringify(mark));
  renameSync(pending, path);
}

/** The hold another install left on the account at `home`, or null when none still holds. */
export function hostAccountExhaustion(home: string, now = Date.now()): HostAccountExhaustion | null {
  const mark = ownerOf<HostAccountExhaustion>(join(accountDirectory(home), 'exhausted.json'));
  return mark && Date.parse(mark.until) > now ? mark : null;
}
