import { appendOnly, defineTable } from '../tables.js';

/** Proof authority: the live grant per principal and its append-only history. */
export const proofGrants = defineTable({
  name: 'proof_grants', orderBy: 'principal_id',
  ddl: `CREATE TABLE IF NOT EXISTS proof_grants (
  principal_id text PRIMARY KEY, document jsonb NOT NULL
);`,
});
export const proofGrantHistory = defineTable({
  name: 'proof_grant_history', orderBy: 'seq', serial: 'seq',
  ddl: `CREATE TABLE IF NOT EXISTS proof_grant_history (
  seq bigserial PRIMARY KEY, principal_id text NOT NULL, document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
${appendOnly('proof_grant_history')}`,
});

export const proofGrantTables = [proofGrants, proofGrantHistory];
