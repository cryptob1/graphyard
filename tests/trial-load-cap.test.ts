import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { trialContainerBoundary, trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { trialContainerCap, trialLoad, trialStartOrder } from '../src/merge-writer/trial-load.js';
import { serveHead } from '../src/merge-writer/serve-head.js';

const proof = 'unit:tests/trial-load-cap.test.ts';

// Stand-in docker and df CLIs. `start` holds the attached client until `rm` of that container ends it, as Docker does.
const fakeDocker = (log: string) => `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
case "$3" in
  start) for name; do :; done; echo $$ > ${JSON.stringify(log)}."$name"; exec sleep 60 ;;
  rm) kill "$(cat ${JSON.stringify(log)}."$5")" 2>/dev/null; exit 0 ;;
esac
exit 0
`;

async function machine(label: string) {
  const base = await temporaryDirectory(label, process.cwd());
  const bin = join(base, 'bin'), hwmon = join(base, 'hwmon'), log = join(base, 'docker.log'), avail = join(base, 'avail'), children: ChildProcess[] = [];
  await mkdir(bin); await mkdir(hwmon);
  await writeFile(join(bin, 'docker'), fakeDocker(log));
  await writeFile(join(bin, 'df'), `#!/bin/sh\necho Avail\ncat ${JSON.stringify(avail)}\n`);
  await chmod(join(bin, 'docker'), 0o755); await chmod(join(bin, 'df'), 0o755);
  await writeFile(avail, '100000000000\n');
  const started = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => line.includes(' start ')).length;
  const sensor = async (name: string, millidegrees: number) => {
    await mkdir(join(hwmon, name), { recursive: true });
    await writeFile(join(hwmon, name, 'name'), name);
    await writeFile(join(hwmon, name, 'temp1_input'), `${millidegrees}\n`);
  };
  const launch = (load: { cap?: number; order?: number } = {}) => {
    const [program, ...words] = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [[base, '/scratch', false]], network: 'none',
      load: { slots: join(base, 'slots'), cap: load.cap ?? 2, order: load.order ?? trialStartOrder.merge, hotCelsius: 95, floorBytes: 30e9, hwmon } });
    const child = spawn(program!, [...words, 'sleep', '600'], { cwd: base, env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'ignore', 'pipe'] });
    let said = '';
    child.stderr!.on('data', chunk => { said += chunk; });
    children.push(child);
    return { child, said: () => said };
  };
  const until = async (condition: () => boolean | Promise<boolean>, what: string) => {
    for (let waited = 0; !(await condition()); waited += 50) {
      assert.ok(waited < 15_000, what);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const end = async (child: ChildProcess) => { const gone = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await gone; };
  const close = async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) await end(child); };
  return { base, avail, started, sensor, launch, until, end, close };
}

test(`${proof} — with the cap reached a further start waits until one ends`, async () => {
  const host = await machine('load-cap');
  try {
    const first = host.launch({ cap: 2 });
    host.launch({ cap: 2 });
    await host.until(async () => await host.started() === 2, 'two starts fit the cap of two');
    const third = host.launch({ cap: 2 });
    await host.until(() => third.said().includes('waiting: the machine-wide cap of 2 trial containers is reached'), 'the third start says what it waits for');
    assert.equal(await host.started(), 2, 'the start over the cap never reaches Docker');
    await host.end(first.child);
    await host.until(async () => await host.started() === 3, 'the waiting start takes the freed slot');
    assert.match(third.said(), /starting/);
  } finally { await host.close(); }
});

test(`${proof} — a CPU sensor at 95C holds a start until it cools; a hot non-CPU sensor does not`, async () => {
  const host = await machine('load-hot');
  try {
    await host.sensor('nvme', 99_000);
    await host.sensor('coretemp', 95_000);
    const held = host.launch();
    await host.until(() => held.said().includes('waiting: a CPU sensor reads 95C or more'), 'the start says the CPU is hot');
    assert.equal(await host.started(), 0, 'nothing starts while the CPU is at 95C');
    await host.sensor('coretemp', 94_000);
    await host.until(async () => await host.started() === 1, 'the start goes once the sensor clears');
  } finally { await host.close(); }
});

test(`${proof} — a start waits while its volume is under the disk floor and goes once it clears`, async () => {
  const host = await machine('load-disk');
  try {
    await writeFile(host.avail, '29000000000\n');
    const held = host.launch();
    await host.until(() => held.said().includes('is under the disk floor'), 'the start names the short volume');
    assert.equal(await host.started(), 0);
    await writeFile(host.avail, '31000000000\n');
    await host.until(async () => await host.started() === 1, 'the start goes once the disk clears');
  } finally { await host.close(); }
});

test(`${proof} — at normal readings a start proceeds at once, without waiting`, async () => {
  const host = await machine('load-normal');
  try {
    await host.sensor('coretemp', 70_000);
    const at = Date.now(), { said } = host.launch();
    await host.until(async () => await host.started() === 1, 'the start goes');
    assert.ok(Date.now() - at < 900, 'no wait of even one retry');
    assert.equal(said(), '');
  } finally { await host.close(); }
});

test(`${proof} — a freed slot goes to the merge trial before the gate, and the gate before worker verification`, async () => {
  const host = await machine('load-order');
  try {
    const occupant = host.launch({ cap: 1 });
    await host.until(async () => await host.started() === 1, 'the slot is taken');
    const verification = host.launch({ cap: 1, order: trialStartOrder.verification });
    await host.until(() => verification.said().includes('waiting'), 'verification waits');
    const gate = host.launch({ cap: 1, order: trialStartOrder.gate });
    await host.until(() => gate.said().includes('waiting'), 'the gate waits');
    const merge = host.launch({ cap: 1, order: trialStartOrder.merge });
    await host.until(() => merge.said().includes('waiting'), 'the merge trial waits');
    await host.end(occupant.child);
    await host.until(() => merge.said().includes('starting'), 'the merge trial goes first');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(gate.said().includes('starting') || verification.said().includes('starting'), false);
    await host.end(merge.child);
    await host.until(() => gate.said().includes('starting'), 'the gate goes second');
    assert.equal(verification.said().includes('starting'), false);
    await host.end(gate.child);
    await host.until(() => verification.said().includes('starting'), 'worker verification goes last');
  } finally { await host.close(); }
});

test(`${proof} — the cap is one per trial lane, and every start reads the install's disk floor and one machine-wide directory`, async () => {
  assert.equal(trialContainerCap(24), 12);
  assert.equal(trialContainerCap(4), 6, 'small hosts keep room for every trial\'s serve and session pair');
  const root = await temporaryDirectory('load-config', process.cwd());
  await mkdir(join(root, '.graphyard'));
  await writeFile(join(root, '.graphyard', 'master.json'), JSON.stringify({ run: { diskFloorGb: 50 } }));
  const merge = await trialLoad(root, 'merge'), other = await trialLoad(join(root, 'elsewhere'), 'verification');
  assert.equal(merge.floorBytes, 50e9);
  assert.equal(other.floorBytes, 30e9);
  assert.equal(merge.slots, other.slots);
  assert.ok(merge.order < other.order);
});

test(`${proof} — a serve command's time to answer starts when its container does`, async () => {
  const base = await temporaryDirectory('load-serve', process.cwd());
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  const launcher = join(base, 'launcher');
  await writeFile(launcher, '#!/bin/sh\necho "graphyard trial container: waiting: a CPU sensor reads 95C or more" >&2\nsleep 2\necho "graphyard trial container: starting" >&2\nexec "$@"\n');
  await chmod(launcher, 0o755);
  const server = join(base, 'server.cjs');
  await writeFile(server, `require('http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1');\n`);
  const command = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}`;
  const serving = serveHead(base, { kind: 'command', id: 'app', command, url: `http://127.0.0.1:${port}/`, readySeconds: 1 } as never,
    { sha: 'a'.repeat(40), env: { PATH: process.env.PATH ?? '' }, budgetMs: 20_000, wrapper: [launcher], scratch: base });
  try { assert.equal(await serving.ready, `http://127.0.0.1:${port}`); } finally { await serving.close(); }
});

test(`${proof} — a trial's compose-network container counts under the same load as its others`, async () => {
  if (existsSync('/etc/graphyard-trial')) return; // Nested trials start no Docker container.
  const allocation = await temporaryDirectory('load-network', process.cwd());
  const load = await trialLoad(allocation, 'merge');
  const boundary = trialContainerBoundary([allocation], [], Date.now() + 60_000, load);
  const spec = (words: string[]) => JSON.parse(words.at(-1)!) as { network: string; load: unknown };
  assert.deepEqual(spec(boundary()).load, load);
  const network = spec(boundary('container:abc'));
  assert.equal(network.network, 'container:abc');
  assert.deepEqual(network.load, load);
});
