import { stepIds, type StepId } from './pr-steps';

/**
 * The Insights Flow replay (GY-161), built only from recorded history. The control plane records
 * a durable `stage.changed` fact every time an item's evaluated stage changes (src/flow-analytics.ts
 * `deriveFacts`), and the stage-dwell drill-down returns one row per such change: the item, the
 * instant, and "from to to". Each row becomes one step transition here, each transition one frame
 * of the replay, and nothing is interpolated or invented: a dot only ever stands where a recorded
 * transition put it. A move back to Build from a later step is rework, drawn in the Blocked colour.
 */

/** The step each evaluated stage stands for; backlog and ready are outside the flow. */
export const stageStep: Record<string, StepId | null> = { backlog: null, ready: null, build: 'build', review: 'review', test: 'test', acceptance: 'prove', merge: 'merge', done: 'deploy' };
/** The replay's length: the last 24 hours played back in this many seconds. */
export const replaySeconds = 20;
export const replayWindowMs = 24 * 60 * 60 * 1000;

export interface StepTransition { key: string; from: StepId | null; to: StepId | null; at: string }
export interface ReplayFrame {
  key: string; step: StepId | null; rework: boolean;
  /** When it happened, and where that falls in the replay, from 0 (24 hours ago) to 1 (now). */
  at: number; t: number;
  /** The recorded transition this frame plays. */
  source: StepTransition;
}

const index = (step: StepId | null) => step ? stepIds.indexOf(step) : -1;

/** Step transitions from the stage-dwell drill-down's rows ({ workKey, observedAt, detail: "review to test" }). */
export function transitionsFromRows(rows: readonly { workKey: string; observedAt: string | null; detail: string }[]): StepTransition[] {
  return rows.flatMap(row => {
    const match = /^(\S+) to (\S+)$/.exec(row.detail);
    if (!match || !row.observedAt) return [];
    const from = stageStep[match[1]] ?? null, to = stageStep[match[2]] ?? null;
    return from === to ? [] : [{ key: row.workKey, from, to, at: row.observedAt }];
  });
}

/** Every recorded transition of the last `windowMs` before `now`, in order, as a replay frame. */
export function replayFrames(transitions: readonly StepTransition[], now: number, windowMs = replayWindowMs): ReplayFrame[] {
  const start = now - windowMs;
  return transitions.map(source => ({ source, at: Date.parse(source.at) }))
    .filter(({ at }) => Number.isFinite(at) && at > start && at <= now)
    .sort((a, b) => a.at - b.at || a.source.key.localeCompare(b.source.key))
    .map(({ source, at }) => ({ key: source.key, step: source.to, at, t: (at - start) / windowMs, source,
      rework: source.to === 'build' && index(source.from) > index('build') }));
}

/**
 * Where each item's dot stands at replay position `t`: the step of its latest frame at or before
 * `t`, and whether that frame was a return to Build. An item with no frame yet has no dot, and one
 * whose latest frame left the flow (back to backlog) has none either.
 */
export function positionsAt(frames: readonly ReplayFrame[], t: number): Map<string, { step: StepId; rework: boolean }> {
  const positions = new Map<string, { step: StepId; rework: boolean }>();
  for (const frame of frames) {
    if (frame.t > t) break;
    if (frame.step) positions.set(frame.key, { step: frame.step, rework: frame.rework });
    else positions.delete(frame.key);
  }
  return positions;
}
