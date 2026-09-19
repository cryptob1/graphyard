import { appendOnly, defineTable } from '../tables.js';

/** Releases, approvals, environment selection, deployment observations and observer leases. */
export const releaseBuilds = defineTable({
  name: 'release_builds', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS release_builds (id uuid PRIMARY KEY, document jsonb NOT NULL);
${appendOnly('release_builds')}`,
});
export const releases = defineTable({
  name: 'releases', orderBy: 'id,revision',
  ddl: `CREATE TABLE IF NOT EXISTS releases (id text NOT NULL, revision int NOT NULL, document jsonb NOT NULL, PRIMARY KEY(id,revision));
${appendOnly('releases')}`,
});
export const releaseApprovals = defineTable({
  name: 'release_approvals', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS release_approvals (id uuid PRIMARY KEY, document jsonb NOT NULL);
${appendOnly('release_approvals')}`,
});
export const deliveryEnvironments = defineTable({
  name: 'delivery_environments', orderBy: 'environment_id',
  ddl: `CREATE TABLE IF NOT EXISTS delivery_environments (environment_id text PRIMARY KEY, document jsonb NOT NULL);`,
});
export const deliveryObservations = defineTable({
  name: 'delivery_observations', orderBy: 'seq', serial: 'seq',
  ddl: `CREATE TABLE IF NOT EXISTS delivery_observations (
  seq bigserial PRIMARY KEY, id uuid NOT NULL UNIQUE, environment_id text NOT NULL, registration_id text NOT NULL,
  snapshot_id text NOT NULL, document jsonb NOT NULL, received_at timestamptz NOT NULL,
  UNIQUE(registration_id,snapshot_id)
);
CREATE INDEX IF NOT EXISTS delivery_observation_environment ON delivery_observations(environment_id,seq);
${appendOnly('delivery_observations')}`,
});
export const deliveryLeases = defineTable({
  name: 'delivery_leases', orderBy: 'registration_id',
  ddl: `CREATE TABLE IF NOT EXISTS delivery_leases (registration_id text PRIMARY KEY, principal text NOT NULL, epoch int NOT NULL, expires_at timestamptz NOT NULL);`,
});
export const deliveryRollbacks = defineTable({
  name: 'delivery_rollbacks', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS delivery_rollbacks (
  id uuid PRIMARY KEY, environment_id text NOT NULL, generation int NOT NULL, document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS delivery_rollback_environment ON delivery_rollbacks(environment_id,created_at);`,
});

export const deliveryTables = [releaseBuilds, releases, releaseApprovals, deliveryEnvironments, deliveryObservations, deliveryLeases, deliveryRollbacks];
