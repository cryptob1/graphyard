// Concern: reading the ledger rows the fold reads — the event kinds, the window's rows, and the document fields each row embeds.
import type pg from 'pg';
import type { Work } from '../model.js';
import type { ReworkGroundsWork } from '../rework-grounds.js';
import { applyWorkDelta, type DeltaOp } from '../store/snapshot-delta.js';
import { extendedGrounds, interventionLedgerSince, reworkGroundsSql, windowOutcomes, withDecisionsBeyondReach } from '../intervention-exemptions.js';

/** The event kinds the fold reads. Every other row of the ledger is left unread. */
export const interventionLedgerKinds = [
  'rework', 'decision.requested', 'decision.approved', 'decision.applied', 'decision.failed', 'decision.withdrawn', 'decision.stale', 'decision.declined', 'decision.superseded',
  'scope', 'autoscope', 'requirements', 'blocked', 'unblock',
  'merge.reconciliation.refused', 'merge.operator-authorized', 'merge.reconciled',
  'quarantine', 'settle', 'autosettle', 'recover', 'lease.expired', 'escalation.resolved',
  'human.requested', 'human.answered', 'intervention.recorded', 'judgement.recorded',
] as const;
/** The newest rows of those kinds a reading folds; older signals are outside the report's reach and the report says so. */
export const interventionLedgerLimit = 20_000;
/** One ledger row as the fold reads it: the typed details, and the few document paths the row embeds. */
export interface InterventionLedgerRow {
  seq: number; workId: string | null; actor: string; kind: string; at: string;
  details: any; payload?: any;
  /** The stage the item's latest earlier row recorded: the stage the item was in when this row's command ran. */
  stageBefore?: string | null;
  /** On a `rework` row only: the document fields its grounds are read from (`routineReworkGround`, GY-1386). */
  grounds?: ReworkGroundsWork | null;
  work?: { key?: string | null; stage?: string | null; title?: string | null; epoch?: number | null; blocker?: string | null; plannedFiles?: string[] | null; quarantine?: unknown; escalations?: { trigger: string; at: string; reason: string; actor: string }[] | null; candidate?: { sha: string; pr: number } | null; submission?: { epoch: number; pr: number } | null } | null;
}
type Db = { query: pg.Pool['query'] };
/** A provider or ledger instant in the one form the report compares: ISO with milliseconds. */
export const instant = (value: unknown, fallback: string) => { const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback; };
/** The document fields the fold reads (`InterventionLedgerRow['work']`), with the document field each comes from. */
const workFields = [['key', 'key'], ['stage', 'stage'], ['title', 'title'], ['epoch', 'epoch'], ['blocker', 'blocker'], ['plannedFiles', 'plannedFiles'],
  ['quarantine', 'containmentQuarantine'], ['escalations', 'escalations'], ['candidate', 'candidate'], ['submission', 'submission']] as const;
/** Those fields and `updatedAt`, projected from a stored document in SQL, so a whole document never leaves the database. */
const projectedWork = (document: string) => `CASE WHEN jsonb_typeof(${document})='object' THEN jsonb_build_object(${[...workFields.map(([, field]) => field), 'updatedAt'].map(field => `'${field}', ${document}->'${field}'`).join(', ')}) END`;
const projectedFields = new Set<unknown>([...workFields.map(([, field]) => field), 'updatedAt']);
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
/** The row's `work` as the fold reads it, from the projected document (null fields where the document has none). */
const workOf = (document: Record<string, any> | null): InterventionLedgerRow['work'] =>
  Object.fromEntries(workFields.map(([name, field]) => [name, document?.[field] ?? null])) as InterventionLedgerRow['work'];
/**
 * The newest `limit` rows of the kinds the fold reads, in ledger order; with `since`, only those
 * written from that instant on (GY-422). A report reads its window this way — the rows come from
 * the (kind, created_at) index, so a ledger of any age costs what the window holds.
 *
 * Nothing is rebuilt per row (GY-491). Three set reads, then one pass in ledger order:
 * - the window's rows, with a whole row's document projected to the fields the fold reads and a
 *   delta row's delta as stored;
 * - the full snapshots those deltas extend, each read once however many rows share it, projected
 *   the same way; each delta's edits are applied to its snapshot's projection
 *   (`applyWorkDelta`, the twin of the SQL `graphyard_event_work`);
 * - each item's stage timeline across its span of the window: the stage of every row that carries
 *   a whole document, and of the last one before the span.
 *
 * The stage before a row is the stage of the item's newest earlier row that carries a document,
 * whole or as a delta. A delta is only ever written on the item's newest whole row and only when
 * the stage is unchanged (`appendSave`, under the coordination lock every ledger write takes), so
 * that stage is the stage of the item's newest earlier whole row — read from the timeline.
 */
export async function readInterventionLedger(db: Db, options: { limit?: number; workId?: string | null; since?: string | null } = {}): Promise<{ rows: InterventionLedgerRow[]; truncated: boolean }> {
  const limit = options.limit ?? interventionLedgerLimit;
  const columns = `seq, work_id, actor, kind, created_at, payload->'details' AS details,
      CASE WHEN kind LIKE 'decision.%' OR kind IN ('intervention.recorded','judgement.recorded') THEN payload ELSE NULL END AS top,
      payload ? 'work' AS whole, ${projectedWork("payload->'work'")} AS work, CASE WHEN payload ? 'work' THEN NULL ELSE payload->'delta' END AS delta,
      CASE WHEN kind = 'rework' AND payload ? 'work' THEN ${reworkGroundsSql("payload->'work'")} END AS grounds`;
  // A window is read kind by kind through the (kind, created_at) index, then ordered (GY-1381).
  // As one `kind = ANY` filter, or as `kind = k AND created_at >= since`, the planner walked the
  // primary key or the created_at index through every routine row the window holds — a busy
  // week's heartbeats — to find the few it reads. The bounds are written as row comparisons on
  // (kind, created_at), which only that index serves, and `OFFSET 0` keeps each kind's read a
  // subquery of its own so it is not flattened back into that walk.
  const result = options.since
    ? await db.query(`SELECT windowed.* FROM unnest($1::text[], $4::timestamptz[]) AS wanted(kind, since)
        CROSS JOIN LATERAL (SELECT ${columns} FROM events
          WHERE (kind, created_at) >= (wanted.kind, wanted.since) AND (kind, created_at) <= (wanted.kind, 'infinity'::timestamptz) AND ($3::uuid IS NULL OR work_id=$3) OFFSET 0) windowed
        ORDER BY seq DESC LIMIT $2`, [[...interventionLedgerKinds], limit + 1, options.workId ?? null, interventionLedgerKinds.map(kind => interventionLedgerSince(kind, options.since!))])
    : await db.query(`SELECT ${columns} FROM events WHERE kind = ANY($1) AND ($3::uuid IS NULL OR work_id=$3) ORDER BY seq DESC LIMIT $2`, [[...interventionLedgerKinds], limit + 1, options.workId ?? null]);
  const truncated = result.rows.length > limit;
  let window = result.rows.slice(0, limit).reverse();
  if (options.since) window = await withDecisionsBeyondReach(db, windowOutcomes(window, options.since), columns);

  // The full snapshots the window's deltas extend, once each.
  const bases = new Map<number, { workId: string | null; work: Record<string, any> | null; grounds: Record<string, any> | null }>();
  const baseSeqs = [...new Set(window.flatMap(row => row.work_id && isObject(row.delta) && Number.isSafeInteger(Number(row.delta.base)) ? [Number(row.delta.base)] : []))];
  // A rework delta's base also yields its grounds fields (GY-1386), extended by the delta's ops on them.
  const groundBases = new Set(window.flatMap(row => row.kind === 'rework' && isObject(row.delta) ? [Number(row.delta.base)] : []));
  if (baseSeqs.length) for (const row of (await db.query(`SELECT seq, work_id, ${projectedWork("payload->'work'")} AS work, CASE WHEN seq = ANY($2::bigint[]) THEN ${reworkGroundsSql("payload->'work'")} END AS grounds FROM events WHERE seq = ANY($1::bigint[])`, [baseSeqs, [...groundBases]])).rows)
    bases.set(Number(row.seq), { workId: row.work_id, work: row.work, grounds: row.grounds ?? null });

  // Each item's stage timeline over its span of the window, and the whole row before that span.
  const spans = new Map<string, { from: number; to: number }>();
  for (const row of window) if (row.work_id) { const seq = Number(row.seq), span = spans.get(row.work_id); if (!span) spans.set(row.work_id, { from: seq, to: seq }); else span.to = seq; }
  const timelines = new Map<string, { seq: number; stage: string | null }[]>();
  if (spans.size) {
    const ids = [...spans.keys()], from = ids.map(id => spans.get(id)!.from), to = ids.map(id => spans.get(id)!.to);
    const stages = await db.query(`SELECT s.id AS work_id, e.seq, e.payload->'work'->>'stage' AS stage
        FROM unnest($1::uuid[], $2::bigint[], $3::bigint[]) AS s(id, from_seq, to_seq)
        JOIN events e ON e.work_id = s.id AND e.seq >= s.from_seq AND e.seq < s.to_seq AND e.payload ? 'work'
      UNION ALL
      SELECT s.id, before.seq, before.stage FROM unnest($1::uuid[], $2::bigint[]) AS s(id, from_seq)
        CROSS JOIN LATERAL (SELECT e.seq, e.payload->'work'->>'stage' AS stage FROM events e WHERE e.work_id = s.id AND e.seq < s.from_seq AND e.payload ? 'work' ORDER BY e.seq DESC LIMIT 1) before`, [ids, from, to]);
    for (const row of stages.rows) { const list = timelines.get(row.work_id) ?? []; list.push({ seq: Number(row.seq), stage: row.stage ?? null }); timelines.set(row.work_id, list); }
    for (const list of timelines.values()) list.sort((a, b) => a.seq - b.seq);
  }

  // One pass in ledger order: each item's timeline is walked forward alongside its rows.
  const cursors = new Map<string, number>();
  const rows = window.map((row): InterventionLedgerRow => {
    const seq = Number(row.seq);
    let document: Record<string, any> | null = null, grounds: Record<string, any> | null = row.grounds ?? null;
    if (row.whole) document = row.work ?? null;
    else if (row.work_id && isObject(row.delta)) {
      const base = bases.get(Number(row.delta.base));
      if (base && base.workId === row.work_id && isObject(base.work)) {
        const delta = Array.isArray(row.delta.ops) ? { ...row.delta, ops: row.delta.ops.filter((op: DeltaOp) => projectedFields.has(op[0]?.[0])) } : row.delta;
        document = applyWorkDelta(base.work as Work, delta) as unknown as Record<string, any>;
      }
      if (row.kind === 'rework' && base && base.workId === row.work_id && isObject(base.grounds)) grounds = extendedGrounds(base.grounds, row.delta);
    }
    let stageBefore: string | null = null;
    if (row.work_id) {
      const timeline = timelines.get(row.work_id) ?? [];
      let cursor = cursors.get(row.work_id) ?? -1;
      while (cursor + 1 < timeline.length && timeline[cursor + 1].seq < seq) cursor++;
      cursors.set(row.work_id, cursor);
      stageBefore = cursor >= 0 ? timeline[cursor].stage : null;
    }
    // A row written with the document carries the transaction instant the document's own
    // timestamps use (`updatedAt`); a raw row has only its insertion instant.
    const updatedAt = document?.updatedAt == null ? null : typeof document.updatedAt === 'string' ? document.updatedAt : JSON.stringify(document.updatedAt);
    return { seq, workId: row.work_id, actor: row.actor, kind: row.kind, at: instant(updatedAt, new Date(row.created_at).toISOString()), details: row.details, payload: row.top ?? undefined,
      work: row.whole || document ? workOf(document) : null, stageBefore, ...(row.kind === 'rework' ? { grounds: grounds as ReworkGroundsWork | null } : {}) };
  });
  return { rows, truncated };
}
