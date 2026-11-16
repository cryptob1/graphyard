import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyDelivery, onboardingServe } from '../src/repository-setup.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { daemonStatePath } from '../src/daemon/state.js';
import type { MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3387: master status judges the placeholder serve from graphyard.json at main's tip, not the
// coordinator checkout's working tree, which can still sit at the onboarding commit.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('e2e:status-placeholder-serve-from-main — the Placeholder serve line follows main, not the working tree', async () => {
  const root = await temporaryDirectory('status-placeholder-main');
  git(root, 'init', '-q', '-b', 'main');
  const policy = { mode: 'local' as const, mergeGate: { preMerge: [], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command' as const, project: null, uat: null, production: null } };
  assert.equal((await applyDelivery(root, policy, 'node')).wroteServe, true);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'onboarded');
  const onboarded = git(root, 'rev-parse', 'HEAD');
  const credentials = await temporaryDirectory('status-placeholder-main-credentials');
  const master = { url: 'http://127.0.0.1:5', repository: 'owner/fixture', credentialFile: join(credentials, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  await writeFile(daemonStatePath(master), JSON.stringify({ version: 1, url: master.url, repository: master.repository }));
  const line = async () => (await masterStatusReport(root, master, async () => ({ work: [], now: new Date().toISOString() }),
    async (command, args) => command === 'git' ? git(root, ...args.slice(2)) : '')).attention.find(entry => entry.subject === 'e2e.serve');

  assert.match((await line())?.text ?? '', /^Placeholder serve: /, 'main still declares the placeholder: the line shows');

  // Main declares the application's serve; the checkout's working tree stays at the onboarding commit.
  const config = JSON.parse(await readFile(join(root, 'graphyard.json'), 'utf8'));
  config.featureMap = [{ name: 'Home', url: '/', traps: [] }];
  config.e2e.serve = { command: 'sh scripts/serve.sh 127.0.0.1:43911', url: 'http://127.0.0.1:43911/', readySeconds: 30 };
  await writeFile(join(root, 'graphyard.json'), JSON.stringify(config));
  git(root, 'commit', '-q', '-am', 'declare the serve');
  git(root, 'checkout', '-q', '--detach', onboarded);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'graphyard.json'), 'utf8')).e2e.serve, onboardingServe, 'the working tree holds the placeholder');
  assert.equal(await line(), undefined, 'main declares a real serve: no Placeholder serve line');
});
