import type { Work } from './work.js';
import type { QueueCarry } from './carry.js';

/**
 * The violation an observed, unauthorized merge records when a two-party reconciliation of it was
 * refused; the engine writes it as `<prefix><decision id> refused: <reasons>`, and master status
 * reads it (GY-94).
 */
export const reconciliationRefusalPrefix = 'Reconciliation by decision ';
/**
 * GY-831. The guarded merge's refusal the loop reported for one candidate, kept on documents from
 * before the control plane became the merge writer: `rereview` cleared the carried approval so the
 * review gate asks for a fresh review of the tip; `rework` asks the approver for the rework decision.
 */
export interface MergeRefusal {
  sha: string; baseSha: string; policyRevision: number; reason: string; since: string; at: string; by: string; action: 'rereview' | 'rework';
  approval?: { reviewer: string; reviewId?: number; originalSha: string }; carry?: QueueCarry | null;
}
/**
 * Whether the merge writer may merge the item right now: every gate passes for its current
 * candidate and nothing stands against it. Every passing gate is the authorization; no separate
 * authorization, execution or observation age is consulted.
 */
export function mergeAuthorized(work: Work): boolean {
  return work.stage === 'merge' && !!work.candidate && !work.observation?.merged
    && work.gates.every(gate => gate.passed) && !work.violations.length && !work.leadHold;
}
