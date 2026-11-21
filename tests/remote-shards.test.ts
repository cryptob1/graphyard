import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runShardsOnHosts, type HostReading, type PlacedHost } from '../src/merge-writer/remote-shards.js';

// GY-3588: the reading taken at trial start never takes this machine out of placement. It keeps its
// room of shards; the launcher holds each container start while a sensor is hot. A hot remote host
// still takes none.

const proof = 'unit:hot-local-host-keeps-its-shard-room';
const hot: Partial<HostReading> = { cores: 8, busy: 0, steal: 0, celsius: 95, limit: 92, away: false };
const local: PlacedHost<string> = { name: 'here', room: 3, reading: { name: 'here', ...hot } as HostReading };

test(`${proof} — a hot reading at trial start leaves this machine its room: 3 of 6 shards run at once and all 6 finish here`, async () => {
  let running = 0, most = 0;
  const result = await runShardsOnHosts({ count: 6, hosts: [local], breadth: 1, run: async () => {
    most = Math.max(most, ++running);
    await new Promise(resolve => setTimeout(resolve, 10));
    running--;
  } });
  assert.ok(most >= 3, `${most} shards ran at the same time`);
  assert.deepEqual(result.ran, Array(6).fill('here'));
});

test(`${proof} — a remote host with a hot reading still receives no shard`, async () => {
  const remote: PlacedHost<string> = { name: 'hot-box', room: 8, remote: 'hot-box', reading: { name: 'hot-box', ...hot } as HostReading };
  const result = await runShardsOnHosts({ count: 6, hosts: [local, remote], breadth: 1, run: async () => { await new Promise(resolve => setTimeout(resolve, 5)); } });
  assert.deepEqual(result.ran, Array(6).fill('here'));
});
