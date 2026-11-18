import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';
import { main } from '../src/cli/index.js';

// GY-3407 AC-5: a host lends compute and nothing else. `host prepare` prints the one-time sudo script
// (gy-compute, not in the docker group, linger, rootless Docker, a key that may only run the shim);
// running that script prepares the stand-in host exactly as prescribed, the shim it installs refuses
// everything but its verbs, and `host add` refuses a key that opens a plain shell, root and a
// docker-group user, and records the prepared host in the one host list.

const proof = 'integration:host-security';
let hosts: Awaited<ReturnType<typeof fakeHosts>>, config: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME };

before(async () => {
  hosts = await fakeHosts('host-security', [{ name: 'box' }, { name: 'open', unrestricted: true }, { name: 'rooty', root: true }, { name: 'dockery', dockerGroup: true }]);
  config = join(hosts.root, 'config');
  const home = join(hosts.root, 'operator');
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaOperatorKey operator@vishrog\n');
  Object.assign(process.env, { PATH: `${hosts.bin}:${saved.PATH}`, HOME: home, GRAPHYARD_CONFIG_HOME: config });
});
after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });

const printed = async (argv: string[]) => {
  const chunks: string[] = [], write = process.stdout.write;
  process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { await main(argv); } finally { process.stdout.write = write; }
  return chunks.join('');
};

test(`${proof} — host prepare prints a one-time sudo script: an unprivileged gy-compute user outside the docker group, linger, rootless Docker, and a key restricted to graphyard-host-shim`, async () => {
  const script = await printed(['host', 'prepare']);
  assert.equal(spawnSync('sh', ['-n'], { input: script }).status, 0, 'the script parses');
  assert.match(script, /^user=gy-compute$/m);
  assert.match(script, /useradd --create-home --shell \/bin\/sh "\$user"/);
  assert.match(script, /gpasswd -d "\$user" docker/, 'never in the docker group');
  assert.doesNotMatch(script, /usermod[^\n]*-aG|sudoers|wheel/, 'gains no group and no sudo');
  assert.match(script, /loginctl enable-linger "\$user"/);
  // GY-3419: the host's own tools when both are installed, else the static extras fetched into gy-compute's home; either way the install runs through $setuptool.
  assert.match(script, /command -v dockerd-rootless-setuptool\.sh >\/dev\/null && command -v slirp4netns/);
  assert.match(script, /"\$setuptool" install/);
  assert.match(script, /'restrict,command="graphyard-host-shim" ssh-ed25519 AAAAC3NzaOperatorKey operator@vishrog' > "\$home\/\.ssh\/authorized_keys"/);
});

test(`${proof} — the script host prepare prints, run, prepares the host: gy-compute outside the docker group, with linger, subuid ranges, its own rootless Docker, and a shim-only key`, async () => {
  const box = hosts.host('box');
  assert.equal(await readFile(join(box, 'home', 'gy-compute', '.ssh', 'authorized_keys'), 'utf8'), `restrict,command="graphyard-host-shim" ${hosts.publicKey}\n`);
  const shim = join(box, 'usr-local-bin', 'graphyard-host-shim');
  assert.match(await readFile(shim, 'utf8'), /^# graphyard-host-shim: the only command/m);
  assert.equal((await stat(shim)).mode & 0o111, 0o111, 'the script installed the shim executable');
  assert.match(await readFile(join(box, 'etc', 'passwd'), 'utf8'), /^gy-compute:x:1001:1001::.*:\/bin\/sh$/m);
  assert.doesNotMatch(await readFile(join(box, 'etc', 'group'), 'utf8'), /^docker:/m, 'no docker group exists: gy-compute is outside it');
  assert.match(await readFile(join(box, 'etc', 'subuid'), 'utf8'), /^gy-compute:300000:/m);
  await stat(join(box, 'var', 'lib', 'systemd', 'linger', 'gy-compute'));
  const log = await readFile(join(box, 'log'), 'utf8');
  assert.match(log, /gpasswd -d gy-compute docker/);
  assert.match(log, /loginctl enable-linger gy-compute/);
  assert.match(log, /sudo -u gy-compute XDG_RUNTIME_DIR=\/run\/user\/1001 [^\n]*dockerd-rootless-setuptool\.sh install/);
  assert.match(log, /dockerd-rootless-setuptool\.sh install for gy-compute at \/run\/user\/1001\/docker\.sock/, 'rootless Docker installed as the user, on its own socket');
  await stat(join(box, 'run', 'user', '1001', 'docker.sock'));
  assert.match(hosts.prepareOutput('box'), /Ready\. On the Graphyard machine run: graphyard host add gy-compute@box\s*$/);
});

test(`${proof} — the shim the script installed answers only its verbs: a plain shell command is refused`, async () => {
  const box = hosts.host('box');
  const run = (command: string) => spawnSync(join(box, 'usr-local-bin', 'graphyard-host-shim'), {
    env: { PATH: `${join(box, 'home', 'gy-compute', 'bin')}:${join(box, 'standins')}:/usr/bin:/bin`, FAKE_SSH_USER: 'gy-compute', SSH_ORIGINAL_COMMAND: command },
    encoding: 'utf8',
  });
  for (const command of ['sh', 'cat /etc/passwd', 'probe; sh', 'docker run -v /:/host alpine']) {
    const result = run(command);
    assert.equal(result.status, 1, command); assert.equal(result.stdout, '', command);
    assert.match(result.stderr, /graphyard-host-shim refuses/);
  }
  assert.match(run('probe').stdout, /^user 1001 gy-compute$/m);
  assert.match(run('probe').stdout, /^cores \d+$/m);
});

test(`${proof} — host add accepts the prepared host into the one host list and refuses a key that opens a plain shell, root and a docker-group user`, async () => {
  await main(['host', 'add', 'gy-compute@box']);
  const recorded = () => readFile(join(config, 'machine', 'hosts.json'), 'utf8').then(text => JSON.parse(text).map((host: { target: string }) => host.target));
  assert.deepEqual(await recorded(), ['gy-compute@box']);
  await assert.rejects(main(['host', 'add', 'vish@open']), /vish@open was not added: its SSH key opens a plain shell, so Graphyard could reach everything that user can; run graphyard host prepare and the script it prints there, then add gy-compute@open/);
  await assert.rejects(main(['host', 'add', 'root@rooty']), /root@rooty was not added: it logs in as root/);
  await assert.rejects(main(['host', 'add', 'gy-compute@dockery']), /gy-compute@dockery was not added: gy-compute is in the docker group, which is root on that host/);
  assert.deepEqual(await recorded(), ['gy-compute@box'], 'a refused host is never recorded');
  // The probe only reads: every home holds exactly what prepare left there, nothing more.
  assert.deepEqual((await readdir(hosts.home('box'))).sort(), ['.graphyard', '.ssh', 'bin']);
  assert.deepEqual((await readdir(hosts.home('open', 'vish'))).sort(), ['.ssh']);
  assert.deepEqual((await readdir(hosts.home('rooty', 'root'))).sort(), ['.ssh', 'bin']);
  assert.deepEqual((await readdir(hosts.home('dockery'))).sort(), ['.graphyard', '.ssh', 'bin']);
});
