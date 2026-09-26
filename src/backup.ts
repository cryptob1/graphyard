import { createHash } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { advisoryLocks, ledgerOrder, ledgerSeeded, ledgerSequences, ledgerTables } from './store.js';
import { releaseInfo, schemaVersion } from './release.js';

/**
 * A logical, versioned backup of the whole coordination ledger, taken from one consistent
 * snapshot and verified by digest on restore.
 *
 * `pg_dump` remains the right tool for a physical copy of the database, but it needs a
 * client that matches the server major version and it says nothing about what Graphyard
 * expects to find inside. This format is what the documented upgrade, backup and restore
 * exercises are held to: every ledger table, the serial sequences that order work, events,
 * proof-grant history and observations, and the schema generation the rows were written
 * at, so a restore into a release that does not know the schema refuses instead of quietly
 * dropping columns. The table list, its export order and its sequences are derived from
 * the store's table registry, so a table a later feature defines is in the next backup
 * without anyone remembering to add it here.
 *
 * A backup is sensitive. It holds private validation artifacts, evidence and hashed
 * credentials; keep it where the database itself is allowed to be.
 */
export const backupFormat = 'graphyard-backup-v1';
const tableName = z.enum(ledgerTables as [string, ...string[]]);
export const backupSchema = z.object({
  format: z.literal(backupFormat),
  takenAt: z.iso.datetime(),
  graphyardVersion: z.string().min(1).max(100),
  schemaVersion: z.number().int().min(1),
  tables: z.array(z.object({ name: tableName, rows: z.array(z.record(z.string(), z.unknown())) }).strict()),
  sequences: z.array(z.object({ name: z.string().min(1).max(200), value: z.number().int().min(0), called: z.boolean() }).strict()),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type Backup = z.infer<typeof backupSchema>;

/** Stable bytes over everything but the digest itself, so a tampered or truncated file cannot restore. */
export const backupDigest = (backup: Omit<Backup, 'digest'>) => {
  const canonical = (value: unknown): string =>
    Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object' ? `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
  const { digest: _omitted, ...rest } = backup as Backup; void _omitted;
  return `sha256:${createHash('sha256').update(canonical(rest)).digest('hex')}`;
};

/**
 * Read every ledger table from one repeatable-read snapshot. Rows are exported through
 * `row_to_json`, which is what `json_populate_recordset` reads back on restore, so
 * `jsonb`, `bytea`, `uuid` and timestamps round-trip through PostgreSQL's own encoders
 * rather than through a hand-written type map.
 */
export async function createBackup(pool: pg.Pool): Promise<Backup> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // The backup lock, shared: backups run beside each other and beside coordination work, and
    // only a restore excludes them. Never the coordination lock (GY-203).
    await db.query('SELECT pg_advisory_xact_lock_shared($1)', [advisoryLocks.backup]);
    const current = Number((await db.query('SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version);
    if (current !== schemaVersion) throw new Error(`Database schema generation ${current} differs from this release (${schemaVersion}); run the migration first, then back up`);
    const takenAt = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
    const tables: Backup['tables'] = [];
    for (const name of ledgerTables) {
      const rows = (await db.query(`SELECT row_to_json(t) AS row FROM ${name} t ORDER BY ${ledgerOrder[name]}`)).rows.map(r => r.row);
      tables.push({ name, rows });
    }
    const exported: Backup['sequences'] = [];
    for (const { table, column } of ledgerSequences) {
      const sequence = (await db.query('SELECT pg_get_serial_sequence($1,$2) AS name', [table, column])).rows[0].name as string;
      const state = (await db.query(`SELECT last_value, is_called FROM ${sequence}`)).rows[0];
      exported.push({ name: sequence, value: Number(state.last_value), called: state.is_called });
    }
    await db.query('COMMIT');
    const body = { format: backupFormat, takenAt, graphyardVersion: releaseInfo().version, schemaVersion, tables, sequences: exported } as const;
    return backupSchema.parse({ ...body, digest: backupDigest(body) });
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}

/** Verify a backup document without touching any database. */
export function verifyBackup(input: unknown): Backup {
  const backup = backupSchema.parse(input);
  if (backupDigest(backup) !== backup.digest) throw new Error('Backup digest does not match its contents; the file is corrupt or was edited');
  if (backup.schemaVersion > schemaVersion) throw new Error(`Backup was taken at schema generation ${backup.schemaVersion}, newer than this release supports (${schemaVersion}); restore it with the release that took it`);
  const names = backup.tables.map(t => t.name);
  if (new Set(names).size !== names.length) throw new Error('Backup lists a table twice');
  return backup;
}

/**
 * Restore a verified backup into an empty, migrated database, in one transaction.
 *
 * Empty is a requirement, not a default: restoring over a live ledger would resurrect
 * expired ownership beside current assignments and discard evidence submitted since the
 * backup, which is exactly the outcome the deployment guide warns against. Proof grants
 * count: a release that already started against the target has materialized its
 * environment allowlist, and restoring beside that seed would leave two proof authorities
 * claiming the same principals. Migrate the target with `db migrate` instead. Tables the
 * backup does not carry — added by a later migration — stay empty and are reported, and
 * the migration that follows a restore fills in whatever the newer schema needs. A
 * checkpoint the migration itself seeds is not live state: the backup's checkpoint
 * replaces the seed, or the seed stays when the backup predates the table.
 */
export async function restoreBackup(pool: pg.Pool, input: unknown) {
  const backup = verifyBackup(input);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // The backup lock, exclusive: one restore at a time and no backup of a half-restored ledger. Never
    // the coordination lock (GY-203): the target must be empty, so a replica already running against
    // it holds that lock over nothing a restore needs. But an empty target does not keep a write from
    // landing between the emptiness check and the inserts, whichever lock that writer took, so every
    // ledger table is locked against writes (EXCLUSIVE still admits readers) before the check: a
    // coordination write waits for the restore, then sees the restored ledger (GY-257).
    await db.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.backup]);
    await db.query(`LOCK TABLE ${ledgerTables.join(', ')} IN EXCLUSIVE MODE`);
    const current = Number((await db.query('SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version);
    if (current !== schemaVersion) throw new Error(`Restore requires a database migrated to schema generation ${schemaVersion} (found ${current}); run \`graphyard db migrate\` with the release that took the backup or a newer one, then restore`);
    for (const name of ledgerTables) {
      if (name === 'graphyard_schema' || ledgerSeeded.includes(name)) continue;
      const count = Number((await db.query(`SELECT count(*) AS n FROM ${name}`)).rows[0].n);
      if (count) throw new Error(`Restore requires an empty database: ${name} already holds ${count} row(s). ${name.startsWith('proof_grant')
        ? 'A release that started against this database has already seeded proof authority from its environment; restore into a database migrated with `graphyard db migrate` instead, so the backup\'s grants and their history are the only authority'
        : 'Restoring over live state resurrects expired ownership and discards later evidence'}`);
    }
    const restored: Record<string, number> = {};
    for (const table of backup.tables) {
      if (table.name === 'graphyard_schema') continue;
      if (ledgerSeeded.includes(table.name)) await db.query(`DELETE FROM ${table.name}`);
      // Chunked so a large ledger does not become one enormous parameter.
      for (let at = 0; at < table.rows.length; at += 500) {
        await db.query(`INSERT INTO ${table.name} SELECT * FROM json_populate_recordset(NULL::${table.name}, $1::json)`, [JSON.stringify(table.rows.slice(at, at + 500))]);
      }
      restored[table.name] = table.rows.length;
    }
    for (const sequence of backup.sequences) {
      if (!/^(?:public\.)?[a-z_]+_seq$/.test(sequence.name)) throw new Error(`Backup names an unexpected sequence ${sequence.name}`);
      await db.query(`SELECT setval($1, $2, $3)`, [sequence.name, Math.max(sequence.value, 1), sequence.called]);
    }
    await db.query('COMMIT');
    const missing = ledgerTables.filter(name => name !== 'graphyard_schema' && !backup.tables.some(t => t.name === name));
    return { restored, takenAt: backup.takenAt, fromVersion: backup.graphyardVersion, fromSchema: backup.schemaVersion, toSchema: schemaVersion, tablesLeftEmpty: missing };
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}

/** Row counts per ledger table, for comparing a restored database with the backup it came from. */
export async function ledgerCounts(pool: pg.Pool) {
  const counts: Record<string, number> = {};
  for (const name of ledgerTables) counts[name] = Number((await pool.query(`SELECT count(*) AS n FROM ${name}`)).rows[0].n);
  return counts;
}
