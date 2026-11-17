import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';
import { main } from '../src/cli/index.js';

// GY-3440: where a host's port 22 is Tailscale SSH (auth none, so authorized_keys and the shim are
// ignored), the script `host prepare` prints gives gy-compute its own OpenSSH on port 2222 and prints
// the tailnet check rule. `host add` takes USER@HOST:PORT or an ssh-config alias, still refuses a
// target where a plain shell opens, and reports whether this machine's own account logs into the
// host unattended on port 22. The hosts are tests/helpers/fake-hosts.ts stand-ins prepared by
// running the printed script.

const proof = 'integration:host-prepare-tailscale-ssh';
const me = userInfo().username;
let hosts: Awaited<ReturnType<typeof fakeHosts>>, config: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME };

before(async () => {
  hosts = await fakeHosts('host-prepare-tailscale-ssh', [{ name: 'desk', tailscale: true }, { name: 'box' }, { name: '127.0.0.1', tailscale: true }]);
  config = join(hosts.root, 'config');
  const home = join(hosts.root, 'operator');
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'config'), 'Host desk-compute\n  HostName desk\n  User gy-compute\n  Port 2222\n\nHost local-compute\n  HostName 127.0.0.1\n  User gy-compute\n  Port 2222\n');
  Object.assign(process.env, { PATH: `${hosts.bin}:${saved.PATH}`, HOME: home, GRAPHYARD_CONFIG_HOME: config });
});
after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });

const recorded = async () => JSON.parse(await readFile(join(config, 'machine', 'hosts.json'), 'utf8').catch(() => '[]')).map((host: { target: string }) => host.target);
const output = async (argv: string[]) => {
  const lines: string[] = [], log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try { await main(argv); } finally { console.log = log; }
  return lines.join('\n');
};

test(`${proof} — on a Tailscale SSH host the printed script runs an OpenSSH for gy-compute only on port 2222 and prints the tailnet check rule; elsewhere it adds none`, async () => {
  const desk = hosts.host('desk');
  const sshd = await readFile(join(desk, 'etc', 'ssh', 'sshd_graphyard_config'), 'utf8');
  for (const line of ['Port 2222', 'AllowUsers gy-compute', 'AuthenticationMethods publickey', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'PermitRootLogin no', 'AllowTcpForwarding no', 'AllowAgentForwarding no', 'AllowStreamLocalForwarding no', 'X11Forwarding no', 'PermitTunnel no', 'PermitTTY no',
    `ForceCommand ${join(desk, 'usr-local-bin', 'graphyard-host-shim')}`]) assert.ok(sshd.split('\n').includes(line), line);
  assert.match(await readFile(join(desk, 'etc', 'systemd', 'system', 'graphyard-sshd.service'), 'utf8'), /^ExecStart=\S*sshd -D -f \S*\/etc\/ssh\/sshd_graphyard_config$/m);
  const log = await readFile(join(desk, 'log'), 'utf8');
  assert.match(log, /^sshd -t -f \S*sshd_graphyard_config$/m, 'the config is checked before it runs');
  assert.match(log, /^systemctl enable --now graphyard-sshd$/m);
  assert.match(hosts.prepareOutput('desk'), /Port 22 here is Tailscale SSH, which skips the shim\. Tailnet check: in your tailnet policy, every ssh rule reaching this machine needs action check, never accept/);
  assert.match(hosts.prepareOutput('desk'), /Ready\. On the Graphyard machine run: graphyard host add gy-compute@desk:2222\s*$/);

  await assert.rejects(readFile(join(hosts.host('box'), 'etc', 'ssh', 'sshd_graphyard_config')), 'a host without Tailscale SSH gets no second OpenSSH');
  assert.doesNotMatch(hosts.prepareOutput('box'), /Tailscale/);
  assert.match(hosts.prepareOutput('box'), /graphyard host add gy-compute@box\s*$/);
});

test(`${proof} — host add takes USER@HOST:PORT and an alias, refuses Tailscale SSH's plain shell, and reports whether ${me}@HOST logs in unattended`, async () => {
  await assert.rejects(main(['host', 'add', 'gy-compute@desk']), /gy-compute@desk was not added: its SSH key opens a plain shell[^\n]*then add gy-compute@desk \(gy-compute@desk:2222 where port 22 is Tailscale SSH\)/);
  const port = await output(['host', 'add', 'gy-compute@desk:2222']);
  assert.match(port, /^Added gy-compute@desk:2222: \d+ cores, rootless Docker answers through the shim/m);
  assert.match(port, new RegExp(`^Warning: ${me}@desk logs in unattended on port 22, so anything running as you here can open a shell there\\. If it is Tailscale SSH, set every ssh rule reaching that host to action check in your tailnet policy\\.$`, 'm'));
  const alias = await output(['host', 'add', 'desk-compute']);
  assert.match(alias, /^Added desk-compute: \d+ cores/m);
  assert.match(alias, new RegExp(`^Warning: ${me}@desk logs in unattended on port 22`, 'm'), 'the alias resolves to the host it names');
  assert.match(await output(['host', 'add', 'gy-compute@box']), new RegExp(`^Tailnet check: ${me}@box does not log in unattended on port 22\\.$`, 'm'));
  await assert.rejects(main(['host', 'add', 'gy-compute@box:2222']), /gy-compute@box:2222 is unreachable over SSH: ssh: connect to host box port 2222: Connection refused/);
  assert.deepEqual(await recorded(), ['gy-compute@desk:2222', 'desk-compute', 'gy-compute@box']);
});

test(`${proof} e2e:host-add-port-alias — host add records a shim-restricted OpenSSH on 127.0.0.1:2222 by USER@HOST:PORT and by alias, and refuses the port that opens a plain shell`, async () => {
  for (const target of ['gy-compute@127.0.0.1:2222', 'local-compute']) {
    assert.match(await output(['host', 'add', target]), new RegExp(`^Added ${target}: \\d+ cores, rootless Docker answers through the shim`, 'm'));
    assert.ok((await recorded()).includes(target));
  }
  await assert.rejects(main(['host', 'add', 'gy-compute@127.0.0.1:22']), /gy-compute@127\.0\.0\.1:22 was not added: its SSH key opens a plain shell/);
  assert.ok(!(await recorded()).includes('gy-compute@127.0.0.1:22'), 'a refused target is never recorded');
});
