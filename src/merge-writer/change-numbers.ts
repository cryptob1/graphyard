// Concern: control-plane change numbers (GY-1523) — one number per (work item, head), allocated inside the submit transaction.
import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * The change number of `head` on `workId`: allocated from the `change_numbers` sequence the first
 * time, read back every time after. `UNIQUE(work_id, head)` makes two allocations of one head
 * agree, and the item lock the submit transaction holds orders them; a number is never reused.
 */
export async function allocateChangeNumber(db: Queryable, workId: string, head: string): Promise<number> {
  const inserted = (await db.query('INSERT INTO change_numbers(work_id,head) VALUES($1,$2) ON CONFLICT (work_id,head) DO NOTHING RETURNING number', [workId, head])).rows[0];
  const row = inserted ?? (await db.query('SELECT number FROM change_numbers WHERE work_id=$1 AND head=$2', [workId, head])).rows[0];
  return Number(row.number);
}
