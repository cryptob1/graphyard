import { defaultChildRun } from '../child-runner.js';
import { runWorkerVerification } from '../merge-writer/worker-verification.js';
import type { WorkerVerificationJob } from '../server/worker-verification-queue.js';

/** Poll alongside the host loop; trials never hold up supervision or renewal. */
export function workerVerificationPump(root: string, host: () => string,
  mutate: (path: string, body: unknown) => Promise<any>) {
  return async () => {
    const jobs: WorkerVerificationJob[] = await mutate('worker-verifications/take', { host: host() });
    for (const job of jobs) {
      void (async () => {
        let reply;
        try {
          const head = (await defaultChildRun('git', ['-C', root, 'rev-parse', `refs/heads/${job.branch}^{commit}`])).trim();
          if (head !== job.input.head) throw new Error('Verification must name the assigned branch HEAD');
          const result = await runWorkerVerification(root, job.work, job.input, job.baseBranch);
          reply = { id: job.id, result };
        } catch (error) { reply = { id: job.id, error: error instanceof Error ? error.message : String(error) }; }
        await mutate('worker-verifications/finish', reply);
      })().catch(error => console.error('Worker verification delivery failed:', error));
    }
  };
}
