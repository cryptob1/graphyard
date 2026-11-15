import { trialOverloadPrefix } from '../model/merge-queue.js';
import { readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';

export interface TrialCpuReading { total: number; steal: number; idle: number; load: number; at: number }
export function readTrialCpu(stat = () => readFileSync('/proc/stat', 'utf8'), load = loadavg()[0], at = Date.now()): TrialCpuReading | null {
  try {
    // Guest time is already included in user/nice; count only the first eight counters.
    const values = stat().split('\n')[0]!.trim().split(/\s+/).slice(1, 9).map(Number);
    if (values.length !== 8 || values.some(value => !Number.isFinite(value))) return null;
    return { total: values.reduce((sum, value) => sum + value, 0), steal: values[7]!, idle: values[3]! + values[4]!, load, at };
  } catch { return null; }
}
export function trialCpuUsage(before: TrialCpuReading | null, after: TrialCpuReading | null) {
  if (!before || !after || after.total <= before.total) return null;
  const total = after.total - before.total;
  return { steal: (after.steal - before.steal) / total, idle: (after.idle - before.idle) / total, load: after.load };
}
export const usableTrialCores = (cores: number, steal: number) => Math.max(1, cores * (1 - steal));
export { trialOverloadPrefix } from '../model/merge-queue.js';
export const trialOverloadFault = (error: unknown) => error instanceof Error && error.message.startsWith(trialOverloadPrefix);
export class TrialOverloadError extends Error {
  constructor(step: string, usage: NonNullable<ReturnType<typeof trialCpuUsage>>, cores: number) {
    super(`${trialOverloadPrefix} ${step} timed out with ${Math.round(usage.steal * 100)}% CPU steal, ${Math.round(usage.idle * 100)}% idle, load ${usage.load.toFixed(1)} on ${cores} cores`);
  }
}

/** One minute of samples for sizing; individual steps use their own counter interval. */
export function trialCpuMonitor(read = readTrialCpu, cores = availableParallelism()) {
  const samples: TrialCpuReading[] = [];
  const sample = () => {
    const current = read();
    if (current) {
      samples.push(current);
      while (samples.length > 2 && samples[1]!.at < current.at - 60_000) samples.shift();
    }
    return current;
  };
  sample();
  const timer = setInterval(sample, 1_000);
  timer.unref();
  return {
    sample,
    cores: () => { const current = sample(); return usableTrialCores(cores, trialCpuUsage(samples[0] ?? null, current)?.steal ?? 0); },
    finish: (step: string, before: TrialCpuReading | null, timedOut: boolean, log: (line: string) => void) => {
      const usage = trialCpuUsage(before, sample());
      if (!usage) return;
      log(`[cpu] ${step}: ${Math.round(usage.steal * 100)}% steal, ${Math.round(usage.idle * 100)}% idle, load ${usage.load.toFixed(1)} / ${cores} cores`);
      if (timedOut && (usage.steal > 0.25 || (usage.idle < 0.01 && usage.load > cores * 2))) throw new TrialOverloadError(step, usage, cores);
    },
    close: () => clearInterval(timer),
  };
}
