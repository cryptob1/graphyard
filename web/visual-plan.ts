// Concern: the goal picture page's flowchart data (GY-2011) — dependency order, Todo/Doing/
// Checking/Done colours, and SVG box positions drawn from the plan alone; no chart library.
// Kept free of src/model/goal-plan (and its e2e/case Node imports) so the dashboard bundle stays browser-safe.

export type PlanState = 'Todo' | 'Doing' | 'Checking' | 'Done';
export const planStateColor: Record<PlanState, string> = {
  Todo: '#64748b',
  Doing: '#2563eb',
  Checking: '#d97706',
  Done: '#15803d',
};

export interface PlanFlowItem {
  ref: string;
  plain: string;
  dependsOn: string[];
}

/** Map a work item's stage (or absence) to the flowchart's four states. */
export function planItemState(stage: string | null | undefined): PlanState {
  if (stage === 'done') return 'Done';
  if (stage === 'review' || stage === 'test' || stage === 'acceptance' || stage === 'merge') return 'Checking';
  if (stage === 'build') return 'Doing';
  return 'Todo';
}

export interface FlowBox {
  ref: string;
  plain: string;
  key?: string;
  id?: string;
  state: PlanState;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowArrow { from: string; to: string; x1: number; y1: number; x2: number; y2: number }

export interface Flowchart {
  boxes: FlowBox[];
  arrows: FlowArrow[];
  width: number;
  height: number;
  order: string[];
}

const boxWidth = 220, boxHeight = 72, gapY = 36, padX = 32, padY = 24;

/** Items in dependency order: each after every item it depends on. Throws on a cycle. */
export function flowOrder(items: readonly PlanFlowItem[]): PlanFlowItem[] {
  const ordered: PlanFlowItem[] = [], placed = new Set<string>();
  while (ordered.length < items.length) {
    const next = items.find(item => !placed.has(item.ref) && item.dependsOn.every(ref => placed.has(ref)));
    if (!next) throw new Error(`the plan's items ${items.filter(item => !placed.has(item.ref)).map(item => item.ref).join(', ')} depend on each other in a cycle`);
    ordered.push(next); placed.add(next.ref);
  }
  return ordered;
}

/**
 * Lay the plan out as a vertical SVG flowchart: one box per item in dependency order, one arrow
 * per dependsOn edge from the dependency's bottom to the dependent's top.
 */
export function planFlowchart(
  items: readonly PlanFlowItem[],
  workByRef: ReadonlyMap<string, { id?: string; key?: string; stage?: string }> = new Map(),
): Flowchart {
  const ordered = flowOrder(items);
  const boxes: FlowBox[] = ordered.map((item, index) => {
    const work = workByRef.get(item.ref);
    return {
      ref: item.ref, plain: item.plain, key: work?.key, id: work?.id, state: planItemState(work?.stage),
      x: padX, y: padY + index * (boxHeight + gapY), width: boxWidth, height: boxHeight,
    };
  });
  const byRef = new Map(boxes.map(box => [box.ref, box]));
  const arrows: FlowArrow[] = [];
  for (const item of ordered) for (const dep of item.dependsOn) {
    const from = byRef.get(dep), to = byRef.get(item.ref);
    if (!from || !to) continue;
    arrows.push({ from: dep, to: item.ref, x1: from.x + from.width / 2, y1: from.y + from.height, x2: to.x + to.width / 2, y2: to.y });
  }
  return {
    boxes, arrows, order: ordered.map(item => item.ref),
    width: padX * 2 + boxWidth,
    height: padY * 2 + ordered.length * boxHeight + Math.max(0, ordered.length - 1) * gapY,
  };
}
