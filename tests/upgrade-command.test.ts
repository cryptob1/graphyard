import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { healthVerdict, renderPlan, resolveTarget, runUpgrade, schemaAt, upgradePlan, type UpgradeInputs, type UpgradeStep } from '../src/cli/upgrade.js';
import { installRequestFromArgs, redeployArguments } from '../src/install/index.js';
import type { InstallRecord } from '../src/install/secrets.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1962: `graphyard upgrade` moves CLI, server, loop and managed files to one release, in order.
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
const order = ['checkout', 'npm-ci', 'backup', 'redeploy', 'restart', 'refresh', 'health'];
const releaseSource = (generations: string[]) => `export const schemaGenerations: readonly (string | null)[] = [\n  ${generations.join(', ')},\n];\n`;
type Entry = InstallRecord['principals'][number];
const principal = (id: string, role: Entry['role'], extra: Partial<Entry> = {}): Entry => ({ id: `acme-app-${id}`, role, fingerprint: 'f'.repeat(12), ...extra });
const record = { installId: 'acme-app', repository: 'acme/app', provider: 'railway', selfContained: false, baseBranch: 'main', service: 'graphyard', domain: null, deployment: null,
  reviewPolicy: 'github', noGithubApp: false, principals: [principal('operator', 'admin'), principal('master', 'coordinator'), principal('worker-1', 'worker'), principal('dashboard', 'reader')] } as unknown as InstallRecord;

function inputs(overrides: Partial<UpgradeInputs> = {}): UpgradeInputs {
  return { cliRoot: '/opt/graphyard', repoRoot: '/work/app', current: { version: '2026.10.16', revision: 'a'.repeat(40), released: true },
    target: { version: '2026.10.17', revision: 'b'.repeat(40), schema: 4 }, databaseSchema: 4, install: record, url: 'https://gy.example',
    backupFile: '/home/op/.config/graphyard/acme-app/backups/before-2026.10.17.json', ...overrides };
}

test('unit:upgrade-command-plan — the plan lists the ordered steps without acting, and refuses a target older than the database\'s schema', async () => {
  const plan = upgradePlan(inputs());
  assert.deepEqual(plan.steps.map(step => step.id), order);
  assert.match(plan.steps[0].command, /git -C "\/opt\/graphyard" checkout --detach b{40}/);
  assert.match(plan.steps[1].command, /^npm ci/);
  assert.match(plan.steps[3].command, /install --repo acme\/app --provider railway --base-branch main --server-name graphyard --review-policy github --workers 1 --image ghcr\.io\/cryptob1\/graphyard:2026\.10\.17 --plan && .*install --repo acme\/app .* --image ghcr\.io\/cryptob1\/graphyard:2026\.10\.17 --apply$/, 'the install preview runs before the apply');
  assert.match(plan.steps[4].command, /master restart.*master executors restart --all/);
  assert.match(plan.steps[5].command, /init --scan --url https:\/\/gy\.example && .*init --scan --apply --url https:\/\/gy\.example$/, 'the scan refreshes the stored proposal before it is applied');
  assert.equal(plan.rollback, 'graphyard upgrade --to 2026.10.16');
  assert.match(renderPlan(plan), /^upgrade 2026\.10\.16 -> 2026\.10\.17/);
  assert.match(upgradePlan(inputs({ current: { version: 'unreleased aaaaaaaaaaaa', revision: 'a'.repeat(40), released: false } })).rollback, /checkout --detach a{40}/, 'an unreleased previous rolls back by commit');
  assert.deepEqual(redeployArguments({ ...record, provider: 'host', selfContained: true, deployment: { sshHost: 'h', sshUser: 'root', local: false, port: null, image: null } }, 'img').slice(0, 4), ['--repo', 'acme/app', '--target', 'host']);
  // The redeploy is a full apply, so it replans exactly the recorded roster and mode: extra workers and the CI producer's grants stay
  // authorized, a principal added by graphyard principal add is reconciled in by install itself, and nothing reverts to defaults.
  const fleet = redeployArguments({ ...record, reviewPolicy: 'agent', noGithubApp: true, principals: [...record.principals, principal('worker-2', 'worker'), principal('worker-3', 'worker'),
    principal('ci', 'producer', { proofs: ['e2e:checkout', 'unit:pay'] }), principal('observer', 'producer', { grants: ['delivery:observe-sha'], source: 'principal' })] }, 'img');
  assert.deepEqual(fleet.slice(fleet.indexOf('--review-policy'), fleet.indexOf('--image')), ['--review-policy', 'agent', '--workers', '3', '--producer-proof', 'e2e:checkout', '--producer-proof', 'unit:pay', '--no-github-app']);
  assert.deepEqual((({ workers, producerProofs, reviewPolicy, noGithubApp }) => ({ workers, producerProofs, reviewPolicy, noGithubApp }))(installRequestFromArgs(fleet).request), { workers: 3, producerProofs: ['e2e:checkout', 'unit:pay'], reviewPolicy: 'agent', noGithubApp: true }, 'install parses the recorded choices back');
  const observed = redeployArguments({ ...record, noGithubApp: true, principals: record.principals.filter(entry => entry.role !== 'worker') }, 'img');
  assert.ok(observed.includes('--observe-only') && !observed.includes('--workers'), 'an installation with no installer worker redeploys observation-only');
  assert.equal(installRequestFromArgs(observed).request.observeOnly, true);

  assert.throws(() => upgradePlan(inputs({ target: { version: '2026.10.1', revision: 'c'.repeat(40), schema: 3 } })), /Refusing 2026\.10\.1: its schema generation 3 is older than the database's \(4\)/);
  assert.equal(plan.rollforward, null, 'a target at the database generation migrates nothing');
  const migrating = upgradePlan(inputs({ target: { version: '2026.10.18', revision: 'd'.repeat(40), schema: 5 } }));
  assert.match(migrating.rollforward ?? '', /migrates the database from generation 4 to 5 .* rerun graphyard upgrade --to 2026\.10\.18, or restore .*before-2026\.10\.17\.json with graphyard db restore/, 'a newer generation migrates forward');
  assert.match(renderPlan(migrating), /from the redeploy on: /);

  // The target and its generation come from the CLI checkout's tags and that revision's release.ts, read without moving HEAD.
  const cli = await temporaryDirectory('upgrade-command');
  git(cli, 'init', '--quiet'); await mkdir(join(cli, 'src'));
  await writeFile(join(cli, 'src/release.ts'), 'export const schemaVersion = 3;\n'); git(cli, 'add', '.'); git(cli, 'commit', '--quiet', '-m', 'old'); git(cli, 'tag', '2026.9.1');
  await writeFile(join(cli, 'src/release.ts'), releaseSource(['null', 'null', 'null', 'null', "'sha256:59c9'"])); git(cli, 'commit', '--quiet', '-am', 'new');
  git(cli, 'tag', '2026.10.17'); git(cli, 'tag', '2026.10.17.1'); git(cli, 'tag', 'stable');
  const head = git(cli, 'rev-parse', 'HEAD'); git(cli, 'checkout', '--quiet', '--detach', '2026.9.1');
  assert.deepEqual(resolveTarget(cli, 'stable'), { version: '2026.10.17.1', revision: head, schema: 4 });
  const old = resolveTarget(cli, '2026.9.1');
  assert.equal(old.schema, 3);
  assert.throws(() => upgradePlan(inputs({ target: old })), /older than the database's \(4\)/);
  assert.equal(git(cli, 'rev-parse', 'HEAD'), old.revision, 'planning never moves the checkout');
  assert.throws(() => resolveTarget(cli, 'latest'), /dated release/);
  assert.equal(schemaAt('nothing here'), null);
});

test('unit:upgrade-command-run — steps run in order, the previous release is recorded first, npm ci follows every checkout, and a failure stops naming the step and rollback', async () => {
  const calls: string[] = [];
  const effects = (failAt?: string) => ({
    async record(entry: { previous: { version: string }; rollback: string }) { calls.push(`record ${entry.previous.version} ${entry.rollback}`); },
    async run(step: UpgradeStep) { calls.push(step.id); if (step.id === failAt) throw new Error(`${step.id} broke`); },
  });
  const plan = upgradePlan(inputs());
  assert.deepEqual(await runUpgrade(plan, effects()), { ok: true, steps: order });
  assert.deepEqual(calls, ['record 2026.10.16 graphyard upgrade --to 2026.10.16', ...order], 'the record precedes every change');
  calls.forEach((call, index) => { if (call === 'checkout') assert.equal(calls[index + 1], 'npm-ci', 'npm ci runs right after each checkout move'); });

  calls.length = 0;
  const stopped = await runUpgrade(plan, effects('redeploy'));
  assert.deepEqual(stopped, { ok: false, steps: ['checkout', 'npm-ci', 'backup'], failed: 'redeploy', error: 'redeploy broke', rollback: 'graphyard upgrade --to 2026.10.16' });
  assert.deepEqual(calls.slice(1), ['checkout', 'npm-ci', 'backup', 'redeploy'], 'nothing runs after the failing step');

  // Once a migrating redeploy has run, the previous release refuses the database, so the failure names the roll forward instead.
  const migrating = upgradePlan(inputs({ target: { version: '2026.10.18', revision: 'd'.repeat(40), schema: 5 } }));
  const early = await runUpgrade(migrating, effects('backup'));
  assert.equal(!early.ok && early.rollback, 'graphyard upgrade --to 2026.10.16', 'before the redeploy nothing migrated');
  for (const failAt of ['redeploy', 'health']) {
    const late = await runUpgrade(migrating, effects(failAt));
    assert.equal(!late.ok && late.rollback, migrating.rollforward, `${failAt} fails after the migration`);
  }

  // The health step passes only on a successful, healthy answer at the target version.
  const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body });
  await healthVerdict(answer(200, { ok: true, healthy: true, version: '2026.10.17' }), '2026.10.17');
  await assert.rejects(healthVerdict(answer(200, { ok: false, healthy: false, version: '2026.10.17', causes: ['database refuses writes'] }), '2026.10.17'), /unhealthy: database refuses writes/);
  await assert.rejects(healthVerdict(answer(503, { ok: false, healthy: false, version: '2026.10.17' }), '2026.10.17'), /HTTP 503/);
  await assert.rejects(healthVerdict(answer(200, { ok: true, healthy: true, version: '2026.10.16' }), '2026.10.17'), /reports 2026\.10\.16, not 2026\.10\.17/);

  calls.length = 0;
  await assert.rejects(runUpgrade(upgradePlan(inputs({ databaseSchema: null })), effects()), /schema generation could not be read/);
  assert.deepEqual(calls, [], 'an unreadable database generation changes nothing, not even the record');
});
