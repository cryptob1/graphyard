import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { assessContainment, masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { faultClassOf, workFaults } from '../src/model/fault-classes.js';
import { sessionObservationFreshMs } from '../src/model/session-state.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { SupervisorProbeReport } from '../src/containment-probe.js';
import type { Work } from '../src/model.js';
import { recordSession, type SessionHandle } from '../src/model/sessions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Imported when each test runs, so against a base without them each proof fails as a test case.
const bound = () => import('../src/model/attempt-bound.js');
const reclaim = () => import('../src/daemon/cycle-reclaim.js') as Promise<typeof import('../src/daemon/cycle-reclaim.js')>;

// GY-1460: GY-1457 epoch 1 held its lease 60m11s without a submission while its live session's
// supervisor renewed the lease every cycle, and nothing recorded it: the lapse-to-containment path
// never ran because the lease never lapsed.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const host = 'coordinator-host';
const path = '/srv/worktrees/GY-1457-1';
const scope = { unit: 'graphyard-watch-4242-0c1e.scope', pid: 4242 };
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
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'build', revision: 4, policyRevision: 1,
    createdAt: iso(-3 * 60 * minute, now), updatedAt: iso(0, now), stageEnteredAt: iso(-claimedMinutesAgo * minute, now), ready: true, epoch: 1,
    lease: { owner: 'worker-a', epoch: 1, expiresAt: iso(2 * minute, now) },
    lastAssignment: { owner: 'worker-a', epoch: 1, claimedAt: iso(-claimedMinutesAgo * minute, now) },
    workspaces: [{ host, path, epoch: 1, owner: 'worker-a', branch: 'graphyard/gy-1457-1' }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
    sessions: [handle()],
    containmentQuarantine: { owner: 'worker-a', epoch: 1, at: iso(-claimedMinutesAgo * minute, now), settlementHash: 'a'.repeat(64), launchAcknowledgedAt: iso(-claimedMinutesAgo * minute, now),
      launchExpiresAt: iso(-(claimedMinutesAgo - 2) * minute, now), leaseExpiresAt: iso(2 * minute, now), scope },
    ...overrides,
  } as Work;
}
const unsubmittedFaults = (work: Work, now = Date.now()) => workFaults(work, now).filter(fault => fault.kind === 'unsubmitted-attempt');

test('unit:stalled-gate-on-renewed-attempt — an attempt past the 60-minute bound with a renewed lease and a working session is a stalled-gate fault naming key, epoch, minutes past the bound and the renewal', () => {
  const now = Date.now();
  const item = attempt(60 + 11, {}, now); // GY-1457: 60m11s, rounded to the minute
  const faults = unsubmittedFaults(item, now);
  assert.equal(faults.length, 1, 'the renewed lease past the bound is recorded');
  const [fault] = faults;
  assert.equal(fault.faultClass, 'stalled-gate');
  assert.equal(faultClassOf('unsubmitted-attempt'), 'stalled-gate');
  assert.equal(fault.subject, 'GY-1457');
  assert.match(fault.text, /^GY-1457 epoch 1 \(worker-a\) has held its lease 11 minutes past the 60-minute worker bound without a submission/);
  assert.match(fault.text, new RegExp(`lease renewed to ${item.lease!.expiresAt.replace(/[.]/g, '\\.')}`), 'the renewal evidence: the lease expiry the read found past the bound');
  assert.match(fault.text, /session last observed working at /);
  assert.match(fault.text, new RegExp(`claimed at ${item.lastAssignment!.claimedAt!.replace(/[.]/g, '\\.')}`));
  assert.ok(fault.text.length <= 500, 'the line fits the fault record');
  // The lapse path never fires for it: the lease is live and its fence is live, so no containment fault stands.
  assert.deepEqual(workFaults(item, now).filter(entry => entry.faultClass === 'containment'), []);
  // The pipeline timeline is enough when the assignment record does not carry the claim.
  const timeline = { ...attempt(75, { lastAssignment: { owner: 'worker-a', epoch: 1 } }, now), pipeline: { attempts: [{ epoch: 1, owner: 'worker-a', claimedAt: iso(-75 * minute, now) }] } } as Work;
  assert.match(unsubmittedFaults(timeline, now)[0]?.text ?? '', /15 minutes past the 60-minute worker bound/);
});

test('unit:inside-bound-no-fault — no fault and no lease stop inside the bound, once the attempt submitted, or while submission progress is inside the cadence', async () => {
  const { observeHead, submissionProgressCadenceMs, unsubmittedAttempt, workerReclaimBoundMs, workerSubmissionBoundMs } = await bound();
  const now = Date.now();
  assert.equal(submissionProgressCadenceMs, sessionObservationFreshMs, 'the cadence is the session reporting cadence');
  assert.equal(workerSubmissionBoundMs, 60 * minute);
  assert.equal(workerReclaimBoundMs, 120 * minute);
  // Inside the bound, however long the lease has been renewed.
  assert.equal(unsubmittedAttempt(attempt(59, {}, now), now), null);
  assert.deepEqual(unsubmittedFaults(attempt(59, {}, now), now), []);
  // A submission (or a resubmission, which keeps the same record) under the attempt's epoch.
  const submitted = attempt(150, { submission: { epoch: 1, pr: 77 } }, now);
  assert.equal(unsubmittedAttempt(submitted, now), null);
  assert.deepEqual(unsubmittedFaults(submitted, now), []);
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
  assert.deepEqual(unsubmittedFaults(observed(iso(-5 * minute, now)), now), []);
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
  assert.match(unsubmittedFaults(observed(iso(-20 * minute, now)), now)[0].text, /last submission progress at /);
  const working = unsubmittedAttempt(attempt(150, {}, now), now);
  assert.ok(working && working.live && working.reclaim, 'a working session with a renewed lease is still past the bound');
  assert.ok(unsubmittedFaults(attempt(150, {}, now), now)[0].text.length <= 500, 'the reclaim line fits the fault record');
  // Another branch's pull request is not this attempt's progress.
  const other = attempt(150, { observation: { at: iso(-1 * minute, now), candidate: { sha: 'b'.repeat(40), baseSha: 'c'.repeat(40), pr: 70, branch: 'graphyard/gy-1457-0', author: 'worker-z' } } as Work['observation'] }, now);
  assert.ok(unsubmittedAttempt(other, now)?.reclaim);
  // Between the bounds the fault stands but nothing stops renewing.
  const between = unsubmittedAttempt(attempt(90, {}, now), now);
  assert.equal(between?.reclaim, false);
  assert.match(unsubmittedFaults(attempt(90, {}, now), now)[0].text, /past 120 minutes with no submission the loop stops renewing the lease$/);
});

test('unit:scope-wait-not-unbounded — an attempt waiting on its own scope request, undecided or refused by the widening rule, is not past the bound; once its request is answered, a refusal by the independent approver included, the bound runs from the answer (GY-1472)', async () => {
  const { noSubmissionRenewalRefused, unsubmittedAttempt } = await bound();
  const now = Date.now();
  const claimed = iso(-150 * minute, now), asked = iso(-149 * minute, now);
  const request = { epoch: 1, paths: ['newtop-18/next.ts'], reason: 'the file this change touches', requestedBy: 'worker-a', at: asked };
  const refusal = { state: 'refused' as const, reason: 'no fold represents the ask', at: iso(-148 * minute, now), decidedBy: 'graphyard', waitedMs: minute, paths: request.paths, requestedBy: 'worker-a', requestedAt: asked };
  // Undecided, and refused with the request left open: the attempt waits on that decision, and its renewal stands.
  const undecided = attempt(150, { scopeRequest: request }, now);
  assert.equal(unsubmittedAttempt(undecided, now), null);
  assert.deepEqual(unsubmittedFaults(undecided, now), []);
  const refused = attempt(150, { scopeRequest: { ...request, decision: refusal }, scopeDecision: refusal }, now);
  assert.equal(unsubmittedAttempt(refused, now), null, 'a refused ask standing for the master is not a stalled worker');
  assert.equal(noSubmissionRenewalRefused(refused, now), false, 'the server keeps renewing it');
  // An independent approver's refusal is final even while it stays on the request: the bound runs from it, so a worker ignoring it is still reclaimed.
  const final = (minutesAgo: number) => { const decision = { ...refusal, decidedBy: 'graphyard-approver', at: iso(-minutesAgo * minute, now) }; return attempt(150, { scopeRequest: { ...request, decision }, scopeDecision: decision }, now); };
  assert.equal(unsubmittedAttempt(final(50), now), null, 'fifty minutes since the approver refused is inside the bound');
  const ignored = unsubmittedAttempt(final(140), now);
  assert.ok(ignored?.reclaim && ignored.boundFrom === iso(-140 * minute, now), 'a worker ignoring the final refusal is reclaimed from it');
  assert.equal(noSubmissionRenewalRefused(final(140), now), true, 'and the server refuses its renewal');
  // An earlier attempt's request does not cover this one.
  assert.ok(unsubmittedAttempt(attempt(150, { scopeRequest: { ...request, epoch: 0 } }, now), now)?.reclaim);
  // Answered after 100 minutes of waiting: the bound runs from the answer, not the claim.
  const answeredAt = (minutesAgo: number) => attempt(150, { scopeDecision: { ...refusal, state: 'approved', at: iso(-minutesAgo * minute, now) } }, now);
  assert.equal(unsubmittedAttempt(answeredAt(50), now), null, 'fifty minutes since the answer is inside the bound');
  const past = unsubmittedAttempt(answeredAt(130), now);
  assert.ok(past?.reclaim && past.boundFrom === iso(-130 * minute, now) && past.claimedAt === claimed, 'past both bounds from the answer');
  // A decision on a request asked before this attempt's claim moves nothing.
  assert.equal(unsubmittedAttempt(attempt(150, { scopeDecision: { ...refusal, state: 'approved', requestedAt: iso(-200 * minute, now), at: iso(-10 * minute, now) } }, now), now)?.boundFrom, claimed);
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

test('unit:lease-stop-renewal — past the reclaim bound the loop ends the attempt once, keeping its work and stopping its supervisor; inside it, or with progress, it stops nothing', async () => {
  const { stopUnboundedAttempts, unboundedAttemptKey } = await reclaim();
  const { config, cleanup } = await configured();
  try {
    const stops: { key: string; epoch: number; unit: string; signal: string }[] = [], ended: { key: string; epoch: number; cause: unknown; partialWork: unknown }[] = [], closed: string[] = [], order: string[] = [];
    const effects: Partial<DaemonEffects> = {
      stopSupervisor: (orphan: { key: string; epoch: number; scope: { unit: string } }, signal: string) => { order.push('stop'); stops.push({ key: orphan.key, epoch: orphan.epoch, unit: orphan.scope.unit, signal }); },
      preserveWork: async (work: Work) => { order.push('preserve'); return { state: 'committed', commit: 'e'.repeat(40), branch: work.workspaces[0].branch, path }; },
      reportCapacity: async (work: Work, event: { epoch: number; cause?: string; partialWork?: unknown }) => { ended.push({ key: work.key, epoch: event.epoch, cause: event.cause, partialWork: event.partialWork }); return work; },
      closeSession: async (pane: string) => { order.push('close'); closed.push(pane); }, recordSession: async () => {}, persist: async () => {},
    } as unknown as Partial<DaemonEffects>;
    const live = [{ name: 'graphyard-claude-1', pane_id: 'w1:p4', agent: 'claude', agent_status: 'working' }];
    const cycle = (item: Work) => ({ ...cycleFor(state, config, effects, item), agents: live }) as Cycle;
    const state = emptyDaemonState(config);
    for (const quiet of [attempt(119), attempt(150, { submission: { epoch: 1, pr: 77 } }), attempt(150, { sessions: [handle({ head: 'd'.repeat(40), headAt: iso(-2 * minute) })] })])
      await stopUnboundedAttempts(cycle(quiet));
    assert.deepEqual([stops, ended, closed], [[], [], []], 'inside the bound, submitted, or progressing: the lease keeps renewing');
    const item = attempt(121);
    await stopUnboundedAttempts(cycle(item));
    assert.deepEqual(stops, [{ key: 'GY-1457', epoch: 1, unit: scope.unit, signal: 'SIGTERM' }], 'its supervisor — what renews the lease — is stopped through its recorded scope');
    assert.deepEqual(ended.map(entry => [entry.key, entry.epoch, entry.cause]), [['GY-1457', 1, 'interrupted']], 'the attempt is ended on the record, so the lapse is explained and no lease-loss escalation waits on an operator');
    assert.equal((ended[0].partialWork as { state: string }).state, 'committed', 'what it left is kept on its branch');
    assert.deepEqual(closed, ['w1:p4'], 'its own pane is closed');
    assert.deepEqual(order, ['stop', 'close', 'preserve'], 'a session still at work is stopped and its pane closed before its worktree is kept, so the snapshot never races the agent');
    const action = state.actions[unboundedAttemptKey(item, 1)];
    assert.equal(action?.state, 'done');
    assert.match(action!.detail, /held its lease past the 120-minute reclaim bound without a submission .*; the loop stopped renewing it: the attempt ended on the record, its supervisor \(pid 4242\) was stopped through /);
    assert.match(action!.detail, /GY-1457 is dispatched again, with its worktree kept$/);
    await stopUnboundedAttempts(cycle(item));
    assert.equal(stops.length, 1, 'once per attempt');
    assert.equal(ended.length, 1);
    // No recorded scope: the attempt still ends on the record, and its supervisor stops on the ended lease.
    const unscoped = attempt(121, { id: 'work-1458', key: 'GY-1458', containmentQuarantine: null });
    await stopUnboundedAttempts(cycle(unscoped));
    assert.equal(state.actions[unboundedAttemptKey(unscoped, 1)]?.state, 'done');
    assert.match(state.actions[unboundedAttemptKey(unscoped, 1)]!.detail, /its supervisor stops on the ended lease/);
    // An end the plane refuses is recorded failed with why, and retried on the backoff.
    const refused = attempt(121, { id: 'work-1460', key: 'GY-1460' });
    const refusing = { ...effects, preserveWork: async () => { throw new Error('the control plane answered 502'); } } as Partial<DaemonEffects>;
    await stopUnboundedAttempts({ ...cycleFor(state, config, refusing, refused), agents: live } as Cycle);
    assert.equal(state.actions[unboundedAttemptKey(refused, 1)]?.state, 'failed');
    assert.match(state.actions[unboundedAttemptKey(refused, 1)]!.detail, /but the loop could not end the attempt: /);
    // A supervisor the host still shows running after the stop: nothing is snapshotted while the
    // agent may still be writing; the end is recorded failed with why, and retried on the backoff.
    const lingering = attempt(121, { id: 'work-1461', key: 'GY-1461' }), before = ended.length;
    const stillRunning = { ...effects, controlPlaneClock: async () => ({ clockOffset: { min: 0, max: 0 }, roundTripMs: 1, source: 'timed read' }),
      containment: (work: Work[]) => Object.fromEntries(work.map(entry => [entry.id, { verification: { workspacePath: path, processes: [{ pid: 4243, evidence: 'workspace' }], scopes: [], recordedScope: { ...scope, activeState: 'deactivating' } } }])) } as unknown as Partial<DaemonEffects>;
    const { supervisorStillRunning } = await reclaim();
    assert.match(await supervisorStillRunning({ ...cycleFor(state, config, stillRunning, lingering), agents: live } as Cycle, lingering, { epoch: 1, owner: 'worker-a' }, { boundMs: 0, pollMs: 1 }) ?? '', /scope graphyard-watch-4242-0c1e\.scope is deactivating/);
    const quick = { ...stillRunning, containment: (work: Work[]) => Object.fromEntries(work.map(entry => [entry.id, { verification: { workspacePath: path, processes: [{ pid: 4243, evidence: 'workspace' }], scopes: [], recordedScope: { ...scope, activeState: 'inactive' } } }])) } as unknown as Partial<DaemonEffects>;
    // One cycle: the probe's bound, which the cycle's endings share, is already spent.
    const lingeringCycle = { ...cycleFor(state, config, quick, lingering), agents: live } as Cycle;
    await supervisorStillRunning(lingeringCycle, lingering, { epoch: 1, owner: 'worker-a' }, { boundMs: 0, pollMs: 1 });
    await stopUnboundedAttempts(lingeringCycle);
    assert.equal(ended.length, before, 'its worktree is not snapshotted while a process still runs there');
    assert.equal(state.actions[unboundedAttemptKey(lingering, 1)]?.state, 'failed');
    assert.match(state.actions[unboundedAttemptKey(lingering, 1)]!.detail, /not yet verified gone, so its worktree is not kept yet: 1 processes still run in /);
    // Another host's attempt is left to that host's loop.
    const elsewhere = attempt(121, { id: 'work-1459', key: 'GY-1459', workspaces: [{ host: 'other-host', path, epoch: 1, owner: 'worker-a', branch: 'graphyard/gy-1459-1' }] });
    const stopped = stops.length;
    await stopUnboundedAttempts(cycle(elsewhere));
    assert.equal(state.actions[unboundedAttemptKey(elsewhere, 1)], undefined);
    assert.equal(stops.length, stopped, 'nothing stopped on this host');
  } finally { await cleanup(); }
});

test('integration:unbounded-attempt-reclaimed — a live, renewing attempt past both bounds is faulted, then its renewal stops: the attempt ends on the record, its supervisor stops, its fence settles and the item returns to the queue with its worktree kept', async () => {
  const { unboundedAttemptKey } = await reclaim();
  const { config, cleanup } = await configured();
  // The plane's record, renewed by the supervisor on every read while it runs, as `graphyard watch` does.
  const plane = { item: attempt(119), preserved: [] as string[] };
  const supervisor = { running: true, stoppedAt: 0 };
  const probe = (): SupervisorProbeReport => ({ method: 'linux-proc-systemd', platform: 'linux', uid: 1000, workspacePath: path, held: [], inaccessible: 0, unverifiable: [],
    processes: supervisor.running ? [{ pid: scope.pid, evidence: 'command' }] : [],
    scopes: supervisor.running ? [{ unit: scope.unit, activeState: 'active', processes: [scope.pid], attributed: [] }] : [],
    recordedScope: { ...scope, activeState: supervisor.running ? 'active' : 'inactive' } }) as unknown as SupervisorProbeReport;
  const read = () => {
    const now = Date.now();
    if (supervisor.running && plane.item.lease) {
      plane.item.lease = { ...plane.item.lease, expiresAt: iso(2 * minute, now) };
      plane.item.containmentQuarantine = { ...plane.item.containmentQuarantine!, leaseExpiresAt: plane.item.lease.expiresAt };
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
    dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, closeSession: () => {}, persist: async () => {},
    controlPlaneClock: async () => ({ clockOffset: { min: 0, max: 0 }, roundTripMs: 1, source: 'timed read' }),
    containment: (work: Work[], observed: { now: string; clockOffset: { min: number; max: number }; clockRoundTripMs?: number; clockSource?: string }) =>
      assessContainment(work, { hostId: host, observedAt: observed.now, clockOffset: observed.clockOffset, clockRoundTripMs: observed.clockRoundTripMs, clockSource: observed.clockSource as never, probe }),
    settleContainment: async () => { plane.item.containmentQuarantine = null; },
    preserveWork: async () => ({ state: 'committed', commit: 'e'.repeat(40), branch: 'graphyard/gy-1457-1', path }),
    reportCapacity: async (_work: Work, event: { epoch: number; reason: string }) => { plane.preserved.push(event.reason); if (plane.item.lease?.epoch === event.epoch) plane.item.lease = null; return clone(plane.item); },
    recordSession: async () => {},
    stopSupervisor: () => { supervisor.running = false; },
  } as unknown as DaemonEffects;
  const cycle = () => { state.faults.observedAt = undefined; return runCycle(config, state, effects); };
  const standing = () => state.faults.instances.filter(instance => instance.kind === 'unsubmitted-attempt' && instance.subject === 'GY-1457');
  try {
    // Inside the bound: nothing.
    plane.item = attempt(59);
    await cycle();
    assert.deepEqual(standing(), [], 'no fault inside the bound');
    // Past the 60-minute bound with the lease still renewing: the stalled-gate fault, nothing stopped.
    plane.item = attempt(61);
    await cycle();
    assert.equal(standing().length, 1, 'the renewed attempt past the bound is recorded');
    assert.equal(standing()[0].faultClass, 'stalled-gate');
    assert.match(standing()[0].text, /GY-1457 epoch 1 \(worker-a\) has held its lease 1 minutes past the 60-minute worker bound without a submission \(claimed at .+, lease renewed to /);
    assert.equal(supervisor.running, true, 'the first bound stops nothing');
    // One further bound, still no submission and no progress: the loop stops renewing — it ends the
    // attempt through the reclaim path, keeping its work, stopping its supervisor and settling its fence.
    plane.item = attempt(121);
    await cycle();
    assert.equal(supervisor.running, false, 'the supervisor renewing the lease was stopped');
    assert.equal(state.actions[unboundedAttemptKey(plane.item, 1)]?.state, 'done');
    assert.match(state.actions[unboundedAttemptKey(plane.item, 1)]!.detail, /the loop stopped renewing it: the attempt ended on the record, its supervisor \(pid 4242\) was stopped through .+, its containment fence was settled, and GY-1457 is dispatched again, with its worktree kept$/);
    assert.equal(plane.preserved.length, 1, 'its partial work was kept on its branch as the attempt ended');
    assert.equal(plane.item.lease, null, 'the attempt ended on the record, so the item is claimable again and no lease lapses unexplained');
    assert.equal(plane.item.containmentQuarantine, null, 'the fence was settled once the host verified the supervisor gone');
    assert.deepEqual(plane.item.workspaces.map(workspace => workspace.path), [path], 'its worktree is kept on the record');
    assert.equal(standing().length, 1, 'still the same fault instance');
    assert.match(standing()[0].text, /past the 120-minute bound the loop ends the attempt and stops its supervisor, returning GY-1457 to the queue with its worktree kept$/, 'the fault records the reclaim');
    await cycle();
    assert.equal(supervisor.running, false);
    assert.equal(standing().length, 1, 'one fault instance across the whole episode');
    assert.equal(state.faults.open[Object.keys(state.faults.open).find(key => key.startsWith('unsubmitted-attempt|GY-1457')) ?? ''], undefined, 'and ends once the item is back in the queue');
  } finally { await cleanup(); }
});
