import { ensureWorktreeDependencies, npmCi, type DependencyInstaller } from '../repository-setup.js';

/**
 * Bring a new worktree's dependencies in line with its lockfile while renewing the lease every
 * `intervalMs`. When an install is needed the lease is renewed first, so npm never starts under a
 * lease about to lapse. Renewals run one at a time, and the install is reported only after the last
 * one has answered: the first refused renewal stops the install, or fails a finished one, with the
 * refusal. The epoch that asked for the worktree is no longer held, so nothing more is done in it.
 */
export async function installUnderLease(worktree: string, renew: () => Promise<unknown>, subject: string,
  options: { install?: DependencyInstaller; intervalMs?: number } = {}) {
  const stop = new AbortController();
  let renewal: Promise<void> | null = null, keepalive: ReturnType<typeof setInterval> | undefined;
  const beat = () => renewal = renew().then(() => {}, error => {
    stop.abort(new Error(`The lease heartbeat for ${subject} was refused while installing dependencies, so the install was stopped: ${error instanceof Error ? error.message : String(error)}`));
  }).finally(() => { renewal = null; });
  const install: DependencyInstaller = async (cwd, signal) => {
    await beat(); signal?.throwIfAborted();
    keepalive = setInterval(() => { if (!renewal && !stop.signal.aborted) beat(); }, options.intervalMs ?? 30_000);
    await (options.install ?? npmCi)(cwd, signal);
  };
  const result = await ensureWorktreeDependencies(worktree, install, stop.signal).finally(async () => { clearInterval(keepalive); await renewal; });
  if (stop.signal.aborted) throw stop.signal.reason;
  return result;
}
