import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';
import { docsSyncRoute } from '../src/daemon/docs-sync-route.js';
import { docsSyncSessionName, type DocsSyncPlan } from '../src/docs-sync.js';
import { checkInvariants, emptyInvariantRecord } from '../src/model/invariants.js';

/**
 * GY-1537: four loop faults in 24 hours. Two stalled-step instances (GY-1515 and GY-1530, 2026-10-08T06:01:56Z): each item's
 * conflict was first recorded at 05:51Z against base tip fbb3f3cbe314, a docs-sync session held it, was stopped at the cutoff
 * (05:59Z), and the rework due at 06:01Z waited on an observation that had not landed, so the loop missed its own 10-minute bound.
 * Two cycle-p90 instances (2026-10-07T22:05Z, 2026-10-08T05:30Z): the invariant judged a cycle's wall time, child waits included.
 * Proof: manual:fault-class-loop.
 */
const at = (time: string) => Date.parse(`2026-10-08T${time}Z`);
const iso = (ms: number) => new Date(ms).toISOString();
const minute = 60_000;
const base0 = '3aef49ab1c7ab0bf1ef8f2bb25ead6b09c39b1fa', tip = 'fbb3f3cbe31470ba3b7231a18b59aa650f60a187';
const paths = ['docs/coordination.md', 'docs/delivery.md'];

const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/true',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

function conflicted(key: string, head: string, observedAt: number): Work {
  const candidate = { sha: head, baseSha: base0, pr: 99, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const observation = { clockOffset: { min: 0, max: 0 }, candidate, baseTip: tip, baseTipContained: false, conflicting: true, checks: [], reviews: [], protected: true, mergeable: false,
    merged: false, mergeSha: null, files: paths, scopeFiles: [], at: iso(observedAt), prState: 'open', draft: false } as unknown as Observation;
  return { id: `${key}-id`, key, title: 't', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true },
    plannedFiles: paths, stage: 'build', revision: 1, policyRevision: 3, createdAt: iso(at('05:00:00')), updatedAt: iso(observedAt), stageEnteredAt: iso(at('05:51:01')), ready: true, epoch: 3,
    lease: null, workspaces: [], submission: { epoch: 3, pr: 99 }, systemDriven: true, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation,
    baseRefresh: { from: { sha: head, baseSha: base0 }, base: tip, baseTree: 'e'.repeat(40), policyRevision: 3, at: '2026-10-08T05:51:01.988Z', head: null, conflict: 'conflict', merge: null, carry: null,
      trigger: 'conflict confirmed', conflictPaths: paths, conflictSince: '2026-10-08T05:51:01.988Z' }, blocker: null, violations: [],
    gates: [{ name: 'build', passed: false, reasons: ['conflict'] }] } as unknown as Work;
}

for (const [key, head] of [['GY-1515', '9237f0b41c1402ce368a69ea40c5b752b3ddde7d'], ['GY-1530', 'bd9acb3e776cbffd5c84c8586ab865bacbb8b8ef']] as const)
test(`manual:fault-class-loop — stalled-step ${key}: past the 10-minute bound the stopped docs-sync gives the conflict up without a fresh reading, and the rework no longer waits for one`, async () => {
  const state = emptyDaemonState(config()), agents: string[] = [], notes: string[] = [];
  const route = (work: Work, now: number) => docsSyncRoute({ config: { baseBranch: 'main' }, state, snapshot: { work: [work] }, stamp: iso(now), clock: now, inventorySpent: () => {},
    effects: { docsSync: async (_item: Work, plan: DocsSyncPlan) => { const name = docsSyncSessionName(plan); agents.push(name); return { agentName: name, pane: 'pane-s', account: 'a', runtime: 'claude' as const, session: null }; },
      conflictPaths: async () => paths, persist: async () => {}, closeSession: async () => { agents.length = 0; } },
    sessions: async () => ({ agents: agents.map(name => ({ name, pane_id: 'pane-s', agent_status: 'working' }) as any), available: true }),
    note: async (_key, _item, _kind, outcome, detail) => { notes.push(`${outcome}: ${detail}`); } });
  const stale = conflicted(key, head, at('05:55:00'));
  assert.equal(await route(stale, at('05:51:35')).holds(stale), true, 'the docs-page conflict is held by a docs-sync');
  // 05:59:30, past the cutoff and inside the bound: stopped, and still held for want of a reading.
  assert.equal(await route(stale, at('05:59:30')).holds(stale, async () => null), true);
  // 06:01:56, past the bound (06:01:01) with no reading since the stop: the conflict returns to a worker.
  assert.equal(await route(stale, at('06:01:56')).holds(stale, async () => null), false, 'the bound is kept without a fresh reading');
  assert.match(notes.at(-1)!, new RegExp(`^failed: ${key}: .*no observation since landed inside the loop-owned bound`));
  // The rework request itself: stale observation, overdue conflict round. Loaded here so the base, which lacks the export, fails at the hold above.
  const { conflictReworkOverdue, reworkObservationWait } = await import('../src/daemon/decisions.js');
  const decision = { action: 'rework' as const, binding: `${head}:conflict` };
  assert.equal(reworkObservationWait(stale, at('06:01:56'), null) !== null, true, 'the observation is stale');
  assert.equal(conflictReworkOverdue(stale, decision, at('06:01:56')), true, 'and the round is overdue, so it does not wait');
  assert.equal(conflictReworkOverdue(stale, decision, at('05:59:00')), false, 'inside the bound the wait stands');
  assert.equal(conflictReworkOverdue(stale, { action: 'rework', binding: `${head}:checks` }, at('06:01:56')), false, 'other grounds keep the wait');
  assert.equal(conflictReworkOverdue(stale, { action: 'merge', binding: `${head}:conflict` }, at('06:01:56')), false);
});

for (const [instant, wall, work] of [[Date.parse('2026-10-07T22:05:07.171Z'), 62_000, 3_000], [Date.parse('2026-10-08T05:30:41.190Z'), 120_000, 5_000]] as const)
test(`manual:fault-class-loop — invariant:cycle-p90 at ${new Date(instant).toISOString()}: a cycle is judged on its own work, not the child and control-plane waits it spent`, () => {
  const now = instant, metric = (index: number, durationMs: number, workMs?: number) => ({ at: iso(now - index * 3 * minute), durationMs, ...(workMs === undefined ? {} : { workMs }) });
  const check = (metrics: ReturnType<typeof metric>[]) => checkInvariants(emptyInvariantRecord(), { work: [], now, metrics }).find(entry => entry.invariant === 'cycle-p90')!;
  const waiting = Array.from({ length: 10 }, (_, index) => metric(index, wall, work));
  assert.equal(check(waiting).holds, true, `${wall / 1000} s of wall time that was ${work / 1000} s of work and the rest waits is a slow provider, not a slow loop`);
  assert.equal(check(Array.from({ length: 10 }, (_, index) => metric(index, 90_000, 80_000))).holds, false, 'a loop that worked for 80 s violates');
  assert.equal(check(Array.from({ length: 10 }, (_, index) => metric(index, 90_000))).holds, false, 'a cycle with no recorded split is judged on its wall time');
});
