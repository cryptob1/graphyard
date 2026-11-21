import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimScript } from '../src/host-shim.js';
import { readHostReadings } from '../src/hosts.js';
import { outdatedShimAttention, readRemoteShardRuns, readShardHosts, remoteShardSummary } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dockerCreates, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3476 AC-1: a merge trial with one added host whose installed graphyard-host-shim is older than this
// release (its probe prints another digest and, GY-3517, lacks a verb the trial uses). That host gets no shard, every shard runs here with the
// one-host verdict, and master status names the host away — "older than this release: run graphyard
// host prepare" — with an attention line. With this release's shim the same host takes shards again.

const proof = 'e2e:host-shim-outdated';
const image = 'graphyard-trial:shim-outdated';
const target = 'gy-compute@stale';
const files = Array.from({ length: 6 }, (_, index) => `tests/plain-${index}.test.ts`);
let hosts: ShardHostsFixture, repository: { root: string; sha: string }, answers: string;
const previous = process.env.GRAPHYARD_TRIAL_IMAGE;

before(async () => {
  hosts = await shardHosts('host-shim-outdated', ['stale'], { [image]: `sha256:${'5e1a'.repeat(16)}` });
  answers = join(hosts.root, 'answers.jsonl');
  const runner = `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const remote = process.cwd().includes('/.graphyard/runs/');
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  console.log('ok ' + file + (remote ? ' on the second host' : ' here'));
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, remote }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
}
`;
  repository = await shardRepository('host-shim-outdated-repo', [], { 'scripts/tests.mjs': runner, ...Object.fromEntries(files.map(file => [file, 'test("adds", () => equal(1 + 1, 2))\n'])) });
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
});
after(() => { if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; });

const run: ChildRun = async (command, args, options) => {
  if (command === 'npm') return '';
  if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
  const env = { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` };
  if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, env, wrapper: undefined });
  return defaultChildRun(command, args, { ...options, env });
};

async function trial(remote: string[]) {
  await rm(answers, { force: true });
  const result = await runTrial({ root: repository.root, base: await temporaryDirectory('host-shim-outdated-base'), mergeSha: repository.sha, changedFiles: files, timeoutMs: 240_000, cores: 2, run, retries: 0,
    remote: { hosts: remote, read: async named => (await readShardHosts(named, run, 2)).map(reading => ({ ...reading, cores: reading.away ? 0 : 2, busy: 0, steal: 0, celsius: null })) } });
  const lines = existsSync(answers) ? (await readFile(answers, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; remote: boolean }) : [];
  return { result, lines };
}

test(`${proof} — a host whose shim reports another digest takes no shard, reads away as older than this release with an attention line; with this release's shim it takes shards`, { timeout: 600_000 }, async () => {
  const one = await trial([]);
  assert.equal(one.result.build, 'pass', one.result.logTail);

  // The host runs a shim from an older release: another digest, and none of the verbs this release's trials use (GY-3517).
  await writeFile(hosts.shim, hostShimScript.replace(hostShimDigest, '0'.repeat(64)).replace(/^ *echo "verbs .*"\n/m, ''));
  const stale = await trial([target]);
  assert.equal(stale.result.build, 'pass', stale.result.logTail);
  assert.deepEqual({ passed: stale.result.tests.passed, failed: stale.result.tests.failed, files: stale.result.tests.files },
    { passed: one.result.tests.passed, failed: one.result.tests.failed, files: one.result.tests.files }, stale.result.logTail);
  assert.ok(stale.lines.length === files.length && stale.lines.every(line => !line.remote), `every shard ran on this machine: ${JSON.stringify(stale.lines)}`);
  assert.equal((await dockerCreates(hosts.state('stale'))).length, 0, 'the stale host was sent no shard');
  const runs = readRemoteShardRuns(repository.root);
  const host = remoteShardSummary(runs)!.hosts.find(entry => entry.name === target)!;
  assert.equal(host.state, 'away');
  assert.match(host.reason ?? '', /older than this release: run graphyard host prepare/);
  // GY-3517: the attention line follows the loop's latest probe of the host.
  const probes = async () => { const file = join(hosts.root, 'hosts.json'); await writeFile(file, JSON.stringify([{ target, addedAt: 'x' }])); return readHostReadings([], { file, run }); };
  const attention = outdatedShimAttention(await probes());
  assert.equal(attention.length, 1);
  assert.match(attention[0]!.text, new RegExp(`^${target}`));
  assert.match(attention[0]!.next, /graphyard host prepare/);

  // With this release's shim the same host takes shards.
  await writeFile(hosts.shim, hostShimScript);
  const current = await trial([target]);
  assert.equal(current.result.build, 'pass', current.result.logTail);
  assert.ok(current.lines.some(line => line.remote), `the host took shards with the current shim: ${JSON.stringify(current.lines)}`);
  assert.equal(remoteShardSummary(readRemoteShardRuns(repository.root))!.hosts.find(entry => entry.name === target)!.state, 'ready');
  assert.deepEqual(outdatedShimAttention(await probes()), []);
});
