// Host-owned terminal lifecycle, shared by the local server and the compose bridge.
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { runChild, ChildProcessError } from '../child-runner.js';
import { daemonStatePath, masterSessionSchema, masterSessionState } from '../daemon/state.js';
import type { MasterConfig } from './profiles.js';
import { herdrCall, herdrInvocation, herdrTarget, herdrTerminalArgs, observeHerdrAgents } from './herdr.js';
import { readSessionScreenOrError } from './prompt-delivery.js';

export interface TerminalSession { account: string | null; runtime: string | null; pane: string | null; state: string }
export type SessionReader = () => Promise<TerminalSession>;
export const terminalSessionReader = (config: () => MasterConfig): SessionReader => async () => {
  const master = masterSessionSchema.parse(JSON.parse(await readFile(daemonStatePath(config()), 'utf8')).master ?? {});
  const runtime = master.agentName ? await observeHerdrAgents(undefined, null) : null;
  const agent = runtime?.agents.find(agent => agent.name === master.agentName || agent.pane_id === master.pane);
  const screen = master.agentName ? (await readSessionScreenOrError(agent?.pane_id ?? master.agentName)).screen : undefined;
  return { account: master.account, runtime: master.runtime, pane: master.pane, state: masterSessionState(master, Date.now(), agent, screen) };
};
export interface TerminalRequest { control: boolean; pane: string | null; master?: boolean; cols: string; rows: string }
export interface TerminalHandlers { line(line: string): void; exit(reason: string): void }
export interface TerminalStream { send(command: unknown): void; end(): void }

export function terminalStream(request: TerminalRequest, handlers: TerminalHandlers, session?: SessionReader, instance = herdrTarget()): TerminalStream {
  let child: import('node:child_process').ChildProcess | undefined;
  let stopped = false, previous = '', pane: string | null | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const abort = new AbortController();
  const emit = (value: unknown) => { if (!stopped) handlers.line(JSON.stringify(value)); };
  const detach = () => { const old = child; child = undefined; old?.stdin?.end(); if (old) setTimeout(() => old.kill(), 1_000).unref(); };
  const refresh = async () => {
    try {
      const current = request.master && session ? await session() : { pane: request.pane, account: null, runtime: null, state: request.pane ? 'unknown' : 'absent' };
      if (stopped) return;
      const serialized = JSON.stringify(current);
      if (serialized !== previous) { emit({ type: previous ? 'session' : 'hello', session: current, pane: current.pane, mode: request.control ? 'control' : 'observe' }); previous = serialized; }
      if (pane !== current.pane) {
        detach(); pane = current.pane;
        if (pane) {
          // Reattach replaces the browser buffer with this bounded history. Herdr's first live
          // frame redraws the screen; it does not append a second history snapshot.
          const history = await herdrCall(runChild, ['pane', 'read', pane, '--source', 'recent', '--lines', '1000', '--ansi'], { signal: abort.signal, timeoutMs: 5_000 }, instance);
          if (stopped) return;
          emit({ type: 'scrollback', data: history });
          const { spawn } = await import('node:child_process');
          if (stopped) return;
          const call = herdrInvocation(herdrTerminalArgs(request.control, pane, request.cols, request.rows), instance);
          const opened = child = spawn(call.command, call.args, { env: call.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
          let stderr = '';
          opened.stderr!.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-300); });
          opened.on('error', error => { if (child === opened && !stopped) handlers.exit(error.message); });
          opened.on('exit', code => { if (child === opened && !stopped) handlers.exit(stderr.trim() || `herdr exited with code ${code}`); });
          createInterface({ input: opened.stdout! }).on('line', line => { if (child === opened && !stopped) handlers.line(line); });
        }
      }
    } catch (error) { if (!stopped) handlers.exit(error instanceof ChildProcessError && (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'herdr is not installed where the server runs, and no host supervisor is connected to stream it' : error instanceof Error ? error.message : String(error)); }
    if (!stopped && request.master) timer = setTimeout(refresh, 1_000);
  };
  void refresh();
  return {
    send: (command: any) => {
      if (command.type === 'terminal.resize') { request.cols = String(command.cols); request.rows = String(command.rows); }
      if (child?.stdin?.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    end: () => { stopped = true; clearTimeout(timer); abort.abort(); detach(); },
  };
}
