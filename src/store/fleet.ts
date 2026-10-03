import type { Work } from '../model.js';

/**
 * The fleet a coordination command evaluates against, read inside its transaction (2026-10-02).
 *
 * Every command used to read every whole document (`SELECT document FROM work_items`, ~19 MB with
 * ~1,000 delivered items) while holding the coordination lock, so each write held the lock for as
 * long as that read and its parse took: 17 of 27 connections queued on the lock and webhooks,
 * heartbeats and claims timed out. A settled delivery is served by its work-index summary
 * (src/store/tables/work-index.ts), exactly as the coordination snapshot and the reconciliation
 * pass already serve it, so its document is never loaded; a live item, and every item the command
 * names as its own target (by id or key), is read whole. A settled row without a summary is read
 * whole too, so nothing is ever evaluated against a missing document.
 */
export const fleetSql = `SELECT CASE WHEN i.settled AND i.summary IS NOT NULL AND NOT (w.id::text = ANY($1::text[]) OR i.key = ANY($1::text[]))
    THEN i.summary ELSE w.document END AS document
  FROM work_items w LEFT JOIN work_index i ON i.id = w.id ORDER BY w.number`;

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

/** The fleet for one command: live items and the named targets whole, other settled deliveries as summaries, in number order. */
export async function readFleet(db: Queryable, targets: readonly (string | null | undefined)[] = []): Promise<Work[]> {
  const named = targets.filter((target): target is string => typeof target === 'string' && target.length > 0);
  return (await db.query(fleetSql, [named])).rows.map(row => row.document as Work);
}
