import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import { daemonStatePath } from '../src/daemon/state.js';
import type { MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3434: master status lists where the app runs — graphyard.json's app.url as main holds it, with
// the machine, the serving commit and its deploy time — refuses a loopback address with a plain
// reason, and names the setting to add while none is declared.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('integration:app-url-declared — master status lists main\'s app.url with machine, serving commit and deploy time; loopback is refused; none names the setting', async () => {
  const root = await temporaryDirectory('app-url-declared');
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({}));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'onboarded');
  const served = git(root, 'rev-parse', 'HEAD');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'served.json'), JSON.stringify({ commit: served, url: 'http://127.0.0.1:8088/', failed: null, reason: null, started: '2026-11-16T09:00:00.000Z', at: '2026-11-16T09:05:00.000Z' }));
  const credentials = await temporaryDirectory('app-url-declared-credentials');
  const master = { url: 'http://127.0.0.1:5', repository: 'owner/fixture', credentialFile: join(credentials, 'coordinator.token'), hostId: 'yard-box', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  await writeFile(daemonStatePath(master), JSON.stringify({ version: 1, url: master.url, repository: master.repository }));
  const app = async () => (await masterStatusReport(root, master, async () => ({ work: [], now: new Date().toISOString() }),
    async (command, args) => command === 'git' ? git(root, ...args.slice(2)) : '')).applications.find(entry => entry.id === 'app') as Record<string, unknown> | undefined;
  const declare = async (url: string) => { await writeFile(join(root, 'graphyard.json'), JSON.stringify({ app: { url } })); git(root, 'commit', '-q', '-am', `app ${url}`); };

  const none = await app();
  assert.equal(none?.url, null);
  assert.match(String(none?.missing), /app\.url|"app": \{ "url"/, 'with none declared, master status names the setting to add');
  assert.match(String(none?.missing), /graphyard\.json/);

  for (const loopback of ['http://127.0.0.1:8088/', 'http://localhost:3000', 'http://[::1]:8080/']) {
    await declare(loopback);
    const refused = await app();
    assert.equal(refused?.url, null, `${loopback} is not listed as shareable`);
    assert.match(String(refused?.refused), /opens only on the machine it runs on; use its tailnet or public address/, `${loopback} is refused with a plain reason`);
  }

  await declare('https://yard-box.tail1234.ts.net:8088/');
  // The checkout's working tree lags main: the declaration is read from main's tip.
  git(root, 'checkout', '-q', '--detach', served);
  assert.deepEqual(await app(), { id: 'app', url: 'https://yard-box.tail1234.ts.net:8088/', machine: 'yard-box', serving: served.slice(0, 12), deployedAt: '2026-11-16T09:00:00.000Z' });
});
