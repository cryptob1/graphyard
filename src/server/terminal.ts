// Concern: the live terminal the dashboard's Master page and Workers page show (GY-3211) — a WebSocket bridged to Herdr's terminal session stream.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createInterface } from 'node:readline';
import type { Principal } from '../model.js';
import { loopPanesRegistry } from '../model/loop-presence.js';
import { herdrInvocation, herdrTarget } from '../master/herdr.js';
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
  if (url.pathname !== '/api/terminal') return refuse(socket, 404, 'Not Found');
  const [protocol, token = ''] = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(part => part.trim());
  let actor: Principal;
  try { actor = await authenticate(services, `Bearer ${token}`, services.repository); } catch { return refuse(socket, 401, 'Unauthorized'); }
  const panes = loopPanesRegistry(services.engine).latest, master = panes?.master ?? null;
  const pane = url.searchParams.get('pane') || master;
  if (!pane) return refuse(socket, 404, 'Not Found');
  if (pane !== master && !(await services.engine.store.pool.query('SELECT 1 FROM work_items WHERE document->\'sessions\' @> $1::jsonb LIMIT 1', [JSON.stringify([{ pane, state: 'running' }])])).rowCount) return refuse(socket, 404, 'Not Found');
  const control = pane === master && canTypeIntoMasterPane(actor);
  const size = (name: string, fallback: number) => String(Math.min(500, Math.max(10, Number(url.searchParams.get(name)) || fallback)));
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')}`,
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n'));
  socket.write(frame(1, Buffer.from(JSON.stringify({ pane, mode: control ? 'control' : 'observe' }))));

  const instance = panes?.configHome && panes.session ? { configHome: panes.configHome, session: panes.session } : herdrTarget();
  const call = herdrInvocation(['terminal', 'session', control ? 'control' : 'observe', pane, ...(control ? ['--takeover'] : []), '--cols', size('cols', 120), '--rows', size('rows', 40)], instance);
  const herdr = spawn(call.command, call.args, { env: call.env ?? process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const command = (value: unknown) => { if (herdr.stdin.writable) herdr.stdin.write(`${JSON.stringify(value)}\n`); };
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    if (control) command({ type: 'terminal.release' });
    herdr.stdin.end(); setTimeout(() => herdr.kill(), 1_000).unref();
    if (socket.writable) socket.end(frame(8));
  };
  herdr.on('error', close).on('exit', close);
  createInterface({ input: herdr.stdout }).on('line', line => {
    let record: any; try { record = JSON.parse(line); } catch { return; }
    if (record.type === 'terminal.frame' && typeof record.bytes === 'string') socket.write(frame(2, Buffer.from(record.bytes, 'base64')));
    if (record.type === 'terminal.closed') close();
  });

  let typed = '', pending = Buffer.alloc(0);
  const record = (line: string) => services.engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, terminalInputEvent, JSON.stringify({ pane, line })]).catch(error => console.error(`[graphyard] terminal input not recorded: ${error}`));
  const message = (text: string) => {
    let input: any; try { input = JSON.parse(text); } catch { return; }
    if (!control) return;
    if (input.type === 'resize') command({ type: 'terminal.resize', cols: Number(input.cols), rows: Number(input.rows) });
    if (input.type !== 'input' || typeof input.data !== 'string') return;
    command({ type: 'terminal.input', text: input.data });
    for (const char of input.data) {
      if (char === '\r' || char === '\n') { if (typed.trim()) void record(typed); typed = ''; }
      else if (char === '\x7f') typed = typed.slice(0, -1);
      else if (char >= ' ') typed += char;
    }
  };
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
      if (opcode === 8) return close();
      if (opcode === 9) socket.write(frame(10, Buffer.from(payload)));
      if (opcode === 1) message(Buffer.from(payload).toString('utf8'));
    }
  });
  socket.on('close', close).on('error', close);
}
