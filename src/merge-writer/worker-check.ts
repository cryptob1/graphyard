// GY-3283: a worker's `graphyard check NAME` runs on the host, as the merge trial runs that check:
// the same image, Compose services and GRAPHYARD_SERVICE_* variables, under the trial load cap.
// The worker sandbox never gets Docker; it gets the check's output and whether it passed.
import { defaultChildRun } from '../child-runner.js';
import { runTrial, trialHiddenPaths } from './trial.js';
import { workerVerificationTimeoutMs } from './worker-verification.js';

export interface WorkerCheckResult { check: string; head: string; passed: boolean; output: string }

export async function runWorkerCheck(input: { root: string; base: string; baseBranch: string; key: string; head: string; check: string; trial?: typeof runTrial }): Promise<WorkerCheckResult> {
  // The head's own changes since it left the base branch: a check that selects its files selects them as the trial would.
  const git = async (...args: string[]) => (await defaultChildRun('git', ['-C', input.root, ...args])).trim();
  const baseTip = await git('merge-base', `refs/remotes/origin/${input.baseBranch}`, input.head).catch(() => git('merge-base', input.baseBranch, input.head));
  const changedFiles = (await git('diff', '--name-only', '--no-renames', baseTip, input.head)).split('\n').filter(Boolean);
  const verdict = await (input.trial ?? runTrial)({
    root: input.root, base: input.base, mergeSha: input.head, baseTip, changedFiles, timeoutMs: workerVerificationTimeoutMs,
    key: input.key, retries: 0, secretScan: false, only: input.check, hidden: trialHiddenPaths(undefined),
  });
  const passed = verdict.build === 'pass' && verdict.tests.failed.length === 0;
  return { check: input.check, head: input.head, passed, output: verdict.logTail };
}
