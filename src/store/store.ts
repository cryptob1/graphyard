import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Work } from '../model.js';
import type { IntegrationJob } from '../coordination.js';
import { migration } from './schema.js';
import { releaseInfo, schemaVersion } from '../release.js';

export class Store {
  pool: pg.Pool;
  constructor(url: string) { this.pool = new pg.Pool({ connectionString: url, max: 12 }); }
  /**
   * Apply the additive migration and record the schema generation it reached. Running
   * against a database a newer release already migrated refuses: rolling the application
   * back under a schema it does not know is how columns and rows go missing silently.
   */
  async init() {
    await this.transaction(async db => {
      await db.query(migration);
      const current = Number((await db.query('SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version);
      if (current > schemaVersion) throw new Error(`Database schema generation ${current} is newer than this release supports (${schemaVersion}); deploy the release that migrated it, or restore a backup taken at generation ${schemaVersion} or earlier`);
      if (current < schemaVersion) await db.query('INSERT INTO graphyard_schema(version, graphyard_version) VALUES($1,$2)', [schemaVersion, releaseInfo().version]);
    });
  }
  async schema() { return Number((await this.pool.query('SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version); }
  async close() { await this.pool.end(); }
  async transaction<T>(fn: (db: pg.PoolClient, now: Date) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      // Serializes short coordination decisions across replicas, including dependency edits
      // and cross-task workspace reservations. Never hold this lock during external I/O.
      await db.query('SELECT pg_advisory_xact_lock(71490321)');
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
  async events(id?: string) {
    return (await this.pool.query('SELECT * FROM events WHERE ($1::uuid IS NULL OR work_id=$1) ORDER BY seq DESC LIMIT 300', [id ?? null])).rows;
  }
  async takeJob() {
    const token = randomUUID();
    const result = await this.pool.query(`UPDATE jobs SET token=$1, locked_until=now()+interval '90 seconds', attempts=attempts+1,claimed_generation=generation
      WHERE work_id=(SELECT work_id FROM jobs WHERE available_at<=now() AND (held_until IS NULL OR held_until<=now()) AND (locked_until IS NULL OR locked_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`, [token]);
    return result.rows[0] as { work_id: string; token: string; attempts: number } | undefined;
  }
  /** `settleSeconds` is the re-poll delay after a success; the caller slows it for candidates not about to merge. */
  async finishJob(id: string, token: string, error?: string, retry = false, settleSeconds = 20) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=$3,held_until=NULL,held_reason=NULL,held_on=NULL,refusals=CASE WHEN $3::text IS NULL THEN 0 ELSE refusals END,
      available_at=now()+ CASE WHEN generation<>claimed_generation THEN interval '0 seconds' WHEN $4::boolean THEN interval '2 seconds' WHEN $3::text IS NULL THEN make_interval(secs => $5::int) ELSE interval '45 seconds' END
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, error ?? null, retry, settleSeconds]);
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
}

export async function wakeJob(db: pg.PoolClient, id: string) {
  await db.query('INSERT INTO jobs(work_id) VALUES($1) ON CONFLICT(work_id) DO UPDATE SET available_at=now(),generation=jobs.generation+1', [id]);
}

export async function save(db: pg.PoolClient, work: Work, actor: string, kind: string, now: Date, details?: unknown) {
  work.revision++;
  work.updatedAt = now.toISOString();
  await db.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(work)]);
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor, kind, JSON.stringify({ work, details })]);
}
