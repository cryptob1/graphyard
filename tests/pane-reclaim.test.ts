import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { approvalWatchSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { agentlessPaneAttentionBound, paneReclaimStatus } from '../src/master-resources.js';
import type { SessionHandle } from '../src/model/sessions.js';
import type { Work } from '../src/model.js';

// GY-842: every pane Graphyard launches is closed when its session ends, and leftover agentless
// panes are reclaimed. 2026-09-26: Herdr held 621 panes, 584 of them Graphyard's with no agent —
// sessions were closed in the ledger ('vanished', 'closed by the loop') while their panes stood
// on as bare shells — and the host throttled under them.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const worktrees = '/repo/.graphyard/worktrees';

function item(key: string, overrides: Partial<Work> = {}, sessions: SessionHandle[] = []): Work {
  return {
    id: `work-${key}`, key, title: 'Panes are reclaimed', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Closed', proofs: ['unit:pane-reclaimed'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'review', revision: 4, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 4,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides, sessions,
  } as unknown as Work;
}
const profile = (name: string, principal: string, agentName: string): WorkerProfile =>
  ({ name, principal, agentName, mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' }) as WorkerProfile;
/** A session handle with the fields the loop reads; the rest is the schema's business, not these tests'. */
const handle = (overrides: Partial<SessionHandle> & Pick<SessionHandle, 'id' | 'kind'>): SessionHandle => ({
  principal: 'worker-a', epoch: null, runtime: 'claude', host: 'machine-a', workspace: null, tab: null, pane: null, agentName: null, role: null, head: null,
  attach: null, transcript: null, subject: 'session', startedAt: iso(-600_000), updatedAt: iso(-600_000), endedAt: null, state: 'running', outcome: null, ...overrides,
});
/** A limit notice, as a stopped runtime prints it (model/capacity.ts). */
const limitNotice = 'Error: weekly usage limit reached. Your usage resets at 17:00.';

function effects(work: Work[], agents: HerdrAgent[], closed: string[], extra: Partial<DaemonEffects> = {}, at: number = clock): DaemonEffects {
  return {
    agents: () => agents,
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: new Date(at).toISOString() }),
    closeSession: pane => { if (!closed.includes(pane)) closed.push(pane); },
    herdr: async () => ({ agents, available: true }),
    persist: async () => {},
    recordSession: async () => {},
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({ result: 'merged', merged: true }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    ...extra,
  } as DaemonEffects;
}

async function master(workers: WorkerProfile[]): Promise<{ root: string; credentials: string; config: MasterConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-pane-reclaim-'));
  const credentials = await mkdtemp(join(tmpdir(), 'graphyard-pane-reclaim-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const config = { ...await loadMasterConfig(root), workers } as MasterConfig;
  return { root, credentials, config };
}

test('unit:session-end-closes-pane — a session of every role the loop ends has its pane closed in the same step, exactly once', async () => {
  const { root, credentials, config } = await master([profile('claude-primary', 'worker-a', 'graphyard-claude-1')]);
  try {
    const decision = 'dec-123';
    const watch = approvalWatchSchema.parse({ work: 'GY-4', action: 'rework', decision, requestedAt: iso(-3_600_000), launchedAt: iso(-1_800_000),
      launches: 1, requests: 1, agentName: 'graphyard-approver-gy-4-a1b2', pane: 'pane-approver' });
    const work = [
      // The worker: its item left build, the stage the attempt was launched for, so the loop ends
      // the implementation session ('closed by the loop') — and must close its pane with it.
      item('GY-1', { stage: 'review' }, [handle({ id: 'worker-a:4', kind: 'implementation', principal: 'worker-a', epoch: 4, pane: 'pane-worker', agentName: 'graphyard-claude-1', host: config.hostId ?? 'machine-a' })]),
      // The reviewer and the producer: sessions stopped on their provider's limit notice are ended
      // on their ledgers, and their panes go with them.
      item('GY-2'), item('GY-3'),
      // The approver: its watch's decision is withdrawn (the item moved past it), so the session is closed.
      item('GY-4', { stage: 'ready' }),
      // The escalation handler: Herdr no longer lists it, so it is ended like a spent one.
      item('GY-5'),
    ];
    const agents: HerdrAgent[] = [
      { name: 'reviewer-a', pane_id: 'pane-review', agent: 'claude', agent_status: 'idle' },
      { name: 'producer-a', pane_id: 'pane-produce', agent: 'codex', agent_status: 'blocked' },
      { name: watch.agentName!, pane_id: 'pane-approver', agent: 'claude', agent_status: 'idle' },
    ];
    const closed: string[] = [];
    const loop = effects(work, agents, closed, {
      launchedSessions: async () => [
        { role: 'reviewer' as const, record: 'rev-1', profile: 'reviewer-a', agentName: 'reviewer-a', pane: 'pane-review', work: 'GY-2', requestId: null },
        { role: 'producer' as const, record: 'prod-1', profile: 'producer-a', agentName: 'producer-a', pane: 'pane-produce', work: 'GY-3', requestId: 'req-3' },
      ],
      sessionOutput: async () => limitNotice,
      reportCapacity: async () => work[0],
      endSession: async session => { if (session.pane && !closed.includes(session.pane)) closed.push(session.pane); },
      escalationSessions: async () => [{ agentName: 'graphyard-escalation-gy-5', pane: 'pane-escalation', work: 'GY-5', trigger: 'review-unavailable', kind: 'claude', account: null, runtime: 'claude', launchedAt: iso(-3_600_000), session: null, waiting: null }],
      endEscalation: async session => { if (session.pane && !closed.includes(session.pane)) closed.push(session.pane); },
      decisions: async () => ({ decisions: [{ id: decision, action: 'rework', state: 'requested', input: null, approvedBy: null, precedent: [] }] }),
      withdraw: async () => ({}),
    }), state = emptyDaemonState(config);
    state.approvals['decision:rework:work-GY-4:binding:1'] = watch;
    // Research and triage runs open no pane at all — they are headless (src/runner/registry.ts) —
    // so they have none to record and none to close.
    await runCycle(config, state, loop, () => clock);
    assert.deepEqual(closed.sort(), ['pane-approver', 'pane-escalation', 'pane-produce', 'pane-review', 'pane-worker'],
      'the pane of every ended session is closed, each exactly once');
    // The worker's close is the loop's own 1g step, recorded with the pane named.
    const actions = Object.values(state.actions);
    assert.ok(actions.some(action => action.kind === 'close' && action.state === 'done' && /Closed implementation session .*pane-worker.* pane pane-worker closed/.test(action.detail)),
      'the implementation session is closed by the loop with its pane, on the record');
    // No pane went through the backstop sweep here: each close belonged to the step that ended its session.
    assert.ok(!Object.keys(state.actions).some(key => key.startsWith('sweep:pane:')), 'the sweep closes nothing a session-end step did not leave behind');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});

test('unit:agentless-pane-sweep — the sweep closes only the agentless panes Graphyard launched whose session ended or whose worktree is gone, bounded per pass', async () => {
  const { root, credentials, config } = await master([profile('claude-primary', 'worker-b', 'graphyard-claude-1')]);
  try {
    const live = { owner: 'worker-b', epoch: 3, expiresAt: iso(600_000) } as Work['lease'];
    const bulk = Array.from({ length: 8 }, (_, index) =>
      item(`GY-${10 + index}`, {}, [handle({ id: `rev-bulk-${index}`, kind: 'review', pane: `pane-bulk-${index}`, state: 'finished' })]));
    const work = [
      // Launched and ended: a review session whose record is finished and whose pane holds a bare shell.
      item('GY-1', {}, [handle({ id: 'rev-1', kind: 'review', pane: 'pane-ended', state: 'finished' })]),
      // Live: the pane stands in the worktree of GY-2's live lease — it is that lease's, never the sweep's.
      item('GY-2', { stage: 'build', lease: live }, [handle({ id: 'worker-b:2', kind: 'implementation', principal: 'worker-b', epoch: 2, state: 'finished', pane: 'pane-live-lease' })]),
      // Its worktree no longer exists, while its session record still says running: closable all the same.
      item('GY-3', { stage: 'build' }, [handle({ id: 'proof-1', kind: 'proof', pane: 'pane-deleted' })]),
      // Fresh: its runtime is still on screen in the first cycle and only exits before the second.
      item('GY-4', {}, [handle({ id: 'rev-2', kind: 'review', pane: 'pane-fresh', state: 'finished' })]),
      // A finished session whose pane still holds its agent (idle at a prompt): never the sweep's.
      item('GY-5', {}, [handle({ id: 'rev-3', kind: 'review', pane: 'pane-live-agent', state: 'finished' })]),
      ...bulk,
    ];
    const agentsAt = (freshAgentless: boolean): HerdrAgent[] => [
      { name: 'graphyard-reviewer-0', pane_id: 'pane-ended', agent_status: 'unknown', cwd: `${worktrees}/GY-1-4` },
      { name: 'graphyard-cursor-1', pane_id: 'pane-live-lease', agent_status: 'unknown', cwd: `${worktrees}/GY-2-3` },
      { name: 'graphyard-producer-1', pane_id: 'pane-deleted', agent_status: 'unknown', cwd: `${worktrees}/GY-3-1 (deleted)` },
      { name: 'graphyard-reviewer-3', pane_id: 'pane-live-agent', agent: 'claude', agent_status: 'idle', cwd: `${worktrees}/GY-5-4` },
      // A pane Graphyard never launched: the operator's own shell. Never recorded, never closed.
      { name: 'operator-shell', pane_id: 'pane-foreign', agent_status: 'unknown', cwd: '/home/vish' },
      ...bulk.map((_, index) => ({ name: `graphyard-reviewer-${10 + index}`, pane_id: `pane-bulk-${index}`, agent_status: 'unknown', cwd: `${worktrees}/GY-${10 + index}-1` })),
      freshAgentless ? { name: 'graphyard-reviewer-2', pane_id: 'pane-fresh', agent_status: 'unknown', cwd: `${worktrees}/GY-4-4` }
        : { name: 'graphyard-reviewer-2', pane_id: 'pane-fresh', agent: 'codex', agent_status: 'working', cwd: `${worktrees}/GY-4-4` },
    ];
    const panes: string[] = ['pane-ended', 'pane-live-lease', 'pane-deleted', 'pane-fresh', 'pane-live-agent', 'pane-foreign', ...bulk.map((_, index) => `pane-bulk-${index}`)];
    const closed: string[] = [], panesEffect: Partial<DaemonEffects> = { panes: async () => ({ panes: panes.map(pane => ({ pane_id: pane })), available: true }) };
    const state = emptyDaemonState(config);
    // First sighting: a runtime that has not started yet looks the same, so nothing closes.
    await runCycle(config, state, effects(work, agentsAt(false), closed, panesEffect), () => clock);
    assert.deepEqual(closed, [], 'an agentless launched pane is not closed on first sight');
    const loop = effects(work, agentsAt(false), closed, panesEffect, clock + 60_000);
    // Inside the launch bound nothing closes yet.
    await runCycle(config, state, loop, () => clock + 60_000);
    assert.deepEqual(closed, [], 'nothing closes within the launch bound of its sighting');
    // The fresh pane's runtime exits now: its own bound starts here.
    const freshLoop = effects(work, agentsAt(true), closed, panesEffect, clock + 130_000);
    await runCycle(config, state, freshLoop, () => clock + 130_000);
    assert.deepEqual(closed, [], 'nor has the fresh pane stood agentless past it');
    await runCycle(config, state, freshLoop, () => clock + 260_000);
    const firstPass: string[] = [...closed];
    assert.ok(firstPass.includes('pane-ended') && firstPass.includes('pane-deleted'), 'the ended launched panes close');
    assert.equal(firstPass.length, 6, 'the pass is bounded at six closes');
    assert.ok(!firstPass.includes('pane-fresh'), 'the fresh pane was only just seen agentless');
    assert.ok(!firstPass.includes('pane-live-lease') && !firstPass.includes('pane-live-agent') && !firstPass.includes('pane-foreign'),
      'a pane whose worktree holds a live lease, a pane with an agent, and a pane Graphyard did not launch never close');
    // The rest of the backlog drains on the next cycle, the fresh pane with it.
    await runCycle(config, state, freshLoop, () => clock + 390_000);
    assert.deepEqual(closed.filter(pane => pane === 'pane-ended').length, 1, 'a pane is closed exactly once');
    assert.deepEqual([...new Set(closed)].sort(), panes.filter(pane => !['pane-live-lease', 'pane-live-agent', 'pane-foreign'].includes(pane)).sort(),
      'every ended launched pane closes across passes, and nothing else ever does');
    // The host's counts are on the record for master status to show.
    const status = state.actions['sweep:panes:status'];
    assert.ok(status && /Pane sweep: Herdr reports 14 pane\(s\) on this host, 13 opened by Graphyard launch\(es\)/.test(status.detail), `the counts are recorded (${status?.detail})`);
    assert.match(status!.detail, /standing agentless/, 'the agentless count is recorded');
    assert.ok(!state.actions['sweep:panes:attention'], 'no attention under the bound');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});

test('unit:pane-count-attention — master status counts the host\'s panes, the agentless Graphyard ones and the oldest, and raises attention past twenty', () => {
  const paneList = (count: number) => [
    ...Array.from({ length: 22 }, (_, index) => ({ pane_id: `pane-a-${index}` })),
    { pane_id: 'pane-live' },
    ...Array.from({ length: Math.max(0, count - 23) }, (_, index) => ({ pane_id: `pane-foreign-${index}` })),
  ];
  const recorded = (agentless: number, withAgent: number, closed: number) => {
    const items: Work[] = [];
    for (let index = 0; index < agentless; index++) items.push(item(`GY-A${index}`, {}, [handle({ id: `h-a${index}`, kind: 'review', pane: `pane-a-${index}`, startedAt: iso(-3_600_000 + index * 1_000) })]));
    for (let index = 0; index < withAgent; index++) items.push(item(`GY-B${index}`, {}, [handle({ id: `h-b${index}`, kind: 'proof', pane: 'pane-live' })]));
    for (let index = 0; index < closed; index++) items.push(item(`GY-C${index}`, {}, [handle({ id: `h-c${index}`, kind: 'review', pane: `gone-${index}` })]));
    return items;
  };
  const agents = [{ name: 'graphyard-reviewer-x', pane_id: 'pane-live', agent: 'claude', agent_status: 'idle' }, { name: 'operator-shell', pane_id: 'pane-foreign-99', agent_status: 'unknown' }];

  // The counts: every pane the host reports, the ones Graphyard launched, the agentless among
  // them, and the oldest by the launch its session recorded. A pane Graphyard never launched, and
  // a recorded pane the runtime no longer holds, count for neither.
  const below = paneReclaimStatus(paneList(30), recorded(18, 1, 2), agents, clock);
  assert.deepEqual({ panes: below.panes, launched: below.launched, agentless: below.agentless }, { panes: 30, launched: 21, agentless: 18 });
  assert.deepEqual(below.oldest, { pane: 'pane-a-0', work: 'GY-A0', kind: 'review', launchedAt: iso(-3_600_000) });
  assert.equal(below.attention, null, 'no attention under the bound');

  const over = paneReclaimStatus(paneList(30), recorded(agentlessPaneAttentionBound + 2, 1, 2), agents, clock);
  assert.equal(over.agentless, agentlessPaneAttentionBound + 2);
  assert.ok(over.attention, 'attention rises past the bound');
  assert.match(over.attention!.text, new RegExp(`${agentlessPaneAttentionBound + 2} of the panes Graphyard launched stand agentless \\(past the ${agentlessPaneAttentionBound}-pane attention bound\\)`));
  assert.match(over.attention!.text, /the oldest pane pane-a-0 of GY-A0 \(review\), launched /, 'the oldest agentless pane is named');
  assert.match(over.attention!.text, /Herdr holds 30 pane\(s\) on this host/, 'the host pane count is on the item');
  assert.equal(over.attention!.next, 'the loop sweeps them itself, a bounded number per cycle, once agentless past its launch bound; graphyard master run --once runs a pass now');

  // A runtime that cannot be read: the pane count is unknown, and an agentless reading is still
  // made from the agent inventory, which lists a session's pane while the pane stands.
  const unreadable = paneReclaimStatus(null, recorded(2, 0, 0), [{ name: 'graphyard-reviewer-1', pane_id: 'pane-a-0', agent_status: 'unknown' }, { name: 'graphyard-reviewer-2', pane_id: 'pane-a-1', agent_status: 'unknown' }], clock);
  assert.equal(unreadable.panes, null);
  assert.deepEqual({ launched: unreadable.launched, agentless: unreadable.agentless }, { launched: 2, agentless: 2 });
});
