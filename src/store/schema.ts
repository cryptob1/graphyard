import { createHash } from 'node:crypto';
import type { TableDefinition } from './tables.js';
import { schemaVersion } from '../release.js';
import { workTables } from './tables/work.js';
import { workIndexTables } from './tables/work-index.js';
import { delegationTables } from './tables/delegation.js';
import { operatorAgentTables } from './tables/operator-agents.js';
import { proofGrantTables } from './tables/proof-grants.js';
import { validationTables } from './tables/validation.js';
import { scenarioTables } from './tables/scenarios.js';
import { deliveryTables } from './tables/delivery.js';
import { productionTables } from './tables/production.js';
import { flowTables } from './tables/flow.js';
import { attributionTables } from './tables/attribution.js';
import { schemaGenerationTables } from './tables/schema-generation.js';
import { githubCacheTables } from './tables/github-cache.js';

/**
 * Every table, in an order a restore can insert without violating references: a table
 * appears after every table it references. A feature adds its tables to one module here.
 */
export const tables: readonly TableDefinition[] = [
  ...workTables, ...workIndexTables, ...delegationTables, ...operatorAgentTables, ...proofGrantTables,
  ...validationTables, ...scenarioTables, ...deliveryTables, ...productionTables, ...flowTables, ...attributionTables,
  ...schemaGenerationTables, ...githubCacheTables,
];

/** The additive startup migration: the append-only trigger function, then each table's DDL. */
export const migration = `
CREATE OR REPLACE FUNCTION graphyard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'The event ledger is append-only'; END $$;
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

/** Refuses to run a release under a database a newer release already migrated. */
export const newerSchema = (current: number) => new Error(`Database schema generation ${current} is newer than this release supports (${schemaVersion}); deploy the release that migrated it, or restore a backup taken at generation ${schemaVersion} or earlier`);

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
