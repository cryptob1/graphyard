import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, symlink, copyFile, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { setupRepository } from '../src/repository-setup.js';
import { setupMaster, loadMasterConfig, reresolveHerdrWorkspace } from '../src/master/config.js';
import { startMaster } from '../src/master/harness.js';
import { liveHerdrWorkspace, scopeHerdr, listHerdrAgents } from '../src/master/herdr.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { startedAtOnce } from './helpers/launch-shell.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

test('two installations bind, start their masters and recover independently on one main Herdr server', async () => {
  const home = await temporaryDirectory('shared-herdr'), pluginHome = join(home, 'plugin');
  // A separate thread serves the synchronous setup calls and the asynchronous runtime calls.
  const server = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { createServer } = require('node:http');
    let workspaces = [], agents = [], sequence = 0;
    createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const args = JSON.parse(body); let result = {};
      const value = flag => args[args.indexOf(flag) + 1];
      if (args[0] === 'plugin' && args[1] === 'config-dir') result = workerData;
      if (args[0] === 'workspace' && args[1] === 'list') result = { workspaces };
      if (args[0] === 'workspace' && args[1] === 'create') {
        const workspace = { workspace_id: 'w' + (++sequence), label: value('--label') };
        workspaces.push(workspace); result = { workspace };
      }
      if (args[0] === 'forget') workspaces = workspaces.filter(w => w.workspace_id !== args[1]);
      if (args[0] === 'tab' && args[1] === 'create') {
        const workspace_id = value('--workspace');
        if (!workspaces.some(w => w.workspace_id === workspace_id)) throw Error('wrong workspace');
        const pane_id = workspace_id + ':p' + (++sequence), tab_id = workspace_id + ':t' + sequence;
        agents.push({ pane_id, workspace_id }); result = { root_pane: { pane_id, tab_id } };
      }
      if (args[0] === 'agent' && args[1] === 'rename') { const agent = agents.find(a => a.pane_id === args[2]); if (agent) agent.name = args[3]; }
      if (args[0] === 'agent' && args[1] === 'list') result = { agents };
      res.end(typeof result === 'string' ? result : JSON.stringify({ result }));
    }).listen(0, '127.0.0.1', function () { parentPort.postMessage(this.address().port); });
  `, { eval: true, workerData: join(home, 'bindings') });
  const port = await new Promise<number>(resolve => server.once('message', resolve));
  const url = `http://127.0.0.1:${port}`;
  const sync = (args: string[]) => execFileSync(process.execPath, ['-e', 'fetch(process.argv[1], {method:"POST", body:process.argv[2]}).then(r=>r.text()).then(t=>process.stdout.write(t))', url, JSON.stringify(args)], { encoding: 'utf8' });
  const run = async (_command: string, args: string[]) => {
    const result = await (await fetch(url, { method: 'POST', body: JSON.stringify(args) })).text();
    return startedAtOnce(args) ?? result;
  };
  try {
    const roots: string[] = [];
    const workspaces: string[] = [];
    for (const name of ['alpha', 'beta']) {
      const root = await temporaryDirectory(name), credentials = await temporaryDirectory(`${name}-credentials`);
      roots.push(root);
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['remote', 'add', 'origin', `https://github.com/acme/${name}.git`], { cwd: root });
      const release = join(home, name);
      await mkdir(join(release, 'bin'), { recursive: true });
      await copyFile(launcher, join(release, 'bin/graphyard.mjs'));
      await symlink(join(dirname(dirname(launcher)), 'integrations'), join(release, 'integrations'));
      await symlink(join(dirname(dirname(launcher)), 'herdr-plugin.toml'), join(release, 'herdr-plugin.toml'));
      const cliPath = join(release, 'bin/graphyard.mjs');
      const token = `${name}-worker-token`.padEnd(40, 'x');
      const result = await setupRepository(root, { url: `https://${name}.example`, token, hostId: hostname(), cliPath }, {
        herdr: true, runHerdr: sync, pluginHome,
        fetcher: async () => new Response(JSON.stringify({ repository: `acme/${name}`, actor: { id: name, role: 'worker' } })),
      });
      if (name === 'alpha') {
        const manifest = await readFile(join(pluginHome, 'herdr-plugin.toml'), 'utf8');
        await writeFile(join(pluginHome, 'herdr-plugin.toml'), manifest.replace('0.2.0', '0.3.0'));
        await appendFile(join(pluginHome, 'integrations/herdr/ledger.mjs'), '\n// newer plugin release\n');
      }
      const workspace = result.herdr!.workspace!;
      workspaces.push(workspace);
      await setupMaster(root, { url: `https://${name}.example`, token: 'coordinator'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: workspace },
        async () => new Response(JSON.stringify({ repository: `acme/${name}`, baseBranch: 'main', actor: { id: 'master', role: 'coordinator' } })));
      const masterPane = await startMaster(root, 'codex', [], [], run);
      assert.ok(masterPane.pane.startsWith(`${workspace}:`));
      scopeHerdr(workspace);
      // Workers run headless (GY-3259): the master is the one pane each install opens.
      assert.equal((await listHerdrAgents(run)).length, 1);
    }
    assert.notEqual(workspaces[0], workspaces[1]);
    const config = JSON.parse(await readFile(join(home, 'bindings/config.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.installs).sort(), ['acme-alpha', 'acme-beta']);
    const { bindingFor } = await import('../integrations/herdr/config.mjs' as string);
    for (let index = 0; index < roots.length; index++) {
      const binding = config.installs[index ? 'acme-beta' : 'acme-alpha'];
      assert.equal(bindingFor(config, { HERDR_PANE_ID: `${workspaces[index]}:p1` }, roots[1 - index]).url, binding.url);
      assert.equal(bindingFor(config, {}, join(roots[index], 'nested')).cliPath, join(home, index ? 'beta' : 'alpha', 'bin/graphyard.mjs'));
      await run('herdr', ['forget', workspaces[index]]);
      const master = await loadMasterConfig(roots[index]);
      const switched = await reresolveHerdrWorkspace(roots[index], master, current => liveHerdrWorkspace(current, run));
      assert.ok(switched && !workspaces.includes(switched.to), 'recovery creates its own workspace, never adopts the other install');
      const inventory = JSON.parse(await run('herdr', ['workspace', 'list'])).result.workspaces;
      assert.equal(bindingFor(config, { HERDR_WORKSPACE_ID: switched.to }, home, inventory).url, binding.url, 'the plugin recognizes the recovered workspace by its install label');
    }
    assert.match(await readFile(join(pluginHome, 'integrations/herdr/ledger.mjs'), 'utf8'), /newer plugin release/, 'an older CLI cannot downgrade the shared plugin');
  } finally { scopeHerdr(null); await server.terminate(); }
});
