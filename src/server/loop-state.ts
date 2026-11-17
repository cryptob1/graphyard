import { z } from 'zod';
import { demand, Refusal, type Principal } from '../model.js';
import type { Store } from '../store.js';
import { reviewRecordSchema } from '../reviewer.js';
import { producerRecordSchema } from '../producer.js';
import { dispatchCursorSchema } from '../dispatch/cursor.js';
import type { LoopStateClient, LoopStateKind } from '../loop-state.js';

/** How long a loop-state write waits for another writer of the same record before it answers a conflict. */
export const loopStateLockWaitMs = 2_000;
const schemas = { reviews: reviewRecordSchema, producers: producerRecordSchema, dispatch: dispatchCursorSchema };
/** Coordinator-only bookkeeping; these records never grant a work lease, review or proof. */
export function storedLoopState(store: Store, actor: Principal, scope: string): LoopStateClient {
  const authorize = () => demand(actor.role === 'coordinator' || actor.role === 'admin', 'Loop state belongs to the executor coordinator', 403);
  return {
    async read(kind) {
      authorize();
      return (await store.pool.query('SELECT data FROM loop_state WHERE scope=$1 AND kind=$2 ORDER BY position', [scope, kind])).rows.map(row => row.data);
    },
    async write(kind, records, removed = [], migrate = false) {
      authorize();
      const parsed = records.map(record => schemas[kind].parse(record));
      if (!parsed.length && !removed.length) return;
      // GY-3341: executor bookkeeping takes no coordination lock. The write is not a coordination
      // decision — it touches no work item — but it used to queue behind the fleet advisory lock
      // anyway, and on a host slow enough for coordination batches to hold that lock for minutes
      // the wait outlived the pool's statement timeout and the control plane answered 500.
      // GY-3366: two writers of one record (a restarting loop and the old one, or the loop and a master
      // command) queue on its row lock. A wait that outlived the server's own timeout was answered 500;
      // a lost race is now answered as a conflict the client retries at once.
      await store.transaction(async db => {
        await db.query(`SET LOCAL lock_timeout = '${loopStateLockWaitMs}ms'`);
        const ids = parsed.map(record => kind === 'dispatch' ? 'cursor' : (record as { id: string }).id);
        for (const [index, record] of parsed.entries()) {
          const id = ids[index];
          await db.query(`INSERT INTO loop_state(scope,kind,id,data) VALUES($1,$2,$3,$4)
            ON CONFLICT(scope,kind,id) ${migrate ? 'DO NOTHING' : 'DO UPDATE SET data=EXCLUDED.data'}`, [scope, kind, id, JSON.stringify(record)]);
        }
        if (removed.length) await db.query('DELETE FROM loop_state WHERE scope=$1 AND kind=$2 AND id=ANY($3::text[])', [scope, kind, removed]);
        // GY-3342: the records live in loop_state; the ledger row names only which ids changed,
        // each id once — dispatch names its one cursor row however many records it wrote.
        await db.query('INSERT INTO events(actor,kind,payload) VALUES($1,$2,$3)', [actor.id, `loop-state.${migrate ? 'migrated' : 'saved'}`, JSON.stringify({ scope, kind, ids: [...new Set(ids)], removed })]);
      }, { coordinationLock: false }).catch(error => {
        const code = (error as { code?: string }).code ?? '';
        if (['55P03', '40P01'].includes(code)) throw new Refusal(`Loop state ${kind} is being written by another writer; retry`, 409, { code: 'loop-state-conflict' });
        // GY-3424: a record the database cannot store (class 22, e.g. a NUL in jsonb) is the writer's to fix, so the
        // refusal names Postgres's reason for master status rather than a bare 500 the loop retries every cycle.
        if (code.startsWith('22')) throw new Refusal(`Loop state ${kind} was refused by the database: ${(error as Error).message}`, 422, { code: 'loop-state-invalid' });
        throw error;
      });
    },
  };
}
export const loopStateWriteSchema = z.object({ records: z.array(z.record(z.string(), z.unknown())), removed: z.array(z.string()).default([]), migrate: z.boolean().default(false) }).strict();
export const loopStateKinds: LoopStateKind[] = ['reviews', 'producers', 'dispatch'];
