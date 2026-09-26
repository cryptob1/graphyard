import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverSessionName, atomicPrivateWrite, loadMasterConfig, runAutonomyCommand, setupMaster, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { readApproverLaunches, saveApproverLaunch } from '../src/master/autonomy.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';

// GY-551: an approver launched for a master-requested decision was only watched — when its session
// died without judging, the watch closed and the decision stayed unanswered. The loop now relaunches
// it exactly as its own: on the next eligible approver account, up to the same 3-launch bound, a
// relaunch the registry refused retried next cycle, and past the bound master status names the
// decision unanswered with each session's end reason. One case per proof: unit:hand-approver-relaunched.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const decisionId = (label: string) => `${label.padEnd(8, '0').slice(0, 8)}-4cb5-4f21-9b0e-0f2a6c8d4e15`;

/** An item the loop itself needs no decision for: ready, unleased, and nothing to merge. */
function item(key: string, stage: string): Work {
  return {
    id: `work-${key}`, key, title: 'Hand approver relaunched', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Relaunched', proofs: ['unit:hand-approver-relaunched'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage, revision: 4, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

function effects(work: Work[], agents: () => HerdrAgent[], decisions: Record<string, { id: string; action: string; state: string; requestedAt: string }[]>,
  closed: string[], launches: { calls: number }, sessionName: string, tick: { at: number }, extra: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: agents,
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: new Date(tick.at).toISOString() }),
    closeSession: pane => { closed.push(pane); },
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({ result: 'merged', merged: true }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    decisions: async entry => ({ decisions: (decisions[entry.key] ?? []).map(decision => ({ ...decision, input: {}, approvedBy: decision.state === 'applied' ? 'graphyard-approver-project' : null })) }),
    // The loop's own launch, as production builds it: the next eligible approver account is the
    // launcher's choice, and each relaunch spends the next one.
    approver: async () => {
      launches.calls += 1;
      if (launches.calls === 1) throw new Error('the agent registry for the approver role is unreachable: timeout');
      return { agentName: sessionName, pane: `pane-relaunch-${launches.calls}`, account: `approver-account-${launches.calls}`, runtime: 'claude', session: null };
    },
    ...extra,
  };
}

test('unit:hand-approver-relaunched — a hand-launched approver that vanished is relaunched by the loop within the same launch bound, a registry timeout is retried next cycle, and past the bound the decision is named unanswered with each end reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-hand-approver-relaunch-'));
  const credentials = await mkdtemp(join(tmpdir(), 'graphyard-hand-approver-relaunch-credentials-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    const approverToken = join(credentials, 'approver.token');
    await writeFile(approverToken, 'approver-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), approver: { id: 'graphyard-approver-project', credentialFile: approverToken } });
    const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };

    const work = item('GY-551', 'ready'), decision = decisionId('9e41c2ab');
    // The CLI path: `graphyard master approver GY-551 DECISION claude`, against a stubbed Herdr.
    const herdr = (_command: string, args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'create') return JSON.stringify({ result: { root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' } } });
      return startedAtOnce(args) ?? JSON.stringify({ result: {} });
    };
    const launched = await runAutonomyCommand(root, config, 'approver', [work.key, decision, 'claude'], {
      coordinator: async path => { assert.equal(path, 'work-snapshot'); return { work: [work], now: iso() }; },
      readSecret: async () => '', agents: () => [], daemonLock: async () => null, runtime: herdr,
      mutate: async () => ({}),
    }) as { agentName: string; pane: string };
    const name = approverSessionName(work, decision);
    assert.equal(launched.agentName, name);
    assert.equal(launched.pane, 'pane-1');
    // The record's real launch time is repinned to the test clock, so the settle bounds judge ages
    // the cycles below stage rather than the gap to 2030.
    const record = (await readApproverLaunches(root)).findLast(entry => entry.agentName === name);
    assert.equal(record?.decision, decision, 'the launch records the decision it judges');
    await saveApproverLaunch(root, { ...record!, launchedAt: iso() });

    const agents: HerdrAgent[] = [];
    const closed: string[] = [], launches = { calls: 0 }, tick = { at: clock };
    const history: Record<string, { id: string; action: string; state: string; requestedAt: string }[]> = { 'GY-551': [{ id: decision, action: 'release', state: 'requested', requestedAt: iso(0) }] };
    const state = emptyDaemonState(config);
    const loop = effects([work], () => agents, history, closed, launches, name, tick, { approverLaunches: () => readApproverLaunches(root) });
    const cycle = (at: number) => { tick.at = at; return runCycle(config, state, loop, () => tick.at); };
    const notes = (result: { actions: { kind: string; state: string; detail: string }[] }, fragment: RegExp) =>
      result.actions.filter(action => action.kind === 'decision' && fragment.test(action.detail));

    // Cycle 1: the session is live and fresh. The loop registers it and waits.
    agents.push({ name, pane_id: 'pane-1', agent_status: 'working' });
    await cycle(clock);
    let watch = Object.values(state.approvals).find(entry => entry.decision === decision);
    assert.ok(watch, 'the hand-launched approver is in the approval watch');
    assert.equal(watch.launches, 1, 'the hand launch is the first of the bound');
    assert.equal(launches.calls, 0, 'a live session is not replaced');

    // Cycle 2: the session vanished without judging. The relaunch is refused by the registry
    // (timeout) — recorded, not final: the watch stays and the next cycle makes the launch again.
    agents.length = 0;
    const second = await cycle(clock + 30_000);
    watch = Object.values(state.approvals).find(entry => entry.decision === decision)!;
    assert.equal(launches.calls, 1, 'the replacement launch was attempted');
    assert.equal(watch.launches, 2, 'the refused relaunch is counted, like any launch of the loop\'s own');
    assert.ok(notes(second, /could not be launched: .*timeout/).every(entry => entry.state === 'failed'), 'the registry timeout is recorded');
    assert.ok(!watch.exhaustedAt, 'a refused relaunch does not end the decision');
    assert.deepEqual(watch.ended, [`release decision ${decision} on GY-551: approver session ${name} is gone without judging it`]);

    // Cycle 3: the same step retried — the replacement is launched on the next eligible account.
    const third = await cycle(clock + 60_000);
    watch = Object.values(state.approvals).find(entry => entry.decision === decision)!;
    assert.equal(watch.launches, 3, 'the retry is the third and last launch of the bound');
    assert.equal(watch.account, 'approver-account-2', 'the replacement runs on the next eligible approver account');
    assert.equal(watch.pane, 'pane-relaunch-2');
    assert.ok(notes(third, /launched independent approver session .* on approver-account-2 \(launch 3 of 3\)/).length === 1);

    // Cycle 4: that session ends `done` without approving. The bound is spent, so no third
    // replacement: the session is closed and the decision escalated as unanswered, with reasons.
    agents.push({ name, pane_id: 'pane-relaunch-2', agent_status: 'done' });
    const fourth = await cycle(clock + 180_000);
    watch = Object.values(state.approvals).find(entry => entry.decision === decision)!;
    assert.equal(launches.calls, 2, 'no session is launched past the bound');
    assert.deepEqual(closed, ['pane-relaunch-2'], 'the ended session is closed');
    assert.ok(watch.exhaustedAt, 'the decision is marked spent');
    assert.equal(history['GY-551'][0].state, 'requested', 'the decision itself is untouched');
    assert.deepEqual(watch.ended, [`release decision ${decision} on GY-551: approver session ${name} is gone without judging it`, `release decision ${decision} on GY-551: approver session ${name} ended done without approving it — declined, or its prompt was dropped`],
      'each session\'s end reason is kept');
    const escalation = fourth.actions.find(action => action.kind === 'escalation' && action.detail.includes('have not produced a judgement'));
    assert.ok(escalation, 'the unanswered decision is escalated');
    assert.match(escalation.detail, /3 approver session\(s\)/);
    assert.match(escalation.detail, new RegExp(`${name} is gone without judging it; release decision ${decision} on GY-551: approver session ${name} ended done without approving it`));
    assert.match(escalation.detail, new RegExp(`graphyard master approver ${work.key} ${decision}`));

    // Cycle 5: nothing further is launched or closed for the spent decision.
    agents.length = 0;
    await cycle(clock + 210_000);
    assert.deepEqual(closed, ['pane-relaunch-2']);
    assert.equal(launches.calls, 2);
    // Master status surfaces the unanswered decision from the watch the loop keeps: the daemon
    // summary carries the watch with each session's end reason, and the escalation above names
    // the decision with them and the command that answers it.
    assert.equal(watch.settledAt, null);
    assert.equal(watch.ended.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(credentials, { recursive: true, force: true });
  }
});
