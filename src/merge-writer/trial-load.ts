// Concern: GY-3189 — what a trial container start waits for: one machine-wide count of running
// containers, the hottest CPU sensor and the disk floor. Merge trials, the batch gate and workers'
// verification runs each size themselves alone; the launcher (trial-container.ts) is what they share.
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

/** What the launcher reads to admit a container. `slots` is per machine, not per install: any install's containers load the same CPUs. */
export interface TrialLoad { slots: string; cap: number; order: number; hotCelsius: number; floorBytes: number; hwmon: string }

/** The load of one start for `root`'s install; `run.diskFloorGb` is the one setting it reads. */
export async function trialLoad(root: string, who: keyof typeof trialStartOrder): Promise<TrialLoad> {
  const run = await readFile(join(root, '.graphyard', 'master.json'), 'utf8').then(text => JSON.parse(text).run ?? {}, () => ({}));
  return { slots: join(homedir(), '.gy', 'trial-slots'), cap: trialContainerCap(), order: trialStartOrder[who], hotCelsius: trialHotCelsius, floorBytes: diskFloorBytes({ run }), hwmon: '/sys/class/hwmon' };
}

const waitingLine = 'graphyard trial container: waiting', startingLine = 'graphyard trial container: starting';
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
def pressure():
    if hottest() >= load['hotCelsius']:
        return 'a CPU sensor reads ' + str(load['hotCelsius']) + 'C or more'
    for source, target, readonly in spec['mounts']:
        space = None if readonly else free(source)
        if space is not None and space < load['floorBytes']:
            return source + ' is under the disk floor'
    return None
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
    queued = None
    said = None
    while True:
        why = pressure()
        slot = None if why else take_slot()
        if slot is not None:
            if queued is not None:
                os.close(queued)
            if said:
                print('${startingLine}', file=sys.stderr, flush=True)
            return slot
        why = why or 'the machine-wide cap of ' + str(load['cap']) + ' trial containers is reached'
        if why != said:
            print('${waitingLine}: ' + why, file=sys.stderr, flush=True)
            said = why
        if queued is None:
            queued = locked('waiting-' + str(load['order']), fcntl.LOCK_SH)
        time.sleep(1)
`;

/** Whether a launcher's output says its container is still waiting to start: that time is no serve command's to answer in. */
export const trialContainerWaiting = (output: string) => output.lastIndexOf(waitingLine) > output.lastIndexOf(startingLine);
