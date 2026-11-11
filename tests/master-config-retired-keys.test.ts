import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadMasterConfig, masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const base = { version: 1, url: 'https://graphyard.example', credentialFile: '/tmp/token', cliPath: '/tmp/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project' };

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
