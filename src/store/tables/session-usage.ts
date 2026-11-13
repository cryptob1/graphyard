import { defineTable } from '../tables.js';

/**
 * The tokens each agent session's runtime reported (GY-3289): one row per session and model, keyed
 * by the run (the master session: its conversation, day and model), with the item, role and account
 * it ran for. A report of the same key replaces its row, so the loop may report a run again.
 * `reported` false is a runtime that printed no usage.
 */
export const sessionUsage = defineTable({
  name: 'session_usage', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS session_usage (
  id text PRIMARY KEY, work text, role text NOT NULL, account text, runtime text NOT NULL, model text,
  reported boolean NOT NULL, input_tokens bigint NOT NULL, output_tokens bigint NOT NULL,
  cache_read_tokens bigint NOT NULL, cache_write_tokens bigint NOT NULL, at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS session_usage_work ON session_usage(work);`,
});
