import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import type { Work } from '../model.js';
import type { IntegrationJob } from '../coordination.js';
import { migration, tables } from './schema.js';
import { releaseInfo, schemaVersion } from '../release.js';
import { appendSave, resolvedPayloadSql } from './snapshot-delta.js';

export * from './snapshot-delta.js';

/**
 * How long the store waits for a pooled connection, and how long any one statement may run —
 * including the wait for the coordination lock, which is itself a statement (GY-185). Without them
 * a saturated pool queued every request behind it indefinitely: callers timed out on their own
 * clocks while the server kept working through requests nobody was waiting for any more. A bounded
 * wait fails the one request with a reason, and the pool drains.
 */
export const storeConnectionTimeoutMs = 10_000, storeStatementTimeoutMs = 60_000;
/** The history each coordination-view document keeps, applied in SQL (see `coordinationSnapshot`). */
const coordinationTail = 20;
const array = (path: string) => `(CASE WHEN jsonb_typeof(${path}) = 'array' THEN ${path} ELSE '[]'::jsonb END)`;
const tail = (path: string) => `(SELECT COALESCE(jsonb_agg(entry ORDER BY position), '[]'::jsonb) FROM jsonb_array_elements(${array(path)}) WITH ORDINALITY AS t(entry, position) WHERE position > jsonb_array_length(${array(path)}) - ${coordinationTail})`;
/**
 * What makes an evidence record one the coordination view can still consult (`coordinationWork` in
 * src/server/work-view.ts), gathered once per document as the lateral `r` from one read of its
 * top-level fields (each `d.document->` detoasts the whole document again): the candidate's head and base, the heads the open
 * review, the open producer requests and the recent dispatch requests name, and the records a
 * carry decision on the queue's tip or the base refresh carried.
 */
const coordinationRelevance = `LATERAL jsonb_to_record(d.document) AS f(candidate jsonb, "autoDispatch" jsonb, queue jsonb, "baseRefresh" jsonb)
  CROSS JOIN LATERAL (SELECT f.candidate->>'sha' AS head, f.candidate->>'baseSha' AS base,
    ARRAY(SELECT f."autoDispatch"->'review'->>'sha'
      UNION SELECT p.request->>'sha' FROM jsonb_array_elements(${array(`f."autoDispatch"->'producers'`)}) AS p(request)
      UNION SELECT h.request->>'sha' FROM jsonb_array_elements(${tail(`f."autoDispatch"->'history'`)}) AS h(request)) AS requested,
    ARRAY(SELECT c.carried->>'evidenceId' FROM jsonb_array_elements(${array("f.queue->'speculation'->'carry'->'evidence'")} || ${array(`f."baseRefresh"->'carry'->'evidence'`)}) AS c(carried)
      WHERE c.carried->'carried' = 'true'::jsonb) AS carried) AS r`;
/**
 * The evidence records the coordination view keeps, decided in SQL so a long history of superseded
 * heads never leaves the database: those on the candidate's exact head and base, those a carry
 * decision carried, and those on a head a request names. The view's own filter then applies the
 * exact rule (which carry applies to the candidate), so this keeps a superset of what it keeps.
 */
const relevantEvidence = `((entry->>'sha' = r.head AND entry->>'baseSha' IS NOT DISTINCT FROM r.base)
    OR entry->>'id' = ANY(r.carried) OR entry->>'sha' = ANY(r.requested))`;
const length = (path: string) => `(CASE WHEN jsonb_typeof(${path}) = 'array' THEN jsonb_array_length(${path}) ELSE 0 END)`;
const object = (path: string) => `jsonb_typeof(${path}) = 'object'`;
/**
 * One document as the coordination view reads it, built in SQL: the pipeline timeline dropped, the
 * observation without its per-file scope comparison, only the evidence records a coordinator
 * decision can still consult (`relevantEvidence`, read with `coordinationRelevance` joined as `r`),
 * each without its artifacts, scope digests and provenance, and the resolved dispatch requests,
 * queue history and resolved action rows cut to their most recent entries. The action queue's
 * history is the largest part of a long-lived document, and it never leaves the database whole.
 */
export const coordinationDocumentSql = `d.document - 'pipeline' - 'evidence' - 'observation' - 'queueHistory' - 'actionQueue' - 'autoDispatch'
  || jsonb_build_object('evidence', (SELECT COALESCE(jsonb_agg(entry - 'artifacts' - 'scopeFiles' - 'provenance' ORDER BY position), '[]'::jsonb) FROM jsonb_array_elements(${array("d.document->'evidence'")}) WITH ORDINALITY AS e(entry, position) WHERE ${relevantEvidence}))
  || CASE WHEN d.document ? 'observation' THEN jsonb_build_object('observation', CASE WHEN ${object("d.document->'observation'")} THEN (d.document->'observation') - 'scopeFiles' ELSE d.document->'observation' END) ELSE '{}'::jsonb END
  || CASE WHEN jsonb_typeof(d.document->'queueHistory') = 'array' THEN jsonb_build_object('queueHistory', ${tail("d.document->'queueHistory'")}) ELSE '{}'::jsonb END
  || CASE WHEN ${object("d.document->'actionQueue'")} THEN jsonb_build_object('actionQueue', ((d.document->'actionQueue') - 'history') || jsonb_build_object('history', ${tail("d.document->'actionQueue'->'history'")})) ELSE '{}'::jsonb END
  || CASE WHEN ${object("d.document->'autoDispatch'")} THEN jsonb_build_object('autoDispatch', ((d.document->'autoDispatch') - 'history') || jsonb_build_object('history', ${tail("d.document->'autoDispatch'->'history'")})) ELSE '{}'::jsonb END`;
/** What the SQL cut from each history, per item, so the view still says how much it left out. */
export interface CoordinationTrim { evidence: number; dispatchHistory: number; queueHistory: number; actionHistory: number }
/** The advisory lock every coordination transaction takes (Store.transaction). */
const coordinationLock = 71490321;
/** How long a migrating release may wait for locks in total: well inside Railway's 120-second health check. */
export const migrationLockTimeoutMs = 30_000;
/** The migration's statements ahead of the first table's DDL: the shared trigger function. */
const migrationPrelude = migration.slice(0, migration.indexOf(tables[0].ddl));
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
const newerSchema = (current: number) => new Error(`Database schema generation ${current} is newer than this release supports (${schemaVersion}); deploy the release that migrated it, or restore a backup taken at generation ${schemaVersion} or earlier`);

/** How long a migrating release waits for its watchdog's connection; a database at its limit refuses at once. */
const watchdogConnectMs = 5_000;
/** A pool connection, or an error after `watchdogConnectMs` without one (sooner than the pool's own `storeConnectionTimeoutMs`). */
async function reserve(pool: pg.Pool) {
  let timer: NodeJS.Timeout | undefined;
  const connecting = pool.connect();
  try {
    return await Promise.race([connecting, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no connection within ${watchdogConnectMs} ms`)), watchdogConnectMs); })]);
  } catch (error) {
    connecting.then(late => late.release(), () => {});
    throw error;
  } finally { clearTimeout(timer); }
}

export class Store {
  pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 12, connectionTimeoutMillis: storeConnectionTimeoutMs, statement_timeout: storeStatementTimeoutMs });
  }
  /**
   * Apply the additive migration and record the schema generation it reached. Running
   * against a database a newer release already migrated refuses: rolling the application
   * back under a schema it does not know is how columns and rows go missing silently.
   *
   * A release whose generation and migration are already recorded starts without any
   * coordination or table lock: it reads graphyard_schema and its comment (the digest of the
   * migration that last ran) and skips the DDL, so a new container never queues behind a busy
   * live replica. Only a release that must migrate takes the coordination lock, and every
   * lock wait of the migration shares one `lockTimeoutMs` deadline: each step's lock_timeout
   * is the time left, and a watchdog cancels any lock wait still running at the deadline, so
   * waits on the coordination lock, across tables, and between the statements of one table's
   * DDL never add up past it. The watchdog's connection is reserved before the migration begins,
   * and a migration that cannot reserve it, or loses it past the deadline, fails at once.
   * Startup then fails naming the lock, well inside the platform's
   * health window. The migration's own work is not timed: a backfill or index build that takes
   * longer than the lock budget (the offline `graphyard db migrate` Job) still completes.
   */
  async init(options: { lockTimeoutMs?: number } = {}) {
    const digest = `migration sha256:${createHash('sha256').update(migration).digest('hex')}`;
    const recorded = await this.recordedGeneration();
    if (recorded && recorded.version > schemaVersion) throw newerSchema(recorded.version);
    if (recorded?.version === schemaVersion && recorded.digest === digest) return;
    const timeout = Math.max(1, Math.floor(options.lockTimeoutMs ?? migrationLockTimeoutMs));
    const deadline = Date.now() + timeout;
    const db = await this.pool.connect();
    // The watchdog's connection is reserved before the migration begins: at the database's
    // connection limit, startup fails here, boundedly, rather than migrating without a deadline.
    let guard: pg.PoolClient;
    try { guard = await reserve(this.pool); } catch (error) {
      db.release();
      throw new Error(`Schema migration to generation ${schemaVersion} could not reserve the connection its lock-wait watchdog needs (${(error as Error).message}); startup fails instead of migrating without a deadline — retry the deploy`, { cause: error });
    }
    let lost: Error | undefined;
    const lose = (error: Error) => { lost ??= error; };
    guard.on('error', lose);
    guard.on('end', () => lose(new Error('Connection terminated')));
    let waitingOn = `the coordination advisory lock pg_advisory_xact_lock(${coordinationLock})`;
    // A watchdog that cannot run past the deadline aborts the migration: without it, lock waits
    // inside one step could restart lock_timeout without end.
    let abort!: (error: Error) => void, aborted: Error | undefined;
    const abandoned = new Promise<never>((_, reject) => { abort = error => { aborted ??= error; reject(error); }; });
    abandoned.catch(() => {});
    // Each step may wait for a lock only for what is left of the migration's single deadline.
    const step = async (waiting: string, sql: string, values?: unknown[]) => {
      waitingOn = waiting;
      await Promise.race([db.query(`SET LOCAL lock_timeout = ${Math.max(1, deadline - Date.now())}`), abandoned]);
      return Promise.race([db.query(sql, values), abandoned]);
    };
    // lock_timeout restarts for every lock one step's statements wait on; past the deadline
    // the watchdog cancels whichever lock wait is still running.
    let cancelledWaiting = false, watching = true, poll: NodeJS.Timeout | undefined, polling = Promise.resolve();
    const watch = async (pid: number) => {
      if (!watching) return;
      try {
        if (lost) throw lost;
        const { rows } = await guard.query("SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid]);
        if (rows[0]?.cancelled) cancelledWaiting = true;
        else if (watching) poll = setTimeout(() => { polling = watch(pid); }, 100);
      } catch (error) {
        if (watching) abort(new Error(`Schema migration to generation ${schemaVersion} lost the connection its lock-wait watchdog needs (${(error as Error).message}) past its ${timeout} ms deadline, while waiting for ${waitingOn}; startup fails instead of outlasting the health check — retry the deploy`, { cause: error }));
      }
    };
    try {
      await guard.query('SET application_name = \'graphyard migration watchdog\'');
      await guard.query('SET statement_timeout = 5000');
      const pid = Number((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      poll = setTimeout(() => { polling = watch(pid); }, Math.max(0, deadline - Date.now()));
      await db.query('BEGIN');
      // The pool's statement timeout bounds coordination reads and writes, not the migration's own
      // work: its lock waits share the deadline above, and a backfill or index build still completes.
      await db.query('SET LOCAL statement_timeout = 0');
      await step(waitingOn, 'SELECT pg_advisory_xact_lock($1)', [coordinationLock]);
      await step('a lock on the migration\'s shared function graphyard_immutable', migrationPrelude);
      for (const table of tables) await step(`a lock on table ${table.name} (or an object its migration touches)`, table.ddl);
      const current = Number((await step('a lock on table graphyard_schema', 'SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version);
      if (current > schemaVersion) throw newerSchema(current);
      if (current < schemaVersion) await step(waitingOn, 'INSERT INTO graphyard_schema(version, graphyard_version) VALUES($1,$2)', [schemaVersion, releaseInfo().version]);
      await step(waitingOn, `COMMENT ON TABLE graphyard_schema IS ${literal(digest)}`);
      await Promise.race([db.query('COMMIT'), abandoned]);
    } catch (error) {
      // An abandoned migration's connection is still busy: it is destroyed below, which rolls it back.
      if (aborted) throw aborted;
      await db.query('ROLLBACK').catch(() => {});
      // 55P03: a lock wait hit the time left; 57014 after the watchdog fired: it cancelled a lock wait past the deadline.
      const code = (error as { code?: string }).code;
      if (code === '55P03' || (code === '57014' && cancelledWaiting)) throw new Error(`Schema migration to generation ${schemaVersion} gave up after ${timeout} ms waiting for ${waitingOn}, held by another session (usually the live replica); startup fails instead of outlasting the health check — retry the deploy when the live replica is idle`, { cause: error });
      throw error;
    } finally {
      // A cancel still in flight must not reach whatever this connection runs next.
      watching = false; clearTimeout(poll); await polling;
      db.release(aborted ? true : undefined);
      // The watchdog's session settings must not follow its connection back into the pool.
      guard.release(true);
    }
  }
  /** The recorded generation and migration digest, read without any lock a replica holds; null before the first migration. */
  private async recordedGeneration(): Promise<{ version: number; digest: string | null } | null> {
    const table = (await this.pool.query("SELECT to_regclass('graphyard_schema') AS oid")).rows[0].oid;
    if (!table) return null;
    const { rows } = await this.pool.query("SELECT COALESCE((SELECT MAX(version) FROM graphyard_schema),0) AS version, obj_description(to_regclass('graphyard_schema'),'pg_class') AS digest");
    return { version: Number(rows[0].version), digest: rows[0].digest };
  }
  async schema() { return Number((await this.pool.query('SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version); }
  async close() { await this.pool.end(); }
  async transaction<T>(fn: (db: pg.PoolClient, now: Date) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
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
    finally { db.release(); }
  }
  async list(): Promise<Work[]> {
    return (await this.pool.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document);
  }
  async workSnapshot(): Promise<{ work: Work[]; now: string; jobs: IntegrationJob[] }> {
    const row = (await this.pool.query("SELECT COALESCE(jsonb_agg(document ORDER BY number), '[]'::jsonb) AS work, statement_timestamp() AS observed_at, (SELECT COALESCE(jsonb_agg(jsonb_build_object('work_id',work_id,'available_at',available_at,'locked_until',locked_until,'error',error,'held_until',held_until)), '[]'::jsonb) FROM jobs) AS jobs FROM work_items")).rows[0];
    return { work: row.work, now: row.observed_at.toISOString(), jobs: row.jobs };
  }
  /**
   * The work snapshot as the coordination view reads it, trimmed in SQL (`coordinationDocumentSql`)
   * rather than after every whole document was loaded, with how much each item's histories lost.
   * The master loop, the dispatcher and every executor poll this; the full snapshot stays for the
   * readers that derive reports from whole documents.
   */
  async coordinationSnapshot(): Promise<{ work: Work[]; now: string; jobs: IntegrationJob[]; trimmed: Map<string, CoordinationTrim> }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const rows = (await client.query(`SELECT ${coordinationDocumentSql} AS document,
        ${length("d.document->'evidence'")} AS evidence_total,
        GREATEST(0, ${length("d.document->'autoDispatch'->'history'")} - ${coordinationTail}) AS dispatch_history,
        GREATEST(0, ${length("d.document->'queueHistory'")} - ${coordinationTail}) AS queue_history,
        GREATEST(0, ${length("d.document->'actionQueue'->'history'")} - ${coordinationTail}) AS action_history
        FROM work_items d CROSS JOIN ${coordinationRelevance} ORDER BY d.number`)).rows;
      const meta = (await client.query("SELECT statement_timestamp() AS observed_at, (SELECT COALESCE(jsonb_agg(jsonb_build_object('work_id',work_id,'available_at',available_at,'locked_until',locked_until,'error',error,'held_until',held_until)), '[]'::jsonb) FROM jobs) AS jobs")).rows[0];
      await client.query('COMMIT');
      const trimmed = new Map<string, CoordinationTrim>(rows.map(row => [row.document.id, { evidence: Number(row.evidence_total) - row.document.evidence.length, dispatchHistory: Number(row.dispatch_history), queueHistory: Number(row.queue_history), actionHistory: Number(row.action_history) }]));
      return { work: rows.map(row => row.document), now: meta.observed_at.toISOString(), jobs: meta.jobs, trimmed };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async events(id?: string) {
    // A delta row reads as the full row it stands for (snapshot-delta.ts).
    return (await this.pool.query(`SELECT seq, work_id, actor, kind, ${resolvedPayloadSql()} AS payload, created_at FROM events WHERE ($1::uuid IS NULL OR work_id=$1) ORDER BY seq DESC LIMIT 300`, [id ?? null])).rows;
  }
  /**
   * Claim the next due job. `woken` says the claim follows a webhook delivery (the generation
   * moved since the job was last claimed) rather than the schedule its last run set: a woken job
   * is observed at once whatever its cadence and whatever is left of the GitHub budget.
   */
  async takeJob() {
    const token = randomUUID();
    const result = await this.pool.query(`WITH picked AS (SELECT work_id, generation<>claimed_generation AS woken FROM jobs WHERE available_at<=now() AND (held_until IS NULL OR held_until<=now()) AND (locked_until IS NULL OR locked_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE jobs SET token=$1, locked_until=now()+interval '90 seconds', attempts=attempts+1,claimed_generation=generation
      FROM picked WHERE jobs.work_id=picked.work_id RETURNING jobs.*, picked.woken`, [token]);
    return result.rows[0] as { work_id: string; token: string; attempts: number; woken: boolean } | undefined;
  }
  /**
   * Release a job with its next due time. A clean run comes back at the observation cadence its
   * item's state earned (`availableInMs`, GY-117; twenty seconds when the caller sets none), a
   * failed one after 45 seconds, and a concurrency retry after two. A webhook that arrived during
   * the run has moved the generation, and the job comes back at once whatever was asked.
   */
  async finishJob(id: string, token: string, error?: string, retry = false, availableInMs?: number) {
    const scheduled = availableInMs === undefined ? null : String(Math.max(0, Math.floor(availableInMs)));
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=$3,held_until=NULL,held_reason=NULL,held_on=NULL,refusals=CASE WHEN $3::text IS NULL THEN 0 ELSE refusals END,
      available_at=now()+ CASE WHEN generation<>claimed_generation THEN interval '0 seconds' WHEN $4::boolean THEN interval '2 seconds' WHEN $5::text IS NOT NULL THEN ($5::text||' milliseconds')::interval WHEN $3::text IS NULL THEN interval '20 seconds' ELSE interval '45 seconds' END
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, error ?? null, retry, scheduled]);
  }
  /**
   * Parks a job that needs a permission the App does not hold. Webhook wakeups move
   * `available_at` but never lift a hold; only a preflight that sees a different installation
   * or the hold's own bounded expiry lets the job run again, so a missing permission costs one
   * attempt per hold. `heldOn` is the installation the hold was decided against
   * (`installationFingerprint`), so a preflight that merely re-reads the same installation
   * does not release it.
   */
  async holdJob(id: string, token: string, reason: string, holdMs: number, heldOn: string | null = null) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=$3,held_reason=$3,held_on=$5,held_until=now()+($4::text||' milliseconds')::interval,available_at=now()+($4::text||' milliseconds')::interval
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, reason, String(Math.max(0, Math.floor(holdMs))), heldOn]);
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
  async deferJob(id: string, token: string, until: string) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=NULL,
      available_at=CASE WHEN generation<>claimed_generation THEN now() ELSE $3::timestamptz END
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, until]);
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

export async function wakeJob(db: pg.PoolClient, id: string) {
  await db.query('INSERT INTO jobs(work_id) VALUES($1) ON CONFLICT(work_id) DO UPDATE SET available_at=now(),generation=jobs.generation+1', [id]);
}

export async function save(db: pg.PoolClient, work: Work, actor: string, kind: string, now: Date, details?: unknown) {
  work.revision++;
  work.updatedAt = now.toISOString();
  await db.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(work)]);
  // Stored as a delta on the item's last full snapshot when that is small (snapshot-delta.ts).
  await appendSave(db, work, actor, kind, details);
}
