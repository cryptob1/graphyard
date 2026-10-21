import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { commands, renderHelp } from '../src/cli/index.js';
import { heldVariable } from '../src/master/verification-slots.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1992 AC-1: the scope-request machinery is deleted, not disabled. Its modules are gone, no
// command answers to `scope-request` or `master scope`, the work scope route is unknown, and the
// tree still builds.

const root = fileURLToPath(new URL('..', import.meta.url));
const removed = ['src/model/scope.ts', 'src/model/scope-collapse.ts', 'src/daemon/cycle-scope.ts', 'src/review-scope.ts', 'src/scope-guard.ts',
  'src/cli/scope-guard.ts', 'src/cli/sync-restore.ts', 'src/cli/master-scope.ts'];
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const principals = [operator, worker, coordinator];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, scratch: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1994;
  scratch = await temporaryDirectory('scope-removed');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('scope_removed_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scope_removed_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

const post = async (path: string, actor: Principal, data: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(data) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};

test('unit:scope-machinery-removed — the scope modules are gone, scope-request and master scope are not registered, the work scope route answers 404, and npm run build passes', { timeout: 600_000 }, async () => {
  for (const file of removed) await assert.rejects(access(join(root, file)), `${file} is deleted`);
  assert.ok(!commands.some(entry => entry.name === 'scope-request' || entry.name === 'scope-guard'), 'no scope-request or scope-guard command is registered');
  const help = renderHelp();
  assert.doesNotMatch(help, /scope-request|master scope\b|--restore|allow-broad-scope/);

  const created = await post('work', operator, { title: 'Scope route', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  await post(`work/${created.body.id}/ready`, operator, {});
  const claimed = await post(`work/${created.body.id}/claim`, worker, {});
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const scope = await post(`work/${created.body.id}/scope`, worker, { epoch: claimed.body.epoch, paths: ['src/a.ts'], reason: 'needs it' });
  assert.equal(scope.status, 404, JSON.stringify(scope.body));
  const autoscope = await post(`work/${created.body.id}/autoscope`, coordinator, { epoch: claimed.body.epoch });
  assert.equal(autoscope.status, 404, JSON.stringify(autoscope.body));

  const build = await promisify(execFile)('npm', ['run', 'build'], { cwd: root, env: { ...process.env, [heldVariable]: '1' }, maxBuffer: 64 * 1024 * 1024 })
    .then(() => null, (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}`);
  assert.equal(build, null, `npm run build passes: ${build?.slice(-4000)}`);
});
