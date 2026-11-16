import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { HostDroppedError, mirrorPath, readRemoteShardRuns, remoteShardSession, remoteShardSummary, type HostReading } from '../src/merge-writer/remote-shards.js';
import { runTrial, runnerRecords } from '../src/merge-writer/trial.js';

// GY-3406: a remote shard host is a Linux box reached over SSH that runs Docker. Here SSH is a shim
// that runs the remote command in the host's own home directory, and that host's Docker is a fake
// keeping its images and containers in a state file and running each container's command in its
// working directory, so the real transport — the commit sent as a pack into the per-repo mirror, docker save | load,
// the warm dependency image, the trial launcher, output and records brought back — runs end to end.

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const image = 'graphyard-trial:remote-fixture', digest = `sha256:${'ab12'.repeat(16)}`;

/** A fake Docker CLI keeping its state under `state`: inspect, pull (always refused), save, load, run (install), commit, create, start, rm. */
const dockerShim = (state: string) => `#!/usr/bin/python3
import fcntl, hashlib, json, os, subprocess, sys
STATE = ${JSON.stringify(state)}
args = sys.argv[1:]
if args[:1] == ['--host']:
    args = args[2:]
os.makedirs(STATE, exist_ok=True)
lock = open(os.path.join(STATE, 'lock'), 'w')
fcntl.flock(lock, fcntl.LOCK_EX)
path = os.path.join(STATE, 'state.json')
s = json.load(open(path)) if os.path.exists(path) else {'images': {}, 'containers': {}}
def save():
    json.dump(s, open(path, 'w'))
def log(word):
    open(os.path.join(STATE, 'calls.log'), 'a').write(word + '\\n')
command = args[0]
if command == 'image':
    name = args[-1]
    if name not in s['images']:
        sys.exit('Error: No such image: ' + name)
    print(s['images'][name])
elif command == 'pull':
    log('pull')
    sys.exit('Error response from daemon: pull access denied')
elif command == 'save':
    log('save')
    print(json.dumps({'name': args[-1], 'id': s['images'][args[-1]]}))
elif command == 'load':
    log('load')
    data = json.loads(sys.stdin.read())
    s['images'][data['name']] = data['id']
    save()
elif command == 'run':
    log('install')
    s['containers'][args[args.index('--name') + 1]] = {}
    save()
elif command == 'commit':
    log('commit')
    s['images'][args[2]] = 'sha256:' + hashlib.sha256(args[2].encode()).hexdigest()
    save()
elif command == 'rm':
    for name in args[1:]:
        s['containers'].pop(name, None)
    save()
elif command == 'create':
    at = args.index('--entrypoint')
    env = dict(value.split('=', 1) for flag, value in zip(args, args[1:]) if flag == '--env')
    s['containers'][args[args.index('--name') + 1]] = {'workdir': args[args.index('--workdir') + 1], 'env': env, 'image': args[at + 2], 'command': [args[at + 1]] + args[at + 3:]}
    log('create ' + args[at + 2])
    save()
elif command == 'start':
    container = s['containers'][args[-1]]
    fcntl.flock(lock, fcntl.LOCK_UN)
    sys.exit(subprocess.call(container['command'], cwd=container['workdir'], env=container['env']))
`;
/** An SSH client shim: the destination names a directory under `hosts` that is the host's home; a `DEST.down` file makes the host unreachable (exit 255). */
const sshShim = (hosts: string, remoteBin: string) => `#!/usr/bin/python3
import os, sys
dest, command = sys.argv[-2], sys.argv[-1]
home = os.path.join(${JSON.stringify(hosts)}, dest)
if not os.path.isdir(home) or os.path.exists(home + '.down'):
    sys.stderr.write('ssh: connect to host ' + dest + ' port 22: Connection refused\\n')
    sys.exit(255)
os.chdir(home)
os.execve('/bin/sh', ['sh', '-c', command], dict(os.environ, HOME=home, PATH=${JSON.stringify(remoteBin)} + ':' + os.environ['PATH']))
`;
/** The repository's test runner: runs the files its list names, writes one record per file, and fails a file whose name says so. */
const runner = `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const files = readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean);
let failed = 0;
for (const file of files) { const passed = !file.includes('fails'); failed += passed ? 0 : 1; appendFileSync(at('--durations'), JSON.stringify({ file, passed, durationMs: 1 }) + '\\n'); console.log((passed ? 'ok ' : 'not ok ') + file + ' in ' + process.cwd()); }
process.exit(failed ? 1 : 0);
`;

let fixture: { dir: string; hosts: string; ssh: string; remoteState: string; localState: string };
const calls = (state: string) => existsSync(join(state, 'calls.log')) ? execFileSync('cat', [join(state, 'calls.log')], { encoding: 'utf8' }).split('\n').filter(Boolean) : [];
const count = (state: string, word: string) => calls(state).filter(entry => entry === word).length;

before(async () => {
  const dir = await temporaryDirectory('remote-shards');
  const hosts = join(dir, 'hosts'), remoteBin = join(dir, 'remote-bin'), localBin = join(dir, 'local-bin');
  const remoteState = join(dir, 'remote-docker'), localState = join(dir, 'local-docker');
  for (const directory of [join(hosts, 'box'), remoteBin, localBin, localState]) await mkdir(directory, { recursive: true });
  await writeFile(join(remoteBin, 'docker'), dockerShim(remoteState));
  await writeFile(join(localBin, 'docker'), dockerShim(localState));
  await writeFile(join(localState, 'state.json'), JSON.stringify({ images: { [image]: digest }, containers: {} }));
  const ssh = join(dir, 'ssh');
  await writeFile(ssh, sshShim(hosts, remoteBin));
  for (const file of [join(remoteBin, 'docker'), join(localBin, 'docker'), ssh]) await chmod(file, 0o755);
  process.env.PATH = `${localBin}:${process.env.PATH}`;
  fixture = { dir, hosts, ssh, remoteState, localState };
});

const files = Array.from({ length: 8 }, (_, index) => `tests/file-${index}.test.ts`);
async function repository(label: string) {
  const root = await temporaryDirectory(label);
  git(root, 'init', '-q', '-b', 'main');
  const content: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'true' } }),
    'package-lock.json': JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }),
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'test', command: 'node scripts/tests.mjs', source: 'script', reason: 'fixture', selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' } }] } } }),
    'scripts/select.mjs': '', 'scripts/tests.mjs': runner,
    ...Object.fromEntries(files.map(file => [file, 'fixture\n'])),
  };
  for (const [path, text] of Object.entries(content)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
  return { root, sha: git(root, 'rev-parse', 'HEAD') };
}
const commit = async (root: string, path: string, text: string) => { await writeFile(join(root, path), text); git(root, 'add', '-A'); git(root, 'commit', '-qm', `change ${path}`); return git(root, 'rev-parse', 'HEAD'); };
const box = { name: 'box', ssh: 'box' };
const reading = (name: string, cores: number): HostReading => ({ name, cores, busy: 0, steal: 0, celsius: 55, limit: 92, away: false });
const objects = (mirror: string) => { const lines = Object.fromEntries(git(mirror, 'count-objects', '-v').split('\n').map(line => line.split(': '))); return Number(lines.count) + Number(lines['in-pack']); };
const argv = (list: string, records: string) => ['node', 'scripts/tests.mjs', '--files-from', list, '--durations', records];

test('integration:remote-shard-transport — the commit reaches the host\'s per-repo mirror as a delta, the image loads once per digest, the warm dependency image is reused for the same digest and lockfile hash, and output and evidence come back', { timeout: 120_000 }, async () => {
  const { root, sha: first } = await repository('remote-transport-repo');
  const mirror = join(fixture.hosts, 'box', mirrorPath(root));
  const session = (sha: string) => remoteShardSession({ root, sha, image, run: defaultChildRun, ssh: fixture.ssh, deadline: Date.now() + 60_000 });

  const one = session(first);
  const ran = await one.run(box, reading('box', 4), 0, files.slice(0, 2), argv);
  assert.equal(ran.ok, true, ran.out);
  assert.match(ran.out, /ok tests\/file-0\.test\.ts in .*\/\.graphyard\/runs\/trial-/, 'the output comes back from the run directory on the host');
  assert.deepEqual(runnerRecords(ran.records), [{ file: files[0], passed: true }, { file: files[1], passed: true }], 'the per-file records come back');
  assert.equal(git(mirror, 'cat-file', '-t', first), 'commit', 'the commit is in the host\'s mirror');
  assert.deepEqual([count(fixture.remoteState, 'load'), count(fixture.remoteState, 'install'), count(fixture.remoteState, 'commit')], [1, 1, 1], calls(fixture.remoteState).join(' '));
  assert.ok(calls(fixture.remoteState).some(entry => entry.startsWith('create graphyard-warm:ab12ab12ab12-')), 'the shard ran in the warm dependency image');
  // A second shard of the same trial reuses the prepared host.
  const failing = await one.run(box, reading('box', 4), 1, ['tests/fails.test.ts'], argv);
  assert.equal(failing.ok, false);
  assert.equal(failing.status, 1);
  assert.deepEqual(runnerRecords(failing.records), [{ file: 'tests/fails.test.ts', passed: false }]);
  await one.close();
  assert.deepEqual(readdirSync(join(fixture.hosts, 'box', '.graphyard', 'runs')), [], 'the run directory is removed');

  // The next commit sends only the objects the mirror lacks; same image digest and lockfile: no load, no install.
  const second = await commit(root, 'tests/file-0.test.ts', 'changed\n');
  const held = objects(mirror), delta = git(root, 'rev-list', '--objects', `${first}..${second}`).split('\n').filter(Boolean).length;
  const two = session(second);
  assert.equal((await two.run(box, reading('box', 4), 0, files.slice(0, 1), argv)).ok, true);
  await two.close();
  assert.equal(objects(mirror) - held, delta, 'the push carried the delta only');
  assert.deepEqual([count(fixture.remoteState, 'load'), count(fixture.remoteState, 'install')], [1, 1], 'image and dependencies reused');

  // A new lockfile hash installs once more.
  const third = await commit(root, 'package-lock.json', JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { version: '2.0.0' } } }));
  const three = session(third);
  assert.equal((await three.run(box, reading('box', 4), 0, files.slice(0, 1), argv)).ok, true);
  await three.close();
  assert.deepEqual([count(fixture.remoteState, 'load'), count(fixture.remoteState, 'install')], [1, 2]);

  // An unreachable host turns the shard away as capacity, never a verdict.
  await writeFile(join(fixture.hosts, 'box.down'), '');
  try { await assert.rejects(session(third).run(box, reading('box', 4), 0, files.slice(0, 1), argv), HostDroppedError); }
  finally { await import('node:fs/promises').then(fs => fs.rm(join(fixture.hosts, 'box.down'))); }
});

test('e2e:remote-shards — a trial with two hosts runs its shards on both and reports one combined result and evidence; master status shows the share run remotely and trial wall time', { timeout: 120_000 }, async () => {
  const { root, sha } = await repository('remote-shards-trial');
  const base = await temporaryDirectory('remote-shards-base');
  const here: string[] = [];
  // This machine's shards run the same runner directly; everything else (git, ssh, docker) runs for real.
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
    if (command === 'node' && args[0] === 'scripts/tests.mjs') { here.push(args[args.indexOf('--files-from') + 1]!); return defaultChildRun(command, args, { ...options, wrapper: undefined }); }
    return defaultChildRun(command, args, options);
  };
  const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
  const timings: string[] = [];
  try {
    const result = await runTrial({ root, base, mergeSha: sha, changedFiles: files, timeoutMs: 90_000, cores: 2, run, retries: 0, onTiming: step => timings.push(step),
      remote: { hosts: [box], ssh: fixture.ssh, read: async () => [reading('vishrog', 2), reading('box', 4)] } });
    assert.equal(result.build, 'pass', result.logTail);
    assert.deepEqual({ passed: result.tests.passed, failed: result.tests.failed, files: result.tests.files }, { passed: files.length, failed: [], files: files.length }, result.logTail);
    const remote = timings.filter(step => /^tests: shard \d+ on box$/.test(step)), local = timings.filter(step => /^tests: shard \d+$/.test(step));
    assert.ok(remote.length > 0 && local.length > 0, `shards ran on both hosts: ${timings.join(', ')}`);
    assert.equal(here.length, local.length);
    assert.deepEqual(result.groups!.flatMap(group => group.files).sort(), [...files].sort(), 'one combined result covers every file once');
    const runs = readRemoteShardRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.shards, remote.length + local.length);
    assert.equal(runs[0]!.remote, remote.length);
    const status = remoteShardSummary(runs)!;
    assert.equal(status.shardsRemote, `${Math.round(remote.length / (remote.length + local.length) * 100)}%`);
    assert.equal(typeof status.trialWallSeconds.median, 'number');
    assert.equal(status.queuedWhileHostIdle, 0);
    assert.deepEqual(status.peakCelsius, { host: 'vishrog', celsius: 55 });
    assert.deepEqual(status.hosts.map(host => [host.name, host.state]), [['vishrog', 'ready'], ['box', 'ready']]);
    assert.ok(JSON.parse(await readFile(join(fixture.remoteState, 'state.json'), 'utf8')).images[image], 'the trial image reached the host');
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; }
});
