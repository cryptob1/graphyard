import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';
import type { BaseRefresh } from '../src/merge-queue.js';
import { docsSyncSessionName, type DocsSyncPlan } from '../src/docs-sync.js';

/**
 * GY-1622. GY-1619's conflict on 4a3a78af0fc7 was first recorded at 00:45:17.921Z on 2026-10-10 and handed to
 * docs-sync session gy-docs-sync-gy-1619-4a3a78a, which held the rework decision until 00:53:17.921Z, the cutoff
 * ahead of the loop-owned rework's 10-minute bound. The session never moved the head, but the loop, having
 * nothing actionable, slept its 300s idle wait past that bound and requested the rework five minutes late. The
 * idle wait now ends at the earliest standing hold bound, so the cycle that releases the hold runs there.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const at = (time: string) => Date.parse(`2026-10-10T${time}Z`);
const iso = (ms: number) => new Date(ms).toISOString();
const interval = 300_000;
const head = '4a3a78af0fc7' + 'a'.repeat(28), bound = 'b'.repeat(40), tip = 'c'.repeat(40);
const since = '2026-10-10T00:45:17.921Z', holdBound = Date.parse('2026-10-10T00:53:17.921Z');
const paths = ['docs/setup-from-zero.md'];

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

/** GY-1619 as the board held it: submitted, unclaimed, its build gate failing on a docs-page conflict with the base tip. */
function gy1619(observedAt: number, systemDriven = true): Work {
  const candidate = { sha: head, baseSha: bound, pr: 1080, branch: 'graphyard/gy-1619-1', author: 'worker' };
  const conflict = `Candidate ${head.slice(0, 12)} cannot be brought onto base branch tip ${tip.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved`;
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, baseTip: tip, baseTipContained: false, conflicting: true,
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: false, merged: false, mergeSha: null,
    files: ['src/up.ts', ...paths], scopeFiles: [], at: iso(observedAt), prState: 'open', draft: false,
  } as unknown as Observation;
  const baseRefresh: BaseRefresh = { from: { sha: head, baseSha: bound }, base: tip, baseTree: 'e'.repeat(40), policyRevision: 3, at: since, head: null,
    conflict, merge: null, carry: null, trigger: 'conflict confirmed', conflictPaths: paths, conflictSince: since };
  return {
    id: '7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4a1619', key: 'GY-1619', title: 'A docs-page conflict', description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:up'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/up.ts', ...paths], stage: 'build', revision: 20, policyRevision: 3, createdAt: iso(at('00:00:00')), updatedAt: iso(observedAt),
    stageEnteredAt: since, ready: true, epoch: 3, lease: null, workspaces: [], submission: { epoch: 3, pr: 1080 }, systemDriven,
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, baseRefresh, blocker: null, violations: [],
    gates: [{ name: 'build', passed: false, reasons: [conflict] }, { name: 'merge', passed: false, reasons: ['Pull request is not mergeable against the current base'] }],
  } as Work;
}

/**
 * Runs the loop on a simulated clock with a 300s idle wait: each sleep advances the clock by the wait it was
 * given, and the loop is stopped after `cycles` cycles. `work` is the board as observed at a time: the snapshot
 * reads it ten seconds old, the step's woken observation one second after the cycle. Returns the cycle times, the waits and the decisions.
 */
async function replay(work: (observedAt: number) => Work[], start: number, cycles: number) {
  let now = start;
  const decided: { action: string; at: number }[] = [], agents: string[] = [], waits: number[] = [], ran: number[] = [], lines: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: agents.map((name, index) => ({ name, pane_id: `pane-${index}`, agent_status: 'working' })), available: true }),
    credentials: async () => ({}),
    snapshot: async () => { ran.push(now); return { work: work(now - 10_000), now: iso(now), jobs: [] }; },
    closeSession: () => { agents.length = 0; }, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work, action) => { decided.push({ action, at: now }); return { id: '5d8a8b9e-0000-4000-8000-000000001619' }; },
    decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'gy-approver-gy-1619', pane: 'pane-a' }),
    docsSync: async (_item: Work, plan: DocsSyncPlan) => { const name = docsSyncSessionName(plan); agents.push(name); return { agentName: name, pane: 'pane-s', account: 'reviewer-a', runtime: 'claude' as const, session: null }; },
    conflictPaths: async () => paths,
    // The step's woken reading, taken now: the docs-sync never moved the head.
    observe: async () => work(now + 1_000)[0],
    persist: async () => {},
  } as DaemonEffects;
  const listeners = new Map<string, () => void>();
  const host = { on: (signal: string, listener: () => void) => { listeners.set(signal, listener); return host; }, off: (signal: string) => { listeners.delete(signal); return host; } };
  const wake = { sleep: async (wait: number) => { waits.push(wait); now += wait; if (ran.length >= cycles) listeners.get('SIGUSR2')?.(); return []; } };
  await runDaemon(config(), emptyDaemonState(config()), effects, { intervalMs: interval, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], now: () => now,
    log: line => lines.push(line), process: host as never, wake, checkout: () => ({ root: '/coordinator', commit: null, modified: [], untracked: [] }) });
  return { ran, waits, decided, lines };
}

test('unit:loop-wakes-at-hold-bound — with a 300s idle wait, a docs-sync hold that ends sooner ends the wait at its bound, and the rework is requested in that cycle', async () => {
  const loop = await replay(observedAt => [gy1619(observedAt)], at('00:46:00'), 3);
  assert.deepEqual(loop.ran.map(iso), ['2026-10-10T00:46:00.000Z', '2026-10-10T00:51:00.000Z', iso(holdBound)],
    'the first wait is the full 300s (the bound is further off); the second ends at the bound, not at 00:56:00');
  assert.deepEqual(loop.waits.slice(0, 2), [interval, holdBound - at('00:51:00')]);
  assert.deepEqual(loop.decided.map(entry => [entry.action, iso(entry.at)]), [['rework', iso(holdBound)]], 'the conflict rework is requested in the cycle at the bound');
  assert.ok(loop.lines.some(line => line.includes(`at the docs-sync hold bound ${iso(holdBound)}`)), loop.lines.join('\n'));
});

test('unit:loop-wakes-at-hold-bound — with no hold pending, or one whose bound lies beyond the idle wait, the idle wait is unchanged', async () => {
  const idle = await replay(() => [], at('00:46:00'), 3);
  assert.deepEqual(idle.waits, [interval, interval, interval], 'no hold: the configured idle wait');
  assert.ok(!idle.lines.some(line => /hold bound/.test(line)));
  // A hand-driven item keeps the docs-sync's own 30-minute bound, far past one idle wait: each wait stays 300s.
  const far = await replay(observedAt => [gy1619(observedAt, false)], at('00:46:00'), 2);
  assert.deepEqual(far.waits, [interval, interval]);
  assert.ok(!far.lines.some(line => /hold bound/.test(line)));
  assert.deepEqual(far.decided, [], 'the hold still stands');
});
