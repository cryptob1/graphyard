import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { coordinatorConfinement, sessionGitAdminDirectory } from '../src/master/confinement.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
import { dispatchWork, setupMaster, loadMasterConfig } from '../src/master.js';
import { cycleBaseTip } from '../src/master/worktrees.js';
import { WorkerSandboxError } from '../src/worker-sandbox.js';
import { registryFixture } from './helpers/registry-fixture.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Huck's service WorkingDirectory is huck-graphyard while ExecStart loads a CLI release
// in cryptob1-graphyard/deploy/build: these are separate repositories. The old worker
// default confined that CLI checkout. Graphyard's self-hosted layout shares its Git store.
for (const layout of ['huck', 'self-hosted', 'relative-pointer', 'symlink', 'linked-coordinator']) {
  test(`integration:sandbox-worktree-admin-layout — ${layout} commits only in its own admin directory`, async () => {
    const base = await temporaryDirectory('sandbox-admin-layout');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      const repo = join(base, 'repository');
      mkdirSync(repo); git(repo, 'init', '-b', 'graphyard-main');
      git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.com');
      git(repo, 'commit', '--allow-empty', '-m', 'base');
      let root = repo;
      if (layout === 'huck') {
        const cli = join(base, 'separate-cli-release'); mkdirSync(cli); git(cli, 'init');
        assert.notEqual(cli, root);
      }
      if (layout === 'linked-coordinator') {
        root = join(base, 'coordinator'); git(repo, 'worktree', 'add', '--detach', root);
      }
      const own = join(root, '.graphyard/worktrees/GY-1-26');
      const other = join(root, '.graphyard/worktrees/GY-2-1');
      git(root, 'worktree', 'add', '-b', 'graphyard/gy-1-26', own);
      git(root, 'worktree', 'add', '-b', 'graphyard/gy-2-1', other);
      const admin = git(own, 'rev-parse', '--absolute-git-dir');
      const sibling = git(other, 'rev-parse', '--absolute-git-dir');
      if (layout === 'relative-pointer') writeFileSync(join(own, '.git'), `gitdir: ${relative(own, admin)}\n`);
      if (layout === 'symlink') {
        const alias = join(base, 'alias'); symlinkSync(repo, alias);
        root = alias;
      }
      assert.equal(sessionGitAdminDirectory(own, root), admin);
      prepareConfinedGitPaths(root);
      const confinement = await coordinatorConfinement({ kind: 'claude', args: [], coordinatorRoot: root, sessionDirectory: own, bwrap: 'bwrap', mountNamespaceWorks: true });
      assert.ok(confinement);
      const script = 'set -eu; cd "$1"; touch "$2/probe"; git -c user.name=Worker -c user.email=w@example.com commit --allow-empty -m worker; if touch "$3/probe" 2>/dev/null; then exit 19; fi';
      execFileSync(confinement.wrapper[0], [...confinement.wrapper.slice(1), '/bin/sh', '-c', script, 'sh', own, admin, sibling], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(git(own, 'log', '-1', '--format=%s'), 'worker');
      assert.equal(git(other, 'log', '-1', '--format=%s'), 'base');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}


test('integration:sandbox-worktree-admin-layout — production dispatch confines the served repository, not its separate CLI release', async () => {
  const base = await temporaryDirectory('sandbox-served-repository');
  try {
    const root = join(base, 'huck-graphyard'), cliRoot = join(base, 'cli-release');
    mkdirSync(root); mkdirSync(cliRoot);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'graphyard-main');
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com');
    git('commit', '--allow-empty', '-m', 'base');
    git('remote', 'add', 'origin', 'https://github.com/hello-huck/huck.git');
    const own = join(root, '.graphyard/worktrees/GY-1-26');
    git('worktree', 'add', '-b', 'graphyard/gy-1-26', own);
    const item = { id: 'work-1', key: 'GY-1', title: 'Bootstrap', type: 'bug', description: '', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Specified work', proofs: ['e2e:fixture'] }],
      policy: { checks: [], review: true }, stage: 'ready', epoch: 0, ready: true, lease: null, blocker: null, workspaces: [], gates: [{ name: 'ready', passed: true, reasons: [] }] } as unknown as Work;
    // Only the control-plane commands are stubbed; production preparation and confinement run.
    const cli = join(cliRoot, 'graphyard.mjs');
    writeFileSync(cli, `const action = process.argv[2]; console.log(JSON.stringify(action === 'claim' ? ${JSON.stringify({ ...item, epoch: 26, lease: { owner: 'worker' } })} : action === 'worktree' ? ${JSON.stringify({ path: own })} : {}));`);
    const credentials = await temporaryDirectory('credentials', base);
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: cli, credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'hello-huck/huck', baseBranch: 'graphyard-main' }))) as typeof fetch);
    const config = await loadMasterConfig(root), credentialFile = join(credentials, 'worker.token');
    writeFileSync(credentialFile, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const profile = { name: 'worker', principal: 'worker', agentName: 'worker', mode: 'launch' as const, kind: 'claude' as const, credentialFile, agentArgs: [], approvals: 'auto' as const, environment: {} };
    config.workers = [profile];
    writeFileSync(join(root, '.graphyard/master.json'), JSON.stringify(config));
    const now = new Date().toISOString();
    await cycleBaseTip(root, config.baseBranch, now, async () => git('rev-parse', 'HEAD'));
    const registry = registryFixture(config.hostId!, ['claude']);
    let probed = false;
    try {
      await dispatchWork(root, item, profile, { allWork: [item], observedAt: now, headless: async () => { throw new Error('No runtime should start'); },
        probe: registry.probe, sandbox: (command, args, options) => {
          assert.equal(command, 'bwrap', 'a production worker carries the served repository confinement');
          assert.ok(args.includes(join(root, '.git/worktrees/GY-1-26')), 'its own Git admin is mounted');
          execFileSync(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          probed = true;
          throw new Error('LAYOUT-VERIFIED: stop before starting the runtime');
        },
      });
      assert.fail('the test stops after the real confined write probe');
    } catch (error) {
      if (!(error instanceof WorkerSandboxError && error.detail.includes('LAYOUT-VERIFIED'))) throw error;
    }
    assert.equal(probed, true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
