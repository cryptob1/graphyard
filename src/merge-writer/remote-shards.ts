// Concern: GY-3406 — a trial's test shards fanned out across hosts over SSH. A host is any Linux box
// with Docker, python3 and our SSH key, named in master.json `run.hosts`; this machine is always one.
// Each trial reads every host once, places each shard on the host with the most real free CPU under
// its heat limit, and runs it there with the same trial launcher (slots, heat, cleanup) over SSH. A
// host that drops or turns away a shard has it re-queued on another host: capacity, never a fault.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hostname } from 'node:os';
import type { ChildRun } from '../child-runner.js';
import { shellQuote } from '../shell-quote.js';
import { trialContainerLaunch } from './trial-container.js';
import { cpuSensorNames, trialContainerFault, defaultDiskFloorGb, trialContainerCap, trialHotCelsius, trialPressureBoundSeconds, trialStartOrder } from './trial-load.js';

/** A remote host from master.json `run.hosts`: its name and the SSH destination that reaches it. */
export interface ShardHost { name: string; ssh: string }
/** One host's reading: cores, cores busy (1-minute load), the share of CPU stolen, and its hottest CPU sensor against that sensor's limit. */
export interface HostReading { name: string; cores: number; busy: number; steal: number; celsius: number | null; limit: number; away: boolean }

/** The hosts master.json names under `run.hosts`; none when it names none. */
export function shardHosts(root: string): ShardHost[] {
  try {
    const hosts = JSON.parse(readFileSync(join(root, '.graphyard', 'master.json'), 'utf8')).run?.hosts;
    return Array.isArray(hosts) ? hosts.filter((host): host is ShardHost => typeof host?.name === 'string' && typeof host?.ssh === 'string') : [];
  } catch { return []; }
}

/** Real free CPU in cores: idle cores less the share the hypervisor steals. */
export const realFreeCores = (reading: HostReading) => Math.max(0, reading.cores - reading.busy - reading.steal * reading.cores);
/** A host takes shards while it answers and its hottest CPU sensor is under its limit. */
export const underHeatLimit = (reading: HostReading) => !reading.away && (reading.celsius === null || reading.celsius < reading.limit);

/** The one command that reads a host: JSON of cores, 1-minute load, CPU steal over one second, hottest CPU sensor and its limit. */
export const hostReadingScript = String.raw`
import glob, json, os, time
def read(path):
    try:
        with open(path) as file:
            return file.read().strip()
    except OSError:
        return ''
def stat():
    values = [int(value) for value in read('/proc/stat').split('\n')[0].split()[1:]]
    return sum(values), values[7] if len(values) > 7 else 0
first = stat(); time.sleep(1); second = stat()
hot, limit = None, ${trialHotCelsius}
for path in glob.glob('/sys/class/hwmon/*/temp*_input'):
    value = read(path)
    if not value.isdigit() or read(os.path.dirname(path) + '/name') not in ${JSON.stringify(cpuSensorNames)}:
        continue
    own = ${trialHotCelsius}
    for kind in ('_crit', '_max'):
        bound = read(path.replace('_input', kind))
        if bound.isdigit() and int(bound) > 0:
            own = int(bound) // 1000 - 3
            break
    if hot is None or int(value) // 1000 > hot:
        hot, limit = int(value) // 1000, own
print(json.dumps({'cores': os.cpu_count(), 'busy': os.getloadavg()[0], 'steal': (second[1] - first[1]) / max(1, second[0] - first[0]), 'celsius': hot, 'limit': limit}))
`;
const readingWords = ['python3', '-I', '-S', '-c', hostReadingScript];

/** A host's reading from the script's output; a host whose output does not parse is away. */
export function parseHostReading(name: string, text: string): HostReading {
  try {
    const value = JSON.parse(text.trim().split('\n').at(-1)!) as Partial<HostReading>;
    if (typeof value.cores === 'number' && typeof value.busy === 'number') return { name, cores: value.cores, busy: value.busy, steal: value.steal ?? 0, celsius: value.celsius ?? null, limit: value.limit ?? trialHotCelsius, away: false };
  } catch { /* away */ }
  return { name, cores: 0, busy: 0, steal: 0, celsius: null, limit: trialHotCelsius, away: true };
}

export const sshWords = (ssh: string, host: ShardHost, command: string) => [ssh, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host.ssh, command];

/** This machine's reading and every remote host's, read at once; a host that does not answer is away for this trial. */
export async function readHosts(hosts: readonly ShardHost[], run: ChildRun, ssh = 'ssh'): Promise<HostReading[]> {
  const local = Promise.resolve(run(readingWords[0]!, readingWords.slice(1), { timeoutMs: 15_000 })).then(String, () => '');
  const remote = hosts.map(host => { const [command, ...args] = sshWords(ssh, host, readingWords.map(shellQuote).join(' ')); return Promise.resolve(run(command!, args, { timeoutMs: 20_000 })).then(String, () => ''); });
  const [mine, ...theirs] = await Promise.all([local, ...remote]);
  const own = parseHostReading(hostname(), mine!);
  // This machine always takes shards: an unreadable reading here means only that no sensor or /proc answered.
  return [own.away ? { ...own, away: false, cores: 1 } : own, ...hosts.map((host, index) => parseHostReading(host.name, theirs[index]!))];
}

/** A shard its host turned away — dropped, unreachable, too hot to start, or not ready — to run on another host: capacity, never a fault. */
export class HostDroppedError extends Error {
  constructor(readonly host: string, reason: string) { super(`host ${host} dropped a shard: ${reason}`); this.name = 'HostDroppedError'; }
}

/** One host's place in a trial: how many of its shards run at once, its reading, and how to run one there (absent: this machine). */
export interface PlacedHost<R> { name: string; room: number; reading: HostReading; remote?: R }
export interface ShardPlacement { ran: string[]; queuedWhileIdle: number; dropped: string[] }

/**
 * Run `count` shards across `hosts` (this machine first). Each shard goes to the host with room under
 * its heat limit that has the most real free CPU left once its running shards (`breadth` cores each)
 * are counted, so one trial's shards spread across hosts and none waits while a host has room. With
 * no host able to take one and none running, it goes to this machine, whose launcher waits on heat as
 * before. A host that throws `HostDroppedError` takes no more shards this trial and its shard is
 * re-queued first. `stopped` ends placement once a shard ended the trial; running shards are awaited.
 */
export async function runShardsOnHosts<R>(input: { count: number; hosts: readonly PlacedHost<R>[]; breadth: number; run: (host: PlacedHost<R>, index: number) => Promise<void>; stopped?: () => boolean }): Promise<ShardPlacement> {
  const queue = Array.from({ length: input.count }, (_, index) => index), ran: string[] = [], dropped = new Set<string>();
  const running = new Map(input.hosts.map(host => [host.name, 0]));
  const inFlight = new Set<Promise<void>>();
  let queuedWhileIdle = 0, failure: { error: unknown } | null = null;
  const usable = (host: PlacedHost<R>) => !dropped.has(host.name) && underHeatLimit(host.reading);
  const left = (host: PlacedHost<R>) => realFreeCores(host.reading) - running.get(host.name)! * input.breadth;
  const pick = () => input.hosts.filter(host => usable(host) && running.get(host.name)! < host.room).reduce<PlacedHost<R> | undefined>((best, host) => !best || left(host) > left(best) ? host : best, undefined)
    ?? (inFlight.size ? undefined : input.hosts[0]);
  const start = (host: PlacedHost<R>, index: number) => {
    running.set(host.name, running.get(host.name)! + 1);
    const flight: Promise<void> = input.run(host, index).then(() => { ran[index] = host.name; }, error => {
      if (error instanceof HostDroppedError && host !== input.hosts[0]) { dropped.add(host.name); queue.unshift(index); }
      else failure ??= { error };
    }).finally(() => { running.set(host.name, running.get(host.name)! - 1); inFlight.delete(flight); });
    inFlight.add(flight);
  };
  while (queue.length || inFlight.size) {
    if (queue.length && !failure && !input.stopped?.()) {
      const host = pick();
      if (host) { start(host, queue.shift()!); continue; }
      if (input.hosts.some(other => usable(other) && running.get(other.name) === 0)) queuedWhileIdle++;
    }
    if (!inFlight.size) break;
    await Promise.race(inFlight);
  }
  const failed = failure as { error: unknown } | null;
  if (failed) throw failed.error;
  return { ran: ran.filter(Boolean), queuedWhileIdle, dropped: [...dropped] };
}

/** What a remote shard answered: its exit and output, and the per-file records it wrote. */
export interface RemoteShardEnd { ok: boolean; out: string; status: number | null; records: string }

/** The per-repo mirror a host keeps under its home: one per checkout this install trials from. */
export const mirrorPath = (root: string) => `.graphyard/mirrors/${basename(root).replace(/[^\w.-]/g, '-')}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}.git`;
/** The warm dependency image for a trial image's digest and a lockfile's hash: dependencies installed once, then reused. */
export const warmImageTag = (digest: string, lockHash: string) => `graphyard-warm:${digest.replace(/^sha256:/, '').slice(0, 12)}-${lockHash.slice(0, 12)}`;

/**
 * One trial's remote hosts: each host is made ready once — the commit pushed into its mirror (git sends
 * only what the mirror lacks), unpacked in a fresh run directory, the trial image there by digest
 * (pulled, else `docker save | docker load` over SSH) and the warm dependency image for the image digest
 * and lockfile hash (installed and committed on a miss) — then runs shards with the trial launcher.
 * `close` removes every run directory it made.
 */
export function remoteShardSession(input: { root: string; sha: string; image: string; run: ChildRun; ssh?: string; deadline: number; order?: keyof typeof trialStartOrder }) {
  const ssh = input.ssh ?? 'ssh', mirror = mirrorPath(input.root);
  const remaining = () => Math.max(1_000, input.deadline - Date.now());
  const on = async (host: ShardHost, command: string, stdin?: string[]) => {
    try {
      if (!stdin) { const [program, ...args] = sshWords(ssh, host, command); return String(await input.run(program!, args, { timeoutMs: remaining() })); }
      // A local command's output piped into the host's: `docker save | ssh host docker load`.
      return String(await input.run('sh', ['-c', `"$@" | ${sshWords(ssh, host, command).map(shellQuote).join(' ')}`, 'sh', ...stdin], { timeoutMs: remaining() }));
    } catch (error) {
      throw new HostDroppedError(host.name, error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  };
  const local = async (command: string, args: string[], env?: NodeJS.ProcessEnv) => String(await input.run(command, args, { timeoutMs: remaining(), ...(env ? { env } : {}) })).trim();
  const ready = new Map<string, { host: ShardHost; prepared: Promise<{ directory: string; image: string }> }>();
  const prepare = async (host: ShardHost) => {
    const directory = (await on(host, `git init -q --bare ${mirror} && mkdir -p "$HOME/.graphyard/runs" && mktemp -d "$HOME/.graphyard/runs/trial-XXXXXX"`)).trim();
    try { await local('git', ['-C', input.root, 'push', '-q', '--force', `${host.ssh}:${mirror}`, `${input.sha}:refs/graphyard/${input.sha}`], { ...process.env, GIT_SSH_COMMAND: `${shellQuote(ssh)} -o BatchMode=yes -o ConnectTimeout=10` }); }
    catch (error) { throw new HostDroppedError(host.name, `the commit did not reach its mirror: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`); }
    await on(host, `git --git-dir=${mirror} archive ${input.sha} | tar -x -C ${shellQuote(directory)}`);
    const digest = await local('docker', ['image', 'inspect', '--format', '{{.Id}}', input.image]);
    const has = async (image: string) => (await on(host, `docker image inspect --format '{{.Id}}' ${shellQuote(image)} 2>/dev/null || true`)).trim();
    if (await has(input.image) !== digest) {
      if (input.image.includes('/')) await on(host, `docker pull -q ${shellQuote(input.image)} >/dev/null 2>&1 || true`);
      if (await has(input.image) !== digest) await on(host, 'docker load -q', ['docker', 'save', input.image]);
    }
    const lock = await local('git', ['-C', input.root, 'show', `${input.sha}:package-lock.json`]).catch(() => null);
    if (lock === null) return { directory, image: input.image };
    const warm = warmImageTag(digest, createHash('sha256').update(lock).digest('hex'));
    if (!await has(warm)) {
      const name = `graphyard-warm-${randomUUID().slice(0, 8)}`;
      const install = 'mkdir -p /deps && cp /src/package.json /src/package-lock.json /deps/ && cd /deps && npm ci --no-audit --no-fund';
      await on(host, `docker run --name ${name} --user 0:0 -v ${shellQuote(directory)}:/src:ro --entrypoint /bin/sh ${shellQuote(input.image)} -c ${shellQuote(install)} >/dev/null && docker commit ${name} ${warm} >/dev/null; status=$?; docker rm -f ${name} >/dev/null 2>&1; exit $status`);
    }
    await on(host, `ln -sfn /deps/node_modules ${shellQuote(join(directory, 'node_modules'))}`);
    return { directory, image: warm };
  };
  return {
    /** Run one shard on `host`: its file list written there, `argv(list, records)` run by the trial launcher in the run directory, the output and records brought back. */
    async run(host: ShardHost, reading: HostReading, index: number, files: readonly string[], argv: (list: string, records: string) => string[]): Promise<RemoteShardEnd> {
      if (!ready.has(host.name)) ready.set(host.name, { host, prepared: prepare(host) });
      const { directory, image } = await ready.get(host.name)!.prepared;
      const list = join(directory, `.graphyard-tests-${index + 1}.txt`), records = join(directory, `.graphyard-tests-${index + 1}.jsonl`);
      // The run directory is HOME/.graphyard/runs/trial-…, so the launcher's slots live in that host's own ~/.gy.
      const home = dirname(dirname(dirname(directory)));
      const launcher = trialContainerLaunch({ image, mounts: [[directory, directory, false]], network: 'bridge', deadline: input.deadline, apparmor: null,
        load: { slots: join(home, '.gy', 'trial-slots'), cap: trialContainerCap(reading.cores || 1), order: trialStartOrder[input.order ?? 'merge'], hotCelsius: trialHotCelsius, floorBytes: defaultDiskFloorGb * 1e9, hwmon: '/sys/class/hwmon', pressureBoundSeconds: trialPressureBoundSeconds } });
      const command = `cd ${shellQuote(directory)} && printf '%s\\n' ${files.map(shellQuote).join(' ')} > ${shellQuote(list)} && env -i PATH="$PATH" HOME=/tmp CI=1 ${[...launcher, ...argv(list, records)].map(shellQuote).join(' ')}`;
      const [program, ...args] = sshWords(ssh, host, command);
      let end: Omit<RemoteShardEnd, 'records'>;
      try { end = { ok: true, out: String(await input.run(program!, args, { timeoutMs: remaining() })), status: 0 }; }
      catch (error) {
        const failed = error as { status?: number | null; stdout?: unknown; stderr?: unknown; timedOut?: boolean };
        if (failed.timedOut) throw error;
        const out = `${String(failed.stdout ?? '')}${String(failed.stderr ?? '')}`;
        // SSH's own failure (255), or a launcher that gave up on the host's heat or disk: the shard runs elsewhere.
        const fault = trialContainerFault(out);
        if (failed.status === 255 || failed.status === undefined || fault) throw new HostDroppedError(host.name, fault ?? out.slice(-500));
        end = { ok: false, out, status: failed.status ?? null };
      }
      return { ...end, records: await on(host, `cat ${shellQuote(records)} 2>/dev/null || true`) };
    },
    async close() {
      await Promise.all([...ready.values()].map(async ({ host, prepared }) => {
        const directory = await prepared.then(value => value.directory, () => null);
        if (!directory) return;
        const [program, ...args] = sshWords(ssh, host, `rm -rf -- ${shellQuote(directory)}`);
        await Promise.resolve(input.run(program!, args, { timeoutMs: 60_000 })).catch(() => {});
      }));
    },
  };
}

/** One trial's shard record, for master status: wall time, shards run and run remotely, waits while a host idled, and each host's reading. */
export interface RemoteShardRun { at: string; wallMs: number; shards: number; remote: number; queuedWhileIdle: number; host: string; celsius: number | null; hosts: { name: string; away: boolean; celsius: number | null; freeCores: number }[] }
export const remoteShardRecordPath = (root: string) => join(root, '.graphyard', 'remote-shards.json');
const keptRuns = 20;

export async function recordRemoteShardRun(root: string, run: RemoteShardRun): Promise<void> {
  const path = remoteShardRecordPath(root), runs = [...readRemoteShardRuns(root), run].slice(-keptRuns);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}`;
  await writeFile(temporary, `${JSON.stringify(runs)}\n`);
  await rename(temporary, path);
}
export function readRemoteShardRuns(root: string): RemoteShardRun[] {
  try { const runs = JSON.parse(readFileSync(remoteShardRecordPath(root), 'utf8')); return Array.isArray(runs) ? runs : []; } catch { return []; }
}

/** Master status's remote shard line over the last 20 trials, or null before any trial ran with hosts. */
export function remoteShardSummary(runs: readonly RemoteShardRun[]) {
  if (!runs.length) return null;
  const shards = runs.reduce((sum, run) => sum + run.shards, 0), remote = runs.reduce((sum, run) => sum + run.remote, 0);
  const walls = runs.map(run => run.wallMs).sort((a, b) => a - b), latest = runs.at(-1)!;
  const peaks = runs.map(run => run.celsius).filter((value): value is number => value !== null);
  return {
    trials: runs.length,
    shardsRemote: `${shards ? Math.round(remote / shards * 100) : 0}%`,
    trialWallSeconds: { median: Math.round(walls[Math.floor((walls.length - 1) / 2)]! / 1000), latest: Math.round(latest.wallMs / 1000) },
    queuedWhileHostIdle: runs.reduce((sum, run) => sum + run.queuedWhileIdle, 0),
    peakCelsius: { host: latest.host, celsius: peaks.length ? Math.max(...peaks) : null },
    hosts: latest.hosts.map(host => ({ ...host, state: host.away ? 'away' : 'ready' })),
  };
}

