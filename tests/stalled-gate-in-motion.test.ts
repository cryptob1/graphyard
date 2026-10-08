import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { actorlessSubmissions } from '../src/cli/actorless-submissions.js';
import { syncConflict } from '../src/daemon/decisions.js';
import { unboundedAttemptKey } from '../src/daemon/cycle-reclaim.js';
import { reviewNeed } from '../src/model/dispatch.js';
import { workFaults } from '../src/model/fault-classes.js';
import { baseRefreshConflict } from '../src/merge-queue.js';
import { coordinationSnapshot } from '../src/server/work-view.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1557 names this file for its proof: manual:fault-class-stalled-gate. The master loop filed 3
// stalled-gate faults in 24 hours on 8 October 2026: two `actorless` submissions (GY-1522, GY-1526)
// and one `unsubmitted-attempt` (GY-1549). The shared cause, the one GY-1403 removed for the
// actorless and blocker kinds: each reading counted a gate while the product's own remedy was in
// motion or could not yet have run, because its bound was anchored to a moment before the fault
// existed.
//
//   - actorless (both): the base-conflict bound ran from the item's last actor — its stage entry —
//     not from the hold. GY-1522's head was submitted at 07:57; its base tip moved at 09:57:06, the
//     control plane's test merge confirmed the conflict at 09:58:09, and the reading counted it at
//     09:58:19, 71s after the move, with the bound consumed hours before; the loop requested the
//     sync rework 26s later. GY-1526 entered its stage at 17:47, its base tip moved at 18:00:51,
//     its head was submitted at 18:20 and first observed conflicting at 18:20:27, and the reading
//     counted it at 18:25:53; the loop requested the sync rework 13s later.
//   - unsubmitted-attempt: counted at 0 minutes past the 60-minute worker bound, while the loop's
//     own remedy — ending the attempt — runs at the 120-minute reclaim bound by design
//     (docs/master-agent-sessions.md, attempt-bound.ts).
//
// Each instance is replayed from the ledger (tests/fixtures/gy-1557-stalled-gate.json, read from
// `graphyard events`) as the item stood when the loop recorded it, through the loop's own fault step,
// after the coordination view the loop reads. Against the base each replay fails: the instance
// reproduces (cycleFaults names the actorless or unsubmitted-attempt kind). Past the bound each is
// counted. Candidate-only readers this change adds are asserted in their own cases below.

interface Conflict { at: string; base: string; baseSha: string }
interface Instance {
  id: string; kind: 'actorless' | 'unsubmitted-attempt'; subject: string; at: string; epoch: number; movedAt: string; moved: string;
  pr?: number; claimedAt?: string; submittedAt?: string; headObservedAt?: string; holdSightedAt?: string; sha?: string; baseSha?: string; baseTip?: string; baseMovedAt?: string;
  observedAt?: string; mergeable?: boolean | null; conflicting?: boolean; conflicts?: Conflict[];
  owner?: string; leaseExpiresAt?: string; sessionObservedAt?: string;
}
const instances: Instance[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gy-1557-stalled-gate.json', import.meta.url)), 'utf8'));
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const shift = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
const minute = 60_000;
// Written out rather than imported, so this file loads against the base: the bounds the remedies keep
// (src/cli/actorless-submissions.ts baseConflictWaitBoundMs, src/model/attempt-bound.ts workerReclaimBoundMs).
const baseConflictWaitBoundMs = 30 * minute, workerSubmissionBoundMs = 60 * minute, workerReclaimBoundMs = 120 * minute;
/** Candidate-only readers this change adds. Kept out of the base replay so a missing symbol is not mistaken for a reproduction of the recorded fault. */
async function holds() {
  const declared = await import('../src/model/behind-base.js');
  assert.equal(typeof declared.observeBaseHold, 'function', 'the observation write records the hold\'s first sighting');
  assert.equal(typeof declared.baseHoldSightedAt, 'function', 'the actorless bound reads the sighting');
  return declared;
}

const conflictText = (sha: string, base: string) => `Candidate ${sha.slice(0, 12)} cannot be brought onto base branch tip ${base.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved: Merge of ${base.slice(0, 12)} into graphyard-merge-check/gy conflicts and cannot be resolved by Graphyard.`;
/**
 * The submitted item as the record held it: a head the base moved past, its stage entered at the
 * claim, no request of any kind raised; the control plane's confirmed conflicts as `baseRefresh`
 * (the newest, dated from the first on this head: GY-1200), the head's first observation, and the
 * hold's first sighting where the observation write recorded one.
 */
function submitted(instance: Instance, overrides: Partial<Work> = {}): Work {
  const candidate = { sha: instance.sha!, baseSha: instance.baseSha!, pr: instance.pr!, branch: `graphyard/${instance.subject.toLowerCase()}-${instance.epoch}`, author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: instance.mergeable, conflicting: instance.conflicting, protected: true, files: ['src/a.ts'], scopeFiles: [],
    at: instance.observedAt, prState: 'open', draft: false, baseTip: instance.baseTip, baseTree: instance.baseTip, baseTipContained: false } as unknown as Observation;
  const conflicts = instance.conflicts ?? [], last = conflicts.at(-1);
  const baseRefresh = last ? { from: { sha: instance.sha!, baseSha: last.baseSha }, base: last.base, baseTree: last.base, policyRevision: 1, at: last.at, head: null,
    conflict: conflictText(instance.sha!, last.base), conflictPaths: ['src/daemon/cycle.ts', 'src/daemon/state.ts'], trigger: 'conflict confirmed', conflictSince: conflicts[0]!.at } : null;
  return { id: `work-${instance.subject}`, key: instance.subject, title: instance.subject, description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'build', revision: 1, policyRevision: 1,
    createdAt: instance.claimedAt, updatedAt: instance.observedAt, stageEnteredAt: instance.claimedAt, ready: true, epoch: instance.epoch, lease: null, workspaces: [],
    candidate, submission: { epoch: instance.epoch, pr: instance.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, escalations: [],
    headObserved: { pr: instance.pr, sha: instance.sha, at: instance.headObservedAt }, ...(instance.holdSightedAt ? { baseHold: { sha: instance.sha, at: instance.holdSightedAt } } : {}), baseRefresh,
    autoDispatch: { review: null, producers: [], history: [] }, actionQueue: { actions: [], history: [] }, gates: [], violations: [], proofGaps: [], scopeRequest: null, containmentQuarantine: null, ...overrides } as unknown as Work;
}
/** The attempt as the record held it: a renewing lease, a session observed working, no submission and no candidate. */
function unsubmitted(instance: Instance, overrides: Partial<Work> = {}): Work {
  const owner = instance.owner!;
  const session = { id: `${owner}:${instance.epoch}`, kind: 'implementation', principal: owner, epoch: instance.epoch, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: 'w1V:pM9Q',
    agentName: owner, role: null, head: null, attach: 'herdr pane attach w1V:pM9Q', transcript: null, subject: instance.subject, state: 'running', observed: 'working', observedAt: instance.sessionObservedAt,
    outcome: null, startedAt: instance.claimedAt, updatedAt: instance.sessionObservedAt, endedAt: null };
  return { id: `work-${instance.subject}`, key: instance.subject, title: instance.subject, description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1,
    createdAt: instance.claimedAt, updatedAt: instance.sessionObservedAt, stageEnteredAt: instance.claimedAt, ready: true, epoch: instance.epoch,
    lease: { owner, epoch: instance.epoch, expiresAt: instance.leaseExpiresAt }, lastAssignment: { owner, epoch: instance.epoch, claimedAt: instance.claimedAt },
    workspaces: [{ host: 'vishrog', path: `/srv/worktrees/${instance.subject}-${instance.epoch}`, epoch: instance.epoch, owner, branch: `graphyard/${instance.subject.toLowerCase()}-${instance.epoch}` }],
    sessions: [session], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, escalations: [],
    autoDispatch: { review: null, producers: [], history: [] }, actionQueue: { actions: [], history: [] }, gates: [], violations: [], proofGaps: [], scopeRequest: null, containmentQuarantine: null, humanRequest: null, ...overrides } as unknown as Work;
}

/** The stalled-gate faults the loop's fault step records for the item at `at`, with the actorless lines master status reports. */
function stalledGate(stored: Work, at: string, state = emptyDaemonState(config())) {
  const [work] = coordinationSnapshot({ work: [stored] }).work;
  assert.equal((work as unknown as { pipeline?: unknown }).pipeline, undefined, 'the loop reads the item without its pipeline timeline');
  const reported = actorlessSubmissions([work], new Date(at));
  return { work, reported, faults: cycleFaults(state, [work], Date.parse(at), { config: config(), reported }).filter(fault => fault.faultClass === 'stalled-gate') };
}

test('manual:fault-class-stalled-gate — GY-1557 lists 3 instances, and every one is replayed below', () => {
  assert.deepEqual(instances.map(instance => instance.id), ['actorless|GY-1522|2026-10-08T09:58:19.250Z', 'unsubmitted-attempt|GY-1549|2026-10-08T16:39:52.678Z', 'actorless|GY-1526|2026-10-08T18:25:53.508Z']);
  // Each actorless instance was moved by the loop's own sync rework within a minute of being counted; the attempt was counted an hour before its remedy's turn.
  for (const instance of instances.filter(entry => entry.kind === 'actorless')) assert.ok(Date.parse(instance.movedAt) > Date.parse(instance.at) && Date.parse(instance.movedAt) - Date.parse(instance.at) < minute, `${instance.id}: ${instance.moved}`);
  for (const instance of instances.filter(entry => entry.kind === 'actorless')) assert.ok(Date.parse(instance.at) - Date.parse(instance.baseMovedAt!) < baseConflictWaitBoundMs, `${instance.id}: the base tip moved inside the bound`);
  const attempt = instances.find(entry => entry.kind === 'unsubmitted-attempt')!;
  assert.ok(Date.parse(attempt.at) - Date.parse(attempt.claimedAt!) - workerSubmissionBoundMs < minute, 'counted at 0 minutes past the worker bound');
});

for (const instance of instances.filter(entry => entry.kind === 'actorless')) {
  const confirmed = !!instance.conflicts?.length;
  // Base replay: reaches cycleFaults with no candidate-only import. Against the base the recorded
  // actorless kind is named (the instance reproduces); at this head it is not.
  test(`manual:fault-class-stalled-gate — ${instance.id}: a hold the base's late move opened is in motion for the bound from its sighting, not from the submission`, () => {
    const work = submitted(instance);
    // The reading the instance recorded: a sync is the missing actor, nothing named, hours or minutes past the 5-minute actorless bound.
    assert.equal(reviewNeed(work, [work], new Date(instance.at)).state, 'base-not-contained');
    const { work: viewed, reported, faults } = stalledGate(work, instance.at);
    assert.ok(viewed.headObserved, 'the coordination view keeps the head observation the bound is read from');
    assert.equal(reported.length, 1, 'master status still names the line, so the wait stays visible');
    assert.match(reported[0].text, /no rework request and no named wait; missing a sync rework/);
    assert.match(reported[0].text, confirmed ? /cannot be brought onto it without resolving a conflict/ : /GitHub reports a merge conflict with that base/);
    assert.match(reported[0].text, new RegExp(`has been submitted for ${Math.round((Date.parse(instance.at) - Date.parse(instance.claimedAt!)) / minute)}m`), 'dated from the stage entry, as the instance was');
    assert.deepEqual(faults.map(fault => fault.kind), [], `${instance.subject} is not counted while the loop returns its head: ${instance.moved}`);
    // The loop's own remedy stands on the record: the confirmed conflict grounds its rework request; GitHub's conflict is its sync rework decision.
    if (confirmed) assert.ok(baseRefreshConflict(viewed), 'the control plane\'s test merge confirmed the conflict');
    else assert.ok(syncConflict(viewed), 'the routine decision step requests the sync rework for this head');
  });

  test(`manual:fault-class-stalled-gate — ${instance.id}: past the bound from the sighting with nothing moving it, the head is actorless`, () => {
    const sighted = confirmed ? instance.conflicts![0]!.at : instance.holdSightedAt!;
    const late = shift(sighted, baseConflictWaitBoundMs + minute);
    assert.deepEqual(stalledGate(submitted(instance, { observation: { ...submitted(instance).observation, at: shift(late, -minute) } } as Partial<Work>), late).faults.map(fault => fault.kind), ['actorless']);
    // The base moving again under the same head rewrites the tip the observation names, never the sighting: inside the bound it is in motion, past it counted.
    const movedAgain = (at: string) => submitted(instance, { observation: { ...submitted(instance).observation, at: shift(at, -minute), baseTip: 'f'.repeat(40), baseTree: 'f'.repeat(40), mergeable: null, conflicting: false }, baseHold: { sha: instance.sha, at: sighted } } as unknown as Partial<Work>);
    assert.deepEqual(stalledGate(movedAgain(shift(sighted, baseConflictWaitBoundMs - minute)), shift(sighted, baseConflictWaitBoundMs - minute)).faults.map(fault => fault.kind), []);
    assert.deepEqual(stalledGate(movedAgain(late), late).faults.map(fault => fault.kind), ['actorless']);
  });
}

// Candidate-only: the sighting readers and the bound they anchor. Against the base these fail on the
// missing exports; they are not the base reproduction of GY-1522 or GY-1526 (those reach cycleFaults above).
for (const instance of instances.filter(entry => entry.kind === 'actorless')) {
  const confirmed = !!instance.conflicts?.length;
  test(`unit:base-hold-bound — ${instance.id}: the actorless bound runs from the hold's first sighting`, async () => {
    const { baseHoldSightedAt } = await holds();
    const { work: viewed, reported } = stalledGate(submitted(instance), instance.at);
    assert.ok(confirmed ? viewed.baseRefresh?.conflictSince : viewed.baseHold, 'the coordination view keeps the sighting record');
    assert.equal(baseHoldSightedAt(viewed), confirmed ? instance.conflicts![0]!.at : instance.holdSightedAt);
    assert.equal(reported[0].inMotionUntil, shift(baseHoldSightedAt(viewed)!, baseConflictWaitBoundMs));
  });
}

test('manual:fault-class-stalled-gate — a record with no sighting falls back to the head\'s first observation, and one with neither reads as before', () => {
  const instance = instances.find(entry => entry.subject === 'GY-1526')!;
  // A record the observation write has not yet dated (one that predates the rule): the head's own first observation is the newest actor.
  assert.deepEqual(stalledGate(submitted(instance, { baseHold: null } as Partial<Work>), instance.at).faults.map(fault => fault.kind), []);
  assert.deepEqual(stalledGate(submitted(instance, { baseHold: null } as Partial<Work>), shift(instance.headObservedAt!, baseConflictWaitBoundMs + minute)).faults.map(fault => fault.kind), ['actorless']);
  // Neither record: the bound runs from the last actor, as it did before.
  assert.deepEqual(stalledGate(submitted(instance, { baseHold: null, headObserved: undefined } as Partial<Work>), instance.at).faults.map(fault => fault.kind), ['actorless']);
  // A confirmed conflict record that predates GY-1200 is dated by its own time: still inside the bound at the instant GY-1522 was counted.
  const earlier = instances.find(entry => entry.subject === 'GY-1522')!;
  const undated = submitted(earlier);
  delete (undated.baseRefresh as { conflictSince?: string | null }).conflictSince;
  assert.deepEqual(stalledGate(undated, earlier.at).faults.map(fault => fault.kind), []);
  assert.deepEqual(stalledGate({ ...undated, observation: { ...undated.observation, at: shift(earlier.conflicts![1]!.at, baseConflictWaitBoundMs) } } as Work, shift(earlier.conflicts![1]!.at, baseConflictWaitBoundMs + minute)).faults.map(fault => fault.kind), ['actorless']);
});

for (const instance of instances.filter(entry => entry.kind === 'unsubmitted-attempt')) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: an attempt inside the loop's reclaim bound is named, not counted`, () => {
    const work = unsubmitted(instance);
    // The record's own reading, which master status and the dashboard show: the instance's text.
    const named = workFaults(work, Date.parse(instance.at)).filter(fault => fault.kind === 'unsubmitted-attempt');
    assert.equal(named.length, 1);
    assert.equal(named[0].text, `${instance.subject} epoch ${instance.epoch} (${instance.owner}) has held its lease 0 minutes past the 60-minute worker bound without a submission (claimed at ${instance.claimedAt}, lease renewed to ${instance.leaseExpiresAt}, session last observed working at ${instance.sessionObservedAt}, no submission progress observed); past 120 minutes with no submission the loop stops renewing the lease`);
    // The loop's fault step: the remedy the text promises has not had its turn.
    assert.deepEqual(stalledGate(work, instance.at).faults.map(fault => fault.kind), [], `${instance.subject} is not counted an hour before the loop's own reclaim bound: ${instance.moved}`);
    assert.deepEqual(stalledGate(unsubmitted(instance, { lease: { owner: instance.owner, epoch: instance.epoch, expiresAt: shift(instance.claimedAt!, workerReclaimBoundMs + 2 * minute) } } as Partial<Work>), shift(instance.claimedAt!, workerReclaimBoundMs - minute)).faults.map(fault => fault.kind), [], 'a minute inside the reclaim bound');
  });
}

for (const instance of instances.filter(entry => entry.kind === 'unsubmitted-attempt')) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: past the reclaim bound the attempt counts unless the loop ended it this cycle; a lapsed lease is the containment path's`, () => {
    const late = shift(instance.claimedAt!, workerReclaimBoundMs + minute);
    const held = (expiresAt = shift(late, 2 * minute)) => unsubmitted(instance, { lease: { owner: instance.owner, epoch: instance.epoch, expiresAt } } as Partial<Work>);
    const state = emptyDaemonState(config());
    assert.deepEqual(stalledGate(held(), late, state).faults.map(fault => fault.kind), ['unsubmitted-attempt'], 'nothing ended it');
    const ended = (outcome: 'done' | 'failed', cycle: number) => ({ ...state, actions: { [unboundedAttemptKey(held(), instance.epoch)]: { kind: 'session', work: instance.subject, principal: instance.owner, epoch: instance.epoch, state: outcome, detail: 'ended', attempts: 1, cycle, at: late } } }) as unknown as typeof state;
    assert.deepEqual(stalledGate(held(), late, ended('done', state.cycle)).faults.map(fault => fault.kind), [], 'the loop ended it this cycle: the snapshot the cycle began with still shows the lease');
    assert.deepEqual(stalledGate(held(), late, ended('done', state.cycle - 1)).faults.map(fault => fault.kind), ['unsubmitted-attempt'], 'an end recorded in an earlier cycle did not take');
    assert.deepEqual(stalledGate(held(), late, ended('failed', state.cycle)).faults.map(fault => fault.kind), ['unsubmitted-attempt'], 'an end the loop could not make');
    assert.deepEqual(stalledGate(held(shift(late, -minute)), late, state).faults.map(fault => fault.kind), [], 'a lapsed lease is the lapse-and-containment path\'s');
    // The record's own reading names it throughout.
    assert.equal(workFaults(held(), Date.parse(late)).filter(fault => fault.kind === 'unsubmitted-attempt').length, 1);
  });
}

test('unit:base-hold-sighting — the hold\'s first sighting is set once per head, kept while the hold stands across base moves, cleared when it clears, and read from the control plane\'s first confirmed conflict when one stands', async () => {
  const { observeBaseHold, baseHoldSightedAt } = await holds();
  const instance = instances.find(entry => entry.subject === 'GY-1526')!;
  const work = submitted(instance, { baseHold: null, observation: { ...submitted(instance).observation, mergeable: null, conflicting: false } } as unknown as Partial<Work>);
  const t = (n: number) => shift(instance.submittedAt!, n * minute);
  observeBaseHold(work, t(0));
  assert.deepEqual(work.baseHold, { sha: instance.sha, at: t(0) }, 'GitHub has not computed mergeability: the hold is sighted');
  work.observation = { ...work.observation!, at: t(1), baseTip: 'e'.repeat(40), baseTree: 'e'.repeat(40), mergeable: false, conflicting: true };
  observeBaseHold(work, t(1));
  assert.deepEqual(work.baseHold, { sha: instance.sha, at: t(0) }, 'the base moving under a conflicting head keeps the sighting');
  assert.equal(baseHoldSightedAt(work), t(0));
  work.observation = { ...work.observation!, at: t(2), mergeable: true, conflicting: false };
  observeBaseHold(work, t(2));
  assert.equal(work.baseHold, null, 'a head GitHub reports mergeable stands under no hold');
  assert.equal(baseHoldSightedAt(work), null);
  work.observation = { ...work.observation!, at: t(3), mergeable: false, conflicting: true };
  observeBaseHold(work, t(3));
  assert.deepEqual(work.baseHold, { sha: instance.sha, at: t(3) }, 'a hold that returns is a new sighting');
  work.candidate = { ...work.candidate!, sha: 'd'.repeat(40) }; work.observation = { ...work.observation!, at: t(4), candidate: work.candidate };
  observeBaseHold(work, t(4));
  assert.deepEqual(work.baseHold, { sha: 'd'.repeat(40), at: t(4) }, 'a hold on a new head is a new sighting');
  // The control plane's confirmed conflict dates the hold from its first conflict on the head, whatever the observation write recorded.
  const earlier = instances.find(entry => entry.subject === 'GY-1522')!;
  assert.equal(baseHoldSightedAt(submitted(earlier, { baseHold: { sha: earlier.sha, at: earlier.observedAt } } as Partial<Work>)), earlier.conflicts![0]!.at);
});

// ---- the observation write records the sighting -------------------------------------------------

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1557;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('base-hold'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('integration:base-hold-observed — the observation write records when the current head was first read withheld behind the base, keeps it across a base move, and clears it when GitHub reports the head mergeable', async () => {
  await holds();
  const head = 'a'.repeat(40), base = 'b'.repeat(40), moved = 'c'.repeat(40);
  let item = await engine.execute(operator, 'create', null, { title: 'Base hold', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:base-hold-fixture'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/base-hold/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}` }, randomUUID());
  item = await engine.execute(worker, 'submit', item.id, { epoch: item.epoch, pr: 77 }, randomUUID());
  const reload = async () => (await store.list()).find(entry => entry.id === item.id)!;
  const observe = async (at: string, reading: Partial<Record<keyof Observation, unknown>>) => {
    const current = await reload();
    await engine.observe(item.id, current.revision, { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: 77, branch: current.workspaces.at(-1)!.branch, author: 'implementer' },
      checks: [], reviews: [], protected: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], prState: 'open', draft: false, baseTree: 'd'.repeat(40),
      at, baseTip: base, baseTipContained: false, mergeable: null, ...reading } as unknown as Observation);
    return reload();
  };
  const first = await observe('2026-10-08T18:20:27.699Z', { mergeable: null });
  assert.deepEqual(first.baseHold, { sha: head, at: '2026-10-08T18:20:27.699Z' }, 'the first observation that reads the hold dates it');
  const polled = await observe('2026-10-08T18:21:07.439Z', { mergeable: false, conflicting: true });
  assert.deepEqual(polled.baseHold, { sha: head, at: '2026-10-08T18:20:27.699Z' }, 'a poll that reads the hold again keeps the sighting');
  const movedBase = await observe('2026-10-08T18:40:00.000Z', { baseTip: moved, mergeable: false, conflicting: true });
  assert.deepEqual(movedBase.baseHold, { sha: head, at: '2026-10-08T18:20:27.699Z' }, 'the base moving again under the conflicting head keeps the sighting');
  const cleared = await observe('2026-10-08T18:45:00.000Z', { baseTip: moved, mergeable: true, conflicting: false });
  assert.equal(cleared.baseHold, null, 'a head GitHub reports mergeable stands under no hold');
});
