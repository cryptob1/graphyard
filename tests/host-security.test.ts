import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';
import { main } from '../src/cli/index.js';

// GY-3407 AC-5: a host lends compute and nothing else. `host prepare` prints the one-time sudo script
// (gy-compute, not in the docker group, linger, rootless Docker, a key that may only run the shim); the
// shim refuses everything but its verbs; `host add` refuses a key that opens a plain shell, root and a
// docker-group user, and records the host in the one host list.

const proof = 'integration:host-security';
let hosts: Awaited<ReturnType<typeof fakeHosts>>, config: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME };

before(async () => {
  hosts = await fakeHosts('host-security', [{ name: 'box' }, { name: 'open', plainShell: true }, { name: 'rooty', uid: 0, groups: 'root' }, { name: 'dockery', groups: 'gy-compute docker' }]);
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
  assert.match(script, /dockerd-rootless-setuptool\.sh install/);
  assert.match(script, /'restrict,command="graphyard-host-shim" ssh-ed25519 AAAAC3NzaOperatorKey operator@vishrog' > "\$home\/\.ssh\/authorized_keys"/);
});

test(`${proof} — the shim answers only its verbs: a plain shell command is refused`, async () => {
  const run = (command: string) => spawnSync('sh', [hosts.shim], { env: { PATH: `${join(hosts.root, 'hosts', 'box', 'bin')}:/usr/bin:/bin`, SSH_ORIGINAL_COMMAND: command }, encoding: 'utf8' });
  for (const command of ['sh', 'cat /etc/passwd', 'probe; sh', 'docker run -v /:/host alpine']) {
    const result = run(command);
    assert.equal(result.status, 1, command); assert.equal(result.stdout, '', command);
    assert.match(result.stderr, /graphyard-host-shim refuses/);
  }
  assert.match(run('probe').stdout, /^user 1001 gy-compute$/m);
});

test(`${proof} — host add refuses a key that opens a plain shell, root and a docker-group user; the shim-restricted gy-compute is added to the one host list`, async () => {
  await assert.rejects(main(['host', 'add', 'vish@open']), /vish@open was not added: its SSH key opens a plain shell, so Graphyard could reach everything that user can; run graphyard host prepare and the script it prints there, then add gy-compute@open/);
  await assert.rejects(main(['host', 'add', 'root@rooty']), /root@rooty was not added: it logs in as root/);
  await assert.rejects(main(['host', 'add', 'gy-compute@dockery']), /gy-compute@dockery was not added: gy-compute is in the docker group, which is root on that host/);
  await main(['host', 'add', 'gy-compute@box']);
  assert.deepEqual(JSON.parse(await readFile(join(config, 'machine', 'hosts.json'), 'utf8')).map((host: { target: string }) => host.target), ['gy-compute@box']);
  for (const name of ['box', 'open', 'rooty', 'dockery']) assert.deepEqual(await readdir(hosts.home(name)), [], `nothing is written on ${name}`);
});
