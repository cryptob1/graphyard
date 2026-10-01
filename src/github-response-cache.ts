/**
 * The GitHub adapter's in-memory answer caches, bounded by bytes as well as entries (GY-975).
 *
 * The conditional-request cache used to keep every GET answer's parsed object graph, capped at
 * 4096 entries and nothing else. A compare answer lists every changed file with its patch even when
 * `per_page` narrows its commits, so one entry for an old base against a new head ran to megabytes,
 * and each new commit pair the observation workers, the production watch and the landing check
 * compared added one more. The production server's heap climbed to its 4 GB limit in ten to fifteen
 * minutes and crashed, failing every lease renewal while it restarted. An entry now holds the answer's
 * JSON text — a flat string, a fraction of its parsed size — and the cache evicts its least recently
 * used entries past either bound; an answer larger than a single entry may be is not kept at all.
 */
export class BoundedCache<V> {
  private entries = new Map<string, { value: V; bytes: number }>();
  private total = 0;
  constructor(readonly maxEntries: number, readonly maxBytes: number, readonly maxValueBytes: number, private sizeOf: (value: V) => number) {}
  get size() { return this.entries.size; }
  /** What the retained values measure, by `sizeOf`. */
  get bytes() { return this.total; }
  has(key: string) { return this.entries.has(key); }
  get(key: string): V | undefined { return this.entries.get(key)?.value; }
  keys() { return this.entries.keys(); }
  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key); this.total -= entry.bytes;
    return true;
  }
  /** Keep `value` as the most recently used entry; false, and nothing kept under `key`, when it alone exceeds `maxValueBytes`. */
  set(key: string, value: V): boolean {
    this.delete(key);
    const bytes = this.sizeOf(value);
    if (bytes > this.maxValueBytes) return false;
    this.entries.set(key, { value, bytes }); this.total += bytes;
    while (this.entries.size > this.maxEntries || this.total > this.maxBytes) this.delete(this.entries.keys().next().value!);
    return true;
  }
}

/** One conditional-request entry: the ETag to revalidate with and the answer's JSON text. */
export interface EtagEntry { etag: string; text: string }

/**
 * Conditional-request cache size. One observation round reads roughly ten paths per open PR; a cache
 * smaller than a round evicts every entry before its reuse, so no request earns a free 304.
 */
export const etagCacheEntries = 4096;
/** The JSON text the conditional-request cache retains in all, and the most one answer may take of it. */
export const etagCacheBytes = 128 * 1024 * 1024, etagCacheValueBytes = 8 * 1024 * 1024;
/** Blob bytes kept for the landing check in all, and the largest blob kept. */
export const blobContentBytes = 64 * 1024 * 1024, blobContentValueBytes = 8 * 1024 * 1024;

/** A string's length in UTF-16 code units, the most memory V8 gives it per character. */
const textBytes = (entry: EtagEntry) => 2 * (entry.text.length + entry.etag.length);

/**
 * The conditional-request cache. `set` takes a parsed value, as the persisted layer loads it
 * (src/github-cache.ts); the adapter stores the text it read with `keep`, and `read` parses a fresh
 * copy for every caller, so no caller can mutate what the next one is served.
 */
export class EtagCache extends BoundedCache<EtagEntry> {
  constructor(maxEntries = etagCacheEntries, maxBytes = etagCacheBytes, maxValueBytes = etagCacheValueBytes) { super(maxEntries, maxBytes, maxValueBytes, textBytes); }
  keep(key: string, etag: string, text: string) { return super.set(key, { etag, text }); }
  // The persisted layer's shape: a parsed value, serialized once on the way in.
  override set(key: string, entry: EtagEntry | { etag: string; value: unknown }) {
    return super.set(key, 'text' in entry ? entry : { etag: entry.etag, text: JSON.stringify(entry.value ?? null) });
  }
  read(key: string): { etag: string; value: () => any } | undefined {
    const entry = this.get(key);
    return entry && { etag: entry.etag, value: () => JSON.parse(entry.text) };
  }
}
