// The outer trial has a private filesystem, rather than a host Landlock domain:
// its tests can establish their own mount namespaces before applying Landlock.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutGitDirectory } from '../master/checkout-git.js';
import { writeFile, readFile } from 'node:fs/promises';
import type { ChildRun } from '../child-runner.js';
import type { TrialE2eCase } from './e2e-trial.js';

export const trialContainerImage = 'graphyard-trial:local';
export const trialHarness = '/graphyard-harness';
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const harnessModules = dirname(dirname(fileURLToPath(import.meta.resolve('tsx/package.json'))));

// Resolve the invocation's cwd and environment at spawn time, including the E2E
// session host's stdin. Docker never receives candidate-controlled launch flags.
const launch = String.raw`
import json, os, signal, subprocess, sys, uuid
spec = json.loads(sys.argv[1])
container_name = 'graphyard-trial-' + uuid.uuid4().hex
if os.getuid() == 0:
    sys.exit('Graphyard trials require a nonroot launcher')
docker = ['docker', '--host', 'unix:///var/run/docker.sock']
args = docker + ['run', '--name', container_name, '--rm', '-i', '--init',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--security-opt=seccomp=unconfined', '--security-opt=systempaths=unconfined', '--network=bridge',
        '--user', str(os.getuid()) + ':' + str(os.getgid()),
        '--tmpfs', '/tmp:rw,nosuid,nodev,exec,mode=1777',
        '--tmpfs', '/var/tmp:rw,nosuid,nodev,exec,mode=1777',
        '--tmpfs', '/run:rw,nosuid,nodev,mode=1777', '--workdir', os.getcwd()]
for source, target, readonly in spec['mounts']:
    args += ['--mount', 'type=bind,src=' + source + ',dst=' + target + (',readonly' if readonly else '')]
for name, value in os.environ.items():
    args += ['--env', name + '=' + value]
args += ['--entrypoint', '/usr/bin/env', spec['image']] + sys.argv[2:]
def stop(number, frame):
    raise SystemExit(128 + number)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    sys.exit(subprocess.call(args))
finally:
    subprocess.run(docker + ['rm', '--force', container_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
`;

export function trialContainerWords(writable: readonly (string | null)[], dependencies: readonly string[] = [], image = process.env.GRAPHYARD_TRIAL_IMAGE ?? trialContainerImage): string[] {
  const mounts: [string, string, boolean][] = [];
  const add = (path: string, readonly: boolean, target = path) => {
    if (existsSync(path)) mounts.push([realpathSync(path), target, readonly]);
  };
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
    return ['bwrap', '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-net',
      '--tmpfs', '/', '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
      '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
      '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp', '--tmpfs', '/run',
      ...mounts.flatMap(([source, target, readonly]) => [readonly ? '--ro-bind' : '--bind', source, target]),
      '--remount-ro', '/', '--'];
  }
  return ['/usr/bin/python3', '-I', '-S', '-c', launch, JSON.stringify({ image, mounts })];
}

/** Dependencies referenced by a linked checkout and its shared install. */
export function trialContainerDependencies(root: string): string[] {
  return [...new Set([checkoutGitDirectory(root), join(root, 'node_modules'), harnessModules].filter(existsSync))];
}

/** Serving and E2E clients share one private network, including loopback binds. */
export async function containerTrialE2e(input: {
  worktree: string; mergeSha: string; proofs: readonly string[]; env: Record<string, string>;
  scratch: string; budgetMs: number; wrapper: readonly string[]; run: ChildRun; log: (line: string) => void;
}): Promise<TrialE2eCase[]> {
  const result = join(input.scratch, 'e2e-result.json');
  const script = join(input.scratch, 'e2e-run.mjs');
  const data = { worktree: input.worktree, mergeSha: input.mergeSha, proofs: input.proofs, env: input.env, scratch: input.scratch, budgetMs: input.budgetMs };
  await writeFile(script, `
import { runTrialE2eCases } from '${trialHarness}/src/merge-writer/e2e-trial.ts';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const input = ${JSON.stringify(data)};
const cases = await runTrialE2eCases({ ...input, log: console.log, holds: async path => {
  try { execFileSync('git', ['-C', input.worktree, 'cat-file', '-e', input.mergeSha + ':' + path], { stdio: 'ignore' }); return true; }
  catch { return false; }
} });
writeFileSync(${JSON.stringify(result)}, JSON.stringify(cases));
`);
  input.log(String(await input.run('node', ['--import', `${trialHarness}/node_modules/tsx/dist/loader.mjs`, script], {
    cwd: input.worktree, env: input.env, timeoutMs: input.budgetMs, wrapper: input.wrapper,
  })));
  return JSON.parse(await readFile(result, 'utf8')) as TrialE2eCase[];
}
