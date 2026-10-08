import type { SessionHandleInput } from './sessions.js';

/**
 * The registration every launch makes before its runtime starts (GY-172 AC-2), split from
 * `session-state.ts` — the loop's report and the one reading — by concern: this is the write a
 * launcher makes, that is what the loop observes of it.
 */
/**
 * Every path that starts a session registers it first (GY-172 AC-2): the loop's worker dispatch,
 * the executors, `master approver`, `master review`, escalation handlers and every reviewer and
 * producer launch go through this one helper, so each session exists on the record before its
 * runtime does and is observed and closed by the report above like any other. The registration
 * names the session by the runtime name its launcher gives it; the coordinates the launch returns
 * (the pane, and the name when the launcher chose one) are written over it once the runtime has
 * started, and a launch that fails ends the registration with the reason rather than leaving an
 * open record for the report to lose.
 *
 * A registration that cannot be written does not refuse the launch, any more than a handle that
 * could not be written ever failed one: the coordinates are written again once it has started,
 * retried `coordinateAttempts` times, and a launch is never lost to a control plane that was
 * briefly unreachable. Should every attempt fail, the handle has no coordinate the report can
 * match, and the report loses and closes it after the launch grace rather than leaving it open.
 */
export const coordinateAttempts = 3, coordinateRetryMs = 500;
export interface LaunchedCoordinates { pane?: string | null; agentName?: string | null }
export async function registeredLaunch<T>(record: ((handle: SessionHandleInput) => Promise<unknown>) | undefined, handle: SessionHandleInput,
  start: () => Promise<T>, coordinates: (launched: T) => LaunchedCoordinates | undefined = launched => launched as LaunchedCoordinates | undefined,
  attach?: (pane: string) => string): Promise<T> {
  if (!record) return start();
  // Every write carries this attempt's token, so the control plane refuses one that would register
  // over, close or re-coordinate a running handle another attempt holds (`engine.ts`): two launches
  // racing for one request from the same snapshot cannot end the session the other one started.
  const launch = globalThis.crypto.randomUUID().replaceAll('-', '');
  const registered = await record({ ...handle, launch, state: 'running' }).then(() => true, () => false);
  let launched: T;
  try { launched = await start(); }
  catch (error) {
    // Refused when the handle is another attempt's: only a registration this attempt holds is closed.
    await record({ ...handle, launch, state: 'finished', outcome: `the launch failed before the session started: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }).catch(() => {});
    throw error;
  }
  const where = coordinates(launched);
  const pane = where?.pane ?? null, agentName = where?.agentName ?? null;
  if (!registered || pane || (agentName && agentName !== handle.agentName)) {
    // A registration that was refused or never written is taken over now: this attempt's runtime
    // started, so the launcher let it run and it is the session the record must describe. The
    // record it takes over may still be running under the same id as another session's (GY-1532:
    // a request relaunched while its earlier session's handle is held, unlisted, until the request
    // ends), so that record is closed as superseded first and this session registered afresh — a
    // reopened record carries none of the previous session's observation, which would otherwise
    // read this one's pane, listed before its agent starts, as an agent that exited.
    if (!registered) await record({ ...handle, launch, supersede: true, state: 'finished', outcome: `superseded: a later launch for ${handle.subject ?? handle.id} started its runtime, so this record describes the session before it` }).catch(() => {});
    const coordinated = { ...handle, launch, ...(registered ? {} : { supersede: true }), state: 'running' as const, ...(agentName ? { agentName } : {}), ...(pane ? { pane, ...(attach ? { attach: attach(pane) } : {}) } : {}) };
    for (let attempt = 1; attempt <= coordinateAttempts; attempt++) {
      if (await record(coordinated).then(() => true, () => false)) break;
      if (attempt < coordinateAttempts) await new Promise(done => setTimeout(done, coordinateRetryMs * attempt));
    }
  }
  return launched;
}
