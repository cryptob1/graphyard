import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal, type Work } from '../model.js';
import { blockerClasses, environmentalBlockerClasses, itemBlockerClass, maxAutomaticClears, uncoveredBlockerPaths, type BlockerProbe } from '../model/blocker-class.js';
import { decisionsByWork } from './decision-ledger.js';
import { save } from '../store.js';
import type { Services } from './routes.js';

/**
 * GY-1008. The loop's probe of a standing blocker's cause, recorded by its coordinator identity.
 *
 * Every probe is written on the item (`blockerProbe`), so the board and `master status` show the
 * class, the last result and when it runs next. A passing probe clears the blocker in the same
 * transaction, with the probe named in the item's history — but only after the control plane has
 * re-classified the blocker itself: an environmental class may be cleared on its probe, a
 * planned-file-scope blocker only once plannedFiles cover every file it names, and a needs-decision
 * blocker only once no decision on the item stands requested. A genuine or human-only blocker is
 * never cleared here, and neither is one the loop has already cleared `maxAutomaticClears` times
 * in a row since the item last submitted.
 */
export const blockerProbeSchema = z.object({
  blocker: z.string().min(1).max(2000),
  class: z.enum(blockerClasses),
  probe: z.string().trim().min(1).max(300),
  result: z.enum(['pass', 'fail']),
  detail: z.string().trim().min(1).max(500),
  nextAt: z.iso.datetime().nullable(),
}).strict();

type Db = pg.PoolClient;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function recordBlockerProbe(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  const data = blockerProbeSchema.parse(body);
  const fingerprint = digest({ id, probe: data });
  return services.engine.store.transaction(async (db: Db, now: Date) => {
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const replay = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (replay) { demand(replay.fingerprint === fingerprint, 'Idempotency key reused with different input'); return replay.result as Work; }
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
    const work = all.find(item => item.id === id || item.key === id);
    demand(work, 'Work item not found', 404);
    demand(work!.stage !== 'done', 'Delivered work is immutable');
    demand(work!.blocker === data.blocker, `${work!.key}'s blocker changed since it was probed; probe the standing one`, 409);
    const classification = itemBlockerClass(work!)!;
    demand(classification.class === data.class, `${work!.key}'s blocker is ${classification.class}, not ${data.class}`, 409);
    const previous = work!.blockerProbe;
    const clears = previous?.clears ?? 0;
    if (data.result === 'pass') {
      demand(clears < maxAutomaticClears, `${work!.key}'s blocker was already cleared automatically ${clears} times in a row; the master decides this one`, 409);
      if (classification.class === 'planned-file-scope') {
        const missing = uncoveredBlockerPaths(work!, classification);
        demand(!missing.length, `plannedFiles do not yet cover ${missing.join(', ')}`, 409);
      } else if (classification.class === 'needs-decision') {
        const standing = ((await decisionsByWork(db, [work!.id]))[work!.id] ?? []).filter(decision => decision.state === 'requested');
        demand(!standing.length, `decision ${standing[0]?.id} still stands requested`, 409);
      } else demand(environmentalBlockerClasses.includes(classification.class), `A ${classification.class} blocker is not cleared by a probe`, 409);
    }
    const probe: BlockerProbe = { blocker: data.blocker, class: data.class, probe: data.probe, result: data.result, detail: data.detail, at: now.toISOString(), nextAt: data.result === 'pass' ? null : data.nextAt, clears: data.result === 'pass' ? clears + 1 : clears };
    work!.blockerProbe = probe;
    if (data.result === 'pass') work!.blocker = null;
    services.engine.evaluate(work!, all, now);
    await (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
    await save(db, work!, actor.id, data.result === 'pass' ? 'blocker.cleared' : 'blocker.probed', now,
      { probe, ...(data.result === 'pass' ? { cleared: data.blocker, reason: `the ${data.class} blocker's cause no longer stands: ${data.probe} passed (${data.detail})` } : {}) });
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
    return work!;
  });
}
