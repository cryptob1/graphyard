import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { installDirectory, readInstallRecord } from '../src/install/secrets.js';
import { DEPLOY_PUBLIC_KEY, harness, HOST_DEPLOY_PUBLIC_KEY, type Harness } from './install-harness.js';

// GY-2010: install registers no GitHub App. A normal install and a self-contained host install both
// finish on the deploy-key path alone — no App page, webhook, branch protection or GitHub API call —
// and the flags of the App era are refused as unknown.

const APP_ERA = /^(github\.(app|env|webhook|ci-app-ids|protection|reviewer)|verify\.webhook)$/;
const APP_VARIABLES = /^(GITHUB_(APP_ID|INSTALLATION_ID|PRIVATE_KEY|WEBHOOK_SECRET|CI_APP_IDS)|GRAPHYARD_REVERT_APPROVER_\w+)=/m;
const githubApiRequests = (fixture: Harness) => fixture.requests.filter(request => /api\.github\.com|\/app\/|\/repos\//.test(request.url));
const deployKeyAdds = (fixture: Harness) => fixture.commandLines().filter(line => line.startsWith('gh repo deploy-key add '));

async function apply(fixture: Harness, args: string[]) {
  const { request } = installRequestFromArgs(args);
  const session = await prepareInstall(fixture.root, request, fixture.deps, 'apply');
  const plan = await buildPlan(session);
  return { session, plan, summary: await applyInstall(session, plan) };
}

test('unit:install-deploy-key — a fresh normal install finishes on the deploy key with no GitHub App, webhook or protection', async () => {
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310' });
  try {
    const args = ['--provider', 'compose', '--repo', 'owner/project', '--apply'];
    const { plan, summary } = await apply(fixture, args);
    assert.ok(plan.preflight.every(item => item.ok), JSON.stringify(plan.preflight.filter(item => !item.ok)));
    assert.deepEqual(plan.actions.filter(action => APP_ERA.test(action.id)).map(action => action.id), [], 'no App-era action is planned');
    const key = plan.actions.find(action => action.id === 'github.deploy-key')!;
    assert.equal(key.state, 'create');
    assert.match(key.title, /register it read-write on owner\/project through the gh login/);
    assert.doesNotMatch(JSON.stringify(plan.humanSteps), /\bApp\b|browser/);

    const directory = installDirectory('owner-project', fixture.configHome);
    assert.equal(summary.deployKey, join(directory, 'deploy-key'));
    assert.equal((await stat(summary.deployKey!)).mode & 0o777, 0o600);
    assert.deepEqual(deployKeyAdds(fixture), [`gh repo deploy-key add ${join(directory, 'deploy-key.pub')} -R owner/project --allow-write --title graphyard-merge-writer-install-test-host`]);
    assert.deepEqual(fixture.state.deployKeys.map(entry => entry.key), [DEPLOY_PUBLIC_KEY]);
    assert.deepEqual(githubApiRequests(fixture), [], 'the install makes no GitHub API request of its own');
    assert.doesNotMatch(fixture.commandLines().join('\n'), /gh api |protection|hooks/);
    for (const file of fixture.transport.files.values()) assert.doesNotMatch(file.content, APP_VARIABLES);
    assert.equal((await readInstallRecord(directory))?.github, null);
    assert.doesNotMatch(summary.nextSteps.join('\n'), /--reviewer|--no-github-app|App-bound|webhook delivery/i);

    // A rerun keeps the key: it is listed already, so it is not added again.
    const again = await apply(fixture, args);
    assert.equal(again.plan.actions.find(action => action.id === 'github.deploy-key')!.state, 'update');
    assert.equal(deployKeyAdds(fixture).length, 1);
  } finally { await fixture.cleanup(); }
});

test('unit:install-deploy-key — the App-era install flags are unknown options', () => {
  for (const flag of [['--no-github-app'], ['--github-app', 'app.json'], ['--reuse-app', 'graphyard-owner-project'], ['--reviewer', 'codex']])
    assert.throws(() => installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', ...flag]), /Unknown option/, flag[0]);
});

test('unit:install-deploy-key — a host install generates its deploy key on the host and clones over SSH with it, with no App', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test' });
  try {
    const { plan, summary } = await apply(fixture, ['--target', 'host', '--repo', 'owner/project', '--ssh-host', '203.0.113.20', '--domain', 'graphyard.example.test', '--apply']);
    assert.deepEqual(plan.actions.filter(action => APP_ERA.test(action.id) || action.id === 'host.github').map(action => action.id), []);
    const key = '/home/graphyard/.config/graphyard/owner-project/owner-project/deploy-key';
    assert.equal(plan.actions.find(action => action.id === 'github.deploy-key')!.target, 'host');
    assert.ok(plan.host!.credentials.some(entry => entry.path === key && entry.mode === '0600'));
    assert.ok(!plan.host!.credentials.some(entry => /app-private-key|github\//.test(entry.path)));

    const host = [...fixture.remotes.values()][0];
    const lines = host.commands.map(command => [command.program, ...command.args].join(' '));
    // The key is generated on the host; only its public half reaches this machine, and gh registers that.
    assert.ok(lines.some(line => line.includes('ssh-keygen -q -t ed25519') && line.includes(key)), 'ssh-keygen runs on the host');
    assert.deepEqual(fixture.state.deployKeys.map(entry => [entry.key, entry.title]), [[HOST_DEPLOY_PUBLIC_KEY, 'graphyard-merge-writer-graphyard-host']]);
    assert.equal(deployKeyAdds(fixture).length, 1);
    const clone = lines.find(line => line.includes('managed-checkout'))!;
    assert.match(clone, /git@github\.com:owner\/project\.git/);
    assert.match(clone, new RegExp(`ssh -i ${key} -o IdentitiesOnly=yes`));
    assert.doesNotMatch(clone, /x-access-token|GIT_TOKEN/);
    const cloneCommand = host.commands.find(command => command.args.includes('managed-checkout'))!;
    assert.equal(cloneCommand.input, undefined, 'no token is piped to the clone');
    // No App credential, helper or gh wrapper is written to the host.
    assert.ok(![...fixture.hostFiles.keys()].some(path => /app-private-key|graphyard-github-credential|\/usr\/local\/bin\/gh$/.test(path)));
    for (const file of fixture.hostFiles.values()) assert.doesNotMatch(file.content, APP_VARIABLES);
    assert.equal(summary.deployKey, key);
    assert.deepEqual(githubApiRequests(fixture), []);
  } finally { await fixture.cleanup(); }
});
