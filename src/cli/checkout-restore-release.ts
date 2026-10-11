// Concern: the release a checkout-restore request is served from (GY-1680) — the verified serving release, materialized as a detached shared-clone snapshot whose CLI runs the quiesce-and-restore — and the serve entry that CLI answers.
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChildProcessError, type ChildRun, defaultChildRun } from '../child-runner.js';
import { type CheckoutQuiesce, type RestoreAct, type RestoreActOutcome, restoreInProcess } from './master-checkout-restore.js';

// GY-1679: the loop served `master checkout-restore` from the code it had loaded, so a fix to the
// serve path (GY-1672's unreadable-cwd skip) reached no installation whose loop could not restart —
// the very loop the request exists to restart. The act now runs from the release the deployment
// step verified serving (or, while none is observed, the base branch's tip at origin): the loop
// clones it `--shared` into a scratch directory, detached at that commit, and runs that snapshot's
// CLI with the serve entry, which does the quiesce-and-restore and prints what it restored. The loop
// keeps what only it can do — settling the escalation and restarting through its unit. A release
// that cannot be materialized, or one from before the serve entry existed (its CLI would file a
// request instead), is served by the loop's own code, and the outcome says so.

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const short = (commit: string) => commit.slice(0, 12);

/** The flag the loop runs the snapshot's CLI with: `master checkout-restore --serve ROOT REASON`. */
export const checkoutRestoreServeFlag = '--serve';
export const checkoutRestoreServeUsage = `Use master checkout-restore ${checkoutRestoreServeFlag} ROOT REASON (the loop runs this in a snapshot of the serving release; it is not a command to run by hand)`;

/** The release the act runs from: the verified serving release, or the base branch's tip at origin. */
export interface ServingRelease { commit: string; source: 'deployment' | 'origin' }
/** What choosing the serving release reads: the loop's deployment observation and the base branch. */
export interface ServingReleaseInputs { deployment: { source: string; sha: string | null } | null; baseBranch: string }
/**
 * The verified serving release when the deployment step observed one and the checkout's object store
 * holds it; otherwise the base branch's tip at origin, fetched first (a fetch that fails leaves the
 * ref as it stands). Neither resolving is a reason, never a guess.
 */
export async function servingRelease(root: string, inputs: ServingReleaseInputs, run: ChildRun = defaultChildRun): Promise<ServingRelease | { reason: string }> {
  const git = async (args: string[]) => String(await run('git', ['-C', root, ...args]));
  const holds = (ref: string) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(out => out.trim() || null, () => null);
  const served = inputs.deployment && inputs.deployment.source !== 'unavailable' ? inputs.deployment.sha : null;
  const reasons: string[] = [];
  if (served) {
    const commit = await holds(served);
    if (commit) return { commit, source: 'deployment' };
    reasons.push(`the verified release ${short(served)} is missing from the checkout's object store`);
  } else reasons.push('no verified release is observed serving');
  const base = `refs/remotes/origin/${inputs.baseBranch}`;
  try { await git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${inputs.baseBranch}:${base}`]); }
  catch (error) { reasons.push(`origin/${inputs.baseBranch} could not be fetched (${message(error).split('\n')[0]})`); }
  const tip = await holds(base);
  if (tip) return { commit: tip, source: 'origin' };
  reasons.push(`${base} does not resolve`);
  return { reason: reasons.join('; ') };
}

/**
 * `commit` from the checkout's object store, checked out detached into a scratch directory outside
 * every repository: a `--shared` clone (the object store is the checkout's; nothing is copied), with
 * the checkout's node_modules linked beside it so the snapshot's CLI resolves its dependencies.
 */
export async function snapshotRelease(root: string, commit: string, run: ChildRun = defaultChildRun): Promise<{ directory: string; dispose: () => Promise<void> }> {
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-checkout-restore-release-'));
  const directory = join(scratch, 'release');
  const dispose = () => rm(scratch, { recursive: true, force: true });
  try {
    await run('git', ['clone', '-q', '--shared', '--no-checkout', root, directory]);
    await run('git', ['-C', directory, 'checkout', '-q', '--detach', commit]);
    const modules = join(root, 'node_modules');
    if (existsSync(modules) && !existsSync(join(directory, 'node_modules'))) await symlink(modules, join(directory, 'node_modules'), 'dir');
    return { directory, dispose };
  } catch (error) { await dispose(); throw error; }
}
/** Whether a snapshot's CLI answers the serve entry: a release from before it would file a request of its own instead. */
export function releaseServes(directory: string): boolean {
  try { return readFileSync(join(directory, 'src', 'cli', 'checkout-restore-release.ts'), 'utf8').includes('checkoutRestoreServeFlag'); } catch { return false; }
}

const serveOutputSchema = z.object({
  restored: z.object({ ref: z.string(), commit: z.string(), paths: z.array(z.string()), skipped: z.array(z.object({ pid: z.number().int(), error: z.string() })).default([]) }).nullable(),
  head: z.string().nullable(),
}).strict();
export type ServeOutput = z.infer<typeof serveOutputSchema>;

export interface ReleaseRestoreDeps {
  /** The loop's deployment observation and base branch, read when a request is served. */
  release: () => ServingReleaseInputs;
  run?: ChildRun; quiesce?: CheckoutQuiesce;
  /** The snapshot's CLI entry and how it is started; defaults to `node SNAPSHOT/bin/graphyard.mjs`. */
  command?: (directory: string) => { command: string; args: string[] };
  /** How long the snapshot's act may take; the freeze alone waits up to 5 s a round. */
  timeoutMs?: number;
}
/**
 * The loop's restore act (GY-1680): the quiesce-and-restore run by the serving release's own CLI in
 * a detached shared-clone snapshot of it, so a fix delivered to the serve path serves the next
 * request without the loop having loaded it. The loop's own code serves only when no release can
 * be materialized or the release predates the serve entry, and `served` says which.
 */
export function releasePinnedRestore(deps: ReleaseRestoreDeps): RestoreAct {
  const run = deps.run ?? defaultChildRun;
  const own = (why: string) => (root: string, reason: string, at: Date) => restoreInProcess(run, deps.quiesce)(root, reason, at).then(outcome => ({ ...outcome, served: `served by the loop's own code: ${why}` }));
  return async (root, reason, at): Promise<RestoreActOutcome> => {
    const release = await servingRelease(root, deps.release(), run);
    if ('reason' in release) return own(`no serving release could be materialized (${release.reason})`)(root, reason, at);
    const named = `the ${release.source === 'deployment' ? 'verified serving' : 'origin base-branch'} release ${short(release.commit)}`;
    let snapshot: Awaited<ReturnType<typeof snapshotRelease>>;
    try { snapshot = await snapshotRelease(root, release.commit, run); }
    catch (error) { return own(`${named} could not be snapshotted (${message(error).split('\n')[0]})`)(root, reason, at); }
    try {
      if (!releaseServes(snapshot.directory)) return await own(`${named} predates the serve entry`)(root, reason, at);
      const served = `served from ${named}, a detached shared-clone snapshot of it`;
      const entry = deps.command?.(snapshot.directory) ?? { command: process.execPath, args: [join(snapshot.directory, 'bin', 'graphyard.mjs')] };
      let output: string;
      try { output = String(await run(entry.command, [...entry.args, 'master', 'checkout-restore', checkoutRestoreServeFlag, root, reason], { cwd: snapshot.directory, timeoutMs: deps.timeoutMs ?? 10 * 60_000 })); }
      catch (error) { throw new Error(`${served}: ${error instanceof ChildProcessError && error.stderr.trim() ? error.stderr.trim() : message(error)}`.slice(0, 4000)); }
      let parsed: ServeOutput;
      try { parsed = serveOutputSchema.parse(JSON.parse(output)); }
      catch (error) { throw new Error(`${served}, whose outcome could not be read (${message(error).split('\n')[0]}): ${output.trim().slice(0, 500)}`); }
      return { ...parsed, served };
    } finally { await snapshot.dispose(); }
  };
}

/**
 * The serve entry (`master checkout-restore --serve ROOT REASON`): the quiesce-and-restore of the
 * checkout at ROOT, run by whichever release's CLI the loop started, printing what it restored and
 * the checkout's HEAD after. A refusal (an unverifiable writer, a path a restore cannot save) is an
 * error on stderr and a failed exit, which the loop records as the request's outcome.
 */
export async function serveCheckoutRestoreAct(args: readonly string[], options: { run?: ChildRun; quiesce?: CheckoutQuiesce; now?: Date } = {}): Promise<ServeOutput> {
  const [root, ...rest] = args, reason = rest.join(' ').trim();
  if (!root || !reason) throw new Error(checkoutRestoreServeUsage);
  const { restored, head } = await restoreInProcess(options.run ?? defaultChildRun, options.quiesce)(root, reason, options.now ?? new Date());
  return { restored, head };
}
