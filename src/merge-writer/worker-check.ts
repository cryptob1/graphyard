// GY-3283: a worker's `graphyard check NAME` runs on the host, as the merge trial runs that check:
// the same image, Compose services and GRAPHYARD_SERVICE_* variables, under the trial load cap.
// The worker sandbox never gets Docker; it gets the check's output and whether it passed.
import { runTrial, trialHiddenPaths } from './trial.js';
import { workerVerificationTimeoutMs } from './worker-verification.js';

export interface WorkerCheckResult { check: string; head: string; passed: boolean; output: string }

export async function runWorkerCheck(input: { root: string; base: string; key: string; head: string; check: string; trial?: typeof runTrial }): Promise<WorkerCheckResult> {
  const verdict = await (input.trial ?? runTrial)({
    root: input.root, base: input.base, mergeSha: input.head, baseTip: input.head, changedFiles: [], timeoutMs: workerVerificationTimeoutMs,
    key: input.key, retries: 0, secretScan: false, only: input.check, hidden: trialHiddenPaths(undefined),
  });
  const passed = verdict.build === 'pass' && verdict.tests.failed.length === 0;
  return { check: input.check, head: input.head, passed, output: verdict.logTail };
}
