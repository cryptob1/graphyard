import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import type pg from 'pg';
import { advisoryLocks, ledgerOrder, ledgerSeeded, ledgerSequences, ledgerTables } from './store.js';
import { releaseInfo, schemaVersion } from './release.js';
import { retiredTables } from './store/schema.js';
import { retryDeadlocks } from './store/migration-locks.js';

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
const tableName = z.enum([...ledgerTables, ...retiredTables]);
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
const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  : JSON.stringify(value) ?? 'null';
export const backupDigest = (backup: Omit<Backup, 'digest'>) => {
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
    // GY-3538: a whole-ledger read outlasts any request's statement timeout, the pool's or the role's.
    await db.query('SET LOCAL statement_timeout = 0');
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

/*
 * GY-3538: the backup file, streamed. The same graphyard-backup-v1 document and digest as
 * createBackup, laid out one row per line, so neither the backup, its verification nor its restore
 * holds the ledger in memory, and a ledger of many gigabytes backs up and restores:
 *
 *   {"format":…,"takenAt":…,"graphyardVersion":…,"schemaVersion":…,"sequences":[…],"tables":[
 *   {"name":"events","rows":[
 *   ROW
 *   ,ROW
 *   ]}
 *   ,{"name":"…","rows":[
 *   ]}
 *   ],"digest":"sha256:…"}
 *
 * The digest hashes the canonical form createBackup's digest hashes, row by row. A file older
 * releases wrote, one line, is read whole as before.
 */
const tablesOpen = '"tables":[';
type Header = Omit<Backup, 'tables' | 'digest'>;
const headerSchema = backupSchema.omit({ tables: true, digest: true });
/** The canonical bytes before the tables and after them, in the digest's sorted key order. */
const digestHead = (header: Header) => `{"format":${JSON.stringify(header.format)},"graphyardVersion":${JSON.stringify(header.graphyardVersion)},"schemaVersion":${header.schemaVersion},"sequences":${canonical(header.sequences)},"tables":[`;
const digestTail = (header: Header) => `],"takenAt":${JSON.stringify(header.takenAt)}}`;
/** Rows a restore inserts per statement, and the bytes that close a chunk early. */
const restoreChunkRows = 500, restoreChunkBytes = 8_000_000;

/** Write a backup of the whole ledger to FILE (created, never overwritten) from one snapshot, a page of rows at a time. */
export async function writeBackupFile(pool: pg.Pool, file: string) {
  const out = await open(file, 'wx', 0o600);
  const db = await pool.connect().catch(async error => { await out.close(); await rm(file, { force: true }); throw error; });
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query('SET LOCAL statement_timeout = 0');
    await db.query('SELECT pg_advisory_xact_lock_shared($1)', [advisoryLocks.backup]);
    const current = Number((await db.query('SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version);
    if (current !== schemaVersion) throw new Error(`Database schema generation ${current} differs from this release (${schemaVersion}); run the migration first, then back up`);
    const takenAt = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
    const sequences: Backup['sequences'] = [];
    for (const { table, column } of ledgerSequences) {
      const sequence = (await db.query('SELECT pg_get_serial_sequence($1,$2) AS name', [table, column])).rows[0].name as string;
      const state = (await db.query(`SELECT last_value, is_called FROM ${sequence}`)).rows[0];
      sequences.push({ name: sequence, value: Number(state.last_value), called: state.is_called });
    }
    const header: Header = { format: backupFormat, takenAt, graphyardVersion: releaseInfo().version, schemaVersion, sequences };
    const hash = createHash('sha256').update(digestHead(header));
    await out.write(`${JSON.stringify(header).slice(0, -1)},${tablesOpen}\n`);
    const rows: Record<string, number> = {};
    for (const [index, name] of ledgerTables.entries()) {
      const start = `${index ? ',' : ''}{"name":${JSON.stringify(name)},"rows":[`;
      hash.update(start); await out.write(`${start}\n`);
      await db.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT row_to_json(t) AS row FROM ${name} t ORDER BY ${ledgerOrder[name]}`);
      let count = 0;
      for (;;) {
        const page = (await db.query('FETCH 200 FROM backup_rows')).rows;
        if (!page.length) break;
        let lines = '';
        for (const { row } of page) { const lead = count++ ? ',' : ''; hash.update(lead + canonical(row)); lines += `${lead}${JSON.stringify(row)}\n`; }
        await out.write(lines);
      }
      await db.query('CLOSE backup_rows');
      hash.update(']}'); await out.write(']}\n');
      rows[name] = count;
    }
    await db.query('COMMIT');
    const digest = `sha256:${hash.update(digestTail(header)).digest('hex')}`;
    await out.write(`],"digest":${JSON.stringify(digest)}}\n`);
    await out.close();
    return { takenAt, schema: schemaVersion, digest, rows };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    await out.close().catch(() => {}); await rm(file, { force: true });
    throw error;
  } finally { db.release(); }
}

/** A file's lines, read as the consumer asks for them: a slow restore never buffers the file. */
async function* fileLines(file: string) {
  let rest = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    const lines = (rest + chunk).split('\n'); rest = lines.pop()!;
    yield* lines;
  }
  if (rest) yield rest;
}

type Chunk = { name: string; rows: unknown[] };
/** The file's header and its tables' rows in chunks (every table at least one, possibly empty), digest-checked at the end when `hash` is given. */
async function* streamedChunks(file: string, hash?: Hash): AsyncGenerator<Chunk, Header & { digest: string }> {
  let header: Header | null = null, name: string | null = null, rows: unknown[] = [], bytes = 0, count = 0;
  for await (const line of fileLines(file)) {
    if (!header) {
      const { tables: _tables, ...rest } = JSON.parse(`${line}]}`); void _tables;
      header = headerSchema.parse(rest);
      hash?.update(digestHead(header));
    } else if (line.startsWith('],"digest":')) {
      const digest = String(JSON.parse(`{${line.slice(2)}`).digest);
      if (hash && `sha256:${hash.update(digestTail(header)).digest('hex')}` !== digest) throw new Error('Backup digest does not match its contents; the file is corrupt or was edited');
      return { ...header, digest };
    } else if (line === ']}') {
      hash?.update(']}');
      yield { name: name!, rows }; name = null; rows = []; bytes = 0;
    } else if (name === null) {
      const start = /^(,?)\{"name":("[a-z_]+"),"rows":\[$/.exec(line);
      if (!start) throw new Error('Backup file is not a backup Graphyard wrote; the file is corrupt or truncated');
      hash?.update(line); name = tableName.parse(JSON.parse(start[2])); count = 0;
    } else {
      const row = z.record(z.string(), z.unknown()).parse(JSON.parse(line.startsWith(',') ? line.slice(1) : line));
      hash?.update(`${count++ ? ',' : ''}${canonical(row)}`);
      rows.push(row); bytes += line.length;
      if (rows.length >= restoreChunkRows || bytes >= restoreChunkBytes) { yield { name, rows }; rows = []; bytes = 0; }
    }
  }
  throw new Error('Backup file ends before its digest; the file is truncated');
}

const streamed = async (file: string) => { for await (const line of fileLines(file)) return line.endsWith(tablesOpen); return false; };

/** Verify a backup file without touching any database or holding it in memory: its digest, generation and table list, and each table's row count. */
export async function verifyBackupFile(file: string) {
  if (!await streamed(file)) { const backup = verifyBackup(JSON.parse(await readFile(file, 'utf8'))); return { ...backup, rows: Object.fromEntries(backup.tables.map(t => [t.name, t.rows.length])) }; }
  const chunks = streamedChunks(file, createHash('sha256')), rows: Record<string, number> = {}, seen: string[] = [];
  for (let next = await chunks.next(); ; next = await chunks.next()) {
    if (next.done) {
      if (next.value.schemaVersion > schemaVersion) throw new Error(`Backup was taken at schema generation ${next.value.schemaVersion}, newer than this release supports (${schemaVersion}); restore it with the release that took it`);
      return { ...next.value, rows };
    }
    if (!(next.value.name in rows)) { if (seen.includes(next.value.name)) throw new Error('Backup lists a table twice'); seen.push(next.value.name); rows[next.value.name] = 0; }
    rows[next.value.name] += next.value.rows.length;
  }
}

/** Restore a backup file into an empty, migrated database: verified first, then read again a chunk at a time. */
export async function restoreBackupFile(pool: pg.Pool, file: string) {
  if (!await streamed(file)) return restoreBackup(pool, JSON.parse(await readFile(file, 'utf8')));
  const verified = await verifyBackupFile(file);
  return restoreFrom(pool, { ...verified, tableNames: Object.keys(verified.rows), chunks: () => streamedChunks(file) });
}

/** How many times a restore runs when live traffic deadlocks it (40P01) before the deadlock is reported. */
const restoreDeadlockAttempts = 5;

/**
 * Restore a verified backup into an empty, migrated database, in one transaction.
 *
 * Empty is a requirement, not a default: restoring over a live ledger would resurrect
 * expired ownership beside current assignments and discard evidence submitted since the
 * backup, which is exactly the outcome the deployment guide warns against. Migrate the
 * target with `db migrate` instead. Retired tables are verified but skipped, as the
 * migration would drop them, and reported in tablesRetired. Tables the
 * backup does not carry — added by a later migration — stay empty and are reported, and
 * the migration that follows a restore fills in whatever the newer schema needs. A
 * checkpoint the migration itself seeds is not live state: the backup's checkpoint
 * replaces the seed, or the seed stays when the backup predates the table.
 */
export async function restoreBackup(pool: pg.Pool, input: unknown) {
  const backup = verifyBackup(input);
  return restoreFrom(pool, { ...backup, tableNames: backup.tables.map(table => table.name), async *chunks() {
    for (const table of backup.tables) for (let at = 0; at === 0 || at < table.rows.length; at += restoreChunkRows) yield { name: table.name, rows: table.rows.slice(at, at + restoreChunkRows) };
  } });
}

type RestoreSource = Header & { tableNames: string[]; chunks(): AsyncIterable<Chunk> };
async function restoreFrom(pool: pg.Pool, backup: RestoreSource) {
  const db = await pool.connect();
  const restored: Record<string, number> = {};
  const restore = async () => {
    await db.query('BEGIN');
    // The backup lock, exclusive: one restore at a time and no backup of a half-restored ledger. Never
    // the coordination lock (GY-203): the target must be empty, so a replica already running against
    // it holds that lock over nothing a restore needs. But an empty target does not keep a write from
    // landing between the emptiness check and the inserts, whichever lock that writer took, so every
    // ledger table is locked against writes (EXCLUSIVE still admits readers) before that check, once the
    // schema check has shown the tables exist: a write waits for the restore, then sees its ledger (GY-257).
    await db.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.backup]);
    const current = Number((await db.query('SELECT COALESCE(MAX(version),0) AS version FROM graphyard_schema')).rows[0].version);
    if (current !== schemaVersion) throw new Error(`Restore requires a database migrated to schema generation ${schemaVersion} (found ${current}); run \`graphyard db migrate\` with the release that took the backup or a newer one, then restore`);
    // Postgres takes those locks one table at a time, so a writer holding a later table that then asks for
    // one already locked here deadlocks with the restore, and Postgres may abort the restore (GY-443). That
    // is transient, as it is for a migration: the restore rolls back and runs again, waits for the writer
    // this time, and then either restores or refuses the ledger that writer left non-empty.
    await db.query(`LOCK TABLE ${ledgerTables.join(', ')} IN EXCLUSIVE MODE`);
    for (const name of ledgerTables) {
      if (name === 'graphyard_schema' || ledgerSeeded.includes(name)) continue;
      const count = Number((await db.query(`SELECT count(*) AS n FROM ${name}`)).rows[0].n);
      if (count) throw new Error(`Restore requires an empty database: ${name} already holds ${count} row(s). Restoring over live state resurrects expired ownership and discards later evidence`);
    }
    for (const key of Object.keys(restored)) delete restored[key];
    // Chunked so a large ledger does not become one enormous parameter.
    for await (const { name, rows } of backup.chunks()) {
      if (name === 'graphyard_schema' || retiredTables.some(retired => retired === name)) continue;
      if (!(name in restored)) { restored[name] = 0; if (ledgerSeeded.includes(name)) await db.query(`DELETE FROM ${name}`); }
      if (rows.length) await db.query(`INSERT INTO ${name} SELECT * FROM json_populate_recordset(NULL::${name}, $1::json)`, [JSON.stringify(rows)]);
      restored[name] += rows.length;
    }
    for (const sequence of backup.sequences) {
      if (!/^(?:public\.)?[a-z_]+_seq$/.test(sequence.name)) throw new Error(`Backup names an unexpected sequence ${sequence.name}`);
      await db.query(`SELECT setval($1, $2, $3)`, [sequence.name, Math.max(sequence.value, 1), sequence.called]);
    }
    await db.query('COMMIT');
  };
  try {
    // Count the runs, not the predicate's calls: retryDeadlocks asks it both before and after each
    // rollback, so counting calls would stop at the third run, not the fifth the guide promises (GY-794).
    let attempts = 0;
    await retryDeadlocks(() => { attempts++; return restore(); }, () => attempts < restoreDeadlockAttempts, () => db.query('ROLLBACK'));
    const missing = ledgerTables.filter(name => name !== 'graphyard_schema' && !backup.tableNames.includes(name));
    return { restored, takenAt: backup.takenAt, fromVersion: backup.graphyardVersion, fromSchema: backup.schemaVersion, toSchema: schemaVersion, tablesLeftEmpty: missing, tablesRetired: backup.tableNames.filter(table => retiredTables.some(name => name === table)) };
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}

/** Row counts per ledger table, for comparing a restored database with the backup it came from. */
export async function ledgerCounts(pool: pg.Pool) {
  const counts: Record<string, number> = {};
  for (const name of ledgerTables) counts[name] = Number((await pool.query(`SELECT count(*) AS n FROM ${name}`)).rows[0].n);
  return counts;
}

/**
 * Fence the database against every writer before a migration's backup (GY-717): new sessions
 * default to read-only, and every other open session is ended, so the old server, a webhook it is
 * handling and any agent session still calling it can no longer write — wherever they run — while
 * reads (and `db backup`, a read-only snapshot) keep working. A write the old server attempts
 * afterwards fails instead of landing in a ledger the new host never sees. `release` lifts it, for
 * a migration that is abandoned. Requires the database owner (the role Graphyard's server uses).
 */
export async function fenceDatabase(pool: pg.Pool, options: { release?: boolean } = {}) {
  const db = await pool.connect();
  try {
    // This session writes the setting, so it must not be read-only itself (a second fence runs in an
    // already fenced database).
    await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
    const database = String((await db.query('SELECT current_database() AS name')).rows[0].name);
    const identifier = `"${database.replaceAll('"', '""')}"`;
    await db.query(options.release ? `ALTER DATABASE ${identifier} RESET default_transaction_read_only` : `ALTER DATABASE ${identifier} SET default_transaction_read_only = on`);
    if (options.release) return { database, fenced: false, ended: 0 };
    const ended = (await db.query('SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')).rows[0].n;
    return { database, fenced: true, ended: Number(ended) };
  } finally { db.release(); }
}

/** Whether a new session on the database starts read-only: the fence holds. */
export async function databaseFenced(pool: pg.Pool) {
  const db = await pool.connect();
  try { return (await db.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only === 'on'; }
  finally { db.release(); }
}
