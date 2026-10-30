import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitWatchPorts, renderPlan, resolveTarget, upgradeCommands, upgradePlan } from '../src/cli/upgrade.js';
import { deployRecordPath, readDeployRecord, watchMain, type DeployWatchPorts } from '../src/deploy-watch.js';
import { defaultChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2982: every install follows Graphyard's own main, whatever base branch the managed repository uses,
// and graphyard upgrade without --to moves to that main tip; the stable channel is gone.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare origin on `branch`, a clone that pushes to it, and `commit(name)` pushing one more commit. */
async function origin(base: string, name: string, branch: string) {
  const bare = join(base, `${name}.git`), pusher = join(base, `${name}-pusher`);
  git(base, 'init', '-q', '--bare', '-b', branch, bare);
  git(base, 'clone', '-q', bare, pusher);
  git(pusher, 'checkout', '-q', '-b', branch);
  const commit = async (label: string, files: Record<string, string> = {}) => {
    for (const [file, text] of Object.entries({ 'release.txt': label, ...files })) { await mkdir(dirname(join(pusher, file)), { recursive: true }); await writeFile(join(pusher, file), text); }
    git(pusher, 'add', '-A'); git(pusher, 'commit', '-q', '-m', label); git(pusher, 'push', '-q', 'origin', `HEAD:${branch}`);
    return git(pusher, 'rev-parse', 'HEAD');
  };
  return { bare, pusher, commit };
}

test('unit:deploy-watch-follows-graphyard-main — with a managed repository on trunk, the deploy watch fetches the Graphyard checkout\'s origin/main and deploys its new tip', async () => {
  const base = await temporaryDirectory('graphyard-main-follow');
  const graphyard = await origin(base, 'graphyard', 'main');
  const a = await graphyard.commit('A');
  const checkout = join(base, 'cli');
  git(base, 'clone', '-q', graphyard.bare, checkout);
  git(checkout, 'checkout', '-q', '--detach', a);
  // The managed repository's base branch is trunk, a branch Graphyard's origin does not have.
  const managed = await origin(base, 'managed', 'trunk');
  await managed.commit('app');
  const repoRoot = join(base, 'managed');
  git(base, 'clone', '-q', '-b', 'trunk', managed.bare, repoRoot);
  const b = await graphyard.commit('B');

  const deployed: string[] = [];
  const ports: DeployWatchPorts = {
    ...gitWatchPorts(checkout, defaultChildRun),
    build: async () => {}, restart: async commit => { deployed.push(commit); }, health: async () => {},
    pin: async () => {}, prune: async () => {}, schema: async () => 1, database: async () => 1,
  };
  const file = deployRecordPath(repoRoot);
  await watchMain(file, ports, { intervalMs: 1000, once: true, log: () => {} });
  assert.equal(git(checkout, 'rev-parse', 'refs/remotes/origin/main'), b, 'the fetch read Graphyard\'s origin/main');
  assert.deepEqual(deployed, [b], 'the new Graphyard main tip was deployed');
  assert.equal(readDeployRecord(file)?.tip, b);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), b);
});

test('unit:upgrade-defaults-to-main — upgrade --plan with no --to targets the fetched origin/main tip, not a stable tag; --to VERSION still resolves the dated tag; no stable channel remains', async () => {
  const base = await temporaryDirectory('upgrade-defaults-main');
  const graphyard = await origin(base, 'graphyard', 'main');
  const release = (generations: number) => `export const schemaGenerations: readonly (string | null)[] = [\n  ${Array(generations + 1).fill('null').join(', ')},\n];\n`;
  const dated = await graphyard.commit('dated', { 'src/release.ts': release(4) });
  git(graphyard.pusher, 'tag', '2026.10.18'); git(graphyard.pusher, 'tag', 'stable');
  git(graphyard.pusher, 'push', '-q', 'origin', '--tags');
  const tip = await graphyard.commit('tip', { 'src/release.ts': release(5) });
  const cli = join(base, 'cli');
  git(base, 'clone', '-q', graphyard.bare, cli);
  git(cli, 'checkout', '-q', '--detach', dated);

  const target = resolveTarget(cli);
  assert.deepEqual(target, { revision: tip, version: `unreleased ${tip.slice(0, 12)}`, schema: 5 }, 'no --to targets origin/main, not the stable tag');
  const plan = renderPlan(upgradePlan({ cliRoot: cli, repoRoot: base, current: { version: '2026.10.18', revision: dated, released: true }, target, databaseSchema: null,
    install: null, url: null, backupFile: join(base, 'backup.json'), cliChanges: [] }));
  assert.match(plan, new RegExp(`checkout --detach ${tip}`));
  assert.deepEqual(resolveTarget(cli, '2026.10.18'), { revision: dated, version: '2026.10.18', schema: 4 });
  assert.throws(() => resolveTarget(cli, 'stable'), /dated release/);

  assert.doesNotMatch(upgradeCommands[0]!.help.join('\n'), /stable/);
  const root = new URL('..', import.meta.url).pathname;
  for (const directory of ['src', 'docs']) {
    for (const entry of await readdir(join(root, directory), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      assert.doesNotMatch(await readFile(path, 'utf8'), /stableChannel|--to stable|VERSION\|stable|stable (channel|tag)/, `${path} names the stable channel`);
    }
  }
});
