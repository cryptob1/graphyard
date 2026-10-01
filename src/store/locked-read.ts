import type { Work } from '../model.js';

/**
 * What a coordination decision reads of the board while it holds the coordination lock (GY-1027).
 *
 * About twenty write paths read every work item's whole document inside the locked transaction —
 * claims, selections, renewals, submissions, observations and each reconciliation batch. On
 * 2026-10-01 the ledger held ~1000 documents (62 MB, 570 of them delivered), one such read took
 * 15-20 s, and every other coordination write queued behind it: registry selects were abandoned at
 * their client bound, leases lapsed, and the cost grew with every item ever created.
 *
 * A decision needs every open item whole — planned-file overlap, exclusive resources, the merge
 * queue, fleet capacity, follow-ups — but of a settled delivery (done, nothing owed and nothing
 * running: `settledSql`) only what the coordination view already serves for it: the work index's
 * summary, projected on write (src/store/tables/work-index.ts), which keeps the stage, key,
 * planned files, observed files, delivery, optimistic merges and the candidate's evidence and drops
 * the histories. So a locked read returns the item(s) the decision acts on (`focus`, by id or key)
 * and every unsettled item whole, and every other settled delivery as its summary. Summaries are
 * cached in-process by the version of their index row, so a read fetches only the summaries that
 * changed since the last one and the lock hold does not grow with the history.
 *
 * A summary is a stand-in, never a document: `save` refuses one (`assertSavable`), so a path that
 * acts on a settled item must name it in `focus`.
 */
export type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

const summaries = new WeakSet<object>();
/** The cache of settled summaries by index-row version, as JSON text, in insertion order; bounded so a long-lived process stays bounded. */
const cache = new Map<string, string>();
export const lockedSummaryCacheLimit = 20_000;

/** Whether `work` is a settled delivery's summary handed out by `lockedWork` rather than its document. */
export const isSettledSummary = (work: object) => summaries.has(work);
/** Refuse to save a summary over the document it stands for. */
export function assertSavable(work: Work) {
  if (summaries.has(work)) throw new Error(`${work.key} was read as a settled summary; a write to it must read it as its document (name it in lockedWork's focus)`);
}

/**
 * Every work item in number order, read for a decision under the coordination lock: the `focus`
 * items and every unsettled item as their documents, every other settled delivery as its summary.
 * `forUpdate` locks the documents read whole.
 */
export async function lockedWork(db: Queryable, focus: readonly (string | null | undefined)[] = [], options: { forUpdate?: boolean } = {}): Promise<Work[]> {
  return (await lockedRows(db, focus, options)).map(row => row.document);
}
/** `lockedWork` with each item's number, which orders the board. */
export async function lockedRows(db: Queryable, focus: readonly (string | null | undefined)[] = [], { forUpdate = false }: { forUpdate?: boolean } = {}): Promise<{ number: number; document: Work }[]> {
  const named = focus.filter((entry): entry is string => !!entry);
  const whole = (await db.query(`SELECT w.number, w.document FROM work_items w LEFT JOIN work_index i ON i.id = w.id
    WHERE i.settled IS NOT TRUE OR w.id::text = ANY($1::text[]) OR i.key = ANY($1::text[]) ORDER BY w.number${forUpdate ? ' FOR UPDATE OF w' : ''}`, [named])).rows;
  const wholeNumbers = new Set(whole.map(row => String(row.number)));
  // A summary's version is its index row's: the row is rewritten (new xmin) with every write to the
  // item, and transaction ids are never reused within a cluster's lifetime, which the postmaster's
  // start time and the database name scope.
  const settled = (await db.query(`SELECT number, id::text || ':' || xmin::text AS version, current_database() || ':' || pg_postmaster_start_time()::text AS cluster
    FROM work_index WHERE settled AND summary IS NOT NULL`)).rows.filter(row => !wholeNumbers.has(String(row.number)));
  const key = (row: { cluster: string; version: string }) => `${row.cluster}/${row.version}`;
  const missing = settled.filter(row => !cache.has(key(row))).map(row => row.version.split(':')[0]);
  if (missing.length) {
    for (const row of (await db.query(`SELECT id::text || ':' || xmin::text AS version, current_database() || ':' || pg_postmaster_start_time()::text AS cluster, summary::text AS summary
      FROM work_index WHERE settled AND id::text = ANY($1::text[])`, [missing])).rows) remember(key(row), row.summary);
  }
  const rows: { number: number; document: Work }[] = whole.map(row => ({ number: Number(row.number), document: row.document as Work }));
  for (const row of settled) {
    const text = cache.get(key(row));
    // Changed between the two reads (or evicted under pressure): read that one document whole.
    const document = text ? JSON.parse(text) as Work : (await db.query('SELECT document FROM work_items WHERE number=$1', [row.number])).rows[0]?.document as Work | undefined;
    if (!document) continue;
    if (text) summaries.add(document);
    rows.push({ number: Number(row.number), document });
  }
  return rows.sort((a, b) => a.number - b.number);
}

function remember(version: string, summary: string) {
  cache.delete(version);
  cache.set(version, summary);
  while (cache.size > lockedSummaryCacheLimit) cache.delete(cache.keys().next().value!);
}

/**
 * The id of the work item `param` names by id or display key, resolved on the work index, so a
 * lookup by key reads one index row instead of scanning (and detoasting) every document's key.
 */
export const workIdByRef = (param: string) => `(SELECT id FROM work_index WHERE id::text = ${param} OR key = ${param} ORDER BY number LIMIT 1)`;
