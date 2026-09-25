import { createHash } from 'node:crypto';
import { defineTable } from '../tables.js';
import { actionSettleMs } from '../../model/action-progress.js';
import { coordinationDocument, coordinationRelevance, coordinationTrimSql, detoasted, settledSql } from '../coordination-sql.js';

/**
 * The work index (GY-203): one small row per work item, projected from its document by a trigger
 * in the same transaction as every write to work_items, whatever path wrote it — `save`, a raw
 * UPDATE, a restore, or a replica still running the previous release.
 *
 * Every snapshot used to load every whole document (17.7 MB on the live ledger) to decide what
 * a handful of live items needed. The index holds what those decisions select on — key, stage,
 * priority, lease owner, epoch, revision, the pull request and its state, the next action's kind
 * and when an action row is next due — and, for a settled delivery (`settledSql`), the summary the
 * coordination view serves in place of its document, so the coordination snapshot reads the index
 * plus only the live items' documents, and an idle claim poll reads the index alone.
 *
 * A cache, not ledger state: a backup does not carry it and a restore rebuilds it through the
 * trigger. The migration rebuilds every row whenever the projection itself changes (its digest is
 * the table's comment), holding a SHARE ROW EXCLUSIVE lock on work_items while it does so that no
 * write lands between the rebuild and the trigger that keeps it; a migration whose projection is
 * unchanged takes no lock on work_items or on the index, so it never waits on a coordination write.
 */

/**
 * When a row is next claimable: its request, backoff, settle window and live claim, the latest of
 * them (`claimable` in src/model/action-progress.ts, as a time). On a delivered item only the
 * deployment row counts, as `openActions` offers no other. The item's due time is the earliest.
 */
const dueAt = `(SELECT MIN(COALESCE(GREATEST(
    graphyard_timestamptz(a.entry->>'requestedAt'),
    graphyard_timestamptz(a.entry->>'retryAt'),
    CASE WHEN a.entry->>'state' = 'done' THEN graphyard_timestamptz(a.entry->>'resolvedAt') + interval '${actionSettleMs} milliseconds' END,
    CASE WHEN a.entry->>'state' IS DISTINCT FROM 'pending' AND jsonb_typeof(a.entry->'claim') = 'object' THEN graphyard_timestamptz(a.entry->'claim'->>'expiresAt') END),
  'epoch'::timestamptz))
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.document->'actionQueue'->'actions') = 'array' THEN d.document->'actionQueue'->'actions' ELSE '[]'::jsonb END) AS a(entry)
  WHERE d.document->>'stage' IS DISTINCT FROM 'done' OR a.entry->>'kind' = 'verify-deployment')`;
const number = (path: string) => `graphyard_number(${path})`;

/** The projection itself: one upsert per document, read as `d.document`. */
// A malformed time reads as none rather than failing the write that carried it. Matched, not
// caught: an exception handler per value would open a subtransaction for every action row.
const projection = `CREATE OR REPLACE FUNCTION graphyard_timestamptz(value text) RETURNS timestamptz LANGUAGE sql STABLE AS $work_index$
  SELECT CASE WHEN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN value::timestamptz END $work_index$;
CREATE OR REPLACE FUNCTION graphyard_number(value jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $work_index$
  SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric END $work_index$;
CREATE OR REPLACE FUNCTION graphyard_index_work(p_id uuid, p_number bigint, p_document jsonb) RETURNS void LANGUAGE sql AS $work_index$
INSERT INTO work_index AS i(id, number, key, stage, priority, owner, epoch, revision, pr, pr_state, next_action, due_at, settled, summary, trimmed)
SELECT p_id, p_number, d.document->>'key', d.document->>'stage', ${number("d.document->'priority'")}, d.document->'lease'->>'owner',
  ${number("d.document->'epoch'")}, ${number("d.document->'revision'")}, ${number("d.document->'candidate'->'pr'")},
  CASE WHEN d.document->'observation'->'merged' = 'true'::jsonb THEN 'merged' ELSE d.document->'observation'->>'prState' END,
  d.document->'nextAction'->>'kind', ${dueAt}, s.settled, x.summary,
  CASE WHEN s.settled THEN ${coordinationTrimSql('x.summary', 0)} END
FROM (SELECT ${detoasted('p_document')} AS document OFFSET 0) d
CROSS JOIN LATERAL (SELECT ${settledSql} AS settled) s
CROSS JOIN ${coordinationRelevance(0)}
CROSS JOIN LATERAL (SELECT CASE WHEN s.settled THEN ${coordinationDocument({ keep: 0, settled: true })} END AS summary) x
ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, key = EXCLUDED.key, stage = EXCLUDED.stage, priority = EXCLUDED.priority,
  owner = EXCLUDED.owner, epoch = EXCLUDED.epoch, revision = EXCLUDED.revision, pr = EXCLUDED.pr, pr_state = EXCLUDED.pr_state,
  next_action = EXCLUDED.next_action, due_at = EXCLUDED.due_at, settled = EXCLUDED.settled, summary = EXCLUDED.summary, trimmed = EXCLUDED.trimmed
$work_index$;
CREATE OR REPLACE FUNCTION graphyard_work_index_sync() RETURNS trigger LANGUAGE plpgsql AS $work_index$
BEGIN PERFORM graphyard_index_work(NEW.id, NEW.number, NEW.document); RETURN NULL; END $work_index$;`;
/** Changes whenever the projection does, so the migration knows to rebuild every row. */
export const workIndexDigest = `work-index sha256:${createHash('sha256').update(projection).digest('hex')}`;

export const workIndex = defineTable({
  name: 'work_index', orderBy: 'id', cache: true,
  ddl: `CREATE TABLE IF NOT EXISTS work_index (
  id uuid PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE, number bigint NOT NULL,
  key text, stage text, priority numeric, owner text, epoch numeric, revision numeric,
  pr numeric, pr_state text, next_action text, due_at timestamptz,
  settled boolean NOT NULL DEFAULT false, summary jsonb, trimmed jsonb
);
${projection}
DO $work_index$ BEGIN
  IF obj_description('work_index'::regclass, 'pg_class') IS DISTINCT FROM '${workIndexDigest}' THEN
    LOCK TABLE work_items IN SHARE ROW EXCLUSIVE MODE;
    CREATE INDEX IF NOT EXISTS work_index_due ON work_index(due_at) WHERE due_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS work_index_number ON work_index(number);
    DROP TRIGGER IF EXISTS work_index_sync ON work_items;
    CREATE TRIGGER work_index_sync AFTER INSERT OR UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION graphyard_work_index_sync();
    PERFORM graphyard_index_work(id, number, document) FROM work_items;
    EXECUTE 'COMMENT ON TABLE work_index IS ''${workIndexDigest}''';
  END IF;
END $work_index$;`,
});

export const workIndexTables = [workIndex];
