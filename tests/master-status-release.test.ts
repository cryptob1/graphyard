import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import { daemonStatePath } from '../src/daemon/state.js';
import { deployRecordPath } from '../src/deploy-watch.js';
import type { MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2951: master status compares the managed repository's served revision to its base tip — only
// what a deployment provider records. The control plane's own build revision (the loop's loaded
// release in the cursor) is not the game's code and never stands in as a game deployment.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const build = '1ea42dc24a1a4f4b6e2d8d2f1e0c9b8a7d6c5b4a', gameMain = 'ec5a2827eb41c3d2a1f0e9d8c7b6a5f4e3d2c1b0', served = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** A managed checkout (a git repository, so its cursor is readable) whose cursor records the control plane's own build. */
async function managed() {
  const root = await temporaryDirectory('master-status-root');
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'README.md'), 'the game\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'the game');
  const credentialDirectory = await temporaryDirectory('master-status-credentials');
  const config = {
    url: 'http://127.0.0.1:5', repository: 'cryptob1/graphyard-openworld', credentialFile: join(credentialDirectory, 'coordinator.token'),
    hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 },
  } as unknown as MasterConfig;
  // The control plane's own build this loop loaded — present in the cursor, and different from the game's base tip.
  await writeFile(daemonStatePath(config), JSON.stringify({ version: 1, url: config.url, repository: config.repository, release: { commit: build, dirty: false } }));
  return { root, config };
}

const status = (root: string, config: MasterConfig) => masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), async () => `${gameMain}\n`);

const deployRecord = (root: string, tip: string | null, failed: string | null = null) => mkdir(join(root, '.graphyard'), { recursive: true })
  .then(() => writeFile(deployRecordPath(root), JSON.stringify({ tip, failed, reason: failed ? 'health failed: /healthz answered 503' : null, at: new Date().toISOString() })));

test('unit:master-status-managed-release-revisions — with no deployment provider the control-plane build is not a lagging game deployment', async () => {
  const { root, config } = await managed();
  const report = await status(root, config);
  assert.equal(report.serving.unconfigured, true, 'no deployment provider records what the game serves');
  assert.equal(report.serving.commit, null, 'the control-plane build the loop loaded is not reported as the game\'s served commit');
  assert.equal(report.serving.atMain, null, 'no claim that the control-plane revision trails the game\'s base tip');
  assert.equal(report.serving.main, gameMain.slice(0, 12), 'the game\'s base tip is still named');
  assert.equal(report.serving.failedDeploy, null);
});

test('unit:master-status-managed-release-revisions — a configured game deployment at the base tip reads atMain true', async () => {
  const { root, config } = await managed();
  await deployRecord(root, gameMain);
  const report = await status(root, config);
  assert.deepEqual({ unconfigured: report.serving.unconfigured, commit: report.serving.commit, atMain: report.serving.atMain }, { unconfigured: false, commit: gameMain.slice(0, 12), atMain: true });
});

test('unit:master-status-managed-release-revisions — a configured game deployment trailing the base tip reads atMain false, with the failed deploy named', async () => {
  const { root, config } = await managed();
  await deployRecord(root, served);
  const trailing = await status(root, config);
  assert.deepEqual({ unconfigured: trailing.serving.unconfigured, commit: trailing.serving.commit, atMain: trailing.serving.atMain }, { unconfigured: false, commit: served.slice(0, 12), atMain: false });
  await deployRecord(root, served, gameMain);
  const failed = await status(root, config);
  assert.deepEqual(failed.serving.failedDeploy, { tip: gameMain.slice(0, 12), reason: 'health failed: /healthz answered 503', restoring: null });
});
