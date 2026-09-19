import { defineRoutes } from '../routes.js';

/**
 * Database reachability; no token required. The reply names the commit the build runs so a
 * deployment probe (`master init --deployment-url .../healthz --deployment-sha-field commit`)
 * and the version-skew guard can read what production serves without a credential.
 */
export const healthRoutes = defineRoutes('health', [
  { method: '*', path: '/healthz', handle: async ({ services }) => { await services.engine.store.pool.query('SELECT 1'); return { ok: true, commit: services.build.commit, protocol: services.build.protocol }; } },
]);
