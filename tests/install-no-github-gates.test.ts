/**
 * GY-2009: install and CI use nothing from GitHub — no App, no branch protection or rulesets,
 * no Actions gates; the merge writer deploy key is the only access.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { applyProposal } from '../src/repository-setup.js';
import { gitleaksIgnorePath, secretScanArgv } from '../src/merge-writer/secret-scan.js';
import { harness } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('unit:install-no-github-gates — default --plan lists the merge writer deploy key and no App or protection step; removed flags are unknown', async () => {
  assert.throws(() => installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--github-app', 'app.json']), /Unknown option|--github-app/i);
  assert.throws(() => installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--reuse-app', 'slug']), /Unknown option|--reuse-app/i);
  assert.throws(() => installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--restore-protection']), /Unknown option|--restore-protection/i);
  assert.throws(() => installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--no-github-app']), /Unknown option|--no-github-app/i);

  const fixture = await harness({ provider: 'compose' });
  try {
    const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--workers', '1', '--plan']);
    assert.equal(request.noGithubApp, true);
    const session = await prepareInstall(fixture.root, request, fixture.deps, 'plan');
    const plan = await buildPlan(session);
    const ids = plan.actions.map(action => action.id);
    assert.ok(ids.includes('github.deploy-key'), `plan must list deploy key: ${ids.join(', ')}`);
    assert.match(plan.actions.find(action => action.id === 'github.deploy-key')!.title, /deploy key|merge writer/i);
    for (const absent of ['github.app', 'github.env', 'github.webhook', 'github.ci-app-ids', 'github.protection', 'github.reviewer']) {
      assert.ok(!ids.includes(absent), `${absent} must not be planned: ${ids.join(', ')}`);
    }
    assert.ok(!plan.humanSteps.some(step => /GitHub App|branch protection|ruleset/i.test(step)), plan.humanSteps.join('\n'));
    assert.deepEqual(plan.browserApps, []);
  } finally { await fixture.cleanup(); }
});

test('unit:install-no-github-gates — apply calls no /protection or /rulesets endpoint, registers no App, and registers the deploy key', async () => {
  const fixture = await harness({
    provider: 'compose',
    statusBody: { actor: { id: 'owner-project-operator', role: 'admin' }, repository: 'owner/project', github: false, githubAppId: null, githubInstallationId: null },
  });
  try {
    const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--workers', '1', '--apply']);
    const session = await prepareInstall(fixture.root, request, { ...fixture.deps, githubApp: async () => { throw new Error('App flow must not run'); } });
    const plan = await buildPlan(session);
    const summary = await applyInstall(session, plan);
    const lines = fixture.allCommandLines();
    assert.ok(!lines.some(line => /\/protection|\/rulesets/.test(line)), `gate API called: ${lines.filter(l => /protection|rulesets/.test(l)).join('\n')}`);
    assert.ok(lines.some(line => /deploy-key list/.test(line)), 'deploy-key list');
    assert.ok(lines.some(line => /deploy-key add/.test(line)) || lines.some(line => /deploy-key list/.test(line)), 'deploy-key registration');
    assert.equal(summary.github, null);
    assert.match(summary.protection, /deploy key/i);
    assert.ok(!existsSync(join(session.directory, 'github-app.json')));
  } finally { await fixture.cleanup(); }
});

test('unit:github-gates-removed — protection scripts and CI gate workflows are gone; repository setup writes no workflow; trial secret-scan argv is pinned', async () => {
  assert.ok(!existsSync('scripts/protect-github.mjs'));
  assert.ok(!existsSync('scripts/verify-enforcement.mjs'));
  assert.ok(!existsSync('.github/workflows/ci.yml'));
  assert.ok(!existsSync('.github/workflows/acceptance.yml'));
  assert.ok(!existsSync('.github/workflows/deploy-smoke.yml'));
  assert.ok(existsSync('.github/workflows/release.yml'));
  assert.ok(existsSync('.github/workflows/release-candidate.yml'));

  const { temporaryRepository } = await import('./install-harness.js');
  const root = await temporaryRepository('owner/demo');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'true', build: 'true' } }));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n');
  // Minimal proposal: apply must not create .github/workflows (GY-2009).
  const { buildProposal, collectScanInput } = await import('../src/onboarding.js');
  const proposal = buildProposal(await collectScanInput(root), { delivery: { mode: 'per-pr' } });
  const result = await applyProposal(root, proposal, { url: 'http://127.0.0.1:4310', writeCredentials: false });
  assert.ok(!(result.delivery?.workflows?.length), `workflows written: ${JSON.stringify(result.delivery?.workflows)}`);
  assert.ok(!existsSync(join(root, '.github', 'workflows', 'graphyard-delivery.yml')));
  assert.ok(!existsSync(join(root, '.github', 'workflows', 'graphyard-release-candidate.yml')));

  const argv = secretScanArgv('/tmp/checkout');
  assert.ok(argv.includes('--redact'));
  assert.ok(argv.includes('--log-opts=HEAD'));
  assert.ok(argv.includes('--gitleaks-ignore-path'));
  assert.ok(argv.some(arg => arg.endsWith(gitleaksIgnorePath)));
});
