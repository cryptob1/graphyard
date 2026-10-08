// The local provider's supervised process (GY-1500): the control plane on this machine against an
// embedded Postgres cluster, with no Docker. One process owns both: it starts the cluster under the
// install directory, migrates through the same Store `graphyard db migrate` uses, then serves. On
// SIGTERM or SIGINT it awaits store.close() before it stops the cluster, so no pooled connection is
// cut by the database going away under it.
//
//   node --import tsx src/install/local-runtime.ts INSTALL_DIRECTORY
//
// The cluster is run from the @embedded-postgres/<platform> binaries directly rather than through
// the embedded-postgres class: importing that class registers an exit hook that stops every cluster
// and exits the process on SIGTERM, which would stop Postgres before the store has closed.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { Store } from '../store.js';

export const LOCAL_DATABASE = 'graphyard';
export const LOCAL_USER = 'graphyard';

/** Everything the local provider keeps under the install directory (~/.config/graphyard/INSTALL). */
export interface LocalPaths {
  directory: string;
  /** 0700: the cluster's data directory, its password file and its port. */
  postgres: string;
  data: string;
  /** 0600: the cluster superuser's password, which initdb reads and DATABASE_URL carries. */
  passwordFile: string;
  portFile: string;
  /** 0600: the server's variables, as `NAME: value` JSON (a private key spans lines, so not an env file). */
  environment: string;
  /** What the runtime last started from (a hash of its unit and variables), so a rerun restarts nothing. */
  deployed: string;
  /** Where a runtime started without systemd writes its output. */
  log: string;
  pid: string;
}

export const localPaths = (directory: string): LocalPaths => {
  const root = resolve(directory), postgres = join(root, 'postgres');
  return { directory: root, postgres, data: join(postgres, 'data'), passwordFile: join(postgres, 'password'), portFile: join(postgres, 'port'),
    environment: join(root, 'local-server.json'), deployed: join(root, 'local-deployed'), log: join(root, 'local-server.log'), pid: join(root, 'local-server.pid') };
};

export const localDatabaseUrl = (password: string, port: number) => `postgres://${LOCAL_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${LOCAL_DATABASE}`;

/** The npm package that carries this platform's Postgres binaries, as embedded-postgres names it. */
export const postgresPackage = (platform: NodeJS.Platform = process.platform, arch: string = process.arch) => `@embedded-postgres/${platform === 'win32' ? 'windows' : platform}-${arch}`;

export interface PostgresBinaries { package: string; initdb: string; postgres: string }

/**
 * The initdb and postgres binaries, resolved the way embedded-postgres resolves them: its platform
 * package, looked up from embedded-postgres itself so a nested install resolves as a hoisted one.
 * Throws, naming the package, when either is missing.
 */
export async function postgresBinaries(): Promise<PostgresBinaries> {
  const name = postgresPackage();
  const file = createRequire(import.meta.resolve('embedded-postgres')).resolve(name);
  const located = await import(pathToFileURL(file).href) as { initdb?: string; postgres?: string };
  if (!located.initdb || !located.postgres || !existsSync(located.initdb) || !existsSync(located.postgres)) throw new Error(`${name} does not ship initdb and postgres for this platform`);
  return { package: name, initdb: located.initdb, postgres: located.postgres };
}

export const clusterExists = (paths: LocalPaths) => existsSync(join(paths.data, 'PG_VERSION'));

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
 * Creates the cluster once: the postgres directory 0700, then initdb with scram-sha-256 against the
 * 0600 password file already there. An existing cluster is left as it is; returns whether it created one.
 */
export async function initialiseCluster(paths: LocalPaths, binaries?: PostgresBinaries) {
  await mkdir(paths.postgres, { recursive: true, mode: 0o700 });
  await chmod(paths.postgres, 0o700);
  if (clusterExists(paths)) return false;
  if (!existsSync(paths.passwordFile)) throw new Error(`The cluster password file ${paths.passwordFile} is missing; rerun graphyard install --provider local --apply`);
  const bin = binaries ?? await postgresBinaries();
  await run(bin.initdb, [`--pgdata=${paths.data}`, '--auth=scram-sha-256', `--username=${LOCAL_USER}`, `--pwfile=${paths.passwordFile}`, '--encoding=UTF8', '--locale=C']);
  return true;
}

export interface RunningCluster { port: number; process: ChildProcess; stop(): Promise<void> }

/** Starts the cluster on 127.0.0.1:PORT only, with no Unix socket, and resolves once it accepts connections. */
export async function startCluster(paths: LocalPaths, port: number, binaries?: PostgresBinaries, log: (line: string) => void = () => {}): Promise<RunningCluster> {
  const bin = binaries ?? await postgresBinaries();
  const child = spawn(bin.postgres, ['-D', paths.data, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories='], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  await new Promise<void>((accept, reject) => {
    let output = '';
    const listen = (chunk: Buffer) => {
      const text = chunk.toString('utf8'); output += text; log(text);
      if (text.includes('database system is ready to accept connections')) accept();
    };
    child.stdout!.on('data', listen); child.stderr!.on('data', listen);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Postgres exited with ${code} before accepting connections: ${output.trim().split('\n').slice(-5).join(' ')}`)));
  });
  let stopping: Promise<void> | null = null;
  return {
    port, process: child,
    // SIGINT is Postgres's fast shutdown: open transactions roll back and the cluster checkpoints.
    stop: () => stopping ??= (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : (child.kill('SIGINT'), exited)),
  };
}

/** Creates the graphyard database on a fresh cluster; an existing one is kept. */
export async function ensureDatabase(password: string, port: number) {
  const client = new pg.Client({ host: '127.0.0.1', port, user: LOCAL_USER, password, database: 'postgres' });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [LOCAL_DATABASE]);
    if (!found.rowCount) await client.query(`CREATE DATABASE ${LOCAL_DATABASE}`);
  } finally { await client.end(); }
}

/** Migrates through the same Store `graphyard db migrate` runs, then closes it. */
export async function migrate(url: string) {
  const store = new Store(url, { max: 2 });
  try { return await store.init(); } finally { await store.close(); }
}

export interface Served { close(): Promise<void> }
export type Serve = (environment: Record<string, string>) => Promise<Served>;

/**
 * The control plane's own process entry (src/server/main.ts) with the install's variables. main()
 * installs SIGTERM/SIGINT handlers that exit as soon as its store has closed; the runtime removes
 * them and owns the signals itself, so the cluster stops after the store and before the exit.
 */
export const serveControlPlane: Serve = async environment => {
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
  const before = { SIGTERM: new Set(process.listeners('SIGTERM')), SIGINT: new Set(process.listeners('SIGINT')) };
  const { main } = await import('../server/main.js');
  const running = await main({ port: Number(environment.PORT), host: environment.HOST ?? '127.0.0.1' });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) for (const listener of process.listeners(signal)) if (!before[signal].has(listener)) process.off(signal, listener as () => void);
  return { close: running.close };
};

export async function readLocalEnvironment(paths: LocalPaths): Promise<Record<string, string> | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.environment, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${paths.environment} is not a variable map`);
    return Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, String(value)]));
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

export interface LocalRuntime { url: string; databaseUrl: string; cluster: RunningCluster; stop(): Promise<void> }

/**
 * Starts the cluster, migrates, then serves. `stop` awaits the server's close (which awaits
 * store.close()) before it stops the cluster; a failure before serving stops the cluster it started.
 */
export async function startLocalRuntime(directory: string, options: { serve?: Serve; log?: (line: string) => void } = {}): Promise<LocalRuntime> {
  const paths = localPaths(directory);
  const environment = await readLocalEnvironment(paths);
  if (!environment) throw new Error(`${paths.environment} is missing; run graphyard install --provider local --apply first`);
  const password = (await readFile(paths.passwordFile, 'utf8')).trim();
  const port = Number((await readFile(paths.portFile, 'utf8')).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${paths.portFile} does not hold a port`);
  const binaries = await postgresBinaries();
  await initialiseCluster(paths, binaries);
  const cluster = await startCluster(paths, port, binaries, options.log);
  try {
    await ensureDatabase(password, port);
    const databaseUrl = environment.DATABASE_URL ?? localDatabaseUrl(password, port);
    await migrate(databaseUrl);
    const served = await (options.serve ?? serveControlPlane)({ ...environment, DATABASE_URL: databaseUrl });
    let stopping: Promise<void> | null = null;
    return {
      url: `http://${environment.HOST ?? '127.0.0.1'}:${environment.PORT}`, databaseUrl, cluster,
      stop: () => stopping ??= (async () => { try { await served.close(); } finally { await cluster.stop(); } })(),
    };
  } catch (error) { await cluster.stop(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory) { console.error('Usage: local-runtime INSTALL_DIRECTORY'); process.exit(2); }
  startLocalRuntime(directory, { log: line => process.stderr.write(line) }).then(runtime => {
    console.log(`Graphyard serving at ${runtime.url} on embedded Postgres 127.0.0.1:${runtime.cluster.port}`);
    let stopping = false;
    const shutdown = () => {
      stopping = true;
      setTimeout(() => process.exit(1), 60_000).unref();
      runtime.stop().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
    };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    // A cluster that dies under the server leaves nothing to serve: exit, and the supervisor restarts both.
    runtime.cluster.process.once('exit', code => { if (stopping) return; console.error(`Postgres exited (${code}); stopping so the supervisor restarts the control plane`); runtime.stop().finally(() => process.exit(1)); });
  }, error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
