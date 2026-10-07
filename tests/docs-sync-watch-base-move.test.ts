import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';
import type { BaseRefresh } from '../src/merge-queue.js';
import * as docsSyncModel from '../src/model/docs-sync.js';
import { docsSyncWatchSchema } from '../src/model/docs-sync.js';
import { docsSyncRoute } from '../src/daemon/docs-sync-route.js';
import { actionableSubjects } from '../src/daemon/metrics.js';
import { docsSyncMaxMs, docsSyncSessionName, type DocsSyncPlan } from '../src/docs-sync.js';

/**
 * GY-1423. On 2026-10-07 the docs-sync session gy-docs-sync-gy-1388-c23a177, launched against base
 * tip cc2cf441cee0, was still running when the tip moved to 4c87e5241d78. The watch was keyed by
 * item, head and base tip, so the next cycle found none, tried to launch the same session name
 * again, was refused "already visible in Herdr", and sent the conflict back to a worker although
 * its docs-sync was live. The watch is now found by the session's own identity: item and head.
 */

// GY-1436's bounds, read off the module so a source without them fails these cases rather than the file's import.
const { blockedBoundMs, docsSyncHolding, docsSyncHoldMs, docsSyncStallMs } = docsSyncModel as typeof docsSyncModel & Record<string, any>;

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const reviewed = 'a'.repeat(40), bound = 'b'.repeat(40), tip = 'c'.repeat(40), moved = 'f'.repeat(40);
const paths = ['docs/master-agent-reference.md'];

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

/** A submitted, approved item whose base refresh confirmed a docs-only conflict (or `conflictPaths`) with base tip `base`. */
function conflicted(base: string, observedAt = iso(-30_000), { id = 'work-42', conflictPaths = paths }: { id?: string; conflictPaths?: string[] } = {}): Work {
  const candidate = { sha: reviewed, baseSha: bound, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, baseTip: base, baseTipContained: false, conflicting: true,
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'independent-reviewer', sha: reviewed, state: 'APPROVED', submittedAt: iso(-60 * minute) }],
    protected: true, mergeable: false, merged: false, mergeSha: null, files: ['src/loop.ts', ...paths], scopeFiles: [], at: observedAt, prState: 'open', draft: false,
  } as unknown as Observation;
  const baseRefresh: BaseRefresh = { from: { sha: reviewed, baseSha: bound }, base, baseTree: 'e'.repeat(40), policyRevision: 1, at: iso(-minute), head: null,
    conflict: `Candidate ${reviewed.slice(0, 12)} cannot be brought onto base branch tip ${base.slice(0, 12)} without resolving a conflict`, merge: null, carry: null, trigger: 'conflict confirmed', conflictPaths };
  return {
    id, key: 'GY-42', title: 'A change that documents itself', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts', ...paths], stage: 'merge', revision: 5, policyRevision: 1, createdAt: iso(-4 * 60 * minute), updatedAt: iso(0),
    stageEnteredAt: iso(-30 * minute), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, baseRefresh, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'merge', passed: false, reasons: ['Pull request is not mergeable against the current base'] }],
  } as Work;
}

/** A launcher that behaves as the real one does: a session name already visible in Herdr is refused. */
function launch(record: { synced: DocsSyncPlan[]; agents: string[] }) {
  return async (_item: Work, plan: DocsSyncPlan) => {
    const name = docsSyncSessionName(plan);
    if (record.agents.includes(name)) throw new Error(`Docs-sync session ${name} is already visible in Herdr; let it finish first`);
    record.synced.push(plan); record.agents.push(name);
    return { agentName: name, pane: 'pane-s', account: 'reviewer-a', runtime: 'claude' as const, session: null };
  };
}

test('unit:docs-sync-watch-adopt-on-base-move — the docs-sync watch is found by the session\'s item and head, so a moved base tip keeps the running session holding the item', async () => {
  // The route itself: launched against `tip`, then the tip moves while the session is visible.
  const state = emptyDaemonState(config()), record = { synced: [] as DocsSyncPlan[], agents: [] as string[] }, notes: string[] = [];
  let work = conflicted(tip), now = clock, available = true;
  const route = () => docsSyncRoute({ config: { baseBranch: 'main' }, state, snapshot: { work: [work] }, stamp: new Date(now).toISOString(), clock: now, inventorySpent: () => {},
    effects: { docsSync: launch(record), persist: async () => {}, closeSession: async () => { record.agents.length = 0; } },
    sessions: async () => ({ agents: record.agents.map(name => ({ name, pane_id: 'pane-s', agent_status: 'working' }) as any), available }),
    note: async (_key, _item, _kind, outcome, detail) => { notes.push(`${outcome}: ${detail}`); } });
  assert.equal((await route().holds(work)).held, true, 'the first cycle launches the docs-sync');
  assert.equal(record.synced.length, 1);
  work = conflicted(moved); now += minute;
  assert.equal((await route().holds(work)).held, true, 'the moved base keeps the running session holding the item');
  assert.equal(record.synced.length, 1, 'no second launch of the same session name is attempted');
  assert.ok(!notes.some(note => note.startsWith('failed')), `nothing failed: ${notes.join(' | ')}`);
  assert.deepEqual(Object.keys(state.docsSyncs), [`work-42:${reviewed}`], 'one watch, keyed by the session\'s identity');
  assert.deepEqual(state.conflicts.map(entry => [entry.base, entry.route]), [[tip, 'docs-sync']]);

  // Herdr unavailable is no evidence the session ended.
  available = false; record.agents.length = 0;
  assert.equal((await route().holds(work)).held, true);
  // The session ended without moving the head: held until an observation taken since shows it, then rework.
  available = true;
  const ended = await route().holds(work);
  assert.ok(!ended.held && ended.awaiting, 'a push not yet observed is awaited: the step wakes the observation for it');
  work = conflicted(moved, new Date(now + 1_000).toISOString()); now += 2_000;
  assert.equal((await route().holds(work)).held, false, 'the conflict returns to a worker once the session is gone and the head did not move');
  assert.match(notes.at(-1)!, /ended without moving/);
  assert.equal(state.conflicts[0].route, 'rework', 'the routed conflict it was launched for is counted as sent back');
  assert.equal(record.synced.length, 1, 'and still no second launch');

  // A watch kept under the older item-head-base key is still found by its fields after the tip moves.
  const kept = emptyDaemonState(config()), relaunched: DocsSyncPlan[] = [];
  kept.docsSyncs[`work-42:${reviewed}:${tip}`] = docsSyncWatchSchema.parse({ work: 'GY-42', head: reviewed, base: tip, paths, agentName: 'gy-docs-sync-gy-42-aaaaaaa', pane: 'p', launchedAt: iso(0) });
  const legacy = docsSyncRoute({ config: { baseBranch: 'main' }, state: kept, snapshot: { work: [conflicted(moved)] }, stamp: iso(minute), clock: clock + minute, inventorySpent: () => {},
    effects: { docsSync: async (_item, plan) => { relaunched.push(plan); throw new Error('already visible in Herdr'); }, persist: async () => {}, closeSession: async () => {} },
    sessions: async () => ({ agents: [{ name: 'gy-docs-sync-gy-42-aaaaaaa', pane_id: 'p', agent_status: 'working' } as any], available: true }), note: async () => {} });
  assert.equal((await legacy.holds(conflicted(moved))).held, true, 'the running session still holds the item');
  assert.deepEqual(relaunched, [], 'and is not launched again');
});

test('integration:docs-sync-route-holds-across-base-move — through the loop\'s cycles, a base move during a live docs-sync neither relaunches it nor requests rework; rework follows only once it ends or runs past its hold bound without moving the head', async () => {
  const decided: string[] = [], record = { synced: [] as DocsSyncPlan[], agents: [] as string[] };
  let item = conflicted(tip), at = clock;
  const effects = (): DaemonEffects => ({
    agents: () => [], herdr: () => ({ agents: record.agents.map((name, index) => ({ name, pane_id: `pane-${index}`, agent_status: 'working' })), available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: [item], now: new Date(at).toISOString(), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(at).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work, action) => { decided.push(action); return { id: '5d8a8b9e-0000-4000-8000-000000000001' }; },
    decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver-gy-42', pane: 'pane-a' }),
    docsSync: launch(record),
    conflictPaths: async () => paths,
    persist: async () => {},
  });
  const state = emptyDaemonState(config());
  const cycle = (now: number) => { at = now; return runCycle(config(), state, effects(), () => now); };
  await cycle(clock);
  assert.equal(record.synced.length, 1, 'the docs-only conflict launches one docs-sync session');
  assert.deepEqual(decided, []);

  // The base tip moves while the session is visible in Herdr.
  item = conflicted(moved);
  const second = await cycle(clock + minute);
  assert.equal(record.synced.length, 1, 'no second launch of the same session name');
  assert.deepEqual(decided, [], 'the item stays held: no rework decision');
  assert.ok(!second.actions.some(action => action.work === 'GY-42' && /already visible in Herdr|returns to a worker/.test(action.detail)), 'no refused relaunch and no return to a worker');
  await cycle(clock + 4 * minute);
  assert.deepEqual(decided, []); assert.equal(record.synced.length, 1);

  // Past its hold bound, still visible, head unmoved: once an observation since shows that, rework.
  const late = clock + docsSyncHoldMs + minute;
  await cycle(late);
  assert.deepEqual(decided, [], 'the overdue session is first noted, and a push not yet observed is waited for');
  item = conflicted(moved, new Date(late + 1_000).toISOString());
  const last = await cycle(late + 2_000);
  assert.deepEqual(decided, ['rework'], 'the conflict returns to a worker');
  assert.ok(last.actions.some(action => action.work === 'GY-42' && new RegExp(`ran past its ${docsSyncHoldMs / minute}-minute bound`).test(action.detail)), 'the rework names the bound the session ran past');
  assert.equal(record.synced.length, 1, 'never a second launch');
});

/*
 * GY-1436. The hold above used to be a bare return in the decisions step: nothing recorded, the
 * silence measure accusing the step of "needs a rework decision requested and approved", a base
 * move never re-classified, and a 30-minute bound gated on an unprompted fresh observation.
 */

/** The loop over one conflicted item, with switchable conflict paths, Herdr listing and observation effects. */
function loop(id: string, options: { observe?: boolean } = {}) {
  const decided: string[] = [], woke: string[] = [], record = { synced: [] as DocsSyncPlan[], agents: [] as string[] };
  const harness = { item: conflicted(tip, iso(-30_000), { id }), at: clock, local: paths as string[], decided, woke, record, state: emptyDaemonState(config()) };
  const effects = (): DaemonEffects => ({
    agents: () => [], herdr: () => ({ agents: record.agents.map((name, index) => ({ name, pane_id: `pane-${index}`, agent_status: 'working' })), available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: [harness.item], now: new Date(harness.at).toISOString(), jobs: [] }),
    closeSession: () => { record.agents.length = 0; }, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(harness.at).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work, action) => { decided.push(action); return { id: '5d8a8b9e-0000-4000-8000-000000000001' }; },
    decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: `graphyard-approver-${id}`, pane: 'pane-a' }),
    docsSync: launch(record),
    conflictPaths: async () => harness.local,
    wakeObservation: async work => { woke.push(work.key); },
    ...(options.observe ? { observe: async (work: Work) => (harness.item = conflicted(harness.item.baseRefresh!.base, new Date(harness.at + 1_000).toISOString(), { id: work.id, conflictPaths: harness.item.baseRefresh!.conflictPaths ?? undefined })) } : {}),
    persist: async () => {},
  });
  const cycle = (now: number) => { harness.at = now; return runCycle(config(), harness.state, effects(), () => now); };
  return { ...harness, harness, cycle };
}

test('unit:docs-sync-hold-wait-recorded — a standing hold answers the session, head, base and the end of its bound, and the in-bound hold is no decision silence subject', async () => {
  const state = emptyDaemonState(config()), record = { synced: [] as DocsSyncPlan[], agents: [] as string[] }, work = conflicted(tip, iso(-30_000), { id: 'work-unit-wait' });
  const route = (now: number) => docsSyncRoute({ config: { baseBranch: 'main' }, state, snapshot: { work: [work] }, stamp: new Date(now).toISOString(), clock: now, inventorySpent: () => {},
    effects: { docsSync: launch(record), persist: async () => {}, closeSession: async () => {} },
    sessions: async () => ({ agents: record.agents.map(name => ({ name, pane_id: 'pane-s', agent_status: 'working' }) as any), available: true }), note: async () => {} });
  const hold = await route(clock).holds(work);
  assert.ok(hold.held, 'the docs-sync holds the item');
  const name = docsSyncSessionName({ key: 'GY-42', head: reviewed }), deadline = new Date(clock + docsSyncHoldMs).toISOString();
  assert.equal(hold.deadline, deadline);
  for (const part of [name, reviewed.slice(0, 12), tip.slice(0, 12), deadline]) assert.ok(hold.wait.includes(part), `the wait names ${part}: ${hold.wait}`);
  const again = await route(clock + minute).holds(work);
  assert.ok(again.held && again.wait === hold.wait, 'the wait is stable from cycle to cycle');
  const subjects = (now: number, docsSyncs = state.docsSyncs) => actionableSubjects({ autoMerge: true, run: config().run }, [work], now, { approvals: {}, docsSyncs }).filter(subject => subject.kind === 'decision').map(subject => subject.detail);
  assert.ok(docsSyncHolding(state.docsSyncs, work, clock + minute), 'the hold stands inside its bound');
  assert.deepEqual(subjects(clock + minute), [], 'no decision subject while the hold stands');
  assert.deepEqual(subjects(clock + minute, {}), ['GY-42 needs a rework decision requested and approved'], 'without the hold the step owes the decision');
  assert.deepEqual(subjects(clock + docsSyncHoldMs), ['GY-42 needs a rework decision requested and approved'], 'past its bound the hold exempts nothing');
});

test('integration:held-conflict-no-decision-subject — through the loop\'s cycles, a held conflict records one wait naming the docs-sync and raises no decision silence subject', async () => {
  const run = loop('work-held-subject');
  await run.cycle(clock);
  await run.cycle(clock + minute);
  await run.cycle(clock + 2 * minute);
  assert.deepEqual(run.decided, []);
  const wait = run.state.actions['wait:docs-sync:work-held-subject'];
  assert.ok(wait, 'the hold is recorded as the item\'s wait');
  assert.equal(wait.attempts, 1, 'once: the wait is stable across cycles');
  for (const part of [run.record.agents[0], reviewed.slice(0, 12), tip.slice(0, 12), new Date(clock + docsSyncHoldMs).toISOString()]) assert.ok(wait.detail.includes(part), `the wait names ${part}: ${wait.detail}`);
  assert.ok(!Object.values(run.state.silence.subjects).some(subject => subject.detail.includes('needs a rework decision requested and approved')), 'no decision silence subject while the hold stands');
});

test('unit:conflict-route-reread-on-base-move — a moved base is classified again for the new head-and-base pair: still docs-only keeps the hold, anything else ends it', async () => {
  const state = emptyDaemonState(config()), record = { synced: [] as DocsSyncPlan[], agents: [] as string[] }, notes: string[] = [];
  let local: string[] = paths, work = conflicted(tip, iso(-30_000), { id: 'work-unit-reread' });
  const route = (now: number) => docsSyncRoute({ config: { baseBranch: 'main' }, state, snapshot: { work: [work] }, stamp: new Date(now).toISOString(), clock: now, inventorySpent: () => {},
    effects: { docsSync: launch(record), conflictPaths: async () => local, persist: async () => {}, closeSession: async () => { record.agents.length = 0; } },
    sessions: async () => ({ agents: record.agents.map(name => ({ name, pane_id: 'pane-s', agent_status: 'working' }) as any), available: true }),
    note: async (_key, _item, _kind, outcome, detail) => { notes.push(`${outcome}: ${detail}`); } });
  assert.ok((await route(clock).holds(work)).held, 'the docs-sync holds the item on its first base');
  work = conflicted(bound, iso(-30_000), { id: 'work-unit-reread' }); local = ['docs/master-agent-reference.md', 'docs/development.md'];
  const kept = await route(clock + minute).holds(work);
  assert.ok(kept.held && kept.watch.base === bound && kept.wait.includes(bound.slice(0, 12)), 'still docs-only: held, against the new base');
  const mixed = ['docs/setup-from-zero.md', 'tests/helpers/timing-baseline.json'];
  work = conflicted(moved, iso(-30_000), { id: 'work-unit-reread', conflictPaths: mixed }); local = mixed;
  assert.equal((await route(clock + 2 * minute).holds(work)).held, false, 'no longer docs-only: the hold ends');
  assert.match(notes.at(-1)!, /no longer docs-only.*tests\/helpers\/timing-baseline\.json/);
  assert.equal(record.agents.length, 0, 'the docs-sync session is closed');
  assert.equal(state.conflicts[0].route, 'rework', 'the routed conflict is counted as sent back');
  assert.equal(docsSyncHolding(state.docsSyncs, work, clock + 2 * minute), null);
  assert.equal((await route(clock + 3 * minute).holds(work)).held, false, 'and stays ended');
});

test('integration:base-move-ends-docs-hold — a base refresh confirming a conflict that is not docs-only on a new tip requests the rework in that cycle', async () => {
  const run = loop('work-base-move');
  await run.cycle(clock);
  assert.equal(run.record.synced.length, 1); assert.deepEqual(run.decided, []);
  const mixed = ['docs/setup-from-zero.md', 'tests/helpers/timing-baseline.json'];
  run.harness.item = conflicted(moved, iso(minute - 30_000), { id: 'work-base-move', conflictPaths: mixed }); run.harness.local = mixed;
  const cycle = await run.cycle(clock + minute);
  assert.deepEqual(run.decided, ['rework'], 'the hold granted on the earlier tip no longer suppresses the rework');
  assert.ok(cycle.actions.some(action => action.work === 'GY-42' && /no longer docs-only/.test(action.detail)), 'the ended hold names the conflict no longer docs-only');
});

test('unit:docs-sync-hold-bound-within-blocked-bound — the hold lasts at most the blocked bound, however long the session may run', async () => {
  assert.equal(blockedBoundMs, 10 * minute);
  assert.ok(docsSyncHoldMs <= blockedBoundMs, 'the hold bound is within the blocked bound');
  assert.ok(docsSyncHoldMs <= docsSyncMaxMs, 'and within the session\'s own run limit');
  assert.ok(docsSyncStallMs > 0 && docsSyncStallMs <= docsSyncHoldMs / 2, 'the stall attention comes at half the bound');
  // A watch launched one blocked bound ago is over its bound though its session still runs.
  const state = emptyDaemonState(config()), work = conflicted(tip, iso(-30_000), { id: 'work-unit-bound' }), name = docsSyncSessionName({ key: 'GY-42', head: reviewed });
  state.docsSyncs[`work-unit-bound:${reviewed}`] = docsSyncWatchSchema.parse({ work: 'GY-42', head: reviewed, base: tip, paths, agentName: name, pane: 'p', launchedAt: iso(-blockedBoundMs) });
  const hold = await docsSyncRoute({ config: { baseBranch: 'main' }, state, snapshot: { work: [work] }, stamp: iso(0), clock, inventorySpent: () => {},
    effects: { persist: async () => {}, closeSession: async () => {} },
    sessions: async () => ({ agents: [{ name, pane_id: 'p', agent_status: 'working' } as any], available: true }), note: async () => {} }).holds(work);
  assert.equal(hold.held, false, 'past the blocked bound the hold ends');
  assert.equal(docsSyncHolding(state.docsSyncs, work, clock), null);
});

test('integration:docs-sync-expiry-requests-rework-in-one-cycle — at the end of its bound, or when its session ends, the step wakes the observation and requests the rework within one cycle', async () => {
  // With the loop's own observation waker: the reading lands in the cycle and the rework is requested in it.
  const run = loop('work-expiry', { observe: true });
  await run.cycle(clock);
  await run.cycle(clock + 2 * minute);
  assert.deepEqual(run.decided, []);
  const expiry = await run.cycle(clock + docsSyncHoldMs);
  assert.deepEqual(run.decided, ['rework'], 'the rework is requested in the cycle the bound ends');
  assert.ok(expiry.actions.some(action => action.work === 'GY-42' && new RegExp(`ran past its ${docsSyncHoldMs / minute}-minute bound`).test(action.detail)), 'the rework names the bound the session ran past');

  // Without it: the cycle the session is found gone wakes the observation job, and the next requests the rework.
  const gone = loop('work-session-gone');
  await gone.cycle(clock);
  gone.record.agents.length = 0;
  await gone.cycle(clock + minute);
  assert.deepEqual(gone.woke, ['GY-42'], 'the observation job is woken the cycle the session is found gone');
  assert.deepEqual(gone.decided, []);
  gone.harness.item = conflicted(tip, new Date(clock + minute + 5_000).toISOString(), { id: 'work-session-gone' });
  await gone.cycle(clock + minute + 20_000);
  assert.deepEqual(gone.decided, ['rework'], 'the woken observation lands and the rework follows the next cycle');
});

test('integration:docs-sync-stall-named-attention — a hold past half its bound raises one attention naming the docs-sync session, and no silence subject while it is inside its bound', async () => {
  const run = loop('work-stall');
  await run.cycle(clock);
  const name = run.record.agents[0];
  await run.cycle(clock + docsSyncStallMs - minute);
  const key = `escalation:docs-sync-stall:work-stall:${reviewed}`;
  assert.equal(run.state.actions[key], undefined, 'not before half the bound');
  await run.cycle(clock + docsSyncStallMs);
  await run.cycle(clock + docsSyncStallMs + minute);
  const attention = run.state.actions[key] as { kind: string; detail: string; attempts: number } | undefined;
  assert.ok(attention && attention.kind === 'escalation' && attention.detail.includes(name), `an attention names ${name}`);
  assert.equal(attention.attempts, 1, 'raised once');
  assert.deepEqual(run.decided, []);
  assert.ok(!Object.values(run.state.silence.subjects).some(subject => subject.work === 'GY-42' && subject.kind === 'decision'), 'no decision silence subject while the hold is inside its bound');
});
