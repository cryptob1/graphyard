import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Work } from './model.js';

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
CREATE TABLE IF NOT EXISTS jobs (
  work_id uuid PRIMARY KEY REFERENCES work_items(id), available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz, token uuid, attempts int NOT NULL DEFAULT 0, error text
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_generation bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS webhook_receipts (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
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
  async workSnapshot(): Promise<{ work: Work[]; now: string }> {
    const row = (await this.pool.query("SELECT COALESCE(jsonb_agg(document ORDER BY number), '[]'::jsonb) AS work, statement_timestamp() AS observed_at FROM work_items")).rows[0];
    return { work: row.work, now: row.observed_at.toISOString() };
  }
  async events(id?: string) {
    return (await this.pool.query('SELECT * FROM events WHERE ($1::uuid IS NULL OR work_id=$1) ORDER BY seq DESC LIMIT 300', [id ?? null])).rows;
  }
  async takeJob() {
    const token = randomUUID();
    const result = await this.pool.query(`UPDATE jobs SET token=$1, locked_until=now()+interval '90 seconds', attempts=attempts+1,claimed_generation=generation
      WHERE work_id=(SELECT work_id FROM jobs WHERE available_at<=now() AND (locked_until IS NULL OR locked_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`, [token]);
    return result.rows[0] as { work_id: string; token: string; attempts: number } | undefined;
  }
  async finishJob(id: string, token: string, error?: string, retry = false) {
    await this.pool.query(`UPDATE jobs SET token=NULL,locked_until=NULL,error=$3,
      available_at=now()+ CASE WHEN generation<>claimed_generation THEN interval '0 seconds' WHEN $4::boolean THEN interval '2 seconds' WHEN $3::text IS NULL THEN interval '20 seconds' ELSE interval '45 seconds' END
      WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp()`, [id, token, error ?? null, retry]);
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
