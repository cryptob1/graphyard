import type pg from 'pg';
import type { Lease, Observation, Work } from '../model.js';

/**
 * Routine ledger rows stored as a delta against the item's last full snapshot.
 *
 * Every save appends the whole work document to the ledger. Two kinds are written continuously
 * — one `github.observed` per reconciliation pass (every 20 s to 5 min per item) and one
 * `heartbeat` per worker renewal (every 30 s per lease) — and on a steady item they change
 * nothing but a clock: the observation's `at` (and its measured clock offset) or the lease's
 * `expiresAt`, plus the write counter and `updatedAt`. Copying the whole document for that was
 * most of the ledger's growth.
 *
 * Such a row now carries `payload.delta` instead of `payload.work`: the sequence number of the
 * full snapshot it extends (`base`) and the current value of every volatile field. The full
 * document is `base` with those fields applied (`applySnapshotDelta`). A row is written this way
 * only when the document equals the base snapshot on every other field, so a reader that looks
 * for the latest `payload ? 'work'` row still reads a document identical to the record in
 * everything but those clocks. Every other kind — decisions, merges, deliveries, interventions,
 * evidence, leases being claimed or lost — keeps its full snapshot. Nothing is updated or
 * deleted: the ledger stays append-only.
 */
export const deltaEventKinds: readonly string[] = ['github.observed', 'heartbeat'];

export interface SnapshotDelta {
  /** The `seq` of the full snapshot this row extends. */
  base: number;
  revision: number;
  updatedAt: string;
  observation: { at: string; clockOffset: Observation['clockOffset'] | null } | null;
  lease: Lease | null;
}

/** The document with every volatile field removed: what must match the base for a delta row. */
function settled(work: any): any {
  const copy = JSON.parse(JSON.stringify(work));
  delete copy.revision; delete copy.updatedAt;
  if (copy.observation && typeof copy.observation === 'object') { delete copy.observation.at; delete copy.observation.clockOffset; }
  if (copy.lease && typeof copy.lease === 'object') delete copy.lease.expiresAt;
  return copy;
}
/** Key-order-independent serialisation: jsonb reorders object keys, a live document does not. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sameBeyondVolatile(work: Work, base: Work): boolean {
  return canonical(settled(work)) === canonical(settled(base));
}
export function snapshotDelta(base: number, work: Work): SnapshotDelta {
  return { base, revision: work.revision, updatedAt: work.updatedAt,
    observation: work.observation ? { at: work.observation.at, clockOffset: work.observation.clockOffset ?? null } : null,
    lease: work.lease ? { ...work.lease } : null };
}
/** The full document a delta row stands for. `keepRevision` leaves the base's revision and `updatedAt`. */
export function applySnapshotDelta(base: Work, delta: SnapshotDelta, options: { keepRevision?: boolean } = {}): Work {
  const work = structuredClone(base);
  if (!options.keepRevision) { work.revision = delta.revision; work.updatedAt = delta.updatedAt; }
  if (work.observation && delta.observation) {
    work.observation.at = delta.observation.at;
    if (delta.observation.clockOffset) work.observation.clockOffset = delta.observation.clockOffset; else delete work.observation.clockOffset;
  }
  if (work.lease && delta.lease) work.lease = { ...work.lease, expiresAt: delta.lease.expiresAt };
  return work;
}

/**
 * Append one save to the ledger: a delta row for a routine kind whose document differs from the
 * item's last full snapshot only in volatile fields, the whole document otherwise.
 */
export async function appendSave(db: pg.PoolClient, work: Work, actor: string, kind: string, details?: unknown) {
  if (deltaEventKinds.includes(kind)) {
    const base = (await db.query("SELECT seq, payload->'work' AS work FROM events WHERE work_id=$1 AND payload ? 'work' ORDER BY seq DESC LIMIT 1", [work.id])).rows[0];
    if (base?.work && sameBeyondVolatile(work, base.work)) {
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor, kind, JSON.stringify({ delta: snapshotDelta(Number(base.seq), work), details })]);
      return;
    }
  }
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor, kind, JSON.stringify({ work, details })]);
}

/**
 * The record as it stood at the newest ledger row satisfying `full` (a full snapshot), with the
 * clocks the delta rows written on it before `before` carried forward. The revision stays the
 * full snapshot's: it is the one the ledger holds whole, so a delivery citing it can be read back.
 */
export async function withLatestDelta(db: pg.PoolClient, workId: string, base: { seq: number | string; work: Work } | undefined, before: Date): Promise<Work | undefined> {
  if (!base) return undefined;
  const delta = (await db.query("SELECT payload->'delta' AS delta FROM events WHERE work_id=$1 AND seq>$2 AND created_at<$3 AND payload ? 'delta' AND payload->'delta'->>'base'=$4 ORDER BY seq DESC LIMIT 1",
    [workId, base.seq, before, String(base.seq)])).rows[0]?.delta as SnapshotDelta | undefined;
  return delta ? applySnapshotDelta(base.work, delta, { keepRevision: true }) : base.work;
}
