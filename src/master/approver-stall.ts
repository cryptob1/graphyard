// Concern: whether a same-named approver session Herdr still lists never ran its request (GY-1598), judged alike by `master approver`, the loop and master status.
import { setTimeout as sleep } from 'node:timers/promises';
import type { HerdrAgent } from './herdr.js';

/** How an `idle` session's screen behaved across a pause: Herdr reports a long command as idle while its output and timer move. */
export type ScreenMotion = 'still' | 'moving' | 'unreadable';
/** How long the launcher, the loop and master status watch an idle session's screen before calling it still. */
export const idleScreenPauseMs = 2_000;

/** Read a session's screen twice across `pauseMs`: `still` only when both reads succeed and match. */
export async function screenMotion(read: () => string | null | Promise<string | null>, pauseMs = idleScreenPauseMs): Promise<ScreenMotion> {
  const once = () => Promise.resolve().then(read).catch(() => null);
  const first = await once();
  if (first === null) return 'unreadable';
  if (pauseMs > 0) await sleep(pauseMs);
  const second = await once();
  return second === null ? 'unreadable' : first === second ? 'still' : 'moving';
}
export const idleScreenWhy = (motion: Exclude<ScreenMotion, 'still'>) => `it is idle with a screen that ${motion === 'moving' ? 'is still changing, as while a long command runs' : 'Herdr could not read'}`;

/**
 * GY-1598. Whether a same-named approver in Herdr never ran its request, judged alike by the launcher, the loop and master status:
 * `done`, or `idle` with a still screen, past its start bound by its launch record. An idle session judged without a `screen` reading
 * is judged by status and age alone; a caller that will close it reads the screen first (`judgeApproverStall`).
 */
export function approverStallVerdict(agent: Pick<HerdrAgent, 'agent_status' | 'pane_id'>, launchedAt: string | null | undefined, bound: number, now: number, screen?: ScreenMotion) {
  const status = agent.agent_status ?? 'unknown', at = Date.parse(launchedAt ?? ''), keep = (why: string) => ({ close: false as const, why });
  if (status !== 'idle' && status !== 'done') return keep(status === 'blocked' ? 'it is blocked at a tool call or question, so it ran its request' : `it is ${status}`);
  if (status === 'idle' && screen && screen !== 'still') return keep(idleScreenWhy(screen));
  if (!agent.pane_id || !Number.isFinite(at)) return keep(agent.pane_id ? 'it has no launch record, so its age is unknown' : 'Herdr lists no pane for it');
  if (now - at < bound) return keep(`it is within its ${bound / 1000}s start bound until ${new Date(at + bound).toISOString()}`);
  return { close: true as const, why: `${status} in Herdr ${Math.round((now - at) / 1000)}s after its launch, past the ${bound / 1000}s start bound without running its request${status === 'idle' && screen === 'still' ? ', its screen still' : ''}` };
}
/** The verdict a caller about to close (or name the close of) a session acts on: an idle one's screen is read only once status and age allow it. */
export async function judgeApproverStall(agent: Pick<HerdrAgent, 'agent_status' | 'pane_id'>, launchedAt: string | null | undefined, bound: number, now: number,
  read: (() => string | null | Promise<string | null>) | null, pauseMs = idleScreenPauseMs) {
  const verdict = approverStallVerdict(agent, launchedAt, bound, now);
  if (agent.agent_status !== 'idle' || (!verdict.close && !verdict.why.startsWith('it has no launch record'))) return verdict;
  return approverStallVerdict(agent, launchedAt, bound, now, read ? await screenMotion(read, pauseMs) : 'unreadable');
}
