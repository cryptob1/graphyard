import type { Criterion, Work } from './model.js';
import { broadScope, scopeBreadth } from './coordination.js';
import { pathScopeContains } from './model/scope.js';
import { isDelivered } from './model/closure.js';
import { decompositionPayloadSchema, type DecompositionPayload } from './runner/payloads.js';
import type { Run, RunResult, Runner } from './runner/types.js';

// ---------------------------------------------------------------------------
// Decomposition of broad work items before dispatch (GY-1126).
//
// In Graphyard many items are broad (many criteria, wide plannedFiles such as
// src/ tests/ docs/), produce large PRs, conflict with each other in the merge
// queue and get ejected, costing CI and review rounds.
//
// Before an item is first dispatched:
// (1) A decomposition step judges it against size bounds (criteria count,
//     planned-file breadth, estimated change size);
// (2) An item over the bounds is split by an agent session into child items,
//     each with its own criteria taken from the parent's, a narrow plannedFiles
//     list and dependencies between children where order matters; the parent's
//     criteria are covered by the union of its children's, never weakened;
// (3) The parent closes as done / is delivered when all its children are delivered;
// (4) An item within the bounds is dispatched as today;
// (5) The operator can opt an item out of splitting (split: false).
// ---------------------------------------------------------------------------

export const decompositionTool = 'graphyard_decompose';
export const decompositionRole = 'decomposition';

export interface DecompositionBounds {
  maxCriteria: number;
  maxPlannedFiles: number;
  maxBreadth: number;
  maxEstimatedChangeSize: number;
}

export const defaultSizeBounds: DecompositionBounds = {
  maxCriteria: 3,
  maxPlannedFiles: 3,
  maxBreadth: 0,
  maxEstimatedChangeSize: 300,
};

/**
 * Estimate change size from criteria count and planned-file breadth.
 */
export function estimateChangeSize(work: Pick<Work, 'criteria' | 'plannedFiles' | 'description'>): number {
  let size = 0;
  for (const _crit of work.criteria ?? []) size += 100;
  for (const file of work.plannedFiles ?? []) {
    if (broadScope(file)) size += 200;
    else size += 50;
  }
  return size;
}

/**
 * Whether a work item exceeds size bounds and needs decomposition.
 * An item opted out (split: false) is never over size bounds.
 * An item explicitly opted in (split: true) is always considered over size bounds.
 */
export function isOverSizeBounds(
  work: Pick<Work, 'criteria' | 'plannedFiles' | 'description'> & { split?: boolean },
  bounds: DecompositionBounds = defaultSizeBounds,
): boolean {
  if (work.split === false) return false;
  if (work.split === true) return true;
  if ((work.criteria?.length ?? 0) > bounds.maxCriteria) return true;
  const breadth = scopeBreadth(work.plannedFiles ?? []);
  if (breadth.broad.length > bounds.maxBreadth) return true;
  if ((work.plannedFiles?.length ?? 0) > bounds.maxPlannedFiles) return true;
  if (estimateChangeSize(work) > bounds.maxEstimatedChangeSize) return true;
  return false;
}

/**
 * Validates that child criteria together cover the parent's criteria exactly:
 * none dropped, none weakened, identical text and proofs.
 */
export function validateSplitCriteria(
  parent: Pick<Work, 'key' | 'criteria'>,
  children: { criteria: Criterion[] }[],
): void {
  const parentMap = new Map((parent.criteria ?? []).map(c => [c.id, c]));
  const seenIds = new Set<string>();

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child.criteria || child.criteria.length === 0) {
      throw new Error(`Child item ${i + 1} must have at least one criterion`);
    }
    for (const crit of child.criteria) {
      const parentCrit = parentMap.get(crit.id);
      if (!parentCrit) {
        throw new Error(`Child criterion ${crit.id} is not present in parent ${parent.key}`);
      }
      if (crit.text !== parentCrit.text) {
        throw new Error(`Criterion ${crit.id} text was modified or weakened: "${crit.text}" vs parent "${parentCrit.text}"`);
      }
      const childProofs = [...crit.proofs].sort();
      const parentProofs = [...parentCrit.proofs].sort();
      if (childProofs.length !== parentProofs.length || !childProofs.every((p, idx) => p === parentProofs[idx])) {
        throw new Error(`Criterion ${crit.id} proofs were modified or weakened`);
      }
      seenIds.add(crit.id);
    }
  }

  for (const parentCrit of parent.criteria ?? []) {
    if (!seenIds.has(parentCrit.id)) {
      throw new Error(`Parent criterion ${parentCrit.id} was dropped in split`);
    }
  }
}

/**
 * Validates that each child item has narrower plannedFiles than the parent,
 * and all child plannedFiles fall within the parent's planned scope.
 */
export function validateNarrowerPlannedFiles(
  parent: Pick<Work, 'plannedFiles'>,
  children: { plannedFiles: string[] }[],
): void {
  const parentBreadth = scopeBreadth(parent.plannedFiles ?? []);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child.plannedFiles || child.plannedFiles.length === 0) {
      throw new Error(`Child item ${i + 1} must specify plannedFiles`);
    }
    const childBreadth = scopeBreadth(child.plannedFiles);
    if (childBreadth.broad.length > parentBreadth.broad.length) {
      throw new Error(`Child item ${i + 1} plannedFiles has more broad scopes than parent`);
    }
    for (const childFile of child.plannedFiles) {
      const covered = (parent.plannedFiles ?? []).some(parentScope => pathScopeContains(parentScope, childFile));
      if (!covered && (parent.plannedFiles ?? []).length > 0) {
        throw new Error(`Child planned file ${childFile} is outside parent's plannedFiles scope`);
      }
    }
  }
}

/**
 * Splits a broad parent work item into small, independently mergeable child items.
 */
export function splitItem(
  parent: Work,
  payload: DecompositionPayload,
  keyGenerator: (index: number) => { id: string; key: string } = (index) => ({
    id: globalThis.crypto.randomUUID(),
    key: `${parent.key}.${index + 1}`,
  }),
): { parent: Work; children: Work[] } {
  if (parent.split === false) {
    throw new Error(`${parent.key} is opted out of splitting (split: false)`);
  }
  if (!isOverSizeBounds(parent)) {
    throw new Error(`${parent.key} is within size bounds and does not need splitting`);
  }
  validateSplitCriteria(parent, payload.children);
  validateNarrowerPlannedFiles(parent, payload.children);

  const generated = payload.children.map((_, i) => keyGenerator(i));
  const childItems: Work[] = payload.children.map((child, i) => {
    const { id, key } = generated[i];
    const deps: string[] = (child.dependencies ?? []).map(dep => {
      const depIndex = parseInt(dep, 10);
      if (!Number.isNaN(depIndex) && depIndex >= 0 && depIndex < generated.length) {
        return generated[depIndex].id;
      }
      const match = generated.find(g => g.key === dep || g.id === dep);
      if (match) return match.id;
      return dep;
    });

    return {
      id,
      key,
      title: child.title,
      description: child.description ?? '',
      type: parent.type,
      priority: parent.priority,
      dependencies: deps,
      criteria: child.criteria.map(c => ({ ...c, proofs: [...c.proofs] })),
      policy: { ...parent.policy, checks: [...(parent.policy?.checks ?? [])] },
      plannedFiles: [...child.plannedFiles],
      stage: 'ready',
      ready: true,
      revision: 1,
      policyRevision: parent.policyRevision,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stageEnteredAt: new Date().toISOString(),
      epoch: 0,
      lease: null,
      workspaces: [],
      candidate: null,
      submission: null,
      reworkRequested: false,
      scenarioRequirements: [],
      evidence: [],
      observation: null,
      blocker: null,
      gates: [],
      violations: [],
      parent: parent.key,
      split: false,
      systemDriven: parent.systemDriven,
    } as unknown as Work;
  });

  parent.children = childItems.map(c => c.key);
  parent.updatedAt = new Date().toISOString();
  return { parent, children: childItems };
}

/**
 * Reconciles parent delivery status:
 * The parent is delivered when all its children are delivered.
 * When delivered, parent.stage becomes 'done' and parent.delivery is set.
 */
export function reconcileParentDelivery(
  parent: Work,
  all: readonly Work[],
  now = new Date(),
): boolean {
  if (!parent.children || parent.children.length === 0 || isDelivered(parent)) {
    return false;
  }
  const childItems = parent.children.map(key => all.find(w => w.key === key || w.id === key));
  const allDelivered = childItems.length === parent.children.length && childItems.every(c => c && isDelivered(c));
  if (!allDelivered) return false;

  parent.stage = 'done';
  delete parent.closure;
  const lastChildWithDelivery = childItems
    .filter((c): c is Work => !!c?.delivery)
    .sort((a, b) => (b.delivery!.mergedAt ?? '').localeCompare(a.delivery!.mergedAt ?? ''))[0];

  parent.delivery = lastChildWithDelivery?.delivery
    ? { ...lastChildWithDelivery.delivery }
    : { mergedAt: now.toISOString(), mergeSha: 'child-deliveries', authorizationRevision: 1 };

  if (parent.gates) {
    for (const gate of parent.gates) {
      gate.passed = true;
      gate.reasons = [];
    }
  }
  parent.updatedAt = now.toISOString();
  return true;
}

/** The prompt sent to the decomposition agent session. */
export function decompositionPrompt(
  config: { repository: string },
  work: Work,
  bounds: DecompositionBounds = defaultSizeBounds,
): string {
  return `You are the Graphyard task decomposition agent for ${config.repository}. `
    + `The work item ${work.key}: "${work.title}" exceeds size bounds and needs to be decomposed before dispatch. `
    + `Its description: ${work.description || 'none'}. `
    + `Its criteria: ${JSON.stringify(work.criteria)}. `
    + `Its plannedFiles: ${JSON.stringify(work.plannedFiles)}. `
    + `Decompose this broad item into 2 to 10 small, independently mergeable child items. `
    + `Rules: `
    + `1. Every criterion in the parent must appear in at least one child item, with exact same ID, text, and proofs (never weakened or dropped). `
    + `2. Each child item must have narrower plannedFiles (specific file paths, not repository roots). `
    + `3. Specify dependencies between child items where order matters. `
    + `Call ${decompositionTool} with children and reason, then stop.`;
}

export interface DecompositionStepAction {
  work: string;
  state: 'started' | 'done' | 'failed';
  detail: string;
}

interface LiveDecomposition {
  run: Run<DecompositionPayload>;
  settled: Promise<void>;
}

const live = new Map<string, LiveDecomposition>();

export function clearDecompositionRuns() {
  for (const entry of live.values()) entry.run.cancel('runs cleared');
  live.clear();
}

export async function decompositionSettled() {
  await Promise.all([...live.values()].map(entry => entry.settled));
}

export interface DecompositionStepInput {
  work: readonly Work[];
  clock: number;
  config: { repository: string };
  cwd: string;
  runner: Runner;
  bounds?: DecompositionBounds;
  record: (parent: Work, children: Work[]) => Promise<unknown>;
}

/**
 * Checks open work items before dispatch. Any item over size bounds that has not yet
 * been dispatched and has not yet been split is split by an agent session.
 */
export function decompositionStep(input: DecompositionStepInput): DecompositionStepAction[] {
  const actions: DecompositionStepAction[] = [];
  const bounds = input.bounds ?? defaultSizeBounds;

  const candidates = input.work.filter(item =>
    !item.children?.length &&
    item.epoch === 0 &&
    !item.lease &&
    (!item.implementers || item.implementers.length === 0) &&
    !live.has(item.id) &&
    isOverSizeBounds(item, bounds)
  );

  for (const work of candidates) {
    const run = input.runner.start(decompositionPrompt(input.config, work, bounds), {
      cwd: input.cwd,
      env: { GRAPHYARD_PI_ROLE: decompositionRole },
      tool: decompositionTool,
      timeoutMs: 10 * 60_000,
      validate: payload => decompositionPayloadSchema.parse(payload),
    });

    const settled = run.result().then(async result => {
      if (!result.ok) return;
      const splitResult = splitItem(work, result.payload);
      await input.record(splitResult.parent, splitResult.children);
    }).finally(() => {
      if (live.get(work.id)?.run === run) live.delete(work.id);
    });

    live.set(work.id, { run, settled });
    actions.push({
      work: work.key,
      state: 'started',
      detail: `Splitting broad item ${work.key} over size bounds into small child items`,
    });
  }

  return actions;
}
