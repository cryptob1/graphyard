import { defineTable } from '../tables.js';

/** Executor bookkeeping, separate from the work and registry lifecycle. */
export const loopState = defineTable({
  name: 'loop_state', orderBy: 'scope, kind, id', serial: 'position',
  ddl: `CREATE TABLE IF NOT EXISTS loop_state (
    scope text NOT NULL, kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, position bigserial NOT NULL,
    PRIMARY KEY(scope, kind, id)
  );`,
});
