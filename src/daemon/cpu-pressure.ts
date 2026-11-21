// Concern: GY-3348 — the host's CPU as the loop reads it before every launch. 'some avg60' from
// /proc/pressure/cpu is the one saturation reading (PSI): the share of recent time at least one
// task waited for a CPU, already averaged by the kernel — unlike a load average that means
// something different on 8 cores than on 24. Above one constant the loop launches nothing new,
// because a saturated host starves the very sessions it starts: on rexera (avg60 94 with
// 10-70 percent steal) every trial timed out into rework, and the caps had to be set by hand.
// Steal percent from /proc/stat names the hypervisor's share, which pressure alone cannot tell
// from the fleet's own load. Both figures ride the loop's presence to the Workers page and master
// status. Where /proc/pressure/cpu is missing (not Linux) the whole check is skipped: launches
// run as they always did, and nothing running is ever stopped.
// GY-3501: a hot CPU sensor never holds a launch. Holding workers for heat they do not cause left
// ready work idle for hours on every install while the hot work ran on; the sensor now governs
// only the work that makes the heat — the trial cap halves (GY-3401, GY-3416: from 5C under
// min(trialHotCelsius, the sensor's own crit-3), a temporary `launchHotCelsius` while it stands)
// and a trial container waits at that same limit, so concurrency restores on its own as the
// reading falls. Where no sensor is readable, nothing waits on heat.
// GY-3426: the reading is the package sensor (the hottest core only where no package sensor exists),
// averaged over the cycles of the last 60 s — one core spikes to 95-100C for a second whenever
// anything starts, and comparing that instant to the limit held nearly every launch on a 60C host.
// GY-3532: the window is 120 s, and the mean decides only once it holds 4 samples (the latest
// before that): turbo spikes are normal on a CPU with a 105C limit.
import type { DaemonState } from './state.js';
import type { DaemonEffects } from './effects.js';
import { heatReading, heatWindowMs, trialHotCelsius } from '../merge-writer/trial-load.js';
import { standingLimit, type MasterRun } from '../master/profiles.js';
import { sessionTestBudget } from '../runner/registry.js';
import { overloadAlarm, overloaded, readSessionUsage } from '../session-share.js';

/** The one constant, no setting: while 'some avg60' reads above this, no new worker, reviewer or trial starts. */
export const cpuPressureCeiling = 85;
/** GY-3416: the trial guard's own heat limit — the trial cap halves from 5C under it; a launch reads it no longer (GY-3501). */
export const launchHotCelsius = trialHotCelsius;
/** GY-3401, GY-3416: from 5C under the limit the trial cap halves. */
export const trialHalfCelsius = trialHotCelsius - 5;

export { heatWindowMs };

/** GY-3446: the trial heat limit now — a temporary `launchHotCelsius` the master set while it stands, else the default. */
const hotLimit = (state: Pick<DaemonState, 'cpuPressure'>) => state.cpuPressure?.hotCelsius ?? launchHotCelsius;

/** The one status line master status carries while launches wait — PSI pressure alone (GY-3501) — or null when nothing holds them. */
export function cpuWaiting(state: Pick<DaemonState, 'cpuPressure'>): string | null {
  const cpu = state.cpuPressure;
  if (cpu?.avg60 != null && cpu.avg60 > cpuPressureCeiling) return `launches waiting: CPU pressure ${Math.round(cpu.avg60)} percent`;
  return null;
}
export const cpuPressureHeld = (state: Pick<DaemonState, 'cpuPressure'>) => cpuWaiting(state) !== null;
/** GY-3501: the implementation hold is the launch hold — heat never holds a worker on its own. */
export const implementationWaiting = cpuWaiting;
/** GY-3401, GY-3416: whether the hottest CPU sensor sits at the trial halving limit. */
export const cpuHot = (state: Pick<DaemonState, 'cpuPressure'>) => (state.cpuPressure?.celsius ?? -Infinity) >= hotLimit(state) - (launchHotCelsius - trialHalfCelsius);
/**
 * GY-3501: whether the heat waits that remain may go — the trial container guard and the heavy
 * checks read the sensor against the same limit. Pressure alone holds launches; the sensor holds
 * no launch, so an environment blocker's heat wait clears only once the reading falls under it.
 */
export const heatClear = (state: Pick<DaemonState, 'cpuPressure'>) => cpuWaiting(state) === null && (state.cpuPressure?.celsius == null || state.cpuPressure.celsius < hotLimit(state));
/**
 * GY-3401: the merge writer's trial cap this cycle. A hot CPU no longer stops every trial: trials
 * running finish, and no new one starts beyond half the cap (at least one, GY-3437) until the reading falls below the limit.
 * A saturated CPU (pressure over its ceiling) still starts none.
 */
export function trialCapNow(state: Pick<DaemonState, 'cpuPressure'>, full: number): number {
  const cpu = state.cpuPressure;
  if (cpu?.avg60 != null && cpu.avg60 > cpuPressureCeiling) return 0;
  return cpuHot(state) ? Math.max(1, Math.floor(full / 2)) : full;
}

export { cpuCelsius } from '../merge-writer/trial-load.js';

/** 'some avg60' of /proc/pressure/cpu: the kernel's own average of the time some task waited for a CPU. */
export function pressureAvg60(text: string): number | null {
  const value = Number(/^some\b[^\n]*\bavg60=([0-9]+(?:\.[0-9]+)?)/m.exec(text)?.[1]);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 100) : null;
}

/** The aggregate `cpu` line of /proc/stat as the counters a steal reading and a busy CPU-seconds reading need. */
export function cpuStatTotals(text: string): { total: number; steal: number; idle: number } | null {
  const fields = /^cpu\s+((?:\d+\s*)+)$/m.exec(text)?.[1]?.trim().split(/\s+/).map(Number);
  if (!fields || fields.length < 8 || fields.some(field => !Number.isFinite(field) || field < 0)) return null;
  // user nice system idle iowait irq softirq steal: guest time is already inside user, so the
  // denominator is the first eight fields — the time the kernel accounted on this CPU.
  return { total: fields.slice(0, 8).reduce((sum, field) => sum + field, 0), steal: fields[7]!, idle: fields[3]! + fields[4]! };
}

/** /proc/stat counts in USER_HZ ticks, 100 a second on Linux. */
const ticksPerSecond = 100;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/**
 * GY-3418: the busy CPU-seconds (not idle, iowait or steal) between two readings, added to the UTC
 * day of `now`. The first day measured stays as the baseline; of the rest only the last eight are
 * kept. A counter that went backwards (a reboot) or a reading without idle adds nothing.
 */
export function tallyCpuSeconds(days: Record<string, number>, previous: { total: number; steal: number; idle?: number } | null, current: { total: number; steal: number; idle: number } | null, now: number) {
  if (!previous || previous.idle === undefined || !current) return;
  const busy = (current.total - current.idle - current.steal) - (previous.total - previous.idle - previous.steal);
  if (!(busy >= 0) || current.total < previous.total) return;
  const today = day(now), first = Object.keys(days).sort()[0] ?? today, oldest = day(now - 7 * 86_400_000);
  days[today] = (days[today] ?? 0) + busy / ticksPerSecond;
  for (const key of Object.keys(days)) if (key !== first && key < oldest) delete days[key];
}

/**
 * GY-3418: CPU-seconds per merged item — the host's busy CPU-seconds over the last 7 days divided by
 * the items merged in them, beside the first measured day's figure and the target, half of it.
 * `mergedAt` is every merged item's merge time. A window with no merge has no figure.
 */
export function cpuPerMergedItem(days: Record<string, number>, mergedAt: readonly string[], now: number) {
  const first = Object.keys(days).sort()[0];
  if (!first) return null;
  const since = day(now - 6 * 86_400_000), merged = mergedAt.map(at => Date.parse(at)).filter(Number.isFinite).map(day);
  const per = (cpu: number, merges: number) => merges ? Math.round(cpu / merges) : null;
  const sevenDays = per(Object.entries(days).filter(([key]) => key >= since).reduce((sum, [, seconds]) => sum + seconds, 0), merged.filter(key => key >= since).length);
  const firstDay = per(days[first]!, merged.filter(key => key === first).length);
  const target = firstDay === null ? null : Math.round(firstDay / 2);
  return { sevenDays, firstDay, target,
    line: `${sevenDays === null ? 'No merge in the last 7 days, so no CPU-seconds per merged item yet' : `${sevenDays} CPU-seconds per merged item over the last 7 days`}; ${target === null
      ? `the target is set once the first measured day (${first}) has a merge` : `target ${target} or less, half the first day's ${firstDay} (${first})`}` };
}

/** Steal percent between two /proc/stat readings: the hypervisor's share of the CPU time that passed between them. */
export function stealPercent(previous: { total: number; steal: number } | null, current: { total: number; steal: number } | null): number | null {
  const time = current && previous ? current.total - previous.total : 0, stolen = current && previous ? current.steal - previous.steal : -1;
  return time > 0 && stolen >= 0 ? Math.min(100, 100 * stolen / time) : null;
}

/**
 * One cycle's reading (GY-3348): the pressure and steal figures the Workers page and master status
 * show, with the counters the next cycle's steal is measured from, kept on the cursor so a restart
 * loses only one reading, and the package sensor's 120 s mean with the readings it is taken over (GY-3373, GY-3426, GY-3532). With neither readable (not Linux) the record clears — launches run and
 * the pages show nothing, exactly as before — and a hold that begins or ends is one journal line.
 */
export async function cpuPressureStep(cycle: { config?: { run: Pick<MasterRun, 'launchHotCelsius'> }; state: DaemonState; effects: DaemonEffects; now: () => number; log: (line: string) => void }) {
  const { state, effects, now, log } = cycle;
  const reading = await Promise.resolve(effects.cpuPressure?.()).catch(() => null) ?? null;
  const avg60 = reading?.pressure ? pressureAvg60(reading.pressure) : null, at = now(), previous = state.cpuPressure, was = cpuWaiting(state);
  const samples = reading?.celsius == null ? [] : [...(previous?.samples ?? []).filter(([when]) => at - when < heatWindowMs && when <= at), [at, reading.celsius] as [number, number]];
  const celsius = heatReading(samples)?.celsius ?? null;
  const stat = avg60 !== null && reading?.stat ? cpuStatTotals(reading.stat) : null, hot = standingLimit(cycle.config?.run.launchHotCelsius, at);
  tallyCpuSeconds((state.cpuSeconds ??= { days: {} }).days, previous?.stat ?? null, stat, now());
  state.cpuPressure = avg60 === null && celsius === null ? null
    : { at: new Date(at).toISOString(), avg60, steal: stealPercent(previous?.stat ?? null, stat), stat, celsius, samples, testBudget: sessionTestBudget(), trialCap: previous?.trialCap ?? null,
      ...(hot === undefined ? {} : { hotCelsius: hot }) };
  const waiting = cpuWaiting(state);
  if (waiting?.split(':')[0] !== was?.split(':')[0]) log(`[graphyard-master] cycle ${state.cycle}: ${!waiting ? 'launches resume' : `${waiting}; no new worker, reviewer or trial starts until it falls`}`);
}

/**
 * GY-3438: every live agent session's use beside its fair share, read from its scope's cgroup each
 * cycle for master status and the Workers page. A session that has used far more than its share of
 * a saturated machine for five minutes is one journal line naming it, logged as its alarm begins;
 * the alarm stands in master status and on the Workers page while it lasts.
 */
export function sessionUsageStep(cycle: { state: DaemonState; effects: DaemonEffects; now: () => number; log: (line: string) => void }) {
  const { state, effects, now, log } = cycle;
  if (!effects.sessionScopes) return;
  const at = now(), raised = new Set(state.sessions.filter(session => overloaded([session], Date.parse(session.at)).length).map(session => session.unit));
  state.sessions = readSessionUsage(state.sessions, at, effects.sessionScopes(), state.cpuPressure?.avg60 ?? null, effects.sessionName, effects.cores?.());
  for (const session of overloaded(state.sessions, at)) if (!raised.has(session.unit)) log(`[graphyard-master] cycle ${state.cycle}: overload: ${overloadAlarm(session, at)}`);
}
