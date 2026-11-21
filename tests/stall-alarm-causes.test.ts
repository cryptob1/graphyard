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
import type { AgentRegistry } from '../src/model/registry.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3432: free worker slots and ready work with no launch for 10 minutes raise one alarm line at
// the top of master status and wake the master, naming the cause: the last dispatch error (the
// 2026-11-16 loop-state save 500), launches waiting on CPU pressure, every worker account out of
// quota, the loop running older code than the served commit, or else the ready item with no actor.
// An open item with no change and no lease for an hour raises it too. Driven through the loop's own cycle.

const proof = 'integration:stall-alarm-causes';
const start = Date.parse('2026-11-16T08:00:00Z');
const minute = 60_000;
const served = 'b'.repeat(40), loaded = 'a'.repeat(40);

function ready(key = 'GY-1', updatedAt = new Date(start).toISOString()): Work {
  return { id: `id-${key}`, key, title: 'Ready work', stage: 'ready', ready: true, epoch: 0, revision: 1, policyRevision: 1, priority: 1, type: 'feature',
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:fixture'] }], dependencies: [], evidence: [], gates: [], workspaces: [], sessions: [], createdAt: updatedAt, updatedAt } as unknown as Work;
}

async function fixture(options: { work?: Work[]; launches?: boolean; dispatchTick?: () => Promise<void>; celsius?: number; pressure?: string; registry?: Pick<AgentRegistry, 'accounts' | 'roles'>; serving?: string } = {}) {
  const directory = await temporaryDirectory('stall-alarm');
  const profile = { name: 'w1', principal: 'worker-a', agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/stall', credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard', hostId: 'stall-host', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master', workers: [profile] });
  const state = emptyDaemonState(config);
  state.lock = { id: 'lock', pid: 1, host: 'stall-host', startedAt: new Date(start).toISOString(), heartbeatAt: new Date(start).toISOString() };
  state.release = { commit: loaded, dirty: false };
  let now = start, work = options.work ?? [ready()];
  const prompts: string[] = [], dispatched: string[] = [];
  const registry = options.registry ? { version: 1, revision: 1, updatedAt: null, runtimes: [], models: [], sessions: [], refusals: [], lastMutation: null, ...options.registry } as unknown as AgentRegistry : undefined;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'idle' }],
    // Launches are held — no worker credential — unless a test lets them start: each launch "starts" a running session.
    credentials: async () => ({ w1: options.launches ? { available: true, reason: null } : { available: false, reason: 'held by the test' } }),
    closeSession: () => {}, persist: async () => {},
    dispatch: async item => {
      dispatched.push(item.key);
      work = work.map(entry => entry.key === item.key ? { ...entry, stage: 'build', sessions: [{ id: 'worker-a:1', kind: 'implementation', state: 'running', principal: 'worker-a', host: 'stall-host', startedAt: new Date(now).toISOString() }] } as unknown as Work : entry);
      return { pane: 'p1', epoch: 1 };
    },
    ...(options.dispatchTick ? { dispatchTick: options.dispatchTick } : {}),
    ...(options.celsius !== undefined || options.pressure !== undefined ? { cpuPressure: async () => ({ pressure: options.pressure ?? null, stat: null, celsius: options.celsius ?? null }) } : {}),
    ...(registry ? { registry: async () => registry } : {}),
    servingCommit: () => options.serving ?? null,
    masterSession: { wake: async (_target, text) => { prompts.push(text); }, launch: async () => ({ agentName: 'master', pane: 'pM', runtime: 'codex', account: 'a', session: 's' }) },
  };
  return { config, state, prompts, dispatched, cycle: () => runCycle(config, state, effects, () => now), advance: (minutes: number) => { now += minutes * minute; },
    allow: () => { options.launches = true; } };
}

async function status(config: MasterConfig, state: DaemonState, work: Work[]) {
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('stall-alarm-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'c'.repeat(40)}\n`;
  return masterStatusReport(root, config, (async (path: string) => path === 'work-snapshot' ? { work, now: new Date().toISOString() } : { messages: [] }) as any, run);
}

/** Runs cycles across 11 minutes of held launches, and returns the alarm line, the master status report's first key and the master's prompts. */
const alarmOf = (state: DaemonState) => state.actions[stallAlarmKey]?.detail;
async function stalled(f: Awaited<ReturnType<typeof fixture>>, work: Work[] = [ready()]) {
  await f.cycle();
  assert.equal(alarmOf(f.state), undefined, 'no alarm before 10 minutes pass');
  f.advance(11);
  await f.cycle();
  const alarm = alarmOf(f.state);
  assert.ok(alarm, 'free capacity, ready work and no launch for 10 minutes raise the alarm');
  const report = await status(f.config, f.state, work);
  assert.equal(Object.keys(report)[0], 'stallAlarm', 'the alarm stands at the top of master status');
  assert.equal(report.stallAlarm, alarm);
  assert.ok(f.prompts.some(prompt => prompt.includes(alarm)), 'a master wake is queued with the alarm');
  return alarm;
}

test(`${proof} — the last dispatch error, today's loop-state save 500, is the named cause; the master is woken although the dispatch tick keeps failing`, async () => {
  let error = 'Loop state dispatch: 500 {"error":"internal","request":"1a2b3c4d"}';
  const f = Object.assign(await fixture({ dispatchTick: async () => { throw new Error(error); } }), { failWith: (next: string) => { error = next; } });
  const alarm = await stalled(f);
  assert.match(alarm, /no launch since 2026-11-16T08:00:00\.000Z/);
  assert.match(alarm, /last dispatch error: .*Loop state dispatch: 500/);
  const wakes = f.prompts.length;
  f.advance(1);
  await f.cycle();
  assert.equal(f.prompts.length, wakes, 'an unchanged alarm wakes the master once');
  // The alarm reads the dispatch error the cycle before recorded.
  f.failWith('Loop state dispatch: 500 {"error":"internal","request":"7f3a9c21"}');
  for (const _ of [1, 2]) { f.advance(1); await f.cycle(); }
  assert.match(alarmOf(f.state)!, /7f3a9c21/, 'the alarm keeps the error as it read');
  assert.equal(f.prompts.length, wakes, 'a new request id in the same error wakes nobody again');
});

test(`${proof} — launches waiting on CPU pressure are the named cause; a hot sensor is none`, async () => {
  const alarm = await stalled(await fixture({ pressure: 'some avg10=96.00 avg60=96.00 avg300=96.00 total=1\n' }));
  assert.match(alarm, /Cause: launches waiting: CPU pressure 96 percent/);
  assert.doesNotMatch(alarm, /heat|96C/, 'a hot sensor alone names no launch cause (GY-3501)');
});

test(`${proof} — every eligible worker account out of quota is the named cause`, async () => {
  const resets = new Date(start + 5 * 3_600_000).toISOString();
  const quota = { loggedIn: true, state: 'exhausted', usage: [], resetsAt: resets, reason: 'weekly limit', since: new Date(start).toISOString(), identity: null, observedAt: null, observedBy: null, source: 'probe' };
  const alarm = await stalled(await fixture({ registry: {
    accounts: [{ name: 'claude-a', enabled: true, quota }, { name: 'codex-b', enabled: true, quota }, { name: 'spare', enabled: false, quota: { ...quota, state: 'available' } }] as any,
    roles: [{ name: 'worker', accounts: ['claude-a', 'codex-b', 'spare'], concurrency: 2 }] as any,
  } }));
  assert.match(alarm, new RegExp(`every worker account is out of quota: claude-a \\(weekly limit; resets ${resets}\\), codex-b`));
});

test(`${proof} — the loop running older code than the serving commit is the named cause`, async () => {
  const alarm = await stalled(await fixture({ serving: served }));
  assert.match(alarm, new RegExp(`the loop runs ${loaded.slice(0, 12)}, older than the served ${served.slice(0, 12)}`));
});

test(`${proof} — with no other cause, the ready item with no actor is named; a launch clears the alarm`, async () => {
  const f = await fixture();
  const alarm = await stalled(f);
  assert.match(alarm, /Cause: GY-1 has no actor: ready, with no lease and no session/);
  f.allow();
  await f.cycle();
  assert.deepEqual(f.dispatched, ['GY-1']);
  await f.cycle();
  assert.equal(f.state.actions[stallAlarmKey], undefined, 'the alarm clears once a launch starts');
});

test(`${proof} — an item with no stage change and no lease for an hour raises it, even with no free slot`, async () => {
  const review = { ...ready('GY-3412', new Date(start - 2 * 3_600_000).toISOString()), stage: 'review', candidate: { sha: 'd'.repeat(40) } } as unknown as Work;
  const busy = { ...ready('GY-2'), stage: 'build', lease: { owner: 'worker-a', epoch: 1, expiresAt: new Date(start + 3_600_000).toISOString() },
    sessions: [{ id: 'worker-a:1', kind: 'implementation', state: 'running', principal: 'worker-a', host: 'stall-host', startedAt: new Date(start).toISOString() }] } as unknown as Work;
  const f = await fixture({ work: [review, busy] });
  await f.cycle();
  const alarm = f.state.actions[stallAlarmKey]?.detail ?? '';
  assert.match(alarm, /GY-3412 has no actor: at review with no lease and no session, unchanged since/);
  assert.doesNotMatch(alarm, /GY-2/, 'an item a worker holds has an actor');
  assert.ok(f.prompts.some(prompt => prompt.includes('GY-3412 has no actor')), 'the master is woken');
  assert.equal(Object.keys(await status(f.config, f.state, [review, busy]))[0], 'stallAlarm');
});

test(`${proof} — a healthy cycle stays quiet`, async () => {
  const f = await fixture({ launches: true });
  await f.cycle();
  f.advance(30);
  await f.cycle();
  assert.equal(f.state.actions[stallAlarmKey], undefined);
  assert.equal((await status(f.config, f.state, [])).stallAlarm, null);
});
