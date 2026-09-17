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
-- Parses an RFC3339 delivery timestamp into an instant using only immutable
-- primitives, so the same expression can be indexed and used as the pulse query
-- predicate. A numeric offset is subtracted explicitly; a bare or Z-suffixed
-- value is read as repository UTC. Casting straight to timestamptz would depend
-- on the session TimeZone and could not be indexed.
CREATE OR REPLACE FUNCTION graphyard_instant(value text) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT CASE WHEN parsed.offset_text IS NULL
    THEN rtrim(value,'Zz')::timestamp AT TIME ZONE 'UTC'
    ELSE (left(value, length(value) - length(parsed.offset_text))::timestamp
          - make_interval(mins => (CASE WHEN left(parsed.digits,1)='-' THEN -1 ELSE 1 END)
              * (substring(parsed.digits from 2 for 2)::int * 60
                 + CASE WHEN length(parsed.digits)=5 THEN substring(parsed.digits from 4 for 2)::int ELSE 0 END)))
         AT TIME ZONE 'UTC'
  END
  FROM (SELECT found, replace(found,':','') AS digits, found AS offset_text
        FROM (SELECT substring(value from '[0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\\.[0-9]+)?([+-][0-9]{2}:?[0-9]{2}|[+-][0-9]{2})$') AS found) raw) parsed $fn$;
-- Renamed with the key it now holds: the text-keyed events_delivery_time could not
-- answer an instant range, and CREATE INDEX IF NOT EXISTS would have kept it.
DROP INDEX IF EXISTS events_delivery_time;
CREATE INDEX IF NOT EXISTS events_delivery_instant ON events (graphyard_instant(payload->'work'->'delivery'->>'mergedAt'),work_id,seq)
  WHERE kind='github.observed' AND payload->'work'->'delivery'->>'mergedAt' IS NOT NULL;
CREATE OR REPLACE FUNCTION graphyard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'The event ledger is append-only'; END $$;
DROP TRIGGER IF EXISTS immutable_events ON events;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();
CREATE TABLE IF NOT EXISTS production_observations (
  id uuid PRIMARY KEY, provider text NOT NULL, deployment_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded','failed','superseded')),
  kind text NOT NULL CHECK (kind IN ('deployment','rollback')),
  deployed_at timestamptz NOT NULL, observed_at timestamptz NOT NULL,
  commit_sha text, artifact_digest text, source_url text NOT NULL,
  producer text NOT NULL, document jsonb NOT NULL,
  UNIQUE(provider,deployment_id,status)
);
-- deployed_at/status/kind are copied from the immutable observation written in the
-- same transaction so the per-merge lookup can be satisfied, ordered, and capped
-- entirely from one index instead of sorting every mapping for a merge SHA.
CREATE TABLE IF NOT EXISTS production_observation_merges (
  observation_id uuid NOT NULL REFERENCES production_observations(id), merge_sha text NOT NULL,
  deployed_at timestamptz NOT NULL, status text NOT NULL, kind text NOT NULL,
  PRIMARY KEY(observation_id,merge_sha)
);
-- Databases created before the ordering columns existed are upgraded in place from
-- the immutable observations they already reference; the append-only guard is
-- reinstated below, so no recorded observation can be altered outside this step.
DROP TRIGGER IF EXISTS immutable_production_observation_merges ON production_observation_merges;
ALTER TABLE production_observation_merges ADD COLUMN IF NOT EXISTS deployed_at timestamptz;
ALTER TABLE production_observation_merges ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE production_observation_merges ADD COLUMN IF NOT EXISTS kind text;
UPDATE production_observation_merges m SET deployed_at=o.deployed_at, status=o.status, kind=o.kind
  FROM production_observations o WHERE o.id=m.observation_id AND m.deployed_at IS NULL;
ALTER TABLE production_observation_merges ALTER COLUMN deployed_at SET NOT NULL,
  ALTER COLUMN status SET NOT NULL, ALTER COLUMN kind SET NOT NULL;
DROP INDEX IF EXISTS production_merges_lookup;
CREATE INDEX IF NOT EXISTS production_merges_deploy_order ON production_observation_merges(merge_sha,deployed_at,observation_id)
  WHERE status='succeeded' AND kind='deployment';
CREATE INDEX IF NOT EXISTS production_deployment_time ON production_observations(deployed_at,id) WHERE status='succeeded' AND kind='deployment';
CREATE INDEX IF NOT EXISTS production_deployment_state ON production_observations(provider,deployment_id,status);
DROP TRIGGER IF EXISTS immutable_production_observations ON production_observations;
CREATE TRIGGER immutable_production_observations BEFORE UPDATE OR DELETE ON production_observations FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();
DROP TRIGGER IF EXISTS immutable_production_observation_merges ON production_observation_merges;
CREATE TRIGGER immutable_production_observation_merges BEFORE UPDATE OR DELETE ON production_observation_merges FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();
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
CREATE TABLE IF NOT EXISTS jobs (
  work_id uuid PRIMARY KEY REFERENCES work_items(id), available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz, token uuid, attempts int NOT NULL DEFAULT 0, error text
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_generation bigint NOT NULL DEFAULT 0;
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
    const row = (await this.pool.query("SELECT COALESCE(jsonb_agg(document ORDER BY number), '[]'::jsonb) AS work, statement_timestamp() AS observed_at, (SELECT COALESCE(jsonb_agg(jsonb_build_object('work_id',work_id,'available_at',available_at,'locked_until',locked_until,'error',error)), '[]'::jsonb) FROM jobs) AS jobs FROM work_items")).rows[0];
    return { work: row.work, now: row.observed_at.toISOString(), jobs: row.jobs };
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
