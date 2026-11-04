import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ChildRun } from '../../src/child-runner.js';

// A real interactive shell and PTY. Only Herdr's transport is substituted; screen,
// foreground group and argv come from the actual launched processes.
const terminal = String.raw`
import json, os, pty, select, signal, sys
pid, master = pty.fork()
if pid == 0:
    os.execv('/bin/bash', ['bash', '--noprofile', '--rcfile', sys.argv[1], '-i'])
def stop(*args):
    try:
        os.killpg(os.tcgetpgrp(master), signal.SIGKILL)
    except OSError:
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
while True:
    ready, _, _ = select.select([master, sys.stdin], [], [], 0.05)
    if sys.stdin in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if not data:
            stop()
        os.write(master, data)
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            stop()
        if not data:
            stop()
        os.write(sys.stdout.fileno(), data)
    try:
        group = os.tcgetpgrp(master)
        processes = []
        for entry in os.listdir('/proc'):
            if not entry.isdigit():
                continue
            try:
                if os.getpgid(int(entry)) == group:
                    argv = open('/proc/' + entry + '/cmdline', 'rb').read().decode().strip('\0').split('\0')
                    processes.append({'argv': argv})
            except (OSError, UnicodeError):
                pass
        print(json.dumps({'shell_pid': pid, 'foreground_process_group_id': group, 'foreground_processes': processes}), file=sys.stderr, flush=True)
    except OSError:
        stop()
`;

export async function runtimeLaunchTerminal(cwd: string, rc: string, environment: NodeJS.ProcessEnv) {
  const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', terminal, rc], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  let screen = '', pending = '', foreground: unknown = null;
  child.stdout.on('data', data => { screen += data; });
  child.stderr.on('data', data => {
    pending += data;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try { foreground = JSON.parse(line); } catch { screen += line; }
    }
  });
  const until = async (predicate: () => boolean, label: string, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`${label}: ${screen}`);
      await sleep(25);
    }
  };
  await until(() => screen.includes('GY-PTY>'), 'interactive shell startup');
  const calls: string[][] = [];
  const run: ChildRun = async (_command, args) => {
    calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'run') { child.stdin.write(args[3] + '\n'); return ''; }
    if (args[0] === 'pane' && args[1] === 'read') return screen.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    if (args[0] === 'pane' && args[1] === 'process-info') return json({ process_info: foreground });
    // Deliberately reproduce the incident: the shell already carries an agent name.
    if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: 'codex', agent_status: 'idle' } });
    if (args[0] === 'agent' && args[1] === 'rename') return json({});
    throw new Error(`Unexpected transport call ${args.join(' ')}`);
  };
  return { run, calls, until, screen: () => screen, close: async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill('SIGTERM'); });
  } };
}
