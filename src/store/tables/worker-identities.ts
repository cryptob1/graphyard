import { defineTable } from '../tables.js';

/** GY-3285: the worker identities the loop minted, one per concurrent worker session; only the token's digest is kept. */
export const workerIdentities = defineTable({
  name: 'worker_identities', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS worker_identities (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, minted_by text NOT NULL, minted_at timestamptz NOT NULL
);`,
});
