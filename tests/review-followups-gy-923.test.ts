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

test('unit:exit-evidence-retained — a close whose pane closed but whose registry update failed is retried on the retained exit, never against a live agent', async () => {
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
    assert.match(row(state.actions, closeKey)!.detail, /registry unavailable; its witnessed exit is retained/);
    assert.equal(row(state.actions, evidenceKey)?.state, 'waiting', 'the witnessed exit is retained outside the prunable ledger');
    assert.match(row(state.actions, evidenceKey)!.detail, /the claude runtime is no longer the foreground process of pane w1:p923/);

    // The pane gone, a sole pane empties its workspace's listing: the sight cannot be taken again,
    // and the retained exit is what completes the registry update.
    listing.length = 0;
    failRegistry = false;
    await runCycle(master, state, flaky.effects, () => clock + 2 * launchAppearanceMs);
    assert.equal(log.sessions.length, 1);
    assert.equal(log.sessions[0].state, 'finished');
    assert.match(log.sessions[0].outcome!, /closed by the loop: the claude runtime is no longer the foreground process of pane w1:p923/);
    assert.match(log.sessions[0].outcome!, /witnessed before the earlier close attempt/);
    assert.match(log.sessions[0].outcome!, /pane w1:p923 was already gone/);
    assert.equal(row(state.actions, closeKey)?.state, 'done');

    // With the handle finished on the record, the retained evidence is swept.
    item.current = [held({ lease: { owner: 'zeta-9', epoch: 2, expiresAt: iso(minutes(600)) }, lastAssignment: { owner: 'zeta-9', epoch: 2, claimedAt: iso(-minutes(230)) }, sessions: [{ ...handle, state: 'finished', outcome: 'closed by the loop' }] })];
    await runCycle(master, state, flaky.effects, () => clock + 3 * launchAppearanceMs);
    assert.equal(row(state.actions, evidenceKey), undefined, 'evidence whose handle is no longer running is swept');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:exit-evidence-never-against-a-live-agent — retained evidence waits while Herdr lists an agent in the pane again', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held({ lease: { owner: 'zeta-9', epoch: 2, expiresAt: iso(minutes(600)) }, lastAssignment: { owner: 'zeta-9', epoch: 2, claimedAt: iso(-minutes(230)) }, sessions: [staleHandle('zeta-9:2', 'w1:p923', 'zeta-9')] })] };
    const live: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:plive', agent_status: 'working', agent: 'claude' };
    const exited: HerdrAgent = { pane_id: 'w1:p923', agent: null, agent_status: 'unknown' };
    const listing: HerdrAgent[] = [exited, live];
    const { log, effects } = harness(item, live, { herdr: () => ({ agents: listing, available: true }) });
    const state = emptyDaemonState(master);
    const handle = item.current[0].sessions![0], closeKey = `close:implementation:work-923:zeta-9:2:${handle.startedAt}`, evidenceKey = `close-evidence:implementation:work-923:zeta-9:2:${handle.startedAt}`;
    await runCycle(master, state, effects, () => clock);

    // The close itself fails, so the pane stands and the evidence is written for its retry.
    const flaky = harness(item, live, { herdr: () => ({ agents: listing, available: true }),
      closeSession: pane => { throw new Error(`herdr refused the close of ${pane}`); } });
    await runCycle(master, state, flaky.effects, () => clock + launchAppearanceMs);
    assert.equal(row(state.actions, closeKey)?.state, 'failed');
    assert.equal(row(state.actions, evidenceKey)?.state, 'waiting', 'the witnessed exit is retained for the retry');

    // Herdr lists a live agent in the pane again: the exit no longer stands, and neither the sight
    // nor the retained evidence closes anything.
    exited.agent = 'zeta';
    exited.agent_status = 'working';
    await runCycle(master, state, flaky.effects, () => clock + 2 * launchAppearanceMs);
    assert.equal(flaky.log.sessions.filter(entry => entry.state === 'finished').length, 0, 'the retained exit is never used against a live agent');
    assert.equal(row(state.actions, closeKey)?.state, 'failed');
    assert.equal(Object.keys(state.actions).filter(key => key.startsWith('exited:implementation:')).length, 0, 'the sighting lapsed when the agent was seen again');

    // The agent leaves for good: a fresh two-sighting witness closes the session plainly.
    exited.agent = null;
    exited.agent_status = 'unknown';
    const plain = harness(item, live, { herdr: () => ({ agents: listing, available: true }) });
    await runCycle(master, state, plain.effects, () => clock + 3 * launchAppearanceMs);
    assert.equal(plain.log.sessions.length, 0, 'a new sighting starts over rather than closing on the old one');
    await runCycle(master, state, plain.effects, () => clock + 4 * launchAppearanceMs);
    assert.equal(plain.log.sessions.length, 1);
    assert.equal(plain.log.sessions[0].state, 'finished');
    assert.match(plain.log.sessions[0].outcome!, /the agent has exited/);
    assert.doesNotMatch(plain.log.sessions[0].outcome!, /witnessed before the earlier close attempt/, 'a fresh witness needs no retained evidence');
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
