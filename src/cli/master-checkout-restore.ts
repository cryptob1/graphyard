// Concern: `graphyard master checkout-restore` and the confined master's `master restart` (GY-1658) — host acts a confined master identity requests and the loop, the one unconfined process, carries out.
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { ChildRun } from '../child-runner.js';
import { atomicPrivateWrite } from '../master/config.js';
import type { UnverifiableProcess } from './checkout-writers.js';
import { type CheckoutQuiesce, type RestoreAct, restoreInProcess } from './checkout-restore-act.js';

export { checkoutWriterProcesses, checkoutWriterScan, freezeCheckoutWriters, processStateOf, type WriterFreezeDeps } from './checkout-writers.js';
// The act itself — the quiesce-and-restore and the HEAD advance under the freeze — is checkout-restore-act.ts's, re-exported for its callers.
export { type CheckoutQuiesce, checkoutRestoreRefPrefix, type RestoreAct, type RestoreActOutcome, divergedHead, type DivergeInputs, restoreCheckoutFrozen, restoreCoordinatorCheckout, restoreInProcess, statusPaths } from './checkout-restore-act.js';
// The command side, re-exported for its callers: checkout-restore-command.ts imports this module's requests and paths (functions and paths only, used inside its functions).
export { checkoutRestoreCommand, checkoutRestoreWaitMs } from './checkout-restore-command.js';
import type { MasterConfig } from '../master/profiles.js';

// The GY-857 guard refuses every loop start, self-upgrade and restart from a coordinator checkout
// holding uncommitted work, and nothing but a person could end that refusal: the doctor's command
// allowlist refuses git and every checkout mutation, and the doctor and the master session both run
// with the checkout read-only and the host's process-launch channels hidden (GY-888, GY-1658). This
// act is the installation's own remedy. Any master identity — the doctor's included — records a
// request beside the loop's cursor, outside the checkout; the loop then freezes the standing
// processes working in the checkout (the suspected writers) — refusing to touch anything when one
// cannot be verified stopped, and recording as skipped the processes whose cwd read is refused EACCES
// (GY-1672) — commits the index and every non-ignored dirty path, untracked scratch
// included, onto HEAD under a named ref (refs/graphyard/checkout-restore/STAMP-COMMIT), returns those paths
// to HEAD, continues the writers it stopped, settles the dirty-checkout escalation and restarts itself through its
// supervising unit (graphyard-master.service). Nothing is discarded: the ref's first parent is HEAD,
// its second the index as it stood, and its tree the working files, so `git diff HEAD REF` and
// `git diff HEAD REF^2` show every byte. No stash entry is used: the stash stack is shared with every
// worktree of the repository. The quiesce-and-restore itself runs from the verified serving
// release's own CLI, in a detached shared-clone snapshot of it (GY-1680, checkout-restore-release.ts),
// so a fix to it reaches an installation whose loop cannot restart; a request that finds the
// checkout clean but at a HEAD other than the commit the loop runs restarts the loop onto that HEAD
// (the drift GY-1531 lets a restart adopt) instead of ending `clean` with the escalation standing.
// The command side — filing a request, the stale-loop and old-HEAD handoffs and `master restart` —
// is checkout-restore-command.ts; the act itself is checkout-restore-act.ts.

export const checkoutRestoreUsage = 'Use master checkout-restore REASON';

const restartSchema = z.object({ state: z.enum(['requested', 'failed', 'done']), pid: z.number().int(), at: z.string(), detail: z.string().max(4000) }).strict();
/** `adopted` (GY-1680): no dirty path, but HEAD is not the commit the loop loaded; the loop restarts onto it (`commit`). */
const outcomeSchema = z.object({
  at: z.string(), state: z.enum(['restored', 'adopted', 'clean', 'failed', 'restart']), detail: z.string().max(4000),
  ref: z.string().nullable(), commit: z.string().nullable(), paths: z.array(z.string()).max(10_000),
  restart: restartSchema.nullable().default(null),
}).strict();
/**
 * GY-1680: the request was filed against a loop whose loaded code (`loaded`, as its cursor recorded it;
 * null when it recorded none) predates the serve path, beside the loop-restart request `restart` that
 * hands it off. Present only then — a request without it is read by every release since GY-1658; one
 * with it only by a loop holding the serve path, since every earlier release parses strictly.
 */
const handoffSchema = z.object({ loaded: z.string().nullable(), restart: z.string().max(100) }).strict();
const requestSchema = z.object({
  id: z.string().max(100), act: z.enum(['checkout-restore', 'restart']).default('checkout-restore'), reason: z.string().min(1).max(2000), requestedAt: z.string(), requestedBy: z.string().max(200),
  /** Always empty: the `master executors` arguments a request filed before GY-1984 could carry. */
  args: z.array(z.string().max(200)).max(20).default([]),
  outcome: outcomeSchema.nullable(),
  handoff: handoffSchema.optional(),
}).strict();
export type LoopRequestAct = z.infer<typeof requestSchema>['act'];
export type CheckoutRestoreRequest = z.infer<typeof requestSchema>;
export type CheckoutRestoreOutcome = z.infer<typeof outcomeSchema>;
export type CheckoutRestoreHandoff = z.infer<typeof handoffSchema>;

export const besideCursor = (config: Pick<MasterConfig, 'credentialFile'>, suffix: string) =>
  resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.${suffix}.json`);
/** The request files: beside the loop's cursor (daemonStatePath), so a session that sees the checkout read-only can still file them. */
export const checkoutRestoreRequestPath = (config: Pick<MasterConfig, 'credentialFile'>) => besideCursor(config, 'checkout-restore');
export const loopRestartRequestPath = (config: Pick<MasterConfig, 'credentialFile'>) => besideCursor(config, 'loop-restart');
/** The single-use grant the loop signs for one serve of a checkout-restore request (GY-1680), beside the cursor like the request it names; the entry accepts it nowhere else. */
export const checkoutRestoreGrantPath = (config: Pick<MasterConfig, 'credentialFile'>) => besideCursor(config, 'checkout-restore-grant');
/** The freeze ledger of a serve (GY-1680 review): the writers the entry stopped, recorded before each SIGSTOP beside the cursor, which the loop continues when the entry is ended before its own thaw (continueFrozenWriters). */
export const checkoutRestoreFreezeLedgerPath = (config: Pick<MasterConfig, 'credentialFile'>) => besideCursor(config, 'checkout-restore-frozen');
export const loopRequestPath = (config: Pick<MasterConfig, 'credentialFile'>, act: LoopRequestAct) =>
  act === 'restart' ? loopRestartRequestPath(config) : checkoutRestoreRequestPath(config);
export async function readCheckoutRestoreRequest(file: string): Promise<CheckoutRestoreRequest | null> {
  try { return requestSchema.parse(JSON.parse(await readFile(file, 'utf8'))); } catch { return null; }
}
/** A request as filed, not yet written: `handoff` (GY-1680) only when the loop it is filed against is handed off. */
export function newLoopRequest(reason: string, requestedBy: string, now = new Date(), act: LoopRequestAct = 'checkout-restore', args: readonly string[] = [], handoff?: CheckoutRestoreHandoff): CheckoutRestoreRequest {
  return requestSchema.parse({ id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, act, reason, requestedAt: now.toISOString(), requestedBy, args, outcome: null, ...(handoff ? { handoff } : {}) });
}
export async function fileCheckoutRestoreRequest(file: string, reason: string, requestedBy: string, now = new Date(), act: LoopRequestAct = 'checkout-restore', args: readonly string[] = [], handoff?: CheckoutRestoreHandoff): Promise<CheckoutRestoreRequest> {
  const request = newLoopRequest(reason, requestedBy, now, act, args, handoff);
  await atomicPrivateWrite(file, request);
  return request;
}

/**
 * Every path `git status --porcelain -z` names, rename and copy origins included: every non-ignored
 * dirty path — tracked changes and untraceckout clean first, or adopt the HEAD a clean drifted
 * checkout holds (GY-1680) just before the restart onto it; `unadopt` reverts that adoption to the
 * commit the loop still runs when the restart could not be asked (review of GY-1680), so the drift
 * escalation stands until one lands; `loaded` is the commit the loop runs, which a clean checkout's
 * HEAD is judged against; `restore` is the act itself (the serving release's, for the loop),
 * defaulting to this process's own code with `quiesce`.
 */
export interface LoopRequestDeps { restart: () => Promise<unknown>; settle?: (adopt: string | null) => Promise<unknown>; unadopt?: (loaded: string) => Promise<unknown>; report?: (outcome: CheckoutRestoreOutcome) => void; run?: ChildRun; now?: () => Date; pid?: number; quiesce?: CheckoutQuiesce;
  loaded?: () => string | null; restore?: RestoreAct }

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
  if (request.act === 'restart') {
    outcome = { at: now().toISOString(), state: 'restart', ref: null, commit: null, paths: [], detail: `the loop restarts through its supervising unit, as ${request.requestedBy} asked: ${request.reason}`, restart: null };
  } else try {
    const act = deps.restore ?? restoreInProcess(deps.run, deps.quiesce);
    const { restored, head, served, diverged } = await act(root, `${request.reason} (requested by ${request.requestedBy})`, now(), { file, id: request.id });
    const by = (served ? `; ${served}` : '') + (request.handoff ? `; handed off by loop-restart request ${request.handoff.restart} from the loop that ran ${request.handoff.loaded ? request.handoff.loaded.slice(0, 12) : 'code it did not record'}, from before the serve path` : '');
    // GY-1680: a clean checkout whose HEAD is not the commit the loop runs is the drift GY-1531 lets a
    // restart adopt — the restart this request exists to make — never a `clean` outcome that leaves
    // the escalation standing.
    const loaded = deps.loaded?.() ?? null, adopt = diverged ? diverged.to : !restored && head && loaded && head !== loaded ? head : null;
    outcome = diverged
      // GY-1745: the checkout was moved off a HEAD that is neither merged nor forward of the loaded commit, which is kept under a ref; the loop adopts the release it moved onto and restarts onto it.
      ? { at: now().toISOString(), state: 'adopted', ref: diverged.ref, commit: diverged.to, paths: restored?.paths ?? [], detail: `the coordinator checkout at ${root} stood detached at ${diverged.from.slice(0, 12)}, neither on the base branch nor a descendant of the commit the loop runs; that HEAD is saved under ${diverged.ref} and the checkout is detached at the serving release ${diverged.to.slice(0, 12)}; the loop adopts it and restarts through its supervising unit onto it${restored ? `; ${restored.paths.length} dirty path(s) were first saved under ${restored.ref} (${restored.commit.slice(0, 12)}) and returned to HEAD` : ''}${by}`.slice(0, 4000), restart: null }
      : restored
      ? { at: now().toISOString(), state: 'restored', ref: restored.ref, commit: restored.commit, paths: restored.paths, detail: `${restored.paths.length} dirty path(s) saved under ${restored.ref} (${restored.commit.slice(0, 12)}; its second parent holds the index) and returned to HEAD; the loop restarts through its supervising unit${skippedDetail(restored.skipped)}${by}`.slice(0, 4000), restart: null }
      : adopt
        ? { at: now().toISOString(), state: 'adopted', ref: null, commit: adopt, paths: [], detail: `the coordinator checkout at ${root} held no dirty path, but its HEAD ${adopt.slice(0, 12)} is not ${loaded!.slice(0, 12)}, the commit the loop runs; the loop adopts it (GY-1531) and restarts through its supervising unit onto it${by}`.slice(0, 4000), restart: null }
        : { at: now().toISOString(), state: 'clean', ref: null, commit: null, paths: [], detail: `the coordinator checkout at ${root} held no dirty path${head && loaded ? ` and its HEAD ${head.slice(0, 12)} is the commit the loop runs` : ''}; nothing was restored and the loop was not restarted${by}`.slice(0, 4000), restart: null };
  } catch (error) {
    outcome = { at: now().toISOString(), state: 'failed', ref: null, commit: null, paths: [], detail: (error instanceof Error ? error.message : String(error)).slice(0, 4000), restart: null };
  }
  // A restored checkout is clean whatever the restart does, so it settles here; an adoption settles
  // only around its restart (restartOwed), and reverts when the restart cannot be asked.
  if (outcome.state === 'restored') {
    try { await deps.settle?.(null); } catch { /* the restarted loop reads the checkout afresh */ }
  }
  deps.report?.(outcome);
  if (outcome.state !== 'restored' && outcome.state !== 'adopted' && outcome.state !== 'restart') return write(file, request, outcome, deps);
  return restartOwed(file, request, outcome, deps, pid, now);
}
const skippedDetail = (skipped: UnverifiableProcess[]) => skipped.length
  ? `; skipped, their cwd unreadable: ${skipped.slice(0, 8).map(entry => `pid ${entry.pid} (${entry.error})`).join(', ')}${skipped.length > 8 ? ` and ${skipped.length - 8} more` : ''}`
  : '';
async function write(file: string, request: CheckoutRestoreRequest, outcome: CheckoutRestoreOutcome, deps: Pick<LoopRequestDeps, 'report'>) {
  await atomicPrivateWrite(file, { ...request, outcome });
  if (outcome.restart && outcome.restart.state !== 'requested') deps.report?.(outcome);
  return outcome;
}
/**
 * The restart an outcome owes, asked now and recorded `requested` first; `failed` when the ask fails,
 * to be asked again next pass. An `adopted` outcome's HEAD is adopted by the guard just before the ask
 * (GY-1680) — the commit the loop runs from the restart on — and, when the ask fails, reverted to the
 * commit the loop still runs (`unadopt`, review of GY-1680): a guard that kept the adopted HEAD would
 * report no drift under a loop running the old commit, and the escalation that explains the stale
 * runtime would be gone with its remedy unfinished. Recording the owed restart can fail the same
 * way (a state directory full or unwritable, review of GY-1680): that too reverts the adoption
 * before the error is raised, so no adoption outlives a restart that was never recorded. Each
 * retry adopts and asks again.
 */
async function restartOwed(file: string, request: CheckoutRestoreRequest, outcome: CheckoutRestoreOutcome, deps: LoopRequestDeps, pid: number, now: () => Date) {
  const adopt = outcome.state === 'adopted' ? outcome.commit : null;
  const loaded = adopt ? deps.loaded?.() ?? null : null;
  if (adopt) { try { await deps.settle?.(adopt); } catch { /* the guard reports what it finds */ } }
  const asked = { ...outcome, restart: { state: 'requested' as const, pid, at: now().toISOString(), detail: 'the loop asked its supervising unit to restart it' } };
  const revert = async () => {
    if (!adopt || !loaded || loaded === adopt) return '';
    try { await deps.unadopt?.(loaded); return deps.unadopt ? `; the adoption of ${adopt.slice(0, 12)} is reverted and the drift escalation stands until a restart lands` : ''; }
    catch { return ''; /* the guard reports what it finds */ }
  };
  // Recorded before it is asked; a record that fails reverts the adoption before the failure is raised (review of GY-1680).
  try { await write(file, request, asked, deps); }
  catch (error) {
    const reverted = await revert();
    throw new Error(`the restart could not be recorded at ${file}, so it was not asked: ${(error instanceof Error ? error.message : String(error)).slice(0, 3000)}${reverted}`, { cause: error });
  }
  try { await deps.restart(); return asked; }
  catch (error) {
    const reverted = await revert();
    return write(file, request, { ...outcome, restart: { state: 'failed', pid, at: now().toISOString(), detail: `the restart failed and is asked again on the loop's next pass: ${(error instanceof Error ? error.message : String(error)).slice(0, 3000)}${reverted}`.slice(0, 4000) } }, deps);
  }
}
