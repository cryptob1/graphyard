import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, rmSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialHostFaultHost } from '../src/merge-writer/trial.js';
import { repositoryTrialImage, repositoryTrialImageTag, trialDockerfile, trialRepositoryImageFault, TrialRepositoryImageError } from '../src/merge-writer/repository-trial-image.js';
import { trialImage } from '../src/merge-writer/trial-container.js';
import { trialImageFaultItem } from '../src/daemon/control-plane.js';

// GY-3275: a managed repository commits graphyard.trial.Dockerfile to extend the trial image with
// its own toolchain. The merge writer builds it from the base tip, caches it by the file's digest and
// the base image, and runs that repository's trials in it; a repository without the file changes
// nothing, and a base tip's build failure is a trial-host fault. A head that edits the file builds
// its own copy first: a broken copy is that head's red verdict, and a head that fixes a broken base
// copy runs in its own image, so the fix lands through an ordinary merge.

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const nested = existsSync('/etc/graphyard-trial');
const check = { check: 'gofake', command: 'gofake verify', source: 'script', reason: 'fixture' };
const policy = () => JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [check] } } });
/** The base tip's Dockerfile: it layers a stub Go toolchain, `gofake`, over the trial image. */
const baseDockerfile = `ARG GRAPHYARD_TRIAL_IMAGE
FROM \${GRAPHYARD_TRIAL_IMAGE}
COPY gofake /usr/local/bin/gofake
`;
const gofake = '#!/bin/sh\n[ "$1" = verify ] && exit 0\nexit 1\n';

/** A fixture repository whose base tip already carries the file, and the managed root its trial checks out under. */
async function repository(files: Record<string, string>) {
  const root = await temporaryDirectory('trial-image-repo'), base = await temporaryDirectory('trial-image-base');
  git(root, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  if (files.gofake) chmodSync(join(root, 'gofake'), 0o755); // git records the bit, so the image's COPY carries it
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  return { root, base, tip: git(root, 'rev-parse', 'HEAD') };
}
/** One head on the base tip: `change` edits the working tree, and the commit is the head a trial merges. */
const head = (root: string, message: string, change: (root: string) => void) => {
  change(root);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
};

/** A docker stub first on the trial's PATH: it records every call, answers `image inspect` from what it has built, and fails builds while `failMarker` exists or whose Dockerfile runs `RUN false`. */
async function dockerStub(failMarker: string) {
  const stub = await temporaryDirectory('trial-image-docker'), dockerLog = join(stub, 'docker.log'), gofakeLog = join(stub, 'gofake.log');
  writeFileSync(join(stub, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> '${dockerLog}'
if [ "$1" = image ] && [ "$2" = inspect ]; then
  if grep -q -- "--tag $3" '${dockerLog}'; then exit 0; fi
  echo "No such image: $3" >&2; exit 1
fi
if [ "$1" = build ] && [ -e '${failMarker}' ]; then echo 'failed to solve: the stub refuses to build' >&2; exit 1; fi
eval context=\\\${$#}
if [ "$1" = build ] && grep -q 'RUN false' "$context/${trialDockerfile}"; then echo 'process "/bin/sh -c false" did not complete successfully' >&2; exit 1; fi
exit 0
`, { mode: 0o755 });
  writeFileSync(join(stub, 'gofake'), `#!/bin/sh
printf '%s\\n' "$*" >> '${gofakeLog}'
[ "$1" = verify ] && exit 0
exit 1
`, { mode: 0o755 });
  return { stub, dockerLog, gofakeLog, lines: (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean) };
}

// The trial puts the running Node's directory first on PATH, where a host's real docker may also
// be: run as a Node in the stub's directory, so `docker` and `gofake` resolve to the stubs. Children
// run unwrapped, as the Docker-less suite's do; the wrapper each child would run under is recorded
// (host-side calls — the image's own docker — carry none).
const recordingRun = (wrappers: (readonly string[])[]): ChildRun => (command, args, options = {}) => {
  if (command === 'git') return defaultChildRun(command, args, options);
  wrappers.push(options.wrapper ?? []);
  return defaultChildRun(command, args, { ...options, wrapper: undefined });
};
const confinedWrappers = (wrappers: readonly (readonly string[])[]) => wrappers.filter(wrapper => wrapper.length);
const runsIn = (wrapper: readonly string[], image: string) => nested || wrapper.some(word => word.includes(`"image":"${image}"`));

test('unit:tests/repository-trial-image.test.ts — the image tag keys on the Dockerfile, the base image and the repository: an edit changes it, two repositories never share one', () => {
  const tag = repositoryTrialImageTag('/repos/a', 'graphyard-trial:local', 'FROM one\n');
  assert.match(tag, /^graphyard-trial-repo:[0-9a-f]{24}$/);
  assert.equal(tag, repositoryTrialImageTag('/repos/a', 'graphyard-trial:local', 'FROM one\n'));
  assert.notEqual(tag, repositoryTrialImageTag('/repos/a', 'graphyard-trial:local', 'FROM two\n'));
  assert.notEqual(tag, repositoryTrialImageTag('/repos/a', 'published:1', 'FROM one\n'));
  assert.notEqual(tag, repositoryTrialImageTag('/repos/b', 'graphyard-trial:local', 'FROM one\n'));
});

test('unit:tests/repository-trial-image.test.ts — a repository without the file answers null and no docker is called; one with the file reuses a built image without building again', { timeout: 60_000 }, async () => {
  const bare = await repository({ 'README.md': 'no trial image\n', 'graphyard.json': policy() });
  const calls: string[][] = [];
  const none = await repositoryTrialImage({ root: bare.root, tip: bare.tip, scratch: bare.base, env: { PATH: process.env.PATH! }, timeoutMs: 30_000,
    run: (command, args, options = {}) => { calls.push([command, ...args]); return defaultChildRun(command, args, options); } });
  assert.equal(none, null);
  assert.equal(calls.some(([command]) => command === 'docker'), false, 'a repository without the file touches no docker');

  const fixture = await repository({ [trialDockerfile]: baseDockerfile, gofake, 'graphyard.json': policy() });
  const run: ChildRun = (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === 'docker') return ''; // `image inspect`: the image is present
    return defaultChildRun(command, args, options);
  };
  const cached = await repositoryTrialImage({ root: fixture.root, tip: fixture.tip, scratch: fixture.base, env: { PATH: process.env.PATH! }, timeoutMs: 30_000, run });
  assert.equal(cached, repositoryTrialImageTag(fixture.root, trialImage(), baseDockerfile));
  assert.deepEqual(calls.filter(([command]) => command === 'docker'), [['docker', 'image', 'inspect', cached!]], 'a built image is inspected, not rebuilt');
});

test('unit:tests/repository-trial-image.test.ts — a first build checks out the tip as its context, builds over the base image, and removes the worktree', { timeout: 60_000 }, async () => {
  const fixture = await repository({ [trialDockerfile]: baseDockerfile, gofake, 'graphyard.json': policy() });
  const calls: string[][] = [];
  const steps: string[] = [];
  const run: ChildRun = (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === 'docker') {
      if (args[0] === 'image') throw Object.assign(new Error('no such image'), { status: 1, stdout: '', stderr: 'No such image' });
      return ''; // the build: recorded above
    }
    return defaultChildRun(command, args, options);
  };
  const built = await repositoryTrialImage({ root: fixture.root, tip: fixture.tip, scratch: fixture.base, env: { PATH: process.env.PATH! }, timeoutMs: 60_000, run, onStep: step => steps.push(step) });
  assert.equal(built, repositoryTrialImageTag(fixture.root, trialImage(), baseDockerfile));
  const build = calls.find(([command, first]) => command === 'docker' && first === 'build')!;
  assert.ok(build, 'the image is built');
  assert.deepEqual(build.slice(2, 5), ['--build-arg', `GRAPHYARD_TRIAL_IMAGE=${trialImage()}`, '--file']);
  assert.equal(build[5], trialDockerfile);
  assert.equal(build[6], '--tag');
  assert.equal(build[7], built);
  const worktreeAdd = calls.find(([command, , , first, second]) => command === 'git' && first === 'worktree' && second === 'add');
  assert.ok(worktreeAdd, 'the build context is a worktree of the tip');
  assert.equal(worktreeAdd![7], fixture.tip, 'the context is the tip it was given');
  assert.equal(existsSync(worktreeAdd![6]!), false, 'the context worktree is removed after the build');
  assert.ok(calls.some(([command, , , first, second]) => command === 'git' && first === 'worktree' && second === 'remove'), 'the worktree is unregistered');
  assert.deepEqual(steps, ['install: repository image']);
});

test('unit:tests/repository-trial-image.test.ts — a build that fails is a trial-host fault naming its output, read again from the message alone, and never a fetch fault', { timeout: 60_000 }, async () => {
  const fixture = await repository({ [trialDockerfile]: baseDockerfile, gofake, 'graphyard.json': policy() });
  const run: ChildRun = (command, args, options = {}) => {
    if (command === 'docker' && args[0] === 'image') throw Object.assign(new Error('no such image'), { status: 1, stdout: '', stderr: 'No such image' });
    if (command === 'docker' && args[0] === 'build') throw Object.assign(new Error('build failed'), { status: 1, stdout: '', stderr: 'failed to solve: no such file or directory' });
    return defaultChildRun(command, args, options);
  };
  const failed = await repositoryTrialImage({ root: fixture.root, tip: fixture.tip, scratch: fixture.base, env: { PATH: process.env.PATH! }, timeoutMs: 60_000, run }).then(() => null, (error: unknown) => error);
  assert.ok(failed instanceof TrialRepositoryImageError, `a trial-host fault, not a red verdict: ${String(failed)}`);
  assert.match(failed.message, /^Trial-host fault: /);
  assert.match(failed.message, /failed to solve/);
  assert.equal(trialRepositoryImageFault(failed), trialRepositoryImageFault(new Error(failed.message)), 'the fault survives a process boundary as its message');
  assert.notEqual(trialRepositoryImageFault(failed), null);
  assert.equal(trialHostFaultHost(failed), null, 'a build fault is no fetch fault');
  const item = trialImageFaultItem('owner/game');
  assert.match(item.title, /Merge trials cannot build owner\/game's trial image/);
  assert.match(item.description, /graphyard\.trial\.Dockerfile/);
});

// AC-1: the real merge-trial path with a stub docker and a stub gofake standing in for the tool the
// image adds. Two trials of one base build the image once; a candidate that edits the Dockerfile is
// built and still runs the base tip's image, a broken edit is refused; a repository without the file
// builds nothing and runs the standard image; a base tip build that fails is a trial-host fault the
// head is not refused for, unless the head fixes the file, which then passes in its own image.
test('e2e:repository-trial-image — a fixture with graphyard.trial.Dockerfile passes its merge trial in its own image, built once for two trials; a candidate edit is built yet keeps the base tip\'s image; a broken edit is refused; a repository without the file builds nothing; a failing base build is a trial-host fault; a head fixing a broken base copy passes in its own image', { timeout: 300_000 }, async () => {
  const failMarker = join(await temporaryDirectory('trial-image-fail'), 'fail');
  const stub = await dockerStub(failMarker);
  const execPath = process.execPath;
  symlinkSync(process.execPath, join(stub.stub, 'node'));
  process.execPath = join(stub.stub, 'node');
  try {
    const fixture = await repository({ [trialDockerfile]: baseDockerfile, gofake, 'graphyard.json': policy(), 'README.md': 'base\n' });
    const expected = repositoryTrialImageTag(fixture.root, trialImage(), baseDockerfile);
    const wrappers: (readonly string[])[] = [];
    const trial = (mergeSha: string, onStep?: (step: string) => void, changedFiles = ['README.md']) => runTrial({ root: fixture.root, base: fixture.base, mergeSha, baseTip: fixture.tip,
      changedFiles, timeoutMs: 120_000, key: 'GY-3275', retries: 0, environment: { PATH: process.env.PATH! }, run: recordingRun(wrappers), ...(onStep ? { onStep } : {}) });

    // Two trials of one base: the first builds the image, the second reuses it.
    const steps: string[] = [];
    const first = await trial(head(fixture.root, 'first head', root => writeFileSync(join(root, 'README.md'), 'first\n')), step => steps.push(step));
    assert.deepEqual(first.tests, { passed: 1, failed: [], files: 1 }, first.logTail);
    assert.ok(steps.includes('install: repository image'), `the build names its step: ${steps.join(', ')}`);
    const second = await trial(head(fixture.root, 'second head', root => writeFileSync(join(root, 'README.md'), 'second\n')));
    assert.deepEqual(second.tests, { passed: 1, failed: [], files: 1 }, second.logTail);
    assert.equal(stub.lines(stub.dockerLog).filter(line => line.startsWith('build ')).length, 1, 'the image is built once for two trials');
    assert.equal(stub.lines(stub.dockerLog).filter(line => line.startsWith('image inspect ')).length, 2, 'each trial checks the cache first');
    assert.deepEqual(stub.lines(stub.gofakeLog), ['verify', 'verify'], 'the check ran the tool the image adds, in the trial, twice');
    const confined = confinedWrappers(wrappers);
    assert.equal(confined.length, 2, `two trials, one confined child each: ${wrappers.length} recorded`);
    for (const wrapper of confined) assert.ok(runsIn(wrapper, expected), 'the trial\'s children run in the repository\'s image');

    // A candidate that edits the Dockerfile builds its own copy, yet its checks still run in the base tip's image.
    const editedDockerfile = `${baseDockerfile}# the head's edit\n`, editedTag = repositoryTrialImageTag(fixture.root, trialImage(), editedDockerfile);
    const editedWrappers = wrappers.length;
    const edited = await trial(head(fixture.root, 'edits the dockerfile', root => writeFileSync(join(root, trialDockerfile), editedDockerfile)), undefined, [trialDockerfile]);
    assert.deepEqual(edited.tests, { passed: 1, failed: [], files: 1 }, edited.logTail);
    const builds = stub.lines(stub.dockerLog).filter(line => line.startsWith('build '));
    assert.equal(builds.length, 2, 'the candidate\'s edit of the Dockerfile is built before it can merge');
    assert.ok(builds[1]!.includes(`--tag ${editedTag}`), 'the second build is the head\'s own copy');
    const editedConfined = confinedWrappers(wrappers.slice(editedWrappers));
    assert.equal(editedConfined.length, 1);
    assert.ok(runsIn(editedConfined[0]!, expected), 'its checks run in the base tip\'s image');

    // A candidate whose Dockerfile does not build is refused: a red verdict on that head, not a trial-host fault.
    const breaking = await trial(head(fixture.root, 'breaks the dockerfile', root => writeFileSync(join(root, trialDockerfile), `${baseDockerfile}RUN false\n`)), undefined, [trialDockerfile]);
    assert.equal(breaking.build, 'fail', breaking.logTail);
    assert.deepEqual(breaking.tests.failed, [trialDockerfile]);
    assert.match(breaking.logTail, /did not complete successfully/);
    const beforeBare = stub.lines(stub.dockerLog).length;

    // A repository without the file runs the standard image and builds nothing.
    const bare = await repository({ 'graphyard.json': policy(), 'README.md': 'no trial image\n' });
    const bareWrappers: (readonly string[])[] = [];
    const bareTrial = await runTrial({ root: bare.root, base: bare.base, mergeSha: head(bare.root, 'no image', root => writeFileSync(join(root, 'README.md'), 'changed\n')),
      baseTip: bare.tip, changedFiles: ['README.md'], timeoutMs: 120_000, key: 'GY-3275', retries: 0, environment: { PATH: process.env.PATH! }, run: recordingRun(bareWrappers) });
    assert.deepEqual(bareTrial.tests, { passed: 1, failed: [], files: 1 }, bareTrial.logTail);
    assert.equal(stub.lines(stub.dockerLog).length, beforeBare, 'a repository without the file adds no docker call');
    const bareConfined = confinedWrappers(bareWrappers);
    assert.equal(bareConfined.length, 1);
    assert.ok(runsIn(bareConfined[0]!, trialImage()), 'its children run in the standard image');

    // A build that fails is a trial-host fault, not a red head: no verdict, no retry, the head neither refused nor reworked.
    writeFileSync(failMarker, '');
    let attempts = 0;
    const broken = await repository({ [trialDockerfile]: baseDockerfile, gofake, 'graphyard.json': policy() });
    const fault = await runTrial({ root: broken.root, base: broken.base, mergeSha: head(broken.root, 'a head to try', root => writeFileSync(join(root, 'README.md'), 'changed\n')),
      baseTip: broken.tip, changedFiles: ['README.md'], timeoutMs: 120_000, key: 'GY-3275', environment: { PATH: process.env.PATH! }, run: recordingRun([]), onAttempt: () => { attempts++; } }).then(() => null, (error: unknown) => error);
    assert.ok(fault instanceof TrialRepositoryImageError, `a trial-host fault, not a red verdict: ${String(fault)}`);
    assert.match(fault.message, /failed to solve: the stub refuses to build/);
    assert.equal(attempts, 1, 'a build fault is not retried');

    rmSync(failMarker);
    // A base tip whose Dockerfile no longer builds does not freeze the repository: a head that fixes the file runs in its own image and passes.
    const frozen = await repository({ [trialDockerfile]: `${baseDockerfile}RUN false\n`, gofake, 'graphyard.json': policy() });
    const fixWrappers: (readonly string[])[] = [];
    const fixed = await runTrial({ root: frozen.root, base: frozen.base, mergeSha: head(frozen.root, 'fixes the dockerfile', root => writeFileSync(join(root, trialDockerfile), baseDockerfile)),
      baseTip: frozen.tip, changedFiles: [trialDockerfile], timeoutMs: 120_000, key: 'GY-3275', retries: 0, environment: { PATH: process.env.PATH! }, run: recordingRun(fixWrappers) });
    assert.deepEqual(fixed.tests, { passed: 1, failed: [], files: 1 }, fixed.logTail);
    const fixConfined = confinedWrappers(fixWrappers);
    assert.equal(fixConfined.length, 1);
    assert.ok(runsIn(fixConfined[0]!, repositoryTrialImageTag(frozen.root, trialImage(), baseDockerfile)), 'the fixing head\'s checks run in its own image');
  } finally { process.execPath = execPath; }
});

// AC-2's shape on a real Docker host: the image the trial builds really adds the tool, and the
// repository's check only passes inside it. Run by hand post-deploy with GRAPHYARD_TRIAL_IMAGE_E2E=1.
test('live:repository-trial-image — a real trial builds the image and runs the repository\'s check in it, cleaning the image up after', {
  timeout: 900_000, skip: process.env.GRAPHYARD_TRIAL_IMAGE_E2E === '1' ? false : 'needs Docker: GRAPHYARD_TRIAL_IMAGE_E2E=1 on a Docker host',
}, async () => {
  assert.equal(nested, false, 'runs on a Docker host');
  const fixture = await repository({ [trialDockerfile]: baseDockerfile, gofake, 'graphyard.json': policy(), 'README.md': 'base\n' });
  const trial = await runTrial({ root: fixture.root, base: fixture.base, mergeSha: head(fixture.root, 'a head', root => writeFileSync(join(root, 'README.md'), 'changed\n')),
    baseTip: fixture.tip, changedFiles: ['README.md'], timeoutMs: 600_000, key: 'GY-3275-LIVE', retries: 0, environment: { PATH: process.env.PATH! } });
  assert.deepEqual(trial.tests, { passed: 1, failed: [], files: 1 }, trial.logTail);
  for (const tag of [repositoryTrialImageTag(fixture.root, trialImage(), baseDockerfile)]) {
    try { execFileSync('docker', ['image', 'rm', tag], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
});
