// Completed trial timings are local observability, never merge evidence.
import type { MergePorts } from '../merge-writer/executor.js';
import type { MergeWriterState } from './merge-writer-state.js';

type Trial = NonNullable<MergeWriterState['trials']>[number];

/** One record per trial invocation, one per head in flight. */
export function timedMergePorts(ports: MergePorts, writer: MergeWriterState, persist: () => Promise<void>): MergePorts {
  const trials = new Map<string, Trial>();
  const save = () => { void persist().catch(() => {}); };
  const timed = async <T>(mergeSha: string, step: string, run: () => Promise<T>): Promise<T> => {
    const trial = trials.get(mergeSha), started = ports.now();
    try { return await run(); }
    finally {
      if (trial) {
        trial.steps.push({ step, durationMs: Math.max(0, ports.now() - started) });
        trial.finishedAt = new Date(ports.now()).toISOString();
        save();
      }
    }
  };
  return { ...ports,
    trial: async (mergeSha, files, item, baseTip, onStep, onTiming, heads, share) => {
      const startedAt = new Date(ports.now()).toISOString();
      const trial: Trial = { mergeSha, startedAt, finishedAt: startedAt, heads: heads ?? [], steps: [] };
      trials.set(mergeSha, trial);
      const record = (step: string, durationMs: number) => { trial.steps.push({ step, durationMs }); onTiming?.(step, durationMs); };
      try {
        return await ports.trial(mergeSha, files, item, baseTip, onStep, record, heads, share);
      } finally {
        trial.finishedAt = new Date(ports.now()).toISOString();
        writer.trials = [...(writer.trials ?? []), trial].slice(-20);
        save();
      }
    },
    // GY-3120: a landing re-merges the head onto a moved tip, making a merge commit no trial ran on;
    // aliasing it to the head's own trial record keeps the landing's push duration on that record.
    merge: async (mergeHead, baseTip, item) => {
      const merged = await ports.merge(mergeHead, baseTip, item);
      if (!('conflict' in merged)) {
        const trial = [...trials.values()].find(entry => entry.heads.some(covered => covered.head === mergeHead));
        if (trial) trials.set(merged.mergeSha, trial);
      }
      return merged;
    },
    push: (...args) => timed(args[0], 'push', () => ports.push(...args)),
  };
}

export function trialStepMedians(trials: Trial[]): Record<string, number> {
  const samples = new Map<string, number[]>();
  for (const trial of trials) for (const { step, durationMs } of trial.steps) {
    const values = samples.get(step) ?? [];
    values.push(durationMs); samples.set(step, values);
  }
  return Object.fromEntries([...samples].map(([step, values]) => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return [step, values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2];
  }));
}
