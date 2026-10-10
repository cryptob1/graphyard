// Concern: `graphyard master checkout-restore` (GY-1658) — the sanctioned, work-preserving restore of a dirty coordinator checkout, requested by any master identity and carried out by the loop.
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { atomicPrivateWrite } from '../master/config.js';
import { dirtyCheckoutPaths, parseCoordinatorCheckout, readCoordinatorCheckout } from '../master/profiles.js';
import type { MasterConfig } from '../master/profiles.js';

// The GY-857 guard refuses every loop start, self-upgrade and restart from a coordinator checkout
// holding uncommitted work, and nothing but a person could end that refusal: the doctor's command
// allowlist refuses git and every checkout mutation, and the doctor and the master session both run
// with the checkout read-only (GY-888, GY-1658). This act is the installation's own remedy. Any
// master identity — the doctor's included — records a request beside the loop's cursor, outside the
// checkout; the loop, the one process that runs unconfined, then commits every dirty path onto HEAD
// under a named ref (refs/graphyard/checkout-restore/STAMP), returns those paths to HEAD, settles
// the dirty-checkout escalation and restarts itself through its supervising unit
// (graphyard-master.service). Nothing is discarded: the ref holds every byte the paths held, and
// `git diff HEAD REF` shows it. No stash entry is used, since the stash stack is shared with every
// worktree of the repository.

/** Where restored checkout contents are kept, one ref per restore. */
export const checkoutRestoreRefPrefix = 'refs/graphyard/checkout-restore/';
export const checkoutRestoreUsage = 'Use master checkout-restore REASON';
/** How long the command waits for the loop to carry its request out before it reports the request as filed. */
export const checkoutRestoreWaitMs = 120_000;

const outcomeSchema = z.object({
  at: z.string(), state: z.enum(['restored', 'clean', 'failed']), detail: z.string().max(4000),
  ref: z.string().nullable(), commit: z.string().nullable(), paths: z.array(z.string()).max(10_000),
}).strict();
const requestSchema = z.object({
  id: z.string().max(100), reason: z.string().min(1).max(2000), requestedAt: z.string(), requestedBy: z.string().max(200),
  outcome: outcomeSchema.nullable(),
}).strict();
export type CheckoutRestoreRequest = z.infer<typeof requestSchema>;
export type CheckoutRestoreOutcome = z.infer<typeof outcomeSchema>;

/** The request file: beside the loop's cursor (daemonStatePath), so a session that sees the checkout read-only can still file it. */
export const checkoutRestoreRequestPath = (config: Pick<MasterConfig, 'credentialFile'>) =>
  resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.checkout-restore.json`);
export async function readCheckoutRestoreRequest(file: string): Promise<CheckoutRestoreRequest | null> {
  try { return requestSchema.parse(JSON.parse(await readFile(file, 'utf8'))); } catch { return null; }
}
export async function fileCheckoutRestoreRequest(file: string, reason: string, requestedBy: string, now = new Date()): Promise<CheckoutRestoreRequest> {
  const request = requestSchema.parse({ id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, reason, requestedAt: now.toISOString(), requestedBy, outcome: null });
  await atomicPrivateWrite(file, request);
  return request;
}

/** The status entries' paths, rename and copy origins included: every path a restore returns to HEAD. */
function statusPaths(status: string, dirty: readonly string[]) {
  const origins: string[] = [], entries = status.split('\0');
  for (let index = 0; index < entries.length; index++) {
    const xy = entries[index].slice(0, 2);
    if (entries[index].length >= 4 && (xy.includes('R') || xy.includes('C')) && xy !== '??') { if (entries[index + 1]) origins.push(entries[index + 1]); index++; }
  }
  return [...new Set([...dirty, ...origins])];
}
const refStamp = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Commit every path the guard counts dirty (dirtyCheckoutPaths), plus any rename's origin, onto
 * HEAD through a private index, record the commit under a named ref, then return those paths to
 * HEAD — tracked ones checked out from it, ones HEAD lacks removed. Null when nothing is dirty.
 * Throws, with the ref named when it was already written, when the checkout is still dirty after.
 */
export async function restoreCoordinatorCheckout(root: string, reason: string, run: ChildRun = defaultChildRun, at = new Date()): Promise<{ ref: string; commit: string; paths: string[] } | null> {
  const git = async (args: string[], env?: NodeJS.ProcessEnv) => String(await run('git', ['-C', root, '--literal-pathspecs', ...args], env ? { env } : undefined));
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=normal']);
  const dirty = dirtyCheckoutPaths(parseCoordinatorCheckout(root, head, status));
  if (!dirty.length) return null;
  const paths = statusPaths(status, dirty);
  const scratch = mkdtempSync(join(tmpdir(), 'graphyard-checkout-restore-'));
  let commit: string;
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    await git(['read-tree', head], env);
    await git(['add', '-A', '--', ...paths], env);
    const tree = (await git(['write-tree'], env)).trim();
    commit = (await git(['-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@localhost', 'commit-tree', tree, '-p', head, '-m', `graphyard checkout-restore: ${paths.length} dirty path(s) of the coordinator checkout at ${head.slice(0, 12)}\n\n${reason}\n\n${paths.join('\n')}`], env)).trim();
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const ref = `${checkoutRestoreRefPrefix}${refStamp(at)}`;
  await git(['update-ref', '-m', `graphyard checkout-restore: ${reason.slice(0, 200)}`, ref, commit, '']);
  // Only once the ref holds them are the paths returned to HEAD.
  const tracked: string[] = [], added: string[] = [];
  for (const path of paths) {
    const inHead = !path.endsWith('/') && await Promise.resolve(run('git', ['-C', root, 'cat-file', '-e', `${head}:${path}`])).then(() => true, () => false);
    (inHead ? tracked : added).push(path);
  }
  if (added.length) await git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...added]);
  if (tracked.length) await git(['checkout', head, '--', ...tracked]);
  for (const path of added) await rm(join(root, path), { recursive: true, force: true });
  const after = dirtyCheckoutPaths(await readCoordinatorCheckout(root, (command, args) => run(command, args)));
  if (after.length) throw new Error(`the coordinator checkout at ${root} is still dirty after its paths were saved under ${ref} (${commit.slice(0, 12)}): ${after.slice(0, 8).join(', ')}`);
  return { ref, commit, paths };
}

/**
 * The loop's side (GY-1658): carry out a standing request, once. A request with no outcome is
 * restored, its outcome written back, and — when paths were restored — `settle` lets the guard record
 * the checkout clean before `restart` re-executes the loop through its unit. Null when no request stands.
 */
export async function serveCheckoutRestore(file: string, root: string, deps: { restart: () => Promise<unknown>; settle?: () => Promise<unknown>; report?: (outcome: CheckoutRestoreOutcome) => void; run?: ChildRun; now?: () => Date }): Promise<CheckoutRestoreOutcome | null> {
  const request = await readCheckoutRestoreRequest(file);
  if (!request || request.outcome) return null;
  const now = deps.now ?? (() => new Date());
  let outcome: CheckoutRestoreOutcome;
  try {
    const restored = await restoreCoordinatorCheckout(root, `${request.reason} (requested by ${request.requestedBy})`, deps.run, now());
    outcome = restored
      ? { at: now().toISOString(), state: 'restored', ref: restored.ref, commit: restored.commit, paths: restored.paths, detail: `${restored.paths.length} dirty path(s) saved under ${restored.ref} (${restored.commit.slice(0, 12)}) and returned to HEAD; the loop restarts through its supervising unit` }
      : { at: now().toISOString(), state: 'clean', ref: null, commit: null, paths: [], detail: `the coordinator checkout at ${root} held no dirty path; nothing was restored and the loop was not restarted` };
  } catch (error) {
    outcome = { at: now().toISOString(), state: 'failed', ref: null, commit: null, paths: [], detail: (error instanceof Error ? error.message : String(error)).slice(0, 4000) };
  }
  if (outcome.state === 'restored') {
    try { await deps.settle?.(); } catch { /* the restarted loop reads the checkout afresh */ }
  }
  await atomicPrivateWrite(file, { ...request, outcome });
  deps.report?.(outcome);
  if (outcome.state === 'restored') await deps.restart();
  return outcome;
}

/** `master checkout-restore REASON`: file the request, then wait for the loop's outcome. */
export async function checkoutRestoreCommand(config: Pick<MasterConfig, 'credentialFile'>, args: readonly string[], requestedBy: string, options: { waitMs?: number; pollMs?: number } = {}) {
  const reason = args.join(' ').trim();
  if (!reason) throw new Error(checkoutRestoreUsage);
  if (reason.length > 2000) throw new Error('The checkout-restore reason is limited to 2000 characters');
  const file = checkoutRestoreRequestPath(config);
  const request = await fileCheckoutRestoreRequest(file, reason, requestedBy);
  const deadline = Date.now() + (options.waitMs ?? checkoutRestoreWaitMs);
  while (Date.now() < deadline) {
    await delay(options.pollMs ?? 2_000);
    const current = await readCheckoutRestoreRequest(file);
    if (current?.id !== request.id) return { request: request.id, state: 'superseded', detail: 'a later checkout-restore request replaced this one' };
    if (current.outcome) {
      if (current.outcome.state === 'failed') process.exitCode = 1;
      return { request: request.id, ...current.outcome };
    }
  }
  return { request: request.id, state: 'requested', detail: `filed at ${file}; the loop carries it out on its next pass and records the outcome there` };
}
