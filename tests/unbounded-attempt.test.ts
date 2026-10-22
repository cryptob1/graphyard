import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { sessionObservationFreshMs } from '../src/model/session-state.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Work } from '../src/model.js';
import { recordSession, type SessionHandle } from '../src/model/sessions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Imported when each test runs, so against a base without them each proof fails as a test case.
const bound = () => import('../src/model/attempt-bound.js');
const reclaim = () => import('../src/daemon/cycle-reclaim.js') as Promise<typeof import('../src/daemon/cycle-reclaim.js')>;

// GY-1460: GY-1457 epoch 1 held its lease 60m11s without a submission while its live session's
// supervisor renewed the lease every cycle, and nothing recorded it: the lapse path never ran
// because the lease never lapsed.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const host = 'coordinator-host';
const path = '/srv/worktrees/GY-1457-1';
const worker = { name: 'claude-1', principal: 'worker-a', agentName: 'graphyard-claude-1', mode: 'launch', kind: 'claude', credentialFile: '/srv/credentials/claude-1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
const minute = 60_000;
const iso = (offsetMs: number, from = Date.now()) => new Date(from + offsetMs).toISOString();
const clone = <T>(value: T): T => structuredClone(value);

const handle = (overrides: Partial<SessionHandle> = {}) => ({ id: 'worker-a:1', kind: 'implementation', principal: 'worker-a', epoch: null, runtime: 'claude', host, workspace: 'w1', tab: null, pane: 'w1:p4',
  agentName: 'graphyard-claude-1', role: null, head: null, attach: null, transcript: null, subject: 'GY-1457', startedAt: iso(-61 * minute), updatedAt: iso(-1 * minute), endedAt: null,
  state: 'running', outcome: null, observed: 'working', observedAt: iso(-1 * minute), ...overrides }) as SessionHandle;

/** GY-1457 epoch 1 as the 14:54 read showed it: claimed `claimedMinutesAgo` ago, its lease renewed two minutes ahead, its session working, nothing submitted. */
function attempt(claimedMinutesAgo: number, overrides: Partial<Work> = {}, now = Date.now()): Work {
  return {
    id: 'work-1457', key: 'GY-1457', title: 'An attempt that never submits', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Submits', proofs: ['unit:submits'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', revision: 4, policyRevision: 1,
    createdAt: iso(-3 * 60 * minute, now), updatedAt: iso(0, now), stageEnteredAt: iso(-claimedMinutesAgo * minute, now), ready: true, epoch: 1,
    lease: { owner: 'worker-a', epoch: 1, expiresAt: iso(2 * minute, now) },
    lastAssignment: { owner: 'worker-a', epoch: 1, claimedAt: iso(-claimedMinutesAgo * minute, now) },
    workspaces: [{ host, path, epoch: 1, owner: 'worker-a', branch: 'graphyard/gy-1457-1' }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
    sessions: [handle()],
    ...overrides,
  } as Work;
}
test('unit:inside-bound-no-fault — no lease stop inside the bound, once the attempt submitted, or while submission progress is inside the cadence', async () => {
  const { observeHead, submissionProgressCadenceMs, unsubmittedAttempt, unsubmittedAttemptText, workerReclaimBoundMs, workerSubmissionBoundMs } = await bound();
  const now = Date.now();
  assert.equal(submissionProgressCadenceMs, sessionObservationFreshMs, 'the cadence is the session reporting cadence');
  assert.equal(workerSubmissionBoundMs, 60 * minute);
  assert.equal(workerReclaimBoundMs, 120 * minute);
  // Inside the bound, however long the lease has been renewed.
  assert.equal(unsubmittedAttempt(attempt(59, {}, now), now), null);
  // A submission (or a resubmission, which keeps the same record) under the attempt's epoch.
  const submitted = attempt(150, { submission: { epoch: 1, pr: 77 } }, now);
  assert.equal(unsubmittedAttempt(submitted, now), null);
  // An earlier epoch's submission does not cover a rework attempt that has not submitted.
  assert.ok(unsubmittedAttempt(attempt(150, { submission: { epoch: 0, pr: 77 } }, now), now)?.reclaim);
  // Submission progress inside the cadence: a pull request or head first observed on the attempt's own branch during the attempt…
  const candidate = { sha: 'b'.repeat(40), baseSha: 'c'.repeat(40), pr: 77, branch: 'graphyard/gy-1457-1', author: 'worker-a' };
  const observed = (at: string, poll = iso(-1 * minute, now)) => {
    const item = attempt(150, { candidate, observation: { at: poll, candidate } as Work['observation'] }, now);
    observeHead(item, candidate, at);
    return item;
  };
  assert.equal(unsubmittedAttempt(observed(iso(-5 * minute, now)), now), null);
  // …or the attempt's session bound to a commit it pushed.
  const pushed = attempt(150, { sessions: [handle({ head: 'd'.repeat(40), headAt: iso(-3 * minute, now) })] }, now);
  assert.equal(unsubmittedAttempt(pushed, now), null);
  // A refresh of an unchanged reading is not progress. A rework attempt reuses the linked pull
  // request's branch, so every poll observes it again: a head first observed before the claim,
  // however recent the poll, holds nothing — and observing the same head again keeps its first time.
  const rework = observed(iso(-160 * minute, now), iso(-1 * minute, now));
  observeHead(rework, candidate, iso(-1 * minute, now));
  assert.equal(rework.headObserved?.at, iso(-160 * minute, now), 'the same head polled again keeps when it was first observed');
  assert.ok(unsubmittedAttempt(rework, now)?.reclaim, 'an idle rework attempt with an existing pull request is still past the bound');
  assert.ok(unsubmittedAttempt(attempt(150, { candidate, observation: { at: iso(-1 * minute, now), candidate } as Work['observation'] }, now), now)?.reclaim, 'a poll with no head observation is not progress');
  const moved = clone(rework);
  observeHead(moved, { ...candidate, sha: 'f'.repeat(40) }, iso(-2 * minute, now));
  assert.equal(unsubmittedAttempt({ ...moved, candidate: { ...candidate, sha: 'f'.repeat(40) } }, now), null, 'a head that moved during the attempt is progress');
  // The loop rewrites a live session's handle on its observation cadence: a head bound once, long
  // ago, with a fresh `updatedAt` is not progress — only a new head moves `headAt`.
  const rewritten = attempt(150, { sessions: [handle({ head: 'd'.repeat(40), headAt: iso(-140 * minute, now), updatedAt: iso(-1 * minute, now) })] }, now);
  assert.ok(unsubmittedAttempt(rewritten, now)?.reclaim, 'a pushed-once attempt that stalled is still past the bound');
  assert.ok(unsubmittedAttempt(attempt(150, { sessions: [handle({ head: 'd'.repeat(40), updatedAt: iso(-1 * minute, now) })] }, now), now)?.reclaim, 'a head with no recorded push time is not progress');
  // The handle records when its head changed, and only then: a rewrite of the same head, or one that omits it, keeps the time.
  const recorded = attempt(150, { sessions: [] }, now), entry = { id: 'worker-a:1', kind: 'implementation' as const, runtime: 'claude', host, subject: 'GY-1457', state: 'running' as const };
  assert.equal(recordSession(recorded, entry, 'worker-a', new Date(now - 30 * minute)).headAt, undefined, 'no head, no push time');
  assert.equal(recordSession(recorded, { ...entry, head: 'd'.repeat(40) }, 'worker-a', new Date(now - 20 * minute)).headAt, iso(-20 * minute, now));
  assert.equal(recordSession(recorded, { ...entry, head: 'd'.repeat(40) }, 'worker-a', new Date(now - 10 * minute)).headAt, iso(-20 * minute, now), 'the same head again');
  assert.equal(recordSession(recorded, entry, 'worker-a', new Date(now - 5 * minute)).headAt, iso(-20 * minute, now), 'a write that omits the head');
  assert.equal(recordSession(recorded, { ...entry, head: 'a'.repeat(40) }, 'worker-a', new Date(now - 1 * minute)).headAt, iso(-1 * minute, now), 'a new head');
  // Progress older than the cadence does not hold it, and a renewed lease or a working session alone never does.
  const stale = unsubmittedAttempt(observed(iso(-20 * minute, now)), now);
  assert.ok(stale?.reclaim, 'progress past the cadence is not progress');
  assert.match(unsubmittedAttemptText(stale!), /last submission progress at /);
  const working = unsubmittedAttempt(attempt(150, {}, now), now);
  assert.ok(working && working.live && working.reclaim, 'a working session with a renewed lease is still past the bound');
  assert.ok(unsubmittedAttemptText(working!).length <= 500, 'the reclaim line fits 500 characters');
  // Another branch's pull request is not this attempt's progress.
  const other = attempt(150, { observation: { at: iso(-1 * minute, now), candidate: { sha: 'b'.repeat(40), baseSha: 'c'.repeat(40), pr: 70, branch: 'graphyard/gy-1457-0', author: 'worker-z' } } as Work['observation'] }, now);
  assert.ok(unsubmittedAttempt(other, now)?.reclaim);
  // Between the bounds the fault stands but nothing stops renewing.
  const between = unsubmittedAttempt(attempt(90, {}, now), now);
  assert.equal(between?.reclaim, false);
  assert.match(unsubmittedAttemptText(between!), /past 120 minutes with no submission the loop stops renewing the lease$/);
});

function cycleFor(state: DaemonState, config: MasterConfig, effects: Partial<DaemonEffects>, item: Work, now = Date.now()): Cycle {
  return { config, state, effects: effects as DaemonEffects, now: Date.now, snapshot: { work: [item], now: iso(0, now) }, clock: now, clockOffset: { min: 0, max: 0 },
    performed: [], isolate: async (_kind: string, _item: unknown, _key: string, fn: () => Promise<unknown>) => fn(), agents: [], open: [item] } as unknown as Cycle;
}
async function configured() {
  const directory = await temporaryDirectory('unbounded-attempt');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: host,
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [worker] });
  return { config, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('unit:lease-stop-renewal — past the reclaim bound the loop ends the attempt once, keeping its work and closing its pane; inside it, or with progress, it stops nothing', async () => {
  const { stopUnboundedAttempts, unboundedAttemptKey } = await reclaim();
  const { config, cleanup } = await configured();
  try {
    const ended: { key: string; epoch: number; cause: unknown; partialWork: unknown }[] = [], closed: string[] = [], order: string[] = [];
    const effects: Partial<DaemonEffects> = {
      preserveWork: async (work: Work) => { order.push('preserve'); return { state: 'committed', commit: 'e'.repeat(40), branch: work.workspaces[0].branch, path }; },
      reportCapacity: async (work: Work, event: { epoch: number; cause?: string; partialWork?: unknown }) => { ended.push({ key: work.key, epoch: event.epoch, cause: event.cause, partialWork: event.partialWork }); return work; },
      closeSession: async (pane: string) => { order.push('close'); closed.push(pane); }, recordSession: async () => {}, persist: async () => {},
    } as unknown as Partial<DaemonEffects>;
    const live = [{ name: 'graphyard-claude-1', pane_id: 'w1:p4', agent: 'claude', agent_status: 'working' }];
    const cycle = (item: Work) => ({ ...cycleFor(state, config, effects, item), agents: live }) as Cycle;
    const state = emptyDaemonState(config);
    for (const quiet of [attempt(119), attempt(150, { submission: { epoch: 1, pr: 77 } }), attempt(150, { sessions: [handle({ head: 'd'.repeat(40), headAt: iso(-2 * minute) })] })])
      await stopUnboundedAttempts(cycle(quiet));
    assert.deepEqual([ended, closed], [[], []], 'inside the bound, submitted, or progressing: the lease keeps renewing');
    const item = attempt(121);
    await stopUnboundedAttempts(cycle(item));
    assert.deepEqual(ended.map(entry => [entry.key, entry.epoch, entry.cause]), [['GY-1457', 1, 'interrupted']], 'the attempt is ended on the record, so the lapse is explained');
    assert.equal((ended[0].partialWork as { state: string }).state, 'committed', 'what it left is kept on its branch');
    assert.deepEqual(closed, ['w1:p4'], 'its own pane is closed');
    assert.deepEqual(order, ['close', 'preserve'], 'a session still at work has its pane closed before its worktree is kept, so the snapshot never races the agent');
    const action = state.actions[unboundedAttemptKey(item, 1)];
    assert.equal(action?.state, 'done');
    assert.match(action!.detail, /held its lease past the 120-minute reclaim bound without a submission .*; the loop stopped renewing it: the attempt ended on the record, its supervisor stops on the ended lease, pane w1:p4 was closed, and GY-1457 is dispatched again, with its worktree kept$/);
    await stopUnboundedAttempts(cycle(item));
    assert.equal(closed.length, 1, 'once per attempt');
    assert.equal(ended.length, 1);
    // An end the plane refuses is recorded failed with why, and retried on the backoff.
    const refused = attempt(121, { id: 'work-1460', key: 'GY-1460' });
    const refusing = { ...effects, preserveWork: async () => { throw new Error('the control plane answered 502'); } } as Partial<DaemonEffects>;
    await stopUnboundedAttempts({ ...cycleFor(state, config, refusing, refused), agents: live } as Cycle);
    assert.equal(state.actions[unboundedAttemptKey(refused, 1)]?.state, 'failed');
    assert.match(state.actions[unboundedAttemptKey(refused, 1)]!.detail, /but the loop could not end the attempt: /);
  } finally { await cleanup(); }
});

test('integration:unbounded-attempt-reclaimed — a live, renewing attempt past the worker bound is named by its record and left to the loop\'s reclaim; past the reclaim bound its renewal stops: the attempt ends on the record, its session is closed and the item returns to the queue with its worktree kept, and the remedy that worked opens no fault instance', async () => {
  const { unboundedAttemptKey } = await reclaim(), { unsubmittedAttempt, unsubmittedAttemptText } = await bound();
  const { config, cleanup } = await configured();
  // The plane's record, renewed by the supervisor on every read while it runs, as `graphyard watch` does.
  const plane = { item: attempt(119), preserved: [] as string[] };
  const supervisor = { running: true, stoppedAt: 0 };
  const read = () => {
    const now = Date.now();
    if (supervisor.running && plane.item.lease) {
      plane.item.lease = { ...plane.item.lease, expiresAt: iso(2 * minute, now) };
      plane.item.sessions = [handle({ observedAt: iso(-1 * minute, now), updatedAt: iso(-1 * minute, now) })];
    }
    return { work: [clone(plane.item)], now: iso(0, now) };
  };
  const state: DaemonState = emptyDaemonState(config);
  const agents = () => supervisor.running ? [{ name: 'graphyard-claude-1', pane_id: 'w1:p4', agent: 'claude', agent_status: 'working' }] as never : [];
  const effects = {
    agents, herdr: () => ({ agents: agents(), available: true }),
    credentials: async (profiles: WorkerProfile[]) => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    snapshot: async () => read(),
    dispatch: async () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, persist: async () => {},
    // Closing the session's pane ends the session, and with it the supervisor renewing the lease.
    closeSession: () => { supervisor.running = false; },
    preserveWork: async () => ({ state: 'committed', commit: 'e'.repeat(40), branch: 'graphyard/gy-1457-1', path }),
    reportCapacity: async (_work: Work, event: { epoch: number; reason: string }) => { plane.preserved.push(event.reason); if (plane.item.lease?.epoch === event.epoch) plane.item.lease = null; return clone(plane.item); },
    recordSession: async () => {},
  } as unknown as DaemonEffects;
  const cycle = () => runCycle(config, state, effects);
  try {
    // Inside the bound: nothing stops.
    plane.item = attempt(59);
    await cycle();
    assert.equal(supervisor.running, true);
    // Past the 60-minute bound with the lease still renewing: the record names the attempt, nothing stopped.
    plane.item = attempt(61);
    await cycle();
    const named = unsubmittedAttempt(plane.item, Date.now());
    assert.ok(named, 'the renewed attempt past the bound is named by its record');
    assert.match(unsubmittedAttemptText(named), /GY-1457 epoch 1 \(worker-a\) has held its lease 1 minutes past the 60-minute worker bound without a submission \(claimed at .+, lease renewed to /);
    assert.equal(supervisor.running, true, 'the first bound stops nothing');
    // One further bound, still no submission and no progress: the loop stops renewing — it ends the
    // attempt through the reclaim path, keeping its work and closing its session.
    plane.item = attempt(121);
    await cycle();
    assert.equal(supervisor.running, false, 'the session renewing the lease was closed');
    assert.equal(state.actions[unboundedAttemptKey(plane.item, 1)]?.state, 'done');
    assert.match(state.actions[unboundedAttemptKey(plane.item, 1)]!.detail, /the loop stopped renewing it: the attempt ended on the record, its supervisor stops on the ended lease, pane w1:p4 was closed, and GY-1457 is dispatched again, with its worktree kept$/);
    assert.equal(plane.preserved.length, 1, 'its partial work was kept on its branch as the attempt ended');
    assert.equal(plane.item.lease, null, 'the attempt ended on the record, so the item is claimable again and no lease lapses unexplained');
    assert.deepEqual(plane.item.workspaces.map(workspace => workspace.path), [path], 'its worktree is kept on the record');
    await cycle();
    assert.equal(supervisor.running, false);
  } finally { await cleanup(); }
});
