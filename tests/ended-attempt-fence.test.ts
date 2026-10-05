import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { assessContainment, masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { containmentFailureNote, supervise, type ContainmentShutdownFailure } from '../src/supervisor.js';
import { agentRequestSchema, leaseHeldRequestTypes } from '../src/model/agent-requests.js';
import { containmentAttestation, containmentSettlementRefusals, containmentVerificationSchema, leaseLapsedEnding, type ContainmentVerification } from '../src/quarantine.js';
import { endWorkerAttempt } from '../src/daemon/cycle-resume.js';
import { settleDue, settleEndedAttemptFence, transientSettlementRefusal } from '../src/daemon/cycle-reclaim.js';
import { workFaults } from '../src/model/fault-classes.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { SupervisorProbeReport } from '../src/containment-probe.js';
import type { Work } from '../src/model.js';
import type { SessionHandle } from '../src/model/sessions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const host = 'coordinator-host';
const path = '/srv/worktrees/GY-1155-3';
const scope = { unit: 'graphyard-watch-4242-0c1e.scope', pid: 4242 };
const worker = { name: 'claude-1', principal: 'worker-a', agentName: 'graphyard-claude-1', mode: 'launch', kind: 'claude', credentialFile: '/srv/credentials/claude-1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const minute = 60_000;

/** An item mid-attempt: its lease live for ten more minutes, the quarantine its supervisor raised at launch, the launch window long past. */
function attempt(overrides: Partial<Work> = {}): Work {
  const epoch = overrides.epoch ?? 3;
  return {
    id: 'work-1155', key: 'GY-1155', title: 'An ended attempt settles its fence', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Settles', proofs: ['unit:ended-attempt-fence-settled-at-once'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'build', revision: 4, policyRevision: 1,
    createdAt: iso(-60 * minute), updatedAt: iso(0), stageEnteredAt: iso(-30 * minute), ready: true, epoch,
    lease: { owner: 'worker-a', epoch, expiresAt: iso(10 * minute) },
    lastAssignment: { owner: 'worker-a', epoch, claimedAt: iso(-30 * minute) },
    workspaces: [{ host, path, epoch, owner: 'worker-a', branch: `graphyard/gy-1155-${epoch}` }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
    containmentQuarantine: { owner: 'worker-a', epoch, at: iso(-30 * minute), settlementHash: 'a'.repeat(64), launchAcknowledgedAt: iso(-30 * minute),
      launchExpiresAt: iso(-28 * minute), leaseExpiresAt: iso(10 * minute), scope },
    ...overrides,
  } as Work;
}

/**
 * The control plane and the coordinator's host, as far as a fence goes. The plane keeps its own
 * record of the item and judges every autosettle with containmentSettlementRefusals on that record,
 * as the engine does; the host's probe reports the supervisor present until it is stopped.
 */
function world(initial: Work, options: { refuseSettles?: string[] } = {}) {
  const plane = { item: clone(initial), settles: 0, refusals: [] as string[], notes: [] as string[] };
  const supervisor = { running: true, probes: 0 };
  const refuseSettles = [...(options.refuseSettles ?? [])];
  const probe = (): SupervisorProbeReport => {
    supervisor.probes++;
    return { method: 'linux-proc-systemd', platform: 'linux', uid: 1000, workspacePath: path, held: [], inaccessible: 0, unverifiable: [],
      processes: supervisor.running ? [{ pid: scope.pid, evidence: 'command' }] : [],
      scopes: supervisor.running ? [{ unit: scope.unit, activeState: 'active', processes: [scope.pid], attributed: [] }] : [],
      recordedScope: { ...scope, activeState: supervisor.running ? 'active' : 'inactive' } } as unknown as SupervisorProbeReport;
  };
  const effects: Partial<DaemonEffects> = {
    controlPlaneClock: async () => ({ clockOffset: { min: 0, max: 0 }, roundTripMs: 1, source: 'timed read' }),
    containment: (work, observed) => assessContainment(work, { hostId: host, observedAt: observed.now, clockOffset: observed.clockOffset, clockRoundTripMs: observed.clockRoundTripMs, clockSource: observed.clockSource, probe }),
    settleContainment: async (_work, assessment) => {
      plane.settles++;
      const refused = refuseSettles.shift();
      if (refused) throw Object.assign(new Error(refused), { confirmedRefusal: !/"code":5\d\d/.test(refused) });
      if (plane.item.containmentQuarantine?.epoch !== assessment.epoch) throw Object.assign(new Error('{"error":"Containment quarantine is missing, superseded, or does not match this verification"}'), { confirmedRefusal: true });
      const refusals = containmentSettlementRefusals(plane.item, containmentVerificationSchema.parse(assessment.verification), { now: Date.now() });
      plane.refusals.push(...refusals);
      if (refusals.length) throw Object.assign(new Error(JSON.stringify({ error: `Automatic containment settlement refused: ${refusals.join('; ')}. ${containmentAttestation(plane.item.key)}` })), { confirmedRefusal: true });
      plane.item.containmentQuarantine = null;
    },
    // A worker exhaustion ends the attempt's lease on the record, as recordCapacity does.
    reportCapacity: async (_work, event: any) => {
      plane.item.capacity = { exhaustions: [...plane.item.capacity?.exhaustions ?? [], { ...event, event: undefined, at: iso(0), owner: 'worker-a', recordedBy: 'coordinator' }], escalations: [] };
      if (plane.item.lease?.epoch === event.epoch) plane.item.lease = null;
      return clone(plane.item);
    },
    preserveWork: async () => ({ state: 'clean' }),
    // The coordinator records the handles it launched without an attempt epoch: one with an epoch
    // must hold that attempt's lease, which the coordinator never does.
    recordSession: async (_work, handle) => {
      if (handle.epoch !== undefined) throw new Error('Implementation lease is missing, expired, or owned by another worker');
      const sessions = plane.item.sessions ?? [], existing = sessions.find(entry => entry.id === handle.id);
      plane.item.sessions = [...sessions.filter(entry => entry.id !== handle.id), { ...existing, ...handle, epoch: existing?.epoch ?? null } as SessionHandle];
    },
    stopSupervisor: () => { supervisor.running = false; },
    closeSession: () => {},
    persist: async () => {},
  };
  return { plane, supervisor, effects };
}

async function loop(effects: Partial<DaemonEffects>, snapshot: () => Work[]) {
  const directory = await temporaryDirectory('ended-fence');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: host,
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [worker] });
  const state: DaemonState = emptyDaemonState(config);
  const all: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: snapshot(), now: iso(0) }),
    dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, closeSession: () => {}, persist: async () => {},
    ...effects,
  } as DaemonEffects;
  // Every cycle's faults pass observes afresh, so a fence left standing is seen on the cycle it stands.
  const run = () => { state.faults.observedAt = undefined; return runCycle(config, state, all); };
  return { config, state, run, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** The cycle the resume step hands an attempt it ends: this test's world as the loop's effects. */
function cycleFor(state: DaemonState, config: MasterConfig, effects: Partial<DaemonEffects>, item: Work): Cycle {
  return { config, state, effects: effects as DaemonEffects, now: Date.now, snapshot: { work: [item], now: iso(0) }, clock: Date.now(), clockOffset: { min: 0, max: 0 },
    performed: [], isolate: async (_kind: string, _item: unknown, _key: string, fn: () => Promise<unknown>) => fn(), agents: [], open: [item] } as unknown as Cycle;
}
const containmentFaults = (state: DaemonState, key: string) => state.faults.instances.filter(instance => instance.faultClass === 'containment' && instance.subject === key);

test('unit:ended-attempt-fence-settled-at-once — an attempt the loop ends has its fence settled in that action, judged on the record the ending wrote, so the item is claimable at once and no containment fault stands', async () => {
  // Idle with its lease live (and so credential-blocked too: both end through endWorkerAttempt).
  // The snapshot still shows the lease live and nothing of the ending; the plane holds the record.
  const { plane, supervisor, effects } = world(attempt());
  const harness = await loop(effects, () => [clone(plane.item)]);
  try {
    const item = clone(plane.item);
    const cycle = cycleFor(harness.state, harness.config, effects, item);
    const outcome = await endWorkerAttempt(cycle, item, worker, 3, 'w1:p4', 'idle past its bound with a live lease', 'ended without submitting: idle past its bound with a live lease');
    assert.equal(supervisor.running, false, 'the supervisor was stopped through its recorded scope');
    assert.match(outcome, /its containment fence was settled/);
    assert.equal(plane.item.containmentQuarantine, null, 'the plane lowered the fence on its own record, inside its grace window');
    assert.equal(plane.item.lease, null, 'and the ending released the lease, so nothing holds the item');
    assert.deepEqual(plane.refusals, []);
    assert.equal(item.containmentQuarantine, null, 'the cycle reads the fence gone for its later steps');
    assert.equal(harness.state.actions['settle:work-1155:3']?.state, 'done');
    assert.equal(plane.item.sessions?.find(handle => handle.id === 'worker-a:3')?.state, 'finished', 'the loop recorded its close of the handle the plane accepts');
    assert.deepEqual(workFaults(plane.item, Date.now()).filter(fault => fault.kind === 'containment'), [], 'no containment fault can be observed of the epoch');
    await harness.run();
    assert.deepEqual(containmentFaults(harness.state, 'GY-1155'), [], 'and the next faults pass records none');
  } finally { await harness.cleanup(); }

  // The orphaned supervisor: a lease that keeps renewing with no agent behind it is ended on the
  // second sight, the supervisor stopped through its scope, and the fence settled in that action.
  const renewing = world(attempt({ lease: { owner: 'worker-a', epoch: 3, expiresAt: iso(30_000) } }));
  let sight = 0;
  const orphaned = await loop(renewing.effects, () => {
    if (renewing.plane.item.lease) renewing.plane.item.lease = { ...renewing.plane.item.lease, expiresAt: iso(30_000 + ++sight * 25_000) };
    return [clone(renewing.plane.item)];
  });
  try {
    await orphaned.run();
    assert.equal(renewing.supervisor.running, true, 'one sight of a renewed lease ends nothing');
    const second = await orphaned.run();
    assert.equal(renewing.supervisor.running, false);
    assert.match(second.actions.find(action => /has outlived the agent/.test(action.detail))?.detail ?? '', /containment fence was settled/);
    assert.equal(renewing.plane.item.containmentQuarantine, null);
    assert.equal(renewing.plane.item.lease, null);
    assert.equal(orphaned.state.actions['settle:work-1155:3']?.state, 'done');
    assert.deepEqual(containmentFaults(orphaned.state, 'GY-1155'), [], 'the faults pass of that cycle saw no fence');
  } finally { await orphaned.cleanup(); }
});

test('the endings of one cycle share its wait for the stopped supervisors, so several held fences stall the cycle one bound, not one each', async () => {
  // Neither supervisor ever goes, so each wait runs to the bound; the second ending still probes once.
  const { supervisor, effects } = world(attempt());
  const harness = await loop(effects, () => []);
  try {
    const first = attempt(), second = attempt({ id: 'work-1156', key: 'GY-1156' });
    const cycle = cycleFor(harness.state, harness.config, effects, first);
    const wait = { boundMs: 300, pollMs: 25 };
    const ending = { epoch: 3, owner: 'worker-a', preserved: 'ended without submitting: idle past its bound with a live lease' };
    const started = Date.now();
    assert.equal(await settleEndedAttemptFence(cycle, first, ending, wait), false, 'a supervisor still held at the bound leaves the fence to the reclaim step');
    assert.ok(Date.now() - started >= 250, 'the first ending waited out the bound');
    const probes = supervisor.probes, resumed = Date.now();
    assert.equal(await settleEndedAttemptFence(cycle, second, ending, wait), false);
    assert.ok(Date.now() - resumed < 150, 'the second ending found the cycle\'s bound spent');
    assert.equal(supervisor.probes, probes + 1, 'and still probed its supervisor once');
    const next = cycleFor(harness.state, harness.config, effects, second), fresh = Date.now();
    await settleEndedAttemptFence(next, second, ending, { boundMs: 100, pollMs: 25 });
    assert.ok(Date.now() - fresh >= 75, 'a new cycle has its own bound');
  } finally { await harness.cleanup(); }
});

function verification(overrides: Partial<ContainmentVerification> = {}): ContainmentVerification {
  return containmentVerificationSchema.parse({ method: 'linux-proc-systemd', host, uid: 1000, platform: 'linux', workspacePath: path, observedAt: iso(-1_000),
    clockOffset: { min: -10, max: 10 }, recordedScope: { ...scope, activeState: 'inactive' }, processes: [], scopes: [], held: [], inaccessible: 0, unverifiable: [], ...overrides });
}
const preserved = (reason: string) => ({ exhaustions: [{ role: 'worker' as const, epoch: 3, cause: 'interrupted' as const, profile: 'claude-1', account: null, runtime: 'claude', reason, resetsAt: null, partialWork: { state: 'clean' as const }, at: iso(-1_000), owner: 'worker-a', recordedBy: 'coordinator' }], escalations: [] });
const closedHandle = (outcome: string) => ({ id: 'worker-a:3', kind: 'implementation', principal: 'worker-a', epoch: null, runtime: 'claude', host, subject: 'GY-1155', state: 'finished', outcome, startedAt: iso(-30 * minute), updatedAt: iso(-1_000), endedAt: iso(-1_000) }) as unknown as SessionHandle;
const grace = (refusals: string[]) => refusals.filter(refusal => /grace window/.test(refusal));

test('unit:ended-attempt-grace-waived-on-loop-record — the grace window is waived exactly for an attempt the loop ended on its own record whose supervisor the host verified gone', () => {
  const now = Date.now();
  // Ended a moment ago: the lease deadline the quarantine kept is ten minutes away, so the grace window has not even begun.
  const ended = (overrides: Partial<Work>) => attempt({ lease: null, ...overrides });
  const unended = containmentSettlementRefusals(ended({}), verification(), { now });
  assert.deepEqual(grace(unended), ['Worker lease for epoch 3 has not been expired for the required 120s grace window'], 'without the loop record the grace window refuses');

  // The loop's preserve — idle, credential-blocked, orphaned — is a worker exhaustion only a coordinator records.
  assert.deepEqual(containmentSettlementRefusals(ended({ capacity: preserved('ended without submitting: idle past its bound with a live lease') }), verification(), { now }), []);
  // The loop's close of a submitted attempt's session.
  assert.deepEqual(containmentSettlementRefusals(ended({ stage: 'review', submission: { epoch: 3, pr: 641 }, sessions: [closedHandle('closed by the loop: GY-1155 has left build, the stage this implementation session was launched for, and is now in review')] }), verification(), { now }), []);
  // A launch window still open is waived with it: the record ended that authority too.
  assert.deepEqual(containmentSettlementRefusals(ended({ capacity: preserved('ended without submitting: credential blocked'), containmentQuarantine: { ...attempt().containmentQuarantine!, launchExpiresAt: iso(minute) } }), verification(), { now }), []);
  // The idle pane shell settlement already excuses does not hold the waiver back either.
  assert.deepEqual(containmentSettlementRefusals(ended({ capacity: preserved('ended without submitting: idle') }), verification({ scopes: [{ unit: scope.unit, activeState: 'inactive', processes: [], attributed: [] }] }), { now }), []);
});

test('unit:ended-attempt-grace-still-refuses-unverified — without the loop record and a verified-gone supervisor the grace window still refuses, and every other refusal stands', () => {
  const now = Date.now();
  const loopEnded = attempt({ lease: null, capacity: preserved('ended without submitting: idle past its bound with a live lease') });
  const graceRefusal = 'Worker lease for epoch 3 has not been expired for the required 120s grace window';
  // The supervisor not verified gone: each keeps the grace refusal beside its own.
  for (const [what, seen, own] of [
    ['a process still held', verification({ processes: [{ pid: 4242, evidence: 'command' }], recordedScope: { ...scope, activeState: 'active' } }), /Process 4242 of the contained worker is still present/],
    ['the recorded scope still active', verification({ recordedScope: { ...scope, activeState: 'active' } }), null],
    ['an incomplete verification', verification({ unverifiable: ['/proc could not be read'] }), /Host verification was incomplete/],
    ['another host', verification({ host: 'other-host' }), /Verification ran on host other-host/],
    ['another workspace', verification({ workspacePath: '/srv/worktrees/elsewhere' }), /Verification inspected \/srv\/worktrees\/elsewhere/],
  ] as [string, ContainmentVerification, RegExp | null][]) {
    const refusals = containmentSettlementRefusals(loopEnded, seen, { now });
    assert.ok(refusals.includes(graceRefusal), `${what}: the grace window still refuses (${refusals.join('; ')})`);
    if (own) assert.ok(refusals.some(refusal => own.test(refusal)), `${what}: its own refusal is unchanged`);
  }
  // Refusals that do not depend on the waiver are unchanged by it.
  assert.ok(containmentSettlementRefusals(loopEnded, verification({ observedAt: iso(-10 * minute) }), { now }).some(refusal => /older than 120s; verify the host again/.test(refusal)), 'stale verification');
  assert.ok(containmentSettlementRefusals(loopEnded, verification({ clockOffset: { min: 9_000, max: 9_500 } }), { now }).some(refusal => /clocks disagree/.test(refusal)), 'clock bound');

  // Records that are not the loop ending this attempt keep the window.
  for (const [what, work] of [
    ['the reclaim of a lapsed lease', attempt({ lease: null, capacity: preserved(`${leaseLapsedEnding} and its supervisor (pid 4242) is verified gone on ${host}`) })],
    ['another epoch\'s exhaustion', attempt({ lease: null, capacity: { ...preserved('ended without submitting: idle'), exhaustions: [{ ...preserved('x').exhaustions[0], epoch: 2 }] } })],
    ['a handle the worker itself marked closed, with no submission', attempt({ lease: null, sessions: [closedHandle('closed by the loop: I am done')] })],
    ['a submission whose handle the loop has not closed', attempt({ lease: null, stage: 'review', submission: { epoch: 3, pr: 641 }, sessions: [closedHandle('submitted and exited')] })],
  ] as [string, Work][]) assert.deepEqual(grace(containmentSettlementRefusals(work, verification(), { now })), [graceRefusal], what);

  // The loop record with its lease still live on it is refused: the record has not ended that lease.
  assert.ok(containmentSettlementRefusals({ ...loopEnded, lease: { owner: 'worker-a', epoch: 3, expiresAt: iso(minute) } }, verification(), { now })
    .includes('Worker lease for epoch 3 is still live, though the record shows the loop ended that attempt'));
});

test('unit:supervisor-settle-failure-recorded-and-settled — a supervisor that cannot lower its fence reports why with its bound, and the loop settles the fence on the cycle it closes the submitted attempt', async () => {
  const lease = () => ({ lease: { epoch: 16, expiresAt: new Date(Date.now() + minute).toISOString() }, updatedAt: new Date().toISOString() });
  const child = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
  // A scope never verified empty within the shutdown bound: the bound and what held it are reported.
  const held: ContainmentShutdownFailure[] = [];
  await assert.rejects(supervise('ignored', [], 16, async () => lease(), { containment: { ...child, unit: scope.unit, signal: () => {}, empty: () => false }, detached: false, graceMs: 5, shutdownPollMs: 1, shutdownTimeoutMs: 20,
    quarantine: { establish: async () => {}, settle: async () => { throw new Error('a scope never verified empty is never settled'); }, report: async failure => { held.push(failure); } } }),
  /Worker containment shutdown could not be verified: containment scope graphyard-watch-4242-0c1e\.scope still held processes \(its scope was not verified empty within 20ms\)/);
  assert.deepEqual(held, [{ reason: `Worker containment shutdown could not be verified: containment scope ${scope.unit} still held processes (its scope was not verified empty within 20ms)`, boundMs: 20, held: `containment scope ${scope.unit} still held processes` }]);
  // A settle POST the plane refuses is reported with the refusal.
  const refused: ContainmentShutdownFailure[] = [];
  await assert.rejects(supervise('ignored', [], 16, async () => lease(), { containment: { ...child, signal: () => {}, empty: () => true }, detached: false, graceMs: 5, shutdownPollMs: 1, shutdownTimeoutMs: 20,
    quarantine: { establish: async () => {}, settle: async () => { throw new Error('Graphyard refused work/GY-1027/settle (502): Application failed to respond'); }, report: async failure => { refused.push(failure); } } }),
  /quarantine could not be settled: Graphyard refused/);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].refusal, 'Graphyard refused work/GY-1027/settle (502): Application failed to respond');
  // `watch` posts the report as a note on the item: a request that needs no lease, since the
  // attempt's may already have ended, and that names the epoch whose fence was left standing.
  const note = agentRequestSchema.parse(containmentFailureNote(16, held[0]));
  assert.equal(note.type, 'note');
  assert.equal(note.epoch, undefined, 'no lease is asked for');
  assert.ok(!leaseHeldRequestTypes.includes(note.type));
  assert.equal(note.reason, `Containment fence of epoch 16 was left standing by its supervisor: ${held[0].reason}`);
  // A report that cannot be delivered does not keep the supervisor from exiting with the failure.
  await assert.rejects(supervise('ignored', [], 16, async () => lease(), { containment: { ...child, signal: () => {}, empty: () => true }, detached: false, graceMs: 5, shutdownPollMs: 1, shutdownTimeoutMs: 20,
    quarantine: { establish: async () => {}, settle: async () => { throw new Error('refused'); }, report: async () => { throw new Error('the plane is unreachable'); } } }), /could not be settled: refused/);

  // GY-1027 epoch 16: submitted, its supervisor gone without lowering the fence. The cycle that
  // closes the attempt's session — the item has left build — settles the fence in that action.
  const submitted = attempt({ epoch: 16, stage: 'review', lease: null, submission: { epoch: 16, pr: 600 },
    lastAssignment: { owner: 'worker-a', epoch: 16, claimedAt: iso(-20 * minute) },
    workspaces: [{ host, path, epoch: 16, owner: 'worker-a', branch: 'graphyard/gy-1155-16' }],
    containmentQuarantine: { ...attempt().containmentQuarantine!, epoch: 16, leaseExpiresAt: iso(-30_000) },
    sessions: [{ ...closedHandle(''), id: 'worker-a:16', state: 'running', outcome: null, pane: 'w1:p9', endedAt: null } as unknown as SessionHandle] });
  const { plane, supervisor, effects } = world(submitted);
  supervisor.running = false;
  const harness = await loop(effects, () => [clone(plane.item)]);
  try {
    const cycle = await harness.run();
    assert.equal(plane.item.sessions?.find(handle => handle.id === 'worker-a:16')?.state, 'finished', 'the loop closed the submitted attempt\'s session');
    assert.equal(plane.item.containmentQuarantine, null, 'and settled its standing fence in the same cycle, 30s into its grace window');
    assert.match(cycle.actions.find(action => action.kind === 'close' && action.work === 'GY-1155')?.detail ?? '', /its containment fence was settled/);
    assert.deepEqual(containmentFaults(harness.state, 'GY-1155'), [], 'no standing fence is seen by the faults pass');
  } finally { await harness.cleanup(); }

  // Closed on an earlier cycle and the fence still standing (the supervisor was still exiting
  // then): the record shows the loop's close, so the reclaim step settles it on the next cycle.
  const later = world({ ...submitted, sessions: [{ ...closedHandle('closed by the loop: GY-1155 has left build'), id: 'worker-a:16' }] });
  later.supervisor.running = false;
  const next = await loop(later.effects, () => [clone(later.plane.item)]);
  try {
    await next.run();
    assert.equal(later.plane.item.containmentQuarantine, null, 'reclaim settles a loop-ended fence without waiting out its grace window');
  } finally { await next.cleanup(); }
});

test('unit:transient-settlement-refusal-retries-next-cycle — a settlement the plane refused with a 5xx or a stale verification is retried on the next cycle with a fresh probe, not on the action backoff', async () => {
  const railway = 'Graphyard refused work/work-1155/autosettle: {"status":"error","code":502,"message":"Application failed to respond","request_id":"x"}';
  const stale = JSON.stringify({ error: `Automatic containment settlement refused: Host verification is older than 120s; verify the host again. ${containmentAttestation('GY-1155')}` });
  const held = JSON.stringify({ error: `Automatic containment settlement refused: Host verification is older than 120s; verify the host again; Process 512 of the contained worker is still present on ${host} (matched by supervisor command line). ${containmentAttestation('GY-1155')}` });
  assert.equal(transientSettlementRefusal(new Error(railway)), 'the control plane answered 5xx');
  assert.equal(transientSettlementRefusal(Object.assign(new Error('{"error":"Internal error"}'), { confirmedRefusal: false })), 'the control plane answered 5xx');
  assert.equal(transientSettlementRefusal(new Error(stale)), 'the host verification went stale before the plane judged it');
  assert.equal(transientSettlementRefusal(new Error(held)), null, 'a stale verification refused beside a held process is the host\'s refusal');
  assert.equal(transientSettlementRefusal(new Error(JSON.stringify({ error: `Automatic containment settlement refused: Process 512 of the contained worker is still present on ${host}; epoch 503. ${containmentAttestation('GY-1155')}` }))), null, 'a pid or an epoch that reads 5xx is no status');

  // A loop-ended attempt whose supervisor is gone: the first settle meets Railway's 502, the second a stale verification.
  for (const refusal of [railway, stale]) {
    const { plane, supervisor, effects } = world(attempt({ lease: null, capacity: preserved('ended without submitting: idle past its bound with a live lease') }), { refuseSettles: [refusal] });
    supervisor.running = false;
    const harness = await loop(effects, () => [clone(plane.item)]);
    try {
      await harness.run();
      const failed = harness.state.actions['settle:work-1155:3'];
      assert.equal(failed?.state, 'failed', 'the first settle was refused');
      assert.match(failed.detail, /retried next cycle with a fresh probe/);
      assert.equal(plane.item.containmentQuarantine?.epoch, 3);
      // After many earlier failures the backoff would hold it for cycles; a transient refusal is not held.
      harness.state.actions['settle:work-1155:3'] = { ...failed, attempts: 6 };
      assert.equal(settleDue(harness.state.actions['settle:work-1155:3'], failed.cycle), false, 'not again in the cycle that was refused');
      const before = supervisor.probes;
      await harness.run();
      assert.ok(supervisor.probes > before, 'the next cycle probed the host afresh');
      assert.equal(harness.state.actions['settle:work-1155:3'].state, 'done', `retried and settled on the next cycle after: ${refusal.slice(0, 60)}`);
      assert.equal(plane.item.containmentQuarantine, null);
    } finally { await harness.cleanup(); }
  }

  // A refusal the host caused keeps the widening backoff.
  const held4 = { kind: 'settle' as const, work: 'GY-1155', principal: null, epoch: 3, state: 'failed' as const, detail: `Containment settlement refused for GY-1155 epoch 3: ${held}`, attempts: 4, cycle: 7, at: iso(0) };
  assert.equal(settleDue(held4, 8), false, 'a host refusal is not retried on the next cycle');
  assert.equal(settleDue(held4, 15), true, 'but on its backoff');
  assert.equal(settleDue({ ...held4, state: 'done' }, 100), false);
});
