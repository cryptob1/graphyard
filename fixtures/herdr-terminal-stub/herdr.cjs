// Host-only TUI fixture: history, agent observations, resize and raw input share a log.
const { appendFileSync, readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const log = entry => appendFileSync(process.env.HERDR_STUB_LOG, `${JSON.stringify(entry)}\n`);
const args = process.argv.slice(2);
log({ args });
const fixture = () => { try { return JSON.parse(readFileSync(process.env.HERDR_STUB_STATE, 'utf8')); } catch { return {}; } };
if (args[0] === 'agent' && args[1] === 'list') {
  const master = fixture().master;
  process.stdout.write(JSON.stringify({ agents: master?.pane ? [{ name: master.agentName, pane_id: master.pane, agent: master.runtime, agent_status: fixture().status ?? 'idle' }] : [] }));
  process.exit(0);
}
if (args[0] === 'agent' && args[1] === 'read') { process.stdout.write('Ready'); process.exit(0); }
if (args[0] === 'pane' && args[1] === 'read') {
  if (args.slice(3).join(' ') !== '--source recent --lines 1000 --ansi') process.exit(2);
  process.stdout.write(Array.from({ length: 1000 }, (_, i) => `earlier line ${String(i).padStart(4, '0')}\r\n`).join(''));
  if (fixture().gap) process.stdout.write(`${fixture().gap}\r\n`);
  process.exit(0);
}
if (args[0] !== 'terminal' || args[1] !== 'session') process.exit(0);
const [, , mode, pane] = args;
let cols = Number(args[args.indexOf('--cols') + 1]), rows = Number(args[args.indexOf('--rows') + 1]);
const frame = text => process.stdout.write(`${JSON.stringify({ type: 'terminal.frame', seq: 0, encoding: 'ansi', width: cols, height: rows, full: false, bytes: Buffer.from(text).toString('base64') })}\n`);
// Enable bracketed paste as a real TUI does.
frame(`\x1b[?2004hscreen of ${pane}\r\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  log({ mode, pane, command });
  if (command.type === 'terminal.input') frame(command.text.replace(/\r/g, '\r\n'));
  if (command.type === 'terminal.resize') { cols = command.cols; rows = command.rows; log({ pane, size: { cols, rows } }); }
  if (command.type === 'terminal.release') process.exit(0);
}).on('close', () => { log({ mode, pane, detached: true }); process.exit(0); });
