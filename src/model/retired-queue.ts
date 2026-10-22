/**
 * The fields of Graphyard's own merge queue (removed in GY-1236; GitHub merges each passing
 * candidate itself). A document stored before then may still carry them: it loads as ever, and
 * every write drops them (`dropRetiredQueueFields`), so no item document is written with them.
 */
export const retiredQueueFields = ['queue', 'queueSequence', 'queueEjection', 'queueHistory'] as const;
export function dropRetiredQueueFields<T extends object>(work: T): T {
  for (const field of retiredQueueFields) if (field in work) delete (work as Record<string, unknown>)[field];
  return work;
}

/**
 * The fields of the retired scope-request machinery and the planned-file list (GY-1992), and of the
 * retired escalations and containment quarantine (GY-2874): a document stored before then may still
 * carry them. It loads as ever, and every evaluation and write drops them, with a standing
 * scope-refusal blocker, which nothing can answer any more.
 */
export const retiredScopeFields = ['plannedFiles', 'scopeRequest', 'carriedScopeRequest', 'scopeDecision', 'scopeWithdrawn', 'heldGroundings', 'escalation', 'escalations', 'containmentQuarantine'] as const;
export function dropRetiredScopeFields<T extends { blocker?: string | null }>(work: T): T {
  for (const field of retiredScopeFields) if (field in work) delete (work as Record<string, unknown>)[field];
  if (work.blocker?.startsWith('Scope request refused')) work.blocker = null;
  return work;
}
