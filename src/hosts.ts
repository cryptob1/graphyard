// Concern: GY-3407 — the hosts Graphyard watches; work runs only on this machine for now. `graphyard host add USER@HOST` checks
// Docker over SSH and records the host in this machine's hosts file; nothing is installed or
// written on the host (the probe only reads). Each loop cycle reads every host with the same
// probe — cores, hottest CPU sensor, steal and the trial containers running now — and this
// machine is listed first. A host that does not answer reads away and is read again next cycle.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { defaultChildRun, type ChildRun } from './child-runner.js';
import { configHome } from './install/secrets.js';
import { cpuSensorNames } from './merge-writer/trial-load.js';
import { cpuStatTotals, stealPercent } from './daemon/cpu-pressure.js';
import { shellQuote } from './shell-quote.js';

export interface HostRecord { target: string; addedAt: string }
export interface HostReading { host: string; local?: boolean; away: boolean; reason?: string; cores: number | null; celsius: number | null; steal: number | null; runs: number | null; stat?: { total: number; steal: number } | null }

/** Machine-wide, beside the machine-share link (team-access.ts): every install's loop on this machine reads the same hosts. */
export const hostsFile = (home = configHome()) => join(home, 'machine', 'hosts.json');
export const hostTargetPattern = /^[a-z_][a-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/;

export async function readHosts(file = hostsFile()): Promise<HostRecord[]> {
  const text = await readFile(file, 'utf8').catch(() => '[]');
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is HostRecord => typeof entry?.target === 'string') : [];
}
const writeHosts = async (file: string, hosts: HostRecord[]) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(hosts, null, 2) + '\n'); };

/** Read-only: Docker's answer, cores, the /proc/stat cpu line, CPU sensors and the trial containers running now. */
export const hostProbeScript = [
  'docker info --format "{{.ID}}" >/dev/null 2>&1 || { echo graphyard-no-docker; exit 0; }',
  'echo "cores $(nproc)"',
  'head -n 1 /proc/stat',
  'for d in /sys/class/hwmon/hwmon*; do n=$(cat "$d/name" 2>/dev/null); for t in "$d"/temp*_input; do [ -r "$t" ] && echo "temp $n $(cat "$t")"; done; done',
  'echo "runs $(docker ps -q --filter name=^graphyard-trial- | wc -l)"',
].join('\n');

export function parseHostProbe(text: string) {
  if (/^graphyard-no-docker$/m.test(text)) return null;
  const number = (pattern: RegExp) => { const value = Number(pattern.exec(text)?.[1]); return Number.isFinite(value) ? value : null; };
  const temps = [...text.matchAll(/^temp (\S+) (\d+)$/gm)].filter(match => cpuSensorNames.includes(match[1]!)).map(match => Math.floor(Number(match[2]) / 1000));
  return { cores: number(/^cores (\d+)$/m), runs: number(/^runs\s+(\d+)$/m), celsius: temps.length ? Math.max(...temps) : null, stat: cpuStatTotals(text) };
}

const lastLine = (text: string) => text.trim().split('\n').filter(Boolean).at(-1) ?? '';

/** One probe of a host (null: this machine): its readings, or the plain reason it cannot be read. */
export async function probeHost(target: string | null, run: ChildRun = defaultChildRun) {
  const command = target ? 'ssh' : 'sh';
  const args = target ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', target, `sh -c ${shellQuote(hostProbeScript)}`] : ['-c', hostProbeScript];
  let output: string;
  try { output = String(await run(command, args, { timeoutMs: 15_000 })); }
  catch (error: any) {
    const detail = lastLine(String(error?.stderr ?? '')) || (error?.timedOut ? 'no answer within 15 seconds' : String(error?.message ?? error));
    return { ok: false as const, reason: target ? `${target} is unreachable over SSH: ${detail}` : `this machine could not be read: ${detail}` };
  }
  const reading = parseHostProbe(output);
  if (!reading) return { ok: false as const, reason: `${target ?? 'this machine'} answers but has no Docker it can use: install Docker there and add ${target?.split('@')[0] ?? 'the user'} to the docker group` };
  return { ok: true as const, ...reading };
}

export async function addHost(target: string, options: { file?: string; run?: ChildRun } = {}) {
  const file = options.file ?? hostsFile();
  if (!hostTargetPattern.test(target)) throw new Error(`Name the host as USER@HOST, for example vish@vish-rexera: got ${JSON.stringify(target)}`);
  const hosts = await readHosts(file);
  if (hosts.some(host => host.target === target)) return { added: false, hosts };
  const probe = await probeHost(target, options.run);
  if (!probe.ok) throw new Error(`${target} was not added: ${probe.reason}`);
  const next = [...hosts, { target, addedAt: new Date().toISOString() }];
  await writeHosts(file, next);
  return { added: true, hosts: next, probe };
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
