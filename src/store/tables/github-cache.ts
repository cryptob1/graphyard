import { defineTable } from '../tables.js';

/**
 * GitHub responses kept across restarts (src/github-cache.ts): conditional-request ETags with
 * their bodies, and answers that never change for a pinned SHA (ancestry, blobs, histories).
 * A cache, not ledger state: it is bounded by pruning, never backed up or restored, and any
 * row may be lost without changing an outcome — a missing row costs one GitHub request.
 */
export const githubCache = defineTable({
  name: 'github_cache', orderBy: 'key', cache: true,
  ddl: `CREATE TABLE IF NOT EXISTS github_cache (
  key text PRIMARY KEY, kind text NOT NULL, etag text, value jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS github_cache_updated ON github_cache(updated_at DESC);`,
});

export const githubCacheTables = [githubCache];
