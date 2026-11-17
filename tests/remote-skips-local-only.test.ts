import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { readShardHosts } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { killTrees, shardHosts, shardRepository, sshdHost, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3419 AC-3: a merge trial on two hosts — this machine, and this same machine reached over a real
// OpenSSH server at 127.0.0.1 whose only key runs graphyard-host-shim with its own host folders (the
// fixture's ssh stand-in reaches the same shim when the trial image has no sshd). The selection mixes
// plain files with files that need Docker: on the second host, where a shard has no Docker socket,
// those fail exactly as they would for real; local-only marking keeps them on this machine, so the
// two-host verdict is the one-host verdict, while the plain files still run on both hosts.

const proof = 'e2e:remote-skips-local-only';
const image = 'graphyard-trial:remote-skips';
const plain = Array.from({ length: 6 }, (_, index) => `tests/plain-${index}.test.ts`);
const docker = Array.from({ length: 4 }, (_, index) => `tests/uses-docker-${index}.test.ts`);
const files = [...plain, ...docker];
let hosts: ShardHostsFixture, second: { target: string; kill(): void; start(): Promise<void> }, target: string, repository: { root: string; sha: string }, answers: string;
const previous = process.env.GRAPHYARD_TRIAL_IMAGE;

before(async () => {
  hosts = await shardHosts('remote-skips', ['loopback'], { [image]: `sha256:${'5c1f'.repeat(16)}` });
  if (spawnSync('sh', ['-c', 'command -v sshd || test -x /usr/sbin/sshd']).status === 0) {
    const server = await sshdHost(hosts.root, hosts.shim, hosts.home('loopback'), join(hosts.root, 'hosts', 'loopback', 'bin'), hosts.bin);
    second = { target: `${server.user}@127.0.0.1`, kill: server.kill, start: server.start };
  } else second = { target: 'gy-compute@loopback', kill: () => killTrees((_, command) => command.includes(hosts.shim)), start: async () => {} };
  target = second.target;
  answers = join(hosts.root, 'answers.jsonl');
  // On the host a file that needs Docker fails as it really would (no Docker socket there); here it passes.
  const runner = `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const remote = process.cwd().includes('/.graphyard/runs/');
let failed = 0;
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  const passed = !(remote && file.includes('uses-docker'));
  console.log((passed ? 'ok ' : 'docker: Cannot connect to the Docker daemon: ') + file + (remote ? ' on the second host' : ' here'));
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, remote, passed }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed, durationMs: 1 }) + '\\n');
  failed += passed ? 0 : 1;
}
process.exit(failed ? 1 : 0);
`;
  repository = await shardRepository('remote-skips-repo', [], {
    'scripts/tests.mjs': runner,
    // The local-only files name Docker in their own text; the plain ones name none of the words.
    ...Object.fromEntries([...plain.map(file => [file, 'test("adds", () => equal(1 + 1, 2))\n']), ...docker.map(file => [file, 'import { docker } from "docker"\ntest("runs a container", () => docker.run("alpine"))\n'])]),
  });
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
});
after(() => { second?.kill(); if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; });

/** This machine's shards run the runner directly; git, ssh and Docker calls find the fixture's ssh and Docker first on PATH. */
const run: ChildRun = async (command, args, options) => {
  if (command === 'npm') return '';
  if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
  const env = { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` };
  if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, env, wrapper: undefined });
  return defaultChildRun(command, args, { ...options, env });
};

/** One trial on `remote` hosts; each host's reading comes from its real probe over SSH, levelled to two free cores so placement alternates. */
async function trial(remote: string[]) {
  await rm(answers, { force: true });
  const result = await runTrial({ root: repository.root, base: await temporaryDirectory('remote-skips-base'), mergeSha: repository.sha, changedFiles: files, timeoutMs: 240_000, cores: 2, run, retries: 0,
    remote: { hosts: remote, read: async named => (await readShardHosts(named, run, 2)).map(reading => ({ ...reading, cores: reading.away ? 0 : 2, busy: 0, steal: 0, celsius: null })) } });
  const lines = existsSync(answers) ? (await readFile(answers, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; remote: boolean; passed: boolean }) : [];
  return { result, lines };
}

test(`${proof} — a two-host trial runs the local-only files only on this machine and the rest on both, with the one-host verdict`, { timeout: 600_000 }, async () => {
  const one = await trial([]);
  assert.equal(one.result.build, 'pass', one.result.logTail);
  assert.deepEqual({ passed: one.result.tests.passed, failed: one.result.tests.failed, files: one.result.tests.files }, { passed: files.length, failed: [], files: files.length }, one.result.logTail);
  assert.ok(one.lines.length === files.length && one.lines.every(line => line.passed && !line.remote), 'every file ran and passed on this machine alone');

  const two = await trial([target]);
  assert.equal(two.result.build, 'pass', two.result.logTail);
  assert.deepEqual({ passed: two.result.tests.passed, failed: two.result.tests.failed, files: two.result.tests.files },
    { passed: one.result.tests.passed, failed: one.result.tests.failed, files: one.result.tests.files }, two.result.logTail);
  assert.ok(two.lines.every(line => line.passed), 'no false failure from the host that has no Docker socket');
  assert.ok(two.lines.filter(line => line.file.includes('uses-docker')).every(line => !line.remote), 'every local-only file ran on this machine only');
  const plainLines = two.lines.filter(line => !line.file.includes('uses-docker'));
  assert.ok(plainLines.some(line => line.remote) && plainLines.some(line => !line.remote), `the plain files ran on both hosts: ${JSON.stringify(plainLines)}`);
  assert.match(two.result.logTail ?? '', /on the second host/, 'the second host\'s output returns into the trial log');
});
