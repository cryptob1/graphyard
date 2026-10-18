import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProtection as installProtection, protectionSatisfied, type GitHubCli } from '../src/install/github.js';

// GY-310: GitHub offers merge queues only on organization-owned repositories and answers the queue
// ruleset on a user-owned one with HTTP 422. There GitHub merges through auto-merge instead, so
// the installer applies allow_auto_merge rather than a ruleset that cannot exist.

const branch = () => ({ required_pull_request_reviews: { required_approving_review_count: 0, require_last_push_approval: false, dismiss_stale_reviews: true },
  required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }, { context: 'graphyard/landable', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } });

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

test('unit:setup-enables-auto-merge — install enables auto-merge on a user-owned repository', async () => {
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

});
