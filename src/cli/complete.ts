import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { type CliCommand } from './registry.js';
import { selfVerification } from './verify.js';

/**
 * A submission is observed on GitHub before it is accepted, so while the control plane's GitHub
 * client is paused after a rate limit the control plane refuses it with "GitHub requests paused
 * until <reset>". That refusal says nothing about the work: `complete` waits for the named reset
 * and submits again, the same request under the same idempotency key. The wait is bounded — a reset
 * further away than `maxWaitMs` in total, or more than `maxAttempts` refusals, fails as before with
 * the control plane's own message — and any other refusal fails at once.
 */
export const pauseRetry = { maxWaitMs: 20 * 60_000, maxAttempts: 6, marginMs: 2_000, unnamedWaitMs: 60_000 };
/** The reset a GitHub-pause refusal names: a time, `unnamed` when the refusal names none, or null for any other refusal. */
export function githubPauseReset(error: unknown): Date | 'unnamed' | null {
  const text = error instanceof Error ? error.message : String(error);
  if (!/GitHub requests paused|requests paused until/.test(text)) return null;
  const at = text.match(/paused until (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1];
  const parsed = at ? new Date(at) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : 'unnamed';
}
export async function submitThroughPause<T>(submit: () => Promise<T>, options: Partial<typeof pauseRetry> & { now?: () => number; sleep?: (ms: number) => Promise<unknown>; report?: (text: string) => void } = {}): Promise<T> {
  const bounds = { ...pauseRetry, ...options }, now = options.now ?? Date.now, sleep = options.sleep ?? delay, report = options.report ?? (text => console.error(text));
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try { return await submit(); } catch (error) {
      const reset = githubPauseReset(error);
      if (reset === null || attempt >= bounds.maxAttempts) throw error;
      const wait = reset === 'unnamed' ? bounds.unnamedWaitMs : Math.max(0, reset.getTime() - now()) + bounds.marginMs;
      if (now() + wait - started > bounds.maxWaitMs) {
        throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)} (complete waits at most ${Math.round(bounds.maxWaitMs / 60_000)} minutes for a GitHub request pause; submit again after the reset)`), { cause: error });
      }
      report(`GitHub requests are paused${reset === 'unnamed' ? '' : ` until ${reset.toISOString()}`}; complete submits again in ${Math.ceil(wait / 1000)}s (attempt ${attempt + 1} of at most ${bounds.maxAttempts})`);
      await sleep(wait);
    }
  }
}

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
    '                                Reports what graphyard verify ran on HEAD and its outcome.',
    '                                Refused while GitHub requests are paused, it waits for the',
    '                                named reset and submits again (bounded)',
    '                                --no-docs STATEMENT states the change alters no documented',
    '                                behaviour, instead of a docs diff (the reviewer checks it)',
  ],
  run: async (context, work) => {
    let verification: Awaited<ReturnType<typeof selfVerification>> | { state: 'unavailable'; reason: string };
    try { verification = await selfVerification(context.repositoryRoot(), work.key); } catch (error: any) { verification = { state: 'unavailable', reason: `the worktree could not be read: ${error.message}` }; }
    const { values, positionals } = parseArgs({ args: context.args, options: { 'no-docs': { type: 'string' } }, allowPositionals: true });
    const statement = values['no-docs']?.trim();
    const body = { epoch: Number(positionals[0]), pr: Number(positionals[1]), ...(statement ? { documentation: statement } : {}) }, requestId = process.env.GRAPHYARD_REQUEST_ID ?? randomUUID();
    const submitted = await submitThroughPause(() => context.api(`work/${work.id}/submit`, body, requestId));
    context.print({ ...submitted, selfVerification: verification });
  },
};
