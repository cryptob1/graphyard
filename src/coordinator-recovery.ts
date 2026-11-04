import { once } from './store/mutations.js';
import { z } from 'zod';
import { demand, type Principal } from './model.js';
import type { Store } from './store.js';

/**
 * GY-1529: `graphyard master recover` repins the known-good coordinator and records the move on the
 * append-only ledger as `policy.coordinator.recovered` {from, to, reason} (no work item), with an
 * admin credential only.
 */
export const coordinatorRecoveredKind = 'policy.coordinator.recovered';
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const schema = z.object({ from: sha.nullable(), to: sha, reason: z.string().trim().min(1).max(1000) }).strict();

export class CoordinatorRecovery {
  constructor(private store: Store) {}

  async record(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'admin', 'A coordinator recovery is recorded only with an admin credential', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = schema.parse(input);
    const receiptInput = { action: 'coordinator-recovered', data };
    return this.store.transaction(async (db) => once(db, actor, key, receiptInput, async () => {
      const row = (await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3) RETURNING seq', [actor.id, coordinatorRecoveredKind, JSON.stringify(data)])).rows[0];
      const result = { recorded: true, event: String(row.seq), ...data };
      return result;
    }));
  }
}
