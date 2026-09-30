import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { awaitRuntimeStart, launchCommand, launchProgram, outputAfterCommand, SessionStartError, startAgentSession, writeLaunchFiles } from '../src/master/launch.js';
import { accountLaunch, registryLaunchArgs } from '../src/master/environments.js';
import { knownRuntimes } from '../src/install/runtimes.js';
import { connectProvider } from '../src/fleet.js';
import { proposedRuntimes } from '../src/model/registry-proposal.js';
import type { FleetLaunchAccount } from '../src/fleet.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// From Cursor CLI 2026.09.23, `cursor` is only the IDE's launcher and `cursor-agent` run
// interactively prints "Error: No Cursor IDE installation found. Use 'cursor agent' or 'agent' to
// run the agent." and exits; every Cursor launch then waited out the 120 s start ceiling (GY-976).

test('unit:cursor-launch-uses-agent — a cursor profile launches, logs in and smoke-tests through `agent`, with CURSOR_CONFIG_DIR and the model flag unchanged', async () => {
  assert.equal(launchProgram('cursor'), 'agent');
  assert.equal(launchProgram('claude'), 'claude', 'every other runtime still starts under its own name');

  // A local profile on a Cursor account home: the home on CURSOR_CONFIG_DIR, the operator's model
  // flag kept, the no-approval recipe added, and the typed command starting `agent`.
  const launch = accountLaunch({ kind: 'cursor', approvals: 'auto', agentArgs: ['--model', 'gpt-5.4'], environment: {} }, { name: 'cursor-a', kind: 'cursor', home: '/home/operator/.graphyard/environments/cursor-a' });
  assert.equal(launch.kind, 'cursor');
  assert.equal(launch.environment.CURSOR_CONFIG_DIR, '/home/operator/.graphyard/environments/cursor-a');
  assert.deepEqual(launch.args, ['--force', '--trust', '--model', 'gpt-5.4']);
  const directory = await temporaryDirectory('cursor-launch');
  try {
    const files = writeLaunchFiles(directory, 'graphyard-cursor-1', { request: 'Implement GY-976' });
    assert.equal(launchCommand('cursor', launch.args, files), `GY=${files.stem}; agent --force --trust --model gpt-5.4 "$(cat "$GY.request")"`);

    // A registry Cursor account: the registry contract's home variable and model flag, unchanged.
    const contract = proposedRuntimes.find(runtime => runtime.name === 'cursor')!.launch;
    assert.equal(contract.homeVariable, 'CURSOR_CONFIG_DIR');
    assert.equal(contract.modelFlag, '--model');
    assert.equal(contract.login, 'CURSOR_CONFIG_DIR={home} agent login');
    const args = registryLaunchArgs({ fleet: { contract, policy: null, modelId: 'claude-sonnet-5' } } as unknown as FleetLaunchAccount);
    assert.equal(launchCommand('cursor', args, files), `GY=${files.stem}; agent --model claude-sonnet-5 "$(cat "$GY.request")"`);
  } finally { await rm(directory, { recursive: true, force: true }); }

  // Detection, the connect card's login and its smoke prompt all run `agent` too.
  assert.equal(knownRuntimes.find(runtime => runtime.kind === 'cursor')!.program, 'agent');
  const card = connectProvider('cursor')!;
  assert.equal(card.login!.command, 'agent');
  assert.equal(card.login!.envVariable, 'CURSOR_CONFIG_DIR');
  assert.deepEqual([card.smoke.command, card.smoke.args[0], card.smoke.envVariable], ['agent', '-p', 'CURSOR_CONFIG_DIR']);
});

/** The pane after `cursor-agent` refused to run and handed the terminal back, as Herdr read it on 2026-09-30. */
const command = 'GY=/w/.graphyard/launch/graphyard-cursor-1; cursor-agent --force --trust "$(cat "$GY.request")"';
const exitedScreen = [
  'vish@vishrog GY-976-1 ❯ previous output',
  `vish@vishrog GY-976-1 ❯ ${command}`,
  "Error: No Cursor IDE installation found. Use 'cursor agent' or 'agent' to run the agent.",
  'Or, install Cursor at https://cursor.com/download',
  'vish@vishrog GY-976-1 ❯',
].join('\n');

/** A Herdr pane on a virtual clock: `screen` read back, no agent under it, and `foreground` as the pane's foreground process group. */
function pane(screen: string, foreground: number | null) {
  let now = Date.parse('2026-09-30T15:00:00.000Z');
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'read') return screen;
    if (args[0] === 'pane' && args[1] === 'process-info') return foreground === null ? json({}) : json({ process_info: { pane_id: args[3], shell_pid: 4100, foreground_process_group_id: foreground, foreground_processes: [] } });
    if (args[0] === 'agent' && args[1] === 'get') throw Object.assign(new Error('agent_not_found'), { stderr: '{"error":{"code":"agent_not_found"}}' });
    return json({});
  };
  return { run, calls, bounds: { clock: () => now, wait: (ms: number) => { now += ms; } } };
}

test('unit:runtime-exit-at-start-fails-fast — a runtime that exits back to the shell before it is ready fails the launch at once with the lines it printed', async () => {
  assert.deepEqual(outputAfterCommand(exitedScreen, command), ["Error: No Cursor IDE installation found. Use 'cursor agent' or 'agent' to run the agent.", 'Or, install Cursor at https://cursor.com/download'], 'the new prompt is not the runtime\'s output');
  assert.equal(outputAfterCommand(`vish@vishrog GY-976-1 ❯ ${command}`, command), null, 'nothing printed below the command yet');
  assert.equal(outputAfterCommand('vish@vishrog GY-976-1 ❯', command), null, 'the command is not on screen');

  // The shell holds the foreground (group = shell pid 4100): refused on the first poll, with the
  // runtime's own words, not after the 60 s bound or the 120 s ceiling.
  const exited = pane(exitedScreen, 4100);
  const error = await awaitRuntimeStart('w1V:pC1', 'cursor', command, exited.run, exited.bounds).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof SessionStartError, String(error));
  assert.equal(error.startCase, 'exited');
  assert.equal(error.waitedMs, 0);
  assert.match(error.message, /^the cursor runtime exited back to the shell in pane w1V:pC1 before it was ready; it last printed: "Error: No Cursor IDE installation found\. .* \| Or, install Cursor at https:\/\/cursor\.com\/download"$/);
  assert.match(error.screen, /No Cursor IDE installation found/);

  // Through the launcher itself: the failed start is logged at once, naming the case.
  const directory = await temporaryDirectory('cursor-exit');
  try {
    const launched = pane('', 4100), lines: string[] = [];
    let typed = '';
    const run = (bin: string, args: string[]) => {
      if (args[0] === 'pane' && args[1] === 'run') { typed = args[3]; return '{}'; }
      if (args[0] === 'pane' && args[1] === 'read') return exitedScreen.replace(command, typed);
      return launched.run(bin, args);
    };
    await assert.rejects(startAgentSession('graphyard-cursor-1', 'cursor', 'w1V:pC1', ['--force', '--trust'], 'Implement GY-976', run, { directory, confinement: false, ...launched.bounds, log: line => lines.push(line) }),
      (caught: unknown) => caught instanceof SessionStartError && caught.startCase === 'exited' && caught.waitedMs === 0);
    assert.match(typed, /; agent --force --trust /);
    assert.deepEqual(lines, ['graphyard: graphyard-cursor-1 (cursor) in pane w1V:pC1: start failed after 0.0 s (exited; bound 60 s)']);
  } finally { await rm(directory, { recursive: true, force: true }); }

  // A runtime still running in the foreground, printing below its command, is not an exit, nor is
  // a pane whose process information Herdr cannot give: both are left to the start bound as before
  // (the Cursor refusal names "Cursor", which reads as its banner, so the bound is the ceiling —
  // the 120 s every Cursor launch waited out before this).
  for (const foreground of [5200, null]) {
    const running = pane(exitedScreen, foreground);
    await assert.rejects(awaitRuntimeStart('w1V:pC1', 'cursor', command, running.run, { ...running.bounds, timeoutMs: 5_000, ceilingMs: 8_000 }),
      (caught: unknown) => caught instanceof SessionStartError && caught.startCase === 'still starting' && caught.waitedMs >= 8_000, String(foreground));
  }
});
