// Concern: the host side of the Master page's terminal on a compose install (GY-3241) — the loop, which runs beside Herdr, streams panes for a server that cannot.
import { createInterface } from 'node:readline';
import { herdrInvocation, herdrTarget, herdrTerminalArgs } from './herdr.js';

/**
 * Keeps one WebSocket open to the control plane's /api/terminal-host with the loop's coordinator
 * credential, reconnecting until SIGNAL aborts (CONNECTED is told of each connection). For each `open` the server sends, it runs the herdr
 * terminal stream here and relays its lines back; `command` writes to that stream and `close` ends it.
 *
 * The stream is a long-lived interactive child, not a run-to-completion call, so it cannot go
 * through src/child-runner.ts; like the loop's own restart in loop-restart.ts it takes `spawn`
 * by dynamic import, and nothing in src/master/ imports node:child_process.
 */
export async function bridgeTerminals(url: string, token: string, signal: AbortSignal, connected: () => void = () => {}) {
  const { spawn } = await import('node:child_process');
  const connect = () => {
    if (signal.aborted) return;
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/api/terminal-host`, ['graphyard', token]);
    const streams = new Map<string, ReturnType<typeof spawn>>();
    const send = (value: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    const open = (id: string, request: { control: boolean; pane: string; cols: string; rows: string }) => {
      const call = herdrInvocation(herdrTerminalArgs(request.control, request.pane, request.cols, request.rows), herdrTarget());
      const child = spawn(call.command, call.args, { env: call.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      const ended = (reason: string) => { if (streams.delete(id)) send({ id, exit: reason }); };
      streams.set(id, child);
      child.stderr!.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-300); });
      child.on('error', error => ended(error.message)).on('exit', code => ended(stderr.trim() || `herdr exited with code ${code}`));
      createInterface({ input: child.stdout! }).on('line', line => send({ id, line }));
    };
    socket.onmessage = event => {
      let message: any; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'open') open(String(message.id), message);
      const child = streams.get(String(message.id));
      if (message.type === 'command' && child?.stdin?.writable) child.stdin.write(`${JSON.stringify(message.command)}\n`);
      if (message.type === 'close' && child) { child.stdin?.end(); setTimeout(() => child.kill(), 1_000).unref(); streams.delete(String(message.id)); }
    };
    socket.onopen = connected;
    socket.onerror = () => {};
    socket.onclose = () => {
      for (const child of streams.values()) child.kill();
      if (!signal.aborted) setTimeout(connect, 5_000).unref();
    };
    signal.addEventListener('abort', () => socket.close(), { once: true });
  };
  connect();
}
