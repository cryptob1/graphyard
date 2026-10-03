import type pg from 'pg';
import { advisoryLocks } from './locks.js';
import type { StoreLane } from './store.js';

/**
 * How a transaction locks (GY-1124). `fleetLock` (alias `coordinationLock`, default true) takes the
 * coordination lock every command that reads or decides on other items needs; `itemLock` takes the
 * named item's own lock after it, so commands that change one item and read nothing else of the
 * fleet (a heartbeat) take only the item lock and never wait for another item's write. A stale
 * write (`StaleWrite`) is retried on a fresh transaction unless `retryStaleWrites` is false.
 */
export interface StoreTransactionOptions {
  lane?: StoreLane;
  coordinationLock?: boolean;
  fleetLock?: boolean;
  itemLock?: string | number | null;
  retryStaleWrites?: boolean;
}

/**
 * A `save` of a document read before another transaction committed a newer revision of it
 * (GY-1124). With heartbeats off the coordination lock, a fleet command that read an item it
 * then writes could otherwise overwrite a renewal that committed in between; the write is
 * refused instead, and `Store.transaction` runs the whole transaction again on what is current.
 */
export class StaleWrite extends Error {
  constructor(readonly workId: string, readonly expectedRevision: number) { super(`Work item ${workId} changed since it was read (expected revision ${expectedRevision}); retry on the current document`); }
}
/** How many times a transaction that hit a stale write runs in all before the refusal surfaces. */
export const staleWriteAttempts = 4;

/**
 * Take one item's transaction lock (GY-1124), keyed by its number in the item lock's own space, so
 * an id, a `GY-N` key and a number name the same lock. An item that does not exist yet (or never
 * will) is locked by its name, which still serialises every command naming it.
 */
export async function lockItem(db: pg.PoolClient, item: string | number): Promise<void> {
  const number = typeof item === 'number' ? item : /^(GY-)?\d+$/i.test(item) ? Number(item.replace(/^GY-/i, ''))
    : (await db.query("SELECT number FROM work_items WHERE id::text=$1 OR document->>'key'=$1 LIMIT 1", [item])).rows[0]?.number;
  if (number !== undefined) await db.query('SELECT pg_advisory_xact_lock($1, $2::int)', [advisoryLocks.item, Number(number)]);
  else await db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [advisoryLocks.item, String(item)]);
}
