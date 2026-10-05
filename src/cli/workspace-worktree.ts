// Concern: local isolated worktree reservation and creation, and the leased attempt's one branch replacement.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runChild } from '../child-runner.js';
import { releaseUnderFailure, reserveReleasingHold, submittedBranchRefusal, workspaceFailure } from '../master/worktrees.js';
import { assertRepository, discover } from '../onboarding.js';
import { gitOrThrow, reclaimBranchHolders, type ReclaimedHolder } from '../worktree-holders.js';
import type { CliContext } from './context.js';
import { installUnderLease } from './install-under-lease.js';
import { workMutation } from './registry.js';

/** `restore-branch GY-N EPOCH`: replace the leased attempt's own branch with HEAD. */
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
  git('fetch', '--quiet', '--no-tags', 'origin');
  const tip = quietly('rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`).stdout.trim();
  const head = git('rev-parse', 'HEAD');
  const push = quietly('push', `--force-with-lease=refs/heads/${branch}:${tip}`, 'origin', `HEAD:refs/heads/${branch}`);
  if (push.status !== 0) throw new Error(`The lease push of ${branch} was refused${/stale info/.test(push.stderr) ? ': the branch moved after the fetch; fetch again and read the new tip before replacing it' : ''}: ${push.stderr.trim()}`);
  context.print({ key: work.key, epoch, branch, replaced: tip || null, head,
    next: `The branch holds ${head.slice(0, 12)}. Submit it with complete ${work.key} ${epoch} PR.` });
}

/** `worktree GY-N EPOCH [BASE]`: reserve and create a local isolated worktree. */
export async function createWorktree(context: CliContext, work: any) {
  const { args, api, print } = context;
  // GY-1059: under GRAPHYARD_REQUEST_ID each write keys off it by name, so the failure release never replays the reservation.
  const request = process.env.GRAPHYARD_REQUEST_ID;
  const mutate = (name: string, data: unknown) => api(`work/${work.id}/${name}`, data, request && name !== 'heartbeat' ? `${request}:worktree-${name}` : randomUUID());
  const epoch = Number(args[0]); const root = context.repositoryRoot();
  const status = await api('status');
  assertRepository((await discover(root)).repository, status.repository);
  const branch = work.submission ? work.workspaces.find((w: any) => w.epoch === work.submission.epoch)?.branch : `graphyard/${work.key.toLowerCase()}-${epoch}`;
  if (!branch) throw new Error('Submitted workspace branch is missing');
  const path = resolve(root, '.graphyard/worktrees', `${work.key}-${epoch}`);
  let startPoint = args[1] ?? 'HEAD';
  if (work.submission) {
    const remoteBranch = `refs/remotes/origin/${branch}`;
    // GY-860 AC-2: an unfetchable or moved PR branch is a workspace failure, so no attempt is spent.
    const refused = await submittedBranchRefusal(root, branch, remoteBranch, work.candidate?.sha, runChild);
    if (refused) { await releaseUnderFailure(mutate, epoch, refused); throw new Error(`${refused}. The claim was released as a workspace failure, so the attempt costs nothing.`); }
    startPoint = remoteBranch;
  }
  // GY-860: an earlier attempt's hold is recorded with the reservation and released; the branch never moves.
  const now = Date.parse(status.now ?? '') || Date.now();
  const released = await reserveReleasingHold(root, branch, path, runChild, mutate, epoch, context.individualHostId(), work, now);
  const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
  // GY-1078: a mid-bisect session worktree the release leaves is reclaimed; failures carry git's stderr.
  let reclaimed: ReclaimedHolder[] = [];
  try {
    // A full or read-only volume is the host's failure too (GY-1059), so it costs no attempt.
    await mkdir(resolve(root, '.graphyard/worktrees'), { recursive: true });
    if (exists) reclaimed = reclaimBranchHolders(root, branch, path, work, now, { checkouts: !!work.submission });
    for (const entry of reclaimed) console.error(`Reclaimed ${entry.path}, which held ${branch}${entry.epoch !== null ? ` for ${entry.key} epoch ${entry.epoch}` : ''}: ${entry.action}`);
    if (!released?.reused) gitOrThrow(exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, startPoint]);
    if (work.submission) gitOrThrow(['-C', path, 'reset', '--hard', startPoint]);
  }
  catch (error) { await workspaceFailure(mutate, epoch, error); } // GY-860: the host failed, not the attempt
  // A checkout whose lockfile the reachable install does not match gets its own install, under heartbeats
  // until the session's supervisor takes over; a refused heartbeat stops npm and fails the command.
  const dependencies = await installUnderLease(path, () => mutate('heartbeat', { epoch }), `${work.key} epoch ${epoch}`);
  return print({ path, branch, epoch, dependencies, ...(reclaimed.length ? { reclaimed } : {}) });
}
