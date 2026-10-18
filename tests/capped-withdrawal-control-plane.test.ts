import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { evaluate } from '../src/model/gates.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, type DaemonAction, type DaemonEffects } from '../src/master-daemon.js';
import { cappedEscalationKey, cappedFilingKey, cappedRereviewKey, cappedRefusalRequest, maxCappedFilingAttempts, refusedCapRereview, reviewCapStep } from '../src/daemon/cycle-review-cap.js';
import { cappedReview, cappedReworkBinding, cappedRevisionMark, standingVerdict } from '../src/daemon/decisions.js';
import { emptyHeldDecisions } from '../src/daemon/decision-reads.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import { blockingFindings, controlPlaneWithdrawal } from '../src/review-cap.js';
import { cappedRefusalSection, reviewPrompt } from '../src/reviewer.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2078, observed on GY-2010 (review 2755628 on f166aafb311b, refused as non-blocking 2026-10-18)
// and GY-1998: an approver's refusal of a capped rework had the loop withdraw the reviewer's change
// request through dismissApproval, which PUTs GitHub's /pulls/PR/reviews/ID/dismissals. Under the
// control-plane merger the candidate has no pull request, GitHub answered 404, the withdrawal failed
// five times and escalated, and the item was stranded in review with no rework owed and no re-review
// launched. These replay that round: the withdrawal runs in the control plane's own review record,
// with no GitHub request, and an item the earlier failures stranded is picked up on the next cycle.

const H = 'f1ea5b764ac7'.padEnd(40, '0'), B = 'b1'.padEnd(40, 'f');
const reviewerBot = 'graphyard-reviewer[bot]';
const BASE = 1_792_000_000_000; // a fixed epoch millisecond every fixture instant derives from, so this file holds no absolute calendar date
const at = (offsetMs = 0) => new Date(BASE + offsetMs).toISOString();
const refusalReason = 'The finding is real but not blocking: the hotspot budget is a follow-up, not a defect of this head. File it as its own item and let the reviewer list it as a FOLLOW-UP.';
const root = await temporaryDirectory('capped-withdrawal-master');
const config = masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: `${root}/coordinator.token`, cliPath: '/outside/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project',
  autoMerge: true, mergeMethod: 'merge', workers: [],
  reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: `${root}/reviewer.pem`, boundAt: at() },
}) as MasterConfig;

/** A control-plane item past its review-round cap with the reviewer's change request standing on its head. */
function capped(body: string, reviewId = 4242): Work {
  const candidate = { sha: H, baseSha: B, pr: 0, branch: 'graphyard/gy-2078-1', author: 'graphyard-opencode-1' };
  const observation = { source: 'control-plane', candidate, checks: [], reviews: [{ reviewer: reviewerBot, sha: H, state: 'CHANGES_REQUESTED', id: reviewId, submittedAt: at(), body, blocking: blockingFindings(body), source: 'control-plane' }],
    merged: false, mergeSha: null, mergeable: true, protected: false, files: ['src/a.ts'], scopeFiles: [], at: at(60_000), baseTip: B, baseTipContained: true } as never as Work['observation'];
  return { id: 'work-2078', key: 'GY-2078', title: 'Hotspot budgets', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'The widget counts every frob.', proofs: ['unit:frob-count'] }], policy: { checks: ['test'], review: true, reviewProvider: 'control-plane' },
    stage: 'review', revision: 40, policyRevision: 1, createdAt: at(-3_600_000), updatedAt: at(60_000), stageEnteredAt: at(60_000), ready: true, epoch: 5,
    lease: null, workspaces: [], candidate, submission: { epoch: 5, pr: 0 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, gates: [], violations: [],
    pipeline: { attempts: [], submittedAt: null, reworkRounds: 4, interventions: { blocked: 0, requirements: 0 } } } as unknown as Work;
}
/** The master's follow-up, filed after the refusal and naming the item. */
const followUp = { id: 'work-2079', key: 'GY-2079', title: 'Former hotspot files exceed their size budgets after GY-2078', description: 'Named by the refusal of GY-2078\'s capped rework.', stage: 'backlog', createdAt: at(240_000) } as unknown as Work;

/** The capped rework the loop requested for the head under policy revision 1, then the approver's refusal of it. */
const decision = (state: 'requested' | 'refused') => ({ id: '334c52c6-467e-4fe4-b81f-2c761e07a066', action: 'rework', state,
  input: { binding: cappedReworkBinding(H, reviewerBot), previousWorkerStopped: true },
  reason: `[Decided from the control-plane observation taken at ${at(60_000)} of candidate ${H}; if the item has moved since, this request no longer describes it.] ${cappedRevisionMark(1)} GY-2078 is in review round 5, past its cap of 3.`,
  approvedBy: null, requestedAt: at(120_000),
  refusal: state === 'refused' ? { approver: 'graphyard-approver-graphyard', reason: refusalReason, at: at(180_000) } : null });

/** The review-cap step over the production effect wiring: the withdrawal runs through the real `withdrawReview` effect. */
function harness(item: Work, history: ReturnType<typeof decision>[], others: Work[] = []) {
  const state = emptyDaemonState(config), performed: DaemonAction[] = [];
  const world: { writes: { path: string; data: unknown }[]; children: string[][]; fetches: string[]; wakes: string[]; history: ReturnType<typeof decision>[] } =
    { writes: [], children: [], fetches: [], wakes: [], history };
  let tick = Date.parse(at(300_000));
  const production = daemonEffects(root, config, {
    snapshot: async () => ({ work: [item, ...others], now: at() }),
    mutate: async (path: string, data: unknown) => { world.writes.push({ path, data }); return {}; },
    run: (async (command: string, args: string[]) => { world.children.push([command, ...args]); return '{}'; }) as never,
    fetcher: (async (input: unknown) => { world.fetches.push(String(input)); throw new Error('no network in this test'); }) as never,
  });
  // The production object holds getter-only effects (decide, approver, decisions); a proxy overrides them, keeps the rest.
  const overrides: Record<string, unknown> = {
    persist: async () => {}, decide: async () => ({ id: 'unused' }), approver: async () => ({ agentName: 'unused', pane: null }),
    decisions: async () => ({ decisions: world.history }),
    wakeObservation: async () => { world.wakes.push(item.key); },
  };
  const effects = new Proxy(production, {
    get: (target, property, receiver) => property in overrides ? overrides[property as string] : Reflect.get(target, property, receiver),
  }) as unknown as DaemonEffects;
  const cycle = async () => {
    state.cycle++;
    tick += 60_000;
    await reviewCapStep({ config, state, effects, performed, now: () => tick, open: [item], snapshot: { work: [item, ...others], now: at(tick - BASE) },
      heldDecisions: emptyHeldDecisions(), isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
  };
  return { state, performed, world, cycle, item };
}

// ——— The control plane's own review record: the routes and the stored verdict. ———
const repository = 'owner/project';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'graphyard-opencode-1', role: 'worker' };
const principals = [admin, coordinator, worker];
const credentials = principals.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const tokenOf = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let pg: InstanceType<typeof EmbeddedPostgres>, store: Store, http: ReturnType<typeof server>, url: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 978;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('capped-withdrawal-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('capped_withdrawal_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/capped_withdrawal_test`); await store.init();
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

/** A control-plane item under review, with `reviews` for its standing verdicts. */
function planeItem(key: string, overrides: Record<string, unknown> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 0, branch: 'graphyard/gy-2078-1', author: 'graphyard-opencode-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'review', revision: 3, policyRevision: 1, createdAt: at(), updatedAt: at(), stageEnteredAt: at(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-2078-1', epoch: 1, owner: 'graphyard-opencode-1' }], candidate, submission: { epoch: 1, pr: 0 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-opencode-1'],
    observation: { source: 'control-plane', at: at(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, files: ['src/store/pools.ts'],
      scopeFiles: [{ path: 'src/store/pools.ts', status: 'modified', sha: 'c'.repeat(40), additions: 1, deletions: 0, binary: false }], baseTip: B, baseTipContained: true },
    pipeline: { attempts: [], submittedAt: null, reworkRounds: 4, interventions: { blocked: 0, requirements: 0 } }, ...overrides } as unknown as Work;
}

test('unit:capped-withdrawal-without-github — an approver refusing a capped rework withdraws the control-plane change request in the control plane\'s own review record, with no GitHub request, and the re-review of the same head is launched with the findings listed as FOLLOW-UP', async () => {
  assert.equal(controlPlaneWithdrawal(capped('x'), 4242), true, 'the control-plane verdict is withdrawn in the review record');
  const githubMode = capped('x');
  githubMode.observation = { at: at(), candidate: githubMode.candidate, checks: [], reviews: githubMode.observation!.reviews, merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false };
  assert.equal(controlPlaneWithdrawal(githubMode, 4242), false, 'a GitHub-observed item\'s change request is dismissed on GitHub');

  // The review-cap step over the production wiring: refusal in, withdrawal out, through the control plane alone.
  const run = harness(capped('BLOCKING: former hotspot files exceed their size budgets.\n\nThe helper could be named more clearly.'), [decision('requested')], [followUp]);
  const judged = cappedReview(run.item, config)!;
  assert.equal(judged.kind, 'escalate');
  // The rework decision stands before its approver: the round is the approver's, and the step takes nothing.
  await run.cycle();
  assert.deepEqual(run.world.writes, []);
  // The approver refuses it as non-blocking.
  run.world.history = [decision('refused')];
  await run.cycle();
  // The withdrawal went to the control plane's review record, and nowhere else: no gh, no GitHub request.
  assert.deepEqual(run.world.writes.map(write => write.path), [`work/${run.item.id}/review-withdraw`]);
  const sent = run.world.writes[0]!.data as { reviewId: number; reason: string };
  assert.equal(sent.reviewId, 4242);
  assert.match(sent.reason, /independent approver graphyard-approver-graphyard refused the rework it asked for as non-blocking \(decision 334c52c6-467e-4fe4-b81f-2c761e07a066\)/);
  assert.equal(sent.reason, refusedCapRereview({ round: 5, cap: 3, sha: H }, { id: decision('refused').id, approver: 'graphyard-approver-graphyard', reason: refusalReason }, ['GY-2079']), 'the withdrawal carries the re-review request the refusal built');
  assert.deepEqual(run.world.children, [], 'no gh ran');
  assert.deepEqual(run.world.fetches, [], 'no GitHub request was made');
  const filing = run.state.actions[cappedFilingKey(run.item, { sha: H, reviewId: 4242 })]!;
  assert.equal(filing.state, 'done');
  assert.match(filing.detail, /is withdrawn and the head re-reviewed with its findings as FOLLOW-UP: the change request withdrawn and its observation woken/);
  const rereview = run.state.actions[cappedRereviewKey(run.item, H)]!;
  assert.equal(rereview.state, 'done');
  assert.match(rereview.detail, /^Requested a fresh review of GY-2078 on f1ea5b764ac7/);
  assert.deepEqual(run.world.wakes, ['GY-2078']);
  // Further cycles on the same reading withdraw nothing again.
  await run.cycle();
  assert.equal(run.world.writes.length, 1);

  // The record the withdrawal leaves is GitHub's own dismissed shape, so everything downstream reads it unchanged:
  // the standing verdict is gone, the review gate reads no change request, and what the item owes next is a re-review.
  const withdrawnItem = structuredClone(run.item);
  withdrawnItem.observation!.reviews = withdrawnItem.observation!.reviews.map(review => ({ ...review, state: 'DISMISSED' }));
  assert.equal(standingVerdict(withdrawnItem), null);
  assert.equal(cappedReview(withdrawnItem, config), null);
  assert.ok(!evaluate(withdrawnItem, [withdrawnItem], new Date(Date.parse(at())), [15368]).gates.find(gate => gate.name === 'review')!.reasons.includes('Outstanding change requests must be resolved through a new review'));

  // The re-review launch lists the refused findings as FOLLOW-UP: the withdrawal's request is the launch's prompt section.
  const rereviewRequest = cappedRefusalRequest(withdrawnItem, H, config, [decision('refused')], [followUp])!;
  assert.match(rereviewRequest, new RegExp(`Re-review head ${H} and list these findings as FOLLOW-UP threads, not as a change request; the follow-up item filed for them: GY-2079`));
  const prompt = reviewPrompt(config, { key: 'GY-2078', pr: 0, sha: H, baseSha: B, policyRevision: 1 }, undefined, undefined, run.item.criteria, undefined, undefined, null, null, null, null, null, { head: H, baseTip: B }, { request: rereviewRequest });
  assert.ok(prompt.includes(cappedRefusalSection({ request: rereviewRequest })), 'the control-plane re-review prompt carries the withdrawal\'s request');
  assert.match(prompt, /An independent approver refused the capped rework this head's last change request asked for/);

  // The route the withdraw effect calls, over a real control plane: the verdict is marked dismissed exactly as
  // GitHub marks one, the id joins dismissedReviewIds, and the item is re-evaluated in the same transaction.
  const held = await insert(planeItem('GY-2078a'));
  held.observation!.reviews.push({ reviewer: reviewerBot, sha: H, state: 'CHANGES_REQUESTED', id: 51, submittedAt: at(), body: 'BLOCKING: src/store/pools.ts:12 — the cache is never invalidated', source: 'control-plane' });
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [held.id, JSON.stringify(held)]);
  for (const credential of [tokenOf(admin), tokenOf(worker)]) assert.equal((await request(credential, `work/${held.id}/review-withdraw`, { reviewId: 51, reason: 'refused as non-blocking' })).status, 403);
  assert.equal((await request(tokenOf(coordinator), `work/${held.id}/review-withdraw`, { reviewId: 52, reason: 'no such review' })).status, 404);
  assert.equal((await request(tokenOf(coordinator), `work/${held.id}/review-withdraw`, { reviewId: 51, reason: '   ' })).status >= 400, true, 'an empty withdrawal reason is refused');
  const done = await request(tokenOf(coordinator), `work/${held.id}/review-withdraw`, { reviewId: 51, reason: 'Review round 5 of GY-2078a is past its cap of 3: the approver refused the capped rework as non-blocking, so the change request is withdrawn and the head re-reviewed with its findings as FOLLOW-UP' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.withdrawn, done.body.key, done.body.reviewId, done.body.sha, done.body.state], [true, 'GY-2078a', 51, H, 'DISMISSED']);
  const record = await stored(held.id);
  assert.deepEqual([record.observation!.reviews[0]!.state, record.observation!.reviews[0]!.id], ['DISMISSED', 51]);
  assert.deepEqual(record.observation!.dismissedReviewIds, [51]);
  assert.equal((await events(held.id, 'review.withdrawn')).length, 1);
  assert.ok(!record.gates.find(gate => gate.name === 'review')!.reasons.includes('Outstanding change requests must be resolved through a new review'), 'the gate was re-evaluated: the change request no longer holds');
  assert.equal(standingVerdict(record), null);
  assert.equal(cappedReview(record, config), null, 'past its cap, the item owes only the re-review the withdrawal asks for');
  // A retried key replays; a fresh key on an already-withdrawn review answers withdrawn again, without a second event.
  assert.equal((await request(tokenOf(coordinator), `work/${held.id}/review-withdraw`, { reviewId: 51, reason: 'again' }, 'one-key')).status, 200);
  assert.equal((await request(tokenOf(coordinator), `work/${held.id}/review-withdraw`, { reviewId: 51, reason: 'again' }, 'one-key')).body.state, 'DISMISSED', 'the retried key replays its result');
  assert.equal((await request(tokenOf(coordinator), `work/${held.id}/review-withdraw`, { reviewId: 51, reason: 'again' })).status, 200, 'a lost answer never turns the retry into a refusal');
  assert.equal((await events(held.id, 'review.withdrawn')).length, 1);
  // A control-plane approval is not a change request, and a GitHub-observed item's reviews are dismissed on GitHub.
  const approved = await insert(planeItem('GY-2078c'));
  approved.observation!.reviews.push({ reviewer: reviewerBot, sha: H, state: 'APPROVED', id: 53, submittedAt: at(), source: 'control-plane' });
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [approved.id, JSON.stringify(approved)]);
  assert.equal((await request(tokenOf(coordinator), `work/${approved.id}/review-withdraw`, { reviewId: 53, reason: 'not a change request' })).status, 409);
  const github = await insert(planeItem('GY-2078b', { observation: { at: at(), candidate: { sha: H, baseSha: B, pr: 7, branch: 'b', author: 'w' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false } }));
  assert.equal((await request(tokenOf(coordinator), `work/${github.id}/review-withdraw`, { reviewId: 9, reason: 'x' })).status, 409);
});

test('unit:capped-withdrawal-failed-earlier-recovers — an item stranded by a withdrawal that failed against GitHub\'s missing pull request is picked up on the next cycle: the step retries it in the control plane and re-reviews the head, with no hand action', async () => {
  const run = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'), [decision('refused')], [followUp]);
  // What the earlier code left behind: five failed withdrawal attempts naming GitHub's refusal, and the escalation they earned.
  const spent = `${run.item.key} is in review round 5, past its cap of 3, and graphyard-reviewer[bot] requested changes naming a blocking finding`;
  run.state.actions[cappedEscalationKey(run.item, H)] = { kind: 'escalation', work: run.item.key, principal: null, state: 'done', detail: `${spent}; withdrawing it failed 5 times (GitHub refused to dismiss review 4242 (404))`, attempts: 1, cycle: run.state.cycle };
  run.state.actions[cappedFilingKey(run.item, { sha: H, reviewId: 4242 })] = { kind: 'review', work: run.item.key, principal: null, state: 'failed', detail: `${spent}, but withdrawing it failed: GitHub refused to dismiss review 4242 (404)`, attempts: maxCappedFilingAttempts, cycle: run.state.cycle };
  await run.cycle();
  assert.deepEqual(run.world.writes.map(write => write.path), [`work/${run.item.id}/review-withdraw`], 'the stranded withdrawal is retried where it now works, on the step\'s next cycle');
  assert.deepEqual(run.world.children, [], 'no gh ran');
  assert.deepEqual(run.world.fetches, [], 'no GitHub request was made');
  const filing = run.state.actions[cappedFilingKey(run.item, { sha: H, reviewId: 4242 })]!;
  assert.equal(filing.state, 'done');
  assert.match(filing.detail, /the change request withdrawn and its observation woken/);
  assert.equal(run.state.actions[cappedRereviewKey(run.item, H)]!.state, 'done', 'the head is re-reviewed');
  assert.deepEqual(run.world.wakes, ['GY-2078']);
  await run.cycle();
  assert.equal(run.world.writes.length, 1, 'further cycles withdraw nothing again');

  // A withdrawal that failed for a reason that still stands keeps its cap: five failures on the control-plane path itself escalate, none retried.
  const stuck = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'), [decision('refused')], []);
  stuck.state.actions[cappedFilingKey(stuck.item, { sha: H, reviewId: 4242 })] = { kind: 'review', work: stuck.item.key, principal: null, state: 'failed', detail: `${spent}, but withdrawing it failed: Graphyard refused work/${stuck.item.id}/review-withdraw (503): the plane did not answer`, attempts: maxCappedFilingAttempts, cycle: stuck.state.cycle };
  await stuck.cycle();
  assert.deepEqual(stuck.world.writes, []);
  assert.match(stuck.state.actions[cappedEscalationKey(stuck.item, H)]!.detail, /withdrawing it failed 5 times/);
});
