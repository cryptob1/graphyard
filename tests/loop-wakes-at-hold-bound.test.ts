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
function gy1619(observedAt: number, systemDriven = true, { key = 'GY-1619', id = '7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4a1619', conflictSince = since } = {}): Work {
  const candidate = { sha: head, baseSha: bound, pr: 1080, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const conflict = `Candidate ${head.slice(0, 12)} cannot be brought onto base branch tip ${tip.slice(0, 12)} without resolving a conflict, which is content nobody reviewed or proved`;
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, baseTip: tip, baseTipContained: false, conflicting: true,
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: false, merged: false, mergeSha: null,
    files: ['src/up.ts', ...paths], scopeFiles: [], at: iso(observedAt), prState: 'open', draft: false,
  } as unknown as Observation;
  const baseRefresh: BaseRefresh = { from: { sha: head, baseSha: bound }, base: tip, baseTree: 'e'.repeat(40), policyRevision: 3, at: conflictSince, head: null,
    conflict, merge: null, carry: null, trigger: 'conflict confirmed', conflictPaths: paths, conflictSince };
  return {
    id, key, title: 'A docs-page conflict', description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:up'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/up.ts', ...paths], stage: 'build', revision: 20, policyRevision: 3, createdAt: iso(at('00:00:00')), updatedAt: iso(observedAt),
    stageEnteredAt: conflictSince, ready: true, epoch: 3, lease: null, workspaces: [], submission: { epoch: 3, pr: 1080 }, systemDriven,
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, baseRefresh, blocker: null, violations: [],
    gates: [{ name: 'build', passed: false, reasons: [conflict] }, { name: 'merge', passed: false, reasons: ['Pull request is not mergeable against the current base'] }],
  } as Work;
}

/**
 * Runs the loop on a simulated clock with a 300s idle wait: each sleep advances the clock by the wait it was
 * given, and the loop is stopped after `cycles` cycles. `work` is the board as observed at a time: the snapshot
 * reads it ten seconds old, the step's woken observation one second after the cycle. `decideMs` is how long each
 * rework request takes, `guardMs` how long the checkout guard spends between cycles, `workMs` how long each cycle's
 * work takes after its snapshot was read, and `skewMs` how far the control plane's clock runs ahead of this host's
 * (the board's times are control-plane times). Returns the cycle times, the waits and the decisions, on this host's clock.
 */
async function replay(work: (observedAt: number) => Work[], start: number, cycles: number, { decideMs = 0, guardMs = 0, workMs = 0, skewMs = 0 } = {}) {
  let now = start, worked = 0;
  const decided: { key: string; action: string; at: number }[] = [], agents: string[] = [], waits: number[] = [], ran: number[] = [], lines: string[] = [];
  const effects: DaemonEffects = {
    agents: () => { if (worked < ran.length) { worked = ran.length; now += workMs; } return []; }, herdr: () => ({ agents: agents.map((name, index) => ({ name, pane_id: `pane-${index}`, agent_status: 'working' })), available: true }),
    credentials: async () => ({}),
    snapshot: async () => { ran.push(now); return { work: work(now + skewMs - 10_000), now: iso(now + skewMs), jobs: [] }; },
    closeSession: () => { agents.length = 0; }, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (subject, action) => { decided.push({ key: subject.key, action, at: now }); now += decideMs; return { id: '5d8a8b9e-0000-4000-8000-000000001619' }; },
    decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'gy-approver-gy-1619', pane: 'pane-a' }),
    docsSync: async (_item: Work, plan: DocsSyncPlan) => { const name = docsSyncSessionName(plan); agents.push(name); return { agentName: name, pane: 'pane-s', account: 'reviewer-a', runtime: 'claude' as const, session: null }; },
    conflictPaths: async () => paths,
    // The step's woken reading, taken now: the docs-sync never moved the head.
    observe: async (subject: Work) => work(now + skewMs + 1_000).find(entry => entry.id === subject.id) ?? null,
    persist: async () => {},
  } as DaemonEffects;
  const listeners = new Map<string, () => void>();
  const host = { on: (signal: string, listener: () => void) => { listeners.set(signal, listener); return host; }, off: (signal: string) => { listeners.delete(signal); return host; } };
  const wake = { sleep: async (wait: number) => { waits.push(wait); now += wait; if (ran.length >= cycles) listeners.get('SIGUSR2')?.(); return []; } };
  await runDaemon(config(), emptyDaemonState(config()), effects, { intervalMs: interval, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], now: () => now,
    log: line => lines.push(line), process: host as never, wake, checkout: () => { if (ran.length) now += guardMs; return { root: '/coordinator', commit: null, modified: [], untracked: [] }; } });
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
  // A hand-driven item keeps the docs-sync session's own bound, 00:56:00 for one launched at 00:46:00, two idle waits off: the wait stays 300s.
  const far = await replay(observedAt => [gy1619(observedAt, false)], at('00:46:00'), 1);
  assert.deepEqual(far.waits, [interval]);
  assert.ok(!far.lines.some(line => /hold bound/.test(line)), far.lines.join('\n'));
  assert.deepEqual(far.decided, [], 'the hold still stands');
});

test('unit:loop-wakes-at-hold-bound — a held item the decisions step put off on its budget keeps its bound, so the idle wait still ends there', async () => {
  // GY-1619 is held until 00:48:00 and GY-1620 until 00:49:15. At 00:48:00 GY-1619's rework request takes 60s,
  // past the step's 30s budget, so GY-1620 is put off unreached: its standing bound still ends the wait after that cycle.
  // Item ids of their own: the step's observation waker throttles wakes per item id across the process.
  const first = { key: 'GY-1619', id: '7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4b1619', conflictSince: '2026-10-10T00:40:00.000Z' };
  const second = { key: 'GY-1620', id: '7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4b1620', conflictSince: '2026-10-10T00:41:15.000Z' };
  const board = (observedAt: number) => [gy1619(observedAt, true, first), gy1619(observedAt, true, second)];
  const loop = await replay(board, at('00:46:00'), 3, { decideMs: 60_000 });
  assert.deepEqual(loop.ran.map(iso), ['2026-10-10T00:46:00.000Z', '2026-10-10T00:48:00.000Z', '2026-10-10T00:49:15.000Z'], loop.lines.join('\n'));
  assert.deepEqual(loop.decided.map(entry => [entry.key, entry.action, iso(entry.at)]), [['GY-1619', 'rework', '2026-10-10T00:48:00.000Z'], ['GY-1620', 'rework', '2026-10-10T00:49:15.000Z']]);
  assert.equal(loop.waits[1], at('00:49:15') - at('00:49:00'), 'the wait after the budget-bound cycle ends at the put-off item\'s bound, sooner than the 30s actionable cadence');
  assert.ok(loop.lines.some(line => line.includes('at the docs-sync hold bound 2026-10-10T00:49:15.000Z')), loop.lines.join('\n'));
});

test('unit:loop-wakes-at-hold-bound — time the checkout guard spends between cycles comes off a wait that ends at a hold bound', async () => {
  const own = { key: 'GY-1619', id: '7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4c1619', conflictSince: since };
  const loop = await replay(observedAt => [gy1619(observedAt, true, own)], at('00:46:00'), 3, { guardMs: 20_000 });
  assert.deepEqual(loop.ran.map(iso), ['2026-10-10T00:46:00.000Z', '2026-10-10T00:51:20.000Z', iso(holdBound)],
    'the idle wait is the full 300s after the guard; the wait to the bound is shortened by the 20s the guard took');
  assert.deepEqual(loop.waits.slice(0, 2), [interval, holdBound - at('00:51:40')]);
  assert.deepEqual(loop.decided.map(entry => [entry.action, iso(entry.at)]), [['rework', iso(holdBound)]], loop.lines.join('\n'));
});

test('unit:loop-wakes-at-hold-bound — a bound exactly one idle wait away still ends the sleep at it, after the checkout guard took its time', async () => {
  const own = { key: 'GY-1619', id: '7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4e1619', conflictSince: since };
  const loop = await replay(observedAt => [gy1619(observedAt, true, own)], holdBound - interval, 2, { guardMs: 20_000 });
  assert.deepEqual(loop.ran.map(iso), [iso(holdBound - interval), iso(holdBound)], `the cycle runs at the bound, not 20s past it\n${loop.lines.join('\n')}`);
  assert.equal(loop.waits[0], interval - 20_000, 'the guard\'s 20s comes off the wait to the bound');
  assert.deepEqual(loop.decided.map(entry => [entry.action, iso(entry.at)]), [['rework', iso(holdBound)]], loop.lines.join('\n'));
});

test('unit:loop-wakes-at-hold-bound — a bound just beyond the idle wait still ends the sleep at it when the checkout guard takes the difference', async () => {
  // A 300s idle wait, the bound 360s after the cycle, and 120s of guard work: the sleep left is 240s, so the cycle runs at the bound, not at 420s.
  const own = { key: 'GY-1619', id: '7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4f1619', conflictSince: since };
  const loop = await replay(observedAt => [gy1619(observedAt, true, own)], holdBound - 360_000, 2, { guardMs: 120_000 });
  assert.deepEqual(loop.ran.map(iso), [iso(holdBound - 360_000), iso(holdBound)], `the cycle runs at the bound, not 60s past it\n${loop.lines.join('\n')}`);
  assert.equal(loop.waits[0], 240_000, 'the sleep after the guard is capped at the bound');
  assert.deepEqual(loop.decided.map(entry => [entry.action, iso(entry.at)]), [['rework', iso(holdBound)]], loop.lines.join('\n'));
});

test('unit:loop-wakes-at-hold-bound — a bound the cycle\'s own work carries the local clock past, while the hold still stood when the step read it, ends the wait at once', async () => {
  // The cycle starts at 00:53:15, before the 00:53:17.921 bound, so the step still finds the hold standing; its
  // work takes 5s, past the bound. The next cycle runs straight away and requests the rework, not 300s later.
  const own = { key: 'GY-1619', id: '7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4d1619', conflictSince: since };
  const loop = await replay(observedAt => [gy1619(observedAt, true, own)], at('00:53:15'), 2, { workMs: 5_000 });
  assert.deepEqual(loop.ran.map(iso), ['2026-10-10T00:53:15.000Z', '2026-10-10T00:53:20.000Z'], loop.lines.join('\n'));
  assert.equal(loop.waits[0], 0, 'the elapsed standing bound is a zero wait');
  assert.deepEqual(loop.decided.map(entry => [entry.action, iso(entry.at)]), [['rework', '2026-10-10T00:53:25.000Z']], loop.lines.join('\n'));
});

test('unit:loop-wakes-at-hold-bound — the control plane\'s bound is translated to this host\'s clock, whichever way the clocks differ', async () => {
  for (const skewMs of [60_000, -60_000]) {
    // The control plane's clock reads skewMs ahead of this host's, so its 00:53:17.921 bound falls at this host's 00:53:17.921 − skewMs.
    const own = { key: 'GY-1619', id: `7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4e${skewMs > 0 ? 'a' : 'b'}619`, conflictSince: since };
    const start = at('00:46:00') - skewMs, local = holdBound - skewMs;
    const loop = await replay(observedAt => [gy1619(observedAt, true, own)], start, 3, { skewMs });
    assert.deepEqual(loop.ran.map(iso), [iso(start), iso(start + interval), iso(local)], `skew ${skewMs / 1000}s: the cycle runs when the control plane reaches the bound\n${loop.lines.join('\n')}`);
    assert.deepEqual(loop.waits.slice(0, 2), [interval, local - start - interval]);
    assert.deepEqual(loop.decided.map(entry => [entry.action, iso(entry.at)]), [['rework', iso(local)]], `skew ${skewMs / 1000}s`);
  }
});
