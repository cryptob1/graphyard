import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateHerdr } from '../src/herdr-migration.js';
import { installRequestFromArgs, redeployArguments } from '../src/install/index.js';
import { applyHerdrConfig } from '../src/master/config.js';
import { herdrInvocation, herdrTarget } from '../src/master/herdr.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('private panes drain while new launches use the main workspace; cleanup runs once after the last pane ends', async () => {
  const root = await temporaryDirectory('shared-migration'), home = await temporaryDirectory('shared-home');
  const configHome = join(home, '.config/graphyard/acme-app/herdr');
  const unit = join(home, '.config/systemd/user/graphyard-herdr-acme-app.service');
  await mkdir(configHome, { recursive: true });
  await mkdir(join(home, '.config/systemd/user'), { recursive: true });
  await mkdir(join(root, '.graphyard'));
  await writeFile(unit, 'legacy unit');
  const file = join(root, '.graphyard/master.json');
  const instance = { configHome, session: 'graphyard-acme-app' };
  const ownership = [{ name: 'worker-1', principal: 'worker-1' }];
  await writeFile(file, JSON.stringify({ repository: 'acme/app', herdrWorkspace: 'wOld', herdrInstance: instance, workers: ownership, masterAgentName: 'master' }));
  let panes = [{ pane_id: 'wOld:p1', agent_status: 'working' }];
  const calls: string[][] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args[0] === '--session') return JSON.stringify({ panes });
    if (args[0] === 'workspace') return JSON.stringify({ workspaces: [{ workspace_id: 'wMain', label: 'graphyard-acme-app' }] });
    return '';
  };
  await migrateHerdr(root, run, home);
  let config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.herdrWorkspace, 'wMain');
  assert.deepEqual(config.herdrInstance, instance);
  assert.deepEqual(config.workers, ownership);
  applyHerdrConfig(config);
  assert.equal(herdrTarget(), null);
  assert.deepEqual(herdrInvocation(['tab', 'create', '--workspace', config.herdrWorkspace]).args, ['tab', 'create', '--workspace', 'wMain']);
  assert.ok(await stat(unit)); assert.ok(await stat(configHome));
  assert.ok(!calls.some(call => call[0] === 'systemctl'));
  panes = [];
  await migrateHerdr(root, run, home);
  config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.herdrInstance, undefined);
  assert.deepEqual(config.workers, ownership);
  await assert.rejects(stat(unit), { code: 'ENOENT' });
  await assert.rejects(stat(configHome), { code: 'ENOENT' });
  const count = calls.length;
  await migrateHerdr(root, run, home);
  assert.equal(calls.length, count);
});

test('retired private-instance and rebind options are unknown, and redeploy stops emitting them', () => {
  for (const flag of ['--herdr-instance', '--herdr-rebind']) {
    assert.throws(() => installRequestFromArgs(['--provider', 'compose', '--repo', 'acme/app', flag]), /Unknown option/);
  }
  const args = redeployArguments({ repository: 'acme/app', provider: 'compose', baseBranch: 'main', herdrInstance: true, principals: [] } as any, 'image');
  assert.ok(!args.includes('--herdr-instance'));
  assert.ok(!args.includes('--observe-only'), 'a legacy full install remains a full install');
});
