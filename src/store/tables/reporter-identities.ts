import { defineTable } from '../tables.js';

/** GY-3385: the reporter identities a Master issued peer installs on its host, one per peer; only the token's digest is kept. */
export const reporterIdentities = defineTable({
  name: 'reporter_identities', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS reporter_identities (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, minted_by text NOT NULL, minted_at timestamptz NOT NULL
);`,
});
