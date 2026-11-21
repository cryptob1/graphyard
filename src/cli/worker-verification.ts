import { execFileSync } from 'node:child_process';
import type { CliContext } from './context.js';
import { leftToCiRun, written, type VerifyRecord } from './verify.js';
import type { completionRerun } from './complete.js';

export interface WorkerVerificationResult {
  record: VerifyRecord;
  rerun: Awaited<ReturnType<typeof completionRerun>>;
}

/**
 * GY-3335: the required-proof runs a completed verification failed — used by finished-head recovery. Empty when every required proof passed or was left to CI.
 */
export const failedRequiredProofs = (record: Pick<VerifyRecord, 'ran'>) =>
  record.ran.filter(run => (run.result !== 'pass' && !leftToCiRun(run)) || run.unexercised);

/** No candidate command executes in the worker's sandbox. */
export async function requestWorkerVerification(context: CliContext, work: any, input: {
  mode: 'verify'; head?: string; epoch?: number; preserves?: string[];
}): Promise<WorkerVerificationResult> {
  const root = context.repositoryRoot();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('Commit the working tree before verification: the private trial runs exact HEAD');
  const head = git('rev-parse', 'HEAD');
  if (input.head && input.head !== head) throw new Error('Verification and submission must name the working tree HEAD');
  // GY-3332: while the host's trial waits to start, its launcher's words reach this output, never a silent hang.
  let shown = 0, reading = false;
  const show = async () => {
    if (reading) return;
    reading = true;
    const { lines } = await context.api(`work/${work.id}/worker-verification`).catch(() => ({ lines: [] as string[] }));
    for (const line of (lines as string[]).slice(shown)) console.error(`graphyard trial container: ${line}`);
    shown = Math.max(shown, lines.length);
    reading = false;
  };
  const progress = setInterval(() => void show(), 2_000);
  let result: WorkerVerificationResult;
  try {
    result = await context.api(`work/${work.id}/worker-verification`, { ...input, head, epoch: input.epoch ?? work.lease?.epoch });
  } finally { clearInterval(progress); }
  if (result.record.head !== head) throw new Error('The private trial returned a different head');
  await written(root, result.record);
  return result;
}
