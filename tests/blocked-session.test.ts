import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockedPromptFailMs, dispatchKey, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { classifyRuntimePrompt, destructivePromptGuidance, masterConfigSchema, workerPrompt, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { producerPrompt } from '../src/producer.js';

import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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
    // Neither an append, a descriptor duplication, /dev/null, an arrow nor a comparison overwrites a file (GY-472).
    menu('   npm test 2>&1 | tee -a test.log >> summary.txt', ' Do you want to proceed?'),
    menu('   node build.mjs > /dev/null', ' Do you want to proceed?'),
    menu(' Rename a -> b.txt and check that x > 5.0 still holds?'),
    menu('   find . -name "*.log" -print', ' Do you want to proceed?'),
    menu('   rsync -a src/ backup/', ' Do you want to proceed?'),
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
    // Other ways to delete or overwrite (GY-472): find -delete, git rm, a truncating redirect, rsync --delete.
    menu('   find . -name "*.log" -delete', ' Do you want to proceed?'),
    menu('● Bash(git rm -r --cached src/old)', ' Do you want to proceed?'),
    menu('   echo "{}" > config/settings.json', ' Do you want to proceed?'),
    menu('   node gen.mjs 2> errors.log', ' Do you want to proceed?'),
    menu('   sudo rsync -a --delete dist/ /srv/app/', ' Do you want to proceed?'),
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
    // An earlier running handle under the same reused agent name and pane: the launch's request id,
    // not the name, binds the outcome to the handle its launcher registered (GY-472).
    const stale: NonNullable<Work['sessions']>[number] = { ...reviewer, id: 'review-request-0', startedAt: iso(-600_000), updatedAt: iso(-600_000) };
    // No worker holds the item; its reviewer session is the one blocked.
    const run = async (screen: string) => {
      const item = { current: held({ lease: null, sessions: [stale, reviewer] } as Partial<Work>) };
      const { log, effects } = harness(screen, item);
      const agent: HerdrAgent = { name: 'graphyard-reviewer-1', pane_id: 'w1:p7', agent_status: 'blocked' };
      const order: string[] = [];
      Object.assign(effects, {
        agents: () => [agent],
        launchedSessions: async () => [{ role: 'reviewer', record: 'review-1', profile: 'reviewer-a', agentName: 'graphyard-reviewer-1', pane: 'w1:p7', work: 'GY-174', requestId: 'review-request-1' }],
        endSession: async () => { order.push('ended'); },
        relaunch: async () => { order.push('relaunched'); return { profile: 'reviewer-b' }; },
        // Only the reviewer's handle is followed; the dispatch step may register a worker's in the same cycle.
        recordSession: async (_work: Work, handle: { id: string; state?: string; outcome?: string }) => {
          if (handle.id === 'review-request-0') order.push('stale');
          if (handle.id !== 'review-request-1') return; order.push(`handle:${handle.state}`); log.sessions.push(handle);
        },
      } satisfies Partial<DaemonEffects>);
      return { log, effects, order, state: emptyDaemonState(master) };
    };

    const answered = await run(dangerousRm);
    await runCycle(master, answered.state, answered.effects, () => clock + 20_000);
    assert.deepEqual(answered.log.keys, [['2']], 'the reviewer\'s destructive prompt is declined');
    const handle = answered.log.sessions.at(-1) as { id: string; kind: string; state: string; outcome: string };
    assert.equal(handle.id, 'review-request-1', 'on the handle its launcher registered');
    assert.ok(!answered.order.includes('stale'), 'not on the earlier handle sharing its agent name');
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
    assert.ok(!unknown.order.includes('stale'), 'the earlier handle sharing its agent name is never written');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** The screen GY-1294's reviewer sat at on 2026-10-05: Claude Code's folder-trust dialog, read off the pane unnumbered. */
const folderTrust = [
  ' Accessing workspace:',
  '',
  ' /srv/graphyard-review-claude-1-f7d467f9/checkout',
  '',
  ' Quick safety check: Is this a project you created or one you trust?',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/** A reviewer session blocked in its pane, wired as the loop sees one its launcher started; `read` is the pane read. */
async function blockedReviewer(master: MasterConfig, read: (agent: HerdrAgent) => string | null) {
  const reviewer: NonNullable<Work['sessions']>[number] = { id: 'review-request-1', kind: 'review', principal: 'coordinator', epoch: null, runtime: 'claude', host: 'machine-a', agentName: 'review-claude-1',
    role: 'review', head: 'a'.repeat(40), workspace: 'w1', tab: null, pane: 'w1:p7', attach: 'herdr pane attach w1:p7', transcript: null, subject: 'GY-174: review aaaaaaaaaaaa (PR #7)',
    startedAt: iso(-60_000), updatedAt: iso(-60_000), endedAt: null, state: 'running', outcome: null };
  const item = { current: held({ lease: null, sessions: [reviewer] } as Partial<Work>) };
  const { log, effects } = harness('', item);
  const order: string[] = [];
  Object.assign(effects, {
    agents: () => [{ name: 'review-claude-1', pane_id: 'w1:p7', agent_status: 'blocked' }],
    sessionOutput: read,
    launchedSessions: async () => [{ role: 'reviewer', record: 'review-1', profile: 'reviewer-a', agentName: 'review-claude-1', pane: 'w1:p7', work: 'GY-174', requestId: 'review-request-1' }],
    endSession: async () => { order.push('ended'); },
    relaunch: async () => { order.push('relaunched'); return { profile: 'reviewer-b' }; },
  } satisfies Partial<DaemonEffects>);
  return { log, effects, order, state: emptyDaemonState(master) };
}
/** The session-liveness fault instances a loop state carries: every failed session action (GY-173 counts each as one). */
const sessionFaults = (state: ReturnType<typeof emptyDaemonState>) => Object.entries(state.actions).filter(([, action]) => action.kind === 'session' && action.state === 'failed');

test('unit:folder-trust-relaunches — a session stopped at its runtime\'s folder-trust dialog is relaunched at once, not failed after five minutes (GY-1304, GY-1294)', async () => {
  const { directory, master } = await setup();
  try {
    const prompt = classifyRuntimePrompt(folderTrust)!;
    assert.equal(prompt.kind, 'folder-trust', 'the arrow-selected dialog is a known shape');
    assert.equal(prompt.keys, null, 'which the loop never answers');
    assert.match(prompt.text, /Security guide \/ ❯ No, exit \/ Yes, I trust this folder \/ Enter to confirm · Esc to cancel/);
    assert.equal(classifyRuntimePrompt(' Do you trust the files in this folder?\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel')!.kind, 'folder-trust', 'and so is the numbered one');
    assert.equal(classifyRuntimePrompt('> Yes, I trust this folder\n● Reading src/harness.ts\n  ⎿ 120 lines\n● Editing src/harness.ts\n  ⎿ done')!.kind, 'unknown', 'the words scrolled up above later output are no dialog');

    // A reviewer: the session is closed and its request launched again in the same cycle, and nothing is a fault.
    const reviewer = await blockedReviewer(master, () => folderTrust);
    await runCycle(master, reviewer.state, reviewer.effects, () => clock);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reviewer.order, ['ended', 'relaunched'], 'closed and launched again on sight');
    assert.deepEqual(sessionFaults(reviewer.state), [], 'no session-liveness fault is recorded');
    const relaunched = reviewer.state.actions['session:trust:reviewer:review-1'];
    assert.equal(relaunched?.state, 'done');
    assert.match(relaunched.detail, /folder-trust dialog .*which the loop never answers/);
    assert.match((reviewer.log.sessions as { id?: string; outcome?: string }[]).findLast(handle => handle.id === 'review-request-1')!.outcome!, /closed as failed: stopped at its runtime's folder-trust dialog/);
    // A dialog that comes back after the relaunch is not relaunched again: it is waited out as before.
    await runCycle(master, reviewer.state, reviewer.effects, () => clock + 20_000);
    assert.deepEqual(reviewer.order, ['ended', 'relaunched'], 'one relaunch per request');
    assert.match(sessionFaults(reviewer.state)[0]?.[1].detail ?? '', /folder-trust dialog came back after the session was launched again/);

    // A worker: its attempt ends at once, so the item is dispatched again into a launch that records the trust.
    const item = { current: held() };
    const worker = harness(folderTrust, item);
    const state = emptyDaemonState(master);
    await runCycle(master, state, worker.effects, () => clock);
    assert.deepEqual(worker.log.keys, [], 'no key is sent into the dialog');
    assert.deepEqual(worker.log.closed, ['w1:p9'], 'the session is closed on sight');
    assert.equal(worker.log.capacity.length, 1, 'and its attempt ended');
    assert.match(String(worker.log.capacity[0].reason), /folder-trust dialog/);
    assert.deepEqual(sessionFaults(state), [], 'no session-liveness fault is recorded');
    await runCycle(master, state, worker.effects, () => clock + 20_000);
    assert.deepEqual(worker.log.dispatched, ['GY-174'], 'the item is dispatched again');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:unread-screen-not-a-prompt — a blocked session whose screen could not be read is never failed on that read (GY-1304, GY-1290, GY-1303)', async () => {
  const { directory, master } = await setup();
  try {
    for (const [name, read] of [
      ['a read that fails', () => { throw new Error('herdr: agent_not_found'); }],
      ['a read that returns nothing', () => null],
      ['a blank screen', () => '\n  \n'],
    ] as const) {
      const reviewer = await blockedReviewer(master, read);
      for (const at of [0, 20_000, blockedPromptFailMs, blockedPromptFailMs + 20_000, 2 * blockedPromptFailMs]) await runCycle(master, reviewer.state, reviewer.effects, () => clock + at);
      assert.deepEqual(sessionFaults(reviewer.state), [], `${name}: no "its screen could not be read" fault`);
      assert.deepEqual(reviewer.order, [], `${name}: the session is neither closed nor relaunched`);
      assert.ok(!Object.keys(reviewer.state.actions).some(key => key.startsWith('session:blocked:')), `${name}: no prompt is timed`);
    }

    // The pane is read when the agent's name reads nothing, so a prompt on screen is still found.
    const byPane = await blockedReviewer(master, agent => agent.name ? null : unknownPrompt);
    await runCycle(master, byPane.state, byPane.effects, () => clock);
    assert.match(sessionFaults(byPane.state)[0]?.[1].detail ?? '', /A new version of the runtime is available/);

    // A prompt read after unread screens is timed from the read that showed it, not from the first unread one.
    let screen: string | null = null;
    const late = await blockedReviewer(master, () => screen);
    await runCycle(master, late.state, late.effects, () => clock);
    screen = unknownPrompt;
    await runCycle(master, late.state, late.effects, () => clock + blockedPromptFailMs);
    await runCycle(master, late.state, late.effects, () => clock + 2 * blockedPromptFailMs - 1000);
    assert.deepEqual(late.order, [], 'not closed before five minutes of a prompt actually seen');
    await runCycle(master, late.state, late.effects, () => clock + 2 * blockedPromptFailMs);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(late.order, ['ended', 'relaunched'], 'then closed as failed with the prompt as the reason');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
