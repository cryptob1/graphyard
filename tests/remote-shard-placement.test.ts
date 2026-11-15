import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultChildRun } from '../src/child-runner.js';
import { HostDroppedError, parseHostReading, readHosts, realFreeCores, runShardsOnHosts, type HostReading, type PlacedHost } from '../src/merge-writer/remote-shards.js';

// GY-3406: a trial's shards are placed across hosts from one reading of each — free cores, CPU steal
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

test(`${proof} — one command reads a host's cores, load, steal and hottest sensor; output that does not parse is an away host`, async () => {
  const [here] = await readHosts([], defaultChildRun);
  assert.ok(here!.cores >= 1 && here!.busy >= 0 && here!.steal >= 0 && here!.steal <= 1, JSON.stringify(here));
  assert.equal(here!.away, false);
  assert.deepEqual(parseHostReading('box', '{"cores":16,"busy":3.5,"steal":0.1,"celsius":71,"limit":97}\n'), { name: 'box', cores: 16, busy: 3.5, steal: 0.1, celsius: 71, limit: 97, away: false });
  assert.equal(parseHostReading('box', 'ssh: Could not resolve hostname box').away, true);
  const unreachable = await readHosts([{ name: 'gone', ssh: 'gone' }], defaultChildRun, '/bin/false');
  assert.equal(unreachable[1]!.away, true);
});
