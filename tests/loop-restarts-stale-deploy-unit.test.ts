import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { readDeployUnitProcess, runDaemon, type DeployUnitProcess } from '../src/daemon/run.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3136: a deploy watch running code older than the commit it serves never runs the newer watch's
// rules (GY-3123's handover is itself new code), so the loop restarts its unit through systemd.

const old = 'a'.repeat(40), served = 'b'.repeat(40);

test('unit:loop-restarts-stale-deploy-unit — the loop restarts the deploy unit once when its watch runs older code than the served commit and no pass is in progress, records why, and leaves a unit running the served commit alone', async () => {
  // The deploy unit is read from the loop's cgroup sibling: the watch's cli.ts names the code it loaded; any other process is a pass.
  const files: Record<string, string> = {
    '/proc/self/cgroup': '0::/user.slice/user-1000.slice/user@1000.service/app.slice/graphyard-master.service\n',
    '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/graphyard-deploy.service/cgroup.procs': '10\n11\n',
    '/proc/10/cmdline': ['/usr/bin/node', '/install/bin/graphyard.mjs', 'upgrade', '--watch', '--checkout', '/install/deploy/src'].join('\0'),
    '/proc/11/cmdline': ['/usr/bin/node', '--import', 'tsx', `/install/cli-releases/${old}/src/cli.ts`, 'upgrade', '--watch', '--checkout', '/install/deploy/src'].join('\0'),
  };
  const read = (file: string) => { if (!(file in files)) throw new Error(`ENOENT ${file}`); return files[file]!; };
  const commitOf = (root: string) => root.split('/').at(-1)!;
  assert.deepEqual(readDeployUnitProcess(read, commitOf), { unit: 'graphyard-deploy.service', commit: old, busy: false });
  files['/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/graphyard-deploy.service/cgroup.procs'] = '10\n11\n12\n';
  files['/proc/12/cmdline'] = ['npm', 'ci'].join('\0');
  assert.equal(readDeployUnitProcess(read, commitOf)?.busy, true, 'a pass child (npm ci) means a deploy pass is in progress');
  assert.equal(readDeployUnitProcess(() => { throw new Error('no cgroup'); }), null);

  const root = await temporaryDirectory('stale-deploy-unit');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'deploy.json'), JSON.stringify({ tip: served, failed: null, reason: null, at: new Date().toISOString() }));
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:5', credentialFile, cliPath: '/bin/true',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {},
    snapshot: async () => ({ work: [], now: new Date().toISOString() }),
    persist: current => writeDaemonState(config, current),
  };
  const state = emptyDaemonState(config), restarts: string[] = [], logs: string[] = [];
  const cycle = (unit: DeployUnitProcess) => runDaemon(config, state, effects, { once: true, intervalMs: 60_000, identity: { pid: process.pid, host: 'machine-a' },
    process: new EventEmitter() as unknown as NodeJS.Process, log: line => logs.push(line), root,
    restartLoop: async () => {}, deployUnit: () => unit, restartDeploy: async name => { restarts.push(name); } });

  await cycle({ unit: 'graphyard-deploy.service', commit: old, busy: true });
  assert.deepEqual(restarts, [], 'no restart while a deploy pass is in progress');

  await cycle({ unit: 'graphyard-deploy.service', commit: old, busy: false });
  assert.deepEqual(restarts, ['graphyard-deploy.service'], 'a stale idle deploy unit is restarted through systemd');
  const recorded = state.actions[`deploy-unit-restart:${served}`];
  assert.equal(recorded?.kind, 'deployment');
  assert.equal(recorded?.state, 'done');
  assert.match(recorded?.detail ?? '', new RegExp(`graphyard-deploy.service runs ${old.slice(0, 12)}, older code than ${served.slice(0, 12)} it serves`));
  assert.ok(logs.some(line => line.includes('restarting graphyard-deploy.service')));

  await cycle({ unit: 'graphyard-deploy.service', commit: old, busy: false });
  assert.equal(restarts.length, 1, 'restarted once per served commit');
  await cycle({ unit: 'graphyard-deploy.service', commit: served, busy: false });
  assert.equal(restarts.length, 1, 'a unit running the served commit is not restarted');
});
