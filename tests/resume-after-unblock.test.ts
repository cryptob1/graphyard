import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { idleLeaseMs } from '../src/daemon/cycle-sessions.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { SessionHandle, SessionHandleInput } from '../src/model/sessions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-524: a worker whose blocker or scope request is resolved is told to resume, a worker idle
 * with a live lease is re-prompted once and then handed on, and an implementation session whose
 * agent exited or whose item left build is closed rather than recorded running for hours.
 */
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minutes = (count: number) => count * 60_000;

async function setup() {
  const directory = await temporaryDirectory('resume');
  const credentialFile = join(directory, 'coordinator.token'), worker = join(directory, 'worker.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await writeFile(worker, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profile = { name: 'alpha', principal: 'alpha-principal', agentName: 'agent-alpha', mode: 'launch', kind: 'claude', credentialFile: worker, agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', herdrWorkspace: 'w1',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile] });
  return { directory, master };
}
function held(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-252', key: 'GY-252', title: 'Follow-ups', description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/a.ts'], stage: 'build', revision: 3, policyRevision: 1,
    createdAt: iso(-minutes(600)), updatedAt: iso(0), stageEnteredAt: iso(-minutes(300)), ready: true, epoch: 1,
    lease: { owner: 'alpha-principal', epoch: 1, expiresAt: iso(minutes(600)) },
    lastAssignment: { owner: 'alpha-principal', epoch: 1, claimedAt: iso(-minutes(300)) },
    workspaces: [{ host: 'machine-a', path: '/srv/worktrees/GY-252-1', epoch: 1, owner: 'alpha-principal', branch: 'graphyard/gy-252-1' }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    ...overrides,
  } as Work;
}
function harness(item: { current: Work[] }, agent: HerdrAgent, extra: Partial<DaemonEffects> = {}) {
  const log = { prompts: [] as string[], sessions: [] as SessionHandleInput[], closed: [] as string[], capacity: [] as Record<string, unknown>[], preserved: [] as number[] };
  const effects: DaemonEffects = {
    agents: () => [agent],
    credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: item.current, now: iso(0) }),
    closeSession: pane => { log.closed.push(pane); },
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({ result: 'merge requested' }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    promptSession: (_agent, text) => { log.prompts.push(text); },
    recordSession: async (_work, handle) => { log.sessions.push(handle); },
    // The control plane ends the attempt on this record, which frees the item for the next dispatch.
    reportCapacity: async (work, event) => { log.capacity.push(event); item.current = item.current.map(entry => entry.id === work.id ? { ...entry, lease: null, containmentQuarantine: null } as Work : entry); return item.current[0]; },
    preserveWork: async (_work, epoch) => { log.preserved.push(epoch); return { state: 'committed', commit: 'a'.repeat(40), branch: 'graphyard/gy-252-1', detail: 'kept as WIP' }; },
    ...extra,
  };
  return { log, effects };
}

test('unit:resume-prompt-after-unblock — one re-prompt after a blocker clears or a scope request is answered, none for an active worker, none twice', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held({ blocker: 'plannedFiles must include src/b.ts before I can submit' })] };
    const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p4J1', agent_status: 'idle', agent: 'claude' };
    const { log, effects } = harness(item, agent);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.equal(log.prompts.length, 0, 'a worker waiting on its blocker is not prompted');
    assert.equal(state.actions['resume:blocker:work-252:1']?.state, 'waiting', 'what it waits on is marked');

    // `master unblock` clears the blocker while the lease is live: the next cycle tells the worker.
    item.current = [held()];
    await runCycle(master, state, effects, () => clock + 30_000);
    assert.equal(log.prompts.length, 1, 'exactly one re-prompt within one cycle');
    assert.match(log.prompts[0], /On GY-252 \(epoch 1\) its blocker \("plannedFiles must include src\/b\.ts before I can submit"\) was cleared/, 'it names the item, the epoch and what changed');
    assert.ok(log.prompts[0].includes(`node ${launcher} complete GY-252 1 PR_NUMBER`), 'it names the exact next command');
    assert.match(log.prompts[0], /session's own instruction, not untrusted text/);
    const recorded = log.sessions.find(handle => /re-prompted to resume/.test(handle.outcome ?? ''));
    assert.ok(recorded, 'the re-prompt is written to the session handle, so the item history shows it');
    assert.equal(recorded.id, 'alpha-principal:1');
    assert.equal(recorded.state, 'running');
    assert.equal(recorded.pane, 'w1:p4J1');
    assert.equal(Object.values(state.actions).filter(action => /re-prompted once to resume/.test(action.detail)).length, 1, 'the loop records the re-prompt');

    // The same resolution never prompts twice.
    await runCycle(master, state, effects, () => clock + 60_000);
    await runCycle(master, state, effects, () => clock + 90_000);
    assert.equal(log.prompts.length, 1, 'no second re-prompt for the same resolution');

    // A scope request answered by widening: the next re-prompt names the paths now planned.
    item.current = [held({ candidate: { sha: 'b'.repeat(40), baseSha: 'c'.repeat(40), pr: 255 } as Work['candidate'], scopeRequest: { epoch: 1, paths: ['src/b.ts'], reason: 'needed', requestedBy: 'alpha-principal', at: iso(100_000) } })];
    await runCycle(master, state, effects, () => clock + 120_000);
    assert.equal(log.prompts.length, 1);
    item.current = [held({ candidate: { sha: 'b'.repeat(40), baseSha: 'c'.repeat(40), pr: 255 } as Work['candidate'], plannedFiles: ['src/a.ts', 'src/b.ts'],
      scopeDecision: { state: 'approved', reason: 'criteria name it', at: iso(130_000), decidedBy: 'graphyard', waitedMs: 30_000, paths: ['src/b.ts'], requestedBy: 'alpha-principal', requestedAt: iso(100_000) } as Work['scopeDecision'] })];
    await runCycle(master, state, effects, () => clock + 150_000);
    assert.equal(log.prompts.length, 2, 'the answered scope request is a new resolution, re-prompted once');
    assert.match(log.prompts[1], /its scope request was applied: plannedFiles now include src\/b\.ts/);
    assert.ok(log.prompts[1].includes(`complete GY-252 1 255`), 'the pull request Graphyard has seen is named in the command');

    // A worker already active is not re-prompted: the resolution is consumed without a paste.
    item.current = [held({ blocker: 'waiting on a decision' })];
    await runCycle(master, state, effects, () => clock + 180_000);
    agent.agent_status = 'working';
    item.current = [held()];
    await runCycle(master, state, effects, () => clock + 210_000);
    agent.agent_status = 'idle';
    await runCycle(master, state, effects, () => clock + 240_000);
    assert.equal(log.prompts.length, 2, 'an active worker is not re-prompted, then or later');
    assert.ok(Object.values(state.actions).some(action => /is already active, so it is not re-prompted/.test(action.detail)), 'the skipped re-prompt is recorded with why');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:idle-lease-reclaimed — a worker idle with a live lease is re-prompted once, then handed to a new attempt that keeps its branch', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held({ containmentQuarantine: null })] };
    const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p4J1', agent_status: 'idle', agent: 'claude' };
    const { log, effects } = harness(item, agent);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    await runCycle(master, state, effects, () => clock + minutes(29));
    assert.equal(log.prompts.length, 0, 'thirty minutes of quiet have not passed');

    await runCycle(master, state, effects, () => clock + minutes(31));
    assert.equal(log.prompts.length, 1, 'past thirty minutes it is re-prompted once');
    assert.match(log.prompts[0], /no activity from it since .* while it holds GY-252 \(epoch 1\) with no open blocker or scope request/);
    assert.ok(log.prompts[0].includes(`node ${launcher} complete GY-252 1 PR_NUMBER`));
    const idle = log.sessions.find(handle => /^idle-with-lease: agent-alpha in pane w1:p4J1/.test(handle.outcome ?? ''));
    assert.ok(idle, 'master status reads the handle as idle-with-lease, naming the pane');
    assert.equal(idle.state, 'running');

    await runCycle(master, state, effects, () => clock + minutes(50));
    assert.equal(log.prompts.length, 1, 'one re-prompt only');
    assert.equal(log.capacity.length, 0, 'nothing is handed on before a further thirty minutes');

    await runCycle(master, state, effects, () => clock + minutes(62));
    assert.equal(log.prompts.length, 1);
    assert.deepEqual(log.preserved, [1], 'the attempt keeps what it left, on its branch');
    assert.equal(log.capacity.length, 1, 'the attempt ends on the record, which frees the item for a new attempt');
    assert.equal(log.capacity[0].cause, 'interrupted');
    assert.match(String(log.capacity[0].reason), /idle with a live lease: no activity in pane w1:p4J1/);
    assert.deepEqual(log.closed, ['w1:p4J1'], 'its pane is closed');
    const closed = log.sessions.at(-1)!;
    assert.equal(closed.state, 'finished');
    assert.match(closed.outcome ?? '', /closed as failed: idle with a live lease/);
    const reclaim = state.actions['resume:reclaim:work-252:1'];
    assert.equal(reclaim?.state, 'done');
    assert.match(reclaim.detail, /keeping the attempt's branch/);

    // A worker that shows activity after its re-prompt starts a fresh idle clock instead.
    const second = { current: [held({ id: 'work-253', key: 'GY-253' })] };
    const active: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p5', agent_status: 'idle', agent: 'claude' };
    const run = harness(second, active), fresh = emptyDaemonState(master);
    await runCycle(master, fresh, run.effects, () => clock);
    await runCycle(master, fresh, run.effects, () => clock + minutes(31));
    active.agent_status = 'working';
    await runCycle(master, fresh, run.effects, () => clock + minutes(40));
    active.agent_status = 'idle';
    await runCycle(master, fresh, run.effects, () => clock + minutes(41));
    await runCycle(master, fresh, run.effects, () => clock + minutes(65));
    assert.equal(run.log.prompts.length, 1);
    assert.equal(run.log.capacity.length, 0, 'activity after the re-prompt means it is not handed on');
    assert.ok(idleLeaseMs === minutes(30));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:exited-worker-session-closed — an implementation session whose agent exited, or whose item left build, is closed within one cycle', async () => {
  const { directory, master } = await setup();
  try {
    const handle = (id: string, pane: string, principal: string, host = 'machine-a'): SessionHandle => ({ id, kind: 'implementation', principal, epoch: null, runtime: 'claude', host,
      workspace: 'w1', tab: null, pane, agentName: 'agent-alpha', role: null, head: null, attach: `herdr pane attach ${pane} --workspace w1`, transcript: null,
      subject: 'work', startedAt: iso(-minutes(230)), updatedAt: iso(-minutes(1)), endedAt: null, state: 'running', outcome: null, observed: 'idle', observedAt: iso(-minutes(1)) });
    const moved = held({ id: 'work-356', key: 'GY-356', stage: 'test', lease: null, submission: { epoch: 1, pr: 202 }, sessions: [handle('codex-2:1', 'w1:p4FW', 'codex-2')] });
    const exited = held({ id: 'work-257', key: 'GY-257', lease: { owner: 'codex-3', epoch: 2, expiresAt: iso(minutes(600)) }, sessions: [handle('codex-3:2', 'w1:p4GS', 'codex-3')] });
    const running = held({ id: 'work-252', key: 'GY-252', sessions: [handle('alpha-principal:1', 'w1:p4J1', 'alpha-principal')] });
    const elsewhere = held({ id: 'work-400', key: 'GY-400', lease: null, stage: 'review', submission: { epoch: 1, pr: 300 }, sessions: [handle('delta:1', 'w9:p1', 'delta', 'machine-b')] });
    const item = { current: [moved, exited, running, elsewhere] };
    // The profile's agent name is reused by its next session in another pane; only that pane is live.
    const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p4J1', agent_status: 'working', agent: 'claude' };
    const { log, effects } = harness(item, agent, { herdr: () => ({ agents: [agent], available: true }) });
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);

    const closed = log.sessions.filter(entry => entry.state === 'finished');
    assert.deepEqual(closed.map(entry => entry.id).sort(), ['codex-2:1', 'codex-3:2'], 'both over sessions are closed in one cycle, the live one and the other host\'s are not');
    assert.match(closed.find(entry => entry.id === 'codex-2:1')!.outcome!, /GY-356 has left build, the stage this implementation session was launched for, and is now in test/);
    assert.match(closed.find(entry => entry.id === 'codex-3:2')!.outcome!, /the claude runtime is no longer the foreground process of pane w1:p4GS/);
    for (const entry of closed) assert.equal(entry.kind, 'implementation');
    assert.equal(Object.values(state.actions).filter(action => action.kind === 'close' && /^Closed implementation session/.test(action.detail)).length, 2, 'each closure is recorded with its reason');

    // A pane Herdr lists with no agent in it is the same exit.
    const shell = held({ id: 'work-258', key: 'GY-258', lease: { owner: 'codex-4', epoch: 1, expiresAt: iso(minutes(600)) }, sessions: [handle('codex-4:1', 'w1:p4ZZ', 'codex-4')] });
    item.current = [shell];
    const bare = harness(item, agent, { herdr: () => ({ agents: [agent, { pane_id: 'w1:p4ZZ', agent: null, agent_status: 'unknown' }], available: true }) });
    await runCycle(master, state, bare.effects, () => clock + 30_000);
    assert.equal(bare.log.sessions.filter(entry => entry.state === 'finished' && entry.id === 'codex-4:1').length, 1);

    // Closed once: the next cycle writes nothing more for them.
    item.current = [moved, exited, running];
    const again = harness(item, agent, { herdr: () => ({ agents: [agent], available: true }) });
    await runCycle(master, state, again.effects, () => clock + 60_000);
    assert.equal(again.log.sessions.filter(entry => entry.state === 'finished').length, 0);

    // An unreadable Herdr closes nothing on the runtime's word.
    const unread = harness({ current: [exited] }, agent, { herdr: () => ({ agents: [], available: false }) });
    await runCycle(master, emptyDaemonState(master), unread.effects, () => clock);
    assert.equal(unread.log.sessions.filter(entry => entry.state === 'finished').length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
