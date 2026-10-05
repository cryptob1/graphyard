import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitRuntimeStart, observeStart, paneForeground } from '../src/master/launch.js';
import { workspaceCommands } from '../src/cli/workspace.js';
import type { CliContext } from '../src/cli/context.js';

const command = 'GY=/w/.graphyard/launch/graphyard-claude-1; graphyard watch GY-1023 4 -- claude "$(cat "$GY.request")"';
const echo = `vish@vishrog GY-1023-4 ❯ ${command}`;

test('manual:review-followups-triaged GY-1053.1: observeStart calls pane process-info at most once per observation when output is printed and command still running (Findings 1, 9, 13, 14, 15)', async () => {
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'read') return `${echo}\ngraphyard: establishing containment for GY-1023 epoch 4\n`;
    if (args[0] === 'pane' && args[1] === 'process-info') {
      return json({ process_info: { pane_id: args[3], shell_pid: 4100, foreground_process_group_id: 5200, foreground_processes: [] } });
    }
    if (args[0] === 'agent' && args[1] === 'get') throw Object.assign(new Error('agent_not_found'), { stderr: '{"error":{"code":"agent_not_found"}}' });
    return json({});
  };

  const observed = await observeStart('w1V:pC1', 'claude', command, run);
  assert.equal(observed.state, 'starting');
  assert.equal(observed.detail, 'the launch command is running, its supervisor setting up: "graphyard: establishing containment for GY-1023 epoch 4"');

  const processInfoCalls = calls.filter(args => args[0] === 'pane' && args[1] === 'process-info');
  assert.equal(processInfoCalls.length, 1, 'pane process-info must be called at most once per observeStart poll');
});

test('manual:review-followups-triaged GY-1053.2: when Herdr reports a different agent kind under the pane, observeStart returns absent naming the unexpected agent rather than starting (Finding 22)', async () => {
  const run = (_cmd: string, args: string[]) => {
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'read') return `${echo}\n`;
    if (args[0] === 'pane' && args[1] === 'process-info') {
      return json({ process_info: { pane_id: args[3], shell_pid: 4100, foreground_process_group_id: 5200, foreground_processes: [] } });
    }
    if (args[0] === 'agent' && args[1] === 'get') {
      return json({ agent: { pane_id: args[2], agent: 'aider', agent_status: 'working' } });
    }
    return json({});
  };

  const observed = await observeStart('w1V:pC1', 'claude', command, run);
  assert.equal(observed.state, 'absent');
  assert.equal(observed.detail, 'the pane holds aider, not claude');
});

// GY-1184: the GY-1053 triage is recorded on the item and its pull request, not as a literal table
// asserted against itself here. What follows are the follow-ups addressed in code.

/** A pane whose foreground group (5200, the shell being 4100) Herdr lists as these processes. */
function listedPane(screen: string, processes: { pid: number; name: string; argv: string[] }[]) {
  return (_cmd: string, args: string[]) => {
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'read') return screen;
    if (args[0] === 'pane' && args[1] === 'process-info') return json({ process_info: { pane_id: args[3], shell_pid: 4100, foreground_process_group_id: 5200, foreground_processes: processes } });
    if (args[0] === 'agent' && args[1] === 'get') throw Object.assign(new Error('agent_not_found'), { stderr: '{"error":{"code":"agent_not_found"}}' });
    return json({});
  };
}
const supervisorProcess = { pid: 5200, name: 'node', argv: ['/usr/bin/node', '/w/bin/graphyard.mjs', 'watch', 'GY-1023', '4', '--', 'claude', 'go'] };

test('manual:review-followups-triaged GY-1184.1: a foreground Herdr lists as an unrelated job is absent and refused at the bound, while the listed supervisor or runtime is starting (Findings 5, 8, 12)', async () => {
  const unrelated = listedPane(`${echo}\n`, [{ pid: 5200, name: 'vim', argv: ['vim', 'notes.txt'] }]);
  assert.deepEqual(await paneForeground('w1V:pC1', unrelated, 'claude'), { other: 'vim' });
  const absent = await observeStart('w1V:pC1', 'claude', command, unrelated);
  assert.equal(absent.state, 'absent');
  assert.equal(absent.detail, 'the pane\'s foreground is held by vim, not the launch command');
  let now = 0;
  await assert.rejects(awaitRuntimeStart('w1V:pC1', 'claude', command, unrelated, { timeoutMs: 60_000, ceilingMs: 120_000, pollMs: 5_000, clock: () => now, wait: ms => { now += ms; } }), (error: any) => error.startCase === 'never started' && error.waitedMs === 60_000);

  const supervising = listedPane(`${echo}\ngraphyard: establishing containment for GY-1023 epoch 4\n`, [supervisorProcess]);
  assert.equal(await paneForeground('w1V:pC1', supervising, 'claude'), 'supervisor');
  const setting = await observeStart('w1V:pC1', 'claude', command, supervising);
  assert.equal(setting.state, 'starting');
  assert.equal(setting.detail, 'the launch command is running, its supervisor setting up: "graphyard: establishing containment for GY-1023 epoch 4"');

  const runtime = listedPane(`${echo}\n`, [{ pid: 5200, name: 'claude', argv: ['/home/u/.local/bin/claude', '--print'] }]);
  const spawned = await observeStart('w1V:pC1', 'claude', command, runtime);
  assert.equal(spawned.state, 'starting');
  assert.equal(spawned.detail, 'the claude runtime holds the pane\'s foreground before Herdr reports it');

  // A group Herdr lists nothing for cannot be told apart, and stays the launch command (GY-1033).
  assert.equal(await paneForeground('w1V:pC1', listedPane(`${echo}\n`, []), 'claude'), 'command');
});

test('manual:review-followups-triaged GY-1184.2: watch refuses a malformed epoch with its usage line before printing the setup line, never "epoch NaN" (Findings 3, 7, 11)', async () => {
  const watch = workspaceCommands.find(entry => entry.name === 'watch')!;
  for (const epoch of ['x', '', '0', '-1', '1.5']) {
    const printed: string[] = [], called: string[] = [];
    const context = {
      command: 'watch', id: 'GY-1023', args: [epoch, '--', 'claude', 'go'], rest: [], base: 'http://127.0.0.1:1', connection: null,
      api: async (path: string) => { called.push(path); throw new Error('control plane unavailable'); }, print: () => {},
      individualToken: async () => '', individualHostId: () => 'vishrog', activeCliPath: async () => '', repositoryRoot: () => process.cwd(),
    } as unknown as CliContext;
    const original = console.error;
    console.error = (...values: unknown[]) => { printed.push(values.join(' ')); };
    try { await assert.rejects(watch.run(context, undefined), /^Error: Usage: watch GY-N EPOCH -- command args$/); }
    finally { console.error = original; }
    assert.deepEqual(printed, [], `epoch ${JSON.stringify(epoch)} prints nothing before its usage error`);
    assert.deepEqual(called, [], `epoch ${JSON.stringify(epoch)} makes no control-plane call`);
  }
});
