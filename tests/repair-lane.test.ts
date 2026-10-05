import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProtection, mergeQueueRuleset, mergeQueueRulesetName, protectionPlan, repairBypassActor, withMergeSettings, withQueueRuleset } from '../src/protection.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decisionActions, decisionInputs, decisionRequestSchema } from '../src/model/approval.js';
import { createSchema, evaluate, type Observation, type Work } from '../src/model.js';

// GY-406 gave the control-plane App a ruleset bypass the main guard still lands its reverts with.
// GY-1234 removed the repair lane built on it: under GitHub delivery GitHub merges on its own
// branch protection, so there is no Graphyard merge path left to repair.

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const config = { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 };
const agentItem = { id: 'w1', key: 'GY-1', stage: 'build', policy: { checks: ['test'], review: true, reviewProvider: 'agent' } } as unknown as Work;
const branch = () => ({ required_pull_request_reviews: { required_approving_review_count: 0, require_last_push_approval: false, dismiss_stale_reviews: true },
  required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }, { context: 'graphyard/landable', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } });
const queueRules = [{ type: 'merge_queue', parameters: {} }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Graphyard / merge', integration_id: 1234 }, { context: 'graphyard/landable', integration_id: 1234 }] } }];

test('unit:repair-bypass-ruleset — the queue ruleset has exactly one bypass actor, the App, in pull_request mode, and protection plans, applies and reports it', async () => {
  const ruleset = mergeQueueRuleset(config);
  assert.equal(ruleset.bypass_actors.length, 1, 'exactly one bypass actor');
  assert.deepEqual(ruleset.bypass_actors[0], { actor_id: 1234, actor_type: 'Integration', bypass_mode: 'pull_request' });
  assert.deepEqual(ruleset.bypass_actors, [repairBypassActor(1234)]);
  // Every other rule stays in force for everyone else: the queue and the App-bound check are unchanged.
  assert.deepEqual(ruleset.rules.map(rule => rule.type), ['merge_queue', 'required_status_checks']);

  // The plan shows the bypass actor, and a ruleset without it (or with anyone else) is a change to make.
  const organization = () => withMergeSettings(branch(), { ownerType: 'Organization', allowAutoMerge: false });
  const missing = protectionPlan(withQueueRuleset(organization(), { name: mergeQueueRulesetName, bypass_actors: [] }), config, [agentItem], queueRules, []);
  assert.deepEqual(missing.repairBypass?.actor, { actor_id: 1234, actor_type: 'Integration', bypass_mode: 'pull_request' });
  assert.equal(missing.repairBypass?.configured, false); assert.equal(missing.consistent, false);
  assert.ok(missing.changes.some(change => change.startsWith(`repair lane bypass on "${mergeQueueRulesetName}"`)), missing.changes.join('; '));
  const wider = protectionPlan(withQueueRuleset(organization(), { bypass_actors: [repairBypassActor(1234), { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }] }), config, [agentItem], queueRules, []);
  assert.equal(wider.repairBypass?.configured, false, 'a second bypass actor is not the repair lane');
  const always = protectionPlan(withQueueRuleset(organization(), { bypass_actors: [{ ...repairBypassActor(1234), bypass_mode: 'always' }] }), config, [agentItem], queueRules, []);
  assert.equal(always.repairBypass?.configured, false, 'the App bypasses in pull-request mode only');
  const exact = protectionPlan(withQueueRuleset(organization(), { bypass_actors: [repairBypassActor(1234)] }), config, [agentItem], queueRules, []);
  assert.equal(exact.repairBypass?.configured, true); assert.equal(exact.consistent, true, exact.changes.join('; '));
  // enforce_admins stays a blocker when off: the bypass never replaces administrator enforcement.
  const admins = protectionPlan(withQueueRuleset(withMergeSettings({ ...branch(), enforce_admins: { enabled: false } }, { ownerType: 'Organization', allowAutoMerge: false }), { bypass_actors: [repairBypassActor(1234)] }), config, [agentItem], queueRules, []);
  assert.ok(admins.blockers.includes('Administrator enforcement is disabled'));

  // Apply: the existing queue ruleset lacking the bypass is rewritten with it, read back, and reported.
  let stored: any = { id: 7, name: mergeQueueRulesetName, bypass_actors: [], rules: queueRules };
  const writes: { args: string[]; body: any }[] = [];
  const run = (_command: string, args: string[], input?: string) => {
    const path = args.find(arg => arg.startsWith('repos/'))!;
    if (args.includes('PUT') && path === 'repos/owner/project/rulesets/7') { const body = JSON.parse(input!); writes.push({ args, body }); stored = { id: 7, ...body }; return '{}'; }
    if (args.includes('--method')) throw new Error(`unexpected write ${args.join(' ')}`);
    if (path === 'repos/owner/project/rulesets?includes_parents=false') return JSON.stringify([{ id: 7, name: mergeQueueRulesetName }]);
    if (path === 'repos/owner/project/rulesets/7') return JSON.stringify(stored);
    if (path.startsWith('repos/owner/project/rules/branches/')) return JSON.stringify(queueRules);
    if (path.endsWith('/protection')) return JSON.stringify(branch());
    if (path === 'repos/owner/project') return JSON.stringify({ owner: { type: 'Organization' }, allow_auto_merge: false });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const applied = await applyProtection(config, [agentItem], run);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.bypass_actors, [{ actor_id: 1234, actor_type: 'Integration', bypass_mode: 'pull_request' }]);
  assert.equal(applied.consistent, true); assert.equal(applied.repairBypass?.configured, true);
  assert.match(applied.result, /only bypass actor is App 1234 in pull-request mode/);
});

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(directory, entry.name)) : /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [join(directory, entry.name)] : []);
}

test('unit:repair-lane-removed — the module is gone and unimported, repair-merge is refused as unknown, and an item stored with "repair": "merge-path" still loads and evaluates', () => {
  assert.equal(existsSync('src/master/repair-lane.ts'), false, 'src/master/repair-lane.ts is deleted');
  const importers = ['src', 'bin', 'web'].filter(existsSync).flatMap(sources).filter(file => /repair-lane(\.js)?['"]/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(importers, [], 'no source file imports the repair lane');

  // The decision action is unknown: not listed, carries no input schema, and the request is refused.
  assert.equal((decisionActions as readonly string[]).includes('repair-merge'), false);
  assert.equal('repair-merge' in decisionInputs, false);
  const request = decisionRequestSchema.safeParse({ action: 'repair-merge', input: { sha: head }, reason: 'The merge path in src/merge-queue.ts stalls' });
  assert.equal(request.success, false, 'a repair-merge decision request is refused');
  assert.deepEqual(request.error!.issues.map(issue => [issue.code, issue.path.join('.')]), [['invalid_value', 'action']], 'refused as an unknown action');
  assert.equal(decisionRequestSchema.safeParse({ action: 'merge', input: { sha: head }, reason: 'still known' }).success, true, 'other actions are unaffected');
  // A new item cannot carry the retired field.
  assert.equal(createSchema.safeParse({ title: 't', criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], repair: 'merge-path' }).success, false);

  // An item stored before the removal — its document as work_items holds it — loads and evaluates.
  const candidate = { sha: head, baseSha: base, pr: 206, branch: 'graphyard/gy-9-1', author: 'worker' };
  const stored = JSON.stringify({ id: 'work-9', key: 'GY-9', title: 'Fix the merge path', description: '', type: 'bug', priority: 0, dependencies: [], criteria: [{ id: 'AC-1', text: 'Merges', proofs: ['unit:merges'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/merge-queue.ts'], repair: 'merge-path', stage: 'build', revision: 9, policyRevision: 1,
    createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z', stageEnteredAt: '2026-09-25T00:00:00.000Z', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 206 },
    reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { at: '2026-09-25T00:01:00.000Z', candidate, reviews: [], checks: [], protected: true, mergeable: true, merged: false, prState: 'open', draft: false } as unknown as Observation,
    blocker: null, gates: [], violations: [] });
  const loaded = JSON.parse(stored) as Work;
  assert.equal(loaded.repair, 'merge-path');
  const evaluated = evaluate(loaded, [loaded], new Date('2026-09-25T00:02:00.000Z'), [1]);
  assert.deepEqual(evaluated.gates.map(gate => gate.name).slice(0, 2), ['ready', 'build']);
  assert.equal(evaluated.gates.find(gate => gate.name === 'test')?.passed, false, 'judged by its gates like any other item');
  const plain = JSON.parse(stored) as Work; delete plain.repair;
  assert.deepEqual(evaluated, evaluate(plain, [plain], new Date('2026-09-25T00:02:00.000Z'), [1]), 'the retired field changes nothing');
});
