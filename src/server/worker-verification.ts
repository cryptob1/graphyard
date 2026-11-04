import { z } from 'zod';
import { activeLease, demand, type Principal } from '../model.js';
import { lockedWork } from '../store/locked-read.js';
import { save } from '../store.js';
import type { Services } from './routes.js';
import { dispatchWorkerVerification } from './worker-verification-queue.js';

const schema = z.object({ head: z.string().regex(/^[a-f0-9]{40}$/), epoch: z.number().int().positive(),
  mode: z.enum(['verify', 'complete']), preserves: z.array(z.string()).max(1000).optional() }).strict();

/** The lease holder requests only its recorded criteria, never arbitrary host commands. */
export async function workerVerification(services: Services, actor: Principal, id: string, body: unknown) {
  const input = schema.parse(body);
  demand(actor.role === 'worker', 'Only an implementation worker may request self-verification', 403);
  const read = () => services.engine.store.transaction(async (db, now) => {
    const work = (await lockedWork(db, [id])).find(work => work.id === id || work.key === id);
    demand(work, 'Work item not found', 404);
    activeLease(work!, actor, input.epoch, now);
    return work!;
  });
  const work = await read();
  const workspace = work.workspaces.find(entry => entry.owner === actor.id && entry.epoch === input.epoch);
  demand(workspace, 'The lease has no assigned worktree', 409);
  // The server's /repo and private filesystem are not Docker host paths.
  const result = await dispatchWorkerVerification(services, {
    host: workspace!.host, branch: workspace!.branch, work, input, baseBranch: services.engine.baseBranch,
  });
  demand(result.record.head === input.head, 'Verification returned a different head', 409);
  await services.engine.store.transaction(async (db, now) => {
    const current = (await lockedWork(db, [id])).find(entry => entry.id === work.id)!;
    activeLease(current, actor, input.epoch, now);
    demand(JSON.stringify(current.criteria) === JSON.stringify(work.criteria), 'Criteria changed during verification', 409);
    await save(db, current, actor.id, 'work.self-verified', now, { epoch: input.epoch, ...result });
  });
  return result;
}
