// Concern: GY-3438 — a session's use against its CPU and memory caps, and the overload alarm, in
// words master status and the Workers page share. Pure: the cgroup reading is src/session-share.ts.

/** A session counts as at its cap from this fraction of its CPU quota or memory limit. */
export const atCapFraction = 0.9;
/** A session at its cap this long raises the overload alarm. */
export const overloadMs = 5 * 60_000;

export interface SessionUsage { unit: string; name?: string; at: string; usec: number; cpu: number | null; cpuCap: number; memory: number; memoryCap: number | null; atCapSince: string | null }

type Usage = Pick<SessionUsage, 'cpu' | 'cpuCap' | 'memory' | 'memoryCap' | 'atCapSince'> & { name?: string; unit?: string; session?: string };
/** The sessions at their cap for five minutes or more: each raises the overload alarm. */
export const overloaded = <T extends Usage>(sessions: readonly T[], now: number) => sessions.filter(session => session.atCapSince && now - Date.parse(session.atCapSince) >= overloadMs);
/** The overload alarm's words, naming the session and the cap it sits at. */
export function overloadAlarm(session: Usage, now: number) {
  const cpuAt = session.cpu !== null && session.cpu >= session.cpuCap * atCapFraction;
  return `Session ${session.session ?? session.name ?? session.unit} has sat at its ${cpuAt ? 'CPU' : 'memory'} cap for ${Math.floor((now - Date.parse(session.atCapSince ?? new Date(now).toISOString())) / 60_000)} min (${sessionFigures(session)})`;
}

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;
/** "CPU 1.9 of 2 cores · memory 3.1 of 5.3 GiB": a session's use against its caps. */
export const sessionFigures = (session: Pick<SessionUsage, 'cpu' | 'cpuCap' | 'memory' | 'memoryCap'>) =>
  `CPU ${session.cpu === null ? '—' : session.cpu.toFixed(1)} of ${Number(session.cpuCap.toFixed(1))} cores · memory ${gib(session.memory)} of ${session.memoryCap === null ? 'no cap' : gib(session.memoryCap)}`;
