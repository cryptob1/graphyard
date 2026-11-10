import { defineTable } from '../tables.js';

/** Browser sessions survive deployments; bearer tokens themselves are never persisted. */
export const humanSignInSessions = defineTable({
  name: 'human_sign_in_sessions', orderBy: 'token_hash',
  ddl: `CREATE TABLE IF NOT EXISTS human_sign_in_sessions (
  token_hash text PRIMARY KEY, actor jsonb NOT NULL, expires_at timestamptz NOT NULL
);`,
});

/** GY-3215: teammates the operator invited, by the label they were invited under, with their team role. */
export const teamMembers = defineTable({
  name: 'team_members', orderBy: 'name',
  ddl: `CREATE TABLE IF NOT EXISTS team_members (
  name text PRIMARY KEY, team text NOT NULL, invited_by text NOT NULL, invited_at timestamptz NOT NULL
);`,
});
