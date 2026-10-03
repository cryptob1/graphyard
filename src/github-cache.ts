import type pg from 'pg';
import { GitHubChargeLedger } from './github-charges.js';

/**
 * The GitHub adapter's response caches, persisted so a restart starts warm (github_cache,
 * src/store/tables/github-cache.ts). Every deploy used to empty them, and the first minutes
 * after each restart spent ~400 billable requests a minute re-reading answers that had not
 * changed. The in-memory maps in src/github.ts stay the hot layer; this is the cold one.
 *
 * - Immutable answers (ancestry of a SHA pair, a blob at a SHA, a history between two SHAs, and
 *   the whole response to a commit read by SHA or a compare of two exact SHAs, GY-806) are
 *   loaded once and never expire. ETag entries are loaded with their ETag and still revalidated
 *   with If-None-Match, which GitHub answers with a free 304.
 * - Whole immutable responses are kept while they are used (GY-806): `lookup` answers a read the
 *   hot layer has evicted, and every hit refreshes the row, so a SHA an open item or queue entry
 *   still reads is asked of GitHub at most once. They have their own bound, apart from the other
 *   kinds, so ETag churn never evicts them: the newest-used `maxImmutableRows` rows and
 *   `maxImmutableBytes` of values. A compare keyed by a base tip that has moved on stops being
 *   read, ages out, and is deleted; a value over `maxValueBytes` stays in the hot layer only.
 * - Reads happen once, at attach; writes are batched write-behind on a timer, one pool query at
 *   a time, so the cache never holds more than one of the pool's connections. Plain pool queries
 *   only: never inside a coordination transaction and never under the advisory lock.
 * - Every other kind is pruned to the newest `maxRows` rows and `maxBytes` of values.
 * - A value over `maxValueBytes`, or a put past `maxPending` queued entries, is not persisted, for
 *   every kind: the table and its write queue stay bounded however large a compare is.
 * - A database failure never fails an observation: the maps stay as they are and the adapter
 *   asks GitHub, exactly as it did before the cache was persisted.
 */
export type GitHubCacheKind = 'etag' | 'ancestry' | 'blob' | 'history' | 'immutable';
/** The map operations `load` needs; the adapter's etag and immutable maps are byte-bounded caches (src/github-response-cache.ts). */
interface LoadableMap<V> { readonly size: number; has(key: string): boolean; set(key: string, value: V): unknown; delete(key: string): boolean; keys(): IterableIterator<string> }
export interface GitHubCacheMaps {
  etag: LoadableMap<{ etag: string; value: any }>;
  ancestry: Map<string, boolean>;
  blob: Map<string, string | null>;
  history: Map<string, Set<string> | null>;
  /** Optional so a caller that keeps no whole-response layer loads none of it. */
  immutable?: LoadableMap<unknown>;
}
export interface GitHubCacheOptions { flushMs?: number; pruneMs?: number; maxRows?: number; maxBytes?: number; maxValueBytes?: number; maxPending?: number; maxImmutableRows?: number; maxImmutableBytes?: number }
/** `retried` marks an entry already re-queued once after a failed write; a second failure drops it. */
type Pending = { kind: GitHubCacheKind; etag: string | null; value: string; retried?: true } | 'touch';

export class GitHubCacheStore {
  readonly flushMs: number; readonly pruneMs: number; readonly maxRows: number; readonly maxBytes: number; readonly maxValueBytes: number; readonly maxPending: number;
  readonly maxImmutableRows: number; readonly maxImmutableBytes: number;
  private pending = new Map<string, Pending>();
  /** The batch a flush is writing: out of `pending`, maybe not yet visible in the table. */
  private writing = new Map<string, Exclude<Pending, 'touch'>>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private prunedAt = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  private reportedAt = 0;
  /** The installation's billable charges across replicas (GY-806), on the same database and scope; the adapter attaches it with the cache. */
  readonly charges: GitHubChargeLedger;
  /** `scope` separates installations that share one database; the adapter passes its installation id. */
  constructor(private pool: Pick<pg.Pool, 'query'>, private scope = '', options: GitHubCacheOptions = {}) {
    this.charges = new GitHubChargeLedger(pool, scope);
    this.flushMs = options.flushMs ?? 5_000; this.pruneMs = options.pruneMs ?? 10 * 60_000;
    this.maxRows = options.maxRows ?? 20_000; this.maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
    this.maxValueBytes = options.maxValueBytes ?? 1024 * 1024; this.maxPending = options.maxPending ?? 10_000;
    this.maxImmutableRows = options.maxImmutableRows ?? 20_000; this.maxImmutableBytes = options.maxImmutableBytes ?? 128 * 1024 * 1024;
  }
  private key(kind: GitHubCacheKind, key: string) { return `${this.scope}:${kind}:${key}`; }
  private report(what: string, error: unknown) {
    if (Date.now() - this.reportedAt < 60_000) return;
    this.reportedAt = Date.now();
    console.error(`GitHub cache ${what} failed; requests fall back to GitHub: ${error instanceof Error ? error.message : String(error)}`);
  }
  /** Fill the maps from the table, newest last so each map's insertion order stays its recency order. Never throws. */
  async load(maps: GitHubCacheMaps, caps: Record<Exclude<GitHubCacheKind, 'immutable'>, number> & { immutable?: number }): Promise<number> {
    try {
      const prefix = `${this.scope.replace(/[\\%_]/g, '\\$&')}:%`;
      const rows = (await this.pool.query(`SELECT key, kind, etag, value FROM (
  SELECT key, kind, etag, value, updated_at, row_number() OVER (PARTITION BY kind ORDER BY updated_at DESC, key) AS n FROM github_cache WHERE key LIKE $1
) t WHERE n <= CASE kind WHEN 'etag' THEN $2::int WHEN 'ancestry' THEN $3::int WHEN 'blob' THEN $4::int WHEN 'history' THEN $5::int WHEN 'immutable' THEN $6::int ELSE 0 END
ORDER BY updated_at, key`, [prefix, caps.etag, caps.ancestry, caps.blob, caps.history, maps.immutable ? caps.immutable ?? 0 : 0])).rows;
      let loaded = 0;
      for (const row of rows) {
        const kind = row.kind as GitHubCacheKind;
        const key = String(row.key).slice(this.scope.length + kind.length + 2);
        if (kind === 'etag' && typeof row.etag === 'string' && !maps.etag.has(key)) maps.etag.set(key, { etag: row.etag, value: row.value });
        else if (kind === 'ancestry' && typeof row.value === 'boolean' && !maps.ancestry.has(key)) maps.ancestry.set(key, row.value);
        else if (kind === 'blob' && (typeof row.value === 'string' || row.value === null) && !maps.blob.has(key)) maps.blob.set(key, row.value);
        else if (kind === 'history' && (Array.isArray(row.value) || row.value === null) && !maps.history.has(key)) maps.history.set(key, row.value ? new Set(row.value.map(String)) : null);
        else if (kind === 'immutable' && row.value !== null && row.value !== undefined && maps.immutable && !maps.immutable.has(key)) maps.immutable.set(key, row.value);
        else continue;
        loaded++;
      }
      for (const kind of Object.keys(caps) as GitHubCacheKind[]) {
        const map = maps[kind] as LoadableMap<unknown> | undefined;
        while (map && map.size > (caps[kind] ?? 0)) map.delete(map.keys().next().value!);
      }
      return loaded;
    } catch (error) { this.report('load', error); return 0; }
  }
  /** Queue an entry for the next write-behind batch. */
  put(kind: GitHubCacheKind, key: string, value: unknown, etag: string | null = null) {
    if (this.closed) return;
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
    if (this.closed) return;
    const id = this.key(kind, key);
    if (this.pending.has(id) || this.pending.size >= this.maxPending) return;
    this.pending.set(id, 'touch');
    this.schedule();
  }
  /** One entry, queued or stored, for a read the hot layer no longer holds; undefined when there is none. Never throws. */
  async lookup(kind: GitHubCacheKind, key: string): Promise<any> {
    const id = this.key(kind, key);
    const queued = this.pending.get(id);
    if (queued && queued !== 'touch') return JSON.parse(queued.value);
    // A batch being written is not yet readable from the table (GY-1052): it answers from memory.
    const writing = this.writing.get(id);
    if (writing) return JSON.parse(writing.value);
    try { return (await this.pool.query('SELECT value FROM github_cache WHERE key = $1', [id])).rows[0]?.value; }
    catch (error) { this.report('lookup', error); return undefined; }
  }
  private schedule() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }
  /**
   * Write the queued batch, one statement at a time. A chunk that fails to write is queued again
   * once, for the next batch (GY-1052), so a transient failure does not lose entries the hot layer
   * may already have evicted; a second failure drops them, so a value the database keeps refusing
   * cannot hold its neighbours back. A failed touch only loses recency and is
   * dropped. Never throws.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => this.pending.size ? this.flush() : undefined);
    this.flushing = this.write().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async write() {
    const batch = [...this.pending]; this.pending.clear();
    const puts = batch.filter((entry): entry is [string, Exclude<Pending, 'touch'>] => entry[1] !== 'touch');
    this.writing = new Map(puts);
    try { await this.writeBatch(puts, batch); } finally { this.writing = new Map(); }
    if (Date.now() - this.prunedAt >= this.pruneMs) await this.prune();
  }
  private async writeBatch(puts: [string, Exclude<Pending, 'touch'>][], batch: [string, Pending][]) {
    const touches = batch.filter(([, entry]) => entry === 'touch').map(([key]) => key);
    for (let at = 0; at < puts.length; at += 500) {
      const chunk = puts.slice(at, at + 500);
      try {
        await this.pool.query(`INSERT INTO github_cache(key, kind, etag, value, updated_at)
SELECT k, kd, e, v::jsonb, now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(k, kd, e, v)
ON CONFLICT (key) DO UPDATE SET kind=EXCLUDED.kind, etag=EXCLUDED.etag, value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`,
        [chunk.map(([key]) => key), chunk.map(([, entry]) => entry.kind), chunk.map(([, entry]) => entry.etag), chunk.map(([, entry]) => entry.value)]);
      } catch (error) { this.report('write', error); this.requeue(chunk); }
    }
    for (let at = 0; at < touches.length; at += 2_000) {
      try { await this.pool.query('UPDATE github_cache SET updated_at=now() WHERE key = ANY($1::text[])', [touches.slice(at, at + 2_000)]); }
      catch (error) { this.report('write', error); }
    }
  }
  /** Queue a failed chunk's entries once more, unless a newer put replaced them or the queue is full or closed. */
  private requeue(chunk: [string, Exclude<Pending, 'touch'>][]) {
    if (this.closed) return;
    for (const [id, entry] of chunk) {
      if (entry.retried || this.pending.has(id) || this.pending.size >= this.maxPending) continue;
      this.pending.set(id, { ...entry, retried: true });
    }
    if (this.pending.size) this.schedule();
  }
  /**
   * Delete entries past their bound, newest-used kept: whole immutable responses past `maxImmutableRows`
   * rows or `maxImmutableBytes` of values, every other kind past `maxRows` or `maxBytes`. Returns the rows removed; never throws.
   */
  async prune(): Promise<number> {
    this.prunedAt = Date.now();
    try {
      const result = await this.pool.query(`DELETE FROM github_cache c USING (
  SELECT key, kind = 'immutable' AS whole, row_number() OVER w AS n, sum(pg_column_size(value)) OVER w AS bytes FROM github_cache
  WINDOW w AS (PARTITION BY kind = 'immutable' ORDER BY updated_at DESC, key)
) r WHERE c.key = r.key AND (CASE WHEN r.whole THEN r.n > $3 OR r.bytes > $4 ELSE r.n > $1 OR r.bytes > $2 END)`, [this.maxRows, this.maxBytes, this.maxImmutableRows, this.maxImmutableBytes]);
      return result.rowCount ?? 0;
    } catch (error) { this.report('prune', error); return 0; }
  }
  /** Stop the timers and write what is queued. A chunk that fails during shutdown is retried once before closing (GY-1052). */
  async close() {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      await Promise.all([this.flush(), this.charges.close()]);
      if (this.pending.size) await this.flush();
      this.closed = true;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    })();
    return this.closing;
  }
}
