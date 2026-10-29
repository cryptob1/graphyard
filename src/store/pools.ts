import type pg from 'pg';

/** How long a migrating release waits for its watchdog's connection; a database at its limit refuses at once. */
const watchdogConnectMs = 5_000;
/** A pool connection, or an error after `watchdogConnectMs` without one (sooner than the pool's own `storeConnectionTimeoutMs`). */
export async function reserve(pool: pg.Pool) {
  let timer: NodeJS.Timeout | undefined;
  const connecting = pool.connect();
  try {
    return await Promise.race([connecting, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no connection within ${watchdogConnectMs} ms`)), watchdogConnectMs); })]);
  } catch (error) {
    connecting.then(late => late.release(), () => {});
    throw error;
  } finally { clearTimeout(timer); }
}

/** How long `closePool` waits for a pool's connections to close before it gives up on the stragglers. */
export const poolCloseBoundMs = 5_000;

const openClients = new WeakMap<pg.Pool, Set<pg.PoolClient>>();

/**
 * Track every connection a pool opens until the connection has actually closed (GY-483). pg-pool's
 * `end()` resolves once it has asked its idle clients to end, not once their sockets have closed,
 * so a caller that stops the database right after it could terminate a still-open client.
 *
 * A connection the database drops (a crash, a restart, `pg_terminate_backend`) raises 'error' on
 * the pool or on its client; unhandled, that event ended the server process (GY-2966). Both are
 * handled for the pool's lifetime with one logged line: pg-pool discards the broken client, the
 * request in flight on it fails, and the next request opens a fresh connection.
 */
export function trackedPool<P extends pg.Pool>(pool: P, log: (message: string) => void = message => console.error(message)): P {
  const open = new Set<pg.PoolClient>();
  openClients.set(pool, open);
  const report = (error: Error) => log(`[store] database connection lost: ${error.message}; the next request reconnects`);
  pool.on('error', report);
  pool.on('connect', client => {
    open.add(client as pg.PoolClient);
    client.on('error', report);
    client.once('end', () => open.delete(client as pg.PoolClient));
  });
  return pool;
}

/** How long the server waits between attempts to reach a database that is not yet accepting connections, at most. */
export const databaseWaitMaxMs = 5_000;
/**
 * Resolve once the database answers a query (GY-2966). A database still starting or recovering —
 * the 2026-10-27 crash left Postgres in recovery for twenty minutes — is waited for with backoff,
 * each wait logged, instead of the server exiting on its first refused connection.
 */
export async function waitForDatabase(pool: pg.Pool, log: (message: string) => void = message => console.error(message), maxMs = databaseWaitMaxMs) {
  for (let attempt = 0; ; attempt++) {
    try { await pool.query('SELECT 1'); return; } catch (error) {
      const wait = Math.min(250 * 2 ** attempt, maxMs);
      log(`[store] the database is not accepting connections (${error instanceof Error ? error.message : String(error)}); retrying in ${wait} ms`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}

/**
 * End a pool and resolve only once every connection it opened has emitted 'end', or after `boundMs`
 * with a warning naming the stragglers. Pool and client 'error' events raised during shutdown (an
 * administrator terminating a closing connection) are logged, never left unhandled.
 */
export async function closePool(pool: pg.Pool, name: string, boundMs = poolCloseBoundMs, log: (message: string) => void = message => console.warn(message)) {
  const open = openClients.get(pool) ?? new Set<pg.PoolClient>();
  const report = (error: Error) => log(`[store] ${name} pool connection error during shutdown: ${error.message}`);
  pool.on('error', report);
  for (const client of open) client.on('error', report);
  pool.on('connect', client => client.on('error', report));
  let timer: NodeJS.Timeout | undefined;
  const closed = Promise.all([...open].map(client => new Promise<void>(resolve => client.once('end', () => resolve()))));
  try {
    await pool.end();
    const outcome = await Promise.race([closed.then(() => 'closed' as const), new Promise<'bounded'>(resolve => { timer = setTimeout(() => resolve('bounded'), boundMs); })]);
    if (outcome === 'bounded') log(`[store] ${name} pool: ${[...open].length} connection(s) still open ${boundMs} ms after end(); continuing shutdown`);
  } finally { clearTimeout(timer); }
}

/**
 * The lease pool (GY-558): the connections the commands that keep or take a worker's lease —
 * renewal (`heartbeat`), `claim`, `complete` (`submit`), `blocked` and `defer` (GY-1726: it ends a
 * live lease as `blocked` does, so a saturated request pool must not turn it into a lease loss) — run on, and nothing else.
 * No report, observation, reconciliation or status read ever takes one, so a lease command still
 * gets a connection while every other pool is exhausted behind slow queries.
 */
export const leasePoolConnections = 4;
export const leaseCommands: ReadonlySet<string> = new Set(['heartbeat', 'claim', 'submit', 'blocked', 'defer']);
