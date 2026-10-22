import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, readPlaneDeploys, readPlaneStalls } from '../src/engine.js';
import { dispatchFailureAttention, launchWaits, postMergeWaitReason, reviewLaunchWaitAttentionMs, type DispatchCursor } from '../src/auto-dispatch.js';
import { dispatchFailureCause, deploySkewFailure, noteDispatchFailure, planeWideFailure } from '../src/daemon/dispatch-failures.js';
import type { DaemonState } from '../src/daemon/state.js';
import { checkInvariants, emptyInvariantRecord, invariantDefaults, invariantFaults } from '../src/model/invariants.js';
import { classifyLeaseLapse, deployCovering, deployLeaseWindowMs, leaseLapseCause, leaseLossReason, standingEscalations, type PlaneDeploy, type Principal, type Work } from '../src/model.js';
import { workFaults, type FaultClass, type FaultKind } from '../src/model/fault-classes.js';
import { noteActionOutcome, trackFaults, type FaultRecord } from '../src/model/fault-record.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2177 names this file for its proof: manual:fault-class-session-liveness. The master loop filed
// eight session-liveness faults in 24 hours on 19 October 2026, and they share one cause: each was
// the loop's own designed lifecycle counted as a fault of a session.
//
// The designed post-merge review wait (GY-1525) — four instances, carried from GY-2176's replay:
//
// - launch-review GY-2164 09:12:18Z: request 5070a6b0… on d49c3f94a67a, waited 59 min since 08:56:17Z.
// - launch-review GY-2097 09:12:18Z: request d0844fb8… on 7f3e74f73cd0, waited 1 h 1 min since 08:56:59Z.
// - launch-review GY-2173 09:47:43Z: request 39981eb7… on 80d0656c3739, waited 25 min since 09:32:17Z.
// - launch-review GY-2173 10:14:49Z: request c7543bac… on 80d0656c3739, waited 21 min since 09:58:24Z.
//
//   A normal-risk control-plane head merges on its trial and is reviewed after the merge, so its
//   pre-merge review request launches no reviewer by design. GY-2085 dropped that fault by matching
//   the exact `postMergeWaitReason` string the tick records — but the wait is faulted through
//   `launchWaits`, and a request whose tick entry is lost reports the fallback `waiting for
//   dispatch` instead (a cursor rebuilt at a restart boundary, a hand-removed cursor file, a failed
//   tick after the request was raised, or the entry dropped past the launchWaitLimit cap), a wording
//   the filter misses. The candidate marks the designed wait from the head itself
//   (`reviewedAfterMerge`, as `postMergeWait` on the row) and drops the fault by the mark.
//
// The deploy's release-skew window — four instances around the 11:41Z deploy of 3879e75b5f20:
//
// - action:dispatch GY-1984 11:42:10Z: the re-dispatch claim ran the held CLI of 9a33429aea6b and was
//   refused client-side with the version skew against the served 3879e75b5f20.
// - action:dispatch GY-1989 11:42:10Z: the same refusal, same cause.
// - escalation:lease-loss GY-1989 11:41:56Z: `Worker graphyard-opencode-1 lost lease epoch 5`.
// - invariant:deploy-lease-loss 11:41:56Z: two leases lost within 10 min of the deploy.
//
//   Between a control-plane deploy and the loop's realignment to the served commit (upgrade.ts
//   GY-2169), every call the release before it runs refuses with the version skew before any request
//   is sent: the re-dispatch claims fail, and the workers the deploy stranded can never renew again —
//   their supervisors spend the renewal margin and stop, the leases run out, and the plane reads them
//   as lost workers. The candidate treats the skew refusal as the deploy's own window — the dispatch
//   counts zero against the item, files no fault and cools no profile — and records each deploy on
//   the plane's own ledger (a `plane.deploy` row, written by the liveness tick that first serves the
//   new release), so a lease that runs out inside the window is classed as the deploy's own end:
//   `lease.expired` history with cause `control-plane-deploy`, never a lease-loss escalation, and so
//   nothing for the deploy-lease-loss invariant to count.
//
// Each instance is replayed below with its recorded subject and raise instant; run against the base,
// each test fails at its candidate assertion and the raised line is the reproduction. The wall-clock
// instants below are the recorded fixtures, passed as constants to pure functions — the file reads
// no clock of its own, and the integration case times everything off the database's own clock.

const instances = [
  { subject: 'GY-2164', requestId: '5070a6b07ae330903821de359f331b9b', sha: 'd49c3f94a67a', requestedAt: '2026-10-19T08:56:17.665Z', raisedAt: '2026-10-19T09:12:18.646Z' },
  { subject: 'GY-2097', requestId: 'd0844fb8cf7411f02173c35430b52a8d', sha: '7f3e74f73cd0', requestedAt: '2026-10-19T08:56:59.228Z', raisedAt: '2026-10-19T09:12:18.646Z' },
  { subject: 'GY-2173', requestId: '39981eb7d0398ba70605852302e0ed21', sha: '80d0656c3739', requestedAt: '2026-10-19T09:32:17.323Z', raisedAt: '2026-10-19T09:47:43.434Z' },
  { subject: 'GY-2173', requestId: 'c7543baca87fde522a86eb3d0af4fcc2', sha: '80d0656c3739', requestedAt: '2026-10-19T09:58:24.215Z', raisedAt: '2026-10-19T10:14:49.112Z' },
] as const;

const stale = '9a33429aea6b69c030a5774dcf50e0da1a63960f', served = '3879e75b5f20bc30d6fca3406d4e6d544184995f';
const dispatchInstances = [
  { subject: 'GY-1984', at: '2026-10-19T11:42:10.446Z' },
  { subject: 'GY-1989', at: '2026-10-19T11:42:10.708Z' },
] as const;
const leaseLossAt = '2026-10-19T11:41:56.302Z';
/** The deploy the liveness tick recorded when the process serving `served` took its first tick. */
const deploy: PlaneDeploy = { commit: served, from: '2026-10-19T11:40:50.000Z', to: '2026-10-19T11:41:30.000Z' };
/** The failure the launcher read from the claim the held CLI of `stale` ran against the served `served`. */
const skewFailure = (subject: string) =>
  `Command failed: /usr/bin/node /home/vish/code/graphyard/.graphyard/held-cli/${stale.slice(0, 12)}/bin/graphyard.mjs claim ${subject}` +
  `\nCLI commit ${stale} and server commit ${served} differ: run graphyard upgrade`;

const H = 'a'.repeat(40), B = 'b'.repeat(40);
const fullSha = (prefix: string) => prefix + '0'.repeat(40 - prefix.length);
const hour = 3_600_000;
const emptyFault = () => ({ instances: [], open: {}, failing: {} } as FaultRecord);

/** A control-plane head whose normal-risk delta merges on its trial (GY-1525): its pre-merge review request is the designed post-merge wait. */
function planeHead(key: string, request: { id: string; sha: string; requestedAt: string }): Work {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'graphyard-claude-1' };
  const raised = Date.parse(request.requestedAt);
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, stage: 'review', revision: 3, policyRevision: 1,
    createdAt: new Date(raised - 24 * hour).toISOString(), updatedAt: new Date(raised - hour).toISOString(), stageEnteredAt: new Date(raised - 2 * hour).toISOString(),
    ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { source: 'control-plane', at: new Date(raised - hour).toISOString(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['src/feature.ts'], scopeFiles: [{ path: 'src/feature.ts', status: 'modified', sha: fullSha('f'), additions: 1, deletions: 0, binary: false }], baseTip: B, baseTipContained: true },
    autoDispatch: { review: { id: request.id, kind: 'review', provider: 'github', sha: request.sha, baseSha: B, policyRevision: 1, pr: 7, requestedAt: request.requestedAt, reason: 'review of the head', state: 'requested' }, producers: [] },
  } as unknown as Work;
}

/** The cursor a restarted loop reads before its first tick covers the request: no entry, so the wait reports its fallback reason. */
const restartCursor: Pick<DispatchCursor, 'lastTick' | 'failures'> = { failures: {}, lastTick: null };

/** The attention lines an opened fault record is fed as: the fault observation each line carries. */
const asObservations = (items: { kind?: FaultKind; faultClass?: FaultClass; subject: string; text: string }[]) =>
  items.map(item => ({ kind: item.kind!, faultClass: item.faultClass!, subject: item.subject, text: item.text }));

for (const [index, instance] of instances.entries()) {
  test(`manual:fault-class-session-liveness — instance ${index + 1}, launch-review on ${instance.subject} (${instance.requestId.slice(0, 8)} at ${instance.raisedAt}): the designed post-merge wait files no fault, though the wait itself is still reported`, () => {
    const work = planeHead(instance.subject, { id: instance.requestId, sha: instance.sha, requestedAt: instance.requestedAt });
    const rows = launchWaits([work], restartCursor, Date.parse(instance.raisedAt));
    assert.deepEqual(rows.map(row => [row.work, row.requestId, row.reason, row.waitedMs > reviewLaunchWaitAttentionMs]),
      [[instance.subject, instance.requestId, 'waiting for dispatch', true]], 'the recorded request is the wait past the bound, its tick entry lost at the restart boundary');
    const attention = dispatchFailureAttention({ waiting: rows });
    assert.deepEqual(attention.map(item => [item.subject, item.kind, item.faultClass]), [],
      `the designed post-merge wait of ${instance.subject} raises no launch-review fault (the base opens the recorded instance here)`);
    assert.deepEqual(trackFaults(emptyFault(), asObservations(attention), instance.raisedAt).map(opened => opened.id), [],
      `no launch-review|${instance.subject}|${instance.raisedAt} instance — the id the loop recorded — opens at the candidate`);
  });
}

test('manual:fault-class-session-liveness — the recorded wording (the tick entry survived with the designed reason): the wait is still listed with how long and why, and files no fault', () => {
  const instance = instances[0];
  const work = planeHead(instance.subject, { id: instance.requestId, sha: instance.sha, requestedAt: instance.requestedAt });
  const cursor: Pick<DispatchCursor, 'lastTick' | 'failures'> = { failures: {}, lastTick: { at: instance.requestedAt, launched: 0, refused: 0, waiting: 1, settled: 0, closed: 0, closeFailures: [], reasons: [],
    waits: [{ kind: 'review', work: instance.subject, requestId: instance.requestId, sha: fullSha(instance.sha), reason: postMergeWaitReason }] } };
  const rows = launchWaits([work], cursor, Date.parse(instance.raisedAt));
  assert.deepEqual(rows.map(row => [row.work, row.reason, row.waitedMs > reviewLaunchWaitAttentionMs]),
    [[instance.subject, postMergeWaitReason, true]], 'the designed wait is still reported, past the bound, with its own reason');
  const attention = dispatchFailureAttention({ waiting: rows });
  assert.deepEqual(attention, [], 'and it files no launch-review fault — dropped by the head it belongs to, not by the wording its entry carries');
  assert.deepEqual(trackFaults(emptyFault(), asObservations(attention), instance.raisedAt).map(opened => opened.id), []);
});

for (const [index, instance] of dispatchInstances.entries()) {
  test(`manual:fault-class-session-liveness — instance ${index + 5}, action:dispatch on ${instance.subject} (${instance.at}): the deploy's release-skew window counts zero and files no fault`, () => {
    const failure = skewFailure(instance.subject);
    // The base counted the refusal as the item's first failure of its cause (the recorded "failure 1
    // of 3") and recorded the failed dispatch as a fault of the item's, which opened exactly the
    // recorded instance:
    const cause = dispatchFailureCause({ key: instance.subject } as Work, failure);
    assert.match(cause, /CLI commit <sha> and server commit <sha> differ: run graphyard upgrade/, 'the cause outlives the commits it names');
    const base = noteActionOutcome(emptyFault(), `dispatch:work-${instance.subject}`, 'failed',
      { kind: 'action:dispatch', faultClass: 'session-liveness', subject: instance.subject, text: `Dispatch of ${instance.subject} to opencode-primary failed: ${failure}` }, instance.at);
    assert.equal(base?.id, `action:dispatch|${instance.subject}|${instance.at}`, 'the base opens exactly the recorded instance here');
    // The candidate names the window for what it is — the deploy's, not the item's, the profile's or
    // the plane's outage — and the launch treats it as it treats a plane-wide failure: no profile
    // cool-off, a zero count toward the dispatch-failure blocker, and no fault recorded at all.
    assert.equal(deploySkewFailure(failure), true, 'the refusal names the skew of the deploy, however the launcher worded the command failure');
    assert.equal(deploySkewFailure(cause), true, 'the normalized cause carries the same refusal');
    assert.equal(planeWideFailure(failure), false, 'the plane was answering; the CLI refused to speak to it');
    assert.equal(deploySkewFailure('HTTP 502 Bad Gateway'), false, 'a plane-wide outage stays the plane-wide class');
    const state = { dispatchFailures: {} } as DaemonState;
    const run = noteDispatchFailure(state, { id: `work-${instance.subject}`, key: instance.subject, epoch: 3 }, failure, instance.at);
    assert.equal(run.count, 0, 'the window counts zero: no run starts, no blocker can accrue, and the next aligned cycle claims again');
    assert.deepEqual(state.dispatchFailures, {}, 'and the window is kept nowhere');
    assert.deepEqual(trackFaults(emptyFault(), [], instance.at).map(opened => opened.id), [],
      `no action:dispatch|${instance.subject}|${instance.at} instance — the id the loop recorded — opens at the candidate`);
  });
}

test('manual:fault-class-session-liveness — instance 7, escalation:lease-loss on GY-1989 (2026-10-19T11:41:56.302Z): the deploy window explains the lapse, so no lease-loss is raised', () => {
  const lease = { owner: 'graphyard-opencode-1', epoch: 5, expiresAt: leaseLossAt };
  // The base explained nothing: the plane was answering, so no stall covered the expiry, and the
  // silent lapse raised the lease-loss whose reason the instance records.
  assert.equal(leaseLossReason(lease), 'Worker graphyard-opencode-1 lost lease epoch 5', 'the recorded instance is this escalation, raised at the reconcile tick that found the lease expired');
  assert.equal(leaseLapseCause({ submission: null } as Work, lease, [], []), null, 'the base explains nothing: attestations empty, no stall covers the expiry');
  assert.equal(classifyLeaseLapse({ submission: null } as Work, lease, []), 'lost');
  const work = { key: 'GY-1989', stage: 'build', escalations: [{ trigger: 'lease-loss', reason: leaseLossReason(lease), at: leaseLossAt, actor: 'graphyard' }], violations: [] } as unknown as Work;
  assert.deepEqual(trackFaults(emptyFault(), workFaults(work, Date.parse(leaseLossAt)), leaseLossAt).map(opened => opened.id),
    ['escalation:lease-loss|GY-1989|2026-10-19T11:41:56.302Z'], 'the base observes exactly the recorded instance here');
  // The candidate reads the deploy the plane's own tick recorded: from the moment the newer release
  // answered, the worker's release refused every renewal client-side with the version skew and no
  // retry of its own could land one, so the lapse inside the window is the deploy's own end —
  // `lease.expired` history with cause `control-plane-deploy`, never an escalation, and therefore
  // never the fault above.
  assert.deepEqual(leaseLapseCause({ submission: null } as Work, lease, [], [], [deploy]), { cause: 'control-plane-deploy', attestation: null, deploy }, 'the deploy window covers the expiry');
  assert.equal(classifyLeaseLapse({ submission: null } as Work, lease, [], [], [deploy]), 'expired');
  assert.equal(deployCovering([deploy], Date.parse(deploy.to) + deployLeaseWindowMs)?.commit, served, 'the window runs to the deployLeaseWindowMs bound after the newer release answered');
  assert.equal(deployCovering([deploy], Date.parse(deploy.to) + deployLeaseWindowMs + 1), null, 'past the bound a lapse is the worker\'s own again');
  assert.equal(leaseLapseCause({ submission: null } as Work, lease, [], [], []), null, 'without the deploy on the record the base reading stands');
});

test('manual:fault-class-session-liveness — instance 8, invariant:deploy-lease-loss (2026-10-19T11:41:56.302Z): no lease is lost to a deploy the plane records', () => {
  const loss = (key: string, owner: string, epoch: number) => ({ key, owner, epoch });
  // What the base's engine left: two leases lapsed unexplained inside the deploy's window, each
  // raising its lease-loss, on GY-1984 first and on GY-1989 beside it.
  const raised = [loss('GY-1984', 'graphyard-opencode-1', 4), loss('GY-1989', 'graphyard-opencode-1', 5)];
  const item = ({ key, owner, epoch }: { key: string; owner: string; epoch: number }) => ({
    id: `work-${key}`, key, title: `Item ${key}`, stage: 'build', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: leaseLossAt, machineFiled: false,
    criteria: [], dependencies: [], violations: [], gates: [],
    escalations: [{ trigger: 'lease-loss', reason: leaseLossReason({ owner, epoch }), at: leaseLossAt, actor: 'graphyard' }],
  }) as unknown as Work;
  const builds = [
    { commit: stale, firstSeenAt: '2026-10-19T09:00:00.000Z', lastSeenAt: '2026-10-19T11:41:40.000Z' },
    { commit: served, firstSeenAt: '2026-10-19T11:41:50.000Z', lastSeenAt: '2026-10-19T11:41:50.000Z' },
  ];
  const record = emptyInvariantRecord();
  record.builds = builds;
  const checks = checkInvariants(record, { work: raised.map(item), now: Date.parse(leaseLossAt), thresholds: invariantDefaults, build: served });
  const violated = checks.find(check => check.invariant === 'deploy-lease-loss')!;
  assert.equal(violated.holds, false, 'the base violates the invariant: both losses fall inside the deploy window (the recorded violation, first GY-1984)');
  assert.deepEqual(violated.subjects, ['GY-1984', 'GY-1989']);
  assert.deepEqual(trackFaults(emptyFault(), invariantFaults(checks), leaseLossAt).map(opened => opened.id),
    ['invariant:deploy-lease-loss|invariant:deploy-lease-loss|2026-10-19T11:41:56.302Z'], 'the base opens exactly the recorded instance here');
  // The candidate's engine classes those lapses as the deploy's own before any escalation stands
  // (instance 7), so the record it leaves carries no standing lease-loss for the loop to count:
  const settled = checkInvariants(emptyInvariantRecord(), { work: [], now: Date.parse(leaseLossAt), thresholds: invariantDefaults, build: served });
  const holds = settled.find(check => check.invariant === 'deploy-lease-loss')!;
  assert.equal(holds.holds, true, 'with the lapses classed as the deploy\'s own, no loss stands and the invariant holds');
  assert.match(holds.reading, /no lease lost to one/);
});

// The engine wiring, over the real store: the liveness tick records the deploy when the served
// release changes, and reconciliation classes a lapse inside the window as history. Times are read
// from the database's own clock (the passes read it back), so the case never depends on when it runs.
const human: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'worker-deploy-window', role: 'worker', sessionKind: 'ai' };
let pg: EmbeddedPostgres, store: Store;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2177;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('fault-class-session-liveness'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('fault_class_session_liveness');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/fault_class_session_liveness`); await store.init();
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

test('manual:fault-class-session-liveness — the deploy the tick records explains a lapse inside its window through the real engine: no lease-loss stands, the attempt ends as history', async () => {
  let work = await engine().execute(human, 'create', null, { title: 'deploy-window-lapse', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, randomUUID());
  work = await engine().execute(human, 'ready', work.id, {}, randomUUID());
  work = await engine().execute(worker, 'claim', work.id, {}, randomUUID());
  assert.ok(work.lease, 'the attempt holds its lease');
  // The previous process served `stale`; its last tick is 45 s back — inside one stall bound, so the
  // gap itself records no outage and the deploy is the only record. The process now serving `served`
  // takes its first tick, which is the deploy.
  await store.pool.query(`INSERT INTO plane_liveness(id,tick_at) VALUES(true, now() - interval '45 seconds') ON CONFLICT (id) DO UPDATE SET tick_at = now() - interval '45 seconds'`);
  process.env.GRAPHYARD_BUILD_SHA = served;
  try {
    const serving = engine();
    await serving.reconcile();
    const deploys = await readPlaneDeploys(store.pool, 0, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(deploys.map(deploy => deploy.commit), [served], 'the first tick of the release that changed records the deploy');
    const windowMs = Date.parse(deploys[0].to) - Date.parse(deploys[0].from);
    assert.ok(windowMs >= 45_000 && windowMs < 60_000, 'the window is the replaced release\'s last 45 s of service, inside one stall bound, timed by the database\'s own clock');
    assert.deepEqual(await readPlaneStalls(store.pool, 0, Number.MAX_SAFE_INTEGER), [], 'a gap inside the stall bound is no outage: the deploy window is the only record');
    // The stranded worker's lease runs out inside the window: the release before the deploy could
    // renew no more once the newer release answered.
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{lease,expiresAt}', to_jsonb(to_char((now() - interval '30 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id = $1`, [work.id]);
    await serving.reconcile();
    const lapsed = (await store.list()).find(item => item.id === work.id)!;
    assert.deepEqual(standingEscalations(lapsed).map(entry => entry.trigger), [],
      'the deploy window explains the lapse: no lease-loss stands (the base raises `Worker worker-deploy-window lost lease epoch N` here)');
    const expired = (await store.events(work.id)).filter(event => event.kind === 'lease.expired');
    assert.deepEqual(expired.map(event => [event.payload.details.epoch, event.payload.details.cause, event.payload.details.deploy?.commit]),
      [[work.epoch, 'control-plane-deploy', served]], 'and the attempt ends as history naming the deploy that ended it');
  } finally { delete process.env.GRAPHYARD_BUILD_SHA; }
});

/** A fresh engine per use: each process records the release it serves on its first moving tick. */
function engine(): Engine {
  const created = new Engine(store, [15368], 120, 'owner/project');
  created.principals = [human, worker];
  return created;
}
