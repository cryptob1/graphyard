import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { localOnlyTestPattern, realFreeCores, remoteableTestFile, runShardsOnHosts, splitLocalOnlyTests, type HostReading, type PlacedHost } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardHosts, shardRepository } from './helpers/shard-hosts.js';

// GY-3419: test files that need the Docker socket or the network are local-only (GY-3549: bwrap may run remotely):
// a shard on an added host runs with no network and no Docker socket, so such a file there would
// fail as a red verdict that measures neither the merge nor the host. With a remote host registered,
// placement always keeps them on this machine; every other file may still go remote.

const proof = 'integration:local-only-tests';
const reading = (name: string, cores: number, busy: number): HostReading => ({ name, cores, busy, steal: 0, celsius: 60, limit: 92, away: false });
const place = (name: string, cores: number, busy: number): PlacedHost<string> => ({ name, remote: name === 'vishrog' ? undefined : name, reading: reading(name, cores, busy), room: cores - busy });

test(`${proof} — a shard pinned local never reaches a host, however free it is; every other shard still may`, async () => {
  const hosts = [place('vishrog', 4, 2), place('spare-box', 32, 0)];
  const started: { host: string; index: number }[] = [];
  const pinned = [false, true, false, true];
  await runShardsOnHosts({ count: pinned.length, hosts, breadth: 1, pinned, run: async (host, index) => { started.push({ host: host.name, index }); } });
  assert.deepEqual(started.filter(entry => pinned[entry.index]).map(entry => entry.host), ['vishrog', 'vishrog'], 'pinned shards ran only on this machine');
  assert.ok(started.filter(entry => !pinned[entry.index]).every(entry => entry.host === 'spare-box'), 'the unpinned shards still took the freer host');
});

test(`${proof} — a file naming docker stays local-only; one whose text cannot be read stays local-only too, the safe side`, async () => {
  assert.equal(remoteableTestFile('import { docker } from "docker"\n'), false);
  assert.equal(remoteableTestFile('const response = await fetch("http://127.0.0.1:4310/sign-in")\n'), false);
  assert.equal(remoteableTestFile('test("adds numbers", () => equal(1 + 1, 2))\n'), true);
  const split = await splitLocalOnlyTests(['tests/reads.test.ts', 'tests/gone.test.ts', 'tests/pure.test.ts'], async file => file === 'tests/gone.test.ts' ? Promise.reject(new Error('gone')) : file === 'tests/pure.test.ts' ? Promise.resolve('equal(1, 1)') : Promise.resolve('docker'));
  assert.deepEqual(split, { remoteable: ['tests/pure.test.ts'], localOnly: ['tests/reads.test.ts', 'tests/gone.test.ts'] });
});

test(`${proof} — in a trial with a remote host registered, files marked local-only are always placed on this machine and the rest may go remote, so the verdict carries no false failure`, { timeout: 120_000 }, async () => {
  const image = 'graphyard-trial:local-only-fixture';
  const hosts = await shardHosts('local-only-trial', ['box'], { [image]: `sha256:${'31d9'.repeat(16)}` });
  const pure = Array.from({ length: 4 }, (_, index) => `tests/plain-${index}.test.ts`);
  const docker = Array.from({ length: 4 }, (_, index) => `tests/uses-docker-${index}.test.ts`);
  const files = [...pure, ...docker];
  // On the host, a file that needs Docker fails exactly as it would there: no Docker socket, so a
  // red verdict that measures nothing. Here it passes.
  const answers = join(hosts.root, 'answers.jsonl');
  const { root, sha } = await shardRepository('local-only-repo', [], {
    'scripts/tests.mjs': `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const remote = process.cwd().includes('/.graphyard/runs/');
let failed = 0;
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  const passed = !(remote && file.includes('uses-docker'));
  if (!passed) { console.log('docker: Cannot connect to the Docker daemon at unix:///run/user/1000/docker.sock: ' + file); failed++; }
  else console.log('ok ' + file + (remote ? ' on the host' : ' here'));
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, remote, passed }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed, durationMs: 1 }) + '\\n');
}
process.exit(failed ? 1 : 0);
`,
    // The local-only files name Docker in their own text; the pure ones name none of the words.
    ...Object.fromEntries([...pure.map(file => [file, 'test("adds", () => equal(1 + 1, 2))\n']), ...docker.map(file => [file, 'import { docker } from "docker"\ntest("runs a container", () => docker.run("alpine"))\n'])]),
  });
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
    const result = await runTrial({ root, base: await temporaryDirectory('local-only-base'), mergeSha: sha, changedFiles: files, timeoutMs: 90_000, cores: 2, run, retries: 0, onTiming: step => timings.push(step),
      remote: { hosts: ['gy-compute@box'], read: async () => [reading('vishrog', 2, 0), reading('gy-compute@box', 8, 0)] } });
    assert.equal(result.build, 'pass', result.logTail);
    assert.deepEqual({ passed: result.tests.passed, failed: result.tests.failed, files: result.tests.files }, { passed: files.length, failed: [], files: files.length }, result.logTail);
    const lines = (await readFile(answers, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; remote: boolean; passed: boolean });
    assert.ok(lines.every(line => line.passed), 'no false failure from the host that has no Docker socket');
    assert.ok(lines.filter(line => line.file.includes('uses-docker')).every(line => !line.remote), 'every local-only file ran on this machine');
    assert.ok(lines.some(line => line.remote), 'and other files still went to the host');
    assert.ok(timings.some(step => /^tests: shard \d+ on gy-compute@box$/.test(step)), timings.join(', '));
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; }
});

test(`${proof} — the marking covers every current test file that uses docker or the network`, async () => {
  // The generous reading of the criterion's own words: any test file naming Docker, or the
  // machinery of the network — servers, sockets, requests, databases, SSH, browsers, e2e — must be
  // marked local-only, or a shard sent to a host would fail it there.
  const uses = /docker|compose|network|socket|ssh|postgres|mysql|redis|database|withDatabase|server|listen|connect|fetch|http|browser|playwright|e2e/i;
  let marked = 0, total = 0;
  for (const [directory, pattern] of [['tests', /\.test\.ts$/], ['browser-tests', /\.spec\.ts$/]] as const) {
    for (const name of await readdir(new URL(`../${directory}`, import.meta.url).pathname)) {
      if (!pattern.test(name)) continue;
      total++;
      const text = await readFile(join(new URL(`../${directory}`, import.meta.url).pathname, name), 'utf8');
      if (!localOnlyTestPattern.test(text)) assert.ok(!uses.test(text), `${directory}/${name} uses docker or the network, so it must be marked local-only`);
      else marked++;
    }
  }
  assert.ok(total > 600 && marked > total / 2, `${total} files read, ${marked} marked local-only`);
  for (const known of ['tests/two-host-trial.test.ts', 'tests/host-security.test.ts', 'tests/remote-shard-placement.test.ts', 'tests/compose-safe-directory.test.ts', 'tests/trial-container-apparmor.test.ts']) {
    assert.match(await readFile(join(new URL('..', import.meta.url).pathname, known), 'utf8'), localOnlyTestPattern, `${known} is local-only`);
  }
});

test(`${proof} — placement still prefers the host with the most real free CPU for shards that may roam`, async () => {
  const hosts = [place('vishrog', 8, 6), place('spare-box', 12, 3)];
  const started: string[] = [];
  await runShardsOnHosts({ count: 1, hosts, breadth: 1, run: async host => { started.push(host.name); } });
  assert.deepEqual(started, ['spare-box']);
  assert.equal(realFreeCores(hosts[1]!.reading), 9);
});
