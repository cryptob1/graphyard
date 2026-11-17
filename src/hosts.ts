// Concern: GY-3407 — the hosts Graphyard watches; merge trials send them test shards (GY-3412). A host lends
// compute and nothing else: `graphyard host prepare` prints a one-time sudo script that creates the
// unprivileged gy-compute user (not in the docker group) with linger and rootless Docker, and lets this
// machine's key run only graphyard-host-shim (restrict,command=…: no shell, pty or forwarding). The shim
// answers fixed verbs (src/host-shim.ts). `graphyard host add USER@HOST` refuses a key
// that opens a plain shell, root and a docker-group user, then records the host in this machine's hosts
// file — the one host list. Each loop cycle probes every host — cores, hottest CPU sensor, steal and the
// trial containers running now — this machine first; a host that does not answer reads away.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { defaultChildRun, type ChildRun } from './child-runner.js';
import { configHome } from './install/secrets.js';
import { cpuSensorNames } from './merge-writer/trial-load.js';
import { cpuStatTotals, stealPercent } from './daemon/cpu-pressure.js';
import { hostProbeScript, hostShimScript } from './host-shim.js';

export interface HostRecord { target: string; addedAt: string }
export interface HostReading { host: string; local?: boolean; away: boolean; reason?: string; cores: number | null; celsius: number | null; steal: number | null; runs: number | null; stat?: { total: number; steal: number } | null }

/** Machine-wide, beside the machine-share link (team-access.ts): every install's loop on this machine reads the same hosts. */
export const hostsFile = (home = configHome()) => join(home, 'machine', 'hosts.json');
export const hostTargetPattern = /^[a-z_][a-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/;
export const hostUser = 'gy-compute';

export async function readHosts(file = hostsFile()): Promise<HostRecord[]> {
  const text = await readFile(file, 'utf8').catch(() => '[]');
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is HostRecord => typeof entry?.target === 'string') : [];
}
const writeHosts = async (file: string, hosts: HostRecord[]) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(hosts, null, 2) + '\n'); };

/** The one-time script `host prepare` prints, for the host's owner to run with sudo. */
export function hostPrepareScript(publicKey: string) {
  return `#!/bin/sh
# Run once on the host with: sudo sh prepare.sh
# Creates ${hostUser}: no sudo, not in the docker group, its own rootless Docker. This machine's key
# may only run graphyard-host-shim as ${hostUser}: no shell, pty, port or agent forwarding.
set -eu
user=${hostUser}
command -v python3 >/dev/null && command -v git >/dev/null || { echo "Install python3 and git, then run this again." >&2; exit 1; }
id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/sh "$user"
gpasswd -d "$user" docker >/dev/null 2>&1 || true
grep -q "^$user:" /etc/subuid || usermod --add-subuids 300000-365535 --add-subgids 300000-365535 "$user"
loginctl enable-linger "$user"
cat > /usr/local/bin/graphyard-host-shim <<'GRAPHYARD_SHIM'
${hostShimScript}GRAPHYARD_SHIM
chmod 755 /usr/local/bin/graphyard-host-shim
home=$(getent passwd "$user" | cut -d: -f6)
install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
echo 'restrict,command="graphyard-host-shim" ${publicKey.trim()}' > "$home/.ssh/authorized_keys"
chown "$user:$user" "$home/.ssh/authorized_keys"; chmod 600 "$home/.ssh/authorized_keys"
command -v dockerd-rootless-setuptool.sh >/dev/null || { echo "Install Docker's rootless extras (dockerd-rootless-setuptool.sh), then run this again." >&2; exit 1; }
uid=$(id -u "$user")
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -S "/run/user/$uid/bus" ] && break; sleep 1; done
sudo -u "$user" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" dockerd-rootless-setuptool.sh install
echo "Ready. On the Graphyard machine run: graphyard host add $user@$(hostname)"
`;
}

/** This machine's SSH public key, the one `host prepare` authorizes. */
export async function localPublicKey(home = homedir()) {
  for (const name of ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']) {
    const key = await readFile(join(home, '.ssh', name), 'utf8').catch(() => null);
    if (key?.trim()) return key.trim();
  }
  throw new Error(`No SSH public key in ${join(home, '.ssh')}: create one with ssh-keygen -t ed25519, then run graphyard host prepare again`);
}

export function parseHostProbe(text: string) {
  if (/^graphyard-no-docker$/m.test(text)) return null;
  const number = (pattern: RegExp) => { const value = Number(pattern.exec(text)?.[1]); return Number.isFinite(value) ? value : null; };
  const temps = [...text.matchAll(/^temp (\S+) (\d+)$/gm)].filter(match => cpuSensorNames.includes(match[1]!)).map(match => Math.floor(Number(match[2]) / 1000));
  const user = /^user (\d+) ?(.*)$/m.exec(text);
  return { cores: number(/^cores (\d+)$/m), load: number(/^load ([\d.]+)$/m), runs: number(/^runs\s+(\d+)$/m), celsius: temps.length ? Math.max(...temps) : null, stat: cpuStatTotals(text),
    uid: user ? Number(user[1]) : null, groups: user ? user[2]!.split(/\s+/).filter(Boolean) : [] };
}

const lastLine = (text: string) => text.trim().split('\n').filter(Boolean).at(-1) ?? '';
const ssh = (target: string, verb: string, run: ChildRun) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', target, verb], { timeoutMs: 15_000 });
const unreachable = (target: string, error: any) => `${target} is unreachable over SSH: ${lastLine(String(error?.stderr ?? '')) || (error?.timedOut ? 'no answer within 15 seconds' : String(error?.message ?? error))}`;

/** One probe of a host through its shim (null: this machine): its readings, or the plain reason it cannot be read. */
export async function probeHost(target: string | null, run: ChildRun = defaultChildRun) {
  let output: string;
  try { output = String(await (target ? ssh(target, 'probe', run) : run('sh', ['-c', hostProbeScript], { timeoutMs: 15_000 }))); }
  catch (error: any) {
    if (!target) return { ok: false as const, reason: `this machine could not be read: ${lastLine(String(error?.stderr ?? '')) || String(error?.message ?? error)}` };
    return { ok: false as const, reason: error?.status === 255 || error?.timedOut ? unreachable(target, error) : `${target} does not answer graphyard-host-shim's probe: run graphyard host prepare and the script it prints there` };
  }
  const reading = parseHostProbe(output);
  if (!reading) return { ok: false as const, reason: `${target ?? 'this machine'} answers but its Docker does not: run graphyard host prepare and the script it prints there` };
  return { ok: true as const, ...reading };
}

/** A host's key must reach only the shim: a plain shell command run through it is refused. */
async function opensPlainShell(target: string, run: ChildRun) {
  try { return String(await ssh(target, 'echo graphyard-plain-shell', run)).includes('graphyard-plain-shell') ? 'yes' : 'no'; }
  catch (error: any) { return error?.status === 255 || error?.timedOut ? unreachable(target, error) : 'no'; }
}

export async function addHost(target: string, options: { file?: string; run?: ChildRun } = {}) {
  const file = options.file ?? hostsFile(), run = options.run ?? defaultChildRun;
  if (target.length > 300 || !hostTargetPattern.test(target)) throw new Error(`Name the host as USER@HOST, for example ${hostUser}@omarchypc: got ${JSON.stringify(target)}`);
  const hosts = await readHosts(file);
  if (hosts.some(host => host.target === target)) return { added: false, hosts };
  const refuse = (reason: string) => { throw new Error(`${target} was not added: ${reason}`); };
  const shell = await opensPlainShell(target, run);
  if (shell === 'yes') refuse(`its SSH key opens a plain shell, so Graphyard could reach everything that user can; run graphyard host prepare and the script it prints there, then add ${hostUser}@${target.split('@')[1]}`);
  if (shell !== 'no') refuse(shell);
  const probe = await probeHost(target, run);
  if (!probe.ok) refuse(probe.reason);
  if (probe.ok && probe.uid === 0) refuse(`it logs in as root; add the unprivileged ${hostUser} user that graphyard host prepare creates`);
  if (probe.ok && probe.groups.includes('docker')) refuse(`${target.split('@')[0]} is in the docker group, which is root on that host; use ${hostUser} with rootless Docker (graphyard host prepare)`);
  const next = [...hosts, { target, addedAt: new Date().toISOString() }];
  await writeHosts(file, next);
  return { added: true, hosts: next, probe: probe.ok ? probe : null };
}

export async function removeHost(target: string, options: { file?: string } = {}) {
  const file = options.file ?? hostsFile();
  const hosts = await readHosts(file);
  if (!hosts.some(host => host.target === target)) return { removed: false, hosts };
  const next = hosts.filter(host => host.target !== target);
  await writeHosts(file, next);
  return { removed: true, hosts: next };
}

/** One cycle's readings: this machine first, then every recorded host; steal is measured from the previous cycle's counters. */
export async function readHostReadings(previous: HostReading[], options: { file?: string; run?: ChildRun; local?: string } = {}): Promise<HostReading[]> {
  const targets = [null, ...(await readHosts(options.file).catch(() => [])).map(host => host.target)];
  return Promise.all(targets.map(async target => {
    const host = target ?? options.local ?? hostname();
    const probe = await probeHost(target, options.run);
    if (!probe.ok) return { host, ...(target ? {} : { local: true }), away: true, reason: probe.reason, cores: null, celsius: null, steal: null, runs: null, stat: null };
    const before = previous.find(reading => reading.host === host)?.stat ?? null;
    return { host, ...(target ? {} : { local: true }), away: false, cores: probe.cores, celsius: probe.celsius, steal: stealPercent(before, probe.stat), runs: probe.runs, stat: probe.stat };
  }));
}
