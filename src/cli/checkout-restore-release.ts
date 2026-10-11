// Concern: the release a checkout-restore request is served from (GY-1680) — the verified serving release, materialized as a detached shared-clone snapshot whose CLI runs the quiesce-and-restore under a grant the loop signs with the coordinator credential — and the serve entry that CLI answers.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { ChildProcessError, type ChildRun, defaultChildRun } from '../child-runner.js';
import { daemonStatePath } from '../daemon/state.js';
import { atomicPrivateWrite, loadStoredMasterConfig, readCredentialFile } from '../master/config.js';
import { coordinatorCheckoutRoot, type MasterConfig } from '../master/profiles.js';
import { type CheckoutQuiesce, type RestoreAct, type RestoreActOutcome, checkoutRestoreGrantPath, checkoutRestoreRequestPath, readCheckoutRestoreRequest, restoreInProcess } from './master-checkout-restore.js';

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
// loop writes a single-use grant beside its cursor — the checkout, the reason, the standing request's
// id, its own pid and the pid its cursor lock names, an expiry and a nonce — signed (HMAC-SHA256)
// with the coordinator credential, the authority only the loop and the master identities hold: a
// worker, a confined master session or a hand has no credential and so can forge no grant. The
// entry is handed only the grant's path, and trusts nothing else a caller could choose: it reads
// the installation from the checkout the grant names (.graphyard/master.json, which must name that
// checkout as its coordinator checkout), verifies the signature with that installation's credential,
// and requires the grant to lie where that installation's loop issues grants, the installation's
// cursor to be locked by the pid the grant names and the issuing pid to be this process's ancestor,
// and the installation's request file to hold the request the grant names still unanswered. A
// cursor that cannot be read or holds no lock refuses: no loop is known to serve. It consumes the
// grant before touching anything, so a grant serves exactly once.
//
// The act can outlast the supervisor's watchdog window (the shipped unit's is 180 s; a fetch, a
// clone and a freeze-and-restore each wait on their own), so the loop's keep-alive is fed on an
// interval for as long as the act runs (review of GY-1680): a long restore is not a hung loop.

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const short = (commit: string) => commit.slice(0, 12);

/** The flag the loop runs the snapshot's CLI with: `master checkout-restore --serve`, everything else in the grant. */
export const checkoutRestoreServeFlag = '--serve';
/** The environment the loop hands the snapshot's CLI: the grant's path, and nothing else of the act. */
export const checkoutRestoreGrantVariable = 'GRAPHYARD_CHECKOUT_RESTORE_GRANT';
/** The kind a grant declares; a release whose entry reads this kind of grant answers the serve entry. */
export const checkoutRestoreGrantKind = 'graphyard-checkout-restore-grant/1';
export const checkoutRestoreServeUsage = `master checkout-restore ${checkoutRestoreServeFlag} is the loop's own act, run in a snapshot of the serving release under a grant the loop signs with the coordinator credential (${checkoutRestoreGrantVariable}); it is not a command to run by hand: file master checkout-restore REASON, which the loop serves`;
/** How long a grant serves after it is issued: the snapshot's act is bounded well inside it. */
export const checkoutRestoreGrantTtlMs = 15 * 60_000;
/** How often the loop's keep-alive is fed while the act runs, when the loop names no cadence of its own. */
export const checkoutRestoreKeepAliveEveryMs = 30_000;

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
/** Whether a snapshot's CLI answers the serve entry under a signed grant: a release from before it would file a request of its own, take a root from the command line, or read a grant it cannot verify. */
export function releaseServes(directory: string): boolean {
  try { return readFileSync(join(directory, 'src', 'cli', 'checkout-restore-release.ts'), 'utf8').includes(checkoutRestoreGrantKind); } catch { return false; }
}

const serveOutputSchema = z.object({
  restored: z.object({ ref: z.string(), commit: z.string(), paths: z.array(z.string()), skipped: z.array(z.object({ pid: z.number().int(), error: z.string() })).default([]) }).nullable(),
  head: z.string().nullable(),
}).strict();
export type ServeOutput = z.infer<typeof serveOutputSchema>;

/** What the loop signs: the grant without its signature. */
const grantPayloadSchema = z.object({
  kind: z.literal(checkoutRestoreGrantKind),
  root: z.string().min(1), reason: z.string().min(1),
  /** The standing request the grant serves, by id; the request's file is the installation's own. */
  request: z.object({ id: z.string().min(1) }).strict(),
  /** The issuing loop: its process, and the pid the installation's cursor lock names. */
  loop: z.object({ pid: z.number().int().positive(), lock: z.number().int().positive() }).strict(),
  issuedAt: z.string(), expiresAt: z.string(), nonce: z.string().length(32),
}).strict();
/** The grant the loop writes beside its cursor for one serve, read back by the snapshot's CLI: the payload and its HMAC-SHA256 under the coordinator credential. */
const grantSchema = grantPayloadSchema.extend({ signature: z.string().length(64).regex(/^[0-9a-f]+$/) }).strict();
export type CheckoutRestoreGrantPayload = z.infer<typeof grantPayloadSchema>;
export type CheckoutRestoreGrant = z.infer<typeof grantSchema>;

/** The payload as signed: its keys in sorted order at every depth, so the same grant always signs the same bytes. */
const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
      : JSON.stringify(value);
/** The grant's signature: HMAC-SHA256 of its canonical payload under the coordinator credential. */
export const signCheckoutRestoreGrant = (payload: CheckoutRestoreGrantPayload, credential: string): string => createHmac('sha256', credential).update(canonical(grantPayloadSchema.parse(payload))).digest('hex');
/** Whether `grant` carries the signature `credential` gives its payload, compared in constant time. */
export function checkoutRestoreGrantSigned(grant: CheckoutRestoreGrant, credential: string): boolean {
  const { signature, ...payload } = grant;
  const expected = Buffer.from(signCheckoutRestoreGrant(payload, credential), 'hex'), presented = Buffer.from(signature, 'hex');
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

export interface ReleaseRestoreDeps {
  /** The loop's deployment observation and base branch, read when a request is served. */
  release: () => ServingReleaseInputs;
  /** Where the loop writes the grant (beside its cursor, checkoutRestoreGrantPath), the coordinator credential it signs with, and the pid its cursor lock names. */
  grant: { file: string; credentialFile: string; lock: number };
  run?: ChildRun; quiesce?: CheckoutQuiesce;
  /** The snapshot's CLI entry and how it is started; defaults to `node SNAPSHOT/bin/graphyard.mjs`. */
  command?: (directory: string) => { command: string; args: string[] };
  /** How long the snapshot's act may take; the freeze alone waits up to 5 s a round. */
  timeoutMs?: number;
  /** The environment the snapshot's CLI inherits beneath the grant; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** The supervisor's keep-alive, fed every `keepAliveEveryMs` (checkoutRestoreKeepAliveEveryMs) for as long as the act runs. */
  keepAlive?: () => Promise<void>; keepAliveEveryMs?: number;
  now?: () => number;
}
/**
 * The loop's restore act (GY-1680): the quiesce-and-restore run by a sanctioned release's own CLI in
 * a detached shared-clone snapshot of it, under a single-use grant signed with the coordinator
 * credential, so a fix delivered to the serve path serves the next request without the loop having
 * loaded it. The verified serving release is tried first, then origin's base-branch tip; when neither
 * can be snapshotted with the serve entry the act fails naming why, and the loop's own loaded code —
 * what this request exists to replace — is never run. The keep-alive is fed throughout.
 */
export function releasePinnedRestore(deps: ReleaseRestoreDeps): RestoreAct {
  const run = deps.run ?? defaultChildRun, now = deps.now ?? Date.now;
  const act = async (root: string, reason: string, request: { id: string }): Promise<RestoreActOutcome> => {
    let credential: string;
    try { credential = await readCredentialFile(deps.grant.credentialFile); }
    catch (error) { throw new Error(`the coordinator credential at ${deps.grant.credentialFile} cannot be read (${message(error).split('\n')[0]}), so no checkout-restore grant can be signed and nothing was restored`); }
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
        const issued = now();
        const payload: CheckoutRestoreGrantPayload = { kind: checkoutRestoreGrantKind, root, reason, request: { id: request.id }, loop: { pid: process.pid, lock: deps.grant.lock }, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + checkoutRestoreGrantTtlMs).toISOString(), nonce: randomBytes(16).toString('hex') };
        const grant: CheckoutRestoreGrant = { ...payload, signature: signCheckoutRestoreGrant(payload, credential) };
        await atomicPrivateWrite(deps.grant.file, grant);
        let output: string;
        try {
          output = String(await run(entry.command, [...entry.args, 'master', 'checkout-restore', checkoutRestoreServeFlag],
            { cwd: snapshot.directory, timeoutMs: deps.timeoutMs ?? 10 * 60_000, env: { ...(deps.env ?? process.env), [checkoutRestoreGrantVariable]: deps.grant.file } }));
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
  return async (root, reason, _at, request) => {
    // The supervisor's watchdog is fed for as long as the act runs — the fetch, the clone, the snapshot's
    // freeze-and-restore — so a restore longer than its window is not restarted as a hung loop.
    const pulse = deps.keepAlive ? setInterval(() => { void deps.keepAlive!().catch(() => {}); }, deps.keepAliveEveryMs ?? checkoutRestoreKeepAliveEveryMs) : null;
    try { return await act(root, reason, request); }
    finally { if (pulse) clearInterval(pulse); }
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
  /** Reads the installation whose coordinator checkout is `root` (its .graphyard/master.json); defaults to loadStoredMasterConfig. */
  installation?: (root: string) => Promise<MasterConfig>;
}
/**
 * The grant the environment names, verified against the installation it names and nothing a caller
 * chooses: the checkout it names holds an installation whose coordinator checkout is that checkout;
 * the grant lies where that installation's loop issues grants; its signature is the installation's
 * coordinator credential's; it has not expired; the issuing loop is among this process's ancestors;
 * the installation's cursor is locked by the pid it names; and the installation's request file holds
 * the request it names, unanswered. Consumed — the file removed — once verified, so it serves exactly
 * once. Anything short of that, a cursor that cannot be read included, is a refusal naming what is
 * missing, before anything is touched.
 */
export async function verifyCheckoutRestoreGrant(options: ServeEntryOptions = {}): Promise<{ grant: CheckoutRestoreGrant; config: MasterConfig }> {
  const env = options.env ?? process.env;
  const file = env[checkoutRestoreGrantVariable];
  if (!file) throw new Error(checkoutRestoreServeUsage);
  let grant: CheckoutRestoreGrant;
  try { grant = grantSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { throw new Error(`the checkout-restore grant at ${file} cannot be read (${message(error).split('\n')[0]}); ${checkoutRestoreServeUsage}`); }
  const refuse = (why: string) => new Error(`the checkout-restore grant at ${file} does not serve: ${why}; nothing was restored`);
  // The installation: read from the checkout the grant names, which must be that installation's own coordinator checkout.
  if (!isAbsolute(grant.root)) throw refuse(`the checkout it names, ${grant.root}, is not an absolute path`);
  let config: MasterConfig;
  try { config = await (options.installation ?? loadStoredMasterConfig)(grant.root); }
  catch (error) { throw refuse(`the checkout it names, ${grant.root}, holds no installation whose configuration can be read (${message(error).split('\n')[0]})`); }
  const coordinator = resolve(coordinatorCheckoutRoot(config.cliPath));
  if (coordinator !== resolve(grant.root)) throw refuse(`the installation at ${grant.root} runs its loop from ${coordinator}, not from that checkout`);
  const issuedAt = checkoutRestoreGrantPath(config);
  if (resolve(file) !== issuedAt) throw refuse(`it lies at ${resolve(file)}, not where that installation's loop issues grants (${issuedAt})`);
  // The authority: the installation's coordinator credential signed it, or no loop issued it.
  let credential: string;
  try { credential = await readCredentialFile(config.credentialFile); }
  catch (error) { throw refuse(`that installation's coordinator credential at ${config.credentialFile} cannot be read (${message(error).split('\n')[0]}), so its signature cannot be verified`); }
  if (!checkoutRestoreGrantSigned(grant, credential)) throw refuse('its signature is not that installation\'s coordinator credential\'s, so no loop issued it');
  const at = (options.now ?? new Date()).getTime();
  if (!(Date.parse(grant.expiresAt) > at)) throw refuse(`it expired at ${grant.expiresAt}`);
  const ancestors = options.ancestors?.() ?? [process.pid, ...ancestorPids()];
  if (!ancestors.includes(grant.loop.pid)) throw refuse(`the loop that issued it, pid ${grant.loop.pid}, is not an ancestor of this process (${ancestors.join(' < ') || 'none readable'})`);
  // The installation's cursor: the loop's daemon state, locked by the loop that serves. Unreadable or unlocked, no loop is known to serve, and the grant is refused.
  const cursor = daemonStatePath(config);
  let lock: number | null = null;
  try { const parsed = JSON.parse(await readFile(cursor, 'utf8')) as { lock?: { pid?: unknown } | null }; lock = typeof parsed.lock?.pid === 'number' ? parsed.lock.pid : null; }
  catch (error) { throw refuse(`that installation's cursor at ${cursor} cannot be read (${message(error).split('\n')[0]}), so no loop is known to serve it`); }
  if (lock === null) throw refuse(`that installation's cursor at ${cursor} holds no lock, so no loop is known to serve it`);
  if (lock !== grant.loop.lock) throw refuse(`that installation's cursor at ${cursor} is locked by pid ${lock}, not the pid ${grant.loop.lock} it names`);
  // The request: the installation's own, standing unanswered under the id the grant names.
  const requestFile = checkoutRestoreRequestPath(config);
  const request = await readCheckoutRestoreRequest(requestFile);
  if (!request || request.id !== grant.request.id || request.act !== 'checkout-restore') throw refuse(`the request it names, ${grant.request.id}, no longer stands at ${requestFile}`);
  if (request.outcome) throw refuse(`the request it names, ${grant.request.id}, was already answered ${request.outcome.state}`);
  try { await unlink(file); } catch (error) { throw refuse(`it could not be consumed (${message(error).split('\n')[0]})`); }
  return { grant, config };
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
  const { grant, config } = await verifyCheckoutRestoreGrant(options);
  const { restored, head } = await restoreInProcess(options.run ?? defaultChildRun, options.quiesce)(grant.root, grant.reason, options.now ?? new Date(), { file: checkoutRestoreRequestPath(config), id: grant.request.id });
  return { restored, head };
}
