import { actionSettleMs } from './action-progress.js';
import type { NextActionKind } from './next-action.js';

/**
 * The ids of the items holding a row an executor may take now, found in SQL without loading a
 * document: the SQL form of `openActions` (`claimable`, the delivered-item rule, the kinds and the
 * item filter) over the stored rows, read at the database clock. The work index narrows it first
 * (GY-203): only an item one of whose rows is already due by its `due_at` has its document read,
 * so an idle poll touches the index alone and answers from this; a poll that finds candidates
 * loads only those documents, and `claimAction` decides again under the lock, so a row that
 * changed in between is simply not taken.
 */
export const claimCandidatesSql = `SELECT w.id FROM work_index i JOIN work_items w ON w.id = i.id
  WHERE i.due_at <= clock_timestamp() AND ($1::text IS NULL OR i.id::text = $1 OR i.key = $1)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.document->'actionQueue'->'actions') = 'array' THEN w.document->'actionQueue'->'actions' ELSE '[]'::jsonb END) AS a(entry)
      WHERE (w.document->>'stage' IS DISTINCT FROM 'done' OR entry->>'kind' = 'verify-deployment')
        AND ($2::text[] IS NULL OR entry->>'kind' = ANY($2::text[]))
        AND (entry->>'retryAt' IS NULL OR (entry->>'retryAt')::timestamptz <= clock_timestamp())
        AND NOT (entry->>'state' = 'done' AND entry->>'resolvedAt' IS NOT NULL AND (entry->>'resolvedAt')::timestamptz > clock_timestamp() - make_interval(secs => $3::double precision / 1000))
        AND (entry->>'state' = 'pending' OR jsonb_typeof(entry->'claim') IS DISTINCT FROM 'object' OR (entry->'claim'->>'expiresAt')::timestamptz <= clock_timestamp()))
  ORDER BY i.number`;
export const claimCandidatesParams = (work: string | undefined, kinds: readonly NextActionKind[] | undefined) => [work ?? null, kinds ? [...kinds] : null, actionSettleMs];
