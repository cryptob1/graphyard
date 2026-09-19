import { appendOnly, defineTable } from '../tables.js';

/** Versioned E2E test-case definitions. */
export const scenarios = defineTable({
  name: 'scenarios', orderBy: 'id,revision',
  ddl: `CREATE TABLE IF NOT EXISTS scenarios (id text NOT NULL, revision int NOT NULL, document jsonb NOT NULL, PRIMARY KEY(id,revision));
${appendOnly('scenarios')}`,
});

export const scenarioTables = [scenarios];
