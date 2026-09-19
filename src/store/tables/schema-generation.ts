import { defineTable } from '../tables.js';

/**
 * The schema generation the rows were written at. `Store.init` records the generation it
 * reached after the additive migration, and refuses to start a release under a database a
 * newer release already migrated; a backup carries the generation so a restore can refuse
 * the same way instead of quietly dropping columns. The table is not restored from a
 * backup — the migration that precedes a restore records the target's own generation.
 */
export const graphyardSchema = defineTable({
  name: 'graphyard_schema', orderBy: 'version',
  ddl: `CREATE TABLE IF NOT EXISTS graphyard_schema (
  version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp(), graphyard_version text NOT NULL
);`,
});

export const schemaGenerationTables = [graphyardSchema];
