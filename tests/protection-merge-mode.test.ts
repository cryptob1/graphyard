import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProtection, mergeMode, mergeQueueRulesetName, protectionPlan, repositoryMergeSettings, withMergeSettings } from '../src/protection.js';
import { applyProtection as installProtection, protectionSatisfied, type GitHubCli } from '../src/install/github.js';
import { applyProposal, scanProposal } from '../src/repository-setup.js';
import type { Work } from '../src/model.js';

// GY-310: GitHub offers merge queues only on organization-owned repositories and answers the queue
// ruleset on a user-owned one with HTTP 422. There GitHub merges through auto-merge instead, so
// protection plans and applies allow_auto_merge rather than a ruleset that cannot exist.

const config = { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 };
const agent = { id: 'w1', key: 'GY-1', stage: 'build', policy: { checks: ['test'], review: true, reviewProvider: 'agent' } } as unknown as Work;
const branch = () => ({ required_pull_request_reviews: { required_approving_review_count: 0, require_last_push_approval: false, dismiss_stale_reviews: true },
  required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } });
const queueRules = [{ type: 'merge_queue', parameters: {} }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Graphyard / merge', integration_id: 1234 }] } }];

/** A fake `gh` for the master's protection: one repository, its branch rules, and every write it receives. */
function github(owner: 'User' | 'Organization', options: { allowAutoMerge?: boolean; refuseQueue?: boolean } = {}) {
  const state = { allowAutoMerge: options.allowAutoMerge ?? false, rules: [] as unknown[], writes: [] as string[][] };
  const run = (_command: string, args: string[], input?: string) => {
    const path = args.find(arg => arg.startsWith('repos/'))!;
    if (args.includes('PATCH') && path === `repos/${config.repository}`) { state.writes.push(args); state.allowAutoMerge = args.includes('allow_auto_merge=true'); return '{}'; }
    if (path.startsWith(`repos/${config.repository}/rulesets`) && (args.includes('POST') || args.includes('PUT'))) {
      state.writes.push(args);
      if (options.refuseQueue) throw Object.assign(new Error(`Command failed: gh ${args.join(' ')}`), { stderr: 'gh: Validation Failed (HTTP 422)' });
      assert.equal(JSON.parse(input!).name, mergeQueueRulesetName);
      state.rules = queueRules; return '{}';
    }
    if (path.startsWith(`repos/${config.repository}/rulesets`)) return '[]';
    if (path.startsWith(`repos/${config.repository}/rules/branches/`)) return JSON.stringify(state.rules);
    if (path.endsWith('/protection')) return JSON.stringify(branch());
    if (path === `repos/${config.repository}`) return JSON.stringify({ full_name: config.repository, owner: { login: 'owner', type: owner }, allow_auto_merge: state.allowAutoMerge });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { state, run };
}

test('unit:protection-auto-merge-mode — a user-owned repository plans auto-merge and no queue ruleset; an organization repository plans the queue', async () => {
  // Planning: a user-owned repository wants allow_auto_merge, never a ruleset.
  const user = github('User');
  const plan = protectionPlan(withMergeSettings(branch(), repositoryMergeSettings({ owner: { type: 'User' }, allow_auto_merge: false })), config, [agent], []);
  assert.equal(plan.mergeMode, 'auto-merge'); assert.equal(plan.mergeQueue, null); assert.deepEqual(plan.autoMerge, { enabled: false });
  assert.equal(plan.consistent, false);
  assert.ok(plan.changes.some(change => change.startsWith('allow_auto_merge false to true')), plan.changes.join('; '));
  assert.ok(!plan.changes.some(change => /^merge queue|ruleset/.test(change)), 'no queue ruleset is planned for a user-owned repository');

  // Applying: allow_auto_merge is switched on, no ruleset is written, and the plan settles.
  const applied = await applyProtection(config, [agent], user.run);
  assert.equal(applied.applied, true); assert.equal(applied.consistent, true); assert.equal(applied.mergeMode, 'auto-merge');
  assert.equal(user.state.allowAutoMerge, true);
  assert.deepEqual(user.state.writes, [['api', '--method', 'PATCH', 'repos/owner/project', '-F', 'allow_auto_merge=true']]);
  assert.match(applied.result, /auto-merge requiring Graphyard \/ merge/);
  // Consistent once auto-merge is on and `Graphyard / merge` is a required check.
  const settled = await applyProtection(config, [agent], user.run);
  assert.equal(settled.applied, false); assert.equal(settled.consistent, true);
  const unbound = protectionPlan(withMergeSettings({ ...branch(), required_status_checks: { strict: false, checks: [] } }, { ownerType: 'User', allowAutoMerge: true }), config, [agent], []);
  assert.equal(unbound.consistent, false, 'auto-merge alone is not enough without the required check');
  assert.match(unbound.refusal!, /Graphyard \/ merge/);

  // An organization repository plans and writes the queue ruleset, and leaves auto-merge alone.
  const organization = github('Organization');
  const queued = protectionPlan(withMergeSettings(branch(), repositoryMergeSettings({ owner: { type: 'Organization' }, allow_auto_merge: false })), config, [agent], []);
  assert.equal(queued.mergeMode, 'queue'); assert.equal(queued.autoMerge, null);
  assert.equal(queued.mergeQueue?.ruleset.name, mergeQueueRulesetName);
  assert.ok(queued.changes.some(change => change.includes(`ruleset "${mergeQueueRulesetName}"`)), queued.changes.join('; '));
  assert.ok(!queued.changes.some(change => change.startsWith('allow_auto_merge')));
  const written = await applyProtection(config, [agent], organization.run);
  assert.equal(written.consistent, true); assert.equal(written.mergeMode, 'queue');
  assert.equal(organization.state.writes.length, 1); assert.equal(organization.state.writes[0][2], 'POST');
  assert.equal(organization.state.allowAutoMerge, false);

  // An organization repository whose queue ruleset GitHub refuses (HTTP 422) falls back to auto-merge.
  const refused = github('Organization', { refuseQueue: true });
  const fallback = await applyProtection(config, [agent], refused.run);
  assert.equal(fallback.consistent, true); assert.equal(fallback.mergeMode, 'auto-merge'); assert.equal(refused.state.allowAutoMerge, true);

  // A branch that already has a queue stays in queue mode; unread repository settings keep the queue.
  assert.equal(mergeMode({ ownerType: 'User', allowAutoMerge: false }, queueRules), 'queue');
  assert.equal(mergeMode(null, []), 'queue');
  assert.equal(repositoryMergeSettings({}), null);
});

/** A fake install-time `gh`: branch protection, rules, and the repository document. */
function installGh(owner: 'User' | 'Organization', options: { protectedBranch?: boolean } = {}) {
  const state = { allowAutoMerge: false, protectedBranch: options.protectedBranch ?? true, calls: [] as string[][] };
  const gh: GitHubCli = async (args) => {
    state.calls.push(args);
    const path = args.find(arg => arg.startsWith('repos/'))!;
    const ok = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '', code: 0 });
    if (args.includes('PATCH') && path === 'repos/owner/project') { state.allowAutoMerge = args.includes('allow_auto_merge=true'); return ok({}); }
    if (args.includes('PUT') && path.endsWith('/protection')) { state.protectedBranch = true; return ok({}); }
    if (path.startsWith('repos/owner/project/rulesets')) return args.includes('POST') ? { stdout: '', stderr: 'HTTP 422', code: 1 } : ok([]);
    if (path.startsWith('repos/owner/project/rules/branches/')) return ok([]);
    // GitHub answers 404 for the protection of a branch that has none, the state of a fresh repository.
    if (path.endsWith('/protection')) return state.protectedBranch ? ok(branch()) : { stdout: '', stderr: 'gh: Branch not protected (HTTP 404)', code: 1 };
    if (path === 'repos/owner/project') return ok({ owner: { type: owner }, allow_auto_merge: state.allowAutoMerge });
    return { stdout: '', stderr: 'not found', code: 1 };
  };
  return { state, gh };
}

test('unit:setup-enables-auto-merge — install and onboarding enable auto-merge on a user-owned repository', async () => {
  // Install: the protection step enables allow_auto_merge and never tries a queue ruleset.
  const user = installGh('User');
  const inputs = { repository: 'owner/project', branch: 'main', requiredChecks: [], graphyardAppId: 1234, reviewCount: 0 };
  await installProtection(user.gh, inputs);
  assert.equal(user.state.allowAutoMerge, true, 'install enables auto-merge on a user-owned repository');
  assert.ok(!user.state.calls.some(args => args.some(arg => arg.includes('/rulesets'))), 'no queue ruleset is attempted');
  const { readProtection } = await import('../src/install/github.js');
  assert.equal(protectionSatisfied(inputs, await readProtection(user.gh, 'owner/project', 'main')), true, 'the reapplied setup is satisfied');
  const off = installGh('User');
  assert.equal(protectionSatisfied(inputs, await readProtection(off.gh, 'owner/project', 'main')), false, 'auto-merge off is drift the installer repairs');
  // A fresh user-owned repository's branch is unprotected: the first install still enables auto-merge.
  const fresh = installGh('User', { protectedBranch: false });
  assert.equal(await readProtection(fresh.gh, 'owner/project', 'main'), null);
  await installProtection(fresh.gh, inputs);
  assert.equal(fresh.state.protectedBranch, true);
  assert.equal(fresh.state.allowAutoMerge, true, 'the first install on an unprotected branch enables auto-merge');
  assert.ok(!fresh.state.calls.some(args => args.some(arg => arg.includes('/rulesets'))), 'no queue ruleset is attempted');
  assert.equal(protectionSatisfied(inputs, await readProtection(fresh.gh, 'owner/project', 'main')), true, 'one install settles a fresh repository');
  // Before the App has published its check the installer still enables auto-merge.
  const early = installGh('User');
  await installProtection(early.gh, { ...inputs, graphyardAppId: null });
  assert.equal(early.state.allowAutoMerge, true);
  // An organization repository whose queue ruleset GitHub refuses falls back to auto-merge too.
  const organization = installGh('Organization');
  await installProtection(organization.gh, inputs);
  assert.ok(organization.state.calls.some(args => args.includes('POST')), 'the queue ruleset is attempted first');
  assert.equal(organization.state.allowAutoMerge, true);

  // Onboarding: init --scan --apply's setup step switches auto-merge on for a user-owned repository.
  const root = await mkdtemp(join(tmpdir(), 'graphyard-merge-mode-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/project.git'], { cwd: root });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'project', scripts: { test: 'node --test' } }));
    const proposal = await scanProposal(root, { url: 'https://graphyard.example', runtimes: [] });
    const onboarding = github('User');
    const result = await applyProposal(root, proposal, { url: 'https://graphyard.example', githubSetup: async () => ({ appId: 1234, slug: 'graphyard-owner-project' }), github: onboarding.run });
    assert.equal(onboarding.state.allowAutoMerge, true, 'onboarding enables auto-merge on a user-owned repository');
    assert.ok(result.applied.some(line => /merge mode: auto-merge enabled/.test(line)), result.applied.join('; '));
    const again = await applyProposal(root, proposal, { url: 'https://graphyard.example', github: onboarding.run });
    assert.ok(again.unchanged.some(line => /auto-merge already enabled/.test(line)), again.unchanged.join('; '));
    // An organization repository gets no auto-merge write during onboarding.
    const org = github('Organization');
    await applyProposal(root, proposal, { url: 'https://graphyard.example', github: org.run });
    assert.deepEqual(org.state.writes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
