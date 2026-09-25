import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GitHub, CHECK_NAME } from '../src/github.js';
import { evaluate, type Evidence, type Observation, type Work } from '../src/model.js';
import { agentOwner, assertMergeCandidate, buildMasterStatus, mergeWork } from '../src/master.js';
import { nameUnresolvedThreads, queueRef } from '../src/merge-queue.js';
import { unansweredRefusal, uncitedRefusals } from '../src/model/approval.js';
import { botThreadReworkRounds, decisionReasonMax, fitDecisionReason, observedFrom, reworkDecisionReason, reworkGroundsMin, routineDecision, threadResolutionGraceMs } from '../src/master-daemon.js';

// The review gate is the configured reviewer's verdict on the exact head plus required CI. Unresolved
// review threads (a bot's findings above all) are that reviewer's inputs, not merge blockers: they are
// observed and listed, the reviewer's approval names the ones it fixed or overrides, and the loop sends
// an item back for threads still open after its review only in its first two rework rounds. Only a
// branch whose protection still requires conversation resolution — drift from the desired protection —
// refuses a merge, since GitHub would refuse it too. Each test is named for the proof it produces.

const head = 'a'.repeat(40), base = 'b'.repeat(40), baseTree = `f${'b'.repeat(39)}`;
const ciAppIds = [15368];
const reviewer = 'chatgpt-codex-connector[bot]';
type Thread = { isResolved: boolean; isOutdated?: boolean; path: string; line: number | null; originalLine?: number | null; author: string };

/** The GitHub adapter behind a stubbed transport: REST for the pull request, GraphQL for its review threads. */
function repository(options: { conversationResolution: boolean; threads: Thread[] }) {
  const pr: any = { number: 133, head: { sha: head, ref: 'graphyard/gy-130-2', repo: { full_name: 'owner/repo' } }, base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } },
    user: { login: 'worker' }, merged: false, mergeable: true, draft: false, state: 'open', merge_commit_sha: null, created_at: '2026-09-23T09:00:00Z' };
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  const queries: any[] = [];
  github.request = async (path, method = 'GET') => {
    if (method !== 'GET') throw new Error(`Unexpected ${method} ${path}`);
    if (path === '/pulls/133') return structuredClone(pr);
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: baseTree } } };
    if (path.startsWith('/compare/')) return { status: 'ahead', files: [] };
    if (path.includes('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true },
      required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
      required_conversation_resolution: { enabled: options.conversationResolution } };
    if (path.includes('/reviews')) return [{ id: 7, user: { login: 'graphyard-reviewer[bot]' }, commit_id: head, state: 'APPROVED', submitted_at: '2026-09-23T10:00:00Z' }];
    if (path.includes('/files')) return [{ filename: 'src/claims.ts', status: 'modified', sha: 'c'.repeat(40), additions: 3, deletions: 1, patch: '@@' }];
    if (path.includes('/check-runs')) return { check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }] };
    throw new Error(`Unexpected request ${path}`);
  };
  // GitHub pages the threads; the stub serves them one per page so pagination is exercised.
  github.graphql = async (query, variables) => {
    queries.push({ query, variables });
    const index = variables.after === null ? 0 : Number(variables.after);
    const thread = options.threads[index];
    return { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: index + 1 < options.threads.length, endCursor: String(index + 1) },
      nodes: thread ? [{ id: `PRRT_thread${index}`, isResolved: thread.isResolved, isOutdated: thread.isOutdated ?? false, path: thread.path, line: thread.line, originalLine: thread.originalLine ?? thread.line, comments: { nodes: [{ author: { login: thread.author.replace(/\[bot\]$/, ''), __typename: thread.author.endsWith('[bot]') ? 'Bot' : 'User' }, url: `https://github.com/owner/repo/pull/133#discussion_r${index}` }] } }] : [],
    } } } };
  };
  return { github, queries };
}

/** A candidate that has passed every gate but the last: approved, green, proven, and at the head of the queue with its tip published. */
function candidate(observation: Observation | null): Work {
  const at = observation?.at ?? new Date().toISOString();
  const work = {
    id: 'gy-130', key: 'GY-130', title: 'Consent prompts', description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['integration:consent'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/claims.ts'], stage: 'merge', revision: 9, policyRevision: 1, createdAt: at, updatedAt: at,
    stageEnteredAt: at, ready: true, epoch: 2, lease: null,
    workspaces: [{ host: 'machine', path: '/srv/GY-130-2', branch: 'graphyard/gy-130-2', epoch: 2, owner: 'worker' }],
    candidate: { sha: head, baseSha: base, pr: 133, branch: 'graphyard/gy-130-2', author: 'worker' },
    submission: { epoch: 2, pr: 133 }, reworkRequested: false, scenarioRequirements: [],
    evidence: [{ id: 'e-1', proof: 'integration:consent', sha: head, baseSha: base, policyRevision: 1, producer: 'ci-runner', trusted: true, result: 'pass', executed: 4, skipped: 0, at } as Evidence],
    queue: { sequence: 1, enqueuedAt: at, policyRevision: 1, speculation: { ref: queueRef('GY-130'), tip: head, base, baseTree, predecessors: [], policyRevision: 1, publishedAt: at } },
    queueSequence: 1, observation, blocker: null, gates: [], violations: [],
  } as unknown as Work;
  return work;
}
const mergeGate = (work: Work, now = new Date()) => evaluate(work, [work], now, ciAppIds).gates.find(gate => gate.name === 'merge')!;
const open: Thread = { isResolved: false, path: 'src/claims.ts', line: 42, author: reviewer };

test('integration:threads-not-merge-blockers — unresolved threads pass the merge gate; only protection that still requires conversation resolution refuses', async () => {
  const bot = reviewer.replace(/\[bot\]$/, '');
  const threads: Thread[] = [{ isResolved: true, path: 'src/old.ts', line: 3, author: 'someone' }, open, { isResolved: false, isOutdated: true, path: 'src/claims.ts', line: null, originalLine: 7, author: reviewer }];
  const recorded = [
    { id: 'PRRT_thread1', author: bot, bot: true, path: 'src/claims.ts', line: 42, outdated: false, url: 'https://github.com/owner/repo/pull/133#discussion_r1' },
    { id: 'PRRT_thread2', author: bot, bot: true, path: 'src/claims.ts', line: 7, outdated: true, url: 'https://github.com/owner/repo/pull/133#discussion_r2' },
  ];
  // The desired protection: conversation resolution off. The reviewer reads threads at launch; the
  // observation spends no GraphQL read on them. Open threads on the record still refuse nothing.
  const unrequired = repository({ conversationResolution: false, threads });
  assert.deepEqual((await unrequired.github.observe(candidate(null))).conversations, { required: false, unresolved: [] });
  assert.equal(unrequired.queries.length, 0);
  const observed = { ...(await unrequired.github.observe(candidate(null))), conversations: { required: false, unresolved: recorded } };
  const gate = mergeGate(candidate(observed));
  assert.deepEqual(gate.reasons, [], 'two open bot threads refuse nothing: the approval of this head is the review gate');
  assert.equal(gate.passed, true);
  assert.equal(evaluate(candidate(observed), [], new Date(), ciAppIds).queueEjection ?? null, null, 'nor do they eject the queued entry');

  // Protection drift: a branch that still requires conversation resolution is a merge GitHub refuses.
  const drift = repository({ conversationResolution: true, threads });
  const drifted = await drift.github.observe(candidate(null));
  assert.deepEqual(drifted.conversations, { required: true, unresolved: recorded });
  const refused = mergeGate(candidate(drifted));
  assert.equal(refused.passed, false);
  assert.ok(refused.reasons.some(reason => reason.startsWith('Branch protection still requires conversation resolution') && reason.includes(`${bot} on src/claims.ts:42`) && reason.includes('graphyard master protection --apply')), refused.reasons.join('\n'));
  assert.match(evaluate(candidate(drifted), [], new Date(), ciAppIds).queueEjection?.reason ?? '', /still requires conversation resolution/);
  // Drift with every thread resolved merges as before.
  const resolved = repository({ conversationResolution: true, threads: [{ ...open, isResolved: true }] });
  const clear = await resolved.github.observe(candidate(null));
  assert.deepEqual(clear.conversations, { required: true, unresolved: [] });
  assert.equal(mergeGate(candidate(clear)).passed, true);

  // A final verification that sees a thread appear between its two reads refuses: the observation changed.
  let reads = 0; const graphql = drift.github.graphql.bind(drift.github);
  drift.github.graphql = async (query, variables) => (++reads > 3 ? resolved.github.graphql(query, variables) : graphql(query, variables));
  await assert.rejects(drift.github.verify(candidate(null)), /gates changed/);

  // GitHub answers a GraphQL rate limit with 200 and a RATE_LIMITED error: it pauses the client
  // like a REST rate limit, rather than reading as an ordinary failure or as zero threads.
  const limited = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  (limited as any).apiRequest = async () => ({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] });
  await assert.rejects(limited.unresolvedThreads(133), /rate limited; requests paused until/);
  assert.ok((limited as any).blockedUntil > Date.now(), 'the client is paused');
});

/** The record a merge-ready candidate carries once the engine evaluated it and granted authorization. */
function authorized(observation: Observation, now: Date): Work {
  const work = candidate(observation);
  const result = evaluate(work, [work], now, ciAppIds);
  Object.assign(work, { stage: result.stage, gates: result.gates, queue: result.queue, queueSequence: result.queueSequence, queueEjection: result.queueEjection });
  if (result.gates.every(gate => gate.passed)) work.mergeAuthorization = { sha: head, baseSha: base, policyRevision: 1 } as Work['mergeAuthorization'];
  return work;
}
const observation = (unresolved: { author: string; path: string; line: number | null; outdated: boolean; bot?: boolean }[], now: Date, required = false): Observation => ({
  candidate: { sha: head, baseSha: base, pr: 133, branch: 'graphyard/gy-130-2', author: 'worker' }, checks: [{ name: 'test', result: 'success', appId: 15368, id: 9 }],
  reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: 7 }], merged: false, mergeSha: null, mergeable: true, protected: true, prState: 'open', draft: false,
  baseTip: base, baseTree, baseTipContained: true, files: ['src/claims.ts'], scopeFiles: [], at: now.toISOString(), conversations: { required, unresolved },
});
const status = (work: Work, now: Date) => nameUnresolvedThreads(buildMasterStatus({ work: [work], now: now.toISOString() }, [], [], {}), [work], agentOwner);

test('unit:unresolved-threads-surfaced — master status lists the open threads without demoting the candidate, and names protection reconciliation, not rework, for protection drift', async () => {
  const now = new Date();
  const thread = { author: reviewer, path: 'src/claims.ts', line: 42, outdated: false };
  const report = status(authorized(observation([thread], now), now), now);
  const row = report.work[0];
  assert.equal(row.mergeable, true, 'an open thread does not keep an approved, green candidate from merging');
  assert.deepEqual(row.reviewThreads, [thread], 'the thread is listed for the record');
  assert.equal(row.attention, null);
  assert.equal(report.counts.mergeable, 1);

  // Protection drift: GitHub would refuse, so the row is not mergeable and the remedy is the protection.
  const drift = authorized(observation([thread], now, true), now);
  const drifted = status(drift, now), driftRow = drifted.work[0];
  assert.equal(driftRow.mergeable, false); assert.equal(drifted.counts.mergeable, 0);
  const text = `Branch protection still requires conversation resolution, which Graphyard's review gate does not use: GitHub refuses the merge of ${head.slice(0, 12)} while 1 thread stays open (${reviewer} on src/claims.ts:42). graphyard master protection --apply removes the requirement; the reviewer's approval of the head is the review gate`;
  assert.equal(driftRow.attention, text);
  assert.equal(driftRow.attentionOwner?.role, 'master'); assert.equal(driftRow.attentionOwner?.approvedBy, null);
  assert.match(driftRow.attentionOwner!.next!, /^graphyard master protection --apply/);
  assert.deepEqual(drifted.attentionItems.filter(item => item.subject === 'GY-130').map(item => item.text), [text], 'the row and the attention list say the same thing, once');

  const guide = (await readFile(new URL('../docs/master-agent.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  assert.match(guide, /Unresolved review threads are the reviewer's inputs, not merge blockers/);
  assert.match(guide, /Overridden threads:/);
});

test('integration:blocked-merge-refused-before-execution — master merge refuses before any execution only where protection still requires conversation resolution; an open thread alone refuses nothing', async () => {
  const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs', repository: 'owner/repo', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-repo',
    autoMerge: true, mergeMethod: 'merge' as const, workers: [], reviewers: [], producers: [], run: { intervalSeconds: 20, deploymentShaField: 'commit', dispatchIntervalSeconds: 10, producerTimeoutMinutes: 120 } };
  const now = new Date();
  const thread = { author: reviewer, path: 'src/claims.ts', line: 42, outdated: false };
  // Protection drift, as the engine records it (the merge gate refuses over the thread) and as a stale
  // record would carry it (every gate green, authorized before the thread was observed).
  const evaluated = authorized(observation([thread], now, true), now);
  const stale = authorized(observation([], now, true), now);
  stale.observation = observation([thread], now, true);
  assert.ok(stale.mergeAuthorization && stale.gates.every(gate => gate.passed));
  for (const work of [evaluated, stale]) {
    const acquired: unknown[] = [], provider: string[][] = [];
    const record = { ...work, mergeExecution: null } as Work;
    await assert.rejects(mergeWork(config, record, async () => ({ work: [record], now: new Date().toISOString() }),
      async (...args) => { acquired.push(args); throw new Error('acquire must not be called'); },
      async () => { throw new Error('cancel must not be called'); }, async () => { throw new Error('verify must not be called'); },
      (command, args) => { provider.push([command, ...args]); throw new Error('GitHub must not be called'); }, 'graphyard-master#interactive'),
    (error: Error) => error.message.includes('before any merge execution') && error.message.includes(`${reviewer} on src/claims.ts:42`));
    assert.equal(acquired.length, 0, 'no merge execution is requested');
    assert.equal(provider.length, 0, 'nothing is sent to GitHub');
    assert.equal(record.mergeExecution, null, 'no merge execution is recorded');
    assert.throws(() => assertMergeCandidate(record, new Date().toISOString(), 'graphyard-master#interactive'), /still requires conversation resolution/);
  }
  // Without the requirement the same open thread refuses nothing: the candidate is merge-ready.
  const free = authorized(observation([thread], now), now);
  assert.ok(free.mergeAuthorization && free.gates.every(gate => gate.passed), free.gates.flatMap(gate => gate.reasons).join('; '));
  assert.doesNotThrow(() => assertMergeCandidate({ ...free, mergeExecution: null } as Work, new Date().toISOString(), 'graphyard-master#interactive'));
});

test('the loop requests thread rework only after the current head\'s review settled without resolving the threads', () => {
  const now = new Date('2026-09-24T06:00:00Z');
  const thread = { author: reviewer, path: 'src/claims.ts', line: 42, outdated: false };
  const item = (reviews: Observation['reviews'], sessions: unknown[] = []) => ({ ...candidate({ ...observation([thread], now), reviews }), sessions } as unknown as Work);
  const decide = (work: Work) => routineDecision(work, { autoMerge: true }, now.getTime())?.action ?? null;
  const approvedAt = (ms: number) => [{ reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: 7, submittedAt: new Date(now.getTime() - ms).toISOString() }];
  const running = { id: 'r-1', kind: 'review', state: 'running', head, principal: 'reviewer', runtime: 'claude', host: 'h', subject: 'review', startedAt: now.toISOString(), updatedAt: now.toISOString(), endedAt: null, outcome: null };
  assert.equal(decide(item([])), null, 'no review of this head yet: the reviewer judges the threads first');
  assert.equal(decide(item([{ reviewer: 'chatgpt-codex-connector[bot]', sha: head, state: 'COMMENTED', id: 8 }])), null, 'a bot comment is not the review');
  assert.equal(decide(item(approvedAt(threadResolutionGraceMs * 2), [running])), null, 'a review session for this head is still running');
  assert.equal(decide(item(approvedAt(60_000))), null, 'approved moments ago: the loop is still resolving the threads it named');
  assert.equal(decide(item(approvedAt(threadResolutionGraceMs + 1))), 'rework', 'approved and the threads still stand');
  assert.equal(decide({ ...item([]), policy: { checks: ['test'], review: false } } as Work), 'rework', 'no review policy: nothing else judges the threads');
});

test('unit:bot-threads-advisory-after-round-2 — after two rework rounds a bot thread no longer sends the item back; a person\'s thread and the reviewer\'s own CHANGES_REQUESTED still do', () => {
  const now = new Date('2026-09-24T06:00:00Z');
  const settledReview = [{ reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: 7, submittedAt: new Date(now.getTime() - threadResolutionGraceMs - 1).toISOString() }];
  const botFinding: { id: string; author: string; bot?: boolean; path: string; line: number; outdated: boolean } = { id: 'PRRT_bot', author: 'chatgpt-codex-connector', bot: true, path: 'src/claims.ts', line: 42, outdated: false };
  const personFinding = { id: 'PRRT_person', author: 'maintainer', path: 'src/claims.ts', line: 9, outdated: false };
  const item = (rounds: number, threads: typeof botFinding[], reviews: Observation['reviews'] = settledReview) =>
    ({ ...candidate({ ...observation(threads, now), reviews }), pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: rounds, interventions: { blocked: 0, requirements: 0 } } } as unknown as Work);
  const decide = (work: Work) => routineDecision(work, { autoMerge: true }, now.getTime());
  assert.equal(botThreadReworkRounds, 2);
  assert.equal(decide(item(0, [botFinding]))?.action, 'rework', 'round 0: a bot finding the review left open is sent back');
  assert.equal(decide(item(1, [botFinding]))?.action, 'rework', 'round 1: still');
  assert.equal(decide(item(2, [botFinding])), null, 'after two rework rounds the bot finding is advisory');
  assert.equal(decide(item(5, [{ ...botFinding, bot: undefined, author: 'chatgpt-codex-connector[bot]' }])), null, 'a bot known by its login alone is advisory too');
  const person = decide(item(2, [botFinding, personFinding]))!;
  assert.equal(person.action, 'rework', "a person's thread still sends the item back");
  assert.match(person.reason, /1 review thread is still open .*maintainer on src\/claims\.ts:9/);
  assert.doesNotMatch(person.reason, /chatgpt-codex-connector/, 'the advisory bot thread is not a ground');
  // The reviewer's own verdict is never advisory.
  const refused = decide(item(4, [botFinding], [{ reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'CHANGES_REQUESTED', id: 8, submittedAt: now.toISOString() }]));
  assert.equal(refused?.action, 'rework');
  assert.match(refused!.binding, /:verdict:/);
});

test('a thread rework request stays within the control plane\'s reason bound however many threads, and however long their paths', () => {
  const now = new Date('2026-09-24T06:00:00Z');
  const threads = Array.from({ length: 40 }, (_, index) => ({ id: `PRRT_${index}`, author: reviewer, path: `src/${'deeply/nested/'.repeat(20)}file-${index}.ts`, line: index + 1, outdated: false }));
  const work = { ...candidate(observation(threads, now)), policy: { checks: ['test'], review: false } } as unknown as Work;
  const decision = routineDecision(work, { autoMerge: true }, now.getTime())!;
  assert.equal(decision.action, 'rework');
  assert.match(decision.reason, /40 review threads are still open/);
  assert.match(decision.reason, /and 35 more on the pull request/);
  assert.ok(threads.every(thread => decision.binding.includes(thread.id)), 'the binding still names every thread');
  // What the requester sends: the observation it decided from and every refusal it answers, kept whole.
  const answers = ` This rests on different grounds from refused rework decisions ${Array.from({ length: 8 }, (_, index) => `00000000-0000-4000-8000-00000000000${index}`).join(', ')}.`;
  const reason = fitDecisionReason(`${observedFrom(work)} `, `${decision.reason} ${'x'.repeat(3000)}`, answers);
  assert.ok(reason.length <= decisionReasonMax, `${reason.length} characters`);
  assert.ok(reason.startsWith(observedFrom(work)) && reason.endsWith(answers));
});

test('a rework request cites every refused rework decision by id within the reason bound, and is not sent once they cannot fit', () => {
  const now = new Date('2026-09-24T06:00:00Z');
  const threads = [{ id: 'PRRT_1', author: reviewer, path: 'src/a.ts', line: 1, outdated: false }];
  const work = { ...candidate(observation(threads, now)), policy: { checks: ['test'], review: false } } as unknown as Work;
  const decision = routineDecision(work, { autoMerge: true }, now.getTime())!;
  const prefix = `${observedFrom(work)} `;
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  for (const count of [1, 8, 30, 40]) {
    const reason = reworkDecisionReason(prefix, `${decision.reason} ${'x'.repeat(3000)}`, ids(count));
    assert.ok(reason !== null, `${count} refusals still fit`);
    assert.ok(reason.length <= decisionReasonMax, `${count} refusals: ${reason.length} characters`);
    assert.ok(reason.startsWith(observedFrom(work)), 'the observation is kept whole');
    assert.ok(ids(count).every(id => reason.includes(id)), `${count} refusals: every refusal is cited, as the server requires`);
    assert.ok(reason.slice(prefix.length).length - ids(count).join(' ').length >= reworkGroundsMin, 'the grounds keep their room');
  }
  // Past what the bound can hold beside the grounds, no reason satisfies the server: the loop escalates instead of retrying a refused request.
  assert.equal(reworkDecisionReason(prefix, decision.reason, ids(60)), null);
  assert.equal(reworkDecisionReason(prefix, decision.reason, []), fitDecisionReason(prefix, decision.reason, ''));
});

test('a refusal chain never outgrows the reason bound: answering the newest refusal answers every one it cited, and a precedent list cites like the reason', () => {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const input = { previousWorkerStopped: true };
  const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  // Sixty refusals, each request having cited the one before it (as the server required): newest first.
  const history = Array.from({ length: 60 }, (_, index) => 59 - index).map(index => ({ id: id(index), action: 'rework' as const, state: 'refused', input,
    reason: index ? `Grounds ${index}. Answers refused rework decisions ${id(index - 1)}.` : 'Grounds 0.', refusal: { approver: 'approver', reason: 'not yet', at: '2026-09-24T06:00:00Z' } }));
  assert.deepEqual(uncitedRefusals(history, 'rework', input, same), [id(59)], 'only the newest refusal is left for the request to cite');
  assert.equal(unansweredRefusal(history, 'rework', input, `New grounds. Answers refused rework decisions ${id(59)}.`, same), null, 'citing the newest answers the chain');
  assert.match(unansweredRefusal(history, 'rework', input, 'New grounds.', same)!, new RegExp(id(59)), 'citing nothing answers nothing');
  assert.equal(unansweredRefusal(history, 'rework', input, 'New grounds, cited structurally.', same, [id(59)]), null, 'a precedent citation answers like a reason citation');
  assert.match(unansweredRefusal(history, 'rework', input, `Grounds 59. Answers refused rework decisions ${id(58)}.`, same, [id(59)])!, new RegExp(id(59)), 'repeating a refused reason is not an answer, however it cites');
  // A refusal nobody in the chain cited (a legacy request) must still be cited itself.
  const legacy = [...history, { id: id(99), action: 'rework' as const, state: 'refused', input, reason: 'Legacy grounds.', refusal: null }];
  assert.deepEqual(uncitedRefusals(legacy, 'rework', input, same), [id(59), id(99)]);
  assert.match(unansweredRefusal(legacy, 'rework', input, `New grounds. Answers ${id(59)}.`, same)!, new RegExp(id(99)));
  assert.equal(unansweredRefusal(legacy, 'rework', input, `New grounds. Answers ${id(59)} ${id(99)}.`, same), null);
  const reason = reworkDecisionReason('', 'New grounds', uncitedRefusals(legacy, 'rework', input, same));
  assert.ok(reason && unansweredRefusal(legacy, 'rework', input, reason, same) === null, 'the loop\'s own reason answers every refusal');
});
