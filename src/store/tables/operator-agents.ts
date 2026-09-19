import { defineTable } from '../tables.js';

/** Scoped operator automation identities and their rotating credentials. */
export const operatorAgents = defineTable({
  name: 'operator_agents', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS operator_agents (
  id text PRIMARY KEY, document jsonb NOT NULL
);`,
});
export const operatorCredentials = defineTable({
  name: 'operator_credentials', orderBy: 'agent_id,fingerprint',
  ddl: `CREATE TABLE IF NOT EXISTS operator_credentials (
  agent_id text NOT NULL REFERENCES operator_agents(id), fingerprint text NOT NULL,
  token_hash text NOT NULL UNIQUE, valid_from timestamptz NOT NULL, valid_until timestamptz,
  revoked_at timestamptz, PRIMARY KEY(agent_id,fingerprint)
);`,
});

export const operatorAgentTables = [operatorAgents, operatorCredentials];
