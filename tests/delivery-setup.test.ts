import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { classifyChecks, describeMergeGate, detectStack } from '../src/onboarding.js';
import { applyDelivery, applyProposal, repositoryScanDifference, saveProposal, scanProposal } from '../src/repository-setup.js';
import { candidateWorkflowFile, deliveryPolicySchema, promotionWorkflowFile, requiredPullRequestChecks, type DeliveryPolicy } from '../src/model/delivery-policy.js';
import { parseRepositoryConfig } from '../src/model/documentation.js';
import { buildPlan, prepareInstall } from '../src/install/index.js';
import { harness } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1102: installing Graphyard in a repository gives it the fast merge gate. GY-1983 removed the
// release-candidate pipeline: setup writes no workflow and install provisions no UAT or production
// environment.

const pullRequestCi = `name: ci
on:
  pull_request:
jobs:
  unit:
    runs-on: ubuntu-latest
  browser-e2e:
    runs-on: ubuntu-latest
  docs-preview:
    runs-on: ubuntu-latest
`;

/** A Node service whose scripts and CI hold every kind of check the classifier has to place. */
const service = {
  'package.json': JSON.stringify({ name: 'orders', scripts: {
    dev: 'vite', build: 'vite build', typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run',
    'test:e2e': 'playwright test', 'test:integration': 'vitest run --config vitest.integration.ts', soak: 'node scripts/soak.mjs',
    'test:snapshots': 'node scripts/snapshots.mjs', 'test:watch': 'vitest',
  }, devDependencies: { vitest: '1.0.0', '@playwright/test': '1.40.0' } }),
  'railway.json': JSON.stringify({ build: { builder: 'NIXPACKS' } }),
  '.github/workflows/ci.yml': pullRequestCi,
};

async function fixtureRepo(files: Record<string, string>) {
  const root = await temporaryDirectory('delivery');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/orders.git'], { cwd: root });
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}
const exists = (path: string) => stat(path).then(() => true, () => false);
const names = (entries: { check: string }[]) => entries.map(entry => entry.check);

test('unit:init-splits-merge-gate-and-candidate-checks — init classifies build, typecheck and fast unit checks as the pre-merge gate and integration/E2E/soak as per-candidate, shows the split before applying, writes the confirmed policy, and honours the per-PR opt-out', async () => {
  // Classification: the gate holds only demonstrably fast checks; tooling scripts are no checks at all.
  const input = { files: Object.keys(service), contents: service };
  const split = classifyChecks(input, detectStack(input));
  assert.deepEqual(names(split.preMerge), ['build', 'typecheck', 'lint', 'test', 'unit']);
  assert.deepEqual(names(split.perCandidate), ['test:e2e', 'test:integration', 'soak', 'test:snapshots', 'browser-e2e', 'docs-preview']);
  assert.equal(split.perCandidate.find(entry => entry.check === 'test:e2e')!.command, 'npm run test:e2e');
  // A check that is not recognisably fast waits for the candidate, and says how to move it.
  assert.match(split.perCandidate.find(entry => entry.check === 'test:snapshots')!.reason, /move it to preMerge in graphyard\.json/);
  assert.equal(split.perCandidate.find(entry => entry.check === 'browser-e2e')!.source, 'workflow');
  assert.ok(![...split.preMerge, ...split.perCandidate].some(entry => ['dev', 'test:watch'].includes(entry.check)));
  // A browser framework no script runs is still the repository's E2E suite.
  const framework = classifyChecks({ files: ['package.json'], contents: { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { cypress: '13.0.0' } }) } });
  assert.deepEqual(names(framework.preMerge), ['test']);
  assert.deepEqual(framework.perCandidate.map(entry => [entry.check, entry.command, entry.source]), [['cypress', 'npx cypress run', 'framework']]);

  const root = await fixtureRepo(service);
  // The confirmation: the scan shows the split and applies nothing.
  const proposal = await scanProposal(root, { url: 'https://graphyard.example', runtimes: [] });
  const delivery = proposal.delivery!;
  assert.equal(delivery.mode, 'release-candidate');
  assert.deepEqual(names(delivery.mergeGate.preMerge), names(split.preMerge));
  assert.deepEqual(proposal.policy.checks, ['test', 'typecheck', 'lint', 'build'], 'a pull request waits only for the pre-merge set');
  assert.equal(delivery.deploy.adapter, 'railway');
  assert.equal(delivery.candidateSchedule, '0 */6 * * *');
  const shown = describeMergeGate(delivery);
  assert.ok(shown.some(line => /^pre-merge — typecheck \(npm run typecheck\)/.test(line)));
  assert.ok(shown.some(line => /^per-candidate — soak \(npm run soak\)/.test(line)));
  assert.match(shown.at(-1)!, /schedule 0 \*\/6 \* \* \*.*railway adapter/);
  assert.equal(await exists(join(root, 'graphyard.json')), false, 'scanning wrote the policy before it was confirmed');
  assert.equal(await exists(join(root, candidateWorkflowFile)), false);

  // Applying the reviewed proposal writes exactly the confirmed split as the merge-gate policy.
  await saveProposal(root, proposal);
  const dependencies = { url: 'https://graphyard.example', githubSetup: async () => ({ appId: 1234, slug: 'graphyard-owner-orders' }), now: () => new Date('2030-01-01T00:00:00Z') };
  const first = await applyProposal(root, proposal, dependencies);
  const config = parseRepositoryConfig(await readFile(join(root, 'graphyard.json'), 'utf8'));
  assert.deepEqual(config.delivery, delivery);
  assert.ok(config.documentation.paths.length > 0, 'the documentation policy is kept beside the delivery policy');
  assert.deepEqual(first.delivery!.requiredChecks, ['build', 'typecheck', 'lint', 'test', 'unit']);
  // GY-2009: repository setup writes no .github/workflows file.
  assert.deepEqual(first.delivery!.workflows, []);
  assert.equal(await exists(join(root, candidateWorkflowFile)), false);
  assert.equal(await exists(join(root, promotionWorkflowFile)), false);
  // Re-applying changes nothing, and nothing feeds back into the scan.
  const second = await applyProposal(root, proposal, dependencies);
  assert.ok(second.unchanged.includes('graphyard.json delivery policy'));
  assert.deepEqual(repositoryScanDifference(await scanProposal(root, { url: 'https://graphyard.example', runtimes: [] }), proposal), []);

  // An operator's edit to the committed split is what the next scan proposes.
  const moved: DeliveryPolicy = { ...delivery, mergeGate: { preMerge: [...delivery.mergeGate.preMerge, delivery.mergeGate.perCandidate[3]], perCandidate: delivery.mergeGate.perCandidate.filter((_, index) => index !== 3) } };
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ ...config, delivery: moved }));
  assert.ok(names((await scanProposal(root, { runtimes: [] })).delivery!.mergeGate.preMerge).includes('test:snapshots'));
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ ...config, delivery }));

  // Opting out to the per-PR model: every check stays required on pull requests and no candidate is cut.
  const perPr = await scanProposal(root, { url: 'https://graphyard.example', runtimes: [], delivery: { mode: 'per-pr' } });
  assert.equal(perPr.delivery!.mode, 'per-pr');
  assert.deepEqual(perPr.policy.checks, perPr.checks);
  assert.match(describeMergeGate(perPr.delivery!)[0], /^per-pr: every check below is required on each pull request/);
  assert.deepEqual(requiredPullRequestChecks(perPr.delivery!), [...names(split.preMerge), ...names(split.perCandidate)]);
  const optedOut = await applyDelivery(root, perPr.delivery!, 'node');
  assert.equal(parseRepositoryConfig(await readFile(join(root, 'graphyard.json'), 'utf8')).delivery!.mode, 'per-pr');
  assert.deepEqual(optedOut.workflows, []);
  assert.equal(await exists(join(root, candidateWorkflowFile)), false, 'GY-2009: no workflow was ever written to name for removal');
  // The committed opt-out is what a later scan proposes.
  assert.equal((await scanProposal(root, { runtimes: [] })).delivery!.mode, 'per-pr');
  // An invalid cadence is refused rather than written.
  await assert.rejects(scanProposal(root, { runtimes: [], delivery: { candidateSchedule: 'hourly' } }), /five-field cron/);
});

const railwayPolicy = (overrides: Partial<DeliveryPolicy['deploy']> = {}): DeliveryPolicy => deliveryPolicySchema.parse({
  mode: 'release-candidate', candidateSchedule: '0 */6 * * *',
  mergeGate: {
    preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fast' }],
    perCandidate: [
      { check: 'test:e2e', command: 'npm run test:e2e', source: 'script', reason: 'long' },
      { check: 'soak', command: 'npm run soak', source: 'script', reason: 'long' },
      { check: 'browser-e2e', command: null, source: 'workflow', reason: 'long' },
    ],
  },
  deploy: { adapter: 'railway', project: 'orders', uat: null, production: null, ...overrides },
});

test('unit:setup-writes-no-release-workflow — setup writes the policy and no workflow, and removes a leftover one an older init generated', async () => {
  const root = await fixtureRepo(service);
  const applied = await applyDelivery(root, railwayPolicy(), 'node');
  assert.equal(await exists(join(root, candidateWorkflowFile)), false);
  assert.equal(await exists(join(root, promotionWorkflowFile)), false);
  assert.deepEqual(applied.workflows, []);
  const leftover = await fixtureRepo(service);
  await mkdir(join(leftover, '.github', 'workflows'), { recursive: true });
  await writeFile(join(leftover, candidateWorkflowFile), '# Generated by graphyard init from the delivery policy in graphyard.json (docs/onboarding.md).\nname: Graphyard release candidate\n');
  const cleaned = await applyDelivery(leftover, railwayPolicy(), 'node');
  assert.equal(await exists(join(leftover, candidateWorkflowFile)), false, 'a leftover generated workflow is removed');
  assert.ok(cleaned.applied.some(line => line.startsWith(`removed ${candidateWorkflowFile}`)));
});

async function committedDelivery(root: string, policy: DeliveryPolicy) {
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ documentation: { paths: ['README.md'], changelog: null }, delivery: policy }));
}

test('unit:install-plan-lists-no-candidate-environments — install --plan of a release-candidate policy lists no UAT or production resource; the reviewed split decides the required checks', async () => {
  const railway = await harness({ provider: 'railway' });
  try {
    await committedDelivery(railway.root, railwayPolicy({ project: null }));
    const session = await prepareInstall(railway.root, { repository: 'owner/project', provider: 'railway' }, railway.deps, 'plan');
    const plan = await buildPlan(session);
    assert.ok(!plan.actions.some(action => action.id.startsWith('release.')));
    assert.deepEqual(plan.delivery, { mode: 'release-candidate', committed: true, preMerge: ['test'], perCandidate: ['test:e2e', 'soak', 'browser-e2e'], adapter: 'railway' });
    assert.deepEqual(session.requiredChecks, ['test']);
    assert.ok(!plan.actions.some(action => action.id === 'github.protection'), 'GY-2009: no branch protection is planned');
    assert.equal(await exists(session.directory), false);
  } finally { await railway.cleanup(); }

  // The per-PR opt-out keeps every check required on pull requests.
  const perPr = await harness({ provider: 'compose' });
  try {
    await committedDelivery(perPr.root, { ...railwayPolicy(), mode: 'per-pr' });
    const session = await prepareInstall(perPr.root, { repository: 'owner/project', provider: 'compose' }, perPr.deps, 'plan');
    await buildPlan(session);
    assert.deepEqual(session.requiredChecks, ['test', 'test:e2e', 'soak', 'browser-e2e']);
    // An explicit --required-check still wins over the policy.
    assert.deepEqual((await prepareInstall(perPr.root, { repository: 'owner/project', provider: 'compose', requiredChecks: ['lint'] }, perPr.deps, 'plan')).requiredChecks, ['lint']);
  } finally { await perPr.cleanup(); }
});
