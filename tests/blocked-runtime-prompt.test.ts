import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { assertDispatchable, masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-2959: a worker sat at OpenCode's "Access external directory" prompt that nobody would ever
// answer, holding its item under a live lease, while the loop's close step treated the session as
// healthy — Herdr reported the agent `blocked`, and the stall judge read only `idle`. The close
// step now answers a blocked session's runtime prompt once with its reject key, and one still
// blocked past the inactivity window ends as stalled naming the prompt: the pane closes, the lease
// releases, and the item dispatches again. A session that unblocks after the key is left alone.

const start = Date.parse('2030-04-01T00:00:00Z'), window = 10 * 60_000;
const iso = (at: number) => new Date(at).toISOString();
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const gates = (passed: string[]) => ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: passed.includes(name), reasons: [] }));
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:blocked-runtime-prompt-is-answered-or-ended'] }],
  policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - 60_000),
  ready: true, epoch: 1, workspaces: [], submission: null, candidate: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: null, blocker: null, violations: [], sessions: [], gates: gates(['ready', 'build']), stage: 'build', ...fields,
}) as unknown as Work;
const session = (pane: string, agentName: string) => ({
  id: 'worker-a:1', kind: 'implementation' as const, principal: 'worker-a', epoch: 1, runtime: 'opencode', host: 'machine-a', workspace: null, tab: null, pane, agentName,
  role: null, head: null, attach: null, transcript: null, subject: 'GY: blocked', startedAt: iso(start), updatedAt: iso(start), endedAt: null, state: 'running' as const, outcome: null,
});
const lease = { owner: 'worker-a', epoch: 1, expiresAt: iso(start + 3_600_000) };

/** The pane GY-98's worker stalled on, as OpenCode draws its external-directory permission dialog. */
const opencodePrompt = [
  'Reading GY-98 before editing.',
  '△ Permission required',
  'Access external directory /repo/.graphyard/gy98-bisect',
  '❯ 1. Allow once',
  '  2. Always allow',
  '  3. Reject',
].join('\n');

test('unit:blocked-runtime-prompt-is-answered-or-ended — the close step sends a blocked session its prompt\u2019s reject key once, ends one still blocked past the window as stalled naming the prompt (lease released, item dispatchable), and leaves one that unblocked alone', async () => {
  const blocked = item({ id: 'w1', key: 'GY-91', title: 'Blocked on the prompt', lease: { ...lease }, sessions: [session('pane-91', 'agent-91')] });
  const unblocked = item({ id: 'w2', key: 'GY-92', title: 'Unblocked after its key', lease: { ...lease }, sessions: [session('pane-92', 'agent-92')] });
  const work = [blocked, unblocked];
  const herdr = [
    { name: 'agent-91', pane_id: 'pane-91', agent_status: 'blocked' },
    { name: 'agent-92', pane_id: 'pane-92', agent_status: 'working' },
  ];
  const state = emptyDaemonState(config);
  // The unblocked session was answered once, long ago, and went back to work.
  state.actions['reject:w2:worker-a:1'] = { kind: 'wake', work: 'GY-92', principal: 'worker-a', state: 'done', detail: 'fixture', attempts: 1, cycle: 0, epoch: null, at: iso(start - 2 * window) };
  const keysSent: { pane: string | null; keys: string[] }[] = [], closed: string[] = [], prompted: string[] = [];
  const ends: { key: string; reason: string; notice: string | null }[] = [], recorded: { key: string; state: string; outcome: string | null }[] = [];
  const screens: Record<string, string> = { 'pane-91': opencodePrompt };
  let clock = start;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: iso(clock) }),
    agents: () => herdr as any[], herdr: () => ({ agents: herdr as any[], available: true }),
    credentials: async () => ({}),
    dispatch: async () => { throw new Error('the fixture launches nothing'); },
    closeSession: pane => { closed.push(pane); },
    recordSession: async (target, handle) => {
      recorded.push({ key: target.key, state: handle.state, outcome: handle.outcome ?? null });
      const live = work.find(entry => entry.id === target.id)!;
      live.sessions = (live.sessions ?? []).map(entry => entry.id === handle.id ? { ...entry, ...handle, state: handle.state } : entry);
    },
    promptSession: async () => { prompted.push('prompted'); },
    sessionScreen: target => screens[target.pane ?? ''] ?? null,
    sessionKeys: async (target, keys) => { keysSent.push({ pane: target.pane ?? null, keys }); },
    endStall: async (target, targetSession, stall) => {
      ends.push({ key: target.key, reason: stall.reason, notice: stall.notice?.reason ?? null });
      target.lease = null;
      targetSession.state = 'finished';
    },
    persist: async () => {},
  };

  // First sight of the block: the reject key goes out once, and the attempt keeps its lease.
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(keysSent, [{ pane: 'pane-91', keys: ['3'] }], 'the OpenCode permission prompt is answered with its Reject option');
  assert.equal(ends.length, 0, 'no blocked session is ended at first sight');
  assert.ok(blocked.lease, 'the answered attempt keeps its lease');
  assert.deepEqual(prompted, [], 'the stall re-prompt is not what answers a prompt');
  assert.equal(state.actions['reject:w1:worker-a:1']?.state, 'done', 'the answer is on the cursor');

  // Inside the window, still blocked: no second key, no end.
  clock = start + 60_000;
  await runCycle(config, state, effects, () => clock);
  assert.equal(keysSent.length, 1, 'the reject key is sent once, not every cycle');
  assert.equal(ends.length, 0);
  assert.ok(blocked.lease, 'the attempt still keeps its lease inside the window');

  // The unblocked session is left alone: no keys for it, no end, its cursor entry cleared for a new episode.
  assert.deepEqual(keysSent.filter(sent => sent.pane === 'pane-92'), []);
  assert.ok(!ends.some(end => end.key === 'GY-92'));
  assert.ok(!closed.includes('pane-92'));
  assert.equal(unblocked.lease?.owner, 'worker-a', 'the unblocked session keeps its lease');
  assert.equal(state.actions['reject:w2:worker-a:1'], undefined, 'a new blocked episode would get its own answer');
  assert.equal(unblocked.sessions?.[0]?.state, 'running');

  // Still blocked past the window: the attempt ends stalled naming the prompt, dispatchable again.
  clock = start + window + 60_000;
  await runCycle(config, state, effects, () => clock);
  assert.equal(keysSent.length, 1, 'still only the one key');
  assert.deepEqual(ends, [{ key: 'GY-91', reason: 'stalled at a runtime prompt: Reading GY-98 before editing. / △ Permission required / Access external directory /repo/.graphyard/gy98-bisect / 1. Allow once / 2. Always allow / 3. Reject', notice: null }]);
  assert.ok(closed.includes('pane-91'), 'the stalled session\u2019s pane is closed');
  assert.equal(blocked.lease, null, 'the stalled attempt\u2019s lease is released');
  assert.doesNotThrow(() => assertDispatchable(blocked, work, iso(clock)), 'the item is dispatchable again');
  assert.deepEqual(recorded, [{ key: 'GY-91', state: 'finished', outcome: ends[0].reason }], 'the session handle records the stall with the prompt text');
  assert.match(state.actions['close:w1:worker-a:1']?.detail ?? '', /stalled at a runtime prompt/);
});
