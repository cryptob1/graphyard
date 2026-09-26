import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';

// 2026-09-26: worker runtimes that exited left bare shells in their panes. Herdr detected no agent
// in them (status unknown), so the loop never closed them, while their agent names kept six of ten
// worker profiles out of every dispatch for hours.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const worktrees = '/repo/.graphyard/worktrees';

function item(key: string, lease: Work['lease'] = null): Work {
  return {
    id: `work-${key}`, key, title: 'Exited panes close', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Closed', proofs: ['unit:exited-worker-pane-closed'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: lease ? 'build' : 'review', revision: 4, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-3_600_000), ready: true, epoch: lease?.epoch ?? 4,
    lease, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}
const profile = (name: string, principal: string, agentName: string): WorkerProfile =>
  ({ name, principal, agentName, mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' }) as WorkerProfile;

function effects(work: Work[], agents: HerdrAgent[], closed: string[]): DaemonEffects {
  return {
    agents: () => agents.filter(agent => !closed.includes(agent.pane_id!)),
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso() }),
    closeSession: pane => { closed.push(pane); },
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({ result: 'merged', merged: true }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
  };
}

test('unit:exited-worker-pane-closed — a worker pane whose runtime exited is closed once it has stood agentless past the launch bound, unless its principal\'s live lease is worked in that worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-exited-pane-'));
  const credentials = await mkdtemp(join(tmpdir(), 'graphyard-exited-pane-credentials-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    // Two profiles share principal worker-b, as a real fleet's do: one works GY-2 live, the other's pane is a leftover.
    const config: MasterConfig = { ...await loadMasterConfig(root), workers: [
      profile('claude-primary', 'worker-a', 'graphyard-claude-1'), profile('cursor-primary', 'worker-b', 'graphyard-cursor-1'), profile('claude-quaternary', 'worker-b', 'graphyard-claude-4'),
    ] };
    const live = { owner: 'worker-b', epoch: 11, expiresAt: iso(600_000) } as Work['lease'];
    const work = [item('GY-1'), item('GY-2', live)];
    const agents: HerdrAgent[] = [
      // Exited: a bare shell in the worktree of an attempt that ended.
      { name: 'graphyard-claude-1', pane_id: 'pane-1', agent_status: 'unknown', cwd: `${worktrees}/GY-1-4` },
      // Exited too, though its principal holds a live lease — worked in another pane and worktree.
      { name: 'graphyard-cursor-1', pane_id: 'pane-2', agent_status: 'unknown', cwd: `${worktrees}/GY-9-3 (deleted)` },
      // The live worker of GY-2 under the same principal: never touched.
      { name: 'graphyard-claude-4', pane_id: 'pane-4', agent: 'claude', agent_status: 'working', cwd: `${worktrees}/GY-2-11` },
    ];
    const closed: string[] = [];
    const loop = effects(work, agents, closed), state = emptyDaemonState(config);

    // First sighting: a runtime that has not started yet looks the same, so nothing closes.
    await runCycle(config, state, loop, () => clock);
    assert.deepEqual(closed, [], 'an agentless pane is not closed on first sight');
    await runCycle(config, state, loop, () => clock + 60_000);
    assert.deepEqual(closed, [], 'nor inside the launch bound');

    // Past the bound, both leftovers close and the live worker stays.
    const result = await runCycle(config, state, loop, () => clock + 130_000);
    assert.deepEqual(closed.sort(), ['pane-1', 'pane-2']);
    assert.ok(result.actions.some(action => action.kind === 'close' && action.state === 'done' && /Closed finished session graphyard-claude-1 \(its runtime exited\)/.test(action.detail)));

    // An agentless pane standing in the worktree of its principal's live lease is that lease's session: kept.
    const kept: string[] = [];
    const worked: HerdrAgent[] = [{ name: 'graphyard-claude-4', pane_id: 'pane-5', agent_status: 'unknown', cwd: `${worktrees}/GY-2-11` }];
    const other = effects(work, worked, kept), fresh = emptyDaemonState(config);
    await runCycle(config, fresh, other, () => clock);
    await runCycle(config, fresh, other, () => clock + 130_000);
    assert.deepEqual(kept, [], 'the pane of a live lease is never closed as exited');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});
