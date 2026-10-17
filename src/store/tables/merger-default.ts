import { defineTable } from '../tables.js';

/**
 * GY-1833: the marker of whether a database held history before the control-plane merger default.
 * It once pinned such a database to the `github` merger; the control plane is now the only merge
 * writer, so nothing reads it and nothing is pinned. The table and its marker stay so backups restore as before.
 */
export const mergerDefaultPin = defineTable({
  name: 'merger_default_pin', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS merger_default_pin (
  id boolean PRIMARY KEY DEFAULT true CHECK (id), pinned boolean NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO merger_default_pin(pinned)
SELECT EXISTS (SELECT 1 FROM events) AND NOT EXISTS (SELECT 1 FROM events WHERE work_id IS NULL AND kind='policy.merger.set')
ON CONFLICT (id) DO NOTHING;`,
});

export const mergerDefaultTables = [mergerDefaultPin];
