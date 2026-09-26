import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProtection, mergeMode, protectionPlan, repositoryMergeSettings, withMergeSettings } from '../src/protection.js';
import { applyProtection as installProtection, installMergeMode, protectionSatisfied, readProtection, type GitHubCli } from '../src/install/github.js';
import type { Work } from '../src/model.js';

// GY-350: a queue-ruleset write GitHub refuses with HTTP 422 settles the repository on auto-merge.
// The fallback records the settled mode in GitHub itself (allow_auto_merge), so a later dry-run
// plan, a later apply in a fresh process, and the installer's re-runs read it back and never plan
// or retry the refused ruleset again.

const config = { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 };
const agent = { id: 'w1', key: 'GY-1', stage: 'build', policy: { checks: ['test'], review: true, reviewProvider: 'agent' } } as unknown as Work;
const branch = () => ({ required_pull_request_reviews: { required_approving_review_count: 0, require_last_push_approval: false, dismiss_stale_reviews: true },
  required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } });

const refused422 = (args: string[]) => Object.assign(new Error(`Command failed: gh ${args.join(' ')}`), { stderr: 'gh: Validation Failed (HTTP 422)' });

/** A fake `gh` for the master's protection: an organization repository whose plan refuses the queue ruleset. */
function refusedGithub() {
  const state = { allowAutoMerge: false, queueRefused: false, rulesetWrites: 0 };
  const run = (_command: string, args: string[], input?: string) => {
    const path = args.find(arg => arg.startsWith('repos/'))!;
    if (args.includes('PATCH') && path === `repos/${config.repository}`) { state.allowAutoMerge = args.includes('allow_auto_merge=true'); return '{}'; }
    if (path.startsWith(`repos/${config.repository}/actions/variables`)) {
      if (args.includes('POST') || args.includes('PATCH')) { state.queueRefused = true; return '{}'; }
      if (state.queueRefused) return '{}';
      throw Object.assign(new Error(`Command failed: gh ${args.join(' ')}`), { stderr: 'gh: Not Found (HTTP 404)' });
    }
    if (path.startsWith(`repos/${config.repository}/rulesets`) && (args.includes('POST') || args.includes('PUT'))) { state.rulesetWrites += 1; throw refused422(args); }
    if (path.startsWith(`repos/${config.repository}/rulesets`)) return '[]';
    if (path.startsWith(`repos/${config.repository}/rules/branches/`)) return '[]';
    if (path.endsWith('/protection')) return JSON.stringify(branch());
    if (path === `repos/${config.repository}`) return JSON.stringify({ full_name: config.repository, owner: { login: 'owner', type: 'Organization' }, allow_auto_merge: state.allowAutoMerge });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { state, run };
}

test('unit:protection-refusal-settles — after the 422 fallback a later dry-run plan and a later apply never plan or retry the refused queue ruleset', async () => {
  // The first --apply retries nothing: it writes the ruleset once, is refused, and settles.
  const first = refusedGithub();
  const settled = await applyProtection(config, [agent], first.run);
  assert.equal(settled.consistent, true); assert.equal(settled.mergeMode, 'auto-merge');
  assert.equal(first.state.rulesetWrites, 1); assert.equal(first.state.allowAutoMerge, true);
  assert.equal(first.state.queueRefused, true, 'the refusal is recorded by its dedicated marker');

  // A later dry-run in a fresh process sees only GitHub's record: auto-merge is planned, consistent.
  const plan = protectionPlan(withMergeSettings(branch(), repositoryMergeSettings({ owner: { type: 'Organization' }, allow_auto_merge: true }, true)), config, [agent], []);
  assert.equal(plan.mergeMode, 'auto-merge'); assert.equal(plan.mergeQueue, null); assert.deepEqual(plan.autoMerge, { enabled: true });
  assert.equal(plan.consistent, true, plan.changes.join('; '));
  assert.ok(!plan.changes.some(change => /ruleset|merge queue|allow_auto_merge/.test(change)), 'no queue or auto-merge change is planned');

  // A later --apply in a fresh process sees the same record, changes nothing, and never POSTs.
  const later = refusedGithub(); later.state.allowAutoMerge = true; later.state.queueRefused = true;
  const reapplied = await applyProtection(config, [agent], later.run);
  assert.equal(reapplied.applied, false); assert.equal(reapplied.consistent, true);
  assert.equal(later.state.rulesetWrites, 0, 'the refused ruleset is never retried');
  assert.equal(mergeMode(repositoryMergeSettings({ owner: { type: 'Organization' }, allow_auto_merge: true }, true), []), 'auto-merge', 'the settled record decides the mode on its own');
});

test('unit:protection-preexisting-auto-merge-gets-queue — an organization repository that allowed auto-merge on its own is given one queue attempt; only the refusal marker settles auto-merge', async () => {
  const organization = (allowAutoMerge: boolean, queueRefused?: boolean | null) => repositoryMergeSettings({ owner: { type: 'Organization' }, allow_auto_merge: allowAutoMerge }, queueRefused);
  // GitHub answered that no refusal was recorded: auto-merge was enabled independently, so the queue is planned.
  assert.equal(mergeMode(organization(true, false), []), 'queue');
  const plan = protectionPlan(withMergeSettings(branch(), organization(true, false)), config, [agent], []);
  assert.equal(plan.mergeMode, 'queue'); assert.equal(plan.autoMerge, null);
  assert.ok(plan.changes.some(change => change.includes('ruleset "Graphyard merge queue"')), plan.changes.join('; '));
  // The marker alone settles auto-merge, even before allow_auto_merge is written.
  assert.equal(mergeMode(organization(false, true), []), 'auto-merge');
  // An unreadable marker keeps the pre-marker reading: allow_auto_merge stands for the refusal.
  assert.equal(mergeMode(organization(true, null), []), 'auto-merge');
  assert.equal(mergeMode(organization(false, null), []), 'queue');

  // The queue attempt succeeds where the repository can carry one: it settles on the queue.
  const rules: unknown[] = [];
  const queued = { writes: 0 };
  const accepting = (_command: string, args: string[]) => {
    const path = args.find(arg => arg.startsWith('repos/'))!;
    if (path.startsWith(`repos/${config.repository}/actions/variables`)) {
      if (args.includes('--method')) throw new Error('no refusal may be recorded when the queue was accepted');
      throw Object.assign(new Error(`Command failed: gh ${args.join(' ')}`), { stderr: 'gh: Not Found (HTTP 404)' });
    }
    if (path.startsWith(`repos/${config.repository}/rulesets`) && args.includes('POST')) { queued.writes += 1; rules.push({ type: 'merge_queue' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Graphyard / merge', integration_id: 1234 }] } }); return '{}'; }
    if (path.startsWith(`repos/${config.repository}/rulesets`)) return '[]';
    if (path.startsWith(`repos/${config.repository}/rules/branches/`)) return JSON.stringify(rules);
    if (path.endsWith('/protection')) return JSON.stringify(branch());
    if (path === `repos/${config.repository}`) return JSON.stringify({ owner: { type: 'Organization' }, allow_auto_merge: true });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const applied = await applyProtection(config, [agent], accepting);
  assert.equal(applied.consistent, true); assert.equal(applied.mergeMode, 'queue'); assert.equal(queued.writes, 1);

  // Where GitHub refuses it, the one attempt records the marker, settles auto-merge, and is never retried.
  const refused = refusedGithub(); refused.state.allowAutoMerge = true;
  const settled = await applyProtection(config, [agent], refused.run);
  assert.equal(settled.consistent, true); assert.equal(settled.mergeMode, 'auto-merge');
  assert.equal(refused.state.rulesetWrites, 1); assert.equal(refused.state.queueRefused, true);
  const again = await applyProtection(config, [agent], refused.run);
  assert.equal(again.applied, false); assert.equal(refused.state.rulesetWrites, 1, 'the refused ruleset is never retried');
});

/** A fake install-time `gh`: an organization repository whose plan refuses the queue ruleset. */
function refusedInstallGh() {
  const state = { allowAutoMerge: false, queueRefused: false, calls: [] as string[][] };
  const gh: GitHubCli = async (args) => {
    state.calls.push(args);
    const path = args.find(arg => arg.startsWith('repos/'))!;
    const ok = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '', code: 0 });
    if (args.includes('PATCH') && path === 'repos/owner/project') { state.allowAutoMerge = args.includes('allow_auto_merge=true'); return ok({}); }
    if (args.includes('PUT') && path.endsWith('/protection')) return ok({});
    if (path.startsWith('repos/owner/project/actions/variables')) {
      if (args.includes('POST') || args.includes('PATCH')) { state.queueRefused = true; return ok({}); }
      return state.queueRefused ? ok({}) : { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 };
    }
    if (path.startsWith('repos/owner/project/rulesets')) return args.includes('POST') || args.includes('PUT') ? { stdout: '', stderr: 'HTTP 422', code: 1 } : ok([]);
    if (path.startsWith('repos/owner/project/rules/branches/')) return ok([]);
    if (path.endsWith('/protection')) return ok(branch());
    if (path === 'repos/owner/project') return ok({ owner: { type: 'Organization' }, allow_auto_merge: state.allowAutoMerge });
    return { stdout: '', stderr: 'not found', code: 1 };
  };
  return { state, gh };
}

test('unit:install-refusal-settles — after the installer fallback its re-run reports no drift and never POSTs the refused ruleset again', async () => {
  const inputs = { repository: 'owner/project', branch: 'main', requiredChecks: [], graphyardAppId: 1234, reviewCount: 0 };
  const first = refusedInstallGh();
  await installProtection(first.gh, inputs);
  assert.equal(first.state.allowAutoMerge, true); assert.equal(first.state.queueRefused, true, 'the installer records the refusal marker');
  assert.equal(first.state.calls.filter(args => args.includes('POST') && args.some(arg => arg.includes('/rulesets'))).length, 1, 'the queue ruleset is attempted exactly once');

  // A fresh read (what every re-run starts from) reports the settled merge mode and no drift.
  const settled = await readProtection(first.gh, 'owner/project', 'main');
  assert.equal(installMergeMode(settled), 'auto-merge');
  assert.equal(protectionSatisfied(inputs, settled), true, 'no drift after the fallback settled auto-merge');

  // A full re-run still writes nothing to the refused ruleset.
  await installProtection(first.gh, inputs);
  assert.equal(first.state.calls.filter(args => args.includes('POST') && args.some(arg => arg.includes('/rulesets'))).length, 1, 'the refused ruleset is never retried');
});
