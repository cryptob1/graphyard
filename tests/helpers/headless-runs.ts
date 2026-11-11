import { basename } from 'node:path';
import type { HeadlessExec } from '../../src/headless-session.js';

/** Worker runs recorded and never started (GY-3259): each run's runtime, request, environment and directory. Each "finishes" at once. */
export function recordedRuns() {
  const runs: { runtime: string; args: string[]; request: string; env: Record<string, string>; cwd: string }[] = [];
  const exec: HeadlessExec = async (_command, args, { env, cwd }) => {
    runs.push({ runtime: basename(args[args.indexOf('--') + 1] ?? ''), args, request: args.at(-1) ?? '', env, cwd });
    return '';
  };
  return { exec, runs, kinds: () => runs.map(run => run.runtime) };
}
