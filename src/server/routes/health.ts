import { releaseInfo, schemaVersion } from '../../release.js';
import { planeVerdict, probeWrites, readDatabaseCapacity, readGitHubBudget } from '../../master-resources.js';
import { defineRoutes } from '../routes.js';

/**
 * The plane's own health; no token required. Health names the release, schema generation and
 * the commit the build runs so an upgrade can be confirmed from outside the container, and so a
 * deployment probe (`master init --deployment-url .../healthz --deployment-sha-field commit`)
 * and the version-skew guard can read what production serves without a credential.
 *
 * It fails (503, `healthy: false`) when the plane cannot serve its purpose, naming each cause:
 * while a rolled-back write is refused — a read-only database, a standby, a role without write
 * privilege — or while a resource the plane owns is at its bound (GY-132). A plane that answers
 * reads and refuses every write used to report `ok: true` while nothing it was asked to record
 * could be recorded; the loop reads this verdict before it dispatches (docs/master-agent.md).
 */
export const healthRoutes = defineRoutes('health', [
  { method: '*', path: '/healthz', handle: async ({ services, send }) => {
    const pool = services.engine.store.pool;
    await pool.query('SELECT 1');
    const [writeError, database, github] = await Promise.all([probeWrites(pool), readDatabaseCapacity(pool), readGitHubBudget(services.github)]);
    const verdict = planeVerdict(writeError, { database, github });
    const body = { ok: verdict.healthy, healthy: verdict.healthy, writable: verdict.writable, causes: verdict.causes, resources: { database, github },
      ...releaseInfo(), schema: schemaVersion, commit: services.build.commit, protocol: services.build.protocol };
    return verdict.healthy ? body : send(503, body);
  } },
]);
