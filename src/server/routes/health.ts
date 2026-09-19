import { defineRoutes } from '../routes.js';

/** Database reachability; no token required. */
export const healthRoutes = defineRoutes('health', [
  { method: '*', path: '/healthz', handle: async ({ services }) => { await services.engine.store.pool.query('SELECT 1'); return { ok: true }; } },
]);
