import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { restartMasterLoop, supervisingUnit } from '../src/master/loop-restart.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1616: `master restart` goes through this install's unit only when the unit's effective
 * ExecStart (drop-ins applied, as `systemctl show` reports it) is node running this install's
 * config.cliPath with `master run`. A unit rooted here whose drop-in rewrote the executable or the
 * CLI is passed over: the command names the mismatch and takes the detached restart.
 */

const unit = 'graphyard-master.service';

async function install() {
  const root = await temporaryDirectory('execstart-root'), home = await temporaryDirectory('execstart-home');
  execFileSync('git', ['init', '-q', root]);
  const launched = join(root, 'launched.txt'), cliPath = join(root, 'cli.mjs');
  await writeFile(cliPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(launched)}, process.argv.slice(2).join(' '));\n`);
  const config = { hostId: 'this-host', cliPath, repository: 'owner/execstart', run: { intervalSeconds: 20 } } as unknown as MasterConfig;
  return { root, home, launched, cliPath, config, host: { home } };
}

/** A fake user manager whose unit runs PATH with ARGV as its effective ExecStart, recording every command it was given. */
function systemd(root: string, path: string, argv: string, state: { mainPid: number; next: number }) {
  const calls: string[][] = [];
  const systemctl = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'restart') state.mainPid = state.next;
    if (args[0] !== 'show') return '';
    return `LoadState=loaded\nActiveState=active\nMainPID=${state.mainPid}\nWorkingDirectory=${root}\nExecStart={ path=${path} ; argv[]=${argv} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`;
  };
  return { calls, systemctl };
}

const launchedText = async (file: string) => {
  for (let attempt = 0; attempt < 50 && !existsSync(file); attempt++) await new Promise(done => setTimeout(done, 100));
  return readFile(file, 'utf8');
};

test('unit:loop-restart-execstart — a unit whose effective ExecStart names another CLI or a non-node executable is not restarted; the mismatch is reported and the detached restart taken', async () => {
  const { root, home, launched, cliPath, config, host } = await install();
  try {
    const cases = [
      { path: '/usr/bin/node', argv: `/usr/bin/node ${join(home, 'other-cli.mjs')} master run`, reason: new RegExp(`runs the CLI ${join(home, 'other-cli.mjs')}, not this install's ${cliPath}`) },
      { path: '/usr/bin/bun', argv: `/usr/bin/bun ${cliPath} master run`, reason: /executable \/usr\/bin\/bun is not node/ },
      { path: '/usr/bin/python3', argv: `/usr/bin/node ${cliPath} master run`, reason: /executable \/usr\/bin\/python3 is not node/ },
      { path: '/bin/echo', argv: '/bin/echo master run', reason: /runs \/bin\/echo master run, not exactly NODE CLI master run/ },
    ];
    for (const { path, argv, reason } of cases) {
      const manager = systemd(root, path, argv, { mainPid: 4242, next: 5151 });
      assert.equal(await supervisingUnit(root, config, { systemctl: manager.systemctl, host, platform: 'linux' }), null, argv);
      const restarted = await restartMasterLoop(root, config, null, { systemctl: manager.systemctl, host, platform: 'linux' });
      assert.equal(restarted.supervisor, null, argv);
      assert.ok(!manager.calls.some(args => args[0] === 'restart'), `no systemctl restart of ${argv}`);
      assert.match(restarted.mismatch ?? '', new RegExp(`^${unit} was not restarted: `), argv);
      assert.match(restarted.mismatch ?? '', reason, argv);
      assert.match(restarted.mismatch ?? '', /restarted detached instead$/, argv);
      assert.ok(restarted.log, 'the detached restart logs beside the config');
      assert.equal(await launchedText(launched), 'master run', `${argv}: the documented fallback starts this install's master run detached`);
      await rm(launched);
    }
  } finally { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});

test('unit:loop-restart-execstart — a unit whose effective ExecStart is node running this install\'s CLI with master run restarts through systemd and reports its new MainPID', async () => {
  const { root, home, launched, cliPath, config, host } = await install();
  try {
    for (const node of ['/usr/bin/node', '/home/operator/.nvm/versions/node/v22.4.0/bin/node']) {
      const manager = systemd(root, node, `${node} ${cliPath} master run`, { mainPid: 4242, next: 5151 });
      assert.deepEqual(await supervisingUnit(root, config, { systemctl: manager.systemctl, host, platform: 'linux' }), { unit, mainPid: 4242 });
      const restarted = await restartMasterLoop(root, config, null, { systemctl: manager.systemctl, host, platform: 'linux' });
      assert.deepEqual({ supervisor: restarted.supervisor, stopped: restarted.stopped, started: restarted.started, log: restarted.log, mismatch: restarted.mismatch }, { supervisor: unit, stopped: 4242, started: 5151, log: null, mismatch: null });
      assert.ok(manager.calls.some(args => args.join(' ') === `restart ${unit}`), 'systemctl --user restart of the unit');
    }
    await new Promise(done => setTimeout(done, 300));
    assert.equal(existsSync(launched), false, 'no detached master run beside a matching unit');
  } finally { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});
