// The warm start for a disposable Postgres cluster: the suite's test databases and the merge
// trial's E2E serve. Measured cold, a cluster on a disk-backed tmpdir spent 4–8 s in initdb and
// 3–7 s in its shutdown checkpoint, both fsync, beside about 0.1 s migrating the schema. So one
// template cluster is built per schema generation, digest and Postgres build under the tmpdir — fsync off, its
// `graphyard_template` database migrated — and each disposable cluster is a copy of that directory.
// A DDL change is a new digest, so the next copy builds its template afresh; a template another
// digest left is removed once it is an hour old. Only throwaway clusters use it: fsync off loses
// nothing a process crash can lose, only what an operating-system crash would.
//
// No embedded-postgres import: its exit hook stops every cluster on SIGTERM, before the E2E
// serve's store has closed (src/install/local-runtime.ts).
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, chmod, cp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { postgresBinaries, startCluster, type LocalPaths } from '../install/local-runtime.js';
import { currentSchemaCode, runStartupMigration, schemaGenerationDigest, type SchemaCode } from '../store/migration-locks.js';

/** The role and password every warm cluster carries, as the suite's clusters always have. */
export const warmUser = 'graphyard', warmPassword = 'testing-only';
/** The migrated database each warm cluster holds, for `CREATE DATABASE ... TEMPLATE`. */
export const templateDatabase = 'graphyard_template';
const prefix = 'graphyard-postgres-template-';
const staleMs = 3_600_000;

function run(program: string, args: string[]) {
  return new Promise<void>((accept, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? accept() : reject(new Error(`${program} exited with ${code}: ${output.trim().split('\n').slice(-5).join(' ')}`)));
  });
}

/**
 * The template cluster for `code` (this process's schema by default) under `root`, built on first
 * use with Postgres on `port`, which the caller holds. Concurrent builders each build their own and
 * the first rename wins.
 */
export async function templateCluster(port: number, options: { code?: SchemaCode; root?: string } = {}): Promise<string> {
  const code = options.code ?? currentSchemaCode(), root = options.root ?? tmpdir();
  const binaries = await postgresBinaries();
  const version = execFileSync(binaries.postgres, ['--version'], { encoding: 'utf8' }).trim();
  const directory = join(root, `${prefix}${createHash('sha256').update(`${version}\n${code.generation}\n${schemaGenerationDigest(code)}`).digest('hex').slice(0, 16)}`);
  if (existsSync(join(directory, 'PG_VERSION'))) return directory;
  const staging = `${directory}.${process.pid}-${randomBytes(4).toString('hex')}`, passwordFile = `${staging}.password`;
  try {
    await writeFile(passwordFile, `${warmPassword}\n`, { mode: 0o600 });
    await run(binaries.initdb, [`--pgdata=${staging}`, '--auth=password', `--username=${warmUser}`, `--pwfile=${passwordFile}`, '--lc-messages=C', '--no-sync']);
    await appendFile(join(staging, 'postgresql.auto.conf'), 'fsync = off\n');
    const cluster = await startCluster({ data: staging } as LocalPaths, port, binaries);
    try {
      const connection = { host: '127.0.0.1', port, user: warmUser, password: warmPassword };
      const admin = new pg.Client({ ...connection, database: 'postgres' });
      await admin.connect();
      try { await admin.query(`CREATE DATABASE ${templateDatabase}`); } finally { await admin.end(); }
      // The migration destroys its watchdog's connection; the shutdown may still reach it.
      const pool = new pg.Pool({ ...connection, database: templateDatabase, max: 2 }).on('error', () => {});
      try { await runStartupMigration(pool, { code }); } finally { await pool.end(); }
    } finally { await cluster.stop(); }
    await rename(staging, directory).catch(error => { if (!existsSync(join(directory, 'PG_VERSION'))) throw error; });
  } finally { await rm(staging, { recursive: true, force: true }); await rm(passwordFile, { force: true }); }
  for (const name of await readdir(root)) {
    const other = join(root, name);
    if (!name.startsWith(prefix) || name.includes('.') || other === directory) continue;
    if (Date.now() - (await stat(other).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > staleMs) await rm(other, { recursive: true, force: true });
  }
  return directory;
}

/** Fill the empty or missing `data` directory with a copy of the template cluster: initdb's place in a cold start. */
export async function copyTemplateCluster(data: string, port: number, options: { code?: SchemaCode; root?: string } = {}) {
  await cp(await templateCluster(port, options), data, { recursive: true });
  await chmod(data, 0o700);
}

/** Create `name` on a running warm cluster as a copy of its migrated template. */
export async function createMigratedDatabase(port: number, name: string) {
  const admin = new pg.Client({ host: '127.0.0.1', port, user: warmUser, password: warmPassword, database: 'postgres' });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE ${templateDatabase}`); } finally { await admin.end(); }
}
