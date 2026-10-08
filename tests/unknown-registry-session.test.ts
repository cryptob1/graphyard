import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { approverSessionName, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { approvalWatchSchema, emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { handWatchPrefix } from '../src/daemon/decisions.js';
import { FleetUnreachableError, unknownRegistrySession } from '../src/fleet.js';
import type { Work } from '../src/model.js';

// GY-1504: the agent registry keeps only its last 100 ended sessions, so an approval watch whose
// session aged out of that history was answered 404 Unknown session on every end, kept its id and
// was retried every cycle forever. That answer now ends the session. One case per proof.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const config = { hostId: 'machine-a', autoMerge: true, mergeMethod: 'merge', workers: [], reviewers: [], producers: [], repository: 'owner/project', baseBranch: 'main',
  url: 'https://graphyard.example', credentialFile: '/dev/null', cliPath: launcher, githubAppId: 1234, run: { intervalSeconds: 20 } } as unknown as MasterConfig;
const unknown = () => new FleetUnreachableError('The agent registry at https://graphyard.example answered 404: Unknown session');

/** An item the loop itself needs no decision for: ready, unleased, and nothing to merge. */
function item(key: string): Work {
  return {
    id: `work-${key}`, key, title: 'Unknown registry session', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Ended', proofs: ['unit:unknown-session-404-clears-watch'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'ready', revision: 4, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

function effects(work: Work[], ends: string[], refuse: (session: string) => Error | null, extra: Partial<DaemonEffects> = {}, agents: HerdrAgent[] = []): DaemonEffects {
  return {
    agents: () => agents,
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso() }),
    closeSession: () => {},
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    decisions: async () => ({ decisions: [] }),
    approverLaunches: async () => [],
    endRegistrySession: async session => { ends.push(session); const error = refuse(session); if (error) throw error; },
    ...extra,
  };
}

const watch = (work: string, decision: string, session: string, closeAttempts = 0) =>
  approvalWatchSchema.parse({ work, action: 'close', decision, requestedAt: iso(-86_400_000), launches: 1, closeAttempts, session });

/** The three end paths: an open item's watch (endApproverSession), a hand watch whose item closed, and the loop's own watch whose item closed. */
function threePaths(state: DaemonState) {
  state.approvals['GY-10:close:open-decision'] = watch('GY-10', 'open-decision', 'aged-open');
  state.approvals[`${handWatchPrefix}hand-decision`] = watch('GY-11', 'hand-decision', 'aged-hand', 1200);
  state.approvals['GY-12:close:gone-decision'] = watch('GY-12', 'gone-decision', 'aged-gone', 1400);
}
const unknownCloses = (actions: { kind: string; state: string; detail: string }[]) => actions.filter(action => action.kind === 'close' && /the registry no longer knows this session/.test(action.detail));
const failedCloses = (actions: { kind: string; state: string; detail: string }[]) => actions.filter(action => action.kind === 'close' && action.state === 'failed');

test('unit:unknown-session-404-clears-watch — an end the registry answers 404 Unknown session clears the watch\'s session in that cycle, is recorded once as the registry not knowing it, and the watch is deleted', async () => {
  assert.equal(unknownRegistrySession(unknown()), true);
  assert.equal(unknownRegistrySession(new FleetUnreachableError('The agent registry at https://graphyard.example answered 404: Unknown work')), false, 'only the Unknown-session answer is definitive');
  assert.equal(unknownRegistrySession(new Error('The agent registry at https://graphyard.example answered 404: Unknown session')), false, 'only fleetRequest\'s own refusal');
  const ends: string[] = [], state = emptyDaemonState(config);
  state.approvals['GY-10:close:open-decision'] = watch('GY-10', 'open-decision', 'aged-open');
  const result = await runCycle(config, state, effects([item('GY-10')], ends, () => unknown()), () => clock);
  assert.deepEqual(ends, ['aged-open'], 'the end is sent once');
  assert.equal(state.approvals['GY-10:close:open-decision'], undefined, 'the watch is deleted in the same cycle');
  const closes = unknownCloses(result.actions);
  assert.equal(closes.length, 1, JSON.stringify(result.actions));
  assert.equal(closes[0].state, 'done');
  assert.match(closes[0].detail, /^Approver registry session aged-open is taken as ended: the registry no longer knows this session \(.*answered 404: Unknown session\)$/);
  assert.deepEqual(failedCloses(result.actions), [], 'no failed close is recorded');
  const again = await runCycle(config, state, effects([item('GY-10')], ends, () => unknown()), () => clock + 20_000);
  assert.deepEqual(ends, ['aged-open'], 'the end is not retried next cycle');
  assert.deepEqual(unknownCloses(again.actions), []);
});

test('unit:unknown-session-404-treated-ended-all-paths — endApproverSession, the hand-watch cleanup and the loop\'s own watch cleanup each take the Unknown-session 404 as the session ended', async () => {
  const ends: string[] = [], state = emptyDaemonState(config);
  threePaths(state);
  const result = await runCycle(config, state, effects([item('GY-10')], ends, () => unknown()), () => clock);
  assert.deepEqual(ends.sort(), ['aged-gone', 'aged-hand', 'aged-open'], 'each path sends its end once');
  assert.deepEqual(Object.keys(state.approvals), [], 'every watch is deleted');
  const closes = unknownCloses(result.actions);
  assert.deepEqual(closes.map(action => (action as { work?: string }).work).sort(), ['GY-10', 'GY-11', 'GY-12'], JSON.stringify(result.actions));
  assert.ok(closes.every(action => action.state === 'done'));
  assert.deepEqual(failedCloses(result.actions), []);
});

test('unit:unknown-session-404-no-launch-hold — a replacement approver is launched past a watch whose only registry session answers Unknown session', async () => {
  const ends: string[] = [], launched: string[] = [], work = item('GY-20'), decision = 'replace-decision', state = emptyDaemonState(config);
  // A hand-launched approver gone from Herdr without judging its still-requested decision.
  state.approvals[`${handWatchPrefix}${decision}`] = approvalWatchSchema.parse({ work: work.key, action: 'close', decision, requestedAt: iso(-3_600_000), launchedAt: iso(-3_600_000),
    agentName: approverSessionName(work, decision), pane: 'pane-gone', launches: 1, session: 'aged-replaced' });
  const result = await runCycle(config, state, effects([work], ends, session => session === 'aged-replaced' ? unknown() : null, {
    decisions: async () => ({ decisions: [{ id: decision, action: 'close', state: 'requested', input: {}, approvedBy: null, requestedAt: iso(-3_600_000) }] }),
    approver: async (entry, id) => { launched.push(id); return { agentName: approverSessionName(entry, id), pane: 'pane-new', account: 'approver-account', runtime: 'claude', session: 'fresh-session' }; },
  }), () => clock);
  assert.deepEqual(ends, ['aged-replaced'], JSON.stringify(result.actions));
  assert.deepEqual(launched, [decision], `the replacement is launched: ${JSON.stringify(result.actions)}`);
  assert.equal(result.actions.some(action => /could not be ended, so no replacement is launched/.test(action.detail)), false, 'nothing holds the launch');
  const kept = state.approvals[`${handWatchPrefix}${decision}`];
  assert.equal(kept?.session, 'fresh-session', 'the watch holds the replacement\'s session');
});

test('unit:plane-wide-refusal-still-retries — a 502/503, a startup readiness refusal, an unreachable registry and a timeout keep the session id and are retried next cycle', async () => {
  const refusals = [
    new FleetUnreachableError('The agent registry at https://graphyard.example answered 502'),
    new FleetUnreachableError('The agent registry at https://graphyard.example answered 503: Startup validation has not completed'),
    new FleetUnreachableError('The agent registry at https://graphyard.example is unreachable: fetch failed'),
    new FleetUnreachableError('The agent registry at https://graphyard.example is unreachable: The operation was aborted due to timeout'),
  ];
  for (const refusal of refusals) {
    assert.equal(unknownRegistrySession(refusal), false, refusal.message);
    const ends: string[] = [], state = emptyDaemonState(config);
    threePaths(state);
    await runCycle(config, state, effects([item('GY-10')], ends, () => refusal), () => clock);
    assert.deepEqual(Object.values(state.approvals).map(entry => entry.session).sort(), ['aged-gone', 'aged-hand', 'aged-open'], `${refusal.message}: every id is kept`);
    await runCycle(config, state, effects([item('GY-10')], ends, () => refusal), () => clock + 20_000);
    assert.deepEqual(ends.sort(), ['aged-gone', 'aged-gone', 'aged-hand', 'aged-hand', 'aged-open', 'aged-open'], `${refusal.message}: each end is retried on the next cycle`);
    assert.equal(Object.keys(state.approvals).length, 3, 'no watch is dropped while its session may still hold a slot');
  }
});

test('integration:stuck-watch-no-recurring-404 — two cycles of the loop with watches whose sessions answer Unknown session send at most one end per session and record no repeating close failure', async () => {
  const ends: string[] = [], state = emptyDaemonState(config);
  threePaths(state);
  const loop = effects([item('GY-10')], ends, () => unknown());
  const first = await runCycle(config, state, loop, () => clock);
  const second = await runCycle(config, state, loop, () => clock + 20_000);
  for (const session of ['aged-open', 'aged-hand', 'aged-gone']) assert.ok(ends.filter(entry => entry === session).length <= 1, `${session}: ${JSON.stringify(ends)}`);
  assert.deepEqual([...failedCloses(first.actions), ...failedCloses(second.actions)], []);
  assert.deepEqual(Object.values(state.actions).filter(action => action.kind === 'close' && action.state === 'failed'), [], 'no close-failed action stands in the loop state');
  assert.deepEqual(unknownCloses(second.actions), [], 'the second cycle has nothing left to end');
});
