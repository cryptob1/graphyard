/**
 * Lock ordering and retry for the startup migration (2026-09-26). A table's DDL that builds an index (a share lock)
 * and then rebuilds a trigger (an exclusive lock) upgrades its lock mid-transaction; a live writer that had
 * read the table and queued behind the index build then deadlocks with it, and Postgres cancelled the
 * migration on every deploy under live traffic. The tables whose triggers a DDL rebuilds are locked
 * exclusively first, in one statement, so the migration never upgrades a lock it holds.
 *
 * GY-773 also keeps the migration's recorded state here: what the last migration wrote about
 * itself (a digest per table, beside the generation), and the metadata-only write that records
 * it for a release whose whole migration is already recorded — so an upgrade deploy asks no
 * work table for a lock at all.
 */
import type { Pool, PoolClient } from 'pg';
import { advisoryLocks } from './locks.js';
import { migration, migrationDigestComment, migrationDigests, newerSchema, recordedMigrationDigests, tables, type MigrationDigests } from './schema.js';
import { releaseInfo, schemaVersion } from '../release.js';
import { reserve } from './pools.js';

type Step = (waiting: string, sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;

/** How long a migrating release may wait for locks in total: well inside Railway's 120-second health check. */
export const migrationLockTimeoutMs = 30_000;
/**
 * How long one attempt of the migration may wait for its locks before it rolls back and retries
 * (GY-773). A migration queued for an exclusive lock queues every live writer of that table behind
 * it, so each attempt gives up its place after this long: a writer never waits behind the migration
 * for more than one attempt's budget, while the retries still share `migrationLockTimeoutMs`.
 */
export const migrationAttemptLockTimeoutMs = 3_000;
/** The migration's statements ahead of the first table's DDL: the shared trigger function. */
const migrationPrelude = migration.slice(0, migration.indexOf(tables[0].ddl));

/** What the recorded generation says about the migration that ran; `tables` null before per-table digests were recorded. */
export interface RecordedMigration { version: number; migration: string | null; prelude: string | null; tables: Record<string, string> | null }

/** The recorded generation and what it says about the migration that ran, read without any lock a replica holds; null before the first migration. */
export async function recordedMigration(pool: Pool): Promise<RecordedMigration | null> {
  const table = (await pool.query("SELECT to_regclass('graphyard_schema') AS oid")).rows[0].oid;
  if (!table) return null;
  const { rows } = await pool.query("SELECT COALESCE((SELECT MAX(version) FROM graphyard_schema),0) AS version, obj_description(to_regclass('graphyard_schema'),'pg_class') AS digest");
  return { version: Number(rows[0].version), ...recordedMigrationDigests(rows[0].digest) };
}

/**
 * Record this release's per-table digests when the whole migration is already recorded at this
 * generation: that digest is written in the transaction which applied the DDL, so a matching
 * whole digest proves every table's DDL ran, and recording it per table touches graphyard_schema
 * alone (GY-773 — this release's own deploy asks no work table for a lock). Returns false when
 * another release recorded a different migration first, so the caller decides again from what is
 * now recorded.
 */
export async function recordMigrationDigests(pool: Pool, digests: MigrationDigests, timeout: number): Promise<boolean> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL lock_timeout = ${timeout}`);
      await db.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.migration]);
      const { rows } = await db.query("SELECT COALESCE((SELECT MAX(version) FROM graphyard_schema),0) AS version, obj_description(to_regclass('graphyard_schema'),'pg_class') AS digest");
      const version = Number(rows[0].version);
      if (version > schemaVersion) throw newerSchema(version);
      const recorded = recordedMigrationDigests(rows[0].digest);
      if (version !== schemaVersion || recorded.tables !== null || recorded.migration !== digests.migration) { await db.query('ROLLBACK'); return false; }
      await db.query(`COMMENT ON TABLE graphyard_schema IS ${migrationDigestComment(digests)}`);
      await db.query('COMMIT');
      return true;
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '55P03') throw new Error(`Recording schema generation ${schemaVersion}'s migration digests gave up after ${timeout} ms waiting for the migration advisory lock pg_advisory_xact_lock(${advisoryLocks.migration}), held by another session; startup fails instead of outlasting the health check — retry the deploy when it is released`, { cause: error });
    throw error;
  } finally { db.release(); }
}

/** The tables a DDL rebuilds a trigger on, in DDL order. */
export const rebuiltTriggerTables = (ddl: string) => [...new Set([...ddl.matchAll(/^DROP TRIGGER IF EXISTS \w+ ON (\w+);/gm)].map(match => match[1]))];

/** Lock the existing tables whose triggers `ddl` rebuilds exclusively, before the DDL runs. */
export async function lockRebuiltTriggerTables(step: Step, waiting: string, ddl: string) {
  const rebuilt = rebuiltTriggerTables(ddl);
  if (!rebuilt.length) return;
  const present: string[] = (await step(waiting, "SELECT COALESCE(array_agg(name ORDER BY ord), '{}') AS names FROM unnest($1::text[]) WITH ORDINALITY AS t(name, ord) WHERE to_regclass(name) IS NOT NULL", [rebuilt])).rows[0].names;
  if (present.length) await step(waiting, `LOCK TABLE ${present.map(name => `"${name}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`);
}

/**
 * A failure live traffic causes mid-migration is transient: a deadlock (40P01), a lock wait that
 * outlived its budget (55P03), or the watchdog cancelling such a wait (57014). A retried migration
 * rolls back first — every lock of the failed attempt releases at once, so live requests queue
 * behind it no longer — and backs off before the next attempt (GY-773).
 */
export const transientLockError = (error: unknown, cancelledLockWait = true) => {
  const code = (error as { code?: string }).code;
  return code === '40P01' || code === '55P03' || (code === '57014' && cancelledLockWait);
};

/** The backoff before a migration's retry: doubling from 100 ms, capped at 2 s so retries still fit the lock budget. */
export const migrationBackoffMs = (attempt: number) => Math.min(100 * 2 ** Math.max(0, attempt), 2_000);

/**
 * Run the migration, retrying transient lock failures with backoff while `retryable` holds (the
 * migration's deadline): each attempt that fails rolls its locks back at once before waiting, so
 * no retry queues live traffic behind work that already lost.
 */
export async function retryLockFailures(
  migrate: () => Promise<void>,
  retryable: () => boolean,
  rollback: () => Promise<unknown>,
  backoff: (attempt: number) => Promise<unknown> = attempt => new Promise(resolve => setTimeout(resolve, migrationBackoffMs(attempt))),
  transient: (error: unknown) => boolean = error => transientLockError(error),
) {
  for (let attempt = 0; ; attempt++) {
    try { return await migrate(); } catch (error) {
      if (!transient(error) || !retryable()) throw error;
      await rollback();
      await backoff(attempt);
    }
  }
}

/**
 * The startup migration's engine, minus the recorded state it decides from: what `Store.init`
 * runs. A table whose recorded DDL digest matches this release's is left alone entirely (GY-773):
 * no statement of its DDL runs, so no lock — not even briefly — is asked for it.
 */
export async function runStartupMigration(pool: Pool, options: { lockTimeoutMs?: number; attemptLockTimeoutMs?: number } = {}) {
  const digests = migrationDigests();
  const timeout = Math.max(1, Math.floor(options.lockTimeoutMs ?? migrationLockTimeoutMs));
  const attemptTimeout = Math.max(1, Math.floor(options.attemptLockTimeoutMs ?? migrationAttemptLockTimeoutMs));
  const upToDate = (recorded: RecordedMigration | null) => {
    const perTable = recorded?.version === schemaVersion ? recorded.tables : null;
    return recorded?.version === schemaVersion && recorded.prelude === digests.prelude && perTable !== null
      && tables.every(table => perTable[table.name] === digests.tables[table.name]);
  };
  // Decide from what is recorded now, and decide again if another release records while we act.
  let recorded = await recordedMigration(pool);
  for (;;) {
    if (recorded && recorded.version > schemaVersion) throw newerSchema(recorded.version);
    if (upToDate(recorded)) return;
    if (recorded?.version === schemaVersion && recorded.tables === null && recorded.migration === digests.migration) {
      if (await recordMigrationDigests(pool, digests, timeout)) return;
      recorded = await recordedMigration(pool);
      continue;
    }
    break;
  }
  const deadline = Date.now() + timeout;
  // Each attempt's lock waits end at its own deadline, never past the migration's.
  let attemptDeadline = deadline;
  const db = await pool.connect();
  // The watchdog's connection is reserved before the migration begins: at the database's
  // connection limit, startup fails here, boundedly, rather than migrating without a deadline.
  let guard: PoolClient;
  try { guard = await reserve(pool); } catch (error) {
    db.release();
    throw new Error(`Schema migration to generation ${schemaVersion} could not reserve the connection its lock-wait watchdog needs (${(error as Error).message}); startup fails instead of migrating without a deadline — retry the deploy`, { cause: error });
  }
  let lost: Error | undefined;
  const lose = (error: Error) => { lost ??= error; };
  guard.on('error', lose);
  guard.on('end', () => lose(new Error('Connection terminated')));
  let waitingOn = `the migration advisory lock pg_advisory_xact_lock(${advisoryLocks.migration})`;
  // A watchdog that cannot run past the deadline aborts the migration: without it, lock waits
  // inside one step could restart lock_timeout without end.
  let abort!: (error: Error) => void, aborted: Error | undefined;
  const abandoned = new Promise<never>((_, reject) => { abort = error => { aborted ??= error; reject(error); }; });
  abandoned.catch(() => {});
  // Each step may wait for a lock only for what is left of the attempt's deadline.
  const step = async (waiting: string, sql: string, values?: unknown[]) => {
    waitingOn = waiting;
    await Promise.race([db.query(`SET LOCAL lock_timeout = ${Math.max(1, attemptDeadline - Date.now())}`), abandoned]);
    return Promise.race([db.query(sql, values), abandoned]);
  };
  // lock_timeout restarts for every lock one step's statements wait on; past the attempt's
  // deadline the watchdog cancels whichever lock wait is still running. Each attempt arms it
  // afresh (`armed` names the attempt), and a failed attempt disarms it before rolling back.
  let cancelledWaiting = false, watching = true, armed = 0, poll: NodeJS.Timeout | undefined, polling = Promise.resolve();
  const watch = async (pid: number, attempt: number) => {
    if (!watching || attempt !== armed) return;
    try {
      if (lost) throw lost;
      const { rows } = await guard.query("SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid]);
      if (rows[0]?.cancelled) cancelledWaiting = true;
      else if (watching && attempt === armed) poll = setTimeout(() => { polling = watch(pid, attempt); }, 100);
    } catch (error) {
      if (watching) abort(new Error(`Schema migration to generation ${schemaVersion} lost the connection its lock-wait watchdog needs (${(error as Error).message}) past its ${timeout} ms deadline, while waiting for ${waitingOn}; startup fails instead of outlasting the health check — retry the deploy`, { cause: error }));
    }
  };
  try {
    await guard.query('SET application_name = \'graphyard migration watchdog\'');
    await guard.query('SET statement_timeout = 5000');
    const pid = Number((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const arm = () => {
      const attempt = ++armed;
      attemptDeadline = Math.min(deadline, Date.now() + attemptTimeout);
      poll = setTimeout(() => { polling = watch(pid, attempt); }, Math.max(0, attemptDeadline - Date.now()));
    };
    const disarm = async () => { armed++; clearTimeout(poll); await polling.catch(() => {}); };
    const unchangedPrelude = recorded?.prelude === digests.prelude;
    const unchangedTable = (name: string) => recorded?.tables?.[name] === digests.tables[name];
    // A failed attempt is judged once the watchdog's cancel, if one is in flight, has recorded what it did.
    const migrate = () => migrateOnce().catch(async error => { await polling.catch(() => {}); throw error; });
    const migrateOnce = async () => {
      arm();
      // The pool's statement timeout bounds coordination work, not the migration's: its lock waits share the deadline above.
      await db.query('BEGIN'); await db.query('SET LOCAL statement_timeout = 0');
      // The migration's own lock, never the coordination lock (GY-203): two migrations serialize beside live coordination.
      await step(waitingOn, 'SELECT pg_advisory_xact_lock($1)', [advisoryLocks.migration]);
      if (!unchangedPrelude) await step('a lock on the migration\'s shared function graphyard_immutable', migrationPrelude);
      for (const { name, ddl } of tables) {
        if (unchangedTable(name)) continue;
        const waiting = `a lock on table ${name} (or an object its migration touches)`;
        await lockRebuiltTriggerTables(step, waiting, ddl); await step(waiting, ddl);
      }
      const current = Number((await step('a lock on table graphyard_schema', 'SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version);
      if (current > schemaVersion) throw newerSchema(current);
      if (current < schemaVersion) await step(waitingOn, 'INSERT INTO graphyard_schema(version, graphyard_version) VALUES($1,$2)', [schemaVersion, releaseInfo().version]);
      await step(waitingOn, `COMMENT ON TABLE graphyard_schema IS ${migrationDigestComment(digests)}`);
      await Promise.race([db.query('COMMIT'), abandoned]);
    }; await retryLockFailures(migrate, () => !aborted && Date.now() < deadline, async () => { await disarm(); await db.query('ROLLBACK').catch(() => {}); }, undefined, error => transientLockError(error, cancelledWaiting));
  } catch (error) {
    // An abandoned migration's connection is still busy: it is destroyed below, which rolls it back.
    if (aborted) throw aborted;
    // The watchdog's cancel may still be in flight: let it record what it did before this error is judged by it.
    await polling.catch(() => {});
    await db.query('ROLLBACK').catch(() => {});
    // 55P03: a lock wait hit the time left; 57014 after the watchdog fired: it cancelled a lock wait past the deadline.
    const code = (error as { code?: string }).code;
    if (code === '55P03' || (code === '57014' && cancelledWaiting)) throw new Error(`Schema migration to generation ${schemaVersion} gave up after ${timeout} ms waiting for ${waitingOn}, held by another session; startup fails instead of outlasting the health check — retry the deploy when it is released`, { cause: error });
    throw error;
  } finally {
    // A cancel still in flight must not reach whatever this connection runs next.
    watching = false; clearTimeout(poll); await polling;
    db.release(aborted ? true : undefined);
    // The watchdog's session settings must not follow its connection back into the pool.
    guard.release(true);
  }
}
