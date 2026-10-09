import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverSessionName, atomicPrivateWrite, loadMasterConfig, setupMaster, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import { approverJudgeBoundMs, handWatchPrefix, maxApproverLaunches } from '../src/daemon/decisions.js';
import { launchStartMs } from '../src/master/launch.js';
import { type InvariantCheck } from '../src/model/invariants.js';
import * as autonomy from '../src/master/autonomy.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1598: the loop now closes a same-named approver session that never ran its request and
// launches the next one. That runs for every unanswered decision, every cycle, so this soak drives
// the real loop and the real approver launcher over a simulated day against a Herdr world: an
// approver that never starts is closed and relaunched only within maxApproverLaunches and then
// escalated, never launched or closed again; an approver at work is never closed under it; and
// every system invariant holds after every cycle. Proof: unit:approver-idle-stall-relaunch.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const minute = 60_000, hour = 60 * minute;

function item(n: number): Work {
  const now = new Date().toISOString();
  return {
    id: `work-${n}`, key: `GY-${n}`, title: `Rescope ${n}`, description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Rescoped', proofs: ['unit:rescope'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 4, policyRevision: 1, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

/** How every approver session launched for a decision behaves: never starts, or works for `workMs` and applies it; `stallFirst` makes its first fresh session never start. */
type Behaviour = { decision: string; work: Work; stall: 'done' | 'idle' | null; workMs: number; stallFirst?: boolean };
type Pane = { pane: string; name: string; status: string; since: number; decision: string; fresh: number };

test('unit:approver-idle-stall-relaunch — over a simulated day the loop closes and relaunches never-started approvers only within the launch bound, never closes one at work, and every system invariant holds', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-idle-approver'), credentials = await temporaryDirectory('soak-idle-approver-credentials'), dataHome = await temporaryDirectory('soak-idle-approver-data');
  const was = process.env.GRAPHYARD_DATA_HOME;
  process.env.GRAPHYARD_DATA_HOME = dataHome;
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    const approverToken = join(credentials, 'approver.token');
    await writeFile(approverToken, 'approver-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), approver: { id: 'graphyard-approver-project', credentialFile: approverToken } });
    const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };
    const bound = launchStartMs(config);

    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T00:00:00.000Z') });
    const start = Date.now();
    // Three decisions: one whose every approver never starts (done at an empty prompt), one whose
    // approver works within the judge bound and applies it, and one whose first fresh approver sits
    // idle with a still screen and whose next works. Each opens as the incident did: the watch holds
    // no live session while the earlier session's tab sits done in Herdr past its start bound.
    const behaviours: Behaviour[] = [
      { decision: 'aaaaaaaa-0000-4000-8000-000000000001', work: item(1601), stall: 'done', workMs: 0 },
      { decision: 'bbbbbbbb-0000-4000-8000-000000000002', work: item(1602), stall: null, workMs: approverJudgeBoundMs - 2 * minute },
      { decision: 'cccccccc-0000-4000-8000-000000000003', work: item(1603), stall: null, workMs: 5 * minute, stallFirst: true },
    ];
    const decisions = new Map(behaviours.map(entry => [entry.decision, 'requested']));
    const panes = new Map<string, Pane>(), closedWhileWorking: string[] = [], launches = new Map<string, number>(), closes = new Map<string, number>();
    let next = 0;
    const nameOf = (entry: Behaviour) => approverSessionName(entry.work, entry.decision);
    for (const entry of behaviours) {
      panes.set(`pane-old-${entry.decision}`, { pane: `pane-old-${entry.decision}`, name: nameOf(entry), status: 'done', since: start - bound - minute, decision: entry.decision, fresh: 0 });
      await autonomy.saveApproverLaunch(root, { agentName: nameOf(entry), account: null, runtime: 'claude', session: null, launchedAt: new Date(start - bound - minute).toISOString(), work: entry.work.key, decision: entry.decision });
    }
    const close = (pane: string) => {
      const session = panes.get(pane); if (!session) return;
      if (session.status === 'working') closedWhileWorking.push(`${session.name} ${pane}`);
      closes.set(session.decision, (closes.get(session.decision) ?? 0) + 1); panes.delete(pane);
    };
    let creating: string | null = null;
    const herdr = (_command: string, args: string[]): string => {
      if (args[0] === 'tab' && args[1] === 'create') { creating = `pane-${++next}`; return JSON.stringify({ result: { root_pane: { pane_id: creating, tab_id: `tab-${next}` } } }); }
      if (args[0] === 'pane' && args[1] === 'close') { close(args[2]!); return JSON.stringify({ result: {} }); }
      if (args[0] === 'pane' && args[1] === 'list') return JSON.stringify({ result: { panes: [...panes.keys(), ...(creating ? [creating] : [])].map(pane_id => ({ pane_id })) } });
      if (args[0] === 'agent' && args[1] === 'read') return '╭─\n│ > \n╰─';
      return startedAtOnce(args) ?? JSON.stringify({ result: {} });
    };
    const listed = (): HerdrAgent[] => [...panes.values()].map(session => ({ name: session.name, pane_id: session.pane, agent: 'claude', agent_status: session.status }));
    const state = emptyDaemonState(config);
    for (const entry of behaviours) state.approvals[`${handWatchPrefix}${entry.decision}`] = approvalWatchSchema.parse({ work: entry.work.key, action: 'requirements', decision: entry.decision, requestedAt: new Date(start - 10 * minute).toISOString(), launches: 1 });
    const loop: DaemonEffects = {
      agents: listed, credentials: async () => ({}), snapshot: async () => ({ work: behaviours.map(entry => entry.work), now: new Date().toISOString() }),
      closeSession: pane => close(pane), dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
      decisions: async work => ({ decisions: behaviours.filter(entry => entry.work.id === work.id).map(entry => ({ id: entry.decision, action: 'requirements', state: decisions.get(entry.decision)!, input: {}, approvedBy: null, requestedAt: new Date(start - 10 * minute).toISOString() })) }),
      approverLaunches: () => autonomy.readApproverLaunches(root),
      // The real launcher against what Herdr lists now; the pane it creates takes the decision's behaviour.
      approver: async (subject, id) => {
        const entry = behaviours.find(candidate => candidate.decision === id)!;
        const launched = await autonomy.launchApprover(root, subject, id, 'claude', { agents: listed(), available: true }, herdr, {}, async () => ({}), { screenPauseMs: 0 });
        const fresh = (launches.get(id) ?? 0) + 1; launches.set(id, fresh);
        const stall = entry.stall ?? (entry.stallFirst && fresh === 1 ? 'idle' : null);
        panes.set(launched.pane!, { pane: launched.pane!, name: launched.agentName, status: stall ?? 'working', since: Date.now(), decision: id, fresh }); creating = null;
        return { agentName: launched.agentName, pane: launched.pane, runtime: launched.runtime, session: launched.session, ...(launched.replaced ? { replaced: launched.replaced } : {}) };
      },
    };

    const violations: string[] = [], failures: string[] = [];
    let cycles = 0;
    for (let now = start; now < start + 24 * hour; now += 2 * minute, cycles++) {
      mock.timers.setTime(now);
      // A working approver applies its decision once its work is done, then its session ends `done`.
      for (const session of panes.values()) {
        const entry = behaviours.find(candidate => candidate.decision === session.decision)!;
        if (session.status === 'working' && now - session.since >= entry.workMs) { session.status = 'done'; decisions.set(session.decision, 'applied'); }
      }
      const result = await runCycle(config, state, loop, () => Date.now());
      failures.push(...result.actions.filter(action => action.state === 'failed').map(action => `${new Date(now).toISOString()} ${action.detail}`));
      for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`${new Date(now).toISOString()} ${check.line}`);
    }

    assert.ok(cycles >= 700, 'the loop ran a whole simulated day');
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.deepEqual(closedWhileWorking, [], 'no approver at work is ever closed under it');
    const [stalled, working, recovered] = behaviours.map(entry => entry.decision) as [string, string, string];
    // The approver that never starts: the earlier launch plus at most two fresh ones, each closed, then escalated and left alone.
    assert.equal(launches.get(stalled), maxApproverLaunches - 1, 'the never-starting approver is relaunched only within the launch bound');
    assert.ok((closes.get(stalled) ?? 0) <= maxApproverLaunches, `its sessions are closed at most once each: ${closes.get(stalled)}`);
    assert.ok(state.approvals[`${handWatchPrefix}${stalled}`]?.exhaustedAt, 'past the bound its decision is escalated, not relaunched');
    assert.equal(decisions.get(stalled), 'requested');
    // The working approver: launched once over the stale tab, left to judge, and the decision applied.
    assert.equal(launches.get(working), 1, 'the approver at work is launched once and left open while it works');
    assert.equal(closes.get(working) ?? 0, 2, 'the stale tab it replaced is closed, and its own session only once it applied the decision');
    assert.equal(decisions.get(working), 'applied');
    // The one whose first fresh session sat idle: closed once, relaunched once, then applied.
    assert.equal(launches.get(recovered), 2);
    assert.equal(decisions.get(recovered), 'applied');
    assert.deepEqual(listed().filter(agent => agent.name !== approverSessionName(behaviours[0]!.work, stalled)).map(agent => agent.name), [], 'no approver of a settled decision is left open');
    const escalated = failures.filter(detail => detail.includes(stalled) && /so the loop has stopped spending sessions on it/.test(detail));
    assert.equal(escalated.length, 1, 'the never-starting approver\'s decision is escalated once, naming the command that answers it');
    assert.deepEqual(failures.filter(detail => !escalated.includes(detail) && /approver/i.test(detail)), [], 'no approver close or launch failed');
  } finally {
    mock.timers.reset();
    if (was === undefined) delete process.env.GRAPHYARD_DATA_HOME; else process.env.GRAPHYARD_DATA_HOME = was;
    for (const directory of [root, credentials, dataHome]) await rm(directory, { recursive: true, force: true });
  }
});
