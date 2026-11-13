import { productBrief } from './tables/product-brief.js';
import { loopState } from './tables/loop-state.js';
import { createHash } from 'node:crypto';
import type { TableDefinition } from './tables.js';
import { humanSignInSessions, teamMembers } from './tables/human-sign-in.js';
import { workTables } from './tables/work.js';
import { workIndexTables } from './tables/work-index.js';
import { mergesTables } from './tables/merges.js';
import { delegationTables } from './tables/delegation.js';
import { operatorAgentTables } from './tables/operator-agents.js';
import { validationTables } from './tables/validation.js';
import { scenarioTables } from './tables/scenarios.js';
import { deliveryTables } from './tables/delivery.js';
import { schemaGenerationTables } from './tables/schema-generation.js';
import { planeLivenessTables } from './tables/plane-liveness.js';
import { registryRefusalTables } from './tables/registry-refusals.js';
import { sessionUsage } from './tables/session-usage.js';

/**
 * Every table, in an order a restore can insert without violating references: a table
 * appears after every table it references. A feature adds its tables to one module here.
 */
export const tables: readonly TableDefinition[] = [
  ...workTables, ...mergesTables, ...workIndexTables, ...delegationTables, ...operatorAgentTables,
  ...validationTables, ...scenarioTables, ...deliveryTables,
  ...schemaGenerationTables, ...planeLivenessTables, ...registryRefusalTables, sessionUsage, humanSignInSessions, teamMembers, loopState, productBrief,
];

/** Tables retired from the schema and logical backups. */
export const retiredTables = ['flow_facts', 'flow_projection', 'flow_projection_state', 'deployment_merge_observations', 'deployment_observations', 'proof_grants', 'proof_grant_history', 'merger_default_pin', 'production_observation_merges', 'production_observations', 'attribution_records', 'attribution_reanchors', 'validation_builds', 'validation_candidates', 'validation_requests', 'validation_artifacts', 'validation_runner_polls', 'validation_resources', 'validation_attempts', 'validation_reuse_decisions', 'validation_replays'] as const;

/** The startup migration: the append-only trigger function, the retired tables dropped, then each table's DDL. */
export const migration = `
CREATE OR REPLACE FUNCTION graphyard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'The event ledger is append-only'; END $$;
DROP TABLE IF EXISTS ${retiredTables.join(', ')};
DROP INDEX IF EXISTS events_delivery_repository_instant, events_delivery_first, events_delivery_time, events_delivery_instant;
${tables.map(table => table.ddl).join('\n')}
`;

/** The migration digests a release records with its generation (the graphyard_schema comment), so the next one touches only what changed. */
export interface MigrationDigests {
  /** The whole migration's digest, in the format the comment carried before per-table digests existed. */
  migration: string;
  /** The digest of the statements ahead of the first table's DDL (the shared trigger function). */
  prelude: string;
  /** One digest per table's own DDL. */
  tables: Record<string, string>;
}

const sha256 = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** The digests of this release's migration: the whole text, its prelude, and each table's own DDL. */
export const migrationDigests = (): MigrationDigests => ({
  migration: `migration ${sha256(migration)}`,
  prelude: sha256(migration.slice(0, migration.indexOf(tables[0].ddl))),
  tables: Object.fromEntries(tables.map(table => [table.name, sha256(table.ddl)])),
});

/**
 * What a recorded graphyard_schema comment says. Releases before per-table digests carried
 * `migration sha256:…` alone — their tables are unknown, so the next migration must read each
 * table's DDL as unproven (unless the whole digest matches, which proves every table's DDL ran).
 */
export const recordedMigrationDigests = (comment: string | null): { migration: string | null; prelude: string | null; tables: Record<string, string> | null } => {
  if (!comment) return { migration: null, prelude: null, tables: null };
  if (comment.startsWith('{')) {
    try {
      const parsed = JSON.parse(comment) as Partial<MigrationDigests>;
      return {
        migration: typeof parsed.migration === 'string' ? parsed.migration : null,
        prelude: typeof parsed.prelude === 'string' ? parsed.prelude : null,
        tables: parsed.tables && typeof parsed.tables === 'object' && !Array.isArray(parsed.tables)
          ? Object.fromEntries(Object.entries(parsed.tables).filter(([, digest]) => typeof digest === 'string'))
          : null,
      };
    } catch { return { migration: null, prelude: null, tables: null }; }
  }
  return { migration: comment.startsWith('migration sha256:') ? comment : null, prelude: null, tables: null };
};

/** The recorded digests as a comment statement, escaped for SQL. */
export const migrationDigestComment = (digests: MigrationDigests) => `'${JSON.stringify(digests).replace(/'/g, "''")}'`;

/**
 * Every table a logical backup carries, derived from the registry so a new table can never
 * be left out of a backup by omission. The order is the registry's restore order. A cache
 * table is not ledger state and is left out.
 */
export const ledgerTables = tables.filter(table => !table.cache).map(table => table.name);
/** Stable export order per table, for backups and audits. */
export const ledgerOrder: Record<string, string> = Object.fromEntries(tables.map(table => [table.name, table.orderBy]));
/** The serial sequences a restore advances, one per table that has one. */
export const ledgerSequences = tables.flatMap(table => table.serial ? [{ table: table.name, column: table.serial }] : []);
/**
 * Tables whose migration seeds a row — a projection checkpoint — so a freshly migrated
 * database is never empty at them. A restore replaces the seed with the backup's row
 * instead of refusing the table as occupied; every other table must be empty.
 */
export const ledgerSeeded = tables.filter(table => !table.cache && /\bINSERT INTO\b/i.test(table.ddl)).map(table => table.name);
