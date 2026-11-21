import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { stallAlarmKey } from '../src/daemon/stall-alarm.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3502: the stall alarm names the cause that holds work now. A launch failure counts only while
// its back-off runs and its item is open; the loop deletes the rest the same cycle. With no such
// cause, each ready item is named with the dispatch gate that refuses it, not "has no actor", and
// an item parked on a human request is never "has no actor". Driven through the loop's cycle.

const start = Date.parse('2026-11-19T03:00:00Z');
const minute = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const doneError = 'codex exited 1: the done item failed to launch';
const expiredError = 'git worktree add .graphyard/worktrees/GY-3446-1: fatal: could not create work tree';

function item(key: string, extra: Partial<Work> = {}): Work {
  return { id: `id-${key}`, key, title: key, stage: 'ready', ready: true, epoch: 0, revision: 1, policyRevision: 1, priority: 1, type: 'bug',
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:fixture'] }], dependencies: [], evidence: [], gates: [], workspaces: [], sessions: [], createdAt: at(start), updatedAt: at(start), ...extra } as unknown as Work;
}

async function fixture() {
  const directory = await temporaryDirectory('stall-cause-is-current');
  const profile = { name: 'w1', principal: 'worker-a', agentName: 'agent-w1', mode: 'launch', kind: 'codex', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/stall', credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard', hostId: 'stall-host', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master', workers: [profile] });
  const state = emptyDaemonState(config);
  state.lock = { id: 'lock', pid: 1, host: 'stall-host', startedAt: at(start - 9 * 60 * minute), heartbeatAt: at(start) };
  // A launch failure for an item that is since done, still inside its back-off; and one whose back-off passed hours ago.
  state.launchBackoff['codex:id-GY-3446'] = { failures: 3, reason: doneError, until: at(start + 30 * minute) };
  state.launchBackoff['any:id-GY-3440'] = { failures: 1, reason: expiredError, until: at(start - 7 * 60 * minute) };
  const work: Work[] = [
    item('GY-3446', { stage: 'done', ready: false }),
    item('GY-3440', { stage: 'review', ready: false, submission: { head: 'a'.repeat(40) }, sessions: [{ id: 'worker-a:1', kind: 'implementation', state: 'finished', principal: 'worker-a', host: 'stall-host', startedAt: at(start - 30 * minute), workTree: { at: at(start) } }] } as Partial<Work>),
    // Ready, claimable, but no worker account is free: launches are held by the credential probe.
    item('GY-3518'),
    // Ready, refused: its exclusive resource is held by an item in flight.
    item('GY-3501', { exclusiveResources: ['e2e/TIMINGS.md'] } as Partial<Work>),
    item('GY-3486', { stage: 'build', lease: { owner: 'worker-b', expiresAt: at(start + 24 * 60 * minute) }, exclusiveResources: ['e2e/TIMINGS.md'] } as Partial<Work>),
    // Ready, parked on a human decision.
    item('GY-3520', { humanRequest: { id: 'h1', kind: 'goals-and-priorities', reason: 'Which goal first?', needed: 'A choice', requestedBy: 'master', epoch: 0, at: at(start) } } as Partial<Work>),
  ];
  let now = start;
  const prompts: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: at(now) }),
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'idle' }],
    credentials: async () => ({ w1: { available: false, reason: 'held by the test' } }),
    closeSession: () => {}, persist: async () => {},
    dispatch: async () => { throw new Error('unexpected launch'); },
    servingCommit: () => null,
    masterSession: { wake: async (_target, text) => { prompts.push(text); }, launch: async () => ({ agentName: 'master', pane: 'pM', runtime: 'codex', account: 'a', session: 's' }) },
  };
  return { config, state, prompts, work, cycle: () => runCycle(config, state, effects, () => now), advance: (minutes: number) => { now += minutes * minute; } };
}

async function status(config: MasterConfig, state: DaemonState, work: Work[]) {
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('stall-cause-is-current-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'c'.repeat(40)}\n`;
  return masterStatusReport(root, config, (async (path: string) => path === 'work-snapshot' ? { work, now: new Date().toISOString() } : { messages: [] }) as any, run);
}

for (const proof of ['integration:stall-cause-is-current', 'e2e:stall-cause-is-current'])
test(`${proof} — a done item's launch failure and an expired back-off are deleted and never named; the alarm names each ready item's current gate`, async () => {
  const f = await fixture();
  await f.cycle();
  assert.deepEqual(f.state.launchBackoff, {}, 'the done item\'s entry and the expired entry are deleted the same cycle');
  assert.equal(f.state.actions[stallAlarmKey], undefined, 'no alarm before 10 minutes pass');
  f.advance(61);
  await f.cycle();
  const alarm = f.state.actions[stallAlarmKey]?.detail ?? '';
  assert.doesNotMatch(alarm, /done item failed|worktree|dispatch error/, 'neither old launch failure is a cause');
  assert.match(alarm, /Cause: GY-3518 waits: no free worker account/, 'the claimable item names the gate that refuses it');
  assert.match(alarm, /GY-3501 waits: exclusive resource e2e\/TIMINGS\.md is held by GY-3486/, 'the refused item names the resource and its holder');
  assert.doesNotMatch(alarm, /has no actor/, 'no ready item is reported as having no actor');
  assert.doesNotMatch(alarm, /GY-3520/, 'an item parked on a human request is not reported');
  const report = await status(f.config, f.state, f.work);
  assert.equal(Object.keys(report)[0], 'stallAlarm');
  assert.equal(report.stallAlarm, alarm, 'master status shows the current cause');
  assert.ok(f.prompts.some(prompt => prompt.includes('exclusive resource e2e/TIMINGS.md is held by GY-3486')), 'the master is woken with the current cause');
});
