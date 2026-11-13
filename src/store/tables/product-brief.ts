import { defineTable } from '../tables.js';

/** The install's one product brief, mirrored from project memory for the dashboard's Product page (GY-3274). */
export const productBrief = defineTable({
  name: 'product_brief', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS product_brief (
    id integer PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
  );`,
});
