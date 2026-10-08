import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal } from './model.js';
import type { Store } from './store.js';
import { unexplainedShadowDisagreements } from './server/shadow-verdict.js';

/**
 * The merger setting: which writer lands heads on the base branch, `github` (the default) or the
 * `control-plane`. Like direct-merge mode it lives on the append-only ledger (`policy.merger.set`,
 * no work item), is set only with an admin credential, and is never read from graphyard.json or the
 * environment. Switching to `control-plane` is refused while any shadow-only-fail or shadow-missed
 * verdict stands unexplained (GY-1560); setting `github` is never refused for that reason.
 */
export const mergerModes = ['github', 'control-plane'] as const;
export type MergerMode = typeof mergerModes[number];
export const mergerEventKind = 'policy.merger.set';
export const defaultMergerMode: MergerMode = 'github';

export interface MergerSetting { merger: MergerMode; since: string | null; setBy: string | null; reason: string | null; event: string | null }
type Queryable = Pick<pg.PoolClient, 'query'>;
const changeSchema = z.object({ merger: z.enum(mergerModes), reason: z.string().trim().min(1).max(1000) }).strict();

const settingOf = (row: any): MergerSetting => ({ merger: row.payload.merger, since: new Date(row.created_at).toISOString(), setBy: row.actor, reason: row.payload.reason ?? null, event: String(row.seq) });

/** Every recorded change, oldest first. */
export async function mergerHistory(db: Queryable): Promise<MergerSetting[]> {
  return (await db.query(`SELECT seq, actor, payload, created_at FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq`, [mergerEventKind])).rows.map(settingOf);
}
/** The newest recorded setting, or the `github` default when none is recorded. */
export async function recordedMergerMode(db: Queryable): Promise<MergerSetting> {
  const row = (await db.query(`SELECT seq, actor, payload, created_at FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq DESC LIMIT 1`, [mergerEventKind])).rows[0];
  return row ? settingOf(row) : { merger: defaultMergerMode, since: null, setBy: null, reason: null, event: null };
}
/** What /api/status shows as `mergeWriter`: the setting, and one line while the control plane is the merger. */
export async function mergeWriterStatus(db: Queryable) {
  const setting = await recordedMergerMode(db);
  const line = setting.merger === 'control-plane' ? `The control plane is the merge writer since ${setting.since}, set by ${setting.setBy} (${setting.reason})` : null;
  return { ...setting, line };
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The admin-only setting: read by the roles that watch the install, changed by an admin alone. */
export class MergerSettings {
  constructor(private store: Store) {}

  async status(actor: Principal) {
    demand(['admin', 'coordinator', 'reader', 'operator-agent'].includes(actor.role), 'The merger setting is readable by admin, coordinator, reader and operator-agent identities', 403);
    return { ...await mergeWriterStatus(this.store.pool), history: await mergerHistory(this.store.pool) };
  }

  async change(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'admin', 'The merger setting is changed only with an admin credential', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = changeSchema.parse(input);
    const fingerprint = digest({ action: 'merger', data });
    return this.store.transaction(async (db) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result; }
      const current = await recordedMergerMode(db);
      demand(current.merger !== data.merger, `The merger is already ${current.merger}`, 409);
      // GY-1560: control-plane is refused while any shadow disagreement stands unexplained; github never is.
      if (data.merger === 'control-plane') {
        const unexplained = await unexplainedShadowDisagreements(db, await this.store.list());
        demand(!unexplained.length, `Control-plane merger refused while unexplained shadow disagreements stand: ${[...new Set(unexplained.map(entry => entry.key))].join(', ')}`, 409);
      }
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, mergerEventKind, JSON.stringify({ merger: data.merger, reason: data.reason, previous: current.merger })]);
      const result = { ...await mergeWriterStatus(db), history: await mergerHistory(db) };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
}
