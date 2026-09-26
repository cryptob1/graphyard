/**
 * JSON with recursively sorted object keys and `undefined` members dropped (as JSON.stringify
 * drops them), for deciding whether a record changed. Postgres jsonb returns keys in its own
 * order, so a record rebuilt with the same content in another key order compared unequal under
 * plain JSON.stringify: on 2026-09-25 the reconcile tick re-saved unchanged merge-queue entries
 * every few seconds (revision +1 each), which discarded every GitHub observation taken meanwhile
 * and deadlocked the merge queue.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => entry === undefined ? 'null' : stableJson(entry)).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined && typeof record[key] !== 'function').sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
