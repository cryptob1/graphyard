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
 * through. It fails (500) when the process cannot reach its database at all, including when a
 * connection hangs past the bound without the pool being full. `/healthz?strict`
 * answers 503 whenever the verdict is unhealthy, for a monitor that alerts on the status alone.
 */
/** How long the health probe waits for its resource checks before answering alive without them. */
export const healthCheckWaitMs = 3000;
/** How long a probe handed its client from the pool's queue may hold it without an answer and still be the busy pool rather than an unreachable database. */
export const healthCheckQueryGraceMs = 1000;
/**
 * The one database probe per pool that has not settled. A later request joins it rather than asking
 * the pool for another slot, so probes answered past their bound never pile up: a probe queued behind
 * a pool saturated for minutes stays the only acquisition health has waiting, and when clients free
 * up it takes one slot, not one per health request that arrived meanwhile. A probe past its bound that
 * never queued was opening a connection the database did not answer, and one handed its client that
 * has held it past the grace is waiting on a database that does not answer: while either is still
 * open, the next request fails at once instead of waiting on it again, so an outage never reads as
 * the busy pool. A queued probe still waiting for its client is the busy pool.
 */
interface DatabaseProbe { startedAt: number; queued: boolean; acquiredAt: number | null; answered: Promise<true> }
const outstandingProbes = new WeakMap<object, DatabaseProbe>();
/** Why a probe that has not answered means the database is unreachable, or null while it is only the busy pool. */
function unanswered(probe: DatabaseProbe, now: number) {
  if (!probe.queued) return 'was not waiting for a pooled connection';
  const held = probe.acquiredAt === null ? 0 : now - probe.acquiredAt;
  return held >= healthCheckQueryGraceMs ? `held its pooled connection for ${held} ms without an answer` : null;
}
function startProbe(pool: any): DatabaseProbe {
  const waiting = Number(pool.waitingCount) || 0, idle = Number(pool.idleCount) || 0;
  const connecting = pool.connect();
  const probe: DatabaseProbe = { startedAt: Date.now(), queued: idle === 0 && (Number(pool.waitingCount) || 0) > waiting, acquiredAt: null, answered: null as any };
  probe.answered = connecting.then(async (client: any) => {
    probe.acquiredAt = Date.now();
    try { await client.query('SELECT 1'); client.release(); } catch (error) { client.release(error as Error); throw error; }
    return true as const;
  });
  // A probe that finishes after the bound has already been answered for; its failure is not unhandled.
  probe.answered.catch(() => {});
  const settle = () => { if (outstandingProbes.get(pool) === probe) outstandingProbes.delete(pool); };
  probe.answered.then(settle, settle);
  outstandingProbes.set(pool, probe);
  return probe;
}
export const healthRoutes = defineRoutes('health', [
  { method: '*', path: '/healthz', handle: async ({ services, send, url }) => {
    const pool = services.engine.store.pool;
    // Even the reachability probe is bounded: on a fresh process the reconciliation step can hold
    // every pooled connection for minutes, and an unbounded SELECT 1 then fails the deploy's health check.
    // Only a probe queued behind a full pool is that busy pool: one that held or was opening a
    // connection when the bound passed met a database that did not answer — a blackholed network
    // hangs rather than refusing — and that is a database the process cannot reach. Whether the probe
    // queued is recorded when it asks for its client, not sampled at the deadline, and so is when it
    // was handed one: a queued probe still waiting at the bound, or handed its client too late for a
    // SELECT 1 to have answered, is the busy pool; one that held its client for most of the bound
    // without an answer met a database that did not answer, whatever queue it waited in first.
    const earlier = outstandingProbes.get(pool);
    const stuck = earlier && Date.now() - earlier.startedAt >= healthCheckWaitMs ? unanswered(earlier, Date.now()) : null;
    if (stuck) throw new Error(`an earlier database probe ${stuck} and is still waiting on the database; the database is unreachable`);
    const probe = earlier ?? startProbe(pool);
    const reachable = await Promise.race([probe.answered, new Promise<false>(resolve => setTimeout(() => resolve(false), healthCheckWaitMs).unref())]);
    const cause = reachable ? null : unanswered(probe, Date.now());
    if (cause) throw new Error(`database probe did not finish within ${healthCheckWaitMs} ms and ${cause}; the database is unreachable`);
    if (!reachable) return { ok: true, healthy: true, writable: null, causes: [`database probe did not finish within ${healthCheckWaitMs} ms; the pool is busy`], resources: null,
      ...releaseInfo(), schema: schemaVersion, commit: services.build.commit, protocol: services.build.protocol };
    // Liveness must not wait on a pool the reconciliation jobs have filled: a probe that queued
    // behind them failed every deployment's health check (2026-09-23). The resource checks get a
    // bounded wait; past it the plane answers alive and names the checks it could not finish.
    const checks = Promise.all([probeWrites(pool), readDatabaseCapacity(pool), readGitHubBudget(services.github)]);
    const settled = await Promise.race([checks, new Promise<null>(resolve => setTimeout(() => resolve(null), healthCheckWaitMs).unref())]);
    if (!settled) return { ok: true, healthy: true, writable: null, causes: [`resource checks did not finish within ${healthCheckWaitMs} ms; the database pool is busy`], resources: null,
      ...releaseInfo(), schema: schemaVersion, commit: services.build.commit, protocol: services.build.protocol };
    const [writeError, database, github] = settled;
    const verdict = planeVerdict(writeError, { database, github });
    const body = { ok: verdict.healthy, healthy: verdict.healthy, writable: verdict.writable, causes: verdict.causes, resources: { database, github },
      ...releaseInfo(), schema: schemaVersion, commit: services.build.commit, protocol: services.build.protocol };
    return verdict.healthy || !url.searchParams.has('strict') ? body : send(503, body);
  } },
]);
