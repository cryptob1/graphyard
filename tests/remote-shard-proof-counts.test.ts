import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runMergeTrial } from '../src/merge-writer/executor.js';
import type { HostReading } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3517: a merge trial counts a bound proof's cases from its test shards' TAP. A shard a compute host
// runs carries the same TAP reporter and its output is counted too, so a proof whose file goes to a host
// is never read as 0 executed. Docker on the host is the fixture's stand-in.

const image = 'graphyard-trial:proof-counts';
const proof = 'integration:remote-counted';
let hosts: ShardHostsFixture;
before(async () => { hosts = await shardHosts('remote-shard-proof-counts', ['box'], { [image]: `sha256:${'6c6c'.repeat(16)}` }); });

test('integration:remote-shard-proof-counts — a proof whose test file runs on a compute host is counted as executed', { timeout: 300_000 }, async () => {
  const file = 'tests/counted.test.ts';
  const answers = join(hosts.root, 'proof-counts-answers.jsonl');
  // The runner runs each listed file with Node's test runner, passing on the reporter options it was given.
  const runner = `import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const reporter = process.argv.filter(arg => arg.startsWith('--test-reporter'));
let failed = 0;
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  const ran = spawnSync(process.execPath, ['--test', ...reporter, file], { encoding: 'utf8' });
  failed += ran.status === 0 ? 0 : 1;
  process.stdout.write(ran.stdout);
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, remote: process.cwd().includes('/.graphyard/runs/') }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed: ran.status === 0, durationMs: 1 }) + '\\n');
}
process.exit(failed ? 1 : 0);
`;
  const repository = await shardRepository('proof-counts-repo', [], {
    'package.json': JSON.stringify({ name: 'fixture', type: 'module', scripts: { build: 'true' } }), 'scripts/tests.mjs': runner,
    [file]: `import { test } from 'node:test';\ntest(${JSON.stringify(`${proof} — runs`)}, () => {});\n`,
  });
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node' && args[0] === 'scripts/select.mjs') return file;
    if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, wrapper: undefined });
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  const reading = (name: string, cores: number): HostReading => ({ name, cores, busy: 0, steal: 0, celsius: 60, limit: 92, away: false });
  const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
  try {
    const result = await runMergeTrial({ root: repository.root, base: await temporaryDirectory('proof-counts-base'), mergeSha: repository.sha, changedFiles: [file], timeoutMs: 200_000, cores: 2, run, retries: 0,
      proofs: [proof], proofFiles: [file], attribute: false, remote: { hosts: ['gy-compute@box'], read: async () => [reading('this-machine', 2), reading('gy-compute@box', 8)] } });
    const lines = (await readFile(answers, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; remote: boolean });
    assert.deepEqual(lines, [{ file, remote: true }], result.logTail);
    assert.deepEqual(result.proofs[proof], { executed: 1, failed: 0 }, result.logTail);
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; }
});
