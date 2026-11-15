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
// GY-3373: the hottest CPU sensor rides the same reading. Pressure alone missed a host at 98C with
// avg60 near 20, where every trial start waited on heat while the loop kept launching agents; so
// launches wait from the trial guard's own limit minus 5C. Where no sensor is readable, no heat holds.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DaemonState } from './state.js';
import type { DaemonEffects } from './effects.js';
import { cpuSensorNames, trialHotCelsius } from '../merge-writer/trial-load.js';

/** The one constant, no setting: while 'some avg60' reads above this, no new worker, reviewer or trial starts. */
export const cpuPressureCeiling = 85;
/** GY-3373: launches wait while the hottest CPU sensor reads this or more, before the trial guard itself refuses a start. */
export const launchHotCelsius = trialHotCelsius - 5;

/** The one status line master status carries while launches wait — heat first, then pressure — or null when nothing holds them. */
export function cpuWaiting(state: Pick<DaemonState, 'cpuPressure'>): string | null {
  const cpu = state.cpuPressure;
  if (cpu?.celsius != null && cpu.celsius >= launchHotCelsius) return `launches waiting: CPU ${cpu.celsius}C`;
  if (cpu?.avg60 != null && cpu.avg60 > cpuPressureCeiling) return `launches waiting: CPU pressure ${Math.round(cpu.avg60)} percent`;
  return null;
}
export const cpuPressureHeld = (state: Pick<DaemonState, 'cpuPressure'>) => cpuWaiting(state) !== null;

/** The hottest CPU sensor under `hwmon` in whole degrees, as the trial guard reads it; null where none is readable. */
export async function hottestCpuCelsius(hwmon = '/sys/class/hwmon'): Promise<number | null> {
  const read = (path: string) => readFile(path, 'utf8').then(text => text.trim(), () => '');
  const readings = (await Promise.all((await readdir(hwmon).catch(() => [] as string[])).map(async sensor => {
    if (!cpuSensorNames.includes(await read(join(hwmon, sensor, 'name')))) return [];
    const inputs = (await readdir(join(hwmon, sensor)).catch(() => [] as string[])).filter(name => name.startsWith('temp') && name.endsWith('_input'));
    return (await Promise.all(inputs.map(name => read(join(hwmon, sensor, name))))).filter(text => /^\d+$/.test(text)).map(text => Math.floor(Number(text) / 1000));
  }))).flat();
  return readings.length ? Math.max(...readings) : null;
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
 * loses only one reading, and the hottest sensor (GY-3373). With neither readable (not Linux) the record clears — launches run and
 * the pages show nothing, exactly as before — and a hold that begins or ends is one journal line.
 */
export async function cpuPressureStep(cycle: { state: DaemonState; effects: DaemonEffects; now: () => number; log: (line: string) => void }) {
  const { state, effects, now, log } = cycle;
  const reading = await Promise.resolve(effects.cpuPressure?.()).catch(() => null) ?? null;
  const avg60 = reading?.pressure ? pressureAvg60(reading.pressure) : null, celsius = reading?.celsius ?? null;
  const previous = state.cpuPressure, was = cpuWaiting(state);
  const stat = avg60 !== null && reading?.stat ? cpuStatTotals(reading.stat) : null;
  state.cpuPressure = avg60 === null && celsius === null ? null
    : { at: new Date(now()).toISOString(), avg60, steal: stealPercent(previous?.stat ?? null, stat), stat, celsius };
  const waiting = cpuWaiting(state);
  if (!!waiting !== !!was) log(`[graphyard-master] cycle ${state.cycle}: ${waiting ? `${waiting}; no new worker, reviewer or trial starts until it falls` : 'launches resume'}`);
}
