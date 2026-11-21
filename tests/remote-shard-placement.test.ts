import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { HostDroppedError, readRemoteShardRuns, readShardHosts, realFreeCores, remoteShardSummary, runShardsOnHosts, type HostReading, type PlacedHost } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { trialHotCelsius } from '../src/merge-writer/trial-load.js';
import { hostShimDigest } from '../src/host-shim.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardHosts, shardRepository } from './helpers/shard-hosts.js';

// GY-3412: a trial's shards are placed across hosts from one reading of each — free cores, CPU steal
// and the hottest sensor. Each shard goes to the host with the most real free CPU under its heat limit,
// one trial's shards spread across hosts, no shard waits while a host under the limit has room, and a
// host that drops mid-shard has that shard re-queued on another host without a fault.

const proof = 'integration:remote-shard-placement';
const reading = (name: string, cores: number, busy: number, extra: Partial<HostReading> = {}): HostReading => ({ name, cores, busy, steal: 0, celsius: 60, limit: 92, away: false, ...extra });
const place = (reading: HostReading, room = Math.floor(realFreeCores(reading))): PlacedHost<string> => ({ name: reading.name, reading, room, ...(reading.name === 'vishrog' ? {} : { remote: reading.name }) });
/** A shard runner whose shards stay running until `release`, recording where each started. */
function held() {
  const started: { host: string; index: number }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { started, release: () => release(), run: async (host: PlacedHost<string>, index: number) => { started.push({ host: host.name, index }); await gate; } };
}

test(`${proof} — a shard goes to the host with the most real free CPU under its heat limit: steal counts against free cores, a hot or away host takes none`, async () => {
  const hosts = [
    place(reading('vishrog', 8, 6)),                                   // 2 free
    place(reading('steal-box', 16, 2, { steal: 0.5 })),                // 14 idle, 8 stolen: 6 real free
    place(reading('quiet-box', 12, 3)),                                // 9 real free
    place(reading('hot-box', 32, 0, { celsius: 93, limit: 92 })),      // most cores, over its heat limit
    place(reading('away-box', 32, 0, { away: true })),                 // did not answer
  ];
  assert.equal(realFreeCores(hosts[1]!.reading), 6);
  const shards = held();
  const placed = runShardsOnHosts({ count: 1, hosts, breadth: 1, run: shards.run });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(shards.started, [{ host: 'quiet-box', index: 0 }]);
  shards.release();
  assert.deepEqual((await placed).ran, ['quiet-box']);
});

test(`${proof} — one trial's shards spread across hosts and none waits while a host under the limit has room`, async () => {
  const hosts = [place(reading('vishrog', 8, 4), 4), place(reading('box-a', 8, 4)), place(reading('box-b', 8, 6)), place(reading('hot-box', 64, 0, { celsius: 99 }))];
  const shards = held();
  const placed = runShardsOnHosts({ count: 12, hosts, breadth: 1, run: shards.run });
  await new Promise(resolve => setImmediate(resolve));
  // 4 + 4 + 2 places: all ten start at once, spread across the three cool hosts; the hot one takes none.
  const per = (name: string) => shards.started.filter(entry => entry.host === name).length;
  assert.equal(shards.started.length, 10, JSON.stringify(shards.started));
  assert.deepEqual([per('vishrog'), per('box-a'), per('box-b'), per('hot-box')], [4, 4, 2, 0]);
  // The first shards alternate between the two hosts with the most real free CPU left.
  assert.deepEqual(new Set(shards.started.slice(0, 2).map(entry => entry.host)), new Set(['vishrog', 'box-a']));
  shards.release();
  const result = await placed;
  assert.equal(result.ran.length, 12);
  assert.equal(result.queuedWhileIdle, 0, 'no shard waited while a host idled');
  assert.deepEqual(result.dropped, []);
});

test(`${proof} — a host that drops mid-shard has that shard re-queued on another host without a fault, and takes no more`, async () => {
  const hosts = [place(reading('vishrog', 4, 2), 2), place(reading('laptop', 8, 0))];
  const tries: string[] = [];
  const result = await runShardsOnHosts({ count: 5, hosts, breadth: 1, run: async (host, index) => {
    tries.push(`${index}@${host.name}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (host.name === 'laptop') throw new HostDroppedError('laptop', 'ssh: connect to host laptop port 22: Connection timed out');
  } });
  assert.deepEqual(result.dropped, ['laptop']);
  assert.equal(result.ran.length, 5, JSON.stringify(tries));
  assert.ok(result.ran.every(host => host === 'vishrog'), 'every dropped shard ran again on this machine');
  for (const index of [0, 1, 2, 3, 4]) assert.ok(tries.includes(`${index}@vishrog`), `shard ${index} ran: ${tries.join(' ')}`);
  // A shard's own failure is still the trial's: only a dropped host re-queues.
  await assert.rejects(runShardsOnHosts({ count: 1, hosts: [hosts[0]!], breadth: 1, run: async () => { throw new Error('runner crashed'); } }), /runner crashed/);
});

test(`${proof} — the shim's probe reads a host's cores, load, steal and hottest sensor; a host that does not answer is away, and this machine always takes shards`, async () => {
  const probe = [`shim ${hostShimDigest}`, 'user 1001 gy-compute', 'cores 16', 'load 3.5', 'cpu  100 0 100 700 0 0 0 100 0 0', 'temp k10temp 71000', 'temp nvme 80000', 'runs 1'].join('\n');
  const run: ChildRun = async (command, args) => {
    if (command === 'ssh' && args[0] === '-G') return `hostname ${args.at(-1)!.split('@').at(-1)}\nuser gy-compute\n`;
    if (command === 'ssh' && (args.includes('-O') || args.includes('-fNM') && args.at(-1) === 'gy-compute@box')) return '';
    if (command === 'ssh' && args.at(-2) === 'gy-compute@box') return probe;
    if (command === 'ssh') throw Object.assign(new Error('ssh: connect to host gone port 22: Connection refused'), { status: 255 });
    throw new Error('no Docker here');
  };
  const [here, box, gone] = await readShardHosts(['gy-compute@box', 'gy-compute@gone'], run, 8);
  assert.deepEqual({ ...here!, name: 'here' }, { name: 'here', cores: 8, busy: 0, steal: 0, celsius: null, limit: trialHotCelsius, away: false });
  assert.deepEqual(box, { name: 'gy-compute@box', cores: 16, busy: 3.5, steal: 0.1, celsius: 71, limit: trialHotCelsius, away: false });
  assert.equal(gone!.away, true);
  assert.match(gone!.reason!, /Connection refused/);
});

test(`${proof} — in a trial, a host's shard that dies without a verdict is re-queued on this machine with no fault, its log tail kept in the trial log`, { timeout: 120_000 }, async () => {
  const image = 'graphyard-trial:remote-fixture';
  const hosts = await shardHosts('remote-placement-trial', ['box'], { [image]: `sha256:${'cd34'.repeat(16)}` });
  const files = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts'];
  // On the host every shard dies before it records a verdict; here the same files pass.
  const { root, sha } = await shardRepository('remote-placement-repo', files, { 'scripts/tests.mjs': `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
if (process.cwd().includes('/.graphyard/runs/')) { console.log('box shard output before it died'); process.exit(137); }
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) appendFileSync(at('--durations'), JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
` });
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
    if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, wrapper: undefined });
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
  const timings: string[] = [];
  try {
    const result = await runTrial({ root, base: await temporaryDirectory('remote-placement-base'), mergeSha: sha, changedFiles: files, timeoutMs: 90_000, cores: 2, run, retries: 0, onTiming: step => timings.push(step),
      remote: { hosts: ['gy-compute@box'], read: async () => [reading('vishrog', 2, 0), reading('gy-compute@box', 8, 0)] } });
    assert.equal(result.build, 'pass', result.logTail);
    assert.deepEqual({ passed: result.tests.passed, failed: result.tests.failed }, { passed: files.length, failed: [] }, result.logTail);
    assert.ok(timings.some(step => /^tests: shard \d+ on gy-compute@box$/.test(step)), `a shard was placed on the host: ${timings.join(', ')}`);
    assert.match(result.logTail ?? '', /\[remote\] host gy-compute@box dropped a shard: .*box shard output before it died.*; its shard runs on another host/s, 'the log tail is kept');
    const [record] = readRemoteShardRuns(root);
    assert.match(remoteShardSummary(readRemoteShardRuns(root))!.hosts.at(-1)!.reason ?? '', /box shard output before it died/);
    assert.equal(record!.remote, 0, 'every shard finally ran on this machine');
    assert.deepEqual(remoteShardSummary(readRemoteShardRuns(root))!.hosts.map(host => [host.name, host.state]), [['vishrog', 'ready'], ['gy-compute@box', 'away']]);
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; }
});
