import type { MasterRun } from './profiles.js';
import { agentStartCeilingMs, launchStartMs } from './launch.js';

/**
 * GY-1373. How long one launch may take, from its hand-off to the session it acknowledges: the
 * runtime's own start bound (or its 120 s ceiling, whichever is longer) and two minutes for what
 * comes before and after it — the checkout, the credential, the pane and the delivered request.
 * A launch every step of which is bounded on its own still waited on a runtime that answered
 * nothing: on 6 October 2026 the claude runtime on one host dropped every session, each launch hung
 * on it, and the dispatcher's tick waited on them all, so no reviewer or producer launched anywhere.
 */
export const launchBoundSlackMs = 120_000;
export const launchBoundMs = (config: { run: Pick<MasterRun, 'launchStartSeconds'> }) => Math.max(launchStartMs(config), agentStartCeilingMs) + launchBoundSlackMs;

/**
 * A launch its runtime did not acknowledge within the bound. The message names the runtime and the
 * host, so the failure is that runtime's — never a control-plane timeout, which is plane-wide and
 * retried as such — and it is the failure of this one launch, not of the tick that handed it off.
 */
export class LaunchBoundError extends Error {
  constructor(readonly runtime: string, readonly host: string, readonly subject: string, readonly boundMs: number) {
    super(`the ${runtime} runtime on ${host} did not acknowledge the launch of ${subject} within its ${boundMs < 1000 ? `${boundMs} ms` : `${Math.round(boundMs / 1000)} s`} launch bound, so that runtime is taken as dead for this launch, which failed on its own while the tick went on`);
    this.name = 'LaunchBoundError';
  }
}

/**
 * Runs `start` under the launch bound. Past it the launch fails with a LaunchBoundError naming the
 * runtime; `start` itself is not cancelled — whatever it later settles to is dropped, and a session
 * it may still start is the session report's and the pane sweep's to close like any unrecorded one.
 */
export async function boundedLaunch<T>(start: () => Promise<T>, bound: { runtime: string; host: string; subject: string; boundMs: number }): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const launch = start();
  launch.catch(() => { /* a late failure is past the bound already reported */ });
  try {
    return await Promise.race([launch, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LaunchBoundError(bound.runtime, bound.host, bound.subject, bound.boundMs)), bound.boundMs);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}
