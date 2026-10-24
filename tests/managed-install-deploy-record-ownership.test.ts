import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import { gitWatchPorts } from '../src/cli/upgrade.js';
import { defaultChildRun } from '../src/child-runner.js';
import { restartCause } from '../src/daemon/run.js';
import { daemonStatePath } from '../src/daemon/state.js';
import { deployRecordPath, readDeployRecord, watchMain, type DeployWatchPorts } from '../src/deploy-watch.js';
import type { MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2955: the control plane's deploy unit persists its own deploy record in the managed checkout
// it upgrades. A record counts as a repository's release health only when it names that repository
// as the one it serves, so an upgrade of a control plane installed for a different managed
// repository cannot impersonate a game deployment; the loop still restarts onto the revision the
// upgrade serves, and a record naming the managed repository is still its release health.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const plane = 'cryptob1/graphyard', game = 'cryptob1/graphyard-openworld';

/** An origin, a pusher that commits to it, and a checkout of it at the first commit. */
async function repository(label: string, name = 'release.txt') {
  const base = await temporaryDirectory(label);
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), checkout = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  const commit = async (what: string) => { await writeFile(join(pusher, name), what); git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', what); git(pusher, 'push', '-q', 'origin', 'HEAD:main'); return git(pusher, 'rev-parse', 'HEAD'); };
  const a = await commit('A');
  git(base, 'clone', '-q', origin, checkout);
  return { commit, a, checkout };
}

/** A managed game checkout (a clone with its own origin/main) whose master.json names the game repository, cursor carrying the loop's loaded build. */
async function managedGame(label: string) {
  const source = await repository(`${label}-origin`, 'game.txt');
  const root = source.checkout, a = source.a;
  const credentialDirectory = await temporaryDirectory(`${label}-credentials`);
  const config = {
    url: 'http://127.0.0.1:5', repository: game, credentialFile: join(credentialDirectory, 'coordinator.token'),
    hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 },
  } as unknown as MasterConfig;
  await writeFile(daemonStatePath(config), JSON.stringify({ version: 1, url: config.url, repository: game, release: { commit: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f', dirty: false } }));
  return {
    root, config, commit: source.commit, a,
    /** The game's base tip as master status reads it: its origin's main. */
    main: () => git(root, 'rev-parse', 'refs/remotes/origin/main'),
    status: (run = async () => `${a}\n`) => masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), run),
  };
}

/** The ports of one watch pass against `checkout`, scripted past the git half, health always passing. */
const ports = (checkout: string): DeployWatchPorts => ({
  ...gitWatchPorts(checkout, 'main', defaultChildRun),
  build: async () => {}, restart: async () => {}, health: async () => {}, pin: async () => {}, prune: async () => {},
  schema: async () => null, database: async () => null,
});

test('integration:managed-install-deploy-record-ownership — an upgrade of the control plane installed for a managed game persists its record there, master status reports no game release health from it, and the loop still restarts onto it', async () => {
  const source = await repository('managed-deploy-plane');
  const gameRepository = await managedGame('managed-deploy-game');
  const { root, config } = gameRepository;
  const b = await source.commit('B');

  // The deploy unit upgrades the control plane from its own checkout and records its revision in the game's checkout, naming the repository it serves.
  await watchMain(deployRecordPath(root), ports(source.checkout), { intervalMs: 1000, once: true, log: () => {}, repository: plane });
  const record = readDeployRecord(deployRecordPath(root));
  assert.equal(record?.tip, b, 'the control-plane revision the upgrade serves is recorded');
  assert.equal(record?.repository, plane, 'the record names the control plane\'s repository, not the game\'s');

  // Master status does not compare the control-plane tip to the game's base as game release health.
  const gameMain = gameRepository.main();
  const report = await gameRepository.status();
  assert.deepEqual(
    { unconfigured: report.serving.unconfigured, commit: report.serving.commit, atMain: report.serving.atMain, main: report.serving.main, failedDeploy: report.serving.failedDeploy },
    { unconfigured: true, commit: null, atMain: null, main: gameMain.slice(0, 12), failedDeploy: null },
    'no game provider records what the game serves, and the control-plane tip is never compared to the game\'s base');

  // The upgrade's restart role stands: the loop restarts onto the revision the upgrade serves.
  const head = () => git(source.checkout, 'rev-parse', 'HEAD');
  assert.match(restartCause(config, root, source.a, head) ?? '', new RegExp(`serves ${b.slice(0, 12)}, not ${source.a.slice(0, 12)}`));
  assert.equal(restartCause(config, root, b, head), null);
});

test('integration:managed-install-deploy-record-ownership — the record an older control plane left without a name keeps its restart role and stays out of the game\'s release health', async () => {
  const gameRepository = await managedGame('managed-deploy-legacy');
  const { root, config } = gameRepository;
  const served = '6114a3b2d546dfed596932a3d0cd58f859382bd5', loaded = '103e88bef44b0000000000000000000000000000';
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(deployRecordPath(root), `${JSON.stringify({ tip: served, failed: null, reason: null, at: '2026-10-24T10:42:26.726Z' }, null, 2)}\n`);

  const report = await gameRepository.status();
  assert.equal(report.serving.unconfigured, true, 'an unattributed control-plane record is no game deployment');
  assert.equal(report.serving.commit, null);
  assert.equal(report.serving.atMain, null, 'the persisted control-plane tip is never compared to the game\'s base');
  assert.equal(report.serving.main, gameRepository.main().slice(0, 12));

  assert.match(restartCause(config, root, loaded, () => served) ?? '', new RegExp(`serves ${served.slice(0, 12)}, not ${loaded.slice(0, 12)}`), 'the upgrade/restart role of the persisted record stands');
  assert.equal(restartCause(config, root, served, () => served), null);
});

test('integration:managed-install-deploy-record-ownership — a control plane managing its own repository still reads its deploy record as that repository\'s release health', async () => {
  const gameRepository = await managedGame('managed-deploy-self');
  const root = gameRepository.root;
  const b = await gameRepository.commit('B');

  // The control plane manages this repository itself: its watch pass records the repository it serves.
  await watchMain(deployRecordPath(root), ports(root), { intervalMs: 1000, once: true, log: () => {}, repository: game });

  // Master status reads the record as this repository's release health against its own real origin/main.
  const report = await masterStatusReport(root, gameRepository.config, async () => ({ work: [], now: new Date().toISOString() }));
  assert.equal(report.serving.unconfigured, false, 'a record naming the managed repository reports its release health');
  assert.equal(report.serving.commit, b.slice(0, 12));
  assert.equal(report.serving.main, b.slice(0, 12));
  assert.equal(report.serving.atMain, true);
});
