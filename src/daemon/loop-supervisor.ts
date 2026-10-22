// Concern: GY-916 — the loop's own supervisor unit: detecting it from the process's cgroup, telling a
// self-restart that succeeded (the unit's stop ended the awaited systemctl) from one that failed, and
// re-applying the unit before the loop re-executes through it — with its ExecStart following the
// held-cli pin (GY-1790). Split out of upgrade.ts, which re-exports it.
import { readFileSync } from 'node:fs';

/** The supervisor unit the loop itself runs under, when systemd supervises it: read from the process's own cgroup, like an executor's. */
export const loopUnitPattern = /^graphyard-master(?:[@.-][A-Za-z0-9@._:-]*)?\.service$/;
export function detectLoopSupervisorUnit(options: { cgroup?: string | null } = {}): string | null {
  let cgroup = options.cgroup;
  if (cgroup === undefined) { try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); } catch { cgroup = null; } }
  const match = cgroup?.match(/\/(graphyard-master[^/\s]*\.service)(?:\/|$)/m);
  return match && loopUnitPattern.test(match[1]) ? match[1] : null;
}

/**
 * Whether the awaited `systemctl --no-block restart` ended because the restart it queued began
 * (GY-916). The loop asks systemd to restart the very unit it runs in, so the queued stop signals
 * the unit's whole cgroup — the systemctl child and the loop alike — while the loop still awaits
 * that child. The child then dies on the stop's signal instead of exiting: that is the hand-off
 * succeeding, observable in the journal as Stopping → Stopped → Started in the same second. Both
 * halves are required: the child ended by a stop signal with no exit status and no timeout of its
 * own, and the loop itself received the stop during the wait (`awaitSupervisorRestart` marks it).
 * A child signalled by anything else, a systemctl that exited non-zero (no such unit, no user
 * bus, access denied), or one cut off by its own timeout is a genuine failure and is recorded.
 */
export function restartEndedBySupervisorStop(error: unknown): boolean {
  const ended = error as { signal?: unknown; status?: unknown; timedOut?: unknown; supervisorStop?: unknown } | null;
  return !!ended && typeof ended === 'object' && ended.supervisorStop === true && typeof ended.signal === 'string' && supervisorStopSignals.includes(ended.signal)
    && (ended.status === null || ended.status === undefined) && ended.timedOut !== true;
}
/** The signals a unit's stop delivers to its cgroup: KillSignal, then SIGKILL past TimeoutStopSec. */
const supervisorStopSignals = ['SIGTERM', 'SIGKILL'];
/** How long a signalled child waits for the loop's own stop signal to arrive beside it; both come from one stop. */
export const supervisorStopGraceMs = 2_000;
type SignalHost = Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>;

/**
 * Runs the self-restart while watching for the supervisor's stop to reach this process (GY-916).
 * When the restart child fails on a signal, the stop that killed it reaches the loop in the same
 * instant, so it is awaited for at most `graceMs`; the failure is rethrown marked with whether it
 * came — the mark `restartEndedBySupervisorStop` requires.
 */
export async function awaitSupervisorRestart(restart: () => unknown, host: SignalHost = process, graceMs = supervisorStopGraceMs): Promise<void> {
  let stopped = false, wake: (() => void) | null = null;
  const onStop = () => { stopped = true; wake?.(); };
  host.on('SIGTERM', onStop);
  try { await restart(); }
  catch (error) {
    const signalled = !!error && typeof error === 'object' && typeof (error as { signal?: unknown }).signal === 'string';
    if (signalled && !stopped) await new Promise<void>(resolve => { const timer = setTimeout(resolve, graceMs); wake = () => { clearTimeout(timer); resolve(); }; });
    throw error && typeof error === 'object' ? Object.assign(error, { supervisorStop: stopped }) : error;
  } finally { host.removeListener('SIGTERM', onStop); }
}
