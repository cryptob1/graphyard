import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coordinatorConfinement, credentialMaskFor, sessionMountNamespaceWorks, type MaskProbe } from '../src/master/confinement.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3384: confined sessions ran with a scratch HOME while /etc/ssh/ssh_config.d held files the
// user namespace reads as nobody-owned, so ssh refused to start — "Bad owner or permissions" —
// and no private dependency could be fetched over SSH; and the host tree beside the checkout was
// readable read-only, so nothing separated the project's declared sibling checkouts (its private
// dependencies) from every other checkout of the host user. Under real bubblewrap: ssh -G
// localhost runs, a sibling the repository lists in graphyard.json is readable and not writable,
// and an unlisted sibling stays unreadable.

const hostProbe: MaskProbe = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('e2e:confined-ssh-and-siblings — under real bwrap a confined worker runs ssh -G localhost, reads only the sibling the repository declares, and cannot write it', async () => {
  // The fixture HOME lives in this checkout: the sandbox replaces /tmp with its own scratch.
  const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  const home = await temporaryDirectory('confined-ssh-home', join(checkout, '.graphyard'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const parent = join(home, 'code', 'da'), root = join(parent, 'project');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    mkdirSync(root, { recursive: true });
    // The repository declares one sibling readable; the other stays unlisted.
    const listed = join(parent, 'ims-api'), unlisted = join(parent, 'other-checkout');
    writeFileSync(join(root, 'graphyard.json'), JSON.stringify({ confinement: { readonlyPaths: [listed] } }));
    writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'seed');
    const worktree = join(root, '.graphyard', 'worktrees', 'gy-1-1');
    mkdirSync(dirname(worktree), { recursive: true });
    git(root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree, 'main');
    prepareConfinedGitPaths(root);
    for (const [sibling, text] of [[join(listed, 'ims.txt'), 'ims-api-2017\n'], [join(unlisted, 'secret.txt'), 'unlisted-secret\n']] as const) {
      mkdirSync(dirname(sibling), { recursive: true });
      writeFileSync(sibling, text, { mode: 0o600 });
    }
    const configHome = join(home, '.config', 'graphyard'), workerToken = join(configHome, 'own-install', 'workers', 'worker.token');
    mkdirSync(dirname(workerToken), { recursive: true });
    writeFileSync(workerToken, 'worker-own-token\n', { mode: 0o600 });
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this host');

    const worker = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: root, sessionDirectory: worktree, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap', secretsBus: null, maskProbe: hostProbe,
      credentialMask: credentialMaskFor({}, { credentialFile: workerToken }, configHome) });
    assert.ok(worker);
    const flow = [
      'ssh -G localhost >/dev/null 2>/tmp/ssh-config.err; echo "SSH-G-$?"',
      'cat /tmp/ssh-config.err >&2',
      'test -r "$1/ims.txt" && grep -q ims-api-2017 "$1/ims.txt" && echo IMS-READABLE',
      'if touch "$1/written" 2>/dev/null; then echo IMS-WRITABLE; else echo IMS-READ-ONLY; fi',
      'test -r "$2" && cat "$2/secret.txt" >/dev/null 2>&1 && echo UNLISTED-READABLE || echo UNLISTED-DENIED',
      'test -r "$3/graphyard.json" && echo ROOT-READABLE',
    ].join('\n');
    const ran = spawnSync(worker.wrapper[0], [...worker.wrapper.slice(1), '/bin/sh', '-c', flow, 'sh', listed, unlisted, root],
      { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', env: { ...process.env, HOME: home } });
    const output = ran.stdout + '\n' + ran.stderr;
    assert.equal(ran.status, 0, `the confined worker ran: ${output.slice(-800)}`);
    assert.ok(ran.stdout.includes('SSH-G-0\n'), `ssh -G localhost reads the system config without refusing its owner: ${output.slice(-800)}`);
    assert.ok(!output.includes('Bad owner or permissions'), `no ssh config is refused on ownership: ${output.slice(-800)}`);
    assert.ok(ran.stdout.includes('IMS-READABLE\n'), `the declared sibling is readable: ${output.slice(-800)}`);
    assert.ok(ran.stdout.includes('IMS-READ-ONLY\n') && !ran.stdout.includes('IMS-WRITABLE'), `the declared sibling is not writable: ${output.slice(-800)}`);
    assert.ok(ran.stdout.includes('UNLISTED-DENIED\n'), `an unlisted sibling stays unreadable: ${output.slice(-800)}`);
    assert.ok(!output.includes('unlisted-secret'), 'no unlisted sibling content is reachable');
    assert.ok(ran.stdout.includes('ROOT-READABLE\n'), `the project's own checkout stays readable: ${output.slice(-800)}`);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});
