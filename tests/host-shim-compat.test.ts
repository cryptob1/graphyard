import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimScript, legacyShimVerbs, trialVerbs } from '../src/host-shim.js';
import { readHostReadings } from '../src/hosts.js';
import { encodeLoopHosts, loopHosts } from '../src/model/loop-presence.js';
import { outdatedShimAttention, readRemoteShardRuns, readShardHosts, recordRemoteShardRun, remoteShardSummary } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardHosts, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3517: a release that changes graphyard-host-shim must not silently take every compute host
// offline. A host whose older shim still speaks every verb a trial uses stays ready; one lacking a
// verb (or a verb's current revision) reads away with the reason and an attention line. Host state
// in master status is the latest probe with when it was read, never the last trial's away reason.

const proof = 'integration:host-shim-compat';
const target = 'gy-compute@box';
let hosts: ShardHostsFixture, file: string;
before(async () => {
  hosts = await shardHosts('host-shim-compat', ['box']);
  file = join(hosts.root, 'hosts.json');
  await writeFile(file, JSON.stringify([{ target, addedAt: '2026-11-19T00:00:00.000Z' }]));
});
const run: ChildRun = (command, args, options) => defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
const verbsLine = `verbs ${trialVerbs.join(' ')}`;
const install = (script: string) => writeFile(hosts.shim, script);
const probe = async () => (await readHostReadings([], { file, run, local: 'here' })).find(reading => reading.host === target)!;
const trialReading = async () => (await readShardHosts([target], run, 2)).find(reading => reading.name === target)!;

test(`${proof} — a shim from another release that speaks every trial verb stays ready; one lacking a verb's current revision reads away with the reason`, { timeout: 120_000 }, async () => {
  assert.ok(hostShimScript.includes(`echo "${verbsLine}"`), 'the probe lists the verbs the shim speaks');

  // Another release changed the shim (its launcher, its wording) but no verb: another digest, the same verbs.
  await install(hostShimScript.replace(hostShimDigest, 'a'.repeat(64)));
  const changed = await probe();
  assert.equal(changed.away, false, changed.reason);
  assert.equal(changed.update, undefined);
  assert.equal((await trialReading()).away, false, 'a trial sends it shards');

  // The shim released before the probe listed verbs, known by its digest, speaks them all.
  const [legacy] = Object.keys(legacyShimVerbs);
  await install(hostShimScript.replace(hostShimDigest, legacy!).replace(`    echo "${verbsLine}"\n`, ''));
  assert.equal((await probe()).away, false, 'the previous release\'s shim stays ready');

  // This release changed run-shard: a shim speaking its older revision cannot run a trial's shard.
  const older = trialVerbs.find(verb => verb.startsWith('run-shard:'))!;
  await install(hostShimScript.replace(hostShimDigest, 'b'.repeat(64)).replace(verbsLine, verbsLine.replace(older, 'run-shard:1')));
  const stale = await probe();
  assert.equal(stale.away, true);
  assert.equal(stale.update, true);
  assert.match(stale.reason ?? '', new RegExp(`older than this release: run graphyard host prepare .*lacks ${older}`));
  const trial = await trialReading();
  assert.equal(trial.away, true, 'a trial sends it no shard');
  assert.match(trial.reason ?? '', /older than this release/);

  // This release added a verb: a shim that never heard of it reads away the same way.
  await install(hostShimScript.replace(hostShimDigest, 'c'.repeat(64)).replace(verbsLine, verbsLine.replace(/ clean:\d+/, '')));
  assert.match((await probe()).reason ?? '', /lacks clean:\d+/);

  // An unknown shim that lists no verbs speaks none a trial can rely on.
  await install(hostShimScript.replace(hostShimDigest, 'd'.repeat(64)).replace(`    echo "${verbsLine}"\n`, ''));
  assert.equal((await probe()).update, true);
});

test(`${proof} — master status reads each host's latest probe with when it was read, never the last trial's stale away reason`, { timeout: 120_000 }, async () => {
  const root = await temporaryDirectory('host-shim-compat-status');
  // The last trial ran while the host's shim was too old.
  await install(hostShimScript.replace(hostShimDigest, 'e'.repeat(64)).replace(verbsLine, 'verbs probe:1'));
  const away = await readHostReadings([], { file, run, local: 'here' });
  assert.equal(outdatedShimAttention(away).length, 1, 'an attention line names the host while it waits');
  assert.match(outdatedShimAttention(away)[0]!.next, /graphyard host prepare/);
  const reading = await trialReading();
  await recordRemoteShardRun(root, { at: new Date().toISOString(), wallMs: 1000, shards: 2, remote: 0, queuedWhileIdle: 0, host: 'here', celsius: null,
    hosts: [{ name: target, away: true, reason: reading.reason, celsius: null, freeCores: 0 }] });

  // The host is updated after that trial: the loop's next probe reads it ready.
  await install(hostShimScript);
  const before = Date.now();
  const latest = loopHosts(encodeLoopHosts(await readHostReadings(away, { file, run, local: 'here' })))!;
  const host = latest.find(entry => entry.host === target)!;
  assert.equal(host.away, false);
  assert.ok(host.at && Date.parse(host.at) >= before - 1000, `the probe names when it read the host: ${host.at}`);
  const summary = remoteShardSummary(readRemoteShardRuns(root), latest)!;
  const row = summary.hosts.find(entry => entry.name === target)!;
  assert.equal(row.state, 'ready');
  assert.equal(row.reason, undefined, 'no stale away reason');
  assert.equal('readAt' in row && row.readAt, host.at);
  assert.deepEqual(outdatedShimAttention(latest), [], 'the attention line clears with the probe');

  // The away reading crosses the loop's header with its update mark, for the dashboard's line.
  const header = loopHosts(encodeLoopHosts(away))!.find(entry => entry.host === target)!;
  assert.deepEqual({ away: header.away, update: header.update, read: typeof header.at }, { away: true, update: true, read: 'string' });
});
