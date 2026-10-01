import { useEffect, useState, type RefObject } from 'react';
import { transitionsFromRows, type StepTransition } from './flow-replay';

/**
 * Whether a session's role may read the flow analytics routes (`analytics/flow*`): an operator
 * agent's scoped API refuses them (src/server/auth.ts `operatorAgentRouteGuard`), so its sessions
 * are neither offered the pages that read them nor polled for step moves.
 */
export const readsFlowAnalytics = (role: string | undefined) => role !== 'operator-agent';

/** The most pages one read follows; a board past that is read as incomplete, never as all of it. */
export const stepPagesLimit = 20;
type StepRow = { workKey: string; observedAt: string | null; detail: string };

/**
 * Every recorded step move of the last week (since `since`, when given): the steps drill-down,
 * followed page by page. Each page holds whole items and names the next (`next`); an item whose
 * history alone is longer than a page is continued within it (`within:<key>:<rows read>`), so no
 * item's history is cut at the page bound. `complete` is false when the pages ran out before the
 * answer did, and the rows then cover only the items read in full: an item the read stopped inside
 * is left out whole, never taken as its whole history.
 */
export async function readStepRows(api: (path: string) => Promise<any>, since?: string | null): Promise<{ rows: StepRow[]; complete: boolean }> {
  const rows: StepRow[] = [];
  let key: string | null = since ?? null;
  const partial = () => {
    const inside = /(?:^|\s)within:(.+):\d+$/.exec(key ?? '')?.[1];
    return { rows: inside ? rows.filter(row => row.workKey !== inside) : rows, complete: false };
  };
  for (let page = 0; page < stepPagesLimit; page++) {
    const answer = await api(`analytics/flow/drilldown?window=7&metric=steps${key ? `&key=${encodeURIComponent(key)}` : ''}`);
    rows.push(...(Array.isArray(answer?.rows) ? answer.rows : []));
    if (!answer?.truncated) return { rows, complete: true };
    if (typeof answer.next !== 'string' || answer.next === key) return partial();
    key = answer.next;
  }
  return partial();
}

/**
 * The recorded step moves that start each row's "In step" clock (src/model/pr-steps.ts `stepSince`):
 * the steps drill-down, the same moves the Insights replay plays, read in full (`readStepRows`).
 * They change only when an item changes step, so a read a minute is enough; until one answers, or
 * if it fails, each clock falls back to the item's own record. An item the read did not reach
 * has no moves here, so its clock falls back the same way rather than reading a partial history.
 * Null while signed out or before the first answer.
 */
export function useStepMoves(signedIn: boolean, token: string, api: (path: string) => Promise<any>, sessionEpoch: RefObject<number>): StepTransition[] | null {
  const [moves, setMoves] = useState<StepTransition[] | null>(null);
  useEffect(() => {
    setMoves(null);
    if (!signedIn) return;
    let active = true; const epoch = sessionEpoch.current;
    const load = () => readStepRows(api)
      .then(({ rows }) => { if (active && epoch === sessionEpoch.current) setMoves(transitionsFromRows(rows)); })
      .catch(() => {});
    void load(); const timer = setInterval(load, 60000);
    return () => { active = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, token]);
  return moves;
}
