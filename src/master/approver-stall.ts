// Concern: whether a same-named approver session Herdr still lists never ran its request (GY-1598), judged alike by `master approver`, the loop and master status.
import { setTimeout as sleep } from 'node:timers/promises';
import type { HerdrAgent } from './herdr.js';

/**
 * How an `idle` session's screen behaved across a pause. Herdr reports a long command as idle while its output and timer move, and a
 * silent one (a tool waiting on the network, output buffered) as idle on a screen that does not move at all, so stillness alone proves
 * nothing: `still` is a screen that stayed the same and holds no trace of its request (`untouchedScreen`); `started` one that stayed
 * the same but shows the request ran.
 */
export type ScreenMotion = 'still' | 'started' | 'moving' | 'unreadable';
/** How long the launcher, the loop and master status watch an idle session's screen before calling it still. */
export const idleScreenPauseMs = 2_000;
/** How many lines of an idle session's screen are read: enough that one which ran its request still shows it, or a screen full of its work. */
export const stallScreenLines = 400;
/** The most non-blank lines a runtime that never ran its request shows: its banner, the launch command it was started by, an empty prompt. */
export const untouchedLineLimit = 40;
/**
 * Whether a screen holds no trace of the request a session was launched with: the decision it judges, named in its request and in every
 * command it runs for it, appears nowhere, and the screen is no fuller than a runtime's start. A session that ran its request shows it
 * as its first message, or has filled the screen with its work since.
 */
export const untouchedScreen = (text: string, marker: string) => !text.includes(marker) && text.split('\n').filter(line => line.trim()).length <= untouchedLineLimit;

/** Read a session's screen twice across `pauseMs`: `still` only when both reads succeed, match, and show no trace of `marker`'s request. */
export async function screenMotion(read: () => string | null | Promise<string | null>, marker: string, pauseMs = idleScreenPauseMs): Promise<ScreenMotion> {
  const once = () => Promise.resolve().then(read).catch(() => null);
  const first = await once();
  if (first === null) return 'unreadable';
  if (pauseMs > 0) await sleep(pauseMs);
  const second = await once();
  return second === null ? 'unreadable' : first !== second ? 'moving' : untouchedScreen(second, marker) ? 'still' : 'started';
}
export const idleScreenWhy = (motion: Exclude<ScreenMotion, 'still'>) => `it is idle with a screen that ${motion === 'moving' ? 'is still changing, as while a long command runs'
  : motion === 'started' ? 'shows its request ran, as while a silent command waits' : 'Herdr could not read'}`;

/**
 * The launch record that dates a listed session (GY-1598): the latest for its name, and only when it names the pane Herdr lists it in.
 * A record of an earlier session under the same name (one whose successor's record could not be written) dates nothing, so its age is unknown.
 */
export function boundLaunch<T extends { agentName: string; launchedAt: string; pane?: string | null }>(records: readonly T[], agent: Pick<HerdrAgent, 'name' | 'pane_id'>): T | undefined {
  const record = records.findLast(entry => entry.agentName === agent.name);
  return record && agent.pane_id && record.pane === agent.pane_id ? record : undefined;
}

/**
 * GY-1598. Whether a same-named approver in Herdr never ran its request, judged alike by the launcher, the loop and master status:
 * `done`, or `idle` with a still, untouched screen, past its start bound by the launch record bound to its pane. An idle session judged
 * without a `screen` reading is judged by status and age alone; a caller that will close it reads the screen first (`judgeApproverStall`).
 */
export function approverStallVerdict(agent: Pick<HerdrAgent, 'agent_status' | 'pane_id'>, launchedAt: string | null | undefined, bound: number, now: number, screen?: ScreenMotion) {
  const status = agent.agent_status ?? 'unknown', at = Date.parse(launchedAt ?? ''), keep = (why: string) => ({ close: false as const, why });
  if (status !== 'idle' && status !== 'done') return keep(status === 'blocked' ? 'it is blocked at a tool call or question, so it ran its request' : `it is ${status}`);
  if (status === 'idle' && screen && screen !== 'still') return keep(idleScreenWhy(screen));
  if (!agent.pane_id || !Number.isFinite(at)) return keep(agent.pane_id ? 'it has no launch record bound to its pane, so its age is unknown' : 'Herdr lists no pane for it');
  if (now - at < bound) return keep(`it is within its ${bound / 1000}s start bound until ${new Date(at + bound).toISOString()}`);
  return { close: true as const, why: `${status} in Herdr ${Math.round((now - at) / 1000)}s after its launch, past the ${bound / 1000}s start bound without running its request${status === 'idle' && screen === 'still' ? ', its screen still and showing no trace of it' : ''}` };
}
/** The verdict a caller about to close (or name the close of) a session acts on: an idle one's screen is read only once status and age allow it. */
export async function judgeApproverStall(agent: Pick<HerdrAgent, 'agent_status' | 'pane_id'>, launchedAt: string | null | undefined, bound: number, now: number,
  read: (() => string | null | Promise<string | null>) | null, marker: string, pauseMs = idleScreenPauseMs) {
  const verdict = approverStallVerdict(agent, launchedAt, bound, now);
  if (agent.agent_status !== 'idle' || (!verdict.close && !verdict.why.startsWith('it has no launch record'))) return verdict;
  return approverStallVerdict(agent, launchedAt, bound, now, read ? await screenMotion(read, marker, pauseMs) : 'unreadable');
}
