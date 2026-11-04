import type pg from 'pg';
import { workIdByRef } from './locked-read.js';

/** The live-lease check and its history insert stay one atomic statement, without a fleet lock. */
export async function recordRenewalFault(db: Pick<pg.Pool, 'query'>, id: string, actor: { id: string }, epoch: number, at: Date, until: number, renewalFaultEvent: string, payload: string) {
  return (await db.query(`WITH live AS (
        SELECT id, CASE WHEN document->'lease' ? 'renewalFault' THEN (document->'lease'->>'expiresAt')::timestamptz
          ELSE GREATEST((document->'lease'->>'expiresAt')::timestamptz, $7::timestamptz) END AS grace_until
        FROM work_items WHERE id = ${workIdByRef('$1')} AND document->'lease'->>'owner'=$2
          AND (document->'lease'->>'epoch')::int=$5 AND (document->'lease'->>'expiresAt')::timestamptz>=$6::timestamptz LIMIT 1),
      recorded AS (INSERT INTO events(work_id,actor,kind,payload) SELECT id, $2, $3, $4::jsonb FROM live RETURNING work_id)
      SELECT live.grace_until, clock_timestamp() AS now FROM live JOIN recorded ON recorded.work_id=live.id`,
    [id, actor.id, renewalFaultEvent, payload, Number.isSafeInteger(epoch) ? epoch : -1, at.toISOString(), new Date(until).toISOString()])).rows[0] as { grace_until: Date; now: Date } | undefined;
}
