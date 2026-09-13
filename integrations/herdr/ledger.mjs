import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';

let config = {};
try { config = JSON.parse(await readFile(join(process.env.HERDR_PLUGIN_CONFIG_DIR || '.', 'config.json'), 'utf8')); } catch { /* env configuration is also supported */ }
const url = process.env.GRAPHYARD_URL || config.url;
const token = process.env.GRAPHYARD_TOKEN || config.token;
if (!url || !token) { console.error('Configure Graphyard URL and an individual worker/reader token in the Herdr plugin config.json. See docs/herdr.md.'); process.exit(1); }
// Treat server content as text, never terminal control sequences.
const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
async function request(path, data) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log('GRAPHYARD · Herdr work ledger\nCommands: list, show GY-N, claim GY-N, heartbeat GY-N EPOCH, release GY-N EPOCH, quit\nClaiming reserves work; it does not launch an agent or start automatic heartbeats.');
async function list() {
  const rows = await request('work');
  console.log('\n' + rows.map(w => `${clean(w.key).padEnd(8)} ${clean(w.stage).padEnd(11)} ${clean(w.lease?.owner ?? 'unassigned').padEnd(16)} ${clean(w.title)}\n         ${clean(w.gates.find(g => !g.passed)?.reasons[0] ?? 'All gates passed')}`).join('\n'));
  if (!rows.length) console.log('No work yet. Create a work item in the web UI.');
  return rows;
}
try {
  await list();
  for (;;) {
    const [command, key, epoch] = (await rl.question('\ngraphyard > ')).trim().split(/\s+/);
    if (command === 'quit') break;
    try {
      if (command === 'list' || !command) { await list(); continue; }
      const work = (await request('work')).find(w => w.key === key || w.id === key);
      if (!work) throw new Error('Unknown work item');
      if (command === 'show') console.log(clean(JSON.stringify(work, null, 2)).replaceAll('  ', ' '));
      else if (['claim', 'heartbeat', 'release'].includes(command)) {
        const result = await request(`work/${work.id}/${command}`, command === 'claim' ? {} : { epoch: Number(epoch) });
        console.log(`${clean(result.key)} · ${clean(result.stage)} · lease epoch ${result.epoch}`);
        if (command === 'claim') console.log(`Next: graphyard worktree ${clean(result.key)} ${result.epoch}\nThen run graphyard watch ${clean(result.key)} ${result.epoch} -- <agent command> in that workspace. Lease expires in two minutes without a heartbeat.`);
      } else console.log('Commands: list, show, claim, heartbeat, release, quit');
    } catch (error) { console.error(clean(error.message)); }
  }
} catch (error) { console.error(clean(error.message)); process.exitCode = 1; }
finally { rl.close(); }
