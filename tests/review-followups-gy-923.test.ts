import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { idleLeaseMs } from '../src/daemon/cycle-sessions.js';
import { launchAppearanceMs } from '../src/daemon/effects.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { DaemonAction } from '../src/daemon/state.js';
import type { Work } from '../src/model.js';
import type { SessionHandle, SessionHandleInput } from '../src/model/sessions.js';

/**
 * GY-923, the follow-ups from the approved review of GY-544 (PR #381): the exit a close witnessed
 * is retained so its registry update can be retried after the pane it closed is gone, and the
 * resume-prompt deduplication survives the prunable action ledger, so a busy installation cannot
 * make one scope decision paste the same instruction twice.
 */
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minutes = (count: number) => count * 60_000;

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-gy923-'));
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
    id: 'work-923', key: 'GY-923', title: 'Follow-ups', description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/a.ts'], stage: 'build', revision: 3, policyRevision: 1,
    createdAt: iso(-minutes(600)), updatedAt: iso(0), stageEnteredAt: iso(-minutes(300)), ready: true, epoch: 1,
    lease: { owner: 'alpha-principal', epoch: 1, expiresAt: iso(minutes(600)) },
    lastAssignment: { owner: 'alpha-principal', epoch: 1, claimedAt: iso(-minutes(300)) },
    workspaces: [{ host: 'machine-a', path: '/srv/worktrees/GY-923-1', epoch: 1, owner: 'alpha-principal', branch: 'graphyard/gy-923-1' }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    ...overrides,
  } as Work;
}
/** A running implementation handle of a principal no configured profile holds, so only step 1g acts on it. */
function staleHandle(id: string, pane: string, principal: string): SessionHandle {
  return { id, kind: 'implementation', principal, epoch: null, runtime: 'claude', host: 'machine-a',
    workspace: 'w1', tab: null, pane, agentName: `${principal}-agent`, role: null, head: null, attach: `herdr pane attach ${pane} --workspace w1`, transcript: null,
    subject: 'work', startedAt: iso(-minutes(230)), updatedAt: iso(-minutes(1)), endedAt: null, state: 'running', outcome: null, observed: 'idle', observedAt: iso(-minutes(1)) };
}
function harness(item: { current: Work[] }, live: HerdrAgent, extra: Partial<DaemonEffects> = {}) {
  const log = { sessions: [] as SessionHandleInput[], closed: [] as string[], prompts: [] as string[] };
  const effects: DaemonEffects = {
    agents: () => [live],
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
    ...extra,
  };
  return { log, effects };
}
const resolvedAction = (detail: string, at: string): DaemonAction => ({ kind: 'dispatch', work: null, principal: null, state: 'done', detail, attempts: 1, epoch: null, cycle: 0, at });
const row = (actions: Record<string, DaemonAction>, key: string) => actions[key];

test('unit:exit-evidence-retained — a close whose pane closed but whose registry update failed retries only the registry update', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held({ lease: { owner: 'zeta-9', epoch: 2, expiresAt: iso(minutes(600)) }, lastAssignment: { owner: 'zeta-9', epoch: 2, claimedAt: iso(-minutes(230)) }, sessions: [staleHandle('zeta-9:2', 'w1:p923', 'zeta-9')] })] };
    const live: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:plive', agent_status: 'working', agent: 'claude' };
    const exited: HerdrAgent = { pane_id: 'w1:p923', agent: null, agent_status: 'unknown' };
    const listing: HerdrAgent[] = [exited];
    const { log, effects } = harness(item, live, { herdr: () => ({ agents: listing, available: true }) });
    const state = emptyDaemonState(master);
    const handle = item.current[0].sessions![0], closeKey = `close:implementation:work-923:zeta-9:2:${handle.startedAt}`, evidenceKey = `close-evidence:implementation:work-923:zeta-9:2:${handle.startedAt}`;

    await runCycle(master, state, effects, () => clock);
    assert.equal(row(state.actions, closeKey), undefined, 'a first sighting closes nothing');
    assert.equal(row(state.actions, evidenceKey), undefined, 'no close attempted, no evidence retained yet');

    // The close succeeds at closing the pane and fails on the registry update.
    listing.push(live);
    let failRegistry = true, closes = 0;
    const flaky = harness(item, live, { herdr: () => ({ agents: listing, available: true }),
      closeSession: pane => { closes++; if (closes > 1) throw new Error('herdr: pane_not_found'); log.closed.push(pane); },
      recordSession: async (work, input) => { if (failRegistry) throw new Error('registry unavailable'); log.sessions.push(input); } });
    await runCycle(master, state, flaky.effects, () => clock + launchAppearanceMs);
    assert.deepEqual(log.closed, ['w1:p923'], 'the pane was closed');
    assert.equal(flaky.log.sessions.length, 0, 'the registry update failed');
    assert.equal(row(state.actions, closeKey)?.state, 'failed');
    assert.match(row(state.actions, closeKey)!.detail, /registry unavailable; its pane is closed and only the registry update is retried/);
    assert.equal(row(state.actions, evidenceKey)?.state, 'waiting', 'the closed pane and its witnessed exit are retained outside the prunable ledger');
    assert.match(row(state.actions, evidenceKey)!.detail, /the claude runtime is no longer the foreground process of pane w1:p923/);

    // The pane gone, a sole pane empties its workspace's listing and Herdr may not answer at all:
    // the sight cannot be taken again, and the retained record completes the registry update
    // without closing the pane a second time — even were its id reused by a live agent.
    listing.length = 0;
    listing.push({ name: 'agent-reused', pane_id: 'w1:p923', agent_status: 'working', agent: 'claude' });
    failRegistry = false;
    const unanswered = harness(item, live, { herdr: () => ({ agents: [], available: false }),
      closeSession: pane => { closes++; log.closed.push(pane); },
      recordSession: async (_work, input) => { log.sessions.push(input); } });
    await runCycle(master, state, unanswered.effects, () => clock + 2 * launchAppearanceMs);
    assert.equal(closes, 1, 'the retry never closes the pane again');
    assert.deepEqual(log.closed, ['w1:p923']);
    assert.equal(log.sessions.length, 1);
    assert.equal(log.sessions[0].state, 'finished');
    assert.match(log.sessions[0].outcome!, /closed by the loop: the claude runtime is no longer the foreground process of pane w1:p923/);
    assert.match(log.sessions[0].outcome!, /pane w1:p923 closed on an earlier attempt, so only the registry update is retried/);
    assert.equal(row(state.actions, closeKey)?.state, 'done');

    // With the handle finished on the record, the retained evidence is swept.
    item.current = [held({ lease: { owner: 'zeta-9', epoch: 2, expiresAt: iso(minutes(600)) }, lastAssignment: { owner: 'zeta-9', epoch: 2, claimedAt: iso(-minutes(230)) }, sessions: [{ ...handle, state: 'finished', outcome: 'closed by the loop' }] })];
    await runCycle(master, state, unanswered.effects, () => clock + 3 * launchAppearanceMs);
    assert.equal(row(state.actions, evidenceKey), undefined, 'evidence whose handle is no longer running is swept');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:exit-evidence-write-never-gates-the-registry — a closed pane whose evidence cannot be persisted still has its registry update attempted', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held({ lease: { owner: 'zeta-9', epoch: 2, expiresAt: iso(minutes(600)) }, lastAssignment: { owner: 'zeta-9', epoch: 2, claimedAt: iso(-minutes(230)) }, sessions: [staleHandle('zeta-9:2', 'w1:p923', 'zeta-9')] })] };
    const live: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:plive', agent_status: 'working', agent: 'claude' };
    const listing: HerdrAgent[] = [{ pane_id: 'w1:p923', agent: null, agent_status: 'unknown' }, live];
    const { effects } = harness(item, live, { herdr: () => ({ agents: listing, available: true }) });
    const state = emptyDaemonState(master);
    const handle = item.current[0].sessions![0], closeKey = `close:implementation:work-923:zeta-9:2:${handle.startedAt}`, evidenceKey = `close-evidence:implementation:work-923:zeta-9:2:${handle.startedAt}`;
    await runCycle(master, state, effects, () => clock);

    // The state volume refuses exactly the write that would persist the closed-pane evidence.
    let refused = 0;
    const full = harness(item, live, { herdr: () => ({ agents: listing, available: true }),
      persist: async written => { if (written.actions[evidenceKey] && !written.actions[closeKey]?.state.match(/done|failed/) && refused === 0) { refused++; throw new Error('ENOSPC: no space left on device'); } } });
    await runCycle(master, state, full.effects, () => clock + launchAppearanceMs);
    assert.equal(refused, 1, 'the evidence write was refused');
    assert.deepEqual(full.log.closed, ['w1:p923'], 'the pane was closed');
    assert.equal(full.log.sessions.length, 1, 'the registry update was still attempted');
    assert.equal(full.log.sessions[0].state, 'finished');
    assert.equal(row(state.actions, closeKey)?.state, 'done');
    assert.match(row(state.actions, closeKey)!.detail, /its closed-pane evidence is not yet persisted \(ENOSPC: no space left on device/);
    assert.equal(row(state.actions, evidenceKey), undefined, 'the finished close sweeps its evidence in the same cycle');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:exit-evidence-never-replays-a-close — a close that failed with its pane standing keeps no evidence and is retried only on a fresh, confirmed sight', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held({ lease: { owner: 'zeta-9', epoch: 2, expiresAt: iso(minutes(600)) }, lastAssignment: { owner: 'zeta-9', epoch: 2, claimedAt: iso(-minutes(230)) }, sessions: [staleHandle('zeta-9:2', 'w1:p923', 'zeta-9')] })] };
    const live: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:plive', agent_status: 'working', agent: 'claude' };
    const exited: HerdrAgent = { pane_id: 'w1:p923', agent: null, agent_status: 'unknown' };
    const listing: HerdrAgent[] = [exited, live];
    const { effects } = harness(item, live, { herdr: () => ({ agents: listing, available: true }) });
    const state = emptyDaemonState(master);
    const handle = item.current[0].sessions![0], closeKey = `close:implementation:work-923:zeta-9:2:${handle.startedAt}`, evidenceKey = `close-evidence:implementation:work-923:zeta-9:2:${handle.startedAt}`;
    await runCycle(master, state, effects, () => clock);

    // The close itself fails, so the pane stands: nothing is retained that could replay it.
    const flaky = harness(item, live, { herdr: () => ({ agents: listing, available: true }),
      closeSession: pane => { throw new Error(`herdr refused the close of ${pane}`); } });
    await runCycle(master, state, flaky.effects, () => clock + launchAppearanceMs);
    assert.equal(row(state.actions, closeKey)?.state, 'failed');
    assert.equal(row(state.actions, evidenceKey), undefined, 'a pane still standing leaves no evidence to replay');

    // No later cycle that cannot confirm the exit closes the pane: Herdr unavailable, a listing
    // that read nothing of the workspace, or the pane listed with its agent field omitted.
    const views: Array<{ agents: HerdrAgent[]; available: boolean }> = [
      { agents: [], available: false },
      { agents: [{ name: 'other', pane_id: 'w9:p1', agent_status: 'working', agent: 'claude' }], available: true },
      { agents: [{ pane_id: 'w1:p923', agent_status: 'working' }, live], available: true },
    ];
    let offset = 2;
    for (const view of views) {
      const blind = harness(item, live, { herdr: () => view });
      await runCycle(master, state, blind.effects, () => clock + offset++ * launchAppearanceMs);
      assert.deepEqual(blind.log.closed, [], 'the pane is never closed without a current, confirmed sight');
      assert.equal(blind.log.sessions.filter(entry => entry.state === 'finished').length, 0);
      assert.equal(row(state.actions, evidenceKey), undefined);
    }
    assert.equal(Object.keys(state.actions).filter(key => key.startsWith('exited:implementation:')).length, 0, 'the unconfirmed sighting lapsed');

    // The agent is seen gone again: a fresh two-sighting witness closes the session plainly.
    const plain = harness(item, live, { herdr: () => ({ agents: listing, available: true }) });
    await runCycle(master, state, plain.effects, () => clock + offset++ * launchAppearanceMs);
    assert.equal(plain.log.sessions.length, 0, 'a new sighting starts over rather than closing on the old one');
    await runCycle(master, state, plain.effects, () => clock + offset++ * launchAppearanceMs);
    assert.deepEqual(plain.log.closed, ['w1:p923']);
    assert.equal(plain.log.sessions.length, 1);
    assert.equal(plain.log.sessions[0].state, 'finished');
    assert.match(plain.log.sessions[0].outcome!, /the agent has exited/);
    assert.match(plain.log.sessions[0].outcome!, /pane w1:p923 closed$/);
    assert.equal(row(state.actions, closeKey)?.state, 'done');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:resume-prompt-dedup-survives-prune — one scope decision prompts once, even when the ledger it was remembered in is pruned', async () => {
  const { directory, master } = await setup();
  try {
    // A scope request asked and answered between two cycles (GY-544): the decision on the item
    // earns its one re-prompt.
    const item = { current: [held({ plannedFiles: ['src/a.ts', 'src/b.ts'],
      scopeDecision: { state: 'approved', reason: 'criteria name it', at: iso(0), decidedBy: 'graphyard', waitedMs: 5_000, paths: ['src/b.ts'], requestedBy: 'alpha-principal', requestedAt: iso(-30_000), epoch: 1 } as Work['scopeDecision'] })] };
    const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p923', agent_status: 'idle', agent: 'claude' };
    const { log, effects } = harness(item, agent);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.equal(log.prompts.length, 1, 'the unmarked answer is re-prompted within one cycle');
    const promptRow = Object.entries(state.actions).find(([key]) => key.startsWith('resume:prompt:work-923:1:'));
    assert.ok(promptRow, 'the prompt is remembered');
    assert.equal(promptRow![1].state, 'waiting', 'as a waiting row, outside the prunable action ledger');

    // A busy installation resolves more actions than the ledger retains: the row a `done` row
    // would have been, and the canary written at the same instant, are pruned away — the dedup
    // row is not, and the same decision never prompts twice.
    for (let index = 0; index < 501; index++) state.actions[`flood:${index}`] = resolvedAction(`resolved work ${index}`, iso(minutes(1)));
    state.actions['canary'] = resolvedAction('written when the prompt was', promptRow![1].at);
    await runCycle(master, state, effects, () => clock + minutes(2));
    assert.equal(state.actions['canary'], undefined, 'the prunable rows were retired');
    assert.ok(promptRow![1] === state.actions[promptRow![0]], 'the dedup row is still on the cursor');
    assert.equal(log.prompts.length, 1, 'and the same decision is not prompted a second time');

    // Past the recency window no decision can match the row again, so the sweep retires it.
    await runCycle(master, state, effects, () => clock + idleLeaseMs + minutes(2));
    assert.equal(state.actions[promptRow![0]], undefined, 'the dedup row is swept once it can dedupe nothing');
    assert.equal(log.prompts.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Both row families above escape `pruneDaemonState` on purpose, so only their sweeps bound them.
 * Driven over many cycles, as the soak drives `exited:implementation:*` (GY-544): after every cycle
 * the closed-pane evidence never exceeds the implementation handles still running here, and every
 * resume-prompt dedup row names an open item and sits within the `idleLeaseMs` recency window.
 */
test('unit:never-pruned-rows-bounded — closed-pane evidence and resume-prompt dedup rows stay within their sweeps\' bounds after every cycle', async () => {
  const { directory, master } = await setup();
  try {
    // Four stale implementation handles whose runtimes exited; one registry update fails three times.
    const items = { current: [1, 2, 3, 4].map(n => held({ id: `work-92${n}`, key: `GY-92${n}`, lease: { owner: `zeta-${n}`, epoch: 2, expiresAt: iso(minutes(600)) },
      lastAssignment: { owner: `zeta-${n}`, epoch: 2, claimedAt: iso(-minutes(230)) }, sessions: [staleHandle(`zeta-${n}:2`, `w1:p${n}`, `zeta-${n}`)] })) };
    const live: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:plive', agent_status: 'working', agent: 'claude' };
    const listing: HerdrAgent[] = [live, ...[1, 2, 3, 4].map(n => ({ pane_id: `w1:p${n}`, agent: null, agent_status: 'unknown' }) as HerdrAgent)];
    let failures = 3;
    const { effects } = harness(items, live, {
      herdr: () => ({ agents: listing, available: true }),
      closeSession: pane => { const at = listing.findIndex(agent => agent.pane_id === pane); if (at < 0) throw new Error('herdr: pane_not_found'); listing.splice(at, 1); },
      recordSession: async (work, input) => {
        if (work.id === 'work-922' && failures-- > 0) throw new Error('registry unavailable');
        items.current = items.current.map(item => item.id !== work.id ? item : { ...item, sessions: item.sessions!.map(handle => handle.id === input.id ? { ...handle, state: input.state, outcome: input.outcome ?? null } : handle) });
      },
    });
    const state = emptyDaemonState(master);
    let evidenceSeen = 0;
    for (let cycle = 0; cycle < 12; cycle++) {
      await runCycle(master, state, effects, () => clock + cycle * launchAppearanceMs);
      const running = items.current.flatMap(item => item.sessions ?? []).filter(handle => handle.kind === 'implementation' && handle.state === 'running').length;
      const evidence = Object.keys(state.actions).filter(key => key.startsWith('close-evidence:implementation:'));
      evidenceSeen += evidence.length;
      assert.ok(evidence.length <= running, `cycle ${cycle}: ${evidence.length} close-evidence row(s) for ${running} running implementation handle(s)`);
    }
    assert.ok(evidenceSeen > 0, 'the failed registry update left closed-pane evidence for its retry');
    assert.equal(items.current.flatMap(item => item.sessions ?? []).filter(handle => handle.state === 'running').length, 0, 'every exited handle was closed');
    assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('close-evidence:implementation:')), [], 'no closed-pane evidence outlives its handle');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const second = await setup();
  try {
    // Scope decisions on the held attempt, one every 45 minutes across a long day, with a prune
    // flood between them; then the item is delivered.
    const item = { current: [held({ plannedFiles: ['src/a.ts', 'src/b.ts'] })] };
    const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p923', agent_status: 'idle', agent: 'claude' };
    const { log, effects } = harness(item, agent);
    const state = emptyDaemonState(second.master);
    let rowsSeen = 0, flood = 0;
    for (let step = 0; step < 40; step++) {
      const at = clock + step * minutes(9);
      if (step % 5 === 0) item.current = [{ ...item.current[0], scopeDecision: { state: 'approved', reason: 'criteria name it', at: new Date(at - 30_000).toISOString(), decidedBy: 'graphyard', waitedMs: 5_000,
        paths: ['src/b.ts'], requestedBy: 'alpha-principal', requestedAt: new Date(at - 60_000).toISOString(), epoch: 1 } as Work['scopeDecision'], lease: { owner: 'alpha-principal', epoch: 1, expiresAt: new Date(at + minutes(600)).toISOString() } }];
      if (step === 36) item.current = [{ ...item.current[0], stage: 'done', lease: null }];
      for (let index = 0; index < 120; index++) state.actions[`flood:${flood++}`] = resolvedAction('resolved elsewhere', new Date(at).toISOString());
      await runCycle(second.master, state, effects, () => at);
      const open = new Set(item.current.filter(entry => entry.stage !== 'done').map(entry => entry.id));
      const rows = Object.entries(state.actions).filter(([key, action]) => key.startsWith('resume:prompt:') && action.state === 'waiting');
      rowsSeen += rows.length;
      for (const [key, action] of rows) {
        assert.ok(open.has(key.split(':')[2]), `step ${step}: dedup row ${key} outlived its item`);
        assert.ok(at - Date.parse(action.at) <= idleLeaseMs, `step ${step}: dedup row ${key} outlived the recency window`);
      }
    }
    assert.ok(rowsSeen > 0, 'the day recorded resume-prompt dedup rows');
    const told = log.prompts.filter(text => /scope request was applied/.test(text)).length;
    assert.equal(told, 8, 'each of the eight decisions made while the item was open was re-prompted exactly once');
    assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('resume:prompt:')), [], 'no dedup row outlives its delivered item');
  } finally {
    await rm(second.directory, { recursive: true, force: true });
  }
});
