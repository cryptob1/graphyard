import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { stallAlarmKey } from '../src/daemon/stall-alarm.js';
import { batchGateFlights } from '../src/daemon/trial-slots.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3473: the stall alarm names the reason dispatch holds launches now — a running batch gate,
// CPU pressure, a launch refusal still backing off — never an expired launch failure an
// item recovered from, and an unexplained idle queue still alarms. Driven through the loop's cycle.

const proof = 'integration:stall-current-dispatch-cause';
const start = Date.parse('2026-11-18T07:00:00Z');
const minute = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const oldError = 'git worktree add .graphyard/worktrees/GY-3446-1 50ddae: fatal: could not create work tree';

function item(key: string, extra: Partial<Work> = {}): Work {
  return { id: `id-${key}`, key, title: key, stage: 'ready', ready: true, epoch: 0, revision: 1, policyRevision: 1, priority: 1, type: 'bug',
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:fixture'] }], dependencies: [], evidence: [], gates: [], workspaces: [], sessions: [], createdAt: at(start), updatedAt: at(start), ...extra } as unknown as Work;
}

/** GY-3446 failed to launch at 23:30 (backoff expired 23:45), then launched and finished; GY-1 is ready with a free slot. */
async function fixture(options: { celsius?: number; pressure?: string; credentialsHeld?: boolean } = {}) {
  const directory = await temporaryDirectory('stall-current-cause');
  const profile = { name: 'w1', principal: 'worker-a', agentName: 'agent-w1', mode: 'launch', kind: 'codex', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/stall', credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard', hostId: 'stall-host', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master', workers: [profile] });
  const state = emptyDaemonState(config);
  state.lock = { id: 'lock', pid: 1, host: 'stall-host', startedAt: at(start - 9 * 60 * minute), heartbeatAt: at(start) };
  state.launchBackoff['codex:id-GY-3446'] = { failures: 1, reason: oldError, until: at(start - 7 * 60 * minute - 15 * minute) };
  const recovered = item('GY-3446', { stage: 'review', ready: false, updatedAt: at(start),
    sessions: [{ id: 'worker-a:2', kind: 'implementation', state: 'finished', principal: 'worker-a', host: 'stall-host', startedAt: at(start - 30 * minute), workTree: { at: at(start - 5 * minute) } }] } as Partial<Work>);
  let now = start, work: Work[] = [recovered, item('GY-1')], launches = false;
  const prompts: string[] = [], dispatched: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: at(now) }),
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'idle' }],
    credentials: async () => ({ w1: options.credentialsHeld ? { available: false, reason: 'held by the test' } : { available: true, reason: null } }),
    closeSession: () => {}, persist: async () => {},
    dispatch: async target => {
      if (!launches) throw new Error('unexpected launch');
      dispatched.push(target.key);
      work = work.map(entry => entry.key === target.key ? { ...entry, stage: 'build', sessions: [{ id: 'worker-a:3', kind: 'implementation', state: 'running', principal: 'worker-a', host: 'stall-host', startedAt: at(now) }] } as unknown as Work : entry);
      return { pane: 'p1', epoch: 1 };
    },
    ...(options.celsius !== undefined || options.pressure !== undefined ? { cpuPressure: async () => ({ pressure: options.pressure ?? null, stat: null, celsius: options.celsius ?? null }) } : {}),
    servingCommit: () => null,
    masterSession: { wake: async (_target, text) => { prompts.push(text); }, launch: async () => ({ agentName: 'master', pane: 'pM', runtime: 'codex', account: 'a', session: 's' }) },
  };
  return { config, state, prompts, dispatched, work: () => work, cycle: () => runCycle(config, state, effects, () => now),
    advance: (minutes: number) => { now += minutes * minute; }, allow: () => { launches = true; } };
}

async function status(config: MasterConfig, state: DaemonState, work: Work[]) {
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('stall-current-cause-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'c'.repeat(40)}\n`;
  return masterStatusReport(root, config, (async (path: string) => path === 'work-snapshot' ? { work, now: new Date().toISOString() } : { messages: [] }) as any, run);
}

const alarmOf = (state: DaemonState) => state.actions[stallAlarmKey]?.detail;
const holdGate = (state: DaemonState) => batchGateFlights.set(state, { gate: new Promise<void>(() => {}), diagnostics: null });
const endGate = (state: DaemonState) => batchGateFlights.set(state, { gate: null, diagnostics: null });

test(`${proof} — a running batch gate is the named cause, not the expired worktree failure; status shows it and it clears once dispatch resumes`, async () => {
  const f = await fixture();
  holdGate(f.state);
  await f.cycle();
  assert.equal(alarmOf(f.state), undefined, 'no alarm before 10 minutes pass');
  f.advance(11);
  await f.cycle();
  const alarm = alarmOf(f.state)!;
  assert.match(alarm, /GY-1/);
  assert.match(alarm, /Cause: implementation launches paused while the batch gate runs/);
  assert.doesNotMatch(alarm, /worktree|50ddae|dispatch error/, 'an expired launch failure is not the cause');
  const report = await status(f.config, f.state, f.work());
  assert.equal(Object.keys(report)[0], 'stallAlarm');
  assert.equal(report.stallAlarm, alarm, 'master status names the current hold');
  assert.ok(f.prompts.some(prompt => prompt.includes('batch gate runs')), 'the master is woken with the current cause');
  endGate(f.state);
  f.allow();
  f.advance(1);
  await f.cycle();
  assert.deepEqual(f.dispatched, ['GY-1'], 'dispatch resumes once the gate settles');
  await f.cycle();
  assert.equal(alarmOf(f.state), undefined, 'the alarm clears after dispatch resumes');
  assert.equal((await status(f.config, f.state, f.work())).stallAlarm, null);
});

test(`${proof} — the pressure hold is the named cause`, async () => {
  const f = await fixture({ pressure: 'some avg10=90.00 avg60=90.00 avg300=90.00 total=1\n' });
  await f.cycle();
  f.advance(11);
  await f.cycle();
  const alarm = alarmOf(f.state)!;
  assert.match(alarm, /Cause: launches waiting: CPU pressure 90 percent/);
  assert.doesNotMatch(alarm, /worktree|50ddae|heat|85C/);
});

test(`${proof} — a hot sensor holds no launch, so it is never the stall cause`, async () => {
  const f = await fixture({ celsius: 96 });
  f.allow();
  await f.cycle();
  assert.deepEqual(f.dispatched, ['GY-1'], 'a CPU at 96C launches the worker');
  f.advance(11);
  await f.cycle();
  assert.equal(alarmOf(f.state), undefined, 'no alarm: the work moved');
});

test(`${proof} — a launch refusal still backing off stays visible`, async () => {
  const f = await fixture();
  f.state.launchBackoff['codex:id-GY-1'] = { failures: 2, reason: 'codex exited 1: not logged in', until: at(start + 30 * minute) };
  await f.cycle();
  f.advance(11);
  await f.cycle();
  const alarm = alarmOf(f.state)!;
  assert.match(alarm, /last dispatch error: codex exited 1: not logged in \(launches back off until 2026-11-18T07:30:00\.000Z\)/);
  assert.doesNotMatch(alarm, /50ddae/, 'the expired failure is still not named');
});

test(`${proof} — an unexplained idle queue still alarms, naming the item with no actor`, async () => {
  const f = await fixture({ credentialsHeld: true });
  await f.cycle();
  f.advance(11);
  await f.cycle();
  const alarm = alarmOf(f.state)!;
  assert.match(alarm, /Cause: GY-1 has no actor: ready, with no lease and no session/);
  assert.doesNotMatch(alarm, /50ddae/);
});
