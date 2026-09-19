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
CREATE INDEX IF NOT EXISTS validation_artifact_expiry ON validation_artifacts(expires_at) WHERE bytes IS NOT NULL;`,
});
export const validationResources = defineTable({
  name: 'validation_resources', orderBy: 'resource',
  ddl: `CREATE TABLE IF NOT EXISTS validation_resources (resource text PRIMARY KEY, request_id uuid NOT NULL REFERENCES validation_requests(id));`,
});

export const validationTables = [validationDefinitions, validationBuilds, validationCandidates, validationRequests, validationArtifacts, validationResources];
