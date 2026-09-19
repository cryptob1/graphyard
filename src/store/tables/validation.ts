import { appendOnly, defineTable } from '../tables.js';

/** The validation runner protocol: definitions, builds, candidates, requests, artifacts and resource reservations. */
export const validationDefinitions = defineTable({
  name: 'validation_definitions', orderBy: 'kind,id,revision',
  ddl: `CREATE TABLE IF NOT EXISTS validation_definitions (
  kind text NOT NULL, id text NOT NULL, revision int NOT NULL, document jsonb NOT NULL,
  PRIMARY KEY(kind,id,revision)
);
${appendOnly('validation_definitions')}
CREATE INDEX IF NOT EXISTS validation_definition_page ON validation_definitions ((document->>'createdAt') DESC,kind DESC,id DESC,revision DESC);`,
});
export const validationBuilds = defineTable({
  name: 'validation_builds', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS validation_builds (id uuid PRIMARY KEY, document jsonb NOT NULL);
${appendOnly('validation_builds')}`,
});
export const validationCandidates = defineTable({
  name: 'validation_candidates', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS validation_candidates (id uuid PRIMARY KEY, document jsonb NOT NULL);
${appendOnly('validation_candidates')}`,
});
export const validationRequests = defineTable({
  name: 'validation_requests', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS validation_requests (id uuid PRIMARY KEY, document jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS validation_request_page ON validation_requests ((document->>'createdAt') DESC,id DESC);
CREATE INDEX IF NOT EXISTS validation_request_state ON validation_requests ((document->>'state'));`,
});
export const validationArtifacts = defineTable({
  name: 'validation_artifacts', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS validation_artifacts (
  id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES validation_requests(id),
  attempt_id uuid NOT NULL, name text NOT NULL, digest text NOT NULL,
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  media_type text NOT NULL, bytes bytea, deleted_at timestamptz,
  UNIQUE(request_id,attempt_id,name)
);
CREATE INDEX IF NOT EXISTS validation_artifact_expiry ON validation_artifacts(expires_at) WHERE bytes IS NOT NULL;
ALTER TABLE validation_artifacts ADD COLUMN IF NOT EXISTS backend text NOT NULL DEFAULT 'postgres';
ALTER TABLE validation_artifacts ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE validation_artifacts ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'stored';
ALTER TABLE validation_artifacts ADD COLUMN IF NOT EXISTS size bigint;
UPDATE validation_artifacts SET size=octet_length(bytes) WHERE size IS NULL AND bytes IS NOT NULL;
UPDATE validation_artifacts SET state='expired' WHERE state='stored' AND backend='postgres' AND bytes IS NULL;
CREATE INDEX IF NOT EXISTS validation_artifact_retained ON validation_artifacts(expires_at) WHERE state='stored';`,
});
export const validationRunnerPolls = defineTable({
  name: 'validation_runner_polls', orderBy: 'registration_id',
  ddl: `CREATE TABLE IF NOT EXISTS validation_runner_polls (
  registration_id text PRIMARY KEY, principal text NOT NULL, polled_at timestamptz NOT NULL, granted_request_id uuid
);`,
});
export const validationResources = defineTable({
  name: 'validation_resources', orderBy: 'resource',
  ddl: `CREATE TABLE IF NOT EXISTS validation_resources (resource text PRIMARY KEY, request_id uuid NOT NULL REFERENCES validation_requests(id));`,
});

/**
 * D6: the durable attempt order. One row per dispatched attempt, numbered by the sequence
 * the dispatch transaction took, so "the newest attempt" is decided by when authority was
 * granted and never by when a result happened to arrive.
 */
export const validationAttempts = defineTable({
  name: 'validation_attempts', orderBy: 'seq', serial: 'seq',
  ddl: `CREATE TABLE IF NOT EXISTS validation_attempts (
  seq bigserial PRIMARY KEY, request_id uuid NOT NULL REFERENCES validation_requests(id), attempt_id uuid NOT NULL UNIQUE,
  epoch int NOT NULL, work_id uuid NOT NULL, proof text NOT NULL, candidate_id uuid NOT NULL, dispatched_at timestamptz NOT NULL
);
${appendOnly('validation_attempts')}
CREATE INDEX IF NOT EXISTS validation_attempt_work ON validation_attempts(work_id,proof,seq DESC);`,
});
/** D6: every reuse decision, granted or refused, with the applicability findings it rests on. */
export const validationReuseDecisions = defineTable({
  name: 'validation_reuse_decisions', orderBy: 'seq', serial: 'seq',
  ddl: `CREATE TABLE IF NOT EXISTS validation_reuse_decisions (
  seq bigserial PRIMARY KEY, id uuid NOT NULL UNIQUE, work_id uuid NOT NULL, proof text NOT NULL, document jsonb NOT NULL
);
${appendOnly('validation_reuse_decisions')}`,
});
/** D6: replay records — a deterministic verifier re-run over retained artifacts, with its coverage and cost. */
export const validationReplays = defineTable({
  name: 'validation_replays', orderBy: 'seq', serial: 'seq',
  ddl: `CREATE TABLE IF NOT EXISTS validation_replays (
  seq bigserial PRIMARY KEY, id uuid NOT NULL UNIQUE, request_id uuid NOT NULL REFERENCES validation_requests(id), attempt_id uuid NOT NULL, document jsonb NOT NULL
);
${appendOnly('validation_replays')}`,
});

export const validationTables = [validationDefinitions, validationBuilds, validationCandidates, validationRequests, validationArtifacts, validationRunnerPolls, validationResources, validationAttempts, validationReuseDecisions, validationReplays];
