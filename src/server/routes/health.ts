import { releaseInfo, schemaVersion } from '../../release.js';
import { defineRoutes } from '../routes.js';

/**
 * Database reachability; no token required. Health names the release, schema generation and
 * the commit the build runs so an upgrade can be confirmed from outside the container, and so a
 * deployment probe (`master init --deployment-url .../healthz --deployment-sha-field commit`)
 * and the version-skew guard can read what production serves without a credential. It still
 * proves only database reachability.
 */
export const healthRoutes = defineRoutes('health', [
  { method: '*', path: '/healthz', handle: async ({ services }) => { await services.engine.store.pool.query('SELECT 1'); return { ok: true, ...releaseInfo(), schema: schemaVersion, commit: services.build.commit, protocol: services.build.protocol }; } },
]);
