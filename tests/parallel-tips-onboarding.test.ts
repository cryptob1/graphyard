import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultParallelTips } from '../src/merge-queue.js';
import { onboardingMergeQueue } from '../src/repository-setup.js';
import { parallelTipsAdvisories } from '../src/protection.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-parallel-tips-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}

test('unit:parallel-tips-onboarded — onboarding writes parallelTips default to master config', async () => {
  const root = await repository();
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-'));
  const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
  const cliPath = process.execPath;
  try {
    const coordinatorStatus = async () =>
      new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 })) as typeof fetch;
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath, credentialDirectory }, coordinatorStatus as typeof fetch);
    const config = await loadMasterConfig(root);
    assert.equal(config.mergeQueue?.parallelTips, defaultParallelTips, 'parallelTips should be set to the default value');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(credentialDirectory, { recursive: true, force: true });
  }
});

test('unit:parallel-tips-onboarded — onboardingMergeQueue includes parallelTips', () => {
  const result = onboardingMergeQueue();
  assert.equal(result.parallelTips, defaultParallelTips, 'onboardingMergeQueue should return parallelTips');
  assert.ok(Array.isArray(result.optimisticExclude), 'onboardingMergeQueue should include optimisticExclude');
});

test('unit:parallel-tips-onboarded — parallelTipsAdvisories generates advisory for low CI concurrency', async () => {
  const root = await repository();
  try {
    // Use a workflow with workflow-level concurrency for per-pull-request runs
    const workflowWithConcurrency = {
      path: '.github/workflows/ci.yml',
      text: 'name: CI\non:\n  pull_request:\nconcurrency:\n  group: ci-${{ github.event.number }}\n  cancel-in-progress: true\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
    };
    const advisories = parallelTipsAdvisories(defaultParallelTips, ['test', 'lint'], [workflowWithConcurrency]);
    assert.equal(advisories.length, 1, `should generate one advisory, got ${advisories.length}: ${advisories.join('; ')}`);
    assert.match(advisories[0], /merge queue will validate/, 'advisory should mention parallel tips');
    assert.match(advisories[0], /concurrent runner slots/, 'advisory should mention runner slots');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unit:parallel-tips-onboarded — parallelTipsAdvisories returns empty when parallelTips is 1', () => {
  const advisories = parallelTipsAdvisories(1, ['test'], []);
  assert.deepEqual(advisories, [], 'no advisory when parallelTips is 1');
});

test('unit:parallel-tips-onboarded — parallelTipsAdvisories returns empty when no pull_request workflows', () => {
  const workflow = {
    path: '.github/workflows/deploy.yml',
    text: 'name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
  };
  const advisories = parallelTipsAdvisories(defaultParallelTips, ['deploy'], [workflow]);
  assert.deepEqual(advisories, [], 'no advisory for non-pull-request workflows');
});
