import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { RefusedResponse } from '../src/model.js';
import { masterConfigSchema, type MasterConfig, approverSessionName } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import { minute, hour } from './helpers/soak-world.js';
import { basePlan, coordinatorRoot, soakControlPlanes } from './helpers/soak-plane.js';
import { assertLaunchesConfined, simulateDay } from './helpers/soak-simulation.js';

/**
 * Decision faults (GY-1541): the recurring causes of the decision fault class, replayed across the
 * real loop's cycles. One concern of the release-candidate soak (GY-404), split per concern
 * (GY-1363): the loop's own docs-sync cutoff give-up (GY-1515, GY-1530) and a deploying plane's
 * startup-readiness 503 on the agent registry reconcile (isolated:decision:agent-registry) are
 * designed routes and retried states, so neither files a decision fault while every system
 * invariant holds.
 *
 * GY-1888: held-rework adoption and held-name recovery also belong here — they repeat per cycle and
 * item, so the repository review contract (src/reviewer.ts repetitionReviewSection) requires this
 * soak suite cover them over a simulated day. That coverage drives the loop through DaemonEffects
 * (no embedded plane), so it sits outside the plane describe that soakControlPlanes wires.
 */
describe('decision-fault plane soak', () => {
  soakControlPlanes('soak-decision-faults', 416);

  test('unit:soak-invariants-hold — the loop\'s own docs-sync cutoff give-up and a startup-readiness 503 on the registry reconcile, cycle after cycle, file no decision fault, the conflict is reworked once and the registry recovers, with every invariant holding', { timeout: 600_000 }, async () => {
    // The docs-sync outlasts the bound, so the loop stops it at its cutoff and gives the conflict up (GY-1434);
    // meanwhile the plane answers 503 "Startup validation has not completed" to the registry reconcile for
    // 40 minutes (every cycle of them), then answers.
    const day = await simulateDay({ hours: 5, readiness: { from: 20 * minute, to: 60 * minute }, plan: { docsConflict: { ...basePlan.docsConflict, syncMs: 30 * minute } } });
    assertLaunchesConfined(day, coordinatorRoot!);
    const { violations, failures, state, docsSyncRuns, items, final, readinessDay, decideCalls } = day;
    assert.deepEqual(violations, [], 'every system invariant holds');
    assert.deepEqual(failures, [], 'no cycle failed');
    const conflicted = items[basePlan.docsConflict.item - 1].key;
    assert.deepEqual(docsSyncRuns.map(run => [run.plan.key, run.outcome]), [[conflicted, 'stopped']], 'the docs-sync was stopped at its cutoff');
    const giveUps = Object.values(state.actions).filter(action => action.work === conflicted && /docs-sync session .* was stopped at .* without having moved/.test(action.detail));
    assert.equal(giveUps.length, 1, 'the cutoff give-up settled once');
    assert.equal(decideCalls.filter(call => call.key === conflicted && call.action === 'rework').length, 1, 'and the conflict was reworked once');
    assert.ok(readinessDay.refused >= 6, `the registry refused across cycles: ${readinessDay.refused}`);
    assert.ok(readinessDay.answered > 0, 'and then answered');
    // The default plan's own simulated rework failure files its fault elsewhere; these two causes file none.
    assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'decision' && (instance.subject === conflicted || /agent-registry|Startup validation|registry/.test(`${instance.subject} ${instance.text}`))), [], 'no decision fault is filed for either');
    assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
  });
});

/** One decision-history row as DaemonEffects.decisions returns it (GY-1888 review of 92e18d651f). */
type DecisionHistoryRow = NonNullable<Awaited<ReturnType<NonNullable<DaemonEffects['decisions']>>>>['decisions'][number];

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const loopConfig = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  autoMerge: true, mergeMethod: 'merge', workers: [],
});
// Fixed clock handed to runCycle; no wall-clock reading in this file.
const holdClock = Date.parse('2026-10-17T02:00:00Z'), holdBase = 'b'.repeat(40);

/**
 * GY-1888: simulated day through the real loop — repeated held-rework adoption across items and heads,
 * own-name recovery with capacity contention on the relaunch, eventual session cleanup, bounded
 * puts/launches, and every system invariant after every cycle.
 */
test('unit:soak-invariants-hold — over a simulated day, held-rework adoption and held-name recovery across six items stay bounded, capacity waits on a recovery relaunch never fail the decision, leftover sessions are cleaned up, and every invariant holds', { timeout: 300_000 }, async () => {
  const day = 24 * hour, cycleMs = 2 * minute;
  const start = holdClock, iso = (at: number) => new Date(at).toISOString();
  const sha = (n: number, head: number) => `${n}${head}`.padEnd(40, 'a');
  type Kind = 'hold' | 'recover' | 'capacity';
  type Item = {
    key: string; n: number; head: number; kind: Kind; heldId: string; decisionId: string | null;
    leftover: string; registry: string; launches: number; puts: number; leftoverClosed: boolean;
    capacityHits: number; recoveredAt: number | null; appliedAt: number | null;
  };
  const items: Item[] = [0, 1, 2, 3, 4, 5].map(n => ({
    key: `GY-${1880 + n}`, n, head: 1, kind: n < 3 ? 'hold' : n < 5 ? 'recover' : 'capacity',
    heldId: `067c0c4f-0000-4000-8000-${String(1880 + n).padStart(12, '0')}`,
    decisionId: n < 3 ? null : `a17c5808-0000-4000-8000-${String(1880 + n).padStart(12, '0')}`,
    leftover: `w1V:pHOLD${n}`, registry: `registry-hold-${n}`, launches: 0, puts: 0,
    leftoverClosed: false, capacityHits: 0, recoveredAt: null, appliedAt: null,
  }));
  const appliedHold = (item: Item, at: number): DecisionHistoryRow[] => [{
    id: item.heldId, action: 'rework', state: 'applied', input: { previousWorkerStopped: true }, requestedAt: iso(at - hour),
    approvedAt: iso(at - hour + minute), approvedBy: 'graphyard-approver-graphyard',
    situation: { sha: sha(item.n, item.head), baseSha: holdBase }, reason: 'reviewer requested changes',
  }];
  const history = new Map<string, DecisionHistoryRow[]>(items.map(item => [item.key, item.kind === 'hold' ? appliedHold(item, start) : []]));
  const sessions: { name: string; pane: string; status: 'working' | 'done'; key: string; decision: string }[] = [];
  const closed: string[] = [], ended: string[] = [], puts: string[] = [], launches: string[] = [];
  const slotTaken = () => Object.assign(new Error('approver role is at its concurrency limit of 1'), { roleAtCapacity: 'approver role is at its concurrency limit of 1 (1 running)' });
  const settle = (item: Item, at: number) => {
    if (item.appliedAt || !item.decisionId) return;
    const decision = history.get(item.key)!.find(entry => entry.id === item.decisionId);
    if (!decision || decision.state !== 'requested') return;
    Object.assign(decision, { state: 'applied', approvedBy: 'graphyard-approver-graphyard' });
    item.appliedAt = at;
    const session = sessions.find(entry => entry.key === item.key);
    if (session) session.status = 'done';
  };
  const view = (item: Item, at: number): Work => {
    const candidate = { sha: sha(item.n, item.head), baseSha: holdBase, pr: 1800 + item.n, branch: `graphyard/${item.key.toLowerCase()}-${item.head}`, author: 'worker' };
    const waiting = item.kind === 'hold' || !item.appliedAt;
    return {
      id: `00000000-0000-4000-8000-${String(1880 + item.n).padStart(12, '0')}`, key: item.key, title: item.key, description: '', type: 'bug', priority: 1,
      dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
      plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5 + item.head, policyRevision: 1, createdAt: iso(start - 3 * hour), updatedAt: iso(at),
      stageEnteredAt: iso(start - hour), ready: true, epoch: item.head, lease: null, workspaces: [], submission: { epoch: item.head, pr: 1800 + item.n },
      candidate, reworkRequested: !!item.appliedAt, scenarioRequirements: [], evidence: [],
      observation: {
        clockOffset: { min: 0, max: 0 }, candidate,
        checks: [{ name: 'test', result: 'success', appId: 15368 }],
        reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: waiting ? 'CHANGES_REQUESTED' : 'APPROVED', submittedAt: iso(at - 10 * minute) }],
        protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: iso(at - minute),
      },
      blocker: null, violations: [],
      gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: !waiting, reasons: waiting ? ['Outstanding change requests must be resolved through a new review'] : [] }],
    } as unknown as Work;
  };
  const heldName = (item: Item) => {
    const name = approverSessionName({ key: item.key } as Work, item.decisionId!);
    return new Error(`No session can be launched as ${JSON.stringify(name)}: the runtime refused it: {"error":{"code":"agent_name_taken","message":"agent name ${name} is already used; candidates: terminal_id=term_1 pane_id=${item.leftover} workspace_id=w1V tab_id=w1V:tQGM"}}`);
  };
  let now = start;
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: sessions.map(session => ({ name: session.name, pane_id: session.pane, agent: 'claude', agent_status: session.status })), available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: items.map(item => view(item, now)), now: iso(now), jobs: [] }),
    closeSession: pane => {
      closed.push(pane);
      const index = sessions.findIndex(session => session.pane === pane);
      if (index >= 0) sessions.splice(index, 1);
      const item = items.find(entry => entry.leftover === pane);
      if (item) item.leftoverClosed = true;
    },
    dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decisions: async work => ({ decisions: structuredClone(history.get(work.key) ?? []) }),
    decide: async work => {
      const item = items.find(entry => entry.key === work.key)!;
      item.puts += 1; puts.push(work.key);
      if (item.kind === 'hold') {
        throw new RefusedResponse(`Graphyard refused work/${work.id}/decide (409): ${item.key} already holds rework: decision ${item.heldId} was applied for head ${sha(item.n, item.head).slice(0, 12)} and no worker has submitted since, so the item waits for a worker on it and a second rework authorizes nothing`, 409, { heldRework: { decision: item.heldId } });
      }
      const id = item.decisionId ?? randomUUID();
      item.decisionId = id;
      if (!history.get(item.key)!.some(entry => entry.id === id)) {
        history.get(item.key)!.push({ id, action: 'rework', state: 'requested', input: {}, approvedBy: null, requestedAt: iso(now) });
      }
      return { id };
    },
    approver: async (work, decision) => {
      const item = items.find(entry => entry.key === work.key)!;
      item.launches += 1; launches.push(`${work.key}:${decision}`);
      if (!item.leftoverClosed) throw heldName(item);
      // After the leftover is gone, the capacity item loses the slot twice, then launches.
      if (item.kind === 'capacity' && item.capacityHits < 2) { item.capacityHits += 1; throw slotTaken(); }
      const name = approverSessionName(work, decision), pane = `w1V:pNEW${item.n}`;
      item.recoveredAt = now;
      sessions.push({ name, pane, status: 'working', key: item.key, decision });
      return { agentName: name, pane };
    },
    approverLaunch: async name => {
      const item = items.find(entry => entry.decisionId && approverSessionName({ key: entry.key } as Work, entry.decisionId) === name);
      return item && !item.leftoverClosed ? { account: null, runtime: 'claude', session: item.registry, pane: item.leftover } : null;
    },
    endRegistrySession: async session => { ended.push(session); },
    persist: async () => {},
  };
  const state = emptyDaemonState(loopConfig());
  const violations: string[] = [];
  const failedDecisions: string[] = [];
  let secondHeadAt: number | null = null;
  for (let cycle = 0; now < start + day; cycle++, now += cycleMs) {
    // Second head for each hold item once, so adoption repeats across heads.
    if (secondHeadAt === null && now >= start + 4 * hour) {
      secondHeadAt = now;
      for (const item of items.filter(entry => entry.kind === 'hold')) {
        item.head = 2;
        history.set(item.key, appliedHold(item, now));
        for (const [key, watch] of Object.entries(state.approvals)) if (watch.work === item.key) delete state.approvals[key];
      }
    }
    // Approvers judge within one cycle of a successful recovery launch, well inside the unanswered bound.
    for (const item of items) if (item.recoveredAt !== null && now >= item.recoveredAt + cycleMs) settle(item, now);
    await runCycle(loopConfig(), state, effects, () => now);
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${cycle}: ${check.line}`);
    for (const action of Object.values(state.actions)) {
      if (action.kind === 'decision' && action.state === 'failed' && /agent_name_taken|concurrency limit|capacity/.test(action.detail)) {
        failedDecisions.push(`${iso(now)} ${action.work}: ${action.detail.slice(0, 120)}`);
      }
    }
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failedDecisions, [], 'a capacity wait on a recovery relaunch never becomes a failed decision action');
  for (const item of items.filter(entry => entry.kind === 'hold')) {
    assert.ok(item.puts >= 1 && item.puts <= 3, `${item.key}: held rework was put at most a few times before adoption across both heads (${item.puts})`);
    assert.equal(item.launches, 0, `${item.key}: an adopted hold launches no approver`);
    assert.ok(Object.values(state.actions).some(action => action.work === item.key && /already holds rework decision/.test(action.detail)), `${item.key}: the hold was adopted`);
  }
  for (const item of items.filter(entry => entry.kind !== 'hold')) {
    assert.equal(item.leftoverClosed, true, `${item.key}: the leftover pane was closed`);
    assert.ok(ended.includes(item.registry), `${item.key}: its registry session was ended`);
    assert.ok(item.launches >= 2 && item.launches <= 6, `${item.key}: recovery relaunches stay bounded (${item.launches})`);
    assert.ok(item.puts <= 2, `${item.key}: the decision is requested once (${item.puts})`);
    assert.ok(item.appliedAt !== null, `${item.key}: the recovered decision was applied`);
  }
  const capacity = items.find(entry => entry.kind === 'capacity')!;
  assert.equal(capacity.capacityHits, 2, 'the capacity item waited through two contended recovery relaunches');
  assert.ok(capacity.recoveredAt !== null, 'and then launched once a slot freed');
  assert.ok(Object.values(state.approvals).every(watch => !watch.capacity), 'no capacity wait lingers at the end of the day');
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'decision'), [], 'no decision fault is filed across the day');
  for (const item of items.filter(entry => entry.appliedAt)) {
    const name = approverSessionName({ key: item.key } as Work, item.decisionId!);
    assert.ok(!sessions.some(session => session.name === name), `${item.key}: no approver session lingers`);
  }
  assert.ok(puts.length <= 20, `puts across the day stay bounded: ${puts.length}`);
  assert.ok(launches.length <= 30, `launches across the day stay bounded: ${launches.length}`);
  assert.ok(secondHeadAt !== null, 'the hold items moved to a second head during the day');
});
