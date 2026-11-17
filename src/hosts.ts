// Concern: GY-3407 — the hosts Graphyard watches; merge trials send them test shards (GY-3412). A host lends
// compute and nothing else: `graphyard host prepare` prints a one-time sudo script that creates the
// unprivileged gy-compute user (not in the docker group) with linger and rootless Docker, and lets this
// machine's key run only graphyard-host-shim (restrict,command=…: no shell, pty or forwarding). The shim
// answers fixed verbs (src/host-shim.ts). `graphyard host add USER@HOST` refuses a key
// that opens a plain shell, root and a docker-group user, then records the host in this machine's hosts
// file — the one host list. Each loop cycle probes every host — cores, hottest CPU sensor, steal and the
// trial containers running now — this machine first; a host that does not answer reads away.
// GY-3440: where port 22 is Tailscale SSH (it ignores authorized_keys and so the shim), prepare adds a
// second OpenSSH for gy-compute only on port 2222; host add takes USER@HOST:PORT or an ssh-config alias
// and reports whether the operator's own account logs into that host unattended on port 22.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { defaultChildRun, type ChildRun } from './child-runner.js';
import { configHome } from './install/secrets.js';
import { cpuSensorNames } from './merge-writer/trial-load.js';
import { cpuStatTotals, stealPercent } from './daemon/cpu-pressure.js';
import { hostProbeScript, hostShimScript } from './host-shim.js';

export interface HostRecord { target: string; addedAt: string }
export interface HostReading { host: string; local?: boolean; away: boolean; reason?: string; cores: number | null; celsius: number | null; steal: number | null; runs: number | null; stat?: { total: number; steal: number } | null }

/** Machine-wide, beside the machine-share link (team-access.ts): every install's loop on this machine reads the same hosts. */
export const hostsFile = (home = configHome()) => join(home, 'machine', 'hosts.json');
/** USER@HOST, USER@HOST:PORT, or an ssh-config alias. */
export const hostTargetPattern = /^(?:[a-z_][a-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?|[A-Za-z0-9][A-Za-z0-9._-]*)$/;
export const computePort = 2222;
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
target="$user@$(hostname)"
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
# Tailscale SSH on port 22 ignores authorized_keys, so the shim: give $user its own OpenSSH on port ${computePort}.
if tailscale debug prefs 2>/dev/null | grep -q '"RunSSH": *true'; then
  sshd=$(command -v sshd) || { echo "Install the OpenSSH server (sshd), then run this again." >&2; exit 1; }
  ssh-keygen -A
  cat > /etc/ssh/sshd_graphyard_config <<GRAPHYARD_SSHD
Port ${computePort}
AllowUsers $user
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowTcpForwarding no
AllowAgentForwarding no
AllowStreamLocalForwarding no
X11Forwarding no
PermitTunnel no
PermitTTY no
ForceCommand /usr/local/bin/graphyard-host-shim
PidFile /run/graphyard-sshd.pid
GRAPHYARD_SSHD
  "$sshd" -t -f /etc/ssh/sshd_graphyard_config
  cat > /etc/systemd/system/graphyard-sshd.service <<GRAPHYARD_UNIT
[Unit]
Description=OpenSSH for $user only (Graphyard compute, port ${computePort})
After=network.target
[Service]
ExecStart=$sshd -D -f /etc/ssh/sshd_graphyard_config
Restart=always
[Install]
WantedBy=multi-user.target
GRAPHYARD_UNIT
  systemctl daemon-reload
  systemctl enable --now graphyard-sshd
  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow in on tailscale0 to any port ${computePort} proto tcp; fi
  target="$target:${computePort}"
  echo "Port 22 here is Tailscale SSH, which skips the shim. Tailnet check: in your tailnet policy, every ssh rule reaching this machine needs action check, never accept, so no account here logs in unattended. Graphyard reaches $user on port ${computePort}."
fi
echo "Ready. On the Graphyard machine run: graphyard host add $target"
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
/** ssh's arguments for a host target: USER@HOST:PORT becomes -p PORT USER@HOST; USER@HOST and an alias pass as they are. */
export const sshTarget = (target: string) => { const port = /^(.+@.+):(\d+)$/.exec(target); return port ? ['-p', port[2]!, port[1]!] : [target]; };
const ssh = (target: string, verb: string, run: ChildRun) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...sshTarget(target), verb], { timeoutMs: 15_000 });
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

const targetHost = (target: string) => target.replace(/^.*@/, '').replace(/:\d+$/, '');

/** Read-only: does this machine's own account open a shell on the host's port 22 (Tailscale SSH or a key) with nobody there to approve it? */
export async function operatorLogin(target: string, run: ChildRun = defaultChildRun, account = userInfo().username) {
  const host = /^hostname (\S+)$/m.exec(String(await Promise.resolve(run('ssh', ['-G', ...sshTarget(target)], { timeoutMs: 5_000 })).catch(() => '')))?.[1] ?? targetHost(target);
  const login = `${account}@${host}`;
  try { await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-p', '22', login, 'true'], { timeoutMs: 15_000 }); return { login, unattended: true }; }
  catch { return { login, unattended: false }; }
}

export async function addHost(target: string, options: { file?: string; run?: ChildRun } = {}) {
  const file = options.file ?? hostsFile(), run = options.run ?? defaultChildRun;
  if (target.length > 300 || !hostTargetPattern.test(target)) throw new Error(`Name the host as USER@HOST, USER@HOST:PORT or an ssh-config alias, for example ${hostUser}@omarchypc:${computePort}: got ${JSON.stringify(target)}`);
  const hosts = await readHosts(file);
  if (hosts.some(host => host.target === target)) return { added: false, hosts };
  const host = targetHost(target);
  const refuse = (reason: string) => { throw new Error(`${target} was not added: ${reason}`); };
  const shell = await opensPlainShell(target, run);
  if (shell === 'yes') refuse(`its SSH key opens a plain shell, so Graphyard could reach everything that user can; run graphyard host prepare and the script it prints there, then add ${hostUser}@${host} (${hostUser}@${host}:${computePort} where port 22 is Tailscale SSH)`);
  if (shell !== 'no') refuse(shell);
  const probe = await probeHost(target, run);
  if (!probe.ok) refuse(probe.reason);
  if (probe.ok && probe.uid === 0) refuse(`it logs in as root; add the unprivileged ${hostUser} user that graphyard host prepare creates`);
  if (probe.ok && probe.groups.includes('docker')) refuse(`${target.split('@')[0]} is in the docker group, which is root on that host; use ${hostUser} with rootless Docker (graphyard host prepare)`);
  const next = [...hosts, { target, addedAt: new Date().toISOString() }];
  await writeHosts(file, next);
  return { added: true, hosts: next, probe: probe.ok ? probe : null, operator: await operatorLogin(target, run) };
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
