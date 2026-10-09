import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation, Work } from '../src/model.js';
import type { MasterConfig } from '../src/master.js';
import { capBindingPrefix, decisionPrecondition } from '../src/model/approval.js';
import { capBinding } from '../src/daemon/reblocked-attempts.js';
import { emptyDaemonState, type DaemonAction, type DaemonEffects } from '../src/master-daemon.js';
import { cappedReview, cappedReworkBinding, cappedRevisionMark, neededDecision } from '../src/daemon/decisions.js';
import { emptyHeldDecisions } from '../src/daemon/decision-reads.js';
import { cappedFilingKey, cappedRereviewKey, reviewCapStep } from '../src/daemon/cycle-review-cap.js';
import type { Cycle } from '../src/daemon/cycle.js';

// GY-1576: three decision faults in 24 hours, on GY-1522 and GY-1573. Each instance is replayed
// from its own ledger record.

const gy1522 = (patch: Partial<Work> = {}) => ({
  id: 'f6032385-3385-4455-9431-58a6f43e18d0', key: 'GY-1522', stage: 'build', ready: true, epoch: 3, revision: 30, policyRevision: 1, blocker: null,
  dependencies: ['8a3c5d1e-0000-4000-8000-000000001519'], lease: null, containmentQuarantine: null, reworkRequested: true, submission: { epoch: 3, pr: 1010 },
  candidate: { sha: '0cfd4ddffa0ce598d91bdb2276f5ea29d4a16688', baseSha: '56ca80414ca99e3547c7dbdb5a4298b6647217e5', pr: 1010, branch: 'graphyard/gy-1522-3', author: 'worker' },
  criteria: [], workspaces: [], evidence: [], gates: [], violations: [], ...patch,
}) as unknown as Work;

test('unit:fault-class-decision GY-1522 — a rework on an item an applied rework already returned to a worker is refused at the request, naming what its dispatch waits on, so no approver has to refuse it', () => {
  // Decision bd40dc45 (2026-10-08T11:38Z): the master requested a rework, with no binding, of GY-1522 while decision 8da1e201's
  // applied rework stood (reworkRequested, lease null, the epoch-3 session closed) and dispatch waited on dependency GY-1519.
  // The base accepted it and the approver refused it; the request is now refused before any approver sees it.
  const refusal = decisionPrecondition('rework', { previousWorkerStopped: true }, gy1522());
  assert.match(refusal ?? '', /^GY-1522 already holds an applied rework: it stands returned to a worker with no lease and no containment fence, so a second rework changes nothing about it\. Its next attempt waits on dispatch, which waits on its dependency being done; read why with graphyard master status GY-1522$/);
  assert.match(decisionPrecondition('rework', { previousWorkerStopped: true }, gy1522({ blocker: 'CI is down', ready: false, dependencies: [] }))!, /waits on its blocker \(CI is down\) and its release \(the item is not ready\);/);
  assert.match(decisionPrecondition('rework', { previousWorkerStopped: true, binding: `${gy1522().candidate!.sha}:conflict` }, gy1522())!, /already holds an applied rework/, 'a loop-bound rework restates the standing one too');

  // What a rework still changes is left to the approver as before.
  assert.equal(decisionPrecondition('rework', { previousWorkerStopped: true }, gy1522({ reworkRequested: false })), null, 'a submitted head with no rework standing');
  assert.equal(decisionPrecondition('rework', { previousWorkerStopped: true }, gy1522({ lease: { owner: 'graphyard-claude-1', epoch: 4, expiresAt: '2026-10-08T12:00:00Z' } } as Partial<Work>)), null, 'a lease the rework discards');
  assert.equal(decisionPrecondition('rework', { previousWorkerStopped: true }, gy1522({ containmentQuarantine: { epoch: 3 } } as Partial<Work>)), null, 'a containment fence the rework settles');
  const cap = capBinding(gy1522(), Date.parse('2026-10-08T11:00:00Z'));
  assert.ok(cap.startsWith(capBindingPrefix));
  assert.equal(decisionPrecondition('rework', { previousWorkerStopped: true, binding: cap }, gy1522()), null, "the attempt cap's fresh round past the cap (GY-885)");
});

// GY-1573 (2026-10-09T08:52Z): decision f84ee922, the capped rework of round 8, was refused as non-blocking, and the
// head then owed a new head nobody would push (owed-decision). GY-1575 (PR #1054, in this base) withdraws the change
// request on that refusal and re-reviews the head; this replays round 8 through the review-cap step.
const H = 'd6a938c5a5c7'.padEnd(40, '0'), B = 'b2'.padEnd(40, 'f');
const reviewer = 'graphyard-reviewer[bot]';
const config = { url: 'https://graphyard.example', repository: 'owner/project',
  reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.pem', boundAt: '2026-09-24T00:00:00Z' } } as unknown as MasterConfig;

function round8(state = 'CHANGES_REQUESTED'): Work {
  const candidate = { sha: H, baseSha: B, pr: 1047, branch: 'graphyard/gy-1573-8', author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [{ reviewer, sha: H, state, id: 8080, submittedAt: '2026-10-09T08:10:00Z', body: 'BLOCKING: a hold saved before this upgrade is never reported to the registry.' }],
    merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/master/environments.ts'], scopeFiles: [], at: '2026-10-09T08:11:00Z', prState: 'open', draft: false, baseTip: B, baseTree: B, baseTipContained: true } as unknown as Observation;
  return { id: 'work-1573', key: 'GY-1573', title: 'Exhausted accounts', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Holds are reported.', proofs: ['unit:holds'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 80, policyRevision: 1, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-09T08:11:00Z', stageEnteredAt: '2026-10-09T08:11:00Z', ready: true, epoch: 8,
    lease: null, workspaces: [], candidate, submission: { epoch: 8, pr: 1047 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, gates: [], violations: [],
    pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 7, interventions: { blocked: 0, requirements: 0 } } } as unknown as Work;
}

test('unit:fault-class-decision GY-1573 — the refused capped rework of round 8 withdraws the change request and re-reviews the head, so no new head stays owed', async () => {
  const item = round8();
  const judged = cappedReview(item, config)!;
  assert.equal(judged.kind, 'escalate');
  assert.equal(neededDecision(item, config)?.binding, cappedReworkBinding(H, reviewer));
  const refused = { id: 'f84ee922-9b67-4a8e-aa96-a2ca189a9ccb', action: 'rework', state: 'refused', input: { binding: cappedReworkBinding(H, reviewer), previousWorkerStopped: true },
    reason: `${cappedRevisionMark(1)} GY-1573 is in review round 8, past its cap of 3.`, approvedBy: null,
    refusal: { approver: 'graphyard-approver-graphyard', reason: 'Refused as non-blocking at round 8, past the cap of 3.', at: '2026-10-09T08:40:00.000Z' } };
  const state = emptyDaemonState(config), performed: DaemonAction[] = [], withdrawn: number[] = [], wakes: string[] = [];
  const effects = { persist: async () => {}, decide: async () => ({ id: 'unused' }), approver: async () => ({ agentName: 'unused', pane: null }), decisions: async () => ({ decisions: [refused] }),
    withdrawReview: async (_work: Work, reviewId: number) => { withdrawn.push(reviewId); }, wakeObservation: async (work: Work) => { wakes.push(work.key); } } as unknown as DaemonEffects;
  let tick = Date.parse('2026-10-09T08:45:00Z');
  for (let cycle = 0; cycle < 3; cycle++) {
    state.cycle++; tick += 60_000;
    await reviewCapStep({ config, state, effects, performed, now: () => tick, open: [item], snapshot: { work: [item], now: new Date(tick).toISOString() },
      heldDecisions: emptyHeldDecisions(), isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
  }
  assert.deepEqual(withdrawn, [8080], 'the change request is withdrawn once');
  assert.deepEqual(wakes, ['GY-1573'], 'the observation is woken so the owed request-rework is cancelled');
  assert.equal(state.actions[cappedFilingKey(item, { sha: H, reviewId: 8080 })]?.state, 'done');
  assert.equal(state.actions[cappedRereviewKey(item, H)]?.state, 'done', 'the head is reviewed again');
  assert.equal(neededDecision(round8('DISMISSED'), config), null, 'with the change request withdrawn, no new head is owed');
});
