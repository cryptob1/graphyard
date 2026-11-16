import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultChildRun } from '../src/child-runner.js';
import { HostDroppedError, mirrorName, remoteShardSession } from '../src/merge-writer/remote-shards.js';
import { runnerRecords } from '../src/merge-writer/trial.js';
import { commitFile, dockerCalls, dockerCount, dockerCreates, git, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3412: a shard reaches a host only through graphyard-host-shim. The commit goes into the host's
// per-repo mirror as a pack of what it lacks and is cloned (with history) into a run directory; the
// warm image — the trial image with the locked dependencies installed, built once on this machine —
// is loaded there once per tag; the shard runs through the trial launcher there; output and records come back.

const image = 'graphyard-trial:remote-fixture', digest = `sha256:${'ab12'.repeat(16)}`;
const files = Array.from({ length: 4 }, (_, index) => `tests/file-${index}.test.ts`);
const box = 'gy-compute@box';
const argv = (list: string, records: string) => ['node', 'scripts/tests.mjs', '--files-from', list, '--durations', records];
let hosts: ShardHostsFixture;

before(async () => {
  hosts = await shardHosts('remote-transport', ['box']);
  await import('node:fs/promises').then(fs => fs.mkdir(hosts.localState, { recursive: true }).then(() => fs.writeFile(join(hosts.localState, 'state.json'), JSON.stringify({ images: { [image]: digest }, containers: {} }))));
  process.env.PATH = `${hosts.bin}:${process.env.PATH}`;
});

const objects = (mirror: string) => { const lines = Object.fromEntries(git(mirror, 'count-objects', '-v').split('\n').map(line => line.split(': '))); return Number(lines.count) + Number(lines['in-pack']); };

test('integration:remote-shard-transport — the commit reaches the host\'s per-repo mirror as a delta, the warm image loads once per tag and is reused for the same image digest and lockfile hash, the checkout has its history, and output and records come back', { timeout: 120_000 }, async () => {
  const { root, sha: first } = await shardRepository('remote-transport-repo', files);
  const mirror = join(hosts.home('box'), '.graphyard', 'mirrors', `${mirrorName(root)}.git`);
  const session = (sha: string) => remoteShardSession({ root, sha, image, run: defaultChildRun, deadline: Date.now() + 60_000 });

  const one = session(first);
  const ran = await one.run(box, 0, files.slice(0, 2), argv, 2);
  assert.equal(ran.ok, true, ran.out);
  assert.match(ran.out, /ok tests\/file-0\.test\.ts in .*\/\.graphyard\/runs\/trial-\w+\/repo/, 'the output comes back from the run directory on the host');
  assert.match(ran.out, /^history 1$/m, 'the checkout is a git clone with the commit\'s history');
  assert.deepEqual(runnerRecords(ran.records), [{ file: files[0], passed: true }, { file: files[1], passed: true }], 'the per-file records come back');
  assert.equal(git(mirror, 'cat-file', '-t', first), 'commit', 'the commit is in the host\'s mirror');
  assert.deepEqual([dockerCount(hosts.localState, 'install'), dockerCount(hosts.localState, 'commit'), dockerCount(hosts.state('box'), 'load')], [1, 1, 1], dockerCalls(hosts.state('box')).join(' '));
  assert.deepEqual(dockerCalls(hosts.state('box')).filter(call => call === 'install'), [], 'the host installs nothing: it has no network to install with');
  const [create] = await dockerCreates(hosts.state('box'));
  assert.match(create![create!.indexOf('--entrypoint') + 2]!, /^graphyard-warm:ab12ab12ab12-[0-9a-f]{12}$/, 'the shard ran in the warm image');
  assert.ok(create!.includes('--network=none') && create!.includes('--cpus=2'), create!.join(' '));

  // A second shard of the same trial reuses the prepared host; a failing file is the shard's verdict.
  const failing = await one.run(box, 1, ['tests/fails.test.ts'], argv, 2);
  assert.deepEqual([failing.ok, failing.status], [false, 1]);
  assert.deepEqual(runnerRecords(failing.records), [{ file: 'tests/fails.test.ts', passed: false }]);
  await one.close();
  assert.deepEqual(readdirSync(join(hosts.home('box'), '.graphyard', 'runs')), [], 'the run directory is removed');

  // The next commit sends only the objects the mirror lacks; same image digest and lockfile: no install, no load.
  const second = await commitFile(root, 'tests/file-0.test.ts', 'changed\n');
  const held = objects(mirror), delta = git(root, 'rev-list', '--objects', `${first}..${second}`).split('\n').filter(Boolean).length;
  const two = session(second);
  const again = await two.run(box, 0, files.slice(0, 1), argv, 2);
  assert.equal(again.ok, true, again.out);
  assert.match(again.out, /^history 2$/m);
  await two.close();
  assert.equal(objects(mirror) - held, delta, 'the push carried the delta only');
  assert.deepEqual([dockerCount(hosts.localState, 'install'), dockerCount(hosts.state('box'), 'load')], [1, 1], 'the warm image is reused');

  // A new lockfile hash installs and loads once more.
  const third = await commitFile(root, 'package-lock.json', JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { version: '2.0.0' } } }));
  const three = session(third);
  assert.equal((await three.run(box, 0, files.slice(0, 1), argv, 2)).ok, true);
  await three.close();
  assert.deepEqual([dockerCount(hosts.localState, 'install'), dockerCount(hosts.state('box'), 'load')], [2, 2]);
});

test('integration:remote-shard-transport — an unreachable host and a shard that dies without a verdict turn the shard away as capacity, its output\'s tail kept', { timeout: 60_000 }, async () => {
  const { root, sha } = await shardRepository('remote-transport-drop', files);
  const session = remoteShardSession({ root, sha, image, run: defaultChildRun, deadline: Date.now() + 60_000 });
  const died = await session.run(box, 0, ['tests/dies.test.ts'], argv, 1).then(() => null, error => error);
  assert.ok(died instanceof HostDroppedError, String(died));
  assert.match(died.message, /host gy-compute@box dropped a shard: .*history 1/s, 'the shard\'s output tail rides the reason');
  await hosts.down('box', true);
  try { await assert.rejects(session.run(box, 1, files.slice(0, 1), argv, 1), (error: unknown) => error instanceof HostDroppedError && /Connection refused/.test(error.message)); }
  finally { await hosts.down('box', false); await session.close(); }
});
