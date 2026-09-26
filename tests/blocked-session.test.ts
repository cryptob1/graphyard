import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockedPromptFailMs, dispatchKey, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { classifyRuntimePrompt, destructivePromptGuidance, masterConfigSchema, workerPrompt, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { producerPrompt } from '../src/producer.js';

import type { Work } from '../src/model.js';

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
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-blocked-'));
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
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'build', revision: 3, policyRevision: 1,
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
    merge: async () => ({ result: 'merge requested' }),
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

test('unit:blocked-prompt-answered-safely — a session blocked on a destructive rm prompt is declined and told to continue safely', async () => {
  const { directory, master } = await setup();
  try {
    const prompt = classifyRuntimePrompt(dangerousRm)!;
    assert.equal(prompt.kind, 'destructive-command');
    assert.deepEqual(prompt.keys, ['2'], 'the non-destructive answer is the No option');
    assert.match(prompt.text, /Dangerous rm operation on statically-unresolvable target/);

    const item = { current: held() };
    const { log, effects } = harness(dangerousRm, item);
    const state = emptyDaemonState(master);
    // One loop cycle — every 20 s in production, well inside the two-minute bound — answers it.
    await runCycle(master, state, effects, () => clock + 20_000);
    assert.deepEqual(log.keys, [['2']], 'the decline key is sent into the pane, never the Yes');
    assert.equal(log.prompts.length, 1, 'then one instruction to continue');
    assert.match(log.prompts[0], /Continue GY-174 without that command/);
    assert.ok(log.prompts[0].includes(`explicit paths inside your worktree ${worktree}`), 'the safe alternative names the worktree');
    assert.match(log.prompts[0], /mktemp -d/);
    const answered = Object.entries(state.actions).find(([key]) => key.startsWith('session:answered:alpha:13:w1:p9:'));
    assert.ok(answered, 'the answer is recorded on the cursor');
    assert.equal(answered[1].state, 'done');
    assert.match(answered[1].detail, /Dangerous rm operation/);
    assert.match(answered[1].detail, /"2\. No"/);
    const handle = log.sessions.at(-1)!;
    assert.equal(handle.state, 'running', 'the session carries on');
    assert.match(handle.outcome!, /Dangerous rm operation on statically-unresolvable target/, 'the prompt is recorded on the session');
    assert.match(handle.outcome!, /with "2\. No"/, 'and so is the answer');
    assert.deepEqual(log.closed, [], 'an answered session is not closed');
    assert.deepEqual(log.capacity, [], 'nor is its attempt ended');

    // The dialog is given time to close: the next cycle, seconds later, does not answer it again.
    await runCycle(master, state, effects, () => clock + 25_000);
    assert.equal(log.keys.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:unknown-prompt-fails-attempt — a prompt the loop cannot classify fails the attempt after 5 minutes and the item is dispatched again', async () => {
  const { directory, master } = await setup();
  try {
    assert.equal(classifyRuntimePrompt(unknownPrompt)!.kind, 'unknown');
    assert.equal(blockedPromptFailMs, 5 * 60_000);
    const item = { current: held() };
    const { log, effects } = harness(unknownPrompt, item);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.deepEqual(log.keys, [], 'an unknown prompt is never answered');
    assert.deepEqual(log.closed, [], 'nor closed on sight');
    assert.match(log.sessions.at(-1)!.outcome!, /A new version of the runtime is available/);

    await runCycle(master, state, effects, () => clock + blockedPromptFailMs - 1000);
    assert.deepEqual(log.closed, [], 'not before five minutes');
    assert.equal(log.capacity.length, 0);

    await runCycle(master, state, effects, () => clock + blockedPromptFailMs);
    assert.deepEqual(log.closed, ['w1:p9'], 'the session is closed');
    assert.equal(log.capacity.length, 1, 'as a failed attempt on the record');
    assert.match(String(log.capacity[0].reason), /A new version of the runtime is available \(2\.4\.1\)\. \/ How would you like to continue\?/, 'with the prompt text as the reason');
    assert.equal(log.capacity[0].epoch, 13);
    const closed = log.sessions.at(-1)!;
    assert.equal(closed.state, 'finished');
    assert.match(closed.outcome!, /closed as failed: blocked for 5 minutes on a runtime prompt \(the loop cannot classify it\): "✻ Welcome back/);
    const failed = Object.entries(state.actions).find(([key]) => key.startsWith('session:unanswered:alpha:13:'));
    assert.equal(failed?.[1].state, 'done');
    assert.match(failed![1].detail, /is dispatched again/);

    // The attempt's end freed the item: the next cycle dispatches it again.
    await runCycle(master, state, effects, () => clock + blockedPromptFailMs + 20_000);
    assert.deepEqual(log.dispatched, ['GY-174'], 'a new dispatch');
    assert.equal(state.actions[dispatchKey(item.current)].state, 'done');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:launch-warns-destructive-globs — worker and producer requests tell the agent to avoid the destructive-operation prompt', () => {
  const config = { cliPath: launcher, repository: 'owner/project' };
  const worker = workerPrompt(config, { key: 'GY-174', title: 'Regenerate the fixtures' }, { principal: 'alpha-principal' }, 13);
  const producer = producerPrompt(config, { key: 'GY-174', pr: 7, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, proofs: ['unit:works'], group: 'unit', checkout: '/srv/checkouts/proof-1' }, { principal: 'producer-principal' });
  for (const [name, request] of [['worker', worker], ['producer', producer]] as const) {
    assert.ok(request.includes(destructivePromptGuidance), `the ${name} request carries the instruction`);
    assert.match(request, /destructive-operation prompt/, name);
    assert.match(request, /never give rm or mv a glob or a variable as its target/, name);
    assert.match(request, /outside a directory you created yourself with mktemp -d/, name);
  }
});

const menu = (...question: string[]) => [...question, ' ❯ 1. Yes', '   2. No'].join('\n');

test('unit:destructive-prompt-classifies-command — the command a prompt would run, not a word in its prose, makes it destructive (GY-223)', () => {
  // Benign yes/no prompts that only mention a broad word are unknown: failed after 5 minutes, not declined.
  for (const screen of [
    menu(' Remove the trailing whitespace from 3 files?'),
    menu(' Force a refresh of the model list before continuing?'),
    menu(' Delete key bindings are not configured. Configure them now?'),
    menu(' Run npm run format to overwrite nothing but formatting?'),
  ]) assert.equal(classifyRuntimePrompt(screen)!.kind, 'unknown', screen);
  // A destructive command, at a command position and inside a box border, is declined.
  for (const screen of [
    dangerousRm,
    dangerousRm.replaceAll('   rm -rf', '│  rm -rf').replace('Dangerous rm operation on statically-unresolvable target:', 'Permission required:'),
    menu('● Bash(cd /srv/app && git reset --hard origin/main)', ' Do you want to proceed?'),
    menu('   find build -name "*.o" | xargs -0 rm -f', ' Do you want to proceed?'),
    menu('   git push -f origin HEAD', ' Do you want to proceed?'),
    menu('   mv generated/ "$OUT"', ' Do you want to proceed?'),
    menu(' This action cannot be undone. Continue?'),
  ]) assert.equal(classifyRuntimePrompt(screen)!.kind, 'destructive-command', screen);
  // A command's own inline confirmation is declined with `n`.
  const inline = classifyRuntimePrompt("$ rm -i notes.txt\nrm: remove regular file 'notes.txt'? [y/N]")!;
  assert.equal(inline.kind, 'destructive-command');
  assert.deepEqual(inline.keys, ['n', 'Enter']);
  assert.equal(classifyRuntimePrompt('Remove unused imports? [y/N]')!.kind, 'unknown', 'prose alone is not a destructive command');
});

test('unit:launched-session-prompt-on-handle — a reviewer blocked at a prompt carries it on its own session handle, as a worker does (GY-223)', async () => {
  const { directory, master } = await setup();
  try {
    const reviewer: NonNullable<Work['sessions']>[number] = { id: 'review-request-1', kind: 'review', principal: 'coordinator', epoch: null, runtime: 'claude', host: 'machine-a', agentName: 'graphyard-reviewer-1',
      role: 'review', head: 'a'.repeat(40), workspace: 'w1', tab: null, pane: 'w1:p7', attach: 'herdr pane attach w1:p7', transcript: null, subject: 'GY-174: review aaaaaaaaaaaa (PR #7)',
      startedAt: iso(-60_000), updatedAt: iso(-60_000), endedAt: null, state: 'running', outcome: null };
    // No worker holds the item; its reviewer session is the one blocked.
    const run = async (screen: string) => {
      const item = { current: held({ lease: null, sessions: [reviewer] } as Partial<Work>) };
      const { log, effects } = harness(screen, item);
      const agent: HerdrAgent = { name: 'graphyard-reviewer-1', pane_id: 'w1:p7', agent_status: 'blocked' };
      const order: string[] = [];
      Object.assign(effects, {
        agents: () => [agent],
        launchedSessions: async () => [{ role: 'reviewer', record: 'review-1', profile: 'reviewer-a', agentName: 'graphyard-reviewer-1', pane: 'w1:p7', work: 'GY-174', requestId: 'review-request-1' }],
        endSession: async () => { order.push('ended'); },
        relaunch: async () => { order.push('relaunched'); return { profile: 'reviewer-b' }; },
        // Only the reviewer's handle is followed; the dispatch step may register a worker's in the same cycle.
        recordSession: async (_work: Work, handle: { id: string; state?: string; outcome?: string }) => { if (handle.id !== 'review-request-1') return; order.push(`handle:${handle.state}`); log.sessions.push(handle); },
      } satisfies Partial<DaemonEffects>);
      return { log, effects, order, state: emptyDaemonState(master) };
    };

    const answered = await run(dangerousRm);
    await runCycle(master, answered.state, answered.effects, () => clock + 20_000);
    assert.deepEqual(answered.log.keys, [['2']], 'the reviewer\'s destructive prompt is declined');
    const handle = answered.log.sessions.at(-1) as { id: string; kind: string; state: string; outcome: string };
    assert.equal(handle.id, 'review-request-1', 'on the handle its launcher registered');
    assert.equal(handle.kind, 'review');
    assert.equal(handle.state, 'running');
    assert.match(handle.outcome, /Dangerous rm operation/);
    assert.match(handle.outcome, /with "2\. No"/);

    const unknown = await run(unknownPrompt);
    await runCycle(master, unknown.state, unknown.effects, () => clock);
    assert.match(unknown.log.sessions.at(-1)!.outcome!, /waiting on input.*A new version of the runtime is available/);
    await runCycle(master, unknown.state, unknown.effects, () => clock + blockedPromptFailMs);
    const closed = unknown.log.sessions.at(-1)!;
    assert.equal(closed.state, 'finished');
    assert.match(closed.outcome!, /closed as failed: blocked for 5 minutes on a runtime prompt \(the loop cannot classify it\)/);
    assert.deepEqual(unknown.order.slice(-3), ['ended', 'handle:finished', 'relaunched'], 'the handle ends before the relaunch reopens it');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
