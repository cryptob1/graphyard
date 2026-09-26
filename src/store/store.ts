import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Work } from '../model.js';
import type { IntegrationJob } from '../coordination.js';
import { appendSave, resolvedPayloadSql } from './snapshot-delta.js';
import { advisoryLocks } from './locks.js';
import { runStartupMigration } from './migration-locks.js';
// The startup migration's engine lives beside its locks and its recorded state (migration-locks.ts);
// the lock budget stays exported here with the store that applies it.
export { migrationLockTimeoutMs } from './migration-locks.js';
import { coordinationDocumentSql, coordinationRelevance, coordinationTail, coordinationTrimSql, detoasted, type CoordinationTrim } from './coordination-sql.js';
import { namedPool, reportPool, type ReportPoolOptions } from './report-pool.js';
import { closePool, leasePoolConnections, trackedPool } from './pools.js';

export * from './snapshot-delta.js';
export type { CoordinationTrim } from './coordination-sql.js';

/**
 * How long the store waits for a pooled connection, and how long any one statement may run —
 * including the wait for the coordination lock, which is itself a statement (GY-185). Without them
 * a saturated pool queued every request behind it indefinitely: callers timed out on their own
 * clocks while the server kept working through requests nobody was waiting for any more. A bounded
 * wait fails the one request with a reason, and the pool drains.
 */
export const storeConnectionTimeoutMs = 10_000, storeStatementTimeoutMs = 60_000;
const coordinationLock = advisoryLocks.coordination;

/**
 * Which connections a transaction may use (GY-274). Lease commands run on the lease pool (pools.ts, GY-558),
 * so a saturated main pool never lets a live worker's lease lapse; background work (the reconciliation
 * tick, whose first pass after a deploy ran 65 s) holds at most half the main pool.
 */
export type StoreLane = 'request' | 'lease' | 'background';
/** A counting semaphore over the background share; a waiter inherits a released permit directly. */
export class BackgroundLane {
  private held = 0; private waiting: (() => void)[] = []; constructor(readonly limit: number) {}
  get inUse() { return this.held; }
  async acquire() {
    if (this.held >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve)); else this.held++;
    let released = false;
    return () => { if (released) return; released = true; const next = this.waiting.shift(); if (next) next(); else this.held--; };
  }
}

export class Store {
  pool: pg.Pool;
  /** Lease commands only (pools.ts `leaseCommands`); `background` bounds the tick to half the main pool; `reportPool` serves report reads only (report-pool.ts). */
  leasePool: pg.Pool; readonly background: BackgroundLane; reportPool: pg.Pool;
  constructor(url: string, options: { max?: number; leaseMax?: number } & ReportPoolOptions = {}) {
    const max = Math.max(2, Math.floor(options.max ?? 12));
    this.pool = namedPool(url, max, storeConnectionTimeoutMs, storeStatementTimeoutMs);
    this.leasePool = trackedPool(new pg.Pool({ connectionString: url, max: Math.max(1, Math.floor(options.leaseMax ?? leasePoolConnections)), connectionTimeoutMillis: storeConnectionTimeoutMs, statement_timeout: storeStatementTimeoutMs }));
    this.background = new BackgroundLane(Math.max(1, Math.floor(max / 2))); this.reportPool = reportPool(url, options, storeConnectionTimeoutMs, storeStatementTimeoutMs);
  }
  /**
   * Apply the additive migration and record the schema generation it reached. Running
   * against a database a newer release already migrated refuses: rolling the application
   * back under a schema it does not know is how columns and rows go missing silently.
   *
   * A release whose generation, prelude and every table's DDL are already recorded starts
   * without any coordination or table lock: it reads graphyard_schema and its comment (the
   * digest of the migration that last ran, with a digest per table, GY-773) and skips the
   * DDL, so a new container never queues behind a busy live replica. A release that must
   * migrate takes a lock — the migration lock, never the coordination lock (GY-203) — but
   * touches only the tables whose DDL is not already recorded: a table whose recorded digest
   * matches this release's is skipped without any lock at all, so `ALTER TABLE ... ADD COLUMN
   * IF NOT EXISTS` and a trigger rebuild on receipts never hold up the writes that stream
   * through an unchanged events table. A release whose whole-migration digest is recorded at
   * this generation but whose per-table digests are not records them alone: a matching whole
   * digest proves every table's DDL ran, so the upgrade itself takes no lock on a work table.
   *
   * Every lock wait of the migration shares one `lockTimeoutMs` deadline: each step's
   * lock_timeout is the time left, and a watchdog cancels any lock wait still running at the
   * deadline, so waits on the migration lock, across tables, and between the statements of one
   * table's DDL never add up past it. The watchdog's connection is reserved before the migration
   * begins, and a migration that cannot reserve it, or loses it past the deadline, fails at once.
   * A deadlock or an expired lock wait under live traffic (40P01, 55P03, the watchdog's 57014) is
   * transient: the attempt rolls back — releasing every lock at once, so live requests queue
   * behind a failed attempt no longer — and retries with backoff while the deadline allows, all
   * inside the health-check window. Startup then fails naming the lock, well inside the platform's
   * health window. The migration's own work is not timed: a backfill or index build that takes
   * longer than the lock budget (the offline `graphyard db migrate` Job) still completes.
   */
  async init(options: { lockTimeoutMs?: number } = {}) { return runStartupMigration(this.pool, options); }
  async schema() { return Number((await this.pool.query('SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version); }
  /** Resolves once every connection of all three pools has closed (GY-483), so the database may be stopped right after. */
  async close() { await Promise.all([closePool(this.pool, 'main'), closePool(this.leasePool, 'lease'), closePool(this.reportPool, 'report')]); }
  async transaction<T>(fn: (db: pg.PoolClient, now: Date) => Promise<T>, { lane = 'request' }: { lane?: StoreLane } = {}): Promise<T> {
    const permit = lane === 'background' ? await this.background.acquire() : null;
    const db = await (lane === 'lease' ? this.leasePool : this.pool).connect().catch(error => { permit?.(); throw error; });
    try {
      await db.query('BEGIN');
      // Serializes short coordination decisions across replicas, including dependency edits
      // and cross-task workspace reservations. Never hold this lock during external I/O.
      await db.query('SELECT pg_advisory_xact_lock($1)', [coordinationLock]);
      const { rows } = await db.query('SELECT clock_timestamp() AS now');
      const result = await fn(db, rows[0].now);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); permit?.(); }
  }
  async list(): Promise<Work[]> {
    return (await this.pool.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
  }
  async workSnapshot(): Promise<{ work: Work[]; now: string; jobs: IntegrationJob[] }> {
    const row = (await this.pool.query("SELECT COALESCE(jsonb_agg(document ORDER BY number), '[]'::jsonb) AS work, statement_timestamp() AS observed_at, (SELECT COALESCE(jsonb_agg(jsonb_build_object('work_id',work_id,'available_at',available_at,'locked_until',locked_until,'error',error,'held_until',held_until,'deferred_reason',deferred_reason,'unobserved',unobserved)), '[]'::jsonb) FROM jobs) AS jobs FROM work_items")).rows[0];
    return { work: row.work, now: row.observed_at.toISOString(), jobs: row.jobs };
  }
  /**
   * The work snapshot as the coordination view reads it, trimmed in SQL (`coordinationDocumentSql`)
   * rather than after every whole document was loaded, with how much each item's histories lost.
   * A settled delivery comes from the work index (src/store/tables/work-index.ts), read in the same
   * snapshot, so only the live items' documents are read at all (GY-203).
   * The master loop, the dispatcher and every executor poll this; the full snapshot stays for the
   * readers that derive reports from whole documents.
   */
  async coordinationSnapshot(): Promise<{ work: Work[]; now: string; jobs: IntegrationJob[]; trimmed: Map<string, CoordinationTrim> }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // A settled delivery is served from the work index (GY-203): its document is never read.
      // Every other item's document is trimmed in SQL, and only those documents are read.
      const settled = (await client.query('SELECT number, summary AS document, trimmed FROM work_index WHERE settled')).rows;
      const live = (await client.query(`SELECT d.number, x.document, ${coordinationTrimSql('x.document', coordinationTail)} AS trimmed
        FROM (SELECT w.number, ${detoasted('w.document')} AS document FROM work_items w WHERE NOT EXISTS (SELECT 1 FROM work_index i WHERE i.id = w.id AND i.settled) OFFSET 0) d
        CROSS JOIN ${coordinationRelevance(coordinationTail)} CROSS JOIN LATERAL (SELECT ${coordinationDocumentSql} AS document) x`)).rows;
      const rows = [...settled, ...live].sort((a, b) => Number(a.number) - Number(b.number));
      const meta = (await client.query("SELECT statement_timestamp() AS observed_at, (SELECT COALESCE(jsonb_agg(jsonb_build_object('work_id',work_id,'available_at',available_at,'locked_until',locked_until,'error',error,'held_until',held_until,'deferred_reason',deferred_reason,'unobserved',unobserved)), '[]'::jsonb) FROM jobs) AS jobs")).rows[0];
      await client.query('COMMIT');
      const trimmed = new Map<string, CoordinationTrim>(rows.map(row => [row.document.id, row.trimmed as CoordinationTrim]));
      return { work: rows.map(row => row.document), now: meta.observed_at.toISOString(), jobs: meta.jobs, trimmed };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async events(id?: string) {
    // A delta row reads as the full row it stands for (snapshot-delta.ts).
    return (await this.pool.query(`SELECT seq, work_id, actor, kind, ${resolvedPayloadSql()} AS payload, created_at FROM events WHERE ($1::uuid IS NULL OR work_id=$1) ORDER BY seq DESC LIMIT 300`, [id ?? null])).rows;
  }
  /**
   * Claim the next due job. `order` names work ids in claim-priority order (GY-492) — the
   * merge-queue head and its batch, then items whose next action waits on an observation; the
   * unnamed keep the available_at order. `woken` says the claim follows a webhook delivery, observed at once.
   * The first `headCount` named ids (the queue-head band) always come first; after them any job due
   * for longer than `starvedAfterMs` is claimed before the rest of the named list, so a job the list
   * never names is still claimed within that bound (2026-09-26: an item whose only refusal was a stale
   * observation waited 40 minutes behind review-waiting items that came due again every cycle).
   */
  async takeJob(order: string[] = [], headCount = 0, starvedAfterMs = observationStarvedAfterMs) {
    const token = randomUUID();
    const result = await this.pool.query(`WITH picked AS (SELECT work_id, generation<>claimed_generation AS woken FROM jobs WHERE available_at<=now() AND (held_until IS NULL OR held_until<=now()) AND (locked_until IS NULL OR locked_until<now()) ORDER BY CASE WHEN array_position($1::uuid[], work_id) <= $3::int THEN 0 WHEN available_at < now() - ($4::text||' milliseconds')::interval THEN 1 WHEN array_position($1::uuid[], work_id) IS NOT NULL THEN 2 ELSE 3 END, array_position($1::uuid[], work_id), available_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE jobs SET token=$2, locked_until=now()+interval '90 seconds', attempts=attempts+1,claimed_generation=generation
      FROM picked WHERE jobs.work_id=picked.work_id RETURNING jobs.*, picked.woken`, [order.length ? order : null, token, Math.max(0, Math.floor(headCount)), String(Math.max(0, Math.floor(starvedAfterMs)))]);
    return result.rows[0] as { work_id: string; token: string; attempts: number; woken: boolean } | undefined;
  }
  /**
   * Release a job with its next due time: a clean run at its observation cadence (`availableInMs`, GY-117), a failure after 45 seconds, a retry after two, a woken run at once.
   */
  async finishJob(id: string, token: string, error?: string, retry = false, availableInMs?: number, observed?: boolean) {
    const scheduled = availableInMs === undefined ? null : String(Math.max(0, Math.floor(availableInMs)));
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=$3,held_until=NULL,held_reason=NULL,held_on=NULL,deferred_reason=NULL,refusals=CASE WHEN $3::text IS NULL THEN 0 ELSE refusals END, unobserved=CASE WHEN $6::boolean IS TRUE THEN 0 WHEN $6::boolean IS FALSE THEN unobserved+1 ELSE unobserved END,
      available_at=now()+ CASE WHEN generation<>claimed_generation THEN interval '0 seconds' WHEN $4::boolean THEN interval '2 seconds' WHEN $5::text IS NOT NULL THEN ($5::text||' milliseconds')::interval WHEN $3::text IS NULL THEN interval '20 seconds' ELSE interval '45 seconds' END WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, error ?? null, retry, scheduled, observed ?? null]);
  }
  /**
   * Parks a job that needs a permission the App does not hold. Webhook wakeups move
   * `available_at` but never lift a hold; only a preflight that sees a different installation
   * or the hold's own bounded expiry lets the job run again, so a missing permission costs one
   * attempt per hold. `heldOn` is the installation it was decided against (so re-reading it releases nothing); `observed` feeds the GY-506 count.
   */
  async holdJob(id: string, token: string, reason: string, holdMs: number, heldOn: string | null = null, observed: boolean = false) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=$3,held_reason=$3,held_on=$5,held_until=now()+($4::text||' milliseconds')::interval,available_at=now()+($4::text||' milliseconds')::interval,deferred_reason=NULL, unobserved=CASE WHEN $6::boolean IS TRUE THEN 0 WHEN $6::boolean IS FALSE THEN unobserved+1 ELSE unobserved END
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, reason, String(Math.max(0, Math.floor(holdMs))), heldOn, observed]);
  }
  /** A permission refusal retries at the ordinary cadence a bounded number of times, then holds. */
  async refuseJob(id: string, token: string, reason: string, limit: number, holdMs: number, heldOn: string | null = null) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=$3,refusals=refusals+1,
      held_reason=CASE WHEN refusals+1>=$4::int THEN $3 ELSE NULL END,
      held_on=CASE WHEN refusals+1>=$4::int THEN $6::text ELSE NULL END,
      held_until=CASE WHEN refusals+1>=$4::int THEN now()+($5::text||' milliseconds')::interval ELSE NULL END,
      available_at=CASE WHEN refusals+1>=$4::int THEN now()+($5::text||' milliseconds')::interval ELSE now()+interval '45 seconds' END
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, reason, limit, String(Math.max(0, Math.floor(holdMs))), heldOn]);
  }
  /**
   * Once the preflight sees every declared permission, held jobs run again immediately — except
   * a job held against this very installation state (`heldOn` equal to `installation`): its
   * 403 is one the declaration does not explain, and re-reading an unchanged installation is
   * not a reason to attempt it again. Such a job waits for its bounded expiry or for the
   * installation to change. Without an installation every hold is released.
   */
  async releaseHeldJobs(installation: string | null = null) {
    const result = await this.pool.query(`UPDATE jobs SET held_until=NULL,held_reason=NULL,held_on=NULL,refusals=0,available_at=now()
      WHERE (held_reason IS NOT NULL OR held_until IS NOT NULL) AND ($1::text IS NULL OR held_on IS NULL OR held_on<>$1::text)`, [installation]);
    return result.rowCount ?? 0;
  }
  /** Jobs currently parked on a permission shortfall, for status and attention reporting. */
  async heldJobs() {
    return (await this.pool.query('SELECT work_id,held_reason,held_until FROM jobs WHERE held_until>now() ORDER BY held_until')).rows as { work_id: string; held_reason: string; held_until: Date }[];
  }
  /** Observation jobs starved of observations three times in a row (GY-506), which `/api/status` reports and master status raises. */
  async starvedJobs() { return (await this.pool.query(`SELECT w.document->>'key' AS key, j.unobserved, j.error, j.deferred_reason FROM jobs j JOIN work_items w ON w.id=j.work_id WHERE j.unobserved>=3 AND w.document->>'stage'<>'done' ORDER BY w.number LIMIT 50`)).rows as { key: string; unobserved: number; error: string | null; deferred_reason: string | null }[]; }
  /** A concurrency retry: back within seconds, never an operator error, never silent (GY-506). */
  async retryJob(id: string, token: string, reason: string, observed: boolean) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=NULL,held_until=NULL,held_reason=NULL,held_on=NULL,deferred_reason=$3,refusals=0, unobserved=CASE WHEN $4::boolean IS TRUE THEN 0 WHEN $4::boolean IS FALSE THEN unobserved+1 ELSE unobserved END, available_at=now()+interval '2 seconds' WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, reason, observed]);
  }
  /** Reschedules past a deferral, keeping its reason on the job record (GY-506); `observed` null leaves the starvation count as it is. */
  async deferJob(id: string, token: string, until: string, reason?: string, observed: boolean | null = false) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=NULL,deferred_reason=$4, unobserved=CASE WHEN $5::boolean IS TRUE THEN 0 WHEN $5::boolean IS FALSE THEN unobserved+1 ELSE unobserved END, available_at=CASE WHEN generation<>claimed_generation THEN now() ELSE $3::timestamptz END
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, until, reason ?? null, observed]);
  }
  /**
   * Whether GitHub's webhook is actually delivering: the last verified delivery recorded and the
   * count in the last hour. Own-App check deliveries are ignored before they are recorded, so this
   * counts the deliveries that can wake a job.
   */
  async webhookLiveness() {
    const row = (await this.pool.query("SELECT max(created_at) AS last, count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS last_hour FROM webhook_receipts")).rows[0];
    return { lastDeliveryAt: row.last ? (row.last as Date).toISOString() : null, lastHour: Number(row.last_hour) };
  }
}

/** How long a due observation job may wait behind the claim-priority list before it is claimed first. */
export const observationStarvedAfterMs = 5 * 60_000;

/**
 * Make an item's observation job due now. A wake never moves a job that is already due later: an
 * item saved every minute would otherwise look freshly due forever and never reach the starvation
 * bound `takeJob` claims ahead of the priority list (2026-09-26: items stuck for an hour on stale reads).
 */
export async function wakeJob(db: pg.PoolClient, id: string) {
  await db.query('INSERT INTO jobs(work_id) VALUES($1) ON CONFLICT(work_id) DO UPDATE SET available_at=LEAST(jobs.available_at, now()),generation=jobs.generation+1', [id]);
}

export async function save(db: pg.PoolClient, work: Work, actor: string, kind: string, now: Date, details?: unknown) {
  work.revision++;
  work.updatedAt = now.toISOString();
  await db.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(work)]);
  // Stored as a delta on the item's last full snapshot when that is small (snapshot-delta.ts).
  await appendSave(db, work, actor, kind, details);
}
