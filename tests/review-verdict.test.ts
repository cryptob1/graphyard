import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { evaluate } from '../src/model/gates.js';
import { sensitiveReviewRefusal, postMergeReviewMark } from '../src/model/post-merge-review.js';
import { postReview, readReviewBinding, reviewBindingFile, reviewBindingSchema, ReviewPostRefusal, writeReviewBinding, type ReviewPostBinding } from '../src/review-post.js';
import { independenceRefusal, headRefusal, secondVerdictRefusal, tokenRefusal, tokenRegistered } from '../src/server/review-verdict.js';
import { launchReview, readReviewLedger, reviewPrompt, saveReviewerProfile } from '../src/reviewer.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1525: review by risk in control-plane mode. The reviewer launch binds a one-time verdict
// token; `review post` sends the verdict to the API as that token; the server records it on the
// item's observation so the review gate reads it unchanged; the gate requires it before merge only
// for a sensitive delta and marks a normal one owed a post-merge review.

const H = 'a'.repeat(40), B = 'b'.repeat(40), M = 'c'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const now = () => new Date().toISOString();

const planeObservation = (candidate: Work['candidate'], files: string[]) => ({
  source: 'control-plane' as const, at: now(), candidate: candidate!, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
  files, scopeFiles: files.map(path => ({ path, status: 'modified' as const, sha: sha(path), additions: 1, deletions: 0, binary: false })), baseTip: candidate!.baseSha, baseTipContained: true,
});
function item(key: string, fields: Record<string, unknown> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-7-1', epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'],
    observation: planeObservation(candidate, ['src/feature.ts']), ...fields } as unknown as Work;
}
const reviewGate = (work: Work) => evaluate(work, [work], new Date(), [15368]).gates.find(gate => gate.name === 'review')!;

// ——— AC-3: the review gate by risk, and the github reasons unchanged. ———
test('unit:review-gate-by-risk — with a control-plane observation a sensitive delta requires an exact approval on the head, a normal one passes the review gate and marks the item owed a post-merge review; an approval clears the debt', () => {
  const sensitive = item('GY-1', { observation: planeObservation({ sha: H, baseSha: B, pr: 7, branch: 'b', author: 'graphyard-claude-1' }, ['src/store/pools.ts']) });
  const gate = reviewGate(sensitive);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.reasons, [sensitiveReviewRefusal(['src/store/pools.ts: persistence layer'])]);
  assert.equal(evaluate(sensitive, [sensitive], new Date(), [15368]).postMergeReview, undefined, 'a sensitive delta owes no post-merge review');
  const normal = item('GY-2');
  const passed = evaluate(normal, [normal], new Date(), [15368]);
  assert.equal(passed.gates.find(gate => gate.name === 'review')!.passed, true, 'a normal delta passes the review gate without a verdict');
  assert.equal(passed.postMergeReview, 'owed', 'and owes a post-merge review');
  // An approval of the exact head, from a control-plane verdict, lands the sensitive one and clears a normal one's debt.
  sensitive.observation!.reviews.push({ reviewer: 'review-claude-1', sha: H, state: 'APPROVED', id: 12, submittedAt: now(), source: 'control-plane' } as never);
  assert.equal(reviewGate(sensitive).passed, true);
  normal.postMergeReview = 'owed';
  normal.observation!.reviews.push({ reviewer: 'review-claude-1', sha: H, state: 'APPROVED', id: 13, submittedAt: now(), source: 'control-plane' } as never);
  assert.equal(evaluate(normal, [normal], new Date(), [15368]).postMergeReview, null, 'an approval before the merge clears the owed review');
  // A change request holds a sensitive pre-merge review; a normal-risk one is attention for the
  // post-merge pass and does not hold the gate. The mark never changes a delivered or reviewed item.
  const changes = item('GY-3'); changes.observation!.reviews.push({ reviewer: 'review-claude-1', sha: H, state: 'CHANGES_REQUESTED', id: 14, submittedAt: now() });
  assert.equal(reviewGate(changes).passed, true, 'a normal-risk change request does not hold the merge');
  assert.equal(evaluate(changes, [changes], new Date(), [15368]).postMergeReview, 'owed');
  const sensitiveChanges = item('GY-3b', { observation: planeObservation({ sha: H, baseSha: B, pr: 7, branch: 'b', author: 'graphyard-claude-1' }, ['src/store/pools.ts']) });
  sensitiveChanges.observation!.reviews.push({ reviewer: 'review-claude-1', sha: H, state: 'CHANGES_REQUESTED', id: 15, submittedAt: now() });
  assert.ok(reviewGate(sensitiveChanges).reasons.includes('Outstanding change requests must be resolved through a new review'));
  assert.deepEqual(postMergeReviewMark({ stage: 'done', postMergeReview: 'owed' }, 'sensitive', false), {});
  assert.deepEqual(postMergeReviewMark({ stage: 'review', postMergeReview: 'reviewed' }, 'normal', false), {});
  assert.deepEqual(postMergeReviewMark({ stage: 'review', postMergeReview: null }, 'normal', false), { postMergeReview: 'owed' });
  // An unseen delta is sensitive: it waits for the approval.
  const unseen = item('GY-4', { observation: { ...planeObservation({ sha: H, baseSha: B, pr: 7, branch: 'b', author: 'w' }, []), scopeFiles: undefined, files: [] } });
  assert.deepEqual(reviewGate(unseen).reasons, [sensitiveReviewRefusal(['unknown change'])]);
});

test('unit:review-gate-github-snapshot — a GitHub-observed item keeps the review gate reasons it had: the plain approval refusal, whatever its paths touch, and no post-merge mark', () => {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: 'b', author: 'worker' };
  const github = item('GY-5', { observation: { at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/feature.ts'], scopeFiles: [], prState: 'open', draft: false } });
  const result = evaluate(github, [github], new Date(), [15368]);
  assert.deepEqual(result.gates.find(gate => gate.name === 'review'), { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] });
  assert.equal('postMergeReview' in result, false);
  const reset = item('GY-6', { formalReviewResetRequired: true, observation: { at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/store/x.ts'], scopeFiles: [], prState: 'open', draft: false } });
  assert.deepEqual(reviewGate(reset).reasons, ['A new independent GitHub approval after the requirement-review baseline is required']);
});

// ——— AC-1: the binding, and review post in both modes. ———
const TOKEN = 'f'.repeat(64);
const bindingOf = (fields: Partial<ReviewPostBinding> = {}): ReviewPostBinding => ({ repository: 'owner/project', key: 'GY-7', pr: 7, sha: H, baseSha: B, policyRevision: 1, criteriaOnly: true, threadsListed: [], ...fields });

test('unit:review-post-control-plane-api — the binding gains mode, head, baseTip and verdictToken; in control-plane mode review post sends { event, body, sha: head, token } to the API as the token and never runs gh; the launch keeps only the token\'s sha256 in .graphyard/reviews.json', async () => {
  const parsed = reviewBindingSchema.parse(bindingOf({ mode: 'control-plane', head: H, baseTip: B, verdictToken: TOKEN }));
  assert.deepEqual([parsed.mode, parsed.head, parsed.baseTip, parsed.verdictToken], ['control-plane', H, B, TOKEN]);
  assert.throws(() => reviewBindingSchema.parse(bindingOf({ mode: 'control-plane' })), /head, baseTip and verdictToken/);
  assert.throws(() => reviewBindingSchema.parse(bindingOf({ verdictToken: TOKEN })), /Only a control-plane binding/);
  const directory = await temporaryDirectory('review-verdict-binding');
  try {
    await writeReviewBinding(directory, bindingOf({ mode: 'control-plane', head: H, baseTip: B, verdictToken: TOKEN }));
    assert.equal((await stat(join(directory, reviewBindingFile))).mode & 0o777, 0o600);
    assert.equal((await readReviewBinding(directory)).verdictToken, TOKEN);
    const calls: { url: string; init: RequestInit }[] = [], gh: string[][] = [];
    const run = async (_command: string, args: string[]) => { gh.push(args); return '{}'; };
    const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ recorded: true, reviewId: 41 }), { status: 200 }); }) as unknown as typeof fetch;
    const environment = { GH_CONFIG_DIR: directory, GRAPHYARD_REVIEW: `GY-7@${H}`, GRAPHYARD_URL: 'https://graphyard.example/' };
    const body = 'AC-1 met.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none';
    const posted = await postReview({ event: 'approve', body, cliPath: launcher, environment }, { run, fetch: fetcher });
    assert.deepEqual(posted, { reviewId: 41, event: 'APPROVE', key: 'GY-7', pr: 7, sha: H, recorded: 'control-plane' });
    assert.deepEqual(gh, [], 'gh never runs in control-plane mode');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://graphyard.example/api/work/GY-7/review-verdict');
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { event: 'APPROVE', body, sha: H, token: TOKEN });
    // A refusal from the control plane is reported with its reason and a correct invocation; an unset address refuses before any call.
    const refusing = (async () => new Response(JSON.stringify({ error: 'The verdict names a different commit' }), { status: 409 })) as unknown as typeof fetch;
    await assert.rejects(postReview({ event: 'APPROVE', body, cliPath: launcher, environment }, { run, fetch: refusing }), (error: Error) => error instanceof ReviewPostRefusal && /refused the verdict \(409\): The verdict names a different commit/.test(error.message) && /review post --event APPROVE/.test(error.message));
    await assert.rejects(postReview({ event: 'APPROVE', body, cliPath: launcher, environment: { ...environment, GRAPHYARD_URL: undefined } }, { run, fetch: fetcher }), /GRAPHYARD_URL is unset/);
    assert.equal(calls.length, 1);
    // The head guard holds in control-plane mode too: GRAPHYARD_REVIEW must name this launch's head.
    await assert.rejects(postReview({ event: 'APPROVE', body, cliPath: launcher, environment: { ...environment, GRAPHYARD_REVIEW: `GY-7@${M}` } }, { run, fetch: fetcher }), /not this launch's GY-7@/);
  } finally { await rm(directory, { recursive: true, force: true }); }

  // The launch: a control-plane head is launched without a reviewer App, writes the binding with the token, registers the launch and records only the hash.
  const root = await temporaryDirectory('review-verdict-master'), credentialDirectory = await temporaryDirectory('review-verdict-credentials');
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
    await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude' });
    assert.equal((await loadMasterConfig(root)).reviewer, undefined, 'no reviewer App is bound');
    const calls: string[][] = [], registered: unknown[] = [];
    const herdr = (_command: string, args: string[]) => { calls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' }, tab: { tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
    // A launch the control plane refuses starts nothing and keeps no record or binding.
    const refused = item('GY-8', { id: randomUUID(), candidate: { sha: M, baseSha: B, pr: 8, branch: 'graphyard/gy-8-1', author: 'graphyard-claude-1' }, submission: { epoch: 1, pr: 8 }, observation: planeObservation({ sha: M, baseSha: B, pr: 8, branch: 'graphyard/gy-8-1', author: 'graphyard-claude-1' }, ['src/x.ts']) });
    await assert.rejects(launchReview(root, refused, 'reviewer-claude', [], now(), { run: herdr, registerLaunch: async () => { throw new Error('refused (409): already reviewed'); } }), /refused \(409\)/);
    assert.equal((await readReviewLedger(root)).reviews.length, 0, 'the refused launch leaves no record');
    const work = item('GY-7');
    const launched = await launchReview(root, work, 'reviewer-claude', [], now(), { run: herdr, registerLaunch: async (_work, launch) => { registered.push(launch); return { launch: 'launch-1' }; } }) as { mode?: string; launch?: string | null; reviewer: string };
    assert.deepEqual([launched.mode, launched.launch, launched.reviewer], ['control-plane', 'launch-1', 'review-claude-1']);
    const tab = calls.filter(args => args[0] === 'tab' && args[1] === 'create').at(-1)!;
    const directory = tab.find(value => value.startsWith('GH_CONFIG_DIR='))!.slice('GH_CONFIG_DIR='.length);
    assert.ok(tab.includes('GRAPHYARD_URL=https://graphyard.example'), 'the session is told the control plane address');
    assert.ok(tab.includes(`GRAPHYARD_REVIEW=GY-7@${H}`));
    const binding = JSON.parse(await readFile(join(directory, reviewBindingFile), 'utf8')) as ReviewPostBinding;
    assert.deepEqual([binding.mode, binding.head, binding.baseTip, binding.pr], ['control-plane', H, B, 7]);
    assert.match(binding.verdictToken!, /^[0-9a-f]{64}$/, '32 random bytes');
    await assert.rejects(stat(join(directory, 'hosts.yml')), 'no GitHub credential is minted');
    const record = (await readReviewLedger(root)).reviews[0]!;
    assert.deepEqual([record.mode, record.launch, record.verdictTokenHash, record.sha, record.baseSha], ['control-plane', 'launch-1', hashOf(binding.verdictToken!), H, B]);
    assert.equal(JSON.stringify(await readReviewLedger(root)).includes(binding.verdictToken!), false, 'the ledger keeps the hash, never the token');
    assert.deepEqual(registered, [{ reviewer: 'review-claude-1', head: H, baseTip: B, tokenHash: hashOf(binding.verdictToken!), expiresAt: record.tokenExpiresAt, postMerge: false }]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('unit:review-post-github-snapshot — a github-mode binding and review post are unchanged: no mode fields, gh pr view then the review POST, the same result', async () => {
  const directory = await temporaryDirectory('review-verdict-github');
  try {
    const binding = bindingOf();
    await writeReviewBinding(directory, binding);
    assert.deepEqual(JSON.parse(await readFile(join(directory, reviewBindingFile), 'utf8')), binding, 'the github binding carries no control-plane field');
    const gh: string[][] = [];
    const run = async (_command: string, args: string[]) => { gh.push(args); return args[0] === 'pr' ? JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: H }) : JSON.stringify({ id: 9001 }); };
    const fetcher = (async () => { throw new Error('github mode never calls the API'); }) as unknown as typeof fetch;
    const body = 'AC-1 met.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none';
    const posted = await postReview({ event: 'APPROVE', body, cliPath: launcher, environment: { GH_CONFIG_DIR: directory, GRAPHYARD_REVIEW: `GY-7@${H}`, GRAPHYARD_URL: 'https://graphyard.example' } }, { run, fetch: fetcher, sleep: async () => {} });
    assert.deepEqual(posted, { reviewId: 9001, event: 'APPROVE', key: 'GY-7', pr: 7, sha: H });
    assert.deepEqual(gh, [
      ['pr', 'view', '7', '--repo', 'owner/project', '--json', 'mergeable,mergeStateStatus,headRefOid'],
      ['api', '--method', 'POST', 'repos/owner/project/pulls/7/reviews', '-f', `commit_id=${H}`, '-f', 'event=APPROVE', '-f', `body=${body}`],
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ——— AC-5: the reviewer prompt in control-plane mode. ———
test('unit:review-prompt-control-plane — the control-plane prompt names head and base SHAs, reads the head from the shared object store, and prints the review post command without a pull-request number; the github prompt is unchanged', () => {
  const config = { repository: 'owner/project', cliPath: '/opt/graphyard/bin/graphyard.mjs' };
  const binding = { key: 'GY-7', pr: 7, sha: H, baseSha: B, policyRevision: 1 };
  const plane = reviewPrompt(config, binding, { directory: '/managed/review/GY-7', worktree: '/managed/review/GY-7/checkout' }, undefined, [{ id: 'AC-1', text: 'Works' }], undefined, undefined, null, null, null, null, null, { head: H, baseTip: B });
  assert.match(plane, new RegExp(`Review head ${H} against base ${B} under policy revision 1, for work item GY-7`));
  assert.match(plane, new RegExp(`Read the change with: git diff ${B} ${H} \\(both commits are in this session's object store`));
  assert.match(plane, new RegExp(`git worktree add --detach /managed/review/GY-7/checkout ${H}`));
  assert.match(plane, /node \/opt\/graphyard\/bin\/graphyard\.mjs review post --event APPROVE <<'EOF'/);
  assert.doesNotMatch(plane, /pull request #|gh pr diff|git fetch|reviewer credential that expires/);
  assert.match(plane, /names no pull request and runs no gh/);
  const postMerge = reviewPrompt(config, binding, undefined, undefined, [], undefined, undefined, null, null, null, null, null, { head: M, baseTip: B, postMerge: { mergeSha: M } });
  assert.match(postMerge, new RegExp(`Review the delivered merge commit ${M} of work item GY-7 against its first parent ${B}, after its merge`));
  assert.match(postMerge, /files one follow-up item per BLOCKING line, planned on that file, keeps every other finding in project memory, and never reopens the delivered item/);
  const github = reviewPrompt(config, binding);
  assert.match(github, new RegExp(`Review pull request #7 at head ${H} against base ${B} under policy revision 1, for work item GY-7. Read the change with: gh pr diff 7 --repo owner/project.`));
  assert.equal(github, reviewPrompt(config, binding, undefined, undefined, undefined, undefined, undefined, null, null, null, null, null, null), 'a null plane argument changes nothing');
});

// ——— AC-2: the routes, over a real control plane. ———
const repository = 'owner/project';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'graphyard-claude-1', role: 'worker' };
const principals = [admin, coordinator, worker];
const credentials = principals.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const tokenOf = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let pg: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1525;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('review-verdict-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('review_verdict_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/review_verdict_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });
async function request(credential: string, path: string, body?: unknown, key: string = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
const insert = async (work: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]); return work; };
const events = async (id: string, kind: string) => (await store.pool.query('SELECT payload FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [id, kind])).rows.map(row => row.payload);
const freshToken = () => randomBytes(32).toString('hex');
const launchBody = (token: string, fields: Record<string, unknown> = {}) => ({ reviewer: 'review-claude-1', head: H, baseTip: B, tokenHash: hashOf(token), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...fields });
const verdict = (token: string, event: string, body = 'AC-1 met.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none', shaOf = H) => ({ event, body, sha: shaOf, token });

test('integration:review-verdict-identity-independent — review-launch is the coordinator\'s and registers the launch; the verdict is accepted only as the launch\'s token, bound to the registered head, and a reviewer who implemented the item or requested the launch is refused with review.independence-refused recorded', async () => {
  const work = await insert(item('GY-9001'));
  const token = freshToken();
  for (const credential of [tokenOf(admin), tokenOf(worker)]) assert.equal((await request(credential, `work/${work.id}/review-launch`, launchBody(token))).status, 403);
  assert.equal((await request(tokenOf(coordinator), `work/${work.id}/review-launch`, launchBody(token, { head: M }))).status, 409, 'a launch names the submitted head');
  const launched = await request(tokenOf(coordinator), `work/${work.id}/review-launch`, launchBody(token));
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  assert.deepEqual([launched.body.registered, launched.body.key, launched.body.reviewer, launched.body.head, launched.body.baseTip, launched.body.postMerge], [true, 'GY-9001', 'review-claude-1', H, B, false]);
  const registered = await stored(work.id);
  assert.deepEqual([registered.reviewLaunch!.reviewer, registered.reviewLaunch!.requester, registered.reviewLaunch!.head, registered.reviewLaunch!.tokenHash, registered.reviewLaunch!.verdict], ['review-claude-1', coordinator.id, H, hashOf(token), null]);
  assert.equal(JSON.stringify(registered).includes(token), false, 'the item holds the hash, never the token');
  assert.ok(tokenRegistered(http.services, hashOf(token)), 'the token authenticates the reviewer principal until the verdict');
  // Another token, a configured identity, or the wrong head: refused, nothing recorded.
  const stranger = freshToken();
  assert.equal((await request(stranger, `work/${work.id}/review-verdict`, verdict(stranger, 'APPROVE'))).status, 401, 'an unregistered token authenticates nobody');
  const forged = await request(tokenOf(coordinator), `work/${work.id}/review-verdict`, verdict(stranger, 'APPROVE'));
  assert.deepEqual([forged.status, forged.body.error], [403, tokenRefusal]);
  const wrongHead = await request(token, `work/${work.id}/review-verdict`, verdict(token, 'APPROVE', undefined, M));
  assert.deepEqual([wrongHead.status, wrongHead.body.error], [409, headRefusal(M, H)]);
  assert.deepEqual((await stored(work.id)).observation!.reviews, [], 'nothing was recorded');
  // The reviewer implemented the item: refused on the verdict, recorded, the token withdrawn.
  const implemented = await insert(item('GY-9002', { implementers: ['review-claude-1'], workspaces: [] }));
  const own = freshToken();
  assert.equal((await request(tokenOf(coordinator), `work/${implemented.id}/review-launch`, launchBody(own))).status, 200);
  const refused = await request(own, `work/${implemented.id}/review-verdict`, verdict(own, 'APPROVE'));
  assert.deepEqual([refused.status, refused.body.error], [403, independenceRefusal('review-claude-1', 'implemented', 'GY-9002')]);
  const recorded = await events(implemented.id, 'review.independence-refused');
  assert.deepEqual([recorded.length, recorded[0].reviewer, recorded[0].how, recorded[0].reason], [1, 'review-claude-1', 'implemented', independenceRefusal('review-claude-1', 'implemented', 'GY-9002')]);
  const afterRefusal = await stored(implemented.id);
  assert.deepEqual([afterRefusal.reviewLaunch!.refused!.reason, afterRefusal.reviewLaunch!.verdict, afterRefusal.observation!.reviews], [independenceRefusal('review-claude-1', 'implemented', 'GY-9002'), null, []]);
  assert.equal(tokenRegistered(http.services, hashOf(own)), false, 'the refused launch\'s token is withdrawn');
  assert.equal((await request(own, `work/${implemented.id}/review-verdict`, verdict(own, 'APPROVE'))).status, 401);
  // The reviewer is the launch's requester: refused the same way.
  const requested = await insert(item('GY-9003'));
  const self = freshToken();
  assert.equal((await request(tokenOf(coordinator), `work/${requested.id}/review-launch`, launchBody(self, { reviewer: coordinator.id }))).status, 200);
  const selfRefused = await request(self, `work/${requested.id}/review-verdict`, verdict(self, 'APPROVE'));
  assert.deepEqual([selfRefused.status, selfRefused.body.error], [403, independenceRefusal(coordinator.id, 'requested', 'GY-9003')]);
  assert.equal((await events(requested.id, 'review.independence-refused')).length, 1);
});

test('integration:review-verdict-recorded-once — the verdict is appended to observation.reviews as { reviewer, sha, state, body, submittedAt, source: control-plane } and re-evaluated: an approval lands a sensitive head\'s review gate, a normal-risk change request keeps its BLOCKING findings without holding the gate; a retried key replays and a second verdict for the launch is refused', async () => {
  const sensitive = await insert(item('GY-9004', { observation: planeObservation({ sha: H, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' }, ['src/store/pools.ts']) }));
  const token = freshToken();
  assert.equal((await request(tokenOf(coordinator), `work/${sensitive.id}/review-launch`, launchBody(token))).status, 200);
  const key = randomUUID();
  const approved = await request(token, `work/${sensitive.id}/review-verdict`, verdict(token, 'APPROVE'), key);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual([approved.body.recorded, approved.body.key, approved.body.state, approved.body.sha, approved.body.reviewer, approved.body.postMerge], [true, 'GY-9004', 'APPROVED', H, 'review-claude-1', false]);
  assert.ok(Number.isInteger(approved.body.reviewId) && approved.body.reviewId > 0, 'the verdict event\'s sequence is its review id');
  const landed = await stored(sensitive.id);
  assert.equal(landed.observation!.reviews.length, 1);
  const [review] = landed.observation!.reviews as { reviewer: string; sha: string; state: string; id?: number; submittedAt?: string; body?: string; blocking?: string[]; source?: string }[];
  assert.deepEqual([review!.reviewer, review!.sha, review!.state, review!.id, review!.body, review!.blocking, review!.source, typeof review!.submittedAt], ['review-claude-1', H, 'APPROVED', approved.body.reviewId, verdict(token, 'APPROVE').body, undefined, 'control-plane', 'string'], 'the record is { reviewer, sha, state, body, submittedAt, source } plus the ledger id: an approval carries its body too');
  assert.equal(landed.gates.find(gate => gate.name === 'review')!.passed, true, 'exactApproval and the review gate read the control-plane verdict unchanged');
  assert.deepEqual([landed.reviewLaunch!.verdict!.state, landed.reviewLaunch!.verdict!.reviewId, landed.reviewLaunch!.verdict!.source], ['APPROVED', approved.body.reviewId, 'control-plane']);
  assert.equal((await events(sensitive.id, 'review.verdict')).length, 1);
  assert.equal(tokenRegistered(http.services, hashOf(token)), false, 'the token is spent with the verdict');
  // The same request again replays; a different one for the same launch is refused as a second verdict, whoever posts it.
  const replayed = await request(token, `work/${sensitive.id}/review-verdict`, verdict(token, 'APPROVE'), key);
  assert.equal(replayed.status, 401, 'the spent token no longer authenticates');
  assert.equal((await stored(sensitive.id)).observation!.reviews.length, 1);
  const again = freshToken();
  assert.equal((await request(tokenOf(coordinator), `work/${sensitive.id}/review-launch`, launchBody(again))).status, 200, 'a relaunch registers a new token');
  const second = await request(again, `work/${sensitive.id}/review-verdict`, verdict(again, 'REQUEST_CHANGES'));
  assert.equal(second.status, 200, 'the new launch yields one verdict of its own');
  const twice = await request(tokenOf(coordinator), `work/${sensitive.id}/review-launch`, launchBody(freshToken()));
  assert.equal(twice.status, 200);
  const relaunch = (await stored(sensitive.id)).reviewLaunch!;
  assert.equal(relaunch.verdict, null, 'each launch starts without a verdict');
  // A change request holds the gate and carries its BLOCKING findings; the same launch refuses a second verdict.
  const normal = await insert(item('GY-9005'));
  const changes = freshToken();
  assert.equal((await request(tokenOf(coordinator), `work/${normal.id}/review-launch`, launchBody(changes))).status, 200);
  const body = 'AC-1 unmet.\nBLOCKING: src/feature.ts:12 — the flag is never read\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none';
  const requestedChanges = await request(changes, `work/${normal.id}/review-verdict`, verdict(changes, 'REQUEST_CHANGES', body));
  assert.equal(requestedChanges.status, 200, JSON.stringify(requestedChanges.body));
  const held = await stored(normal.id);
  const [change] = held.observation!.reviews as { state: string; blocking?: string[]; body?: string }[];
  assert.deepEqual([change!.state, change!.blocking, change!.body], ['CHANGES_REQUESTED', ['src/feature.ts:12 — the flag is never read'], body]);
  assert.equal(held.gates.find(gate => gate.name === 'review')!.passed, true, 'a normal-risk change request is attention for the post-merge pass, never a merge gate');
  assert.equal(held.postMergeReview, 'owed', 'the engine persists the normal delta\'s post-merge debt');
  const secondVerdict = await request(tokenOf(coordinator), `work/${normal.id}/review-verdict`, verdict(changes, 'APPROVE'));
  assert.deepEqual([secondVerdict.status, secondVerdict.body.error], [409, secondVerdictRefusal('GY-9005', H)]);
  assert.equal((await stored(normal.id)).observation!.reviews.length, 1);
  // Malformed bodies and unknown items are refused before anything is read.
  assert.ok([400, 422].includes((await request(tokenOf(coordinator), `work/${normal.id}/review-verdict`, { event: 'MAYBE', body: 'x', sha: H, token: changes })).status));
  assert.equal((await request(tokenOf(coordinator), `work/${randomUUID()}/review-launch`, launchBody(freshToken()))).status, 404);
  // A github-observed item has no API verdict: its review posts through gh.
  const github = await insert(item('GY-9006', { observation: { at: now(), candidate: { sha: H, baseSha: B, pr: 7, branch: 'b', author: 'w' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false } }));
  assert.equal((await request(tokenOf(coordinator), `work/${github.id}/review-launch`, launchBody(freshToken()))).status, 409);
});
