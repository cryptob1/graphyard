// Concern: a stale attempt worktree holding the item's branch (GY-860) — its stopped state captured, the operation ended, and the branch released to the new attempt's worktree.
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { ChildRun } from '../child-runner.js';
import type { Work } from '../model.js';
import { submittedBranchMoved } from '../model/assignment.js';
import { branchHolders, heldBranchRefusal, holderRefusals } from '../worktree-holders.js';
import { failureText, worktreesDirectory } from './worktrees.js';

// ---- Stale attempt worktrees hold the item's branch (GY-860) -------------------------------------

/** What an earlier attempt's worktree held when an allocation released its branch: where it was, what it pointed at, the operation it was mid-way through, and the uncommitted diff it carried. */
export interface PreservedWorktree { path: string; head: string; branchTip: string; op: 'rebase' | 'merge' | 'cherry-pick' | null; refs: string; diff: string; at: string }

/** The git a branch release runs: the asynchronous runner, so a launcher on this loop never blocks on a child. */
export type BranchGit = (cwd: string, ...args: string[]) => Promise<string>;

/** An operation a holder can be stopped inside; the ledger's record names the first three, and the diff's first line names the rest. */
type HolderOperation = NonNullable<PreservedWorktree['op']> | 'revert' | 'merge --squash';

/** The in-progress operation a worktree is stopped inside, or null; each state lives in that worktree's own git dir. */
async function inProgressOperation(git: BranchGit, path: string): Promise<HolderOperation | null> {
  const gitPath = async (name: string) => resolve(path, (await git(path, 'rev-parse', '--git-path', name)).trim());
  if (existsSync(await gitPath('rebase-merge')) || existsSync(await gitPath('rebase-apply'))) return 'rebase';
  if (existsSync(await gitPath('MERGE_HEAD'))) return 'merge';
  if (existsSync(await gitPath('CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(await gitPath('REVERT_HEAD'))) return 'revert';
  // `merge --squash` writes no MERGE_HEAD; its message file is what marks it.
  if (existsSync(await gitPath('SQUASH_MSG'))) return 'merge --squash';
  return null;
}

/** The branch a stopped rebase is rewriting, read from its own state, or empty. */
async function rebaseHeadName(git: BranchGit, path: string): Promise<string> {
  for (const state of ['rebase-merge', 'rebase-apply']) {
    const directory = resolve(path, (await git(path, 'rev-parse', '--git-path', state)).trim());
    if (!existsSync(directory)) continue;
    try { return (await readFile(resolve(directory, 'head-name'), 'utf8')).trim(); } catch { return ''; }
  }
  return '';
}

/** The most `git diff` output a release buffers (GY-1059): far above the ledger's limit, far below the runner's. */
export const preservedDiffCaptureBytes = 1024 * 1024;

/**
 * The holder's uncommitted tracked changes, bounded before they are buffered: a diff larger than
 * the capture limit (or one git cannot produce) is recorded as its stat instead, saying so.
 */
async function trackedDiff(run: ChildRun, path: string): Promise<string> {
  try { return String(await run('git', ['-C', path, 'diff', 'HEAD'], { maxBuffer: preservedDiffCaptureBytes })); }
  catch (error) {
    let stat = '';
    try { stat = String(await run('git', ['-C', path, 'diff', 'HEAD', '--stat=200'], { maxBuffer: preservedDiffCaptureBytes })); } catch {}
    return `-- the full diff could not be captured (${failureText(error).split('\n')[0]}); its stat follows --\n${stat}`;
  }
}

/**
 * Each untracked file by path and content, within `budget` characters: the record alone can then
 * restore it, not only name it. A binary file, a symlink or anything past the budget is named only
 * and returned in `unrecorded` (GY-1215), for whoever cleans the worktree to keep.
 */
async function untrackedContents(git: BranchGit, path: string, budget: number): Promise<{ text: string; unrecorded: string[] }> {
  const paths = (await git(path, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  const sections: string[] = [], unrecorded: string[] = [];
  let used = 0;
  for (const name of paths) {
    const file = resolve(path, name), info = await lstat(file).catch(() => null);
    let section = `-- untracked file ${name} --`, whole = false;
    if (info?.isSymbolicLink()) section = `-- untracked symlink ${name} --`;
    else if (info?.isFile() && used + section.length < budget) {
      const handle = await open(file, 'r');
      try {
        const room = Math.min(info.size, budget - used - section.length - 1);
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(room), 0, room, 0);
        const bytes = buffer.subarray(0, bytesRead), text = bytes.toString('utf8');
        if (bytes.includes(0)) section = `-- untracked binary file ${name} (${info.size} bytes) --`;
        else {
          section += `\n${text}${bytesRead < info.size ? `\n… ${info.size - bytesRead} more bytes not recorded` : ''}`;
          // Bytes that are not UTF-8 do not survive the record either.
          whole = bytesRead === info.size && Buffer.from(text, 'utf8').equals(bytes);
        }
      } finally { await handle.close(); }
    }
    if (!whole) unrecorded.push(name);
    sections.push(section); used += section.length + 1;
  }
  return { text: sections.join('\n'), unrecorded };
}

/** Move the untracked files a record names but does not hold into `aside`, keeping their relative paths (GY-1215); a file that cannot be kept rejects, so the clean that would delete it never runs. */
async function moveAside(path: string, names: string[], aside: string) {
  for (const name of names) {
    const from = resolve(path, name), to = resolve(aside, name);
    if (!await lstat(from).catch(() => null)) continue;
    await mkdir(dirname(to), { recursive: true });
    try { await rename(from, to); }
    catch { await cp(from, to, { recursive: true, verbatimSymlinks: true }); }
  }
}

/** Where a reused path's unrecorded untracked files go (GY-1274): `<common git dir>/graphyard-preserved/<worktree>/<time>`, which outlives the worktree's own git dir; an unresolvable git dir rejects before anything changes. */
async function keptDirectory(run: ChildRun, holderPath: string, at: string): Promise<string> {
  const common = String(await run('git', ['-C', holderPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  if (!common) throw new Error(`Cannot keep the untracked files of ${holderPath}: git named no common git dir for it`);
  return resolve(common, 'graphyard-preserved', basename(holderPath), at.replace(/[:.]/g, '-'));
}

/**
 * Free the item's branch for a new attempt's worktree (GY-860 AC-1). When a session worktree
 * directly under `.graphyard/worktrees` holds it — checked out, or stopped inside a rebase naming
 * it, a merge, a squash merge, a cherry-pick or a revert — its state is captured, the operation
 * ended and its HEAD detached, so `git worktree add` succeeds. Any other checkout is never touched
 * (GY-1059), nor a stopped `git am` (left to the GY-1078 reclaim); the branch ref never moves. A
 * locked record whose directory is gone is unlocked and pruned. The new attempt's own path keeps
 * its worktree, forced back onto the branch and returned with `reused`; its clean deletes only
 * what the record holds in full, moving merely named untracked files aside (GY-1215).
 * `register` receives the captured state (or null) before anything changes, so a refused
 * registration leaves the holder as it was. Probes answer empty on a refusal; a step that changes
 * the holder and fails rejects.
 */
export async function releaseHeldBranch(root: string, branch: string, targetPath: string, run: ChildRun,
  register: (preserved: PreservedWorktree | null) => Promise<unknown> = async () => {}): Promise<{ preserved: PreservedWorktree; reused: boolean } | null> {
  const ref = `refs/heads/${branch}`, sessions = worktreesDirectory(root);
  // Quiet git answers empty on a refusal; the caller decides what a refusal means.
  const quiet = async (...args: string[]) => { try { return await run('git', args); } catch { return ''; } };
  const git: BranchGit = async (cwd, ...args) => quiet('-C', cwd, ...args);
  // Registrations whose directory is gone hold nothing but still refuse a new checkout.
  await quiet('-C', root, 'worktree', 'prune');
  const raw = await git(root, 'worktree', 'list', '--porcelain', '-z');
  if (!raw.trim()) { await register(null); return null; }
  const branchTip = (await git(root, 'rev-parse', '--verify', ref)).trim();
  for (const record of raw.split('\0\0')) {
    const fields = record.split('\0');
    const holderPath = fields.find(field => field.startsWith('worktree '))?.slice('worktree '.length);
    if (!holderPath || resolve(dirname(holderPath)) !== sessions) continue;
    if (!existsSync(holderPath)) {
      // A locked record survives `worktree prune` and still holds the branch it names.
      if (fields.some(field => field === 'locked' || field.startsWith('locked ')) && fields.includes(`branch ${ref}`)) {
        await run('git', ['-C', root, 'worktree', 'unlock', holderPath]);
        await run('git', ['-C', root, 'worktree', 'prune']);
      }
      continue;
    }
    // A stopped `git am` keeps its state in `rebase-apply` too, but `rebase --abort` refuses it:
    // that holder is left to the GY-1078 reclaim the worktree command runs next, which aborts it.
    if (existsSync(resolve(holderPath, (await git(holderPath, 'rev-parse', '--git-path', 'rebase-apply/applying')).trim()))) continue;
    // A rebase detaches the holder's HEAD, so the branch shows neither in the porcelain record
    // nor as HEAD: the rebase's own head-name is what still holds it.
    const op = await inProgressOperation(git, holderPath);
    const headName = op === 'rebase' ? await rebaseHeadName(git, holderPath) : '';
    if (!fields.includes(`branch ${ref}`) && headName !== ref) continue;
    const diffLimit = 100_000, truncated = `\n… truncated to ${diffLimit} characters`;
    const recorded = op === 'rebase' || op === 'merge' || op === 'cherry-pick' ? op : null;
    const tracked = `${op && !recorded ? `-- stopped inside git ${op} --\n` : ''}${await trackedDiff(run, holderPath)}`;
    const reused = resolve(holderPath) === resolve(targetPath), at = new Date().toISOString();
    const aside = reused ? await keptDirectory(run, holderPath, at) : '';
    const keptNote = `\n-- untracked files not recorded in full are kept under ${aside} --`;
    const heading = `${tracked ? '\n' : ''}-- untracked files --\n`;
    // The heading, note and truncation suffix count toward the limit, so a cut never ends a file recorded in full (GY-1274).
    const untracked = await untrackedContents(git, holderPath, diffLimit - tracked.length - heading.length - truncated.length - (reused ? keptNote.length : 0));
    const note = reused && untracked.unrecorded.length ? keptNote : '', room = diffLimit - note.length;
    const fullDiff = tracked + (untracked.text && tracked.length < diffLimit ? `${heading}${untracked.text}` : '');
    const head = (await git(holderPath, 'rev-parse', 'HEAD')).trim(), refs = (await git(holderPath, 'show-ref')).trim().slice(0, 20_000);
    // The suffix and the note count toward the limit, so a truncated diff still fits the ledger's schema.
    const diff = `${fullDiff.length > room ? `${fullDiff.slice(0, room - truncated.length)}${truncated}` : fullDiff}${note}`;
    const preserved: PreservedWorktree = { path: holderPath, head, branchTip, op: recorded, refs, diff, at };
    await register(preserved);
    const letGo = async (args: string[]) => { await run('git', ['-C', holderPath, ...args]); };
    if (op === 'rebase') await letGo(['rebase', '--abort']);
    if (op === 'merge') await letGo(['merge', '--abort']);
    // `--abort` returns a stopped sequence to where it began, which would move the branch back
    // past the commits already made; quitting and resetting the conflicted index ends it where
    // the branch stands. A squash merge has no sequence: its conflicted index is reset.
    if (op === 'cherry-pick' || op === 'revert') await letGo([op, '--quit']);
    if (op && op !== 'rebase' && op !== 'merge') await letGo(['reset', '--merge']);
    if (op === 'merge --squash') await unlink(resolve(holderPath, (await git(holderPath, 'rev-parse', '--git-path', 'SQUASH_MSG')).trim())).catch(() => {});
    if (reused) {
      // The same epoch's own path: what a failed preparation left there is in the record or moved aside, and the session starts clean.
      await moveAside(holderPath, untracked.unrecorded, aside);
      await letGo(['checkout', '--quiet', '--force', branch]);
      await letGo(['clean', '-fd', '--quiet']);
    } else await letGo(['checkout', '--detach', '--quiet']);
    return { preserved, reused };
  }
  await register(null);
  return null;
}

/**
 * Release this attempt's claim as a workspace failure (GY-860 AC-2): the control plane keeps the
 * git message on the item and, while the attempt is still the untouched claim, undoes it, so the
 * epoch returns and no attempt is consumed. A release the server refuses — a lease that lapsed or
 * was superseded while git ran included — returned nothing, so it is never reported as one
 * (GY-1059): the error keeps the original git failure, which names the workspace rather than the
 * profile, and says the epoch is spent.
 */
export async function releaseUnderFailure(mutate: (name: string, data: unknown) => Promise<unknown>, epoch: number, message: string) {
  try { await mutate('release', { epoch, failure: { message: message.slice(0, 2000) } }); }
  catch (releaseError) {
    throw Object.assign(new Error(`Git worktree creation failed: ${message.slice(0, 2000)}. The claim could not be released as a workspace failure (${failureText(releaseError)}), so epoch ${epoch} is spent rather than handed back.`), { cause: releaseError });
  }
}

/**
 * GY-860 AC-2, GY-2035: why a rework workspace may not start from the submitted PR branch, or null
 * when it may. The workspace starts from the worker's local branch, so the local head alone
 * decides: one that is missing, or holds anything but the submitted candidate, refuses with the
 * existing message. Origin is never asked — no fetch, no push, whatever it holds for the branch
 * (GY-1753's push of a local-only head is gone): workers' branches never touch origin, the merge
 * writer is the only git network user, and a stale remote-tracking ref is never a start point.
 */
export async function submittedBranchRefusal(root: string, branch: string, candidateSha: string | undefined, run: ChildRun): Promise<string | null> {
  let sha = '';
  try { sha = String(await run('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: root })).trim(); } catch { /* a branch that is gone holds no candidate */ }
  return !candidateSha || sha !== candidateSha ? submittedBranchMoved : null;
}

/**
 * GY-860: record the reservation with any earlier attempt's preserved hold on the branch, then
 * release that hold. A holder whose epoch holds a live lease, or an operation outside this item's
 * session worktrees, is never touched (GY-1078): it is named and nothing is reserved; so, on a
 * first attempt, is a checkout outside the session worktrees (GY-1059), which only a rework's
 * reclaim may detach. A deleted worktree's record is skipped: the release prunes it. A refusal, a
 * refused reservation or a failed release is a workspace failure that costs no attempt — except
 * that a reservation refused because another `worktree` run for this epoch made it first leaves
 * that run's reservation and the claim alone (GY-1059), so the run still building keeps both.
 */
export async function reserveReleasingHold(root: string, branch: string, path: string, run: ChildRun, mutate: (name: string, data: unknown) => Promise<unknown>, epoch: number, host: string,
  work: Pick<Work, 'key' | 'lease' | 'submission'>, now: number) {
  const branchExists = await Promise.resolve().then(() => run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root })).then(() => true, () => false);
  const holders = branchExists ? branchHolders(root, branch, path).filter(holder => !holder.missing) : [];
  const refusals = holderRefusals(root, holders, work, now, { dirty: false });
  if (!work.submission) for (const holder of holders) {
    if (holder.via === 'checkout' && resolve(dirname(holder.path)) !== worktreesDirectory(root)) refusals.push(`${holder.path} (checked out) is outside the session worktrees under ${worktreesDirectory(root)}, and Graphyard detaches only its own session worktrees: check out another branch there`);
  }
  if (refusals.length) {
    const detail = heldBranchRefusal(branch, refusals);
    await releaseUnderFailure(mutate, epoch, detail);
    throw new Error(`Git worktree creation failed: ${detail} The claim was released as a workspace failure, so the attempt costs nothing.`);
  }
  try { return await releaseHeldBranch(root, branch, path, run, preserved => mutate('workspace', { epoch, host, path, branch, ...(preserved ? { preserved } : {}) })); }
  catch (error) {
    const detail = failureText(error);
    if (/This assignment already has a workspace/.test(detail)) throw new Error(`Git worktree creation failed: ${detail}. Another worktree run for ${work.key} epoch ${epoch} reserved it first, so this run leaves that reservation and the claim alone.`);
    await releaseUnderFailure(mutate, epoch, `Reserving ${branch} or releasing an earlier attempt's hold on it failed: ${detail}`);
    throw new Error(`Git worktree creation failed while reserving ${branch} or releasing an earlier attempt's hold on it: ${detail}. The claim was released as a workspace failure, so the attempt costs nothing; repair the host and it redispatches.`);
  }
}

/** GY-860: a worktree the host's git could not build releases the claim with git's message, so the epoch returns; the error says so. */
export async function workspaceFailure(mutate: (name: string, data: unknown) => Promise<unknown>, epoch: number, error: unknown): Promise<never> {
  const detail = failureText(error);
  await releaseUnderFailure(mutate, epoch, detail);
  throw new Error(`Git worktree creation failed: ${detail}. The claim was released as a workspace failure, so the attempt costs nothing; inspect the event and repair the host before it redispatches.`);
}
