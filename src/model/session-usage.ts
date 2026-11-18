// Concern: GY-3438 — a session's use against its fair share, and the overload alarm, in words master
// status and the Workers page share. Pure: the cgroup reading is src/session-share.ts.

/** The machine is saturated from this 'some avg60' CPU pressure: half the time some task waits for a CPU. */
export const saturatedPressure = 50;
/** A session uses far more than its share from this many times it. */
export const overloadFactor = 2;
/** A session over its share of a saturated machine this long raises the overload alarm. */
export const overloadMs = 5 * 60_000;

export interface SessionUsage { unit: string; name?: string; at: string; usec: number; cpu: number | null; cpuShare: number; memory: number; memoryShare: number; overSince: string | null }

type Usage = Pick<SessionUsage, 'cpu' | 'cpuShare' | 'memory' | 'memoryShare' | 'overSince'> & { name?: string; unit?: string; session?: string };
/** The sessions that have used far more than their share of a saturated machine for five minutes or more: each raises the overload alarm. */
export const overloaded = <T extends Usage>(sessions: readonly T[], now: number) => sessions.filter(session => session.overSince && now - Date.parse(session.overSince) >= overloadMs);
/** The overload alarm's words, naming the session. */
export const overloadAlarm = (session: Usage, now: number) =>
  `Session ${session.session ?? session.name ?? session.unit} has used far more than its share of a saturated machine for ${Math.floor((now - Date.parse(session.overSince ?? new Date(now).toISOString())) / 60_000)} min (${sessionFigures(session)})`;

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;
const cores = (value: number) => `${Number(value.toFixed(1))}`;
/** "CPU 5.1 cores, share 2.7 · memory 3.1 GiB, share 7.1 GiB": a session's use beside its share. */
export const sessionFigures = (session: Pick<SessionUsage, 'cpu' | 'cpuShare' | 'memory' | 'memoryShare'>) =>
  `CPU ${session.cpu === null ? '—' : session.cpu.toFixed(1)} cores, share ${cores(session.cpuShare)} · memory ${gib(session.memory)}, share ${gib(session.memoryShare)}`;
