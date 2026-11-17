import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { setupLine } from '../src/setup-from-zero.js';
import { accountRuntimeChecks, gitRemoteCheck, herdrPluginCheck } from '../src/host-readiness.js';
import { remoteFetchProbe } from '../src/master/worktrees.js';

// GY-3351: doctor checks, on a temporary home, every registry account's runtime executable and PATH
// entries on this host, the Herdr plugin and one git ls-remote of origin — one line with the fix each.
const executable = async (file: string, body = '#!/bin/sh\n') => { await writeFile(file, body); await chmod(file, 0o755); };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

async function host(pluginEnabled: boolean, remote: string) {
  const home = await temporaryDirectory('doctor-host-readiness');
  const bin = join(home, 'bin'), empty = join(home, 'empty'), root = join(home, 'checkout');
  await mkdir(bin); await mkdir(empty); await mkdir(root);
  await executable(join(bin, 'claude'));
  await executable(join(bin, 'herdr'), `#!/bin/sh\necho '{"plugins":[${pluginEnabled ? '{"plugin_id":"graphyard","enabled":true}' : ''}]}'\n`);
  git(root, 'init', '-q'); git(root, 'remote', 'add', 'origin', remote);
  return { home, bin, empty, root };
}

const lines = async (root: string, bin: string, document: any) => {
  const path = `${bin}:/usr/bin:/bin`;
  const plugin = await herdrPluginCheck(path);
  return [...(plugin ? [plugin] : []), ...accountRuntimeChecks(document, 'host-a', path), gitRemoteCheck(await remoteFetchProbe(root))].map(setupLine);
};

test('e2e:doctor-host-readiness — a missing runtime executable, a missing PATH entry, a missing Herdr plugin and a failing remote each yield one line with the fix', async () => {
  const { home, bin, empty, root } = await host(false, join(await temporaryDirectory('doctor-host-no-remote'), 'absent.git'));
  const mise = join(home, '.local/share/mise/installs/pi/latest/bin');
  const document = {
    runtimes: [
      { name: 'claude-noexe', launch: { kind: 'claude', environment: { PATH: empty } } },
      { name: 'claude-badpath', launch: { kind: 'claude', environment: { PATH: `${bin}:${mise}` } } },
    ],
    accounts: [
      { name: 'noexe-a', runtime: 'claude-noexe', credential: { host: 'host-a' } },
      { name: 'badpath-a', runtime: 'claude-badpath', credential: { host: 'host-a' } },
      { name: 'elsewhere', runtime: 'claude-noexe', credential: { host: 'host-b' } },
    ],
  };
  const printed = await lines(root, bin, document);
  const account = printed.filter(line => line.startsWith('FAIL account-runtime'));
  assert.equal(account.length, 2, printed.join('\n'));
  assert.ok(account.some(line => line.includes('account noexe-a') && line.includes('executable claude') && line.includes(empty) && line.includes('(fix: install claude')), account.join('\n'));
  assert.ok(account.some(line => line.includes('account badpath-a') && line.includes(`PATH entry ${mise}`) && line.includes('(fix: mise install pi@latest)')), account.join('\n'));
  assert.ok(!printed.some(line => line.includes('elsewhere')), 'an account on another host is not this host\'s to judge');
  const plugin = printed.filter(line => line.includes('herdr-plugin'));
  assert.deepEqual(plugin, ['FAIL herdr-plugin: Herdr has no enabled graphyard plugin (fix: rerun graphyard up from this checkout; its Herdr step links and enables the graphyard plugin)']);
  const remote = printed.filter(line => line.includes('git-remote'));
  assert.equal(remote.length, 1);
  assert.match(remote[0], /^FAIL git-remote: git ls-remote origin failed: .*absent\.git.* \(fix: make git fetch from origin work on this host/);
});

test('e2e:doctor-host-readiness — with every executable, PATH entry, the plugin and the remote present doctor reports them passing', async () => {
  const bare = await temporaryDirectory('doctor-host-bare');
  git(bare, 'init', '-q', '--bare');
  const { bin, root } = await host(true, bare);
  const document = {
    runtimes: [{ name: 'claude-ok', launch: { kind: 'claude', environment: { PATH: bin } } }],
    accounts: [{ name: 'ok-a', runtime: 'claude-ok', credential: { host: 'host-a' } }, { name: 'ok-b', runtime: 'claude-ok', credential: { host: 'host-a' } }],
  };
  assert.deepEqual(await lines(root, bin, document), [
    `PASS herdr-plugin: Herdr has the graphyard plugin enabled (${join(bin, 'herdr')})`,
    `PASS account-runtime: account ok-a runs ${join(bin, 'claude')}`,
    `PASS account-runtime: account ok-b runs ${join(bin, 'claude')}`,
    'PASS git-remote: git ls-remote origin answered',
  ]);
});
