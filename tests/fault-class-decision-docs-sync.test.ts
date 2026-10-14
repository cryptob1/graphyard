import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { RefusedResponse } from '../src/model/refusal.js';
import type { Observation, Work } from '../src/model.js';
import type { BaseRefresh } from '../src/merge-queue.js';
import { docsSyncSessionName, type DocsSyncPlan } from '../src/docs-sync.js';

/**
 * GY-1430 names this file for its proof: manual:fault-class-decision. The master loop filed 3
 * decision faults in 24 hours on 7 October 2026, two from the docs-sync route and one from a rework
 * bound to a head the worker had already replaced:
 *
 * - action:decision|GY-1424|2026-10-07T06:31:47.748Z — docs-sync session gy-docs-sync-gy-1424-59dfc7c
 *   was running (launched 06:28 against base 52146cf3943c) when the base moved to 98478c257ce7; the
 *   loop held no watch for it, tried to launch it again, was refused "already visible in Herdr" and
 *   sent the conflict to a worker while the session still ran. The visible session is now adopted.
 * - action:decision|GY-1417|2026-10-07T07:06:08.907Z — the cycle's snapshot showed candidate
 *   e303a7c75cae with a failed required check; the worker submitted a5581e5c9d86 at 07:05:51, so the
 *   server refused the rework bound to e303a7c75cae (409). The item moved after the snapshot: the
 *   refusal judged nothing, as GY-1405 treats an item delivered meanwhile.
 * - action:decision|GY-1416|2026-10-07T07:09:56.473Z — docs-sync session gy-docs-sync-gy-1416-8798afd
 *   went idle at 06:39:20, a minute after its launch, without pushing — its instruction stops the
 *   session when it aborts — and the loop waited out the 30-minute bound because the idle pane stayed
 *   listed. A session stopped for docsSyncStoppedMs is now taken as ended: the conflict goes to a
 *   worker within minutes, by the route the instruction names, which is no decision fault.
 *
 * Each instance is replayed through the loop's own cycles. Against the base each records a decision
 * fault; against the candidate none, while the faults the class exists for still count.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const minute = 60_000;
const paths = ['docs/master-agent-reference.md'];
const decisionFaults = (state: ReturnType<typeof emptyDaemonState>) => state.faults.instances.filter(instance => instance.faultClass === 'decision');

/** A submitted, approved item whose base refresh confirmed a docs-only conflict of `head` with base tip `base`, observed at `observedAt`. */
function conflicted(key: string, head: string, bound: string, base: string, observedAt: string): Work {
  const candidate = { sha: head, baseSha: bound, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, baseTip: base, baseTipContained: false, conflicting: true,
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'independent-reviewer', sha: head, state: 'APPROVED', submittedAt: observedAt }],
    protected: true, mergeable: false, merged: false, mergeSha: null, files: ['src/loop.ts', ...paths], scopeFiles: [], at: observedAt, prState: 'open', draft: false,
  } as unknown as Observation;
  const baseRefresh: BaseRefresh = { from: { sha: head, baseSha: bound }, base, baseTree: 'e'.repeat(40), policyRevision: 1, at: observedAt, head: null,
    conflict: `Candidate ${head.slice(0, 12)} cannot be brought onto base branch tip ${base.slice(0, 12)} without resolving a conflict`, merge: null, carry: null, trigger: 'conflict confirmed', conflictPaths: paths };
  return {
    id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`, key, title: key, description: '', type: 'bug', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts', ...paths], stage: 'merge', revision: 5, policyRevision: 1, createdAt: observedAt, updatedAt: observedAt,
    stageEnteredAt: observedAt, ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, baseRefresh, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'merge', passed: false, reasons: ['Pull request is not mergeable against the current base'] }],
  } as Work;
}

/** The loop's effects around one item; the docs-sync launcher refuses a name already visible in Herdr, as the real one does. */
function effects(item: () => Work, at: () => number, herdr: { agents: { name: string; status: string }[] }, decided: string[], overrides: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: herdr.agents.map((agent, index) => ({ name: agent.name, pane_id: `pane-${index}`, agent_status: agent.status })), available: true }),
    credentials: async () => ({}), snapshot: async () => ({ work: [item()], now: new Date(at()).toISOString(), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(at()).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work, action) => { decided.push(action); return { id: '5d8a8b9e-0000-4000-8000-000000000001' }; },
    decisions: async () => ({ decisions: [] }), approver: async () => ({ agentName: 'graphyard-approver', pane: 'pane-a' }),
    docsSync: async (_work, plan: DocsSyncPlan) => {
      const name = docsSyncSessionName(plan);
      if (herdr.agents.some(agent => agent.name === name)) throw new Error(`Docs-sync session ${name} is already visible in Herdr; let it finish first`);
      herdr.agents.push({ name, status: 'working' });
      return { agentName: name, pane: 'pane-s', account: 'reviewer-a', runtime: 'claude', session: null };
    },
    conflictPaths: async () => paths, persist: async () => {},
    ...overrides,
  };
}

test('manual:fault-class-decision — action:decision|GY-1424|2026-10-07T06:31:47.748Z: a docs-sync session already running when the loop holds no watch is adopted, not refused', async () => {
  const head = '59dfc7ca8ceda6bf40badebdf6ae17f5c0e65249', bound = '059bf0f2b05b4274811a1e65d548a2fa891b362a', moved = '98478c257ce71d2f8c046eb2525018b596923075';
  const clock = Date.parse('2026-10-07T06:31:40Z'), decided: string[] = [];
  // Launched at 06:28 against 52146cf3943c, and running; this loop holds no watch for it.
  const herdr = { agents: [{ name: 'gy-docs-sync-gy-1424-59dfc7c', status: 'working' }] };
  let at = clock;
  const item = conflicted('GY-1424', head, bound, moved, '2026-10-07T06:31:08.234Z');
  const state = emptyDaemonState(config());
  const result = await runCycle(config(), state, effects(() => item, () => at, herdr, decided), () => at);
  assert.equal(herdr.agents.length, 1, 'no second session is launched');
  assert.deepEqual(decided, [], 'no rework is requested while the session runs');
  assert.deepEqual(decisionFaults(state), [], 'the running session judged nothing');
  assert.ok(!result.actions.some(action => /already visible in Herdr|returns to a worker/.test(action.detail)), JSON.stringify(result.actions.map(action => action.detail)));
  assert.ok(result.actions.some(action => /Adopted docs-sync session gy-docs-sync-gy-1424-59dfc7c/.test(action.detail)));
  const [watch] = Object.values(state.docsSyncs);
  assert.equal(watch.agentName, 'gy-docs-sync-gy-1424-59dfc7c');

  // The adopted session ends without moving the head (06:37, its pane vanished): rework follows as before.
  herdr.agents.length = 0; at = clock + 6 * minute;
  await runCycle(config(), state, effects(() => item, () => at, herdr, decided), () => at);
  const later = conflicted('GY-1424', head, bound, moved, new Date(at + 1_000).toISOString());
  at += 20_000;
  await runCycle(config(), state, effects(() => later, () => at, herdr, decided), () => at);
  assert.deepEqual(decided, ['rework'], 'the conflict returns to a worker once the adopted session is gone');
  assert.equal(decisionFaults(state).length, 1, 'a session that vanished without moving the head still counts');
});

test('manual:fault-class-decision — action:decision|GY-1416|2026-10-07T07:09:56.473Z: a docs-sync session that stopped without pushing returns the conflict within minutes, with no fault', async () => {
  const head = '8798afd56bafb5e8da90bd6ea448c147112be37d', bound = '52146cf3943c571e155160118ef991daa3673a8c', tip = '2cca02cd2424cdacbbad18484b5590f61150cc3e';
  const launchedAt = Date.parse('2026-10-07T06:38:00Z'), decided: string[] = [], herdr = { agents: [] as { name: string; status: string }[] };
  let at = launchedAt;
  // Every cycle sees an observation taken just before it, still on the reviewed head.
  const item = () => conflicted('GY-1416', head, bound, tip, new Date(at - 1_000).toISOString());
  const state = emptyDaemonState(config());
  const fx = effects(item, () => at, herdr, decided);
  await runCycle(config(), state, fx, () => at);
  assert.deepEqual(herdr.agents.map(agent => agent.name), ['gy-docs-sync-gy-1416-8798afd'], 'the docs-sync session is launched');
  // 06:39:20 onward its runtime reports idle: the turn ended without a push.
  herdr.agents[0].status = 'idle';
  let returnedAt: number | null = null;
  for (at = Date.parse('2026-10-07T06:39:20Z'); at <= Date.parse('2026-10-07T07:10:00Z') && returnedAt === null; at += minute) {
    await runCycle(config(), state, fx, () => at);
    if (decided.includes('rework')) returnedAt = at;
  }
  assert.ok(returnedAt !== null && returnedAt - Date.parse('2026-10-07T06:39:20Z') <= 5 * minute, `the conflict returns to a worker within minutes of the session stopping, not at the 30-minute bound (${returnedAt && new Date(returnedAt).toISOString()})`);
  assert.deepEqual(decisionFaults(state), [], 'the session took the route its instruction names: no decision fault');
  assert.match(Object.values(state.docsSyncs)[0].failed ?? '', /stopped without moving 8798afd56baf/);

  // A session still working past the 30-minute bound is a fault, as before.
  const busy = { agents: [] as { name: string; status: string }[] }, stuck = emptyDaemonState(config()), reworked: string[] = [];
  const bfx = effects(item, () => at, busy, reworked);
  at = launchedAt; await runCycle(config(), stuck, bfx, () => at);
  for (at = launchedAt + minute; at <= launchedAt + 33 * minute && !reworked.length; at += minute) await runCycle(config(), stuck, bfx, () => at);
  assert.deepEqual(reworked, ['rework']);
  assert.equal(decisionFaults(stuck).length, 1, 'a docs-sync that ran past its bound still counts');
});

test('manual:fault-class-decision — action:decision|GY-1417|2026-10-07T07:06:08.907Z: a rework refused because a new head was submitted after the snapshot is no fault', async () => {
  const head = 'e303a7c75cae2d79da24d44d0bc13de137b35541', submitted = 'a5581e5c9d86887d234092934d52f2d71b8cc2d8', base = '2cca02cd2424cdacbbad18484b5590f61150cc3e';
  const clock = Date.parse('2026-10-07T07:06:00Z'), iso = (offset: number) => new Date(clock + offset).toISOString();
  const candidate = { sha: head, baseSha: base, pr: 893, branch: 'graphyard/gy-1417-1', author: 'worker' };
  const observation = { clockOffset: { min: 0, max: 0 }, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha: head, state: 'CHANGES_REQUESTED' }], protected: true, mergeable: true, merged: false, mergeSha: null,
    files: ['src/loop.ts'], scopeFiles: [], at: iso(-20_000) } as Observation;
  const item = {
    id: '00000000-0000-4000-8000-000000001417', key: 'GY-1417', title: 'GY-1417', description: '', type: 'bug', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5,
    policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(-1_800_000), ready: true, epoch: 7, lease: null, workspaces: [],
    submission: { epoch: 7, pr: 893 }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  } as unknown as Work;
  const refusedOn = (bound: string, current: string) => async (target: Work) => {
    throw new RefusedResponse(`Graphyard refused work/${target.id}/decide (409): The rework is bound to ${bound.slice(0, 12)} but the current candidate is ${current.slice(0, 12)}; its grounds no longer describe the item`, 409, { error: 'stale binding' });
  };
  const state = emptyDaemonState(config()), decided: string[] = [];
  const result = await runCycle(config(), state, effects(() => item, () => clock, { agents: [] }, decided, { decide: refusedOn(head, submitted) }), () => clock);
  const recorded = result.actions.filter(action => action.kind === 'decision' && action.work === 'GY-1417');
  assert.deepEqual(decisionFaults(state), [], 'the refusal judged nothing: the item moved after the snapshot');
  assert.ok(recorded.some(action => /bound to e303a7c75cae/.test(action.detail) && /candidate moved after this cycle's snapshot/.test(action.detail)), JSON.stringify(recorded));

  // A rework bound to a head other than the snapshot's own is the loop's own error, and still counts.
  const other = emptyDaemonState(config());
  await runCycle(config(), other, effects(() => item, () => clock, { agents: [] }, decided, { decide: refusedOn(submitted, 'f'.repeat(40)) }), () => clock);
  assert.equal(decisionFaults(other).length, 1, 'a refusal of a rework bound to another head is a fault');
});

/**
 * GY-1541 names this file for its proof: manual:fault-class-decision. The loop filed 3 decision
 * faults on 8 October 2026: GY-1515 and GY-1530 (06:02Z) from the docs-sync cutoff give-up, the
 * loop's own GY-1434 route, and isolated:decision:agent-registry (07:13Z) from a plane deploy's
 * startup-readiness 503, which the isolate() catch did not know as plane-wide (GY-1375).
 */
for (const [key, instance] of [['GY-1515', '2026-10-08T06:02:22.347Z'], ['GY-1530', '2026-10-08T06:02:30.923Z']] as const) test(`manual:fault-class-decision — action:decision|${key}|${instance}: the cutoff give-up returns the conflict to a worker with no fault`, async () => {
  const head = '9237f0b41c14b6d51bd44d0bc13de137b35541aa', bound = '059bf0f2b05b4274811a1e65d548a2fa891b362a', tip = '2cca02cd2424cdacbbad18484b5590f61150cc3e';
  const launchedAt = Date.parse('2026-10-08T05:52:00Z'), decided: string[] = [], herdr = { agents: [] as { name: string; status: string }[] };
  let at = launchedAt;
  // The conflict was first recorded at 05:51:01Z; its rework is due ten minutes later, the cutoff two minutes before.
  const item = () => { const work = conflicted(key, head, bound, tip, new Date(at - 1_000).toISOString());
    return { ...work, systemDriven: true, baseRefresh: { ...work.baseRefresh!, conflictSince: '2026-10-08T05:51:01.988Z' } } as Work; };
  const state = emptyDaemonState(config());
  const fx = effects(item, () => at, herdr, decided);
  await runCycle(config(), state, fx, () => at);
  assert.equal(herdr.agents.length, 1, 'the docs-sync is launched');
  for (at = launchedAt + minute; at <= launchedAt + 15 * minute && !decided.includes('rework'); at += 20_000) await runCycle(config(), state, fx, () => at);
  assert.deepEqual(decided, ['rework'], 'the conflict returns to a worker');
  assert.match(Object.values(state.docsSyncs)[0].failed ?? '', /was stopped at .* without having moved/);
  assert.deepEqual(decisionFaults(state), [], 'the loop\'s own cutoff stop is no decision fault');
});

test('manual:fault-class-decision — action:decision|isolated:decision:agent-registry|2026-10-08T07:13:09.435Z: a registry 503 during a plane deploy is retried next cycle, no fault', async () => {
  const { FleetUnreachableError } = await import('../src/fleet.js');
  const clock = Date.parse('2026-10-08T07:13:00Z'), decided: string[] = [];
  const failing = (text: string) => ({ reconcileSessions: async () => { throw new FleetUnreachableError(text); } });
  const state = emptyDaemonState(config());
  const result = await runCycle(config(), state, effects(() => conflicted('GY-1541', 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), new Date(clock).toISOString()), () => clock, { agents: [] }, decided,
    failing('The agent registry at https://graphyard-production.up.railway.app answered 503: Startup validation has not completed; retry shortly')), () => clock);
  assert.ok(result.actions.some(action => action.work === null && /registry/.test(action.detail) || /did not answer/.test(action.detail)), JSON.stringify(result.actions.map(action => action.detail)));
  assert.deepEqual(decisionFaults(state).filter(fault => fault.kind === 'action:decision'), [], 'a deploy\'s readiness 503 judged nothing');

  // An item-specific registry failure is still a fault.
  const other = emptyDaemonState(config());
  await runCycle(config(), other, effects(() => conflicted('GY-1541', 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), new Date(clock).toISOString()), () => clock, { agents: [] }, decided,
    failing('The agent registry at https://graphyard.example answered 400: malformed session')), () => clock);
  assert.equal(decisionFaults(other).filter(fault => fault.kind === 'action:decision').length, 1);
});

test('manual:fault-class-decision — action:decision|isolated:decision:agent-registry|2026-10-08T07:13:09.435Z: repeated readiness 503s over many cycles record no fault and the loop recovers when the plane answers', async () => {
  const { FleetUnreachableError } = await import('../src/fleet.js');
  let clock = Date.parse('2026-10-08T07:13:00Z'), down = true;
  const decided: string[] = [], state = emptyDaemonState(config());
  const reconcile = { reconcileSessions: async () => { if (down) throw new FleetUnreachableError('The agent registry at https://graphyard-production.up.railway.app answered 503: Startup validation has not completed; retry shortly'); return []; } };
  const fx = effects(() => conflicted('GY-1541', 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), new Date(clock).toISOString()), () => clock, { agents: [] }, decided, reconcile);
  for (let cycle = 0; cycle < 6; cycle += 1, clock += minute) await runCycle(config(), state, fx, () => clock);
  assert.deepEqual(decisionFaults(state), [], 'six cycles of a deploy\'s readiness 503 file no decision fault');
  down = false;
  for (let cycle = 0; cycle < 3; cycle += 1, clock += minute) await runCycle(config(), state, fx, () => clock);
  assert.deepEqual(decisionFaults(state), [], 'and none once the plane answers again');
});
