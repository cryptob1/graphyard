// Concern: local isolated worktree reservation, branch restoration, and lease dependency installs.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertRepository, discover } from '../onboarding.js';
import { gitOrThrow, reclaimBranchHolders, type ReclaimedHolder } from '../worktree-holders.js';
import type { CliContext } from './context.js';
import { installUnderLease } from './install-under-lease.js';
import { workMutation } from './registry.js';

export async function restoreBranchWork(context: CliContext, work: any) {
  // The worker's one history rewrite (GY-128). Its harness denies every raw force push, the lease
  // form included, because a glob cannot limit one to a single ref; this command can. The server
  // confirms the caller holds this epoch's live lease, and the push names only the branch
  // registered for that epoch, leased on the tip fetched here, so it replaces what it saw.
  const epoch = Number(context.args[0]);
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error('Use restore-branch GY-N EPOCH');
  await workMutation(context, work)('heartbeat', { epoch });
  const branch = work.workspaces.find((w: any) => w.epoch === epoch)?.branch;
  if (!branch) throw new Error(`No workspace branch is registered for ${work.key} epoch ${epoch}`);
  const git = (...gitArgs: string[]) => execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const quietly = (...gitArgs: string[]) => spawnSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const current = quietly('symbolic-ref', '--short', 'HEAD').stdout.trim();
  if (current !== branch) throw new Error(`Run restore-branch on ${branch}, the branch of ${work.key} epoch ${epoch}; this worktree is on ${current || 'a detached HEAD'}`);
  if (quietly('rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0) throw new Error(`A merge is in progress: finish sync ${work.key} before restoring the branch`);
  if (quietly('diff', '--quiet', 'HEAD').status !== 0) throw new Error('The worktree has uncommitted changes: commit them or reset before restoring the branch');
  git('fetch', '--quiet', 'origin');
  const tip = quietly('rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`).stdout.trim();
  const head = git('rev-parse', 'HEAD');
  const push = quietly('push', `--force-with-lease=refs/heads/${branch}:${tip}`, 'origin', `HEAD:refs/heads/${branch}`);
  if (push.status !== 0) throw new Error(`The lease push of ${branch} was refused${/stale info/.test(push.stderr) ? ': the branch moved after the fetch; fetch again and read the new tip before replacing it' : ''}: ${push.stderr.trim()}`);
  context.print({ key: work.key, epoch, branch, replaced: tip || null, head,
    next: `The branch holds ${head.slice(0, 12)}. Submit it with complete ${work.key} ${epoch} PR.` });
}

export async function createWorktree(context: CliContext, work: any) {
  const { args, api, print } = context;
  const mutate = workMutation(context, work);
  const epoch = Number(args[0]); const root = context.repositoryRoot();
  const status = await api('status');
  assertRepository((await discover(root)).repository, status.repository);
  const branch = work.submission ? work.workspaces.find((w: any) => w.epoch === work.submission.epoch)?.branch : `graphyard/${work.key.toLowerCase()}-${epoch}`;
  if (!branch) throw new Error('Submitted workspace branch is missing');
  const path = resolve(root, '.graphyard/worktrees', `${work.key}-${epoch}`);
  let startPoint = args[1] ?? 'HEAD';
  if (work.submission) {
    const remoteBranch = `refs/remotes/origin/${branch}`;
    execFileSync('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${remoteBranch}`], { stdio: ['ignore', 'ignore', 'inherit'] });
    const remoteSha = execFileSync('git', ['rev-parse', '--verify', remoteBranch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    if (!work.candidate?.sha || remoteSha !== work.candidate.sha) throw new Error('Submitted PR branch changed; wait for Graphyard to observe its current head before creating the rework workspace');
    startPoint = remoteBranch;
  }
  const hostId = context.individualHostId();
  await mutate('workspace', { epoch, host: hostId, path, branch });
  await mkdir(resolve(root, '.graphyard/worktrees'), { recursive: true });
  const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
  // GY-1078: an abandoned session worktree of this item still holding the branch — checked out
  // on a rework, or stopped mid-rebase, mid-am or mid-bisect of it, which git lists as detached —
  // is reclaimed first; one with a live lease or uncommitted changes is named and left alone.
  // Every failure carries git's own stderr, so the loop's record says why.
  let reclaimed: ReclaimedHolder[] = [];
  try {
    if (exists) reclaimed = reclaimBranchHolders(root, branch, path, work, Date.parse(status.now ?? '') || Date.now(), { checkouts: !!work.submission });
    for (const entry of reclaimed) console.error(`Reclaimed ${entry.path}, which held ${branch}${entry.epoch !== null ? ` for ${entry.key} epoch ${entry.epoch}` : ''}: ${entry.action}`);
    gitOrThrow(exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, startPoint]);
    if (work.submission) gitOrThrow(['-C', path, 'reset', '--hard', startPoint]);
  }
  catch (error) { throw new Error(`Git worktree creation failed: ${error instanceof Error ? error.message : String(error)}. Reservation remains for safety; inspect the event and repair locally. Do not reuse the branch for another task.`); }
  // A checkout whose lockfile the reachable install does not match gets its own install now,
  // so the session never starts on the wrong dependency versions. The lease is kept alive
  // while npm runs; the session's supervisor takes over heartbeats once it starts. A refused
  // heartbeat means this epoch is no longer held: npm is stopped there and the command fails
  // rather than reporting a worktree ready for work nobody may do.
  const dependencies = await installUnderLease(path, () => mutate('heartbeat', { epoch }), `${work.key} epoch ${epoch}`);
  return print({ path, branch, epoch, dependencies, ...(reclaimed.length ? { reclaimed } : {}) });
}
