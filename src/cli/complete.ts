import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

/** The commit the worktree at `root` has checked out, for `--head` with no SHA. */
export function worktreeHead(root: string): string {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`complete --head could not read the worktree's HEAD: ${result.stderr.trim() || result.error?.message || `git exited ${result.status}`}`);
  return result.stdout.trim();
}
/**
 * What `complete GY-N EPOCH ...` submits (GY-1523): `{epoch, pr}` for `PR`, exactly as before, or
 * `{epoch, head}` for `--head [SHA]`, the SHA defaulting to the worktree's HEAD. parseArgs has no
 * flag with an optional value, so `--head` and the SHA that follows it (unless the next word is a
 * flag) are taken out before the positionals and `--no-docs` are parsed; without `--head` the
 * arguments reach parseArgs untouched and the body is byte-identical to the PR form's.
 */
export function completionBody(args: readonly string[], headOf: () => string): { epoch: number; pr?: number; head?: string; documentation?: string } {
  const rest: string[] = []; let head: string | undefined | null = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--head') { const next = args[index + 1]; if (next !== undefined && !next.startsWith('-')) { head = next; index++; } else head = undefined; continue; }
    if (argument.startsWith('--head=')) { head = argument.slice('--head='.length); continue; }
    rest.push(argument);
  }
  const { values, positionals } = parseArgs({ args: rest, options: { 'no-docs': { type: 'string' } }, allowPositionals: true });
  const statement = values['no-docs']?.trim();
  const documentation = statement ? { documentation: statement } : {};
  if (head === null) return { epoch: Number(positionals[0]), pr: Number(positionals[1]), ...documentation };
  if (positionals[1] !== undefined) throw new Error('complete takes either a PR number or --head [SHA], not both');
  const sha = (head ?? headOf()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`--head takes a 40-hex commit, or none for the worktree's HEAD; ${JSON.stringify(sha)} is neither`);
  return { epoch: Number(positionals[0]), head: sha, ...documentation };
}

/**
 * `complete GY-N EPOCH PR`, or `complete GY-N EPOCH --head [SHA]` while the control plane is the
 * merge writer (GY-1523): submit the implementation and end the lease. Beside the control
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
    '  complete GY-N EPOCH --head [SHA]  While the control plane is the merge writer: submit the',
    '                                commit (the worktree\'s HEAD when no SHA is given), which the',
    '                                shared object store already holds, so nothing is pushed; the',
    '                                control plane allocates its change number and ends the lease',
  ],
  run: async (context, work) => {
    let verification: Awaited<ReturnType<typeof selfVerification>> | { state: 'unavailable'; reason: string };
    try { verification = await selfVerification(context.repositoryRoot(), work.key); } catch (error: any) { verification = { state: 'unavailable', reason: `the worktree could not be read: ${error.message}` }; }
    const body = completionBody(context.args, () => worktreeHead(context.repositoryRoot())), requestId = process.env.GRAPHYARD_REQUEST_ID ?? randomUUID();
    const submitted = await submitThroughPause(() => context.api(`work/${work.id}/submit`, body, requestId));
    context.print({ ...submitted, selfVerification: verification });
  },
};
