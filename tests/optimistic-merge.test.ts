import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig } from '../src/master.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1233: optimistic merge (GY-500) and its main guard are removed. GitHub delivery merges every
 * passing candidate, so nothing lands past the queue, nothing reads a post-merge verdict and nothing
 * is reverted. The modules are gone, no source imports them, a master.json written while they ran
 * still loads, and master status reports no optimisticMerge section.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const source = fileURLToPath(new URL('../src/', import.meta.url));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []))).flat();
}

test('unit:optimistic-merge-removed — the optimistic-merge and main-guard modules are deleted and nothing in src imports them', async () => {
  for (const removed of ['optimistic-merge.ts', 'master/optimistic-attention.ts']) await assert.rejects(access(join(source, removed)), `src/${removed} is deleted`);
  const importers: string[] = [];
  for (const file of await sourceFiles(source)) if (/from ['"][^'"]*(optimistic-merge|optimistic-attention)(\.js)?['"]/.test(await readFile(file, 'utf8'))) importers.push(file);
  assert.deepEqual(importers, [], 'no source file imports them');
});

test('unit:optimistic-merge-removed — a master.json carrying mergeQueue.optimistic still loads, and master status has no optimisticMerge key', async () => {
  const root = await temporaryDirectory('optimistic-removed');
  const credentials = await temporaryDirectory('optimistic-removed-credentials');
  try {
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git');
    await writeFile(join(root, 'README.md'), 'first\n');
    git(root, 'add', 'README.md'); git(root, 'commit', '-q', '-m', 'first');
    const credentialFile = join(credentials, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    // As onboarding and operators wrote it while optimistic merge ran (GY-500, GY-503).
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
      mergeQueue: { parallelTips: 4, optimistic: true, optimisticExclude: ['**/package.json', 'tests/helpers/'] } }), { mode: 0o600 });
    const master = await loadMasterConfig(root);
    assert.equal(master.mergeQueue?.parallelTips, 4, 'the config loads with its other merge-queue settings intact');

    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [], now: new Date().toISOString() } : { decisions: [] };
    const report = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null }) as Record<string, any>;
    assert.equal('optimisticMerge' in report, false, 'master status reports no optimisticMerge section');
    assert.equal('optimistic' in (report.mergeQueue ?? {}), false, 'and its mergeQueue names no optimistic setting');
    assert.doesNotMatch(JSON.stringify(report), /optimistic merge|main guard/i, 'nor any attention line about the guard');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(credentials, { recursive: true, force: true });
  }
});
