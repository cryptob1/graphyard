import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateHerdr } from '../src/herdr-migration.js';
import { installRequestFromArgs, redeployArguments } from '../src/install/index.js';
import { readInstallRecord } from '../src/install/secrets.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('e2e:upgrade-private-herdr-install — a pre-GY-3212 private-Herdr install restarts onto the head, migrates to the main Herdr and drops herdrInstance from every record', async () => {
  const root = await temporaryDirectory('private-herdr-root'), home = await temporaryDirectory('private-herdr-home');
  const configRoot = join(home, '.config/graphyard'), installDir = join(configRoot, 'acme-app');
  const previous = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = configRoot;
  try {
    // The records a pre-GY-3212 release wrote for an install on its own Herdr server.
    const instance = { configHome: join(configRoot, 'acme-app/herdr'), session: 'gy-9a4de6' };
    const unit = join(home, '.config/systemd/user/graphyard-herdr-acme-app.service');
    await mkdir(instance.configHome, { recursive: true });
    await mkdir(join(home, '.config/systemd/user'), { recursive: true });
    await writeFile(unit, 'private herdr unit');
    await mkdir(join(root, '.graphyard'));
    await writeFile(join(root, '.graphyard/up.json'), JSON.stringify({ version: 1, repository: 'acme/app', provider: 'compose', completed: [], noHerdr: false, herdrInstance: true }));
    await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ repository: 'acme/app', herdrWorkspace: 'wPrivate', herdrInstance: instance }));
    const now = new Date(0).toISOString();
    await writeFile(join(installDir, 'install.json'), JSON.stringify({ version: 1, installId: 'acme-app', repository: 'acme/app', provider: 'compose', baseBranch: 'main', reviewPolicy: 'agent', merger: 'control-plane', herdrInstance: true,
      principals: [{ id: 'acme-app-worker-1', role: 'worker', sessionKind: 'ai', fingerprint: 'abcdefabcdef' }], createdAt: now, updatedAt: now }));

    // The predecessor's deploy watch restarts onto the head with its own redeploy arguments, which carry
    // --herdr-instance; the head's install accepts and ignores them, so the restart's plan and apply run.
    const predecessor = ['--repo', 'acme/app', '--provider', 'compose', '--base-branch', 'main', '--review-policy', 'agent', '--workers', '1', '--herdr-instance', '--image', 'graphyard-local:6a33f7bc2a2a', '--source-root', '/build'];
    for (const mode of ['--plan', '--apply']) {
      const { request } = installRequestFromArgs([...predecessor, mode]);
      assert.deepEqual(request, installRequestFromArgs([...predecessor.filter(flag => flag !== '--herdr-instance'), mode]).request);
    }
    assert.doesNotThrow(() => installRequestFromArgs([...predecessor, '--herdr-rebind', '--apply']));

    // The restarted watch migrates: new launches go to the main Herdr's workspace while the private server drains.
    let panes = [{ pane_id: 'wPrivate:p1' }];
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (args[0] === '--session') return JSON.stringify({ panes });
      if (args[0] === 'workspace') return JSON.stringify({ workspaces: [{ workspace_id: 'wMain', label: 'graphyard-acme-app' }] });
      return '';
    };
    await migrateHerdr(root, run, home);
    const master = () => readFile(join(root, '.graphyard/master.json'), 'utf8').then(JSON.parse);
    assert.equal((await master()).herdrWorkspace, 'wMain');
    assert.deepEqual((await master()).herdrInstance, instance, 'the private server is kept while it still has panes');
    assert.ok(await stat(unit));

    // Its last pane ends: the private server is removed and every record drops herdrInstance.
    panes = [];
    await migrateHerdr(root, run, home);
    assert.ok(calls.some(call => call.join(' ') === 'systemctl --user disable --now graphyard-herdr-acme-app.service'));
    await assert.rejects(stat(unit), { code: 'ENOENT' });
    await assert.rejects(stat(instance.configHome), { code: 'ENOENT' });
    assert.ok(!('herdrInstance' in await master()));
    assert.ok(!('herdrInstance' in JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8'))));
    assert.ok(!('herdrInstance' in JSON.parse(await readFile(join(installDir, 'install.json'), 'utf8'))));

    // The next redeploy, from the migrated record, passes no --herdr-instance and stays a full install.
    const record = await readInstallRecord(installDir);
    const args = redeployArguments(record!, 'graphyard-local:next');
    assert.ok(!args.includes('--herdr-instance'));
    assert.deepEqual(args.slice(args.indexOf('--workers'), args.indexOf('--workers') + 2), ['--workers', '1']);
  } finally {
    if (previous === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = previous;
  }
});
