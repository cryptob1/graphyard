import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readOnlyMountWrapper } from '../../src/master/confinement.js';
import { accountLaunch } from '../../src/master/environments.js';
import { proposedRuntimes } from '../../src/model/registry.js';
import { prepareConfinedGitPaths, startAgentSession } from '../../src/master/launch.js';
import { runtimeLaunchProvider } from './runtime-launch-provider.js';
import { runtimeLaunchTerminal } from './runtime-launch-terminal.js';
import { temporaryDirectory } from './temp-dirs.js';

/** Runs inside the fixture's systemd-resolved-style host namespace. */
export async function runtimeLaunchSession(base: string, resolver: boolean) {
  const root = join(base, 'repo'), worktree = join(root, 'assigned'), home = join(base, 'operator');
  for (const path of [root, home]) await mkdir(path, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  await writeFile(join(root, 'README'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  git('worktree', 'add', '-qb', 'graphyard/test-runtime', worktree);
  prepareConfinedGitPaths(root);
  await writeFile(join(home, 'sentinel'), 'protected');
  const wrapper = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: worktree, secretsBus: null });
  const execute = (words: readonly string[], command: string, args: string[]) => spawnSync(words[0], [...words.slice(1), command, ...args], {
    cwd: worktree, env: { ...process.env, RES_OPTIONS: 'attempts:1 timeout:1' }, encoding: 'utf8', timeout: 15_000,
  });
  if (resolver) {
    const file = '/run/systemd/resolve/stub-resolv.conf';
    const at = wrapper.findIndex((word, index) => word === '--ro-bind' && wrapper[index + 1] === file);
    assert.ok(at >= 0, 'the canonical resolver is the only file restored under /run');
    const broken = [...wrapper]; broken.splice(at, 3);
    const failed = execute(broken, 'getent', ['ahosts', 'example.com']);
    assert.equal(failed.status, 2, `actual DNS lookup must fail with masked /run: ${failed.stderr}`);
    const fixed = execute(wrapper, 'getent', ['ahosts', 'example.com']);
    assert.equal(fixed.status, 0, `repaired DNS must resolve: ${fixed.stderr}`);
    assert.match(fixed.stdout, /STREAM/);
    const isolation = execute(wrapper, '/bin/sh', ['-ec',
      'test ! -e /run/gy-control/sentinel; test ! -S /run/dbus/system_bus_socket; test ! -w /run/systemd/resolve/stub-resolv.conf; test ! -w "$1/sentinel"', 'probe', home]);
    assert.equal(isolation.status, 0, isolation.stderr);
    console.log('getent ahosts failed with masked /run and recovered with only the read-only resolver');
  }
  // An actual executable wrapper stops on the incident dialog. Shell startup
  // shadows the selected PATH and clears the override, just as mise activation did.
  const shims = join(base, 'shims'); await mkdir(shims);
  await writeFile(join(shims, 'codex'), '#!/bin/sh\necho "mise ERROR config files in /home/operator are not trusted."\necho "Trust them? [y/N]"\nread answer\n', { mode: 0o700 });
  const rc = join(base, 'bashrc');
  await writeFile(rc, `export PATH='${shims}:/usr/local/bin:/usr/bin:/bin'\nunset MISE_NO_CONFIG\nPS1='GY-PTY> '\n`);
  const installed = execFileSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim();
  assert.ok(installed && !installed.includes('/shims/'), 'use the installed binary, never the wrapper');
  const accounts = await temporaryDirectory('accounts', base);
  for (const role of ['worker', 'reviewer']) {
    const provider = await runtimeLaunchProvider();
    try {
      const account = await temporaryDirectory(`${role}-account`, accounts);
      // Production exposes only this selected login/state directory after masking
      // the install's other credentials. CODEX_HOME alone is not a write grant.
      const credentialMask = { configHome: accounts, extraPaths: [], own: [account], cli: [] };
      const contract = { ...proposedRuntimes.find(runtime => runtime.name === 'codex')!.launch,
        args: provider.args, environment: {} };
      const launch = accountLaunch({ kind: 'codex', approvals: 'auto', agentArgs: [], environment: { PROFILE_ONLY: 'ignored' } }, {
        name: `${role}-account`, kind: 'codex', home: account,
        fleet: { runtime: 'codex', contract, model: 'test', modelId: null, session: `${role}-session`, role: role as 'worker' | 'reviewer', reason: 'fixture', revision: 7 },
      });
      const selected = launch.environment;
      assert.equal(selected.PROFILE_ONLY, undefined, 'only the chosen registry runtime environment applies');
      assert.equal(selected.PATH, process.env.PATH, 'the native install PATH survives without a registry workaround');
      assert.equal(selected.MISE_NO_CONFIG, '1');
      const terminal = await runtimeLaunchTerminal(worktree, rc, { ...process.env, ...selected, TERM: 'dumb' });
      try {
        const options = { directory: worktree, coordinatorRoot: root, cwd: worktree, secretsBus: null, credentialMask,
          timeoutMs: 3000, ceilingMs: 5000, pollMs: 25, keyringWarning: async () => null } as const;
        // The unrepaired launch hits the real wrapper before any runtime request.
        await assert.rejects(startAgentSession(`failed-${role}`, 'codex', 'pty', provider.args, 'wrapper-negative-request', terminal.run,
          { ...options, environment: { CODEX_HOME: account } }), /mise stopped the launch before the agent started/);
        assert.equal(provider.requests.length, 0);
        assert.ok(!terminal.calls.some(args => args[1] === 'rename' || args[1] === 'send-keys'), 'no adoption or trust grant');
      } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}\nFull failed-launch PTY output:\n${terminal.screen()}`, { cause: error }); }
      finally { await terminal.close(); }
      const recovered = await runtimeLaunchTerminal(worktree, rc, { ...process.env, ...selected, TERM: 'dumb' });
      try {
        const request = `First request for ${role}: preserve exact apostrophe ' and newline\nrequest-marker-${role}`;
        const launched = await startAgentSession(`recovered-${role}`, 'codex', 'pty', launch.args, request, recovered.run, {
          directory: worktree, coordinatorRoot: root, cwd: worktree, secretsBus: null, credentialMask, environment: selected,
          timeoutMs: 5000, ceilingMs: 10_000, pollMs: 25, keyringWarning: async () => null,
        });
        assert.equal(launched.started.state, 'started');
        await recovered.until(() => JSON.stringify(provider.requests).includes(`request-marker-${role}`), 'installed runtime first provider request');
        const actual = JSON.stringify(provider.requests.at(-1));
        assert.ok(actual.includes(JSON.stringify(request).slice(1, -1)), 'provider receives the exact initial request');
        provider.release();
        await recovered.until(() => recovered.screen().includes('runtime-request-completed') && recovered.screen().trimEnd().endsWith('GY-PTY>'), 'installed runtime completed response and exited successfully');
        assert.ok(provider.requests.some((request: any) => request.input?.some((item: any) => item.type === 'function_call_output' && JSON.stringify(item.output).includes('runtime-tool-completed'))), 'the installed runtime actually executed its shell tool and returned the result');
        assert.equal(await readFile(join(home, 'sentinel'), 'utf8'), 'protected');
        console.log(`${role}: installed Codex received its first request and completed the provider response`);
      } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}\nFull recovered-launch PTY output:\n${recovered.screen()}`, { cause: error }); }
      finally { await recovered.close(); }
    } finally { await provider.close(); }
  }
}
