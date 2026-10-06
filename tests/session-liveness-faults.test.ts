import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { record as recordAction } from '../src/daemon/effects.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import { FleetUnreachableError } from '../src/fleet.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { workFaults } from '../src/model/fault-classes.js';
import { RefusedResponse } from '../src/model/refusal.js';
// Namespace imports for what GY-1375 adds or changes, so a run against the base fails its cases rather than the module's load.
import * as blockerClass from '../src/model/blocker-class.js';
import * as escalationModule from '../src/model/escalation.js';
import * as approversModule from '../src/daemon/cycle-approvers.js';

// GY-1375 names this file for its proof: manual:fault-class-session-liveness. The master loop filed
// three session-liveness faults in 24 hours on 6 October 2026, and they share one cause: each was a
// window in which the control plane itself was not answering — a restart or an outage — counted as
// a session's own failure to start, stop or keep its lease.
//
// - action:close GY-1359 06:14:41Z: ending an approver's registry session met the restarting
//   server's "503: Startup validation has not completed; retry shortly" (GY-1127). The watch keeps
//   the session and ends it next cycle, which it did; only the plane's restart failed.
// - escalation:lease-loss GY-1373 14:03:39Z: epoch 1 was claimed at 14:01:00Z by a launch that was
//   still waiting out the outage when the lease lapsed; its session record ended "the launch failed
//   before the session started". No worker ever held the lease, so no worker lost it: the lapse is
//   the launch's outcome, which the dispatch step records and classifies.
// - action:dispatch GY-1373 14:10:19Z: the claim failed "fetch failed". The dispatch step already
//   judged it plane-wide (GY-1345: no profile cooled, no blocker counted) but still opened an
//   action:dispatch session-liveness instance for it.
//
// Each instance is replayed below with its recorded text; each test fails on the base.

const instances = [
  { id: 'action:close|GY-1359|2026-10-06T06:14:41.077Z', kind: 'action:close', subject: 'GY-1359', at: '2026-10-06T06:14:41.077Z' },
  { id: 'escalation:lease-loss|GY-1373|2026-10-06T14:03:39.561Z', kind: 'escalation:lease-loss', subject: 'GY-1373', at: '2026-10-06T14:03:39.561Z' },
  { id: 'action:dispatch|GY-1373|2026-10-06T14:10:19.671Z', kind: 'action:dispatch', subject: 'GY-1373', at: '2026-10-06T14:10:19.671Z' },
] as const;
const registry = 'https://graphyard-production.up.railway.app';
/** The registry client's error for the restarting server, as fleet.ts words it from the 503 body src/server/main.ts answers. */
const startup503 = `The agent registry at ${registry} answered 503: Startup validation has not completed; retry shortly`;
/** The claim's failure on GY-1373 at 14:10:19Z, as the launcher recorded it. */
const claimFetchFailed = 'Command failed: /usr/bin/node /home/vish/code/graphyard/bin/graphyard.mjs claim GY-1373\nfetch failed';
const minute = 60_000, hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();
const sessionLiveness = (state: DaemonState) => state.faults.instances.filter(entry => entry.faultClass === 'session-liveness');

function config(workers: unknown[] = []): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers, run: { proofWorkflow: 'acceptance.yml' } });
}
function item(key: string, at: number, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: iso(at - 3 * hour), updatedAt: iso(at), stageEnteredAt: iso(at - hour), ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}

test('manual:fault-class-session-liveness — the item lists three instances, and every one is replayed below', () => {
  assert.deepEqual(instances.map(entry => [entry.kind, entry.subject]), [['action:close', 'GY-1359'], ['escalation:lease-loss', 'GY-1373'], ['action:dispatch', 'GY-1373']]);
});

// ---- action:close GY-1359: the registry restarting ----------------------------------------------

/** End GY-1359's approver registry session through the approver supervisor, the registry answering `failure`. */
async function endApprover(failure: Error, at: number) {
  const state = emptyDaemonState(config()), work = item('GY-1359', at, { stage: 'build', epoch: 3 });
  const cycle = { config: config(), state, now: () => at, clock: at, performed: [], snapshot: { work: [work], now: iso(at) }, isolate: async () => {} } as unknown as Cycle;
  const effects = { endRegistrySession: async () => { throw failure; }, persist: async () => {} } as unknown as DaemonEffects;
  // The note cycle-decisions.ts hands the supervisor: the action is recorded with the fault kind the caller names.
  const note = async (key: string, subject: Work, kind: never, outcome: 'done' | 'failed', detail: string, when = at, faultKind?: never) =>
    await recordAction(state, key, { kind, work: subject.key, principal: null, state: outcome, detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: subject.epoch, cycle: state.cycle }, when, effects.persist, faultKind);
  const supervisor = approversModule.createApproverSupervisor(cycle, effects, iso(at), note as never, [], false);
  const watch = approvalWatchSchema.parse({ work: work.key, action: 'release', decision: '2ae5c156', requestedAt: iso(at - 30 * minute), agentName: 'gy-approver-2ae5c156', session: '27db352e', settledAt: iso(at - minute) });
  const ended = await supervisor.endApproverSession(work, watch, 'the decision was refused');
  return { state, watch, ended };
}

test(`manual:fault-class-session-liveness — ${instances[0].id}: an approver registry session the restarting plane could not end is kept for the next cycle and opens no session-liveness fault`, async () => {
  const at = Date.parse(instances[0].at);
  assert.equal(blockerClass.planeWideFailure(startup503), true, 'the startup-readiness 503 is the whole plane not ready');
  assert.equal(blockerClass.planeWideRefusal(new FleetUnreachableError(startup503)), true);
  assert.equal(blockerClass.planeWideRefusal(new RefusedResponse('Graphyard refused work/x/decide (503): Startup validation has not completed; retry shortly', 503, { error: 'Startup validation has not completed; retry shortly', retryable: true })), true,
    'the same 503 from the control plane client, whose body carries the error field');
  const { state, watch, ended } = await endApprover(new FleetUnreachableError(startup503), at);
  assert.equal(ended, false, 'the registry was not told, so the close is retried');
  assert.equal(watch.session, '27db352e', 'the watch keeps the session and ends it on the next try');
  const row = Object.values(state.actions)[0];
  assert.equal(row?.state, 'failed');
  assert.match(row.detail, /the control plane did not answer, so it is ended on the next try/);
  assert.equal(row.faultClass, undefined, 'the row is kept for retry with no fault class');
  assert.deepEqual(sessionLiveness(state), [], 'no action:close session-liveness instance');
  // The registry's own judgement — a refusal that is not the plane's — is still the session's fault.
  const own = await endApprover(new FleetUnreachableError(`The agent registry at ${registry} answered 409: session 27db352e belongs to another launch`), at);
  assert.deepEqual(sessionLiveness(own.state).map(entry => [entry.kind, entry.subject]), [['action:close', 'GY-1359']]);
});

// ---- escalation:lease-loss GY-1373: a lease lapsed while its launch waited out the outage ------

/** GY-1373 as the fault step read it at 14:03:39Z: epoch 1's lease lost, its session record ended by the launch's failure. */
function gy1373(session: Partial<NonNullable<Work['sessions']>[number]>): Work {
  const at = Date.parse(instances[1].at);
  return item('GY-1373', at, { stage: 'build', ready: true, epoch: 1,
    escalations: [{ trigger: 'lease-loss', reason: 'Worker graphyard-claude-1 lost lease epoch 1', at: '2026-10-06T14:03:13.938Z', actor: 'graphyard' }],
    sessions: [{ id: 'graphyard-claude-1:1', kind: 'implementation', principal: 'graphyard-claude-1', epoch: null, runtime: 'claude', host: 'vishrog', workspace: 'w1V', pane: null, agentName: null,
      subject: 'GY-1373: Dispatch plane unavailable', startedAt: '2026-10-06T14:01:24.702Z', updatedAt: '2026-10-06T14:01:32.904Z', endedAt: '2026-10-06T14:01:32.904Z', state: 'finished',
      outcome: 'the launch failed before the session started: GY-1373 is being dispatched by another dispatcher (process 2431123 on vishrog since 2026-10-06T14:00:31.764Z); it is left to that launch',
      ...session }] as unknown as Work['sessions'] } as Partial<Work>);
}

test(`manual:fault-class-session-liveness — ${instances[1].id}: a lease lost before its worker session started is the launch's outcome, not a lost session`, () => {
  const at = Date.parse(instances[1].at), work = gy1373({});
  assert.deepEqual(workFaults(work, at).filter(fault => fault.faultClass === 'session-liveness'), [], 'no escalation:lease-loss instance');
  assert.equal(escalationModule.lapsedBeforeStart(work, work.escalations![0]), true);
  // The same lapse once the launch that held the claim failed too (14:04:47Z): still no worker ever started.
  const launchFailed = gy1373({ outcome: 'the launch failed before the session started: Worker launch failed: no push credential could be minted for GY-1373 epoch 1 (Lease missing, expired, or superseded; claim the task)' });
  assert.deepEqual(workFaults(launchFailed, at).map(fault => fault.kind), []);
});

// Holds on the base too: the fix narrows nothing a worker that ran can lose.
test(`manual:fault-class-session-liveness — ${instances[1].id}: a worker that started and then lost its lease is still a session-liveness fault`, () => {
  const at = Date.parse(instances[1].at);
  const started = [
    gy1373({ state: 'running', outcome: undefined, pane: 'w1V:p1', agentName: 'graphyard-claude-1' }),
    gy1373({ outcome: 'vanished: the claude runtime has not reported session/pane', pane: 'w1V:p1', agentName: 'graphyard-claude-1' }),
    // A launch failure recorded for another epoch or owner says nothing about this lease.
    gy1373({ id: 'graphyard-claude-1:2' }),
    gy1373({ id: 'graphyard-claude-2:1' }),
    gy1373({ kind: 'review' } as never),
  ];
  for (const work of started) {
    assert.deepEqual(workFaults(work, at).map(fault => [fault.kind, fault.faultClass]), [['escalation:lease-loss', 'session-liveness']], JSON.stringify(work.sessions));
  }
  const unrecorded = { ...gy1373({}), sessions: [] } as Work;
  assert.deepEqual(workFaults(unrecorded, at).map(fault => fault.kind), ['escalation:lease-loss'], 'no session record: the lapse stands');
});

// ---- action:dispatch GY-1373: the claim met the outage ----------------------------------------

async function dispatchCycle(failure: string, at: number) {
  const master = config([{ name: 'claude-primary', principal: 'graphyard-claude-1', agentName: 'graphyard-claude-1', mode: 'launch', kind: 'claude', credentialFile: '/outside/claude.token' }]);
  const work = item('GY-1373', at, { stage: 'build', ready: true, epoch: 1 } as Partial<Work>), state = emptyDaemonState(master);
  const effects = { agents: () => [], credentials: async (profiles: { name: string }[]) => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [work], now: iso(at) }), closeSession: () => {}, dispatch: async () => { throw new Error(failure); }, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(at), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {} } as unknown as DaemonEffects;
  await runCycle(master, state, effects, () => at);
  return { state, key: `dispatch:${work.id}:1` };
}

test(`manual:fault-class-session-liveness — ${instances[2].id}: a dispatch whose claim met the outage is retried and opens no session-liveness fault`, async () => {
  const at = Date.parse(instances[2].at);
  for (const failure of [claimFetchFailed, `Command failed: graphyard claim GY-1373\n${startup503}`]) {
    const { state, key } = await dispatchCycle(failure, at);
    assert.equal(state.actions[key]?.state, 'failed', failure);
    assert.match(state.actions[key].detail, /plane-wide control-plane failure/);
    assert.equal(state.actions[key].faultClass, undefined, 'the row is kept for retry with no fault class');
    assert.deepEqual(sessionLiveness(state), [], `no action:dispatch instance for ${failure}`);
    assert.equal(state.profiles['claude-primary'], undefined, 'and no profile cool-off, as before');
  }
  // The item's own launch failure is still the session-liveness fault it always was.
  const own = await dispatchCycle('Herdr refused agent start: workspace w1V not found', at);
  assert.deepEqual(sessionLiveness(own.state).map(entry => [entry.kind, entry.subject]), [['action:dispatch', 'GY-1373']]);
});

test('manual:fault-class-session-liveness — the three instances together open no session-liveness instance, so the class files nothing', async () => {
  const close = await endApprover(new FleetUnreachableError(startup503), Date.parse(instances[0].at));
  const dispatch = await dispatchCycle(claimFetchFailed, Date.parse(instances[2].at));
  const lapse = workFaults(gy1373({}), Date.parse(instances[1].at)).filter(fault => fault.faultClass === 'session-liveness');
  assert.equal(sessionLiveness(close.state).length + sessionLiveness(dispatch.state).length + lapse.length, 0);
});
