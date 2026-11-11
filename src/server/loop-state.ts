import { z } from 'zod';
import { demand, type Principal } from '../model.js';
import type { Store } from '../store.js';
import { reviewRecordSchema } from '../reviewer.js';
import { producerRecordSchema } from '../producer.js';
import { dispatchCursorSchema } from '../dispatch/cursor.js';
import type { LoopStateClient, LoopStateKind } from '../loop-state.js';

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
      await store.transaction(async db => {
        for (const record of parsed) {
          const id = kind === 'dispatch' ? 'cursor' : (record as { id: string }).id;
          await db.query(`INSERT INTO loop_state(scope,kind,id,data) VALUES($1,$2,$3,$4)
            ON CONFLICT(scope,kind,id) ${migrate ? 'DO NOTHING' : 'DO UPDATE SET data=EXCLUDED.data'}`, [scope, kind, id, JSON.stringify(record)]);
        }
        if (removed.length) await db.query('DELETE FROM loop_state WHERE scope=$1 AND kind=$2 AND id=ANY($3::text[])', [scope, kind, removed]);
        await db.query('INSERT INTO events(actor,kind,payload) VALUES($1,$2,$3)', [actor.id, `loop-state.${migrate ? 'migrated' : 'saved'}`, JSON.stringify({ scope, kind, records: parsed, removed })]);
      });
    },
  };
}
export const loopStateWriteSchema = z.object({ records: z.array(z.record(z.string(), z.unknown())), removed: z.array(z.string()).default([]), migrate: z.boolean().default(false) }).strict();
export const loopStateKinds: LoopStateKind[] = ['reviews', 'producers', 'dispatch'];
