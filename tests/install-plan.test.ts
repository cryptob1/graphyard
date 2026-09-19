import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildPlan, coreEnv, githubEnv, materializeInstall, prepareInstall, repositoryRoot } from '../src/install/index.js';
import { protectionPayload, protectionSatisfied, CHECK_NAME } from '../src/install/github.js';
import { fingerprint } from '../src/install/secrets.js';
import { installIdFor, REDACTED } from '../src/install/types.js';
import { appKey, harness, satisfiedProtection, WEBHOOK_SECRET, GRAPHYARD_APP_ID } from './install-harness.js';

const execFile = promisify(execFileCallback);

test('an install id is derived from owner/name and rejects anything else', () => {
  assert.equal(installIdFor('Owner/Project'), 'owner-project');
  assert.equal(installIdFor('owner/my.repo'), 'owner-my.repo');
  for (const value of ['owner', 'owner/name/extra', 'https://github.com/owner/name', '']) assert.throws(() => installIdFor(value), /--repo OWNER\/NAME/);
});

test('--plan produces a complete ordered plan and redacts every value that is a secret', async () => {
  const fixture = await harness({ provider: 'railway' });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'railway' }, fixture.deps, 'plan');
    const plan = await buildPlan(session);

    assert.equal(plan.secretsRedacted, true);
    assert.equal(plan.existing, false);
    assert.deepEqual(plan.actions.map(action => action.id), [
      'local.credentials', 'provider.provision.project', 'provider.provision.database', 'provider.provision.app',
      'provider.env.core', 'provider.deploy', 'provider.url', 'verify.health',
      'github.app', 'github.env', 'github.webhook', 'github.ci-app-ids', 'github.protection',
      'verify.status', 'verify.webhook', 'local.profiles', 'local.herdr',
    ]);

    const values = plan.actions.flatMap(action => action.values ?? []);
    const principalsValue = values.find(value => value.name === 'GRAPHYARD_PRINCIPALS')!;
    assert.equal(principalsValue.secret, true);
    assert.equal(principalsValue.value, REDACTED);
    // Nothing has been generated yet, so the plan promises rather than fingerprints.
    assert.equal(principalsValue.fingerprint, undefined);
    assert.equal(principalsValue.note, 'generated on apply');
    for (const value of values) if (value.secret) assert.equal(value.value, REDACTED);
    assert.equal(values.find(value => value.name === 'HOST')!.value, '0.0.0.0');
    assert.equal(values.find(value => value.name === 'DATABASE_URL')!.value, '${{Postgres.DATABASE_URL}}');
    assert.equal(values.find(value => value.name === 'GITHUB_REPOSITORY')!.value, 'owner/project');

    // The plan states the exact human inputs and nothing else is required of a person.
    assert.equal(plan.humanSteps.length, 3);
    assert.match(plan.humanSteps.join(' '), /provider CLI and GitHub CLI/);
    assert.match(plan.actions.find(action => action.id === 'github.app')!.human!, /One browser confirmation/);

    // A plan applies nothing: no provider mutation ran and no local file was created.
    const lines = fixture.commandLines();
    for (const mutation of ['railway init', 'railway add', 'railway up', 'railway variables --service', '--method PUT']) assert.ok(!lines.some(line => line.includes(mutation)), `plan must not run ${mutation}`);
    assert.equal(session.materialized, false);
    assert.equal(session.tokens.size, 0, 'planning must not generate a credential');
    await assert.rejects(stat(session.directory), { code: 'ENOENT' }, 'planning must not create the installation directory');

    // Preparing an --apply run creates nothing either: the credentials are minted only after
    // the preflight gate inside applyInstall, so a refused apply leaves the machine untouched.
    const applied = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'railway' }, fixture.deps, 'apply');
    assert.equal(applied.materialized, false);
    await assert.rejects(stat(applied.directory), { code: 'ENOENT' }, 'preparing an apply created the installation directory');

    // Once the credentials exist, the same plan reports the real fingerprints of what exists.
    await materializeInstall(applied);
    const materialized = await buildPlan(applied);
    const written = materialized.actions.find(action => action.id === 'provider.env.core')!.values!.find(value => value.name === 'GRAPHYARD_PRINCIPALS')!;
    assert.equal(written.value, REDACTED);
    assert.equal(written.fingerprint, fingerprint(coreEnv(applied).find(value => value.name === 'GRAPHYARD_PRINCIPALS')!.value));
    const serialized = JSON.stringify(materialized);
    for (const token of applied.tokens.values()) assert.ok(!serialized.includes(token));
    assert.ok(!serialized.includes(applied.context.databasePassword));
  } finally { await fixture.cleanup(); }
});

test('a self-hosted plan treats DATABASE_URL as a secret and names the required variables', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'compose' }, fixture.deps, 'apply');
    const core = coreEnv(session);
    assert.deepEqual(core.map(value => value.name), ['HOST', 'PORT', 'DATABASE_URL', 'GRAPHYARD_PRINCIPALS', 'GITHUB_REPOSITORY', 'GITHUB_BASE_BRANCH', 'GRAPHYARD_REVIEWER_APPS', 'GRAPHYARD_MAX_SLICE_LEADS', 'GRAPHYARD_MAX_ENGINEERS_PER_LEAD', 'GRAPHYARD_MIN_REVIEWERS', 'GRAPHYARD_MAX_REVIEWERS']);
    assert.equal(core.find(value => value.name === 'DATABASE_URL')!.secret, true);
    const plan = await buildPlan(session);
    assert.equal(plan.actions.find(action => action.id === 'provider.env.core')!.values!.find(value => value.name === 'DATABASE_URL')!.value, REDACTED);

    const github = githubEnv({ appId: GRAPHYARD_APP_ID, slug: 'app', installationId: 500, privateKey: appKey, webhookSecret: WEBHOOK_SECRET }, [15368, 99]);
    assert.deepEqual(github.map(value => value.name), ['GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_CI_APP_IDS']);
    assert.deepEqual(github.filter(value => value.secret).map(value => value.name), ['GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET']);
    assert.equal(github.find(value => value.name === 'GITHUB_CI_APP_IDS')!.value, '15368,99');
  } finally { await fixture.cleanup(); }
});

test('preflight names the exact command to run when a CLI is missing or unauthenticated', async () => {
  const fixture = await harness({ provider: 'hetzner' });
  fixture.transport.commands.length = 0;
  const failing = await harness({ provider: 'hetzner' });
  try {
    // Replace the transcript so hcloud reports that it is not configured.
    const broken = { ...failing.deps, transport: { ...failing.transport, exec: async (program: string, args: string[], options: any = {}) => {
      if (program === 'hcloud') { if (!options.allowFailure) throw new Error('hcloud exited with 1'); return { stdout: '', stderr: 'not configured', code: 1 }; }
      return failing.transport.exec(program, args, options);
    } } };
    const session = await prepareInstall(failing.root, { repository: 'owner/project', provider: 'hetzner' }, broken as any, 'plan');
    const plan = await buildPlan(session);
    const hcloud = plan.preflight.find(item => item.name === 'hcloud CLI')!;
    assert.equal(hcloud.ok, false);
    assert.match(hcloud.fix!, /hcloud context create graphyard/);
    assert.ok(plan.preflight.some(item => item.name === 'GitHub CLI'));
  } finally { await fixture.cleanup(); await failing.cleanup(); }
});

test('branch protection is read-modify-write and matches the chosen review policy', () => {
  const current = {
    required_status_checks: { strict: false, checks: [{ context: 'lint', app_id: 77 }] },
    required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: false, require_code_owner_reviews: true, require_last_push_approval: true, dismissal_restrictions: { users: [{ login: 'release-manager' }], teams: [{ slug: 'platform' }], apps: [] } },
    restrictions: { users: [{ login: 'release-manager' }], teams: [], apps: [] },
    lock_branch: { enabled: true },
  };
  const payload = protectionPayload({ repository: 'owner/project', branch: 'main', requiredChecks: ['test', 'typecheck'], graphyardAppId: 4242, reviewCount: 1 }, current);
  // "Require branches to be up to date" stays off: the merge queue lands a queued candidate that
  // is deliberately behind the base branch, and Graphyard's merge gate refuses while it is on.
  assert.equal(payload.required_status_checks.strict, false);
  // The branch requires approvals but dismissed none; an approval must bind the commit it is on.
  assert.equal(payload.required_pull_request_reviews.dismiss_stale_reviews, true);
  assert.equal(payload.required_pull_request_reviews.require_last_push_approval, true);
  // The repository's own check survives; Graphyard's is bound to its App.
  assert.deepEqual(payload.required_status_checks.checks.map(check => check.context), ['lint', 'test', 'typecheck', CHECK_NAME]);
  assert.equal(payload.required_status_checks.checks.find(check => check.context === CHECK_NAME)!.app_id, 4242);
  assert.equal(payload.required_status_checks.checks.find(check => check.context === 'lint')!.app_id, 77);
  assert.equal(payload.enforce_admins, true);
  assert.equal(payload.required_conversation_resolution, true);
  assert.equal(payload.allow_force_pushes, false);
  assert.equal(payload.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.deepEqual(payload.restrictions, { users: ['release-manager'], teams: [], apps: [] });
  assert.deepEqual(payload.required_pull_request_reviews.dismissal_restrictions, { users: ['release-manager'], teams: ['platform'], apps: [] });
  // The branch already asks for two reviewers; a policy that asks for one does not lower it.
  assert.equal(payload.required_pull_request_reviews.required_approving_review_count, 2);
  assert.equal(payload.lock_branch, true, 'a locked branch stays locked');

  // Neither does the agent review policy, which asks for none.
  const agent = protectionPayload({ repository: 'owner/project', branch: 'main', requiredChecks: [], graphyardAppId: 4242, reviewCount: 0 }, current);
  assert.equal(agent.required_pull_request_reviews.required_approving_review_count, 2);
  assert.equal(agent.required_pull_request_reviews.require_last_push_approval, true);
  assert.equal(agent.enforce_admins, true);

  // On an unprotected branch the policy's own count is what gets applied.
  const fresh = protectionPayload({ repository: 'owner/project', branch: 'main', requiredChecks: ['test'], graphyardAppId: 4242, reviewCount: 1 }, null);
  assert.equal(fresh.required_pull_request_reviews.required_approving_review_count, 1);
  assert.equal(fresh.required_pull_request_reviews.require_last_push_approval, true);
  assert.equal(fresh.lock_branch, false);
  assert.equal(fresh.required_pull_request_reviews.dismiss_stale_reviews, true);
  assert.equal(fresh.required_status_checks.strict, false);
  const freshAgent = protectionPayload({ repository: 'owner/project', branch: 'main', requiredChecks: ['test'], graphyardAppId: 4242, reviewCount: 0 }, null);
  assert.equal(freshAgent.required_pull_request_reviews.required_approving_review_count, 0);
  assert.equal(freshAgent.required_pull_request_reviews.require_last_push_approval, false);
  assert.equal(freshAgent.enforce_admins, true);
  assert.equal(freshAgent.required_status_checks.strict, false);

  // A branch that keeps "up to date" on is drift the installer repairs: leaving it would install a
  // repository whose merge gate refuses every candidate the queue publishes.
  const upToDate = { ...satisfiedProtection(4242), required_status_checks: { ...satisfiedProtection(4242).required_status_checks, strict: true } };
  assert.equal(protectionSatisfied({ repository: 'owner/project', branch: 'main', requiredChecks: ['test', 'typecheck'], graphyardAppId: 4242, reviewCount: 1 }, upToDate), false, 'a strict branch was reported as satisfying protection');

  const inputs = { repository: 'owner/project', branch: 'main', requiredChecks: ['test', 'typecheck'], graphyardAppId: 4242, reviewCount: 1 };
  assert.equal(protectionSatisfied(inputs, null), false);
  assert.equal(protectionSatisfied(inputs, satisfiedProtection(4242)), true);
  assert.equal(protectionSatisfied(inputs, satisfiedProtection(null)), false, 'an unbound merge check is not the App-bound check');
  assert.equal(protectionSatisfied(inputs, satisfiedProtection(4242, 0)), false, 'too few required reviews is drift, not a match');
  assert.equal(protectionSatisfied(inputs, satisfiedProtection(4242, 3)), true, 'a stricter review count already satisfies the policy');
  assert.equal(protectionSatisfied(inputs, { ...satisfiedProtection(4242), enforce_admins: { enabled: false } }), false);
  // An approval that survives the next push does not bind the candidate that finally merges.
  assert.equal(protectionSatisfied(inputs, { ...satisfiedProtection(4242), required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false, require_last_push_approval: true } }), false, 'undismissed stale approvals were reported as satisfying protection');
  assert.equal(protectionSatisfied(inputs, { ...satisfiedProtection(4242), required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: false } }), false, 'an unapproved last push was reported as satisfying protection');

  // A branch whose head can be replaced or removed is not protected, whatever else it requires:
  // evidence is bound to a commit, and a force push swaps the commit out from under it.
  assert.equal(protectionSatisfied(inputs, { ...satisfiedProtection(4242), allow_force_pushes: { enabled: true } }), false, 'a force-pushable branch was reported as satisfying protection');
  assert.equal(protectionSatisfied(inputs, { ...satisfiedProtection(4242), allow_deletions: { enabled: true } }), false, 'a deletable branch was reported as satisfying protection');
  assert.equal(fresh.allow_force_pushes, false);
  assert.equal(fresh.allow_deletions, false);
});

test('repositoryRoot refuses to install from outside a checkout', async () => {
  assert.throws(() => repositoryRoot('/'), /Run graphyard install from the checkout/);
});

test('the CLI accepts every option the runbook documents and refuses a count that is not a number', async () => {
  const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
  const run = async (args: string[]) => {
    const result = await execFile(process.execPath, [launcher, 'install', '--provider', 'compose', '--repo', 'owner/project', ...args], { cwd: '/', env: { ...process.env, GRAPHYARD_URL: '', GRAPHYARD_TOKEN: '' } })
      .then(() => ({ code: 0, stderr: '' }), (error: any) => ({ code: error.code ?? 1, stderr: String(error.stderr ?? '') }));
    assert.notEqual(result.code, 0);
    return result.stderr;
  };
  // Every documented flag must parse. Reaching the checkout check proves the option was accepted.
  for (const args of [['--port', '4400'], ['--workers', '3'], ['--review-count', '2'], ['--required-check', 'lint'], ['--domain', 'graphyard.example'], ['--base-branch', 'trunk'], ['--producer-proof', 'unit:example'], ['--reviewer', 'claude'], ['--review-policy', 'agent']]) {
    assert.match(await run([...args, '--plan']), /Run graphyard install from the checkout/, `${args[0]} was not accepted by the CLI`);
  }
  // A silently NaN count would install no worker principal at all, or an unusable port.
  for (const flag of ['--workers', '--port', '--review-count']) assert.match(await run([flag, 'many', '--plan']), new RegExp(`${flag} takes a whole number`));
});
