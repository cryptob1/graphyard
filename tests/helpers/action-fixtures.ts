import type { Principal, Work } from '../../src/model.js';
import { claimAction, settleAction, renewClaim } from '../../src/model/actions.js';
import type { NextActionKind } from '../../src/model/next-action.js';
import { Store, save } from '../../src/store.js';

/** Seed model action bookkeeping for tests of observations, clocks and indexes. */
export async function claimFixture(store: Store, actor: Principal, input: { host: string; executor?: string; kinds?: NextActionKind[]; work?: string; leaseSeconds?: number }) {
  return store.transaction(async (db, now) => {
    const work: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
    const claimed = claimAction(work, { id: input.executor ?? actor.id, host: input.host, principal: actor.id }, now, { kinds: input.kinds, work: input.work, leaseMs: input.leaseSeconds ? input.leaseSeconds * 1000 : undefined });
    if (claimed) for (const item of [claimed.work, ...claimed.yielded]) await save(db, item, actor.id, 'test.action-claimed', now);
    return { action: claimed?.row ?? null };
  });
}

export async function settleFixture(store: Store, actor: Principal, id: string, input: { executor?: string; result: 'done' | 'failed'; reason: string }) {
  return store.transaction(async (db, now) => {
    const work = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document as Work).find(item => item.actionQueue?.actions.some(row => row.id === id))!;
    const transition = settleAction(work, id, { executor: input.executor ?? actor.id, principal: actor.id }, input.result, input.reason, now);
    await save(db, work, actor.id, `test.action-${transition.event}`, now);
    return { action: transition.action };
  });
}

export async function renewFixture(store: Store, actor: Principal, id: string) {
  await store.transaction(async (db, now) => {
    const work = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document as Work).find(item => item.actionQueue?.actions.some(row => row.id === id))!;
    renewClaim(work, id, { executor: actor.id, principal: actor.id }, now);
    await save(db, work, actor.id, 'test.action-renewed', now);
  });
}
