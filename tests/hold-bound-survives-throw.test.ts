import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';
import type { BaseRefresh } from '../src/merge-queue.js';
import { docsSyncSessionName, type DocsSyncPlan } from '../src/docs-sync.js';

/**
 * GY-1624. GY-1622 ends the loop's idle wait at a standing docs-sync hold bound. The decisions step removes an
 * item's recorded bound before re-reading it, and re-sets it only when the hold still stands; at 45d721dbb a throw
 * from closeStanding or docsSync.hold in between was swallowed by isolate() and the bound was lost, so a still-held
 * item fell back to the full idle wait. The bound is now kept on such a throw. The scenario below is GY-1622's:
 *
 * GY-1619's conflict on 4a3a78af0fc7 was first recorded at 00:45:17.921Z on 2026-10-10 and handed to
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
/** The two call sites a throw is injected into, and the stack frame that tells the effect it is read from there. */
type Site = 'closeStanding' | 'docsSync.hold';
const sites: Record<Site, RegExp> = { closeStanding: /at (async )?closeStanding \(/, 'docsSync.hold': /at (async )?(Object\.)?hold \(/ };

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
async function replay(work: (observedAt: number) => Work[], start: number, cycles: number, { decideMs = 0, guardMs = 0, workMs = 0, skewMs = 0, throwIn = null as Site | null, throwOnCycle = 2 } = {}) {
  let now = start, worked = 0, thrown = 0;
  /** One transient failure of `throwIn`, on the cycle `throwOnCycle`, thrown from what that call site reads: closeStanding's decision history, docsSync.hold's base refresh. */
  /** docsSync.hold reads the item's base refresh on its first line, before any await, so the throw is injected there. */
  const armed = (item: Work) => { const refresh = item.baseRefresh; return Object.defineProperty(item, 'baseRefresh', { enumerable: true, get: () => { fail('docsSync.hold'); return refresh; } }); };
  const fail = (site: Site) => {
    if (throwIn !== site || thrown || ran.length !== throwOnCycle) return;
    // The call site's frame lies below the effect wrappers, past V8's default ten frames.
    const limit = Error.stackTraceLimit; Error.stackTraceLimit = 100; const stack = new Error().stack ?? ''; Error.stackTraceLimit = limit;
    if (!sites[site].test(stack)) return;
    thrown++; throw new Error(`transient ${site} failure`);
  };
  const decided: { key: string; action: string; at: number }[] = [], agents: string[] = [], waits: number[] = [], ran: number[] = [], lines: string[] = [];
  const effects: DaemonEffects = {
    agents: () => { if (worked < ran.length) { worked = ran.length; now += workMs; } return []; }, herdr: () => ({ agents: agents.map((name, index) => ({ name, pane_id: `pane-${index}`, agent_status: 'working' })), available: true }),
    credentials: async () => ({}),
    snapshot: async () => { ran.push(now); return { work: work(now + skewMs - 10_000).map(armed), now: iso(now + skewMs), jobs: [] }; },
    closeSession: () => { agents.length = 0; }, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (subject, action) => { decided.push({ key: subject.key, action, at: now }); now += decideMs; return { id: '5d8a8b9e-0000-4000-8000-000000001619' }; },
    decisions: ((_subject: Work) => { fail('closeStanding'); return Promise.resolve({ decisions: [] }); }) as DaemonEffects['decisions'],
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
  return { ran, waits, decided, lines, thrown };
}

for (const [site, suffix] of [['closeStanding', 'a'], ['docsSync.hold', 'b']] as const) {
  test(`unit:hold-bound-survives-throw — a throw from ${site} while the hold still stands keeps the item's bound, so the next cycle runs at it`, async () => {
    // Item ids of their own: the step's observation waker throttles wakes per item id across the process.
    const own = { key: 'GY-1619', id: `7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4f${suffix}619`, conflictSince: since };
    const loop = await replay(observedAt => [gy1619(observedAt, true, own)], at('00:46:00'), 3, { throwIn: site });
    assert.equal(loop.thrown, 1, `the ${site} throw was injected on the second cycle\n${loop.lines.join('\n')}`);
    assert.deepEqual(loop.ran.map(iso), ['2026-10-10T00:46:00.000Z', '2026-10-10T00:51:00.000Z', iso(holdBound)],
      `the cycle after the throw runs at the kept bound, not after a full 300s idle wait at 00:56:00\n${loop.lines.join('\n')}`);
    assert.deepEqual(loop.waits.slice(0, 2), [interval, holdBound - at('00:51:00')]);
    assert.ok(loop.lines.some(line => line.includes(`at the docs-sync hold bound ${iso(holdBound)}`)), loop.lines.join('\n'));
    assert.deepEqual(loop.decided.map(entry => [entry.action, iso(entry.at)]), [['rework', iso(holdBound)]], 'the conflict rework is requested in the cycle at the bound');
  });
}

test('unit:hold-bound-survives-throw — on the normal path the bound is set while the hold stands and cleared once it is released', async () => {
  const own = { key: 'GY-1619', id: '7c1e2a6b-3f4d-4e8a-9b0c-1d2e3f4fc619', conflictSince: since };
  const loop = await replay(observedAt => [gy1619(observedAt, true, own)], at('00:46:00'), 4);
  assert.equal(loop.thrown, 0);
  assert.deepEqual(loop.ran.slice(0, 3).map(iso), ['2026-10-10T00:46:00.000Z', '2026-10-10T00:51:00.000Z', iso(holdBound)], loop.lines.join('\n'));
  assert.deepEqual(loop.decided.map(entry => [entry.action, iso(entry.at)])[0], ['rework', iso(holdBound)], loop.lines.join('\n'));
  // Only the wait after the second cycle ends at the bound: once the cycle at the bound released the hold, no bound is left to end a wait.
  assert.deepEqual(loop.lines.filter(line => /hold bound/.test(line)).length, 1, loop.lines.join('\n'));
  assert.notEqual(loop.ran[3], holdBound, 'the released bound does not end the next wait at once');
});
