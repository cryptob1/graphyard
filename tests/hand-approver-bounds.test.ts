import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverSessionName, atomicPrivateWrite, loadMasterConfig, setupMaster, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { Launcher } from '../src/daemon/cycle.js';
import type { Work } from '../src/model.js';

// GY-589, the follow-ups of GY-551's review. A hand-launched approver's watch is not judged while
// its relaunch is still with the launcher, a launch refused for a reason other than capacity is
// escalated after three in a row instead of retried forever, and the step reads an item's
// decisions once however many retained launch records name it.

const launcherPath = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const decisionId = (label: string) => `${label.padEnd(8, '0').slice(0, 8)}-4cb5-4f21-9b0e-0f2a6c8d4e15`;

function item(key: string): Work {
  return {
    id: `work-${key}`, key, title: 'Hand approver bounds', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Bounded', proofs: ['manual:review-followups-triaged'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'ready', revision: 4, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

async function withConfig(body: (config: MasterConfig) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-hand-approver-bounds-'));
  const credentials = await mkdtemp(join(tmpdir(), 'graphyard-hand-approver-bounds-credentials-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcherPath, credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    const approverToken = join(credentials, 'approver.token');
    await writeFile(approverToken, 'approver-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), approver: { id: 'graphyard-approver-project', credentialFile: approverToken } });
    await body({ ...await loadMasterConfig(root), workers: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(credentials, { recursive: true, force: true });
  }
}

function effects(work: Work[], agents: HerdrAgent[], history: Record<string, { id: string; action: string; state: string; requestedAt: string }[]>, tick: { at: number }, reads: { count: number }, extra: Partial<DaemonEffects>): DaemonEffects {
  return {
    agents: () => agents,
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: new Date(tick.at).toISOString() }),
    closeSession: () => {},
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({ result: 'merged', merged: true }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    decisions: async entry => { reads.count += 1; return { decisions: (history[entry.key] ?? []).map(decision => ({ ...decision, input: {}, approvedBy: null })) }; },
    ...extra,
  };
}

test('a hand-launched approver whose launch is refused for a reason other than capacity is escalated after three refusals in a row', async () => withConfig(async config => {
  const work = item('GY-589'), decision = decisionId('5a8c1e2f'), name = approverSessionName(work, decision);
  const agents: HerdrAgent[] = [{ name, pane_id: 'pane-1', agent_status: 'working' }];
  const history = { 'GY-589': [{ id: decision, action: 'release', state: 'requested', requestedAt: iso() }] };
  const tick = { at: clock }, reads = { count: 0 }, launches = { calls: 0 };
  const loop = effects([work], agents, history, tick, reads, {
    approver: async () => { launches.calls += 1; throw new Error('approver credential file is missing'); },
  });
  const state = emptyDaemonState(config);
  const cycle = (at: number) => { tick.at = at; return runCycle(config, state, loop, () => tick.at); };

  await cycle(clock);
  assert.ok(Object.values(state.approvals).some(watch => watch.decision === decision), 'the hand-launched approver is watched');
  agents.length = 0;
  for (let round = 1; round <= 3; round += 1) {
    await cycle(clock + round * 30_000);
    const watch = Object.values(state.approvals).find(entry => entry.decision === decision)!;
    assert.equal(launches.calls, round);
    assert.equal(watch.launches, 1, 'a refused launch ran no session, so it never spends the bound');
    assert.equal(watch.refusals, round, 'each refusal in a row is counted');
    assert.equal(watch.exhaustedAt, null, 'the decision is retried until the refusal bound');
  }
  const fourth = await cycle(clock + 120_000);
  const watch = Object.values(state.approvals).find(entry => entry.decision === decision)!;
  assert.equal(launches.calls, 3, 'no launch is made past the refusal bound');
  assert.ok(watch.exhaustedAt, 'the decision is marked spent');
  const escalation = fourth.actions.find(action => action.kind === 'escalation');
  assert.ok(escalation, 'the permanently refused decision is escalated');
  assert.match(escalation.detail, /refused 3 times in a row \(last: approver credential file is missing\)/);
  assert.match(escalation.detail, /1 approver session\(s\)/, 'only the session that ran is counted');
  await cycle(clock + 150_000);
  assert.equal(launches.calls, 3, 'an escalated decision is left for the master');
  assert.equal(fourth.actions.filter(action => action.kind === 'escalation').length, 1);
}));

test('a hand watch is not judged while its relaunch is still with the launcher, so it is neither recorded as ended nor counted again', async () => withConfig(async config => {
  const work = item('GY-589'), decision = decisionId('6b9d2f3a'), name = approverSessionName(work, decision);
  const agents: HerdrAgent[] = [{ name, pane_id: 'pane-1', agent_status: 'working' }];
  const history = { 'GY-589': [{ id: decision, action: 'release', state: 'requested', requestedAt: iso() }] };
  const tick = { at: clock }, reads = { count: 0 }, launches = { calls: 0 };
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const loop = effects([work], agents, history, tick, reads, {
    approver: async (entry, id) => { launches.calls += 1; await held; return { agentName: approverSessionName(entry, id), pane: 'pane-2', account: 'approver-account-2', runtime: 'claude', session: null }; },
  });
  const state = emptyDaemonState(config), launcher = new Launcher();
  const cycle = (at: number) => { tick.at = at; return runCycle(config, state, loop, () => tick.at, launcher); };

  await cycle(clock);
  agents.length = 0;
  await cycle(clock + 30_000);
  let watch = Object.values(state.approvals).find(entry => entry.decision === decision)!;
  assert.equal(watch.launches, 2, 'the relaunch is handed to the launcher');
  assert.ok(launcher.busy(`launch:approver:${decision}`));
  const ended = [...watch.ended];
  // The launch is still in flight: Herdr lists no session yet.
  await cycle(clock + 60_000);
  await cycle(clock + 90_000);
  watch = Object.values(state.approvals).find(entry => entry.decision === decision)!;
  assert.equal(watch.launches, 2, 'an in-flight launch is not counted again');
  assert.deepEqual(watch.ended, ended, 'no phantom end reason is recorded');
  assert.equal(watch.exhaustedAt, null);
  release();
  await launcher.idle();
  assert.equal(launches.calls, 1);
  watch = Object.values(state.approvals).find(entry => entry.decision === decision)!;
  assert.equal(watch.pane, 'pane-2');
}));

test('the hand-approver step reads an item\'s decisions once, however many retained launch records name it', async () => withConfig(async config => {
  const work = item('GY-589');
  const settled = Array.from({ length: 6 }, (_, index) => decisionId(`${index}c0e4a1b`));
  const history = { 'GY-589': settled.map(id => ({ id, action: 'release', state: 'applied', requestedAt: iso(-600_000) })) };
  const records = settled.map(id => ({ agentName: approverSessionName(work, id), work: work.key, decision: id, launchedAt: iso(-600_000), account: null, runtime: 'claude', session: null, pane: null }));
  const tick = { at: clock }, reads = { count: 0 };
  const loop = effects([work], [], history, tick, reads, {
    approver: async () => { throw new Error('no launch expected'); },
    approverLaunches: async () => records as never,
  });
  const state = emptyDaemonState(config);
  await runCycle(config, state, loop, () => clock);
  assert.equal(Object.keys(state.approvals).length, 0, 'settled decisions are not watched');
  assert.equal(reads.count, 1, 'six settled launch records cost one decision read');
}));
