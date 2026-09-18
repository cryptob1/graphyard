import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Work } from './model.js';
import type { IntegrationJob } from './coordination.js';

export const migration = `
CREATE TABLE IF NOT EXISTS work_items (
  id uuid PRIMARY KEY, number bigserial UNIQUE, document jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq bigserial PRIMARY KEY, work_id uuid REFERENCES work_items(id),
  actor text NOT NULL, kind text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS events_work ON events(work_id,seq);
CREATE OR REPLACE FUNCTION graphyard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'The event ledger is append-only'; END $$;
DROP TRIGGER IF EXISTS immutable_events ON events;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();
CREATE TABLE IF NOT EXISTS receipts (
  actor text NOT NULL, key text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(actor,key)
);
CREATE TABLE IF NOT EXISTS operator_agents (
  id text PRIMARY KEY, document jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS operator_credentials (
  agent_id text NOT NULL REFERENCES operator_agents(id), fingerprint text NOT NULL,
  token_hash text NOT NULL UNIQUE, valid_from timestamptz NOT NULL, valid_until timestamptz,
  revoked_at timestamptz, PRIMARY KEY(agent_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS proof_grants (
  principal_id text PRIMARY KEY, document jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS proof_grant_history (
  seq bigserial PRIMARY KEY, principal_id text NOT NULL, document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS immutable_proof_grant_history ON proof_grant_history;
CREATE TRIGGER immutable_proof_grant_history BEFORE UPDATE OR DELETE ON proof_grant_history FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();
CREATE TABLE IF NOT EXISTS jobs (
  work_id uuid PRIMARY KEY REFERENCES work_items(id), available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz, token uuid, attempts int NOT NULL DEFAULT 0, error text
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS held_until timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS held_reason text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS refusals int NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS webhook_receipts (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS validation_definitions (
  kind text NOT NULL, id text NOT NULL, revision int NOT NULL, document jsonb NOT NULL,
  PRIMARY KEY(kind,id,revision)
);
DROP TRIGGER IF EXISTS immutable_validation_definitions ON validation_definitions;
CREATE TRIGGER immutable_validation_definitions BEFORE UPDATE OR DELETE ON validation_definitions FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();
CREATE TABLE IF NOT EXISTS validation_builds (id uuid PRIMARY KEY, document jsonb NOT NULL);
DROP TRIGGER IF EXISTS immutable_validation_builds ON validation_builds;
CREATE TRIGGER immutable_validation_builds BEFORE UPDATE OR DELETE ON validation_builds FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();
CREATE TABLE IF NOT EXISTS validation_candidates (id uuid PRIMARY KEY, document jsonb NOT NULL);
DROP TRIGGER IF EXISTS immutable_validation_candidates ON validation_candidates;
CREATE TRIGGER immutable_validation_candidates BEFORE UPDATE OR DELETE ON validation_candidates FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();
CREATE TABLE IF NOT EXISTS validation_requests (id uuid PRIMARY KEY, document jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS validation_definition_page ON validation_definitions ((document->>'createdAt') DESC,kind DESC,id DESC,revision DESC);
CREATE INDEX IF NOT EXISTS validation_request_page ON validation_requests ((document->>'createdAt') DESC,id DESC);
CREATE INDEX IF NOT EXISTS validation_request_state ON validation_requests ((document->>'state'));
CREATE TABLE IF NOT EXISTS validation_artifacts (
  id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES validation_requests(id),
  attempt_id uuid NOT NULL, name text NOT NULL, digest text NOT NULL,
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  media_type text NOT NULL, bytes bytea, deleted_at timestamptz,
  UNIQUE(request_id,attempt_id,name)
);
CREATE INDEX IF NOT EXISTS validation_artifact_expiry ON validation_artifacts(expires_at) WHERE bytes IS NOT NULL;
CREATE TABLE IF NOT EXISTS validation_resources (resource text PRIMARY KEY, request_id uuid NOT NULL REFERENCES validation_requests(id));
CREATE TABLE IF NOT EXISTS scenarios (id text NOT NULL, revision int NOT NULL, document jsonb NOT NULL, PRIMARY KEY(id,revision));
DROP TRIGGER IF EXISTS immutable_scenarios ON scenarios;
CREATE TRIGGER immutable_scenarios BEFORE UPDATE OR DELETE ON scenarios FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();
`;

export class Store {
  pool: pg.Pool;
  constructor(url: string) { this.pool = new pg.Pool({ connectionString: url, max: 12 }); }
  async init() { await this.transaction(async db => { await db.query(migration); }); }
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
  async finishJob(id: string, token: string, error?: string, retry = false) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=$3,held_until=NULL,held_reason=NULL,refusals=CASE WHEN $3::text IS NULL THEN 0 ELSE refusals END,
      available_at=now()+ CASE WHEN generation<>claimed_generation THEN interval '0 seconds' WHEN $4::boolean THEN interval '2 seconds' WHEN $3::text IS NULL THEN interval '20 seconds' ELSE interval '45 seconds' END
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, error ?? null, retry]);
  }
  /**
   * Parks a job that needs a permission the App does not hold. Webhook wakeups move
   * `available_at` but never lift a hold; only a passing preflight or the hold's own bounded
   * expiry lets the job run again, so a missing permission costs one attempt per hold.
   */
  async holdJob(id: string, token: string, reason: string, holdMs: number) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=$3,held_reason=$3,held_until=now()+($4::text||' milliseconds')::interval,available_at=now()+($4::text||' milliseconds')::interval
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, reason, String(Math.max(0, Math.floor(holdMs)))]);
  }
  /** A permission refusal retries at the ordinary cadence a bounded number of times, then holds. */
  async refuseJob(id: string, token: string, reason: string, limit: number, holdMs: number) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=$3,refusals=refusals+1,
      held_reason=CASE WHEN refusals+1>=$4::int THEN $3 ELSE NULL END,
      held_until=CASE WHEN refusals+1>=$4::int THEN now()+($5::text||' milliseconds')::interval ELSE NULL END,
      available_at=CASE WHEN refusals+1>=$4::int THEN now()+($5::text||' milliseconds')::interval ELSE now()+interval '45 seconds' END
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, reason, limit, String(Math.max(0, Math.floor(holdMs)))]);
  }
  /** Once the preflight sees every declared permission, held jobs run again immediately. */
  async releaseHeldJobs() {
    const result = await this.pool.query('UPDATE jobs SET held_until=NULL,held_reason=NULL,refusals=0,available_at=now() WHERE held_reason IS NOT NULL OR held_until IS NOT NULL');
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
