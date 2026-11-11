import { basename } from 'node:path';
import type { HeadlessExec } from '../../src/headless-session.js';
import { clearRuns } from '../../src/runner/registry.js';

type Run = { runtime: string; args: string[]; request: string; env: Record<string, string>; cwd: string };
/**
 * Worker runs recorded and never started (GY-3259): each run's runtime, request, environment and
 * directory. Each "finishes" at once, or with `running` never ends, so its registry session stays
 * live; `forget` then drops it from this process's run list, freeing its profile's name.
 */
export function recordedRuns({ running = false, fail }: { running?: boolean; fail?: (run: Run) => string | null } = {}) {
  const runs: Run[] = [];
  const exec: HeadlessExec = async (_command, args, { env, cwd }) => {
    const run = { runtime: basename(args[args.indexOf('--') + 1] ?? ''), args, request: args.at(-1) ?? '', env, cwd };
    runs.push(run);
    const failure = fail?.(run);
    if (failure) throw new Error(failure);
    return running ? new Promise<string>(() => {}) : '';
  };
  return { exec, runs, kinds: () => runs.map(run => run.runtime), forget: clearRuns, startupMs: running ? 20 : undefined };
}
