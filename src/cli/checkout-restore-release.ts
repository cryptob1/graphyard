// Concern: the release a checkout-restore request is served from (GY-1680) — the verified serving release, materialized as a detached shared-clone snapshot whose CLI runs the quiesce-and-restore under a grant the loop signs with the coordinator credential — and the serve entry that CLI answers.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { ChildProcessError, type ChildRun, defaultChildRun } from '../child-runner.js';
import { daemonStatePath } from '../daemon/state.js';
import { atomicPrivateWrite, loadStoredMasterConfig, readCredentialFile } from '../master/config.js';
import { coordinatorCheckoutRoot, type MasterConfig } from '../master/profiles.js';
import { continueFrozenWriters, freezeCheckoutWriters, type WriterFreezeDeps } from './checkout-writers.js';
import { type CheckoutQuiesce, type RestoreAct, type RestoreActOutcome, checkoutRestoreFreezeLedgerPath, checkoutRestoreGrantPath, checkoutRestoreRequestPath, readCheckoutRestoreRequest, restoreInProcess } from './master-checkout-restore.js';

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
// id, the issuing loop's pid, an expiry and a nonce — signed (HMAC-SHA256) with the coordinator
// credential, the authority only the loop and the master identities hold: a worker, a confined
// master session or a hand has no credential and so can forge no grant. The entry is handed only the
// grant's path, and trusts nothing else a caller could choose: it reads the installation from the
// checkout the grant names (.graphyard/master.json, which must name that checkout as its coordinator
// checkout), verifies the signature with that installation's credential, and requires the grant to
// lie where that installation's loop issues grants, the one issuing pid it names to be both this
// process's ancestor and the pid the installation's cursor lock names — the loop that serves, not a
// credential holder naming its own wrapper as the issuer beside the real lock (review of GY-1680) —
// and the installation's request file to hold the request the grant names still unanswered. A
// cursor that cannot be read or holds no lock refuses: no loop is known to serve. It consumes the
// grant before touching anything, so a grant serves exactly once.
//
// A loop whose loaded code predates the serve entry serves a request it reads from that code — the
// stale executor this item exists to replace, and the standing one on an installation whose checkout
// moved to this release under it. The command side hands such a loop off (staleServingLoop, used by
// checkoutRestoreCommand): it files the request in a form only a loop holding the entry reads —
// every release since GY-1658 parses requests strictly and leaves one with a field it does not know
// standing, unread — and a loop-restart request beside it, the act every such loop serves, so the
// running loop restarts through its unit onto the checkout's HEAD and the loop that loads it serves
// the standing request from the serving release. When that HEAD itself predates the serve entry
// (GY-1680 review), a restart onto it still cannot read the handoff or execute the verified release:
// the command — already holding this release's code — serves the request itself from a snapshot under
// a grant that names the old HEAD (`handoff`), advances the checkout onto the release that served,
// and only then files the restart so the unit loads that release.
//
// The act can outlast the supervisor's watchdog window (the shipped unit's is 180 s; a fetch, a
// clone and a freeze-and-restore each wait on their own), so the loop's keep-alive is fed on an
// interval for as long as the act runs (review of GY-1680): a long restore is not a hung loop.
//
// The entry stops the checkout's writers (SIGSTOP) and continues them in a `finally` — which a process
// ended by a signal never reaches: the loop's timeout on the snapshot's CLI sends SIGTERM, then
// SIGKILL, and a thaw left undone leaves those writers stopped indefinitely, a retry treating them as
// quiet (review of GY-1680). So the entry records every pid in a freeze ledger beside the cursor
// before it signals it (checkoutRestoreFreezeLedgerPath), continues them itself on SIGTERM or SIGINT,
// and the loop — whichever way the entry ended — continues whatever the ledger still names stopped
// before it records the outcome (continueFrozenWriters).

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
/** releaseServes for a commit in the checkout's object store: whether a loop that loaded it serves requests from the serving release, or from its own loaded code. A commit the store lacks does not. */
export async function commitServes(root: string, commit: string, run: ChildRun = defaultChildRun): Promise<boolean> {
  try { return String(await run('git', ['-C', root, 'show', `${commit}:src/cli/checkout-restore-release.ts`])).includes(checkoutRestoreGrantKind); } catch { return false; }
}
/** The loop holding the installation's cursor lock, with the commit that process recorded loading (state.release); null when the cursor cannot be read or holds no lock, so no loop is known to serve. */
export async function lockedLoop(cursor: string): Promise<{ pid: number; loaded: string | null } | null> {
  try {
    const parsed = JSON.parse(await readFile(cursor, 'utf8')) as { lock?: { pid?: unknown } | null; release?: { commit?: unknown } | null };
    if (typeof parsed.lock?.pid !== 'number') return null;
    return { pid: parsed.lock.pid, loaded: typeof parsed.release?.commit === 'string' ? parsed.release.commit : null };
  } catch { return null; }
}
/** What staleServingLoop found: the lock holder, and whether the checkout's HEAD already holds the serve entry (a restart onto it can serve) or not (the command must serve first). */
export interface StaleServingLoop { pid: number; loaded: string | null; head: string | null; headServes: boolean }
/**
 * The loop a checkout-restore request filed now would be read by, when its loaded code would serve
 * the request itself instead of from the serving release (GY-1680 review): the lock holder whose
 * recorded loaded commit predates the serve entry, or records none, or cannot be judged against the
 * checkout. Null when no loop holds the lock, or the locked loop serves from the release. `head` /
 * `headServes` say whether a restart onto the checkout's HEAD would load the serve entry — when it
 * would not, the command serves from the verified release itself before asking for that restart.
 */
export async function staleServingLoop(cursor: string, root: string | null, run: ChildRun = defaultChildRun): Promise<StaleServingLoop | null> {
  const loop = await lockedLoop(cursor);
  if (!loop) return null;
  if (loop.loaded && root && await commitServes(root, loop.loaded, run)) return null;
  let head: string | null = null;
  if (root) {
    try { head = String(await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim() || null; } catch { head = null; }
  }
  return { ...loop, head, headServes: !!(head && root && await commitServes(root, head, run)) };
}

const serveOutputSchema = z.object({
  restored: z.object({ ref: z.string(), commit: z.string(), paths: z.array(z.string()), skipped: z.array(z.object({ pid: z.number().int(), error: z.string() })).default([]) }).nullable(),
  head: z.string().nullable(),
}).strict();
export type ServeOutput = z.infer<typeof serveOutputSchema>;

/** What the loop (or the command's old-HEAD handoff) signs: the grant without its signature. */
const grantPayloadSchema = z.object({
  kind: z.literal(checkoutRestoreGrantKind),
  root: z.string().min(1), reason: z.string().min(1),
  /** The standing request the grant serves, by id; the request's file is the installation's own. */
  request: z.object({ id: z.string().min(1) }).strict(),
  /** The issuing process's pid: an ancestor of the entry's process; for a loop grant, also the pid the installation's cursor lock names — one pid, never one for each check. */
  loop: z.object({ pid: z.number().int().positive() }).strict(),
  /**
   * Present only for the command's old-HEAD handoff (GY-1680 review): the checkout's HEAD that
   * predates the serve entry, so a restart onto it cannot serve and this command — not the lock
   * holder — issues the grant. Absent on every loop-issued grant.
   */
  handoff: z.object({ head: z.string().min(1) }).strict().optional(),
  issuedAt: z.string(), expiresAt: z.string(), nonce: z.string().length(32),
}).strict();
/** The grant the loop (or the command's old-HEAD handoff) writes beside its cursor for one serve, read back by the snapshot's CLI: the payload and its HMAC-SHA256 under the coordinator credential. */
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
  /** Where the loop (or the command's old-HEAD handoff) writes the grant (beside its cursor, checkoutRestoreGrantPath), the coordinator credential it signs with, and the issuing pid — the loop's cursor lock holder, or this command when `handoff` is set. */
  grant: { file: string; credentialFile: string; pid: number };
  /**
   * When set, this is the command's old-HEAD handoff (GY-1680 review): the grant carries `handoff`
   * naming that HEAD, the cursor lock is not required (the stale loop still holds it), and the
   * issuer pid is this command's. Absent for every loop-served request.
   */
  handoff?: { head: string };
  run?: ChildRun; quiesce?: CheckoutQuiesce;
  /** The snapshot's CLI entry and how it is started; defaults to `node SNAPSHOT/bin/graphyard.mjs`. */
  command?: (directory: string) => { command: string; args: string[] };
  /** How long the snapshot's act may take; the freeze alone waits up to 5 s a round. */
  timeoutMs?: number;
  /** The environment the snapshot's CLI inherits beneath the grant; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** The supervisor's keep-alive, fed every `keepAliveEveryMs` (checkoutRestoreKeepAliveEveryMs) for as long as the act runs. */
  keepAlive?: () => Promise<void>; keepAliveEveryMs?: number;
  /** The entry's freeze ledger (checkoutRestoreFreezeLedgerPath): the writers it stopped, continued by the loop once the entry has ended however it ended; `signal` and `state` as continueFrozenWriters takes them. */
  ledger?: { file: string } & Pick<WriterFreezeDeps, 'signal' | 'state'>;
  now?: () => number;
}
/** What the loop found in the entry's freeze ledger once the entry ended, in words; empty when the ledger named nothing. */
const thawedDetail = (thawed: ReturnType<typeof continueFrozenWriters>) => {
  if (!thawed || !thawed.continued.length && !thawed.left.length) return '';
  const list = (pids: number[]) => pids.slice(0, 8).join(', ') + (pids.length > 8 ? ` and ${pids.length - 8} more` : '');
  return `; the entry ended before its own thaw, so the loop ${thawed.continued.length ? `continued the writer(s) it had stopped, pid ${list(thawed.continued)}` : 'continued nothing'}${thawed.left.length ? ` (pid ${list(thawed.left)} no longer stopped, left alone)` : ''}`;
};
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
        const payload: CheckoutRestoreGrantPayload = { kind: checkoutRestoreGrantKind, root, reason, request: { id: request.id }, loop: { pid: deps.grant.pid }, ...(deps.handoff ? { handoff: deps.handoff } : {}), issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + checkoutRestoreGrantTtlMs).toISOString(), nonce: randomBytes(16).toString('hex') };
        const grant: CheckoutRestoreGrant = { ...payload, signature: signCheckoutRestoreGrant(payload, credential) };
        await atomicPrivateWrite(deps.grant.file, grant);
        let output = '', failure: unknown = null;
        try {
          output = String(await run(entry.command, [...entry.args, 'master', 'checkout-restore', checkoutRestoreServeFlag],
            { cwd: snapshot.directory, timeoutMs: deps.timeoutMs ?? 10 * 60_000, env: { ...(deps.env ?? process.env), [checkoutRestoreGrantVariable]: deps.grant.file } }));
        } catch (error) { failure = error; }
        finally { await unlink(deps.grant.file).catch(() => {}); }
        // The entry has ended, however it ended: whatever its freeze ledger still names stopped is continued
        // here, before the outcome is recorded — the thaw a signalled entry never reached (review of GY-1680).
        const thawed = deps.ledger ? continueFrozenWriters(deps.ledger.file, deps.ledger) : null;
        if (failure) throw new Error(`${served}: ${failure instanceof ChildProcessError && failure.stderr.trim() ? failure.stderr.trim() : message(failure)}${thawedDetail(thawed)}`.slice(0, 4000));
        let parsed: ServeOutput;
        try { parsed = serveOutputSchema.parse(JSON.parse(output)); }
        catch (error) { throw new Error(`${served}, whose outcome could not be read (${message(error).split('\n')[0]}): ${output.trim().slice(0, 500)}`); }
        return { ...parsed, served, release: release.commit };
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

type SignalHost = Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>;
/** What continuing the frozen writers on the entry's own stop needs: the signal host (this process), how it exits, and how writers are signalled and read (continueFrozenWriters). */
export interface StopThawDeps extends Pick<WriterFreezeDeps, 'signal' | 'state'> { host?: SignalHost; exit?: (code: number) => void; log?: (line: string) => void }
/**
 * While the entry acts, a SIGTERM or SIGINT — the loop's timeout, a hand's interrupt — continues the
 * writers the freeze ledger at `file` names stopped before the process exits with the signal's
 * conventional status (review of GY-1680): the freeze's `finally` never runs after a signal. Returns
 * what removes the listeners once the act has ended on its own.
 */
export function thawFrozenWritersOnStop(file: string, deps: StopThawDeps = {}): () => void {
  const host = deps.host ?? process, exit = deps.exit ?? (code => process.exit(code)), log = deps.log ?? (line => console.error(line));
  const listeners = (['SIGTERM', 'SIGINT'] as const).map(signal => [signal, () => {
    const thawed = continueFrozenWriters(file, deps);
    log(`master checkout-restore ${checkoutRestoreServeFlag} was ended by ${signal} before its thaw: ${thawed?.continued.length ? `continued the writer(s) it had stopped, pid ${thawed.continued.join(', ')}` : 'it had stopped nothing still stopped'}; nothing more was touched`);
    exit(128 + (osConstants.signals[signal] ?? 0));
  }] as const);
  for (const [signal, listener] of listeners) host.on(signal, listener);
  return () => { for (const [signal, listener] of listeners) host.removeListener(signal, listener); };
}

export interface ServeEntryOptions {
  run?: ChildRun; quiesce?: CheckoutQuiesce; now?: Date;
  /** How the entry continues its frozen writers when it is stopped mid-act (thawFrozenWritersOnStop); defaults to this process and its signals. */
  stop?: StopThawDeps;
  /** The environment the grant is read from; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** The pids the issuing loop (or the command's old-HEAD handoff) may be: this process and its ancestors, by default. */
  ancestors?: () => number[];
  /** Reads the installation whose coordinator checkout is `root` (its .graphyard/master.json); defaults to loadStoredMasterConfig. */
  installation?: (root: string) => Promise<MasterConfig>;
}
/**
 * The grant the environment names, verified against the installation it names and nothing a caller
 * chooses: the checkout it names holds an installation whose coordinator checkout is that checkout;
 * the grant lies where that installation's loop issues grants; its signature is the installation's
 * coordinator credential's; it has not expired; the one issuing pid it names is among this
 * process's ancestors; for a loop grant, that pid is also the pid the installation's cursor lock
 * names; for the command's old-HEAD handoff grant (`handoff`), the checkout's HEAD still matches the
 * named pre-serve HEAD and still predates the serve entry, and the cursor lock is not required
 * (the stale loop still holds it); and the installation's request file holds the request it names,
 * unanswered. Consumed — the file removed — once verified, so it serves exactly once. Anything short
 * of that, a cursor that cannot be read included (loop grants), is a refusal naming what is missing,
 * before anything is touched.
 */
export async function verifyCheckoutRestoreGrant(options: ServeEntryOptions = {}): Promise<{ grant: CheckoutRestoreGrant; config: MasterConfig }> {
  const env = options.env ?? process.env, run = options.run ?? defaultChildRun;
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
  // The authority: the installation's coordinator credential signed it, or no loop (or old-HEAD handoff) issued it.
  let credential: string;
  try { credential = await readCredentialFile(config.credentialFile); }
  catch (error) { throw refuse(`that installation's coordinator credential at ${config.credentialFile} cannot be read (${message(error).split('\n')[0]}), so its signature cannot be verified`); }
  if (!checkoutRestoreGrantSigned(grant, credential)) throw refuse('its signature is not that installation\'s coordinator credential\'s, so no loop issued it');
  const at = (options.now ?? new Date()).getTime();
  if (!(Date.parse(grant.expiresAt) > at)) throw refuse(`it expired at ${grant.expiresAt}`);
  const ancestors = options.ancestors?.() ?? [process.pid, ...ancestorPids()];
  if (!ancestors.includes(grant.loop.pid)) throw refuse(`the ${grant.handoff ? 'command' : 'loop'} that issued it, pid ${grant.loop.pid}, is not an ancestor of this process (${ancestors.join(' < ') || 'none readable'})`);
  if (grant.handoff) {
    // Old-HEAD handoff: the stale loop still holds the cursor, so the lock is not the issuer; the
    // checkout's HEAD must still be the named pre-serve commit, or a later move would let any
    // credential holder forge a handoff against a HEAD that already serves.
    let head: string;
    try { head = String(await run('git', ['-C', grant.root, 'rev-parse', 'HEAD'])).trim(); }
    catch (error) { throw refuse(`the checkout's HEAD cannot be read (${message(error).split('\n')[0]}), so the old-HEAD handoff cannot be verified`); }
    if (head !== grant.handoff.head) throw refuse(`the checkout's HEAD is ${short(head)}, not ${short(grant.handoff.head)} the old-HEAD handoff names`);
    if (await commitServes(grant.root, head, run)) throw refuse(`the checkout's HEAD ${short(head)} already holds the serve entry, so the old-HEAD handoff does not apply`);
  } else {
    // The installation's cursor: the loop's daemon state, locked by the loop that serves — the one issuing pid the grant names,
    // so a credential holder cannot name its own wrapper as the issuer beside the real lock (review of GY-1680). Unreadable or
    // unlocked, no loop is known to serve, and the grant is refused.
    const cursor = daemonStatePath(config);
    let lock: number | null = null;
    try { const parsed = JSON.parse(await readFile(cursor, 'utf8')) as { lock?: { pid?: unknown } | null }; lock = typeof parsed.lock?.pid === 'number' ? parsed.lock.pid : null; }
    catch (error) { throw refuse(`that installation's cursor at ${cursor} cannot be read (${message(error).split('\n')[0]}), so no loop is known to serve it`); }
    if (lock === null) throw refuse(`that installation's cursor at ${cursor} holds no lock, so no loop is known to serve it`);
    if (lock !== grant.loop.pid) throw refuse(`that installation's cursor at ${cursor} is locked by pid ${lock}, not the loop that issued it, pid ${grant.loop.pid}`);
  }
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
 * records as the request's outcome. The writers it stops are recorded in the installation's freeze
 * ledger before each SIGSTOP and continued on SIGTERM or SIGINT (review of GY-1680); the loop
 * continues whatever the ledger still names once the entry has ended.
 */
export async function serveCheckoutRestoreAct(args: readonly string[], options: ServeEntryOptions = {}): Promise<ServeOutput> {
  if (args.length) throw new Error(`master checkout-restore ${checkoutRestoreServeFlag} takes no arguments: the checkout and the reason are in the loop's grant. ${checkoutRestoreServeUsage}`);
  const { grant, config } = await verifyCheckoutRestoreGrant(options);
  const ledger = checkoutRestoreFreezeLedgerPath(config);
  const quiesce = options.quiesce ?? ((root: string) => freezeCheckoutWriters(root, { ledger }));
  const release = thawFrozenWritersOnStop(ledger, options.stop);
  try {
    const { restored, head } = await restoreInProcess(options.run ?? defaultChildRun, quiesce)(grant.root, grant.reason, options.now ?? new Date(), { file: checkoutRestoreRequestPath(config), id: grant.request.id });
    return { restored, head };
  } finally { release(); }
}
