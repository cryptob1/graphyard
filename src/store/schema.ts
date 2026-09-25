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
import { defineTable } from './tables.js';

/**
 * How the index row's `summary` — the stand-in a settled delivered item has in the coordination
 * snapshot — bounds a work document. It keeps every key the document has and the type each key
 * holds, because the master loop and the executors scan every item of the snapshot (a worktree's
 * owner by `workspaces`, obligations by `criteria`) and must not meet a missing field; it empties
 * the history a document accumulates instead:
 *
 * - `emptied`: replaced by the empty value of its type (the evidence of every head, the sessions
 *   launched, the queue history, the description's prose);
 * - `histories`: an object whose `history` list is emptied, its open state kept;
 * - `observation`: kept without the per-file scope comparison, as the coordination view keeps it;
 * - `dropped`: the pipeline timeline, which the coordination view drops from every item anyway.
 *
 * Everything else — criteria, workspaces, lease, candidate, submission, delivery, gates — is kept
 * whole: it is the item's decision state and small.
 */
export const workIndexSummary = {
  emptied: { description: '', evidence: [], sessions: [], queueHistory: [] },
  histories: ['autoDispatch', 'actionQueue'],
  observationOmits: ['scopeFiles'],
  dropped: ['pipeline'],
} as const;
/** The summary of one document, as the index trigger computes it in SQL. */
export function summarizeWork(document: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = { ...document };
  for (const key of workIndexSummary.dropped) delete summary[key];
  for (const [key, value] of Object.entries(workIndexSummary.emptied)) if (key in document) summary[key] = structuredClone(value);
  for (const key of workIndexSummary.histories) {
    const value = document[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && 'history' in value) summary[key] = { ...value, history: [] };
  }
  const observation = document.observation;
  if (observation && typeof observation === 'object' && !Array.isArray(observation)) {
    const kept: Record<string, unknown> = { ...observation };
    for (const key of workIndexSummary.observationOmits) delete kept[key];
    summary.observation = kept;
  }
  return { ...summary, summarized: true };
}
/** Bumped whenever the projection below changes, so the migration recomputes every row it wrote. */
export const workIndexProjection = 2;
const sqlArray = (values: readonly string[]) => `ARRAY[${values.map(value => `'${value}'`).join(',')}]::text[]`;
const sqlJson = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
/** `summarizeWork` in SQL, over the document expression `d`. */
function summarySql(d: string) {
  const object = (key: string) => `jsonb_typeof(${d}->'${key}') = 'object'`;
  return [
    `(${d} - ${sqlArray(workIndexSummary.dropped)})`,
    ...Object.entries(workIndexSummary.emptied).map(([key, value]) => `CASE WHEN ${d} ? '${key}' THEN jsonb_build_object('${key}', ${sqlJson(value)}) ELSE '{}'::jsonb END`),
    ...workIndexSummary.histories.map(key => `CASE WHEN ${object(key)} AND ${d}->'${key}' ? 'history' THEN jsonb_build_object('${key}', jsonb_set(${d}->'${key}', '{history}', '[]'::jsonb)) ELSE '{}'::jsonb END`),
    `CASE WHEN ${object('observation')} THEN jsonb_build_object('observation', (${d}->'observation') - ${sqlArray(workIndexSummary.observationOmits)}) ELSE '{}'::jsonb END`,
    `'{"summarized":true}'::jsonb`,
  ].join(`\n    || `);
}

/**
 * The work index (GY-203): one small row per work item, projected from its document by a
 * trigger in the same transaction as every write to `work_items`, so the index can never
 * disagree with the documents a committed transaction left. It holds what the coordination
 * snapshot selects on — key, stage, priority, owner, epoch, revision, the pull request's
 * state, the next action's kind and when the item next comes due — and a `summary` of the
 * document without its history, which stands in for a delivered item nobody needs whole.
 *
 * It is derivable, so it is a cache: a backup leaves it out, and a restore rebuilds it as
 * the trigger fires on every restored document. The migration creates the trigger only when
 * it is missing and adds no index of its own, so re-running it takes no lock that conflicts
 * with a live replica's writes to `work_items`; its backfill rewrites only rows whose
 * projection or revision is behind their document.
 */
export const workIndex = defineTable({
  name: 'work_index', orderBy: 'id', cache: true,
  ddl: `CREATE TABLE IF NOT EXISTS work_index (
  id uuid PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE, number bigint NOT NULL,
  key text, stage text, priority numeric, owner text, epoch bigint, revision bigint,
  pr_state text, pr_open boolean NOT NULL DEFAULT false, next_action text, due_at timestamptz,
  updated_at timestamptz, summary jsonb NOT NULL, projection int NOT NULL
);
CREATE OR REPLACE FUNCTION graphyard_timestamp(value text) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
BEGIN RETURN value::timestamptz; EXCEPTION WHEN others THEN RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION graphyard_number(value jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN value::text::numeric END $$;
CREATE OR REPLACE FUNCTION graphyard_work_index_write(item uuid, ordinal bigint, d jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO work_index(id, number, key, stage, priority, owner, epoch, revision, pr_state, pr_open, next_action, due_at, updated_at, summary, projection)
  SELECT item, ordinal, d->>'key', d->>'stage', graphyard_number(d->'priority'), d->'lease'->>'owner',
    graphyard_number(d->'epoch')::bigint, graphyard_number(d->'revision')::bigint,
    CASE WHEN COALESCE(jsonb_typeof(d->'observation'), '') <> 'object' THEN NULL
      WHEN d->'observation'->'merged' = 'true'::jsonb THEN 'merged' ELSE d->'observation'->>'prState' END,
    COALESCE(d->>'stage' IS DISTINCT FROM 'done' AND jsonb_typeof(d->'submission') = 'object' AND jsonb_typeof(d->'observation') = 'object'
      AND d->'observation'->'merged' IS DISTINCT FROM 'true'::jsonb AND d->'observation'->>'prState' IS DISTINCT FROM 'closed', false),
    d->'nextAction'->>'kind',
    LEAST(graphyard_timestamp(d->'lease'->>'expiresAt'),
      (SELECT min(COALESCE(graphyard_timestamp(a->>'retryAt'), graphyard_timestamp(a->'claim'->>'expiresAt'), graphyard_timestamp(a->>'requestedAt')))
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d->'actionQueue'->'actions') = 'array' THEN d->'actionQueue'->'actions' ELSE '[]'::jsonb END) a)),
    graphyard_timestamp(d->>'updatedAt'),
    ${summarySql('d')},
    ${workIndexProjection}
  ON CONFLICT (id) DO UPDATE SET number=EXCLUDED.number, key=EXCLUDED.key, stage=EXCLUDED.stage, priority=EXCLUDED.priority,
    owner=EXCLUDED.owner, epoch=EXCLUDED.epoch, revision=EXCLUDED.revision, pr_state=EXCLUDED.pr_state, pr_open=EXCLUDED.pr_open,
    next_action=EXCLUDED.next_action, due_at=EXCLUDED.due_at, updated_at=EXCLUDED.updated_at, summary=EXCLUDED.summary, projection=EXCLUDED.projection $$;
CREATE OR REPLACE FUNCTION graphyard_work_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM graphyard_work_index_write(NEW.id, NEW.number, NEW.document); RETURN NULL; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'work_index_projection' AND tgrelid = 'work_items'::regclass) THEN
    CREATE TRIGGER work_index_projection AFTER INSERT OR UPDATE OF document ON work_items FOR EACH ROW EXECUTE FUNCTION graphyard_work_index();
  END IF;
END $$;
SELECT graphyard_work_index_write(w.id, w.number, w.document) FROM work_items w
  WHERE NOT EXISTS (SELECT 1 FROM work_index i WHERE i.id = w.id AND i.projection = ${workIndexProjection}
    AND i.revision IS NOT DISTINCT FROM graphyard_number(w.document->'revision')::bigint);`,
});

/**
 * Every table, in an order a restore can insert without violating references: a table
 * appears after every table it references. A feature adds its tables to one module here.
 */
export const tables: readonly TableDefinition[] = [
  ...workTables, workIndex, ...delegationTables, ...operatorAgentTables, ...proofGrantTables,
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
export const ledgerSeeded = tables.filter(table => !table.cache && /\bINSERT INTO\b/i.test(table.ddl)).map(table => table.name);
