import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

interface Renewal { lease: { epoch: number; expiresAt: string } | null; updatedAt: string }

export interface Containment {
  command: string;
  args: string[];
  signal: (signal: NodeJS.Signals) => void;
  empty: () => boolean;
}

export function systemdContainment(command: string, args: string[], run: typeof execFileSync = execFileSync): Containment {
  run('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
  const unit = `graphyard-watch-${process.pid}-${randomUUID()}.scope`;
  return {
    command: 'systemd-run',
    args: ['--user', '--scope', '--quiet', `--unit=${unit}`, '--', command, ...args],
    signal: signal => { run('systemctl', ['--user', 'kill', '--kill-whom=all', `--signal=${signal}`, unit], { stdio: 'ignore' }); },
    empty: () => {
      const query = ['--user', 'show', '--property=LoadState', '--property=ActiveState', unit];
      const unloaded = (output: unknown) => String(output ?? '').split(/\r?\n/).some(line => line.trim() === 'LoadState=not-found');
      try {
        const properties = String(run('systemctl', query, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        if (unloaded(properties)) return true;
        const state = properties.split(/\r?\n/).find(line => line.startsWith('ActiveState='))?.slice('ActiveState='.length);
        return state === 'inactive' || state === 'failed';
      } catch (error) {
        // A transient scope may be unloaded between process exit and verification.
        // Only systemd's structured LoadState can turn a failed query into success;
        // transport, manager and all other query failures remain unverifiable.
        if (unloaded((error as { stdout?: unknown }).stdout)) return true;
        throw error;
      }
    },
  };
}

export type ProcessRecord = { ppid: number; identity: string };

export function linuxProcessRecord(stat: string): ProcessRecord | null {
  const end = stat.lastIndexOf(') ');
  if (end < 0) return null;
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]), starttime = fields[19];
  return Number.isSafeInteger(ppid) && ppid >= 0 && /^\d+$/.test(starttime ?? '') ? { ppid, identity: starttime } : null;
}

function processTable(): Map<number, ProcessRecord> {
  const records = new Map<number, ProcessRecord>();
  if (process.platform !== 'linux') return records;
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const record = linuxProcessRecord(readFileSync(`/proc/${name}/stat`, 'utf8'));
        if (record) records.set(Number(name), record);
      } catch {}
    }
  } catch {}
  return records;
}

export function signalTrackedProcesses(rootPid: number, supervisedPids: Map<number, string>, rows: Map<number, ProcessRecord>, signal: NodeJS.Signals, kill: (pid: number, signal: NodeJS.Signals) => void = process.kill) {
  const root = rows.get(rootPid);
  if (root && !supervisedPids.has(rootPid)) supervisedPids.set(rootPid, root.identity);
  const pending = [...supervisedPids.keys()];
  while (pending.length) {
    const parent = pending.shift()!;
    if (rows.get(parent)?.identity !== supervisedPids.get(parent)) {
      supervisedPids.delete(parent);
      continue;
    }
    for (const [pid, record] of rows) if (record.ppid === parent && !supervisedPids.has(pid)) {
      supervisedPids.set(pid, record.identity); pending.push(pid);
    }
  }
  for (const [pid, identity] of [...supervisedPids].reverse()) {
    if (rows.get(pid)?.identity !== identity) { supervisedPids.delete(pid); continue; }
    try { kill(pid, signal); } catch {}
  }
}

// The deadline uses elapsed local time and server-reported duration, not synchronized clocks.
export async function supervise(command: string, args: string[], epoch: number, renew: () => Promise<Renewal>, options: { intervalMs?: number; graceMs?: number; shutdownPollMs?: number; shutdownTimeoutMs?: number; detached?: boolean; containment?: Containment; platform?: NodeJS.Platform; quarantine?: { establish: () => Promise<unknown>; settle: () => Promise<unknown> } } = {}) {
  let deadline = 0;
  async function heartbeat() {
    const started = performance.now();
    const result = await renew();
    const duration = Date.parse(result.lease?.expiresAt ?? '') - Date.parse(result.updatedAt);
    if (result.lease?.epoch !== epoch || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid lease renewal');
    deadline = started + duration;
    if (deadline <= performance.now()) throw new Error('Lease expired during renewal');
  }
  await heartbeat();
  const env = { ...process.env };
  for (const key of ['GRAPHYARD_PRINCIPALS', 'DATABASE_URL', 'GITHUB_PRIVATE_KEY', 'GITHUB_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET']) delete env[key];
  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== 'win32';
  if (!detached && platform !== 'linux' && !options.containment) throw new Error(`Foreground worker supervision requires durable containment and is not supported on ${platform}`);
  const containment = options.containment ?? (!detached && platform === 'linux' ? systemdContainment(command, args) : undefined);
  if (containment && !options.quarantine) throw new Error('Foreground worker supervision requires a durable Graphyard containment quarantine');
  return new Promise<number>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined;
    let stopping = false, pending = false, prelaunchInterrupted = false, finished = false;
    const supervisedPids = new Map<number, string>();
    let containmentFailure: unknown;
    let expiry: ReturnType<typeof setTimeout>;
    let timer: ReturnType<typeof setInterval>;
    const finish = (error: unknown, code?: number) => {
      if (finished) return;
      finished = true;
      process.off('SIGTERM', interrupted); process.off('SIGINT', interrupted);
      if (error) reject(error); else resolve(code!);
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child?.pid) return;
      if (containment) {
        try { containment.signal(signal); return; }
        catch (error) { containmentFailure ??= error; }
      }
      if (detached && platform !== 'win32') { try { process.kill(-child.pid, signal); } catch {} return; }
      if (platform === 'win32') { try { child.kill(signal); } catch {} return; }
      const rows = processTable();
      signalTrackedProcesses(child.pid, supervisedPids, rows, signal);
    };
    const interrupted = () => {
      if (!child) { prelaunchInterrupted = true; return; }
      stop(1);
    };
    function stop(code: number) {
      if (stopping) return;
      stopping = true; clearInterval(timer); clearTimeout(expiry);
      signalGroup('SIGTERM');
      // Keep this timer referenced even if the group leader exits first.
      setTimeout(async () => {
        signalGroup('SIGKILL');
        if (containment) {
          let empty = false, lastVerificationFailure: unknown;
          const shutdownDeadline = performance.now() + (options.shutdownTimeoutMs ?? 2000);
          do {
            try { if (containment.empty()) { empty = true; break; } }
            catch (error) { lastVerificationFailure = error; }
            const remaining = shutdownDeadline - performance.now();
            if (remaining <= 0) break;
            await delay(Math.min(options.shutdownPollMs ?? 50, remaining));
          } while (performance.now() < shutdownDeadline);
          containmentFailure ??= lastVerificationFailure;
          if (!empty) { finish(new Error(`Worker containment shutdown could not be verified${containmentFailure instanceof Error ? `: ${containmentFailure.message}` : ''}`)); return; }
          try { await options.quarantine!.settle(); }
          catch (error) { finish(new Error(`Worker containment shutdown was verified but its Graphyard quarantine could not be settled: ${error instanceof Error ? error.message : String(error)}`)); return; }
        }
        finish(null, code);
      }, options.graceMs ?? 5000);
    }
    const armDeadline = () => { clearTimeout(expiry); expiry = setTimeout(() => stop(1), Math.max(0, deadline - performance.now())); };
    process.on('SIGTERM', interrupted); process.on('SIGINT', interrupted);
    void (async () => {
      try {
        if (containment) await options.quarantine!.establish();
        if (prelaunchInterrupted) {
          if (containment) {
            try { await options.quarantine!.settle(); }
            catch (error) { finish(new Error(`Worker launch was interrupted after its Graphyard quarantine was established, but the quarantine could not be settled: ${error instanceof Error ? error.message : String(error)}`)); return; }
          }
          finish(null, 1);
          return;
        }
        child = spawn(containment?.command ?? command, containment?.args ?? args, { stdio: 'inherit', detached, env });
        timer = setInterval(async () => {
          if (pending || stopping) return;
          pending = true;
          try { await heartbeat(); if (!stopping) armDeadline(); }
          catch { console.error('Graphyard lease cannot be renewed. Stopping worker.'); stop(1); }
          finally { pending = false; }
        }, options.intervalMs ?? 25_000);
        armDeadline();
        child.on('error', error => { console.error(error.message); stop(1); });
        child.on('exit', code => stop(code ?? 1));
      } catch (error) { finish(error); }
    })();
  });
}
