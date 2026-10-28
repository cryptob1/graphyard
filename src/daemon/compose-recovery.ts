// Concern: bringing a stopped compose control plane back (GY-2966) — when the loop cannot reach it, `docker compose up -d` in the install's compose directory, and what master status says about it.
import type { ChildRun } from '../child-runner.js';
import type { DaemonState } from './state.js';
import { message } from './state.js';

/** How long the control plane must be unreachable before the loop starts its server, and how often it tries again. */
export const composeRestartAfterMs = 120_000, composeRestartEveryMs = 300_000;

/** A compose install's server, as the loop drives it: its compose directory, the restart, and the readings master status names. */
export interface ComposeServer {
  directory: string;
  up(): Promise<string>;
  /** The server container's state and the last error line it logged, e.g. `Exited (1) 3 minutes ago: Error: Connection terminated unexpectedly`. */
  exitReason(): Promise<string>;
  /** The free space of the volume holding Docker's data. */
  freeDisk(): Promise<string>;
}

const reading = (read: () => Promise<string>) => read().catch(error => `unreadable: ${message(error).slice(0, 200)}`);

export function composeServer(directory: string, run: ChildRun): ComposeServer {
  const compose = async (args: string[], timeoutMs = 30_000) => String(await run('docker', ['compose', ...args], { cwd: directory, timeoutMs }));
  return {
    directory,
    up: async () => (await compose(['up', '-d'], 300_000)).trim(),
    exitReason: () => reading(async () => {
      const listed = (await compose(['ps', '-a', '--format', 'json', 'server'])).trim();
      const entry = [JSON.parse(listed.startsWith('[') ? listed : `[${listed.split('\n').join(',')}]`)].flat()[0];
      const logged = (await compose(['logs', '--no-log-prefix', '--tail', '50', 'server'])).split('\n').filter(line => /error/i.test(line)).at(-1)?.trim();
      return `${entry?.Status ?? 'no server container'}${logged ? `: ${logged}` : ''}`;
    }),
    freeDisk: () => reading(async () => {
      const root = String(await run('docker', ['info', '--format', '{{.DockerRootDir}}'], { timeoutMs: 30_000 })).trim() || '/var/lib/docker';
      const [, , , available, , mount] = String(await run('df', ['-Pk', root], { timeoutMs: 30_000 })).trim().split('\n').at(-1)!.split(/\s+/);
      return `${(Number(available) / 1024 ** 2).toFixed(1)} GiB free on ${mount} (Docker data at ${root})`;
    }),
  };
}

/**
 * After a cycle: a reachable control plane clears the record; one the snapshot could not reach is
 * dated from its first failure, and once that is `composeRestartAfterMs` old on a compose install,
 * the loop runs `docker compose up -d` there at most once per `composeRestartEveryMs`, logging the
 * result with the server's last exit reason and the free disk space master status then shows.
 */
export async function noteControlPlane(state: DaemonState, failure: { call: string | null; reason: string; answered: boolean } | null, now: number, server: (() => ComposeServer | null | Promise<ComposeServer | null>) | undefined, log: (line: string) => void) {
  if (!failure) {
    if (state.controlPlane) log(`[graphyard-master] the control plane answers again after being unreachable since ${state.controlPlane.unreachableSince}`);
    state.controlPlane = null;
    return;
  }
  // Only a snapshot that got no answer is an unreachable plane; a refusal or a failing step is not.
  if (failure.call !== 'snapshot' || failure.answered) return;
  const at = new Date(now).toISOString();
  const record = state.controlPlane ??= { unreachableSince: at, error: failure.reason, restartedAt: null, restart: null, exitReason: null, freeDisk: null };
  record.error = failure.reason;
  if (now - Date.parse(record.unreachableSince) < composeRestartAfterMs) return;
  if (record.restartedAt && now - Date.parse(record.restartedAt) < composeRestartEveryMs) return;
  const compose = await Promise.resolve(server?.()).catch(() => null);
  if (!compose) return;
  record.restartedAt = at;
  [record.exitReason, record.freeDisk] = await Promise.all([compose.exitReason(), compose.freeDisk()]);
  record.restart = await compose.up().then(output => `started${output ? `: ${output.slice(-300)}` : ''}`, error => `failed: ${message(error).slice(0, 300)}`);
  log(`[graphyard-master] the control plane has been unreachable since ${record.unreachableSince} (${record.error}); ran docker compose up -d in ${compose.directory}: ${record.restart}; the server's last exit: ${record.exitReason}; ${record.freeDisk}`);
}
