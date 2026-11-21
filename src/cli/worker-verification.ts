import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { CliContext } from './context.js';
import { leftToCiRun, recordPath, written, type VerifyRecord } from './verify.js';
import type { completionRerun } from './complete.js';

export interface WorkerVerificationResult {
  record: VerifyRecord;
  rerun: Awaited<ReturnType<typeof completionRerun>>;
}

/**
 * GY-3335: the required-proof runs a completed verification failed — exactly what `complete`
 * refuses on. Empty when every required proof passed or was left to CI; read wherever complete's
 * own judgement is re-run, never re-worded.
 */
export const failedRequiredProofs = (record: Pick<VerifyRecord, 'ran'>) =>
  record.ran.filter(run => (run.result !== 'pass' && !leftToCiRun(run)) || run.unexercised);

/** No candidate command executes in the worker's sandbox. */
export async function requestWorkerVerification(context: CliContext, work: any, input: {
  mode: 'verify' | 'complete'; head?: string; epoch?: number; preserves?: string[];
}): Promise<WorkerVerificationResult | { queued: true }> {
  const root = context.repositoryRoot();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('Commit the working tree before verification: the private trial runs exact HEAD');
  const head = git('rev-parse', 'HEAD');
  if (input.head && input.head !== head) throw new Error('Verification and submission must name the working tree HEAD');
  if (input.mode === 'complete' && !input.preserves) {
    const previous: VerifyRecord | null = await readFile(recordPath(root, work.key), 'utf8').then(JSON.parse).catch(() => null);
    if (previous?.head === head) input = { ...input, preserves: previous.preserves };
  }
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
  let result: WorkerVerificationResult | { queued: true };
  try {
    result = await context.api(`work/${work.id}/worker-verification`, { ...input, head, epoch: input.epoch ?? work.lease?.epoch });
  } finally { clearInterval(progress); }
  // GY-3537: still waiting for a slot when the request's time ran out; the loop submits the head.
  if ('queued' in result) return result;
  if (result.record.head !== head) throw new Error('The private trial returned a different head');
  await written(root, result.record);
  if (input.mode === 'complete') {
    const failed = failedRequiredProofs(result.record);
    if (failed.length) throw new Error(`complete refused: required proofs failed: ${JSON.stringify(failed)}`);
  }
  return result;
}
