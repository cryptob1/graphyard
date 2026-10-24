import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import { deployOnce, deployRecordPath, readDeployRecord, type DeployWatchPorts } from '../src/deploy-watch.js';
import type { MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2957: the watch's first pass names the repository in a deploy record an older watcher left
// without one, so master status reads the serving commit on every existing install straight after
// the GY-2955 upgrade, not only from the next merge on.

const served = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', owner = 'cryptob1/graphyard-openworld';

/** Ports whose checkout is at the served tip; every deploy step is recorded, none may run. */
const ports = (calls: string[]): DeployWatchPorts => ({
  fetch: async () => served, head: async () => served,
  checkout: async () => { calls.push('checkout'); }, build: async () => { calls.push('build'); },
  restart: async () => { calls.push('restart'); }, health: async () => { calls.push('health'); },
  pin: async () => { calls.push('pin'); }, prune: async () => { calls.push('prune'); },
  schema: async () => 7, database: async () => 7,
});

test('unit:deploy-record-gains-repository-on-first-pass — a watch pass over an unnamed record at the served tip names the repository and runs no deploy step, and master status over that record then reports the commit at main', async () => {
  const root = await temporaryDirectory('deploy-record-repository');
  // What a watcher running pre-GY-2955 code persisted: the tip, no repository named.
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(deployRecordPath(root), JSON.stringify({ tip: served, failed: null, reason: null, at: new Date().toISOString() }));
  const calls: string[] = [];
  assert.equal(await deployOnce(deployRecordPath(root), ports(calls), () => {}, owner), 'unchanged', 'the served tip is no new deploy');
  assert.deepEqual(calls, [], 'no deploy step runs for the served tip');
  const record = readDeployRecord(deployRecordPath(root));
  assert.equal(record?.tip, served, 'the served tip stands');
  assert.equal(record?.repository, owner, 'the first pass named the repository the watch serves');
  const config = { url: 'http://127.0.0.1:5', repository: owner, credentialFile: join(root, 'credential.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const report = await masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), async () => `${served}\n`);
  assert.deepEqual({ unconfigured: report.serving.unconfigured, commit: report.serving.commit, main: report.serving.main, atMain: report.serving.atMain },
    { unconfigured: false, commit: served.slice(0, 12), main: served.slice(0, 12), atMain: true });
});
