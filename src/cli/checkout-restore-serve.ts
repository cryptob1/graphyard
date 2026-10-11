// Concern: the serve entry of a checkout-restore (GY-1680) — `master checkout-restore --serve`, answered by the serving release's own CLI in the loop's snapshot: the grant verified against the installation the checkout holds and nothing the caller chose, the quiesce-and-restore under it, and the thaw of the writers it stopped when it is ended by a signal. The release and the grant it serves under are checkout-restore-release.ts's.
import { readFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { daemonStatePath } from '../daemon/state.js';
import { loadStoredMasterConfig, readCredentialFile } from '../master/config.js';
import { coordinatorCheckoutRoot, type MasterConfig } from '../master/profiles.js';
import { continueFrozenWriters, freezeCheckoutWriters, type WriterFreezeDeps } from './checkout-writers.js';
import { type CheckoutRestoreGrant, checkoutRestoreGrantSigned, checkoutRestoreGrantVariable, checkoutRestoreServeFlag, checkoutRestoreServeUsage, commitServes, grantSchema, type ServeOutput } from './checkout-restore-release.js';
import { type CheckoutQuiesce, checkoutRestoreFreezeLedgerPath, checkoutRestoreGrantPath, checkoutRestoreRequestPath, readCheckoutRestoreRequest, restoreInProcess } from './master-checkout-restore.js';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const short = (commit: string) => commit.slice(0, 12);

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
 * named pre-serve HEAD and still predates the serve entry, the release it advances onto holds the
 * serve entry in the checkout's object store, and the cursor lock is not required (the stale loop
 * still holds it); and the installation's request file holds the request it names,
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
    // The release the entry advances the clean checkout onto, under its freeze: one the loop's unit
    // restarts onto and serves from, so it must hold the serve entry in this checkout's object store.
    if (!await commitServes(grant.root, grant.handoff.advance, run)) throw refuse(`the release ${short(grant.handoff.advance)} the old-HEAD handoff advances onto does not hold the serve entry in the checkout's object store, so a restart onto it could not serve`);
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
 * the checkout's HEAD after — for an old-HEAD handoff, the grant's release, which the entry moves the
 * clean checkout onto while its writers still stand frozen (review of GY-1680), so no writer resumes
 * between the restore and the HEAD advance. Without a grant that verifies there is no act. A refusal (an unverifiable
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
    // An old-HEAD handoff's checkout is advanced onto the grant's release inside the same freeze (review of GY-1680).
    const { restored, head } = await restoreInProcess(options.run ?? defaultChildRun, quiesce, grant.handoff?.advance ?? null)(grant.root, grant.reason, options.now ?? new Date(), { file: checkoutRestoreRequestPath(config), id: grant.request.id });
    return { restored, head };
  } finally { release(); }
}
