import { defineTable } from '../tables.js';

/**
 * The control plane as merge writer (GY-1523). A head submitted with `complete GY-N EPOCH --head`
 * has no pull request, so the control plane allocates it a change number from this sequence and
 * records it where the 64 readers of `candidate.pr` and `submission.pr` already look. One number
 * per (work item, head): a replayed or repeated submission of the same head reads its row back
 * instead of allocating another, and a new head of the same item allocates the next number.
 */
export const changeNumbers = defineTable({
  name: 'change_numbers', orderBy: 'number', serial: 'number',
  ddl: `CREATE TABLE IF NOT EXISTS change_numbers (
  number bigserial PRIMARY KEY, work_id uuid NOT NULL REFERENCES work_items(id), head text NOT NULL,
  allocated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(work_id, head)
);`,
});

/** The merge writer's tables, registered after the work tables they reference. */
export const mergesTables = [changeNumbers];
