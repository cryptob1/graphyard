import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostPrepareScript } from '../src/hosts.js';
import { remoteShardSession, type HostReading } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { trialAppArmorProfile, trialAppArmorProfilePath } from '../src/merge-writer/trial-apparmor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dockerCreates, git, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3549: a shard on a compute host may start nested sandboxes, as a local trial can: its container
// gets Docker's seccomp and system paths unconfined (and the graphyard-trial AppArmor profile where the
// host's Docker uses AppArmor), and keeps rootless Docker, a read-only root, no capabilities, no new
// privileges, no network and its CPU, memory and process limits. Docker is the fixture's stand-in.

const image = 'graphyard-trial:allow-sandbox';
const source = fileURLToPath(new URL('..', import.meta.url));
let hosts: ShardHostsFixture;
before(async () => {
  hosts = await shardHosts('remote-shards-allow-sandbox', ['box'], { [image]: `sha256:${'5b5b'.repeat(16)}` });
});

test('integration:remote-shards-allow-sandbox — the remote launcher lets a shard start bubblewrap and keeps its confinement and resource limits; host prepare loads the trial AppArmor profile', { timeout: 60_000 }, async () => {
  const { root, sha } = await shardRepository('allow-sandbox-repo', ['tests/a.test.ts']);
  const previous = process.env.PATH;
  process.env.PATH = `${hosts.bin}:${previous}`;
  const session = remoteShardSession({ root, sha, image, run: defaultChildRun, deadline: Date.now() + 50_000 });
  try {
    const ended = await session.run('gy-compute@box', 0, ['tests/a.test.ts'], (_list, records) => ['node', '-e', "require('node:fs').writeFileSync(process.argv[1], '')", records], 2);
    assert.equal(ended.ok, true, ended.out);
  } finally { await session.close(); process.env.PATH = previous; }
  const [create] = await dockerCreates(hosts.state('box'));
  const words = create!.join(' ');
  for (const flag of ['--security-opt=seccomp=unconfined', '--security-opt=systempaths=unconfined',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=none', '--pids-limit=4096']) assert.ok(words.includes(flag), `${flag}: ${words}`);
  assert.match(words, /--cpus=\d+ /);
  assert.match(words, /--memory=\d+m /);
  assert.match(words, new RegExp(`--host unix:///run/user/${process.getuid!()}/docker\\.sock`), 'the user\'s rootless Docker');
  assert.doesNotMatch(words, /privileged|docker\.sock,|apparmor=unconfined|--cap-add/);

  const script = hostPrepareScript('ssh-ed25519 AAAAC3NzaOperatorKey operator@vishrog');
  const guard = script.indexOf('/sys/module/apparmor/parameters/enabled');
  assert.ok(guard > 0, 'host prepare asks whether the host enforces AppArmor');
  assert.ok(script.indexOf(`apparmor_parser -r -W ${trialAppArmorProfilePath}`) > guard, 'and then loads the trial profile');
  assert.match(script, new RegExp(`profile ${trialAppArmorProfile} flags=\\(unconfined\\) \\{\\s+userns,\\s+\\}`));
});

test('e2e:remote-shards-allow-sandbox — a trial with one ready compute host runs tests/trial-runtime.test.ts on that host and it passes', { timeout: 600_000 }, async () => {
  const file = 'tests/trial-runtime.test.ts';
  const loader = import.meta.resolve('tsx');
  const answers = join(hosts.root, 'trial-runtime-answers.jsonl');
  // The runner runs each listed file with Node's test runner and records where it ran and whether it passed.
  const runner = `import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const remote = process.cwd().includes('/.graphyard/runs/');
let failed = 0;
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  const ran = spawnSync(process.execPath, ['--import', ${JSON.stringify(loader)}, '--test', file], { encoding: 'utf8' });
  const passed = ran.status === 0; failed += passed ? 0 : 1;
  console.log(ran.stdout + ran.stderr);
  console.log((passed ? 'ok ' : 'not ok ') + file + (remote ? ' on the host' : ' here'));
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, remote, passed }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed, durationMs: 1 }) + '\\n');
}
process.exit(failed ? 1 : 0);
`;
  const repository = await shardRepository('allow-sandbox-trial-runtime', [], { 'package.json': JSON.stringify({ name: 'fixture', type: 'module', scripts: { build: 'true' } }), 'scripts/tests.mjs': runner, [file]: readFileSync(join(source, file), 'utf8') });
  // The test file is the real one, byte for byte; its imports reach this checkout's sources through links.
  for (const path of ['src', 'tests/helpers']) symlinkSync(join(source, path), join(repository.root, path));
  git(repository.root, 'add', '-A'); git(repository.root, 'commit', '-qm', 'link the sources');
  const sha = git(repository.root, 'rev-parse', 'HEAD');
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node' && args[0] === 'scripts/select.mjs') return file;
    if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, wrapper: undefined });
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  const reading = (name: string, cores: number): HostReading => ({ name, cores, busy: 0, steal: 0, celsius: 60, limit: 92, away: false });
  const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
  const timings: string[] = [];
  try {
    const result = await runTrial({ root: repository.root, base: await temporaryDirectory('allow-sandbox-base'), mergeSha: sha, changedFiles: [file], timeoutMs: 400_000, cores: 2, run, retries: 0,
      onTiming: step => timings.push(step), remote: { hosts: ['gy-compute@box'], read: async () => [reading('this-machine', 2), reading('gy-compute@box', 8)] } });
    const lines = (await readFile(answers, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; remote: boolean; passed: boolean });
    assert.deepEqual(lines, [{ file, remote: true, passed: true }], result.logTail);
    assert.ok(timings.some(step => /^tests: shard \d+ on gy-compute@box$/.test(step)), timings.join(', '));
    assert.equal(result.build, 'pass', result.logTail);
    assert.deepEqual({ passed: result.tests.passed, failed: result.tests.failed }, { passed: 1, failed: [] }, result.logTail);
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; }
});
