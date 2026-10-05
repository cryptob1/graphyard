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

const workflowWithoutGroup: WorkflowFile = {
  path: '.github/workflows/lint.yml',
  text: 'name: Lint\non: [pull_request]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n',
};

test('unit:parallel-tips-onboarded — onboarding writes parallelTips default to master config and explains it', async () => {
  const root = await repository();
  const credentialDirectory = await temporaryDirectory('master-credentials');
  const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
  const cliPath = process.execPath;
  const coordinatorStatus = (async () =>
    new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
  const report = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath, credentialDirectory }, coordinatorStatus);
  const config = await loadMasterConfig(root);
  assert.equal(config.mergeQueue?.parallelTips, defaultParallelTips, 'parallelTips should be set to the default value');
  assert.equal(report.mergeQueue.parallelTips, defaultParallelTips, 'the setup report names the value it wrote');
  assert.match(report.mergeQueue.parallelTipsExplained, new RegExp(`validates ${defaultParallelTips} queue positions at once`), 'the setup report explains what the value means');
  assert.match(report.mergeQueue.parallelTipsExplained, /mergeQueue\.ciConcurrency/, 'the setup report says how to declare the CI limit');
  assert.match(report.mergeQueue.source, /tune mergeQueue\.parallelTips/, 'the setup report says where to tune it');
});

test('unit:parallel-tips-onboarded — onboardingMergeQueue writes the product default from profiles.ts', () => {
  assert.equal(onboardingParallelTips, defaultParallelTips, 'the recommended value is the product default master/profiles.ts names');
  const result = onboardingMergeQueue();
  assert.equal(result.parallelTips, onboardingParallelTips, 'onboardingMergeQueue should return parallelTips');
  assert.deepEqual(result, { parallelTips: onboardingParallelTips }, 'and nothing else: optimistic merge and its exclude globs are retired (GY-1233)');
});

test('unit:parallel-tips-onboarded — parallelTipsAdvisories compares the declared CI concurrency limit with parallelTips × jobs per run', () => {
  const low = parallelTipsAdvisories(defaultParallelTips, [workflowWithConcurrency, workflowWithoutGroup], 4);
  assert.equal(low.length, 1, `a low limit is reported: ${low.join('; ')}`);
  assert.match(low[0], /CI concurrency limit 4 \(mergeQueue\.ciConcurrency\) is lower than parallelTips × jobs per run/);
  assert.match(low[0], /4 parallel tips × 3 pull-request job\(s\) per run need 12 concurrent Actions jobs/, 'jobs of every pull-request workflow count, with or without a concurrency group');
  assert.match(low[0], /Raise the limit to at least 12, or set mergeQueue\.parallelTips to 1/);
  assert.deepEqual(parallelTipsAdvisories(defaultParallelTips, [workflowWithConcurrency, workflowWithoutGroup], 12), [], 'a limit that covers the need is silent');
  const undeclared = parallelTipsAdvisories(defaultParallelTips, [workflowWithoutGroup]);
  assert.equal(undeclared.length, 1, 'an undeclared limit states the need');
  assert.match(undeclared[0], /need 4 concurrent Actions jobs.*declare it as mergeQueue\.ciConcurrency/);
});

test('unit:parallel-tips-onboarded — parallelTipsAdvisories returns empty when parallelTips is 1', () => {
  assert.deepEqual(parallelTipsAdvisories(1, [workflowWithConcurrency], 1), [], 'no advisory when parallelTips is 1');
});

test('unit:parallel-tips-onboarded — parallelTipsAdvisories returns empty when no pull_request workflows', () => {
  const workflow: WorkflowFile = {
    path: '.github/workflows/deploy.yml',
    text: 'name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
  };
  assert.deepEqual(parallelTipsAdvisories(defaultParallelTips, [workflow], 1), [], 'no advisory for non-pull-request workflows');
});

test('unit:parallel-tips-onboarded — master protection plans the advisory against the effective parallelTips and a low concurrency limit', () => {
  const work = [{ key: 'GY-42', stage: 'review', policy: { checks: ['test'], review: true } } as unknown as Work];
  const protection = { required_status_checks: { strict: false, checks: [] }, enforce_admins: { enabled: true } };
  const config = { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 };
  const onboarded = protectionPlan(protection, { ...config, mergeQueue: { parallelTips: defaultParallelTips, ciConcurrency: 4 } }, work, undefined, [workflowWithConcurrency]);
  assert.equal(onboarded.advisories.length, 1, `the plan reports the parallel-tips advisory: ${onboarded.advisories.join('; ')}`);
  assert.match(onboarded.advisories[0], /CI concurrency limit 4 .*need 8 concurrent Actions jobs.*Raise the limit to at least 8, or set mergeQueue\.parallelTips to 2/, 'the advisory recommends parallelTips × jobs per run');
  // An installation without the key still runs the product default window, so it is planned against it.
  const unwritten = protectionPlan(protection, { ...config, mergeQueue: { ciConcurrency: 4 } }, work, undefined, [workflowWithConcurrency]);
  assert.deepEqual(unwritten.advisories, onboarded.advisories, 'an unwritten parallelTips is planned as the effective default');
  const sufficient = protectionPlan(protection, { ...config, mergeQueue: { ciConcurrency: 8 } }, work, undefined, [workflowWithConcurrency]);
  assert.deepEqual(sufficient.advisories, [], 'a limit covering the need is silent');
  const single = protectionPlan(protection, { ...config, mergeQueue: { parallelTips: 1 } }, work, undefined, [workflowWithConcurrency]);
  assert.deepEqual(single.advisories, [], 'one tip at a time needs no parallel capacity');
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
    const advisories = parallelTipsAdvisories(defaultParallelTips, found, 4);
    assert.equal(advisories.length, 1, `the advisory survives a subdirectory invocation: ${advisories.join('; ')}`);
    assert.match(advisories[0], /need 8 concurrent Actions jobs/);
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
