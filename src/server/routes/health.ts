import { releaseInfo, schemaVersion } from '../../release.js';
import { defineRoutes } from '../routes.js';

/**
 * Database reachability; no token required. Health names the release and schema generation
 * so an upgrade can be confirmed from outside the container without a credential; it still
 * proves only database reachability.
 */
export const healthRoutes = defineRoutes('health', [
  { method: '*', path: '/healthz', handle: async ({ services }) => { await services.engine.store.pool.query('SELECT 1'); return { ok: true, ...releaseInfo(), schema: schemaVersion }; } },
]);
