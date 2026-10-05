import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { launchCommand, launchProgram, paneForeground, runsProgram, supervisorArgv } from '../src/master/launch.js';

/** A pane whose foreground group (5200, the shell being 4100) Herdr lists as these processes. */
function listedPane(processes: { pid: number; name?: string; argv?: string[] }[]) {
  return (_cmd: string, args: string[]) => JSON.stringify({ result: args[0] === 'pane' && args[1] === 'process-info' ? { process_info: { pane_id: args[3], shell_pid: 4100, foreground_process_group_id: 5200, foreground_processes: processes } } : {} });
}
/** The argv the pane's shell starts for a typed command line, as the shell itself splits it. */
const shellArgv = (line: string) => execFileSync('bash', ['-c', `set -- ${line}; printf '%s\\0' "$@"`], { encoding: 'utf8' }).split('\0').slice(0, -1);
const files = { stem: '/w/.graphyard/launch/s', role: null, request: null };

test('manual:review-followups-triaged GY-1213.1: supervisor detection is pinned to the launch command dispatch builds, and tolerates flags and a -c wrapper (Findings 3, 5, 7)', async () => {
  // The prefix dispatch passes (src/master/dispatch.ts): the CLI, `watch KEY EPOCH --`.
  const prefix = ['/usr/bin/node', '/home/u/code/project/bin/graphyard.mjs', 'watch', 'GY-1213', '1', '--'];
  for (const kind of ['claude', 'codex', 'cursor']) {
    const argv = shellArgv(launchCommand(kind, ['--flag'], files, prefix));
    assert.ok(supervisorArgv(argv), `${kind}: ${argv.join(' ')}`);
    assert.equal(await paneForeground('w1V:pC1', listedPane([{ pid: 5200, name: 'node', argv }]), launchProgram(kind)), 'supervisor');
  }
  // A flag before EPOCH, or the whole command as one `-c` string, is still the supervisor.
  assert.ok(supervisorArgv(['/usr/bin/node', '/w/bin/graphyard.mjs', 'watch', '--quiet', 'GY-1213', '1', '--', 'claude']));
  const wrapped = ['/bin/sh', '-c', `/usr/bin/node /w/bin/graphyard.mjs watch GY-1213 1 -- claude go`];
  assert.ok(supervisorArgv(wrapped));
  assert.equal(await paneForeground('w1V:pC1', listedPane([{ pid: 5200, name: 'sh', argv: wrapped }]), 'claude'), 'supervisor');
  // Not a supervisor: procps watch, or `watch` with no `--` opening a runtime.
  assert.equal(supervisorArgv(['watch', '-n', '1', '--', 'ls']), false);
  assert.equal(supervisorArgv(['/bin/sh', '-c', 'watch -n 1 -- ls']), false);
  assert.equal(supervisorArgv(['/usr/bin/node', '/w/bin/graphyard.mjs', 'watch', 'GY-1213']), false);
});

test('manual:review-followups-triaged GY-1213.2: the runtime is recognised by its program or a script named for it; a script of another name is not (Findings 1, 4, 6)', async () => {
  assert.ok(runsProgram(['/home/u/.local/bin/claude', '--print'], 'claude'));
  assert.ok(runsProgram(['/usr/bin/node', '/usr/lib/node_modules/@openai/codex/bin/codex.js', 'exec'], 'codex'));
  assert.ok(runsProgram(['/bin/sh', '-c', '/usr/lib/codex/bin/codex.mjs exec go'], 'codex'));
  assert.equal(await paneForeground('w1V:pC1', listedPane([{ pid: 5200, name: 'node', argv: ['/usr/bin/node', '/opt/codex/bin/codex.js'] }]), 'codex'), 'runtime');
  // Declined: `node …/cli.js` cannot be told from any other Node script by its argv, and needs no
  // recognition today — the supervisor stays in the launch's foreground group and is classed first.
  assert.equal(runsProgram(['/usr/bin/node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'], 'claude'), false);
  assert.deepEqual(await paneForeground('w1V:pC1', listedPane([{ pid: 5200, name: 'node', argv: ['/usr/bin/node', '/opt/claude-code/cli.js'] }]), 'claude'), { other: 'node' });
  assert.equal(await paneForeground('w1V:pC1', listedPane([{ pid: 5200, name: 'node', argv: ['/usr/bin/node', '/opt/claude-code/cli.js'] }, { pid: 5201, name: 'node', argv: ['/usr/bin/node', '/w/bin/graphyard.mjs', 'watch', 'GY-1', '1', '--', 'claude'] }]), 'claude'), 'supervisor');
});

test('manual:review-followups-triaged GY-1213.3: a refusal names the process that was inspected, not an argv-less first entry (Finding 2)', async () => {
  const pane = listedPane([{ pid: 5200, name: 'zombie' }, { pid: 5201, name: 'vim', argv: ['vim', 'notes.txt'] }]);
  assert.deepEqual(await paneForeground('w1V:pC1', pane, 'claude'), { other: 'vim' });
  const unnamed = listedPane([{ pid: 5200 }, { pid: 5201, argv: ['/usr/bin/htop'] }]);
  assert.deepEqual(await paneForeground('w1V:pC1', unnamed, 'claude'), { other: 'htop' });
});
