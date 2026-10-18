import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1753: over a simulated day of loop cycles the environment the loop publishes is the one deployments are read
 * under (stable, published once), and the branch check a rework workspace starts from stays bounded across items —
 * GY-2035: it reads the worker's local branch alone, so it runs no git fetch or push for any item, with every
 * system invariant holding in the real loop's day.
 */
soakControlPlanes('soak-pages-environment-and-branch-recovery', 1753);

test('unit:soak-invariants-hold — a Pages-only repository publishes one stable environment over a day of cycles and branch recovery stays bounded across items', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 24 });
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');

  const { daemonEffects } = await import('../src/daemon/effects.js');
  const { deploymentEnvironmentName } = await import('../src/daemon/deployment.js');
  const { submittedBranchRefusal } = await import('../src/master/worktrees.js');
  const root = await temporaryDirectory('soak-pages');
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'pages-deploy.yml'), 'name: pages\n');
  const posted: unknown[] = [];
  const config = { url: 'http://x', run: {} } as never;
  const effects = daemonEffects(root, () => config, { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate: async (_path: string, data: unknown) => { posted.push(data); return {}; } } as never);
  for (let cycle = 0; cycle < 288; cycle++) await effects.publishProductionEnvironment!();
  assert.deepEqual(posted, [{ environment: deploymentEnvironmentName(config, root) }], 'published once, as the name deployments are read under');
  assert.equal(deploymentEnvironmentName(config, root, {}), 'github-pages');
  assert.equal(deploymentEnvironmentName(config, root, { GRAPHYARD_PRODUCTION_ENVIRONMENT: 'prod' }), 'prod', 'an explicit setting wins');

  const base = await temporaryDirectory('soak-branches'), origin = join(base, 'origin.git'), work = join(base, 'work');
  const sh = (cwd: string, ...args: string[]) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  spawnSync('git', ['init', '--bare', '--quiet', origin]); spawnSync('git', ['init', '--quiet', work]);
  sh(work, 'remote', 'add', 'origin', origin);
  const calls: string[][] = [];
  const run = ((command: string, args: string[], options: { cwd: string }) => {
    calls.push(args);
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  }) as never;
  for (let item = 1; item <= 20; item++) {
    const branch = `graphyard/gy-${item}-1`;
    sh(work, 'checkout', '-q', '-B', branch); sh(work, 'commit', '-q', '--allow-empty', '-m', `item ${item}`);
    const sha = sh(work, 'rev-parse', 'HEAD').stdout.trim();
    assert.equal(await submittedBranchRefusal(work, branch, sha, run), null);
  }
  assert.equal(calls.filter(args => ['fetch', 'push'].includes(String(args[0]))).length, 0, 'no fetch or push, for any item');
  assert.equal(sh(origin, 'branch', '--list').stdout.trim(), '', 'workers\' branches never touch origin');
});
