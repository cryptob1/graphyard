import { createHash } from 'node:crypto';
import type pg from 'pg';
import { demand, type Principal, type Work } from '../model.js';
import type { Services } from './routes.js';
import { workIdByRef } from '../store/locked-read.js';

type Db = pg.PoolClient;
/** The fingerprint an idempotent mutation's receipt is matched on. */
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const findWork = async (db: Db, id: string): Promise<Work | undefined> =>
  (await db.query(`SELECT document FROM work_items WHERE id = ${workIdByRef('$1')} FOR UPDATE`, [id])).rows[0]?.document;
export const record = (db: Db, work: Work, actor: string, kind: string, payload: unknown) =>
  db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor, kind, JSON.stringify(payload)]);
/** The caller as the server knows it: an operator agent is re-read from its registry row. */
export async function authenticated(services: Services, db: Db, now: Date, actor: Principal) {
  if (actor.role !== 'operator-agent') return actor;
  demand(services.engine.operatorAuthorizer, 'Operator-agent authorization is unavailable', 503);
  return services.engine.operatorAuthorizer!(db, now, actor);
}
/** The recorded result of a mutation already made under this key, or undefined; a key reused with different input is refused. */
export async function receipt(db: Db, actor: Principal, key: string, fingerprint: string) {
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const row = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
  if (row) demand(row.fingerprint === fingerprint, 'Idempotency key reused with different input');
  return row?.result as unknown;
}
