import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { CliContext } from './context.js';
import { leftToCiRun, recordPath, written, type VerifyRecord } from './verify.js';
import type { completionRerun } from './complete.js';

export interface WorkerVerificationResult {
  record: VerifyRecord;
  rerun: Awaited<ReturnType<typeof completionRerun>>;
}

/** No candidate command executes in the worker's sandbox. */
export async function requestWorkerVerification(context: CliContext, work: any, input: {
  mode: 'verify' | 'complete'; head?: string; epoch?: number; preserves?: string[];
}): Promise<WorkerVerificationResult> {
  const root = context.repositoryRoot();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('Commit the working tree before verification: the private trial runs exact HEAD');
  const head = git('rev-parse', 'HEAD');
  if (input.head && input.head !== head) throw new Error('Verification and submission must name the working tree HEAD');
  if (input.mode === 'complete' && !input.preserves) {
    const previous: VerifyRecord | null = await readFile(recordPath(root, work.key), 'utf8').then(JSON.parse).catch(() => null);
    if (previous?.head === head) input = { ...input, preserves: previous.preserves };
  }
  const result: WorkerVerificationResult = await context.api(`work/${work.id}/worker-verification`, {
    ...input, head, epoch: input.epoch ?? work.lease?.epoch,
  });
  if (result.record.head !== head) throw new Error('The private trial returned a different head');
  await written(root, result.record);
  if (input.mode === 'complete' && result.record.ran.some(run => (run.result !== 'pass' && !leftToCiRun(run)) || run.unexercised))
    throw new Error(`complete refused: required proofs failed: ${JSON.stringify(result.record.ran)}`);
  return result;
}
