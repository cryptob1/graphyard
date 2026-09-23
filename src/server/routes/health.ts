import { releaseInfo, schemaVersion } from '../../release.js';
import { planeVerdict, probeWrites, readDatabaseCapacity, readGitHubBudget } from '../../master-resources.js';
import { defineRoutes } from '../routes.js';

/**
 * The plane's own health; no token required. Health names the release, schema generation and
 * the commit the build runs so an upgrade can be confirmed from outside the container, and so a
 * deployment probe (`master init --deployment-url .../healthz --deployment-sha-field commit`)
 * and the version-skew guard can read what production serves without a credential.
 *
 * It reports the plane unhealthy (`healthy: false`, `ok: false`), naming each cause, while it
 * cannot serve its purpose: while a rolled-back write is refused — a read-only database, a standby,
 * a role without write privilege — or while a resource the plane owns is at its bound (GY-132). A
 * plane that answers reads and refuses every write used to report `ok: true` while nothing it was
 * asked to record could be recorded; the loop reads this verdict before it dispatches
 * (docs/master-agent.md).
 *
 * The plain endpoint still answers 200 for that verdict: it is the liveness and readiness probe of
 * the Helm chart and Railway, and restarting a plane, or pulling it from its Service, would not give
 * back a spent budget or a full volume — it would only take away the API the operator recovers
 * through. It fails (500) when the process cannot reach its database at all. `/healthz?strict`
 * answers 503 whenever the verdict is unhealthy, for a monitor that alerts on the status alone.
 */
export const healthRoutes = defineRoutes('health', [
  { method: '*', path: '/healthz', handle: async ({ services, send, url }) => {
    const pool = services.engine.store.pool;
    await pool.query('SELECT 1');
    const [writeError, database, github] = await Promise.all([probeWrites(pool), readDatabaseCapacity(pool), readGitHubBudget(services.github)]);
    const verdict = planeVerdict(writeError, { database, github });
    const body = { ok: verdict.healthy, healthy: verdict.healthy, writable: verdict.writable, causes: verdict.causes, resources: { database, github },
      ...releaseInfo(), schema: schemaVersion, commit: services.build.commit, protocol: services.build.protocol };
    return verdict.healthy || !url.searchParams.has('strict') ? body : send(503, body);
  } },
]);
