import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultParallelTips } from '../src/merge-queue.js';
import { onboardingParallelTips } from '../src/master/profiles.js';
import { onboardingMergeQueue } from '../src/repository-setup.js';
import { parallelTipsAdvisories, protectionPlan, readWorkflows, type WorkflowFile } from '../src/protection.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

async function repository() {
  const root = await temporaryDirectory('parallel-tips');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}

const workflowWithConcurrency: WorkflowFile = {
  path: '.github/workflows/ci.yml',
  text: 'name: CI\non:\n  pull_request:\nconcurrency:\n  group: ci-${{ github.event.number }}\n  cancel-in-progress: true\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
};

test('unit:parallel-tips-onboarded — onboarding writes parallelTips default to master config', async () => {
  const root = await repository();
  const credentialDirectory = await temporaryDirectory('master-credentials');
  const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
  const cliPath = process.execPath;
  const coordinatorStatus = (async () =>
    new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath, credentialDirectory }, coordinatorStatus);
  const config = await loadMasterConfig(root);
  assert.equal(config.mergeQueue?.parallelTips, defaultParallelTips, 'parallelTips should be set to the default value');
});

test('unit:parallel-tips-onboarded — onboardingMergeQueue writes the product default from profiles.ts', () => {
  assert.equal(onboardingParallelTips, defaultParallelTips, 'the recommended value is the product default master/profiles.ts names');
  const result = onboardingMergeQueue();
  assert.equal(result.parallelTips, onboardingParallelTips, 'onboardingMergeQueue should return parallelTips');
  assert.ok(Array.isArray(result.optimisticExclude), 'onboardingMergeQueue should include optimisticExclude');
});

test('unit:parallel-tips-onboarded — parallelTipsAdvisories generates advisory for low CI concurrency', () => {
  const advisories = parallelTipsAdvisories(defaultParallelTips, [workflowWithConcurrency]);
  assert.equal(advisories.length, 1, `should generate one advisory, got ${advisories.length}: ${advisories.join('; ')}`);
  assert.match(advisories[0], /merge queue will validate/, 'advisory should mention parallel tips');
  assert.match(advisories[0], /concurrent runner slots/, 'advisory should mention runner slots');
});

test('unit:parallel-tips-onboarded — parallelTipsAdvisories returns empty when parallelTips is 1', () => {
  const advisories = parallelTipsAdvisories(1, []);
  assert.deepEqual(advisories, [], 'no advisory when parallelTips is 1');
});

test('unit:parallel-tips-onboarded — parallelTipsAdvisories returns empty when no pull_request workflows', () => {
  const workflow: WorkflowFile = {
    path: '.github/workflows/deploy.yml',
    text: 'name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
  };
  const advisories = parallelTipsAdvisories(defaultParallelTips, [workflow]);
  assert.deepEqual(advisories, [], 'no advisory for non-pull-request workflows');
});

test('unit:parallel-tips-onboarded — master protection plans the advisory for a written parallelTips under a low concurrency limit', () => {
  const work = [{ key: 'GY-42', stage: 'review', policy: { checks: ['test'], review: true } } as unknown as Work];
  const protection = { required_status_checks: { strict: false, checks: [] }, enforce_admins: { enabled: true } };
  // An installation whose onboarding wrote parallelTips learns, from the plan, when its CI
  // concurrency cannot validate the tips in parallel; one without the key stays silent.
  const onboarded = protectionPlan(protection, { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, mergeQueue: { parallelTips: defaultParallelTips } }, work, undefined, [workflowWithConcurrency]);
  assert.equal(onboarded.advisories.length, 1, `the plan reports the parallel-tips advisory: ${onboarded.advisories.join('; ')}`);
  assert.match(onboarded.advisories[0], new RegExp(`validate ${defaultParallelTips} tips concurrently`));
  assert.match(onboarded.advisories[0], /at least 8 concurrent runner slots/, 'the advisory recommends parallelTips × jobs per run');
  const unwritten = protectionPlan(protection, { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }, work, undefined, [workflowWithConcurrency]);
  assert.deepEqual(unwritten.advisories, [], 'no parallel-tips advisory where the installation wrote none');
});

test('unit:parallel-tips-onboarded — the advisory reads the checkout from the repository root, not the working directory', async () => {
  // `graphyard master protection` runs from wherever the operator stands: the workflows must come
  // from the discovered repository root, or a subdirectory invocation silently loses the advisory.
  const root = await temporaryDirectory('parallel-tips-root');
  const home = process.cwd();
  await mkdir(join(root, 'nested'), { recursive: true });
  process.chdir(join(root, 'nested'));
  try {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), workflowWithConcurrency.text);
    assert.deepEqual(readWorkflows(), [], 'from a subdirectory the working-directory default finds no workflows');
    const found = readWorkflows(root);
    assert.deepEqual(found.map(file => file.path), ['.github/workflows/ci.yml'], 'the repository root yields the checkout\u2019s workflows');
    const advisories = parallelTipsAdvisories(defaultParallelTips, found);
    assert.equal(advisories.length, 1, `the advisory survives a subdirectory invocation: ${advisories.join('; ')}`);
    assert.match(advisories[0], /concurrent runner slots/);
  } finally {
    process.chdir(home);
  }
});

test('unit:parallel-tips-onboarded — master protection feeds both plan and apply the workflows read from the CLI root', async () => {
  const fleet = await readFile(new URL('../src/cli/master/fleet.ts', import.meta.url), 'utf8');
  assert.match(fleet, /const workflows = readWorkflows\(root\)/, 'the command reads the workflows from the discovered repository root');
  assert.match(fleet, /protectionPlan\(readProtection\(master\), master, snapshot\.work, undefined, workflows\)/, 'the plan carries those workflows, not a working-directory default');
  assert.match(fleet, /applyProtection\(master, snapshot\.work, undefined, workflows\)/, 'the apply path carries the same workflows');
});
