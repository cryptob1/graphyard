import { trialCpuMonitor, trialOverloadPrefix } from './trial-cpu.js';
// Concern: GY-3189 — what a trial container start waits for: one machine-wide count of running
// containers, the hottest CPU sensor and the disk floor. Merge trials, the batch gate and workers'
// verification runs share the launcher (trial-container.ts); trials also divide their CPU lanes.
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { join } from 'node:path';

/** The free space every volume Graphyard writes keeps, when master.json sets no `run.diskFloorGb`. */
export const defaultDiskFloorGb = 30;
export const diskFloorBytes = (config: { run: { diskFloorGb?: number } }) => (config.run.diskFloorGb ?? defaultDiskFloorGb) * 1e9;

/** One lane per allocated core (GY-3352); sharing keeps at least two lanes unless files or memory cap it. */
export const trialShardLanes = (cores: number) => Math.max(2, Math.floor(cores));
/** Two lanes per busy trial (GY-3352), bounded by the host and any configured upper bound. */
export const trialSlotCount = (cores: number, requested: number, affordableFiles: number | null = null) =>
  Math.max(1, Math.min(requested, Math.floor(cores / 2), affordableFiles === null ? Infinity : Math.floor(affordableFiles / 2)));
/** The trials that can each hold a serve and a session container at once: a smaller cap would leave them all waiting on each other. */
export const minimumTrialContainers = 6;
/** Scale the normal cap by CPU not stolen, leaving room for a serve/session pair. */
export const trialContainerCap = (cores = availableParallelism(), usable = cores) => Math.max(2, Math.floor(Math.max(minimumTrialContainers, Math.floor(cores / 2)) * usable / cores));
/** The hwmon sensor names that read a CPU, for the trial guard here and the loop's launch guard (GY-3373). */
export const cpuSensorNames = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'];
/** GY-3376, GY-3416: a start waits while a CPU sensor reads the lower of this and 3C under its own critical (else max) temperature — a laptop at 95-98C against a 102C crit-3 was never held; this alone is the limit for a sensor that reports neither. */
export const trialHotCelsius = 85;
/** The CPU package sensor under `hwmon` in whole degrees (the hottest core where no package sensor exists); null where none is readable. */
export async function cpuCelsius(hwmon = '/sys/class/hwmon'): Promise<number | null> {
  const read = (path: string) => readFile(path, 'utf8').then(text => text.trim(), () => '');
  const readings = (await Promise.all((await readdir(hwmon).catch(() => [] as string[])).map(async sensor => {
    if (!cpuSensorNames.includes(await read(join(hwmon, sensor, 'name')))) return [];
    const inputs = (await readdir(join(hwmon, sensor)).catch(() => [] as string[])).filter(name => name.startsWith('temp') && name.endsWith('_input'));
    return (await Promise.all(inputs.map(async name => ({ text: await read(join(hwmon, sensor, name)), label: await read(join(hwmon, sensor, name.replace('_input', '_label'))) }))))
      .filter(({ text }) => /^\d+$/.test(text)).map(({ text, label }) => ({ celsius: Math.floor(Number(text) / 1000), package: /^(Package id|Tctl|Tdie)/.test(label) }));
  }))).flat();
  const packages = readings.filter(reading => reading.package), chosen = packages.length ? packages : readings;
  return chosen.length ? Math.max(...chosen.map(reading => reading.celsius)) : null;
}

/** The batch gate's key in the trial, a proofless pseudo-item. */
export const gateTrialKey = 'batch-gate';
/** GY-3474: the owner a trial's container starts carry in their wait markers: the install and the commit it trials. */
export const trialStartOwner = (root: string, commit: string) => `${root} ${commit}`;
/** GY-3444: the gate's containers' CPU weight (Docker's default is 1024), so under load its checks run ahead of merge trials and worker verification. */
export const gateCpuShares = 4096;
/** Who starts first once a start can go: the lower number. GY-3444: the batch gate's checks first, so a loaded host never starves the deploy path. */
export const trialStartOrder = { gate: 0, merge: 1, verification: 2 } as const;

/**
 * GY-3332: how long a start waits on host pressure (heat, the disk floor) before it fails as a trial-host
 * fault, with no verdict on its head. A wait for a slot under the cap is capacity, not a fault (GY-3390):
 * every start waits its turn, bounded only by its own run's deadline (a worker verification's 55 minutes).
 */
export const trialPressureBoundSeconds = 10 * 60;

/** What the launcher reads to admit a container. `slots` is per machine, not per install: any install's containers load the same CPUs. */
export interface TrialLoad { slots: string; cap: number; order: number; /** GY-3444: Docker --cpu-shares, set for the gate alone. */ cpuShares?: number; /** GY-3444: the gate's cap while the CPU is hot: it starts within it instead of waiting on heat. */ hotCap?: number; /** GY-3474: whose start this is — the install root and commit — written into its wait marker, so the gate counts its own check's wait alone. */ owner?: string; hotCelsius: number; floorBytes: number; hwmon: string; pressureBoundSeconds: number }

/** The load of one start for `root`'s install; `run.diskFloorGb` is the one setting it reads. */
const hostCpu = trialCpuMonitor();
export async function trialLoad(root: string, who: keyof typeof trialStartOrder, usable = hostCpu.cores(), cores = availableParallelism()): Promise<TrialLoad> {
  const run = await readFile(join(root, '.graphyard', 'master.json'), 'utf8').then(text => JSON.parse(text).run ?? {}, () => ({}));
  return { slots: trialSlots(), cap: trialContainerCap(cores, usable), order: trialStartOrder[who], ...(who === 'gate' ? { cpuShares: gateCpuShares, hotCap: Math.max(1, Math.floor(trialContainerCap(cores, usable) / 2)) } : {}), hotCelsius: trialHotCelsius, floorBytes: diskFloorBytes({ run }), hwmon: '/sys/class/hwmon',
    pressureBoundSeconds: trialPressureBoundSeconds };
}
export const trialSlots = (home = homedir()) => join(home, '.gy', 'trial-slots');

const launcherLine = 'graphyard trial container: ', waitingLine = `${launcherLine}waiting`, startingLine = `${launcherLine}starting`;
/** GY-3535: the line a launcher prints when a heat wait ends, followed by its seconds. */
const heatLine = `${waitingLine}: a CPU sensor held this start `;
/** GY-3535: the seconds every container start in `output` waited for the CPU to cool, summed. */
export const heatWaitSeconds = (output: string) => [...output.matchAll(new RegExp(`${heatLine}(\\d+)s`, 'g'))].reduce((sum, match) => sum + Number(match[1]), 0);
/** GY-3535: a step that failed or timed out after its containers waited over a minute on heat: the host's overload, so the same head is trialled again, never reworked. */
export class TrialHeatError extends Error {
  constructor(step: string, seconds: number) {
    super(`${trialOverloadPrefix} trial slowed by heat: ${step} failed after its containers waited ${seconds}s for the CPU to cool`);
    this.name = 'TrialHeatError';
  }
}
export const trialHeatFault = (error: unknown) => error instanceof Error && error.message.startsWith(`${trialOverloadPrefix} trial slowed by heat`);
/** The words a launcher that gave up waiting ends with: `Trial-host fault: …`, the trial's own host-fault prefix. */
const faultLine = `${launcherLine}Trial-host fault: `;
/** The launcher's Python: `admit()` returns once a container may start, holding its slot in the fd it returns. */
export const trialAdmission = String.raw`
load = spec.get('load')
cpu_sensors = ${JSON.stringify(cpuSensorNames)}
def read(path):
    try:
        with open(path) as file:
            return file.read().strip()
    except OSError:
        return ''
def limit(path):
    # GY-3416: the lower of the constant and the sensor's own critical (else max) minus 3.
    for kind in ('_crit', '_max'):
        value = read(path.replace('_input', kind))
        if value.isdigit() and int(value) > 0:
            return min(load['hotCelsius'], int(value) // 1000 - 3)
    return load['hotCelsius']
def hottest():
    # (reading, limit) of the first CPU sensor at or over its own limit, else None.
    for path in glob.glob(load['hwmon'] + '/*/temp*_input'):
        reading = read(path)
        if reading.isdigit() and read(os.path.dirname(path) + '/name') in cpu_sensors and int(reading) // 1000 >= limit(path):
            return int(reading) // 1000, limit(path)
    return None
def free(path):
    try:
        return int(subprocess.check_output(['df', '--output=avail', '-B1', path], stderr=subprocess.DEVNULL).split()[-1])
    except (OSError, ValueError, IndexError, subprocess.CalledProcessError):
        return None
def gb(size):
    return '%.1f GB' % (size / 1e9)
def cap():
    # GY-3444: a hot CPU never holds the batch gate's start: it starts within half the cap instead.
    return load['hotCap'] if load.get('hotCap') and hottest() else load['cap']
def pressure():
    hot = hottest()
    if hot and not load.get('hotCap'):
        return 'a CPU sensor reads ' + str(hot[0]) + 'C, at or over its ' + str(hot[1]) + 'C limit', False
    for source, target, readonly in spec['mounts']:
        space = None if readonly else free(source)
        if space is not None and space < load['floorBytes']:
            return source + ' is under the disk floor: ' + gb(space) + ' free of the ' + gb(load['floorBytes']) + ' kept free', True
    return None, False
def locked(name, flags):
    fd = os.open(os.path.join(load['slots'], name), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, flags)
        return fd
    except BlockingIOError:
        os.close(fd)
        return None
def take_slot():
    for earlier in range(load['order']):
        probe = locked('waiting-' + str(earlier), fcntl.LOCK_EX | fcntl.LOCK_NB)
        if probe is None:
            return None
        os.close(probe)
    # A lower cap must count containers already holding higher-numbered slots. Serialize
    # counting and claiming, so simultaneous starts cannot both spend the same free capacity.
    admission = locked('admission', fcntl.LOCK_EX)
    spare = None
    try:
        names = set(os.path.basename(path) for path in glob.glob(os.path.join(load['slots'], 'slot-*')))
        allowed = cap()
        names.update('slot-' + str(slot) for slot in range(allowed))
        occupied = 0
        for name in sorted(names):
            fd = locked(name, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if fd is None:
                occupied += 1
            elif spare is None:
                spare = fd
            else:
                os.close(fd)
        if occupied < allowed:
            return spare
        if spare is not None:
            os.close(spare)
        return None
    finally:
        os.close(admission)

def admit():
    # The kernel drops a flock with its last holder, so a killed launcher leaves no slot and no place in the queue.
    os.makedirs(load['slots'], exist_ok=True)
    # A start waiting on the disk floor says so here, for master status; a killed launcher's note names a dead pid.
    note = os.path.join(load['slots'], 'floor-' + str(os.getpid()))
    # GY-3444: any wait says so too, by start order, so the batch gate's bound leaves the wait out.
    waiting = os.path.join(load['slots'], 'wait-' + str(load['order']) + '-' + str(os.getpid()))
    queued = None
    said = None
    began = time.time()
    hot_since = None
    try:
        while True:
            why, floor = pressure()
            # GY-3535: a heat wait says how long it held the start when it ends and every 30s, so a trial killed mid-wait can still tell heat from the head.
            hot = why is not None and why.startswith('a CPU sensor')
            if hot and hot_since is None:
                hot_since = time.time()
            elif hot_since is not None and (not hot or time.time() - hot_since >= 30):
                print('${heatLine}' + str(int(time.time() - hot_since)) + 's', file=sys.stderr, flush=True)
                hot_since = time.time() if hot else None
            slot = None if why else take_slot()
            if floor and why != said:
                with open(note, 'w') as file:
                    file.write(why)
            elif not floor and os.path.exists(note):
                os.remove(note)
            if slot is not None:
                if queued is not None:
                    os.close(queued)
                if said:
                    print('${startingLine}', file=sys.stderr, flush=True)
                return slot
            if why:
                # A start held by host pressure keeps no place in the queue: later-ordered starts go on without it.
                if queued is not None:
                    os.close(queued)
                    queued = None
                bound = load['pressureBoundSeconds']
            else:
                why = 'the machine-wide cap of ' + str(cap()) + ' trial containers is reached'
                if queued is None:
                    queued = locked('waiting-' + str(load['order']), fcntl.LOCK_SH)
                # A slot wait is capacity, never a fault: it has no bound, and only pressure that follows it is timed.
                bound = None
                began = time.time()
            if why != said:
                print('${waitingLine}: ' + why, file=sys.stderr, flush=True)
                if said is None:
                    with open(waiting, 'w') as file:
                        file.write(load.get('owner', ''))
                said = why
            if bound is not None and time.time() - began >= bound:
                print('${faultLine}the trial container waited ' + str(int(time.time() - began)) + 's to start and gave up: ' + why, file=sys.stderr, flush=True)
                sys.exit(75)
            time.sleep(1)
    finally:
        for path in (note, waiting):
            if os.path.exists(path):
                os.remove(path)
`;

/** The launcher's own lines from `chunks` of its stderr, each passed to `line` as it arrives (GY-3332): what a waiting start shows its caller. */
export function launcherLines(line: (text: string) => void): (chunk: string) => void {
  let rest = '';
  return chunk => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop()!;
    for (const text of lines) if (text.startsWith(launcherLine)) line(text.slice(launcherLine.length));
  };
}
/** The trial-host fault a launcher gave up waiting with, from its output; null when it never did. */
export const trialContainerFault = (output: string): string | null => {
  const at = output.lastIndexOf(faultLine);
  return at < 0 ? null : output.slice(at + launcherLine.length).split('\n')[0]!;
};
/** GY-3332: the disk-floor readings live launchers on this machine wait on now, one per start. */
export function trialFloorWaits(slots = trialSlots()): string[] {
  let names: string[];
  try { names = readdirSync(slots); } catch { return []; }
  return names.flatMap(name => {
    const pid = /^floor-(\d+)$/.exec(name)?.[1];
    if (!pid) return [];
    try { process.kill(Number(pid), 0); return [readFileSync(join(slots, name), 'utf8')]; }
    catch { try { unlinkSync(join(slots, name)); } catch { /* another reader took it */ } return []; } // a killed launcher's note
  });
}

/** GY-3444: whether a live launcher on this machine waits to start a container of start order `who` now; GY-3474: with `owner`, only that owner's start. */
export function trialStartWaiting(who: keyof typeof trialStartOrder, slots = trialSlots(), owner?: string): boolean {
  let names: string[];
  try { names = readdirSync(slots); } catch { return false; }
  return names.some(name => {
    const pid = new RegExp(`^wait-${trialStartOrder[who]}-(\\d+)$`).exec(name)?.[1];
    if (!pid) return false;
    try { process.kill(Number(pid), 0); }
    catch { try { unlinkSync(join(slots, name)); } catch { /* another reader took it */ } return false; } // a killed launcher's note
    if (owner === undefined) return true;
    try { return readFileSync(join(slots, name), 'utf8') === owner; } catch { return false; }
  });
}

/** Whether a launcher's output says its container is still waiting to start: that time is no serve command's to answer in. */
export const trialContainerWaiting = (output: string) => output.lastIndexOf(waitingLine) > output.lastIndexOf(startingLine);
/** The one master status attention line while any trial start on this machine waits on the disk floor; none otherwise. */
export function trialFloorAttention(slots = trialSlots()) {
  const waits = trialFloorWaits(slots);
  return waits.length ? [{ subject: 'trial disk floor', text: `${waits.length} trial start(s) wait on the disk floor: ${waits[0]}`,
    next: `Free space on that volume, or lower run.diskFloorGb in .graphyard/master.json; a start that waits ${trialPressureBoundSeconds / 60} minutes fails as a trial-host fault` }] : [];
}
