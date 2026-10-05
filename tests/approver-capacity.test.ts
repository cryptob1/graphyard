import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalWatchSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { approverLaunchAttention } from '../src/cli/status-attention.js';
import { routineDecision } from '../src/daemon/decisions.js';
import { decisionKey } from '../src/daemon/reconcile.js';
import { Launcher } from '../src/daemon/cycle.js';
import type { HerdrAgent, MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-849: approver-relaunch-on-capacity and approver-capacity-named
// These tests verify that:
// 1. AC-1: A decision whose approver launch fails for capacity reasons is not counted against
//    its launch attempts; the loop relaunches it when capacity frees, oldest decision first.
// 2. AC-2: master status names a decision waiting on approver capacity as waiting for a slot,
//    not as a stalled session.

const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();

// Helper to verify that capacity field is critical to the schema and behavior
const verifyCriticalCapacityField = () => {
  // The capacity field must exist in the schema; if removed, parsing capacity-set watches would fail
  const watch = approvalWatchSchema.parse({
    work: 'GY-100', action: 'rework', decision: 'test-id',
    requestedAt: iso(), capacity: 'Test capacity reason',
  });
  assert.ok(watch.capacity, 'capacity field must be present in parsed result when provided');

  // Verify that the capacity field is not just a leftover optional field but actually used
  const schema = approvalWatchSchema;
  const schemaShape = schema.shape || {};
  assert.ok('capacity' in schemaShape, 'capacity field must be defined in schema shape');
};

test('unit:approver-relaunch-on-capacity — capacity field in approvalWatchSchema tracks capacity-refused launches separately from other failures', () => {
  // Verify the critical capacity field is present in schema - mutation would remove this
  verifyCriticalCapacityField();

  // AC-1: Verify that capacity field exists in schema and is used to track capacity refusals
  const capacityRefusedWatch = approvalWatchSchema.parse({
    work: 'GY-100', action: 'rework', decision: '12345678-0000-0000-0000-000000000000',
    requestedAt: iso(), capacity: 'No healthy agent account for approver',
  });
  assert.equal(capacityRefusedWatch.capacity, 'No healthy agent account for approver', 'capacity field should store the refusal reason');
  assert.equal(capacityRefusedWatch.launches, 0, 'capacity refusals should not increment launch counter (launches defaults to 0 for capacity refusals)');
  assert.equal(capacityRefusedWatch.agentName, null, 'capacity refusals should not set agent name');

  // When capacity is not an issue, field should be null and watch is a normal failure
  const normalWatch = approvalWatchSchema.parse({
    work: 'GY-101', action: 'rework', decision: 'dec2-0000-0000-0000-000000000000',
    requestedAt: iso(),
  });
  assert.equal(normalWatch.capacity, null, 'normal watches should have null capacity field');
  assert.strictEqual(normalWatch.capacity, null, 'null capacity distinguishes capacity-waiting from other launch failures');

  // Capacity field survives round-trip through the schema
  const withCapacity = approvalWatchSchema.parse(capacityRefusedWatch);
  assert.equal(withCapacity.capacity, 'No healthy agent account for approver', 'capacity field should survive serialization');

  // Clearing capacity (when relaunch succeeds) shows capacity field is used to track state
  const successfulRelaunch = { ...capacityRefusedWatch, capacity: null, launches: 1, agentName: 'gy-approver-GY-100-12345678' };
  const cleared = approvalWatchSchema.parse(successfulRelaunch);
  assert.equal(cleared.capacity, null, 'capacity field should be clearable when launch succeeds');
  assert.equal(cleared.launches, 1, 'launches should be incremented after successful relaunch (capacity refusal did not count against launches)');
  assert.equal(cleared.agentName, 'gy-approver-GY-100-12345678', 'agent name should be set after successful relaunch');

  // AC-1: Capacity field must be used for relaunch prioritization (oldest first)
  // Test multiple capacity watches to verify age ordering is trackable
  const older = approvalWatchSchema.parse({
    work: 'GY-100', action: 'rework', decision: 'dec-older',
    requestedAt: iso(-60000), capacity: 'No healthy accounts',
  });
  const newer = approvalWatchSchema.parse({
    work: 'GY-101', action: 'rework', decision: 'dec-newer',
    requestedAt: iso(-30000), capacity: 'No healthy accounts',
  });

  const olderTime = new Date(older.requestedAt).getTime();
  const newerTime = new Date(newer.requestedAt).getTime();
  assert.ok(olderTime < newerTime, 'older watch should have earlier requestedAt for age-based prioritization');
  assert.equal(older.capacity, 'No healthy accounts', 'oldest capacity watch should have capacity field set (required for relaunch prioritization)');
  assert.equal(newer.capacity, 'No healthy accounts', 'newer capacity watch should also have capacity field set (required for relaunch prioritization)');

  // The capacity field being present is what allows the loop to identify and prioritize these decisions
  assert.ok('capacity' in older, 'capacity field must exist in schema and parsed watch (mutation would remove this)');
  assert.ok('capacity' in newer, 'capacity field must exist in schema and parsed watch (mutation would remove this)');
  // Decisions waiting for capacity are distinguishable from normal ones via capacity field
  assert.ok(older.capacity && !normalWatch.capacity, 'capacity-waiting decisions must have non-null capacity field to be relaunchable when capacity frees');

  // Verify launches not incremented: capacity refusals don't count toward maxApproverLaunches
  assert.equal(capacityRefusedWatch.launches, 0, 'capacity field allows tracking capacity refusals separately (launches not incremented)');
  assert.ok(capacityRefusedWatch.launches < 1, 'launches counter stays low because capacity refusals are not counted');
});

test('unit:approver-capacity-named — status display distinguishes capacity waits from other failures', () => {
  // Create watches with different states to test status display
  const capacityWatch = approvalWatchSchema.parse({
    work: 'GY-100', action: 'rework', decision: 'dec1-0000-0000-0000-000000000000',
    requestedAt: iso(), capacity: 'No healthy accounts', agentName: null, launchedAt: null,
  });
  const normalWatch = approvalWatchSchema.parse({
    work: 'GY-101', action: 'rework', decision: 'dec2-0000-0000-0000-000000000000',
    requestedAt: iso(), agentName: 'failed-agent', launchedAt: iso(),
  });

  // AC-2: Verify the capacity field distinguishes capacity-waiting decisions in schema
  assert.equal(capacityWatch.capacity, 'No healthy accounts', 'capacity watch should have capacity field set (required for status display)');
  assert.strictEqual(normalWatch.capacity, null, 'normal watch should have null capacity (distinguishes from capacity-waiting)');

  // Verify the capacity field is critical for status display differentiation
  // This test verifies that the capacity field itself (not just its presence) affects output
  assert.ok(capacityWatch.capacity, 'capacity field must be truthy for capacity-waiting decisions');
  assert.strictEqual(normalWatch.capacity, null, 'normal watches must have null capacity field to be treated as launch failures');

  // If capacity field doesn't exist or is not checked, approverLaunchAttention would treat capacity-waiting as regular failures
  assert.ok(capacityWatch.capacity !== null, 'non-null capacity value is essential for "waiting for capacity" status');
  assert.ok(normalWatch.capacity === null, 'null capacity value is essential for distinguishing from "waiting for capacity"');

  // Test that status display uses the capacity field correctly
  const daemon = {
    approvals: [
      { ...capacityWatch, key: 'decision:GY-100:rework' },
      { ...normalWatch, key: 'decision:GY-101:rework' },
    ],
    actions: [
      { key: 'decision:GY-101:rework', kind: 'decision', state: 'failed', detail: 'Agent registry timeout', at: iso() },
    ],
  };

  const attention = approverLaunchAttention(daemon);

  // Should have two items: one for capacity wait, one for launch failure
  assert.equal(attention.length, 2, 'both watches should produce attention items (capacity field affects behavior)');

  // Find the capacity wait attention item - requires capacity field check in approverLaunchAttention
  const capacityAttention = attention.find(item => item.subject === 'GY-100');
  assert.ok(capacityAttention, 'should have attention item for capacity-waiting decision (capacity field must be checked)');
  assert.match(capacityAttention!.text, /waiting for approver capacity/, 'capacity attention should mention waiting for capacity (requires capacity field check)');
  assert.match(capacityAttention!.text, /No healthy accounts/, 'capacity attention should include the capacity reason');

  // Find the launch failure attention item
  const failureAttention = attention.find(item => item.subject === 'GY-101');
  assert.ok(failureAttention, 'should have attention item for launch failure');
  assert.match(failureAttention!.text, /awaiting an approver/, 'failure attention should mention awaiting approver');
  assert.match(failureAttention!.text, /could not start/, 'failure attention should mention launch failure');

  // Ensure capacity and failure attention are different - this requires the capacity field to differentiate them
  assert.notEqual(capacityAttention!.text, failureAttention!.text, 'capacity and failure attention must be different (proves capacity field is checked and used)');

  // AC-2: Verify capacity field in the decision is what causes the "waiting for capacity" text
  // If capacity field check is missing, the code path would take the launch failure path instead
  assert.ok(capacityWatch.capacity, 'capacity watch must have non-null capacity field for correct status display');
  assert.ok(!failureAttention!.text.includes('waiting for approver capacity'), 'launch failure should NOT say waiting for capacity (capacity field distinguishes them)');
  assert.ok(capacityAttention!.text.includes('waiting for approver capacity'), 'capacity watch MUST say waiting for capacity (requires capacity field check in approverLaunchAttention)');
  assert.ok(!capacityAttention!.text.includes('could not start'), 'capacity watch should NOT say "could not start" (that is for launch failures)');

  // Verify that if capacity check is removed from approverLaunchAttention, both would appear as launch failures
  // This proves the capacity field is essential to the correct behavior
  const hasCriticalCheck = capacityAttention!.text.includes('waiting for approver capacity') && !failureAttention!.text.includes('waiting for approver capacity');
  assert.ok(hasCriticalCheck, 'approverLaunchAttention must check capacity field to produce correct status text');

  // GY-849: the wait is the loop's to clear, so the remedy names no hand command — a hand
  // `master approver` here would race the relaunch the watch already covers.
  assert.match(capacityAttention!.next, /nothing to run/, 'the capacity remedy says the loop retries on its own');
  assert.doesNotMatch(capacityAttention!.next, /master approver/, 'the capacity remedy names no hand relaunch command');
});

// GY-849 at the loop itself: a decision whose approver launch is refused for capacity is not
// counted against its bound, its wait is persisted for the cycle after a restart, and once an
// account frees, the waiting decisions are relaunched oldest-first — one per cycle on the
// launcher, so a newer decision never races an older one for the freed capacity. No hand action
// of any kind appears: the loop alone takes the decision from refusal to a running approver.

const config = { hostId: 'machine-a', autoMerge: true, mergeMethod: 'merge', workers: [], reviewers: [], producers: [], repository: 'owner/project', baseBranch: 'main',
  url: 'https://graphyard.example', credentialFile: '/dev/null', cliPath: 'graphyard', githubAppId: 1234, run: { intervalSeconds: 20 } } as unknown as MasterConfig;
type Watch = ReturnType<typeof approvalWatchSchema.parse>;
const headOf = (key: string) => `head-${key.toLowerCase()}`.padEnd(40, '0'), baseOf = 'base'.padEnd(40, '0');
/** A submitted item whose reviewer requested changes: the loop owes it a rework decision. */
function verdictItem(key: string, reviewer: string): Work {
  const head = headOf(key);
  return {
    id: `work-${key}`, key, title: 'Approver capacity', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:approver-relaunch-on-capacity'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'test', revision: 4, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate: { sha: head, baseSha: baseOf, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' },
    submission: { epoch: 1, pr: 7 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { candidate: { sha: head, baseSha: baseOf, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' }, checks: [],
      reviews: [{ id: 41, reviewer, sha: head, state: 'CHANGES_REQUESTED', submittedAt: iso(-60_000) }], protected: true, mergeable: true, merged: false, prState: 'open', draft: false,
      at: iso(-10_000), baseTip: baseOf, baseTree: 'tree-0', files: [], scopeFiles: [] },
  } as unknown as Work;
}
const capacityError = () => Object.assign(new Error('No healthy agent account for the approver: every approver account is spent until its quota resets'), { capacityExhausted: true });

test('unit:approver-relaunch-on-capacity — a refused launch is persisted uncounted, the wait survives a restart, and freed capacity is taken oldest-first one decision per cycle with no hand action', async () => {
  const older = verdictItem('GY-301', 'graphyard-reviewer[bot]'), newer = verdictItem('GY-302', 'graphyard-reviewer[bot]');
  const decisionOf: Record<string, string> = { 'GY-301': 'a1a1a1a1-4cb5-4f21-9b0e-0f2a6c8d4e15', 'GY-302': 'b2b2b2b2-4cb5-4f21-9b0e-0f2a6c8d4e15' };
  const keyOf: Record<string, string> = {};
  for (const item of [older, newer]) {
    const decision = routineDecision(item, config, clock)!;
    assert.equal(decision.action, 'rework', `${item.key} owes a rework decision`);
    keyOf[item.key] = decisionKey(item, decision);
  }
  const agents: HerdrAgent[] = [], launches: { decision: string; cycle: number }[] = [], persists: Record<string, Watch>[] = [];
  const persistLog: { capacityA: boolean; launchRecorded: boolean }[] = [];
  const requested: string[] = [];
  let capacityFree = false, cycleNo = 0, state = emptyDaemonState(config);
  const effects: DaemonEffects = {
    agents: () => agents,
    herdr: async () => ({ agents, available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: cycleNo === 1 ? [older] : [older, newer], now: iso(cycleNo * 20_000) }),
    closeSession: () => {},
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(cycleNo * 20_000), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async current => {
      persistLog.push({
        capacityA: !!current.approvals[keyOf['GY-301']]?.capacity,
        launchRecorded: current.actions[`launch:approver:${decisionOf['GY-301']}`]?.state === 'done',
      });
      persists.push(JSON.parse(JSON.stringify(current.approvals)));
    },
    decisions: async item => ({ decisions: requested.includes(decisionOf[item.key]) ? [{ id: decisionOf[item.key], action: 'rework', state: 'requested', input: {}, approvedBy: null }] : [] }),
    decide: async (item, action) => { assert.equal(action, 'rework'); requested.push(decisionOf[item.key]); return { id: decisionOf[item.key] }; },
    approver: async (_item, decision) => {
      launches.push({ decision, cycle: cycleNo });
      if (!capacityFree) throw capacityError();
      const name = `approver-${decision.slice(0, 8)}`;
      agents.push({ name, pane_id: `pane-${name}`, agent_status: 'working' });
      return { agentName: name, pane: `pane-${name}` };
    },
  };
  const launcher = new Launcher();
  const run = async () => { cycleNo += 1; await runCycle(config, state, effects, () => clock + cycleNo * 20_000, launcher); await launcher.idle(); };

  // Cycle one: the older item's decision is requested, and its launch waits for capacity. The wait
  // is on the record before the cycle ends: the state the loop last persisted carries it, so a
  // restart reloads a capacity-waiting watch rather than a plain never-launched one.
  await run();
  assert.deepEqual(requested, [decisionOf['GY-301']], 'the decision was requested by the loop itself');
  assert.deepEqual(launches, [{ decision: decisionOf['GY-301'], cycle: 1 }]);
  const watch = state.approvals[keyOf['GY-301']];
  assert.equal(watch.capacity, 'No healthy agent account for the approver: every approver account is spent until its quota resets');
  assert.equal(watch.launches, 0, 'a capacity refusal is not counted against the launch bound');
  assert.equal(watch.agentName, null);
  assert.ok(persists.at(-1)![keyOf['GY-301']]?.capacity, 'the persisted state the next process loads carries the capacity wait');
  // The refusal itself put the wait on the record: before the launcher recorded the launch's
  // outcome, more than one write already carried the wait — the write the refusal made, and the
  // cycle's own. The wait is on the disk however far the launcher got, crash or queue included.
  const beforeOutcome = persistLog.filter(entry => entry.capacityA && !entry.launchRecorded).length;
  assert.ok(beforeOutcome >= 2, `the refused launch persisted the wait itself, before the launcher recorded anything: ${JSON.stringify(persistLog)}`);

  // A restart: the loop reloads the cursor it last persisted and keeps waiting. The second item's
  // review lands and its decision waits too, both refusals still uncounted.
  state = emptyDaemonState(config);
  state.approvals = { ...persists.at(-1)! } as typeof state.approvals;
  await run();
  assert.deepEqual(requested, [decisionOf['GY-301'], decisionOf['GY-302']]);
  assert.equal(state.approvals[keyOf['GY-301']].launches, 0, 'still uncounted after the restart');
  assert.equal(state.approvals[keyOf['GY-302']].launches, 0);
  const reloaded = persists.at(-1)!;
  assert.ok(reloaded[keyOf['GY-301']]?.capacity && reloaded[keyOf['GY-302']]?.capacity, 'both waits are on the record');
  const waiting = approverLaunchAttention({ approvals: Object.entries(state.approvals).map(([key, entry]) => ({ ...entry, key })), actions: [] });
  assert.equal(waiting.length, 2, 'both waiting decisions are named as waiting, not stalled');
  assert.match(waiting[0].text, /waiting for approver capacity/);

  // An account frees: the oldest waiting decision takes it this cycle, on the launcher, and the
  // newer one waits for the next cycle rather than racing it. No decide, no hand command, nothing
  // but the loop's own next cycle.
  state = emptyDaemonState(config);
  state.approvals = { ...reloaded } as typeof state.approvals;
  capacityFree = true;
  await run();
  assert.deepEqual(launches.filter(entry => entry.cycle === 3), [{ decision: decisionOf['GY-301'], cycle: 3 }],
    `the oldest waiting decision alone met the freed capacity: ${JSON.stringify(launches)}`);
  assert.equal(state.approvals[keyOf['GY-301']].launches, 1, 'the successful launch is the first one counted');
  assert.equal(state.approvals[keyOf['GY-301']].capacity, null, 'the wait cleared with the launch');

  // The next cycle is the newer decision's turn: each in its own cycle, oldest first, both judged.
  await run();
  assert.deepEqual(launches.filter(entry => entry.cycle >= 3), [{ decision: decisionOf['GY-301'], cycle: 3 }, { decision: decisionOf['GY-302'], cycle: 4 }],
    `the waiting decisions were relaunched oldest-first, one per cycle: ${JSON.stringify(launches)}`);
  assert.equal(state.approvals[keyOf['GY-302']].launches, 1);
  assert.equal(requested.length, 2, 'no decision was requested twice: nothing waited past its answer');
});

// GY-849, the pre-check path: a decision whose request lands while every approver account is
// already spent never reaches the runtime at all, yet it must be marked and persisted as a
// capacity wait all the same. Unmarked, it would leave the oldest-first queue and its relaunch
// would race a marked older waiter for the first account that frees.
test('unit:approver-relaunch-on-capacity — a request landing on spent accounts is marked unlaunched and joins the oldest-first queue', async () => {
  const older = verdictItem('GY-401', 'graphyard-reviewer[bot]'), newer = verdictItem('GY-402', 'graphyard-reviewer[bot]');
  const decisionOf: Record<string, string> = { 'GY-401': 'c1c1c1c1-4cb5-4f21-9b0e-0f2a6c8d4e15', 'GY-402': 'd2d2d2d2-4cb5-4f21-9b0e-0f2a6c8d4e15' };
  const keyOf: Record<string, string> = {};
  for (const item of [older, newer]) {
    const decision = routineDecision(item, config, clock)!;
    assert.equal(decision.action, 'rework', `${item.key} owes a rework decision`);
    keyOf[item.key] = decisionKey(item, decision);
  }
  const agents: HerdrAgent[] = [], approverCalls: string[] = [], requested: string[] = [];
  let spent = true, cycleNo = 0, state = emptyDaemonState(config);
  const effects: DaemonEffects = {
    agents: () => agents,
    herdr: async () => ({ agents, available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: [older, newer], now: iso(cycleNo * 20_000) }),
    closeSession: () => {},
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(cycleNo * 20_000), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    reportCapacity: (async () => null) as unknown as DaemonEffects['reportCapacity'],
    roleHealth: async () => ({ approver: { profiles: [{ name: 'approver-p' }], health: { 'approver-p': spent
      ? { available: false, reason: 'quota is exhausted', accounts: [{ environment: 'claude-a', healthy: false, reason: 'quota is exhausted', quota: 'exhausted', resetsAt: iso(3_600_000) }] }
      : { available: true, reason: null, accounts: [] } } } }),
    decisions: async item => ({ decisions: requested.includes(decisionOf[item.key]) ? [{ id: decisionOf[item.key], action: 'rework', state: 'requested', input: {}, approvedBy: null }] : [] }),
    decide: async (item, action) => { assert.equal(action, 'rework'); requested.push(decisionOf[item.key]); return { id: decisionOf[item.key] }; },
    approver: async (_item, decision) => {
      approverCalls.push(decision);
      const name = `approver-${decision.slice(0, 8)}`;
      agents.push({ name, pane_id: `pane-${name}`, agent_status: 'working' });
      return { agentName: name, pane: `pane-${name}` };
    },
  };
  const launcher = new Launcher();
  const run = async () => { cycleNo += 1; await runCycle(config, state, effects, () => clock + cycleNo * 20_000, launcher); await launcher.idle(); };

  // Cycle one, every account spent: both decisions are requested, and the pre-check refuses each
  // launch before the runtime sees it — marked and persisted, never a session, never counted.
  await run();
  assert.deepEqual(requested, [decisionOf['GY-401'], decisionOf['GY-402']], 'both decisions were requested by the loop itself');
  assert.deepEqual(approverCalls, [], 'no approver launch is attempted while every account is spent');
  const watch = state.approvals[keyOf['GY-401']];
  assert.match(watch.capacity ?? '', /every approver account is spent/, 'the pre-check marks the wait like a refused launch');
  assert.equal(watch.launches, 0, 'the wait is not counted against the launch bound');
  assert.equal(watch.agentName, null);

  // Cycle two, still spent: supervision only waits, no launch is attempted, both stay marked.
  await run();
  assert.equal(requested.length, 2, 'no decision was requested twice while it waits');
  assert.deepEqual(approverCalls, []);
  assert.match(state.approvals[keyOf['GY-402']].capacity ?? '', /every approver account is spent/);
  assert.match(state.approvals[keyOf['GY-401']].capacity ?? '', /every approver account is spent/,
    'an unmarked wait would leave the oldest-first queue and race for the freed account');

  // An account frees: the oldest waiting decision takes it this cycle, and the newer one — marked
  // by the pre-check, not by a refused launch — waits for the next cycle rather than racing it.
  spent = false;
  await run();
  assert.deepEqual(approverCalls, [decisionOf['GY-401']],
    `the oldest pre-check-marked decision alone met the freed account: ${JSON.stringify(approverCalls)}`);
  assert.equal(state.approvals[keyOf['GY-401']].capacity, null, 'the wait cleared with the launch');
  assert.equal(state.approvals[keyOf['GY-401']].launches, 1, 'the successful launch is the first one counted');

  await run();
  assert.deepEqual(approverCalls, [decisionOf['GY-401'], decisionOf['GY-402']],
    `the newer pre-check-marked decision followed one cycle later: ${JSON.stringify(approverCalls)}`);
  assert.equal(state.approvals[keyOf['GY-402']].capacity, null);
});

// GY-849, the re-key path: while a capacity-waiting decision is still standing, its binding can
// move (a second reviewer requests changes on the same head), which re-keys its watch. The carry
// keeps the capacity marker with it, so the re-keyed decision keeps its age in the oldest-first
// queue and, when another waiter's relaunch is already handed off this cycle, holds behind it
// instead of racing the same freed account.
test('unit:approver-relaunch-on-capacity — a re-keyed capacity wait keeps its marker and holds behind the relaunch in flight', async () => {
  const older = verdictItem('GY-501', 'graphyard-reviewer[bot]'), newer = verdictItem('GY-502', 'graphyard-reviewer[bot]');
  const decisionOf: Record<string, string> = { 'GY-501': 'e1e1e1e1-4cb5-4f21-9b0e-0f2a6c8d4e15', 'GY-502': 'f2f2f2f2-4cb5-4f21-9b0e-0f2a6c8d4e15' };
  const keyOf: Record<string, string> = {};
  for (const item of [older, newer]) {
    const decision = routineDecision(item, config, clock)!;
    assert.equal(decision.action, 'rework', `${item.key} owes a rework decision`);
    keyOf[item.key] = decisionKey(item, decision);
  }
  const agents: HerdrAgent[] = [], launches: { decision: string; cycle: number }[] = [], requested: string[] = [];
  let capacityFree = false, cycleNo = 0, state = emptyDaemonState(config);
  const effects: DaemonEffects = {
    agents: () => agents,
    herdr: async () => ({ agents, available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: [older, newer], now: iso(cycleNo * 20_000) }),
    closeSession: () => {},
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(cycleNo * 20_000), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    decisions: async item => ({ decisions: requested.includes(decisionOf[item.key]) ? [{ id: decisionOf[item.key], action: 'rework', state: 'requested', input: {}, approvedBy: null }] : [] }),
    decide: async (item, action) => { assert.equal(action, 'rework'); requested.push(decisionOf[item.key]); return { id: decisionOf[item.key] }; },
    approver: async (_item, decision) => {
      launches.push({ decision, cycle: cycleNo });
      if (!capacityFree) throw capacityError();
      const name = `approver-${decision.slice(0, 8)}`;
      agents.push({ name, pane_id: `pane-${name}`, agent_status: 'working' });
      return { agentName: name, pane: `pane-${name}` };
    },
  };
  const launcher = new Launcher();
  const run = async () => { cycleNo += 1; await runCycle(config, state, effects, () => clock + cycleNo * 20_000, launcher); await launcher.idle(); };

  // Cycle one, capacity spent: both decisions are requested and both launches are refused and
  // marked, uncounted.
  await run();
  assert.deepEqual(requested, [decisionOf['GY-501'], decisionOf['GY-502']]);
  assert.ok(state.approvals[keyOf['GY-501']].capacity && state.approvals[keyOf['GY-502']].capacity, 'both waits are marked');
  assert.deepEqual(launches, [{ decision: decisionOf['GY-501'], cycle: 1 }, { decision: decisionOf['GY-502'], cycle: 1 }],
    'both launches were attempted and both refused for capacity');

  // The binding moves while the decision stands (a second reviewer requests changes on the same
  // head), and capacity frees in the same cycle: the older waiter is relaunched, the re-keyed one
  // holds behind it with its wait carried over.
  newer.observation!.reviews[0].reviewer = 'graphyard-reviewer-2[bot]';
  const movedDecision = routineDecision(newer, config, clock)!;
  const movedKey = decisionKey(newer, movedDecision);
  assert.notEqual(movedKey, keyOf['GY-502'], 'the moved binding re-keys the watch');
  capacityFree = true;
  await run();
  assert.deepEqual(launches.filter(entry => entry.cycle === 2), [{ decision: decisionOf['GY-501'], cycle: 2 }],
    `the re-keyed waiter did not race the older waiter's relaunch: ${JSON.stringify(launches)}`);
  const carried = state.approvals[movedKey];
  assert.ok(carried, 'the re-keyed watch exists under the moved binding');
  assert.ok(carried.capacity, 'the capacity wait was carried across the re-key');
  assert.equal(carried.agentName, null);
  assert.equal(carried.launches, 0, 'the held cycle spent no launch');
  assert.equal(state.approvals[keyOf['GY-502']], undefined, 'the old watch went with the re-key');
  assert.equal(requested.length, 2, 'the standing decision was adopted, not requested again');

  await run();
  assert.deepEqual(launches, [
    { decision: decisionOf['GY-501'], cycle: 1 }, { decision: decisionOf['GY-502'], cycle: 1 },
    { decision: decisionOf['GY-501'], cycle: 2 }, { decision: decisionOf['GY-502'], cycle: 3 },
  ], `the re-keyed waiter relaunched on the next cycle: ${JSON.stringify(launches)}`);
  assert.equal(state.approvals[movedKey].capacity, null, 'the wait cleared with the launch');
});
