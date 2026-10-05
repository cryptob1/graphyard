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
