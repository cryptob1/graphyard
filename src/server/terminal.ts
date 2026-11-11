// Concern: the live terminal the dashboard's Master page and Workers page show (GY-3211) — a WebSocket bridged to Herdr's terminal session stream.
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Principal } from '../model.js';
import { loopPanesRegistry } from '../model/loop-presence.js';
import { herdrTarget } from '../master/herdr.js';
import { terminalStream, terminalSessionReader, type TerminalRequest } from '../master/terminal-session.js';
import { loadMasterConfig } from '../master/config.js';
import { authenticate } from './auth.js';
import { canTypeIntoMasterPane } from './principals.js';
import type { Services } from './routes.js';

/** The history event each line a human types into the master's pane is recorded as. */
export const terminalInputEvent = 'master.terminal.input';

const refuse = (socket: Duplex, status: number, text: string) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
/** One unfragmented server frame: text (1), binary (2), close (8) or pong (10). */
const frame = (opcode: number, payload: Buffer = Buffer.alloc(0)) => {
  const length = payload.length, head = length < 126 ? Buffer.from([0x80 | opcode, length]) : length < 65_536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length)); return size; })()]);
  return Buffer.concat([head, payload]);
};

const text = (value: unknown) => frame(1, Buffer.from(JSON.stringify(value)));
/** Completes the WebSocket handshake on SOCKET, echoing the subprotocol the client offered first. */
const accept = (req: IncomingMessage, socket: Duplex, protocol: string) => socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
  `Sec-WebSocket-Accept: ${createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')}`,
  ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n'));
/** Calls ON for each client frame (masked, as a browser sends them) arriving on SOCKET. */
const readFrames = (socket: Duplex, on: (opcode: number, payload: Buffer) => void) => {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      const opcode = pending[0]! & 15; let length = pending[1]! & 127, offset = 2;
      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); offset = 10; }
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4), payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length)).map((byte, index) => byte ^ mask[index % 4]!);
      pending = pending.subarray(offset + 4 + length);
      on(opcode, Buffer.from(payload));
    }
  });
};

/** A herdr terminal stream, wherever it runs: a command goes in as a JSON line, lines come out through the handlers. */
interface Stream { send(command: unknown): void; end(): void }
interface Handlers { line(line: string): void; exit(reason: string): void }
type StreamRequest = TerminalRequest;

/**
 * On a compose install the server container has no herdr: the loop, running on the host beside
 * Herdr, connects to /api/terminal-host (GY-3241) and runs each stream for the server. One host at a time.
 */
let host: { socket: Duplex; streams: Map<string, Handlers> } | null = null;
const hostUpgrade = async (services: Services, req: IncomingMessage, socket: Duplex) => {
  const [protocol, token = ''] = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(part => part.trim());
  let actor: Principal;
  try { actor = await authenticate(services, `Bearer ${token}`, services.repository); } catch { return refuse(socket, 401, 'Unauthorized'); }
  if (actor.role !== 'coordinator') return refuse(socket, 403, 'Forbidden');
  accept(req, socket, protocol);
  const mine = { socket, streams: new Map<string, Handlers>() };
  host?.socket.destroy(); host = mine;
  const gone = () => { if (host === mine) host = null; for (const [id, handlers] of mine.streams) { mine.streams.delete(id); handlers.exit('the host supervisor disconnected'); } };
  readFrames(socket, (opcode, payload) => {
    if (opcode === 8) return void socket.end(frame(8));
    if (opcode === 9) socket.write(frame(10, payload));
    if (opcode !== 1) return;
    let message: any; try { message = JSON.parse(payload.toString('utf8')); } catch { return; }
    const handlers = mine.streams.get(String(message.id));
    if (typeof message.line === 'string') handlers?.line(message.line);
    if (typeof message.exit === 'string') { mine.streams.delete(String(message.id)); handlers?.exit(message.exit); }
  });
  socket.on('close', gone).on('error', gone);
};

const bridgedStream = (bridge: NonNullable<typeof host>, request: StreamRequest, handlers: Handlers): Stream => {
  const id = randomUUID();
  bridge.streams.set(id, handlers);
  const send = (value: object) => { if (bridge.socket.writable) bridge.socket.write(text({ id, ...value })); };
  send({ type: 'open', ...request });
  return { send: command => send({ type: 'command', command }), end: () => { send({ type: 'close' }); bridge.streams.delete(id); } };
};

/**
 * `GET /api/terminal?pane=PANE&cols=C&rows=R` upgraded to a WebSocket. A browser cannot set an
 * Authorization header on a WebSocket, so the dashboard's token rides as the second subprotocol
 * (`graphyard, TOKEN`); a request without a valid one is refused before the upgrade. The pane is
 * the master's, as the loop last named it, unless PANE names a running session an item records:
 * only panes Graphyard launched for this install are ever attached, never a host shell. A human
 * admin on the master's pane gets Herdr's writable `terminal session control` stream, every other
 * session its read-only `observe` stream. Frames go out as binary messages of ANSI bytes; the page
 * sends `{type:'input',data}` and `{type:'resize',cols,rows}`. Each typed line is recorded in
 * history under the human who typed it. Closing the page releases the stream; the pane runs on.
 * These are the streams Herdr documents for bridges: unlike `herdr terminal attach TERMINAL_ID`,
 * they take the pane ids Graphyard records and speak newline-delimited JSON over pipes, so the
 * server needs no PTY and no native module.
 */
export async function terminalUpgrade(services: Services, req: IncomingMessage, socket: Duplex) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/terminal-host') return hostUpgrade(services, req, socket);
  if (url.pathname !== '/api/terminal') return refuse(socket, 404, 'Not Found');
  const [protocol, token = ''] = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(part => part.trim());
  let actor: Principal;
  try { actor = await authenticate(services, `Bearer ${token}`, services.repository); } catch { return refuse(socket, 401, 'Unauthorized'); }
  const panes = loopPanesRegistry(services.engine).latest, master = panes?.master ?? null;
  const pane = url.searchParams.get('pane') || master;
  const followsMaster = !url.searchParams.get('pane');
  if (!followsMaster && pane !== master && !(await services.engine.store.pool.query('SELECT 1 FROM work_items WHERE document->\'sessions\' @> $1::jsonb LIMIT 1', [JSON.stringify([{ pane, state: 'running' }])])).rowCount) return refuse(socket, 404, 'Not Found');
  const control = (followsMaster || pane === master) && canTypeIntoMasterPane(actor);
  const size = (name: string, fallback: number) => String(Math.min(500, Math.max(10, Number(url.searchParams.get(name)) || fallback)));
  accept(req, socket, protocol);

  // The loop's host stream when one is connected (a compose install), else herdr where the server runs.
  const instance = panes?.configHome && panes.session ? { configHome: panes.configHome, session: panes.session } : herdrTarget();
  const [cols, rows] = [size('cols', 120), size('rows', 40)];
  let closed = false, framed = false;
  let activePane = pane, typed = '';
  const close = () => {
    if (closed) return; closed = true;
    if (control) herdr.send({ type: 'terminal.release' });
    herdr.end();
    if (socket.writable) socket.end(frame(8));
  };
  const handlers: Handlers = {
    line: line => {
      let record: any; try { record = JSON.parse(line); } catch { return; }
      if (['hello', 'session', 'scrollback'].includes(record.type)) {
        if (record.session) { if (activePane !== record.session.pane) typed = ''; activePane = record.session.pane; }
        socket.write(text(record));
      }
      if (record.type === 'terminal.frame' && typeof record.bytes === 'string') { framed = true; socket.write(frame(2, Buffer.from(record.bytes, 'base64'))); }
      if (record.type === 'terminal.closed') close();
    },
    // A stream that ends before showing anything is a refusal the page words with its cause, not a detach.
    exit: reason => { if (!framed && socket.writable) socket.write(text({ refused: reason })); close(); },
  };
  const request = { control, pane, cols, rows, master: followsMaster };
  const herdr = host ? bridgedStream(host, request, handlers) : terminalStream(request, handlers, async () => {
    const config = await loadMasterConfig(process.cwd()).catch(() => null);
    if (config) return terminalSessionReader(() => config)();
    const pane = loopPanesRegistry(services.engine).latest?.master ?? null;
    return { pane, account: null, runtime: null, state: pane ? 'unknown' : 'absent' };
  }, instance);
  const command = herdr.send;

  const record = (line: string) => services.engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, terminalInputEvent, JSON.stringify({ pane: activePane, line })]).catch(error => console.error(`[graphyard] terminal input not recorded: ${error}`));
  const message = (text: string) => {
    let input: any; try { input = JSON.parse(text); } catch { return; }
    if (!control || !activePane) return;
    if (input.type === 'resize') command({ type: 'terminal.resize', cols: Number(input.cols), rows: Number(input.rows) });
    if (input.type !== 'input' || typeof input.data !== 'string') return;
    command({ type: 'terminal.input', text: input.data });
    for (const char of input.data) {
      if (char === '\r' || char === '\n') { if (typed.trim()) void record(typed); typed = ''; }
      else if (char === '\x7f') typed = typed.slice(0, -1);
      else if (char >= ' ') typed += char;
    }
  };
  readFrames(socket, (opcode, payload) => {
    if (opcode === 8) return close();
    if (opcode === 9) socket.write(frame(10, payload));
    if (opcode === 1) message(payload.toString('utf8'));
  });
  socket.on('close', close).on('error', close);
}
