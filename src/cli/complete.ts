import { workMutation, type CliCommand } from './registry.js';
import { selfVerification } from './verify.js';

/**
 * `complete GY-N EPOCH PR`: submit the implementation and end the lease. Beside the control
 * plane's answer it reports the worker's own verification of HEAD (`graphyard verify GY-N`): which
 * mechanical proofs were run and their outcome, which proofs are outstanding, or that none was run.
 * The report never changes what is submitted — the gates decide from trusted evidence alone — but a
 * head whose proof failed here is the head the control plane returns before review.
 */
export const completeCommand: CliCommand = {
  name: 'complete',
  scope: 'work',
  help: [
    '  complete GY-N EPOCH PR        Submit implementation and end the lease; gates decide',
    '                                completion. Refused when the PR reverts, deletes or',
    '                                rewrites files outside plannedFiles relative to the base.',
    '                                Reports what graphyard verify ran on HEAD and its outcome',
  ],
  run: async (context, work) => {
    let verification: Awaited<ReturnType<typeof selfVerification>> | { state: 'unavailable'; reason: string };
    try { verification = await selfVerification(context.repositoryRoot(), work.key); } catch (error: any) { verification = { state: 'unavailable', reason: `the worktree could not be read: ${error.message}` }; }
    const submitted = await workMutation(context, work)('submit', { epoch: Number(context.args[0]), pr: Number(context.args[1]) });
    context.print({ ...submitted, selfVerification: verification });
  },
};
