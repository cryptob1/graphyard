import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
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
import { independenceRefusal, headRefusal, reviewLaunchBodySchema, secondVerdictRefusal, tokenRefusal, tokenRegistered } from '../src/server/review-verdict.js';
import { bindReviewer, launchReview, readReviewLedger, reviewPrompt, reviewStandard, saveReviewerProfile } from '../src/reviewer.js';
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
const reviewGate = (work: Work) => evaluate(work, [work], new Date()).gates.find(gate => gate.name === 'review')!;

// ——— AC-3: the review gate by risk, and the github reasons unchanged. ———
test('unit:review-gate-by-risk — with a control-plane observation a sensitive delta requires an exact approval on the head, a normal one passes the review gate and marks the item owed a post-merge review; an approval clears the debt', () => {
  const sensitive = item('GY-1', { observation: planeObservation({ sha: H, baseSha: B, pr: 7, branch: 'b', author: 'graphyard-claude-1' }, ['src/store/pools.ts']) });
  const gate = reviewGate(sensitive);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.reasons, [sensitiveReviewRefusal(['src/store/pools.ts: persistence layer'])]);
  assert.equal(evaluate(sensitive, [sensitive], new Date()).postMergeReview, undefined, 'a sensitive delta owes no post-merge review');
  const normal = item('GY-2');
  const passed = evaluate(normal, [normal], new Date());
  assert.equal(passed.gates.find(gate => gate.name === 'review')!.passed, true, 'a normal delta passes the review gate without a verdict');
  assert.equal(passed.postMergeReview, 'owed', 'and owes a post-merge review');
  // An approval of the exact head, from a control-plane verdict, lands the sensitive one and clears a normal one's debt.
  sensitive.observation!.reviews.push({ reviewer: 'review-claude-1', sha: H, state: 'APPROVED', id: 12, submittedAt: now(), source: 'control-plane' } as never);
  assert.equal(reviewGate(sensitive).passed, true);
  normal.postMergeReview = 'owed';
  normal.observation!.reviews.push({ reviewer: 'review-claude-1', sha: H, state: 'APPROVED', id: 13, submittedAt: now(), source: 'control-plane' } as never);
  assert.equal(evaluate(normal, [normal], new Date()).postMergeReview, null, 'an approval before the merge clears the owed review');
  // A change request holds a sensitive pre-merge review; a normal-risk one is attention for the
  // post-merge pass and does not hold the gate. The mark never changes a delivered or reviewed item.
  const changes = item('GY-3'); changes.observation!.reviews.push({ reviewer: 'review-claude-1', sha: H, state: 'CHANGES_REQUESTED', id: 14, submittedAt: now() });
  assert.equal(reviewGate(changes).passed, true, 'a normal-risk change request does not hold the merge');
  assert.equal(evaluate(changes, [changes], new Date()).postMergeReview, 'owed');
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
  const result = evaluate(github, [github], new Date());
  assert.deepEqual(result.gates.find(gate => gate.name === 'review'), { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] });
  assert.equal('postMergeReview' in result, false);
  const reset = item('GY-6', { formalReviewResetRequired: true, observation: { at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/store/x.ts'], scopeFiles: [], prState: 'open', draft: false } });
  assert.deepEqual(reviewGate(reset).reasons, ['A new independent approval after the requirement-review baseline is required']);
});

// ——— AC-1: the binding, and review post in both modes. ———
const TOKEN = 'f'.repeat(64);
const bindingOf = (fields: Partial<ReviewPostBinding> = {}): ReviewPostBinding => ({ repository: 'owner/project', key: 'GY-7', pr: 7, sha: H, baseSha: B, policyRevision: 1, criteriaOnly: true, ...fields });

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

test('unit:review-post-github-snapshot — a pull-request-era github binding still writes and reads unchanged, and its review post is refused naming the control plane, running no gh and calling no API (GY-2010)', async () => {
  const directory = await temporaryDirectory('review-verdict-github');
  try {
    const binding = bindingOf();
    await writeReviewBinding(directory, binding);
    assert.deepEqual(JSON.parse(await readFile(join(directory, reviewBindingFile), 'utf8')), binding, 'the github binding carries no control-plane field');
    const gh: string[][] = [];
    const run = async (_command: string, args: string[]) => { gh.push(args); return ''; };
    const fetcher = (async () => { throw new Error('a github binding never calls the API'); }) as unknown as typeof fetch;
    const body = 'AC-1 met.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none';
    await assert.rejects(postReview({ event: 'APPROVE', body, cliPath: launcher, environment: { GH_CONFIG_DIR: directory, GRAPHYARD_REVIEW: `GY-7@${H}`, GRAPHYARD_URL: 'https://graphyard.example' } }, { run, fetch: fetcher, sleep: async () => {} }),
      /pull-request-era GitHub binding, and Graphyard no longer posts GitHub reviews; the loop launches the review again against the control plane/);
    assert.deepEqual(gh, [], 'no gh ran');
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
  const engine = new Engine(store, 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
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

// ——— GY-1987 AC-1: the reviewer's judging text is what reviewStandard builds, byte for byte. ———
// The request below is the exact text controlPlaneReviewPrompt produced before the judging part was
// factored into reviewStandard: fixed binding, criteria, documentation obligation and verification
// maps, no memory, history, research or checkout. The factoring must not have moved a byte, and the
// request must carry reviewStandard's output verbatim, so the worker's review self reads exactly
// what the independent reviewer is asked. The pinned text carries GY-2000's blocking standard and
// repetition rule, both part of the shared standard reviewStandard builds.
const standardCriteria = [{ id: 'AC-1', text: 'The change works at its head', proofs: ['unit:works'] }];
// A criterion whose proof is declared post-deploy: the review request gains the post-deploy rule,
// and where that rule sits pins the factoring for criteria the first fixture does not cover (the
// rework finding: the rule once moved to after the repetition section, and review self then
// printed a standard without the post-deploy guidance the reviewer judges by).
const standardPostDeployCriteria = [...standardCriteria, { id: 'AC-2', text: 'The restarted loop serves the change', proofs: ['manual:post-deploy/loop-serves-change'] }];
const standardDocumentation = { obligation: { id: 'DOCS' as const, text: "Documentation reflects this change: the diff updates this repository's documentation for any user-visible behaviour it changes, or the worker states at submission that it alters no documented behaviour.", paths: ['docs/', 'README.md', 'AGENTS.md'], changelog: null }, files: ['src/master/dispatch.ts', 'docs/x.md'] };
const standardVerification = { maps: [{ path: 'verification/master.md', paths: ['src/master/'], sections: { Tests: 'tests/master.test.ts covers dispatch.', Drive: 'node bin/graphyard.mjs master status reads the loop.', Invariants: 'A failed launch releases its claim.', Gotchas: 'src/master.ts only re-exports.' } }], plannedFiles: ['src/master/dispatch.ts'] };
const controlPlaneRequestThroughReviewStandard = "You are the independent Graphyard reviewer for owner/repo. Review head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa against base bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb under policy revision 1, for work item GY-9: the control plane observed it from the shared object store, and there is no pull request. Read the change with: git diff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (both commits are in this session's object store; git show --stat aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa lists its files). Verification maps for the areas this item plans to change: verification/master.md: Invariants: A failed launch releases its claim. Gotchas: src/master.ts only re-exports. Review against the acceptance criteria of GY-9: [AC-1] The change works at its head [DOCS] Documentation reflects this change: the diff updates this repository's documentation for any user-visible behaviour it changes, or the worker states at submission that it alters no documented behaviour.. Judge each acceptance criterion met or unmet at head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, and state that judgement for every criterion in the review body. Classify each finding as BLOCKING or FOLLOW-UP. BLOCKING: a real defect a user or operator would hit with this change, an acceptance criterion not met, a leaked secret, or lost or corrupted data; anything else is at most a Nit. The same worker fixes BLOCKING findings on this head; nothing is deferred to another item. FOLLOW-UP: nits only — style, naming, hypotheticals and suggestions not worth a round; mention them briefly and move on. APPROVE when every criterion is met and no finding is BLOCKING; mention the FOLLOW-UP nits in the body instead of requesting changes for them. Graphyard files no backlog item for a nit. REQUEST_CHANGES cites only BLOCKING findings, and names for each the acceptance criterion or defect it concerns; never request changes for a FOLLOW-UP. Never weaken a criterion to let the change pass. A change to a file outside plannedFiles is not a finding by itself; judge the change. Name each nit on its own \"Nit: PATH:LINE — FINDING\" line. Nits are advisory in control-plane mode: Graphyard keeps them in project memory for later workers, and no bot fixes them, so put anything that must be fixed on a BLOCKING: line instead. A BLOCKING finding must name a real defect a user or operator would hit with this change, a criterion that is not met, a leaked secret, or lost or corrupted data; anything else is at most a Nit. Documentation check (the standard criterion \"Documentation reflects this change\"): confirm the diff updates this repository's documentation paths (docs/, README.md, AGENTS.md) for what it changes, or, when the worker stated the change alters no documented behaviour, that the statement is true. Request changes when user-visible behaviour, commands, configuration or APIs changed without a matching documentation update; a stale or contradicted page counts as missing. The worker made no no-docs statement at submission. Documentation files in the diff: docs/x.md. This change touches src/master/dispatch.ts, which run on every loop cycle: ask what it does when repeated across many cycles, heads and items: one follow-up per approval becomes 170 for 40 parents, one refresh per merge becomes one per merge for every open candidate, one session per decision stays open unless something closes it. Ask whether that repeated behaviour stays bounded; never require new soak-suite coverage of it — lacking tests/soak-*.test.ts coverage is at most a Nit. This session is read-only: do not edit, stage, commit, push, rebase, or merge anything, do not run the project's build, tests, or servers, do not claim Graphyard work, and do not submit evidence. Post exactly one verdict, only through Graphyard, with the review body on standard input: node /srv/graphyard/bin/graphyard.mjs review post --event APPROVE <<'EOF' … EOF (use --event REQUEST_CHANGES instead only when a BLOCKING finding stands). It binds the verdict to the head this session was launched for and checks it before posting; when it refuses, it prints why and a correct invocation: do what the reason says. Never post a review any other way. Judge whether this diff meets what GY-9 requires by that rule; never weaken a requirement to let it pass, and never hold a change that meets its criteria over a FOLLOW-UP. Posting that review is granted to this session's role, not a permission to request: the launch allows exactly this one command, so post it as soon as you have judged the diff, without asking for confirmation. review post sends the verdict to the Graphyard control plane at GRAPHYARD_URL with this launch's one-time token from GH_CONFIG_DIR; it names no pull request and runs no gh. Once it has posted, stop; Graphyard closes this session once it observes your verdict. Decide and act on your own: post the verdict yourself, APPROVE or REQUEST_CHANGES, as soon as you have judged the diff. Never stop to ask a human for confirmation, never end your turn with a question, and never offer a menu of options to choose from; choose what the criteria and these instructions support and carry it out. If a command you need is refused or cannot succeed, record a blocker as one review posted with --event COMMENT (or, when posting is itself refused, as a final line starting BLOCKED:), naming the exact command that was blocked and its error, then stop. A session that ends waiting on input is recorded as failed with that reason.";

// The same request with a declared post-deploy criterion: the exact text controlPlaneReviewPrompt
// produced before the factoring, with the post-deploy rule where it sat — directly after the
// criteria rule, before the BLOCKING/Nit rule — not after the repetition section.
const controlPlaneRequestThroughReviewStandardWithPostDeploy = "You are the independent Graphyard reviewer for owner/repo. Review head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa against base bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb under policy revision 1, for work item GY-9: the control plane observed it from the shared object store, and there is no pull request. Read the change with: git diff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (both commits are in this session's object store; git show --stat aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa lists its files). Verification maps for the areas this item plans to change: verification/master.md: Invariants: A failed launch releases its claim. Gotchas: src/master.ts only re-exports. Review against the acceptance criteria of GY-9: [AC-1] The change works at its head [AC-2] The restarted loop serves the change [DOCS] Documentation reflects this change: the diff updates this repository's documentation for any user-visible behaviour it changes, or the worker states at submission that it alters no documented behaviour.. Judge each acceptance criterion met or unmet at head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, and state that judgement for every criterion in the review body. Classify each finding as BLOCKING or FOLLOW-UP. BLOCKING: a real defect a user or operator would hit with this change, an acceptance criterion not met, a leaked secret, or lost or corrupted data; anything else is at most a Nit. The same worker fixes BLOCKING findings on this head; nothing is deferred to another item. FOLLOW-UP: nits only — style, naming, hypotheticals and suggestions not worth a round; mention them briefly and move on. APPROVE when every criterion is met and no finding is BLOCKING; mention the FOLLOW-UP nits in the body instead of requesting changes for them. Graphyard files no backlog item for a nit. REQUEST_CHANGES cites only BLOCKING findings, and names for each the acceptance criterion or defect it concerns; never request changes for a FOLLOW-UP. Never weaken a criterion to let the change pass. A change to a file outside plannedFiles is not a finding by itself; judge the change. AC-2 is a declared post-deploy verification: the live install can only show its outcome after this change is merged and deployed. Judge each on this head's pre-merge evidence — the change that should produce the outcome, and what the head shows before merge — and never request changes or hold the merge because the live install or deployed release has not shown it yet; it is read on the serving release after delivery, and a failure is a follow-up naming the delivered item. Name each nit on its own \"Nit: PATH:LINE — FINDING\" line. Nits are advisory in control-plane mode: Graphyard keeps them in project memory for later workers, and no bot fixes them, so put anything that must be fixed on a BLOCKING: line instead. A BLOCKING finding must name a real defect a user or operator would hit with this change, a criterion that is not met, a leaked secret, or lost or corrupted data; anything else is at most a Nit. Documentation check (the standard criterion \"Documentation reflects this change\"): confirm the diff updates this repository's documentation paths (docs/, README.md, AGENTS.md) for what it changes, or, when the worker stated the change alters no documented behaviour, that the statement is true. Request changes when user-visible behaviour, commands, configuration or APIs changed without a matching documentation update; a stale or contradicted page counts as missing. The worker made no no-docs statement at submission. Documentation files in the diff: docs/x.md. This change touches src/master/dispatch.ts, which run on every loop cycle: ask what it does when repeated across many cycles, heads and items: one follow-up per approval becomes 170 for 40 parents, one refresh per merge becomes one per merge for every open candidate, one session per decision stays open unless something closes it. Ask whether that repeated behaviour stays bounded; never require new soak-suite coverage of it — lacking tests/soak-*.test.ts coverage is at most a Nit. This session is read-only: do not edit, stage, commit, push, rebase, or merge anything, do not run the project's build, tests, or servers, do not claim Graphyard work, and do not submit evidence. Post exactly one verdict, only through Graphyard, with the review body on standard input: node /srv/graphyard/bin/graphyard.mjs review post --event APPROVE <<'EOF' … EOF (use --event REQUEST_CHANGES instead only when a BLOCKING finding stands). It binds the verdict to the head this session was launched for and checks it before posting; when it refuses, it prints why and a correct invocation: do what the reason says. Never post a review any other way. Judge whether this diff meets what GY-9 requires by that rule; never weaken a requirement to let it pass, and never hold a change that meets its criteria over a FOLLOW-UP. Posting that review is granted to this session's role, not a permission to request: the launch allows exactly this one command, so post it as soon as you have judged the diff, without asking for confirmation. review post sends the verdict to the Graphyard control plane at GRAPHYARD_URL with this launch's one-time token from GH_CONFIG_DIR; it names no pull request and runs no gh. Once it has posted, stop; Graphyard closes this session once it observes your verdict. Decide and act on your own: post the verdict yourself, APPROVE or REQUEST_CHANGES, as soon as you have judged the diff. Never stop to ask a human for confirmation, never end your turn with a question, and never offer a menu of options to choose from; choose what the criteria and these instructions support and carry it out. If a command you need is refused or cannot succeed, record a blocker as one review posted with --event COMMENT (or, when posting is itself refused, as a final line starting BLOCKED:), naming the exact command that was blocked and its error, then stop. A session that ends waiting on input is recorded as failed with that reason.";

test('unit:review-standard-shared-with-reviewer — the control-plane request keeps its exact pre-factoring text and carries reviewStandard\'s output verbatim', () => {
  const prompt = reviewPrompt({ repository: 'owner/repo', cliPath: '/srv/graphyard/bin/graphyard.mjs' }, { key: 'GY-9', pr: 7, sha: H, baseSha: B, policyRevision: 1 }, undefined, undefined, standardCriteria, undefined, standardDocumentation, undefined, null, null, null, standardVerification, { head: H, baseTip: B });
  assert.equal(prompt, controlPlaneRequestThroughReviewStandard, 'the request changed when the judging text moved into reviewStandard');
  const standard = reviewStandard({ key: 'GY-9', head: H, base: B }, standardCriteria, standardDocumentation, standardVerification);
  assert.ok(prompt.includes(standard), 'the request contains reviewStandard verbatim, so review self reads what the reviewer reads');
  // The same fixed inputs with a declared post-deploy criterion: byte-identical to the
  // pre-factoring request too, with the post-deploy rule inside the shared standard.
  const declared = reviewPrompt({ repository: 'owner/repo', cliPath: '/srv/graphyard/bin/graphyard.mjs' }, { key: 'GY-9', pr: 7, sha: H, baseSha: B, policyRevision: 1 }, undefined, undefined, standardPostDeployCriteria, undefined, standardDocumentation, undefined, null, null, null, standardVerification, { head: H, baseTip: B });
  assert.equal(declared, controlPlaneRequestThroughReviewStandardWithPostDeploy, 'the request with a declared post-deploy criterion changed when the judging text moved into reviewStandard');
  const declaredStandard = reviewStandard({ key: 'GY-9', head: H, base: B }, standardPostDeployCriteria, standardDocumentation, standardVerification);
  assert.ok(declared.includes(declaredStandard), 'the request contains reviewStandard verbatim for post-deploy criteria too');
  const at = (needle: string) => declaredStandard.indexOf(needle);
  assert.ok(at('is a declared post-deploy verification') >= 0, 'reviewStandard carries the post-deploy rule, so review self prints the guidance the reviewer judges by');
  assert.ok(at('Review against the acceptance criteria of GY-9') < at('is a declared post-deploy verification') && at('is a declared post-deploy verification') < at('Name each nit on its own "Nit: PATH:LINE'), 'the post-deploy rule sits directly after the criteria rule, before the BLOCKING/Nit rule, as in the request before the factoring');
});

// ——— GY-2008: the launcher and the route, together, with the reviewer App bound. ———
// An installation that retains its reviewer App after switching to control-plane merging launches
// under the App's bot identity `${slug}[bot]`; the launch route must take exactly that shape. Both
// regressions drive the real `launchReview` with no injected registration, so its default POST
// runs against this file's in-process server: against the base these fail on the route's 400
// Invalid input for the bracketed identity, and nothing is launched.
const reviewerApp = 'graphyard-reviewer';
const botIdentity = `${reviewerApp}[bot]`;
const herdrStub = (calls: string[][]) => (_command: string, args: string[]) => { calls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' }, tab: { tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
const tabsOf = (calls: string[][]) => calls.filter(args => args[0] === 'tab' && args[1] === 'create');
/** A master root with a reviewer profile and the reviewer App bound, as an App-retaining installation is configured. */
async function reviewerAppMaster(label: string) {
  const root = await temporaryDirectory(label), credentials = await temporaryDirectory(`${label}-credentials`);
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${repository}.git`], { cwd: root });
    await setupMaster(root, { url, token: tokenOf(coordinator), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'workspace-graphyard' });
    await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude' });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const bound = await bindReviewer(root, { appId: 99, installationId: 555, slug: reviewerApp, privateKey, credentialDirectory: credentials }, async () => ({ repository, permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
    assert.equal(bound.identity, botIdentity);
    return { root, credentials };
  } catch (error) { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); throw error; }
}

test('integration:control-plane-reviewer-app-launch — with a reviewer App configured, the real launcher registers its bot identity through the real review-launch route and starts exactly one session on the requested head and base; a malformed identity is still a 400', async () => {
  const master = await reviewerAppMaster('review-app-launch');
  try {
    const calls: string[][] = [];
    const work = await insert(item('GY-9007'));
    const launched = await launchReview(master.root, work, 'reviewer-claude', [], now(), { run: herdrStub(calls) }) as { reviewer: string; mode?: string; launch: string | null; sha: string; baseSha: string };
    assert.equal(launched.reviewer, botIdentity, 'the configured App identity, not the profile agent name');
    assert.deepEqual([launched.mode, launched.sha, launched.baseSha], ['control-plane', H, B], 'one launch on the requested head and base');
    assert.ok(launched.launch, 'the real route registered the launch');
    assert.equal(tabsOf(calls).length, 1, 'exactly one session started');
    const [record] = (await readReviewLedger(master.root)).reviews;
    assert.equal(record!.launch, launched.launch, 'the session record carries the launch the route allocated');
    const registered = await stored(work.id);
    assert.deepEqual([registered.reviewLaunch!.reviewer, registered.reviewLaunch!.requester, registered.reviewLaunch!.head, registered.reviewLaunch!.baseTip, registered.reviewLaunch!.verdict], [botIdentity, coordinator.id, H, B, null]);
    assert.ok(tokenRegistered(http.services, registered.reviewLaunch!.tokenHash), 'the launch token authenticates the bot identity');
    // The widening is the `[bot]` suffix alone: every other shape stays a refusal, so independent
    // review is not weakened to let the launch through.
    for (const bad of ['review claude', 'reviewer[deputy]', 'sla[bot]ug', `${botIdentity} extra`])
      assert.equal((await request(tokenOf(coordinator), `work/${work.id}/review-launch`, launchBody(freshToken(), { reviewer: bad }))).status, 400, bad);
  } finally { await rm(master.root, { recursive: true, force: true }); await rm(master.credentials, { recursive: true, force: true }); }
});

test('integration:control-plane-reviewer-app-independence — the launched reviewer session posts its verdict with its own launch token; wrong head, wrong token, implementer-as-reviewer, requester-as-reviewer and a second verdict are still refused, each with its refusal recorded', async () => {
  const master = await reviewerAppMaster('review-app-independence');
  try {
    const calls: string[][] = [];
    const work = await insert(item('GY-9008'));
    await launchReview(master.root, work, 'reviewer-claude', [], now(), { run: herdrStub(calls) });
    const [tab] = tabsOf(calls);
    assert.equal(tabsOf(calls).length, 1);
    const binding = JSON.parse(await readFile(join(tab!.find(value => value.startsWith('GH_CONFIG_DIR='))!.slice('GH_CONFIG_DIR='.length), reviewBindingFile), 'utf8')) as ReviewPostBinding;
    assert.deepEqual([binding.mode, binding.head, binding.baseTip], ['control-plane', H, B]);
    const token = binding.verdictToken!;
    const registered = await stored(work.id);
    assert.equal(hashOf(token), registered.reviewLaunch!.tokenHash, 'the session holds the one token the launch registered');
    // Wrong token: an unregistered token authenticates nobody, and a registered caller offering
    // another token is refused by name; a wrong head records nothing.
    const stranger = freshToken();
    assert.equal((await request(stranger, `work/${work.id}/review-verdict`, verdict(stranger, 'APPROVE'))).status, 401);
    const forged = await request(tokenOf(coordinator), `work/${work.id}/review-verdict`, verdict(stranger, 'APPROVE'));
    assert.deepEqual([forged.status, forged.body.error], [403, tokenRefusal]);
    const wrongHead = await request(token, `work/${work.id}/review-verdict`, verdict(token, 'APPROVE', undefined, M));
    assert.deepEqual([wrongHead.status, wrongHead.body.error], [409, headRefusal(M, H)]);
    assert.deepEqual((await stored(work.id)).observation!.reviews, [], 'nothing recorded for the refused verdicts');
    // The session's own verdict, with its own launch token, lands under the bot identity.
    const approved = await request(token, `work/${work.id}/review-verdict`, verdict(token, 'APPROVE'));
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.reviewer, botIdentity);
    const [review] = (await stored(work.id)).observation!.reviews as { reviewer: string; state: string }[];
    assert.deepEqual([review!.reviewer, review!.state], [botIdentity, 'APPROVED']);
    // One launch yields one verdict; the spent token is withdrawn.
    const second = await request(tokenOf(coordinator), `work/${work.id}/review-verdict`, verdict(token, 'APPROVE'));
    assert.deepEqual([second.status, second.body.error], [409, secondVerdictRefusal('GY-9008', H)]);
    assert.equal(tokenRegistered(http.services, registered.reviewLaunch!.tokenHash), false);
    // The bot identity implementing the item: the launcher refuses before anything starts, and the
    // route refuses the verdict with review.independence-refused recorded and the token withdrawn.
    const implemented = await insert(item('GY-9009', { implementers: [botIdentity], workspaces: [] }));
    await assert.rejects(launchReview(master.root, implemented, 'reviewer-claude', [], now(), { run: herdrStub(calls) }), /graphyard-reviewer\[bot\] implemented GY-9009/);
    assert.equal(tabsOf(calls).length, 1, 'no session for a reviewer of its own work');
    const own = freshToken();
    assert.equal((await request(tokenOf(coordinator), `work/${implemented.id}/review-launch`, launchBody(own, { reviewer: botIdentity }))).status, 200);
    const refused = await request(own, `work/${implemented.id}/review-verdict`, verdict(own, 'APPROVE'));
    assert.deepEqual([refused.status, refused.body.error], [403, independenceRefusal(botIdentity, 'implemented', 'GY-9009')]);
    assert.equal((await events(implemented.id, 'review.independence-refused')).length, 1);
    assert.equal(tokenRegistered(http.services, hashOf(own)), false);
    assert.equal((await request(own, `work/${implemented.id}/review-verdict`, verdict(own, 'APPROVE'))).status, 401);
    // The launch's requester as its reviewer: refused the same way.
    const requested = await insert(item('GY-9010'));
    const self = freshToken();
    assert.equal((await request(tokenOf(coordinator), `work/${requested.id}/review-launch`, launchBody(self, { reviewer: coordinator.id }))).status, 200);
    const selfRefused = await request(self, `work/${requested.id}/review-verdict`, verdict(self, 'APPROVE'));
    assert.deepEqual([selfRefused.status, selfRefused.body.error], [403, independenceRefusal(coordinator.id, 'requested', 'GY-9010')]);
    assert.equal((await events(requested.id, 'review.independence-refused')).length, 1);
  } finally { await rm(master.root, { recursive: true, force: true }); await rm(master.credentials, { recursive: true, force: true }); }
});

test('unit:review-launch-bot-identity — the launch body takes the configured App\'s bot login (SLUG[bot]) beside principal names and refuses every other shape', () => {
  const base = { head: H, baseTip: B, tokenHash: 'e'.repeat(64), expiresAt: now() };
  assert.equal(reviewLaunchBodySchema.parse({ ...base, reviewer: 'review-claude-1' }).reviewer, 'review-claude-1');
  assert.equal(reviewLaunchBodySchema.parse({ ...base, reviewer: botIdentity }).reviewer, botIdentity);
  for (const bad of ['', 'review claude', '[bot]', 'reviewer[deputy]', 'sla[bot]ug', `${botIdentity} extra`])
    assert.throws(() => reviewLaunchBodySchema.parse({ ...base, reviewer: bad }), Error, bad);
});
