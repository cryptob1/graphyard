import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, pruneDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, PromptNotAcceptedError, type HerdrAgent, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// A namespace import, so the base run of this file, which has no deaf-rotation bound, fails only the case that reads it.
import * as cycleMaster from '../src/daemon/cycle-master.js';
const masterDeafRotationBound = cycleMaster.masterDeafRotationBound ?? 3;
const masterWakeKey = cycleMaster.masterWakeKey ?? 'master:wake';
const deafStreak = (master: Parameters<NonNullable<typeof cycleMaster.deafStreak>>[0]) => cycleMaster.deafStreak?.(master) ?? 0;

/**
 * GY-1863 across the real loop's cycles, over simulated days: the master wake that rotates a deaf
 * session, held against the system invariants after every cycle. The single-cycle cases in
 * tests/fault-class-session-liveness.test.ts replay the class's instances; here the behaviour runs
 * every cycle the way production does.
 *
 * One day wakes a master whose pane stays deaf whatever replaces it: the first three deaf ends are
 * each answered with a replacement, and at the bound the loop stops — the wake stands failed as the
 * one action:wake instance the class counts, instead of a pane, a registry session and a launch
 * churned every cycle with both records done. A delivery a session then accepts closes the
 * standing failure, and a deaf end after it starts a fresh count.
 */
const minute = 60_000;
/** The fixed clock every cycle is derived from; nothing in this file reads the wall clock. */
const start = Date.parse('2030-03-02T00:00:00.000Z');
const cycleMs = 5 * minute;
const stalled = 'the pane did not visibly accept its prompt after 3 deliveries (agent_prompt_stalled, agent_prompt_stalled, agent_prompt_stalled); the session is closed and relaunched rather than left idle';

const credential = async (name: string) => {
  const directory = await temporaryDirectory(name);
  const file = join(directory, 'coordinator.token');
  await writeFile(file, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  return { directory, file };
};

/** One claimable item: the standing subject a deaf master is woken for. */
const wakeItem = (key: string, at: number): Work => ({
  id: `work-${key}`, key, title: `A claimable ${key}`, description: '', type: 'bug', priority: 0, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Delivered', proofs: ['manual:x'] }], policy: { checks: ['test'], review: true }, 
  stage: 'ready', revision: 1, policyRevision: 1, createdAt: new Date(start - 2 * 3_600_000).toISOString(), updatedAt: new Date(at).toISOString(),
  stageEnteredAt: new Date(start - 3_600_000).toISOString(), ready: true, epoch: 0,
  lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
} as unknown as Work);

test('soak:session-liveness — a persistently deaf master is rotated at most three times, then the wake stands failed until a delivery is accepted, and every invariant holds', { timeout: 300_000 }, async () => {
  const { directory, file } = await credential('soak-deaf-master');
  try {
    const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: file, cliPath: 'graphyard',
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'soak-host', masterAgentName: 'graphyard-master-project',
      autoMerge: true, mergeMethod: 'merge', workers: [], run: { proofWorkflow: 'acceptance.yml', masterSessionMinutes: 720, masterHeartbeatMinutes: 5 } });
    const masterName = config.masterAgentName!;
    let now = start, deaf = true;
    const agents: HerdrAgent[] = [{ name: masterName, pane_id: 'w1V:pQ35', agent: 'claude', agent_status: 'idle' }];
    const launched: string[] = [], closed: string[] = [], ended: string[] = [], endReasons: string[] = [], accepted: number[] = [], boundHeld: number[] = [];
    const effects: DaemonEffects = {
      agents: () => [],
      herdr: () => ({ agents, available: true }),
      credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: [wakeItem('GY-9', now)], now: new Date(now).toISOString() }),
      dispatch: async () => {},
      observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, persist: async () => {},
      closeSession: pane => { closed.push(pane); const keep = agents.filter(agent => agent.pane_id !== pane); agents.splice(0, agents.length, ...keep); },
      // The pane whatever replaces the session stays deaf, as a Herdr regression or an unknown dialog would keep it.
      promptSession: async () => { if (deaf) throw new PromptNotAcceptedError(stalled); accepted.push(now); },
      endRegistrySession: async (session, reason) => { ended.push(session); endReasons.push(reason); },
      masterSession: { launch: async () => {
        const pane = `w1V:pQ${40 + launched.length}`, session = `master-registry-${launched.length + 1}`;
        launched.push(pane);
        agents.push({ name: masterName, pane_id: pane, agent: 'claude', agent_status: 'idle' });
        return { agentName: masterName, pane, runtime: 'claude', account: 'claude-master', session };
      } },
    };
    const state = emptyDaemonState(config);
    Object.assign(state.master, { agentName: masterName, pane: 'w1V:pQ35', runtime: 'claude', account: 'claude-master', session: 'master-registry-0',
      startedAt: new Date(start - 10 * minute).toISOString(), adopted: true, rotations: 0, misses: 0 });
    const violations: string[] = [];
    const boundFailedAt: number[] = [], boundAttempts: number[] = [];

    // Cycles 1-11: the master is woken every other cycle and answers deaf every time. The first
    // three deaf ends are each rotated; the fourth meets the bound and stands failed until the
    // wake at cycle 11 is the one a session finally accepts.
    for (let cycle = 1; cycle <= 11; cycle++, now += cycleMs) {
      if (cycle === 11) deaf = false; // the wake at cycle 11 is the one a session finally accepts
      await runCycle(config, state, effects, () => now);
      pruneDaemonState(state);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
      if (deafStreak(state.master) >= masterDeafRotationBound) boundHeld.push(cycle);
      const record = state.actions[masterWakeKey];
      if (record?.state === 'failed' && record.at === new Date(now).toISOString()) { boundFailedAt.push(cycle); boundAttempts.push(record.attempts); }
      // Past the bound no pane is closed and no session replaced: the churn is capped at three.
      if (cycle >= 7 && deaf) assert.ok(launched.length <= masterDeafRotationBound, `cycle ${cycle}: the bound holds (${launched.length} launches)`);
    }

    assert.deepEqual(violations.join('\n'), '', 'every system invariant holds after every deaf cycle');
    assert.deepEqual(launched.length, masterDeafRotationBound, `one replacement per deaf end, none past the bound: ${launched.join(', ')}`);
    assert.deepEqual(closed.length, masterDeafRotationBound, "each replacement closed its predecessor's pane, and none was closed past the bound");
    assert.deepEqual(ended.length, masterDeafRotationBound, "each replacement's registry session was given back, and none past the bound");
    assert.equal(state.master.rotations, masterDeafRotationBound, 'the launch count is the deaf end count');
    assert.equal(state.master.lastEnd?.cause, 'deaf');
    assert.match(state.master.lastEnd!.detail, new RegExp(`${masterDeafRotationBound} consecutive deaf ends without an accepted wake`));
    // While the pane stayed deaf, the bound held the wake failed — one standing record, never once per cycle.
    assert.deepEqual(boundFailedAt, [7, 8, 9, 10], `every deaf wake past the bound restates the standing record, never a new one: ${JSON.stringify(boundFailedAt)}`);
    assert.ok(boundAttempts.at(-1)! >= 2, `every deaf wake past the bound restates the standing record (${boundAttempts.join(', ')} attempts)`);
    const bound = state.actions[masterWakeKey];
    assert.ok(bound && bound.state === 'done' && /accepted its wake/.test(bound.detail), `the accepted wake closed the bound's record: ${JSON.stringify(bound?.detail)}`);
    assert.ok(boundHeld.length >= 1, 'the bound was read on the cycles that needed it');
    assert.deepEqual(accepted.length, 1, 'exactly the cycle-11 wake was accepted while the pane stayed deaf');

    // A later deaf end starts a fresh count: the rotation is the remedy again, once.
    const launchesBefore = launched.length, rotationsBefore = state.master.rotations;
    for (let cycle = 12; cycle <= 14; cycle++, now += cycleMs) {
      if (cycle === 13) deaf = true;
      await runCycle(config, state, effects, () => now);
      pruneDaemonState(state);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
    }
    assert.deepEqual(violations.join('\n'), '', 'every system invariant holds after the recovery too');
    assert.equal(state.master.rotations, rotationsBefore + 1, 'a deaf end after an accepted wake is rotated once more');
    assert.equal(launched.length, launchesBefore + 1, "and replaced once, back at the bound's pace");

    // Two more simulated days of the same deaf episode beside ordinary work: every cycle resolves
    // more unrelated actions than the cursor keeps, so pruning retires the episode's rotation rows
    // within the first hours. The bound rides on the master session's own record, so the episode is
    // replaced at most twice more (three in all) and never again before a wake is accepted; the
    // session's budget still rotates it every twelve hours, and each replacement inherits the streak.
    const deafEnds = () => endReasons.filter(reason => /\(deaf\)/.test(reason)).length;
    const deafBefore = deafEnds(), budgetBefore = endReasons.filter(reason => /\(budget\)/.test(reason)).length;
    let traffic = 0, prunedRotations = false;
    const days = 2, cycles = (days * 24 * 60 * minute) / cycleMs;
    for (let cycle = 1; cycle <= cycles; cycle++, now += cycleMs) {
      for (let row = 0; row < 120; row++, traffic++) state.actions[`traffic:${traffic}`] = { kind: 'refresh', work: `work-T-${traffic}`, principal: null, state: 'done',
        detail: `refreshed T-${traffic}`, attempts: 1, epoch: null, cycle: state.cycle, at: new Date(now).toISOString() };
      await runCycle(config, state, effects, () => now);
      pruneDaemonState(state);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`day cycle ${cycle}: ${check.invariant} — ${check.reading}`);
      if (!Object.values(state.actions).some(action => action.kind === 'failover' && /\(deaf\)/.test(action.detail))) prunedRotations = true;
      assert.ok(deafEnds() - deafBefore <= masterDeafRotationBound - 1, `day cycle ${cycle}: no deaf replacement past the bound (${deafEnds()} deaf ends)`);
    }
    assert.deepEqual(violations.join('\n'), '', 'every system invariant holds after every cycle of the pruned days');
    assert.ok(prunedRotations, 'pruning retired the episode\'s rotation rows while it stood');
    assert.equal(deafEnds() - deafBefore, masterDeafRotationBound - 1, 'the episode reached the bound — three deaf ends in all — and stopped there');
    assert.ok(endReasons.filter(reason => /\(budget\)/.test(reason)).length - budgetBefore >= days * 2 - 1, 'the session budget still rotated the deaf session over the days');
    assert.equal(deafStreak(state.master), masterDeafRotationBound, 'each budget replacement inherited the streak');
    assert.equal(state.actions[masterWakeKey]?.state, 'failed', 'the wake still stands failed on the bound');
    deaf = false;
    for (let cycle = 1; cycle <= 2; cycle++, now += cycleMs) { await runCycle(config, state, effects, () => now); pruneDaemonState(state); }
    assert.equal(state.actions[masterWakeKey]?.state, 'done', 'an accepted wake ends the standing failure');
    assert.equal(deafStreak(state.master), 0, 'and the streak with it');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
