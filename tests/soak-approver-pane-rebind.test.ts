import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverSessionName, atomicPrivateWrite, loadMasterConfig, setupMaster, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import { handWatchPrefix, maxApproverLaunches } from '../src/daemon/decisions.js';
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
// Proof: unit:approver-stall-followup.

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
