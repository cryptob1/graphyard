import { defineTable } from '../tables.js';

/**
 * The last time each executor was heard (GY-1289): one row per executor, upserted by every claim
 * poll, presence-only poll and claim renewal (src/model/executor-presence.ts). It is presence kept
 * beside the engine's store so a replaced control-plane process — a deploy, a restart, another
 * replica — reads the fleet that was polling a moment before it started instead of an empty one.
 * Never an event row: an idle poll overwrites its executor's row and appends nothing (GY-185). A
 * cache, not ledger state: presence is only ever a statement about now, so it is neither backed up
 * nor restored, and a lost row is one executor unheard until its next poll five seconds later.
 */
export const executorPresence = defineTable({
  name: 'executor_presence', orderBy: 'principal, executor', cache: true,
  ddl: `CREATE TABLE IF NOT EXISTS executor_presence (
  principal text NOT NULL, executor text NOT NULL, host text NOT NULL, kinds jsonb NOT NULL, seen_at timestamptz NOT NULL,
  claims int NOT NULL DEFAULT 0, PRIMARY KEY(principal, executor)
);
CREATE INDEX IF NOT EXISTS executor_presence_seen ON executor_presence(seen_at DESC);`,
});

export const executorPresenceTables = [executorPresence];
