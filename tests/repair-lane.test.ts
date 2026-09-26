import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProtection, mergeQueueRuleset, mergeQueueRulesetName, protectionPlan, repairBypassActor, withMergeSettings, withQueueRuleset } from '../src/protection.js';
import { normalMergeState, repairLaneAttention, repairLaneVerdict, repairScopeRefusal, repairStallMs, type RepairAudit, type RepairDecision } from '../src/master/repair-lane.js';
import { repairLaneStep } from '../src/github.js';
import { decisionInputs, decisionPrecondition } from '../src/model/approval.js';
import { createSchema, type Observation, type Work } from '../src/model.js';

// GY-406: when the merge path itself breaks, a fix to it cannot pass through it. The repair lane
// lets the control-plane App merge a merge-path fix through one narrow, audited bypass.

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const config = { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 };
const agentItem = { id: 'w1', key: 'GY-1', stage: 'build', policy: { checks: ['test'], review: true, reviewProvider: 'agent' } } as unknown as Work;
const branch = () => ({ required_pull_request_reviews: { required_approving_review_count: 0, require_last_push_approval: false, dismiss_stale_reviews: true },
  required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } });
const queueRules = [{ type: 'merge_queue', parameters: {} }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Graphyard / merge', integration_id: 1234 }] } }];

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

const decision = (overrides: Partial<RepairDecision> = {}): RepairDecision => ({ id: 'd-1', action: 'repair-merge', state: 'applied', input: { sha: head },
  reason: 'The delegated merge in src/merge-queue.ts stalls every merge on UNSTABLE heads', requestedBy: 'graphyard-operator', approvedBy: 'graphyard-approver', ...overrides });
function repairItem(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 206, branch: 'graphyard/gy-9-1', author: 'worker' };
  return { id: 'work-9', key: 'GY-9', title: 'Fix the merge path', description: '', type: 'bug', priority: 0, dependencies: [], criteria: [{ id: 'AC-1', text: 'Merges', proofs: ['unit:merges'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/merge-queue.ts', 'src/daemon/cycle-delivery.ts'], repair: 'merge-path', stage: 'merge', revision: 9, policyRevision: 1,
    createdAt: '', updatedAt: '', stageEnteredAt: '2026-09-25T00:00:00.000Z', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 206 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { at: new Date().toISOString(), candidate, reviews: [], checks: [{ name: 'test', result: 'success', appId: 1 }], protected: true, mergeable: true, merged: false, prState: 'open', draft: false } as unknown as Observation,
    blocker: null, gates: [{ name: 'test', passed: true, reasons: [] }, { name: 'merge', passed: false, reasons: ['GitHub reports the pull request UNSTABLE'] }], violations: [], ...overrides } as Work;
}
const since = '2026-09-25T00:00:00.000Z', stalled = Date.parse(since) + repairStallMs;
const stalledMerge = { state: 'refused' as const, since, detail: 'GitHub reports the pull request UNSTABLE' };

test('unit:repair-lane-conditions — each missing condition is refused by name; the one allowed path merges the approved head', () => {
  // Only an item whose plannedFiles stay within the merge path may carry "repair": "merge-path".
  assert.equal(createSchema.safeParse({ title: 't', criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], repair: 'merge-path' }).success, true);
  assert.equal(createSchema.safeParse({ title: 't', criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], repair: 'anything' }).success, false);
  assert.equal(repairScopeRefusal({ repair: 'merge-path', plannedFiles: ['src/github.ts', 'src/merge-queue.ts', 'src/model/queue.ts', 'src/daemon/cycle.ts', '.github/workflows/ci.yml'] }), null);
  assert.match(repairScopeRefusal({ repair: 'merge-path', plannedFiles: ['src/github.ts', 'src/engine.ts'] })!, /outside the merge path .*: src\/engine\.ts/);
  assert.match(repairScopeRefusal({ repair: 'merge-path', plannedFiles: [] })!, /names no plannedFiles/);
  assert.match(repairScopeRefusal({ repair: 'merge-path', plannedFiles: ['src/daemon/../engine.ts'] })!, /outside the merge path/);
  assert.equal(repairScopeRefusal({ plannedFiles: ['src/engine.ts'] }), null, 'an ordinary item carries no repair');

  // The decision is head-bound, requested only on a repair item for its current head.
  assert.deepEqual(decisionInputs['repair-merge'].parse({ sha: head }), { sha: head });
  assert.throws(() => decisionInputs['repair-merge'].parse({ sha: head, admin: true }));
  assert.equal(decisionPrecondition('repair-merge', { sha: head }, repairItem()), null);
  assert.match(decisionPrecondition('repair-merge', { sha: head }, repairItem({ repair: undefined }))!, /only a merge-path repair item/);
  assert.match(decisionPrecondition('repair-merge', { sha: 'c'.repeat(40) }, repairItem())!, /current candidate is aaaaaaaaaaaa/);

  const refused = (verdict: ReturnType<typeof repairLaneVerdict>, condition: string, pattern: RegExp) => {
    assert.equal(verdict.allowed, false); assert.equal(!verdict.allowed && verdict.condition, condition);
    assert.match(!verdict.allowed ? verdict.refusal : '', new RegExp(`^Repair lane refused \\(${condition}\\): `));
    assert.match(!verdict.allowed ? verdict.refusal : '', pattern);
  };
  refused(repairLaneVerdict(repairItem({ repair: undefined }), [decision()], stalledMerge, stalled), 'repair-item', /merges nothing else/);
  refused(repairLaneVerdict(repairItem({ plannedFiles: ['src/merge-queue.ts', 'README.md'] }), [decision()], stalledMerge, stalled), 'merge-path-scope', /README\.md/);
  refused(repairLaneVerdict(repairItem({ submission: null }), [decision()], stalledMerge, stalled), 'candidate', /no submitted candidate/);
  refused(repairLaneVerdict(repairItem({ gates: [{ name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate'] }] }), [decision()], stalledMerge, stalled), 'required-checks', /test has not passed/);
  const moved = repairItem(); moved.observation = { ...moved.observation!, candidate: { ...moved.candidate!, sha: 'c'.repeat(40) } };
  refused(repairLaneVerdict(moved, [decision()], stalledMerge, stalled), 'required-checks', /has not been observed at GY-9's head/);
  refused(repairLaneVerdict(repairItem(), [], stalledMerge, stalled), 'decision', /graphyard master decide GY-9 repair-merge REASON/);
  refused(repairLaneVerdict(repairItem(), [decision({ state: 'requested', approvedBy: null })], stalledMerge, stalled), 'decision', /d-1 is requested/);
  refused(repairLaneVerdict(repairItem(), [decision({ approvedBy: 'graphyard-operator' })], stalledMerge, stalled), 'decision', /no independent approver/);
  refused(repairLaneVerdict(repairItem(), [decision({ input: { sha: 'c'.repeat(40) } })], stalledMerge, stalled), 'decision', /no repair-merge decision names head/);
  refused(repairLaneVerdict(repairItem(), [decision({ reason: 'please merge it' })], stalledMerge, stalled), 'fault-named', /does not name the merge-path fault/);
  refused(repairLaneVerdict(repairItem(), [decision({ reason: 'the fault is in src/engine.ts' })], stalledMerge, stalled), 'fault-named', /merge-path fault/);
  refused(repairLaneVerdict(repairItem(), [decision()], { state: 'none', since: null, detail: null }, stalled), 'normal-merge-stalled', /has not been refused or left pending/);
  refused(repairLaneVerdict(repairItem(), [decision()], stalledMerge, stalled - 60_000), 'normal-merge-stalled', /refused for 14 minute\(s\).*waits 15/);

  // The one allowed path: every condition holds, and the verdict binds the exact head and PR.
  const allowed = repairLaneVerdict(repairItem(), [decision()], stalledMerge, stalled);
  assert.equal(allowed.allowed, true);
  if (allowed.allowed) { assert.equal(allowed.sha, head); assert.equal(allowed.pr, 206); assert.equal(allowed.decision.id, 'd-1'); assert.equal(allowed.fault, 'src/merge-queue.ts'); assert.deepEqual(allowed.bypassed, stalledMerge); }
  // A pending merge the coordinator requested for this head counts from its request, the older of the two.
  assert.deepEqual(normalMergeState(repairItem({ stage: 'test' }), { sha: head, at: since }).state, 'pending');
  assert.equal(normalMergeState(repairItem(), { sha: head, at: '2026-09-25T00:05:00.000Z' }).since, since);
  assert.equal(normalMergeState(repairItem({ stage: 'test' }), { sha: 'c'.repeat(40), at: since }).state, 'none', 'a request for another head is not this head\'s merge');
});

test('unit:repair-lane-audited — a repair-lane merge appends its audit entry before the head-bound merge, and stays on master status until a normal merge', async () => {
  const events: { kind: string; payload: any }[] = [];
  const ledger = [
    { actor: 'graphyard-operator', kind: 'decision.requested', created_at: new Date(since), payload: { id: 'd-1', action: 'repair-merge', input: { sha: head }, reason: decision().reason } },
    { actor: 'graphyard-approver', kind: 'decision.approved', created_at: new Date(since), payload: { id: 'd-1', reason: 'The merge-path fault is real' } },
    { actor: 'graphyard-approver', kind: 'decision.applied', created_at: new Date(since), payload: { id: 'd-1', outcome: 'approved' } },
  ];
  const engine = { enqueueRequest: async () => null,
    store: { pool: { query: async (text: string, values: unknown[]) => {
      if (text.startsWith('INSERT INTO events')) { events.push({ kind: values[2] as string, payload: JSON.parse(values[3] as string) }); return { rows: [] }; }
      if (text.includes("kind LIKE 'decision.%'")) return { rows: ledger };
      if (text.includes("kind='repair.refused'")) return { rows: [] };
      throw new Error(`unexpected query ${text}`);
    } } } } as any;
  const merges: { work: string; audit: RepairAudit; recorded: number }[] = [];
  const github = { repairMerge: async (work: Work, audit: RepairAudit) => { merges.push({ work: work.key, audit, recorded: events.length }); } };

  // Too early: nothing is merged, and the refusal is named on the ledger once.
  const early = await repairLaneStep(engine, github, repairItem(), new Date(stalled - 1000));
  assert.equal(early.allowed, false); assert.equal(merges.length, 0);
  assert.deepEqual(events.map(event => event.kind), ['repair.refused']);
  assert.equal(events[0].payload.details.condition, 'normal-merge-stalled');

  // Allowed: the audit entry is appended first, then the head-bound merge is asked for.
  events.length = 0;
  const verdict = await repairLaneStep(engine, github, repairItem(), new Date(stalled));
  assert.equal(verdict.allowed, true);
  assert.deepEqual(events.map(event => event.kind), ['repair.merged']);
  const audit = events[0].payload.details as RepairAudit;
  assert.deepEqual({ item: audit.item, pr: audit.pr, head: audit.head, decision: audit.decision, requestedBy: audit.requestedBy, approver: audit.approver, fault: audit.fault },
    { item: 'GY-9', pr: 206, head, decision: 'd-1', requestedBy: 'graphyard-operator', approver: 'graphyard-approver', fault: 'src/merge-queue.ts' });
  assert.deepEqual(audit.bypassed, { state: 'refused', since, detail: 'GitHub reports the pull request UNSTABLE' }, 'the refusal it bypassed');
  assert.equal(merges.length, 1); assert.equal(merges[0].recorded, 1, 'the audit entry precedes the merge'); assert.equal(merges[0].audit.head, head);

  // A refused GitHub merge is appended too, and surfaces.
  events.length = 0;
  await assert.rejects(repairLaneStep(engine, { repairMerge: async () => { throw new Error('head moved'); } }, repairItem(), new Date(stalled)), /head moved/);
  assert.deepEqual(events.map(event => event.kind), ['repair.merged', 'repair.failed']);

  // Master status: the delivered repair raises an attention item until the next normal merge.
  const delivered = (key: string, mergedAt: string, repairLane: RepairAudit | null) => ({ key, stage: 'done', delivery: { mergedAt, mergeSha: head, authorizationRevision: 1 }, repairLane }) as Work;
  const earlierNormal = delivered('GY-8', '2026-09-25T00:10:00.000Z', null);
  const repaired = delivered('GY-9', '2026-09-25T00:20:00.000Z', audit);
  const attention = repairLaneAttention([earlierNormal, repaired, repairItem({ key: 'GY-10', stage: 'merge' })]);
  assert.equal(attention.length, 1);
  assert.equal(attention[0].subject, 'GY-9'); assert.equal(attention[0].role, 'master'); assert.equal(attention[0].human, false);
  assert.match(attention[0].text, /merged through the repair lane .*bypassing a normal guarded merge refused since 2026-09-25T00:00:00\.000Z .*decision d-1 requested by graphyard-operator and approved by graphyard-approver .*src\/merge-queue\.ts.*unproven until the next normal merge/);
  assert.deepEqual(repairLaneAttention([earlierNormal, repaired, delivered('GY-11', '2026-09-25T00:30:00.000Z', null)]), [], 'a later normal merge proves the merge path healthy');
  assert.equal(repairLaneAttention([repaired, delivered('GY-12', '2026-09-25T00:30:00.000Z', { ...audit, item: 'GY-12' })]).length, 2, 'a second repair is no normal merge');
});
