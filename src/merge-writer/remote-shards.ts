// Concern: GY-3412 — a trial's test shards fanned out across hosts over SSH. The hosts are the one host
// list `graphyard host add` keeps (GY-3407); this machine is always one. Each trial reads every host
// once, places each shard on the host with the most real free CPU under its heat limit, and runs it
// there through graphyard-host-shim (src/host-shim.ts), whose fixed verbs are all this machine's key
// may run. A host that drops or turns away a shard has it re-queued on another host: capacity, never a fault.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hostname } from 'node:os';
import type { ChildRun } from '../child-runner.js';
import { shellQuote } from '../shell-quote.js';
import { probeHost, readHosts } from '../hosts.js';
import { trialContainerFault, trialHotCelsius } from './trial-load.js';

/** One host's reading: cores, cores busy (1-minute load), the share of CPU stolen, and its hottest CPU sensor against the heat limit. */
export interface HostReading { name: string; cores: number; busy: number; steal: number; celsius: number | null; limit: number; away: boolean }

/** The targets of the hosts `graphyard host add` recorded; none when it recorded none. */
export const shardHosts = async () => (await readHosts().catch(() => [])).map(host => host.target);

/** Real free CPU in cores: idle cores less the share the hypervisor steals. */
export const realFreeCores = (reading: HostReading) => Math.max(0, reading.cores - reading.busy - reading.steal * reading.cores);
/** A host takes shards while it answers and its hottest CPU sensor is under its limit. */
export const underHeatLimit = (reading: HostReading) => !reading.away && (reading.celsius === null || reading.celsius < reading.limit);

/** This machine's reading and every host's, read at once through the shim's probe; a host that does not answer is away for this trial. */
export async function readShardHosts(targets: readonly string[], run: ChildRun, cores: number): Promise<HostReading[]> {
  return Promise.all([null, ...targets].map(async target => {
    const probe = await probeHost(target, run);
    const name = target ?? hostname();
    // This machine always takes shards: an unreadable reading here means only that its Docker or sensors did not answer.
    if (!probe.ok) return { name, cores: target ? 0 : cores, busy: 0, steal: 0, celsius: null, limit: trialHotCelsius, away: target !== null };
    return { name, cores: probe.cores ?? cores, busy: probe.load ?? 0, steal: probe.stat?.total ? probe.stat.steal / probe.stat.total : 0, celsius: probe.celsius, limit: trialHotCelsius, away: false };
  }));
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

/** The name of this checkout's mirror on a host (~/.graphyard/mirrors/NAME.git): one per checkout this install trials from. */
export const mirrorName = (root: string) => `${createHash('sha1').update(root).digest('hex').slice(0, 8)}-${basename(root).replace(/[^A-Za-z0-9._-]/g, '-')}`.slice(0, 100);
/** The warm image for a trial image's digest and a lockfile's hash (`none` without one): dependencies installed once, then reused. */
export const warmImageTag = (digest: string, lockHash: string) => `graphyard-warm:${digest.replace(/^sha256:/, '').slice(0, 12)}-${lockHash.slice(0, 12)}`;

/**
 * One trial's remote hosts. The warm image — the trial image with the commit's locked dependencies
 * installed in /deps — is built once on this machine, so hosts never need the network. Each host is
 * made ready once through the shim: `prepare-run` answers what it lacks — the commit, sent as a pack of
 * only what its mirror lacks, or the warm image, sent once per tag — then clones the commit into a run
 * directory. Shards run there through the shim's `run-shard`; `close` cleans every run directory.
 */
export function remoteShardSession(input: { root: string; sha: string; image: string; run: ChildRun; deadline: number; signal?: AbortSignal }) {
  const repo = mirrorName(input.root);
  const remaining = () => Math.max(1_000, input.deadline - Date.now());
  const local = async (command: string, args: string[]) => String(await input.run(command, args, { timeoutMs: remaining() })).trim();
  const ssh = (target: string, verb: string) => ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, verb];
  /** One shim verb on `target`, with `source`'s output as its input; any failure turns the host away. */
  const shim = async (target: string, verb: string, source?: string) => {
    try {
      if (!source) { const [program, ...args] = ssh(target, verb); return String(await input.run(program!, args, { timeoutMs: remaining() })); }
      return String(await input.run('sh', ['-c', `set -o pipefail 2>/dev/null; ${source} | ${ssh(target, verb).map(shellQuote).join(' ')}`], { timeoutMs: remaining() }));
    } catch (error) {
      const failed = error as { stderr?: unknown; message?: string };
      throw new HostDroppedError(target, (String(failed.stderr ?? '').trim() || String(failed.message ?? error)).slice(-500));
    }
  };
  let warm: Promise<string> | null = null;
  const warmImage = async () => {
    const digest = await local('docker', ['image', 'inspect', '--format', '{{.Id}}', input.image]);
    const lock = await local('git', ['-C', input.root, 'show', `${input.sha}:package-lock.json`]).catch(() => null);
    const tag = warmImageTag(digest, lock === null ? 'none' : createHash('sha256').update(lock).digest('hex'));
    if (await local('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]).then(() => true, () => false)) return tag;
    if (lock === null) { await local('docker', ['tag', input.image, tag]); return tag; }
    const name = `graphyard-warm-${randomUUID().slice(0, 8)}`, install = 'mkdir -p /deps && cd /deps && tar -xf - && npm ci --no-audit --no-fund >/dev/null';
    try {
      await local('sh', ['-c', `set -o pipefail 2>/dev/null; git -C ${shellQuote(input.root)} archive ${input.sha} package.json package-lock.json | docker run -i --name ${name} --user 0:0 --entrypoint /bin/sh ${shellQuote(input.image)} -c ${shellQuote(install)}`]);
      await local('docker', ['commit', name, tag]);
    } finally { await local('docker', ['rm', '-f', name]).catch(() => {}); }
    return tag;
  };
  const prepare = async (target: string) => {
    const image = await (warm ??= warmImage());
    for (let step = 0; step < 3; step++) {
      const answer = (await shim(target, `prepare-run ${repo} ${input.sha} ${image}`)).trim().split('\n').at(-1) ?? '';
      if (answer.startsWith('run ')) return answer.slice(4);
      if (answer.startsWith('need-pack ')) {
        // Only the objects the mirror lacks travel: the commit less what the mirror's last commit holds, when this checkout knows that commit.
        const last = answer.slice('need-pack '.length);
        const known = /^[0-9a-f]+$/.test(last) && await local('git', ['-C', input.root, 'cat-file', '-e', `${last}^{commit}`]).then(() => true, () => false);
        await shim(target, `receive-pack ${repo} ${input.sha}`, `printf '%s\\n' ${[input.sha, ...(known ? [`^${last}`] : [])].join(' ')} | git -C ${shellQuote(input.root)} pack-objects --revs --stdout -q`);
      } else if (answer === 'need-image') await shim(target, `receive-image ${image}`, `docker save ${image}`);
      else throw new HostDroppedError(target, `prepare-run answered ${answer.slice(0, 200)}`);
    }
    throw new HostDroppedError(target, 'not ready after the commit and image were sent');
  };
  const ready = new Map<string, Promise<string>>();
  return {
    /** Run one shard on `target` through the shim: its files, `argv(list, records)` run by the trial launcher there with `cpus` CPUs, the output and records brought back. */
    async run(target: string, index: number, files: readonly string[], argv: (list: string, records: string) => string[], cpus: number): Promise<RemoteShardEnd> {
      if (!ready.has(target)) ready.set(target, prepare(target));
      const run = await ready.get(target)!, shard = index + 1;
      const request = JSON.stringify({ files, argv: argv('{list}', '{records}'), cpus, deadline: input.deadline });
      const words = ssh(target, `run-shard ${run} ${shard}`);
      let end: Omit<RemoteShardEnd, 'records'>;
      try { end = { ok: true, out: String(await input.run('sh', ['-c', `printf '%s' ${shellQuote(request)} | ${words.map(shellQuote).join(' ')}`], { timeoutMs: remaining(), ...(input.signal ? { signal: input.signal } : {}) })), status: 0 }; }
      catch (error) {
        const failed = error as { status?: number | null; stdout?: unknown; stderr?: unknown; timedOut?: boolean };
        if (failed.timedOut) throw error;
        end = { ok: false, out: `${String(failed.stdout ?? '')}${String(failed.stderr ?? '')}`, status: failed.status ?? null };
      }
      const records = end.ok || end.status !== 255 ? await shim(target, `fetch-records ${run} ${shard}`) : '';
      // SSH's own failure (255), a launcher that gave up on the host's heat or disk, or a shard that died
      // without a verdict (no records): the shard runs on another host, its output's tail kept in the trial log
      // (less the launcher's own waiting lines, which on a hot host would fill it).
      const fault = trialContainerFault(end.out);
      if (!end.ok && (end.status === 255 || end.status === null || fault || !records.trim())) throw new HostDroppedError(target, fault ?? end.out.replace(/^graphyard trial container: (waiting|starting).*\n/gm, '').slice(-500));
      return { ...end, records };
    },
    async close() {
      await Promise.all([...ready.entries()].map(async ([target, prepared]) => {
        const run = await prepared.catch(() => null);
        if (run) await shim(target, `clean ${run}`).catch(() => {});
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

