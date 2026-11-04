import { createHash } from 'node:crypto';
import type pg from 'pg';
import { demand, type Principal, type Work } from '../model.js';

type Db = Pick<pg.PoolClient, 'query'>;
export const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** A lookup without executing a mutation, including preflight checks before external I/O. */
export async function readReceipt(db: Db, actor: Principal, key: string) {
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const row = (await db.query('SELECT fingerprint,result FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
  return row as { fingerprint: string; result: any } | undefined;
}

/** Match a preflight read; the mutation checks again inside its transaction. */
export async function receipt(db: Db, actor: Principal, key: string, input: unknown) {
  const row = await readReceipt(db, actor, key);
  if (row) demand(row.fingerprint === digest(input), 'Idempotency key reused with different input', 409);
  return row;
}

/** Run under the caller's transaction and locks: the mutation and its receipt commit together. */
export async function once<T>(db: Db, actor: Principal, key: string, input: unknown, fn: () => Promise<T>, options: {
  replay?: (result: T) => Promise<void>;
  store?: (result: T) => unknown;
} = {}): Promise<T> {
  const fingerprint = digest(input);
  const previous = await receipt(db, actor, key, input);
  if (previous) {
    await options.replay?.(previous.result);
    return previous.result;
  }
  const result = await fn();
  await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)',
    [actor.id, key, fingerprint, JSON.stringify(options.store ? options.store(result) : result)]);
  return result;
}

/** Append history in the same transaction as the document it describes. */
export const record = (db: { query: (text: string, values: unknown[]) => Promise<unknown> }, work: Pick<Work, 'id'> | null, actor: string, kind: string, details: unknown) =>
  db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work?.id ?? null, actor, kind, JSON.stringify(details)]);
