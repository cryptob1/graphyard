import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, unauthorizedMergeViolation } from '../src/engine.js';
import { CHECK_NAME, GitHub, gateMerge } from '../src/github.js';
import { masterConfigSchema, mergeExecutor, type MasterConfig } from '../src/master.js';
import { mergeQueueRuleset, mergeQueueRulesetName, protectionPlan, applyProtection } from '../src/protection.js';
import { queueRef, type MergeEnqueueRequest, type QueueSpeculation } from '../src/merge-queue.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-258: GitHub executes merges; Graphyard only gates them. The control plane's App publishes
// `Graphyard / merge` on the exact head and puts an authorized, requested pull request in GitHub's
// merge queue; it fails the check and dequeues on withdrawal; nothing in Graphyard calls the REST
// merge endpoint, and the one GraphQL merge (a clean PR without a queue, see
// merge-delegation-clean.test.ts) is bound to the head; and `master protection` writes the merge
// queue with the check required.

const head = 'a'.repeat(40), base = 'b'.repeat(40), moved = 'c'.repeat(40), groupHead = 'd'.repeat(40);
const pullRequestId = 'PR_kwDOgraphyard42';

function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  return { id: 'work-42', key: 'GY-42', title: 'Delegated merge', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { at: new Date().toISOString(), candidate, reviews: [], checks: [], protected: true, mergeable: true, merged: false, prState: 'open', draft: false, baseTip: base } as unknown as Observation,
    blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [],
    mergeAuthorization: { sha: head, baseSha: base, policyRevision: 2, at: new Date().toISOString() }, ...overrides } as Work;
}
const requested = (item: Work): MergeEnqueueRequest => ({ sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, requestedBy: 'master#daemon-1', at: new Date().toISOString() });

/**
 * The control-plane App against a fake GitHub: every REST call and GraphQL operation is recorded,
 * and the pull request's queue state is what the fake says it is.
 */
function fakeGitHub(options: { queue?: boolean; mode?: 'queued' | 'auto-merge' | 'none'; prHead?: string; groupHead?: string | null } = {}) {
  const calls: { path: string; method: string; body?: any }[] = [];
  const operations: { operation: string; variables: Record<string, unknown> }[] = [];
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  const prHead = options.prHead ?? head;
  github.request = async (path: string, method = 'GET', body?: unknown) => {
    calls.push({ path, method, body });
    if (method !== 'GET') return { id: 77 };
    if (path === '/pulls/42') return { number: 42, state: 'open', draft: false, head: { sha: prHead }, base: { ref: 'main', sha: base } };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: 'e'.repeat(40) } } };
    if (path.includes('/check-runs')) return { check_runs: [] };
    throw new Error(`Unexpected GitHub request ${method} ${path}`);
  };
  github.graphql = async (query: string, variables: Record<string, unknown>) => {
    const operation = /(enqueuePullRequest|dequeuePullRequest|enablePullRequestAutoMerge|disablePullRequestAutoMerge|mergePullRequest|mergeQueue\(branch)/.exec(query)?.[1] ?? 'unknown';
    operations.push({ operation, variables });
    if (operation === 'mergeQueue(branch') return { repository: { mergeQueue: options.queue === false ? null : { id: 'MQ_1' },
      pullRequest: { id: pullRequestId, headRefOid: prHead, isInMergeQueue: options.mode === 'queued', autoMergeRequest: options.mode === 'auto-merge' ? { enabledAt: new Date().toISOString() } : null,
        mergeQueueEntry: options.mode === 'queued' ? { state: 'AWAITING_CHECKS', position: 1, headCommit: options.groupHead === null ? null : { oid: options.groupHead ?? groupHead } } : null } } };
    return {};
  };
  const checks = () => calls.filter(call => call.method !== 'GET' && /\/check-runs/.test(call.path)).map(call => call.body);
  const named = (name: string) => operations.filter(entry => entry.operation === name);
  return { github, calls, operations, checks, named };
}

test('unit:authorized-head-enqueued — an authorized head gets Graphyard / merge success on that exact head and is enqueued in GitHub\'s merge queue (auto-merge without a queue); an unauthorized head is never enqueued', async () => {
  const item = work();
  const queued = fakeGitHub();
  const gated = await gateMerge(queued.github, item, requested(item));
  assert.equal(gated.action.kind, 'enqueue');
  const [check] = queued.checks();
  assert.equal(check.name, CHECK_NAME);
  assert.equal(check.head_sha, head, 'the check is published on the exact authorized head');
  assert.equal(check.conclusion, 'success');
  const enqueued = queued.named('enqueuePullRequest');
  assert.equal(enqueued.length, 1, 'the pull request is enqueued once');
  assert.deepEqual(enqueued[0].variables, { id: pullRequestId, head }, 'the enqueue binds the exact head GitHub may merge');
  const checkAt = queued.calls.findIndex(call => call.method !== 'GET' && /\/check-runs/.test(call.path));
  assert.ok(checkAt >= 0 && queued.operations.findIndex(entry => entry.operation === 'enqueuePullRequest') > 0, 'the check is written before the pull request is handed to GitHub');

  // A base branch without a merge queue: auto-merge bound to the same head instead.
  const unqueued = fakeGitHub({ queue: false });
  assert.equal((await gateMerge(unqueued.github, item, requested(item))).action.kind, 'enqueue');
  assert.equal(unqueued.named('enqueuePullRequest').length, 0);
  assert.deepEqual(unqueued.named('enablePullRequestAutoMerge').map(entry => entry.variables), [{ id: pullRequestId, head, method: 'MERGE' }]);

  // Already queued: nothing is enqueued twice, and the merge group commit GitHub builds gets the same verdict.
  const inQueue = fakeGitHub({ mode: 'queued' });
  assert.equal((await gateMerge(inQueue.github, item, requested(item))).action.kind, 'hold');
  assert.equal(inQueue.named('enqueuePullRequest').length, 0);
  assert.deepEqual(inQueue.checks().map(body => [body.head_sha, body.conclusion]), [[head, 'success'], [groupHead, 'success']]);

  // No authorization for the head: failure is published and nothing is enqueued.
  const refused = work({ gates: [{ name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], mergeAuthorization: null, stage: 'review' });
  const unauthorized = fakeGitHub();
  assert.equal((await gateMerge(unauthorized.github, refused, requested(refused))).action.kind, 'hold');
  assert.deepEqual(unauthorized.checks().map(body => [body.head_sha, body.conclusion]), [[head, 'failure']]);
  assert.equal(unauthorized.named('enqueuePullRequest').length + unauthorized.named('enablePullRequestAutoMerge').length, 0, 'an unauthorized head is never enqueued');

  // Authorized but never requested (automatic merging off, no approved decision yet): not enqueued.
  const unrequested = fakeGitHub();
  assert.equal((await gateMerge(unrequested.github, item, null)).action.kind, 'hold');
  assert.equal(unrequested.named('enqueuePullRequest').length, 0);
  // A request for another head does not authorize this one.
  const stale = fakeGitHub();
  assert.equal((await gateMerge(stale.github, item, { ...requested(item), sha: moved })).action.kind, 'hold');
  assert.equal(stale.named('enqueuePullRequest').length, 0);
});

test('unit:withdrawal-dequeues — a head change, a failing gate and a policy change each fail the check for that head and dequeue the pull request', async () => {
  const authorized = work();
  const withdrawals: { kind: string; item: Work; request: MergeEnqueueRequest; prHead?: string }[] = [
    // The worker pushed: the candidate is the new head, which nothing has authorized yet.
    { kind: 'head change', item: work({ candidate: { ...authorized.candidate!, sha: moved }, stage: 'review', mergeAuthorization: null,
      gates: [{ name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }] }), request: requested(authorized), prHead: moved },
    // A gate stopped passing on the same head: a required proof expired.
    { kind: 'failing gate', item: work({ stage: 'acceptance', mergeAuthorization: null, gates: [{ name: 'acceptance', passed: false, reasons: ['AC-1: unit:works needs trusted passing evidence'] }] }), request: requested(authorized) },
    // The requirements were revised: the authorization and the request name the old policy revision.
    { kind: 'policy change', item: work({ policyRevision: 3, stage: 'acceptance', gates: [{ name: 'acceptance', passed: false, reasons: ['AC-2: unit:new needs trusted passing evidence'] }] }), request: requested(authorized) },
  ];
  for (const withdrawal of withdrawals) for (const mode of ['queued', 'auto-merge'] as const) {
    const fake = fakeGitHub({ mode, prHead: withdrawal.prHead });
    const gated = await gateMerge(fake.github, withdrawal.item, withdrawal.request);
    assert.equal(gated.action.kind, 'dequeue', `${withdrawal.kind} (${mode}) dequeues`);
    assert.deepEqual(fake.checks().map(body => [body.head_sha, body.conclusion]), [[withdrawal.item.candidate!.sha, 'failure']], `${withdrawal.kind} (${mode}) fails the check on the head GitHub holds`);
    assert.deepEqual(fake.named(mode === 'queued' ? 'dequeuePullRequest' : 'disablePullRequestAutoMerge').map(entry => entry.variables), [{ id: pullRequestId }], `${withdrawal.kind} (${mode}) takes the pull request out of GitHub's hands`);
    assert.equal(fake.named('enqueuePullRequest').length, 0);
    const failedAt = fake.calls.findIndex(call => call.method !== 'GET' && /\/check-runs/.test(call.path));
    assert.ok(failedAt >= 0, 'the failure is published before the dequeue');
  }
  // A withdrawn head whose merge group GitHub already built never gets the group check.
  const fake = fakeGitHub({ mode: 'queued' });
  await gateMerge(fake.github, withdrawals[1].item, withdrawals[1].request);
  assert.equal(fake.checks().some(body => body.head_sha === groupHead), false);
});

/** Every source file Graphyard ships: the ones that could call GitHub's merge endpoint. */
async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sources(join(directory, entry.name)) : /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [join(directory, entry.name)] : []))).flat();
}

test('unit:no-graphyard-merge-call — the merge step requests the merge and GitHub performs it: no code path calls the GitHub merge endpoint', async () => {
  const directory = await temporaryDirectory('merge-delegation');
  try {
    const credentialFile = join(directory, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
    const item = work({ queue: { sequence: 1, enqueuedAt: new Date().toISOString(), policyRevision: 2,
      speculation: { ref: queueRef('GY-42'), tip: head, base, baseTree: 'e'.repeat(40), predecessors: [], policyRevision: 2, publishedAt: new Date().toISOString() } } } as Partial<Work>);
    const gh: string[][] = [];
    const run = async (_command: string, args: string[]) => {
      gh.push(args);
      if (args[1] === 'view') return JSON.stringify({ headRefOid: head, baseRefName: 'main', state: 'OPEN', isDraft: false });
      if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: base } });
      if (/\/commits\/[a-f0-9]{40}$/.test(args[1] ?? '')) return JSON.stringify({ sha: base, commit: { tree: { sha: 'e'.repeat(40) } } });
      throw new Error(`Unexpected gh ${args.join(' ')}`);
    };
    const mutations: { path: string; data: any }[] = [];
    const mutation = async (path: string, data: any) => { mutations.push({ path, data }); return { key: 'GY-42', revision: 9, enqueue: { ...data, at: new Date().toISOString() } }; };
    const outcome = await mergeExecutor(config, async () => ({ work: [item], now: new Date().toISOString() }), mutation, { principal: 'master', instance: 'daemon-1' }, randomUUID(), run as any)(item);
    assert.equal(outcome.pending, true, 'the merge step is pending until GitHub merges and the merged observation delivers it');
    assert.equal(outcome.enqueued, true);
    assert.deepEqual(mutations.map(entry => entry.path), ['work/work-42/merge-acquire'], 'the step records one request and nothing else');
    assert.equal(mutations[0].data.enqueue, true);
    assert.equal(mutations[0].data.sha, head);
    assert.equal(gh.some(args => args.includes('--method') || args.some(arg => /\/merge(\?|$)/.test(arg))), false, `no gh call mutates GitHub or names the merge endpoint: ${JSON.stringify(gh)}`);

    // The control plane's side: gating an authorized head makes no merge call either.
    const fake = fakeGitHub();
    await gateMerge(fake.github, item, requested(item));
    assert.equal(fake.calls.some(call => /\/merge(\?|$)/.test(call.path)), false);
    assert.equal(fake.named('mergePullRequest').length, 0);

    // And nowhere in the shipped source: no REST merge endpoint, and no GraphQL mergePullRequest that
    // is not bound to the authorized head (GitHub refuses auto-merge on a clean pull request, so a
    // clean one without a queue is merged at once with expectedHeadOid; branch protection still applies).
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files = [...await sources(join(root, 'src')), ...await sources(join(root, 'scripts')), ...await sources(join(root, 'bin'))];
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      text.split('\n').forEach((line, index) => {
        // A harness deny rule names the endpoint to forbid it; that is not a call.
        if (/Bash\(gh api \*pulls\/\*\/merge\*\)/.test(line)) return;
        if (/\bmergePullRequest\s*\(input: \{ pullRequestId: \$id, expectedHeadOid: \$head, mergeMethod: \$method \}\)/.test(line)) return;
        if (/pulls\/\$\{[^}]+\}\/merge\b|pulls\/\d+\/merge\b|\bmergePullRequest\s*\(/.test(line)) offenders.push(`${file.slice(root.length)}:${index + 1}`);
      });
    }
    assert.deepEqual(offenders, [], 'no source line calls the GitHub merge endpoint unbound to the head');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:protection-configures-merge-queue — master protection plans and applies the base branch merge queue with Graphyard / merge required from the App', async () => {
  const config = { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 };
  const protection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true },
    required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
  const open = [work({ policy: { checks: ['test'], review: true } })];

  const ruleset = mergeQueueRuleset(config);
  assert.equal(ruleset.name, mergeQueueRulesetName);
  assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/main']);
  assert.ok(ruleset.rules.some(rule => rule.type === 'merge_queue'), 'the plan carries a merge queue');
  assert.deepEqual(ruleset.rules.find(rule => rule.type === 'required_status_checks')?.parameters, { strict_required_status_checks_policy: false, required_status_checks: [{ context: CHECK_NAME, integration_id: 1234 }] });

  const missing = protectionPlan(protection, config, open, []);
  assert.equal(missing.consistent, false);
  assert.ok(missing.changes.some(change => /merge queue on main/.test(change)), missing.changes.join('; '));
  assert.ok(missing.changes.some(change => /merge queue required check Graphyard \/ merge/.test(change)));
  assert.deepEqual(missing.mergeQueue?.ruleset, ruleset, 'the protection plan includes the merge-queue configuration');

  const configured = protectionPlan(protection, config, open, [{ type: 'merge_queue', parameters: {} }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: CHECK_NAME, integration_id: 1234 }] } }]);
  assert.equal(configured.consistent, true, configured.changes.join('; '));
  // A same-named check from another App does not satisfy the queue.
  assert.equal(protectionPlan(protection, config, open, [{ type: 'merge_queue' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: CHECK_NAME, integration_id: 999 }] } }]).consistent, false);

  // Apply: the rules are read from the branch, the ruleset is written, then read back.
  let rules: unknown[] = [];
  const writes: { args: string[]; input?: string }[] = [];
  const run = (_command: string, args: string[], input?: string) => {
    if (args.includes('--method')) { writes.push({ args, input }); if (args.some(arg => arg.endsWith('/rulesets'))) rules = JSON.parse(input!).rules; return '{}'; }
    if (args[1].endsWith('/protection')) return JSON.stringify(protection);
    if (args[1].includes('/rules/branches/')) return JSON.stringify(rules);
    if (args[1].includes('/rulesets')) return '[]';
    throw new Error(`Unexpected gh ${args.join(' ')}`);
  };
  const applied = await applyProtection(config, open, run);
  assert.equal(applied.applied, true);
  assert.equal(applied.consistent, true);
  assert.deepEqual(writes.map(write => write.args.slice(0, 4)), [['api', '--method', 'POST', 'repos/owner/project/rulesets']], 'only the merge queue ruleset is written');
  assert.deepEqual(JSON.parse(writes[0].input!), ruleset);
  assert.match(applied.result, /merge queue requiring Graphyard \/ merge/);
});

// ---- Delivery from GitHub's merge, against a real engine ----------------------------------------
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const ci: Principal = { id: 'ci', role: 'producer', proofs: ['integration:claim-safety'] };
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;
before(async () => {
  const port = Number(process.env.GRAPHYARD_MERGE_DELEGATION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 258);
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('merge-delegation-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('merge_delegation_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/merge_delegation_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'test/repository');
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

/** An item at the merge stage with every gate passing, the way the queue head reaches it. */
async function authorized() {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Delegated merge ${n}`, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID()); w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/delegation-${n}`, branch: `graphyard/delegation-${n}` }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: n }, randomUUID());
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [w.id]);
  const observation = (): Observation => ({ candidate: { sha: head, baseSha: base, pr: n, branch: `graphyard/delegation-${n}`, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString() });
  w = await engine.observe(w.id, w.revision, observation());
  w = await engine.execute(ci, 'evidence', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 5, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());
  const speculation: QueueSpeculation = { ref: queueRef(w.key), tip: head, base, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: w.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [w.id, JSON.stringify(speculation)]);
  w = await engine.observe(w.id, (await store.list()).find(item => item.id === w.id)!.revision, observation());
  assert.equal(w.stage, 'merge', JSON.stringify(w.gates.filter(gate => !gate.passed)));
  return { w, observation };
}

test('GitHub-executed merge: a requested, authorized head is delivered from the merged observation; a merge nobody requested is not', async () => {
  const { w, observation } = await authorized();
  const request = await engine.requestEnqueue(coordinator, w.id, { enqueue: true, expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision, executor: 'daemon-1' }, randomUUID());
  assert.equal(request.enqueue.sha, head);
  assert.equal(request.execution, undefined, 'no merge execution is issued');
  assert.equal((await engine.enqueueRequest(w.id))?.sha, head);
  assert.equal((await store.list()).find(item => item.id === w.id)?.mergeExecution ?? null, null);
  // The request is refused for a head that is not authorized.
  await assert.rejects(engine.requestEnqueue(coordinator, w.id, { enqueue: true, expectedRevision: w.revision, sha: moved, baseSha: base, policyRevision: w.policyRevision }, randomUUID()), /no longer current/);
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  const current = (await store.list()).find(item => item.id === w.id)!;
  const delivered = await engine.observe(w.id, current.revision, { ...observation(), merged: true, mergedAt, mergeSha: 'f'.repeat(40) });
  assert.equal(delivered.stage, 'done', JSON.stringify(delivered.violations));
  assert.equal(delivered.delivery?.mergeSha, 'f'.repeat(40), 'the delivery is recorded from merge_commit_sha');

  const other = await authorized();
  await delay(5); const unrequestedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  const latest = (await store.list()).find(item => item.id === other.w.id)!;
  const refused = await engine.observe(other.w.id, latest.revision, { ...other.observation(), merged: true, mergedAt: unrequestedAt, mergeSha: '9'.repeat(40) });
  assert.notEqual(refused.stage, 'done');
  assert.ok(refused.violations.includes(unauthorizedMergeViolation), 'a merge Graphyard never requested is recorded as unauthorized');
});
