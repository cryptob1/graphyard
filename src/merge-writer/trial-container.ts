// The outer trial has a private filesystem, rather than a host Landlock domain:
// its tests can establish their own mount namespaces before applying Landlock.
import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutGitDirectory } from '../master/checkout-git.js';
import { writeFile, readFile } from 'node:fs/promises';
import type { ChildRun } from '../child-runner.js';
import { runTrialE2eCases, type TrialE2eCase } from './e2e-trial.js';
import { composeBounds, composeProjectName, composeStack, defaultDocker, dockerEnvironment } from '../compose-preview.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const trialContainerImage = 'graphyard-trial:local';
export const trialHarness = '/graphyard-harness';
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const harnessModules = dirname(dirname(fileURLToPath(import.meta.resolve('tsx/package.json'))));

// Resolve the invocation's cwd and environment at spawn time, including the E2E
// session host's stdin. Docker never receives candidate-controlled launch flags.
const launch = String.raw`
import json, os, select, signal, subprocess, sys, uuid
spec = json.loads(sys.argv[1])
container_name = 'graphyard-trial-' + uuid.uuid4().hex
if os.getuid() == 0:
    sys.exit('Graphyard trials require a nonroot launcher')
docker = ['docker', '--host', 'unix:///var/run/docker.sock']
args = docker + ['create', '--name', container_name, '-i', '--init',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--security-opt=seccomp=unconfined', '--security-opt=systempaths=unconfined', '--network=' + spec['network'],
        '--user', str(os.getuid()) + ':' + str(os.getgid()),
        '--tmpfs', '/tmp:rw,nosuid,nodev,exec,mode=1777',
        '--tmpfs', '/run:rw,nosuid,nodev,mode=1777', '--workdir', os.getcwd()]
for source, target, readonly in spec['mounts']:
    args += ['--mount', 'type=bind,src=' + source + ',dst=' + target + (',readonly' if readonly else '')]
for name, value in os.environ.items():
    args += ['--env', name + '=' + value]
args += ['--entrypoint', '/usr/bin/env', spec['image']] + sys.argv[2:]
# A separate session owns the container, including after SIGKILL of the launcher
# or its process group. Only the launcher holds the pipe's write end; exec'd
# Docker clients cannot keep it alive. Create before start closes the cleanup
# race where a killed docker-run client still creates a container afterwards.
reader, writer = os.pipe()
guardian = os.fork()
if guardian == 0:
    os.close(writer)
    os.setsid()
    def owner_gone():
        return bool(select.select([reader], [], [], 0)[0])
    try:
        created = subprocess.call(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        if created != 0:
            sys.exit(created)
        status = 137
        if not owner_gone():
            client = subprocess.Popen(docker + ['start', '--attach', '--interactive', container_name])
            while client.poll() is None:
                if select.select([reader], [], [], 0.05)[0]:
                    break
            # Remove first: this also ends the attached client and its output pipes.
            subprocess.run(docker + ['rm', '--force', container_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            status = client.wait()
    finally:
        subprocess.run(docker + ['rm', '--force', container_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os._exit(status if status >= 0 else 128 - status)
os.close(reader)
def stop(number, frame):
    raise SystemExit(128 + number)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    _, status = os.waitpid(guardian, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    os.close(writer)
    # Graceful cancellation waits for removal; SIGKILL is handled by pipe EOF.
    try:
        os.waitpid(guardian, 0)
    except ChildProcessError:
        pass
`;

/** The first writable directory is the disposable allocation that owns boundary scratch. */
export function trialContainerWords(writable: readonly (string | null)[], dependencies: readonly string[] = [], image = process.env.GRAPHYARD_TRIAL_IMAGE ?? trialContainerImage, network = 'bridge'): string[] {
  // The managed allocation is durable. Give this boundary its own empty, sticky
  // /var/tmp, reclaimed with that allocation; never mount the host's /var/tmp.
  const allocation = writable.find((path): path is string => !!path)!;
  const scratch = mkdtempSync(join(allocation, 'var-tmp-'));
  chmodSync(scratch, 0o1777);
  const mounts: [string, string, boolean][] = [];
  const add = (path: string, readonly: boolean, target = path) => {
    // Linked installs and harness dependencies can name the same target. Docker
    // rejects duplicate destinations; keep the writable allocation added first.
    if (existsSync(path) && !mounts.some(mount => mount[1] === target)) mounts.push([realpathSync(path), target, readonly]);
  };
  add(scratch, false, '/var/tmp');
  for (const directory of writable) if (directory) add(directory, false);
  for (const directory of dependencies) { add(directory, true); if (existsSync(directory) && realpathSync(directory) !== directory) add(directory, true, realpathSync(directory)); }
  // Only trusted source and dependencies, never the install's home or credentials.
  add(join(sourceRoot, 'src'), true, join(trialHarness, 'src'));
  add(harnessModules, true, join(trialHarness, 'node_modules'));
  add(join(sourceRoot, 'package.json'), true, join(trialHarness, 'package.json'));
  if (existsSync('/etc/graphyard-trial')) {
    // Nested trial tests have no Docker socket. Reconstruct a private root from
    // the container's toolchain and explicit allocations. No host-root bind or
    // filesystem Landlock domain is inherited, so further sandbox mounts work.
    // A checkout bind already exposes its dependency symlink. Bubblewrap cannot
    // bind onto that link; mount only its real tree. Aliases outside bound
    // directories (including the harness) still need their explicit mounts.
    const nestedMounts = mounts.filter(([source, target, readonly], index) => !readonly || source === target ||
      !mounts.slice(0, index).some(([parentSource, parentTarget]) =>
        target.startsWith(parentTarget + '/') &&
        lstatSync(join(parentSource, target.slice(parentTarget.length))).isSymbolicLink() &&
        realpathSync(join(parentSource, target.slice(parentTarget.length))) === source));
    return ['bwrap', '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-net',
      '--tmpfs', '/', '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
      '--ro-bind', '/opt/graphyard-browsers', '/opt/graphyard-browsers',
      '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
      '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run',
      ...nestedMounts.flatMap(([source, target, readonly]) => [readonly ? '--ro-bind' : '--bind', source, target]),
      '--remount-ro', '/', '--'];
  }
  return ['/usr/bin/python3', '-I', '-S', '-c', launch, JSON.stringify({ image, mounts, network })];
}

/** Dependencies referenced by a linked checkout and its shared install. */
export function trialContainerDependencies(root: string): string[] {
  return [...new Set([checkoutGitDirectory(root), join(root, 'node_modules'), harnessModules].filter(existsSync))];
}

/** Only trusted orchestration receives Docker access; candidate commands receive a private root. */
export async function containerTrialE2e(input: {
  worktree: string; mergeSha: string; proofs: readonly string[]; env: Record<string, string>;
  scratch: string; budgetMs: number; wrapper: readonly string[]; run: ChildRun; log: (line: string) => void;
  networkWrapper: (network: string) => readonly string[];
}): Promise<TrialE2eCase[]> {
  const holds = async (path: string) => {
    try { execFileSync('git', ['-C', input.worktree, 'cat-file', '-e', input.mergeSha + ':' + path], { stdio: 'ignore' }); return true; }
    catch { return false; }
  };
  return runTrialE2eCases({ ...input, holds, runGroup: async (target, proofs, group) => {
    const deadline = Date.now() + group.budgetMs;
    const left = () => Math.max(1, deadline - Date.now());
    let stack: ReturnType<typeof composeStack> | undefined;
    let origin: string | undefined;
    let wrapper = input.wrapper;
    try {
      if ('kind' in target && target.kind === 'compose') {
        const environment = dockerEnvironment(input.env, { DOCKER_HOST: 'unix:///var/run/docker.sock' });
        // Unpredictable project identities prevent collisions between parallel trials of a head.
        const project = composeProjectName('trial-e2e-' + target.id, randomUUID());
        stack = composeStack({ checkout: input.worktree, file: target.file, service: target.service, port: target.port,
          project, environment, variables: {}, bounds: composeBounds(), isolatedTrial: true,
          scratch: await mkdtemp(join(input.scratch, 'compose-')) });
        await stack.start(AbortSignal.timeout(left()), left());
        const id = (await defaultDocker(['ps', '--quiet', '--filter', 'label=com.docker.compose.project=' + project,
          '--filter', 'label=com.docker.compose.service=' + target.service], { env: environment, timeoutMs: left() })).trim();
        if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('the Compose HTTP service has no unique running container');
        wrapper = input.networkWrapper('container:' + id);
        origin = 'http://127.0.0.1:' + target.port;
      }
      const directory = await mkdtemp(join(input.scratch, 'e2e-'));
      const result = join(directory, 'result.json'), script = join(directory, 'run.mjs');
      const data = { worktree: input.worktree, mergeSha: input.mergeSha, env: input.env, scratch: directory, budgetMs: left() };
      await writeFile(script, `
import { runTrialE2eGroup } from '${trialHarness}/src/merge-writer/e2e-trial.ts';
import { writeFileSync } from 'node:fs';
const cases = await runTrialE2eGroup(${JSON.stringify(target)}, ${JSON.stringify(proofs)},
  { ...${JSON.stringify(data)}, proofs: [], holds: async () => true, log: console.log }, ${JSON.stringify(origin)});
writeFileSync(${JSON.stringify(result)}, JSON.stringify(cases));
`);
      input.log(String(await input.run('node', ['--import', `${trialHarness}/node_modules/tsx/dist/loader.mjs`, script], {
        cwd: input.worktree, env: input.env, timeoutMs: left(), wrapper,
      })));
      return JSON.parse(await readFile(result, 'utf8')) as TrialE2eCase[];
    } catch (error) {
      return proofs.map(proof => ({ proof, case: proof.slice(4), executed: 0, failed: 1,
        failingStep: error instanceof Error ? error.message : String(error) }));
    } finally { await stack?.close(); }
  } });
}
