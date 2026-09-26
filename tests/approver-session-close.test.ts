import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverSessionName, atomicPrivateWrite, loadMasterConfig, runAutonomyCommand, setupMaster, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { readApproverLaunches } from '../src/master/autonomy.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';

// GY-403: an approver session a master launched by hand with `master approver` had no approval
// watch, so nothing closed it once its decision settled: it held an approver slot for hours. One
// case per proof: unit:hand-approver-closed, unit:orphan-approver-closed.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const decisionId = (label: string) => `${label.padEnd(8, '0').slice(0, 8)}-4cb5-4f21-9b0e-0f2a6c8d4e15`;

/** An item the loop itself needs no decision for: ready, unleased, and nothing to merge. */
function item(key: string, stage: string): Work {
  return {
    id: `work-${key}`, key, title: 'Approver sessions close', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Closed', proofs: ['unit:hand-approver-closed'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage, revision: 4, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

function effects(work: Work[], agents: HerdrAgent[], decisions: Record<string, { id: string; action: string; state: string }[]>, closed: string[], extra: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => agents.filter(agent => !closed.includes(agent.pane_id!)),
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso() }),
    closeSession: pane => { closed.push(pane); },
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({ result: 'merged' }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    decisions: async entry => ({ decisions: (decisions[entry.key] ?? []).map(decision => ({ ...decision, input: {}, approvedBy: decision.state === 'applied' ? 'graphyard-approver-project' : null })) }),
    ...extra,
  };
}

test('unit:hand-approver-closed — an approver launched with master approver is registered in the loop\'s approval watch and closed, with why, on the cycle after its decision settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-hand-approver-'));
  const credentials = await mkdtemp(join(tmpdir(), 'graphyard-hand-approver-credentials-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    const approverToken = join(credentials, 'approver.token');
    await writeFile(approverToken, 'approver-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), approver: { id: 'graphyard-approver-project', credentialFile: approverToken } });
    const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };

    const work = item('GY-245', 'ready'), decision = decisionId('2d398574');
    // The CLI path: `graphyard master approver GY-245 DECISION claude`, against a stubbed Herdr.
    const herdr = (_command: string, args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'create') return JSON.stringify({ result: { root_pane: { pane_id: 'pane-7', tab_id: 'tab-7' } } });
      return startedAtOnce(args) ?? JSON.stringify({ result: {} });
    };
    const registered: unknown[] = [];
    const launched = await runAutonomyCommand(root, config, 'approver', [work.key, decision, 'claude'], {
      coordinator: async path => { assert.equal(path, 'work-snapshot'); return { work: [work], now: iso() }; },
      readSecret: async () => '', agents: () => [], daemonLock: async () => null, runtime: herdr,
      mutate: async (_path, body) => { registered.push(body); return {}; },
    }) as { agentName: string; pane: string };
    const name = approverSessionName(work, decision);
    assert.equal(launched.agentName, name);
    assert.equal(launched.pane, 'pane-7');
    const record = (await readApproverLaunches(root)).find(entry => entry.agentName === name);
    assert.equal(record?.work, 'GY-245', 'the launch records the item it judges');
    assert.equal(record?.decision, decision, 'and the decision');

    const agents: HerdrAgent[] = [{ name, pane_id: 'pane-7', agent: 'claude', agent_status: 'idle' }];
    const closed: string[] = [];
    const history: Record<string, { id: string; action: string; state: string }[]> = { 'GY-245': [{ id: decision, action: 'release', state: 'requested' }] };
    const loop = effects([work], agents, history, closed, { approverLaunches: () => readApproverLaunches(root) });
    const state = emptyDaemonState(config);

    // While the decision is still being judged, the loop registers the session and leaves it open.
    await runCycle(config, state, loop, () => clock);
    const watch = Object.values(state.approvals).find(entry => entry.agentName === name);
    assert.ok(watch, 'the hand-launched approver is in the same approval watch the loop keeps for its own requests');
    assert.equal(watch.decision, decision);
    assert.equal(watch.work, 'GY-245');
    assert.deepEqual(closed, [], 'a session still judging its decision is not closed');

    // The decision settles; one cycle closes the session and records why.
    history['GY-245'] = [{ id: decision, action: 'release', state: 'applied' }];
    const result = await runCycle(config, state, loop, () => clock + 20_000);
    assert.deepEqual(closed, ['pane-7'], 'the approver session is closed within one cycle of its decision settling');
    const close = result.actions.find(action => action.kind === 'close' && action.state === 'done');
    assert.ok(close, 'the close is recorded');
    assert.match(close.detail, new RegExp(`Closed approver session ${name} .*its decision is applied`));
    assert.equal(Object.values(state.approvals).some(entry => entry.agentName === name), false, 'the watch goes with the session');

    // Nothing is closed twice, and a closed session is not watched again.
    const again = await runCycle(config, state, loop, () => clock + 40_000);
    assert.deepEqual(closed, ['pane-7']);
    assert.equal(again.actions.some(action => action.kind === 'close'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(credentials, { recursive: true, force: true });
  }
});

test('unit:orphan-approver-closed — an approver session no watch and no launch record knows is closed within one cycle once its item is delivered or its decision settled', async () => {
  const config = { hostId: 'machine-a', autoMerge: true, mergeMethod: 'merge', workers: [], reviewers: [], producers: [], repository: 'owner/project', baseBranch: 'main',
    url: 'https://graphyard.example', credentialFile: '/dev/null', cliPath: launcher, githubAppId: 1234, run: { intervalSeconds: 20 } } as unknown as MasterConfig;
  const delivered = item('GY-200', 'done'), open = item('GY-201', 'ready'), judging = item('GY-202', 'ready');
  const deliveredDecision = decisionId('548864f5'), settledDecision = decisionId('77aa11bb'), pendingDecision = decisionId('33cc44dd');
  const agents: HerdrAgent[] = [
    { name: approverSessionName(delivered, deliveredDecision), pane_id: 'pane-1', agent: 'claude', agent_status: 'idle' },
    { name: approverSessionName(open, settledDecision), pane_id: 'pane-2', agent: 'claude', agent_status: 'idle' },
    { name: approverSessionName(judging, pendingDecision), pane_id: 'pane-3', agent: 'claude', agent_status: 'working' },
  ];
  const closed: string[] = [];
  const history = { 'GY-201': [{ id: settledDecision, action: 'rework', state: 'refused' }], 'GY-202': [{ id: pendingDecision, action: 'release', state: 'requested' }] };
  const state = emptyDaemonState(config);
  // No launch record at all: the sessions are known only by their names.
  const result = await runCycle(config, state, effects([delivered, open, judging], agents, history, closed, { approverLaunches: async () => [] }), () => clock);
  assert.deepEqual(closed.sort(), ['pane-1', 'pane-2'], 'the delivered item\'s and the settled decision\'s approvers are closed in one cycle; the one still judging is not');
  const closes = result.actions.filter(action => action.kind === 'close' && action.state === 'done').map(action => action.detail);
  assert.ok(closes.some(detail => detail.includes(agents[0].name!) && /GY-200 is delivered/.test(detail)), `the delivered item's close is recorded with why: ${closes.join(' | ')}`);
  assert.ok(closes.some(detail => detail.includes(agents[1].name!) && /its decision is refused/.test(detail)), `the settled decision's close is recorded with why: ${closes.join(' | ')}`);
  assert.equal(result.actions.some(action => action.kind === 'decision' && /Withdrew/.test(action.detail)), false, 'a decision the loop did not request is never withdrawn');
});
