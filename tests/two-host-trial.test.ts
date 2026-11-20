import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { readRemoteShardRuns, readShardHosts, remoteShardSummary } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { generate } from '../benchmarks/hard-math/generator.js';
import { oracleSource } from '../benchmarks/hard-math/oracle.js';
import { pinnedPython } from '../benchmarks/hard-math/python.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dockerCreates, dockerEveryCall, killTrees, shardHosts, shardRepository, sshdHost, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3412 AC-3: a merge trial on two hosts — this machine, and this same machine reached over a real
// OpenSSH server at 127.0.0.1 whose only key runs graphyard-host-shim with its own host folders — so
// the real remote path runs: the commit packed into the host's mirror, the warm image loaded there, the
// trial launcher run over SSH, output and records back. The workload is the hard-math benchmark: each
// test file computes the pinned SymPy oracle's root intervals for its slice of the 24 v1 polynomials and
// has the oracle verify them. Only Docker is a stand-in on both hosts (see helpers/shard-hosts.ts): the trial
// container has no Docker daemon, so the dedicated rootless user and real container isolation are
// observed after deploy on the operator's hosts (AC-4); here the shim's refusals are. A
// trial image from before openssh-server was added has no sshd: there the fixture's ssh stand-in reaches
// the same shim in the same host folders.

const proof = 'e2e:two-host-trial';
const image = 'graphyard-trial:two-host';
const files = Array.from({ length: 8 }, (_, index) => `tests/math-${index}.test.ts`);
let hosts: ShardHostsFixture, second: { target: string; kill(): void; start(): Promise<void> }, target: string, repository: { root: string; sha: string }, answers: string, slow: string;
const previous = process.env.GRAPHYARD_TRIAL_IMAGE;

before(async () => {
  hosts = await shardHosts('two-host-trial', ['loopback'], { [image]: `sha256:${'7a7a'.repeat(16)}` });
  if (spawnSync('sh', ['-c', 'command -v sshd || test -x /usr/sbin/sshd']).status === 0) {
    const server = await sshdHost(hosts.root, hosts.shim, hosts.home('loopback'), join(hosts.root, 'hosts', 'loopback', 'bin'), hosts.bin);
    second = { target: `${server.user}@127.0.0.1`, kill: server.kill, start: server.start };
  } else second = { target: 'gy-compute@loopback', kill: () => killTrees((_, cwd) => cwd.startsWith(hosts.home('loopback'))), start: async () => {} };
  target = second.target;
  const python = await pinnedPython(await temporaryDirectory('two-host-oracle'));
  answers = join(hosts.root, 'answers.jsonl'); slow = join(hosts.root, 'slow');
  const samples = [1, 2, 3].flatMap(seed => generate(seed));
  // Each file holds three polynomials; the runner asks the oracle for their isolating intervals, then has it verify them.
  const runner = `import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const remote = process.cwd().includes('/.graphyard/runs/');
if (remote && existsSync(${JSON.stringify(slow)})) { appendFileSync(${JSON.stringify(slow)}, 'started\\n'); execFileSync('sleep', ['60']); }
const oracle = lines => execFileSync(${JSON.stringify(python)}, ['oracle/verify.py'], { input: lines.map(line => JSON.stringify(line)).join('\\n') + '\\n', encoding: 'utf8' }).trim().split('\\n').map(line => JSON.parse(line));
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  const requests = JSON.parse(readFileSync(file, 'utf8'));
  const roots = oracle(requests.map(request => ({ request, reference: true })));
  const checked = oracle(requests.map((request, index) => ({ request, output: roots[index] })));
  const passed = checked.every(result => result.pass === true);
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, remote, answer: createHash('sha256').update(JSON.stringify(roots)).digest('hex'), passed }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed, durationMs: 1 }) + '\\n');
  console.log((passed ? 'ok ' : 'not ok ') + file + (remote ? ' on the second host' : ' here'));
}
`;
  repository = await shardRepository('two-host-repo', [], {
    'scripts/tests.mjs': runner, 'oracle/verify.py': await readFile(oracleSource, 'utf8'),
    ...Object.fromEntries(files.map((file, index) => [file, JSON.stringify(samples.slice(index * 3, index * 3 + 3).map(({ coefficients, precisionBits }) => ({ coefficients, precisionBits })))])),
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
async function trial(remote: string[], timings: string[] = []) {
  await rm(answers, { force: true });
  const result = await runTrial({ root: repository.root, base: await temporaryDirectory('two-host-base'), mergeSha: repository.sha, changedFiles: files, timeoutMs: 240_000, cores: 2, run, retries: 0,
    onTiming: step => timings.push(step),
    remote: { hosts: remote, read: async named => (await readShardHosts(named, run, 2)).map(reading => ({ ...reading, cores: reading.away ? 0 : 2, busy: 0, steal: 0, celsius: null })) } });
  const lines = existsSync(answers) ? (await readFile(answers, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; remote: boolean; answer: string; passed: boolean }) : [];
  return { result, lines, byFile: Object.fromEntries(lines.map(line => [line.file, line.answer])) };
}

test(`${proof} — shards split across both hosts; the verdict and the oracle-checked hard-math answers equal a one-host run; logs return`, { timeout: 600_000 }, async () => {
  const one = await trial([]);
  assert.equal(one.result.build, 'pass', one.result.logTail);
  assert.deepEqual({ passed: one.result.tests.passed, failed: one.result.tests.failed }, { passed: files.length, failed: [] }, one.result.logTail);
  assert.equal(one.lines.length, files.length);
  assert.ok(one.lines.every(line => line.passed && !line.remote), 'the oracle verified every answer on this machine');

  const timings: string[] = [];
  const two = await trial([target], timings);
  assert.equal(two.result.build, 'pass', two.result.logTail);
  assert.deepEqual({ passed: two.result.tests.passed, failed: two.result.tests.failed, files: two.result.tests.files }, { passed: one.result.tests.passed, failed: [], files: one.result.tests.files }, two.result.logTail);
  const remote = two.lines.filter(line => line.remote);
  assert.ok(remote.length > 0 && remote.length < files.length, `shards split across both hosts: ${JSON.stringify(two.lines)}`);
  assert.ok(timings.some(step => step.endsWith(` on ${target}`)), timings.join(', '));
  assert.deepEqual(two.byFile, one.byFile, 'the hard-math answers are identical to the one-host run');
  assert.ok(two.lines.every(line => line.passed), 'and the oracle verified each on the host that computed it');
  assert.match(two.result.logTail ?? '', /on the second host/, 'the second host\'s output returns into the trial log');
  const [record] = readRemoteShardRuns(repository.root).slice(-1);
  assert.equal(record!.remote, timings.filter(step => step.endsWith(` on ${target}`)).length, 'the record counts the shards the second host ran');
  assert.deepEqual(remoteShardSummary(readRemoteShardRuns(repository.root))!.hosts.map(host => host.state), ['ready', 'ready']);
  assert.ok(existsSync(join(hosts.home('loopback'), '.graphyard', 'mirrors')), 'the commit reached the second host\'s own mirror');
});

test(`${proof} — killing the second host's SSH mid-shard re-queues that shard on this machine with no fault`, { timeout: 600_000 }, async () => {
  await writeFile(slow, '');
  const waiting = (async () => {
    while (!(await readFile(slow, 'utf8').catch(() => '')).includes('started')) await new Promise(resolve => setTimeout(resolve, 100));
    second.kill();
  })();
  try {
    const killed = await trial([target]);
    await waiting;
    assert.equal(killed.result.build, 'pass', killed.result.logTail);
    assert.deepEqual({ passed: killed.result.tests.passed, failed: killed.result.tests.failed }, { passed: files.length, failed: [] }, killed.result.logTail);
    assert.match(killed.result.logTail ?? '', new RegExp(`\\[remote\\] host ${target.replace(/\./g, '\\.')} dropped a shard: .*its shard runs on another host`, 's'));
    assert.ok(killed.lines.filter(line => !line.remote).length === files.length, 'every file finally ran on this machine');
    const host = remoteShardSummary(readRemoteShardRuns(repository.root))!.hosts.at(-1)!;
    assert.equal(host.state, 'away');
    assert.ok(host.reason?.trim(), 'master status keeps the dropped host’s SSH failure text');
    assert.ok(killed.result.logTail?.includes(host.reason!), 'status and the trial log carry the same failure');
  } finally { await rm(slow, { force: true }); await second.start(); }
});

test(`${proof} — over the second host's key a plain shell command, a read outside the run directory and a run-shard request mounting the root filesystem are refused by the shim before any Docker runs`, { timeout: 120_000 }, async () => {
  const run = 'trial-refusals';
  await mkdir(join(hosts.home('loopback'), '.graphyard', 'runs', run, 'repo'), { recursive: true });
  const docker = join(hosts.root, 'hosts', 'loopback', 'docker');
  const calls = dockerEveryCall(docker).length, creates = (await dockerCreates(docker)).length;
  const asks: Array<[string, string?]> = [
    ['echo graphyard-plain-shell'],
    ['cat /etc/passwd'],
    [`fetch-records ${run}/../../.. 1`],
    ['fetch-records ../../.ssh 1'],
    [`run-shard ${run} 1`, JSON.stringify({ files: ['tests/math-0.test.ts'], argv: ['node', 'scripts/tests.mjs'], cpus: 1, deadline: Date.now() + 60_000, mounts: [['/', '/host', false]] })],
  ];
  for (const [command, input] of asks) {
    const result = spawnSync(join(hosts.bin, 'ssh'), ['-o', 'BatchMode=yes', target, command], { encoding: 'utf8', input: input ?? '' });
    assert.equal(result.status, 1, `${command}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, '', command);
    assert.match(result.stderr, /graphyard-host-shim refuses/, command);
  }
  assert.equal(dockerEveryCall(docker).length, calls, 'no Docker call was made for a refused request');
  assert.equal((await dockerCreates(docker)).length, creates, 'and no container was created');
  const shards = await dockerCreates(docker);
  assert.ok(shards.length > 0 && shards.every(create => create.includes('--network=none') && create.includes('--cap-drop=ALL') && !create.join(' ').includes('apparmor=unconfined')), 'the shards the second host did run had no network and kept their confinement');
  assert.equal(execFileSync('id', ['-u'], { encoding: 'utf8' }).trim() === '0', false, 'the host user is not root');
});
