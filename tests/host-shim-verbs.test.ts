import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { defaultChildRun } from '../src/child-runner.js';
import { hostPrepareScript } from '../src/hosts.js';
import { remoteShardSession } from '../src/merge-writer/remote-shards.js';
import { dockerCreates, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3412 AC-6: Graphyard uses a host's compute and can reach nothing else. This machine's key runs only
// graphyard-host-shim as the unprivileged gy-compute user; the shim answers its fixed verbs with
// validated arguments and refuses everything else; a shard container runs without the network, under
// CPU, memory and process limits and only its run directory; seccomp and system paths are unconfined for nested sandboxes (GY-3549).

const proof = 'integration:host-shim-verbs';
const image = 'graphyard-trial:shim-fixture';
let hosts: ShardHostsFixture;
before(async () => {
  hosts = await shardHosts('host-shim-verbs', ['box'], { [image]: `sha256:${'ef56'.repeat(16)}` });
  process.env.PATH = `${hosts.bin}:${process.env.PATH}`;
});
const shim = (command: string) => spawnSync(hosts.shim, ['--home', hosts.home('box')], {
  encoding: 'utf8', env: { PATH: `${join(hosts.root, 'hosts', 'box', 'bin')}:/usr/bin:/bin`, HOME: hosts.home('box'), SSH_ORIGINAL_COMMAND: command, GRAPHYARD_HOST_FLOOR_GB: '0' } });

test(`${proof} — host prepare installs the shim as the only command of this machine's key, for gy-compute outside the docker group`, () => {
  const script = hostPrepareScript('ssh-ed25519 AAAAC3NzaOperatorKey operator@vishrog');
  assert.match(script, /'restrict,command="graphyard-host-shim" ssh-ed25519 AAAAC3NzaOperatorKey operator@vishrog' > "\$home\/\.ssh\/authorized_keys"/);
  assert.match(script, /gpasswd -d "\$user" docker/);
  // GY-3419: the host's own tools when both are installed, else the static extras fetched into the home; either way the install runs.
  assert.match(script, /"\$setuptool" install/, 'rootless Docker');
  const installed = /<<'GRAPHYARD_SHIM'\n([\s\S]*?)GRAPHYARD_SHIM\n/.exec(script)![1]!;
  assert.equal(spawnSync('sh', ['-n'], { input: installed }).status, 0, 'the installed shim is valid sh');
  const verbs = /<<'GRAPHYARD_VERBS'\n([\s\S]*?)GRAPHYARD_VERBS\n/.exec(installed)![1]!;
  assert.equal(spawnSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: verbs }).status, 0, 'its verbs are valid Python');
});

test(`${proof} — a plain shell command, another user's files, docker run with the root filesystem and any malformed verb are refused`, () => {
  for (const command of ['', 'sh', 'bash -i', 'echo graphyard-plain-shell', 'cat /home/vish/.ssh/id_ed25519', 'ls /root', 'docker run -v /:/host alpine cat /host/etc/shadow',
    'probe; sh', 'probe  x', 'receive-pack ../../etc 0123456789abcdef0123456789abcdef01234567', 'receive-pack repo $(id)', 'receive-image alpine:latest',
    'prepare-run repo 0123456789abcdef0123456789abcdef01234567 alpine', 'run-shard ../../.ssh 1', 'run-shard trial-abcdef 0', 'fetch-records trial-abcdef/../.. 1', 'clean /', 'clean trial-abcdef extra']) {
    const result = shim(command);
    assert.equal(result.status, 1, command); assert.equal(result.stdout, '', command);
    assert.match(result.stderr, /graphyard-host-shim refuses/, command);
  }
  const extra = spawnSync(hosts.shim, ['-c', 'id'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: 'probe' } });
  assert.equal(extra.status, 1, 'the shim takes no arguments beyond its host folder');
  assert.match(shim('probe').stdout, /^cores \d+$/m);
});

test(`${proof} — a shard runs through the trial launcher in its run directory alone, with no network, CPU, memory and process limits, and reaches no private address, the tailnet or the host`, { timeout: 60_000 }, async () => {
  const listening: Server = await new Promise(resolve => { const server = createServer(socket => socket.end('host answered\n')).listen(0, '127.0.0.1', () => resolve(server)); });
  const port = (listening.address() as { port: number }).port;
  const { root, sha } = await shardRepository('host-shim-verbs-repo', ['tests/a.test.ts']);
  const homeMode = (await stat(hosts.home('box'))).mode;
  const session = remoteShardSession({ root, sha, image, run: defaultChildRun, deadline: Date.now() + 50_000 });
  // The shard tries a private-range address, the tailnet range and this host; each must fail.
  const reach = `const net = require('node:net'); const targets = [['10.0.0.1', 80], ['192.168.1.1', 80], ['100.64.0.1', 80], ['127.0.0.1', ${port}]];
let left = targets.length; for (const [host, port] of targets) { const socket = net.connect({ host, port, timeout: 2000 });
socket.on('connect', () => { console.log('reached ' + host); process.exitCode = 3; socket.destroy(); }); socket.on('data', () => {});
const done = (why) => { console.log('blocked ' + host + ' ' + why); socket.destroy(); if (--left === 0) require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ file: 'tests/a.test.ts', passed: process.exitCode !== 3, durationMs: 1 }) + '\\n'); };
socket.on('error', error => done(error.code)); socket.on('timeout', () => done('timeout')); }`;
  try {
    const ended = await session.run('gy-compute@box', 0, ['tests/a.test.ts'], (_list, records) => ['node', '-e', reach, records], 64);
    assert.equal(ended.ok, true, ended.out);
    for (const host of ['10.0.0.1', '192.168.1.1', '100.64.0.1', '127.0.0.1']) assert.match(ended.out, new RegExp(`^blocked ${host.replace(/\./g, '\\.')} `, 'm'), ended.out);
    const [create] = await dockerCreates(hosts.state('box'));
    const words = create!.join(' ');
    for (const flag of ['--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--pids-limit=4096', '--user 1000:0']) assert.ok(words.includes(flag), `${flag}: ${words}`);
    assert.match(words, /--cpus=\d+ /);
    assert.ok(Number(/--cpus=(\d+)/.exec(words)![1]) <= Number(/^cores (\d+)$/m.exec(shim('probe').stdout)![1]), 'CPUs are clamped to the host\'s cores');
    assert.match(words, /--memory=\d+m /);
    assert.doesNotMatch(words, /apparmor=unconfined|docker\.sock,|privileged|--network=(?!none)/, 'never AppArmor unconfined, never the Docker socket or a network');
    for (const flag of ['--security-opt=seccomp=unconfined', '--security-opt=systempaths=unconfined']) assert.ok(words.includes(flag), `GY-3549 nested sandboxes: ${flag}`);
    assert.match(words, new RegExp(`--host unix:///run/user/${process.getuid!()}/docker\\.sock`), 'the user\'s rootless Docker');
    const mounts = create!.filter((_, index) => create![index - 1] === '--mount');
    assert.equal(mounts.length, 1, words);
    const runDirectory = /src=([^,]+)/.exec(mounts[0]!)![1]!;
    for (const path of [runDirectory, join(runDirectory, 'repo'), join(runDirectory, 'repo', 'tests')]) {
      assert.equal((await stat(path)).mode & 0o2070, 0o2070, `mapped group can write and traverse ${path}`);
    }
    assert.equal((await stat(join(runDirectory, 'repo', 'tests', 'a.test.ts'))).mode & 0o060, 0o060);
    assert.equal((await stat(hosts.home('box'))).mode, homeMode, 'host home permissions stay unchanged');
    assert.match(mounts[0]!, new RegExp(`^type=bind,src=${hosts.home('box')}/\\.graphyard/runs/trial-\\w+,dst=`), 'only the run directory is mounted');
  } finally { await session.close(); listening.close(); }
});

// GY-3456: the production refusal named this exact valid command. Keep the installed script's
// dispatch and warm-image validation exercised together, without opening any extra verb/image.
test('integration:remote-ssh-confined — the prepared shim accepts the reported prepare-run warm-image command', () => {
  const result = shim('prepare-run 4a46888f-graphyard b14b433253349f3fa4dd97f9893b49f9622c7d33 graphyard-warm:98f889ed5f9e-961b8cf1ad0e');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^need-pack -/);
});
