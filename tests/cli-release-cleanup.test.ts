import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { directoryBytes } from '../src/daemon/leftovers.js';

// GY-3334: the loop's leftovers sweep removes the install's CLI release copies nothing uses, through
// `git worktree remove` in the checkout that owns each, and counts them in the leftovers report.

// Imported in the test, so a base without the sweep fails the case rather than the file.
const release = () => import('../src/install/cli-release.js') as Promise<{ sweepCliReleases: (directory: string, run: (command: string, args: string[]) => string) => Promise<{ removed: string[]; bytes: number; left: string[] }> }>;
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { diskFloorGb: 30 } });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('e2e:cli-release-cleanup — of six release copies the served, the previous and the one a live session runs stay; the other three go with their worktree entries, another install\'s copy of the same checkout keeps working, and the leftovers report counts the copies and bytes', async () => {
  const { sweepCliReleases } = await release();
  const root = realpathSync(await temporaryDirectory('cli-release-cleanup'));
  const source = join(root, 'checkout');
  mkdirSync(source);
  git(source, 'init', '--quiet', '-b', 'main');
  const commits: string[] = [];
  for (let index = 1; index <= 6; index += 1) {
    writeFileSync(join(source, 'version.txt'), `${index}\n`);
    git(source, 'add', 'version.txt');
    git(source, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', `release ${index}`);
    commits.push(git(source, 'rev-parse', 'HEAD'));
  }
  const store = (install: string) => join(root, install, 'deploy', 'build', '.graphyard', 'cli-releases');
  const copy = (install: string, commit: string, readyAt: number) => {
    const path = join(store(install), commit);
    mkdirSync(store(install), { recursive: true });
    git(source, 'worktree', 'add', '--detach', '--quiet', path, commit);
    mkdirSync(join(path, '.graphyard'));
    mkdirSync(join(path, 'node_modules', 'dependency'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'dependency', 'index.js'), 'x'.repeat(10_000));
    writeFileSync(join(path, '.graphyard', 'cli-ready'), commit);
    utimesSync(join(path, '.graphyard', 'cli-ready'), readyAt, readyAt);
    return path;
  };
  // Readied in commit order; the newest is served, the one before it is the previous release.
  const copies = commits.map((commit, index) => copy('install-a', commit, 1_700_000_000 + index * 3_600));
  symlinkSync(copies[5]!, join(root, 'install-a', 'deploy', 'build', '.graphyard', 'cli-published'));
  // A second install on the host whose release copy is a worktree of the same checkout, at a commit the first install removes.
  const other = copy('install-b', commits[0]!, 1_700_000_000);
  const session = spawn('sleep', ['300'], { cwd: copies[1]!, stdio: 'ignore' });
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    const gone = [copies[0]!, copies[2]!, copies[3]!];
    const bytes = (await Promise.all(gone.map(path => directoryBytes(path)))).reduce((sum: number, size) => sum + (size ?? 0), 0);

    let clock = Date.parse('2030-04-01T23:50:00Z');
    const lines: string[] = [];
    const effects: DaemonEffects = {
      snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }),
      agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
      recordSession: async () => {}, removeWorktree: async () => true,
      sweepCliReleases: () => sweepCliReleases(join(root, 'install-a'), run),
      leftoverDisk: async () => ({ trialRuns: null, worktrees: null, trialCheckouts: null, trialImages: null, buildCache: null }),
    };
    const state = emptyDaemonState(config);
    await runCycle(config, state, effects, Date.now, undefined, line => lines.push(line));

    for (const path of gone) assert.equal(existsSync(path), false, `${path} is removed`);
    for (const path of [copies[1]!, copies[4]!, copies[5]!]) assert.equal(git(path, 'rev-parse', 'HEAD').length, 40, `${path} stays a working copy`);
    const listed = git(source, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length)).sort();
    assert.deepEqual(listed, [source, copies[1]!, copies[4]!, copies[5]!, other].sort(), 'the removed copies\' worktree entries are gone and every other entry stays');
    assert.equal(git(other, 'rev-parse', 'HEAD'), commits[0], 'the second install\'s copy still works');

    clock = Date.parse('2030-04-02T00:01:00Z');
    await runCycle(config, state, effects, Date.now, undefined, line => lines.push(line));
    assert.equal(state.leftovers.report?.counts.cliReleases, 3);
    assert.equal(state.leftovers.report?.counts.cliReleaseBytes, bytes);
    assert.ok(bytes > 30_000, 'the freed bytes include each copy\'s dependencies');
    assert.ok(lines.some(line => line.includes('leftovers report') && line.includes('"cliReleases":3')), lines.join('\n'));
  } finally { session.kill(); }
});
