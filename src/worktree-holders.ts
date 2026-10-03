import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Work } from './model.js';

/*
 * The branch an assignment worktree is created on can be held by another worktree that git no
 * longer lists as being on it (GY-1078). A worktree stopped in an interactive rebase, an `am` or a
 * bisect of the branch shows a detached HEAD in `git worktree list --porcelain`, yet git still
 * refuses the branch to every other worktree (`fatal: '...' is already used by worktree at ...`).
 * One abandoned GY-859 session worktree left that way held its item's branch for days, and every
 * dispatch of the item failed on it. Before the worktree is added, the holders are found by
 * reading each worktree's own admin directory, and an abandoned session's is reclaimed: never one
 * whose epoch holds a live lease, never one with uncommitted changes, and never one outside
 * `.graphyard/worktrees`; each of those is named in the refusal instead.
 */

/** One worktree holding a branch: where it is, how it holds it, and which attempt it belongs to. */
export interface BranchHolder {
  path: string;
  /** `checkout` is an ordinary checkout of the branch; the others are an operation in progress on it. */
  via: 'checkout' | 'rebase' | 'am' | 'bisect';
  key: string | null; epoch: number | null;
}
/** What was done to free the branch: the operation aborted, and the worktree removed or detached. */
export interface ReclaimedHolder extends BranchHolder { action: string }

const git = (args: string[], cwd?: string) => spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** A failed git command as one line: its arguments and what git wrote to stderr. */
export const gitFailure = (args: string[], result: { stderr?: string | null; stdout?: string | null; status: number | null; error?: Error }) =>
  `git ${args.join(' ')} failed${result.status !== null ? ` (exit ${result.status})` : ''}: ${(result.stderr || result.stdout || result.error?.message || 'no output').trim().replace(/\s*\n\s*/g, ' / ')}`;
/** Runs git, throwing with git's own stderr when it fails. */
export function gitOrThrow(args: string[], cwd?: string) {
  const result = git(args, cwd);
  if (result.status !== 0) throw new Error(gitFailure(args, result));
  return result.stdout;
}

/**
 * The operation in progress in a worktree's admin directory that holds `branch`, if any. `attached`
 * says git lists the worktree on the branch: a `git am` keeps HEAD attached and writes no
 * `head-name`, so only its `applying` marker tells it from an ordinary checkout.
 */
function operationHolding(adminDir: string, branch: string, attached: boolean): BranchHolder['via'] | null {
  const read = (name: string) => { try { return readFileSync(resolve(adminDir, name), 'utf8').trim(); } catch { return null; } };
  const ref = `refs/heads/${branch}`, applying = existsSync(resolve(adminDir, 'rebase-apply/applying'));
  if (read('rebase-merge/head-name') === ref) return 'rebase';
  if (read('rebase-apply/head-name') === ref) return applying ? 'am' : 'rebase';
  if (attached && applying) return 'am';
  const bisect = read('BISECT_START');
  if (bisect === branch || bisect === ref) return 'bisect';
  return null;
}

/** Every worktree of the repository at `root` except `except` that holds `branch`. */
export function branchHolders(root: string, branch: string, except: string, keyOf: (path: string) => { key: string | null; epoch: number | null } = sessionOf): BranchHolder[] {
  const records = gitOrThrow(['worktree', 'list', '--porcelain', '-z'], root).split('\0\0');
  const holders: BranchHolder[] = [];
  for (const record of records) {
    const fields = record.split('\0');
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9);
    if (!path || resolve(path) === resolve(except)) continue;
    // An operation in progress is looked for first, so an attached `am` is not taken for a checkout.
    const attached = fields.includes(`branch refs/heads/${branch}`);
    let via: BranchHolder['via'] | null = null;
    if (existsSync(path)) {
      const adminDir = git(['rev-parse', '--absolute-git-dir'], path);
      if (adminDir.status === 0) via = operationHolding(adminDir.stdout.trim(), branch, attached);
    }
    via ??= attached ? 'checkout' : null;
    if (via) holders.push({ path, via, ...keyOf(path) });
  }
  return holders;
}

/** The item key and epoch a session worktree's directory name (`GY-N-EPOCH`) says it belongs to. */
export function sessionOf(path: string): { key: string | null; epoch: number | null } {
  const match = /^([A-Z][A-Z0-9]*-\d+)-(\d+)$/.exec(basename(path));
  return match ? { key: match[1], epoch: Number(match[2]) } : { key: null, epoch: null };
}

/**
 * Why each of `holders` may not be touched: an operation in progress outside a session worktree
 * of `work`, an epoch holding a live lease on `now`, or — with `dirty` — uncommitted changes.
 * GY-860's release of an earlier attempt's hold records the uncommitted diff on the item's
 * ledger before it ends the operation, so it asks without `dirty`.
 */
export function holderRefusals(root: string, holders: BranchHolder[], work: Pick<Work, 'key' | 'lease'>, now: number, options: { dirty: boolean }): string[] {
  const sessions = resolve(root, '.graphyard/worktrees');
  const refusals: string[] = [];
  const live = (holder: BranchHolder) => !!work.lease && work.lease.epoch === holder.epoch && Date.parse(work.lease.expiresAt) > now;
  for (const holder of holders) {
    const name = `${holder.path} (${holder.via === 'checkout' ? 'checked out' : `${holder.via} in progress`})`;
    if (holder.via !== 'checkout' && resolve(dirname(holder.path)) !== sessions) refusals.push(`${name} is not a session worktree under ${sessions}`);
    else if (holder.via !== 'checkout' && holder.key !== work.key) refusals.push(`${name} belongs to ${holder.key ?? 'no Graphyard item'}, not ${work.key}`);
    else if (live(holder)) refusals.push(`${name} belongs to ${work.key} epoch ${holder.epoch}, which holds a live lease`);
    else if (holder.via !== 'checkout' && options.dirty) {
      // An unreadable status is not a clean one: the worktree is left alone and named.
      const status = git(['status', '--porcelain'], holder.path);
      if (status.status !== 0) refusals.push(`${name} could not be checked for uncommitted changes (${gitFailure(['status', '--porcelain'], status)})`);
      else if (status.stdout.trim()) refusals.push(`${name} has uncommitted changes`);
    }
  }
  return refusals;
}

/** The refusal `holderRefusals` names, as the error the worktree command reports. */
export const heldBranchRefusal = (branch: string, refusals: string[]) =>
  `Branch ${branch} is held by another worktree that was not reclaimed: ${refusals.join('; ')}. Finish or abort its operation, or remove that worktree, before retrying.`;

/**
 * Frees `branch` for the worktree about to be created at `target`, returning what was reclaimed,
 * or throws naming every holder it may not touch. A holder is reclaimed only when it is a session
 * worktree directly under `<root>/.graphyard/worktrees` belonging to `work`, its epoch holds no
 * live lease on `now`, and it has no uncommitted changes. An operation in progress is aborted and
 * the clean worktree removed (detached if git will not remove it); an ordinary checkout is
 * detached, as the rework path always did, keeping whatever it holds.
 */
export function reclaimBranchHolders(root: string, branch: string, target: string, work: Pick<Work, 'key' | 'lease'>, now: number, options: { checkouts: boolean }): ReclaimedHolder[] {
  const holders = branchHolders(root, branch, target).filter(holder => holder.via !== 'checkout' || options.checkouts);
  const refusals = holderRefusals(root, holders, work, now, { dirty: true });
  if (refusals.length) throw new Error(heldBranchRefusal(branch, refusals));
  const reclaimed: ReclaimedHolder[] = [];
  for (const holder of holders) {
    if (holder.via === 'checkout') {
      gitOrThrow(['-C', holder.path, 'checkout', '--detach', '--quiet']);
      reclaimed.push({ ...holder, action: 'detached its HEAD' });
      continue;
    }
    const abort = holder.via === 'bisect' ? ['bisect', 'reset', '--quiet'] : [holder.via, '--abort'];
    gitOrThrow(['-C', holder.path, ...abort]);
    const removed = git(['worktree', 'remove', holder.path], root);
    if (removed.status === 0) { reclaimed.push({ ...holder, action: `aborted the ${holder.via} and removed the worktree` }); continue; }
    gitOrThrow(['-C', holder.path, 'checkout', '--detach', '--quiet']);
    reclaimed.push({ ...holder, action: `aborted the ${holder.via} and detached its HEAD (${gitFailure(['worktree', 'remove', holder.path], removed)})` });
  }
  return reclaimed;
}
