import { defineTable } from '../tables.js';

/**
 * Repeats of one registry refusal (GY-3095): the `agent-registry.refused` ledger row stands for
 * the first refusal, and each identical refusal of the same request after it raises this row's
 * count and last-seen time instead of appending another row, so registry history keeps real
 * changes among its newest entries. Keyed by the refusal's event sequence.
 */
export const registryRefusalRepeats = defineTable({
  name: 'registry_refusal_repeats', orderBy: 'seq',
  ddl: `CREATE TABLE IF NOT EXISTS registry_refusal_repeats (
  seq bigint PRIMARY KEY, count integer NOT NULL, last_at timestamptz NOT NULL
);`,
});

export const registryRefusalTables = [registryRefusalRepeats];
