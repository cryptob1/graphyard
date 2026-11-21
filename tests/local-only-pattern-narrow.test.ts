import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { localOnlyTestPattern, readRemoteShardRuns, remoteShardSummary, remoteableTestFile, type HostReading } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardHosts, shardRepository } from './helpers/shard-hosts.js';

// GY-3522: the local-only word list named every network word (url, http, server, fetch, connect…),
// which kept nine test files in ten on this machine while the added hosts idled. It names only what
// a host's shard truly lacks: the database, Docker, nested confinement and browsers.

const repo = new URL('..', import.meta.url).pathname;
const networkOnly = 'const server = createServer().listen(0);\nconst response = await fetch(new URL("http://127.0.0.1/sign-in"));\nsocket.connect(port);\n';

test('unit:local-only-pattern-narrow — only database, Docker, confinement and browser words keep a file local; url, http, server, fetch or connect alone do not', () => {
  assert.equal(localOnlyTestPattern.source, 'postgres|withDatabase|docker|bwrap|unshare|landlock|hard-math|playwright|chromium');
  for (const word of ['url', 'http', 'server', 'fetch', 'connect']) assert.equal(remoteableTestFile(`test("${word}", () => ${word}())\n`), true, `${word} alone is remoteable`);
  assert.equal(remoteableTestFile(networkOnly), true);
  for (const word of ['postgres', 'withDatabase', 'docker', 'bwrap', 'unshare', 'landlock', 'playwright', 'chromium']) assert.equal(remoteableTestFile(`${networkOnly}${word}\n`), false, `${word} stays local`);
});

test('unit:local-only-pattern-narrow — at least half of the real test files are remoteable', async () => {
  let remoteable = 0, total = 0;
  for (const name of await readdir(join(repo, 'tests'))) {
    if (!name.endsWith('.test.ts')) continue;
    total++;
    if (remoteableTestFile(await readFile(join(repo, 'tests', name), 'utf8'))) remoteable++;
  }
  assert.ok(total > 600 && remoteable >= total / 2, `${remoteable} of ${total} test files are remoteable`);
});

test('e2e:local-only-pattern-narrow — master status remoteShards shows a trial placing most shards on a ready added host', { timeout: 300_000 }, async () => {
  const image = 'graphyard-trial:pattern-narrow-fixture';
  const hosts = await shardHosts('pattern-narrow', ['box'], { [image]: `sha256:${'3522'.repeat(16)}` });
  const network = Array.from({ length: 8 }, (_, index) => `tests/calls-server-${index}.test.ts`);
  const docker = ['tests/uses-docker.test.ts'];
  const files = [...network, ...docker];
  const answers = join(hosts.root, 'answers.jsonl');
  const { root, sha } = await shardRepository('pattern-narrow-repo', [], {
    'scripts/tests.mjs': `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const remote = process.cwd().includes('/.graphyard/runs/');
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, remote }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
}
`,
    ...Object.fromEntries([...network.map(file => [file, networkOnly]), ...docker.map(file => [file, 'import { docker } from "docker"\n'])]),
  });
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
    if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, wrapper: undefined });
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  const reading = (name: string, cores: number, busy: number): HostReading => ({ name, cores, busy, steal: 0, celsius: 60, limit: 92, away: false });
  const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
  try {
    const result = await runTrial({ root, base: await temporaryDirectory('pattern-narrow-base'), mergeSha: sha, changedFiles: files, timeoutMs: 240_000, cores: 2, run, retries: 0,
      remote: { hosts: ['gy-compute@box'], read: async () => [reading('vishrog', 2, 2), reading('gy-compute@box', 8, 0)] } });
    assert.deepEqual({ build: result.build, failed: result.tests.failed, files: result.tests.files }, { build: 'pass', failed: [], files: files.length }, result.logTail);
    const lines = (await readFile(answers, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; remote: boolean });
    assert.ok(lines.filter(line => network.includes(line.file)).every(line => line.remote), `the files naming only network words ran on the host: ${JSON.stringify(lines)}`);
    assert.ok(lines.filter(line => docker.includes(line.file)).every(line => !line.remote), 'the Docker file ran here');
    const status = remoteShardSummary(readRemoteShardRuns(root))!;
    assert.ok(status.latest.remote > status.latest.shards / 2, `most shards ran remotely: ${JSON.stringify(status.latest)}`);
    assert.deepEqual(status.hosts.map(host => [host.name, host.state]), [['vishrog', 'ready'], ['gy-compute@box', 'ready']]);
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; }
});
