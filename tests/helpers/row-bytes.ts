/**
 * The bytes of every row in a pg result (or a multi-statement result's array of them). A hot path's
 * cost judged in rows the database returned is the same on an idle or a loaded runner, where its
 * wall-clock time against another read's is not (GY-3546).
 */
export function rowBytes(result: unknown): number {
  let bytes = 0;
  for (const each of [result].flat() as Array<{ rows?: unknown[] } | undefined>) for (const row of each?.rows ?? []) bytes += JSON.stringify(row).length;
  return bytes;
}
