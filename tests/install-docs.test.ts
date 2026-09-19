import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const repository = fileURLToPath(new URL('..', import.meta.url));
const checker = resolve(repository, 'scripts/check-docs.mjs');
const run = (cwd: string) => spawnSync('node', [checker], { cwd, encoding: 'utf8' });

async function documentationCopy() {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-docs-'));
  await cp(resolve(repository, 'docs'), join(directory, 'docs'), { recursive: true });
  await cp(resolve(repository, 'README.md'), join(directory, 'README.md'));
  await cp(resolve(repository, 'examples'), join(directory, 'examples'), { recursive: true });
  await cp(resolve(repository, 'AGENTS.md'), join(directory, 'AGENTS.md'));
  // The install rules bind any repository that ships the installer.
  await cp(resolve(repository, 'src/install'), join(directory, 'src/install'), { recursive: true });
  return directory;
}

test('the shipped documentation passes the install docs check', () => {
  const result = run(repository);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /the one-command install path leads every setup guide/);
});

test('docs/install.md is an agent-executable runbook with commands, verification, and failure handling', async () => {
  const runbook = await readFile(resolve(repository, 'docs/install.md'), 'utf8');
  // The instruction the runbook promises an agent can execute.
  assert.match(runbook, /install Graphyard for OWNER\/REPO on PROVIDER following docs\/install\.md/);
  assert.match(runbook, /## Preconditions/);
  assert.match(runbook, /## Hard rules/);
  assert.match(runbook, /## Failure handling/);
  assert.match(runbook, /## Agent execution contract/);
  assert.match(runbook, /## Manual fallback/);

  // Every step names its command and how to verify it.
  const steps = [...runbook.matchAll(/^## (Step \d[^\n]*)\n([\s\S]*?)(?=^## )/gm)];
  assert.ok(steps.length >= 5, `expected numbered steps, found ${steps.length}`);
  assert.ok(steps.some(step => step[2].includes('install --provider PROVIDER --repo OWNER/REPO --plan')));
  assert.ok(steps.some(step => step[2].includes('install --provider PROVIDER --repo OWNER/REPO --apply')));
  assert.ok(steps.filter(step => /Verify|Expected output|Verification/.test(step[2])).length >= 3, 'each step must state what to verify');

  // The four human inputs, and the secret rules, are stated explicitly.
  for (const rule of ['Never print, echo, `cat`, log, paste, or commit a credential', 'One principal per role', 'Workers never receive an admin, coordinator, or producer credential', 'Proof producers get explicit grants only', '`0700`', '`0600`']) {
    assert.ok(runbook.includes(rule), `the runbook must state: ${rule}`);
  }
  assert.match(runbook, /Which provider/);
  assert.match(runbook, /Provider login/);
  assert.match(runbook, /GitHub App confirmation click/);
  assert.match(runbook, /Approval of the printed plan/);
  assert.match(runbook, /Never invent a fifth/);

  // Failure handling is a symptom-to-action table, not prose.
  const failures = runbook.slice(runbook.indexOf('## Failure handling'));
  assert.ok((failures.match(/^\| `/gm) ?? []).length >= 8, 'the failure table must cover the real refusals');
  for (const symptom of ['Preflight is incomplete', 'did not become healthy', 'Branch protection could not be applied', 'inside the managed repository']) {
    assert.ok(failures.includes(symptom), `failure handling must cover "${symptom}"`);
  }
});

test('the check fails when a guide leads with a manual provisioning step', async () => {
  const directory = await documentationCopy();
  try {
    const onboarding = join(directory, 'docs/onboarding.md');
    const content = await readFile(onboarding, 'utf8');
    await writeFile(onboarding, content.replace('## 1. Install the control plane', '## 1. Install the control plane\n\nFirst run `railway init --name graphyard`.\n'));
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/onboarding\.md: "railway init" precedes the one-command install path/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the check fails when a manual step escapes the labelled fallback', async () => {
  const directory = await documentationCopy();
  try {
    const deployment = join(directory, 'docs/deployment.md');
    const content = await readFile(deployment, 'utf8');
    await writeFile(deployment, content.replace('## The one command', '## The one command\n\n```sh\nrailway add --database postgres\n```\n'));
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"railway add" appears outside the labelled manual fallback/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the check fails when a guide stops naming the one-command path first', async () => {
  const directory = await documentationCopy();
  try {
    const readme = join(directory, 'README.md');
    const content = await readFile(readme, 'utf8');
    await writeFile(readme, content.replace('[Install](docs/install.md) · ', ''));
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the first setup link is docs\/how|README\.md: the first setup link is docs\/onboarding\.md/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the check fails when the runbook loses a required section or the variables table disappears', async () => {
  const directory = await documentationCopy();
  try {
    const runbook = join(directory, 'docs/install.md');
    const content = await readFile(runbook, 'utf8');
    await writeFile(runbook, content.replace('## Failure handling', '## Troubles'));
    let result = run(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no section covering failure handling/);

    await writeFile(runbook, content);
    const deployment = join(directory, 'docs/deployment.md');
    const reference = await readFile(deployment, 'utf8');
    await writeFile(deployment, reference.replace(/^\| `GRAPHYARD_PRINCIPALS` \|.*$/m, ''));
    result = run(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the variables table must document GRAPHYARD_PRINCIPALS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the check fails when the runbook itself is missing', async () => {
  const directory = await documentationCopy();
  try {
    await rm(join(directory, 'docs/install.md'));
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/install\.md: the primary install runbook is missing/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the install rules bind only a repository that ships the installer', async () => {
  const directory = await documentationCopy();
  try {
    const onboarding = join(directory, 'docs/onboarding.md');
    const content = await readFile(onboarding, 'utf8');
    await writeFile(onboarding, content.replace('## 1. Install the control plane', '## 1. Install the control plane\n\nFirst run `railway init --name graphyard`.\n'));
    assert.match(run(directory).stderr, /"railway init" precedes the one-command install path/);
    await rm(join(directory, 'src/install'), { recursive: true });
    // The copy omits unrelated link targets, so only the install rules are asserted absent.
    assert.doesNotMatch(run(directory).stderr, /one-command install path|install runbook|manual fallback/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
