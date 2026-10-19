// Concern: the release a checkout-restore request is served from (GY-1680) — the verified serving release, materialized as a detached shared-clone snapshot whose CLI runs the quiesce-and-restore under a grant the loop signs with the coordinator credential. The serve entry that CLI answers is checkout-restore-serve.ts.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ChildProcessError, type ChildRun, defaultChildRun } from '../child-runner.js';
import { atomicPrivateWrite, readCredentialFile } from '../master/config.js';
import { continueFrozenWriters, type WriterFreezeDeps } from './checkout-writers.js';
import type { CheckoutQuiesce, RestoreAct, RestoreActOutcome } from './master-checkout-restore.js';

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
// a grant that names the old HEAD and the release to advance onto (`handoff`); the entry moves the
// clean checkout onto that release while its writers still stand frozen (a HEAD advance after the
// thaw would let a writer resume under it), and only then does the command file the restart so the
// unit loads that release.
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
/** How long the serve child has to begin the act — the grant consumed, which the entry does before it touches anything — before the loop ends it (GY-2437): well inside the client's checkoutRestoreWaitMs, so a serve that cannot start is refused within the window, never a silent hang. */
export const checkoutRestoreServeStartupMs = 30_000;
/** How long the base-branch fetch and the snapshot's shared clone may each take (GY-2437): the serve must reach its child inside the client's window, so every step before it is bounded. */
export const checkoutRestoreServeFetchMs = 10_000, checkoutRestoreServeCloneMs = 10_000;
/**
 * The loader arguments the serve child inherits: the `--import` values this process itself booted
 * with (bin/graphyard.mjs passes the tsx loader and, while a pin stands, the held snapshot's resolve
 * hooks), each bare specifier resolved here, in the loop's own module graph — the chain that booted
 * it. The child's working directory is the serve snapshot, where a bare specifier would resolve
 * through the linked node_modules of the coordinator checkout, which a production install need not
 * hold a loader in (GY-2437: the 08:01Z/08:36Z ERR_MODULE_NOT_FOUND records); a resolved URL or an
 * absolute path never resolves again.
 */
export function serveChildImports(argv: readonly string[] = process.execArgv): string[] {
  const imports: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--import') continue;
    const value = argv[index + 1];
    if (!value) continue;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || isAbsolute(value)) imports.push('--import', value);
    else try { imports.push('--import', import.meta.resolve(value)); } catch { imports.push('--import', value); }
  }
  return imports;
}
/**
 * The serve child (GY-2437): the snapshot's own CLI entry — `src/cli.ts`, not `bin/graphyard.mjs`,
 * whose launcher re-resolves tsx through the snapshot's linked node_modules and crashed every serve
 * on a checkout whose install lacks it — under the loader arguments the running loop itself booted
 * with. Startup then depends on nothing but the snapshot's code and a loader the loop demonstrably
 * holds, never on a resolution through the checkout's node_modules.
 */
export const serveEntry = (directory: string): { command: string; args: string[] } => ({ command: process.execPath, args: [...serveChildImports(), join(directory, 'src', 'cli.ts')] });

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
  try { await run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${inputs.baseBranch}:${base}`], { timeoutMs: checkoutRestoreServeFetchMs }); }
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
    await run('git', ['clone', '-q', '--shared', '--no-checkout', root, directory], { timeoutMs: checkoutRestoreServeCloneMs });
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
  // GY-1745: a diverged heal rides inside `restored` (an object a loop loaded before it strips unknown keys of), never as a new top-level key its strict schema rejects: with no dirty path the entry reports the diverged ref as an empty restore, so an older loop still asks its restart.
  restored: z.object({ ref: z.string(), commit: z.string(), paths: z.array(z.string()), skipped: z.array(z.object({ pid: z.number().int(), error: z.string() })).default([]), diverged: z.object({ ref: z.string(), from: z.string(), to: z.string() }).optional() }).nullable(),
  head: z.string().nullable(),
}).strict();
export type ServeOutput = z.infer<typeof serveOutputSchema>;
type Restored = NonNullable<ServeOutput['restored']>;
/** The serve entry's printed output: the diverged heal carried inside `restored`, as an older loop's schema still reads. */
export const encodeServeOutput = (out: { restored: Omit<Restored, 'diverged'> | null; head: string | null; diverged?: Restored['diverged'] | null }): ServeOutput =>
  ({ restored: out.diverged ? { ...(out.restored ?? { ref: out.diverged.ref, commit: out.diverged.from, paths: [], skipped: [] }), diverged: out.diverged } : out.restored, head: out.head });
/** What a serve output holds: the dirty restore (none for the empty one that only carries a heal) and the diverged heal. */
const decodeServeOutput = (out: ServeOutput) => {
  const { diverged, ...restored } = out.restored ?? {};
  // Only a heal that also saved dirty paths has a restore of its own.
  const dirty = out.restored && (restored as Restored).paths.length > 0 ? restored as Omit<Restored, 'diverged'> : diverged ? null : (out.restored as Omit<Restored, 'diverged'> | null);
  return { restored: dirty, head: out.head, ...(diverged ? { diverged } : {}) };
};

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
   * holder — issues the grant, and `advance`, the release the entry moves the checkout onto once it
   * is clean, under the same freeze — the release that serves, whose snapshot runs the entry — so no
   * writer resumes between the restore and the HEAD advance. Absent on every loop-issued grant.
   */
  handoff: z.object({ head: z.string().min(1), advance: z.string().min(1) }).strict().optional(),
  issuedAt: z.string(), expiresAt: z.string(), nonce: z.string().length(32),
}).strict();
/** The grant the loop (or the command's old-HEAD handoff) writes beside its cursor for one serve, read back by the snapshot's CLI: the payload and its HMAC-SHA256 under the coordinator credential. */
export const grantSchema = grantPayloadSchema.extend({ signature: z.string().length(64).regex(/^[0-9a-f]+$/) }).strict();
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
   * naming that HEAD and, as `advance`, the release being served from — which the entry moves the
   * checkout onto under its freeze — the cursor lock is not required (the stale loop still holds it),
   * and the issuer pid is this command's. Absent for every loop-served request.
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
  /** How long the serve child has to begin the act (the grant consumed) before the loop ends it; the default is checkoutRestoreServeStartupMs (GY-2437). */
  startupTimeoutMs?: number;
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
        const entry = deps.command?.(snapshot.directory) ?? serveEntry(snapshot.directory);
        const issued = now();
        // An old-HEAD handoff's entry advances the checkout onto the release it runs from, under its own freeze.
        const payload: CheckoutRestoreGrantPayload = { kind: checkoutRestoreGrantKind, root, reason, request: { id: request.id }, loop: { pid: deps.grant.pid }, ...(deps.handoff ? { handoff: { head: deps.handoff.head, advance: release.commit } } : {}), issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + checkoutRestoreGrantTtlMs).toISOString(), nonce: randomBytes(16).toString('hex') };
        const grant: CheckoutRestoreGrant = { ...payload, signature: signCheckoutRestoreGrant(payload, credential) };
        await atomicPrivateWrite(deps.grant.file, grant);
        let output = '', failure: unknown = null;
        try {
          output = String(await run(entry.command, [...entry.args, 'master', 'checkout-restore', checkoutRestoreServeFlag],
            { cwd: snapshot.directory, timeoutMs: deps.timeoutMs ?? 10 * 60_000, env: { ...(deps.env ?? process.env), [checkoutRestoreGrantVariable]: deps.grant.file },
              // GY-2437: a serve that has not begun acting — the grant consumed, which the entry does before
              // it touches anything — by the startup bound is not going to: the loop ends it here, records
              // the failure with what it said, and the client refuses within its own window.
              started: () => !existsSync(deps.grant.file), startupTimeoutMs: deps.startupTimeoutMs ?? checkoutRestoreServeStartupMs }));
        } catch (error) { failure = error; }
        finally { await unlink(deps.grant.file).catch(() => {}); }
        // The entry has ended, however it ended: whatever its freeze ledger still names stopped is continued
        // here, before the outcome is recorded — the thaw a signalled entry never reached (review of GY-1680).
        const thawed = deps.ledger ? continueFrozenWriters(deps.ledger.file, deps.ledger) : null;
        if (failure) throw new Error(`${served}: ${failure instanceof ChildProcessError && failure.stderr.trim() ? failure.stderr.trim() : message(failure)}${thawedDetail(thawed)}`.slice(0, 4000));
        let parsed: ServeOutput;
        try { parsed = serveOutputSchema.parse(JSON.parse(output)); }
        catch (error) { throw new Error(`${served}, whose outcome could not be read (${message(error).split('\n')[0]}): ${output.trim().slice(0, 500)}`); }
        return { ...decodeServeOutput(parsed), served, release: release.commit };
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
