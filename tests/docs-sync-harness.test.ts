import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { claudeRuleProblem, harnessDecision } from '../src/harness.js';
import { sessionHarnessPlan } from '../src/master/harness.js';
import { docsSyncPrompt, type DocsSyncPlan } from '../src/docs-sync.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1433: a docs-sync session loads its own role harness, never the master's project settings.
// The new exports are imported inside each test, so on a base without them the file still loads
// and each proof fails as a test case.

const cliPath = '/srv/graphyard/bin/graphyard.mjs';
const cli = `node ${cliPath}`;
const plan: DocsSyncPlan = { key: 'GY-1433', pr: 909, branch: 'graphyard/gy-1433-1', baseBranch: 'main', head: 'a1b2c3d4'.padEnd(40, 'e'), base: 'f0e1d2c3'.padEnd(40, 'a'), paths: ['docs/development.md'] };
const own = `git push origin HEAD:refs/heads/${plan.branch}`;
const config = { cliPath, repository: 'owner/project', baseBranch: 'main', credentialFile: '/home/op/.config/graphyard/credentials/master.token',
  reviewer: { credentialFile: '/home/op/.config/graphyard/reviewer/reviewer.token' }, repositoryWorktreeRoot: null, run: {} } as unknown as MasterConfig;
const plan_ = () => sessionHarnessPlan({ role: 'docs-sync', kind: 'claude', cliPath, repository: 'owner/project', baseBranch: 'main', credentialHome: '/home/op/.config/graphyard',
  credentialDirectories: ['home/op/.config/graphyard/credentials'], branch: plan.branch });

test('unit:docs-sync-harness-allows-own-branch-push — the docs-sync role allows the commit and the plain push to its own branch and denies every other push, the lifecycle commands, verdicts and secrets', async () => {
  const { docsSyncPushDenials } = await import('../src/master/harness.js') as { docsSyncPushDenials: (branch: string) => { rule: string; why: string }[] };
  const rules = plan_();
  const decide = (command: string) => harnessDecision(rules, command).decision;
  assert.equal(decide(own), 'allow', 'the plain push of the resolved merge to the item\'s own branch is allowed');
  assert.equal(decide(`git commit -m "Graphyard docs-sync of ${plan.key} onto ${plan.base.slice(0, 12)}"`), 'allow', 'the merge commit is allowed');
  assert.equal(decide(`git merge --no-ff ${plan.base}`), 'allow');
  assert.equal(decide('git merge --abort'), 'allow');
  assert.equal(decide('npm test -- tests/docs-budget.test.ts tests/docs-obligation.test.ts'), 'allow');
  // The prompt's own push instruction is the allowed command, verbatim.
  assert.ok(docsSyncPrompt({ repository: 'owner/project', cliPath }, plan, '/repo', '/w').includes(`${own} —`), 'the instruction names exactly the allowed push');
  for (const command of [
    `git push --force origin HEAD:refs/heads/${plan.branch}`, `git push -f origin HEAD:refs/heads/${plan.branch}`, `git push origin +HEAD:refs/heads/${plan.branch}`,
    `git push --force-with-lease origin HEAD:refs/heads/${plan.branch}`,
    'git push origin HEAD:refs/heads/main', 'git push origin HEAD:main', 'git push origin main', 'git push', 'git push origin', 'git push origin HEAD',
    'git push origin HEAD:refs/heads/graphyard/gy-1432-1', 'git push origin HEAD:refs/heads/graphyard/gy-1433-2', 'git push origin HEAD:refs/heads/graphyard/gy-1433',
    `git push origin HEAD:refs/heads/${plan.branch}-copy`, `git push origin HEAD:refs/heads/${plan.branch}x`, `git push origin HEAD:refs/heads/${plan.branch} HEAD:refs/heads/main`,
    `git push origin HEAD:refs/heads/${plan.branch} other`, `git push origin HEAD:refs/heads/${plan.branch}:x`,
    'git push origin HEAD:refs/tags/v1', 'git push origin --tags', `git push upstream HEAD:refs/heads/${plan.branch}`, `git push origin HEAD~1:refs/heads/${plan.branch}`,
    `git push origin ${plan.branch}`, `git push origin :refs/heads/${plan.branch}`, `git push origin --delete ${plan.branch}`, 'git push origin HEAD:refs/heads/Graphyard/gy-1433-1',
    `git -C /w push origin HEAD:refs/heads/${plan.branch}`, `git push -u origin HEAD:refs/heads/${plan.branch}`,
    // Bash drops a backslash escape, so these reach another item's branch or the base ref.
    `git push origin HEAD:refs/heads/${plan.branch.slice(0, -1)}\\2`, 'git push origin HEAD:refs/heads/\\main', `git push origin HEAD:refs/heads/${plan.branch}\\2`,
    `git push origin HEAD:refs/heads/${plan.branch}>out`, `git push origin HEAD:refs/heads/${plan.branch}<in`, 'git push origin HEAD:refs/heads/(main)',
    `git push\torigin HEAD:refs/heads/${plan.branch.slice(0, -1)}2`,
  ]) assert.equal(decide(command), 'deny', `${command} is denied`);
  for (const command of [`${cli} claim GY-1433`, `${cli} complete GY-1433 1 909`, `${cli} evidence GY-1433 --proof unit:x`, 'gh pr review 909 --approve',
    'gh api --method POST repos/owner/project/pulls/909/reviews', 'gh pr merge 909', 'git rebase main'])
    assert.equal(decide(command), 'deny', `${command} is denied`);
  const reads = rules.deny.map(entry => entry.rule);
  for (const secret of ['Read(/home/op/.config/graphyard/credentials/**)', 'Read(./.graphyard/connection.json)', 'Read(./.graphyard/credentials.json)', 'Read(./.graphyard/github-app.json)', 'Read(**/*.pem)', 'Read(**/*.token)'])
    assert.ok(reads.includes(secret), `the docs-sync role denies ${secret}, as every other role does`);
  for (const role of ['reviewer', 'producer'] as const) {
    const other = sessionHarnessPlan({ role, kind: 'claude', cliPath, repository: 'owner/project', baseBranch: 'main', credentialHome: '/home/op/.config/graphyard', credentialDirectories: ['home/op/.config/graphyard/credentials'] });
    for (const entry of other.deny.filter(rule => rule.rule.startsWith('Read('))) assert.ok(reads.includes(entry.rule), `the ${role}'s secret deny ${entry.rule} applies to docs-sync too`);
  }
  // No generated rule is one Claude Code would skip with a settings warning.
  for (const entry of [...rules.allow, ...rules.deny, ...docsSyncPushDenials('graphyard/gy-1-1')]) assert.equal(claudeRuleProblem(entry.rule), null, entry.rule);
  assert.equal(harnessDecision(sessionHarnessPlan({ role: 'docs-sync', kind: 'claude', cliPath, repository: 'o/p', baseBranch: 'main', credentialHome: '/h', credentialDirectories: [], branch: 'graphyard/gy-7-12' }), 'git push origin HEAD:refs/heads/graphyard/gy-7-12').decision, 'allow',
    'another item\'s own push is allowed under its own role');
  assert.throws(() => sessionHarnessPlan({ role: 'docs-sync', kind: 'claude', cliPath, repository: 'o/p', baseBranch: 'main', credentialHome: '/h', credentialDirectories: [] }), /names the item branch/);
});

test('unit:docs-sync-launch-excludes-project-settings — under a repository whose local settings deny git push, a Claude docs-sync launch loads only user settings plus its role file, where its own push is allowed', async () => {
  const { docsSyncHarness } = await import('../src/docs-sync.js') as unknown as { docsSyncHarness: (root: string, config: MasterConfig, plan: DocsSyncPlan, kind: string) => Promise<{ file: string | null; args: string[]; role: string | null }> };
  const root = await temporaryDirectory('docs-sync-harness');
  await mkdir(join(root, '.claude'), { recursive: true });
  // The master's rules as on this host: the project-local settings deny every push.
  await writeFile(join(root, '.claude', 'settings.local.json'), `${JSON.stringify({ permissions: { allow: [`Bash(${cli} master:*)`], deny: ['Bash(git push:*)'] } }, null, 2)}\n`);
  const harness = await docsSyncHarness(root, config, plan, 'claude');
  assert.ok(harness.file, 'a Claude docs-sync session under a repository with project settings gets a role file');
  assert.equal(resolve(harness.file!), resolve(root, '.graphyard/harness', `docs-sync-${plan.key}-${plan.head.slice(0, 7)}.json`), 'the role file is the plan\'s own, beside the ledgers');
  assert.deepEqual(harness.args, ['--setting-sources', 'user', '--settings', harness.file], 'setting sources are limited to the user settings plus the role file, so the project and local settings are never loaded');
  assert.ok(!harness.args.some(arg => /project|local/.test(arg)), 'neither the project nor the local settings source is named');
  assert.ok(harness.role, 'the session carries the launch authorization as its role text, since AGENTS.md is not loaded');
  const loaded = JSON.parse(await readFile(harness.file!, 'utf8')) as { permissions: { allow: string[]; deny: string[] } };
  assert.ok(!loaded.permissions.deny.includes('Bash(git push:*)'), 'the master\'s push deny is not in the session\'s rules');
  const toRules = (list: string[]) => list.map(rule => ({ rule, why: '' }));
  assert.equal(harnessDecision({ allow: toRules(loaded.permissions.allow), deny: toRules(loaded.permissions.deny) }, own).decision, 'allow', 'the written role file allows the resolved merge\'s push, so the session never waits out docsSyncMaxMs on a denied push');
  const project = JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')) as { permissions: { deny: string[] } };
  assert.equal(harnessDecision({ allow: [], deny: toRules(project.permissions.deny) }, own).decision, 'deny', 'the project settings it no longer loads would have denied that push');
  // A runtime that does not load Claude Code settings inherits nothing and is launched unchanged.
  assert.deepEqual((await docsSyncHarness(root, config, plan, 'codex')).args, []);
  const bare = await temporaryDirectory('docs-sync-harness-bare');
  assert.deepEqual((await docsSyncHarness(bare, config, plan, 'claude')).args, [], 'a repository with no project settings has nothing to exclude');
});

test('docs-sync role files do not accumulate — the settle removes the plan\'s file and the orphan reclaim removes every file no visible session owns', async () => {
  const { docsSyncHarness, docsSyncHarnessFile, releaseDocsSyncHarness, reclaimDocsSyncCheckouts, docsSyncSessionName } = await import('../src/docs-sync.js') as any;
  const root = await temporaryDirectory('docs-sync-harness-release');
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(join(root, '.claude', 'settings.local.json'), `${JSON.stringify({ permissions: { deny: ['Bash(git push:*)'] } })}\n`);
  const other: DocsSyncPlan = { ...plan, key: 'GY-7', branch: 'graphyard/gy-7-1', head: '0badc0de'.padEnd(40, '1') };
  const third: DocsSyncPlan = { ...plan, key: 'GY-8', branch: 'graphyard/gy-8-1', head: 'feedface'.padEnd(40, '2') };
  for (const each of [plan, other, third]) await docsSyncHarness(root, config, each, 'claude');
  await releaseDocsSyncHarness(root, plan);
  await assert.rejects(readFile(docsSyncHarnessFile(root, plan)), /ENOENT/, 'a settled session\'s role file is removed');
  await releaseDocsSyncHarness(root, plan); // already gone is fine
  // A loop that died before settling leaves files behind: only the one a visible session owns survives the reclaim.
  const run = async () => { throw new Error('no git here'); };
  await reclaimDocsSyncCheckouts(root, [docsSyncSessionName(other)], run);
  assert.ok((await readFile(docsSyncHarnessFile(root, other), 'utf8')).includes('permissions'), 'the role file of a visible session is kept');
  await assert.rejects(readFile(docsSyncHarnessFile(root, third)), /ENOENT/, 'an orphaned role file is reclaimed');
});
