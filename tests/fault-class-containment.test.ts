import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { containmentSettlementRefusals, containmentVerificationSchema, containmentAttestation } from '../src/quarantine.js';
import type { SupervisorProbeReport } from '../src/containment-probe.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Work } from '../src/model.js';
import { assessContainment, masterConfigSchema, type ContainmentAssessment, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { containmentSettleWaitBoundMs, cycleFaults, emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { settleDue, settleEndedAttemptFence, transientSettlementRefusal } from '../src/daemon/cycle-reclaim.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { SessionHandle } from '../src/model/sessions.js';
import { workFaults } from '../src/model/fault-classes.js';
import { containmentPhase } from '../src/model/containment.js';
// Time-bomb allowance (GY-1694): the 2026-10-03/05 instance stamps are replayed ledger fixtures judged on Date.parse(entry.observedAt); the Date.now() case builds its own lapsed fence relative to the real clock and judges it there; the 2026-10-18/19 instance ids are test names, replayed as relative-deadline fixtures whose fence deadlines derive from the real clock (GY-2151).

// GY-1151 names this file for its proof: manual:fault-class-containment. The master loop filed 7 containment
// faults in 24 hours on 3 October 2026. Every one was a completed or interrupted attempt whose containment
// fence was inside the 120-second grace window (containmentGraceMs) before supervisor absence can legally
// be verified or settled. Within minutes, autosettle cleanly settled every one of them without intervention.
//
// The shared cause:
//   - workFaults emitted a containment fault on any item with containmentQuarantine whenever it lacked an
//     active lease, ignoring whether the item was in its routine grace window (containmentPhase 'grace');
//   - cycleFaults classified the derived attention line containment-grace as a containment fault when not
//     covered by an own fault.
//
// Each instance is replayed from the ledger (`graphyard events GY-N`) as the item stood at the instant
// the loop recorded it. Against the base each subtest fails: the instance reproduces. Against the candidate
// each passes: no fault is observed while inside the grace window, and genuinely lapsed quarantines past
// grace are observed as containment faults.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  autoMerge: true, mergeMethod: 'merge', workers: [],
});

interface Instance {
  id: string;
  subject: string;
  observedAt: string;
  epoch: number;
  owner: string;
  leaseExpiresAt: string;
  launchExpiresAt: string;
  settlementHash: string;
  settled: string;
}

const instances: Instance[] = [
  {
    id: 'containment|GY-1027|2026-10-03T08:26:44.721Z',
    subject: 'GY-1027',
    observedAt: '2026-10-03T08:26:44.721Z',
    epoch: 16,
    owner: 'graphyard-claude-2',
    leaseExpiresAt: '2026-10-03T08:28:18.423Z',
    launchExpiresAt: '2026-10-03T08:27:00.000Z',
    settlementHash: '8b7f2f118121db5976b70743b18566d8ba9c9963e6e8e8ce1b29a24d2ef79a29',
    settled: 'submitted 08:26:39, autosettled 08:32:15',
  },
  {
    id: 'containment|GY-566|2026-10-03T11:09:53.672Z',
    subject: 'GY-566',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 73,
    owner: 'graphyard-claude-2',
    leaseExpiresAt: '2026-10-03T11:08:56.840Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: 'bb9a1adccdb898083aae0c78a05f32eb4a16b9cbbe2c2cead26c459ca2a5f78c',
    settled: 'interrupted 11:06:57, autosettled 11:12:39',
  },
  {
    id: 'containment|GY-973|2026-10-03T11:09:53.672Z',
    subject: 'GY-973',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 17,
    owner: 'graphyard-cursor-2',
    leaseExpiresAt: '2026-10-03T11:08:33.208Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: '2fb2853177894d8a55e2d67ad97e55ceea73fcb5c71b697669d03d3ce6b2518e',
    settled: 'interrupted 11:06:57, autosettled 11:12:39',
  },
  {
    id: 'containment|GY-1070|2026-10-03T11:09:53.672Z',
    subject: 'GY-1070',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 20,
    owner: 'graphyard-claude-3',
    leaseExpiresAt: '2026-10-03T11:08:40.852Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: 'd3d62283084196ddc862bc341df47da3dcbf1ca75fbca8e3f43454b5ae17e817',
    settled: 'interrupted 11:06:47, autosettled 11:12:39',
  },
  {
    id: 'containment|GY-1098|2026-10-03T11:09:53.672Z',
    subject: 'GY-1098',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 14,
    owner: 'graphyard-claude-4',
    leaseExpiresAt: '2026-10-03T11:08:12.783Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: 'f4f3c0598858db1e2333b2bf0dbb6e22f281e5927ad2ff5507ea9999a4c86cb3',
    settled: 'interrupted 11:06:37, autosettled 11:12:18',
  },
  {
    id: 'containment|GY-1099|2026-10-03T11:09:53.672Z',
    subject: 'GY-1099',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 14,
    owner: 'graphyard-opencode-3',
    leaseExpiresAt: '2026-10-03T11:08:12.836Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: 'f72da0c7ba0d7dbe9812401ba2a94fb2193b2a3c74daaf013cf8e87498c4b7b2',
    settled: 'interrupted 11:06:37, autosettled 11:12:18',
  },
  {
    id: 'containment|GY-1147|2026-10-03T11:09:53.672Z',
    subject: 'GY-1147',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 1,
    owner: 'graphyard-opencode-4',
    leaseExpiresAt: '2026-10-03T11:09:04.288Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: '23e20ec42c3886566dca0b1c099042b47ecda4a572a6b22bce37d45f3efefb61',
    settled: 'interrupted 11:07:11, autosettled 11:12:18',
  },
];

/** The item as it stood when the loop observed it: attempt finished/interrupted, lease cleared, quarantine in grace window. */
function standing(entry: Instance): Work {
  return {
    id: `work-${entry.subject}`,
    key: entry.subject,
    title: entry.subject,
    description: '',
    type: 'feature',
    priority: 2,
    dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The behaviour changes as described', proofs: ['unit:behaviour-changes'] }],
    policy: { checks: ['test'], review: true },
    stage: 'implementation',
    revision: 1,
    policyRevision: 1,
    createdAt: entry.observedAt,
    updatedAt: entry.observedAt,
    stageEnteredAt: entry.observedAt,
    ready: true,
    epoch: entry.epoch,
    lease: null,
    workspaces: [],
    candidate: null,
    submission: null,
    reworkRequested: false,
    scenarioRequirements: [],
    evidence: [],
    observation: null,
    blocker: null,
    gates: [],
    violations: [],
    containmentQuarantine: {
      at: entry.observedAt,
      epoch: entry.epoch,
      owner: entry.owner,
      leaseExpiresAt: entry.leaseExpiresAt,
      launchExpiresAt: entry.launchExpiresAt,
      settlementHash: entry.settlementHash,
      scope: { pid: 12345, unit: `graphyard-${entry.subject}.scope` },
    },
  } as unknown as Work;
}

function containmentFaults(work: Work, at: string) {
  return cycleFaults(emptyDaemonState(config()), [work], Date.parse(at), { config: config() })
    .filter(fault => fault.faultClass === 'containment');
}

for (const entry of instances) {
  test(`manual:fault-class-containment — ${entry.id} (${entry.settled}) is no fault while in grace window`, () => {
    const work = standing(entry);
    const clock = Date.parse(entry.observedAt);
    const phase = containmentPhase(work, clock);
    assert.equal(phase?.state, 'grace', `${entry.subject} must be in grace window at observed timestamp`);
    assert.deepEqual(workFaults(work, clock).filter(fault => fault.faultClass === 'containment'), [], 'workFaults observes no containment fault during grace');
    assert.deepEqual(containmentFaults(work, entry.observedAt).map(fault => fault.kind), [], `${entry.subject} has no containment fault while in grace`);
  });
}

test('manual:fault-class-containment — a genuinely lapsed quarantine past the settle wait bound is observed as a containment fault', () => {
  const entry = instances[0];
  const work = standing(entry);
  // 5 minutes past the settle wait bound that follows the grace window (GY-1299)
  const pastGrace = Date.parse(entry.leaseExpiresAt) + 120_000 + containmentSettleWaitBoundMs + 300_000;
  const phase = containmentPhase(work, pastGrace);
  assert.equal(phase?.state, 'lapsed', 'quarantine must be lapsed after grace window has passed');
  const own = workFaults(work, pastGrace).filter(fault => fault.faultClass === 'containment');
  assert.equal(own.length, 1);
  assert.equal(own[0].kind, 'containment');
  assert.match(own[0].text, /Containment quarantine from epoch 16 holds GY-1027/);
  const cycle = containmentFaults(work, new Date(pastGrace).toISOString());
  assert.equal(cycle.length, 1);
  assert.equal(cycle[0].kind, 'containment');
});

// ---------------------------------------------------------------------------
// GY-1299: 3 containment faults in 24 hours on 5 October 2026, after GY-1151 and GY-1155 shipped.
//
// None was a fence the product could not handle: each was verified gone and autosettled by the
// loop's reclaim step within a minute of being counted. The shared cause:
//   - a fence counted the moment its grace window ended, or the moment master status showed it
//     verified settleable, although the reclaim step settles a verified-dead fence on its own;
//   - the faults pass read the cycle-start snapshot, so the very cycle that settled a fence still
//     counted it (settleQuarantine did not clear the fence from the cycle's record, as GY-1155's
//     ended-attempt settlement does);
//   - one fence counted under two kinds: `containment-settleable` while its grace window still ran
//     (the item's own record shows no fault inside grace, so nothing restated the line), then the
//     own-record `containment` hold once the window ended.
// The candidate counts a lapsed fence only once it has stood past containmentSettleWaitBoundMs
// after its grace window (containmentInMotion), under either kind, and the reclaim step clears a
// fence it settled from the cycle's record. Each instance is replayed from the ledger
// (`graphyard events GY-N`): the lease deadline from the attempt's last heartbeat (+120s), the
// launch deadline from its ending, the settlement from its `autosettle` row.
// ---------------------------------------------------------------------------

interface Replay { id: string; subject: string; observedAt: string; epoch: number; owner: string; leaseExpiresAt: string; launchExpiresAt: string; settled: string; assessed: 'settleable' | null }
const replays: Replay[] = [
  { id: 'containment|GY-1147|2026-10-05T09:31:42.251Z', subject: 'GY-1147', observedAt: '2026-10-05T09:31:42.251Z', epoch: 14, owner: 'graphyard-codex-1',
    leaseExpiresAt: '2026-10-05T09:29:17.594Z', launchExpiresAt: '2026-10-05T09:29:31.718Z', assessed: null,
    settled: 'blocked 09:27:31 (lease released), last heartbeat 09:27:17, counted 11s past grace, autosettled 09:32:10' },
  { id: 'containment-settleable|GY-1289|2026-10-05T12:50:59.090Z', subject: 'GY-1289', observedAt: '2026-10-05T12:50:59.090Z', epoch: 1, owner: 'graphyard-codex-2',
    leaseExpiresAt: '2026-10-05T12:49:00.817Z', launchExpiresAt: '2026-10-05T12:49:00.000Z', assessed: 'settleable',
    settled: 'submitted 12:47:05, last heartbeat 12:47:00, shown settleable 1.7s before grace ended, autosettled 12:52:43' },
  { id: 'containment|GY-1289|2026-10-05T12:52:30.229Z', subject: 'GY-1289', observedAt: '2026-10-05T12:52:30.229Z', epoch: 1, owner: 'graphyard-codex-2',
    leaseExpiresAt: '2026-10-05T12:49:00.817Z', launchExpiresAt: '2026-10-05T12:49:00.000Z', assessed: 'settleable',
    settled: 'the same fence, 89s past grace, in the cycle whose reclaim step autosettled it at 12:52:43' },
];
const kindOf = (id: string) => id.slice(0, id.indexOf('|'));
function replayed(entry: Replay): Work {
  return { ...standing({ ...entry, settlementHash: 'c'.repeat(64) }), workspaces: [{ host: 'machine-a', path: `/srv/${entry.subject}`, epoch: entry.epoch, owner: entry.owner, branch: 'b' }] } as Work;
}
const assessment = (work: Work, entry: Replay): Record<string, ContainmentAssessment> => entry.assessed ? { [work.id]: {
  key: work.key, id: work.id, epoch: entry.epoch, owner: entry.owner, at: entry.observedAt, host: 'machine-a', workspacePath: `/srv/${entry.subject}`,
  scope: work.containmentQuarantine!.scope ?? null, settleable: true, refusals: [], attestation: '', verification: null } } : {};

for (const entry of replays) {
  test(`manual:fault-class-containment — ${entry.id} (${entry.settled}) is a fence the loop is settling, not a fault`, () => {
    const work = replayed(entry), clock = Date.parse(entry.observedAt);
    const observed = cycleFaults(emptyDaemonState(config()), [work], clock, { config: config(), containment: assessment(work, entry) })
      .filter(fault => fault.faultClass === 'containment');
    // The base counted this instance under this kind; the candidate counts neither kind inside the bound.
    assert.deepEqual(observed.map(fault => `${fault.kind}|${fault.subject}`), [], `${entry.subject} was counted as ${kindOf(entry.id)} on the base`);
    // Still standing past the bound, the same fence counts once, as the item's own hold, whatever master status shows.
    const late = clock + containmentSettleWaitBoundMs + 60_000;
    const standingLate = cycleFaults(emptyDaemonState(config()), [work], late, { config: config(), containment: assessment(work, entry) })
      .filter(fault => fault.faultClass === 'containment');
    assert.deepEqual(standingLate.map(fault => fault.kind), ['containment'], 'a fence standing past the bound is one containment fault');
  });
}

test('manual:fault-class-containment — the cycle whose reclaim step settles a fence past the bound counts no fault for it', async () => {
  // A fence lapsed well past the settle wait bound: only the reclaim step's settlement can keep it from counting.
  const host = 'coordinator-host', path = '/srv/worktrees/GY-1289-1', scope = { unit: 'graphyard-watch-3948957.scope', pid: 3948957 };
  const lapsed = Date.now() - containmentSettleWaitBoundMs - 5 * 60_000;
  const iso = (at: number) => new Date(at).toISOString();
  const item = { ...replayed(replays[2]), id: 'work-1289', key: 'GY-1289', stage: 'build', submission: null,
    workspaces: [{ host, path, epoch: 1, owner: 'worker-a', branch: 'graphyard/gy-1289-1' }],
    containmentQuarantine: { owner: 'worker-a', epoch: 1, at: iso(lapsed - 15 * 60_000), settlementHash: 'a'.repeat(64), launchAcknowledgedAt: iso(lapsed - 15 * 60_000),
      launchExpiresAt: iso(lapsed), leaseExpiresAt: iso(lapsed), scope } } as unknown as Work;
  const plane = { item: structuredClone(item), settles: 0 };
  const probe = (): SupervisorProbeReport => ({ method: 'linux-proc-systemd', platform: 'linux', uid: 1000, workspacePath: path, held: [], inaccessible: 0, unverifiable: [],
    processes: [], scopes: [], recordedScope: { ...scope, activeState: 'inactive' } }) as unknown as SupervisorProbeReport;
  const directory = await temporaryDirectory('containment-fault-class');
  try {
    const credentialFile = join(directory, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const worker = { name: 'claude-1', principal: 'worker-a', agentName: 'graphyard-claude-1', mode: 'launch', kind: 'claude', credentialFile: '/srv/credentials/claude-1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
    const loopConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234,
      hostId: host, masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [worker] });
    const state: DaemonState = emptyDaemonState(loopConfig);
    const effects = {
      agents: () => [], herdr: () => ({ agents: [], available: true }),
      credentials: async (profiles: WorkerProfile[]) => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: [structuredClone(plane.item)], now: iso(Date.now()) }),
      dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
      observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(Date.now()), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, requestSmoke: () => {}, closeSession: () => {}, persist: async () => {}, preserveWork: async () => ({ state: 'clean' }),
      reportCapacity: async (_work: Work, event: any) => { plane.item.capacity = { exhaustions: [{ ...event, event: undefined, at: iso(Date.now()), owner: 'worker-a', recordedBy: 'coordinator' }], escalations: [] }; return structuredClone(plane.item); },
      controlPlaneClock: async () => ({ clockOffset: { min: 0, max: 0 }, roundTripMs: 1, source: 'timed read' }),
      containment: (work: Work[], observed: any) => assessContainment(work, { hostId: host, observedAt: observed.now, clockOffset: observed.clockOffset, clockRoundTripMs: observed.clockRoundTripMs, clockSource: observed.clockSource, probe }),
      settleContainment: async (_work: Work, verified: ContainmentAssessment) => {
        plane.settles++;
        const refusals = containmentSettlementRefusals(plane.item, containmentVerificationSchema.parse(verified.verification), { now: Date.now() });
        if (refusals.length) throw new Error(`Automatic containment settlement refused: ${refusals.join('; ')}`);
        plane.item.containmentQuarantine = null;
      },
    } as unknown as DaemonEffects;
    await runCycle(loopConfig, state, effects);
    assert.equal(plane.settles, 1, 'the reclaim step settled the verified-dead fence');
    assert.equal(state.actions['settle:work-1289:1']?.state, 'done');
    assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'containment').map(instance => instance.id), [],
      'and the faults pass of that same cycle read the fence gone, so no instance opened');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// GY-2151: 3 containment faults in 24 hours on 18–19 October 2026, after GY-1155 and GY-1299 shipped.
//
// Every one was the loop's own autosettle POST refused by the plane's referee, and each refusal
// opened an action:settle instance that invited the operator attestation path:
//   - GY-2075 19:53:30Z, epoch 3: the POST met `fetch failed` — the plane never answered it — and
//     the failure was classed as the host's, so the fence took the widening action backoff instead
//     of a next-cycle fresh-probe retry;
//   - GY-2085 23:35:21Z, epoch 3, and GY-2113 00:55:13Z, epoch 2: one second after the loop closed a
//     submitted attempt's session it POSTed a settlement its own record called settleable, while
//     the plane's live record still fenced the item — the worker's last heartbeat had renewed the
//     lease the quarantine retained (to 23:36:32Z / 00:56:42Z), GY-2085's launch authority ran to
//     23:36:02Z, and the session observation written after the close had replaced the close
//     outcome the loop's record waived the windows on. The plane refused each POST correctly, and
//     settled both fences itself (23:39:03Z / 00:59:25Z), exactly when its own grace allowed.
// The shared cause: the loop's settlement gate is judged on a record the loop holds — the cycle's
// snapshot, or the record its ending constructed — while the fence is lowered by the plane judging
// its own. The candidate judges every settlement on the record the plane holds now, at the latest
// control-plane time the verification's measured clock bound allows, and posts only when the
// plane's own referee would lower the fence; a POST the plane never answered is a transient
// refusal, retried on the next cycle with a fresh probe and counted as the plane's outage, not the
// fence's fault. Each instance is replayed from the ledger (`graphyard events GY-N`), the plane
// judging with the engine's own refusals on the record it holds.
// ---------------------------------------------------------------------------

const fenceHost = 'vishrog', fencePath = '/srv/worktrees/GY-2151-2', fenceScope = { unit: 'graphyard-watch-1511378-7d52feae-e43e-4d96-9ccc-5d5c2878bf99.scope', pid: 1511378 };
const fenceIso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const fenceClose = (pane: string) => `closed by the loop: GY-2151 has left build, the stage this implementation session was launched for, and is now in test; pane ${pane} closed`;
const fenceObserved = (pane: string) => `the claude runtime on ${fenceHost} no longer reports pane ${pane}: the attempt was submitted as a pull request, so the session is over`;

/**
 * The item as two records held it around one refused settlement: `outcome` is the session handle's —
 * the loop's close, or the observation that overwrote it on the plane; `lease` and `launch` are the
 * fence deadlines as offsets from now (negative: expired). The plane's record keeps the lapsed lease
 * its reconciliation had yet to clear, as both instances' did.
 */
function fencedItem(outcome: 'loop' | 'observed', deadlines: { lease: number; launch: number }, epoch: number, owner: string, pane: string): Work {
  return {
    id: 'work-2151', key: 'GY-2151', title: 'Fence', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Settles', proofs: ['unit:fence-settles'] }],
    policy: { checks: ['test'], review: true }, stage: 'review', revision: 3, policyRevision: 1,
    createdAt: fenceIso(-60 * 60_000), updatedAt: fenceIso(0), stageEnteredAt: fenceIso(-30 * 60_000), ready: true, epoch,
    lease: { owner, epoch, expiresAt: fenceIso(deadlines.lease) },
    lastAssignment: { owner, epoch, claimedAt: fenceIso(-30 * 60_000) },
    workspaces: [{ host: fenceHost, path: fencePath, epoch, owner, branch: `graphyard/gy-2151-${epoch}` }],
    candidate: null, submission: { epoch, pr: 182 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
    containmentQuarantine: { owner, epoch, at: fenceIso(-30 * 60_000), settlementHash: 'b'.repeat(64), launchAcknowledgedAt: fenceIso(deadlines.launch - 120_000),
      launchExpiresAt: fenceIso(deadlines.launch), leaseExpiresAt: fenceIso(deadlines.lease), scope: fenceScope },
    sessions: [{ id: `${owner}:${epoch}`, kind: 'implementation', principal: owner, epoch: null, runtime: 'claude', host: fenceHost, subject: 'GY-2151', state: 'finished',
      outcome: outcome === 'loop' ? fenceClose(pane) : fenceObserved(pane), pane } as unknown as SessionHandle],
  } as unknown as Work;
}

/**
 * The loop's settle of one fenced submitted attempt against a plane that keeps its own record and
 * judges every autosettle on it with the engine's refusals: the loop probes the record its cycle
 * opened with (`snapshot`) and reads the plane's record afresh before posting; `settle` replaces
 * the POST for a transport failure. Returns the plane, the loop's state and the settle outcome.
 */
async function settleFencedAttempt(live: Work, snapshot: Work, epoch: number, owner: string, pane: string,
  settle?: (work: Work, assessment: ContainmentAssessment) => Promise<unknown>) {
  const plane = { item: structuredClone(live), settles: 0, refusals: [] as string[] };
  const probe = (): SupervisorProbeReport => ({ method: 'linux-proc-systemd', platform: 'linux', uid: 1000, workspacePath: fencePath, held: [], inaccessible: 0, unverifiable: [],
    processes: [], scopes: [], recordedScope: { ...fenceScope, activeState: 'inactive' } }) as unknown as SupervisorProbeReport;
  const directory = await temporaryDirectory('fault-class-containment-fence');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const loopConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234,
    hostId: fenceHost, masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const state: DaemonState = emptyDaemonState(loopConfig);
  const effects = {
    controlPlaneClock: async () => ({ clockOffset: { min: 0, max: 0 }, roundTripMs: 1, source: 'timed read' as const }),
    containment: (work: Work[], observed: { now: string; clockOffset: { min: number; max: number }; clockRoundTripMs?: number; clockSource?: 'timed read' | 'snapshot read' }) =>
      assessContainment(work, { hostId: fenceHost, observedAt: observed.now, clockOffset: observed.clockOffset, clockRoundTripMs: observed.clockRoundTripMs, clockSource: observed.clockSource, probe }),
    settleContainment: async (work: Work, assessment: ContainmentAssessment) => {
      plane.settles++;
      if (settle) return settle(work, assessment);
      const refusals = containmentSettlementRefusals(plane.item, containmentVerificationSchema.parse(assessment.verification), { now: Date.now() });
      plane.refusals.push(...refusals);
      if (refusals.length) throw Object.assign(new Error(JSON.stringify({ error: `Automatic containment settlement refused: ${refusals.join('; ')}. ${containmentAttestation(plane.item.key)}` })), { confirmedRefusal: true });
      plane.item.containmentQuarantine = null;
    },
    readWork: async () => structuredClone(plane.item),
    persist: async () => {},
  } as unknown as DaemonEffects;
  const cycle = { config: loopConfig, state, effects, now: Date.now, snapshot: { work: [structuredClone(snapshot)], now: fenceIso(0) }, clock: Date.now(), clockOffset: { min: 0, max: 0 },
    performed: [], isolate: async (_kind: string, _item: unknown, _name: string, fn: () => Promise<unknown>) => fn(), agents: [], open: [] } as unknown as Cycle;
  const settled = await settleEndedAttemptFence(cycle, structuredClone(snapshot), { epoch, owner, closed: fenceClose(pane) });
  await rm(directory, { recursive: true, force: true });
  return { plane, state, settled, key: `settle:work-2151:${epoch}` };
}
const containmentInstances = (state: DaemonState) => state.faults.instances.filter(instance => instance.faultClass === 'containment');

test('manual:fault-class-containment — action:settle|GY-2075|2026-10-18T19:53:30.673Z (fetch failed) is the plane not answering: a transient refusal retried next cycle with a fresh probe, no instance', async () => {
  // The fence's windows had genuinely passed on both records; the POST itself met `fetch failed`.
  const item = fencedItem('loop', { lease: -10 * 60_000, launch: -12 * 60_000 }, 3, 'graphyard-opencode-1', 'w1V:pRF7');
  const { plane, state, settled, key } = await settleFencedAttempt(item, structuredClone(item), 3, 'graphyard-opencode-1', 'w1V:pRF7',
    async () => { throw new Error('fetch failed'); });
  assert.equal(settled, false, 'the fence stands; the settlement is retried');
  assert.equal(plane.settles, 1, 'the POST was attempted: the gate passed and the transport failed');
  const row = state.actions[key];
  assert.equal(row?.state, 'failed');
  assert.match(row?.detail ?? '', /the control plane did not answer, so it is retried next cycle with a fresh probe/);
  assert.equal(row?.faultClass, undefined, "the plane's outage is a wait, not the fence's fault");
  assert.deepEqual(containmentInstances(state), [], 'no containment instance opens for a plane the loop never reached');
  assert.equal(settleDue(state.actions[key], state.cycle), false, 'not again in the cycle that was refused');
  assert.equal(settleDue(state.actions[key], state.cycle + 1), true, 'but on the next cycle, with a fresh probe');
  assert.equal(transientSettlementRefusal(new Error('fetch failed')), 'the control plane did not answer');
  assert.equal(transientSettlementRefusal(new Error('ECONNRESET')), 'the control plane did not answer');
});

test('manual:fault-class-containment — action:settle|GY-2113|2026-10-19T00:55:13.308Z (lease grace window) is judged on the plane record and waits, not posted and refused', async () => {
  // The loop's snapshot carried the close outcome and a lease deadline 240s old; the plane's live
  // record had the observation's outcome and the last heartbeat's renewal, 60s before its grace end.
  const snapshot = fencedItem('loop', { lease: -240_000, launch: -300_000 }, 2, 'graphyard-opencode-2', 'w1V:pRKB');
  const live = fencedItem('observed', { lease: -60_000, launch: -300_000 }, 2, 'graphyard-opencode-2', 'w1V:pRKB');
  const { plane, state, settled, key } = await settleFencedAttempt(live, snapshot, 2, 'graphyard-opencode-2', 'w1V:pRKB');
  assert.equal(settled, false, 'the fence waits, in motion');
  assert.equal(plane.settles, 0, 'no POST the plane must refuse');
  const row = state.actions[key];
  assert.equal(row?.state, 'waiting');
  assert.match(row?.detail ?? '', /the control plane's own record still fences it .*Worker lease for epoch 2 has not been expired for the required 120s grace window/);
  assert.deepEqual(containmentInstances(state), [], 'the fence in motion is no fault');
  assert.equal(settleDue(state.actions[key], state.cycle + 1), true, 're-probed on the next cycle');

  // The same fence on the cycle its windows pass: the fresh judgment posts, and the plane lowers it.
  const passed = fencedItem('observed', { lease: -300_000, launch: -300_000 }, 2, 'graphyard-opencode-2', 'w1V:pRKB');
  const late = await settleFencedAttempt(passed, structuredClone(passed), 2, 'graphyard-opencode-2', 'w1V:pRKB');
  assert.equal(late.settled, true, "settled once the plane's own grace allows");
  assert.equal(late.plane.item.containmentQuarantine, null);
  assert.equal(late.state.actions[late.key]?.state, 'done');
  assert.deepEqual(containmentInstances(late.state), []);
});

test('manual:fault-class-containment — action:settle|GY-2085|2026-10-18T23:35:21.939Z (lease and launch grace windows) is judged on the plane record and waits, not posted and refused', async () => {
  const snapshot = fencedItem('loop', { lease: -240_000, launch: -300_000 }, 3, 'graphyard-opencode-1', 'w1V:pRJD');
  const live = fencedItem('observed', { lease: -60_000, launch: -60_000 }, 3, 'graphyard-opencode-1', 'w1V:pRJD');
  const { plane, state, settled, key } = await settleFencedAttempt(live, snapshot, 3, 'graphyard-opencode-1', 'w1V:pRJD');
  assert.equal(settled, false, 'the fence waits, in motion');
  assert.equal(plane.settles, 0, 'no POST the plane must refuse');
  const row = state.actions[key];
  assert.equal(row?.state, 'waiting');
  assert.match(row?.detail ?? '', /Worker lease for epoch 3 has not been expired for the required 120s grace window/);
  assert.match(row?.detail ?? '', /Launch authority for epoch 3 has not been expired for the required 120s grace window/);
  assert.deepEqual(containmentInstances(state), []);
});
