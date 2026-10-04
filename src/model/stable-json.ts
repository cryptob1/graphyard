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

/**
 * Whether `value` now differs, as `stableJson` would judge it, from `before` — its plain
 * `JSON.stringify` taken earlier. Equal text is unchanged; otherwise the two are compared parsed,
 * with keys in any order, stopping at the first difference. The reconciliation pass judges every
 * open item this way under the coordination lock, where two `stableJson` calls (sorting every key
 * of a ~45 KB document) were a fifth of its hold (GY-1027).
 */
export function jsonChanged(before: string, value: unknown) {
  const after = JSON.stringify(value);
  return after !== before && !jsonEqual(JSON.parse(before), JSON.parse(after));
}
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((entry, index) => jsonEqual(entry, (b as unknown[])[index]));
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}
