import { appendOnly, defineTable } from '../tables.js';

/** Versioned E2E test-case definitions. */
export const scenarios = defineTable({
  name: 'scenarios', orderBy: 'id,revision',
  ddl: `CREATE TABLE IF NOT EXISTS scenarios (id text NOT NULL, revision int NOT NULL, document jsonb NOT NULL, PRIMARY KEY(id,revision));
${appendOnly('scenarios')}`,
});

/**
 * Each trusted run of a test case (GY-162), bound to its commit and its lane's run identity.
 * `run_key` makes a retried publish of the same run the same row; see src/model/test-cases.ts.
 */
export const scenarioRuns = defineTable({
  name: 'scenario_runs', orderBy: 'seq', serial: 'seq',
  ddl: `CREATE TABLE IF NOT EXISTS scenario_runs (seq bigserial PRIMARY KEY, scenario text NOT NULL, run_key text NOT NULL UNIQUE, document jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS scenario_runs_scenario ON scenario_runs(scenario, seq DESC);
${appendOnly('scenario_runs')}`,
});

export const scenarioTables = [scenarios, scenarioRuns];
