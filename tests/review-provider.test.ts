import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReviewerProfiles, evaluate, exhaustedReviewerProfiles, nativeReviewRequired, parseReviewerApps, policySchema, reviewerProfileFor, type ReviewerApp, type ReviewerProfile, type Work } from '../src/model.js';
// Time-bomb allowance (GY-1694): new Date() only stamps work() items and clocks their gate evaluation.

const head = 'a'.repeat(40), base = 'b'.repeat(40), other = 'c'.repeat(40);
const GRAPHYARD_APP = 1234, CLAUDE_APP = 55_001, CLAUDE_BOT = 55_002, CURSOR_APP = 66_001, CURSOR_BOT = 66_002;
const registry: ReviewerApp[] = [
  { id: 'claude-reviewer', runtime: 'claude', appId: CLAUDE_APP, botUserId: CLAUDE_BOT },
  { id: 'cursor-reviewer', runtime: 'cursor', appId: CURSOR_APP, botUserId: CURSOR_BOT },
];
const profiles: ReviewerProfile[] = [
  { name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer', timeoutSeconds: 1800 },
  { name: 'cursor-reviewer', runtime: 'cursor', reviewerApp: 'cursor-reviewer', timeoutSeconds: 900 },
];

function work(overrides: Partial<Work> = {}): Work {
  const now = new Date().toISOString();
  return {
    id: 'work-id', key: 'GY-42', title: 'Pluggable review', description: '', type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Reviewed', proofs: ['integration:claim-safety'] }], 
    policy: { checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: profiles },
    stage: 'review', revision: 5, policyRevision: 3, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true,
    epoch: 1, lease: null, workspaces: [{ host: 'h', path: '/p', branch: 'graphyard/gy-42-1', epoch: 1, owner: 'agent-a' }],
    candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-42-1', author: 'implementer' },
    submission: { epoch: 1, pr: 7 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null,
    gates: [], violations: [],
    reviewRequest: { commentId: 900, sha: head, baseSha: base, policyRevision: 3, body: 'dispatch', createdAt: now,
      provider: 'agent', profile: 'claude-reviewer', reviewerApp: 'claude-reviewer', marker: '11111111-1111-4111-8111-111111111111' },
    observation: { candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-42-1', author: 'implementer' },
      checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], merged: false, mergeSha: null, mergeable: true,
      protected: true, files: [], scopeFiles: [], at: now, prState: 'open', draft: false,
      agentReview: { provider: 'agent', sha: head, approved: true, reason: 'approved', requestId: 900, profile: 'claude-reviewer', reviewerApp: 'claude-reviewer' } },
    ...overrides,
  } as Work;
}
const reviewGate = (item: Work) => evaluate(item, [item], new Date()).gates.find(gate => gate.name === 'review')!;

test('policy validation binds agent review to registered, distinct reviewer identities', () => {
  const agent = policySchema.parse({ checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer' }] });
  assert.equal(agent.reviewerProfiles![0].timeoutSeconds, 1800);
  assert.throws(() => policySchema.parse({ checks: ['test'], review: true, reviewProvider: 'agent' }), /at least one reviewer profile/);
  assert.throws(() => policySchema.parse({ checks: ['test'], review: true, reviewProvider: 'codex', reviewerProfiles: profiles }), /require reviewProvider/);
  assert.throws(() => policySchema.parse({ checks: ['test'], review: true, reviewProvider: 'github', reviewerProfiles: profiles }), /require reviewProvider/);
  for (const duplicated of [
    [profiles[0], { ...profiles[1], name: 'claude-reviewer' }],
    [profiles[0], { ...profiles[1], reviewerApp: 'claude-reviewer' }],
  ]) assert.throws(() => policySchema.parse({ checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: duplicated }), /must be unique|distinct/);
  assert.doesNotThrow(() => assertReviewerProfiles(profiles, registry, GRAPHYARD_APP));
  assert.throws(() => assertReviewerProfiles([{ ...profiles[0], reviewerApp: 'unregistered' }], registry, GRAPHYARD_APP), /not registered/);
  assert.throws(() => assertReviewerProfiles([{ ...profiles[0], runtime: 'cursor' }], registry, GRAPHYARD_APP), /registered runtime/);
  assert.throws(() => assertReviewerProfiles(profiles, [{ ...registry[0], appId: GRAPHYARD_APP }], GRAPHYARD_APP), /control-plane App/);
  assert.throws(() => assertReviewerProfiles([], registry, GRAPHYARD_APP), /at least one reviewer profile/);
});

test('the reviewer registry refuses ambiguous identities and unknown fields', () => {
  assert.deepEqual(parseReviewerApps(undefined), []);
  assert.deepEqual(parseReviewerApps(JSON.stringify(registry)), registry);
  for (const invalid of [
    [registry[0], { ...registry[1], id: 'claude-reviewer' }],
    [registry[0], { ...registry[1], appId: CLAUDE_APP }],
    [registry[0], { ...registry[1], botUserId: CLAUDE_BOT }],
    [{ ...registry[0], secret: 'x' }],
    [{ ...registry[0], appId: 0 }],
  ]) assert.throws(() => parseReviewerApps(JSON.stringify(invalid)));
});

test('native branch protection stays required only for formal GitHub review', () => {
  assert.equal(nativeReviewRequired({ checks: ['test'], review: true }), true);
  assert.equal(nativeReviewRequired({ checks: ['test'], review: true, reviewProvider: 'github' }), true);
  assert.equal(nativeReviewRequired({ checks: ['test'], review: true, reviewProvider: 'codex' }), false);
  assert.equal(nativeReviewRequired({ checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: profiles }), false);
});

test('profile selection follows configured order and only this candidate’s exhaustion', () => {
  const failover = (profile: string, overrides: Record<string, unknown> = {}) => ({ profile, reviewerApp: profile, runtime: 'claude', exhaustion: 'usage-limit' as const,
    reason: 'quota', at: new Date().toISOString(), sha: head, baseSha: base, policyRevision: 3, requestCommentId: 900, nextProfile: null, ...overrides });
  assert.equal(reviewerProfileFor(work())!.name, 'claude-reviewer');
  assert.equal(reviewerProfileFor(work({ reviewFailovers: [failover('claude-reviewer')] }))!.name, 'cursor-reviewer');
  assert.equal(reviewerProfileFor(work({ reviewFailovers: [failover('claude-reviewer'), failover('cursor-reviewer')] })), null);
  // Exhaustion recorded for another commit, base, or policy never disqualifies a profile here.
  for (const stale of [{ sha: other }, { baseSha: other }, { policyRevision: 2 }]) {
    const item = work({ reviewFailovers: [failover('claude-reviewer', stale)] });
    assert.equal(reviewerProfileFor(item)!.name, 'claude-reviewer');
    assert.deepEqual(exhaustedReviewerProfiles(item), []);
  }
  assert.equal(reviewerProfileFor(work({ policy: { checks: ['test'], review: true, reviewProvider: 'codex' } })), null);
});

test('the agent review gate accepts only the dispatched, registered, currently selected identity', () => {
  assert.equal(reviewGate(work()).passed, true);
  const refused: [string, Partial<Work>][] = [
    ['no dispatched request', { reviewRequest: null }],
    ['request for another commit', { reviewRequest: { ...work().reviewRequest!, sha: other } }],
    ['request for another base', { reviewRequest: { ...work().reviewRequest!, baseSha: other } }],
    ['request for another policy revision', { reviewRequest: { ...work().reviewRequest!, policyRevision: 2 } }],
    ['request for another profile', { reviewRequest: { ...work().reviewRequest!, profile: 'cursor-reviewer', reviewerApp: 'cursor-reviewer' } }],
    ['legacy Codex request record', { reviewRequest: { ...work().reviewRequest!, provider: 'codex' } }],
  ];
  for (const [reason, override] of refused) assert.equal(reviewGate(work(override)).passed, false, reason);
  const verdicts: [string, Record<string, unknown>][] = [
    ['unapproved', { approved: false }],
    ['another commit', { sha: other }],
    ['another dispatch', { requestId: 901 }],
    ['another provider', { provider: 'codex' }],
    ['another profile', { profile: 'cursor-reviewer' }],
    ['another reviewer App', { reviewerApp: 'cursor-reviewer' }],
    ['no identity', { profile: undefined, reviewerApp: undefined }],
  ];
  for (const [reason, override] of verdicts) {
    const item = work();
    item.observation!.agentReview = { ...item.observation!.agentReview!, ...override } as any;
    assert.equal(reviewGate(item).passed, false, reason);
  }
  // A profile removed from the policy cannot keep approving through an old observation.
  const removed = work();
  removed.policy = { ...removed.policy, reviewerProfiles: [profiles[1]] };
  assert.equal(reviewGate(removed).passed, false);
  // Once the dispatched profile is recorded exhausted, its verdict no longer counts.
  const failedOver = work({ reviewFailovers: [{ profile: 'claude-reviewer', reviewerApp: 'claude-reviewer', runtime: 'claude', exhaustion: 'timeout', reason: 'silent', at: new Date().toISOString(), sha: head, baseSha: base, policyRevision: 3, requestCommentId: 900, nextProfile: 'cursor-reviewer' }] });
  assert.equal(reviewGate(failedOver).passed, false);
  const exhausted = work({ reviewFailovers: profiles.map(profile => ({ profile: profile.name, reviewerApp: profile.reviewerApp, runtime: profile.runtime, exhaustion: 'usage-limit' as const, reason: 'quota', at: new Date().toISOString(), sha: head, baseSha: base, policyRevision: 3, requestCommentId: 900, nextProfile: null })) });
  assert.match(reviewGate(exhausted).reasons[0], /Every configured reviewer profile is exhausted/);
  // Outstanding native change requests still block an approved agent verdict.
  const contested = work();
  contested.observation!.reviews = [{ reviewer: 'human', sha: head, state: 'CHANGES_REQUESTED' }];
  assert.equal(reviewGate(contested).passed, false);
});
