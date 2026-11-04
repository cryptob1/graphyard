import { defineTable } from '../tables.js';

/** Browser sessions survive deployments; bearer tokens themselves are never persisted. */
export const humanSignInSessions = defineTable({
  name: 'human_sign_in_sessions', orderBy: 'token_hash',
  ddl: `CREATE TABLE IF NOT EXISTS human_sign_in_sessions (
  token_hash text PRIMARY KEY, actor jsonb NOT NULL, expires_at timestamptz NOT NULL
);`,
});
