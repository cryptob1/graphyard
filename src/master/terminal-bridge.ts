// Concern: the host side of the Master page's terminal on a compose install (GY-3241) — the loop, which runs beside Herdr, streams panes for a server that cannot.
import { terminalStream, type SessionReader, type TerminalStream } from './terminal-session.js';
/**
 * Keeps one WebSocket open to the control plane's /api/terminal-host with the loop's coordinator
 * credential, reconnecting until SIGNAL aborts (CONNECTED is told of each connection). For each `open` the server sends, it runs the herdr
 * terminal stream here and relays its lines back; `command` writes to that stream and `close` ends it.
 *
 * The stream is a long-lived interactive child, not a run-to-completion call, so it cannot go
 * through src/child-runner.ts; like the loop's own restart in loop-restart.ts it takes `spawn`
 * by dynamic import, and nothing in src/master/ imports node:child_process.
 */
export async function bridgeTerminals(url: string, token: string, signal: AbortSignal, connected: () => void = () => {}, session?: SessionReader) {
  const connect = () => {
    if (signal.aborted) return;
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/api/terminal-host`, ['graphyard', token]);
    const streams = new Map<string, TerminalStream>();
    const send = (value: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    socket.onmessage = event => {
      let message: any; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'open') streams.set(String(message.id), terminalStream(message, { line: line => send({ id: message.id, line }), exit: reason => { streams.get(String(message.id))?.end(); streams.delete(String(message.id)); send({ id: message.id, exit: reason }); } }, session));
      const child = streams.get(String(message.id));
      if (message.type === 'command' && child) child.send(message.command);
      if (message.type === 'close' && child) { child.end(); streams.delete(String(message.id)); }
    };
    socket.onopen = connected;
    socket.onerror = () => {};
    const abort = () => socket.close();
    socket.onclose = () => {
      signal.removeEventListener('abort', abort);
      for (const child of streams.values()) child.end();
      if (!signal.aborted) setTimeout(connect, 1_000).unref();
    };
    signal.addEventListener('abort', abort, { once: true });
  };
  connect();
}
