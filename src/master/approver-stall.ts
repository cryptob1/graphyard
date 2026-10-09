// Concern: whether a same-named approver session Herdr still lists never ran its request (GY-1598), judged alike by `master approver`, the loop and master status.
import type { HerdrAgent } from './herdr.js';

/** GY-1598. Whether a same-named approver in Herdr never ran its request, judged alike by the launcher and master status: `idle` or `done` past its start bound by its launch record. */
export function approverStallVerdict(agent: Pick<HerdrAgent, 'agent_status' | 'pane_id'>, launchedAt: string | null | undefined, bound: number, now: number) {
  const status = agent.agent_status ?? 'unknown', at = Date.parse(launchedAt ?? ''), keep = (why: string) => ({ close: false as const, why });
  if (status !== 'idle' && status !== 'done') return keep(status === 'blocked' ? 'it is blocked at a tool call or question, so it ran its request' : `it is ${status}`);
  if (!agent.pane_id || !Number.isFinite(at)) return keep(agent.pane_id ? 'it has no launch record, so its age is unknown' : 'Herdr lists no pane for it');
  if (now - at < bound) return keep(`it is within its ${bound / 1000}s start bound until ${new Date(at + bound).toISOString()}`);
  return { close: true as const, why: `${status} in Herdr ${Math.round((now - at) / 1000)}s after its launch, past the ${bound / 1000}s start bound without running its request` };
}
