import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
 * `.graphyard/worktrees`; each of those is named in the refusal instead. The same rules apply to
 * an ordinary checkout of the branch and to the record of a session worktree whose directory was
 * deleted outside git (GY-1082).
 */

/** One worktree holding a branch: where it is, how it holds it, and which attempt it belongs to. */
export interface BranchHolder {
  path: string;
  /** `checkout` is an ordinary checkout of the branch; the others are an operation in progress on it. */
  via: 'checkout' | 'rebase' | 'am' | 'bisect';
  key: string | null; epoch: number | null;
  /** The directory is gone but git still records the worktree (`prunable`); only its record holds the branch. */
  missing?: boolean;
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
    const present = existsSync(path);
    if (present) {
      const adminDir = git(['rev-parse', '--absolute-git-dir'], path);
      if (adminDir.status === 0) via = operationHolding(adminDir.stdout.trim(), branch, attached);
    }
    via ??= attached ? 'checkout' : null;
    if (via) holders.push({ path, via, ...keyOf(path), ...(present ? {} : { missing: true }) });
  }
  return holders;
}

/** The item key and epoch a session worktree's directory name (`GY-N-EPOCH`) says it belongs to. */
export function sessionOf(path: string): { key: string | null; epoch: number | null } {
  const match = /^([A-Z][A-Z0-9]*-\d+)-(\d+)$/.exec(basename(path));
  return match ? { key: match[1], epoch: Number(match[2]) } : { key: null, epoch: null };
}

/** Lines of `git status --porcelain` in `path`, with `--ignored` or tracked files only when asked, or git's failure when it cannot read them. */
function statusLines(path: string, ignored: boolean, trackedOnly = false) {
  const args = ['status', '--porcelain', ...(ignored ? ['--ignored'] : []), ...(trackedOnly ? ['--untracked-files=no'] : [])];
  const result = git(args, path);
  return result.status === 0 ? { lines: result.stdout.split('\n').filter(Boolean) } : { failure: gitFailure(args, result) };
}

/**
 * Why each of `holders` may not be touched: an operation outside a session worktree, a session
 * worktree of another item or of an epoch holding a live lease on `now`, or — with `dirty` —
 * uncommitted changes (only tracked ones for an ordinary checkout). GY-860's release of an earlier
 * attempt's hold records the uncommitted diff on the item's ledger before it ends the operation,
 * so it asks without `dirty`.
 */
export function holderRefusals(root: string, holders: BranchHolder[], work: Pick<Work, 'key' | 'lease'>, now: number, options: { dirty: boolean }): string[] {
  const sessions = resolve(root, '.graphyard/worktrees');
  const refusals: string[] = [];
  const live = (holder: BranchHolder) => !!work.lease && work.lease.epoch === holder.epoch && Date.parse(work.lease.expiresAt) > now;
  for (const holder of holders) {
    const name = `${holder.path} (${holder.missing ? 'deleted, still recorded' : holder.via === 'checkout' ? 'checked out' : `${holder.via} in progress`})`;
    const checkout = holder.via === 'checkout' && !holder.missing, session = resolve(dirname(holder.path)) === sessions;
    if (!session && !checkout) refusals.push(`${name} is not a session worktree under ${sessions}`);
    else if (session && holder.key !== work.key) refusals.push(`${name} belongs to ${holder.key ?? 'no Graphyard item'}, not ${work.key}`);
    else if (session && live(holder)) refusals.push(`${name} belongs to ${work.key} epoch ${holder.epoch}, which holds a live lease`);
    else if (!holder.missing && options.dirty) {
      // An unreadable status is not a clean one: the worktree is left alone and named.
      const status = statusLines(holder.path, false, checkout);
      if (status.failure) refusals.push(`${name} could not be checked for uncommitted changes (${status.failure})`);
      else if (status.lines!.length) refusals.push(`${name} has uncommitted changes`);
    }
  }
  return refusals;
}

export const heldBranchRefusal = (branch: string, refusals: string[]) =>
  `Branch ${branch} is held by another worktree that was not reclaimed: ${refusals.join('; ')}. Finish or abort its operation, or remove that worktree, before retrying.`;

/**
 * Frees `branch` for the worktree about to be created at `target`, returning what was reclaimed,
 * or throws naming every holder it may not touch. A holder is reclaimed only when it is a session
 * worktree directly under `<root>/.graphyard/worktrees` belonging to `work`, its epoch holds no
 * live lease on `now`, and it has no uncommitted changes. An ordinary checkout is judged by the
 * same rules, except that one outside `.graphyard/worktrees` (the worker's earlier checkout of the
 * branch, which may be the repository's own) is detached as the rework path always did, and only
 * changes to tracked files count against it: detaching moves no file, and untracked files are its
 * owner's scratch. A dirty checkout, or another item's session checkout, is named, never changed.
 * The record of a deleted session worktree is removed. An operation in progress is aborted; on a
 * rework (`options.checkouts`, which also reclaims ordinary checkouts), whose new workspace resets
 * the branch to the remote candidate, the tip the abort leaves is first kept under
 * `refs/graphyard/reclaimed/<worktree>` unless the remote branch already holds it. The
 * clean worktree is then removed, unless it holds ignored files (which removal would delete) or
 * git will not remove it, and then detached; an ordinary checkout is detached, keeping what it holds.
 */
export function reclaimBranchHolders(root: string, branch: string, target: string, work: Pick<Work, 'key' | 'lease'>, now: number, options: { checkouts: boolean }): ReclaimedHolder[] {
  // A deleted worktree's record holds the branch on a first attempt as much as on a rework.
  const holders = branchHolders(root, branch, target).filter(holder => holder.via !== 'checkout' || options.checkouts || holder.missing);
  const refusals = holderRefusals(root, holders, work, now, { dirty: true });
  if (refusals.length) throw new Error(heldBranchRefusal(branch, refusals));
  const reclaimed: ReclaimedHolder[] = [];
  for (const holder of holders) {
    if (holder.missing) {
      // Only this record goes. A git that will not remove a missing worktree has its admin directory
      // deleted instead: `git worktree prune` would also drop every other stale record in the repository.
      const removed = git(['worktree', 'remove', holder.path], root);
      if (removed.status !== 0) {
        const record = worktreeRecord(root, holder.path);
        if (!record) throw new Error(`${gitFailure(['worktree', 'remove', holder.path], removed)}, and no worktree record under the repository's admin directory names ${holder.path}`);
        // A lock is somebody's decision to keep the record; it is named, never overridden.
        if (existsSync(resolve(record, 'locked'))) throw new Error(`${gitFailure(['worktree', 'remove', holder.path], removed)}; its record ${record} is locked, so it is left alone. Unlock it with git worktree unlock before retrying.`);
        rmSync(record, { recursive: true, force: true });
      }
      reclaimed.push({ ...holder, action: 'removed the record of the deleted worktree' });
      continue;
    }
    if (holder.via === 'checkout') {
      gitOrThrow(['-C', holder.path, 'checkout', '--detach', '--quiet']);
      reclaimed.push({ ...holder, action: 'detached its HEAD' });
      continue;
    }
    // `git bisect reset` takes an optional commit and nothing else: `--quiet` would be read as one.
    const abort = holder.via === 'bisect' ? ['bisect', 'reset'] : [holder.via, '--abort'];
    gitOrThrow(['-C', holder.path, ...abort]);
    const kept = options.checkouts ? keepTip(root, holder, branch) : '';
    const ignored = statusLines(holder.path, true);
    const removed = ignored.lines?.some(line => line.startsWith('!! ')) || ignored.failure ? null : git(['worktree', 'remove', holder.path], root);
    if (removed?.status === 0) { reclaimed.push({ ...holder, action: `aborted the ${holder.via}${kept} and removed the worktree` }); continue; }
    gitOrThrow(['-C', holder.path, 'checkout', '--detach', '--quiet']);
    const why = removed ? gitFailure(['worktree', 'remove', holder.path], removed) : ignored.failure ? `its ignored files could not be listed: ${ignored.failure}` : 'it holds ignored files, which removing it would delete';
    reclaimed.push({ ...holder, action: `aborted the ${holder.via}${kept} and detached its HEAD (${why})` });
  }
  return reclaimed;
}

/** The admin directory (`<common-dir>/worktrees/<name>`) recording the worktree at `path`, found by its `gitdir` file. */
export function worktreeRecord(root: string, path: string): string | null {
  const common = resolve(root, gitOrThrow(['rev-parse', '--git-common-dir'], root).trim()), records = resolve(common, 'worktrees');
  let names: string[];
  try { names = readdirSync(records); } catch { return null; }
  const target = resolve(path, '.git');
  for (const name of names) {
    let gitdir: string;
    try { gitdir = readFileSync(resolve(records, name, 'gitdir'), 'utf8').trim(); } catch { continue; }
    if (resolve(records, name, gitdir) === target) return resolve(records, name);
  }
  return null;
}

/**
 * Keeps the commit an aborted operation left `holder` on under `refs/graphyard/reclaimed/<worktree>`,
 * unless the remote branch already contains it: a rework workspace is reset to the remote candidate
 * once the holder is gone, and its local commits would otherwise be referenced by nothing.
 */
function keepTip(root: string, holder: BranchHolder, branch: string) {
  const tip = gitOrThrow(['-C', holder.path, 'rev-parse', 'HEAD']).trim();
  if (git(['merge-base', '--is-ancestor', tip, `refs/remotes/origin/${branch}`], root).status === 0) return '';
  const ref = `refs/graphyard/reclaimed/${basename(holder.path)}`;
  gitOrThrow(['update-ref', ref, tip], root);
  return `, kept its tip ${tip.slice(0, 12)} as ${ref}`;
}
