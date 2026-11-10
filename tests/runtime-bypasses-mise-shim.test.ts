import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { startAgentSession } from '../src/master/launch.js';
import { spawnHeadless, startHeadlessSession } from '../src/headless-session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3236: the runtime's command on PATH is a mise shim that fails in the launch environment
// (Huck's cursor reviewers died on it). Worker and reviewer launches run the installed binary.
test('e2e:runtime-bypasses-mise-shim — worker and reviewer launches run the real binary behind a failing mise shim and start', async () => {
  const base = await temporaryDirectory('runtime-bypasses-mise-shim');
  const data = join(base, 'mise'), shims = join(data, 'shims'), installed = join(data, 'installs', 'cursor-agent', '2026.1.0', 'bin');
  const directory = join(base, 'worktree'), root = join(base, 'coordinator');
  for (const path of [shims, installed, directory, root]) await mkdir(path, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  for (const program of ['agent', 'cursor-agent']) {
    await writeFile(join(shims, program), `#!/bin/sh\necho "mise ERROR No version is set for shim: ${program}" >&2\nexit 1\n`, { mode: 0o755 });
    await writeFile(join(installed, program), `#!/bin/sh\necho "Cursor Agent"\nprintf '{"binary":"%s"}\\n' "$0"\n`, { mode: 0o755 });
  }
  const environment = { PATH: `${shims}:/usr/bin:/bin`, MISE_NO_CONFIG: '1', MISE_DATA_DIR: data };
  assert.equal(execFileSync('/bin/sh', ['-c', 'command -v agent'], { encoding: 'utf8', env: environment }).trim(), join(shims, 'agent'), 'the shim is what PATH selects');

  for (const role of ['worker', 'reviewer']) {
    // The pane's shell runs the typed line in the launch environment; Herdr reports what it ran.
    let screen = '', real = false;
    const run = (_command: string, args: string[]) => {
      const json = (result: unknown) => JSON.stringify({ result });
      if (args[0] === 'pane' && args[1] === 'run') {
        let printed: string;
        try { printed = execFileSync('/bin/sh', ['-c', args[3]!], { encoding: 'utf8', cwd: directory, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (error) { printed = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`; }
        real = printed.includes(`"binary":"${join(installed, 'agent')}"`);
        screen = `$ ${args[3]}\n${printed}`;
        return '';
      }
      if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: 'cursor', agent_status: real ? 'idle' : 'unknown' } });
      if (args[0] === 'agent' && args[1] === 'rename') return json({});
      if (args[0] === 'pane' && args[1] === 'read') return real ? 'Cursor Agent\n> ' : screen;
      if (args[0] === 'pane' && args[1] === 'process-info') return json({ process_info: { shell_pid: 100, foreground_process_group_id: real ? 200 : 100,
        foreground_processes: real ? [{ argv: [join(installed, 'agent')] }] : [] } });
      throw new Error(`unexpected herdr call ${args.join(' ')}`);
    };
    let now = 0;
    const started = await startAgentSession(`${role}-cursor`, 'cursor', 'w1:p1', ['--force', '--trust'], `Run as the ${role} for GY-3236`, run, {
      directory, role: `You are the ${role}.`, environment, confinement: false, log: () => {},
      timeoutMs: 2000, ceilingMs: 4000, pollMs: 100, clock: () => now, wait: ms => { now += ms; },
    });
    assert.equal(started.started.state, 'started', `the ${role} launch started: ${screen}`);
    assert.ok(real, `the ${role} launch ran the installed binary, not the shim: ${screen}`);
  }

  // A headless reviewer run spawns the installed cursor-agent too.
  const review = await startHeadlessSession({
    name: 'reviewer-headless', work: 'GY-3236', subject: 'review', kind: 'cursor', args: [], environment,
    directory, root, route: 'review', context: {}, prompt: 'Report the executed binary.', exec: spawnHeadless,
    answer: async output => JSON.parse(output.split('\n').find(line => line.startsWith('{'))!).binary as string,
  });
  assert.equal(await review.settled, join(installed, 'cursor-agent'));
});
