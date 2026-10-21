import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockedPromptFailMs, dispatchKey, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { classifyRuntimePrompt, destructivePromptGuidance, masterConfigSchema, workerPrompt, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';

import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2030-01-01 clock is handed to runCycle as `() => clock` and the 2026-10-05 now is startAgentSession's explicit clock; Date.now() builds relative expiries for the account tests.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const worktree = '/srv/graphyard/.graphyard/worktrees/GY-174-13';

/** The screen the GY-174 worker sat at on 2026-09-25: Claude Code's own check, which bypass mode does not cover. */
const dangerousRm = [
  '● Bash(rm -rf /srv/graphyard/.graphyard/worktrees/GY-174-13/*)',
  '  ⎿  Running…',
  '',
  '╭──────────────────────────────────────────────────────────────╮',
  '│ Bash command                                                 │',
  '│                                                              │',
  '│   rm -rf /srv/graphyard/.graphyard/worktrees/GY-174-13/*     │',
  '│   Clear the worktree before regenerating it                  │',
  '│                                                              │',
  '│ Dangerous rm operation on statically-unresolvable target:    │',
  '│ /srv/graphyard/.graphyard/worktrees/GY-174-13/*              │',
  '│                                                              │',
  '│ Do you want to proceed?                                      │',
  '│ ❯ 1. Yes                                                     │',
  '│   2. No                                                      │',
  '╰──────────────────────────────────────────────────────────────╯',
  '   Esc to cancel',
].join('\n').replaceAll('│', ' ');
/** A prompt the loop has no safe answer for: a menu with neither a destructive yes nor a no. */
const unknownPrompt = [
  '✻ Welcome back',
  '',
  ' A new version of the runtime is available (2.4.1).',
  ' How would you like to continue?',
  ' ❯ 1. Update and restart',
  '   2. Remind me tomorrow',
].join('\n');

async function setup() {
  const directory = await temporaryDirectory('blocked');
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
    id: 'work-174', key: 'GY-174', title: 'Regenerate the fixtures', description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', revision: 3, policyRevision: 1,
    createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(-600_000), ready: true, epoch: 13,
    lease: { owner: 'alpha-principal', epoch: 13, expiresAt: iso(3_600_000) },
    lastAssignment: { owner: 'alpha-principal', epoch: 13, claimedAt: iso(-600_000) },
    workspaces: [{ host: 'machine-a', path: worktree, epoch: 13, owner: 'alpha-principal', branch: 'graphyard/gy-174-13' }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    ...overrides,
  } as Work;
}
function harness(screen: string, item: { current: Work }) {
  const log = { keys: [] as string[][], prompts: [] as string[], sessions: [] as { state?: string; outcome?: string }[], closed: [] as string[], capacity: [] as Record<string, unknown>[], dispatched: [] as string[] };
  const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p9', agent_status: 'blocked' };
  const effects: DaemonEffects = {
    agents: () => item.current.lease ? [agent] : [],
    credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [item.current], now: iso(0) }),
    closeSession: pane => { log.closed.push(pane); },
    dispatch: async work => { log.dispatched.push(work.key); },
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    sessionOutput: () => screen,
    answerSession: (_agent, keys) => { log.keys.push(keys); },
    promptSession: (_agent, text) => { log.prompts.push(text); },
    recordSession: async (_work, handle) => { log.sessions.push(handle); },
    // The control plane ends the attempt on this record, which frees the item for the next dispatch.
    reportCapacity: async (work, event) => { log.capacity.push(event); item.current = { ...item.current, lease: null, containmentQuarantine: null } as Work; return item.current; },
    preserveWork: async () => ({ state: 'clean', detail: 'nothing uncommitted' }),
  };
  return { log, effects };
}

test('unit:blocked-prompt-answered-once — GY-1774: a continuation prompt carried past its bound is retried alone; the decline keys are never sent twice', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: held() };
    const { log, effects } = harness(dangerousRm, item);
    let release!: () => void;
    const prompts: string[] = [];
    effects.promptSession = (_agent, text) => { prompts.push(text); return new Promise<void>(resolve => { release = resolve; }); };
    (effects as { stepCallBoundMs?: number }).stepCallBoundMs = 30;
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock + 20_000);
    assert.deepEqual(log.keys, [['2']], 'the decline was sent');
    assert.equal(prompts.length, 1, 'the continuation was sent and did not answer in time');
    release();
    await new Promise(resolve => setTimeout(resolve, 5));
    await runCycle(master, state, effects, () => clock + 60_000);
    assert.deepEqual(log.keys, [['2']], 'the retry resumed at the continuation: the decline keys were not sent again');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:blocked-prompt-answered-once — GY-1774: a carried continuation answered meanwhile is consumed inside the settle window, without the decline keys or a second paste', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: held() };
    const { log, effects } = harness(dangerousRm, item);
    let release!: () => void;
    const prompts: string[] = [];
    effects.promptSession = (_agent, text) => { prompts.push(text); return new Promise<void>(resolve => { release = resolve; }); };
    (effects as { stepCallBoundMs?: number }).stepCallBoundMs = 30;
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock + 20_000);
    assert.deepEqual(log.keys, [['2']], 'the decline was sent');
    assert.equal(prompts.length, 1, 'the continuation was sent and did not answer in time');
    release();
    await new Promise(resolve => setTimeout(resolve, 5));
    await runCycle(master, state, effects, () => clock + 25_000);
    assert.equal(prompts.length, 1, 'the continuation answered meanwhile is consumed within the settle window, never pasted twice');
    assert.equal(Object.values(state.actions).filter(row => row.detail.includes('destructive-command prompt') && row.state === 'done' && row.detail.includes('told it to continue')).length, 1, 'the answer retired the carried row');
    assert.deepEqual(log.keys, [['2']], 'the retry resumed at the continuation: the decline keys were not sent again');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:blocked-prompt-answered-once — GY-1774: a carried continuation is retried after the declined dialog has closed, never dropped with it', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: held() };
    let screen = dangerousRm;
    const { log, effects } = harness(dangerousRm, item);
    effects.sessionOutput = () => screen;
    let release!: () => void;
    const prompts: string[] = [];
    effects.promptSession = (_agent, text) => { prompts.push(text); return new Promise<void>(resolve => { release = resolve; }); };
    (effects as { stepCallBoundMs?: number }).stepCallBoundMs = 30;
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock + 20_000);
    assert.deepEqual(log.keys, [['2']], 'the decline was sent');
    assert.equal(Object.values(state.actions).filter(row => row.state === 'waiting' && row.detail.includes('destructive-command prompt')).length, 1, 'the continuation is carried');
    screen = '';
    release();
    await new Promise(resolve => setTimeout(resolve, 5));
    await runCycle(master, state, effects, () => clock + 60_000);
    assert.equal(Object.values(state.actions).filter(row => row.state === 'waiting' && row.detail.includes('destructive-command prompt')).length, 0, 'the carried continuation was retried with the dialog gone');
    assert.equal(Object.values(state.actions).filter(row => row.state === 'done' && row.detail.includes('told it to continue')).length, 1, 'and ran through');
    assert.deepEqual(log.keys, [['2']], 'the decline keys were not sent again');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
