import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { coordinatorConfinement, sessionGitAdminDirectory } from '../src/master/confinement.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
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
