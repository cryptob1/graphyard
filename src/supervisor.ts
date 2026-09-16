import { execFileSync, spawn } from 'node:child_process';

interface Renewal { lease: { epoch: number; expiresAt: string } | null; updatedAt: string }

// The deadline uses elapsed local time and server-reported duration, not synchronized clocks.
export async function supervise(command: string, args: string[], epoch: number, renew: () => Promise<Renewal>, options: { intervalMs?: number; graceMs?: number; detached?: boolean } = {}) {
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
  const child = spawn(command, args, { stdio: 'inherit', detached, env });
  return new Promise<number>(resolve => {
    let stopping = false, pending = false;
    const supervisedPids = new Set<number>();
    let expiry: ReturnType<typeof setTimeout>;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (detached && process.platform !== 'win32') { try { process.kill(-child.pid, signal); } catch {} return; }
      supervisedPids.add(child.pid);
      if (process.platform !== 'win32') try {
        const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
        const pending = [...supervisedPids];
        while (pending.length) { const parent = pending.shift()!; for (const [pid, ppid] of rows) if (ppid === parent && !supervisedPids.has(pid)) { supervisedPids.add(pid); pending.push(pid); } }
      } catch {}
      for (const pid of [...supervisedPids].reverse()) try { process.kill(pid, signal); } catch {}
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
