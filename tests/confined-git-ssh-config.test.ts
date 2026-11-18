import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coordinatorConfinement, credentialMaskFor, sessionMountNamespaceWorks, type MaskProbe } from '../src/master/confinement.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
import { pushEnvironment } from '../src/merge-writer/executor.js';
import { fetchRefusalLine } from '../src/daemon/cycle-batch-gate.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3470: Huck's confined coordinator fetched its base branch graphyard-main over SSH and ssh
// refused before dialling anything: "Bad owner or permissions on
// /etc/ssh/ssh_config.d/20-omarchy-keepalive.conf" — a root-owned system include reads as nobody
// inside the user namespace. The loop then reported it as a SAML/deploy-key authorization failure.
// Under real bubblewrap, the confinement's own words run with such a foreign-owned include in the
// system include directory; the fetch presents the assigned deploy key through the merge writer's
// own SSH environment, against a fixture origin whose door is the real ssh's own configuration
// parse (`ssh -G` with the exact options git passes) before it serves the bare repository.

const hostProbe: MaskProbe = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const omarchyInclude = '/etc/ssh/ssh_config.d/20-omarchy-keepalive.conf';

/** A confined session of a fixture project whose origin serves graphyard-main only to the deploy key, over a door that parses ssh's real configuration first. */
async function confinedFixture(run: (fixture: { worktree: string; spawn: (script: string) => ReturnType<typeof spawnSync>; doorLog: string }) => Promise<void> | void) {
  // The fixture lives in this checkout: the sandbox replaces /tmp with its own scratch.
  const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  const home = await temporaryDirectory('confined-git-ssh-home', join(checkout, '.graphyard'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const realSsh = execFileSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).trim();
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    // The origin: a bare repository whose non-default base branch carries the project's check.
    const remote = join(home, 'remote'), origin = join(remote, 'huck.git'), seed = join(remote, 'seed'), key = join(remote, 'deploy-key'), bin = join(remote, 'bin'), doorLog = join(remote, 'door.log');
    mkdirSync(bin, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'graphyard-main', origin]);
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'graphyard-main');
    writeFileSync(join(seed, 'check.sh'), 'echo VERIFIED-GRAPHYARD-MAIN\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'base');
    git(seed, 'push', '-q', origin, 'graphyard-main');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'gy-3470-fixture', '-f', key]);
    // The door: real ssh resolves its whole configuration with the options git hands it, refusing
    // as ssh would (its stderr passes through); only then is the deploy key and host-key checking
    // judged and the bare repository served.
    writeFileSync(join(bin, 'ssh'), [
      '#!/bin/sh',
      `resolved=$('${realSsh}' -G "$@") || exit 255`,
      `printf '%s\\n' "$resolved" | grep -qx 'identityfile ${key}' || { echo 'git@github.com: Permission denied (publickey).' >&2; echo refused-identity >> '${doorLog}'; exit 255; }`,
      `printf '%s\\n' "$resolved" | grep -qx 'stricthostkeychecking false' && { echo 'host-key checking disabled' >&2; echo refused-hostkey >> '${doorLog}'; exit 255; }`,
      `printf '%s\\n' "$resolved" | grep -x 'stricthostkeychecking .*' >> '${doorLog}'`,
      'for last do :; done',
      `case "$last" in git-upload-pack*) echo served >> '${doorLog}'; exec git-upload-pack '${origin}';; esac`,
      'exit 255',
    ].join('\n') + '\n');
    chmodSync(join(bin, 'ssh'), 0o755);
    // The coordinator checkout with its SSH origin, and the session's own worktree.
    const root = join(home, 'code', 'hello-huck');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'seed');
    git(root, 'remote', 'add', 'origin', 'git@github.com:cryptob1/hello-huck.git');
    const worktree = join(root, '.graphyard', 'worktrees', 'gy-1-1');
    mkdirSync(dirname(worktree), { recursive: true });
    git(root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree, 'main');
    prepareConfinedGitPaths(root);
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this host');
    const session = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: root, sessionDirectory: worktree, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap', secretsBus: null, maskProbe: hostProbe,
      credentialMask: credentialMaskFor({}, {}, join(home, '.config', 'graphyard')) });
    assert.ok(session);
    // The production words, then the system include directory holding one foreign-owned include:
    // a root-owned host file bound where Omarchy keeps its keepalive include, read inside the
    // namespace as owned by nobody.
    const end = session.wrapper.indexOf('--');
    const wrapper = [...session.wrapper.slice(0, end), '--tmpfs', dirname(omarchyInclude), '--ro-bind', '/etc/passwd', omarchyInclude, ...session.wrapper.slice(end)];
    // The merge writer's own SSH environment: the assigned deploy key and nothing else.
    const env = pushEnvironment(key, { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` });
    const spawn = (script: string) => spawnSync(wrapper[0], [...wrapper.slice(1), '/bin/sh', '-c', script, 'sh', worktree],
      { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', env });
    await run({ worktree, spawn, doorLog });
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const fetchScript = [
  `ls -ln ${omarchyInclude} | awk '{ print "INCLUDE-OWNER-" $3 }'`,
  'git -C "$1" fetch --no-tags origin +refs/heads/graphyard-main:refs/remotes/origin/graphyard-main; echo "FETCH-$?"',
].join('\n');

test('integration:confined-git-ssh-config — a confined fetch over SSH succeeds with a foreign-owned system ssh include present, presenting the assigned deploy key with host-key checking kept', async () => {
  await confinedFixture(({ spawn, doorLog }) => {
    const ran = spawn(fetchScript);
    const output = `${ran.stdout}\n${ran.stderr}`;
    if (process.getuid?.() !== 0) assert.ok(String(ran.stdout).includes('INCLUDE-OWNER-65534\n'), `the include is foreign-owned inside the namespace: ${output.slice(-800)}`);
    assert.ok(!output.includes('Bad owner or permissions'), `ssh refuses no configuration file on ownership: ${output.slice(-800)}`);
    assert.ok(String(ran.stdout).includes('FETCH-0\n'), `the confined fetch succeeded: ${output.slice(-800)}`);
    const door = execFileSync('cat', [doorLog], { encoding: 'utf8' });
    assert.match(door, /^stricthostkeychecking accept-new$/m, 'ssh ran with host-key checking enforced for known hosts, never disabled');
    assert.match(door, /^served$/m, 'the origin served the deploy key');
    assert.doesNotMatch(door, /refused-/, 'the door refused nothing');
  });
});

test('e2e:confined-git-ssh-config — a confined coordinator fetches its configured non-default base branch graphyard-main and proceeds to verification; an ssh config ownership refusal is reported as such, not as SAML', async () => {
  await confinedFixture(({ spawn, doorLog }) => {
    const ran = spawn([fetchScript,
      'git -C "$1" checkout -q --detach refs/remotes/origin/graphyard-main && sh "$1/check.sh"'].join('\n'));
    const output = `${ran.stdout}\n${ran.stderr}`;
    assert.ok(String(ran.stdout).includes('FETCH-0\n'), `the confined coordinator fetched graphyard-main: ${output.slice(-800)}`);
    assert.ok(String(ran.stdout).includes('VERIFIED-GRAPHYARD-MAIN\n'), `verification ran on the fetched base: ${output.slice(-800)}`);
    assert.match(execFileSync('cat', [doorLog], { encoding: 'utf8' }), /^stricthostkeychecking accept-new$/m, 'host-key checking stayed enforced');
  });
  // The loop's fetch-refusal line for ssh's own ownership refusal names that file and the host fault, never SAML or the deploy key's authorization.
  const refused = Object.assign(new Error('Command failed: git fetch --no-tags origin graphyard-main'), {
    stderr: `Bad owner or permissions on ${omarchyInclude}\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n` });
  const line = fetchRefusalLine('cryptob1/hello-huck', 'graphyard-main', refused);
  assert.match(line, /ssh refuses its configuration file \/etc\/ssh\/ssh_config\.d\/20-omarchy-keepalive\.conf/);
  assert.match(line, /not the repository's authorization/);
  assert.doesNotMatch(line, /SAML|authorise the SSH key|--push-auth/);
  // A genuine remote refusal keeps its authorization advice.
  assert.match(fetchRefusalLine('cryptob1/hello-huck', 'graphyard-main', Object.assign(new Error('fetch failed'), { stderr: 'ERROR: The organization has enabled or enforced SAML SSO.\n' })), /SAML organization/);
});
