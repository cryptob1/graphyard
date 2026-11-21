import { defaultChildRun } from '../child-runner.js';
import { runWorkerVerification } from '../merge-writer/worker-verification.js';
import { runWorkerCheck } from '../merge-writer/worker-check.js';
import { heavyJobsDirectory, readHeavyDrain } from '../master/verification-slots.js';
import type { WorkerVerificationJob } from '../server/worker-verification-queue.js';

/**
 * The assigned branch holds the head a worker names, or is moved to it (GY-3279): a worker whose
 * HEAD is detached at a descendant of its branch cannot always move the branch itself, so the host
 * fast-forwards it; a head that does not descend from the branch is refused.
 */
export async function moveBranchToHead(root: string, branch: string, head: string): Promise<void> {
  const git = (...args: string[]) => defaultChildRun('git', ['-C', root, ...args]);
  const ref = `refs/heads/${branch}`, tip = (await git('rev-parse', `${ref}^{commit}`)).trim();
  if (tip === head) return;
  await git('merge-base', '--is-ancestor', tip, head).catch(() => { throw new Error(`Verification must name the assigned branch HEAD or a commit descending from it: ${branch} holds ${tip.slice(0, 12)}`); });
  await git('update-ref', ref, head, tip);
}

/** Poll alongside the host loop; trials never hold up supervision or renewal. */
export function workerVerificationPump(root: string, host: () => string,
  mutate: (path: string, body: unknown) => Promise<any>, base: () => string, check = runWorkerCheck, verify = runWorkerVerification) {
  let started: Promise<unknown> | undefined;
  return async () => {
    // Once per loop lifetime, even while drained. Share initialization across overlapping polls.
    await (started ??= mutate('worker-verifications/restart', { host: host() }).catch(error => {
      started = undefined;
      throw error;
    }));
    // GY-3304: while the host's heavy work is drained, requests stay queued on the control plane until resume.
    if (readHeavyDrain(heavyJobsDirectory())) return;
    const jobs: WorkerVerificationJob[] = await mutate('worker-verifications/take', { host: host() });
    for (const job of jobs) {
      void (async () => {
        let reply;
        try {
          await moveBranchToHead(root, job.branch, job.input.head);
          const result = job.input.mode === 'check'
            ? await check({ root, base: base(), baseBranch: job.baseBranch, key: job.work.key, head: job.input.head, check: job.input.check! })
            : await verify(root, job.work, job.input, job.baseBranch, undefined,
              line => { void mutate('worker-verifications/progress', { id: job.id, line }).catch(() => {}); });
          reply = { id: job.id, result };
        } catch (error) { reply = { id: job.id, error: error instanceof Error ? error.message : String(error) }; }
        await mutate('worker-verifications/finish', reply);
      })().catch(error => console.error('Worker verification delivery failed:', error));
    }
  };
}
