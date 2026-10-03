import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { classifyChecks, describeMergeGate, detectStack } from '../src/onboarding.js';
import { applyDelivery, applyProposal, repositoryScanDifference, saveProposal, scanProposal } from '../src/repository-setup.js';
import { candidateWorkflowFile, deliveryPolicySchema, promotionWorkflowFile, requiredPullRequestChecks, type DeliveryPolicy } from '../src/model/delivery-policy.js';
import { parseRepositoryConfig } from '../src/model/documentation.js';
import { candidateWorkflowName, pinnedCli, publishedCliCommit, renderCandidateWorkflow, renderPromotionWorkflow, suiteJobId } from '../src/install/release-pipeline.js';
import { assessPromotion, type ReleaseCandidate, type UatRecord } from '../src/release-candidate.js';
import { applyInstall, buildPlan, prepareInstall } from '../src/install/index.js';
import { fileURLToPath } from 'node:url';
import { harness } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1102: installing Graphyard in a repository gives it the fast merge gate and the
// release-candidate pipeline Graphyard delivers itself with. One case per proof:
// unit:init-splits-merge-gate-and-candidate-checks, unit:setup-generates-candidate-and-promotion-workflows,
// unit:install-plan-lists-candidate-environments.

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
  assert.deepEqual(first.delivery!.workflows, [candidateWorkflowFile, promotionWorkflowFile]);
  // Re-applying changes nothing, and the generated workflows never feed back into the scan.
  const second = await applyProposal(root, proposal, dependencies);
  assert.ok(second.unchanged.includes('graphyard.json delivery policy') && second.unchanged.includes(candidateWorkflowFile));
  assert.deepEqual(repositoryScanDifference(await scanProposal(root, { url: 'https://graphyard.example', runtimes: [] }), proposal), []);

  // An operator's edit to the committed split is what the next scan proposes.
  const moved: DeliveryPolicy = { ...delivery, mergeGate: { preMerge: [...delivery.mergeGate.preMerge, delivery.mergeGate.perCandidate[3]], perCandidate: delivery.mergeGate.perCandidate.filter((_, index) => index !== 3) } };
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ ...config, delivery: moved }));
  assert.ok(names((await scanProposal(root, { runtimes: [] })).delivery!.mergeGate.preMerge).includes('test:snapshots'));
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ ...config, delivery }));

  // Opting out to the per-PR model: every check stays required on pull requests, no candidate is cut,
  // and generated workflows left behind are named for removal rather than silently deleted.
  const perPr = await scanProposal(root, { url: 'https://graphyard.example', runtimes: [], delivery: { mode: 'per-pr' } });
  assert.equal(perPr.delivery!.mode, 'per-pr');
  assert.deepEqual(perPr.policy.checks, perPr.checks);
  assert.match(describeMergeGate(perPr.delivery!)[0], /^per-pr: every check below is required on each pull request/);
  assert.deepEqual(requiredPullRequestChecks(perPr.delivery!), [...names(split.preMerge), ...names(split.perCandidate)]);
  const optedOut = await applyDelivery(root, perPr.delivery!, 'node');
  assert.equal(parseRepositoryConfig(await readFile(join(root, 'graphyard.json'), 'utf8')).delivery!.mode, 'per-pr');
  assert.deepEqual(optedOut.workflows, []);
  assert.ok(optedOut.drift.some(line => line.includes(candidateWorkflowFile) && /opting out/.test(line)));
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

/** Each job's id and block of text (the tests/ci-workflow-split.test.ts approach, no YAML dependency). */
function jobsOf(text: string) {
  const lines = text.split('\n'), start = lines.indexOf('jobs:');
  assert.ok(start >= 0, 'the workflow declares jobs');
  const jobs = new Map<string, string>();
  let id: string | null = null, body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const opened = line.match(/^ {2}([\w-]+):\s*$/)?.[1];
    if (opened) { if (id) jobs.set(id, body.join('\n')); id = opened; body = []; } else body.push(line);
  }
  if (id) jobs.set(id, body.join('\n'));
  return jobs;
}
const triggersOf = (text: string) => text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'));

test('unit:setup-generates-candidate-and-promotion-workflows — the generated workflows cut a pinned SHA, deploy it to UAT through the configured adapter, and promote only a UAT-passed candidate by its exact SHA', async () => {
  const cli = pinnedCli();
  // The pin is the exact Graphyard commit that rendered the workflows, and one that exists: a
  // version tag the repository never published would fail the very first step in every managed repo.
  const pinned = cli.match(/^npx -y github:cryptob1\/graphyard#([0-9a-f]{40})$/)?.[1];
  assert.ok(pinned, `the workflows run the CLI commit that rendered them, never a floating or version ref: ${cli}`);
  assert.doesNotThrow(() => execFileSync('git', ['cat-file', '-e', `${pinned}^{commit}`], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' }), 'the pinned commit exists');
  const stamped = 'a'.repeat(40);
  assert.equal(publishedCliCommit({ GRAPHYARD_BUILD_SHA: stamped }), stamped, 'a build that stamps its commit pins that commit');
  assert.equal(publishedCliCommit({}, (_command, args) => args.includes('merge-base') ? `${'b'.repeat(40)}\n` : 'c'.repeat(40)), 'b'.repeat(40), 'a checkout pins its newest commit origin/main already holds');
  assert.throws(() => publishedCliCommit({}, () => { throw new Error('not a git checkout'); }), /GRAPHYARD_BUILD_SHA/, 'no resolvable commit refuses rather than rendering an unresolvable pin');
  for (const policy of [railwayPolicy(), railwayPolicy({ adapter: 'command', project: null, uat: './deploy.sh uat', production: './deploy.sh production' })]) {
    const adapter = policy.deploy.adapter;
    const candidate = renderCandidateWorkflow(policy, { stack: 'node' });
    assert.match(triggersOf(candidate), /schedule:\n {4}- cron: '0 \*\/6 \* \* \*'\n {2}workflow_dispatch:/);
    assert.doesNotMatch(triggersOf(candidate), /pull_request|push:/, 'a candidate is never cut by a pull request or a push');
    const jobs = jobsOf(candidate);
    assert.deepEqual([...jobs.keys()], ['candidate', 'suite-test-e2e', 'suite-soak', 'uat']);

    // The cut pins main's tip to an exact SHA and hands it to every later job.
    const cut = jobs.get('candidate')!;
    assert.match(cut, new RegExp(`${cli.replace(/[.#/]/g, '\\$&')} release cut --base main`));
    assert.match(cut, /sha: \$\{\{ steps\.cut\.outputs\.sha \}\}/);

    // Every per-candidate suite runs its command at that exact SHA, never on a moving ref.
    for (const check of ['test:e2e', 'soak']) {
      const suite = jobs.get(suiteJobId(check))!;
      assert.match(suite, /needs: candidate/);
      assert.match(suite, /CANDIDATE_SHA: \$\{\{ needs\.candidate\.outputs\.sha \}\}/);
      assert.match(suite, /\^\[0-9a-f\]\{40\}\$/, 'a suite refuses anything but a full SHA');
      assert.match(suite, /ref: '\$\{\{ env\.CANDIDATE_SHA \}\}'/);
      assert.doesNotMatch(suite, /ref: main/);
      assert.match(suite, new RegExp(`npm run ${check}`));
    }
    assert.ok(![...jobs.keys()].includes('suite-browser-e2e'), 'a workflow job without a command keeps running in its own workflow');

    // UAT receives that SHA through the configured adapter, then records the verdict with every suite.
    const uat = jobs.get('uat')!;
    assert.match(uat, /needs: \[candidate, suite-test-e2e, suite-soak\]/);
    assert.match(uat, /environment: uat/);
    assert.match(uat, /release uat "\$\{\{ needs\.candidate\.outputs\.id \}\}"/);
    assert.match(uat, adapter === 'railway' ? /railway adapter \(the uat environment's service tracks release\/uat/ : /through the command adapter\n.*\n.*\n {10}\.\/deploy\.sh uat\n/);
    assert.match(uat, /GRAPHYARD_CANDIDATE_SHA: \$\{\{ needs\.candidate\.outputs\.sha \}\}/);
    assert.match(uat, /release validate .* --url "\$UAT_URL"/);
    assert.match(uat, /--suite 'test-e2e=test "\$SUITE_TEST_E2E" = success'/);
    assert.match(uat, /SUITE_SOAK: \$\{\{ needs\.suite-soak\.result \}\}/);

    // Promotion follows only a successful candidate run, and production gets the promoted SHA.
    const promotion = renderPromotionWorkflow(policy);
    assert.match(triggersOf(promotion), new RegExp(`workflow_run:\\n {4}workflows: \\['${candidateWorkflowName}'\\]\\n {4}types: \\[completed\\]`));
    const promote = jobsOf(promotion).get('promote')!;
    assert.match(promote, /if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.workflow_run\.conclusion == 'success'/);
    assert.match(promote, /environment: production/);
    assert.match(promote, /release promote "\$\{CANDIDATE:-latest\}"/);
    assert.match(promote, /GRAPHYARD_CANDIDATE_SHA: \$\{\{ steps\.promote\.outputs\.sha \}\}/);
    assert.match(promote, adapter === 'railway' ? /tracks release\/production/ : / {10}\.\/deploy\.sh production\n/);
    assert.ok(promote.indexOf('release promote') < promote.indexOf('GRAPHYARD_CANDIDATE_SHA'), 'production deploys only after promotion accepted the candidate');
    assert.match(promote, /release verify --base main --url "\$PRODUCTION_URL"/);
  }

  // The command adapter never invents a deploy command.
  assert.throws(() => renderCandidateWorkflow(railwayPolicy({ adapter: 'command', project: null })), /set delivery\.deploy\.uat in graphyard\.json/);
  // A candidate cut only on demand has no schedule.
  assert.doesNotMatch(renderCandidateWorkflow({ ...railwayPolicy(), candidateSchedule: null }), /schedule:/);

  // The promotion step the workflow runs is the CLI's own gate: only a candidate whose UAT record
  // passed on its exact SHA is promotable, whatever triggered the workflow.
  const sha = 'b'.repeat(40);
  const rc: ReleaseCandidate = { id: '20301001T000000Z', sha, cutAt: '2030-10-01T00:00:00Z', trigger: 'schedule', since: null, items: [] };
  const record = (overrides: Partial<UatRecord>): UatRecord => ({ id: rc.id, sha, result: 'passed', deployedSha: sha, at: '2030-10-01T01:00:00Z', suites: [], followUp: null, ...overrides });
  assert.equal(assessPromotion(rc, null, null).promotable, false);
  assert.equal(assessPromotion(rc, record({ result: 'failed', suites: [{ name: 'test-e2e', passed: false, detail: 'failed' }] }), null).promotable, false);
  assert.equal(assessPromotion(rc, record({ deployedSha: 'c'.repeat(40) }), null).promotable, false, 'UAT served another SHA');
  assert.deepEqual(assessPromotion(rc, record({}), null), { promotable: true, refusals: [], sha, already: false });

  // Setup writes exactly what it renders.
  const root = await fixtureRepo(service);
  const applied = await applyDelivery(root, railwayPolicy(), 'node');
  assert.equal(await readFile(join(root, candidateWorkflowFile), 'utf8'), renderCandidateWorkflow(railwayPolicy(), { stack: 'node' }));
  assert.equal(await readFile(join(root, promotionWorkflowFile), 'utf8'), renderPromotionWorkflow(railwayPolicy(), { stack: 'node' }));
  assert.deepEqual(applied.workflows, [candidateWorkflowFile, promotionWorkflowFile]);
  // A command adapter without its commands writes the policy but no workflow, and says what is missing.
  const unconfigured = await applyDelivery(await fixtureRepo(service), railwayPolicy({ adapter: 'command', project: null }), 'node');
  assert.deepEqual(unconfigured.workflows, []);
  assert.ok(unconfigured.drift.some(line => /delivery\.deploy\.uat/.test(line)));
});

async function committedDelivery(root: string, policy: DeliveryPolicy) {
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ documentation: { paths: ['README.md'], changelog: null }, delivery: policy }));
}

test('unit:install-plan-lists-candidate-environments — install --plan lists every UAT and production resource the deployment adapter would create, marks the ones that cost money as human decisions, and applies nothing', async () => {
  // Railway: a new project and both environments, each a cost the operator approves.
  const railway = await harness({ provider: 'railway' });
  try {
    await committedDelivery(railway.root, railwayPolicy({ project: null }));
    const session = await prepareInstall(railway.root, { repository: 'owner/project', provider: 'railway' }, railway.deps, 'plan');
    const plan = await buildPlan(session);
    const release = plan.actions.filter(action => action.id.startsWith('release.'));
    assert.deepEqual(release.map(action => action.id), ['release.branches', 'release.github-environments', 'release.railway.project', 'release.railway.uat', 'release.railway.production']);
    for (const id of ['release.railway.project', 'release.railway.uat', 'release.railway.production']) {
      const action = release.find(entry => entry.id === id)!;
      assert.equal(action.state, 'create');
      assert.match(action.human!, /billable|Costs money/, `${id} is not marked as a human cost decision`);
      assert.match(action.human!, /--create-environments/);
    }
    assert.match(release.find(action => action.id === 'release.railway.uat')!.title, /deploying release\/uat \(never main\), holding no GITHUB_\* credential/);
    assert.match(release.find(action => action.id === 'release.railway.production')!.command!, /railway environment new production/);
    assert.ok(!release.find(action => action.id === 'release.branches')!.human, 'free wiring is no human decision');
    // The reviewed split, not the discovered checks, is what protection requires.
    assert.deepEqual(plan.delivery, { mode: 'release-candidate', committed: true, preMerge: ['test'], perCandidate: ['test:e2e', 'soak', 'browser-e2e'], adapter: 'railway' });
    assert.deepEqual(session.requiredChecks, ['test']);
    assert.match(plan.actions.find(action => action.id === 'github.protection')!.title, /Require status checks \(test, Graphyard/);
    // The plan applied nothing.
    const lines = railway.commandLines();
    for (const mutation of ['railway init', 'railway environment', 'railway add', '--method POST', '--method PUT']) assert.ok(!lines.some(line => line.includes(mutation)), `plan ran ${mutation}`);
    assert.equal(await exists(session.directory), false);
  } finally { await railway.cleanup(); }

  // --apply without --create-environments wires the free parts and leaves every cost pending.
  const applied = await harness({ provider: 'compose' });
  try {
    await committedDelivery(applied.root, railwayPolicy());
    const session = await prepareInstall(applied.root, { repository: 'owner/project', provider: 'compose' }, applied.deps);
    const summary = await applyInstall(session, await buildPlan(session));
    const lines = applied.commandLines();
    assert.ok(lines.some(line => line.includes('--method POST repos/owner/project/git/refs -f ref=refs/heads/release/uat')));
    assert.ok(lines.some(line => line.includes('--method PUT repos/owner/project/environments/production')));
    assert.ok(!lines.some(line => line.startsWith('railway environment') || line.startsWith('railway add')), 'a paid environment was created without --create-environments');
    assert.deepEqual(summary.release.pending.map(action => action.id), ['release.railway.uat', 'release.railway.production']);
    assert.ok(summary.nextSteps.some(step => /Costs money.*Command: railway environment new uat/.test(step)));

    // With the operator's explicit approval the environments are created, inside Graphyard's own link directory.
    const approved = await prepareInstall(applied.root, { repository: 'owner/project', provider: 'compose', createEnvironments: true }, applied.deps);
    const second = await applyInstall(approved, await buildPlan(approved));
    const created = applied.transport.commands.filter(command => command.program === 'railway' && command.args[0] === 'environment' && command.args[1] === 'new');
    assert.deepEqual(created.map(command => command.args[2]), ['uat', 'production']);
    for (const command of created) assert.equal(command.cwd, `${approved.directory}/release-railway`, 'railway ran outside the Graphyard link directory');
    assert.deepEqual(second.release.created.filter(id => id.startsWith('release.railway')), ['release.railway.uat', 'release.railway.production']);
    const replanned = await buildPlan(await prepareInstall(applied.root, { repository: 'owner/project', provider: 'compose' }, applied.deps, 'plan'));
    assert.equal(replanned.actions.find(action => action.id === 'release.railway.uat')!.state, 'satisfied', 'a re-plan creates nothing twice');
  } finally { await applied.cleanup(); }

  // The generic command adapter creates nothing and invents nothing: a configured environment is the
  // operator's command, an unconfigured one is the operator's step, and both are human decisions.
  const command = await harness({ provider: 'compose' });
  try {
    await committedDelivery(command.root, railwayPolicy({ adapter: 'command', project: null, uat: './deploy.sh uat' }));
    const session = await prepareInstall(command.root, { repository: 'owner/project', provider: 'compose' }, command.deps, 'plan');
    const plan = await buildPlan(session);
    const uat = plan.actions.find(action => action.id === 'release.command.uat')!, production = plan.actions.find(action => action.id === 'release.command.production')!;
    assert.equal(uat.state, 'satisfied');
    assert.match(uat.title, /\.\/deploy\.sh uat/);
    assert.equal(production.state, 'create');
    assert.match(production.command!, /set delivery\.deploy\.production in graphyard\.json/);
    for (const action of [uat, production]) assert.match(action.human!, /creates no (uat|production) resource.*account or cost it needs is your decision/);
    assert.ok(plan.preflight.every(item => item.ok), 'an unconfigured command is a listed step, not a refused install');
    assert.ok(!command.commandLines().some(line => /--method (POST|PUT)/.test(line)));
  } finally { await command.cleanup(); }

  // The per-PR opt-out plans no candidate environment and keeps every check required on pull requests.
  const perPr = await harness({ provider: 'compose' });
  try {
    await committedDelivery(perPr.root, { ...railwayPolicy(), mode: 'per-pr' });
    const session = await prepareInstall(perPr.root, { repository: 'owner/project', provider: 'compose' }, perPr.deps, 'plan');
    const plan = await buildPlan(session);
    assert.ok(!plan.actions.some(action => action.id.startsWith('release.')));
    assert.deepEqual(session.requiredChecks, ['test', 'test:e2e', 'soak', 'browser-e2e']);
    // An explicit --required-check still wins over the policy.
    assert.deepEqual((await prepareInstall(perPr.root, { repository: 'owner/project', provider: 'compose', requiredChecks: ['lint'] }, perPr.deps, 'plan')).requiredChecks, ['lint']);
  } finally { await perPr.cleanup(); }
});
