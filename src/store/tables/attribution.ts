import { appendOnly, defineTable } from '../tables.js';

/**
 * Candidate-to-deployment attribution: the append-only ledger of target checks, mismatches,
 * supersessions, re-anchor decisions, signature regenerations and refused claims, and the
 * one-row-per-superseded-request table that makes automatic rescheduling idempotent. Both
 * are written only by src/validation.ts inside coordination transactions and read by
 * src/attribution.ts; nothing here participates in gate evaluation.
 */
export const attributionRecords = defineTable({
  name: 'attribution_records', orderBy: 'seq', serial: 'seq',
  ddl: `CREATE TABLE IF NOT EXISTS attribution_records (
  seq bigserial PRIMARY KEY, id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  work_id uuid NOT NULL REFERENCES work_items(id), work_key text NOT NULL, proof text NOT NULL, environment_id text NOT NULL,
  candidate_id uuid, request_id uuid, attempt_id uuid,
  kind text NOT NULL, recorded_at timestamptz NOT NULL, dedupe text UNIQUE, details jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS attribution_records_time ON attribution_records(recorded_at, seq);
CREATE INDEX IF NOT EXISTS attribution_records_work ON attribution_records(work_id, seq);
CREATE INDEX IF NOT EXISTS attribution_records_kind ON attribution_records(kind, recorded_at, seq);
CREATE INDEX IF NOT EXISTS attribution_records_environment ON attribution_records(environment_id, seq);
${appendOnly('attribution_records')}`,
});
/** One re-anchor per superseded request: the primary key is the idempotency fence under concurrent observations. */
export const attributionReanchors = defineTable({
  name: 'attribution_reanchors', orderBy: 'superseded_request_id',
  ddl: `CREATE TABLE IF NOT EXISTS attribution_reanchors (
  superseded_request_id uuid PRIMARY KEY REFERENCES validation_requests(id),
  fresh_request_id uuid NOT NULL REFERENCES validation_requests(id), fresh_candidate_id uuid NOT NULL REFERENCES validation_candidates(id),
  recorded_at timestamptz NOT NULL, document jsonb NOT NULL
);
${appendOnly('attribution_reanchors')}`,
});

export const attributionTables = [attributionRecords, attributionReanchors];
