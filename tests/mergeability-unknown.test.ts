import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_NAME, GitHub, mergeabilityRetries } from '../src/github.js';
import { predictQueue, queueRef } from '../src/merge-queue.js';
import { evaluate, type Observation, type Work } from '../src/model.js';
import { mergeabilityComputingRefusal } from '../src/model/gates.js';
import { refusalRuleFor } from '../src/model/refusal-mapping.js';

// GY-548. GitHub answers `mergeable: null` while it recomputes mergeability after the base moves;
// that was recorded as not mergeable and held merge-stage items for hours. Each test is named for
// the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const notMergeable = 'Pull request is not mergeable against the current base';
const PR = 548, HEAD = sha40('a1'), BASE = sha40('b1');
const now = new Date('2026-09-26T08:30:00.000Z'), at = '2026-09-26T08:00:00.000Z';

/** A fake GitHub over the request surface `observe` uses; each read of the pull request takes the next `mergeable` answer. */
function provider(answers: (boolean | null)[]) {
  const reads: (boolean | null)[] = [];
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.mergeabilityRetryMs = 0;
  github.controlPlaneLogin = async () => 'graphyard-owner-repo[bot]';
  github.request = async (path, method = 'GET') => {
    if (method !== 'GET') return { id: 12 };
    if (path === `/pulls/${PR}`) {
      const mergeable = answers.length > 1 ? answers.shift()! : answers[0];
      reads.push(mergeable);
      return { number: PR, head: { sha: HEAD, ref: 'graphyard/gy-548-1', repo: { full_name: 'owner/repo' } }, base: { sha: BASE, ref: 'main', repo: { full_name: 'owner/repo' } },
        user: { login: 'implementer', id: 7 }, merged: false, mergeable, draft: false, state: 'open', merge_commit_sha: null, created_at: at };
    }
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: BASE } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: sha40('e1') } }, parents: [], author: null };
    if (path.startsWith('/compare/')) return { status: 'ahead', files: [] };
    if (path.includes('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (path.includes('/reviews')) return [];
    if (path.includes('/files')) return [{ filename: 'src/feature.ts', status: 'modified', sha: sha40('cc'), additions: 1, deletions: 0 }];
    if (path.includes('/check-runs')) return { check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }] };
    throw new Error(`Unexpected request ${path}`);
  };
  return { github, reads };
}

/**
 * A submitted item carrying `observation`. Unqueued, it awaits review, so it stays out of the merge
 * queue and the merge gate words its own mergeability; queued, every gate but merge passes.
 */
function item(observation: Observation, queued = false): Work {
  const candidate = observation.candidate;
  return { id: 'id-GY-548', key: 'GY-548', title: 'GY-548', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/feature.ts'], criteria: [],
    policy: { checks: ['test'], review: queued ? false : true }, stage: 'merge', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine', path: '/tmp/GY-548', branch: candidate.branch, epoch: 1, owner: 'agent' }], candidate, submission: { epoch: 1, pr: PR }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [], observation: { ...observation, at: now.toISOString() },
    ...(queued ? { queue: { sequence: 7, enqueuedAt: at, policyRevision: 1, speculation: null }, queueSequence: 7 } : {}) } as unknown as Work;
}
const mergeReasons = (work: Work) => evaluate(work, [work], now, [15368]).gates.find(gate => gate.name === 'merge')!.reasons;

test('unit:mergeability-unknown-not-refused — GitHub\'s not-yet-computed mergeability is re-requested and recorded as unknown, never as not mergeable; a computed conflict keeps the conflict path', async () => {
  // null, then true: the re-request reads the computed value and nothing refuses the merge on it.
  const settles = provider([null, true]);
  const settled = await settles.github.observe({ id: 'id-GY-548', key: 'GY-548', policy: { review: false, checks: ['test'] }, plannedFiles: ['src/feature.ts'], submission: { pr: PR, epoch: 1 }, policyRevision: 1, observation: null } as unknown as Work);
  assert.deepEqual([settled.mergeable, settled.conflicting, settled.mergeabilityUnknown], [true, false, undefined]);
  assert.deepEqual(settles.reads.slice(0, 2), [null, true], 'the pull request is read again once GitHub answered null');
  const clean = mergeReasons(item(settled));
  assert.ok(!clean.includes(notMergeable) && !clean.includes(mergeabilityComputingRefusal), clean.join('; '));

  // null every time: re-requested exactly `mergeabilityRetries` times, then recorded as unknown.
  const computing = provider([null]);
  const unknown = await computing.github.observe({ id: 'id-GY-548', key: 'GY-548', policy: { review: false, checks: ['test'] }, plannedFiles: ['src/feature.ts'], submission: { pr: PR, epoch: 1 }, policyRevision: 1, observation: null } as unknown as Work);
  assert.equal(mergeabilityRetries, 3);
  // The first read, three re-requests, and the one confirmation read every observation makes.
  assert.equal(computing.reads.length, 1 + mergeabilityRetries + 1);
  assert.deepEqual([unknown.mergeable, unknown.conflicting, unknown.mergeabilityUnknown], [false, false, true]);
  const pending = mergeReasons(item(unknown));
  assert.ok(pending.includes(mergeabilityComputingRefusal), pending.join('; '));
  assert.ok(!pending.includes(notMergeable), 'unknown is never reported as not mergeable');
  assert.equal(refusalRuleFor('merge', mergeabilityComputingRefusal)?.kind, 'resync', 'the next observation reads it again');

  // false: the existing conflict path, with no re-request.
  const conflicts = provider([false]);
  const conflicting = await conflicts.github.observe({ id: 'id-GY-548', key: 'GY-548', policy: { review: false, checks: ['test'] }, plannedFiles: ['src/feature.ts'], submission: { pr: PR, epoch: 1 }, policyRevision: 1, observation: null } as unknown as Work);
  assert.equal(conflicts.reads.length, 2, 'a computed answer is not re-requested');
  assert.deepEqual([conflicting.mergeable, conflicting.conflicting, conflicting.mergeabilityUnknown], [false, true, undefined]);
  const refused = mergeReasons(item(conflicting));
  assert.ok(refused.includes(notMergeable) && !refused.includes(mergeabilityComputingRefusal), refused.join('; '));
});

test('unit:queued-unknown-mergeability — a queued entry whose own pull request reports unknown mergeability keeps its place and is published a speculative tip', () => {
  const candidate = { sha: HEAD, baseSha: BASE, pr: PR, branch: 'graphyard/gy-548-1', author: 'implementer' };
  const observation = { clockOffset: { min: 0, max: 0 }, candidate, baseTip: BASE, baseTree: sha40('e1'), baseTipContained: true, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [],
    protected: true, merged: false, mergeable: false, conflicting: false, mergeabilityUnknown: true, mergeSha: null, prState: 'open', draft: false, files: [], scopeFiles: [], at: now.toISOString() } as unknown as Observation;
  const work = item(observation, true);
  const evaluated = evaluate(work, [work], now, [15368]);
  assert.equal(evaluated.queue?.sequence, 7, 'the entry keeps its position');
  assert.equal(evaluated.queueEjection, null);
  const merge = evaluated.gates.find(gate => gate.name === 'merge')!.reasons;
  assert.ok(!merge.includes(notMergeable) && !merge.includes(mergeabilityComputingRefusal), `the entry is not held on its own mergeability: ${merge.join('; ')}`);

  // The queue publishes it a tip: the speculative tip, not the pull request's own reading, decides.
  const queued = { ...work, ...evaluated } as Work;
  const placement = predictQueue([queued], now.getTime()).find(entry => entry.id === work.id)!;
  assert.equal(placement.publishable, true, 'the entry is published a speculative tip');
  const tip = sha40('c1');
  const published = { ...queued, candidate: { ...candidate, sha: tip, baseSha: placement.predictedBase! },
    queue: { ...queued.queue!, speculation: { ref: queueRef(work.key), tip, base: placement.predictedBase!, baseTree: sha40('e1'), tipTree: sha40('e2'), predecessors: placement.predecessors, policyRevision: 1, publishedAt: at, reviewedHead: HEAD } } } as Work;
  published.observation = { ...observation, candidate: published.candidate!, at: now.toISOString() };
  const onTip = evaluate(published, [published], now, [15368]);
  assert.equal(onTip.queue?.sequence, 7, 'the published entry still holds its position');
  const tipMerge = onTip.gates.find(gate => gate.name === 'merge')!.reasons;
  assert.ok(!tipMerge.includes(notMergeable) && !tipMerge.includes(mergeabilityComputingRefusal), tipMerge.join('; '));
});
