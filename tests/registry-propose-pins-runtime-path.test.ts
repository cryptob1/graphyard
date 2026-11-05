import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registryCommand } from '../src/cli/master-registry.js';
import { accountLaunch } from '../src/master/environments.js';
import { emptyRegistry } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-3090 AC-1: a runtime whose program is a mise shim is proposed with PATH led by the directory
 * mise installed it in and MISE_NO_CONFIG=1, so its launch runs the install itself — not the shim,
 * which fails once the user's global mise config no longer pins the tool.
 */
const scratch = await temporaryDirectory('registry-pins');
after(() => rm(scratch, { recursive: true, force: true }));

async function script(path: string, body: string) {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

test('unit:registry-propose-pins-runtime-path — registry propose resolves a mise-shimmed runtime to its install directory and stores PATH led by it with MISE_NO_CONFIG=1, so the launch runs with no global mise pin', async t => {
  const tools = join(scratch, 'mise-bin'), shims = join(scratch, 'mise', 'shims'), install = join(scratch, 'mise', 'installs', 'opencode', '1.2.3', 'bin');
  const directory = join(scratch, '.coding_agents'), home = join(scratch, 'home');
  for (const path of [tools, shims, install, home]) await mkdir(path, { recursive: true });
  // mise: `mise which opencode` names the install; run through a shim with no pin it fails like the real one.
  await script(join(tools, 'mise'), `if [ "$1" = which ]; then echo '${install}/opencode'; exit 0; fi\necho "mise ERROR No version is set for shim: $(basename "$0")" >&2; exit 1`);
  await symlink(join(tools, 'mise'), join(shims, 'opencode'));
  await script(join(install, 'opencode'), 'echo installed-opencode');
  await mkdir(join(directory, 'opencode-a', 'opencode'), { recursive: true });
  await writeFile(join(directory, 'opencode-a', 'opencode', 'auth.json'), JSON.stringify({ anthropic: { type: 'api', key: 'k' } }));
  const saved = { PATH: process.env.PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  process.env.PATH = `${shims}:${tools}:/usr/bin:/bin`;
  process.env.XDG_DATA_HOME = join(home, '.local/share');
  assert.throws(() => execFileSync('opencode', [], { stdio: 'pipe' }), 'the shim alone fails with no mise pin');

  const preview = await registryCommand({ hostId: 'agent-host-1' }, ['propose', '--directory', directory],
    { read: async () => emptyRegistry(), write: async () => { throw new Error('a preview stores nothing'); } },
    { home, executables: () => false }) as any;
  const runtime = preview.proposal.runtimes.find((entry: any) => entry.name === 'opencode');
  assert.equal(runtime.launch.environment.PATH.split(':')[0], install, 'PATH is led by the resolved install directory');
  assert.equal(runtime.launch.environment.MISE_NO_CONFIG, '1');

  const account = preview.proposal.accounts.find((entry: any) => entry.runtime === 'opencode');
  const launch = accountLaunch({ approvals: 'auto', agentArgs: [], environment: {} },
    { name: account.name, kind: 'opencode', home: account.credential.home, fleet: { runtime: 'opencode', contract: runtime.launch, model: 'm', modelId: null, session: 's', reason: 'r', role: 'worker', revision: 1 } } as any);
  assert.equal(launch.environment.PATH.split(':')[0], install, 'the launch environment keeps the pinned PATH');
  assert.equal(execFileSync('opencode', [], { env: launch.environment, encoding: 'utf8' }).trim(), 'installed-opencode', 'the launch runs the install, not the shim');
});
