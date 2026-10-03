import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitRuntimeStart, observeStart, SessionStartError } from '../src/master.js';
import { paneForeground } from '../src/master/launch.js';
import { setupLine } from '../src/supervisor.js';
import { workspaceCommands } from '../src/cli/workspace.js';
import type { CliContext } from '../src/cli/context.js';

/** The worker launch command, as the launcher types it into the pane. */
const command = 'GY=/w/.graphyard/launch/graphyard-claude-1; graphyard watch GY-1023 4 -- claude "$(cat "$GY.request")"';
const echo = `vish@vishrog GY-1023-4 ❯ ${command}`;

/**
 * A Herdr pane on a virtual clock: `screen(elapsed)` is read back, `foreground(elapsed)` is the
 * pane's foreground process group (4100 is the pane's shell), and `agent(elapsed)` the runtime Herdr
 * reports working under it, if any.
 */
function supervisorPane(screen: (elapsedMs: number) => string, foreground: (elapsedMs: number) => number | null, agent: (elapsedMs: number) => string | null = () => null) {
  const start = Date.parse('2026-10-01T03:00:00.000Z');
  let now = start;
  const run = (_command: string, args: string[]) => {
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'read') return screen(now - start);
    if (args[0] === 'pane' && args[1] === 'process-info') {
      const group = foreground(now - start);
      return group === null ? json({}) : json({ process_info: { pane_id: args[3], shell_pid: 4100, foreground_process_group_id: group, foreground_processes: [] } });
    }
    const kind = agent(now - start);
    if (args[0] === 'agent' && args[1] === 'get' && kind) return json({ agent: { pane_id: args[2], agent: kind, agent_status: 'working' } });
    if (args[0] === 'agent' && args[1] === 'get') throw Object.assign(new Error('agent_not_found'), { stderr: '{"error":{"code":"agent_not_found"}}' });
    return json({});
  };
  return { run, elapsed: () => now - start, bounds: { clock: () => now, wait: (ms: number) => { now += ms; } } };
}

/**
 * The lines `graphyard watch GY-N EPOCH -- …` prints, in order with its control-plane calls. Every
 * call is refused, so the command stops at the first one: whatever it printed came before it.
 */
async function printedSetupLine(subject: string, epoch: number) {
  const printed: string[] = [], events: string[] = [];
  const watch = workspaceCommands.find(command => command.name === 'watch')!;
  const refuse = async (what: string) => { events.push(`${what} after ${printed.length} line(s)`); throw new Error('control plane unavailable'); };
  const context = {
    command: 'watch', id: subject, args: [String(epoch), '--', 'claude', 'go'], rest: [], base: 'http://127.0.0.1:1', connection: null,
    api: (path: string) => refuse(`api ${path}`), print: () => {}, individualToken: () => refuse('token'),
    individualHostId: () => 'vishrog', activeCliPath: () => refuse('cli'), repositoryRoot: () => process.cwd(),
  } as CliContext;
  const original = console.error;
  console.error = (...values: unknown[]) => { printed.push(values.join(' ')); events.push(`printed ${values.join(' ')}`); };
  try { await assert.rejects(watch.run(context, undefined), /control plane unavailable/); }
  finally { console.error = original; }
  return { printed, events };
}

test('unit:launch-supervisor-setup-is-starting — a launch whose supervisor is still setting up is starting, extended to the ceiling, and quotes the supervisor\'s setup line; a shell back in the foreground with nothing printed is absent', async () => {
  // AC-2: the supervisor prints one line naming the item and epoch, before its first control-plane call.
  // The line comes from argv, ahead of the item lookup, the status read and every heartbeat.
  const { printed, events } = await printedSetupLine('GY-1023', 4);
  assert.deepEqual(printed, ['graphyard: establishing containment for GY-1023 epoch 4']);
  assert.equal(printed[0], setupLine('GY-1023', 4));
  assert.deepEqual(events, ['printed graphyard: establishing containment for GY-1023 epoch 4', 'api work after 1 line(s)'], 'the line is printed before the first control-plane call');

  // AC-1: the pane's last line is the launch command and the shell is not the foreground group:
  // the launch command is running, so the start is `starting`, never `absent`.
  const setup = supervisorPane(() => `${echo}\n`, () => 5200);
  assert.equal(await paneForeground('w1V:pC1', setup.run), 'command');
  const running = await observeStart('w1V:pC1', 'claude', command, setup.run);
  assert.equal(running.state, 'starting');
  assert.equal(running.detail, 'the launch command is running, its supervisor still setting up');
  assert.equal(running.line, echo);

  // AC-2: once the supervisor has printed its line, the observation names it as the starting detail.
  const announced = supervisorPane(() => `${echo}\n${printed[0]}\n`, () => 5200);
  const said = await observeStart('w1V:pC1', 'claude', command, announced.run);
  assert.equal(said.state, 'starting');
  assert.equal(said.detail, 'the launch command is running, its supervisor setting up: "graphyard: establishing containment for GY-1023 epoch 4"');

  // The shell is back in the foreground with nothing printed: the command never ran, so it is absent.
  const idle = supervisorPane(() => `${echo}\n`, () => 4100);
  assert.equal(await paneForeground('w1V:pC1', idle.run), 'shell');
  const absent = await observeStart('w1V:pC1', 'claude', command, idle.run);
  assert.equal(absent.state, 'absent'); assert.equal(absent.detail, 'command still echoing');
  // Herdr cannot describe the pane's foreground: nothing proves the command is running, so absent as before.
  assert.equal((await observeStart('w1V:pC1', 'claude', command, supervisorPane(() => `${echo}\n`, () => null).run)).state, 'absent');

  // awaitRuntimeStart: a supervisor in setup for 90 s (a slow control plane) is extended past the
  // 60 s bound to the 120 s ceiling, and the runtime is adopted when it comes up.
  const slow = supervisorPane(elapsed => elapsed < 90_000 ? `${echo}\n${printed[0]}\n` : `${echo}\n${printed[0]}\n ▐▛███▛█   Claude Code v2.1.278\n∙ Crunching… (esc to interrupt)\n`, () => 5200, elapsed => elapsed < 90_000 ? null : 'claude');
  const started = await awaitRuntimeStart('w1V:pC1', 'claude', command, slow.run, slow.bounds);
  assert.ok(started.waitedMs >= 90_000 && started.waitedMs < 91_000, `started after ${started.waitedMs} ms`);
  assert.equal(started.extended, 'the launch command is running, its supervisor setting up: "graphyard: establishing containment for GY-1023 epoch 4" at 60 s; waiting up to 120 s');

  // A supervisor that never finishes setting up is refused at the ceiling as still starting, with its line.
  const stuck = supervisorPane(() => `${echo}\n${printed[0]}\n`, () => 5200);
  const ceiling = await awaitRuntimeStart('w1V:pC1', 'claude', command, stuck.run, stuck.bounds).then(() => null, (error: unknown) => error);
  assert.ok(ceiling instanceof SessionStartError, String(ceiling));
  assert.equal(ceiling.startCase, 'still starting');
  assert.ok(stuck.elapsed() >= 120_000 && stuck.elapsed() < 121_000, `refused at ${stuck.elapsed()} ms`);
  assert.match(ceiling.message, /^the claude runtime was still starting after 120 s in pane w1V:pC1 \(the launch command is running, its supervisor setting up: "graphyard: establishing containment for GY-1023 epoch 4"\)/);

  // The shell in the foreground with only the command on screen fails at the 60 s bound, not the ceiling.
  const never = supervisorPane(() => `${echo}\n`, () => 4100);
  const refusal = await awaitRuntimeStart('w1V:pC1', 'claude', command, never.run, never.bounds).then(() => null, (error: unknown) => error);
  assert.ok(refusal instanceof SessionStartError, String(refusal));
  assert.equal(refusal.startCase, 'never started');
  assert.ok(never.elapsed() >= 60_000 && never.elapsed() < 61_000, `refused at ${never.elapsed()} ms`);
  assert.match(refusal.message, /never started within 60 s in pane w1V:pC1 \(command still echoing\)/);
});
