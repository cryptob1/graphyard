import { appendOnly, defineTable } from '../tables.js';

/**
 * The repository-clock instant of a delivery, written once so the index key, the pulse
 * predicate and its ordering are literally the same expression. A delivery authorized
 * with a measured GitHub/database clock offset carries `mergedAtRepository`; one recorded
 * before that field existed falls back to the provider timestamp, which is the best
 * available reading of it. Unqualified `payload` resolves to the single `events` table in
 * every place this is used, so the planner can match it to the index.
 */
export const DELIVERY_REPOSITORY_INSTANT =
  "graphyard_instant(COALESCE(payload->'work'->'delivery'->>'mergedAtRepository',payload->'work'->'delivery'->>'mergedAt'))";

/**
 * What makes an event an accepted-delivery record. Written once so the two indexes, the
 * window scan, and the global first-delivery probe all select exactly the same set of
 * rows: a work item is delivered once, and which event is its first must not depend on
 * which query is asking.
 */
export const DELIVERY_EVENT_PREDICATE =
  "kind='github.observed' AND payload->'work'->'delivery'->>'mergedAt' IS NOT NULL";

/**
 * Production deployment observations and the shipping pulse read from them. The pulse
 * also indexes the events ledger by delivery instant; that DDL travels with this module
 * because the events table itself is unchanged and the indexes exist for the pulse.
 */
export const productionObservations = defineTable({
  name: 'production_observations', orderBy: 'id',
  ddl: `-- Parses an RFC3339 delivery timestamp into an instant using only immutable
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
-- Renamed each time the key changed, because CREATE INDEX IF NOT EXISTS would otherwise
-- keep an index that can no longer answer the pulse range: the text-keyed
-- events_delivery_time could not answer an instant range at all, and
-- events_delivery_instant was keyed on the provider merge timestamp, which the pulse no
-- longer compares against repository-clock values.
DROP INDEX IF EXISTS events_delivery_time;
DROP INDEX IF EXISTS events_delivery_instant;
CREATE INDEX IF NOT EXISTS events_delivery_repository_instant ON events (${DELIVERY_REPOSITORY_INSTANT},work_id,seq)
  WHERE ${DELIVERY_EVENT_PREDICATE};
-- A work item is delivered once, at its first accepted-delivery event, whether or not
-- that event falls in the reporting window. The pulse therefore has to identify the
-- globally first one for each candidate it finds, and this keys that question directly:
-- one (work_id, seq) probe returning a single tuple per candidate, rather than a walk of
-- the item's history looking for the earliest event that happens to carry a delivery.
CREATE INDEX IF NOT EXISTS events_delivery_first ON events (work_id,seq)
  WHERE ${DELIVERY_EVENT_PREDICATE};
-- Recent-delivery quality is read from the immutable snapshot each delivery cites by
-- revision, so that lookup must be an exact probe rather than a walk of one work
-- item's history. Revisions are written by save() as canonical JSON integers, so the
-- stored text compares exactly; a numeric cast would not be indexable over rows whose
-- payload carries no work document.
CREATE INDEX IF NOT EXISTS events_work_revision ON events (work_id,(payload->'work'->>'revision'),seq)
  WHERE payload ? 'work';
CREATE TABLE IF NOT EXISTS production_observations (
  id uuid PRIMARY KEY, provider text NOT NULL, deployment_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded','failed','superseded')),
  kind text NOT NULL CHECK (kind IN ('deployment','rollback')),
  -- deployed_at is the provider's own clock, retained exactly as reported. The repository
  -- clock is this database's, and nothing after ingestion can relate the two, so the
  -- bracket the collector measured is recorded with the observation and the deployment
  -- instant is carried onto the repository clock here, once: deployed_at_repository is
  -- the earliest repository instant the deployment can have happened at and
  -- deployed_at_repository_max the latest. Every comparison the pulse makes against a
  -- merge, and every duration it publishes, reads those rather than deployed_at.
  deployed_at timestamptz NOT NULL, observed_at timestamptz NOT NULL,
  deployed_at_repository timestamptz, deployed_at_repository_max timestamptz,
  clock_offset_min_ms bigint, clock_offset_max_ms bigint,
  commit_sha text, artifact_digest text, source_url text NOT NULL,
  producer text NOT NULL, document jsonb NOT NULL,
  UNIQUE(provider,deployment_id,status)
);`,
});
/**
 * The upgrade of both tables from earlier column layouts runs here, once both exist: it
 * lifts the append-only guards for the duration and reinstates them last.
 */
export const productionObservationMerges = defineTable({
  name: 'production_observation_merges', orderBy: 'observation_id,merge_sha',
  ddl: `-- The repository deployment instants, status, and kind are copied from the immutable
-- observation written in the same transaction so the per-merge lookup can be satisfied,
-- ordered, and capped entirely from one index instead of sorting every mapping for a
-- merge SHA.
CREATE TABLE IF NOT EXISTS production_observation_merges (
  observation_id uuid NOT NULL REFERENCES production_observations(id), merge_sha text NOT NULL,
  deployed_at timestamptz NOT NULL, status text NOT NULL, kind text NOT NULL,
  deployed_at_repository timestamptz, deployed_at_repository_max timestamptz,
  PRIMARY KEY(observation_id,merge_sha)
);
-- Databases created before the ordering and clock-anchor columns existed are upgraded in
-- place from the immutable observations they already reference; the append-only guard is
-- reinstated below, so no recorded observation can be altered outside this step. An
-- observation recorded before the offset was measured has no bracket to apply, so its
-- provider timestamp stands as the only reading of the instant available for it, with a
-- zero-width offset recorded to say exactly that.
DROP TRIGGER IF EXISTS immutable_production_observations ON production_observations;
DROP TRIGGER IF EXISTS immutable_production_observation_merges ON production_observation_merges;
ALTER TABLE production_observations ADD COLUMN IF NOT EXISTS deployed_at_repository timestamptz;
ALTER TABLE production_observations ADD COLUMN IF NOT EXISTS deployed_at_repository_max timestamptz;
ALTER TABLE production_observations ADD COLUMN IF NOT EXISTS clock_offset_min_ms bigint;
ALTER TABLE production_observations ADD COLUMN IF NOT EXISTS clock_offset_max_ms bigint;
UPDATE production_observations SET deployed_at_repository=deployed_at, deployed_at_repository_max=deployed_at,
  clock_offset_min_ms=0, clock_offset_max_ms=0 WHERE deployed_at_repository IS NULL;
ALTER TABLE production_observations ALTER COLUMN deployed_at_repository SET NOT NULL,
  ALTER COLUMN deployed_at_repository_max SET NOT NULL,
  ALTER COLUMN clock_offset_min_ms SET NOT NULL, ALTER COLUMN clock_offset_max_ms SET NOT NULL;
ALTER TABLE production_observation_merges ADD COLUMN IF NOT EXISTS deployed_at timestamptz;
ALTER TABLE production_observation_merges ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE production_observation_merges ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE production_observation_merges ADD COLUMN IF NOT EXISTS deployed_at_repository timestamptz;
ALTER TABLE production_observation_merges ADD COLUMN IF NOT EXISTS deployed_at_repository_max timestamptz;
UPDATE production_observation_merges m SET deployed_at=o.deployed_at, status=o.status, kind=o.kind,
    deployed_at_repository=o.deployed_at_repository, deployed_at_repository_max=o.deployed_at_repository_max
  FROM production_observations o
  WHERE o.id=m.observation_id AND (m.deployed_at IS NULL OR m.deployed_at_repository IS NULL);
ALTER TABLE production_observation_merges ALTER COLUMN deployed_at SET NOT NULL,
  ALTER COLUMN status SET NOT NULL, ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN deployed_at_repository SET NOT NULL, ALTER COLUMN deployed_at_repository_max SET NOT NULL;
DROP INDEX IF EXISTS production_merges_lookup;
-- Keyed on the repository instant, because that is the clock the lookup orders by and the
-- clock the published durations are measured on. Keyed on the provider timestamp the cap
-- would stop at the wrong 101 observations whenever the provider clock is offset.
DROP INDEX IF EXISTS production_merges_deploy_order;
CREATE INDEX IF NOT EXISTS production_merges_repository_order ON production_observation_merges(merge_sha,deployed_at_repository,observation_id)
  WHERE status='succeeded' AND kind='deployment';
DROP INDEX IF EXISTS production_deployment_time;
CREATE INDEX IF NOT EXISTS production_deployment_repository_time ON production_observations(deployed_at_repository,id) WHERE status='succeeded' AND kind='deployment';
CREATE INDEX IF NOT EXISTS production_deployment_state ON production_observations(provider,deployment_id,status);
${appendOnly('production_observations')}
${appendOnly('production_observation_merges')}`,
});

export const productionTables = [productionObservations, productionObservationMerges];
