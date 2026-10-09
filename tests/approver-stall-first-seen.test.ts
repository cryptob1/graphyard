import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { approverSessionName, masterConfigSchema, type HerdrAgent } from '../src/master.js';
import { approvalWatchSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { approvalStep, handWatchPrefix } from '../src/daemon/decisions.js';
import { createApproverSupervisor } from '../src/daemon/cycle-approvers.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { launchStartMs } from '../src/master/launch.js';
import type { Work } from '../src/model.js';

// GY-1612, a follow-up of GY-1604: when `master approver` replaced a watched approver's pane and the registry refused to end the
// replaced launch's session, the rebind of the unrecorded replacement waited for the end, and the retry that succeeded dated the pane
// from its own cycle, so every refused cycle delayed the stall judgement. The watch now keeps the cycle that first saw the pane. And a
// loop watch whose last launch failed adopts a session already listed under its approver name instead of replacing it.
// One proof: unit:approver-stall-first-seen.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const bound = launchStartMs(config);
const decision = '5e1d2c3b-4cb5-4f21-9b0e-0f2a6c8d4e15';

function item(): Work {
  return {
    id: 'work-1612', key: 'GY-1612', title: 'First seen', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Dated from first sight', proofs: ['unit:approver-stall-first-seen'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'ready', revision: 4, policyRevision: 1, createdAt: iso(clock - 7_200_000), updatedAt: iso(clock), stageEnteredAt: iso(clock - 3_600_000), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

test('unit:approver-stall-first-seen — a moved pane is dated from the cycle that first saw it across refused predecessor ends, an unrecorded launch is never judged by an older record, and a failed loop launch adopts the listed session', async () => {
  const work = item(), name = approverSessionName(work, decision);
  const requested = iso(clock - 600_000);
  // The hand launch the loop first watches, in pane-a, recorded with its registry session; an earlier launch of the same name, long
  // past the bound, recorded in pane-old.
  const records = [
    { agentName: name, account: 'claude-old', runtime: 'claude', session: 'registry-old', launchedAt: iso(clock - 10 * bound), work: work.key, decision, pane: 'pane-old' },
    { agentName: name, account: 'claude-a', runtime: 'claude', session: 'registry-a', launchedAt: iso(clock), work: work.key, decision, pane: 'pane-a' },
  ];
  const panes = new Map<string, string>([['pane-a', 'working']]), closed: string[] = [], launched: string[] = [], ended: string[] = [];
  let refusals = 0;
  const listed = (): HerdrAgent[] => [...panes].map(([pane_id, agent_status]) => ({ name, pane_id, agent: 'claude', agent_status }));
  const state = emptyDaemonState(config);
  const loop = (at: number): DaemonEffects => ({
    agents: listed, credentials: async () => ({}), snapshot: async () => ({ work: [work], now: iso(at) }),
    closeSession: pane => { closed.push(pane); panes.delete(pane); }, dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(at), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
    decisions: async () => ({ decisions: [{ id: decision, action: 'requirements', state: 'requested', input: {}, approvedBy: null, requestedAt: requested }] }),
    approverLaunches: async () => records,
    approver: async () => { panes.set('pane-relaunched', 'working'); launched.push('pane-relaunched'); return { agentName: name, pane: 'pane-relaunched', runtime: 'claude', session: null }; },
    endRegistrySession: async (id, reason) => { if (refusals > 0) { refusals -= 1; throw new Error('registry unavailable: 503'); } ended.push(`${id}: ${reason}`); },
  });
  const cycle = (at: number) => runCycle(config, state, loop(at), () => at);

  await cycle(clock);
  const watch = state.approvals[`${handWatchPrefix}${decision}`];
  assert.ok(watch, 'the loop watches the hand launch');
  assert.deepEqual([watch.pane, watch.session, watch.launchedAt], ['pane-a', 'registry-a', iso(clock)], 'bound to its own pane-bound record');

  // AC-1: `master approver` replaces pane-a with pane-b, whose own record could not be written. The registry refuses to end
  // registry-a for three cycles, a quarter of the start bound apart, then accepts it.
  panes.clear(); panes.set('pane-b', 'done');
  const firstSeen = clock + 60_000, step = bound / 4;
  refusals = 3;
  for (let at = firstSeen, n = 0; n < 3; n += 1, at += step) {
    const refused = await cycle(at);
    assert.deepEqual([watch.pane, watch.session], ['pane-a', 'registry-a'], `refused end ${n + 1} rebinds nothing: ${JSON.stringify(refused.actions.map(action => action.detail))}`);
    assert.deepEqual(watch.movedPane, { pane: 'pane-b', at: iso(firstSeen) }, 'and keeps the cycle that first saw pane-b');
  }
  assert.deepEqual([closed, ended], [[], []], 'pane-b is neither closed nor judged while the end is refused');
  const accepted = await cycle(firstSeen + 3 * step);
  assert.equal(watch.pane, 'pane-b', 'once the end is accepted the watch is rebound to pane-b');
  assert.equal(watch.launchedAt, iso(firstSeen), 'and dated from the cycle that first observed it, not the cycle the end succeeded');
  assert.equal(watch.movedPane, null, 'the first-seen stamp is spent by the rebind');
  assert.match(accepted.actions.find(action => action.detail.includes('which replaced the one the watch held'))?.detail ?? '', new RegExp(`so it is dated from ${iso(firstSeen)}, when the loop first saw it`));
  assert.equal(ended.length, 1, 'registry-a is ended once');
  assert.deepEqual([watch.session, watch.account], [null, null], 'and the watch carries none of the replaced launch\'s registry session or account');
  // AC-2: pane-b, a launch whose own record was not written, is not judged by the older pane-a or pane-old records, nor stalled
  // before the start bound passes from its first observation.
  await cycle(firstSeen + bound * 0.9);
  assert.deepEqual(closed, [], 'within the bound from pane-b\'s first observation it is not a stall');
  // Dated from the successful end it would be only 0.35 of the bound old here, and left standing.
  const judged = await cycle(firstSeen + bound * 1.1);
  assert.deepEqual(closed, ['pane-b'], `the stall is judged at the bound from first observation, not delayed by the three refused cycles: ${JSON.stringify(judged.actions.map(action => action.detail))}`);
  assert.deepEqual(launched, ['pane-relaunched'], 'and replaced');

  // A first sight carries over a pane that moves again while the end is still refused: the stamp names the pane it was taken for.
  const again = approvalWatchSchema.parse({ work: work.key, action: 'unknown', decision, requestedAt: requested, agentName: name, pane: 'pane-x', launchedAt: iso(clock), launches: 1, session: 'registry-x', movedPane: { pane: 'pane-y', at: iso(clock) } });
  state.approvals[`${handWatchPrefix}${decision}`] = again;
  panes.clear(); panes.set('pane-z', 'done'); closed.length = 0; refusals = 1;
  const movedAgain = clock + 20 * bound;
  await cycle(movedAgain);
  assert.deepEqual(again.movedPane, { pane: 'pane-z', at: iso(movedAgain) }, 'a stamp taken for another pane never dates this one');
  await cycle(movedAgain + bound / 4);
  assert.deepEqual([again.pane, again.launchedAt], ['pane-z', iso(movedAgain)]);
  assert.deepEqual(closed, [], 'so the new pane is not judged by the earlier stamp\'s age');
});

test('unit:approver-stall-first-seen — a loop watch whose last launch failed adopts the session listed under its approver name and judges it only by its own pane-bound record', async () => {
  const work = item(), name = approverSessionName(work, decision), at = clock;
  const launches: string[] = [];
  const supervise = (agents: HerdrAgent[], record: { pane: string; ageMs: number } | null) => {
    const state = emptyDaemonState(config);
    const cycle = { config, state, now: () => at, clock: at, performed: [], snapshot: { work: [work], now: iso(at) }, isolate: async () => {}, detached: false,
      launcher: { busy: () => false } } as unknown as Cycle;
    // The latest launch record of the name; only one naming the listed pane is the adopted session's own.
    const launch = record && { agentName: name, account: 'claude-recorded', runtime: 'claude', session: 'registry-recorded', launchedAt: iso(at - record.ageMs), work: work.key, decision, pane: record.pane };
    const effects = {
      agents: () => agents, persist: async () => {},
      approverLaunch: async () => launch, approverLaunches: async () => launch ? [launch] : [],
      approver: async () => { launches.push('launched'); return { agentName: name, pane: 'pane-launched', runtime: 'claude', session: null }; },
    } as unknown as DaemonEffects;
    const note = async (key: string, _item: Work, kind: string, outcome: string, detail: string) => { state.actions[key] = { kind, state: outcome, detail } as never; };
    return { state, supervisor: createApproverSupervisor(cycle, effects, iso(at), note as never, [], false) };
  };
  const relaunch = { step: 'relaunch' as const, detail: 'its last approver launch was refused' };
  // The loop's own watch after a launch that failed: its agentName, pane and session cleared, one launch spent.
  const failed = () => approvalWatchSchema.parse({ work: work.key, action: 'requirements', decision, requestedAt: iso(at - 600_000), agentName: null, pane: null, launches: 1 });
  const listed: HerdrAgent = { name, pane_id: 'pane-listed', agent: 'claude', agent_status: 'done' };

  // An older same-name record for another pane, far past the bound: the session is adopted and kept, never dated, billed or ended
  // by that record.
  const { state, supervisor } = supervise([listed], { pane: 'pane-older', ageMs: 10 * bound });
  const watch = failed();
  assert.equal(await supervisor.actOnStep(work, watch, relaunch), 'done');
  assert.deepEqual(launches, [], 'no replacement is launched over the listed session');
  assert.deepEqual([watch.agentName, watch.pane, watch.launches, watch.launchedAt], [name, 'pane-listed', 2, iso(at)], 'the listed session is adopted, dated from the loop\'s first sight of it');
  assert.deepEqual([watch.account, watch.runtime, watch.session], [null, null, null], 'the older record, naming another pane, gives it nothing');
  assert.match(Object.values(state.actions).map(action => (action as { detail: string }).detail).join('\n'), new RegExp(`adopted approver session ${name}, already judging it`));
  // Done, and adopted just now: within the start bound from that observation it is no stall.
  const seen = { agents: [listed], available: true };
  assert.equal(approvalStep(watch, { state: 'requested' }, seen, at + bound * 0.9, { startMs: bound }).step, 'wait', 'it is not judged by the older record\'s age');
  assert.equal(approvalStep(watch, { state: 'requested' }, seen, at + bound * 1.1, { startMs: bound }).step, 'relaunch', 'past the bound from its first observation it is');

  // A record naming the listed pane is the session's own: within its start bound it is adopted on that record's account and session.
  const own = supervise([listed], { pane: 'pane-listed', ageMs: bound / 2 }), recorded = failed();
  await own.supervisor.actOnStep(work, recorded, relaunch);
  assert.deepEqual([recorded.pane, recorded.account, recorded.session], ['pane-listed', 'claude-recorded', 'registry-recorded']);
  assert.deepEqual(launches, [], 'still nothing launched');
  // And its own record is the start check: one that record shows done past its start bound is a stall, replaced rather than adopted.
  const stalled = supervise([listed], { pane: 'pane-listed', ageMs: bound * 2 }), replaced = failed();
  await stalled.supervisor.actOnStep(work, replaced, relaunch);
  assert.deepEqual(launches, ['launched'], 'a session its own record shows stalled is replaced');
  assert.deepEqual([replaced.pane, replaced.account, replaced.session], ['pane-launched', null, null], 'and never adopted on its record');
  // A session that has started — blocked at a question, or working long past its record's bounds — is one the launcher refuses to
  // replace: it is adopted on its own record, so supervision reaches it, instead of a relaunch that fails every cycle.
  for (const status of ['blocked', 'working']) {
    const started = supervise([{ ...listed, agent_status: status }], { pane: 'pane-listed', ageMs: bound * 20 }), kept = failed();
    assert.equal(await started.supervisor.actOnStep(work, kept, relaunch), 'done');
    assert.deepEqual(launches, ['launched'], `a ${status} session is never replaced`);
    assert.deepEqual([kept.agentName, kept.pane, kept.session], [name, 'pane-listed', 'registry-recorded'], `a ${status} session is adopted on its own record`);
  }
});
