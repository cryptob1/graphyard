import { appendOnly, defineTable } from '../tables.js';

/**
 * Flow analytics: a normalized, append-only projection of the ledger and of observed
 * provider facts, kept so delivery metrics survive upstream retention, plus the
 * deployment-provider observations recorded through `POST /api/deployments`. These tables
 * are read only by src/flow-analytics.ts and never participate in gate evaluation.
 */
export const flowFacts = defineTable({
  name: 'flow_facts', orderBy: 'id', serial: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS flow_facts (
  id bigserial PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES work_items(id),
  work_key text NOT NULL,
  kind text NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  source text NOT NULL,
  source_event bigint NOT NULL,
  stage text,
  work_type text NOT NULL,
  slices text[] NOT NULL DEFAULT '{}',
  details jsonb NOT NULL,
  dedupe text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS flow_facts_time ON flow_facts(observed_at, id);
CREATE INDEX IF NOT EXISTS flow_facts_work ON flow_facts(work_id, observed_at, id);
CREATE INDEX IF NOT EXISTS flow_facts_work_kind_latest ON flow_facts(work_id, kind, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS flow_facts_kind ON flow_facts(kind, observed_at, id);
CREATE INDEX IF NOT EXISTS flow_facts_merge_sha ON flow_facts((details->>'mergeSha'), observed_at, id) WHERE kind='merged';
${appendOnly('flow_facts')}`,
});
/** The projection checkpoint: the last ledger event folded into flow_facts. */
export const flowProjection = defineTable({
  name: 'flow_projection', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS flow_projection (id int PRIMARY KEY, last_event bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO flow_projection(id,last_event) VALUES(1,0) ON CONFLICT DO NOTHING;`,
});
/** Per-item projection state, so a replayed or delayed observation derives no duplicate fact. */
export const flowProjectionState = defineTable({
  name: 'flow_projection_state', orderBy: 'work_id',
  ddl: `CREATE TABLE IF NOT EXISTS flow_projection_state (work_id uuid PRIMARY KEY REFERENCES work_items(id), state jsonb NOT NULL);`,
});
export const deploymentObservations = defineTable({
  name: 'deployment_observations', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS deployment_observations (
  id uuid PRIMARY KEY, provider text NOT NULL, external_id text NOT NULL, environment text NOT NULL,
  sha text NOT NULL, state text NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), producer text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(provider, external_id, state)
);
CREATE INDEX IF NOT EXISTS deployment_time ON deployment_observations(started_at, id);
CREATE INDEX IF NOT EXISTS deployment_sha ON deployment_observations(sha);
DROP TRIGGER IF EXISTS immutable_deployments ON deployment_observations;
CREATE TRIGGER immutable_deployments BEFORE UPDATE OR DELETE ON deployment_observations FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();`,
});
/** The independently verified merge commits each deployed artifact contains. */
export const deploymentMergeObservations = defineTable({
  name: 'deployment_merge_observations', orderBy: 'deployment_id,merge_sha',
  ddl: `CREATE TABLE IF NOT EXISTS deployment_merge_observations (
  deployment_id uuid NOT NULL REFERENCES deployment_observations(id), merge_sha text NOT NULL,
  PRIMARY KEY(deployment_id, merge_sha)
);
CREATE INDEX IF NOT EXISTS deployment_merge_sha ON deployment_merge_observations(merge_sha, deployment_id);
DROP TRIGGER IF EXISTS immutable_deployment_merges ON deployment_merge_observations;
CREATE TRIGGER immutable_deployment_merges BEFORE UPDATE OR DELETE ON deployment_merge_observations FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();`,
});

export const flowTables = [flowFacts, flowProjection, flowProjectionState, deploymentObservations, deploymentMergeObservations];
