/**
 * GY-2009: install and CI use nothing from GitHub — no App, no branch protection or rulesets,
 * no Actions gates; the merge writer deploy key is the only access.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { applyProposal } from '../src/repository-setup.js';
import { gitleaksIgnorePath, gitleaksSha256, runSecretScan, secretScanArgv, secretScanCacheDirectory, type SecretScanInput } from '../src/merge-writer/secret-scan.js';
import { runTrialAttempt, TrialRunnerError } from '../src/merge-writer/trial.js';
import { refuseUpAppReuse, upUsageWithoutAppReuse } from '../src/cli/install.js';
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

  const argv = secretScanArgv('/tmp/checkout', 'gitleaks', true);
  assert.ok(argv.includes('--redact'));
  assert.ok(argv.includes('--log-opts=HEAD'));
  assert.ok(argv.includes('--gitleaks-ignore-path'));
  assert.ok(argv.some(arg => arg.endsWith(gitleaksIgnorePath)));
});

const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
/** A one-commit repository with no package.json, so a trial past the scan builds and tests nothing. */
async function scanRepository() {
  const root = await temporaryDirectory('scan-repo', tmpdir());
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
  git('init', '-q');
  await writeFile(join(root, 'README.md'), 'scan me\n');
  git('add', '-A'); git('commit', '-qm', 'one');
  return { root, sha: git('rev-parse', 'HEAD'), base: await temporaryDirectory('scan-base', tmpdir()) };
}

test('unit:github-gates-removed — the merge writer\'s trial runs the secret scan on its checkout: findings fail the trial as secret-scan, an unobtainable binary is no verdict', async () => {
  const repo = await scanRepository();
  const calls: (SecretScanInput & { head: string })[] = [];
  const trial = (secretScan: (input: SecretScanInput) => Promise<{ ok: true } | { ok: false; detail: string; unavailable?: true }>) =>
    runTrialAttempt({ root: repo.root, base: repo.base, mergeSha: repo.sha, changedFiles: ['README.md'], timeoutMs: 60_000, key: 'GY-2009', environment: { PATH: process.env.PATH! },
      secretScan: async input => { calls.push({ ...input, head: execFileSync('git', ['-C', input.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }); return secretScan(input); } });

  const passed = await trial(async () => ({ ok: true }));
  assert.equal(passed.build, 'pass', passed.logTail);
  assert.equal(calls.length, 1, 'the trial ran the scan');
  assert.equal(calls[0]!.head, repo.sha, 'on the trial checkout of the merge');
  assert.ok(!existsSync(calls[0]!.worktree), 'which the trial removes afterwards');
  assert.ok(!calls[0]!.cacheDirectory.startsWith(calls[0]!.worktree));
  assert.equal(calls[0]!.cacheDirectory, secretScanCacheDirectory(repo.base), 'caching the binary under the managed root, not the trial\'s temporary directory');

  const leaked = await trial(async () => ({ ok: false, detail: 'leaks found: 1' }));
  assert.equal(leaked.build, 'fail');
  assert.deepEqual(leaked.tests, { passed: 0, failed: ['secret-scan'], files: 0 });
  assert.match(leaked.logTail, /leaks found: 1/);

  await assert.rejects(trial(async () => ({ ok: false, unavailable: true, detail: 'secret scan unavailable: gitleaks download failed (503)' })),
    (error: unknown) => error instanceof TrialRunnerError && error.phase === 'install' && /gitleaks download failed \(503\)/.test(error.outputTail));
});

test('unit:github-gates-removed — the pinned gitleaks binary is downloaded once and reused by later scans; a failed download or another platform is unavailable, never thrown', async () => {
  const worktree = await temporaryDirectory('scan-worktree', tmpdir());
  const cacheDirectory = secretScanCacheDirectory(await temporaryDirectory('scan-cache', tmpdir()));
  const ran: string[][] = [];
  const run = (async (command: string, args: string[]) => {
    ran.push([command, ...args]);
    // The stand-in tar writes the binary where -C names.
    if (command === 'tar') await writeFile(join(args[args.indexOf('-C') + 1]!, 'gitleaks'), '#!/bin/sh\nexit 0\n');
    return '';
  }) as unknown as SecretScanInput['run'];
  const archive = Buffer.from('pinned archive');
  let downloads = 0;
  const pinned = { worktree, cacheDirectory, run, platform: 'linux', arch: 'x64', download: async () => { downloads++; return archive; } };
  // An archive whose digest is not the pin is unavailable and caches nothing.
  const mismatch = await runSecretScan(pinned);
  assert.ok(!mismatch.ok && mismatch.unavailable && new RegExp(`does not match ${gitleaksSha256}`).test(mismatch.detail), JSON.stringify(mismatch));
  assert.ok(!existsSync(join(cacheDirectory, 'gitleaks')));
  assert.equal(downloads, 1);

  // The first scan with a matching archive downloads and caches it; the second downloads nothing.
  downloads = 0;
  const matching = { ...pinned, sha256: createHash('sha256').update(archive).digest('hex') };
  for (let scan = 0; scan < 2; scan++) assert.deepEqual(await runSecretScan(matching), { ok: true });
  assert.equal(downloads, 1, 'a cached binary is never downloaded again');
  assert.ok(existsSync(join(cacheDirectory, 'gitleaks')));
  assert.equal(ran.filter(argv => argv[0] === 'tar').length, 1);
  assert.equal(ran.filter(argv => argv[0] === join(cacheDirectory, 'gitleaks')).length, 2);
  assert.deepEqual(ran.at(-1), secretScanArgv(worktree, join(cacheDirectory, 'gitleaks')));

  const offline = await runSecretScan({ ...pinned, cacheDirectory: join(cacheDirectory, 'empty'), download: async () => { throw new Error('gitleaks download failed (503)'); } });
  assert.ok(!offline.ok && offline.unavailable && /503/.test(offline.detail));
  const arm = await runSecretScan({ ...pinned, cacheDirectory: join(cacheDirectory, 'arm'), arch: 'arm64' });
  assert.ok(!arm.ok && arm.unavailable && /linux x64 only; this host is linux arm64/.test(arm.detail));
});

test('unit:install-no-github-gates — up refuses --reuse-app and its help no longer offers it', () => {
  assert.throws(() => refuseUpAppReuse(['--repo', 'owner/project', '--reuse-app', 'slug']), /--reuse-app is refused.*GY-2009/);
  assert.throws(() => refuseUpAppReuse(['--reuse-app=slug']), /GY-2009/);
  refuseUpAppReuse(['--repo', 'owner/project']);
  assert.ok(!/--reuse-app/.test(upUsageWithoutAppReuse), upUsageWithoutAppReuse);
});
