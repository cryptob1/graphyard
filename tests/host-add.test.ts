import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { main } from '../src/cli/index.js';
import { readHostReadings } from '../src/hosts.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import { encodeLoopHosts, loopHostsHeader, loopPresenceHeader, loopSupervisionHeader } from '../src/model/loop-presence.js';
import { coordinationViewHeader } from '../src/server/work-view.js';

// GY-3407: `graphyard host add USER@HOST` checks Docker over SSH and records the host; a host
// without Docker or one SSH cannot reach is refused with a plain reason; `host remove` removes it;
// and the probe only reads, so nothing lands on the host. SSH and Docker are stand-ins on PATH: the
// fake ssh runs the remote command in that host's own home with its own Docker (or none), and
// refuses the connection to an unreachable one exactly as OpenSSH words it.

const proof = 'integration:host-add';
let root: string, config: string, homes: string, savedPath: string | undefined, savedConfig: string | undefined;

before(async () => {
  root = await temporaryDirectory('host-add');
  config = join(root, 'config'); homes = join(root, 'homes');
  const bin = join(root, 'bin'), dockerBin = join(root, 'docker-bin');
  await mkdir(bin); await mkdir(dockerBin);
  for (const host of ['box', 'bare']) await mkdir(join(homes, host), { recursive: true });
  // A Docker that answers and runs two trial containers.
  await writeFile(join(dockerBin, 'docker'), '#!/bin/sh\ncase "$1" in info) echo id;; ps) printf "a1\\nb2\\n";; esac\n');
  await writeFile(join(bin, 'ssh'), `#!/bin/sh
for last; do :; done
for arg; do case "$arg" in *@*) target="$arg";; esac; done
host="\${target#*@}"
if [ ! -d "${homes}/$host" ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
path="/usr/bin:/bin"; [ "$host" = box ] && path="${dockerBin}:$path"
cd "${homes}/$host" && HOME="${homes}/$host" PATH="$path" sh -c "$last"
`);
  await chmod(join(bin, 'ssh'), 0o755); await chmod(join(dockerBin, 'docker'), 0o755);
  savedPath = process.env.PATH; savedConfig = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.PATH = `${bin}:${dockerBin}:${process.env.PATH}`;
  process.env.GRAPHYARD_CONFIG_HOME = config;
});
after(() => { process.env.PATH = savedPath; if (savedConfig === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = savedConfig; });

const recorded = async () => JSON.parse(await readFile(join(config, 'hosts.json'), 'utf8').catch(() => '[]')).map((host: { target: string }) => host.target);
const output = async (argv: string[]) => {
  const lines: string[] = [], log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try { await main(argv); } finally { console.log = log; }
  return lines.join('\n');
};

test(`${proof} — host add records a Docker-over-SSH host and writes nothing on it; one without Docker or unreachable is refused with a plain reason; host remove removes it`, async () => {
  assert.match(await output(['host', 'add', 'vish@box']), /Added vish@box: \d+ cores, Docker answers/);
  assert.deepEqual(await recorded(), ['vish@box']);
  assert.deepEqual(await readdir(join(homes, 'box')), [], 'the probe only reads: nothing is written on the host');

  await assert.rejects(main(['host', 'add', 'vish@bare']), /vish@bare was not added: vish@bare answers but has no Docker it can use: install Docker there and add vish to the docker group/);
  await assert.rejects(main(['host', 'add', 'vish@gone']), /vish@gone was not added: vish@gone is unreachable over SSH: ssh: connect to host gone port 22: Connection refused/);
  await assert.rejects(main(['host', 'add', 'not a host']), /Name the host as USER@HOST/);
  assert.deepEqual(await recorded(), ['vish@box'], 'a refused host is never recorded');
  assert.deepEqual(await readdir(join(homes, 'bare')), []);

  assert.match(await output(['host', 'list']), /^vish@box {2}added /);
  assert.equal(await output(['host', 'remove', 'vish@box']), 'Removed vish@box.');
  assert.deepEqual(await recorded(), []);
});

test(`${proof} e2e:workers-host-list — each cycle reads this machine and every added host, an unreachable one away, and the control plane serves them on /api/status`, async () => {
  await writeFile(join(config, 'hosts.json'), JSON.stringify([{ target: 'vish@box', addedAt: 'x' }, { target: 'vish@gone', addedAt: 'x' }]));
  const first = await readHostReadings([], { local: 'vishrog' });
  assert.deepEqual(first.map(reading => [reading.host, reading.away]), [['vishrog', false], ['vish@box', false], ['vish@gone', true]]);
  const box = first[1]!;
  assert.ok(box.cores! > 0); assert.equal(box.runs, 2); assert.equal(box.steal, null, 'steal needs two readings');
  const second = await readHostReadings(first, { local: 'vishrog' });
  assert.equal(typeof second[1]!.steal, 'number', 'the second cycle measures steal from the first');
  assert.deepEqual(await readdir(join(homes, 'box')), []);

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
    const status = await (await fetch(`${url}/api/status`, { headers: { Authorization: 'Bearer host-add-operator-token-xxxxxxxxxxxxxxxx' } })).json() as { hosts: Array<{ host: string; away: boolean; runs: number | null; local?: boolean }> };
    assert.deepEqual(status.hosts.map(host => [host.host, host.away, host.local ?? false]), [['vishrog', false, true], ['vish@box', false, false], ['vish@gone', true, false]]);
    assert.equal(status.hosts[1]!.runs, 2);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); }
});
