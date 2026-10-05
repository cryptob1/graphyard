import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Work } from '../model.js';
import type { IntegrationJob } from '../coordination.js';
import { appendSave, resolvedPayloadSql } from './snapshot-delta.js';
import { noteSaved } from './locked-read.js';
import { advisoryLocks } from './locks.js';
import { StaleWrite, lockItem, staleWriteAttempts, type StoreTransactionOptions } from './item-lock.js';
import { saveDocument } from './document-write.js';
export { saveDocument, rewriteDocument } from './document-write.js';
import { runStartupMigration } from './migration-locks.js';
// The startup migration's engine lives beside its locks and its recorded state (migration-locks.ts);
// the lock budget stays exported here with the store that applies it.
export { migrationAttemptLockTimeoutMs, migrationLockTimeoutMs } from './migration-locks.js';
import { coordinationDocumentSql, coordinationRelevance, coordinationTail, coordinationTrimSql, detoasted, type CoordinationTrim } from './coordination-sql.js';
import { namedPool, reportPool, type ReportPoolOptions } from './report-pool.js';
import { closePool, leasePoolConnections, trackedPool } from './pools.js';

export * from './snapshot-delta.js';
export * from './item-lock.js';
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
   * inside the health-check window. Each attempt waits for its locks at most
   * `attemptLockTimeoutMs` (3 s by default) before it gives up its place, so a live writer queued
   * behind the migration's exclusive lock request waits no longer than one attempt's budget. Startup then fails naming the lock, well inside the platform's
   * health window. The migration's own work is not timed: a backfill or index build that takes
   * longer than the lock budget (the offline `graphyard db migrate` Job) still completes.
   */
  async init(options: { lockTimeoutMs?: number; attemptLockTimeoutMs?: number } = {}) { return runStartupMigration(this.pool, options); }
  async schema() { return Number((await this.pool.query('SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version); }
  /** Resolves once every connection of all three pools has closed (GY-483), so the database may be stopped right after. */
  async close() { await Promise.all([closePool(this.pool, 'main'), closePool(this.leasePool, 'lease'), closePool(this.reportPool, 'report')]); }
  /**
   * Run `fn` in one transaction under the locks `options` name. A `StaleWrite` reruns the whole of
   * `fn` on a fresh transaction (up to `staleWriteAttempts` runs), so `fn` must keep its effects in
   * the database: an external call or in-memory change it makes is repeated by each rerun.
   */
  async transaction<T>(fn: (db: pg.PoolClient, now: Date) => Promise<T>, options: StoreTransactionOptions = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await this.transactionOnce(fn, options); } catch (error) {
        if (!(error instanceof StaleWrite) || options.retryStaleWrites === false || attempt >= staleWriteAttempts) throw error;
      }
    }
  }
  private async transactionOnce<T>(fn: (db: pg.PoolClient, now: Date) => Promise<T>, options: StoreTransactionOptions): Promise<T> {
    const { lane = 'request', itemLock } = options;
    const fleetLock = options.fleetLock ?? (options.coordinationLock !== false);
    const permit = lane === 'background' ? await this.background.acquire() : null;
    const db = await (lane === 'lease' ? this.leasePool : this.pool).connect().catch(error => { permit?.(); throw error; });
    try {
      await db.query('BEGIN');
      // Serializes coordination decisions: fleet lock first, then per-item lock in fixed order so no deadlock is possible (GY-1124).
      if (fleetLock) await db.query('SELECT pg_advisory_xact_lock($1)', [coordinationLock]);
      if (itemLock !== undefined && itemLock !== null) await lockItem(db, itemLock);
      const { rows } = await db.query('SELECT clock_timestamp() AS now');
      // Job wakes are taken last, in work-id order (GY-1115): see `wakeJob`.
      pendingWakes.set(db, new Map());
      const query = db.query; db.query = guardDeferredWakes(db, query);
      let result: T;
      try { result = await fn(db, rows[0].now); } finally { db.query = query; }
      const wakes = pendingWakes.get(db)!; pendingWakes.delete(db);
      await wakeJobs(db, [...wakes.keys()], [...wakes].filter(([, prioritized]) => prioritized).map(([id]) => id));
      await db.query('COMMIT');
      return result;
    } catch (error) { pendingWakes.delete(db); await db.query('ROLLBACK'); throw error; }
    finally { db.release(); permit?.(); }
  }
  async list(): Promise<Work[]> {
    return (await this.pool.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
  }
  /** One item's document by its id, without reading the fleet (GY-1052). */
  async workItem(id: string): Promise<Work | undefined> {
    return (await this.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0]?.document;
  }
  /**
   * The live merge-queue entries, which is all a queue position is computed from (GY-1052): the
   * filter is `queueOrder`'s own, a queue entry on an item not done, so `queuePlacement` over this
   * equals it over the whole fleet. Selected through the work index, so no unqueued item's
   * document is read; a settled item has no queue (`settledSql`), so none is read either.
   */
  async queuedWork(): Promise<Work[]> {
    return (await this.pool.query(`SELECT w.document FROM work_index i JOIN work_items w ON w.id=i.id
      WHERE i.stage IS DISTINCT FROM 'done' AND jsonb_typeof(w.document->'queue')='object' ORDER BY i.number`)).rows.map(row => row.document);
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
   * A job an observation webhook made due within `webhookWakeTtlMs` (GY-806) comes before all of
   * them, oldest delivery first; `webhook` says the claim is that wake, and the claim clears it.
   * The wake lives on the job row, so a replica that did not receive the delivery claims it first too.
   * `refreshed` says a webhook-driven observation refreshed the item until `refreshed_until`, still ahead.
   */
  async takeJob(order: string[] = [], headCount = 0, starvedAfterMs = observationStarvedAfterMs) {
    const token = randomUUID();
    const result = await this.pool.query(`WITH picked AS (SELECT work_id, generation<>claimed_generation AS woken, webhook_at > now() - ($5::text||' milliseconds')::interval AS webhook, refreshed_until > now() AS refreshed FROM jobs WHERE available_at<=now() AND (held_until IS NULL OR held_until<=now()) AND (locked_until IS NULL OR locked_until<now()) ORDER BY CASE WHEN webhook_at > now() - ($5::text||' milliseconds')::interval THEN -1 WHEN array_position($1::uuid[], work_id) <= $3::int THEN 0 WHEN available_at < now() - ($4::text||' milliseconds')::interval * 3 THEN 1 WHEN available_at < now() - ($4::text||' milliseconds')::interval THEN 2 WHEN array_position($1::uuid[], work_id) IS NOT NULL THEN 3 ELSE 4 END, CASE WHEN webhook_at > now() - ($5::text||' milliseconds')::interval THEN webhook_at END, CASE WHEN available_at < now() - ($4::text||' milliseconds')::interval * 3 THEN available_at END, array_position($1::uuid[], work_id), available_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE jobs SET token=$2, locked_until=now()+interval '90 seconds', attempts=attempts+1,claimed_generation=generation,webhook_at=NULL
      FROM picked WHERE jobs.work_id=picked.work_id RETURNING jobs.*, picked.woken, picked.webhook IS TRUE AS webhook, picked.refreshed IS TRUE AS refreshed`, [order.length ? order : null, token, Math.max(0, Math.floor(headCount)), String(Math.max(0, Math.floor(starvedAfterMs))), String(webhookWakeTtlMs)]);
    return result.rows[0] as { work_id: string; token: string; attempts: number; woken: boolean; webhook: boolean; refreshed: boolean; refreshed_until: Date | null } | undefined;
  }
  /** The items an observation webhook made due and no claim has taken yet (GY-806), oldest delivery first. */
  async webhookDue(): Promise<string[]> {
    return (await this.pool.query(`SELECT work_id FROM jobs WHERE webhook_at > now() - ($1::text||' milliseconds')::interval ORDER BY webhook_at, work_id`, [String(webhookWakeTtlMs)])).rows.map(row => String(row.work_id));
  }
  /**
   * A webhook-driven observation refreshed the item (GY-806): a poll claimed before `pollMs` has
   * passed is skipped. Recorded on the job row, so the replica that claims the poll sees it.
   */
  async noteWebhookRefresh(id: string, token: string, pollMs: number) {
    await this.pool.query(`UPDATE jobs SET refreshed_until=now()+($3::text||' milliseconds')::interval WHERE work_id=$1 AND token=$2`, [id, token, String(Math.max(0, Math.floor(pollMs)))]);
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
    const result = await this.pool.query(`WITH target AS (SELECT work_id FROM jobs WHERE (held_reason IS NOT NULL OR held_until IS NOT NULL) AND ($1::text IS NULL OR held_on IS NULL OR held_on<>$1::text) ORDER BY work_id FOR UPDATE)
      UPDATE jobs SET held_until=NULL,held_reason=NULL,held_on=NULL,refusals=0,available_at=now() FROM target WHERE jobs.work_id = target.work_id`, [installation]);
    return result.rowCount ?? 0;
  }
  /** Jobs currently parked on a permission shortfall, for status and attention reporting. */
  async heldJobs() {
    return (await this.pool.query('SELECT work_id,held_reason,held_until FROM jobs WHERE held_until>now() ORDER BY held_until')).rows as { work_id: string; held_reason: string; held_until: Date }[];
  }
  /** Observation jobs starved of observations three times in a row (GY-506), which `/api/status` reports and master status raises. */
  async starvedJobs() { return (await this.pool.query(`SELECT w.document->>'key' AS key, j.unobserved, j.error, j.deferred_reason FROM jobs j JOIN work_items w ON w.id=j.work_id WHERE j.unobserved>=3 AND w.id IN (SELECT id FROM work_index WHERE stage <> 'done') ORDER BY w.number LIMIT 50`)).rows as { key: string; unobserved: number; error: string | null; deferred_reason: string | null }[]; }
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

/** How long a webhook wake keeps its job ahead of polled jobs before it is dropped from the front (the job stays due). */
export const webhookWakeTtlMs = 10 * 60_000;
/** How long a due observation job may wait behind the claim-priority list before it is claimed first. */
export const observationStarvedAfterMs = 5 * 60_000;

/**
 * Wake the jobs a verified GitHub webhook delivery names (GY-806): every job when it moved the base
 * branch or a merge-queue ref (`all`), else the items whose pull request, candidate or speculative
 * tip SHA, or candidate branch it names. An observation event also stamps their webhook wake, which
 * `takeJob` on any replica claims ahead of polled jobs. Returns the woken work ids.
 */
export async function wakeFromWebhook(db: Pick<pg.PoolClient, 'query'>, subjects: { all: boolean; prs: number[]; shas: string[]; branches: string[] }, observation: boolean): Promise<string[]> {
  // The job rows are locked in work-id order first (GY-1115), the order every other job wake takes them in.
  const woken = await db.query(`WITH target AS (SELECT work_id FROM jobs WHERE $1::boolean OR work_id IN (SELECT id FROM work_items
    WHERE document->'submission'->>'pr' = ANY($2::text[]) OR document->'candidate'->>'sha' = ANY($3::text[]) OR document->'queue'->'speculation'->>'tip' = ANY($3::text[]) OR document->'candidate'->>'branch' = ANY($6::text[]))
    ORDER BY work_id FOR UPDATE)
    UPDATE jobs SET available_at=LEAST(available_at, now()),generation=generation+1,
    webhook_at=CASE WHEN $4::boolean AND (webhook_at IS NULL OR webhook_at <= now() - ($5::text||' milliseconds')::interval) THEN now() ELSE webhook_at END
    FROM target WHERE jobs.work_id = target.work_id RETURNING jobs.work_id`,
    [subjects.all, subjects.prs.map(String), subjects.shas, observation, String(webhookWakeTtlMs), subjects.branches]);
  return woken.rows.map(row => String(row.work_id));
}

/** The job wakes a `Store.transaction` has asked for and not yet taken, per connection, each with whether it is prioritized (GY-1115). */
const pendingWakes = new WeakMap<object, Map<string, boolean>>();
const jobsStatement = /\b(?:from|into|update|join)\s+jobs\b/i;
/** A transaction's `query`, refusing any statement on `jobs` once a wake is deferred (GY-1212): see `wakeJob`. */
function guardDeferredWakes(db: pg.PoolClient, query: pg.PoolClient['query']): pg.PoolClient['query'] {
  return ((text: unknown, ...rest: unknown[]) => {
    const sql = typeof text === 'string' ? text : (text as { text?: unknown } | null)?.text, wakes = pendingWakes.get(db);
    if (wakes?.size && typeof sql === 'string' && jobsStatement.test(sql)) return Promise.reject(new Error(`A jobs statement ran after this transaction deferred a job wake (${[...wakes.keys()].join(', ')}) (GY-1212)`));
    return (query as (...args: unknown[]) => unknown).call(db, text, ...rest);
  }) as pg.PoolClient['query'];
}
/**
 * Make an item's observation job due now. A wake never moves a job that is already due later: an
 * item saved every minute would otherwise look freshly due forever and never reach the starvation
 * bound `takeJob` claims ahead of the priority list (2026-09-26: items stuck for an hour on stale reads).
 * `prioritized` also stamps the job's webhook wake, so `takeJob` claims it ahead of the polled
 * backlog as it would a webhook's (GY-1099: a merge refused only for a stale observation). Like a
 * webhook's, a wake still standing keeps its stamp, so prioritized wakes are claimed oldest first.
 * Inside a `Store.transaction` the wake is taken just before COMMIT, with the transaction's other
 * wakes, in work-id order (GY-1115): every transaction then locks its item rows before any job row,
 * and job rows in one stable order, so a reconciliation batch, a resync and an observation can no
 * longer deadlock on a job row one of them took mid-way. A transaction's own statements on `jobs`
 * (an observation's own job, a delivered item's) must come before its first wake; a later one is
 * refused (GY-1212), as a read would miss the wake and a delete would see its row put back.
 */
export async function wakeJob(db: Pick<pg.PoolClient, 'query'>, id: string, prioritized = false) {
  const pending = pendingWakes.get(db);
  if (pending) pending.set(id, prioritized || pending.get(id) === true);
  else await wakeJobs(db, [id], prioritized ? [id] : []);
}
/** Make several items' observation jobs due in one statement, their rows locked in work-id order; those in `prioritized` are stamped as `wakeJob` stamps one. */
export async function wakeJobs(db: Pick<pg.PoolClient, 'query'>, ids: string[], prioritized: string[] = []) {
  if (!ids.length) return;
  await db.query(`INSERT INTO jobs(work_id,webhook_at) SELECT id, CASE WHEN id = ANY($2::uuid[]) THEN now() END FROM unnest($1::uuid[]) AS id ORDER BY id
    ON CONFLICT(work_id) DO UPDATE SET available_at=LEAST(jobs.available_at, now()),generation=jobs.generation+1,
    webhook_at=CASE WHEN EXCLUDED.webhook_at IS NOT NULL AND (jobs.webhook_at IS NULL OR jobs.webhook_at <= now() - ($3::text||' milliseconds')::interval) THEN now() ELSE jobs.webhook_at END`,
    [[...new Set(ids)].sort(), [...new Set(prioritized)], String(webhookWakeTtlMs)]);
}

export async function save(db: pg.PoolClient, work: Work, actor: string, kind: string, now: Date, details?: unknown) {
  const text = await saveDocument(db, work, now);
  noteSaved(work, text);
  // Stored as a delta on the item's last full snapshot when that is small (snapshot-delta.ts).
  await appendSave(db, work, actor, kind, details, text);
}
