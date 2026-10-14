// Concern: the command side of `master checkout-restore` and the confined master's `master restart` and `master executors` (GY-1658) — filing the request a master identity records beside the loop's cursor and waiting for the loop's outcome, and, under GY-1680, handing a stale loop off and serving the old-HEAD case from the verified serving release itself. The requests, paths and the restore act are master-checkout-restore.ts's; the loop's side is serveCheckoutRestore there.
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { atomicPrivateWrite } from '../master/config.js';
import { coordinatorCheckoutRoot, type MasterConfig } from '../master/profiles.js';
import type { WriterFreezeDeps } from './checkout-writers.js';
import { releasePinnedRestore, type ReleaseRestoreDeps, type ServingReleaseInputs, staleServingLoop } from './checkout-restore-release.js';
import { besideCursor, type CheckoutRestoreOutcome, checkoutRestoreFreezeLedgerPath, checkoutRestoreGrantPath, checkoutRestoreUsage, fileCheckoutRestoreRequest, type LoopRequestAct, loopRequestPath, loopRestartRequestPath, newLoopRequest, readCheckoutRestoreRequest } from './master-checkout-restore.js';

// A loop whose loaded code predates that serve path would still serve a request from its own code,
// so the command hands such a loop off (review of GY-1680): the request carries a `handoff` field
// only a loop holding the serve path reads — every release since GY-1658 parses requests strictly and
// leaves an unknown field's request standing, unread — and a loop-restart request is filed beside
// it, the act every such loop serves; the restarted loop, running the checkout's HEAD, serves the
// standing request from the serving release. When that HEAD itself predates the serve entry, a
// restart onto it still cannot serve: the command — already holding this release's code — serves
// from a snapshot under a handoff grant naming that HEAD and the release to advance onto; the entry
// moves the clean checkout onto that release while its writers still stand frozen (review of
// GY-1680: a `git checkout` after the thaw would move HEAD under a resumed writer), and only then
// does the command file the restart so the unit loads it. An adoption is settled only around the restart
// it is for (review of GY-1680): the guard adopts the HEAD just before the unit is asked, and when
// the ask fails the expectation reverts, so the drift escalation stands — explaining the loop still
// running the old commit — until a restart lands.
//
// The confined master's `master restart` is the same kind of act: the systemd user manager is one of
// the process-launch channels its confinement hides, so it files a restart request the loop serves.
// A restart the loop owes is recorded before it is asked for, against the loop's pid, and retried on
// every pass until a process other than the one that asked reads the request — the restarted loop.
// Its `master executors [restart]` is a third: the restart goes through the host's systemd, and the
// liveness of the executors' host pids cannot be judged from its own PID namespace, so the loop runs
// the command and records what it printed.

/** How long the command waits for the loop to carry its request out before it reports the request as filed. */
export const checkoutRestoreWaitMs = 120_000;
/** An executor restart waits on held claims and re-registration for up to its timeout twice over (executor-fleet.ts). */
export const loopExecutorsWaitMs = 1_200_000;

/** The deployment observation and base branch the command's old-HEAD handoff reads from the cursor and the installation config. */
function handoffReleaseInputs(config: Pick<MasterConfig, 'credentialFile' | 'baseBranch'>): ServingReleaseInputs {
  try {
    const parsed = JSON.parse(readFileSync(besideCursor(config, 'daemon'), 'utf8')) as { deployment?: { source?: unknown; sha?: unknown } | null };
    const source = typeof parsed.deployment?.source === 'string' ? parsed.deployment.source : null;
    const sha = typeof parsed.deployment?.sha === 'string' ? parsed.deployment.sha : null;
    return { deployment: source ? { source, sha } : null, baseBranch: config.baseBranch };
  } catch { return { deployment: null, baseBranch: config.baseBranch }; }
}

/**
 * `master checkout-restore REASON` (and the confined master's `master restart` and `master executors
 * [restart]`): file the request, then wait for the loop's outcome. A checkout-restore filed against a
 * loop whose loaded code predates the serve path (staleServingLoop) is handed off (GY-1680): the
 * request carries `handoff`, which that loop cannot read and so leaves standing, and a loop-restart
 * request is filed beside it, which every such loop serves; the loop its unit restarts, running the
 * checkout's HEAD, serves the standing request from the serving release. When that HEAD itself
 * predates the serve entry (GY-1680 review), the command serves from the verified serving release's
 * snapshot under a handoff grant whose entry advances the checkout onto that release under its own
 * freeze, then files the restart so the unit loads it — a restart onto the old HEAD would still
 * leave the request unread, and an advance after the thaw would run under a resumed writer. That serve
 * carries the installation's freeze ledger as the loop-served path does (review of GY-1680): the
 * entry records each writer it stops there, and once the entry has ended however it ended — the
 * act's timeout kills it after its SIGSTOPs, say — the command continues every writer the ledger
 * still names stopped before recording the failure, so no writer stays stopped behind a failed
 * request. A restart that loop reports failed (no supervising unit) fails the command, with the
 * request left standing for the loop that next starts. `run` runs git against the checkout to judge
 * the loaded code; `serve` adjusts the handoff's act (its timeout, the snapshot's entry command, how
 * the ledger's writers are signalled and read) for tests.
 */
export async function checkoutRestoreCommand(config: Pick<MasterConfig, 'credentialFile' | 'baseBranch'> & Partial<Pick<MasterConfig, 'cliPath'>>, args: readonly string[], requestedBy: string, options: { waitMs?: number; pollMs?: number; act?: LoopRequestAct; run?: ChildRun; release?: () => ServingReleaseInputs; restore?: ReturnType<typeof releasePinnedRestore>; serve?: Pick<ReleaseRestoreDeps, 'timeoutMs' | 'command'> & { ledger?: Pick<WriterFreezeDeps, 'signal' | 'state'> } } = {}) {
  const act = options.act ?? 'checkout-restore';
  const reason = act === 'executors' ? `master executors ${args.join(' ')} from the confined master session`.replace(/ {2,}/g, ' ')
    : args.join(' ').trim() || (act === 'restart' ? 'master restart from the confined master session' : '');
  if (!reason) throw new Error(checkoutRestoreUsage);
  if (reason.length > 2000) throw new Error(`The ${act} reason is limited to 2000 characters`);
  const file = loopRequestPath(config, act), now = new Date(), run = options.run ?? defaultChildRun;
  const root = config.cliPath ? coordinatorCheckoutRoot(config.cliPath) : null;
  const stale = act === 'checkout-restore' ? await staleServingLoop(besideCursor(config, 'daemon'), root, run) : null;
  const restartFile = loopRestartRequestPath(config);
  // Old-HEAD handoff: the checkout's HEAD predates the serve entry, so a restart onto it cannot
  // serve. This command — holding the serve path — restores from the verified release's snapshot,
  // whose entry advances HEAD onto that release under its freeze, then files the restart the stale loop serves.
  if (stale && !stale.headServes) {
    if (!root || !stale.head) throw new Error(`the loop (pid ${stale.pid}) runs ${stale.loaded ? stale.loaded.slice(0, 12) : 'code it did not record'}, from before the serve path, and the checkout's HEAD ${stale.head ? `${stale.head.slice(0, 12)} predates the serve entry` : 'cannot be read'}, so a restart onto it cannot serve the request from the serving release; the command could not read the checkout's HEAD to bind the old-HEAD handoff, so nothing was restored`);
    const restart = newLoopRequest(`GY-1680 handoff for checkout-restore: the loop (pid ${stale.pid}) runs ${stale.loaded ? stale.loaded.slice(0, 12) : 'code it did not record'}, from before the serve path, and the checkout's HEAD ${stale.head.slice(0, 12)} predates the serve entry too, so a restart onto it cannot serve; the command served from the verified serving release's snapshot, whose entry advanced the checkout onto that release under its freeze, and this restart loads it`, requestedBy, now, 'restart');
    const request = await fileCheckoutRestoreRequest(file, reason, requestedBy, now, act, [], { loaded: stale.loaded, restart: restart.id });
    const handoff = { pid: stale.pid, loaded: stale.loaded, restart: restart.id, detail: `the loop (pid ${stale.pid}) runs ${stale.loaded ? stale.loaded.slice(0, 12) : 'code it did not record'}, from before the serve path, and the checkout's HEAD ${stale.head.slice(0, 12)} predates the serve entry too, so this command served from the verified serving release's snapshot, whose entry advanced the checkout onto that release under its freeze, and loop-restart request ${restart.id} was filed at ${restartFile} so the unit loads it` };
    const skippedDetail = (skipped: { pid: number; error: string }[]) => skipped.length
      ? `; skipped, their cwd unreadable: ${skipped.slice(0, 8).map(entry => `pid ${entry.pid} (${entry.error})`).join(', ')}${skipped.length > 8 ? ` and ${skipped.length - 8} more` : ''}`
      : '';
    try {
      // The installation's freeze ledger, as the loop-served path passes it (review of GY-1680): the entry's
      // own thaw is a `finally` the act's timeout kill never reaches, so the command finishes it from the ledger.
      const restore = options.restore ?? releasePinnedRestore({
        release: options.release ?? (() => handoffReleaseInputs(config)),
        grant: { file: checkoutRestoreGrantPath(config), credentialFile: config.credentialFile, pid: process.pid },
        handoff: { head: stale.head }, run,
        ledger: { file: checkoutRestoreFreezeLedgerPath(config), ...options.serve?.ledger },
        ...(options.serve?.timeoutMs !== undefined ? { timeoutMs: options.serve.timeoutMs } : {}),
        ...(options.serve?.command ? { command: options.serve.command } : {}),
      });
      const { restored, head, served, release } = await restore(root, `${reason} (requested by ${requestedBy})`, now, { file, id: request.id });
      // The entry advanced the checkout onto the release under its own freeze (review of GY-1680): a
      // `git checkout` here, after the thaw, would move HEAD and the tracked files under a resumed
      // writer. The command only checks that the checkout stands where the entry says it left it.
      if (!release || head !== release) throw new Error(`the coordinator checkout at ${root} stands at ${head ? head.slice(0, 12) : 'a HEAD the entry did not report'}${release ? `, not the release ${release.slice(0, 12)} the entry was to advance it onto under its freeze` : ', and no release served'}${restored ? `; ${restored.paths.length} dirty path(s) were saved under ${restored.ref} (${restored.commit.slice(0, 12)}) and returned to HEAD` : ''}; no restart was filed${served ? ` (${served})` : ''}`);
      const by = (served ? `; ${served}` : '') + `; handed off by loop-restart request ${restart.id} from the loop that ran ${stale.loaded ? stale.loaded.slice(0, 12) : 'code it did not record'}, from before the serve path, with checkout HEAD ${stale.head.slice(0, 12)} predating the serve entry so the command served and the entry advanced the checkout onto the release while its writers stood frozen`;
      // Advanced onto the release — a commit the loop, running code from before the serve entry, has not loaded — the checkout is the drift the restart adopts.
      const outcome: CheckoutRestoreOutcome = restored
        ? { at: now.toISOString(), state: 'restored', ref: restored.ref, commit: restored.commit, paths: restored.paths, detail: `${restored.paths.length} dirty path(s) saved under ${restored.ref} (${restored.commit.slice(0, 12)}; its second parent holds the index) and returned to HEAD; the loop restarts through its supervising unit onto the verified serving release ${release.slice(0, 12)}${skippedDetail(restored.skipped)}${by}`.slice(0, 4000), restart: null }
        : { at: now.toISOString(), state: 'adopted', ref: null, commit: release, paths: [], detail: `the coordinator checkout at ${root} held no dirty path at ${stale.head.slice(0, 12)}${stale.loaded && stale.head !== stale.loaded ? `, which is not ${stale.loaded.slice(0, 12)}, the commit the loop runs` : ''}; the loop adopts the verified serving release ${release.slice(0, 12)} the entry advanced it onto and restarts through its supervising unit onto it${by}`.slice(0, 4000), restart: null };
      await atomicPrivateWrite(file, { ...request, outcome });
      await atomicPrivateWrite(restartFile, restart);
    } catch (error) {
      const outcome: CheckoutRestoreOutcome = { at: now.toISOString(), state: 'failed', ref: null, commit: null, paths: [], detail: (error instanceof Error ? error.message : String(error)).slice(0, 4000), restart: null };
      await atomicPrivateWrite(file, { ...request, outcome });
      process.exitCode = 1;
      return { request: request.id, act, ...outcome, handoff };
    }
    const deadline = Date.now() + (options.waitMs ?? checkoutRestoreWaitMs);
    while (Date.now() < deadline) {
      await delay(options.pollMs ?? 2_000);
      const current = await readCheckoutRestoreRequest(file);
      if (current?.id !== request.id) return { request: request.id, act, state: 'superseded', detail: `a later ${act} request replaced this one`, handoff };
      const owed = await readCheckoutRestoreRequest(restartFile);
      if (owed?.id !== handoff.restart || !owed.outcome?.restart) continue;
      if (owed.outcome.restart.state === 'failed') {
        process.exitCode = 1;
        return { request: request.id, act, state: 'failed', detail: `the handoff failed: ${owed.outcome.restart.detail}; the request was already served from the verified serving release and the checkout stands at that release for the loop that next starts`, handoff };
      }
      // `requested`: the stale loop asked its unit; `done`: the restarted loop recorded it. The
      // restore already landed either way — return once the unit was asked.
      if (owed.outcome.restart.state === 'requested' || owed.outcome.restart.state === 'done') {
        return { request: request.id, act, ...current!.outcome!, restart: owed.outcome.restart, handoff };
      }
    }
    const standing = await readCheckoutRestoreRequest(file);
    return { request: request.id, act, ...(standing?.outcome ?? { state: 'requested' as const, detail: `filed at ${file}; the old-HEAD handoff restored from the serving release and waits for its restart`, at: now.toISOString(), ref: null, commit: null, paths: [], restart: null }), handoff };
  }
  const restart = stale ? newLoopRequest(`GY-1680 handoff for checkout-restore: the loop (pid ${stale.pid}) runs ${stale.loaded ? stale.loaded.slice(0, 12) : 'code it did not record'}, from before the serve path, so it would serve the request from that code; it restarts through its unit onto the checkout's HEAD, and the loop that loads it serves the standing request from the serving release`, requestedBy, now, 'restart') : null;
  // The request first, in the form the stale loop leaves standing; then the restart it serves.
  const request = await fileCheckoutRestoreRequest(file, reason, requestedBy, now, act, act === 'executors' ? args : [], restart && stale ? { loaded: stale.loaded, restart: restart.id } : undefined);
  if (restart) await atomicPrivateWrite(restartFile, restart);
  const handoff = restart && stale ? { pid: stale.pid, loaded: stale.loaded, restart: restart.id, detail: `the loop (pid ${stale.pid}) runs ${stale.loaded ? stale.loaded.slice(0, 12) : 'code it did not record'}, from before the serve path, so loop-restart request ${restart.id} was filed at ${restartFile}: it restarts through its unit onto the checkout's HEAD, and the loop that loads it serves this request from the serving release` } : null;
  const deadline = Date.now() + (options.waitMs ?? (act === 'executors' ? loopExecutorsWaitMs : checkoutRestoreWaitMs));
  while (Date.now() < deadline) {
    await delay(options.pollMs ?? 2_000);
    const current = await readCheckoutRestoreRequest(file);
    if (current?.id !== request.id) return { request: request.id, act, state: 'superseded', detail: `a later ${act} request replaced this one`, ...(handoff ? { handoff } : {}) };
    if (current.outcome) {
      const executors = (current.outcome.result as { result?: unknown } | undefined)?.result;
      if (current.outcome.state === 'failed' || typeof executors === 'string' && executors !== 'restarted') process.exitCode = 1;
      return { request: request.id, act, ...current.outcome, ...(handoff ? { handoff } : {}) };
    }
    if (handoff) {
      const owed = await readCheckoutRestoreRequest(restartFile);
      if (owed?.id === handoff.restart && owed.outcome?.restart?.state === 'failed') {
        process.exitCode = 1;
        return { request: request.id, act, state: 'failed', detail: `the handoff failed: ${owed.outcome.restart.detail}; the request stands at ${file} for the loop that next starts, which serves it from the serving release`, handoff };
      }
    }
  }
  return { request: request.id, act, state: 'requested', detail: `filed at ${file}; the loop carries it out on its next pass and records the outcome there${handoff ? `, once the handoff's restart lands` : ''}`, ...(handoff ? { handoff } : {}) };
}
