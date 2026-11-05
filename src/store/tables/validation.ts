import { appendOnly, defineTable } from '../tables.js';

/** Deployment environment and registration definitions shared with Delivery. */
export const validationDefinitions = defineTable({
  name: 'validation_definitions', orderBy: 'kind,id,revision',
  ddl: `CREATE TABLE IF NOT EXISTS validation_definitions (
  kind text NOT NULL, id text NOT NULL, revision int NOT NULL, document jsonb NOT NULL,
  PRIMARY KEY(kind,id,revision)
);
${appendOnly('validation_definitions')}
CREATE INDEX IF NOT EXISTS validation_definition_page ON validation_definitions ((document->>'createdAt') DESC,kind DESC,id DESC,revision DESC);`,
});
export const validationTables = [validationDefinitions];
