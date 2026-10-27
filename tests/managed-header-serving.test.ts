import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { deployRecordPath } from '../src/deploy-watch.js';
import type { Principal } from '../src/model.js';
import { ReleaseLine } from '../web/components/top-bar.js';

// GY-2964: the dashboard header of a managed install names the managed repository's own serving —
// what a deploy record naming it serves, or "No deploy configured · main <tip>" — never the
// control plane's own commit, and "not carried yet" is counted only against a configured deploy.

const game = 'owner/openworld', plane = 'f'.repeat(40);
const operator: Principal = { id: 'operator', role: 'admin' };
const tokens = new Map([[operator.id, `operator-${'t'.repeat(32)}`]]);

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, root: string;
let tipB = '', main = '';

const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
/** One commit on main; returns its sha. */
const commit = async (what: string) => {
  await writeFile(join(root, 'game.txt'), `${what}\n`);
  git(['add', '.']); git(['commit', '-q', '-m', what]);
  return git(['rev-parse', 'HEAD']);
};
const writeDeploy = async (record: Record<string, unknown>) => {
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(deployRecordPath(root), JSON.stringify({ failed: null, reason: null, ...record }));
};

before(async () => {
  // The shared checkout the header reads main's tip and the deploy record from.
  root = await temporaryDirectory('managed-header-root');
  git(['init', '-q', '-b', 'main']);
  await writeFile(join(root, 'game.txt'), 'the game\n');
  git(['add', '.']); git(['commit', '-q', '-m', 'the game']);
  tipB = await commit('second');
  main = await commit('third');
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3012;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('managed-header-serving'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('managed_header_serving');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/managed_header_serving`); await store.init();
  engine = new Engine(store, 120, game);
  // The control plane's own build identity, which is never the managed repository's serving commit.
  http = server(engine, [{ ...operator, token: tokens.get(operator.id)! }], null, { env: { GRAPHYARD_BUILD_SHA: plane } });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (database) await database.stop();
  delete process.env.GRAPHYARD_REPOSITORY_ROOT;
});

const api = async (path: string) => {
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${tokens.get(operator.id)}` } });
  const body = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${response.status}`), { status: response.status });
  return body;
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const line = (status: any) => text(renderToStaticMarkup(createElement(ReleaseLine, { status }))!);

test('unit:managed-header-names-repository-serving — a managed install\'s header names its own deploy or "No deploy configured · main", never the control plane\'s commit', async () => {
  // Without a deploy record naming the repository: unconfigured, with main's tip named.
  const unconfigured = await api('status');
  assert.deepEqual({ ...unconfigured.deploy, repository: unconfigured.deploy.repository }, { repository: game, configured: false, tip: null, at: null, main, pending: null });
  const idle = line(unconfigured);
  assert.match(idle, /No deploy configured/);
  assert.match(idle, new RegExp(`main ${main.slice(0, 8)}`), 'the repository\'s main tip is named');
  assert.ok(!idle.includes('not carried yet'), 'no not-carried count without a configured deploy');
  assert.ok(!idle.includes(plane.slice(0, 8)), 'the control plane\'s own commit is never named');

  // With a configured deploy: its commit, and the merged changes main holds since it.
  await writeDeploy({ tip: tipB, at: new Date().toISOString(), repository: game });
  const configured = await api('status');
  assert.deepEqual({ configured: configured.deploy.configured, tip: configured.deploy.tip, main: configured.deploy.main, pending: configured.deploy.pending },
    { configured: true, tip: tipB, main, pending: 1 });
  const serving = line(configured);
  assert.match(serving, new RegExp(`Serving ${tipB.slice(0, 8)}`));
  assert.match(serving, /1 merged change not carried yet/);
  assert.ok(!serving.includes(plane.slice(0, 8)), 'the control plane\'s own commit is never named');

  // A record naming the control plane's own repository is not this repository's deploy (GY-2955).
  await writeDeploy({ tip: plane, at: new Date().toISOString(), repository: 'cryptob1/graphyard' });
  const foreign = await api('status');
  assert.equal(foreign.deploy.configured, false);
  assert.ok(!line(foreign).includes(plane.slice(0, 8)), 'the control plane\'s deploy record never serves the managed repository\'s header');
});
