import { defineTable } from '../tables.js';

/**
 * The reconciliation loop's own liveness (GY-1791): one row, upserted by every reconciliation pass
 * with the time it ran. A pass that finds its predecessor older than the stall bound knows the
 * control plane itself was not ticking — a deploy, a stalled event loop, a database the passes
 * could not reach — and records the gap once as a `plane.stall` ledger row. That row is what lets
 * the plane explain its own outages: a lease that runs out while no tick ran was not lost by a
 * vanished worker, and renewal grace (engine.ts, GY-558's rule) keeps it live for a supervisor
 * still retrying, the way a recorded server-side renewal fault does. Never an event per tick: an
 * ordinary pass overwrites the row and appends nothing. A cache, like executor presence: a lost
 * row only delays stall detection by one gap.
 */
export const planeLiveness = defineTable({
  name: 'plane_liveness', orderBy: 'id', cache: true,
  ddl: `CREATE TABLE IF NOT EXISTS plane_liveness (
  id boolean PRIMARY KEY DEFAULT true CHECK (id), tick_at timestamptz NOT NULL
);`,
});

export const planeLivenessTables = [planeLiveness];
