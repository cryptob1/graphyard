import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { buildPlan, installRequestFromArgs, prepareInstall, type InstallSession } from '../src/install/index.js';
import { freeLoopbackPort, loopbackPortFree, type LocalSupervisor } from '../src/install/local.js';
import { installRecordSchema, writeInstallRecord } from '../src/install/secrets.js';
import { installCommands } from '../src/cli/install.js';
import { runUp, upRequestFromArgs, type UpDependencies } from '../src/up.js';
import { harness } from './install-harness.js';

const foreground = (): LocalSupervisor => ({ systemd: null, reason: 'test host', systemctl: async () => { throw new Error('no systemd'); }, detach: async () => { throw new Error('a plan starts nothing'); }, kill: async () => {} });
// Nothing on a held port answers as this installation.
const notServing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
const plannedPort = async (session: InstallSession) => {
  const plan = await buildPlan(session);
  return Number(plan.actions.find(action => action.id === 'provider.env.core')!.values!.find(value => value.name === 'PORT')!.value);
};

test('unit:tests/up-free-port.test.ts — a local plan picks a free port when 4310 is held, up --port forwards N to install, and a rerun keeps the recorded port', async () => {
  const fixture = await harness({ provider: 'local' });
  const deps = { ...fixture.deps, fetch: notServing, localSupervisor: foreground() };
  // Hold 4310 unless something on this host already does.
  let held: Server | null = null;
  if (await loopbackPortFree(4310)) { held = createServer(); await new Promise<void>(accept => held!.listen(4310, '127.0.0.1', () => accept())); }
  try {
    const picked = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'local' }, deps, 'plan');
    const port = await plannedPort(picked);
    assert.ok(port > 4310 && port < 4330, `a held 4310 gives way to the next free port, got ${port}`);
    assert.equal(picked.context.port, port);
    assert.ok(await loopbackPortFree(port));
    assert.equal((await buildPlan(picked)).preflight.find(item => item.name === 'Loopback port')!.ok, true);

    assert.match(installCommands.find(command => command.name === 'up')!.help.join('\n'), /--port N/);
    const request = upRequestFromArgs(['--repo', 'owner/project', '--local', '--port', '4399']);
    assert.equal(request.port, 4399);
    const calls: string[][] = [];
    const planned: number[] = [];
    const dependencies: UpDependencies = {
      root: fixture.root, emit: () => {}, now: Date.now, sleep: async () => {},
      serverUrl: async () => null, masterToken: async () => null, status: async () => null,
      publishOnboarding: async () => null,
      gh: async () => ({ code: 0, stdout: '{}' }), git: async () => ({ code: 0, stdout: '' }),
      async cli(args) {
        calls.push(args);
        if (args[0] !== 'install' || !args.includes('--plan')) return { code: 1, stdout: '', stderr: 'stop after the plan' };
        const { request: inputs } = installRequestFromArgs(args.slice(1));
        planned.push(await plannedPort(await prepareInstall(fixture.root, inputs, deps, 'plan')));
        return { code: 1, stdout: '', stderr: 'stop after the plan' };
      },
    };
    await runUp(request, dependencies);
    const install = calls.find(args => args[0] === 'install' && args.includes('--plan'));
    assert.ok(install, 'up ran the install plan');
    assert.equal(install[install.indexOf('--port') + 1], '4399');
    assert.deepEqual(planned, [4399], 'up\'s preflight plans 4399');

    // The apply records the port; a rerun without --port plans it, not a fresh pick.
    const recorded = await freeLoopbackPort();
    await mkdir(picked.directory, { recursive: true });
    await writeInstallRecord(picked.directory, installRecordSchema.parse({
      version: 1, installId: picked.installId, repository: 'owner/project', provider: 'local', baseBranch: 'main',
      createdAt: '2026-11-09', updatedAt: '2026-11-09', deployment: { local: false, port: recorded, image: null },
    }), picked.vault);
    const rerun = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'local' }, deps, 'plan');
    assert.equal(await plannedPort(rerun), recorded, 'a rerun keeps the recorded port');
  } finally {
    held?.close();
    await fixture.cleanup();
  }
});
