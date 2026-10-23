import { statfs } from 'node:fs/promises';

// The plane's own health (GY-132), which /healthz reports (routes/health.ts) and the loop reads before it dispatches.

/** `advisory`: the bound is a default nobody configured, so reaching it warns but does not fail health. */
export interface PlaneReading { used: number | null; bound: number | null; detail?: string | null; advisory?: boolean; tables?: { table: string; bytes: number }[] }
/** The plane's database bound when GRAPHYARD_DATABASE_MAX_BYTES is unset. */
export const defaultDatabaseMaxBytes = 10 * 1024 ** 3;

/**
 * Whether the plane can record anything: a write in a transaction that is rolled back. A
 * read-only database, a standby, or a role without write privilege refuses it; a database that
 * cannot be reached refuses it too.
 */
export async function probeWrites(pool: { connect(): Promise<{ query(sql: string): Promise<unknown>; release(): void }> }): Promise<string | null> {
  let client: Awaited<ReturnType<typeof pool.connect>> | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    try {
      await client.query('UPDATE graphyard_schema SET version = version WHERE false');
      await client.query('SELECT pg_current_xact_id()');
    } finally { await client.query('ROLLBACK').catch(() => {}); }
    return null;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  finally { client?.release(); }
}

/**
 * The size of the volume holding the database's data directory, when the plane can see it: the
 * directory is readable to the database role (`data_directory` needs pg_read_all_settings) and the
 * same path exists on this host — an embedded, compose or same-machine database. A database on its
 * own host (a managed service) answers null and the default bound stands.
 */
export async function readDatabaseVolumeBytes(pool: { query(sql: string): Promise<{ rows: any[] }> }): Promise<{ bytes: number; path: string } | null> {
  try {
    const path = String((await pool.query("SELECT current_setting('data_directory') AS path")).rows[0]?.path ?? '');
    if (!path) return null;
    const volume = await statfs(path);
    const bytes = Number(volume.blocks) * Number(volume.bsize);
    return Number.isFinite(bytes) && bytes > 0 ? { bytes, path } : null;
  } catch { return null; }
}

/**
 * The plane's database size against its bound: GRAPHYARD_DATABASE_MAX_BYTES when set, else the
 * size of the database's own volume when the plane can read it (GY-979: the fixed 10 GiB default
 * reported headroom a 19 GB volume did not have, or lacked), else the default. Only the default is
 * a guess at a volume nobody sized, so it alone is advisory: `master status` warns on it, but a
 * configured or measured bound fails health.
 */
export async function readDatabaseCapacity(pool: { query(sql: string): Promise<{ rows: any[] }> }, env: NodeJS.ProcessEnv = process.env): Promise<PlaneReading> {
  const configured = Number(env.GRAPHYARD_DATABASE_MAX_BYTES);
  const set = Number.isFinite(configured) && configured > 0;
  const volume = set ? null : await readDatabaseVolumeBytes(pool);
  const bound = set ? configured : volume?.bytes ?? defaultDatabaseMaxBytes;
  const advisory = !set && !volume;
  const against = set ? 'GRAPHYARD_DATABASE_MAX_BYTES' : volume ? `the size of the database volume at ${volume.path}` : 'the default bound (GRAPHYARD_DATABASE_MAX_BYTES unset and the database volume not readable from the plane; it warns but does not fail health)';
  try {
    const used = Number((await pool.query('SELECT pg_database_size(current_database()) AS size')).rows[0].size);
    // The largest tables, so growth is attributed from outside the database (a catalogue read, no scan).
    const tables = await pool.query(`SELECT relname AS table, pg_total_relation_size(c.oid) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 6`).then(r => r.rows.map(row => ({ table: String(row.table), bytes: Number(row.bytes) })), () => undefined);
    return { used, bound, advisory, ...(tables ? { tables } : {}), detail: `pg_database_size against ${against}` };
  } catch (error) { return { used: null, bound, advisory, detail: `pg_database_size could not be read: ${error instanceof Error ? error.message : String(error)}` }; }
}

/**
 * The plane's own health: unhealthy while writes are refused or a resource it owns is exhausted,
 * each cause named. A plane that cannot record results must not be dispatched into. A database
 * at an advisory (default) bound is reported by `master status`, not here.
 */
export function planeVerdict(writeError: string | null, resources: { database: PlaneReading | null }) {
  const causes: string[] = [];
  if (writeError) causes.push(`Writes are refused: ${writeError}`);
  const exhausted = (reading: PlaneReading | null) => !!reading && reading.used !== null && reading.bound !== null && reading.used >= reading.bound;
  if (exhausted(resources.database) && !resources.database!.advisory) causes.push(`Control-plane database is at its bound: ${resources.database!.used} of ${resources.database!.bound} bytes (${resources.database!.detail ?? 'pg_database_size'}); grow the volume and raise GRAPHYARD_DATABASE_MAX_BYTES`);
  return { healthy: causes.length === 0, writable: !writeError, causes };
}
