import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { GitHub, CHECK_NAME } from '../src/github.js';
import { evaluate, type Evidence, type Observation, type Work } from '../src/model.js';
import { agentOwner, assertMergeCandidate, buildMasterStatus, mergeWork } from '../src/master.js';
import { nameUnresolvedThreads, queueRef } from '../src/merge-queue.js';
import { decisionReasonMax, fitDecisionReason, observedFrom, reworkDecisionReason, reworkGroundsMin, routineDecision, threadResolutionGraceMs } from '../src/master-daemon.js';

// GY-139. Each test is named for the proof it produces: integration:unresolved-threads-fail-merge-gate,
// unit:unresolved-threads-surfaced, integration:blocked-merge-refused-before-execution.

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
      nodes: thread ? [{ id: `PRRT_thread${index}`, isResolved: thread.isResolved, isOutdated: thread.isOutdated ?? false, path: thread.path, line: thread.line, originalLine: thread.originalLine ?? thread.line, comments: { nodes: [{ author: { login: thread.author }, url: `https://github.com/owner/repo/pull/133#discussion_r${index}` }] } }] : [],
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

test('integration:unresolved-threads-fail-merge-gate — an unresolved thread fails the merge gate naming its author and path, and the same candidate with it resolved passes', async () => {
  const blocked = repository({ conversationResolution: true, threads: [{ isResolved: true, path: 'src/old.ts', line: 3, author: 'someone' }, open, { isResolved: false, isOutdated: true, path: 'src/claims.ts', line: null, originalLine: 7, author: reviewer }] });
  const observed = await blocked.github.observe(candidate(null));
  // The observation records each unresolved thread with its author, path and line; the resolved one is not recorded.
  assert.deepEqual(observed.conversations, { required: true, unresolved: [
    { id: 'PRRT_thread1', author: reviewer, path: 'src/claims.ts', line: 42, outdated: false, url: 'https://github.com/owner/repo/pull/133#discussion_r1' },
    { id: 'PRRT_thread2', author: reviewer, path: 'src/claims.ts', line: 7, outdated: true, url: 'https://github.com/owner/repo/pull/133#discussion_r2' },
  ] });
  assert.equal(blocked.queries.length, 3, 'every page of threads is read');
  assert.equal(observed.protected, true); assert.equal(observed.mergeable, true);
  const refused = mergeGate(candidate(observed));
  assert.equal(refused.passed, false);
  assert.ok(refused.reasons.some(reason => reason.includes('conversation resolution') && reason.includes(`${reviewer} on src/claims.ts:42`) && reason.includes(`${reviewer} on src/claims.ts:7 (outdated)`)), refused.reasons.join('\n'));
  assert.equal(evaluate(candidate(observed), [], new Date(), ciAppIds).stage, 'merge', 'every earlier gate still passes: the merge gate is the one that refuses');

  // The same candidate once the threads are resolved: the merge gate passes outright.
  const resolved = repository({ conversationResolution: true, threads: [{ ...open, isResolved: true }] });
  const clear = await resolved.github.observe(candidate(null));
  assert.deepEqual(clear.conversations, { required: true, unresolved: [] });
  assert.deepEqual(mergeGate(candidate(clear)).reasons, []);
  assert.equal(mergeGate(candidate(clear)).passed, true);

  // Without required conversation resolution a thread blocks nothing, so none is read.
  const unrequired = repository({ conversationResolution: false, threads: [open] });
  const free = await unrequired.github.observe(candidate(null));
  assert.deepEqual(free.conversations, { required: false, unresolved: [] });
  assert.equal(unrequired.queries.length, 0);
  assert.equal(mergeGate(candidate(free)).passed, true);

  // An unresolved thread on a queued entry ejects it rather than holding the head of the queue.
  assert.match(evaluate(candidate(observed), [], new Date(), ciAppIds).queueEjection?.reason ?? '', /review thread is|review threads are/);
  // A final verification that sees a thread appear between its two reads refuses.
  let reads = 0; const graphql = blocked.github.graphql.bind(blocked.github);
  blocked.github.graphql = async (query, variables) => (++reads > 3 ? resolved.github.graphql(query, variables) : graphql(query, variables));
  await assert.rejects(blocked.github.verify(candidate(null)), /gates changed/);

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
const observation = (unresolved: { author: string; path: string; line: number | null; outdated: boolean }[], now: Date): Observation => ({
  candidate: { sha: head, baseSha: base, pr: 133, branch: 'graphyard/gy-130-2', author: 'worker' }, checks: [{ name: 'test', result: 'success', appId: 15368, id: 9 }],
  reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: 7 }], merged: false, mergeSha: null, mergeable: true, protected: true, prState: 'open', draft: false,
  baseTip: base, baseTree, baseTipContained: true, files: ['src/claims.ts'], scopeFiles: [], at: now.toISOString(), conversations: { required: true, unresolved },
});
const status = (work: Work, now: Date) => nameUnresolvedThreads(buildMasterStatus({ work: [work], now: now.toISOString() }, [], [], {}), [work], agentOwner);

test('unit:unresolved-threads-surfaced — master status lists the unresolved threads, names rework as the remedy, and never reports the candidate mergeable', async () => {
  const now = new Date();
  const ready = status(authorized(observation([], now), now), now);
  assert.equal(ready.work[0].mergeable, true, 'the same candidate with no thread open is mergeable');
  assert.deepEqual(ready.work[0].reviewThreads, []);

  const thread = { author: reviewer, path: 'src/claims.ts', line: 42, outdated: false };
  const blocked = authorized(observation([thread], now), now);
  const report = status(blocked, now);
  const row = report.work[0];
  assert.equal(row.mergeable, false);
  assert.equal(report.counts.mergeable, 0);
  assert.deepEqual(row.reviewThreads, [thread]);
  const text = `Branch protection requires conversation resolution and 1 review thread is unresolved on ${head.slice(0, 12)}: ${reviewer} on src/claims.ts:42. GitHub blocks the merge until each is resolved; rework the candidate to address the findings, never dismiss them`;
  assert.equal(row.attention, text);
  assert.equal(row.attentionOwner?.role, 'master'); assert.equal(row.attentionOwner?.approvedBy, 'approver'); assert.equal(row.attentionOwner?.human, false);
  assert.equal(row.attentionOwner?.next, `graphyard master decide GY-130 rework 'Address the unresolved review threads: ${reviewer} on src/claims.ts:42. Fix each finding; resolving or dismissing a thread the master did not write is not the master'\\''s call'`);
  assert.deepEqual(report.attentionItems.filter(item => item.subject === 'GY-130').map(item => item.text), [text], 'the row and the attention list say the same thing, once');
  assert.equal(report.counts.attention, report.work.filter(entry => entry.attention).length);

  // A record whose gates were decided before the thread was observed is still not mergeable.
  const stale = authorized(observation([], now), now);
  stale.observation = observation([thread], now);
  const demoted = status(stale, now);
  assert.equal(demoted.work[0].mergeable, false); assert.equal(demoted.counts.mergeable, 0);
  assert.equal(demoted.work[0].attention, text);

  // A path and author are contributor-controlled: whatever they contain, the remedy is one command
  // whose reason is a single argument, so following it can never run anything the path names.
  const hostile = { author: `bot"'$(touch pwned)`, path: `src/$(touch pwned)"; echo 'x\`id\`.ts`, line: 1, outdated: false };
  const next = status(authorized(observation([hostile], now), now), now).work[0].attentionOwner!.next!;
  const argv = JSON.parse(execFileSync('bash', ['-c', `set -- ${next.replace(/^graphyard master decide /, '')}; printf '%s\\0' "$@" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.split("\\0").slice(0,-1))))'`], { encoding: 'utf8' }));
  assert.equal(argv.length, 3, 'the key, the action and the reason, nothing more');
  assert.deepEqual(argv.slice(0, 2), ['GY-130', 'rework']);
  assert.ok(argv[2].includes(`${hostile.author} on ${hostile.path}:1`), 'the reason carries the thread verbatim, unexpanded');

  const guide = (await readFile(new URL('../docs/master-agent.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  assert.match(guide, /An unresolved review thread is a finding to fix/);
  assert.match(guide, /Resolving a thread the master did not write is not the master's call/);
});

test('integration:blocked-merge-refused-before-execution — master merge refuses a candidate with unresolved threads before any merge execution is issued', async () => {
  const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs', repository: 'owner/repo', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-repo',
    autoMerge: true, mergeMethod: 'merge' as const, workers: [], reviewers: [], producers: [], run: { intervalSeconds: 20, deploymentShaField: 'commit', dispatchIntervalSeconds: 10, producerTimeoutMinutes: 120 } };
  const now = new Date();
  const thread = { author: reviewer, path: 'src/claims.ts', line: 42, outdated: false };
  // As the engine records it: the merge gate refuses over the thread. And as a stale record would
  // carry it: every gate green and an authorization granted before the thread was observed.
  const evaluated = authorized(observation([thread], now), now);
  const stale = authorized(observation([], now), now);
  stale.observation = observation([thread], now);
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
    assert.throws(() => assertMergeCandidate(record, new Date().toISOString(), 'graphyard-master#interactive'), /conversation resolution and 1 review thread is unresolved/);
  }
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

test('a thread rework request stays within the control plane\'s reason bound however many threads, and however long their paths', () => {
  const now = new Date('2026-09-24T06:00:00Z');
  const threads = Array.from({ length: 40 }, (_, index) => ({ id: `PRRT_${index}`, author: reviewer, path: `src/${'deeply/nested/'.repeat(20)}file-${index}.ts`, line: index + 1, outdated: false }));
  const work = { ...candidate(observation(threads, now)), policy: { checks: ['test'], review: false } } as unknown as Work;
  const decision = routineDecision(work, { autoMerge: true }, now.getTime())!;
  assert.equal(decision.action, 'rework');
  assert.match(decision.reason, /40 review threads are unresolved/);
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
