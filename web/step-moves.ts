import { useEffect, useState, type RefObject } from 'react';
import { transitionsFromRows, type StepTransition } from './flow-replay';

/**
 * The recorded step moves that start each row's "In step" clock (web/pr-steps.ts `stepSince`):
 * the steps drill-down, the same moves the Insights replay plays. They change only when an item
 * changes step, so a read a minute is enough; until one answers, or if it fails, each clock falls
 * back to the item's own record. Null while signed out or before the first answer.
 */
export function useStepMoves(signedIn: boolean, token: string, api: (path: string) => Promise<any>, sessionEpoch: RefObject<number>): StepTransition[] | null {
  const [moves, setMoves] = useState<StepTransition[] | null>(null);
  useEffect(() => {
    setMoves(null);
    if (!signedIn) return;
    let active = true; const epoch = sessionEpoch.current;
    const load = () => api('analytics/flow/drilldown?window=7&metric=steps')
      .then(rows => { if (active && epoch === sessionEpoch.current) setMoves(transitionsFromRows(Array.isArray(rows?.rows) ? rows.rows : [])); })
      .catch(() => {});
    void load(); const timer = setInterval(load, 60000);
    return () => { active = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, token]);
  return moves;
}
