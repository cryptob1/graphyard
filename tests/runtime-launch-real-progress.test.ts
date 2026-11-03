import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { awaitRuntimeStart, observeStart, SessionStartError } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('integration:runtime-launch-real-progress — named idle/working shells and external trust dialogs are not live agent runtimes', async () => {
  for (const status of ['idle', 'working']) for (const holder of ['shell', 'mise']) {
    const run = (_command: string, args: string[]) => {
      const json = (result: unknown) => JSON.stringify({ result });
      if (args[0] === 'agent') return json({ agent: { agent: 'codex', agent_status: status } });
      if (args[1] === 'read') return holder === 'mise' ? 'mise ERROR config files in /home/operator are not trusted.\nTrust them? [y/N]' : 'Codex named shell\n$ ';
      if (args[1] === 'process-info') return json({ process_info: { shell_pid: 100, foreground_process_group_id: holder === 'shell' ? 100 : 200,
        foreground_processes: holder === 'shell' ? [] : [{ argv: ['mise', 'exec', 'codex'] }] } });
      throw new Error(`Unexpected ${args}`);
    };
    assert.equal((await observeStart('pane', 'codex', 'codex', run)).state, holder === 'shell' ? 'absent' : 'blocked');
    let now = 0;
    await assert.rejects(awaitRuntimeStart('pane', 'codex', 'codex', run, {
      timeoutMs: 1000, ceilingMs: 2000, pollMs: 100, clock: () => now, wait: ms => { now += ms; }, holdConsent: true,
    }), (error: unknown) => error instanceof SessionStartError && error.startCase === (holder === 'shell' ? 'never started' : 'blocked'));
    assert.ok(now <= 1000, 'refused at the existing start bound, never the attempt lifetime');
  }
});

test('integration:runtime-launch-real-progress — real PTY worker/reviewer requests and systemd resolver failure/recovery keep the sandbox', { timeout: 90_000 }, async () => {
  // The outer fixture reproduces a host with resolv.conf symlinked into /run.
  // The inner wrappers are the production worker/reviewer wrappers, including Landlock.
  const base = await temporaryDirectory('runtime-launch', process.cwd());
  const etc = join(base, 'etc'); await mkdir(etc);
  await writeFile(join(etc, 'nsswitch.conf'), 'hosts: files dns\n');
  await writeFile(join(etc, 'hosts'), '127.0.0.1 localhost\n::1 localhost\n');
  await symlink('/run/systemd/resolve/stub-resolv.conf', join(etc, 'resolv.conf'));
  const resolver = join(base, 'public-resolver');
  await writeFile(resolver, await readFile('/etc/resolv.conf'));
  const marker = join(base, 'control-marker'); await writeFile(marker, 'host control socket directory stays hidden');
  const driver = fileURLToPath(new URL('fixtures/runtime-launch-resolver.ts', import.meta.url));
  const { stdout } = await promisify(execFile)('bwrap', ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
    '--ro-bind', etc, '/etc', '--tmpfs', '/run', '--ro-bind', resolver, '/run/systemd/resolve/stub-resolv.conf',
    '--ro-bind', marker, '/run/gy-control/sentinel', '--bind', base, base,
    '--', process.execPath, '--import', 'tsx', driver, base], { cwd: process.cwd(), timeout: 80_000, maxBuffer: 2_000_000 });
  assert.match(stdout, /getent ahosts failed with masked \/run and recovered/);
  for (const role of ['worker', 'reviewer']) assert.ok(stdout.includes(`${role}: installed Codex received its first request and completed the provider response`), stdout);
});
