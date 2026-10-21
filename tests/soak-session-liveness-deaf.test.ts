import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, pruneDaemonState, runCycle, type DaemonEffects, type OrphanSupervisor } from '../src/master-daemon.js';
import { masterConfigSchema, PromptNotAcceptedError, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { SessionHandle } from '../src/model/sessions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// A namespace import, so the base run of this file, which has no deaf-rotation bound, fails only the case that reads it.
import * as cycleMaster from '../src/daemon/cycle-master.js';
const masterDeafRotationBound = cycleMaster.masterDeafRotationBound ?? 3;
const masterWakeKey = cycleMaster.masterWakeKey ?? 'master:wake';
const deafStreak = (master: Parameters<NonNullable<typeof cycleMaster.deafStreak>>[0]) => cycleMaster.deafStreak?.(master) ?? 0;

/**
 * GY-1863 across the real loop's cycles, over simulated days: the two per-cycle behaviours the
 * fault class gained — the master wake that rotates a deaf session, and the session attention line
 * that waits for the orphan watch and gone-worker preserve — held against the system invariants
 * after every cycle. The single-cycle cases in tests/fault-class-session-liveness.test.ts replay
 * the class's three instances; here the behaviours run every cycle the way production does.
 *
 * One day wakes a master whose pane stays deaf whatever replaces it: the first three deaf ends are
 * each answered with a replacement, and at the bound the loop stops — the wake stands failed as the
 * one action:wake instance the class counts, instead of a pane, a registry session and a launch
 * churned every cycle with both records done. A delivery a session then accepts closes the
 * standing failure, and a deaf end after it starts a fresh count. A second day runs the session
 * line beside the loop's own recovery: an absence that establishes (the preserve ends the attempt,
 * the line counts nothing at any point), an absence that does not establish (the session is seen
 * again, and the line counts as the failed recovery it is), and an orphaned supervisor that
 * establishes (two observations, then the stop; the line counts nothing while the record stands).
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
  criteria: [{ id: 'AC-1', text: 'Delivered', proofs: ['manual:x'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
  stage: 'ready', revision: 1, policyRevision: 1, createdAt: new Date(start - 2 * 3_600_000).toISOString(), updatedAt: new Date(at).toISOString(),
  stageEnteredAt: new Date(start - 3_600_000).toISOString(), ready: true, epoch: 0,
  lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
} as unknown as Work);

const worker = (name: string, principal: string, agentName: string): WorkerProfile =>
  ({ name, principal, agentName, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], environment: {} }) as unknown as WorkerProfile;

/** An assignment whose agent session is finished against its live lease, as GY-1860's was. */
const finishedAssignment = (key: string, profile: WorkerProfile, epoch: number, at: number, quarantine: Work['containmentQuarantine']): Work => ({
  id: key, key, title: `A finished session on ${key}`, description: '', type: 'bug', priority: 0, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Delivered', proofs: ['manual:x'] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/attempt.ts'],
  stage: 'build', revision: 1, policyRevision: 1, createdAt: new Date(start - 6 * 3_600_000).toISOString(), updatedAt: new Date(at).toISOString(),
  stageEnteredAt: new Date(at - 30 * minute).toISOString(), ready: true, epoch,
  lease: { owner: profile.principal, epoch, expiresAt: new Date(start + 4 * minute).toISOString() },
  workspaces: [{ host: 'soak-host', path: `/srv/worktrees/${key}-${epoch}`, branch: `graphyard/${key.toLowerCase()}-${epoch}`, epoch, owner: profile.principal }],
  candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
  lastAssignment: { epoch, owner: profile.principal, claimedAt: new Date(at - 30 * minute).toISOString(), startedAt: new Date(at - 30 * minute).toISOString() },
  sessions: [{
    id: `${profile.principal}:${epoch}`, kind: 'implementation', principal: profile.principal, epoch, runtime: 'claude', host: 'soak-host', workspace: 'w1', tab: null,
    pane: `w1:p${epoch}0`, agentName: profile.agentName, role: null, head: null, attach: null, transcript: null, subject: key,
    startedAt: new Date(at - 30 * minute).toISOString(), updatedAt: new Date(at - minute).toISOString(), endedAt: new Date(at - minute).toISOString(),
    state: 'finished', outcome: 'the runtime left its pane',
  } as unknown as SessionHandle],
  ...(quarantine ? { containmentQuarantine: quarantine } : {}),
});

test('soak:session-liveness — a persistently deaf master is rotated at most three times, then the wake stands failed until a delivery is accepted, and every invariant holds', { timeout: 300_000 }, async () => {
  const { directory, file } = await credential('soak-deaf-master');
  try {
    const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: file, cliPath: 'graphyard',
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'soak-host', masterAgentName: 'graphyard-master-project',
      autoMerge: true, mergeMethod: 'merge', workers: [], run: { proofWorkflow: 'acceptance.yml', masterSessionMinutes: 720, masterHeartbeatMinutes: 5 } });
    const masterName = config.masterAgentName!;
    let now = start, deaf = true;
    const agents: HerdrAgent[] = [{ name: masterName, pane_id: 'w1V:pQ35', agent: 'claude', agent_status: 'idle' }];
    const launched: string[] = [], closed: string[] = [], ended: string[] = [], endReasons: string[] = [], accepted: number[] = [], opened: number[] = [], boundHeld: number[] = [];
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
    const instancesBefore = () => state.faults.instances.filter(entry => entry.kind === 'action:wake').length;
    const boundFailedAt: number[] = [], boundAttempts: number[] = [];

    // Cycles 1-11: the master is woken every other cycle and answers deaf every time. The first
    // three deaf ends are each rotated; the fourth meets the bound and stands failed until the
    // wake at cycle 11 is the one a session finally accepts.
    for (let cycle = 1; cycle <= 11; cycle++, now += cycleMs) {
      if (cycle === 11) deaf = false; // the wake at cycle 11 is the one a session finally accepts
      const flying = instancesBefore();
      await runCycle(config, state, effects, () => now);
      pruneDaemonState(state);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
      const instances = instancesBefore();
      if (instances > flying) opened.push(cycle);
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
    // While the pane stayed deaf, the bound held the wake failed as the class's one standing
    // instance — opened at the bound, never once per cycle, never during the rotations.
    assert.deepEqual(boundFailedAt, [7, 8, 9, 10], `every deaf wake past the bound restates the standing record, never a new one: ${JSON.stringify(boundFailedAt)}`);
    assert.ok(boundAttempts.at(-1)! >= 2, `every deaf wake past the bound restates the standing record (${boundAttempts.join(', ')} attempts)`);
    const bound = state.actions[masterWakeKey];
    assert.ok(bound && bound.state === 'done' && /accepted its wake/.test(bound.detail), `the accepted wake closed the bound's record: ${JSON.stringify(bound?.detail)}`);
    assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'action:wake').length, 1, 'one action:wake instance for the whole episode');
    assert.deepEqual(opened, [7], `the instance opened when the bound was reached, not before or per cycle: ${JSON.stringify(opened)}`);
    assert.ok(boundHeld.length >= 1, 'the bound was read on the cycles that needed it');
    assert.deepEqual(state.faults.failing[masterWakeKey], undefined, 'the accepted wake closed the standing failure');
    assert.deepEqual(accepted.length, 1, 'exactly the cycle-11 wake was accepted while the pane stayed deaf');

    // A later deaf end starts a fresh count: the rotation is the remedy again, once.
    const launchesBefore = launched.length, rotationsBefore = state.master.rotations;
    for (let cycle = 12; cycle <= 14; cycle++, now += cycleMs) {
      if (cycle === 13) deaf = true;
      const flying = instancesBefore();
      await runCycle(config, state, effects, () => now);
      pruneDaemonState(state);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
      if (instancesBefore() > flying) opened.push(cycle);
    }
    assert.deepEqual(violations.join('\n'), '', 'every system invariant holds after the recovery too');
    assert.equal(state.master.rotations, rotationsBefore + 1, 'a deaf end after an accepted wake is rotated once more');
    assert.equal(launched.length, launchesBefore + 1, "and replaced once, back at the bound's pace");
    assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'action:wake').length, 1, 'the recovery closed the episode; the record keeps its one instance');

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
      const flying = instancesBefore();
      await runCycle(config, state, effects, () => now);
      pruneDaemonState(state);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`day cycle ${cycle}: ${check.invariant} — ${check.reading}`);
      if (instancesBefore() > flying) opened.push(14 + cycle);
      if (!Object.values(state.actions).some(action => action.kind === 'failover' && /\(deaf\)/.test(action.detail))) prunedRotations = true;
      assert.ok(deafEnds() - deafBefore <= masterDeafRotationBound - 1, `day cycle ${cycle}: no deaf replacement past the bound (${deafEnds()} deaf ends)`);
    }
    assert.deepEqual(violations.join('\n'), '', 'every system invariant holds after every cycle of the pruned days');
    assert.ok(prunedRotations, 'pruning retired the episode\'s rotation rows while it stood');
    assert.equal(deafEnds() - deafBefore, masterDeafRotationBound - 1, 'the episode reached the bound — three deaf ends in all — and stopped there');
    assert.ok(endReasons.filter(reason => /\(budget\)/.test(reason)).length - budgetBefore >= days * 2 - 1, 'the session budget still rotated the deaf session over the days');
    assert.equal(deafStreak(state.master), masterDeafRotationBound, 'each budget replacement inherited the streak');
    assert.equal(state.actions[masterWakeKey]?.state, 'failed', 'the wake still stands failed on the bound');
    assert.ok(state.faults.failing[masterWakeKey], 'the standing failure is kept through pruning');
    assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'action:wake').length, 2, 'the second episode opened its one instance, never one per cycle or per pruning');
    deaf = false;
    for (let cycle = 1; cycle <= 2; cycle++, now += cycleMs) { await runCycle(config, state, effects, () => now); pruneDaemonState(state); }
    assert.equal(state.actions[masterWakeKey]?.state, 'done', 'an accepted wake ends the standing failure');
    assert.equal(deafStreak(state.master), 0, 'and the streak with it');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('soak:session-liveness — the finished-session line waits for the orphan watch and gone-worker preserve, counts when they stand down without ending the attempt, and every invariant holds', { timeout: 300_000 }, async () => {
  const { directory, file } = await credential('soak-session-end');
  try {
    const establishing = worker('claude-alpha', 'graphyard-alpha-1', 'graphyard-alpha-1');
    const returning = worker('claude-beta', 'graphyard-beta-1', 'graphyard-beta-1');
    const orphaned = worker('claude-gamma', 'graphyard-gamma-1', 'graphyard-gamma-1');
    const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: file, cliPath: 'graphyard',
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'soak-host', masterAgentName: 'graphyard-master-project',
      autoMerge: true, mergeMethod: 'merge', workers: [establishing, returning, orphaned], run: { proofWorkflow: 'acceptance.yml' } });
    let now = start;
    // Who is on a pane, who still has a supervisor renewing the lease, and which attempt the preserve ended.
    const listed = new Set<string>(), renewing = new Set<string>(['work-GY-A', 'work-GY-B', 'work-GY-C']), preserved = new Set<string>();
    const quarantine = (profile: WorkerProfile, epoch: number): Work['containmentQuarantine'] => ({
      epoch, owner: profile.principal, at: new Date(start - 3_600_000).toISOString(), settlementHash: 'a'.repeat(64),
      launchAcknowledgedAt: new Date(start - 3_600_000).toISOString(), launchExpiresAt: new Date(start - 3_600_000).toISOString(),
      leaseExpiresAt: new Date(start - 3_600_000).toISOString(), scope: { unit: `graphyard-watch-${7000 + epoch}.scope`, pid: 7000 + epoch },
    });
    const item = (key: string, profile: WorkerProfile, at: number): Work =>
      finishedAssignment(key, profile, 1, at, key === 'work-GY-C' ? quarantine(profile, 1) : null);
    const work = (at: number): Work[] => (['work-GY-A', 'work-GY-B', 'work-GY-C'] as const).map(key => {
      const base = item(key, key === 'work-GY-A' ? establishing : key === 'work-GY-B' ? returning : orphaned, at);
      const renew = renewing.has(key);
      const exhausted = preserved.has(key);
      return { ...base, lease: renew ? { ...base.lease!, expiresAt: new Date(at + 4 * minute).toISOString() } : base.lease,
        ...(exhausted ? { capacity: { exhaustions: [{ event: 'exhausted', cause: 'interrupted', role: 'worker', epoch: 1, profile: base.lastAssignment?.owner, account: null, runtime: 'claude', reason: 'kept', resetsAt: null, at: new Date(at).toISOString() }] } } : {}) } as Work;
    });
    const agents = (): HerdrAgent[] => [...listed].map(name => ({
      name, pane_id: `w1:p${name.at(-1)}`, agent: 'claude', agent_status: 'working' as const,
    }));
    const stops: { key: string; signal: NodeJS.Signals }[] = [];
    const effects: DaemonEffects = {
      agents: () => [],
      herdr: () => ({ agents: agents(), available: true }),
      credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: work(now), now: new Date(now).toISOString() }),
      dispatch: async () => {},
      observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, persist: async () => {},
      closeSession: () => {},
      // The gone-worker preserve ends the attempt on the record, as the plane's capacity write does.
      reportCapacity: async (item, event) => {
        preserved.add(item.id);
        return { ...item, capacity: { exhaustions: [{ event: 'exhausted', cause: 'interrupted', role: 'worker', epoch: Number(event.epoch), profile: item.lastAssignment?.owner ?? null, account: null, runtime: 'claude', reason: String(event.reason ?? 'kept'), resetsAt: null, at: new Date(now).toISOString() }] } } as unknown as Work;
      },
      stopSupervisor: (orphan: OrphanSupervisor, signal: NodeJS.Signals) => { stops.push({ key: orphan.key, signal }); renewing.delete(orphan.id); },
    };
    const state = emptyDaemonState(config);
    const violations: string[] = [];
    const sessionInstances = () => state.faults.instances.filter(entry => entry.kind === 'session');
    let backInstances = 0;
    // Cycle 1: all three sessions are gone from Herdr; every line stands against live machinery.
    // Cycle 2: the preserve ends GY-A's attempt; GY-B's session is seen again, so its absence never
    // establishes and the line counts; GY-C's lease advanced, so the orphan is established and stopped.
    for (let cycle = 1; cycle <= 5; cycle++, now += cycleMs) {
      if (cycle === 2) listed.add(returning.agentName);
      const before = sessionInstances().length;
      await runCycle(config, state, effects, () => now);
      pruneDaemonState(state);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
      const after = sessionInstances();
      const keys = after.filter(entry => !['work-GY-B'].includes(entry.subject)).map(entry => entry.subject);
      assert.deepEqual(keys, [], `cycle ${cycle}: no session-liveness instance outside the returned session (${keys.join(', ')})`);
      if (cycle === 1) {
        assert.ok(state.absences['work-GY-A'] && state.absences['work-GY-B'], 'the gone-worker watch holds both absences');
        assert.ok(state.orphans['work-GY-C'], 'the orphan watch holds the supervisor');
        assert.equal(state.orphans['work-GY-C'].establishedAt, null, 'the orphan is not established on its first observation');
      }
      if (cycle === 2) {
        assert.ok(preserved.has('work-GY-A'), 'the establishing absence ended its attempt through the preserve');
        assert.ok(state.absences['work-GY-B'] === undefined, "the returned session's absence stood down");
        assert.match(String(state.orphans['work-GY-C']?.establishedAt ?? ''), /^20\d\d-/, 'the advancing lease established the orphan');
        backInstances = after.length - before;
      }
      if (cycle >= 4) assert.ok(state.orphans['work-GY-C'] === undefined, `cycle ${cycle}: the stopped supervisor's lapsed lease cleared the orphan record`);
    }
    assert.deepEqual(violations.join('\n'), '', 'every system invariant holds after every cycle');
    assert.deepEqual(stops, [{ key: 'work-GY-C', signal: 'SIGTERM' }], "the established orphan's supervisor was stopped once, through its scope");
    assert.ok(sessionInstances().some(entry => entry.subject === 'work-GY-B' && entry.faultClass === 'session-liveness'), 'the absence that never established counts the finished session it left behind');
    assert.equal(backInstances, 1, 'the line counted exactly once, when the machinery stood down under it');
    // The establishing absence: the attempt is ended on the record and the line counted nothing, ever.
    const kept = state.actions[`preserve:work-GY-A:1`];
    assert.ok(kept && kept.state === 'done' && /work-GY-A attempt 1 ended without submitting/.test(kept.detail), `the preserve stands done: ${JSON.stringify(kept?.detail)}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
