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
import type { DaemonState } from './state.js';
import type { DaemonEffects } from './effects.js';

/** The one constant, no setting: while 'some avg60' reads above this, no new worker, reviewer or trial starts. */
export const cpuPressureCeiling = 85;

/** The one status line master status carries while launches wait (GY-3348), with the figure rounded. */
export const cpuWaitingLine = (avg60: number) => `launches waiting: CPU pressure ${Math.round(avg60)} percent`;

/** Whether the last reading holds new launches: avg60 above the ceiling. A missing reading (or file) holds nothing. */
export function cpuPressureHeld(state: Pick<DaemonState, 'cpuPressure'>): boolean {
  return !!state.cpuPressure && state.cpuPressure.avg60 > cpuPressureCeiling;
}

/** 'some avg60' of /proc/pressure/cpu: the kernel's own average of the time some task waited for a CPU. */
export function pressureAvg60(text: string): number | null {
  const value = Number(/^some\b[^\n]*\bavg60=([0-9]+(?:\.[0-9]+)?)/m.exec(text)?.[1]);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 100) : null;
}

/** The aggregate `cpu` line of /proc/stat as the two counters a steal reading needs. */
export function cpuStatTotals(text: string): { total: number; steal: number } | null {
  const fields = /^cpu\s+((?:\d+\s*)+)$/m.exec(text)?.[1]?.trim().split(/\s+/).map(Number);
  if (!fields || fields.length < 8 || fields.some(field => !Number.isFinite(field) || field < 0)) return null;
  // user nice system idle iowait irq softirq steal: guest time is already inside user, so the
  // denominator is the first eight fields — the time the kernel accounted on this CPU.
  return { total: fields.slice(0, 8).reduce((sum, field) => sum + field, 0), steal: fields[7]! };
}

/** Steal percent between two /proc/stat readings: the hypervisor's share of the CPU time that passed between them. */
export function stealPercent(previous: { total: number; steal: number } | null, current: { total: number; steal: number } | null): number | null {
  const time = current && previous ? current.total - previous.total : 0, stolen = current && previous ? current.steal - previous.steal : -1;
  return time > 0 && stolen >= 0 ? Math.min(100, 100 * stolen / time) : null;
}

/**
 * One cycle's reading (GY-3348): the pressure and steal figures the Workers page and master status
 * show, with the counters the next cycle's steal is measured from, kept on the cursor so a restart
 * loses only one reading. A missing pressure file (not Linux) clears the record — launches run and
 * the pages show nothing, exactly as before — and a hold that begins or ends is one journal line.
 */
export async function cpuPressureStep(cycle: { state: DaemonState; effects: DaemonEffects; now: () => number; log: (line: string) => void }) {
  const { state, effects, now, log } = cycle;
  const reading = await Promise.resolve(effects.cpuPressure?.()).catch(() => null) ?? null;
  const avg60 = reading ? pressureAvg60(reading.pressure) : null;
  if (avg60 === null) {
    if (cpuPressureHeld(state)) log(`[graphyard-master] cycle ${state.cycle}: launches resume: no CPU pressure reading (the file is missing, so the check is skipped)`);
    state.cpuPressure = null;
    return;
  }
  const previous = state.cpuPressure;
  const stat = reading && reading.stat !== null ? cpuStatTotals(reading.stat) : null;
  state.cpuPressure = { at: new Date(now()).toISOString(), avg60, steal: stealPercent(previous?.stat ?? null, stat), stat };
  const waiting = avg60 > cpuPressureCeiling;
  if (waiting !== cpuPressureHeld({ cpuPressure: previous })) log(waiting
    ? `[graphyard-master] cycle ${state.cycle}: ${cpuWaitingLine(avg60)} (above ${cpuPressureCeiling}); no new worker, reviewer or trial starts until it falls`
    : `[graphyard-master] cycle ${state.cycle}: launches resume: CPU pressure ${Math.round(avg60)} percent`);
}
