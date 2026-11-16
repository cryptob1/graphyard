// GY-3407: SSH hosts as stand-ins on PATH. Each host has an empty home, its own PATH (its Docker or
// none, and its `id`), and either the shim `graphyard host prepare` installs as the forced command of
// this machine's key, or a plain shell. The fake ssh refuses an unknown host exactly as OpenSSH words it.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './temp-dirs.js';
import { hostPrepareScript } from '../../src/hosts.js';

export interface FakeHost { name: string; docker?: boolean; uid?: number; groups?: string; plainShell?: boolean }

const executable = async (path: string, text: string) => { await writeFile(path, text); await chmod(path, 0o755); };

/** The shim exactly as the printed prepare script installs it. */
export const preparedShim = () => /<<'GRAPHYARD_SHIM'\n([\s\S]*?)GRAPHYARD_SHIM\n/.exec(hostPrepareScript('ssh-ed25519 AAAAfake test'))![1]!;

export async function fakeHosts(label: string, hosts: FakeHost[]) {
  const root = await temporaryDirectory(label), bin = join(root, 'bin'), shim = join(root, 'graphyard-host-shim');
  await mkdir(bin);
  await executable(shim, preparedShim());
  const docker = '#!/bin/sh\ncase "$1" in info) echo id;; ps) printf "a1\\nb2\\n";; esac\n';
  // This machine answers with the same stand-in Docker.
  await executable(join(bin, 'docker'), docker);
  for (const host of hosts) {
    const hostBin = join(root, 'hosts', host.name, 'bin');
    await mkdir(join(root, 'hosts', host.name, 'home'), { recursive: true }); await mkdir(hostBin);
    // A Docker that answers and runs two trial containers, or one that does not (whatever Docker the machine has).
    await executable(join(hostBin, 'docker'), host.docker === false ? '#!/bin/sh\nexit 1\n' : docker);
    await executable(join(hostBin, 'id'), `#!/bin/sh\ncase "$1" in -u) echo ${host.uid ?? 1001};; -Gn) echo ${host.groups ?? 'gy-compute'};; esac\n`);
    if (host.plainShell) await writeFile(join(root, 'hosts', host.name, 'plain-shell'), '');
  }
  await executable(join(bin, 'ssh'), `#!/bin/sh
for last; do :; done
for arg; do case "$arg" in *@*) target="$arg";; esac; done
host="\${target#*@}"; dir="${root}/hosts/$host"
if [ ! -d "$dir" ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
cd "$dir/home" && export HOME="$dir/home" PATH="$dir/bin:/usr/bin:/bin"
if [ -f "$dir/plain-shell" ]; then exec sh -c "$last"; fi
SSH_ORIGINAL_COMMAND="$last" exec "${shim}"
`);
  return { root, bin, shim, home: (name: string) => join(root, 'hosts', name, 'home') };
}
