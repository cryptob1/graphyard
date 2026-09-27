import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work, Observation } from '../src/model.js';
import { reviewLaunchObservationWait, observationWakeDue } from '../src/daemon/decisions.js';

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('h1'), B = sha40('b1');
const at = '2026-09-24T10:00:00.000Z';
const now = Date.parse(at);

function observation(candidate: { sha: string; baseSha: string }, observedAt: string = at): Observation {
  return {
    candidate: { ...candidate, pr: 1, branch: 'feature/test', author: 'tester' },
    checks: [], reviews: [], agentReview: null, merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: observedAt, prState: 'open', draft: false,
    baseTip: candidate.baseSha, baseTree: sha40('tree'), baseTipContained: true, conflicting: false
  };
}

function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 1, branch: 'feature/test', author: 'tester' };
  return {
    id: 'work-1', key: 'GY-1', title: 'Test', description: '', type: 'feature', priority: 0,
    dependencies: [], plannedFiles: ['src/'], criteria: [], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 1 },
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: observation(candidate),
    blocker: null, gates: [{ name: 'review', passed: false, reasons: ['Independent approval required'] }],
    violations: [], queue: null, nextAction: null, reviewRequest: null, approval: null, agentReview: null,
    rework: null, ...overrides
  } as Work;
}

test('unit:launch-binds-head-not-age — review launch binds to the head sha/baseSha, not the observation age', () => {
  // The observation is fresh: under 2 minutes old and matches the head
  const freshObs = observation({ sha: H, baseSha: B }, new Date(now + 60_000).toISOString());
  const freshWork = work({ observation: freshObs, candidate: { sha: H, baseSha: B, pr: 1, branch: 'feature/test', author: 'tester' } });

  // A review launch should succeed when the observation matches the head (no age requirement)
  const wait = reviewLaunchObservationWait(freshWork, now + 60_000, null);
  assert.equal(wait, null, 'review launch succeeds when observation matches the head (fresh observation)');

  // The observation is stale: older than 2 minutes, but matches the current head
  const staleObs = observation({ sha: H, baseSha: B }, new Date(now - 3 * 60_000).toISOString());
  const staleWork = work({ observation: staleObs, candidate: { sha: H, baseSha: B, pr: 1, branch: 'feature/test', author: 'tester' } });

  // Even with a stale observation, if the head matches, the launch succeeds (binding is to head, not age)
  const staleWait = reviewLaunchObservationWait(staleWork, now + 3 * 60_000, null);
  assert.equal(staleWait, null, 'review launch succeeds with stale observation that matches the current head');

  // But if the observation is of a different head, we must wait
  const oldHeadObs = observation({ sha: sha40('old'), baseSha: B }, new Date(now - 1 * 60_000).toISOString());
  const movedHeadWork = work({ observation: oldHeadObs, candidate: { sha: H, baseSha: B, pr: 1, branch: 'feature/test', author: 'tester' } });
  const movedWait = reviewLaunchObservationWait(movedHeadWork, now + 1 * 60_000, null);
  assert.ok(movedWait, 'review launch waits when observation is of a different head');
});

test('unit:stale-refusal-wakes-observation — when an observation of an old head would refuse a review launch, the observation job is woken', () => {
  // Observation is of an old head (different from current)
  const oldHeadObs = observation({ sha: sha40('old'), baseSha: B }, new Date(now - 3 * 60_000).toISOString());
  const workWithOldHeadObs = work({ observation: oldHeadObs, candidate: { sha: H, baseSha: B, pr: 1, branch: 'feature/test', author: 'tester' } });

  // An observation of a different head should trigger a wait reason
  const wait = reviewLaunchObservationWait(workWithOldHeadObs, now + 3 * 60_000, null);
  assert.ok(wait, 'observation of a different head produces a wait reason');
  assert.match(wait, /earlier head/, 'wait reason mentions earlier head');

  // observationWakeDue should return true when the observation is blocking
  const wokenAt = new Date(now - 4 * 60_000).toISOString(); // woken 4 minutes ago
  const shouldWakeAgain = observationWakeDue(workWithOldHeadObs, wokenAt, now + 3 * 60_000, null);
  assert.equal(shouldWakeAgain, true, 'observation wake is due when observation still blocks (different head)');
});

test('unit:launch-wait-reported — the reason a review launch waits is clearly reported', () => {
  // No observation at all
  const noObsWork = work({ observation: null, candidate: { sha: H, baseSha: B, pr: 1, branch: 'feature/test', author: 'tester' } });
  const noObsWait = reviewLaunchObservationWait(noObsWork, now, null);
  assert.ok(noObsWait?.includes('observation') && noObsWait?.includes('there is none'), 'missing observation is clearly reported');

  // Observation is of a different (earlier) head
  const oldHeadObs = observation({ sha: sha40('old'), baseSha: B }, new Date(now - 3 * 60_000).toISOString());
  const oldHeadWork = work({ observation: oldHeadObs, candidate: { sha: H, baseSha: B, pr: 1, branch: 'feature/test', author: 'tester' } });
  const oldHeadWait = reviewLaunchObservationWait(oldHeadWork, now + 3 * 60_000, null);
  assert.ok(oldHeadWait?.includes('earlier head'), 'observation of earlier head is clearly reported');
  assert.ok(oldHeadWait?.includes(oldHeadObs.at), 'observation time is included');
  assert.ok(oldHeadWait?.includes(oldHeadObs.candidate.sha.slice(0, 12)), 'the earlier head sha is included');

  // GitHub pause
  const pausedObs = observation({ sha: H, baseSha: B });
  const pausedWork = work({ observation: pausedObs });
  const pauseWait = reviewLaunchObservationWait(pausedWork, now, { until: new Date(now + 5 * 60_000).toISOString() });
  assert.ok(pauseWait?.includes('paused'), 'GitHub pause is reported');
});
