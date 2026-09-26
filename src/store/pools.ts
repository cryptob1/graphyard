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
 */
export function trackedPool<P extends pg.Pool>(pool: P): P {
  const open = new Set<pg.PoolClient>();
  openClients.set(pool, open);
  pool.on('connect', client => {
    open.add(client as pg.PoolClient);
    client.once('end', () => open.delete(client as pg.PoolClient));
  });
  return pool;
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
 * renewal (`heartbeat`), `claim`, `complete` (`submit`) and `blocked` — run on, and nothing else.
 * No report, observation, reconciliation or status read ever takes one, so a lease command still
 * gets a connection while every other pool is exhausted behind slow queries.
 */
export const leasePoolConnections = 4;
export const leaseCommands: ReadonlySet<string> = new Set(['heartbeat', 'claim', 'submit', 'blocked']);
