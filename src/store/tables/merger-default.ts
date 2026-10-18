import { defineTable } from '../tables.js';

/**
 * GY-1833: the marker of whether a database held history before the control-plane merger default.
 * It once pinned such a database to the `github` merger; the control plane is now the only merge
 * writer, so nothing reads the marker or the pin event, and an old `github` event reads control-plane.
 * The table stays so backups restore as before, and its DDL text stays byte-identical: it ran once on
 * every database that has it, and a changed definition would be a new schema generation (GY-1961)
 * that older releases refuse, for no change in behaviour.
 */
const legacyPinReason = 'install predates the control-plane merger default (GY-1833); graphyard up --merger control-plane migrates it';
export const mergerDefaultPin = defineTable({
  name: 'merger_default_pin', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS merger_default_pin (
  id boolean PRIMARY KEY DEFAULT true CHECK (id), pinned boolean NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO merger_default_pin(pinned)
SELECT EXISTS (SELECT 1 FROM events) AND NOT EXISTS (SELECT 1 FROM events WHERE work_id IS NULL AND kind='policy.merger.set')
ON CONFLICT (id) DO NOTHING;
INSERT INTO events(work_id, actor, kind, payload)
SELECT NULL, 'graphyard', 'policy.merger.set', '{"merger":"github","reason":"${legacyPinReason}","previous":null}'::jsonb
WHERE EXISTS (SELECT 1 FROM merger_default_pin WHERE pinned) AND NOT EXISTS (SELECT 1 FROM events WHERE work_id IS NULL AND kind='policy.merger.set');`,
});

export const mergerDefaultTables = [mergerDefaultPin];
