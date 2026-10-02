import { defineTable } from '../tables.js';

/**
 * GitHub responses kept across restarts (src/github-cache.ts): conditional-request ETags with
 * their bodies, and answers that never change for a pinned SHA (ancestry, blobs, histories).
 * A cache, not ledger state: it is never backed up or restored, and any row may be lost without
 * changing an outcome — a missing row costs one GitHub request. Every kind is bounded by pruning;
 * whole immutable responses (GY-806) have their own newest-used bound, so they outlive ETag churn.
 */
export const githubCache = defineTable({
  name: 'github_cache', orderBy: 'key', cache: true,
  ddl: `CREATE TABLE IF NOT EXISTS github_cache (
  key text PRIMARY KEY, kind text NOT NULL, etag text, value jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS github_cache_updated ON github_cache(updated_at DESC);`,
});

/**
 * Billable GitHub requests per installation, process and minute, by endpoint (GY-806): every
 * replica sharing the installation's quota writes its own rows and reads the others', so the
 * billable report master status carries counts the whole installation, not one process. A cache
 * too: rows older than two hours are pruned, and a lost row only understates one minute.
 */
export const githubCharges = defineTable({
  name: 'github_charges', orderBy: 'installation, instance, minute, endpoint', cache: true,
  ddl: `CREATE TABLE IF NOT EXISTS github_charges (
  installation text NOT NULL, instance text NOT NULL, minute timestamptz NOT NULL, endpoint text NOT NULL, kind text NOT NULL,
  requests int NOT NULL, PRIMARY KEY(installation, instance, minute, endpoint)
);
CREATE INDEX IF NOT EXISTS github_charges_minute ON github_charges(installation, minute);`,
});

export const githubCacheTables = [githubCache, githubCharges];
