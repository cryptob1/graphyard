// Concern: GY-3189 — what a trial container start waits for: one machine-wide count of running
// containers, the hottest CPU sensor and the disk floor. Merge trials, the batch gate and workers'
// verification runs each size themselves alone; the launcher (trial-container.ts) is what they share.
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { join } from 'node:path';

/** The free space every volume Graphyard writes keeps, when master.json sets no `run.diskFloorGb`. */
export const defaultDiskFloorGb = 30;
export const diskFloorBytes = (config: { run: { diskFloorGb?: number } }) => (config.run.diskFloorGb ?? defaultDiskFloorGb) * 1e9;

/** How many shards of a trial's tests run at once on a host with `cores` CPUs (GY-1832): half of them, never fewer than one, the rest left to the shards' own test concurrency. */
export const trialShardLanes = (cores: number) => Math.max(1, Math.floor(cores / 2));
/** The trials that can each hold a serve and a session container at once: a smaller cap would leave them all waiting on each other. */
const minimumTrialContainers = 6;
/** The containers a host runs at once: one per trial lane, whichever trials they serve. */
export const trialContainerCap = (cores = availableParallelism()) => Math.max(minimumTrialContainers, trialShardLanes(cores));
/** A start waits while the hottest CPU sensor reads this or more. */
export const trialHotCelsius = 95;
/** The batch gate's key in the trial, a proofless pseudo-item. */
export const gateTrialKey = 'batch-gate';
/** Who starts first once a start can go: the lower number. */
export const trialStartOrder = { merge: 0, gate: 1, verification: 2 } as const;

/**
 * GY-3332: how long a start waits on host pressure (heat, the disk floor) before it fails as a trial-host
 * fault, with no verdict on its head; and how long a worker's verification waits for anything, so
 * `complete` never hangs on a start it cannot see. A merge or gate start's wait for a slot is bounded by its trial's own deadline.
 */
export const trialPressureBoundSeconds = 10 * 60;
export const trialVerificationBoundSeconds = 10 * 60;

/** What the launcher reads to admit a container. `slots` is per machine, not per install: any install's containers load the same CPUs. */
export interface TrialLoad { slots: string; cap: number; order: number; hotCelsius: number; floorBytes: number; hwmon: string; pressureBoundSeconds: number; waitBoundSeconds: number | null }

/** The load of one start for `root`'s install; `run.diskFloorGb` is the one setting it reads. */
export async function trialLoad(root: string, who: keyof typeof trialStartOrder): Promise<TrialLoad> {
  const run = await readFile(join(root, '.graphyard', 'master.json'), 'utf8').then(text => JSON.parse(text).run ?? {}, () => ({}));
  return { slots: trialSlots(), cap: trialContainerCap(), order: trialStartOrder[who], hotCelsius: trialHotCelsius, floorBytes: diskFloorBytes({ run }), hwmon: '/sys/class/hwmon',
    pressureBoundSeconds: trialPressureBoundSeconds, waitBoundSeconds: who === 'verification' ? trialVerificationBoundSeconds : null };
}
export const trialSlots = (home = homedir()) => join(home, '.gy', 'trial-slots');

const launcherLine = 'graphyard trial container: ', waitingLine = `${launcherLine}waiting`, startingLine = `${launcherLine}starting`;
/** The words a launcher that gave up waiting ends with: `Trial-host fault: …`, the trial's own host-fault prefix. */
const faultLine = `${launcherLine}Trial-host fault: `;
/** The launcher's Python: `admit()` returns once a container may start, holding its slot in the fd it returns. */
export const trialAdmission = String.raw`
load = spec.get('load')
cpu_sensors = ('coretemp', 'k10temp', 'zenpower', 'cpu_thermal')
def read(path):
    try:
        with open(path) as file:
            return file.read().strip()
    except OSError:
        return ''
def hottest():
    readings = [read(path) for path in glob.glob(load['hwmon'] + '/*/temp*_input') if read(os.path.dirname(path) + '/name') in cpu_sensors]
    return max([int(reading) // 1000 for reading in readings if reading.isdigit()], default=0)
def free(path):
    try:
        return int(subprocess.check_output(['df', '--output=avail', '-B1', path], stderr=subprocess.DEVNULL).split()[-1])
    except (OSError, ValueError, IndexError, subprocess.CalledProcessError):
        return None
def gb(size):
    return '%.1f GB' % (size / 1e9)
def pressure():
    hot = hottest()
    if hot >= load['hotCelsius']:
        return 'a CPU sensor reads ' + str(hot) + 'C, at or over ' + str(load['hotCelsius']) + 'C', False
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
    for slot in range(load['cap']):
        fd = locked('slot-' + str(slot), fcntl.LOCK_EX | fcntl.LOCK_NB)
        if fd is not None:
            return fd
    return None
def admit():
    # The kernel drops a flock with its last holder, so a killed launcher leaves no slot and no place in the queue.
    os.makedirs(load['slots'], exist_ok=True)
    # A start waiting on the disk floor says so here, for master status; a killed launcher's note names a dead pid.
    note = os.path.join(load['slots'], 'floor-' + str(os.getpid()))
    queued = None
    said = None
    began = time.time()
    try:
        while True:
            why, floor = pressure()
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
                bound = load.get('pressureBoundSeconds')
            else:
                why = 'the machine-wide cap of ' + str(load['cap']) + ' trial containers is reached'
                if queued is None:
                    queued = locked('waiting-' + str(load['order']), fcntl.LOCK_SH)
                bound = load.get('waitBoundSeconds')
            if why != said:
                print('${waitingLine}: ' + why, file=sys.stderr, flush=True)
                said = why
            if bound is not None and time.time() - began >= bound:
                print('${faultLine}the trial container waited ' + str(int(time.time() - began)) + 's to start and gave up: ' + why, file=sys.stderr, flush=True)
                sys.exit(75)
            time.sleep(1)
    finally:
        if os.path.exists(note):
            os.remove(note)
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

/** Whether a launcher's output says its container is still waiting to start: that time is no serve command's to answer in. */
export const trialContainerWaiting = (output: string) => output.lastIndexOf(waitingLine) > output.lastIndexOf(startingLine);
/** The one master status attention line while any trial start on this machine waits on the disk floor; none otherwise. */
export function trialFloorAttention(slots = trialSlots()) {
  const waits = trialFloorWaits(slots);
  return waits.length ? [{ subject: 'trial disk floor', text: `${waits.length} trial start(s) wait on the disk floor: ${waits[0]}`,
    next: `Free space on that volume, or lower run.diskFloorGb in .graphyard/master.json; a start that waits ${trialPressureBoundSeconds / 60} minutes fails as a trial-host fault` }] : [];
}
