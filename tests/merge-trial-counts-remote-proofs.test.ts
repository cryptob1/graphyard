import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runMergeTrial } from '../src/merge-writer/executor.js';
import { readShardHosts } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { killTrees, shardHosts, shardRepository, sshdHost } from './helpers/shard-hosts.js';

// GY-3577: the merge trial counts each proof's cases from its shards' TAP. A shard sent to a compute
// host ran without the TAP reporter and its output was never read, so a proof whose file ran there
// counted 0 executed and the item was refused though its case passed. Every file here holds one proof
// case; the trial spreads them over this machine and a second host, and every proof must count once.

const image = 'graphyard-trial:remote-proofs';
const files = Array.from({ length: 6 }, (_, index) => `tests/proof-${index}.test.ts`);
const proofs = files.map((_, index) => `unit:remote-proof-${index}`);
let target: string, kill = () => {}, repository: { root: string; sha: string }, bin: string;
const previous = process.env.GRAPHYARD_TRIAL_IMAGE;

before(async () => {
  const hosts = await shardHosts('remote-proofs', ['loopback'], { [image]: `sha256:${'3577'.repeat(16)}` });
  bin = hosts.bin;
  if (spawnSync('sh', ['-c', 'command -v sshd || test -x /usr/sbin/sshd']).status === 0) {
    const server = await sshdHost(hosts.root, hosts.shim, hosts.home('loopback'), join(hosts.root, 'hosts', 'loopback', 'bin'), hosts.bin);
    target = `${server.user}@127.0.0.1`; kill = server.kill;
  } else { target = 'gy-compute@loopback'; kill = () => killTrees((_, command) => command.includes(hosts.shim)); }
  // The runner prints a file's case as TAP only when asked for the TAP reporter, as node --test does.
  const runner = `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const tap = process.argv.includes('--test-reporter=tap');
let n = 0;
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  const index = file.match(/proof-(\\d+)/)[1];
  console.log(tap ? 'ok ' + (++n) + ' - unit:remote-proof-' + index + ' — passes' : '✔ unit:remote-proof-' + index);
  appendFileSync(at('--durations'), JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
}
`;
  repository = await shardRepository('remote-proofs-repo', [], {
    'scripts/tests.mjs': runner,
    ...Object.fromEntries(files.map((file, index) => [file, `test('${proofs[index]} — passes', () => {})\n`])),
  });
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
});
after(() => { kill(); if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; });

const run: ChildRun = async (command, args, options) => {
  if (command === 'npm') return '';
  if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
  const env = { ...process.env, ...options?.env, PATH: `${bin}:${process.env.PATH}` };
  if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, env, wrapper: undefined });
  return defaultChildRun(command, args, { ...options, env });
};

test('unit:merge-trial-counts-remote-shard-proofs — a proof whose file ran on a compute host is counted from that shard\'s TAP', { timeout: 300_000 }, async () => {
  const timings: string[] = [];
  const result = await runMergeTrial({ root: repository.root, base: await temporaryDirectory('remote-proofs-base'), mergeSha: repository.sha, changedFiles: files, timeoutMs: 240_000, cores: 2, run, retries: 0,
    proofs, proofFiles: files, attribute: false, onTiming: step => timings.push(step),
    remote: { hosts: [target], read: async named => (await readShardHosts(named, run, 2)).map(reading => ({ ...reading, cores: reading.away ? 0 : 2, busy: 0, steal: 0, celsius: null })) } });
  assert.equal(result.build, 'pass', result.logTail);
  assert.deepEqual(result.tests.failed, [], result.logTail);
  assert.ok(timings.some(step => step.endsWith(` on ${target}`)), `a shard ran on the second host: ${timings.join(', ')}`);
  assert.deepEqual(result.proofs, Object.fromEntries(proofs.map(proof => [proof, { executed: 1, failed: 0 }])));
});
