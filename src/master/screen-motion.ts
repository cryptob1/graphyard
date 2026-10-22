// Concern: whether a session Herdr reports idle or done ever ran its request, read from its own screen (GY-1598, GY-1705).
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * How a session's screen behaved across a pause. Herdr reports a long command as idle while its output and timer move, and a
 * silent one as idle on a screen that does not move at all, so stillness alone proves nothing: `still` is a screen that stayed
 * the same and holds no trace of its request (`untouchedScreen`); `started` one that stayed the same but shows the request ran.
 */
export type ScreenMotion = 'still' | 'started' | 'moving' | 'unreadable';
/** How long the loop watches a session's screen before calling it still. */
export const idleScreenPauseMs = 2_000;
/** How many lines of a session's screen are read: enough that one which ran its request still shows it, or a screen full of its work. */
export const stallScreenLines = 400;
/** The most non-blank lines a runtime that never ran its request shows: its banner, the launch command it was started by, an empty prompt. */
export const untouchedLineLimit = 40;
/** Whether a screen holds no trace of the request a session was launched with, and is no fuller than a runtime's start. */
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
