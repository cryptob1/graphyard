import type pg from 'pg';
import { dropRetiredQueueFields, type Work } from '../model.js';
import { assertSavable } from './locked-read.js';
import { StaleWrite } from './item-lock.js';

/**
 * Write a document as its next revision (GY-1124), only over the revision it was read at: a
 * heartbeat commits under its item lock alone, so a fleet command holding a copy read before that
 * renewal must not overwrite it. Returns the text written; `save` adds the ledger entry.
 */
export async function saveDocument(db: pg.PoolClient, work: Work, now: Date): Promise<string> {
  assertSavable(work);
  dropRetiredQueueFields(work);
  const read = work.revision;
  work.revision++;
  work.updatedAt = now.toISOString();
  const text = JSON.stringify(work);
  await guardedWrite(db, work.id, text, read);
  return text;
}

/**
 * Write bookkeeping onto an item in place (GY-1124): no new revision and no ledger entry, so a
 * reader resolving an older revision from the ledger (`onlyActionsMovedSince`) still counts saves
 * exactly. Only for a caller holding the item's lock — the lock a heartbeat takes alone — so no
 * renewal can commit between its read and this write; the revision guard refuses one that did.
 */
export async function rewriteDocument(db: pg.PoolClient, work: Work) {
  assertSavable(work);
  dropRetiredQueueFields(work);
  await guardedWrite(db, work.id, JSON.stringify(work), work.revision);
}

async function guardedWrite(db: pg.PoolClient, id: string, text: string, revision: number | undefined) {
  const written = await db.query("UPDATE work_items SET document=$2 WHERE id=$1 AND (document->>'revision')::numeric IS NOT DISTINCT FROM $3::numeric", [id, text, revision ?? null]);
  if (!written.rowCount && (await db.query('SELECT 1 FROM work_items WHERE id=$1', [id])).rowCount) throw new StaleWrite(id, revision as number);
}
