// Concern: GY-3412 — graphyard-host-shim, the only command this machine's SSH key may run on a host
// (authorized_keys restrict,command=…, written by `graphyard host prepare`). It runs as the host's
// unprivileged gy-compute user with rootless Docker and answers fixed verbs with validated arguments:
//   probe                          read cores, load, CPU steal, sensors and running trial containers
//   receive-pack REPO SHA          a git pack on stdin into the per-repo mirror ~/.graphyard/mirrors/REPO.git
//   receive-image IMAGE            `docker save` output on stdin, loaded once per warm image
//   prepare-run REPO SHA IMAGE     a checkout of SHA cloned from the mirror under ~/.graphyard/runs,
//                                  or `need-pack LAST` / `need-image` when the host lacks either
//   run-shard RUN INDEX            JSON {files, argv, cpus, deadline} on stdin; the trial launcher runs argv
//                                  in IMAGE with --network=none, CPU, memory and process limits, only RUN mounted
//   fetch-records RUN INDEX        the shard's per-file records
//   clean RUN                      remove a run directory
// Anything else is refused. Containers keep Docker's default seccomp and system paths and never get
// the Docker socket or the network, so a shard reaches no private address, the tailnet or the host.
import { trialLauncher } from './merge-writer/trial-container.js';
import { defaultDiskFloorGb, minimumTrialContainers, trialHotCelsius, trialPressureBoundSeconds, trialStartOrder } from './merge-writer/trial-load.js';

/** Read-only: Docker's answer, cores, load, the /proc/stat cpu line, CPU sensors and the trial containers running now. */
export const hostProbeScript = [
  'docker info --format "{{.ID}}" >/dev/null 2>&1 || { echo graphyard-no-docker; exit 0; }',
  'echo "cores $(nproc)"',
  'echo "load $(cut -d " " -f 1 /proc/loadavg)"',
  'head -n 1 /proc/stat',
  'for d in /sys/class/hwmon/hwmon*; do n=$(cat "$d/name" 2>/dev/null); for t in "$d"/temp*_input; do [ -r "$t" ] && echo "temp $n $(cat "$t")"; done; done',
  'echo "runs $(docker ps -q --filter name=^graphyard-trial- | wc -l)"',
].join('\n');

/** The warm image a host runs shards in: the trial image's digest and the lockfile's hash (`none` without one). */
export const warmImagePattern = /^graphyard-warm:[0-9a-f]{12}-(?:[0-9a-f]{12}|none)$/;

export const hostShimScript = `#!/usr/bin/python3 -I
# graphyard-host-shim: the only command Graphyard's SSH key may run here (graphyard host prepare).
import json, os, re, shutil, subprocess, sys, tempfile, time
LAUNCHER = ${JSON.stringify(trialLauncher)}
PROBE = ${JSON.stringify(hostProbeScript)}
asked = os.environ.get('SSH_ORIGINAL_COMMAND', '')
def refuse():
    sys.stderr.write('graphyard-host-shim refuses: ' + asked + '\\n')
    sys.exit(1)
home = os.path.expanduser('~')
if len(sys.argv) == 3 and sys.argv[1] == '--home':
    home = sys.argv[2]
elif len(sys.argv) != 1:
    refuse()
runtime = '/run/user/%d' % os.getuid()
os.environ['XDG_RUNTIME_DIR'] = runtime
os.environ['DOCKER_HOST'] = 'unix://' + runtime + '/docker.sock'
words = asked.split(' ')
verb, args = words[0], words[1:]
NAME = r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}'
SHA = r'[0-9a-f]{40}(?:[0-9a-f]{24})?'
RUN = r'trial-[A-Za-z0-9_]{6,40}'
IMAGE = ${JSON.stringify(warmImagePattern.source.slice(1, -1))}
INDEX = r'[1-9][0-9]{0,3}'
SHAPES = {'probe': [], 'receive-pack': [NAME, SHA], 'receive-image': [IMAGE], 'prepare-run': [NAME, SHA, IMAGE],
          'run-shard': [RUN, INDEX], 'fetch-records': [RUN, INDEX], 'clean': [RUN]}
if verb not in SHAPES or len(args) != len(SHAPES[verb]) or not all(re.fullmatch(shape, arg) for shape, arg in zip(SHAPES[verb], args)):
    refuse()
mirrors, runs = os.path.join(home, '.graphyard', 'mirrors'), os.path.join(home, '.graphyard', 'runs')
def quiet(*command, **options):
    return subprocess.call(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options) == 0
def has_image(image):
    return quiet('docker', 'image', 'inspect', image)
if verb == 'probe':
    sys.exit(subprocess.call(['sh', '-c', 'echo "user $(id -u) $(id -Gn)"\\n' + PROBE]))
if verb in ('receive-pack', 'prepare-run'):
    mirror = os.path.join(mirrors, args[0] + '.git')
    if not os.path.isdir(mirror):
        os.makedirs(mirrors, exist_ok=True)
        subprocess.check_call(['git', 'init', '-q', '--bare', mirror])
    def has_commit(sha):
        return quiet('git', '--git-dir=' + mirror, 'cat-file', '-e', sha + '^{commit}')
if verb == 'receive-pack':
    subprocess.check_call(['git', '--git-dir=' + mirror, 'index-pack', '--stdin'], stdout=subprocess.DEVNULL)
    if not has_commit(args[1]):
        sys.exit('graphyard-host-shim: the pack does not hold ' + args[1])
    subprocess.check_call(['git', '--git-dir=' + mirror, 'update-ref', 'refs/graphyard/last', args[1]])
    quiet('git', '--git-dir=' + mirror, 'gc', '--auto', '-q')
elif verb == 'receive-image':
    subprocess.check_call(['docker', 'load', '-q'], stdout=subprocess.DEVNULL)
    if not has_image(args[0]):
        sys.exit('graphyard-host-shim: the image stream does not hold ' + args[0])
elif verb == 'prepare-run':
    if not has_commit(args[1]):
        last = subprocess.run(['git', '--git-dir=' + mirror, 'rev-parse', '-q', '--verify', 'refs/graphyard/last'], capture_output=True, text=True).stdout.strip()
        print('need-pack ' + (last or '-'))
        sys.exit(0)
    if not has_image(args[2]):
        print('need-image')
        sys.exit(0)
    os.makedirs(runs, exist_ok=True)
    # Run directories a killed trial left behind over a day ago go first.
    for name in os.listdir(runs):
        if re.fullmatch(RUN, name) and time.time() - os.path.getmtime(os.path.join(runs, name)) > 86400:
            shutil.rmtree(os.path.join(runs, name), ignore_errors=True)
    run = tempfile.mkdtemp(prefix='trial-', dir=runs)
    checkout = os.path.join(run, 'repo')
    # A clone with history, so tests that read the checkout's git log run as they do on this machine; --local hardlinks the mirror's objects.
    subprocess.check_call(['git', 'clone', '-q', '--local', '--no-checkout', mirror, checkout])
    subprocess.check_call(['git', '-C', checkout, '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', args[1]])
    if not args[2].endswith('-none') and not os.path.lexists(os.path.join(checkout, 'node_modules')):
        os.symlink('/deps/node_modules', os.path.join(checkout, 'node_modules'))
    with open(os.path.join(run, 'image'), 'w') as file:
        file.write(args[2])
    print('run ' + os.path.basename(run))
else:
    run = os.path.join(runs, args[0])
    if not os.path.isdir(run):
        sys.exit('graphyard-host-shim: no run ' + args[0])
    if verb == 'clean':
        shutil.rmtree(run, ignore_errors=True)
    elif verb == 'fetch-records':
        try:
            sys.stdout.write(open(os.path.join(run, 'tests-' + args[1] + '.jsonl')).read())
        except OSError:
            pass
    else:
        shard = json.load(sys.stdin)
        files, argv, cpus, deadline = shard.get('files'), shard.get('argv'), shard.get('cpus'), shard.get('deadline')
        strings = lambda values: isinstance(values, list) and 0 < len(values) <= 5000 and all(isinstance(value, str) and '\\0' not in value and '\\n' not in value for value in values)
        if not strings(files) or not strings(argv) or type(cpus) is not int or type(deadline) is not int:
            refuse()
        cores = os.cpu_count() or 1
        cap = max(2, max(${minimumTrialContainers}, cores // 2))
        listed, records = os.path.join(run, 'tests-' + args[1] + '.txt'), os.path.join(run, 'tests-' + args[1] + '.jsonl')
        with open(listed, 'w') as file:
            file.write('\\n'.join(files) + '\\n')
        memory = next((int(line.split()[1]) for line in open('/proc/meminfo') if line.startswith('MemTotal:')), 4 << 20) // 1024 // cap
        spec = {'image': open(os.path.join(run, 'image')).read().strip(), 'mounts': [[run, run, False]], 'network': 'none',
                'deadline': min(deadline, int(time.time() * 1000) + 3 * 3600 * 1000), 'docker': os.environ['DOCKER_HOST'], 'user': '0:0',
                'limits': {'cpus': max(1, min(cpus, cores)), 'memory': '%dm' % max(512, memory), 'pids': 4096},
                'load': {'slots': os.path.join(home, '.gy', 'trial-slots'), 'cap': cap, 'order': ${trialStartOrder.merge}, 'hotCelsius': ${trialHotCelsius},
                         'floorBytes': ${defaultDiskFloorGb * 1e9}, 'hwmon': '/sys/class/hwmon', 'pressureBoundSeconds': ${trialPressureBoundSeconds}}}
        command = [{'{list}': listed, '{records}': records}.get(word, word) for word in argv]
        os.chdir(os.path.join(run, 'repo'))
        sys.stdout.flush()
        sys.exit(subprocess.call([sys.executable, '-I', '-S', '-c', LAUNCHER, json.dumps(spec)] + command,
                                 env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': '/tmp', 'CI': '1'}))
`;
