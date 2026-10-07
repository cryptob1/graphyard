import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { buildMasterStatus, masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';
import type { BaseRefresh } from '../src/merge-queue.js';
import { conflictReworkBoundMs, conflictReworkDue } from '../src/model/approval.js';
import { docsSyncRoute } from '../src/daemon/docs-sync-route.js';
import { routineDecision } from '../src/daemon/decisions.js';
import { docsSyncSessionName, type DocsSyncPlan } from '../src/docs-sync.js';
import { loopRework } from '../src/cli/hand-rework.js';
import { faultClassOf } from '../src/model/fault-classes.js';

/**
 * GY-1434. On 2026-10-07 GY-1419's candidate 69dcd419da45 (PR #904) was recorded conflicting with three
 * successive base tips — 1ed7e5a9de06 at 07:42:04Z, 6cc15b6412a1 at 07:47:17Z, 2c6f5bdb3095 at
 * 08:07:01Z — while the item sat unclaimed with six idle workers. The loop's decisions step had routed the
 * docs-page conflict to a docs-sync session, which held the item for its whole 30-minute bound, and no
 * rework decision was requested between 07:30:10Z and 08:12Z. The doctor's `master decide GY-1419 rework`
 * was refused (the round is the loop's) without naming that the round was overdue, and master status
 * named the conflict to a master and an approver who could not act on it.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const at = (time: string) => Date.parse(`2026-10-07T${time}Z`);
const iso = (ms: number) => new Date(ms).toISOString();
const minute = 60_000;
const head = '69dcd419da45eefde1840d88db515a3cedb101e5', bound = '8bbd387f594f23cdbeb6d9bcb048f2526d89b3e3';
const tips = { first: '1ed7e5a9de06' + '0'.repeat(28), second: '6cc15b6412a17a8cdfdfc68ae022f88fab742d85', third: '2c6f5bdb30957926e73c570ec10f272be31f0d69' };
const recorded = { [tips.first]: at('07:42:04'), [tips.second]: at('07:47:17'), [tips.third]: at('08:07:01') };
const since = iso(at('07:42:04'));
const paths = ['docs/setup-from-zero.md'];

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

/** GY-1419 as the board held it: submitted epoch 6, unclaimed, its build gate failing on the conflict with base tip `tip`. */
function gy1419(tip: string, observedAt: number, systemDriven = true): Work {
  const candidate = { sha: head, baseSha: bound, pr: 904, branch: 'graphyard/gy-1419-1', author: 'worker' };
  const conflict = `Candidate ${head.slice(0, 12)} cannot be brought onto base branch tip ${tip.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved`;
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, baseTip: tip, baseTipContained: false, conflicting: true,
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: false, merged: false, mergeSha: null,
    files: ['src/up.ts', ...paths], scopeFiles: [], at: iso(observedAt), prState: 'open', draft: false,
  } as unknown as Observation;
  const baseRefresh: BaseRefresh = { from: { sha: head, baseSha: bound }, base: tip, baseTree: 'e'.repeat(40), policyRevision: 6, at: iso(recorded[tip]), head: null,
    conflict, merge: null, carry: null, trigger: 'conflict confirmed', conflictPaths: [...paths, 'tests/helpers/timing-baseline.json'], conflictSince: since };
  return {
    id: 'a8ec9c1d-2b3f-4362-8bd6-8a11ce8c63c7', key: 'GY-1419', title: 'graphyard up and the Setup wizard', description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:up'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/up.ts', ...paths], stage: 'build', revision: 40, policyRevision: 6, createdAt: iso(at('05:00:00')), updatedAt: iso(observedAt),
    stageEnteredAt: iso(recorded[tip]), ready: true, epoch: 6, lease: null, workspaces: [], submission: { epoch: 6, pr: 904 }, systemDriven,
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, baseRefresh, blocker: null, violations: [],
    gates: [{ name: 'build', passed: false, reasons: [conflict] }, { name: 'merge', passed: false, reasons: ['Pull request is not mergeable against the current base'] }],
  } as Work;
}

function launch(record: { synced: DocsSyncPlan[]; agents: string[] }) {
  return async (_item: Work, plan: DocsSyncPlan) => {
    const name = docsSyncSessionName(plan);
    record.synced.push(plan); record.agents.push(name);
    return { agentName: name, pane: 'pane-s', account: 'reviewer-a', runtime: 'claude' as const, session: null };
  };
}

test('unit:system-driven-conflict-rework-requested — a docs-sync holds a system-driven conflict only inside the rework\'s 10-minute bound, then gives it up in the same cycle', async () => {
  // The bound: one decision cycle after the grounds, at most ten minutes from the conflict first recorded on the head.
  assert.equal(conflictReworkBoundMs, 10 * minute);
  const due = conflictReworkDue(gy1419(tips.second, at('07:48:00')), at('07:48:00'))!;
  assert.deepEqual(due, { binding: `${head}:conflict`, since, dueAt: '2026-10-07T07:52:04.000Z', overdueMs: 0 }, 'it runs from conflictSince, standing on every later tip');
  assert.equal(conflictReworkDue(gy1419(tips.third, at('08:07:30')), at('08:07:30'))!.overdueMs, at('08:07:30') - at('07:52:04'));
  assert.equal(conflictReworkDue(gy1419(tips.third, at('08:07:30'), false), at('08:07:30')), null, 'a hand-driven item is the master\'s to rework');
  assert.equal(conflictReworkDue({ ...gy1419(tips.third, at('08:07:30')), reworkRequested: true }, at('08:07:30')), null, 'a requested round owes nothing');
  assert.deepEqual(routineDecision(gy1419(tips.first, at('07:42:30')), config(), at('07:42:30'))?.binding, `${head}:conflict`, 'the item calls for the loop\'s conflict rework');

  const state = emptyDaemonState(config()), record = { synced: [] as DocsSyncPlan[], agents: [] as string[] }, notes: string[] = [];
  const route = (work: Work, now: number) => docsSyncRoute({ config: { baseBranch: 'main' }, state, snapshot: { work: [work] }, stamp: iso(now), clock: now, inventorySpent: () => {},
    effects: { docsSync: launch(record), conflictPaths: async () => paths, persist: async () => {}, closeSession: async () => { record.agents.length = 0; } },
    sessions: async () => ({ agents: record.agents.map(name => ({ name, pane_id: 'pane-s', agent_status: 'working' }) as any), available: true }),
    note: async (_key, _item, _kind, outcome, detail) => { notes.push(`${outcome}: ${detail}`); } });
  // 07:42:30: the docs-page conflict is routed to a docs-sync session, inside the bound.
  assert.equal(await route(gy1419(tips.first, at('07:42:20')), at('07:42:30')).holds(gy1419(tips.first, at('07:42:20'))), true);
  assert.equal(record.synced.length, 1);
  // 07:47:30, the second tip: the running session still holds the item (GY-1423).
  assert.equal(await route(gy1419(tips.second, at('07:47:20')), at('07:47:30')).holds(gy1419(tips.second, at('07:47:20'))), true);
  // 07:52:10, past the bound, the session still running and the head unmoved: given up at once, no observation waited for.
  assert.equal(await route(gy1419(tips.second, at('07:51:50')), at('07:52:10')).holds(gy1419(tips.second, at('07:51:50'))), false, 'the docs-sync releases the conflict to the rework');
  assert.match(notes.at(-1)!, /^failed: GY-1419: docs-sync session gy-docs-sync-gy-1419-69dcd41 had not moved 69dcd419da45 when the rework's bound passed: the conflict was first recorded on 69dcd419da45 at 2026-10-07T07:42:04.000Z, and the loop requests its rework within 10 minutes of that \(due at 2026-10-07T07:52:04.000Z\), so the conflict returns to a worker$/);
  assert.equal(record.agents.length, 0, 'its session is closed');
  assert.equal(state.conflicts[0].route, 'rework', 'and the routed conflict is counted as sent back');

  // A conflict first classified past the bound launches no docs-sync at all.
  const late = emptyDaemonState(config()), none = { synced: [] as DocsSyncPlan[], agents: [] as string[] };
  const lateRoute = docsSyncRoute({ config: { baseBranch: 'main' }, state: late, snapshot: { work: [] }, stamp: iso(at('08:07:30')), clock: at('08:07:30'), inventorySpent: () => {},
    effects: { docsSync: launch(none), conflictPaths: async () => paths, persist: async () => {}, closeSession: async () => {} },
    sessions: async () => ({ agents: [], available: true }), note: async () => {} });
  assert.equal(await lateRoute.holds(gy1419(tips.third, at('08:07:20'))), false);
  assert.deepEqual(none.synced, [], 'no docs-sync is launched past the bound');
  assert.deepEqual(late.conflicts.map(entry => entry.route), ['rework']);

  // A hand-driven item keeps the docs-sync's own 30-minute bound.
  const hand = emptyDaemonState(config()), handRecord = { synced: [] as DocsSyncPlan[], agents: [] as string[] };
  const handRoute = (now: number) => docsSyncRoute({ config: { baseBranch: 'main' }, state: hand, snapshot: { work: [] }, stamp: iso(now), clock: now, inventorySpent: () => {},
    effects: { docsSync: launch(handRecord), conflictPaths: async () => paths, persist: async () => {}, closeSession: async () => {} },
    sessions: async () => ({ agents: handRecord.agents.map(name => ({ name, pane_id: 'pane-s', agent_status: 'working' }) as any), available: true }), note: async () => {} });
  assert.equal(await handRoute(at('07:42:30')).holds(gy1419(tips.first, at('07:42:20'), false)), true);
  assert.equal(await handRoute(at('07:52:10')).holds(gy1419(tips.second, at('07:51:50'), false)), true);
});

test('integration:conflict-rework-decision-cycle — replaying GY-1419 through the loop\'s cycles, the rework is requested in the first cycle past the bound, not after the docs-sync\'s 30 minutes', async () => {
  const decided: { action: string; binding: unknown; at: number }[] = [], record = { synced: [] as DocsSyncPlan[], agents: [] as string[] };
  let item = gy1419(tips.first, at('07:42:20')), now = at('07:42:30');
  const effects = (): DaemonEffects => ({
    agents: () => [], herdr: () => ({ agents: record.agents.map((name, index) => ({ name, pane_id: `pane-${index}`, agent_status: 'working' })), available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: [item], now: iso(now), jobs: [] }),
    closeSession: () => { record.agents.length = 0; }, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work, action, _reason, input) => { decided.push({ action, binding: (input as { binding?: unknown } | undefined)?.binding, at: now }); return { id: '5d8a8b9e-0000-4000-8000-000000001419' }; },
    decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'gy-approver-gy-1419', pane: 'pane-a' }),
    docsSync: launch(record),
    conflictPaths: async () => paths,
    persist: async () => {},
  });
  const state = emptyDaemonState(config());
  const cycle = (time: string, tip: string) => { now = at(time); item = gy1419(tip, now - 10_000); return runCycle(config(), state, effects(), () => now); };
  await cycle('07:42:30', tips.first);
  assert.equal(record.synced.length, 1, 'the docs-page conflict is first routed to a docs-sync session');
  await cycle('07:47:30', tips.second);
  await cycle('07:50:00', tips.second);
  assert.deepEqual(decided, [], 'inside the bound the docs-sync holds the item');
  const past = await cycle('07:52:10', tips.second);
  assert.deepEqual(decided.map(entry => [entry.action, entry.binding]), [['rework', `${head}:conflict`]], 'the loop requests the conflict rework itself on its grounds binding');
  assert.ok(decided[0].at - Date.parse(since) <= conflictReworkBoundMs + minute, 'within one decision cycle of the bound');
  assert.ok(decided[0].at < at('08:07:01'), 'long before the third tip, where GY-1419 still had none');
  assert.ok(past.actions.some(action => action.work === 'GY-1419' && /when the rework's bound passed/.test(action.detail)));
  assert.equal(record.synced.length, 1, 'no second docs-sync');
});

test('unit:hand-rework-refusal-names-loop-round — a refused hand rework names the loop round it restates and the bound it is overdue against', () => {
  const loopConfig = { autoMerge: true };
  const work = gy1419(tips.third, at('08:11:50'));
  const refusal = loopRework(work, 'rework', { previousWorkerStopped: true }, loopConfig, { now: at('08:12:00'), requestsDecisions: true, baseFailed: new Set(), exhausted: [], mechanical: [] })!;
  assert.ok(refusal.includes(`The round is decision:rework:${work.id}:${head}:conflict:6`), refusal);
  assert.match(refusal, /owed within 10 minutes of the conflict first recorded on this head at 2026-10-07T07:42:04\.000Z \(due at 2026-10-07T07:52:04\.000Z\)/);
  assert.match(refusal, /It is 20 minute\(s\) overdue against that bound, so the loop's decisions step is stalled on it: master status names it as a stalled-step attention/);
  // Inside the bound the same refusal names the round and when it falls due, and claims no stall.
  const early = loopRework(gy1419(tips.first, at('07:44:50')), 'rework', {}, loopConfig, { now: at('07:45:00'), requestsDecisions: true, baseFailed: new Set() })!;
  assert.match(early, /The round is decision:rework:.*:conflict:6, owed within 10 minutes .* \(due at 2026-10-07T07:52:04\.000Z\)/);
  assert.doesNotMatch(early, /overdue|stalled/);
});

test('unit:stalled-decision-attention-on-overdue-rework — master status names the loop\'s overdue conflict rework as a stalled step on the item, owned by no approver', () => {
  const row = (time: string, tip: string) => {
    const status = buildMasterStatus({ work: [gy1419(tip, at(time) - 10_000)], now: iso(at(time)) }, [], []);
    return { row: status.work[0], items: status.attentionItems.filter(item => item.subject === 'GY-1419') };
  };
  // Inside the bound: the conflict, owned by the loop's step that requests it — never a refused hand command for an approver.
  const inside = row('07:47:30', tips.second);
  assert.equal(inside.items.length, 1);
  assert.equal(inside.items[0].kind, 'base-conflict');
  assert.equal(inside.items[0].role, 'control plane');
  assert.equal(inside.items[0].approvedBy, null);
  assert.match(inside.items[0].next, /the loop's decisions step requests GY-1419's rework itself \(due at 2026-10-07T07:52:04\.000Z/);
  assert.doesNotMatch(inside.items[0].next, /master decide/);
  // 08:11:09, the board clock of the report: a stalled-step attention with its subject, in the loop class.
  const stalled = row('08:11:09', tips.third);
  assert.equal(stalled.items.length, 1);
  assert.equal(stalled.items[0].kind, 'stalled-step');
  assert.equal(stalled.items[0].faultClass, 'loop');
  assert.equal(faultClassOf('stalled-step'), 'loop');
  assert.match(stalled.items[0].text, /^The loop's decisions step has not requested GY-1419's conflict rework \(round 69dcd419da45eefde1840d88db515a3cedb101e5:conflict\) within 10 minutes of the conflict first recorded at 2026-10-07T07:42:04\.000Z: it fell due at 2026-10-07T07:52:04\.000Z and is 20 minute\(s\) overdue\. Candidate 69dcd419da45 cannot be brought onto base branch tip 2c6f5bdb3095/);
  assert.equal(stalled.items[0].approvedBy, null);
  assert.match(stalled.items[0].next, /a hand rework of GY-1419 is refused/);
  assert.equal(stalled.row.attention, stalled.items[0].text);
  // A hand-driven item's conflict stays the master's to rework, with its approver.
  const hand = buildMasterStatus({ work: [gy1419(tips.third, at('08:11:00'), false)], now: iso(at('08:11:09')) }, [], []).attentionItems.find(item => item.subject === 'GY-1419')!;
  assert.equal(hand.kind, 'base-conflict');
  assert.equal(hand.approvedBy, 'approver');
});
