import type { TableDefinition } from './tables.js';
import { workTables } from './tables/work.js';
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
  ...workTables, ...delegationTables, ...operatorAgentTables, ...proofGrantTables,
  ...validationTables, ...scenarioTables, ...deliveryTables, ...productionTables, ...flowTables, ...attributionTables,
  ...schemaGenerationTables, ...githubCacheTables,
];

/** The additive startup migration: the append-only trigger function, then each table's DDL. */
export const migration = `
CREATE OR REPLACE FUNCTION graphyard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'The event ledger is append-only'; END $$;
${tables.map(table => table.ddl).join('\n')}
`;

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
export const ledgerSeeded = tables.filter(table => /\bINSERT INTO\b/i.test(table.ddl)).map(table => table.name);
