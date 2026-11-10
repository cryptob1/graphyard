// A stub herdr for e2e:master-page-terminal (GY-3211): `terminal session control|observe PANE`
// prints the pane's screen as a terminal.frame, echoes each terminal.input back as one, and logs
// every call and stream event as a JSON line to HERDR_STUB_LOG. It never closes a pane.
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const log = entry => appendFileSync(process.env.HERDR_STUB_LOG, `${JSON.stringify(entry)}\n`);
const args = process.argv.slice(2);
log({ args });
if (args[0] !== 'terminal' || args[1] !== 'session') process.exit(0);
const [, , mode, pane] = args;
const frame = text => process.stdout.write(`${JSON.stringify({ type: 'terminal.frame', seq: 0, encoding: 'ansi', width: 120, height: 36, full: false, bytes: Buffer.from(text).toString('base64') })}\n`);
frame(`screen of ${pane}\r\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  log({ mode, pane, command });
  if (command.type === 'terminal.input') frame(command.text.replace(/\r/g, '\r\n'));
  if (command.type === 'terminal.release') process.exit(0);
}).on('close', () => { log({ mode, pane, detached: true }); process.exit(0); });
