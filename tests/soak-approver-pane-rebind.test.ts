import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverSessionName, atomicPrivateWrite, loadMasterConfig, setupMaster, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import { handWatchPrefix, maxApproverLaunches, neededDecision } from '../src/daemon/decisions.js';
import { decisionKey } from '../src/daemon/reconcile.js';
import { launchStartMs } from '../src/master/launch.js';
import { type InvariantCheck } from '../src/model/invariants.js';
import * as autonomy from '../src/master/autonomy.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1604: every cycle the loop rebinds an already-watched approver whose pane `master approver`
// replaced, and dates a replacement no launch record names from the cycle that first saw it. That
// runs for every watched decision, every cycle, so this soak drives the real loop and the real
// approver launcher over a simulated day against a Herdr world: no replacement is closed within its
// start bound or at work, a never-starting one is escalated once when due, nothing lingers, and
// every system invariant holds after every cycle.
// Proof: unit:approver-stall-followup. GY-1612 adds the refused-registry-end and failed-launch cases under unit:approver-stall-first-seen.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

function item(): Work {
  const now = new Date().toISOString();
  return {
    id: 'work-1335', key: 'GY-1335', title: 'Rescope', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Rescoped', proofs: ['unit:rescope'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 4, policyRevision: 1, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

/** A checkout set up as `master setup` leaves it, with an approver identity. */
async function boundCheckout(label: string) {
  const root = await temporaryDirectory(label), credentials = await temporaryDirectory(`${label}-credentials`);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const approverToken = join(credentials, 'approver.token');
  await writeFile(approverToken, 'approver-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), approver: { id: 'graphyard-approver-project', credentialFile: approverToken } });
  const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };
  return { root, config, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

/** Runs `body` with GRAPHYARD_DATA_HOME naming `dataHome`, as the loop's sessions inherit it. */
async function withDataHome<T>(dataHome: string, body: () => Promise<T>): Promise<T> {
  const was = process.env.GRAPHYARD_DATA_HOME;
  process.env.GRAPHYARD_DATA_HOME = dataHome;
  try { return await body(); }
  finally { if (was === undefined) delete process.env.GRAPHYARD_DATA_HOME; else process.env.GRAPHYARD_DATA_HOME = was; }
}

test('unit:approver-stall-followup — soak: over a simulated day the real loop rebinds an already-watched approver whose pane master approver replaced without a launch record, never closes the replacement within its start bound or at work, escalates a never-starting one only when due, and leaves no session lingering', { timeout: 300_000 }, async () => {
  const { root, config: bare, cleanup } = await boundCheckout('approver-followup-soak');
  const dataHome = await temporaryDirectory('approver-followup-soak-data');
  try {
    await withDataHome(dataHome, async () => {
      // A start bound above the loop's 60-second settle, as the GY-1598 soak runs it.
      await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), run: { ...bare.run, launchStartSeconds: 300 } });
      const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };
      const bound = launchStartMs(config), minute = 60_000, hour = 60 * minute;
      mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T00:00:00.000Z') });
      const start = Date.now();
      // Two decisions, each watched with a working approver its launch recorded. Six minutes in, `master approver` replaces that pane
      // and the replacement's record cannot be written: one replacement never starts (done at an empty prompt), so do the loop's
      // relaunches; the other works eight minutes, within the judge bound, and applies its decision, after being replaced by hand
      // once more four minutes into its work.
      const work = (n: number): Work => ({ ...item(), id: `work-${n}`, key: `GY-${n}` });
      const stalls = { decision: 'aaaaaaaa-0000-4000-8000-0000000016a1', work: work(1701), starts: false };
      const works = { decision: 'bbbbbbbb-0000-4000-8000-0000000016b2', work: work(1702), starts: true };
      const behaviours = [stalls, works], decisions = new Map(behaviours.map(entry => [entry.decision, 'requested']));
      type Pane = { pane: string; name: string; status: string; since: number; decision: string; hand: boolean };
      const panes = new Map<string, Pane>(), closes: string[] = [], closedWithinBound: string[] = [], closedWhileWorking: string[] = [], launches = new Map<string, number>();
      const nameOf = (entry: typeof stalls) => approverSessionName(entry.work, entry.decision);
      const state = emptyDaemonState(config);
      for (const entry of behaviours) {
        const pane = `pane-recorded-${entry.decision}`;
        panes.set(pane, { pane, name: nameOf(entry), status: 'working', since: start, decision: entry.decision, hand: false });
        await autonomy.saveApproverLaunch(root, { agentName: nameOf(entry), account: null, runtime: 'claude', session: null, launchedAt: new Date(start).toISOString(), work: entry.work.key, decision: entry.decision, pane });
        state.approvals[`${handWatchPrefix}${entry.decision}`] = approvalWatchSchema.parse({ work: entry.work.key, action: 'requirements', decision: entry.decision, requestedAt: new Date(start).toISOString(), agentName: nameOf(entry), pane, launchedAt: new Date(start).toISOString(), launches: 1 });
      }
      const close = (pane: string) => {
        const session = panes.get(pane); if (!session) return;
        if (session.status === 'working') closedWhileWorking.push(`${session.name} ${pane}`);
        if (Date.now() - session.since < bound) closedWithinBound.push(`${pane} after ${(Date.now() - session.since) / 1000}s`);
        closes.push(pane); panes.delete(pane);
      };
      let next = 0, creating: string | null = null;
      const herdr = (_command: string, args: string[]): string => {
        if (args[0] === 'tab' && args[1] === 'create') { creating = `pane-loop-${++next}`; return JSON.stringify({ result: { root_pane: { pane_id: creating, tab_id: `tab-${next}` } } }); }
        if (args[0] === 'pane' && args[1] === 'close') { close(args[2]!); return JSON.stringify({ result: {} }); }
        if (args[0] === 'pane' && args[1] === 'list') return JSON.stringify({ result: { panes: [...panes.keys(), ...(creating ? [creating] : [])].map(pane_id => ({ pane_id })) } });
        if (args[0] === 'agent' && args[1] === 'read') return '╭─\n│ > \n╰─';
        return startedAtOnce(args) ?? JSON.stringify({ result: {} });
      };
      const listed = (): HerdrAgent[] => [...panes.values()].map(session => ({ name: session.name, pane_id: session.pane, agent: 'claude', agent_status: session.status }));
      // `master approver` by hand, its record unwritten: the watched pane is closed and a same-named one opens in its place.
      const replaceByHand = (entry: typeof stalls, at: number) => {
        for (const session of [...panes.values()]) if (session.decision === entry.decision) panes.delete(session.pane);
        const pane = `pane-hand-${entry.decision}-${at}`;
        panes.set(pane, { pane, name: nameOf(entry), status: entry.starts ? 'working' : 'done', since: at, decision: entry.decision, hand: true });
      };
      const loop: DaemonEffects = {
        agents: listed, credentials: async () => ({}), snapshot: async () => ({ work: behaviours.map(entry => entry.work), now: new Date().toISOString() }),
        closeSession: pane => close(pane), dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
        decisions: async item => ({ decisions: behaviours.filter(entry => entry.work.id === item.id).map(entry => ({ id: entry.decision, action: 'requirements', state: decisions.get(entry.decision)!, input: {}, approvedBy: null, requestedAt: new Date(start).toISOString() })) }),
        approverLaunches: () => autonomy.readApproverLaunches(root),
        sessionOutput: () => '╭─\n│ > \n╰─', idleScreenPauseMs: 0,
        approver: async (subject, id) => {
          const entry = behaviours.find(candidate => candidate.decision === id)!;
          const launched = await autonomy.launchApprover(root, subject, id, 'claude', { agents: listed(), available: true }, herdr, {}, async () => ({}), { screenPauseMs: 0 });
          launches.set(id, (launches.get(id) ?? 0) + 1);
          panes.set(launched.pane!, { pane: launched.pane!, name: launched.agentName, status: entry.starts ? 'working' : 'done', since: Date.now(), decision: id, hand: false }); creating = null;
          return { agentName: launched.agentName, pane: launched.pane, runtime: launched.runtime, session: launched.session, ...(launched.replaced ? { replaced: launched.replaced } : {}) };
        },
      };
      const violations: string[] = [], failures: string[] = [], replacedAt = [6 * minute, 10 * minute];
      let cycles = 0;
      for (let now = start; now < start + 24 * hour; now += 2 * minute, cycles++) {
        mock.timers.setTime(now);
        if (now - start === replacedAt[0]) for (const entry of behaviours) replaceByHand(entry, now);
        if (now - start === replacedAt[1]) replaceByHand(works, now);
        // A working approver applies its decision after eight minutes, then its session ends `done`.
        for (const session of panes.values()) if (session.status === 'working' && now - session.since >= 8 * minute) { session.status = 'done'; decisions.set(session.decision, 'applied'); }
        const result = await runCycle(config, state, loop, () => Date.now());
        failures.push(...result.actions.filter(action => action.state === 'failed').map(action => `${new Date(now).toISOString()} ${action.detail}`));
        for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`${new Date(now).toISOString()} ${check.line}`);
      }

      assert.ok(cycles >= 700, 'the loop ran a whole simulated day');
      assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
      assert.deepEqual(closedWithinBound, [], 'no approver, the unrecorded replacements included, is closed within its start bound');
      assert.deepEqual(closedWhileWorking, [], 'no approver at work is closed under it');
      // The replacement that never starts: rebound and dated from when the loop first saw it, closed only past that bound, its
      // decision relaunched within the launch bound and then escalated once, never launched again.
      assert.ok(closes.includes(`pane-hand-${stalls.decision}-${start + replacedAt[0]!}`), `the never-starting replacement is closed once due: ${closes.join(', ')}`);
      assert.ok((launches.get(stalls.decision) ?? 0) <= maxApproverLaunches - 1, `it is relaunched only within the launch bound: ${launches.get(stalls.decision)}`);
      assert.ok(state.approvals[`${handWatchPrefix}${stalls.decision}`]?.exhaustedAt, `past the bound its decision is escalated, not relaunched: ${failures.join('; ')}`);
      const escalated = failures.filter(detail => detail.includes(stalls.decision) && /so the loop has stopped spending sessions on it/.test(detail));
      assert.equal(escalated.length, 1, 'escalated once');
      assert.equal(decisions.get(stalls.decision), 'requested');
      // The replacement at work: left to judge, its decision applied, its session closed after; nothing relaunched for it.
      assert.equal(decisions.get(works.decision), 'applied');
      assert.equal(launches.get(works.decision) ?? 0, 0, 'the working replacement is never relaunched');
      assert.deepEqual(listed().filter(agent => agent.name !== nameOf(stalls)).map(agent => agent.pane_id), [], 'no approver of a settled decision lingers');
      assert.ok(listed().length <= 1, `at most the escalated decision's last session is left: ${JSON.stringify(listed())}`);
      assert.deepEqual(failures.filter(detail => !escalated.includes(detail) && /approver/i.test(detail)), [], 'no approver close or launch failed');
    });
  } finally { mock.timers.reset(); await cleanup(); await rm(dataHome, { recursive: true, force: true }); }
});

test('unit:approver-stall-followup — soak: a watch whose loop relaunch failed binds the approver master approver then starts by hand for its decision, dated from the cycle that first saw it, and the loop launches nothing beside it', { timeout: 300_000 }, async () => {
  const { root, config: bare, cleanup } = await boundCheckout('approver-failed-launch-soak');
  const dataHome = await temporaryDirectory('approver-failed-launch-soak-data');
  try {
    await withDataHome(dataHome, async () => {
      await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), run: { ...bare.run, launchStartSeconds: 300 } });
      const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };
      const bound = launchStartMs(config), minute = 60_000, hour = 60 * minute;
      mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T00:00:00.000Z') });
      const start = Date.now(), subject: Work = { ...item(), id: 'work-1703', key: 'GY-1703' }, decision = 'cccccccc-0000-4000-8000-0000000016c3';
      const name = approverSessionName(subject, decision);
      let judged = 'requested';
      type Pane = { pane: string; status: string; since: number };
      const panes = new Map<string, Pane>(), closedWithinBound: string[] = [], closedWhileWorking: string[] = [], failures: string[] = [], violations: string[] = [];
      // The recorded launch never starts: done at an empty prompt, so once past its start bound the loop closes it and relaunches.
      panes.set('pane-recorded', { pane: 'pane-recorded', status: 'done', since: start });
      await autonomy.saveApproverLaunch(root, { agentName: name, account: null, runtime: 'claude', session: null, launchedAt: new Date(start).toISOString(), work: subject.key, decision, pane: 'pane-recorded' });
      const watchKey = `${handWatchPrefix}${decision}`;
      const state = emptyDaemonState(config);
      state.approvals[watchKey] = approvalWatchSchema.parse({ work: subject.key, action: 'requirements', decision, requestedAt: new Date(start).toISOString(), agentName: name, pane: 'pane-recorded', launchedAt: new Date(start).toISOString(), launches: 1 });
      const listed = (): HerdrAgent[] => [...panes.values()].map(session => ({ name, pane_id: session.pane, agent: 'claude', agent_status: session.status }));
      let relaunches = 0, handAt: number | null = null;
      const loop: DaemonEffects = {
        agents: listed, credentials: async () => ({}), snapshot: async () => ({ work: [subject], now: new Date().toISOString() }),
        closeSession: pane => {
          const session = panes.get(pane); if (!session) return;
          if (session.status === 'working') closedWhileWorking.push(pane);
          if (Date.now() - session.since < bound) closedWithinBound.push(`${pane} after ${(Date.now() - session.since) / 1000}s`);
          panes.delete(pane);
        },
        dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
        decisions: async () => ({ decisions: [{ id: decision, action: 'requirements', state: judged, input: {}, approvedBy: null, requestedAt: new Date(start).toISOString() }] }),
        approverLaunches: () => autonomy.readApproverLaunches(root),
        sessionOutput: () => '╭─\n│ > \n╰─', idleScreenPauseMs: 0,
        // The loop's relaunch fails, leaving the watch with no session; only that one is expected.
        approver: async () => { relaunches += 1; throw new Error('Herdr refused to create the approver tab'); },
      };
      for (let now = start; now < start + 2 * hour; now += 2 * minute) {
        mock.timers.setTime(now);
        // The cycle after the failed relaunch, `master approver` starts a working session by hand; its record cannot be written.
        if (relaunches === 1 && handAt === null) { handAt = now; panes.set(`pane-hand-${now}`, { pane: `pane-hand-${now}`, status: 'working', since: now }); }
        for (const session of panes.values()) if (session.status === 'working' && now - session.since >= 8 * minute) { session.status = 'done'; judged = 'applied'; }
        const result = await runCycle(config, state, loop, () => Date.now());
        failures.push(...result.actions.filter(action => action.state === 'failed').map(action => `${new Date(now).toISOString()} ${action.detail}`));
        for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`${new Date(now).toISOString()} ${check.line}`);
      }

      assert.ok(handAt !== null, `the loop's relaunch was made and failed: ${failures.join('; ')}`);
      assert.equal(relaunches, 1, `nothing is launched beside the hand-started approver: ${failures.join('; ')}`);
      assert.equal(judged, 'applied', 'the hand-started approver judged its decision');
      assert.deepEqual(closedWithinBound, [], 'no approver is closed within its start bound');
      assert.deepEqual(closedWhileWorking, [], 'no approver at work is closed under it');
      assert.deepEqual(listed(), [], 'its session is closed once the decision is applied');
      assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
      assert.deepEqual(failures.filter(detail => /approver/i.test(detail) && !/Herdr refused to create the approver tab/.test(detail)), [], 'no approver close or launch failed but the refused relaunch');
    });
  } finally { mock.timers.reset(); await cleanup(); await rm(dataHome, { recursive: true, force: true }); }
});

test('unit:approver-stall-followup — soak: over a simulated day the real loop rebinds its own decision watch whose pane master approver replaced without a launch record before judging it, so the replacement is dated from the cycle that first saw it, never closed within its start bound or at work, and every invariant holds', { timeout: 300_000 }, async () => {
  const { root, config: bare, cleanup } = await boundCheckout('approver-routine-rebind-soak');
  const dataHome = await temporaryDirectory('approver-routine-rebind-soak-data');
  try {
    await withDataHome(dataHome, async () => {
      await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), run: { ...bare.run, launchStartSeconds: 300 } });
      const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };
      const bound = launchStartMs(config), minute = 60_000, hour = 60 * minute;
      mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T00:00:00.000Z') });
      const start = Date.now(), at = new Date(start).toISOString();
      // Two machine-filed items whose triage proposed a closure: the loop's own `close` decision watch holds each, with a working
      // approver its launch recorded. Six minutes in, past that launch's start bound, `master approver` replaces each pane and the
      // replacement's record cannot be written: one replacement never starts (done at an empty prompt), the other works eight minutes
      // and applies its decision.
      const triaged = (n: number): Work => ({ ...item(), id: `work-${n}`, key: `GY-${n}`, stage: 'backlog', ready: false,
        triage: { judgement: { outcome: 'close', reason: 'Not worth doing' }, state: 'proposed', by: 'graphyard-triage', at } } as unknown as Work);
      const stalls = { decision: 'dddddddd-0000-4000-8000-0000000016d4', work: triaged(1704), starts: false };
      const works = { decision: 'eeeeeeee-0000-4000-8000-0000000016e5', work: triaged(1705), starts: true };
      const behaviours = [stalls, works], decisions = new Map(behaviours.map(entry => [entry.decision, 'requested']));
      type Pane = { pane: string; name: string; status: string; since: number; decision: string };
      const panes = new Map<string, Pane>(), closes: string[] = [], closedWithinBound: string[] = [], closedWhileWorking: string[] = [], launches = new Map<string, number>();
      const nameOf = (entry: typeof stalls) => approverSessionName(entry.work, entry.decision);
      const state = emptyDaemonState(config), keys = new Map<string, string>();
      for (const entry of behaviours) {
        const pane = `pane-recorded-${entry.decision}`, routine = neededDecision(entry.work, config)!;
        assert.equal(routine?.action, 'close', 'the loop calls for the triage closure decision');
        keys.set(entry.decision, decisionKey(entry.work, routine));
        panes.set(pane, { pane, name: nameOf(entry), status: 'working', since: start, decision: entry.decision });
        await autonomy.saveApproverLaunch(root, { agentName: nameOf(entry), account: null, runtime: 'claude', session: null, launchedAt: at, work: entry.work.key, decision: entry.decision, pane });
        state.approvals[keys.get(entry.decision)!] = approvalWatchSchema.parse({ work: entry.work.key, action: 'close', decision: entry.decision, requestedAt: at, agentName: nameOf(entry), pane, launchedAt: at, launches: 1 });
      }
      const close = (pane: string) => {
        const session = panes.get(pane); if (!session) return;
        if (session.status === 'working') closedWhileWorking.push(`${session.name} ${pane}`);
        if (Date.now() - session.since < bound) closedWithinBound.push(`${pane} after ${(Date.now() - session.since) / 1000}s`);
        closes.push(pane); panes.delete(pane);
      };
      let next = 0, creating: string | null = null;
      const herdr = (_command: string, args: string[]): string => {
        if (args[0] === 'tab' && args[1] === 'create') { creating = `pane-loop-${++next}`; return JSON.stringify({ result: { root_pane: { pane_id: creating, tab_id: `tab-${next}` } } }); }
        if (args[0] === 'pane' && args[1] === 'close') { close(args[2]!); return JSON.stringify({ result: {} }); }
        if (args[0] === 'pane' && args[1] === 'list') return JSON.stringify({ result: { panes: [...panes.keys(), ...(creating ? [creating] : [])].map(pane_id => ({ pane_id })) } });
        if (args[0] === 'agent' && args[1] === 'read') return '╭─\n│ > \n╰─';
        return startedAtOnce(args) ?? JSON.stringify({ result: {} });
      };
      const listed = (): HerdrAgent[] => [...panes.values()].map(session => ({ name: session.name, pane_id: session.pane, agent: 'claude', agent_status: session.status }));
      const loop: DaemonEffects = {
        agents: listed, credentials: async () => ({}), // An applied closure closes its item.
        snapshot: async () => ({ work: behaviours.map(entry => decisions.get(entry.decision) === 'applied' ? { ...entry.work, stage: 'done', triage: { ...entry.work.triage!, state: 'applied' } } as Work : entry.work), now: new Date().toISOString() }),
        closeSession: pane => close(pane), dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
        decisions: async item => ({ decisions: behaviours.filter(entry => entry.work.id === item.id).map(entry => ({ id: entry.decision, action: 'close', state: decisions.get(entry.decision)!, input: {}, approvedBy: null, requestedAt: at })) }),
        approverLaunches: () => autonomy.readApproverLaunches(root),
        sessionOutput: () => '╭─\n│ > \n╰─', idleScreenPauseMs: 0,
        approver: async (subject, id) => {
          const entry = behaviours.find(candidate => candidate.decision === id)!;
          const launched = await autonomy.launchApprover(root, subject, id, 'claude', { agents: listed(), available: true }, herdr, {}, async () => ({}), { screenPauseMs: 0 });
          launches.set(id, (launches.get(id) ?? 0) + 1);
          panes.set(launched.pane!, { pane: launched.pane!, name: launched.agentName, status: entry.starts ? 'working' : 'done', since: Date.now(), decision: id }); creating = null;
          return { agentName: launched.agentName, pane: launched.pane, runtime: launched.runtime, session: launched.session, ...(launched.replaced ? { replaced: launched.replaced } : {}) };
        },
      };
      const violations: string[] = [], failures: string[] = [], replacedAt = 6 * minute;
      let cycles = 0;
      for (let now = start; now < start + 24 * hour; now += 2 * minute, cycles++) {
        mock.timers.setTime(now);
        // `master approver` by hand, its record unwritten: the watched pane is closed and a same-named one opens in its place.
        if (now - start === replacedAt) for (const entry of behaviours) {
          for (const session of [...panes.values()]) if (session.decision === entry.decision) panes.delete(session.pane);
          const pane = `pane-hand-${entry.decision}`;
          panes.set(pane, { pane, name: nameOf(entry), status: entry.starts ? 'working' : 'done', since: now, decision: entry.decision });
        }
        for (const session of panes.values()) if (session.status === 'working' && now - session.since >= 8 * minute) { session.status = 'done'; decisions.set(session.decision, 'applied'); }
        const result = await runCycle(config, state, loop, () => Date.now());
        failures.push(...result.actions.filter(action => action.state === 'failed').map(action => `${new Date(now).toISOString()} ${action.detail}`));
        for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`${new Date(now).toISOString()} ${check.line}`);
        // Each replacement is rebound, dated from the cycle that first saw it, before any step judges it.
        for (const entry of behaviours) {
          const watch = state.approvals[keys.get(entry.decision)!];
          if (now - start === replacedAt && watch) assert.deepEqual([watch.pane, watch.launchedAt], [`pane-hand-${entry.decision}`, new Date(now).toISOString()], `${entry.decision}: rebound to the replacement in the cycle that first saw it`);
        }
      }

      assert.ok(cycles >= 700, 'the loop ran a whole simulated day');
      assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
      assert.deepEqual(closedWithinBound, [], 'no approver, the unrecorded replacements included, is closed within its start bound');
      assert.deepEqual(closedWhileWorking, [], 'no approver at work is closed under it');
      assert.ok(closes.includes(`pane-hand-${stalls.decision}`), `the never-starting replacement is closed once due: ${closes.join(', ')}`);
      assert.ok((launches.get(stalls.decision) ?? 0) <= maxApproverLaunches - 1, `it is relaunched only within the launch bound: ${launches.get(stalls.decision)}`);
      assert.equal(decisions.get(works.decision), 'applied');
      assert.equal(launches.get(works.decision) ?? 0, 0, 'the working replacement is never relaunched');
      assert.deepEqual(listed().filter(agent => agent.name !== nameOf(stalls)).map(agent => agent.pane_id), [], 'no approver of a settled decision lingers');
      assert.ok(listed().length <= 1, `at most the stalled decision's last session is left: ${JSON.stringify(listed())}`);
      assert.deepEqual(failures.filter(detail => /approver/i.test(detail) && !/so the loop has stopped spending sessions on it/.test(detail)), [], `no approver close or launch failed: ${failures.join('; ')}`);
    });
  } finally { mock.timers.reset(); await cleanup(); await rm(dataHome, { recursive: true, force: true }); }
});

test('unit:approver-stall-first-seen — soak: over a simulated day the real loop rebinds replaced approver panes whose predecessor registry sessions the registry refuses to end for several cycles, dates each from the cycle that first saw it, judges a never-starting one at the bound from that sight, ends every predecessor session once, and every invariant holds', { timeout: 300_000 }, async () => {
  const { root, config: bare, cleanup } = await boundCheckout('approver-refused-end-soak');
  const dataHome = await temporaryDirectory('approver-refused-end-soak-data');
  try {
    await withDataHome(dataHome, async () => {
      await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), run: { ...bare.run, launchStartSeconds: 300 } });
      const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };
      const bound = launchStartMs(config), minute = 60_000, hour = 60 * minute, cycleMs = 2 * minute;
      mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T00:00:00.000Z') });
      const start = Date.now();
      // GY-1612: two decisions, each watched with a working approver its launch recorded with a registry session. Six minutes in,
      // `master approver` replaces each pane and the replacement's record cannot be written; the registry refuses to end each
      // predecessor's session for four cycles, longer than the start bound, then accepts. One replacement never starts, the other
      // works nine minutes, within the judge bound from its first
      // sight but past the cycle its rebind waits for, and applies its decision.
      const work = (n: number): Work => ({ ...item(), id: `work-${n}`, key: `GY-${n}` });
      const stalls = { decision: 'ffffffff-0000-4000-8000-0000000016f6', work: work(1706), starts: false };
      const works = { decision: 'abababab-0000-4000-8000-0000000016a7', work: work(1707), starts: true };
      const behaviours = [stalls, works], decisions = new Map(behaviours.map(entry => [entry.decision, 'requested']));
      type Pane = { pane: string; name: string; status: string; since: number; decision: string };
      const panes = new Map<string, Pane>(), closes: Array<{ pane: string; at: number }> = [], closedWithinBound: string[] = [], closedWhileWorking: string[] = [], launches = new Map<string, number>();
      const nameOf = (entry: typeof stalls) => approverSessionName(entry.work, entry.decision);
      const registry = (entry: typeof stalls) => `registry-${entry.decision}`;
      const refusals = new Map(behaviours.map(entry => [registry(entry), 4])), ended: string[] = [];
      const state = emptyDaemonState(config);
      for (const entry of behaviours) {
        const pane = `pane-recorded-${entry.decision}`;
        panes.set(pane, { pane, name: nameOf(entry), status: 'working', since: start, decision: entry.decision });
        await autonomy.saveApproverLaunch(root, { agentName: nameOf(entry), account: null, runtime: 'claude', session: registry(entry), launchedAt: new Date(start).toISOString(), work: entry.work.key, decision: entry.decision, pane });
        state.approvals[`${handWatchPrefix}${entry.decision}`] = approvalWatchSchema.parse({ work: entry.work.key, action: 'requirements', decision: entry.decision, requestedAt: new Date(start).toISOString(), agentName: nameOf(entry), pane, launchedAt: new Date(start).toISOString(), launches: 1, session: registry(entry) });
      }
      const close = (pane: string) => {
        const session = panes.get(pane); if (!session) return;
        if (session.status === 'working') closedWhileWorking.push(`${session.name} ${pane}`);
        if (Date.now() - session.since < bound) closedWithinBound.push(`${pane} after ${(Date.now() - session.since) / 1000}s`);
        closes.push({ pane, at: Date.now() }); panes.delete(pane);
      };
      let next = 0, creating: string | null = null;
      const herdr = (_command: string, args: string[]): string => {
        if (args[0] === 'tab' && args[1] === 'create') { creating = `pane-loop-${++next}`; return JSON.stringify({ result: { root_pane: { pane_id: creating, tab_id: `tab-${next}` } } }); }
        if (args[0] === 'pane' && args[1] === 'close') { close(args[2]!); return JSON.stringify({ result: {} }); }
        if (args[0] === 'pane' && args[1] === 'list') return JSON.stringify({ result: { panes: [...panes.keys(), ...(creating ? [creating] : [])].map(pane_id => ({ pane_id })) } });
        if (args[0] === 'agent' && args[1] === 'read') return '╭─\n│ > \n╰─';
        return startedAtOnce(args) ?? JSON.stringify({ result: {} });
      };
      const listed = (): HerdrAgent[] => [...panes.values()].map(session => ({ name: session.name, pane_id: session.pane, agent: 'claude', agent_status: session.status }));
      const loop: DaemonEffects = {
        agents: listed, credentials: async () => ({}), snapshot: async () => ({ work: behaviours.map(entry => entry.work), now: new Date().toISOString() }),
        closeSession: pane => close(pane), dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
        decisions: async item => ({ decisions: behaviours.filter(entry => entry.work.id === item.id).map(entry => ({ id: entry.decision, action: 'requirements', state: decisions.get(entry.decision)!, input: {}, approvedBy: null, requestedAt: new Date(start).toISOString() })) }),
        approverLaunches: () => autonomy.readApproverLaunches(root),
        sessionOutput: () => '╭─\n│ > \n╰─', idleScreenPauseMs: 0,
        endRegistrySession: async id => {
          const left = refusals.get(id) ?? 0;
          if (left > 0) { refusals.set(id, left - 1); throw new Error('registry refused the end: 500 Internal Server Error'); }
          ended.push(id);
        },
        approver: async (subject, id) => {
          const entry = behaviours.find(candidate => candidate.decision === id)!;
          const launched = await autonomy.launchApprover(root, subject, id, 'claude', { agents: listed(), available: true }, herdr, {}, async () => ({}), { screenPauseMs: 0 });
          launches.set(id, (launches.get(id) ?? 0) + 1);
          panes.set(launched.pane!, { pane: launched.pane!, name: launched.agentName, status: entry.starts ? 'working' : 'done', since: Date.now(), decision: id }); creating = null;
          return { agentName: launched.agentName, pane: launched.pane, runtime: launched.runtime, session: launched.session, ...(launched.replaced ? { replaced: launched.replaced } : {}) };
        },
      };
      const violations: string[] = [], failures: string[] = [], replacedAt = start + 6 * minute;
      const rebound = new Map<string, { at: number; launchedAt: string }>();
      let cycles = 0;
      for (let now = start; now < start + 24 * hour; now += cycleMs, cycles++) {
        mock.timers.setTime(now);
        if (now === replacedAt) for (const entry of behaviours) {
          for (const session of [...panes.values()]) if (session.decision === entry.decision) panes.delete(session.pane);
          const pane = `pane-hand-${entry.decision}`;
          panes.set(pane, { pane, name: nameOf(entry), status: entry.starts ? 'working' : 'done', since: now, decision: entry.decision });
        }
        for (const session of panes.values()) if (session.status === 'working' && now - session.since >= 9 * minute) { session.status = 'done'; decisions.set(session.decision, 'applied'); }
        const result = await runCycle(config, state, loop, () => Date.now());
        failures.push(...result.actions.filter(action => action.state === 'failed').map(action => `${new Date(now).toISOString()} ${action.detail}`));
        for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`${new Date(now).toISOString()} ${check.line}`);
        for (const entry of behaviours) {
          const watch = state.approvals[`${handWatchPrefix}${entry.decision}`];
          // While the end is refused the watch holds the predecessor, its first sight of the replacement stamped and unchanged.
          if (watch && now >= replacedAt && (refusals.get(registry(entry)) ?? 0) > 0) assert.deepEqual([watch.pane, watch.movedPane], [`pane-recorded-${entry.decision}`, { pane: `pane-hand-${entry.decision}`, at: new Date(replacedAt).toISOString() }], `${entry.decision}: held across refused ends at ${new Date(now).toISOString()}`);
          // The rebind's own note names the date it gave the replacement; the step may judge and close it in that same cycle.
          const note = result.actions.map(action => action.detail.match(new RegExp(`in pane pane-hand-${entry.decision}, which replaced the one the watch held; no launch record names that pane, so it is dated from (\\S+), when`))).find(Boolean);
          if (note) { assert.ok(!rebound.has(entry.decision), `${entry.decision}: rebound once`); rebound.set(entry.decision, { at: now, launchedAt: note[1]! }); }
        }
      }

      assert.ok(cycles >= 700, 'the loop ran a whole simulated day');
      assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
      assert.deepEqual(closedWithinBound, [], 'no approver is closed within its start bound');
      assert.deepEqual(closedWhileWorking, [], 'no approver at work is closed under it');
      for (const entry of behaviours) {
        const bind = rebound.get(entry.decision);
        assert.ok(bind, `${entry.decision}: rebound to its replacement once the end went through`);
        assert.ok(bind.at >= replacedAt + 4 * cycleMs, 'only after the four refused cycles');
        assert.equal(bind.launchedAt, new Date(replacedAt).toISOString(), `${entry.decision}: dated from the cycle that first saw it, not the cycle the end succeeded`);
      }
      assert.deepEqual(ended.sort(), behaviours.map(registry).sort(), 'each predecessor registry session is ended exactly once');
      // The never-starting replacement is judged at the bound from first sight: by the time the end goes through, already past it,
      // so it is closed within a cycle of the rebind rather than a whole start bound later.
      const stalled = closes.find(entry => entry.pane === `pane-hand-${stalls.decision}`);
      assert.ok(stalled, `the never-starting replacement is closed once due: ${closes.map(entry => entry.pane).join(', ')}`);
      assert.ok(stalled.at < rebound.get(stalls.decision)!.at + bound, `closed at the bound from first sight, not delayed by the refused ends: ${new Date(stalled.at).toISOString()}`);
      assert.ok((launches.get(stalls.decision) ?? 0) <= maxApproverLaunches - 1, `relaunched only within the launch bound: ${launches.get(stalls.decision)}`);
      assert.ok(state.approvals[`${handWatchPrefix}${stalls.decision}`]?.exhaustedAt, 'past the bound its decision is escalated, not relaunched');
      assert.equal(failures.filter(detail => detail.includes(stalls.decision) && /so the loop has stopped spending sessions on it/.test(detail)).length, 1, 'escalated once');
      assert.equal(decisions.get(works.decision), 'applied');
      assert.equal(launches.get(works.decision) ?? 0, 0, 'the working replacement is never relaunched');
      assert.deepEqual(listed().filter(agent => agent.name !== nameOf(stalls)).map(agent => agent.pane_id), [], 'no approver of a settled decision lingers');
      assert.ok(listed().length <= 1, `at most the escalated decision's last session is left: ${JSON.stringify(listed())}`);
      assert.deepEqual(failures.filter(detail => /approver/i.test(detail) && !/so the loop has stopped spending sessions on it/.test(detail) && !/Could not end approver registry session/.test(detail)), [], `no approver close or launch failed but the refused ends: ${failures.join('; ')}`);
      assert.equal(failures.filter(detail => /Could not end approver registry session/.test(detail)).length, 8, 'each refused end is reported, four per predecessor');
    });
  } finally { mock.timers.reset(); await cleanup(); await rm(dataHome, { recursive: true, force: true }); }
});

test('unit:approver-stall-first-seen — soak: over a simulated day the loop\'s own decision watches whose relaunch failed after its pane opened, leaving a registry session the registry refuses to end for several cycles, never launch over or adopt across the listed same-name session, take it once that session is ended, dated from first sight or its own pane-bound record, and every invariant holds', { timeout: 300_000 }, async () => {
  const { root, config: bare, cleanup } = await boundCheckout('approver-failed-launch-adopt-soak');
  const dataHome = await temporaryDirectory('approver-failed-launch-adopt-soak-data');
  try {
    await withDataHome(dataHome, async () => {
      await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), run: { ...bare.run, launchStartSeconds: 300 } });
      const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };
      const bound = launchStartMs(config), minute = 60_000, hour = 60 * minute, cycleMs = 2 * minute;
      mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T00:00:00.000Z') });
      const start = Date.now(), at = new Date(start).toISOString();
      // GY-1612: three machine-filed items whose triage proposed a closure, each held by the loop's own `close` decision watch with a
      // recorded approver that never starts. Past its start bound the loop closes it and relaunches; that relaunch opens its pane and
      // registers a session, then fails, leaving the watch that registry session and no pane while the pane is listed under the
      // decision's approver name. The registry refuses to end those sessions for eight minutes, longer than the start bound. One left
      // pane is unrecorded and works nine minutes; one had its launch record written before the failure and works nine minutes; one is
      // unrecorded and never starts, so once taken it is judged at the bound from first sight and, past the launch bound, escalated.
      const triaged = (n: number): Work => ({ ...item(), id: `work-${n}`, key: `GY-${n}`, stage: 'backlog', ready: false,
        triage: { judgement: { outcome: 'close', reason: 'Not worth doing' }, state: 'proposed', by: 'graphyard-triage', at } } as unknown as Work);
      const works = { decision: 'cdcdcdcd-0000-4000-8000-0000000016c8', work: triaged(1708), left: 'working', recorded: false };
      const recorded = { decision: 'efefefef-0000-4000-8000-0000000016e9', work: triaged(1709), left: 'working', recorded: true };
      const stalls = { decision: 'a1a1a1a1-0000-4000-8000-0000000016a0', work: triaged(1710), left: 'done', recorded: false };
      const behaviours = [works, recorded, stalls], decisions = new Map(behaviours.map(entry => [entry.decision, 'requested']));
      type Pane = { pane: string; name: string; status: string; since: number; decision: string };
      const panes = new Map<string, Pane>(), closes: Array<{ pane: string; at: number }> = [], closedWithinBound: string[] = [], closedWhileWorking: string[] = [];
      const calls = new Map<string, number>(), failed = new Map<string, { pane: string; at: number }>(), ended: string[] = [];
      const nameOf = (entry: typeof works) => approverSessionName(entry.work, entry.decision);
      const orphan = (id: string) => `registry-orphan-${id}`;
      const state = emptyDaemonState(config), keys = new Map<string, string>();
      for (const entry of behaviours) {
        const pane = `pane-recorded-${entry.decision}`, routine = neededDecision(entry.work, config)!;
        assert.equal(routine?.action, 'close', 'the loop calls for the triage closure decision');
        keys.set(entry.decision, decisionKey(entry.work, routine));
        panes.set(pane, { pane, name: nameOf(entry), status: 'done', since: start, decision: entry.decision });
        await autonomy.saveApproverLaunch(root, { agentName: nameOf(entry), account: null, runtime: 'claude', session: null, launchedAt: at, work: entry.work.key, decision: entry.decision, pane });
        state.approvals[keys.get(entry.decision)!] = approvalWatchSchema.parse({ work: entry.work.key, action: 'close', decision: entry.decision, requestedAt: at, agentName: nameOf(entry), pane, launchedAt: at, launches: 1 });
      }
      const close = (pane: string) => {
        const session = panes.get(pane); if (!session) return;
        if (session.status === 'working') closedWhileWorking.push(`${session.name} ${pane}`);
        if (Date.now() - session.since < bound) closedWithinBound.push(`${pane} after ${(Date.now() - session.since) / 1000}s`);
        closes.push({ pane, at: Date.now() }); panes.delete(pane);
      };
      let next = 0, creating: string | null = null;
      const herdr = (_command: string, args: string[]): string => {
        if (args[0] === 'tab' && args[1] === 'create') { creating = `pane-loop-${++next}`; return JSON.stringify({ result: { root_pane: { pane_id: creating, tab_id: `tab-${next}` } } }); }
        if (args[0] === 'pane' && args[1] === 'close') { close(args[2]!); return JSON.stringify({ result: {} }); }
        if (args[0] === 'pane' && args[1] === 'list') return JSON.stringify({ result: { panes: [...panes.keys(), ...(creating ? [creating] : [])].map(pane_id => ({ pane_id })) } });
        if (args[0] === 'agent' && args[1] === 'read') return '╭─\n│ > \n╰─';
        return startedAtOnce(args) ?? JSON.stringify({ result: {} });
      };
      const listed = (): HerdrAgent[] => [...panes.values()].map(session => ({ name: session.name, pane_id: session.pane, agent: 'claude', agent_status: session.status }));
      const loop: DaemonEffects = {
        agents: listed, credentials: async () => ({}), // An applied closure closes its item.
        snapshot: async () => ({ work: behaviours.map(entry => decisions.get(entry.decision) === 'applied' ? { ...entry.work, stage: 'done', triage: { ...entry.work.triage!, state: 'applied' } } as Work : entry.work), now: new Date().toISOString() }),
        closeSession: pane => close(pane), dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
        decisions: async item => ({ decisions: behaviours.filter(entry => entry.work.id === item.id).map(entry => ({ id: entry.decision, action: 'close', state: decisions.get(entry.decision)!, input: {}, approvedBy: null, requestedAt: at })) }),
        approverLaunches: () => autonomy.readApproverLaunches(root),
        sessionOutput: () => '╭─\n│ > \n╰─', idleScreenPauseMs: 0,
        endRegistrySession: async id => {
          const left = [...failed].find(([decision]) => orphan(decision) === id)?.[1];
          if (left && Date.now() < left.at + 8 * minute) throw new Error('registry refused the end: 500 Internal Server Error');
          ended.push(id);
        },
        approver: async (subject, id) => {
          const entry = behaviours.find(candidate => candidate.decision === id)!;
          const call = (calls.get(id) ?? 0) + 1; calls.set(id, call);
          // The first relaunch opens its pane, registers a session, perhaps writes its record, and then fails.
          if (call === 1) {
            const pane = `pane-failed-${id}`;
            panes.set(pane, { pane, name: nameOf(entry), status: entry.left, since: Date.now(), decision: id });
            if (entry.recorded) await autonomy.saveApproverLaunch(root, { agentName: nameOf(entry), account: 'claude-recorded', runtime: 'claude', session: null, launchedAt: new Date().toISOString(), work: entry.work.key, decision: id, pane });
            failed.set(id, { pane, at: Date.now() });
            throw Object.assign(new Error('the approver session started but its launch could not be confirmed'), { registrySession: orphan(id) });
          }
          const launched = await autonomy.launchApprover(root, subject, id, 'claude', { agents: listed(), available: true }, herdr, {}, async () => ({}), { screenPauseMs: 0 });
          panes.set(launched.pane!, { pane: launched.pane!, name: launched.agentName, status: 'done', since: Date.now(), decision: id }); creating = null;
          return { agentName: launched.agentName, pane: launched.pane, runtime: launched.runtime, session: launched.session, ...(launched.replaced ? { replaced: launched.replaced } : {}) };
        },
      };
      const violations: string[] = [], failures: string[] = [], taken = new Map<string, { at: number; launchedAt: string | null; account: string | null }>();
      let cycles = 0;
      for (let now = start; now < start + 24 * hour; now += cycleMs, cycles++) {
        mock.timers.setTime(now);
        for (const session of panes.values()) if (session.status === 'working' && now - session.since >= 9 * minute) { session.status = 'done'; decisions.set(session.decision, 'applied'); }
        const result = await runCycle(config, state, loop, () => Date.now());
        failures.push(...result.actions.filter(action => action.state === 'failed').map(action => `${new Date(now).toISOString()} ${action.detail}`));
        for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`${new Date(now).toISOString()} ${check.line}`);
        for (const entry of behaviours) {
          const watch = state.approvals[keys.get(entry.decision)!], left = failed.get(entry.decision);
          if (!left || taken.has(entry.decision)) continue;
          // While the registry refuses, the watch keeps the failed launch's session and takes no pane: nothing is adopted across it.
          if (watch && now < left.at + 8 * minute) assert.deepEqual([watch.agentName, watch.pane, watch.session], [null, null, orphan(entry.decision)], `${entry.decision}: held unbound across refused ends at ${new Date(now).toISOString()}`);
          // The bind's own note names the date it gave the pane; the step may judge and close it in that same cycle.
          const note = result.actions.map(action => action.detail).find(detail => detail.includes(`in pane ${left.pane}, launched by hand`));
          if (note) taken.set(entry.decision, { at: now, launchedAt: note.match(/so it is dated from (\S+), when/)?.[1] ?? (watch?.pane === left.pane ? watch.launchedAt : null), account: watch?.pane === left.pane ? watch.account : null });
        }
      }

      assert.ok(cycles >= 700, 'the loop ran a whole simulated day');
      assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
      assert.deepEqual(closedWithinBound, [], 'no approver, the taken ones included, is closed within its start bound');
      assert.deepEqual(closedWhileWorking, [], 'no approver at work is closed under it');
      assert.deepEqual(ended.sort(), behaviours.map(entry => orphan(entry.decision)).sort(), 'each failed launch\'s registry session is ended exactly once, never dropped');
      for (const entry of behaviours) {
        const take = taken.get(entry.decision), left = failed.get(entry.decision);
        assert.ok(take && left, `${entry.decision}: the pane its failed launch left is taken`);
        assert.equal(take.at, left.at + 8 * minute, `${entry.decision}: taken in the cycle the registry session is ended`);
        // Only a record naming the pane dates and bills it; an unrecorded one is dated from the cycle that first saw it.
        assert.deepEqual([take.launchedAt, take.account], entry.recorded ? [new Date(left.at).toISOString(), 'claude-recorded'] : [new Date(left.at + cycleMs).toISOString(), null], `${entry.decision}: judged only by its own pane-bound record or its first sight`);
      }
      // The started sessions are never launched over: one failed launch each and nothing after.
      assert.equal(calls.get(works.decision), 1, 'the unrecorded working session is never launched over');
      assert.equal(calls.get(recorded.decision), 1, 'the recorded working session is never launched over');
      assert.equal(decisions.get(works.decision), 'applied');
      assert.equal(decisions.get(recorded.decision), 'applied');
      // The never-starting one is judged at the bound from its first sight, not a whole bound after the refused ends.
      const stalled = closes.find(entry => entry.pane === failed.get(stalls.decision)?.pane);
      assert.ok(stalled && stalled.at < taken.get(stalls.decision)!.at + bound, `the never-starting pane is closed at the bound from first sight: ${closes.map(entry => entry.pane).join(', ')}`);
      assert.ok((calls.get(stalls.decision) ?? 0) <= maxApproverLaunches, `relaunched only within the launch bound: ${calls.get(stalls.decision)}`);
      assert.equal(failures.filter(detail => detail.includes(stalls.decision) && /so the loop has stopped spending sessions on it/.test(detail)).length, 1, 'escalated once');
      assert.deepEqual(listed().filter(agent => agent.name !== nameOf(stalls)).map(agent => agent.pane_id), [], 'no approver of a settled decision lingers');
      assert.ok(listed().length <= 1, `at most the escalated decision's last session is left: ${JSON.stringify(listed())}`);
      const launchFailures = failures.filter(detail => /could not be confirmed/.test(detail));
      assert.equal(launchFailures.length, behaviours.length, `each decision's failed launch is reported once: ${launchFailures.join('; ')}`);
      assert.deepEqual(failures.filter(detail => /approver/i.test(detail) && !launchFailures.includes(detail) && !/so the loop has stopped spending sessions on it/.test(detail) && !/Could not end approver registry session registry-orphan-/.test(detail)), [], `no other approver close or launch failed: ${failures.join('; ')}`);
    });
  } finally { mock.timers.reset(); await cleanup(); await rm(dataHome, { recursive: true, force: true }); }
});
