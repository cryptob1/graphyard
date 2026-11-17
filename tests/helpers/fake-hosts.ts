// GY-3407: SSH hosts as stand-ins on PATH, prepared by running the script `graphyard host prepare`
// actually prints. The privileged commands that script calls — useradd, gpasswd, usermod, loginctl,
// install, chown, sudo, dockerd-rootless-setuptool.sh — are PATH stand-ins acting on a fixture /etc,
// /usr/local/bin and /run, and the shim's install prefix is redirected into the fixture because the
// test is not root; every other line of the printed script runs as printed. The fake `ssh` then
// honours the authorized_keys the script wrote the way sshd does: a restrict,command="graphyard-
// host-shim" line runs only the shim with the caller's command in SSH_ORIGINAL_COMMAND, a bare key
// line gives a plain shell. Key material is never read, exactly as tests/helpers/ssh-origin.ts does
// not. A host with no directory refuses the connection exactly as OpenSSH words it. GY-3440: a
// `tailscale` host's port 22 is Tailscale SSH (auth none: any account gets a plain shell, keys
// ignored); another port answers only as the sshd_graphyard_config the script wrote says (Port,
// AllowUsers, ForceCommand). `ssh -G` and connections resolve aliases from $HOME/.ssh/config.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { temporaryDirectory } from './temp-dirs.js';
import { hostPrepareScript, hostUser } from '../../src/hosts.js';

export interface FakeHost {
  name: string;
  /** the operator's everyday key, authorized for a plain shell: `host add` must refuse it. */
  unrestricted?: boolean;
  /** the same shim-restricted key also authorized for root, whose Docker answers: `host add` must refuse root. */
  root?: boolean;
  /** gy-compute in the docker group after prepare: `host add` must refuse it. */
  dockerGroup?: boolean;
  /** the prepared rootless Docker does not answer, as one installed but not running. */
  docker?: boolean;
  /** GY-3440: port 22 is Tailscale SSH, so prepare adds the compute-only OpenSSH on port 2222. */
  tailscale?: boolean;
}

/** The operator public key the fixture authorizes on every host (the wrapper reads no key material). */
export const fixturePublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFJpeHR1cmU graphyard-host-fixture';

const executable = async (path: string, text: string) => { await writeFile(path, text); await chmod(path, 0o755); };
const restrictLine = () => `restrict,command="graphyard-host-shim" ${fixturePublicKey}`;

/** The user's own Docker, as dockerd-rootless-setuptool.sh leaves it: it answers only through its own socket. */
const rootlessDockerTemplate = (dir: string) => `#!/bin/sh
D='${dir}'
case "$DOCKER_HOST" in unix://*) [ -e "$D\${DOCKER_HOST#unix://}" ] || { echo "Cannot connect to the Docker daemon at $DOCKER_HOST" >&2; exit 1; } ;; esac
case "$1" in info) exit 0 ;; ps) printf 'a1\nb2\n' ;; esac
`;

/** The machine's own Docker (root's, or this machine's): answers without a user socket. */
const systemDocker = "#!/bin/sh\ncase \"$1\" in info) exit 0 ;; ps) printf 'a1\\nb2\\n' ;; esac\n";

/** Stand-ins for the privileged commands the printed script calls, each acting on the host's fixture root. */
const standins = (dir: string, host: FakeHost): Record<string, string> => ({
  useradd: `#!/bin/sh
D='${dir}'
name=
for a in "$@"; do case "$a" in -*) ;; *) name="$a" ;; esac; done
/usr/bin/grep -q "^$name:" "$D/etc/passwd" && exit 0
home="$D/home/$name"; mkdir -p "$home"
echo "$name:x:1001:1001::$home:/bin/sh" >> "$D/etc/passwd"
echo "$name:x:1001:" >> "$D/etc/group"
`,
  gpasswd: `#!/bin/sh
D='${dir}'
echo "gpasswd $*" >> "$D/log"
user="$2" group="$3"
while IFS=: read name x gid members; do
  if [ "$name" = "$group" ]; then
    kept=
    for m in $(echo "$members" | tr , ' '); do [ "$m" = "$user" ] || kept="$kept,$m"; done
    echo "$name:$x:$gid:\${kept#,}"
  else echo "$name:$x:$gid:$members"; fi
done < "$D/etc/group" > "$D/etc/group.new"
mv "$D/etc/group.new" "$D/etc/group"
`,
  usermod: `#!/bin/sh
D='${dir}'
name= sub= subg= pending=
for a in "$@"; do
  case "$a" in
    --add-subuids) pending=sub ;;
    --add-subgids) pending=subg ;;
    -*) ;;
    *) case "$pending" in sub) sub="$a" ;; subg) subg="$a" ;; *) name="$a" ;; esac; pending= ;;
  esac
done
start=\${sub%-*}; /usr/bin/grep -q "^$name:" "$D/etc/subuid" || echo "$name:$start:$(( \${sub#*-} - start + 1 ))" >> "$D/etc/subuid"
start=\${subg%-*}; /usr/bin/grep -q "^$name:" "$D/etc/subgid" || echo "$name:$start:$(( \${subg#*-} - start + 1 ))" >> "$D/etc/subgid"
echo "usermod $*" >> "$D/log"
`,
  loginctl: `#!/bin/sh
D='${dir}'
echo "loginctl $*" >> "$D/log"
if [ "$1" = enable-linger ]; then mkdir -p "$D/var/lib/systemd/linger"; touch "$D/var/lib/systemd/linger/$2"; fi
`,
  getent: `#!/bin/sh
D='${dir}'
if [ "$1" = passwd ]; then /usr/bin/grep "^$2:" "$D/etc/passwd" && exit 0; fi
exit 2
`,
  id: `#!/bin/sh
D='${dir}'
name= opts=
for a in "$@"; do case "$a" in -*) opts="$opts$a" ;; *) name="$a" ;; esac; done
[ -n "$name" ] || name="\${FAKE_SSH_USER:-$(/usr/bin/id -un)}"
line=$(/usr/bin/grep "^$name:" "$D/etc/passwd") || { echo "id: '$name': no such user" >&2; exit 1; }
uid=$(echo "$line" | /usr/bin/cut -d: -f3); pgid=$(echo "$line" | /usr/bin/cut -d: -f4)
case "$opts" in *u*) echo "$uid"; exit 0 ;; esac
if [ -n "$opts" ]; then
  groups=
  while IFS=: read g x gid members; do
    [ "$gid" = "$pgid" ] && groups="$groups $g"
    for m in $(echo "$members" | tr , ' '); do [ "$m" = "$name" ] && groups="$groups $g"; done
  done < "$D/etc/group"
  echo "\${groups# }"
  exit 0
fi
echo "uid=$uid($name) gid=$pgid"
`,
  install: `#!/bin/sh
D='${dir}'
echo "install $*" >> "$D/log"
path= mode= pending=
for a in "$@"; do
  case "$a" in
    -m) pending=mode ;;
    -o | -g | -d) ;;
    -*) ;;
    *) case "$pending" in mode) mode="$a" ;; *) path="$a" ;; esac; pending= ;;
  esac
done
mkdir -p "$path"
[ -n "$mode" ] && /usr/bin/chmod "$mode" "$path"
`,
  chown: `#!/bin/sh
D='${dir}'
echo "chown $*" >> "$D/log"
`,
  grep: `#!/bin/sh
D='${dir}'
case "$3" in /etc/*) exec /usr/bin/grep "$1" "$2" "$D$3" ;; esac
exec /usr/bin/grep "$@"
`,
  tailscale: `#!/bin/sh
[ "$1 $2" = "debug prefs" ] && echo '{ "RunSSH": ${host.tailscale ? 'true' : 'false'} }'
`,
  sshd: `#!/bin/sh
D='${dir}'
echo "sshd $*" >> "$D/log"
`,
  'ssh-keygen': `#!/bin/sh
D='${dir}'
echo "ssh-keygen $*" >> "$D/log"
`,
  systemctl: `#!/bin/sh
D='${dir}'
echo "systemctl $*" >> "$D/log"
`,
  ufw: `#!/bin/sh
echo 'Status: inactive'
`,
  sleep: `#!/bin/sh
# The fixture host does not wait out the session bus.
exit 0
`,
  hostname: `#!/bin/sh
echo '${host.name}'
`,
  sudo: `#!/bin/sh
D='${dir}'
full="$*"
[ "$1" = -u ] && user="$2" && shift 2
while :; do case "$1" in *=*) export "$1"; shift ;; *) break ;; esac; done
export HOME="$D/home/$user" USER="$user" LOGNAME="$user" FAKE_SSH_USER="$user"
echo "sudo $full" >> "$D/log"
exec "$@"
`,
  'dockerd-rootless-setuptool.sh': `#!/bin/sh
D='${dir}'
[ "$1" = install ] || exit 0
mkdir -p "$HOME/bin" "$D$XDG_RUNTIME_DIR"
: > "$D$XDG_RUNTIME_DIR/docker.sock"
cp "$D/standins/rootless-docker-template" "$HOME/bin/docker"
/usr/bin/chmod 755 "$HOME/bin/docker"
echo "dockerd-rootless-setuptool.sh install for $USER at $XDG_RUNTIME_DIR/docker.sock" >> "$D/log"
`,
});

/** Run the printed script itself against the stand-in host: gy-compute, linger, subuid, shim, key, rootless Docker. */
async function runPrepareScript(host: FakeHost, dir: string) {
  await Promise.all(['etc/ssh', 'etc/systemd/system', 'usr-local-bin', 'standins'].map(part => mkdir(join(dir, part), { recursive: true })));
  await Promise.all([
    writeFile(join(dir, 'etc', 'passwd'), 'root:x:0:0:root:/root:/bin/sh\n'),
    writeFile(join(dir, 'etc', 'group'), 'root:x:0:\n'),
    writeFile(join(dir, 'etc', 'subuid'), ''),
    writeFile(join(dir, 'etc', 'subgid'), ''),
    writeFile(join(dir, 'standins', 'rootless-docker-template'), rootlessDockerTemplate(dir)),
  ]);
  for (const [name, text] of Object.entries(standins(dir, host))) await executable(join(dir, 'standins', name), text);
  // The one rewrite of the printed script: the test is not root, so the shim's /usr/local/bin and the
  // files it writes under /etc/ssh and /etc/systemd/system land inside the fixture. Every other line
  // runs exactly as printed.
  const script = hostPrepareScript(fixturePublicKey).replaceAll('/usr/local/bin/graphyard-host-shim', join(dir, 'usr-local-bin', 'graphyard-host-shim'))
    .replaceAll('/etc/ssh/', `${dir}/etc/ssh/`).replaceAll('/etc/systemd/system/', `${dir}/etc/systemd/system/`);
  const file = join(dir, 'prepare.sh');
  await writeFile(file, script);
  const result = spawnSync('sh', [file], { encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'standins')}:${process.env.PATH}` } });
  if (result.status !== 0) throw new Error(`the script host prepare prints failed on the stand-in host ${host.name}: ${result.stderr || result.stdout}`);
  return String(result.stdout);
}

export interface FakeHosts {
  root: string;
  /** First on a caller's PATH: the fake `ssh`, and this machine's own Docker. */
  bin: string;
  publicKey: string;
  /** The fixture root of one host: its etc, usr-local-bin, homes, run and the log of privileged calls. */
  host: (name: string) => string;
  home: (name: string, user?: string) => string;
  /** What running the printed script printed on that host. */
  prepareOutput: (name: string) => string;
}

export async function fakeHosts(label: string, hosts: FakeHost[]): Promise<FakeHosts> {
  const root = await temporaryDirectory(label), bin = join(root, 'bin');
  await mkdir(bin);
  // This machine answers with the same stand-in Docker.
  await executable(join(bin, 'docker'), systemDocker);
  const outputs = new Map<string, string>();
  for (const host of hosts) {
    const dir = join(root, 'hosts', host.name);
    if (host.unrestricted) {
      const home = join(dir, 'home', 'vish');
      await mkdir(join(home, '.ssh'), { recursive: true });
      await writeFile(join(home, '.ssh', 'authorized_keys'), `${fixturePublicKey}\n`);
      continue;
    }
    outputs.set(host.name, await runPrepareScript(host, dir));
    if (host.root) {
      const home = join(dir, 'home', 'root');
      await mkdir(join(home, 'bin'), { recursive: true }); await mkdir(join(home, '.ssh'), { recursive: true });
      await executable(join(home, 'bin', 'docker'), systemDocker);
      await writeFile(join(home, '.ssh', 'authorized_keys'), `${restrictLine()}\n`);
    }
    if (host.dockerGroup) await writeFile(join(dir, 'etc', 'group'), `${await readFile(join(dir, 'etc', 'group'))}docker:x:998:${hostUser}\n`);
    if (host.tailscale) await writeFile(join(dir, 'tailscale-ssh'), '');
    if (host.docker === false) await writeFile(join(dir, 'home', hostUser, 'bin', 'docker'), '#!/bin/sh\nexit 1\n');
  }
  await executable(join(bin, 'ssh'), `#!/bin/sh
G= port= target= last=
while [ $# -gt 0 ]; do
  case "$1" in
    -G) G=1 ;;
    -p) port="$2"; shift ;;
    -o) shift ;;
    *) if [ -z "$target" ]; then target="$1"; else last="$1"; fi ;;
  esac
  shift
done
case "$target" in
  *@*) user="\${target%@*}"; host="\${target#*@}" ;;
  *) user=$(/usr/bin/id -un); host="$target"
     eval "$(awk -v a="$target" '$1 == "Host" { on = ($2 == a) } on && $1 == "HostName" { print "host=" $2 } on && $1 == "User" { print "user=" $2 } on && $1 == "Port" { print "cport=" $2 }' "$HOME/.ssh/config" 2>/dev/null)"
     port="\${port:-$cport}" ;;
esac
port="\${port:-22}"
if [ -n "$G" ]; then printf 'user %s\\nhostname %s\\nport %s\\n' "$user" "$host" "$port"; exit 0; fi
dir="${root}/hosts/$host"
refused() { echo "ssh: connect to host $host port $port: Connection refused" >&2; exit 255; }
[ -d "$dir" ] || refused
if [ "$port" = 22 ] && [ -f "$dir/tailscale-ssh" ]; then
  # Tailscale SSH, auth none: any account gets a plain shell, authorized_keys and the shim ignored.
  cd "$dir" && exec sh -c "$last"
fi
home="$dir/home/$user"; keys="$home/.ssh/authorized_keys"; force=
if [ "$port" != 22 ]; then
  conf="$dir/etc/ssh/sshd_graphyard_config"
  /usr/bin/grep -qx "Port $port" "$conf" 2>/dev/null || refused
  /usr/bin/grep -qx "AllowUsers $user" "$conf" || { echo "$user@$host: Permission denied (publickey)." >&2; exit 255; }
  force=$(sed -n 's/^ForceCommand //p' "$conf")
fi
if [ ! -f "$keys" ]; then echo "$user@$host: Permission denied (publickey)." >&2; exit 255; fi
cd "$home" || exit 255
case "$(cat "$keys")" in 'restrict,command="graphyard-host-shim"'*) force=graphyard-host-shim ;; esac
HOME="$home"; export HOME
if [ -n "$force" ]; then
  export FAKE_SSH_USER="$user"
  PATH="$home/bin:$dir/usr-local-bin:$dir/standins:/usr/bin:/bin"
  SSH_ORIGINAL_COMMAND="$last" exec "$force"
fi
PATH="$home/bin:/usr/bin:/bin"
exec sh -c "$last"
`);
  return { root, bin, publicKey: fixturePublicKey, host: (name: string) => join(root, 'hosts', name), home: (name: string, user = hostUser) => join(root, 'hosts', name, 'home', user), prepareOutput: (name: string) => outputs.get(name) ?? '' };
}
