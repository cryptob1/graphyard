import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeAgentReview } from '../src/agent-review.js';
import { assertReviewerProfiles, evaluate, exhaustedReviewerProfiles, nativeReviewRequired, parseReviewerApps, policySchema, reviewerProfileFor, type ReviewerApp, type ReviewerProfile, type Work } from '../src/model.js';

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
    criteria: [{ id: 'AC-1', text: 'Reviewed', proofs: ['integration:claim-safety'] }], plannedFiles: [],
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
      protected: true, files: [], at: now, prState: 'open', draft: false,
      agentReview: { provider: 'agent', sha: head, approved: true, reason: 'approved', requestId: 900, profile: 'claude-reviewer', reviewerApp: 'claude-reviewer' } },
    ...overrides,
  } as Work;
}
const reviewGate = (item: Work) => evaluate(item, [item], new Date(), [15368]).gates.find(gate => gate.name === 'review')!;

test('policy validation binds agent review to registered, distinct reviewer identities', () => {
  const agent = policySchema.parse({ checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer' }] });
  assert.equal(agent.reviewerProfiles![0].timeoutSeconds, 1800);
  assert.throws(() => policySchema.parse({ checks: ['test'], review: true, reviewProvider: 'agent' }), /at least one reviewer profile/);
  assert.throws(() => policySchema.parse({ checks: ['test'], review: false, reviewProvider: 'agent', reviewerProfiles: profiles }), /review: true/);
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
  assert.equal(nativeReviewRequired({ checks: ['test'], review: false }), false);
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

const marker = '22222222-2222-4222-8222-222222222222';
const requestedAt = '2026-01-01T00:00:00Z', verdictAt = '2026-01-01T00:05:00Z';
const now = Date.parse('2026-01-01T00:06:00Z');
function adapter() {
  const profile: ReviewerProfile = { name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer', timeoutSeconds: 1800 };
  const app = registry[0];
  const request = { commentId: 500, sha: head, baseSha: base, policyRevision: 3, body: 'Graphyard requests a review', createdAt: requestedAt,
    provider: 'agent' as const, profile: profile.name, reviewerApp: app.id, marker };
  const trigger: any = { id: 500, user: { type: 'Bot', id: 999 }, performed_via_github_app: { id: GRAPHYARD_APP }, body: request.body, created_at: requestedAt, updated_at: requestedAt };
  const verdict: any = { id: 501, user: { type: 'Bot', id: CLAUDE_BOT }, performed_via_github_app: { id: CLAUDE_APP },
    body: `Reviewed the diff; no blocking findings.\n\n<!-- graphyard-verdict:${marker} head:${head} verdict:approved -->`, created_at: verdictAt, updated_at: verdictAt };
  const comments: any[] = [trigger, verdict];
  const reviews: any[] = [];
  let authorId = 12_345;
  const source = {
    async pages(path: string) { return structuredClone(path.endsWith('/reviews') ? reviews : comments); },
    async request(path: string) { return structuredClone(comments.find(comment => path.endsWith(`/${comment.id}`))); },
  };
  return { profile, app, request, trigger, verdict, comments, reviews, source,
    author: (id: number) => { authorId = id; },
    run: (clock = now) => observeAgentReview(source, 7, head, reviews, authorId, request, base, 3, GRAPHYARD_APP, profile, app, clock) };
}

test('an identity-bound verdict approves exactly the dispatched candidate', async () => {
  const f = adapter();
  const result = await f.run();
  assert.equal(result.approved, true);
  assert.equal(result.provider, 'agent'); assert.equal(result.sha, head);
  assert.equal(result.profile, 'claude-reviewer'); assert.equal(result.reviewerApp, 'claude-reviewer');
  assert.equal(result.requestId, 500); assert.equal(result.verdictId, 501);
  assert.equal(result.completedAt, new Date(verdictAt).toISOString());
});

test('only the registered reviewer App identity can approve, never the author or control plane', async () => {
  for (const spoof of [
    (f: ReturnType<typeof adapter>) => { f.verdict.performed_via_github_app.id = GRAPHYARD_APP; },
    (f: ReturnType<typeof adapter>) => { f.verdict.performed_via_github_app.id = CURSOR_APP; },
    (f: ReturnType<typeof adapter>) => { f.verdict.user.id = CURSOR_BOT; },
    (f: ReturnType<typeof adapter>) => { f.verdict.user.type = 'User'; },
  ]) { const f = adapter(); spoof(f); assert.equal((await f.run()).approved, false); }
  const author = adapter(); author.author(CLAUDE_BOT);
  const authored = await author.run();
  assert.equal(authored.approved, false); assert.match(authored.reason, /independent of the pull request author/);
  const controlPlane = adapter();
  const selfReview = await observeAgentReview(controlPlane.source, 7, head, [], 12_345, controlPlane.request, base, 3, CLAUDE_APP, controlPlane.profile, controlPlane.app, now);
  assert.equal(selfReview.approved, false); assert.match(selfReview.reason, /control-plane App/);
});

test('a verdict must correlate to the exact recorded request, commit, base and policy revision', async () => {
  for (const change of [
    (f: ReturnType<typeof adapter>) => { f.request.sha = other; },
    (f: ReturnType<typeof adapter>) => { f.request.baseSha = other; },
    (f: ReturnType<typeof adapter>) => { f.request.policyRevision = 4; },
    (f: ReturnType<typeof adapter>) => { (f.request as any).profile = 'cursor-reviewer'; },
    (f: ReturnType<typeof adapter>) => { (f.request as any).reviewerApp = 'cursor-reviewer'; },
    (f: ReturnType<typeof adapter>) => { (f.request as any).provider = 'codex'; },
    (f: ReturnType<typeof adapter>) => { (f.request as any).marker = undefined; },
  ]) { const f = adapter(); change(f); assert.equal((await f.run()).approved, false); }
  const stale = adapter();
  stale.verdict.body = stale.verdict.body.replace(marker, '33333333-3333-4333-8333-333333333333');
  const staleResult = await stale.run();
  assert.equal(staleResult.approved, false); assert.match(staleResult.reason, /Waiting for reviewer profile/);
  const early = adapter(); early.verdict.created_at = early.verdict.updated_at = '2025-12-31T23:59:59Z';
  assert.equal((await early.run()).approved, false);
  const wrongCommit = adapter(); wrongCommit.verdict.body = wrongCommit.verdict.body.replace(head, other);
  const wrongResult = await wrongCommit.run();
  assert.equal(wrongResult.approved, false); assert.match(wrongResult.reason, /different commit/);
  for (const forged of [
    (f: ReturnType<typeof adapter>) => { f.trigger.body += ' edited'; },
    (f: ReturnType<typeof adapter>) => { f.trigger.updated_at = '2026-01-01T00:01:00Z'; },
    (f: ReturnType<typeof adapter>) => { f.trigger.performed_via_github_app.id = CLAUDE_APP; },
    (f: ReturnType<typeof adapter>) => { f.comments.splice(f.comments.indexOf(f.trigger), 1); },
  ]) { const f = adapter(); forged(f); const result = await f.run(); assert.equal(result.approved, false); assert.match(result.reason, /review request is missing or edited/); }
});

test('findings, newer activity, edits and unsupported formats refuse instead of approving', async () => {
  const findings = adapter();
  findings.verdict.body = findings.verdict.body.replace('verdict:approved', 'verdict:changes-requested');
  const requested = await findings.run();
  assert.equal(requested.approved, false); assert.equal(requested.exhausted, undefined); assert.match(requested.reason, /requested changes/);
  for (const change of [
    (f: ReturnType<typeof adapter>) => { f.verdict.updated_at = '2026-01-01T00:05:30Z'; },
    (f: ReturnType<typeof adapter>) => { f.reviews.push({ user: { id: CLAUDE_BOT, type: 'Bot' }, performed_via_github_app: { id: CLAUDE_APP }, submitted_at: '2026-01-01T00:04:00Z' }); },
    (f: ReturnType<typeof adapter>) => { f.comments.push({ ...f.verdict, id: 502, body: 'One more thing: this is broken.', created_at: '2026-01-01T00:05:30Z', updated_at: '2026-01-01T00:05:30Z' }); },
    (f: ReturnType<typeof adapter>) => { f.comments.push({ ...f.verdict, id: 502 }); },
  ]) { const f = adapter(); change(f); assert.equal((await f.run()).approved, false); }
  for (const body of ['<!-- graphyard-verdict:not-a-uuid head:x verdict:approved -->', `<!-- graphyard-verdict:${marker} head:${head} verdict:approved --><!-- graphyard-verdict:${marker} head:${head} verdict:approved -->`]) {
    const f = adapter(); f.verdict.body = body;
    const result = await f.run();
    assert.equal(result.approved, false); assert.match(result.reason, /unsupported verdict format/);
  }
  const unknown = adapter(); unknown.verdict.body = unknown.verdict.body.replace('verdict:approved', 'verdict:probably-fine');
  const unknownResult = await unknown.run();
  assert.equal(unknownResult.approved, false); assert.match(unknownResult.reason, /unsupported verdict decision/);
});

test('evidence changing during collection refuses the snapshot', async () => {
  for (const target of ['verdict', 'trigger'] as const) {
    const f = adapter(); const original = f.source.pages.bind(f.source); let reads = 0;
    f.source.pages = async (path: string) => {
      const rows = await original(path);
      if (path.endsWith('/comments') && ++reads > 1) rows.find((row: any) => row.id === f[target].id).body += ' edited';
      return rows;
    };
    const result = await f.run();
    assert.equal(result.approved, false); assert.match(result.reason, /changed while collecting|missing or edited/);
  }
  const added = adapter(); const originalPages = added.source.pages.bind(added.source); let reads = 0;
  added.source.pages = async (path: string) => {
    const rows = await originalPages(path);
    if (path.endsWith('/comments') && ++reads > 1) rows.push({ ...added.verdict, id: 503, body: 'late finding', created_at: '2026-01-01T00:05:59Z', updated_at: '2026-01-01T00:05:59Z' });
    return rows;
  };
  assert.equal((await added.run()).approved, false);
  const late = adapter(); const originalRequest = late.source.request.bind(late.source);
  late.source.request = async (path: string) => { const row = await originalRequest(path); if (path.endsWith('/501')) row.body += ' edited'; return row; };
  assert.equal((await late.run()).approved, false);
});

test('usage limits and silence past the configured timeout report provider exhaustion', async () => {
  const quota = adapter();
  quota.verdict.body = `Out of quota.\n\n<!-- graphyard-verdict:${marker} head:${head} verdict:usage-limit -->`;
  const limited = await quota.run();
  assert.equal(limited.approved, false); assert.equal(limited.exhausted, true); assert.equal(limited.exhaustion, 'usage-limit');
  assert.equal(limited.profile, 'claude-reviewer'); assert.equal(limited.reviewerApp, 'claude-reviewer');
  // A repeated usage-limit reply is still capacity exhaustion, not an ambiguous verdict.
  quota.comments.push({ ...quota.verdict, id: 502, created_at: '2026-01-01T00:05:30Z', updated_at: '2026-01-01T00:05:30Z' });
  assert.equal((await quota.run()).exhausted, true);
  const silent = adapter(); silent.comments.splice(silent.comments.indexOf(silent.verdict), 1);
  const waiting = await silent.run();
  assert.equal(waiting.exhausted, undefined); assert.match(waiting.reason, /Waiting for reviewer profile/);
  const expired = await silent.run(Date.parse(requestedAt) + 1800_001);
  assert.equal(expired.exhausted, true); assert.equal(expired.exhaustion, 'timeout');
  // A timeout never overrides an approval that already arrived.
  assert.equal((await adapter().run(Date.parse(requestedAt) + 1800_001)).approved, true);
  // Conflicting verdicts refuse without failing over.
  const conflicting = adapter();
  conflicting.comments.push({ ...conflicting.verdict, id: 502, body: conflicting.verdict.body.replace('verdict:approved', 'verdict:usage-limit'), created_at: '2026-01-01T00:05:30Z', updated_at: '2026-01-01T00:05:30Z' });
  const conflicted = await conflicting.run();
  assert.equal(conflicted.approved, false); assert.equal(conflicted.exhausted, undefined); assert.match(conflicted.reason, /conflicting verdicts/);
});
