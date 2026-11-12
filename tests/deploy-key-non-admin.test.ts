import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { installDirectory } from '../src/install/secrets.js';
import { DEPLOY_PUBLIC_KEY, harness, type Harness } from './install-harness.js';

// GY-3174: `gh repo deploy-key list` needs repository admin, so GitHub answers 403/404 to an operator
// with push access alone — the install stopped at the deploy-key step even after an admin registered
// the key. That answer now probes the key over ssh: the ref advertisement a write key receives
// (nothing is pushed) continues the install, a refusal stops naming the one admin command, and a
// successful list keeps the admin path exactly as before.

/** What GitHub answers a login without admin: gh's wording for the 404 (or 403) on the keys listing. */
const NOT_ADMIN = { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 };
const PROBE = "git-receive-pack 'owner/project.git'";

async function apply(fixture: Harness, args: string[]) {
  const { request } = installRequestFromArgs(args);
  const session = await prepareInstall(fixture.root, request, fixture.deps, 'apply');
  const plan = await buildPlan(session);
  return { session, plan, summary: await applyInstall(session, plan) };
}

test('unit:tests/deploy-key-non-admin.test.ts — a deploy-key list answered 404 with a key that already pushes continues the install', async () => {
  const fixture = await harness({
    provider: 'compose', serverUrl: 'http://127.0.0.1:4310',
    extraResponses: [
      { match: 'gh repo deploy-key list', result: NOT_ADMIN },
      { match: PROBE, result: '001e# service=git-receive-pack\n0000' },
    ],
  });
  try {
    const { summary } = await apply(fixture, ['--provider', 'compose', '--repo', 'owner/project', '--apply']);
    const directory = installDirectory('owner-project', fixture.configHome);
    assert.equal(summary.deployKey, join(directory, 'deploy-key'), 'the install finishes and hands the merge writer its key');
    const lines = fixture.commandLines();
    assert.deepEqual(lines.filter(line => line.includes(PROBE)), [`ssh -i ${join(directory, 'deploy-key')} -o IdentitiesOnly=yes -o BatchMode=yes git@github.com ${PROBE}`], 'the key alone is probed, read-write, and nothing is pushed');
    assert.deepEqual(lines.filter(line => line.startsWith('gh repo deploy-key add ')), [], 'a login that cannot list keys cannot add one');
    assert.ok(!lines.some(line => line.includes('gh api ') && line !== 'gh api orgs/owner'), 'the install itself runs no admin command (GY-3219 reads the org setting)');
  } finally { await fixture.cleanup(); }
});

test('unit:tests/deploy-key-non-admin.test.ts — a refused probe stops the install naming the admin command', async () => {
  const fixture = await harness({
    provider: 'compose', serverUrl: 'http://127.0.0.1:4310',
    extraResponses: [
      { match: 'gh repo deploy-key list', result: NOT_ADMIN },
      { match: PROBE, result: { stdout: '', stderr: 'This deploy key does not have write access to this repository.', code: 1 } },
    ],
  });
  try {
    const publicKeyFile = join(installDirectory('owner-project', fixture.configHome), 'deploy-key.pub');
    await assert.rejects(
      apply(fixture, ['--provider', 'compose', '--repo', 'owner/project', '--apply']),
      (error: Error) => error.message.includes(`gh api -X POST repos/owner/project/keys -f title=graphyard-merge-writer-install-test-host -f key="$(cat ${publicKeyFile})" -F read_only=false`),
      'the one message names the exact command an admin must run',
    );
    assert.deepEqual(fixture.commandLines().filter(line => line.startsWith('gh repo deploy-key add ')), []);
  } finally { await fixture.cleanup(); }
});

test('unit:tests/deploy-key-non-admin.test.ts — a login that can list keys keeps the admin path: no ssh probe, the key is added', async () => {
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310' });
  try {
    const { summary } = await apply(fixture, ['--provider', 'compose', '--repo', 'owner/project', '--apply']);
    assert.equal(summary.deployKey, join(installDirectory('owner-project', fixture.configHome), 'deploy-key'));
    const lines = fixture.commandLines();
    // The key's push probe; GY-3269's SAML preflight may still ask the fetch direction (git-upload-pack) without the key.
    assert.ok(!lines.some(line => line.startsWith('ssh ') && line.includes(PROBE)), 'a successful list probes nothing over ssh');
    assert.deepEqual(lines.filter(line => line.startsWith('gh repo deploy-key add ')), [`gh repo deploy-key add ${join(installDirectory('owner-project', fixture.configHome), 'deploy-key.pub')} -R owner/project --allow-write --title graphyard-merge-writer-install-test-host`]);
    assert.deepEqual(fixture.state.deployKeys.map(entry => entry.key), [DEPLOY_PUBLIC_KEY]);
  } finally { await fixture.cleanup(); }
});
