import { defineRoutes, parseJson } from '../routes.js';
import { storedLoopState, loopStateWriteSchema } from '../loop-state.js';
import type { LoopStateKind } from '../../loop-state.js';

const path = /^\/api\/loop-state\/([a-f0-9]{64})\/(reviews|producers|dispatch)$/;
export const loopStateRoutes = defineRoutes('loop-state', [
  { method: 'GET', path, handle: ({ services, actor }, [scope, kind]) => storedLoopState(services.engine.store, actor, scope).read(kind as LoopStateKind) },
  { method: 'POST', path, async handle(context, [scope, kind]) {
    const data = loopStateWriteSchema.parse(await parseJson(context, 16_000_000));
    await storedLoopState(context.services.engine.store, context.actor, scope).write(kind as LoopStateKind, data.records, data.removed, data.migrate);
    return { saved: true };
  } },
]);
