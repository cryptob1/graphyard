import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3204: Railway deploys each application from git on its own; Graphyard only reads each app's
// versionUrl and, against main in the managed checkout, reports it current, lagging or failed in
// master status, with an attention line for each lagging or failed app.

const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString(), twoHoursAgo = new Date(Date.now() - 120 * 60_000).toISOString();
const git = (cwd: string, date: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();
const commit = async (root: string, date: string, file: string, text: string) => {
  await mkdir(join(root, file, '..'), { recursive: true });
  await writeFile(join(root, file), text);
  git(root, date, 'add', '.');
  git(root, date, 'commit', '-q', '-m', file);
  return git(root, date, 'rev-parse', 'HEAD');
};

/** A stub version endpoint answering `body`; resolves to its URL. */
const endpoint = (body: string, type: string) => new Promise<{ url: string; close(): void }>(resolve => {
  const server = createServer((_, res) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); }).listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${port}/version`, close: () => server.close() });
  });
});
const closedPort = () => new Promise<string>(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(`http://127.0.0.1:${port}/version`)); }); });

test('e2e:railway-observed-deploys — master status lists each app\'s versionUrl release against main: current, lagging, failed', async () => {
  const root = await temporaryDirectory('railway-observed-deploys');
  git(root, twoHoursAgo, 'init', '-q', '-b', 'main');
  const first = await commit(root, twoHoursAgo, 'api/compose.yml', 'services:\n  api:\n    ports:\n      - "8080"\n');
  await commit(root, twoHoursAgo, 'web/index.html', '<h1>v1</h1>\n');
  const deployed = await commit(root, twoHoursAgo, 'README.md', 'v1\n');
  // On main for an hour, past the watch's 15 minutes: web must serve it by now; api's directory is untouched.
  const webChange = await commit(root, hourAgo, 'web/index.html', '<h1>v2</h1>\n');
  const main = await commit(root, hourAgo, 'README.md', 'v2\n');
  assert.ok(first);

  const api = await endpoint(JSON.stringify({ commit: deployed }), 'application/json'), web = await endpoint(`${deployed}\n`, 'text/plain'), gone = await closedPort();
  try {
    await writeFile(join(root, 'graphyard.json'), JSON.stringify({ delivery: { mode: 'local', applications: [
      { id: 'api', kind: 'compose', file: 'api/compose.yml', service: 'api', port: 8080, versionUrl: api.url },
      { id: 'web', kind: 'static', directory: 'web', versionUrl: web.url },
      { id: 'worker', kind: 'static', directory: 'worker', versionUrl: gone },
      { id: 'docs', kind: 'static', directory: 'docs' },
    ] } }));
    const credentials = await temporaryDirectory('railway-observed-credentials');
    const config = { url: 'http://127.0.0.1:5', repository: 'acme/huck', credentialFile: join(credentials, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
    const run = (command: string, args: string[]) => command === 'git' ? execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) : '';
    const report = await masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), run);

    const short = (sha: string) => sha.slice(0, 12);
    assert.deepEqual(report.applications.map(({ id, serving, main, state }) => ({ id, serving, main, state })), [
      { id: 'api', serving: short(deployed), main: short(main), state: 'current' },
      { id: 'web', serving: short(deployed), main: short(main), state: 'lagging' },
      { id: 'worker', serving: null, main: short(main), state: 'failed' },
    ], 'an app without a versionUrl is not observed; api is current, web lags, worker\'s endpoint is unreachable');
    const lines = report.attention.map(item => item.text);
    assert.equal(lines.length, 2, 'one attention line per lagging or failed app');
    assert.match(lines[0], new RegExp(`^Application web lags main: serves ${short(deployed)}; ${short(webChange)} changed it on main 60 minutes ago`));
    assert.match(lines[1], /^Application worker's versionUrl failed: /);
  } finally { api.close(); web.close(); }
});
