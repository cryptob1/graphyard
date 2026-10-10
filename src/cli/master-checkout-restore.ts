// Concern: `graphyard master checkout-restore` and the confined master's `master restart` and `master executors` (GY-1658) — host acts a confined master identity requests and the loop, the one unconfined process, carries out.
import { copyFileSync, existsSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { atomicPrivateWrite } from '../master/config.js';
import { freezeCheckoutWriters } from './checkout-writers.js';

export { checkoutWriterProcesses, freezeCheckoutWriters, processStateOf, type WriterFreezeDeps } from './checkout-writers.js';
import type { MasterConfig } from '../master/profiles.js';

// The GY-857 guard refuses every loop start, self-upgrade and restart from a coordinator checkout
// holding uncommitted work, and nothing but a person could end that refusal: the doctor's command
// allowlist refuses git and every checkout mutation, and the doctor and the master session both run
// with the checkout read-only and the host's process-launch channels hidden (GY-888, GY-1658). This
// act is the installation's own remedy. Any master identity — the doctor's included — records a
// request beside the loop's cursor, outside the checkout; the loop then freezes the standing
// processes working in the checkout (the suspected writers) — refusing to touch anything when one
// cannot be verified stopped — commits the index and every non-ignored dirty path, untracked scratch
// included, onto HEAD under a named ref (refs/graphyard/checkout-restore/STAMP-COMMIT), returns those paths
// to HEAD, continues the writers it stopped, settles the dirty-checkout escalation and restarts itself through its
// supervising unit (graphyard-master.service). Nothing is discarded: the ref's first parent is HEAD,
// its second the index as it stood, and its tree the working files, so `git diff HEAD REF` and
// `git diff HEAD REF^2` show every byte. No stash entry is used: the stash stack is shared with every
// worktree of the repository.
//
// The confined master's `master restart` is the same kind of act: the systemd user manager is one of
// the process-launch channels its confinement hides, so it files a restart request the loop serves.
// A restart the loop owes is recorded before it is asked for, against the loop's pid, and retried on
// every pass until a process other than the one that asked reads the request — the restarted loop.
// Its `master executors [restart]` is a third: the restart goes through the host's systemd, and the
// liveness of the executors' host pids cannot be judged from its own PID namespace, so the loop runs
// the command and records what it printed.

/** Where restored checkout contents are kept, one ref per restore. */
export const checkoutRestoreRefPrefix = 'refs/graphyard/checkout-restore/';
export const checkoutRestoreUsage = 'Use master checkout-restore REASON';
/** How long the command waits for the loop to carry its request out before it reports the request as filed. */
export const checkoutRestoreWaitMs = 120_000;
/** An executor restart waits on held claims and re-registration for up to its timeout twice over (executor-fleet.ts). */
export const loopExecutorsWaitMs = 1_200_000;

const restartSchema = z.object({ state: z.enum(['requested', 'failed', 'done']), pid: z.number().int(), at: z.string(), detail: z.string().max(4000) }).strict();
const outcomeSchema = z.object({
  at: z.string(), state: z.enum(['restored', 'clean', 'failed', 'restart', 'executors']), detail: z.string().max(4000),
  ref: z.string().nullable(), commit: z.string().nullable(), paths: z.array(z.string()).max(10_000),
  restart: restartSchema.nullable().default(null),
  /** What `master executors` printed when the loop ran it for a confined master. */
  result: z.unknown().optional(),
}).strict();
const requestSchema = z.object({
  id: z.string().max(100), act: z.enum(['checkout-restore', 'restart', 'executors']).default('checkout-restore'), reason: z.string().min(1).max(2000), requestedAt: z.string(), requestedBy: z.string().max(200),
  /** The `master executors` arguments the loop runs. */
  args: z.array(z.string().max(200)).max(20).default([]),
  outcome: outcomeSchema.nullable(),
}).strict();
export type LoopRequestAct = z.infer<typeof requestSchema>['act'];
export type CheckoutRestoreRequest = z.infer<typeof requestSchema>;
export type CheckoutRestoreOutcome = z.infer<typeof outcomeSchema>;

const besideCursor = (config: Pick<MasterConfig, 'credentialFile'>, suffix: string) =>
  resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.${suffix}.json`);
/** The request files: beside the loop's cursor (daemonStatePath), so a session that sees the checkout read-only can still file them. */
export const checkoutRestoreRequestPath = (config: Pick<MasterConfig, 'credentialFile'>) => besideCursor(config, 'checkout-restore');
export const loopRestartRequestPath = (config: Pick<MasterConfig, 'credentialFile'>) => besideCursor(config, 'loop-restart');
export const loopExecutorsRequestPath = (config: Pick<MasterConfig, 'credentialFile'>) => besideCursor(config, 'loop-executors');
export const loopRequestPath = (config: Pick<MasterConfig, 'credentialFile'>, act: LoopRequestAct) =>
  act === 'restart' ? loopRestartRequestPath(config) : act === 'executors' ? loopExecutorsRequestPath(config) : checkoutRestoreRequestPath(config);
export async function readCheckoutRestoreRequest(file: string): Promise<CheckoutRestoreRequest | null> {
  try { return requestSchema.parse(JSON.parse(await readFile(file, 'utf8'))); } catch { return null; }
}
export async function fileCheckoutRestoreRequest(file: string, reason: string, requestedBy: string, now = new Date(), act: LoopRequestAct = 'checkout-restore', args: readonly string[] = []): Promise<CheckoutRestoreRequest> {
  const request = requestSchema.parse({ id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, act, reason, requestedAt: now.toISOString(), requestedBy, args, outcome: null });
  await atomicPrivateWrite(file, request);
  return request;
}

/**
 * Every path `git status --porcelain -z` names, rename and copy origins included: every non-ignored
 * dirty path — tracked changes and untracked files alike, wherever they lie — which a restore saves
 * and returns to HEAD.
 */
export function statusPaths(status: string): string[] {
  const paths: string[] = [], entries = status.split('\0');
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index], xy = entry.slice(0, 2);
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if ((xy.includes('R') || xy.includes('C')) && xy !== '??') { if (entries[index + 1]) paths.push(entries[index + 1]); index++; }
  }
  return [...new Set(paths)];
}
const refStamp = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * With the checkout's writers frozen (`quiesce`, which throws before anything is touched when it
 * cannot establish that), commit the index as it stands and every non-ignored dirty path (statusPaths:
 * tracked changes, untracked files anywhere, rename origins) onto HEAD — the index as the second
 * parent, the working files as the tree — record the commit under a named ref, then return those
 * paths to HEAD: tracked ones checked out from it, ones HEAD lacks removed. Null when nothing is
 * dirty. Throws, with the ref named when it was already written, when the checkout is still dirty
 * after; the writers this attempt stopped are continued whatever happens.
 */
export type CheckoutQuiesce = (root: string) => { thaw: () => void } | Promise<{ thaw: () => void }>;
export async function restoreCoordinatorCheckout(root: string, reason: string, run: ChildRun = defaultChildRun, at = new Date(), quiesce: CheckoutQuiesce = freezeCheckoutWriters): Promise<{ ref: string; commit: string; paths: string[] } | null> {
  const frozen = await quiesce(root);
  try { return await restoreQuiesced(root, reason, run, at); } finally { frozen.thaw(); }
}
async function restoreQuiesced(root: string, reason: string, run: ChildRun, at: Date) {
  const git = async (args: string[], env?: NodeJS.ProcessEnv) => String(await run('git', ['-C', root, '--literal-pathspecs', ...args], env ? { env } : undefined));
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  // Every untracked file by its own path (GY-1658 review): `normal` collapses an untracked directory to
  // `dir/`, which `git add` saves without its ignored descendants while a recursive removal would delete them.
  const status = () => git(['status', '--porcelain', '-z', '--untracked-files=all']);
  const paths = statusPaths(await status());
  if (!paths.length) return null;
  // Only a nested repository is still named as a directory; its history is not the checkout's to save.
  const nested = paths.filter(path => path.endsWith('/'));
  if (nested.length) throw new Error(`the coordinator checkout at ${root} holds untracked nested repositories (${nested.slice(0, 8).join(', ')}), which a restore cannot save, so nothing was restored`);
  const scratch = mkdtempSync(join(tmpdir(), 'graphyard-checkout-restore-'));
  let commit: string;
  try {
    const identity = ['-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@localhost'];
    const message = `graphyard checkout-restore: ${paths.length} dirty path(s) of the coordinator checkout at ${head.slice(0, 12)}\n\n${reason}\n\n${paths.join('\n')}`;
    // The index as it stands, staged versions included, read from a copy so the real one is untouched; an unmerged index refuses here.
    const staged = { ...process.env, GIT_INDEX_FILE: join(scratch, 'staged') }, realIndex = resolve(root, (await git(['rev-parse', '--git-path', 'index'])).trim());
    if (existsSync(realIndex)) copyFileSync(realIndex, staged.GIT_INDEX_FILE); else await git(['read-tree', head], staged);
    const index = (await git([...identity, 'commit-tree', (await git(['write-tree'], staged)).trim(), '-p', head, '-m', `index of ${message}`], staged)).trim();
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
    await git(['read-tree', head], env);
    await git(['add', '-A', '--', ...paths], env);
    commit = (await git([...identity, 'commit-tree', (await git(['write-tree'], env)).trim(), '-p', head, '-p', index, '-m', message], env)).trim();
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  // The stamp and the commit: two restores within one second never collide.
  const ref = `${checkoutRestoreRefPrefix}${refStamp(at)}-${commit.slice(0, 12)}`;
  await git(['update-ref', '-m', `graphyard checkout-restore: ${reason.slice(0, 200)}`, ref, commit, '']);
  // Only once the ref holds them are the paths returned to HEAD.
  const tracked: string[] = [], added: string[] = [];
  const holds = (tree: string, path: string) => Promise.resolve(run('git', ['-C', root, 'cat-file', '-e', `${tree}:${path}`])).then(() => true, () => false);
  for (const path of paths) (await holds(head, path) ? tracked : added).push(path);
  // A path is removed only once the saved tree is proven to hold it; one deleted in the working tree is absent from both and already gone.
  const unsaved: string[] = [];
  for (const path of added) if (existsSync(join(root, path)) && !await holds(commit, path)) unsaved.push(path);
  if (unsaved.length) throw new Error(`the restore commit ${commit.slice(0, 12)} under ${ref} does not hold ${unsaved.slice(0, 8).join(', ')}, so nothing was returned to HEAD`);
  // Forced: a path staged differently from both HEAD and its file is already saved in the ref's second parent.
  if (added.length) await git(['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...added]);
  if (tracked.length) await git(['checkout', head, '--', ...tracked]);
  for (const path of added) await rm(join(root, path), { force: true });
  // The directories those files emptied go too; one still holding anything (an ignored file) stays.
  const parents = [...new Set(added.flatMap(path => path.split('/').slice(0, -1).map((_, depth, parts) => parts.slice(0, depth + 1).join('/'))))];
  for (const directory of parents.sort((a, b) => b.length - a.length)) { try { rmdirSync(join(root, directory)); } catch { /* not empty, or not ours */ } }
  const after = statusPaths(await status());
  if (after.length) throw new Error(`the coordinator checkout at ${root} is still dirty after its paths were saved under ${ref} (${commit.slice(0, 12)}): ${after.slice(0, 8).join(', ')}`);
  return { ref, commit, paths };
}

/** What the loop's serving of a request needs: `restart` re-executes the loop through its unit; `settle` lets the guard record a restored checkout clean first. */
export interface LoopRequestDeps { restart: () => Promise<unknown>; settle?: () => Promise<unknown>; report?: (outcome: CheckoutRestoreOutcome) => void; run?: ChildRun; now?: () => Date; pid?: number; quiesce?: CheckoutQuiesce;
  /** Runs `master executors ARGS` on the host — the loop's own view of its processes and systemd — and returns what it prints. */
  executors?: (args: string[]) => Promise<unknown> }

/**
 * The loop's side (GY-1658): carry out a standing request, once, and the restart it owes until it
 * lands. A request with no outcome is served — a checkout-restore restored, a restart request
 * answered — and its outcome written back with the restart it owes recorded `requested` against this
 * process's pid before `restart` is asked; a restart that fails is recorded `failed` and asked again
 * on the next pass. A process other than the one that asked reading an owed restart is the restarted
 * loop, and records it `done`. Returns the outcome this pass wrote, or null when it wrote none.
 */
export async function serveCheckoutRestore(file: string, root: string, deps: LoopRequestDeps): Promise<CheckoutRestoreOutcome | null> {
  const request = await readCheckoutRestoreRequest(file);
  if (!request) return null;
  const now = deps.now ?? (() => new Date()), pid = deps.pid ?? process.pid;
  const owed = request.outcome?.restart;
  if (request.outcome) {
    if (!owed || owed.state === 'done') return null;
    if (owed.pid !== pid) return write(file, request, { ...request.outcome, restart: { ...owed, state: 'done', at: now().toISOString(), detail: `the loop restarted: pid ${pid} serves the checkout after pid ${owed.pid} asked for the restart` } }, deps);
    if (owed.state === 'requested') return null;
    return restartOwed(file, request, request.outcome, deps, pid, now);
  }
  let outcome: CheckoutRestoreOutcome;
  if (request.act === 'executors') {
    try {
      if (!deps.executors) throw new Error('this loop cannot run master executors for a confined master');
      const result = await deps.executors(request.args);
      const verdict = (result as { result?: unknown } | null)?.result;
      outcome = { at: now().toISOString(), state: 'executors', ref: null, commit: null, paths: [], detail: `the loop ran master executors ${request.args.join(' ')}`.trim() + (typeof verdict === 'string' ? `: ${verdict}` : ''), restart: null, result };
    } catch (error) {
      outcome = { at: now().toISOString(), state: 'failed', ref: null, commit: null, paths: [], detail: (error instanceof Error ? error.message : String(error)).slice(0, 4000), restart: null };
    }
    deps.report?.(outcome);
    return write(file, request, outcome, deps);
  }
  if (request.act === 'restart') {
    outcome = { at: now().toISOString(), state: 'restart', ref: null, commit: null, paths: [], detail: `the loop restarts through its supervising unit, as ${request.requestedBy} asked: ${request.reason}`, restart: null };
  } else try {
    const restored = await restoreCoordinatorCheckout(root, `${request.reason} (requested by ${request.requestedBy})`, deps.run, now(), deps.quiesce);
    outcome = restored
      ? { at: now().toISOString(), state: 'restored', ref: restored.ref, commit: restored.commit, paths: restored.paths, detail: `${restored.paths.length} dirty path(s) saved under ${restored.ref} (${restored.commit.slice(0, 12)}; its second parent holds the index) and returned to HEAD; the loop restarts through its supervising unit`, restart: null }
      : { at: now().toISOString(), state: 'clean', ref: null, commit: null, paths: [], detail: `the coordinator checkout at ${root} held no dirty path; nothing was restored and the loop was not restarted`, restart: null };
  } catch (error) {
    outcome = { at: now().toISOString(), state: 'failed', ref: null, commit: null, paths: [], detail: (error instanceof Error ? error.message : String(error)).slice(0, 4000), restart: null };
  }
  if (outcome.state === 'restored') {
    try { await deps.settle?.(); } catch { /* the restarted loop reads the checkout afresh */ }
  }
  deps.report?.(outcome);
  if (outcome.state !== 'restored' && outcome.state !== 'restart') return write(file, request, outcome, deps);
  return restartOwed(file, request, outcome, deps, pid, now);
}
async function write(file: string, request: CheckoutRestoreRequest, outcome: CheckoutRestoreOutcome, deps: Pick<LoopRequestDeps, 'report'>) {
  await atomicPrivateWrite(file, { ...request, outcome });
  if (outcome.restart && outcome.restart.state !== 'requested') deps.report?.(outcome);
  return outcome;
}
async function restartOwed(file: string, request: CheckoutRestoreRequest, outcome: CheckoutRestoreOutcome, deps: LoopRequestDeps, pid: number, now: () => Date) {
  const asked = { ...outcome, restart: { state: 'requested' as const, pid, at: now().toISOString(), detail: 'the loop asked its supervising unit to restart it' } };
  await write(file, request, asked, deps);
  try { await deps.restart(); return asked; }
  catch (error) {
    return write(file, request, { ...outcome, restart: { state: 'failed', pid, at: now().toISOString(), detail: `the restart failed and is asked again on the loop's next pass: ${(error instanceof Error ? error.message : String(error)).slice(0, 3000)}` } }, deps);
  }
}

/** `master checkout-restore REASON` (and the confined master's `master restart` and `master executors [restart]`): file the request, then wait for the loop's outcome. */
export async function checkoutRestoreCommand(config: Pick<MasterConfig, 'credentialFile'>, args: readonly string[], requestedBy: string, options: { waitMs?: number; pollMs?: number; act?: LoopRequestAct } = {}) {
  const act = options.act ?? 'checkout-restore';
  const reason = act === 'executors' ? `master executors ${args.join(' ')} from the confined master session`.replace(/ {2,}/g, ' ')
    : args.join(' ').trim() || (act === 'restart' ? 'master restart from the confined master session' : '');
  if (!reason) throw new Error(checkoutRestoreUsage);
  if (reason.length > 2000) throw new Error(`The ${act} reason is limited to 2000 characters`);
  const file = loopRequestPath(config, act);
  const request = await fileCheckoutRestoreRequest(file, reason, requestedBy, new Date(), act, act === 'executors' ? args : []);
  const deadline = Date.now() + (options.waitMs ?? (act === 'executors' ? loopExecutorsWaitMs : checkoutRestoreWaitMs));
  while (Date.now() < deadline) {
    await delay(options.pollMs ?? 2_000);
    const current = await readCheckoutRestoreRequest(file);
    if (current?.id !== request.id) return { request: request.id, act, state: 'superseded', detail: `a later ${act} request replaced this one` };
    if (current.outcome) {
      const executors = (current.outcome.result as { result?: unknown } | undefined)?.result;
      if (current.outcome.state === 'failed' || typeof executors === 'string' && executors !== 'restarted') process.exitCode = 1;
      return { request: request.id, act, ...current.outcome };
    }
  }
  return { request: request.id, act, state: 'requested', detail: `filed at ${file}; the loop carries it out on its next pass and records the outcome there` };
}
