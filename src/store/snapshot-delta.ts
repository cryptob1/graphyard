import type pg from 'pg';
import type { Lease, Observation, Work } from '../model.js';
import { DELIVERY_EVENT_PREDICATE } from './tables/production.js';

/**
 * Ledger rows stored as a delta against the item's last full snapshot.
 *
 * Every save appends the work document it produced. Copying the whole document for each of
 * the continuous writes — reconciliation passes, lease renewals, action-queue claims and
 * failures, dispatch and loop bookkeeping — was nearly all of the ledger's growth, though each
 * changes a few fields. A save of any kind is therefore stored as `payload.delta` when the item
 * has a recent full snapshot: `base` (that snapshot's `seq`), the replay fields (`revision`,
 * `updatedAt`, `lease`, `submission`) and `ops`, the edits that turn the base into this
 * document. Deltas are always taken against the full snapshot, never chained, so any row is
 * one base lookup away from its document (`applyWorkDelta`, and `graphyard_event_work` in SQL).
 *
 * A full snapshot is written for the first save, every `snapshotEvery` rows, when the delta
 * would exceed `deltaSizeFraction` of the document, when the stage or delivery changed (so
 * lifecycle rows stay whole), and for an item's first accepted-delivery observation (the row
 * the shipping pulse indexes). Nothing is updated or deleted: the ledger stays append-only.
 *
 * Rows written before this generalisation carry a clock-only delta (`observation`, `lease`,
 * no `ops`); both readers still resolve them.
 */
export const snapshotEvery = 50;
export const deltaSizeFraction = 0.25;

export type DeltaPath = (string | number)[];
/** `[path, value]` sets a value (appending when the index is an array's length); `[path]` removes an object key. */
export type DeltaOp = [DeltaPath, unknown] | [DeltaPath];
export interface WorkDelta {
  /** The `seq` of the full snapshot this row extends. */
  base: number;
  revision: number;
  updatedAt: string;
  lease: Lease | null;
  submission: Work['submission'] | null;
  ops: DeltaOp[];
}
/** The clock-only delta rows written before `ops` existed. */
export interface SnapshotDelta {
  base: number;
  revision: number;
  updatedAt: string;
  observation: { at: string; clockOffset: Observation['clockOffset'] | null } | null;
  lease: Lease | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((entry, index) => equal(entry, b[index]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
  }
  return false;
}
function diff(base: unknown, next: unknown, path: DeltaPath, ops: DeltaOp[]) {
  if (equal(base, next)) return;
  if (isObject(base) && isObject(next)) {
    for (const key of Object.keys(base)) if (!Object.prototype.hasOwnProperty.call(next, key)) ops.push([[...path, key]]);
    for (const key of Object.keys(next)) {
      if (Object.prototype.hasOwnProperty.call(base, key)) diff(base[key], next[key], [...path, key], ops);
      else ops.push([[...path, key], next[key]]);
    }
    return;
  }
  if (Array.isArray(base) && Array.isArray(next) && path.length && next.length >= base.length) {
    base.forEach((entry, index) => diff(entry, next[index], [...path, index], ops));
    for (let index = base.length; index < next.length; index++) ops.push([[...path, index], next[index]]);
    return;
  }
  ops.push([path, next]);
}
/** The edits that turn `base` into `next`; both are JSON documents. */
export function workDiff(base: Work, next: Work): DeltaOp[] {
  const ops: DeltaOp[] = [];
  diff(base, next, [], ops);
  return ops;
}
export function workDelta(baseSeq: number, base: Work, work: Work): WorkDelta {
  return { base: baseSeq, revision: work.revision, updatedAt: work.updatedAt, lease: work.lease ?? null, submission: work.submission ?? null, ops: workDiff(base, work) };
}

/** The full document a delta row stands for, given the full snapshot it names. Handles both delta formats. */
export function applyWorkDelta(base: Work, delta: WorkDelta | SnapshotDelta): Work {
  const work: any = structuredClone(base);
  if ('ops' in delta) {
    for (const op of delta.ops) {
      const path = op[0];
      let parent: any = work;
      for (const key of path.slice(0, -1)) parent = parent?.[key];
      if (!parent || typeof parent !== 'object') continue;
      const key = path[path.length - 1];
      if (op.length === 1) { if (!Array.isArray(parent)) delete parent[key]; continue; }
      if (Array.isArray(parent)) { const index = Number(key); if (index >= parent.length) parent.push(op[1]); else parent[index] = op[1]; }
      else parent[key] = op[1];
    }
    return work;
  }
  work.revision = delta.revision; work.updatedAt = delta.updatedAt;
  if (work.observation && delta.observation) {
    work.observation.at = delta.observation.at;
    if (delta.observation.clockOffset) work.observation.clockOffset = delta.observation.clockOffset; else delete work.observation.clockOffset;
  }
  if (work.lease && delta.lease) work.lease = { ...work.lease, expiresAt: delta.lease.expiresAt };
  return work;
}

/**
 * The SQL twin of `applyWorkDelta`, installed with the events table: an event's full document
 * from its own `payload`, whether it carries the document whole or a delta on a full snapshot.
 * `graphyard_work_at_revision` finds the document an item held at a revision: the exact full
 * snapshot by index, else the delta row within `snapshotEvery` rows of its base.
 */
export const eventWorkFunctions = `CREATE OR REPLACE FUNCTION graphyard_event_work(p_work uuid, p_payload jsonb) RETURNS jsonb
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $fn$
DECLARE d jsonb; result jsonb; op jsonb; path text[];
BEGIN
  IF p_payload ? 'work' THEN RETURN p_payload->'work'; END IF;
  d := p_payload->'delta';
  IF d IS NULL THEN RETURN NULL; END IF;
  SELECT e.payload->'work' INTO result FROM events e WHERE e.seq=(d->>'base')::bigint AND e.work_id=p_work;
  IF result IS NULL THEN RETURN NULL; END IF;
  IF d ? 'ops' THEN
    FOR op IN SELECT value FROM jsonb_array_elements(d->'ops') WITH ORDINALITY ORDER BY ordinality LOOP
      path := ARRAY(SELECT jsonb_array_elements_text(op->0));
      IF jsonb_array_length(op) = 1 THEN
        IF jsonb_typeof(result #> path[1:array_length(path,1)-1]) = 'object' THEN result := result #- path; END IF;
      ELSE result := jsonb_set(result, path, op->1, true); END IF;
    END LOOP;
    RETURN result;
  END IF;
  result := jsonb_set(jsonb_set(result, '{revision}', d->'revision'), '{updatedAt}', d->'updatedAt');
  IF jsonb_typeof(result->'observation')='object' AND jsonb_typeof(d->'observation')='object' THEN
    result := jsonb_set(result, '{observation,at}', d->'observation'->'at');
    IF jsonb_typeof(d->'observation'->'clockOffset')='object' THEN result := jsonb_set(result, '{observation,clockOffset}', d->'observation'->'clockOffset');
    ELSE result := result #- '{observation,clockOffset}'; END IF;
  END IF;
  IF jsonb_typeof(result->'lease')='object' AND jsonb_typeof(d->'lease')='object' THEN result := jsonb_set(result, '{lease,expiresAt}', d->'lease'->'expiresAt'); END IF;
  RETURN result;
END $fn$;
CREATE OR REPLACE FUNCTION graphyard_work_at_revision(p_work uuid, p_revision text) RETURNS jsonb
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $fn$
DECLARE found jsonb; base_seq bigint;
BEGIN
  SELECT e.payload->'work' INTO found FROM events e WHERE e.work_id=p_work AND e.payload ? 'work' AND e.payload->'work'->>'revision'=p_revision ORDER BY e.seq DESC LIMIT 1;
  IF found IS NOT NULL OR p_revision IS NULL OR p_revision !~ '^[0-9]{1,15}$' THEN RETURN found; END IF;
  SELECT max(e.seq) INTO base_seq FROM events e WHERE e.work_id=p_work AND e.payload ? 'work'
    AND e.payload->'work'->>'revision' = ANY(ARRAY(SELECT (p_revision::bigint - g)::text FROM generate_series(1, ${snapshotEvery}) g));
  IF base_seq IS NULL THEN RETURN NULL; END IF;
  SELECT graphyard_event_work(x.work_id, x.payload) INTO found
    FROM (SELECT e.work_id, e.payload FROM events e WHERE e.work_id=p_work AND e.seq>base_seq ORDER BY e.seq LIMIT ${snapshotEvery}) x
    WHERE x.payload ? 'delta' AND x.payload->'delta'->>'revision'=p_revision LIMIT 1;
  RETURN found;
END $fn$;`;

/** An event's full document in SQL, for a row of `events` under `alias`. */
export const eventWorkSql = (alias = 'events') => `graphyard_event_work(${alias}.work_id, ${alias}.payload)`;
/** An event's payload with a delta replaced by the document it stands for: the shape every full row has. */
export const resolvedPayloadSql = (alias = 'events') =>
  `CASE WHEN ${alias}.payload ? 'delta' THEN (${alias}.payload - 'delta') || jsonb_build_object('work', ${eventWorkSql(alias)}) ELSE ${alias}.payload END`;

/** The one ledger read a save makes: the item's last full snapshot and how many rows followed it. */
export const snapshotBaseSql = `SELECT b.seq, b.payload->'work' AS work, (SELECT count(*)::int FROM events n WHERE n.work_id=$1 AND n.seq>b.seq) AS since
    FROM events b WHERE b.work_id=$1 AND b.payload ? 'work' ORDER BY b.seq DESC LIMIT 1`;
/**
 * Append one save to the ledger: a delta on the item's last full snapshot when it is small
 * and recent, the whole document otherwise.
 */
export async function appendSave(db: pg.PoolClient, work: Work, actor: string, kind: string, details?: unknown) {
  const document: Work = JSON.parse(JSON.stringify(work));
  const full = JSON.stringify({ work: document, details });
  const base = (await db.query(snapshotBaseSql, [work.id])).rows[0] as { seq: string; work: Work; since: number } | undefined;
  let row = full;
  if (base?.work && base.since < snapshotEvery && base.work.stage === document.stage && equal(base.work.delivery ?? null, document.delivery ?? null)
    && !(kind === 'github.observed' && document.delivery?.mergedAt && !(await db.query(`SELECT 1 FROM events WHERE work_id=$1 AND ${DELIVERY_EVENT_PREDICATE} LIMIT 1`, [work.id])).rows.length)) {
    const delta = JSON.stringify({ delta: workDelta(Number(base.seq), base.work, document), details });
    if (delta.length <= full.length * deltaSizeFraction) row = delta;
  }
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor, kind, row]);
}

/**
 * The record as it stood at the newest ledger row before `before` that `keep` accepts, resolved
 * from a delta when the row is one. Rows are resolved newest first, a few at a time, and the walk
 * stops at the first accepted one.
 */
export async function documentBefore(db: pg.PoolClient, workId: string, before: Date, keep: (work: Work) => boolean): Promise<Work | undefined> {
  let below: string | null = null;
  for (;;) {
    const rows = (await db.query(`SELECT seq, ${eventWorkSql()} AS work FROM (SELECT seq, work_id, payload FROM events WHERE work_id=$1 AND created_at<$2 AND ($3::bigint IS NULL OR seq<$3)
      AND (payload ? 'work' OR payload ? 'delta') ORDER BY seq DESC LIMIT 8) events ORDER BY seq DESC`, [workId, before, below])).rows as { seq: string; work: Work | null }[];
    if (!rows.length) return undefined;
    const kept = rows.find(row => row.work && keep(row.work));
    if (kept) return kept.work!;
    below = rows.at(-1)!.seq;
  }
}

/** Event count and stored payload bytes by kind over the last `minutes`, from the created_at index. */
export async function eventStats(db: Pick<pg.Pool, 'query'>, minutes = 60) {
  const result = await db.query(`SELECT kind, count(*)::int AS count, COALESCE(sum(pg_column_size(payload)),0)::bigint AS bytes,
      count(*) FILTER (WHERE payload ? 'delta')::int AS deltas, clock_timestamp() AS now
    FROM events WHERE created_at > now() - make_interval(mins => $1::int) GROUP BY kind ORDER BY bytes DESC, kind`, [minutes]);
  const kinds = result.rows.map(row => ({ kind: row.kind as string, count: Number(row.count), bytes: Number(row.bytes), deltas: Number(row.deltas) }));
  return { windowMinutes: minutes, observedAt: ((result.rows[0]?.now as Date | undefined) ?? new Date()).toISOString(),
    count: kinds.reduce((sum, entry) => sum + entry.count, 0), bytes: kinds.reduce((sum, entry) => sum + entry.bytes, 0), kinds };
}
