// GY-3412: hosts for remote shard runs. Every host runs the real graphyard-host-shim, exactly as
// `graphyard host prepare` installs it, in its own home; only Docker is a stand-in, keeping its images
// and containers in a state file, logging each call, and running a container's command in its working
// directory — under `unshare -rn` (no network) when it was created with --network=none. This machine
// has the same stand-in Docker. `ssh` here routes USER@NAME to the host named NAME (exit 255 while
// NAME.down exists, as OpenSSH does for a host it cannot reach); `sshd` runs a real OpenSSH server.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { temporaryDirectory } from './temp-dirs.js';
import { hostShimScript } from '../../src/host-shim.js';

const executable = async (path: string, text: string) => { await writeFile(path, text); await chmod(path, 0o755); };

/** A Docker CLI keeping its state under `state`. */
export const dockerStandIn = (state: string) => `#!/usr/bin/python3
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
open(os.path.join(STATE, 'every-call.log'), 'a').write(command + '\\n')
if command == 'info':
    print('fixture')
elif command == 'ps':
    pass
elif command == 'image':
    name = args[-1]
    if name not in s['images']:
        sys.exit('Error: No such image: ' + name)
    print(s['images'][name])
elif command == 'tag':
    s['images'][args[2]] = s['images'][args[1]]
    save()
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
    sys.stdin.read()
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
    s['containers'][args[args.index('--name') + 1]] = {'workdir': args[args.index('--workdir') + 1], 'env': env, 'image': args[at + 2],
        'command': (['unshare', '-rn'] if '--network=none' in args else []) + [args[at + 1]] + args[at + 3:]}
    open(os.path.join(STATE, 'creates.jsonl'), 'a').write(json.dumps(sys.argv[1:]) + '\\n')
    save()
elif command == 'start':
    container = s['containers'][args[-1]]
    fcntl.flock(lock, fcntl.LOCK_UN)
    sys.exit(subprocess.call(container['command'], cwd=container['workdir'], env=container['env']))
`;

export interface ShardHostsFixture { root: string; bin: string; shim: string; localState: string; home(name: string): string; state(name: string): string; down(name: string, down: boolean): Promise<void> }

/** Hosts `names`, each with its own home and Docker state, reached as gy-compute@NAME through the ssh on `bin`; this machine's Docker holds `images` (name to id). */
export async function shardHosts(label: string, names: string[], images: Record<string, string> = {}): Promise<ShardHostsFixture> {
  const root = await temporaryDirectory(label), bin = join(root, 'bin'), shim = join(root, 'graphyard-host-shim'), localState = join(root, 'local-docker');
  await mkdir(bin, { recursive: true });
  await executable(shim, hostShimScript);
  await executable(join(bin, 'docker'), dockerStandIn(localState));
  await mkdir(localState);
  await writeFile(join(localState, 'state.json'), JSON.stringify({ images, containers: {} }));
  for (const name of names) {
    await mkdir(join(root, 'hosts', name, 'home'), { recursive: true }); await mkdir(join(root, 'hosts', name, 'bin'));
    await executable(join(root, 'hosts', name, 'bin', 'docker'), dockerStandIn(join(root, 'hosts', name, 'docker')));
  }
  await executable(join(bin, 'ssh'), `#!/bin/sh
if [ "$1" = -G ]; then exec /usr/bin/ssh "$@"; fi
for arg; do case "$arg" in -fNM|-O) exit 0;; esac; done
for last; do :; done
for arg; do case "$arg" in *@*) target="$arg";; esac; done
host="\${target#*@}"; dir="${root}/hosts/$host"
if [ ! -d "$dir" ] || [ -e "$dir.down" ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
cd "$dir/home" && export HOME="$dir/home" PATH="$dir/bin:/usr/bin:/bin" GRAPHYARD_HOST_FLOOR_GB=0
SSH_ORIGINAL_COMMAND="$last" exec "${shim}"
`);
  return {
    root, bin, shim, localState,
    home: name => join(root, 'hosts', name, 'home'),
    state: name => join(root, 'hosts', name, 'docker'),
    down: async (name, down) => { if (down) await writeFile(join(root, 'hosts', `${name}.down`), ''); else await import('node:fs/promises').then(fs => fs.rm(join(root, 'hosts', `${name}.down`), { force: true })); },
  };
}

export const dockerCalls = (state: string) => existsSync(join(state, 'calls.log')) ? execFileSync('cat', [join(state, 'calls.log')], { encoding: 'utf8' }).split('\n').filter(Boolean) : [];
/** Every Docker call the host made, by its command word. */
export const dockerEveryCall = (state: string) => existsSync(join(state, 'every-call.log')) ? readFileSync(join(state, 'every-call.log'), 'utf8').split('\n').filter(Boolean) : [];
export const dockerCount = (state: string, word: string) => dockerCalls(state).filter(entry => entry === word).length;
export const dockerCreates = async (state: string): Promise<string[][]> => existsSync(join(state, 'creates.jsonl'))
  ? (await readFile(join(state, 'creates.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
export const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

/** A repository whose test runner runs the files its list names, writes one record per file (a file named `fails` fails), and prints the checkout's commit count. */
export const shardRunner = `import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const files = readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean);
console.log('history ' + execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
let failed = 0;
for (const file of files) {
  if (file.includes('dies')) process.exit(137);
  const passed = !file.includes('fails'); failed += passed ? 0 : 1;
  appendFileSync(at('--durations'), JSON.stringify({ file, passed, durationMs: 1 }) + '\\n');
  console.log((passed ? 'ok ' : 'not ok ') + file + ' in ' + process.cwd());
}
process.exit(failed ? 1 : 0);
`;
export async function shardRepository(label: string, files: readonly string[], extra: Record<string, string> = {}) {
  const root = await temporaryDirectory(label);
  git(root, 'init', '-q', '-b', 'main');
  const content: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'true' } }),
    'package-lock.json': JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }),
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'test', command: 'node scripts/tests.mjs', source: 'script', reason: 'fixture', selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' } }] } } }),
    'scripts/select.mjs': '', 'scripts/tests.mjs': shardRunner,
    ...Object.fromEntries(files.map(file => [file, 'fixture\n'])),
    ...extra,
  };
  for (const [path, text] of Object.entries(content)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
  return { root, sha: git(root, 'rev-parse', 'HEAD') };
}
export const commitFile = async (root: string, path: string, text: string) => { await writeFile(join(root, path), text); git(root, 'add', '-A'); git(root, 'commit', '-qm', `change ${path}`); return git(root, 'rev-parse', 'HEAD'); };

/** Kill every process under the ones `matches` picks (by working directory: the shim execs python, so its command line names no path), and those too. */
export function killTrees(matches: (pid: number, cwd: string) => boolean) {
  const table = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try { return [{ pid: Number(pid), ppid: Number(readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[1]), cwd: readlinkSync(`/proc/${pid}/cwd`) }]; } catch { return []; }
  });
  const tree = new Set(table.filter(entry => matches(entry.pid, entry.cwd)).map(entry => entry.pid));
  for (let grew = true; grew;) { grew = false; for (const { pid, ppid } of table) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; } }
  for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

const freePort = () => new Promise<number>((resolve, reject) => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }).on('error', reject); });

/**
 * A real OpenSSH server on 127.0.0.1 for this user, whose only key may run the shim with `home` as the
 * host's own folder and `hostBin` (its Docker) first on PATH (restrict,command=…, as `graphyard host prepare` writes it), and an `ssh` on `bin`
 * that reaches it as USER@127.0.0.1 with that key. `kill` drops the host mid-run.
 */
export async function sshdHost(root: string, shim: string, home: string, hostBin: string, bin: string) {
  const dir = join(root, 'sshd'), port = await freePort();
  await mkdir(dir, { recursive: true }); await mkdir(home, { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'client')]);
  const key = (await readFile(join(dir, 'client.pub'), 'utf8')).trim();
  await writeFile(join(dir, 'authorized_keys'), `restrict,command="GRAPHYARD_HOST_FLOOR_GB=0 PATH=${hostBin}:/usr/bin:/bin ${shim} --home ${home}" ${key}\n`);
  await writeFile(join(dir, 'sshd_config'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host')}`, `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
    `PidFile ${join(dir, 'pid')}`, 'UsePAM no', 'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PermitUserEnvironment no', ''].join('\n'));
  const sshd = execFileSync('sh', ['-c', 'command -v sshd || echo /usr/sbin/sshd'], { encoding: 'utf8' }).trim();
  let server: ChildProcess | null = null;
  const start = async () => {
    server = spawn(sshd, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
    for (let tries = 0; tries < 100; tries++) {
      const open = await new Promise<boolean>(resolve => { const socket = createServer(); socket.once('error', () => resolve(true)).listen(port, '127.0.0.1', () => socket.close(() => resolve(false))); });
      if (open) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('sshd did not listen');
  };
  await start();
  const real = execFileSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).trim();
  await executable(join(bin, 'ssh'), `#!/bin/sh\nexec ${real} -i ${join(dir, 'client')} -p ${port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$@"\n`);
  /** Every process the server started — its sessions, the shim, the launcher and the shard — then the server itself: the host drops off. */
  const kill = () => killTrees(pid => pid === server?.pid);
  return { port, user: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), start, kill };
}
