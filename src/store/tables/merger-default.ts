import { defineTable } from '../tables.js';

/**
 * GY-1833: the merger default changed from `github` to `control-plane` (src/merger-mode.ts), and an
 * install switches its merger only by the admin ledger event. This DDL keeps an install that ran
 * before the change on the merger it ran with: the startup migration runs a table's DDL once, when
 * its digest is new, so on a database that already holds history and no `policy.merger.set` event
 * it records `github` once, and the setup checklist then flags the install as legacy with its
 * migration command. A new database holds no events when it migrates, so it records nothing and
 * reads as control-plane. The marker row records which way the first run went, and the event is
 * written only when it says pinned, so a rerun (a rollback and a later upgrade re-run this DDL)
 * never pins a database that started on the new default. A cache: the ledger event is the record.
 */
export const mergerDefaultPinReason = 'install predates the control-plane merger default (GY-1833); graphyard up --merger control-plane migrates it';
export const mergerDefaultPin = defineTable({
  name: 'merger_default_pin', orderBy: 'id', cache: true,
  ddl: `CREATE TABLE IF NOT EXISTS merger_default_pin (
  id boolean PRIMARY KEY DEFAULT true CHECK (id), pinned boolean NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO merger_default_pin(pinned)
SELECT EXISTS (SELECT 1 FROM events) AND NOT EXISTS (SELECT 1 FROM events WHERE work_id IS NULL AND kind='policy.merger.set')
ON CONFLICT (id) DO NOTHING;
INSERT INTO events(work_id, actor, kind, payload)
SELECT NULL, 'graphyard', 'policy.merger.set', '{"merger":"github","reason":"${mergerDefaultPinReason}","previous":null}'::jsonb
WHERE EXISTS (SELECT 1 FROM merger_default_pin WHERE pinned) AND NOT EXISTS (SELECT 1 FROM events WHERE work_id IS NULL AND kind='policy.merger.set');`,
});

export const mergerDefaultTables = [mergerDefaultPin];
