import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coordinatorConfinement, credentialMaskFor, masterCredentialMask, sessionMountNamespaceWorks, type MaskProbe } from '../src/master/confinement.js';
import { masterSessionConfinement, prepareConfinedGitPaths } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3228: a confined session ran with the whole host readable apart from the install's own
// credential locations, so a worker read the owner's SSH key and gh token and could act as the
// owner on GitHub. Under real bubblewrap, with a fixture HOME holding the usual personal
// credentials, a second install, another agent account and declared extras: a worker and a
// review session read none of them and keep their own work; the master keeps only its own
// install directory and token.

const secret = 'host-credential-secret-'.padEnd(48, 'x');
const ownToken = 'worker-own-token-'.padEnd(40, 'x');
const hostProbe: MaskProbe = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture(home: string) {
  const root = join(home, 'code', 'project');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(root, { recursive: true });
  // The repository declares its own extra mask path, home-relative.
  writeFileSync(join(root, 'graphyard.json'), JSON.stringify({ confinement: { maskPaths: ['~/.config/huck'] } }));
  writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
  writeFileSync(join(root, 'test.js'), 'console.log(\'the fixture test passes\');\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'seed');
  const worktree = join(root, '.graphyard', 'worktrees', 'gy-1-1');
  mkdirSync(dirname(worktree), { recursive: true });
  git(root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree, 'main');
  for (const [key, value] of [['user.email', 'w@t'], ['user.name', 'Worker']]) git(worktree, 'config', key, value);
  // The base tip the worker's sync merges.
  writeFileSync(join(root, 'advance.md'), 'advanced on main\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'advance main');
  git(root, 'update-ref', 'refs/remotes/origin/main', git(root, 'rev-parse', 'HEAD'));
  prepareConfinedGitPaths(root);

  const configHome = join(home, '.config', 'graphyard'), install = join(configHome, 'own-install');
  const masterToken = join(install, 'tokens', 'master.token'), workerToken = join(install, 'workers', 'worker.token');
  const reviewBinding = join(install, 'reviewers', 'sessions', 'review-1');
  const ownAccount = join(home, '.coding_agents', 'claude-a'), otherAccount = join(home, '.coding_agents', 'claude-b');
  const personal = [join(home, '.ssh', 'id_ed25519'), join(home, '.config', 'gh', 'hosts.yml'), join(home, '.git-credentials'), join(home, '.netrc'),
    join(home, '.docker', 'config.json'), join(home, '.aws', 'credentials')];
  const otherInstall = join(configHome, 'other-install'), installExtra = join(home, '.huck-engineer.env'), repositoryExtra = join(home, '.config', 'huck');
  for (const file of [...personal, join(otherInstall, 'tokens', 'other.token'), join(otherAccount, '.credentials.json'), installExtra, join(repositoryExtra, 'secrets.env'), masterToken, join(ownAccount, '.credentials.json'), join(reviewBinding, 'review-binding.json')]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  }
  mkdirSync(dirname(workerToken), { recursive: true });
  writeFileSync(workerToken, `${ownToken}\n`, { mode: 0o600 });
  // An ordinary file of the host user's stays readable: the home is not hidden wholesale.
  const visible = join(home, 'notes.txt');
  writeFileSync(visible, 'not a credential\n');
  const reviewCheckout = join(home, 'managed', 'review-gy-1');
  mkdirSync(reviewCheckout, { recursive: true });
  const config = { credentialFile: masterToken, confinement: { maskPaths: [installExtra] }, environments: [{ home: ownAccount }, { home: otherAccount }] };
  /** Everything no worker or reviewer may read; `test -r` on each must fail. */
  const denied = [...personal, otherInstall, otherAccount, join(otherAccount, '.credentials.json'), installExtra, repositoryExtra, join(repositoryExtra, 'secrets.env'), masterToken];
  return { root, worktree, configHome, install, masterToken, workerToken, reviewBinding, reviewCheckout, ownAccount, otherAccount, config, denied, visible };
}

const readProbe = 'for p do if test -r "$p"; then echo "READABLE $p"; else echo "DENIED $p"; fi; done';
function reads(wrapper: readonly string[], paths: readonly string[]) {
  const run = spawnSync(wrapper[0], [...wrapper.slice(1), '/bin/sh', '-c', readProbe, 'sh', ...paths], { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, `the confined probe ran: ${run.stderr}`);
  assert.ok(!(run.stdout + run.stderr).includes(secret), 'no secret value is reachable');
  return run.stdout;
}

test('e2e:confined-session-host-credentials — under real bwrap a worker and a review session read none of the host user\'s personal credentials, another install, another account or a declared extra, the worker still syncs, verifies and completes, and the master reads only its own install and token', async () => {
  // The fixture HOME lives in this checkout, not the host's tmpdir: the sandbox replaces /tmp with
  // its own scratch, which would hide the fixture's credentials whatever the mask did.
  const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  const home = await temporaryDirectory('confined-session-home', join(checkout, '.graphyard'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const f = fixture(home);
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this host');

    // The worker: its own token and runtime login kept, everything else of the host user's hidden.
    // The launch probe runs against the built sandbox and passes.
    const worker = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: f.root, sessionDirectory: f.worktree, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap', secretsBus: null, maskProbe: hostProbe,
      credentialMask: credentialMaskFor(f.config, { credentialFile: f.workerToken, runtimeHomes: [f.ownAccount] }, f.configHome) });
    assert.ok(worker);
    const workerReads = reads(worker.wrapper, [...f.denied, f.visible]);
    assert.ok(workerReads.includes(`READABLE ${f.visible}\n`), `the host user's ordinary files stay readable: ${workerReads}`);
    for (const path of f.denied) assert.ok(workerReads.includes(`DENIED ${path}\n`), `the worker cannot read ${path}: ${workerReads}`);

    // Its normal flow: own token and login, a commit, the supported sync, the repository's test
    // command, and complete — the real commands, with the control plane's answers stubbed.
    writeFileSync(join(f.worktree, 'flow-driver.mjs'), [
      'import { readFileSync } from "node:fs";',
      `import { syncWork } from ${JSON.stringify(join(checkout, 'src', 'cli', 'workspace.js'))};`,
      `import { completeCommand } from ${JSON.stringify(join(checkout, 'src', 'cli', 'complete.js'))};`,
      'const tree = process.env.WORKER_TREE;',
      'process.chdir(tree);',
      'const token = readFileSync(process.env.GRAPHYARD_TOKEN_FILE, "utf8").trim();',
      'const work = { id: "id-1", key: "GY-1", workspaces: [{ epoch: 1, branch: "graphyard/gy-1-1", host: "test-host", path: tree }], lease: { epoch: 1 } };',
      'const printed = [];',
      'await syncWork({ api: async () => ({ baseBranch: "main" }), print: value => printed.push(value) }, work);',
      'console.log(`WORKER-SYNC ${JSON.stringify(printed.at(-1))}`);',
      'const calls = [];',
      'await completeCommand.run({ args: ["1", "--head"], repositoryRoot: () => tree, print: () => {},',
      '  api: async (path, body) => { calls.push(path);',
      '    return path.endsWith("/worker-verification") ? { record: { key: "GY-1", head: body.head, clean: true, at: new Date().toISOString(), ran: [], outstanding: [] }, rerun: { flaked: [], baseFailures: [] } } : { key: "GY-1", submission: { epoch: 1 } }; } }, work);',
      'console.log(`WORKER-COMPLETE ${token.length} ${calls.join(",")}`);',
    ].join('\n'));
    const flow = [
      'test "$(cat "$GRAPHYARD_TOKEN_FILE")" = "$3" && echo OWN-TOKEN-READABLE',
      'test -r "$2/.credentials.json" && touch "$2/launch-state" && echo LOGIN-USABLE',
      'printf \'worker change\\n\' > "$1/worker.txt" && git -C "$1" add worker.txt flow-driver.mjs && git -C "$1" commit -qm "the worker change" && echo GIT-COMMIT-OK',
      'cd "$4" && WORKER_TREE="$1" node --import tsx "$1/flow-driver.mjs" || echo FLOW-FAILED',
      'cd "$1" && node test.js',
    ].join('\n');
    const ran = spawnSync(worker.wrapper[0], [...worker.wrapper.slice(1), '/bin/sh', '-c', flow, 'sh', f.worktree, f.ownAccount, ownToken, checkout],
      { encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL', env: { ...process.env, GRAPHYARD_TOKEN_FILE: f.workerToken } });
    const output = ran.stdout + '\n' + ran.stderr;
    assert.equal(ran.status, 0, `the confined worker ran: ${output.slice(-800)}`);
    for (const marker of ['OWN-TOKEN-READABLE', 'LOGIN-USABLE', 'GIT-COMMIT-OK', 'the fixture test passes', `WORKER-COMPLETE ${ownToken.length} work/id-1/worker-verification,work/id-1/submit`])
      assert.ok(ran.stdout.includes(marker), `${marker}: ${output.slice(-800)}`);
    const sync = JSON.parse(/^WORKER-SYNC (.*)$/m.exec(ran.stdout)![1]);
    assert.equal(sync.ok && sync.merged, true, `graphyard sync merged the base tip: ${JSON.stringify(sync)}`);
    assert.ok(existsSync(join(f.worktree, 'advance.md')), 'the base tip landed in the worktree');

    // A review session: its own binding directory and runtime login kept, the same locations hidden.
    const review = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: f.root, sessionDirectory: f.reviewCheckout, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap', ownGitHubCredential: true, maskProbe: hostProbe,
      credentialMask: credentialMaskFor(f.config, { credentialFile: f.reviewBinding, runtimeHomes: [f.ownAccount] }, f.configHome) });
    assert.ok(review);
    const reviewReads = reads(review.wrapper, [...f.denied, f.workerToken, join(f.reviewBinding, 'review-binding.json'), join(f.ownAccount, '.credentials.json')]);
    for (const path of [...f.denied, f.workerToken]) assert.ok(reviewReads.includes(`DENIED ${path}\n`), `the reviewer cannot read ${path}: ${reviewReads}`);
    for (const path of [join(f.reviewBinding, 'review-binding.json'), join(f.ownAccount, '.credentials.json')]) assert.ok(reviewReads.includes(`READABLE ${path}\n`), `the reviewer keeps its own ${path}`);

    // The master: its own install directory and token, and nothing else among them.
    const master = await masterSessionConfinement('claude', f.root, { bwrap: 'bwrap', platform: 'linux', mountNamespaceWorks: true }, [f.ownAccount, dirname(f.masterToken)], undefined,
      masterCredentialMask(f.config, [f.ownAccount], f.configHome));
    const masterDenied = f.denied.filter(path => path !== f.masterToken);
    const masterReads = reads(master.wrapper, [...masterDenied, f.install, f.masterToken]);
    for (const path of masterDenied) assert.ok(masterReads.includes(`DENIED ${path}\n`), `the master cannot read ${path}: ${masterReads}`);
    for (const path of [f.install, f.masterToken]) assert.ok(masterReads.includes(`READABLE ${path}\n`), `the master keeps its own ${path}`);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});
