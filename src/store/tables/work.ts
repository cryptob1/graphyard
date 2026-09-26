import { appendOnly, defineTable } from '../tables.js';
import { eventWorkFunctions } from '../snapshot-delta.js';

/** Work aggregates, their immutable history, and the durable integration jobs behind them. */
export const workItems = defineTable({
  name: 'work_items', orderBy: 'number', serial: 'number',
  ddl: `CREATE TABLE IF NOT EXISTS work_items (
  id uuid PRIMARY KEY, number bigserial UNIQUE, document jsonb NOT NULL
);`,
});
export const events = defineTable({
  name: 'events', orderBy: 'seq', serial: 'seq',
  ddl: `CREATE TABLE IF NOT EXISTS events (
  seq bigserial PRIMARY KEY, work_id uuid REFERENCES work_items(id),
  actor text NOT NULL, kind text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS events_work ON events(work_id,seq);
-- The ledger's recent growth by kind (eventStats) is a range read on insertion time.
CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
-- The intervention report reads a window of a few kinds (GY-422): by kind and time, never the
-- whole ledger newest-first.
CREATE INDEX IF NOT EXISTS events_kind_created ON events(kind,created_at);
-- An item's newest row carrying a whole document before a point in the ledger, in one probe: the
-- snapshot a save's delta extends, and the stage an item held before the intervention report's
-- window (GY-491).
CREATE INDEX IF NOT EXISTS events_work_whole ON events(work_id,seq) WHERE payload ? 'work';
-- The production watch restores its containment answers before the server listens, on every
-- restart (and every deploy restarts): newest record per item, and the newest pending set.
-- Partial on kind, so each read touches only its own records instead of the window's events.
CREATE INDEX IF NOT EXISTS events_deployment_contained ON events(work_id,seq DESC)
  WHERE kind='delivery.deployment-contained' AND work_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_deployment_pending ON events(created_at DESC,seq DESC)
  WHERE kind='production.deployment-pending';
${eventWorkFunctions}
${appendOnly('events')}`,
});
export const receipts = defineTable({
  name: 'receipts', orderBy: 'actor,key',
  ddl: `CREATE TABLE IF NOT EXISTS receipts (
  actor text NOT NULL, key text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(actor,key)
);
-- Nullable so a restore of an older backup fills NULL; rows present when it is added read the migration's time.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
CREATE INDEX IF NOT EXISTS receipts_created ON receipts(created_at);`,
});
export const jobs = defineTable({
  name: 'jobs', orderBy: 'work_id',
  ddl: `CREATE TABLE IF NOT EXISTS jobs (
  work_id uuid PRIMARY KEY REFERENCES work_items(id), available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz, token uuid, attempts int NOT NULL DEFAULT 0, error text
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS held_until timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS held_reason text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS refusals int NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS held_on text;`,
});
export const webhookReceipts = defineTable({
  name: 'webhook_receipts', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS webhook_receipts (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());`,
});

export const workTables = [workItems, events, receipts, jobs, webhookReceipts];
