import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadMasterConfig, masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1264: `mergeQueue.optimistic` and `optimisticExclude` are retired (GY-1233), and GY-1236
 * retires `batchSize`, `parallelTips` and `ciConcurrency` with Graphyard's own merge queue. A
 * master.json that still carries them loads, but parsing drops them, so every writer that re-parses
 * before it saves (master init, profile and environment changes) removes them from the file.
 */
const base = { version: 1, url: 'https://graphyard.example', credentialFile: '/tmp/token', cliPath: '/tmp/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project' };

test('unit:retired-merge-queue-keys — parsing drops rerunFailedChecks, optimistic, optimisticExclude and the queue\'s batchSize, parallelTips and ciConcurrency', () => {
  const parsed = masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: 4, batchSize: 2, ciConcurrency: 20, rerunFailedChecks: 1, optimistic: true, optimisticExclude: ['**/package.json'] } });
  assert.deepEqual(parsed.mergeQueue, {}, 'all retired settings drop from the parse');
  const rewritten = JSON.parse(JSON.stringify(parsed));
  for (const retired of ['optimistic', 'optimisticExclude', 'batchSize', 'parallelTips', 'ciConcurrency', 'rerunFailedChecks'])
    assert.equal(retired in rewritten.mergeQueue, false, `a config written back from the parse no longer names ${retired}`);
  assert.deepEqual(masterConfigSchema.parse(rewritten).mergeQueue, {}, 'and re-parses unchanged');
});

test('unit:retired-merge-queue-keys — unknown merge-queue keys are kept and written back (GY-1960), the retired declared ones still drop', () => {
  const parsed = masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: 4, optimisticLane: true } });
  assert.deepEqual(parsed.mergeQueue, { optimisticLane: true }, 'the retired declared key drops; the unknown one a newer version wrote is kept (GY-1960)');
  assert.deepEqual(masterConfigSchema.parse(JSON.parse(JSON.stringify(parsed))).mergeQueue, { optimisticLane: true }, 'and re-parses unchanged');
});

// A pre-control-plane master.json keeps loading while new installations omit the App ID.
test('unit:master-config-retired-keys — old App and merge settings load and githubAppId is optional', async () => {
  const old = masterConfigSchema.parse({ ...base, mergeMethod: 'squash' });
  assert.equal(old.githubAppId, 1234);
  assert.equal((old as unknown as Record<string, unknown>).mergeMethod, 'squash');
  const { githubAppId, ...withoutApp } = base;
  assert.equal(masterConfigSchema.parse(withoutApp).githubAppId, undefined);
  const directory = await temporaryDirectory('retired-master-config');
  const root = join(directory, 'repo');
  try {
    await mkdir(join(root, '.graphyard'), { recursive: true });
    execFileSync('git', ['init', '--quiet', root]);
    const credentialFile = join(directory, 'master.token');
    await writeFile(credentialFile, 'fixture-master-token-with-no-app-credentials', { mode: 0o600 });
    const file = join(root, '.graphyard/master.json');
    const config = { ...base, credentialFile, cliPath: resolve('bin/graphyard.mjs'), mergeMethod: 'squash' };
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const loaded = await loadMasterConfig(root);
    assert.equal(loaded.githubAppId, 1234);
    assert.equal((loaded as unknown as Record<string, unknown>).mergeMethod, 'squash');
    const { githubAppId: _retired, ...current } = config;
    await writeFile(file, JSON.stringify(current));
    assert.equal((await loadMasterConfig(root)).githubAppId, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('retired autoMerge loads and drops on rewrite', () => {
  const parsed = masterConfigSchema.parse({ ...base, autoMerge: false });
  assert.equal('autoMerge' in parsed, false);
});
