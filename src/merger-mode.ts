import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal, type Work } from './model.js';
import type { Store } from './store.js';

/**
 * The merge writer: the control plane is the only one. Old `policy.merger.set` events stay on the
 * append-only ledger and are never read, so a ledger that once said `github` delivers through the
 * control plane all the same, and nothing can set the merger.
 */
export type MergerMode = 'control-plane';
/** GY-2940: the origin form the merge writer's deploy key pushes OWNER/REPO through: SSH. */
export const sshOrigin = (repository: string) => `git@github.com:${repository}.git`;
type Queryable = Pick<pg.PoolClient, 'query'>;
/** What /api/status shows as `mergeWriter`. */
export const mergeWriterStatus = { merger: 'control-plane' as MergerMode, line: 'The control plane is the merge writer' };

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * GY-1927: the automatic-merging setting, an attributed policy event on the append-only ledger
 * (`policy.auto-merge.set`), written by an admin or coordinator only. It holds no candidate
 * (GY-2874): a candidate whose every gate passes is merged whatever it says.
 */
export const autoMergeEventKind = 'policy.auto-merge.set';
export interface AutoMergeSetting { autoMerge: boolean; since: string | null; setBy: string | null; reason: string | null; event: string | null }
const autoMergeChangeSchema = z.object({ autoMerge: z.boolean(), reason: z.string().trim().min(1).max(1000) }).strict();
const autoMergeOf = (row: any): AutoMergeSetting => ({ autoMerge: row.payload.autoMerge === true, since: new Date(row.created_at).toISOString(), setBy: row.actor, reason: row.payload.reason ?? null, event: String(row.seq) });

/** The newest recorded automatic-merging setting, or the default (on) when none is recorded. */
export async function recordedAutoMerge(db: Queryable): Promise<AutoMergeSetting> {
  const row = (await db.query(`SELECT seq, actor, payload, created_at FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq DESC LIMIT 1`, [autoMergeEventKind])).rows[0];
  return row ? autoMergeOf(row) : { autoMerge: true, since: null, setBy: null, reason: null, event: null };
}
/** What /api/status shows as `autoMerge`: the setting, and the line master status shows for it. */
export async function autoMergeStatus(db: Queryable) {
  const setting = await recordedAutoMerge(db);
  const line = setting.autoMerge ? 'routine merges permitted after gates pass'
    : `automatic merging was set off since ${setting.since} by ${setting.setBy} (${setting.reason}); it holds nothing, and merges still land once every gate passes`;
  return { ...setting, line };
}

/** The automatic-merging setting: read by the roles that watch the install, changed by an admin or the coordinator alone. */
export class AutoMergeSettings {
  constructor(private store: Store) {}

  async status(actor: Principal) {
    demand(['admin', 'coordinator', 'reader', 'operator-agent'].includes(actor.role), 'The automatic-merging setting is readable by admin, coordinator, reader and operator-agent identities', 403);
    return autoMergeStatus(this.store.pool);
  }

  /** An unchanged value writes nothing and answers the standing setting, so rerunning `master init` is idempotent. */
  async change(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'admin' || actor.role === 'coordinator', 'Automatic merging is set only with an admin or coordinator credential', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = autoMergeChangeSchema.parse(input);
    const fingerprint = digest({ action: 'auto-merge', data });
    return this.store.transaction(async (db) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result; }
      const current = await recordedAutoMerge(db);
      if (current.autoMerge !== data.autoMerge) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, autoMergeEventKind, JSON.stringify({ autoMerge: data.autoMerge, reason: data.reason, previous: current.autoMerge, role: actor.role })]);
      const result = await autoMergeStatus(db);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
}
