import type pg from 'pg';

/**
 * The GitHub adapter's response caches, persisted so a restart starts warm (github_cache,
 * src/store/tables/github-cache.ts). Every deploy used to empty them, and the first minutes
 * after each restart spent ~400 billable requests a minute re-reading answers that had not
 * changed. The in-memory maps in src/github.ts stay the hot layer; this is the cold one.
 *
 * - Immutable answers (ancestry of a SHA pair, a blob at a SHA, a history between two SHAs) are
 *   loaded once and never expire. ETag entries are loaded with their ETag and still revalidated
 *   with If-None-Match, which GitHub answers with a free 304.
 * - Reads happen once, at attach; writes are batched write-behind on a timer, one pool query at
 *   a time, so the cache never holds more than one of the pool's connections. Plain pool queries
 *   only: never inside a coordination transaction and never under the advisory lock.
 * - The table is pruned to the newest `maxRows` rows and `maxBytes` of values.
 * - A database failure never fails an observation: the maps stay as they are and the adapter
 *   asks GitHub, exactly as it did before the cache was persisted.
 */
export type GitHubCacheKind = 'etag' | 'ancestry' | 'blob' | 'history';
export interface GitHubCacheMaps {
  etag: Map<string, { etag: string; value: any }>;
  ancestry: Map<string, boolean>;
  blob: Map<string, string | null>;
  history: Map<string, Set<string> | null>;
}
export interface GitHubCacheOptions { flushMs?: number; pruneMs?: number; maxRows?: number; maxBytes?: number; maxValueBytes?: number; maxPending?: number }
type Pending = { kind: GitHubCacheKind; etag: string | null; value: string } | 'touch';

export class GitHubCacheStore {
  readonly flushMs: number; readonly pruneMs: number; readonly maxRows: number; readonly maxBytes: number; readonly maxValueBytes: number; readonly maxPending: number;
  private pending = new Map<string, Pending>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private prunedAt = 0;
  private reportedAt = 0;
  /** `scope` separates installations that share one database; the adapter passes its installation id. */
  constructor(private pool: Pick<pg.Pool, 'query'>, private scope = '', options: GitHubCacheOptions = {}) {
    this.flushMs = options.flushMs ?? 5_000; this.pruneMs = options.pruneMs ?? 10 * 60_000;
    this.maxRows = options.maxRows ?? 20_000; this.maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
    this.maxValueBytes = options.maxValueBytes ?? 1024 * 1024; this.maxPending = options.maxPending ?? 10_000;
  }
  private key(kind: GitHubCacheKind, key: string) { return `${this.scope}:${kind}:${key}`; }
  private report(what: string, error: unknown) {
    if (Date.now() - this.reportedAt < 60_000) return;
    this.reportedAt = Date.now();
    console.error(`GitHub cache ${what} failed; requests fall back to GitHub: ${error instanceof Error ? error.message : String(error)}`);
  }
  /** Fill the maps from the table, newest last so each map's insertion order stays its recency order. Never throws. */
  async load(maps: GitHubCacheMaps, caps: Record<GitHubCacheKind, number>): Promise<number> {
    try {
      const prefix = `${this.scope.replace(/[\\%_]/g, '\\$&')}:%`;
      const rows = (await this.pool.query(`SELECT key, kind, etag, value FROM (
  SELECT key, kind, etag, value, updated_at, row_number() OVER (PARTITION BY kind ORDER BY updated_at DESC, key) AS n FROM github_cache WHERE key LIKE $1
) t WHERE n <= CASE kind WHEN 'etag' THEN $2::int WHEN 'ancestry' THEN $3::int WHEN 'blob' THEN $4::int WHEN 'history' THEN $5::int ELSE 0 END
ORDER BY updated_at, key`, [prefix, caps.etag, caps.ancestry, caps.blob, caps.history])).rows;
      let loaded = 0;
      for (const row of rows) {
        const kind = row.kind as GitHubCacheKind;
        const key = String(row.key).slice(this.scope.length + kind.length + 2);
        if (kind === 'etag' && typeof row.etag === 'string' && !maps.etag.has(key)) maps.etag.set(key, { etag: row.etag, value: row.value });
        else if (kind === 'ancestry' && typeof row.value === 'boolean' && !maps.ancestry.has(key)) maps.ancestry.set(key, row.value);
        else if (kind === 'blob' && (typeof row.value === 'string' || row.value === null) && !maps.blob.has(key)) maps.blob.set(key, row.value);
        else if (kind === 'history' && (Array.isArray(row.value) || row.value === null) && !maps.history.has(key)) maps.history.set(key, row.value ? new Set(row.value.map(String)) : null);
        else continue;
        loaded++;
      }
      for (const kind of Object.keys(caps) as GitHubCacheKind[]) {
        const map = maps[kind] as Map<string, unknown>;
        while (map.size > caps[kind]) map.delete(map.keys().next().value!);
      }
      return loaded;
    } catch (error) { this.report('load', error); return 0; }
  }
  /** Queue an entry for the next write-behind batch. */
  put(kind: GitHubCacheKind, key: string, value: unknown, etag: string | null = null) {
    let json: string;
    try { json = JSON.stringify(value instanceof Set ? [...value] : value ?? null); } catch { return; }
    if (json.length > this.maxValueBytes) return;
    const id = this.key(kind, key);
    if (!this.pending.has(id) && this.pending.size >= this.maxPending) return;
    this.pending.set(id, { kind, etag, value: json });
    this.schedule();
  }
  /** Mark an entry as just used, so pruning keeps what the adapter still reads. */
  touch(kind: GitHubCacheKind, key: string) {
    const id = this.key(kind, key);
    if (this.pending.has(id) || this.pending.size >= this.maxPending) return;
    this.pending.set(id, 'touch');
    this.schedule();
  }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }
  /** Write the queued batch, one statement at a time; a failed chunk is dropped, not retried. Never throws. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => this.pending.size ? this.flush() : undefined);
    this.flushing = this.write().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async write() {
    const batch = [...this.pending]; this.pending.clear();
    const puts = batch.filter((entry): entry is [string, Exclude<Pending, 'touch'>] => entry[1] !== 'touch');
    const touches = batch.filter(([, entry]) => entry === 'touch').map(([key]) => key);
    for (let at = 0; at < puts.length; at += 500) {
      const chunk = puts.slice(at, at + 500);
      try {
        await this.pool.query(`INSERT INTO github_cache(key, kind, etag, value, updated_at)
SELECT k, kd, e, v::jsonb, now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(k, kd, e, v)
ON CONFLICT (key) DO UPDATE SET kind=EXCLUDED.kind, etag=EXCLUDED.etag, value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`,
        [chunk.map(([key]) => key), chunk.map(([, entry]) => entry.kind), chunk.map(([, entry]) => entry.etag), chunk.map(([, entry]) => entry.value)]);
      } catch (error) { this.report('write', error); }
    }
    for (let at = 0; at < touches.length; at += 2_000) {
      try { await this.pool.query('UPDATE github_cache SET updated_at=now() WHERE key = ANY($1::text[])', [touches.slice(at, at + 2_000)]); }
      catch (error) { this.report('write', error); }
    }
    if (Date.now() - this.prunedAt >= this.pruneMs) await this.prune();
  }
  /** Delete everything past the newest `maxRows` rows or `maxBytes` of values. Returns the rows removed; never throws. */
  async prune(): Promise<number> {
    this.prunedAt = Date.now();
    try {
      const result = await this.pool.query(`DELETE FROM github_cache c USING (
  SELECT key, row_number() OVER w AS n, sum(pg_column_size(value)) OVER w AS bytes FROM github_cache WINDOW w AS (ORDER BY updated_at DESC, key)
) r WHERE c.key = r.key AND (r.n > $1 OR r.bytes > $2)`, [this.maxRows, this.maxBytes]);
      return result.rowCount ?? 0;
    } catch (error) { this.report('prune', error); return 0; }
  }
  /** Stop the timer and write what is queued. */
  async close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
  }
}
