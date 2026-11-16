import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';
import { main } from '../src/cli/index.js';
import { readHostReadings } from '../src/hosts.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import { encodeLoopHosts, loopHostsHeader, loopPresenceHeader, loopSupervisionHeader } from '../src/model/loop-presence.js';
import { coordinationViewHeader } from '../src/server/work-view.js';

// GY-3407: `graphyard host add USER@HOST` checks the host's rootless Docker through its shim and
// records it; a host without Docker or one SSH cannot reach is refused with a plain reason; `host
// remove` removes it; and the probe only reads, so nothing lands on the host (tests/helpers/fake-hosts.ts).

const proof = 'integration:host-add';
let hosts: Awaited<ReturnType<typeof fakeHosts>>, config: string, savedPath: string | undefined, savedConfig: string | undefined;

before(async () => {
  hosts = await fakeHosts('host-add', [{ name: 'box' }, { name: 'bare', docker: false }]);
  config = join(hosts.root, 'config');
  savedPath = process.env.PATH; savedConfig = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.PATH = `${hosts.bin}:${process.env.PATH}`;
  process.env.GRAPHYARD_CONFIG_HOME = config;
});
after(() => { process.env.PATH = savedPath; if (savedConfig === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = savedConfig; });

const recorded = async () => JSON.parse(await readFile(join(config, 'machine', 'hosts.json'), 'utf8').catch(() => '[]')).map((host: { target: string }) => host.target);
const output = async (argv: string[]) => {
  const lines: string[] = [], log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try { await main(argv); } finally { console.log = log; }
  return lines.join('\n');
};

test(`${proof} — host add records a Docker-over-SSH host and writes nothing on it; one without Docker or unreachable is refused with a plain reason; host remove removes it`, async () => {
  assert.match(await output(['host', 'add', 'gy-compute@box']), /Added gy-compute@box: \d+ cores, rootless Docker answers through the shim/);
  assert.deepEqual(await recorded(), ['gy-compute@box']);
  assert.deepEqual(await readdir(hosts.home('box')), [], 'the probe only reads: nothing is written on the host');

  await assert.rejects(main(['host', 'add', 'gy-compute@bare']), /gy-compute@bare was not added: gy-compute@bare answers but its Docker does not: run graphyard host prepare/);
  await assert.rejects(main(['host', 'add', 'gy-compute@gone']), /gy-compute@gone was not added: gy-compute@gone is unreachable over SSH: ssh: connect to host gone port 22: Connection refused/);
  await assert.rejects(main(['host', 'add', 'not a host']), /Name the host as USER@HOST/);
  assert.deepEqual(await recorded(), ['gy-compute@box'], 'a refused host is never recorded');
  assert.deepEqual(await readdir(hosts.home('bare')), []);

  assert.match(await output(['host', 'list']), /^gy-compute@box {2}added /);
  assert.equal(await output(['host', 'remove', 'gy-compute@box']), 'Removed gy-compute@box.');
  assert.deepEqual(await recorded(), []);
});

test(`${proof} e2e:workers-host-list — each cycle reads this machine and every added host, an unreachable one away, and the control plane serves them on /api/status`, async () => {
  await mkdir(join(config, 'machine'), { recursive: true });
  await writeFile(join(config, 'machine', 'hosts.json'), JSON.stringify([{ target: 'gy-compute@box', addedAt: 'x' }, { target: 'gy-compute@gone', addedAt: 'x' }]));
  const first = await readHostReadings([], { local: 'vishrog' });
  assert.deepEqual(first.map(reading => [reading.host, reading.away]), [['vishrog', false], ['gy-compute@box', false], ['gy-compute@gone', true]]);
  const box = first[1]!;
  assert.ok(box.cores! > 0); assert.equal(box.runs, 2); assert.equal(box.steal, null, 'steal needs two readings');
  const second = await readHostReadings(first, { local: 'vishrog' });
  assert.equal(typeof second[1]!.steal, 'number', 'the second cycle measures steal from the first');
  assert.deepEqual(await readdir(hosts.home('box')), []);

  const store: Store = await withDatabase('host_add');
  await store.init();
  const engine = new Engine(store, 120, 'fixture/hosts');
  engine.gitRunner = null;
  const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: 'host-add-operator-token-xxxxxxxxxxxxxxxx' }, { id: 'loop', role: 'coordinator', sessionKind: 'ai', token: 'host-add-loop-token-xxxxxxxxxxxxxxxxxxxxx' }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  try {
    const read = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: 'Bearer host-add-loop-token-xxxxxxxxxxxxxxxxxxxxx', [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '15', [loopSupervisionHeader]: 'autonomous', [loopHostsHeader]: encodeLoopHosts(second) } });
    assert.equal(read.status, 200);
    const status = await (await fetch(`${url}/api/status`, { headers: { Authorization: 'Bearer host-add-operator-token-xxxxxxxxxxxxxxxx' } })).json() as { hosts: Array<{ host: string; away: boolean; reason?: string; runs: number | null; local?: boolean }> };
    assert.deepEqual(status.hosts.map(host => [host.host, host.away, host.local ?? false]), [['vishrog', false, true], ['gy-compute@box', false, false], ['gy-compute@gone', true, false]]);
    assert.equal(status.hosts[1]!.runs, 2);
    assert.match(status.hosts[2]!.reason!, /is unreachable over SSH/, "the away host's reason reaches the dashboard");
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); }
});
