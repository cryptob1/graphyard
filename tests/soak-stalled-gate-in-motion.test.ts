import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { actorlessSubmissions } from '../src/cli/actorless-submissions.js';
import { unboundedAttemptKey } from '../src/daemon/cycle-reclaim.js';
import { hour, minute } from './helpers/soak-world.js';

/**
 * GY-1557 (manual:fault-class-stalled-gate): recurring stalled-gate decisions across a simulated
 * day of the loop's own fault step. Repeated observations and base moves under submitted heads
 * stay inside the hold's in-motion window and are not counted; attempts past the worker bound are
 * counted only past the reclaim bound, and a reclaim that ends the attempt opens none. The
 * real-loop reclaim day that stops those attempts lives in soak-sessions.test.ts.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'soak-host', masterAgentName: 'graphyard-master-project',
  autoMerge: true, mergeMethod: 'merge', workers: [],
});
const baseConflictWaitBoundMs = 30 * minute, workerReclaimBoundMs = 120 * minute;
const shift = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
const iso = (ms: number) => new Date(ms).toISOString();

/** A submitted head withheld behind a moving base tip, as the soak's observation write would leave it. */
function heldHead(key: string, opts: { claimedAt: string; headAt: string; holdAt: string; observedAt: string; tip: string; conflicting?: boolean }): Work {
  const sha = key.replace(/\W/g, '').padEnd(40, 'a').slice(0, 40);
  const candidate = { sha, baseSha: 'b'.repeat(40), pr: 100 + key.length, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  const observation = {
    candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: opts.conflicting === false ? null : false,
    conflicting: opts.conflicting !== false, protected: true, files: ['src/a.ts'], scopeFiles: [],
    at: opts.observedAt, prState: 'open', draft: false, baseTip: opts.tip, baseTree: opts.tip, baseTipContained: false,
  } as unknown as Observation;
  // A confirmed conflict clears the pending base-refresh named wait (pendingBaseRefresh), so the
  // actorless reading stands — the same shape GY-1522 had when it was counted.
  const baseRefresh = {
    from: { sha, baseSha: candidate.baseSha }, base: opts.tip, baseTree: opts.tip, policyRevision: 1, at: opts.observedAt, head: null,
    conflict: `Candidate ${sha.slice(0, 12)} cannot be brought onto base branch tip ${opts.tip.slice(0, 12)} without resolving a conflict`,
    conflictPaths: ['src/a.ts'], trigger: 'conflict confirmed', conflictSince: opts.holdAt,
  };
  return {
    id: `work-${key}`, key, title: key, description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'build', revision: 1, policyRevision: 1, createdAt: opts.claimedAt, updatedAt: opts.observedAt, stageEnteredAt: opts.claimedAt,
    ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: candidate.pr },
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, escalations: [],
    headObserved: { pr: candidate.pr, sha, at: opts.headAt }, baseHold: { sha, at: opts.holdAt }, baseRefresh,
    autoDispatch: { review: null, producers: [], history: [] }, actionQueue: { actions: [], history: [] },
    gates: [], violations: [], proofGaps: [], scopeRequest: null, containmentQuarantine: null,
  } as unknown as Work;
}

function unsubmitted(key: string, claimedAt: string, at: string, expiresAt: string): Work {
  const owner = `worker-${key.toLowerCase()}`;
  return {
    id: `work-${key}`, key, title: key, description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true },
    stage: 'build', revision: 1, policyRevision: 1, createdAt: claimedAt, updatedAt: at, stageEnteredAt: claimedAt, ready: true, epoch: 1,
    lease: { owner, epoch: 1, expiresAt }, lastAssignment: { owner, epoch: 1, claimedAt },
    workspaces: [{ host: 'soak-host', path: `/tmp/soak/${key}-1`, epoch: 1, owner, branch: `graphyard/${key.toLowerCase()}-1` }],
    sessions: [{ id: `${owner}:1`, kind: 'implementation', principal: owner, epoch: 1, runtime: 'claude', host: 'soak-host', workspace: 'w1', tab: null, pane: 'w1:p1',
      agentName: owner, role: null, head: null, attach: 'herdr pane attach w1:p1', transcript: null, subject: key, state: 'running',
      observed: 'working', observedAt: at, outcome: null, startedAt: claimedAt, updatedAt: at, endedAt: null }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    escalations: [], autoDispatch: { review: null, producers: [], history: [] }, actionQueue: { actions: [], history: [] },
    gates: [], violations: [], proofGaps: [], scopeRequest: null, containmentQuarantine: null, humanRequest: null,
  } as unknown as Work;
}

function stalledKinds(work: Work[], at: string, state = emptyDaemonState(config())) {
  const reported = actorlessSubmissions(work, new Date(at));
  return cycleFaults(state, work, Date.parse(at), { config: config(), reported })
    .filter(fault => fault.faultClass === 'stalled-gate')
    .map(fault => `${fault.kind}|${fault.subject}`)
    .sort();
}

test('unit:soak-invariants-hold — across a simulated day of observations and base moves, held heads are not actorless inside the hold bound, and unsubmitted attempts are counted only past the reclaim bound', () => {
  const dayStart = Date.parse('2031-06-02T08:00:00Z');
  const claimed = iso(dayStart - 3 * hour);
  const headAt = iso(dayStart - 2 * hour);
  const holdAt = iso(dayStart);
  const tips = ['c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)];
  const keys = ['GY-A', 'GY-B', 'GY-C'];
  const cycleMs = 5 * minute;
  const actorlessInside: string[] = [], actorlessPast: string[] = [];
  const u1Inside: string[] = [], u1Past: string[] = [], u2Counts: string[] = [];
  // GY-U1 starts 70 minutes before the day: past the 60-minute worker bound, inside the 120-minute reclaim bound for the first 50 minutes.
  const u1Claimed = dayStart - 70 * minute;
  const u2Claimed = dayStart - (workerReclaimBoundMs + 10 * minute);

  for (let elapsed = 0; elapsed <= 2 * hour; elapsed += cycleMs) {
    const atMs = dayStart + elapsed, at = iso(atMs);
    const tip = tips[Math.min(Math.floor(elapsed / (40 * minute)), tips.length - 1)]!;
    const heads = keys.map(key => heldHead(key, { claimedAt: claimed, headAt, holdAt, observedAt: at, tip, conflicting: true }));
    const attempts = [
      unsubmitted('GY-U1', iso(u1Claimed), at, shift(at, 2 * minute)),
      unsubmitted('GY-U2', iso(u2Claimed), at, shift(at, 2 * minute)),
    ];
    const kinds = stalledKinds([...heads, ...attempts], at);
    if (elapsed < baseConflictWaitBoundMs) actorlessInside.push(...kinds.filter(k => k.startsWith('actorless|')));
    else actorlessPast.push(...kinds.filter(k => k.startsWith('actorless|')));
    const u1Held = atMs - u1Claimed;
    if (u1Held <= workerReclaimBoundMs) u1Inside.push(...kinds.filter(k => k === 'unsubmitted-attempt|GY-U1'));
    else u1Past.push(...kinds.filter(k => k === 'unsubmitted-attempt|GY-U1'));
    u2Counts.push(...kinds.filter(k => k === 'unsubmitted-attempt|GY-U2'));
  }

  assert.deepEqual(actorlessInside, [], `no actorless count while the hold's bound still runs across tip moves: ${actorlessInside}`);
  assert.ok(new Set(actorlessPast).size === keys.length, `past the hold bound each head is counted once the wait stands: ${[...new Set(actorlessPast)]}`);
  assert.deepEqual(u1Inside, [], `inside the reclaim bound GY-U1 is not counted: ${u1Inside}`);
  assert.ok(u1Past.length > 0, `past the reclaim bound GY-U1 is counted: ${u1Past}`);
  assert.ok(u2Counts.length > 0, `an attempt already past the reclaim bound is counted every cycle it stands: ${u2Counts.length} cycles`);

  // A reclaim that ends the overdue attempt this cycle opens no instance, matching soak-sessions.
  const late = iso(dayStart + workerReclaimBoundMs + minute);
  const overdue = unsubmitted('GY-U3', iso(dayStart), late, shift(late, 2 * minute));
  const state = emptyDaemonState(config());
  state.actions[unboundedAttemptKey(overdue, 1)] = {
    kind: 'session', work: overdue.key, principal: overdue.lease!.owner, epoch: 1, state: 'done',
    detail: 'ended', attempts: 1, cycle: state.cycle, at: late,
  };
  assert.deepEqual(stalledKinds([overdue], late, state), [], 'a successful reclaim this cycle opens no unsubmitted-attempt instance');
});
