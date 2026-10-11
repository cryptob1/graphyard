// Concern: the release a checkout-restore request is served from (GY-1680) — the verified serving release, materialized as a detached shared-clone snapshot whose CLI runs the quiesce-and-restore under a grant the loop issues — and the serve entry that CLI answers.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ChildProcessError, type ChildRun, defaultChildRun } from '../child-runner.js';
import { atomicPrivateWrite } from '../master/config.js';
import { type CheckoutQuiesce, type RestoreAct, type RestoreActOutcome, readCheckoutRestoreRequest, restoreInProcess } from './master-checkout-restore.js';

// GY-1679: the loop served `master checkout-restore` from the code it had loaded, so a fix to the
// serve path (GY-1672's unreadable-cwd skip) reached no installation whose loop could not restart —
// the very loop the request exists to restart. The act now runs from the release the deployment
// step verified serving (or, while none is observed, the base branch's tip at origin): the loop
// clones it `--shared` into a scratch directory, detached at that commit, and runs that snapshot's
// CLI with the serve entry, which does the quiesce-and-restore and prints what it restored. The loop
// keeps what only it can do — settling the escalation and restarting through its unit. The loop's
// own loaded code never serves: when neither sanctioned release can be materialized with the serve
// entry, the request fails with the reasons, and nothing is touched (review of GY-1680).
//
// The serve entry alters files, so it is not a command but a capability (review of GY-1680): the
// loop writes a single-use grant beside its cursor — the checkout, the reason, the standing request,
// its own pid and the pid its cursor lock names, an expiry, and the digest of a random token — and
// hands the snapshot's CLI the grant's path and the token through its environment. The entry serves
// only when the token matches, the grant has not expired, the issuing pid is this process's ancestor,
// the request the grant names still stands unanswered beside it, and the cursor beside it (when one
// holds a lock) is locked by the pid the grant names; it consumes the grant before touching anything.
// A confined master, a worker, or a hand that runs the entry has no grant and is refused.

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const short = (commit: string) => commit.slice(0, 12);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/** The flag the loop runs the snapshot's CLI with: `master checkout-restore --serve`, everything else in the grant. */
export const checkoutRestoreServeFlag = '--serve';
/** The environment the loop hands the snapshot's CLI: the grant's path, and the token whose digest the grant holds. */
export const checkoutRestoreGrantVariable = 'GRAPHYARD_CHECKOUT_RESTORE_GRANT';
export const checkoutRestoreGrantTokenVariable = 'GRAPHYARD_CHECKOUT_RESTORE_GRANT_TOKEN';
export const checkoutRestoreServeUsage = `master checkout-restore ${checkoutRestoreServeFlag} is the loop's own act, run in a snapshot of the serving release under a grant the loop issues (${checkoutRestoreGrantVariable}); it is not a command to run by hand: file master checkout-restore REASON, which the loop serves`;
/** How long a grant serves after it is issued: the snapshot's act is bounded well inside it. */
export const checkoutRestoreGrantTtlMs = 15 * 60_000;

/** A release the act may run from: the verified serving release, or the base branch's tip at origin. */
export interface ServingRelease { commit: string; source: 'deployment' | 'origin' }
/** What choosing the serving releases reads: the loop's deployment observation and the base branch. */
export interface ServingReleaseInputs { deployment: { source: string; sha: string | null } | null; baseBranch: string }
/**
 * The releases sanctioned to serve, in order: the verified serving release when the deployment step
 * observed one and the checkout's object store holds it, then the base branch's tip at origin, fetched
 * first (a fetch that fails leaves the ref as it stands), when it is a different commit. `reasons`
 * says why each absent one is absent. Nothing else is ever a candidate: never a guess, never the
 * loop's own code.
 */
export async function servingReleases(root: string, inputs: ServingReleaseInputs, run: ChildRun = defaultChildRun): Promise<{ releases: ServingRelease[]; reasons: string[] }> {
  const git = async (args: string[]) => String(await run('git', ['-C', root, ...args]));
  const holds = (ref: string) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(out => out.trim() || null, () => null);
  const served = inputs.deployment && inputs.deployment.source !== 'unavailable' ? inputs.deployment.sha : null;
  const releases: ServingRelease[] = [], reasons: string[] = [];
  if (served) {
    const commit = await holds(served);
    if (commit) releases.push({ commit, source: 'deployment' });
    else reasons.push(`the verified release ${short(served)} is missing from the checkout's object store`);
  } else reasons.push('no verified release is observed serving');
  const base = `refs/remotes/origin/${inputs.baseBranch}`;
  try { await git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${inputs.baseBranch}:${base}`]); }
  catch (error) { reasons.push(`origin/${inputs.baseBranch} could not be fetched (${message(error).split('\n')[0]})`); }
  const tip = await holds(base);
  if (tip && !releases.some(release => release.commit === tip)) releases.push({ commit: tip, source: 'origin' });
  else if (!tip) reasons.push(`${base} does not resolve`);
  return { releases, reasons };
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
/** Whether a snapshot's CLI answers the serve entry under a grant: a release from before it would file a request of its own, or take a root from the command line. */
export function releaseServes(directory: string): boolean {
  try { return readFileSync(join(directory, 'src', 'cli', 'checkout-restore-release.ts'), 'utf8').includes(checkoutRestoreGrantVariable); } catch { return false; }
}

const serveOutputSchema = z.object({
  restored: z.object({ ref: z.string(), commit: z.string(), paths: z.array(z.string()), skipped: z.array(z.object({ pid: z.number().int(), error: z.string() })).default([]) }).nullable(),
  head: z.string().nullable(),
}).strict();
export type ServeOutput = z.infer<typeof serveOutputSchema>;

/** The grant the loop writes beside its cursor for one serve, read back by the snapshot's CLI. */
const grantSchema = z.object({
  token: z.string().length(64), root: z.string().min(1), reason: z.string().min(1),
  request: z.object({ file: z.string().min(1), id: z.string().min(1) }).strict(),
  /** The issuing loop: its process, the pid its cursor lock names, and the cursor itself (beside the grant). */
  loop: z.object({ pid: z.number().int().positive(), lock: z.number().int().positive(), cursor: z.string().min(1) }).strict(),
  issuedAt: z.string(), expiresAt: z.string(),
}).strict();
export type CheckoutRestoreGrant = z.infer<typeof grantSchema>;

export interface ReleaseRestoreDeps {
  /** The loop's deployment observation and base branch, read when a request is served. */
  release: () => ServingReleaseInputs;
  /** Where the loop writes the grant (beside its cursor, checkoutRestoreGrantPath), its cursor (daemonStatePath) and the pid its cursor lock names. */
  grant: { file: string; cursor: string; lock: number };
  run?: ChildRun; quiesce?: CheckoutQuiesce;
  /** The snapshot's CLI entry and how it is started; defaults to `node SNAPSHOT/bin/graphyard.mjs`. */
  command?: (directory: string) => { command: string; args: string[] };
  /** How long the snapshot's act may take; the freeze alone waits up to 5 s a round. */
  timeoutMs?: number;
  /** The environment the snapshot's CLI inherits beneath the grant; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}
/**
 * The loop's restore act (GY-1680): the quiesce-and-restore run by a sanctioned release's own CLI in
 * a detached shared-clone snapshot of it, under a single-use grant, so a fix delivered to the serve
 * path serves the next request without the loop having loaded it. The verified serving release is
 * tried first, then origin's base-branch tip; when neither can be snapshotted with the serve entry the
 * act fails naming why, and the loop's own loaded code — what this request exists to replace — is
 * never run.
 */
export function releasePinnedRestore(deps: ReleaseRestoreDeps): RestoreAct {
  const run = deps.run ?? defaultChildRun, now = deps.now ?? Date.now;
  return async (root, reason, _at, request): Promise<RestoreActOutcome> => {
    const { releases, reasons } = await servingReleases(root, deps.release(), run);
    for (const release of releases) {
      const named = `the ${release.source === 'deployment' ? 'verified serving' : 'origin base-branch'} release ${short(release.commit)}`;
      let snapshot: Awaited<ReturnType<typeof snapshotRelease>>;
      try { snapshot = await snapshotRelease(root, release.commit, run); }
      catch (error) { reasons.push(`${named} could not be snapshotted (${message(error).split('\n')[0]})`); continue; }
      try {
        if (!releaseServes(snapshot.directory)) { reasons.push(`${named} predates the serve entry`); continue; }
        const served = `served from ${named}, a detached shared-clone snapshot of it`;
        const entry = deps.command?.(snapshot.directory) ?? { command: process.execPath, args: [join(snapshot.directory, 'bin', 'graphyard.mjs')] };
        const token = randomBytes(32).toString('hex'), issued = now();
        const grant: CheckoutRestoreGrant = { token: digest(token), root, reason, request, loop: { pid: process.pid, lock: deps.grant.lock, cursor: deps.grant.cursor }, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + checkoutRestoreGrantTtlMs).toISOString() };
        await atomicPrivateWrite(deps.grant.file, grant);
        let output: string;
        try {
          output = String(await run(entry.command, [...entry.args, 'master', 'checkout-restore', checkoutRestoreServeFlag],
            { cwd: snapshot.directory, timeoutMs: deps.timeoutMs ?? 10 * 60_000, env: { ...(deps.env ?? process.env), [checkoutRestoreGrantVariable]: deps.grant.file, [checkoutRestoreGrantTokenVariable]: token } }));
        } catch (error) { throw new Error(`${served}: ${error instanceof ChildProcessError && error.stderr.trim() ? error.stderr.trim() : message(error)}`.slice(0, 4000)); }
        finally { await unlink(deps.grant.file).catch(() => {}); }
        let parsed: ServeOutput;
        try { parsed = serveOutputSchema.parse(JSON.parse(output)); }
        catch (error) { throw new Error(`${served}, whose outcome could not be read (${message(error).split('\n')[0]}): ${output.trim().slice(0, 500)}`); }
        return { ...parsed, served };
      } finally { await snapshot.dispose(); }
    }
    throw new Error(`no sanctioned release can serve this request, and the loop's own loaded code is not run (GY-1680): ${reasons.join('; ')}. Once a release holding the serve entry is observed serving or reaches origin, file master checkout-restore REASON again`.slice(0, 4000));
  };
}

/** The pids above this process, nearest first, read from /proc (the loop starts the snapshot's CLI through bin/graphyard.mjs, so it is a grandparent). */
export function ancestorPids(proc = '/proc', self = process.pid, limit = 8): number[] {
  const chain: number[] = [];
  let pid = self;
  while (chain.length < limit) {
    let stat: string;
    try { stat = readFileSync(join(proc, String(pid), 'stat'), 'utf8'); } catch { break; }
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!Number.isInteger(parent) || parent <= 0 || parent === pid) break;
    chain.push(parent); pid = parent;
  }
  return chain;
}

export interface ServeEntryOptions {
  run?: ChildRun; quiesce?: CheckoutQuiesce; now?: Date;
  /** The environment the grant is read from; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** The pids the issuing loop may be: this process and its ancestors, by default. */
  ancestors?: () => number[];
}
/**
 * The grant the environment names, verified: its token's digest, its expiry, the issuing loop among
 * this process's ancestors, the request it names standing unanswered beside it, and the cursor beside
 * it (when one holds a lock) locked by the pid it names. Consumed — the file removed — once verified,
 * so it serves exactly once. Anything short of that is a refusal naming what is missing.
 */
export async function verifyCheckoutRestoreGrant(options: ServeEntryOptions = {}): Promise<CheckoutRestoreGrant> {
  const env = options.env ?? process.env;
  const file = env[checkoutRestoreGrantVariable], token = env[checkoutRestoreGrantTokenVariable];
  if (!file || !token) throw new Error(checkoutRestoreServeUsage);
  let grant: CheckoutRestoreGrant;
  try { grant = grantSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { throw new Error(`the checkout-restore grant at ${file} cannot be read (${message(error).split('\n')[0]}); ${checkoutRestoreServeUsage}`); }
  const refuse = (why: string) => new Error(`the checkout-restore grant at ${file} does not serve: ${why}; nothing was restored`);
  if (grant.token !== digest(token)) throw refuse('its token does not match the one presented');
  const at = (options.now ?? new Date()).getTime();
  if (!(Date.parse(grant.expiresAt) > at)) throw refuse(`it expired at ${grant.expiresAt}`);
  const ancestors = options.ancestors?.() ?? [process.pid, ...ancestorPids()];
  if (!ancestors.includes(grant.loop.pid)) throw refuse(`the loop that issued it, pid ${grant.loop.pid}, is not an ancestor of this process (${ancestors.join(' < ') || 'none readable'})`);
  const beside = dirname(resolve(file));
  if (dirname(resolve(grant.request.file)) !== beside || dirname(resolve(grant.loop.cursor)) !== beside) throw refuse(`the request (${grant.request.file}) and cursor (${grant.loop.cursor}) it names do not both lie beside it`);
  const request = await readCheckoutRestoreRequest(grant.request.file);
  if (!request || request.id !== grant.request.id || request.act !== 'checkout-restore') throw refuse(`the request it names, ${grant.request.id} at ${grant.request.file}, no longer stands`);
  if (request.outcome) throw refuse(`the request it names, ${grant.request.id}, was already answered ${request.outcome.state}`);
  // The cursor beside the grant: the loop's daemon state, locked by the loop that serves (a cursor not yet written holds no lock to judge).
  let lock: number | null = null;
  try { const parsed = JSON.parse(await readFile(grant.loop.cursor, 'utf8')) as { lock?: { pid?: unknown } | null }; lock = typeof parsed.lock?.pid === 'number' ? parsed.lock.pid : null; } catch { lock = null; }
  if (lock !== null && lock !== grant.loop.lock) throw refuse(`the loop's cursor at ${grant.loop.cursor} is locked by pid ${lock}, not the pid ${grant.loop.lock} it names`);
  try { await unlink(file); } catch (error) { throw refuse(`it could not be consumed (${message(error).split('\n')[0]})`); }
  return grant;
}

/**
 * The serve entry (`master checkout-restore --serve`): the quiesce-and-restore of the checkout the
 * loop's grant names, run by whichever release's CLI the loop started, printing what it restored and
 * the checkout's HEAD after. Without a grant that verifies there is no act. A refusal (an unverifiable
 * writer, a path a restore cannot save) is an error on stderr and a failed exit, which the loop
 * records as the request's outcome.
 */
export async function serveCheckoutRestoreAct(args: readonly string[], options: ServeEntryOptions = {}): Promise<ServeOutput> {
  if (args.length) throw new Error(`master checkout-restore ${checkoutRestoreServeFlag} takes no arguments: the checkout and the reason are in the loop's grant. ${checkoutRestoreServeUsage}`);
  const grant = await verifyCheckoutRestoreGrant(options);
  const { restored, head } = await restoreInProcess(options.run ?? defaultChildRun, options.quiesce)(grant.root, grant.reason, options.now ?? new Date(), grant.request);
  return { restored, head };
}
