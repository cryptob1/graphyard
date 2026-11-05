import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { databaseUrl, databaseAvailable } from './helpers/postgres.js';
import pg from 'pg';

// GY-2966: on 2026-10-27 the disk filled, Postgres crash-looped, and both servers exited on an
// unhandled pool 'error' event and stayed down 32 hours. The server process now survives every
// dropped connection and waits for a database that is not yet accepting connections at start.

const repositoryRoot = new URL('..', import.meta.url).pathname;
const admin = { id: 'admin', role: 'admin', token: 'a'.repeat(32) };
const servers: ChildProcess[] = [];
after(async () => {
  for (const server of servers) if (server.exitCode === null) server.kill('SIGKILL');
});

/** The server as its container runs it: its own process, so an unhandled error ends it. */
function startServer(databaseUrl: string) {
  const env = { ...process.env, DATABASE_URL: databaseUrl, GRAPHYARD_PRINCIPALS: JSON.stringify([admin]), PORT: '0', HOST: '127.0.0.1', GITHUB_CI_APP_IDS: '15368' };
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: repositoryRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(server);
  let output = '';
  server.stdout!.on('data', chunk => { output += chunk; });
  server.stderr!.on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => server.once('exit', code => resolve(code)));
  const port = new Promise<number>((resolve, reject) => {
    server.stdout!.on('data', () => { const match = /listening on port (\d+)/.exec(output); if (match) resolve(Number(match[1])); });
    void exited.then(code => reject(new Error(`the server exited ${code} before listening:\n${output}`)));
  });
  port.catch(() => {}); // awaited by the test; an exit before it listens fails that await, never the process
  return { server, port, exited, output: () => output };
}

const get = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${admin.token}` }, signal: AbortSignal.timeout(15_000) });

async function ready(port: number) {
  for (const started = Date.now(); Date.now() - started < 60_000; await new Promise(resolve => setTimeout(resolve, 250))) {
    const health = await get(port, '/healthz').then(response => response.json(), () => null);
    if (health?.readiness) return;
  }
  throw new Error('the server never reported readiness');
}

test('unit:server-survives-dropped-database-connections — every backend terminated with pg_terminate_backend leaves the server process running and the next request succeeds', { timeout: 120_000 }, async () => {
  const url = await databaseUrl('crash-survival');
  const started = startServer(url);
  const port = await started.port;
  await ready(port);
  // Hold idle connections in the pool, then drop every one of them as a crashing database does.
  await Promise.all(Array.from({ length: 4 }, () => get(port, '/api/status')));
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname=current_database()');
  await admin.end();
  assert.ok((rowCount ?? 0) > 0, 'the server held connections to terminate');
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(started.server.exitCode, null, `the server process is still running:\n${started.output()}`);
  assert.match(started.output(), /database connection lost/, 'the dropped connection is logged, not thrown');
  const response = await get(port, '/api/status');
  assert.equal(response.status, 200, `the next request succeeds: ${await response.clone().text()}`);
  assert.equal(started.server.exitCode, null);
  started.server.kill();
  await started.exited;
});

test('unit:server-waits-for-database-at-start — a server started before its database accepts connections waits, and is healthy once the database accepts 10 seconds later', { timeout: 120_000 }, async () => {
  const url = await databaseUrl('wait-for-database');
  await databaseAvailable(url, false);
  const started = startServer(url);
  let exited = false;
  void started.exited.then(() => { exited = true; });
  await new Promise(resolve => setTimeout(resolve, 10_000));
  assert.equal(exited, false, `the server did not exit while the database was down:\n${started.output()}`);
  assert.match(started.output(), /the database is not accepting connections/, 'each wait is logged');
  await databaseAvailable(url, true);
  const port = await started.port;
  await ready(port);
  assert.equal(exited, false);
  assert.equal((await get(port, '/healthz')).status, 200);
  started.server.kill();
  await started.exited;
});
