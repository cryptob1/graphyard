import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

interface Renewal { lease: { epoch: number; expiresAt: string } | null; updatedAt: string }

interface Containment {
  command: string;
  args: string[];
  signal: (signal: NodeJS.Signals) => void;
}

export function systemdContainment(command: string, args: string[], run: typeof execFileSync = execFileSync): Containment {
  run('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
  const unit = `graphyard-watch-${process.pid}-${randomUUID()}.scope`;
  return {
    command: 'systemd-run',
    args: ['--user', '--scope', '--quiet', `--unit=${unit}`, '--', command, ...args],
    signal: signal => { try { run('systemctl', ['--user', 'kill', '--kill-whom=all', `--signal=${signal}`, unit], { stdio: 'ignore' }); } catch {} },
  };
}

export type ProcessRecord = { ppid: number; identity: string };

function processTable(): Map<number, ProcessRecord> {
  const records = new Map<number, ProcessRecord>();
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,ppid=,lstart='], { encoding: 'utf8' });
    for (const row of output.trim().split('\n')) {
      const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (match) records.set(Number(match[1]), { ppid: Number(match[2]), identity: match[3] });
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
export async function supervise(command: string, args: string[], epoch: number, renew: () => Promise<Renewal>, options: { intervalMs?: number; graceMs?: number; detached?: boolean; containment?: Containment } = {}) {
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
  const detached = options.detached ?? process.platform !== 'win32';
  const containment = options.containment ?? (!detached && process.platform === 'linux' ? systemdContainment(command, args) : undefined);
  const child = spawn(containment?.command ?? command, containment?.args ?? args, { stdio: 'inherit', detached, env });
  return new Promise<number>(resolve => {
    let stopping = false, pending = false;
    const supervisedPids = new Map<number, string>();
    let expiry: ReturnType<typeof setTimeout>;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (containment) { containment.signal(signal); return; }
      if (detached && process.platform !== 'win32') { try { process.kill(-child.pid, signal); } catch {} return; }
      if (process.platform === 'win32') { try { child.kill(signal); } catch {} return; }
      const rows = processTable();
      signalTrackedProcesses(child.pid, supervisedPids, rows, signal);
    };
    const interrupted = () => stop(1);
    function stop(code: number) {
      if (stopping) return;
      stopping = true; clearInterval(timer); clearTimeout(expiry);
      signalGroup('SIGTERM');
      // Keep this timer referenced even if the group leader exits first.
      setTimeout(() => {
        signalGroup('SIGKILL');
        process.off('SIGTERM', interrupted); process.off('SIGINT', interrupted);
        resolve(code);
      }, options.graceMs ?? 5000);
    }
    const armDeadline = () => { clearTimeout(expiry); expiry = setTimeout(() => stop(1), Math.max(0, deadline - performance.now())); };
    const timer = setInterval(async () => {
      if (pending || stopping) return;
      pending = true;
      try { await heartbeat(); if (!stopping) armDeadline(); }
      catch { console.error('Graphyard lease cannot be renewed. Stopping worker.'); stop(1); }
      finally { pending = false; }
    }, options.intervalMs ?? 25_000);
    armDeadline();
    process.on('SIGTERM', interrupted); process.on('SIGINT', interrupted);
    child.on('error', error => { console.error(error.message); stop(1); });
    child.on('exit', code => stop(code ?? 1));
  });
}
