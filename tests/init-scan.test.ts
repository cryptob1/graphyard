import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { availableRuntimes, buildProposal, detectDeploy, detectStack, environmentTopology, hasSharedDatabase, workflowCheckNames } from '../src/onboarding.js';
import { applyProposal, loadAppliedSetup, loadProposal, proposalDigest, readSetupStatus, repositoryScanDifference, saveProposal, scanProposal, setupDrift } from '../src/repository-setup.js';
import { workerProfileSchema } from '../src/master.js';

const scan = (files: Record<string, string>) => ({ files: Object.keys(files), contents: files });

const nodeRailway = {
  'package.json': JSON.stringify({ name: 'orders-api', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', build: 'vite build' }, dependencies: { pg: '8.1.0' }, devDependencies: { vitest: '1.0.0' } }),
  'railway.json': JSON.stringify({ build: { builder: 'NIXPACKS' } }),
  'tests/api.test.ts': 'import { test } from "vitest";\ntest.todo("orders");\n',
};

const pythonContainers = {
  'pyproject.toml': '[project]\nname = "ml-service"\ndependencies = ["fastapi", "psycopg"]\n[tool.pytest.ini_options]\n',
  'Dockerfile': 'FROM python:3.12-slim\n',
  'compose.yaml': 'services:\n  db:\n    image: postgres:16\n',
  'tests/test_api.py': 'def test_ok():\n    assert True\n',
};

const staticPages = {
  'index.html': '<!doctype html><title>Site</title>',
  '.nojekyll': '',
  'CNAME': 'example.test',
  '.github/workflows/pages.yml': 'name: pages\non:\n  push:\n    branches: [main]\njobs:\n  build-and-deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
};

test('detectors classify stacks, deploy targets, CI checks, and candidate-bound topology', () => {
  const node = detectStack(scan(nodeRailway));
  assert.equal(node.name, 'node');
  assert.deepEqual(node.frameworks, ['vitest']);
  assert.deepEqual(node.testLayout, ['tests/']);
  const nodeDeploy = detectDeploy(scan(nodeRailway), node);
  assert.equal(nodeDeploy.target, 'railway');
  assert.match(nodeDeploy.verification, /RAILWAY_GIT_COMMIT_SHA/);
  const nodeProposal = buildProposal(scan(nodeRailway), { repository: 'owner/orders-api', runtimes: ['codex'] });
  assert.deepEqual(nodeProposal.checks, ['test', 'typecheck', 'build']);
  assert.deepEqual(nodeProposal.proofs.filter(proof => proof.command).map(proof => proof.name), ['integration:test', 'unit:typecheck']);
  assert.equal(nodeProposal.environment.topology, 'ephemeral');
  assert.match(nodeProposal.environment.declaration, /per-candidate/);

  const python = detectStack(scan(pythonContainers));
  assert.equal(python.name, 'python');
  assert.deepEqual(python.commands.map(command => command.check), ['pytest']);
  const pythonDeploy = detectDeploy(scan(pythonContainers), python);
  assert.equal(pythonDeploy.target, 'container-registry');
  assert.equal(hasSharedDatabase(scan(pythonContainers)).detected, true);
  const pythonPooled = environmentTopology(pythonDeploy, hasSharedDatabase(scan(pythonContainers)));
  assert.equal(pythonPooled.topology, 'pooled');
  assert.match(pythonPooled.declaration, /isolat/i);
  const pythonEphemeral = environmentTopology(pythonDeploy, { detected: false, evidence: [] });
  assert.equal(pythonEphemeral.topology, 'ephemeral');
  const pythonProposal = buildProposal(scan(pythonContainers), { repository: 'owner/ml-service', runtimes: [] });
  assert.deepEqual(pythonProposal.proofs.filter(proof => proof.command).map(proof => proof.name), ['integration:pytest']);

  const pages = detectStack(scan(staticPages));
  assert.equal(pages.name, 'static');
  const pagesDeploy = detectDeploy(scan(staticPages), pages);
  assert.equal(pagesDeploy.target, 'github-pages');
  assert.match(pagesDeploy.verification, /version\.json/);
  const pagesProposal = buildProposal(scan(staticPages), { repository: 'owner/site', runtimes: [] });
  assert.equal(pagesProposal.environment.topology, 'ephemeral');
  assert.deepEqual(pagesProposal.commands, []);
  assert.deepEqual(pagesProposal.checks, ['build-and-deploy']);
  assert.deepEqual(pagesProposal.proofs.map(proof => proof.name), ['manual:deployed-sha']);

  const input = scan({ 'Dockerfile': 'FROM node:24\n', 'docker-compose.yml': 'services:\n  db:\n    image: mysql:8\n', '.env.example': 'DATABASE_URL=postgres://user:secret@db.example.internal:5432/app\n' });
  assert.equal(detectDeploy(input, detectStack(input)).target, 'container-registry');
  assert.deepEqual(hasSharedDatabase(input).evidence.length >= 2, true);
  assert.equal(environmentTopology({ target: 'none', evidence: [], verification: '', proofName: 'manual:deployed-sha' }, { detected: false, evidence: [] }).topology, 'partial');
  assert.equal(detectStack(scan({ 'README.md': 'empty' })).name, 'unknown');
  const unknown = buildProposal(scan({ 'README.md': 'empty' }), { repository: null, runtimes: [] });
  assert.equal(unknown.repository, 'unknown');
  assert.equal(unknown.githubApp, null);
  assert.equal(unknown.ci.system, 'none');
});

test('CI check names honor job labels, pull-request scoping, and deploy-target precedence', () => {
  const workflows = scan({
    '.github/workflows/pr.yml': 'name: CI\non:\n  pull_request:\njobs:\n  build:\n    name: Build and Test\n    runs-on: ubuntu-latest\n  audit:\n    runs-on: ubuntu-latest\n',
    '.github/workflows/nightly.yml': 'name: Nightly\non:\n  schedule:\n    - cron: "0 3 * * *"\njobs:\n  nightly-job:\n    runs-on: ubuntu-latest\n',
  });
  assert.deepEqual(workflowCheckNames(workflows), ['Build and Test', 'audit', 'nightly-job']);
  assert.deepEqual(workflowCheckNames(workflows, { onlyPullRequest: true }), ['Build and Test', 'audit']);
  const withDocker = scan({ ...nodeRailway, 'Dockerfile': 'FROM node:24\n' });
  assert.equal(detectDeploy(withDocker, detectStack(withDocker)).target, 'railway');
  assert.equal(detectDeploy(scan({ 'fly.toml': '', 'Dockerfile': '' }), detectStack(scan({ 'index.html': '' }))).target, 'fly');
  assert.equal(detectDeploy(scan({ 'vercel.json': '{}' }), detectStack(scan({ 'index.html': '' }))).target, 'vercel');
  assert.equal(detectDeploy(scan({ 'index.html': '', 'Dockerfile': '' }), detectStack(scan({ 'index.html': '', 'Dockerfile': '' }))).target, 'container-registry');
});

test('runtime detection probes the machine PATH without executing anything', () => {
  assert.deepEqual(availableRuntimes('/tools:/usr/bin', candidate => candidate === '/tools/codex'), ['codex']);
  assert.deepEqual(availableRuntimes(undefined, () => false), []);
});

async function addFile(root: string, path: string, content: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function fixtureRepo(files: Record<string, string>, remote = 'git@github.com:owner/repo.git') {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-scan-'));
  execFileSync('git', ['init', '-q', root]);
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  for (const [path, content] of Object.entries(files)) await addFile(root, path, content);
  return root;
}

test('init --scan writes only an ignored proposal and covers every required area', async () => {
  const root = await fixtureRepo({ ...nodeRailway, '.github/workflows/ci.yml': 'on:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n' });
  try {
    const proposal = await scanProposal(root, { url: 'https://graphyard.example' });
    assert.equal(proposal.repository, 'owner/repo');
    assert.equal(proposal.server, 'https://graphyard.example');
    assert.equal(proposal.ci.system, 'github-actions');
    assert.ok(proposal.checks.includes('test') && proposal.checks.includes('typecheck'));
    assert.ok(proposal.proofs.some(proof => proof.name.startsWith('integration:')));
    assert.ok(proposal.proofs.some(proof => proof.name.startsWith('manual:')));
    assert.ok(proposal.deploy.verification.length > 20);
    assert.ok(['ephemeral', 'pooled', 'partial'].includes(proposal.environment.topology));
    assert.equal(proposal.policy.review, true);
    assert.equal(proposal.policy.reviewProvider, 'github');
    assert.ok(proposal.githubApp && proposal.githubApp.repository === 'owner/repo');
    const saved = await saveProposal(root, proposal);
    assert.equal((await stat(saved.file)).mode & 0o777, 0o600);
    assert.equal(execFileSync('git', ['check-ignore', '.graphyard/setup-proposal.json'], { cwd: root, encoding: 'utf8' }).trim(), '.graphyard/setup-proposal.json');
    assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /\.graphyard\/\n$/);
    await assert.rejects(stat(join(root, 'AGENTS.md')));
    await assert.rejects(stat(join(root, '.graphyard/connection.json')));
    await assert.rejects(stat(join(root, '.graphyard/principals.json')));
    await assert.rejects(stat(join(root, '.graphyard/profiles')));
    await assert.rejects(stat(join(root, '.graphyard/repository-setup.json')));
    const loaded = await loadProposal(root);
    assert.deepEqual(loaded!.proposal, proposal);
    assert.deepEqual(await loadAppliedSetup(root), null);
    assert.deepEqual(setupDrift(await loadAppliedSetup(root), proposal), []);
    const status = await readSetupStatus(root);
    assert.equal(status.proposal, '.graphyard/setup-proposal.json');
    assert.equal(status.appliedAt, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('applying a reviewed proposal performs the App flow, registers principals and grants, and is idempotent with drift reporting', async () => {
  const root = await fixtureRepo(nodeRailway);
  try {
    const proposal = await scanProposal(root, { url: 'https://graphyard.example', runtimes: ['codex'] });
    await saveProposal(root, proposal);
    let flows = 0, tokens = 0;
    const dependencies = {
      url: 'https://graphyard.example',
      githubSetup: async () => { flows++; return { appId: 1234, slug: 'graphyard-owner-repo' }; },
      token: () => `secret-${++tokens}-`.padEnd(40, 't'),
      now: () => new Date('2030-01-01T00:00:00Z'),
    };
    const first = await applyProposal(root, proposal, dependencies);
    assert.equal(flows, 1);
    assert.ok(first.applied.some(entry => /AGENTS.md/.test(entry)));
    assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /Graphyard coordination/);
    const principalsFile = join(root, '.graphyard/principals.json');
    assert.equal((await stat(principalsFile)).mode & 0o777, 0o600);
    const registry = JSON.parse(await readFile(principalsFile, 'utf8'));
    const byId = Object.fromEntries(registry.principals.map((entry: any) => [entry.id, entry]));
    assert.equal(byId.operator.role, 'admin');
    assert.equal(byId.master.role, 'coordinator');
    assert.equal(byId['worker-1'].role, 'worker');
    assert.equal(byId.evidence.role, 'producer');
    assert.deepEqual(byId.evidence.proofs, ['integration:test', 'unit:typecheck']);
    for (const entry of registry.principals) assert.ok(entry.token.length >= 32);
    const profile = JSON.parse(await readFile(join(root, '.graphyard/profiles/codex-primary.json'), 'utf8'));
    assert.equal(workerProfileSchema.parse(profile).principal, 'worker-1');
    assert.equal(JSON.parse(await readFile(join(root, '.graphyard/profiles/reviewer.json'), 'utf8')).provider, 'github');
    const applied = await loadAppliedSetup(root);
    assert.equal(applied!.proposalDigest, proposalDigest(proposal));
    assert.deepEqual(applied!.artifacts.githubApp, { appId: 1234, slug: 'graphyard-owner-repo' });
    assert.deepEqual(applied!.artifacts.profiles, ['codex-primary', 'reviewer']);

    const second = await applyProposal(root, proposal, dependencies);
    assert.equal(flows, 1);
    assert.equal(second.applied.length, 0);
    assert.ok(second.unchanged.includes('AGENTS.md coordination section'));
    assert.ok(second.unchanged.includes('principal and grant registry'));
    assert.deepEqual(JSON.parse(await readFile(principalsFile, 'utf8')), registry);

    const tampered = { ...profile, agentArgs: ['--operator-tuned'] };
    await writeFile(join(root, '.graphyard/profiles/codex-primary.json'), JSON.stringify(tampered, null, 2), { mode: 0o600 });
    const third = await applyProposal(root, proposal, dependencies);
    assert.ok(third.drift.some(entry => /codex-primary/.test(entry)));
    assert.deepEqual(JSON.parse(await readFile(join(root, '.graphyard/profiles/codex-primary.json'), 'utf8')).agentArgs, ['--operator-tuned']);

    await addFile(root, '.github/workflows/audit.yml', 'on:\n  pull_request:\njobs:\n  audit:\n    runs-on: ubuntu-latest\n');
    const rescan = await scanProposal(root, { url: 'https://graphyard.example', runtimes: ['codex'] });
    assert.deepEqual(repositoryScanDifference(rescan, proposal), ['The repository scan no longer matches the stored proposal']);
    assert.equal(setupDrift(applied, rescan).length, 1);
    assert.deepEqual(repositoryScanDifference(await scanProposal(root, { url: 'https://graphyard.example', runtimes: ['codex', 'claude'] }), rescan), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('apply registers only the worker principals the reviewed proposal declares', async () => {
  const root = await fixtureRepo(nodeRailway);
  try {
    // No agent runtime on the machine means no reviewed worker profile, so apply
    // must not mint an unreviewed worker credential of its own.
    const proposal = await scanProposal(root, { url: 'https://graphyard.example', runtimes: [] });
    assert.deepEqual(proposal.profiles.workers, []);
    await saveProposal(root, proposal);
    let tokens = 0;
    const result = await applyProposal(root, proposal, { url: 'https://graphyard.example',
      githubSetup: async () => ({ appId: 1234, slug: 'graphyard-owner-repo' }),
      token: () => `secret-${++tokens}-`.padEnd(40, 't'), now: () => new Date('2030-01-01T00:00:00Z') });
    const registry = JSON.parse(await readFile(join(root, '.graphyard/principals.json'), 'utf8'));
    assert.deepEqual(registry.principals.map((entry: any) => entry.id), ['operator', 'master', 'evidence']);
    assert.deepEqual(registry.principals.filter((entry: any) => entry.role === 'worker'), []);
    assert.deepEqual(result.workerPrincipals, []);
    assert.match(result.next, /no agent runtime was detected/);
    assert.deepEqual((await loadAppliedSetup(root))!.artifacts.profiles, ['reviewer']);

    // Declaring a runtime later adds exactly that principal and keeps existing secrets.
    const withRuntime = await scanProposal(root, { url: 'https://graphyard.example', runtimes: ['codex'] });
    await saveProposal(root, withRuntime);
    const second = await applyProposal(root, withRuntime, { url: 'https://graphyard.example',
      githubSetup: async () => ({ appId: 1234, slug: 'graphyard-owner-repo' }),
      token: () => `secret-${++tokens}-`.padEnd(40, 't'), now: () => new Date('2030-01-01T00:00:00Z') });
    assert.deepEqual(second.workerPrincipals, ['worker-1']);
    const grown = JSON.parse(await readFile(join(root, '.graphyard/principals.json'), 'utf8'));
    assert.deepEqual(grown.principals.map((entry: any) => entry.id), ['operator', 'master', 'worker-1', 'evidence']);
    for (const id of ['operator', 'master', 'evidence'])
      assert.equal(grown.principals.find((entry: any) => entry.id === id).token,
        registry.principals.find((entry: any) => entry.id === id).token);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scan chooses and documents topology for three distinct stack fixtures', async () => {
  const cases = [
    { files: nodeRailway, repository: 'owner/orders-api', stack: 'node', target: 'railway', topology: 'ephemeral' },
    { files: pythonContainers, repository: 'owner/ml-service', stack: 'python', target: 'container-registry', topology: 'pooled' },
    { files: staticPages, repository: 'owner/site', stack: 'static', target: 'github-pages', topology: 'ephemeral' },
  ];
  const documented: string[] = [];
  for (const expected of cases) {
    const root = await fixtureRepo(expected.files, `git@github.com:${expected.repository}.git`);
    try {
      const proposal = await scanProposal(root, { runtimes: [] });
      assert.equal(proposal.stack.name, expected.stack, expected.repository);
      assert.equal(proposal.deploy.target, expected.target, expected.repository);
      assert.equal(proposal.environment.topology, expected.topology, expected.repository);
      assert.ok(proposal.environment.declaration.length > 40, expected.repository);
      documented.push(`${expected.repository}: ${expected.stack} -> ${expected.target} -> ${proposal.environment.topology}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  assert.equal(documented.length, 3);
  assert.match(documented.join('\n'), /node -> railway -> ephemeral/);
  assert.match(documented.join('\n'), /python -> container-registry -> pooled/);
  assert.match(documented.join('\n'), /static -> github-pages -> ephemeral/);
});

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  return promisify(execFile)(process.execPath, [join(import.meta.dirname, '../bin/graphyard.mjs'), ...args], { cwd, env })
    .then(result => result.stdout, error => { throw new Error(String((error as any).stderr || error.message)); });
}

test('CLI init --scan applies nothing without approval and --apply enforces the reviewed proposal', async () => {
  const root = await fixtureRepo(nodeRailway);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GRAPHYARD_')) delete env[key];
  try {
    await assert.rejects(runCli(root, ['init', '--scan', '--apply', '--url', 'https://graphyard.example'], env), /No stored setup proposal/);
    const scanned = JSON.parse(await runCli(root, ['init', '--scan'], env));
    assert.equal(scanned.appliedNothingElse, true);
    assert.equal(scanned.proposal.stack.name, 'node');
    assert.deepEqual(scanned.proposal.profiles.workers.map((worker: any) => worker.kind), availableRuntimes(process.env.PATH).slice(0, 2));
    await assert.rejects(stat(join(root, 'AGENTS.md')));
    await assert.rejects(stat(join(root, '.graphyard/principals.json')));
    await assert.rejects(stat(join(root, '.graphyard/repository-setup.json')));
    const stored = await readFile(join(root, '.graphyard/setup-proposal.json'), 'utf8');

    await addFile(root, '.github/workflows/notify.yml', 'on:\n  pull_request:\njobs:\n  notify:\n    runs-on: ubuntu-latest\n');
    await assert.rejects(runCli(root, ['init', '--scan', '--apply', '--url', 'https://graphyard.example'], env), /no longer matches/);
    assert.equal(await readFile(join(root, '.graphyard/setup-proposal.json'), 'utf8'), stored);

    await runCli(root, ['init', '--scan'], env);
    const refreshed = JSON.parse(await readFile(join(root, '.graphyard/setup-proposal.json'), 'utf8'));
    assert.ok(refreshed.ci.jobs.includes('notify'));

    await writeFile(join(root, '.graphyard/github-app.json'), JSON.stringify({ appId: 99, slug: 'graphyard-owner-repo', repository: 'owner/repo', privateKey: 'test-only', webhookSecret: 'test-only', installationId: 7 }), { mode: 0o600 });
    const applied = JSON.parse(await runCli(root, ['init', '--scan', '--apply', '--url', 'https://graphyard.example'], env));
    assert.deepEqual(applied.githubApp, { appId: 99, slug: 'graphyard-owner-repo' });
    assert.equal(applied.githubPending, false);
    assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /Graphyard coordination/);
    const appliedProposal = JSON.parse(await readFile(join(root, '.graphyard/setup-proposal.json'), 'utf8'));
    const registry = JSON.parse(await readFile(join(root, '.graphyard/principals.json'), 'utf8'));
    // operator, master, the evidence producer, the CI producer, and one worker per reviewed profile.
    assert.equal(registry.principals.length, 4 + new Set(appliedProposal.profiles.workers.map((worker: any) => worker.principal)).size);
    assert.deepEqual(registry.principals.at(-1), { ...registry.principals.at(-1), id: "ci-proofs", role: "producer", runtime: "github-actions", proofs: ["unit:*", "integration:*"] });
    assert.deepEqual(applied.ciProofs.grants, ["unit:*", "integration:*"]); assert.ok(applied.ciProofs.next.some((step: string) => step.includes("GRAPHYARD_CI_PRODUCER_TOKEN")));
    for (const principal of registry.principals) assert.doesNotMatch(principal.token, /test-only/);

    await addFile(root, 'compose.yaml', 'services:\n  db:\n    image: postgres:16\n');
    const afterChange = JSON.parse(await runCli(root, ['init', '--scan'], env));
    assert.equal(afterChange.drift.length, 1);
    assert.match(afterChange.drift[0], /changed after setup was applied/);
    const status = JSON.parse(await runCli(root, ['doctor'], env));
    assert.equal(status.setup.githubApp.appId, 99);
    assert.equal(status.setup.drift.length, 1);
    // The readiness checklist is part of doctor: with no server it cannot be ready, every
    // item states what was observed and the direct recovery, and drift is a missing item.
    assert.equal(status.readiness.profile, 'through-merge'); assert.equal(status.readiness.ready, false);
    const byId = Object.fromEntries(status.readiness.items.map((item: any) => [item.id, item]));
    assert.equal(byId.server.status, 'missing'); assert.match(byId.server.recovery, /GRAPHYARD_TOKEN/);
    assert.equal(byId['setup-proposal'].status, 'missing'); assert.match(byId['setup-proposal'].detail, /drift/);
    assert.equal(byId['test-formats'].status, 'ready'); assert.match(byId['test-formats'].detail, /vitest → junit-xml-v1/);
    assert.equal(byId['github-app'].status, 'unknown'); assert.match(byId['github-app'].recovery, /GITHUB_APP_ID/);
    assert.ok(status.readiness.items.every((item: any) => item.status === 'ready' || typeof item.recovery === 'string'));
    assert.equal(status.next, status.readiness.next);
    const preview = JSON.parse(await runCli(root, ['doctor', '--profile', 'preview-validation'], env));
    assert.ok(preview.readiness.items.some((item: any) => item.id === 'runner-registration' && item.status === 'unknown'));
    assert.equal(preview.readiness.items.find((item: any) => item.id === 'e2e-suite').status, 'missing');
    await assert.rejects(runCli(root, ['doctor', '--profile', 'done'], env), /Unknown completion profile/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
