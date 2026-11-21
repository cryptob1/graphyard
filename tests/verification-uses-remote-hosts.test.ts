import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { acquireVerificationSlot, setStrictCap, slotHolders, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { readRemoteShardRuns, readShardHosts, remoteShardSummary } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { runWorkerCheck } from '../src/merge-writer/worker-check.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3526: a worker's host-run test check held a host heavy-job slot (under a strict cap) for its
// whole trial — 30 to 60 minutes — while two compute hosts sat idle and merge trials and the batch
// gate waited behind it. Its shards go to ready hosts as a merge trial's do, with the same
// local-only split, and it holds a slot only while one of its shards runs on this machine.

const image = 'graphyard-trial:verification-remote';
const plain = Array.from({ length: 10 }, (_, index) => `tests/plain-${index}.test.ts`);
const docker = Array.from({ length: 2 }, (_, index) => `tests/uses-docker-${index}.test.ts`);
let hosts: ShardHostsFixture, slots: string, answers: string, go: string, files: string[] = [];
const previous = { image: process.env.GRAPHYARD_TRIAL_IMAGE, slots: process.env[slotsDirectoryVariable] };

before(async () => {
  hosts = await shardHosts('verification-remote', ['host-a', 'host-b'], { [image]: `sha256:${'3526'.repeat(16)}` });
  slots = join(hosts.root, 'heavy-jobs'); answers = join(hosts.root, 'answers.jsonl'); go = join(hosts.root, 'go');
  mkdirSync(slots, { recursive: true });
  // The host asked every install to back off: one heavy job at a time, and worker verifications take a slot too.
  setStrictCap(slots, { value: 1, until: new Date(Date.now() + 3600_000).toISOString() }, 'graphyard-master-app');
  process.env[slotsDirectoryVariable] = slots;
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
});
after(() => {
  for (const [name, value] of [['GRAPHYARD_TRIAL_IMAGE', previous.image], [slotsDirectoryVariable, previous.slots]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
});

/** Each file records where it ran (`here`, or the host whose run directory it ran in) and whether a heavy-job slot was held then; a host's file waits for `go` once it exists. */
const runner = () => `import { readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const where = process.cwd().match(/\\/hosts\\/([^/]+)\\/home\\//)?.[1] ?? 'here';
const slot = () => readdirSync(${JSON.stringify(slots)}).some(name => /^slot-\\d+$/.test(name) && Number(name.slice(5)) < 1000);
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  if (where !== 'here' && existsSync(${JSON.stringify(`${go}.wait`)})) while (!existsSync(${JSON.stringify(go)})) await new Promise(done => setTimeout(done, 50));
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, where, slot: slot() }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
  console.log('ok ' + file + ' on ' + where);
}
`;
const run: ChildRun = async (command, args, options) => {
  if (command === 'npm') return '';
  if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
  const env = { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` };
  if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, env, wrapper: undefined });
  return defaultChildRun(command, args, { ...options, env });
};

/** A worker's `graphyard check test` over `selected`, on this machine and both fake hosts; this machine reads busy, each host eight free cores. */
async function verification(label: string, selected: string[]) {
  files = selected;
  await rm(answers, { force: true });
  const repository = await shardRepository(label, [], { 'scripts/tests.mjs': runner(),
    ...Object.fromEntries([...plain.map(file => [file, `test("adds ${label}", () => equal(1 + 1, 2))\n`]), ...docker.map(file => [file, `import { docker } from "docker"\ntest("runs ${label}", () => docker.run("alpine"))\n`])]) });
  const result = await runWorkerCheck({ root: repository.root, base: await temporaryDirectory(`${label}-base`), baseBranch: 'main', key: 'GY-1', head: repository.sha, check: 'test',
    trial: input => runTrial({ ...input, run, cores: 2, timeoutMs: 240_000,
      remote: { hosts: ['gy-compute@host-a', 'gy-compute@host-b'], read: async named => (await readShardHosts(named, run, 2)).map((reading, index) => ({ ...reading, cores: index ? 8 : 2, busy: index ? 0 : 2, steal: 0, celsius: null })) } }) });
  const lines = existsSync(answers) ? (await readFile(answers, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; where: string; slot: boolean }) : [];
  return { result, lines, root: repository.root };
}

test('integration:verification-uses-remote-hosts — with two ready hosts a worker verification of a large test list places its shards on them, keeps local-only files here, and holds a slot only while a local shard runs', { timeout: 600_000 }, async () => {
  const remote = await verification('verification-remote-only', plain);
  assert.equal(remote.result.passed, true, remote.result.output);
  assert.deepEqual(remote.lines.map(line => line.file).sort(), [...plain].sort(), remote.result.output);
  assert.deepEqual(new Set(remote.lines.map(line => line.where)), new Set(['host-a', 'host-b']), `the shards ran on both ready hosts: ${JSON.stringify(remote.lines)}`);
  assert.ok(remote.lines.every(line => !line.slot), `no heavy-job slot was held while only other hosts ran its shards: ${JSON.stringify(remote.lines)}`);
  assert.deepEqual(slotHolders(slots), [], 'and none is held once it ends');

  const mixed = await verification('verification-mixed', [...plain, ...docker]);
  assert.equal(mixed.result.passed, true, mixed.result.output);
  const local = mixed.lines.filter(line => line.file.includes('uses-docker'));
  assert.deepEqual(local.map(line => line.where), ['here', 'here'], 'the local-only files ran on this machine only, as a merge trial runs them');
  assert.ok(local.every(line => line.slot), 'a slot was held while a local shard ran');
  assert.ok(mixed.lines.filter(line => !line.file.includes('uses-docker')).every(line => line.where !== 'here'), `the other files ran on the hosts: ${JSON.stringify(mixed.lines)}`);
  assert.deepEqual(slotHolders(slots), [], 'the slot is given back when the local shards end');
});

test('e2e:verification-uses-remote-hosts — master status shows a worker verification with remote shards while a merge trial can start', { timeout: 600_000 }, async () => {
  await writeFile(`${go}.wait`, ''); await rm(go, { force: true });
  const running = verification('verification-beside-trial', plain);
  try {
    while (!existsSync(join(hosts.home('host-a'), '.graphyard', 'runs')) && !existsSync(join(hosts.home('host-b'), '.graphyard', 'runs'))) await new Promise(done => setTimeout(done, 50));
    await new Promise(done => setTimeout(done, 500));
    // While its shards run on the hosts, the strict cap's one slot is free: a merge trial starts at once (on a cool CPU reading).
    assert.deepEqual(slotHolders(slots), [], 'the worker verification holds no slot while its shards run elsewhere');
    const sensors = await temporaryDirectory('verification-remote-sensors');
    mkdirSync(join(sensors, 'hwmon0'));
    writeFileSync(join(sensors, 'hwmon0', 'name'), 'coretemp\n'); writeFileSync(join(sensors, 'hwmon0', 'temp1_label'), 'Package id 0\n'); writeFileSync(join(sensors, 'hwmon0', 'temp1_input'), '60000\n');
    const waits: string[] = [];
    const trial = await acquireVerificationSlot({ directory: slots, label: 'merge trial GY-2', hwmon: sensors, pollMs: 20, onWait: line => waits.push(line) });
    assert.deepEqual(waits, [], 'the merge trial did not wait');
    assert.deepEqual(slotHolders(slots).map(holder => holder.label), ['merge trial GY-2']);
    trial.release();
  } finally { await writeFile(go, ''); await running.catch(() => {}); await rm(`${go}.wait`, { force: true }); }
  const { result, root } = await running;
  assert.equal(result.passed, true, result.output);
  const status = remoteShardSummary(readRemoteShardRuns(root))!;
  assert.equal(status.latest.run, 'worker verification GY-1: check test');
  assert.equal(status.latest.remote, plain.length, 'master status: every shard of the worker verification ran remotely');
  assert.deepEqual(status.hosts.map(host => host.state), ['ready', 'ready', 'ready']);
});
