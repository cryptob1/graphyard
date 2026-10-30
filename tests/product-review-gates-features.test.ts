import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDispatchCursor, runDispatchTick } from '../src/auto-dispatch.js';
import { reconcileAutoDispatch, productReviewNeed } from '../src/model/dispatch.js';
import { evaluate } from '../src/model/gates.js';
import { nextAction } from '../src/model/next-action.js';
import { needsProductReview, productReviewCarries, productReviewRefusal, type ProductReview } from '../src/model/product-review.js';
import type { Work } from '../src/model.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { saveReviewerProfile, reviewPrompt } from '../src/reviewer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2989: the product review before merge. A feature head with passing proofs does not merge until
// its product review approves; changes requested reworks with the findings; a reject is owed to the
// master and never merges; a bug merges without one. The loop tests drive runDispatchTick with a
// stubbed product reviewer — a launch that records the session it would start — and settle each
// verdict the way the control plane records a launched session's post: on `work.productReview`.

const H = 'a'.repeat(40), B = 'b'.repeat(40), H2 = 'd'.repeat(40);
const at = '2026-10-30T06:00:00.000Z';
const shaOf = (seed: string) => createHash('sha1').update(seed).digest('hex');

/** A submitted, control-plane-observed candidate whose preview serves: the shape a product review is asked on. */
function feature(key: string, head = H): Work {
  const candidate = { sha: head, baseSha: B, pr: 0, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker-1' };
  return {
    id: randomUUID(), key, title: `Feature ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works end to end', proofs: ['e2e:feature-works'] }],
    policy: { checks: ['test'], review: true }, stage: 'review', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 1, lease: null, workspaces: [{ host: 'h', path: `/w/${key}`, branch: candidate.branch, epoch: 1, owner: 'worker-1' }], candidate, submission: { epoch: 1, pr: 0 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [{ id: 'e1', proof: 'e2e:feature-works', sha: head, baseSha: B, policyRevision: 1, producer: 'merge-trial', trusted: true, result: 'pass', executed: 1, skipped: 0, at }], blocker: null, gates: [], violations: [], implementers: ['worker-1'],
    observation: {
      source: 'control-plane', at, candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['web/feature.ts'], scopeFiles: [{ path: 'web/feature.ts', status: 'added' as const, sha: shaOf(key), additions: 10, deletions: 0, binary: false }],
      baseTip: B, baseTipContained: true, mergeBase: B,
    },
    preview: { id: randomUUID(), path: `/preview/${key}`, state: 'running', runner: 'local', application: 'app', sha: head, source: 'head', origin: null, cases: [], detail: '', startedAt: at, readyAt: at, cleanedAt: null, endReason: null },
  } as unknown as Work;
}

const review = (verdict: ProductReview['verdict'], head = H, findings = 'The wording on the settings screen is not where a user would look.'): ProductReview =>
  ({ sha: head, baseSha: B, verdict, reviewer: 'product-reviewer', findings, screenshots: [`/preview/shots/${verdict}.png`], at });

const reviewGate = (work: Work) => evaluate(work, [work], new Date()).gates.find(gate => gate.name === 'review')!;

test('unit:product-review-gates-features — who owes one: a feature carrying an e2e: proof does, bugs, chores and "No user-facing change" items do not', () => {
  assert.equal(needsProductReview(feature('GY-1')), true);
  const bug = { ...feature('GY-2'), type: 'bug' } as Work;
  assert.equal(needsProductReview(bug), false);
  const chore = { ...feature('GY-3'), type: 'chore' } as Work;
  assert.equal(needsProductReview(chore), false);
  const opted = { ...feature('GY-4'), description: 'No user-facing change: the scheduler internals moved.' } as Work;
  assert.equal(needsProductReview(opted), false);
  const unitOnly = { ...feature('GY-5'), criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] } as Work;
  assert.equal(needsProductReview(unitOnly), false);
  // The review is launched and posted through the control plane, so a GitHub-observed head owes none here.
  const github = feature('GY-6');
  github.observation = { ...github.observation!, source: undefined } as never;
  assert.equal(productReviewRefusal(github), null);
});

test('unit:product-review-gates-features — a feature head with passing proofs does not merge until its product review approves the exact head', () => {
  const item = feature('GY-10');
  assert.deepEqual(reviewGate(item).reasons, ['Product review of the current commit is required'], 'unreviewed: the review gate refuses');
  assert.equal(productReviewRefusal(item), 'Product review of the current commit is required');
  // The verdict binds its exact head: an approval of an earlier head is not this head's.
  const approved = { ...feature('GY-11'), productReview: review('approved', H2) } as Work;
  assert.equal(productReviewRefusal(approved), 'Product review of the current commit is required');
  // An approval of the exact head passes the gate — a normal-risk delta, so every other gate reason is absent too.
  const done = { ...feature('GY-12'), productReview: review('approved') } as Work;
  assert.equal(reviewGate(done).passed, true);
  // With the merge writer's trial and push recorded and its proof passed, a bug merges with no product review at all.
  const bug = { ...feature('GY-13'), type: 'bug', mergeLedger: { head: H, baseTip: B, state: 'reconciled', pushedAt: at },
    evidence: [{ id: 'e1', proof: 'e2e:feature-works', sha: H, baseSha: B, policyRevision: 1, producer: 'merge-trial', trusted: true, result: 'pass', executed: 1, skipped: 0, at }] } as unknown as Work;
  const judged = evaluate(bug, [bug], new Date());
  assert.deepEqual(judged.gates.filter(gate => !gate.passed).map(gate => gate.name), [], 'a bug item merges without a product review');
  assert.equal(judged.stage, 'merge');
});

test('unit:product-review-gates-features — changes requested returns the item to rework with the findings; a reject is owed to the master and never merges', async () => {
  const changes = { ...feature('GY-14'), productReview: review('changes-requested') } as Work;
  assert.match(productReviewRefusal(changes)!, /^Product review requested changes on/);
  assert.match(productReviewRefusal(changes)!, /not where a user would look/, 'the findings ride the refusal');
  const gates = evaluate(changes, [changes], new Date()).gates;
  const action = nextAction({ ...changes, gates }, [changes], new Date());
  assert.equal(action?.kind, 'request-rework', 'a product change request reworks, as a code review change request does');
  assert.match(action?.reason ?? '', /not where a user would look/);
  // The loop's own routine rework names it too: the head goes back to a worker with the findings.
  const { neededRework } = await import('../src/daemon/rework.js');
  const routine = neededRework(changes);
  assert.ok(routine, 'a standing product change request reworks the head');
  assert.match(routine.reason, /product review requested changes/);
  assert.match(routine.reason, /not where a user would look/);

  const rejected = { ...feature('GY-15'), productReview: review('rejected', H, 'This duplicates the export flow and makes the page worse.') } as Work;
  assert.match(productReviewRefusal(rejected)!, /^Product review rejected/);
  const rejectedGates = evaluate(rejected, [rejected], new Date()).gates;
  const owed = nextAction({ ...rejected, gates: rejectedGates }, [rejected], new Date());
  assert.equal(owed?.kind, 'attention', 'a reject is a judgment: the master closes the item unmerged or files a reshaped one');
  assert.match(owed?.reason ?? '', /closes the item unmerged/);
  assert.equal(evaluate(rejected, [rejected], new Date()).gates.every(gate => gate.passed), false, 'a rejected head never merges');
});

test('unit:product-review-gates-features — an approval carries to a head only non-UI files changed on, and a UI change is reviewed afresh', () => {
  const policy = { product: { ui: ['web/'] } } as never;
  const carried = feature('GY-16', H2);
  carried.productReview = review('approved', H);
  carried.observation!.headDelta = ['docs/feature.md', 'src/scheduler.ts'];
  assert.equal(productReviewCarries(carried, policy), true, 'nothing user-facing changed between the reviewed head and this one');
  assert.equal(productReviewRefusal(carried), null, 'the carried approval passes the gate');
  const uiChanged = feature('GY-17', H2);
  uiChanged.productReview = review('approved', H);
  uiChanged.observation!.headDelta = ['web/style.css'];
  assert.equal(productReviewCarries(uiChanged, policy), false);
  assert.equal(productReviewRefusal(uiChanged), 'Product review of the current commit is required');
  // Without a declaration, or without a read delta, a new head is reviewed afresh.
  const undeclared = feature('GY-18', H2);
  undeclared.productReview = review('approved', H);
  undeclared.observation!.headDelta = ['docs/x.md'];
  assert.equal(productReviewCarries(undeclared, {} as never), false);
  const unreadable = feature('GY-19', H2);
  unreadable.productReview = review('approved', H);
  assert.equal(productReviewCarries(unreadable, policy), false);
});

test('unit:product-review-gates-features — the loop launches the product review like the code review once the head\'s preview serves, one session per request', async () => {
  const host = await temporaryDirectory('product-review-loop');
  const credentialDirectory = await temporaryDirectory('product-review-credentials');
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', host]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: host });
    const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(host, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: '/bin/true', credentialDirectory, herdrWorkspace: 'wP' }, status as typeof fetch);
    await saveReviewerProfile(host, { name: 'product-reviewer', agentName: 'product-reviewer', kind: 'claude' });
    const config = await loadMasterConfig(host);

    const item = feature('GY-20');
    // The request is raised beside the code review's the moment the head is eligible.
    reconcileAutoDispatch(item, [item], new Date());
    assert.equal(item.autoDispatch?.product?.state, 'requested', 'a user-facing feature requests its product review');
    assert.equal(productReviewNeed(item).needed, true);
    assert.ok(item.autoDispatch?.review, 'the code review request stands as it always has; its launch waits for the merge');

    const launches: { work: string; sha: string }[] = [];
    const agents: { name: string; pane_id?: string; agent_status?: string }[] = [];
    const effects = {
      snapshot: async () => ({ work: [item], now: at }),
      agents: () => [...agents],
      credentials: async () => ({}),
      reconcileReviews: async () => ({ reviews: [] }),
      reconcileProducers: async () => ({ producers: [] }),
      launchReview: async () => { throw new Error('no code review is launched here'); },
      launchProducer: async () => { throw new Error('no producer is launched here'); },
      // The stubbed product reviewer: it records the session it would start, as the ledger would.
      launchProductReview: async (work: Work, request: { sha: string }) => { launches.push({ work: work.key, sha: request.sha }); agents.push({ name: 'product-reviewer' }); return { agentName: 'product-reviewer', pane: null }; },
      persist: async () => {},
    };
    // Before the head serves (no preview running, no passed trial), the product review waits; with the preview up, the launch happens.
    const waiting = { ...item, preview: { ...item.preview!, state: 'starting' } } as Work;
    const heldTick = await runDispatchTick(config, emptyDispatchCursor(config), { ...effects, snapshot: async () => ({ work: [waiting], now: at }) } as never, Date.now);
    assert.deepEqual(heldTick.launched, []);
    assert.ok(heldTick.waiting.some(entry => /waits for its head to serve/.test(entry.reason)), 'the launch waits for the head to serve');
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), effects as never, Date.now);
    assert.deepEqual(tick.launched.map(entry => [entry.work, entry.reason]), [['GY-20', 'product review']]);
    assert.deepEqual(launches, [{ work: 'GY-20', sha: H }]);
    // The request is that one session's: a second tick launches no second reviewer.
    const again = await runDispatchTick(config, emptyDispatchCursor(config), effects as never, Date.now);
    assert.equal(again.launched.length, 0, 'one product review request is answered by one session');
    assert.equal(launches.length, 1);
    // A head whose merge trial passed serves too, even with no preview at all: the trial built and ran it.
    const trialLaunches: unknown[] = [];
    const trialled = feature('GY-26');
    trialled.preview = null; trialled.gates = [{ name: 'test', passed: true, reasons: [] }];
    reconcileAutoDispatch(trialled, [trialled], new Date());
    const trialTick = await runDispatchTick(config, emptyDispatchCursor(config), { ...effects, agents: () => [], snapshot: async () => ({ work: [trialled], now: at }), launchProductReview: async (_work: Work, request: { sha: string }) => { trialLaunches.push(request.sha); return { agentName: 'product-reviewer', pane: null }; } } as never, Date.now);
    assert.deepEqual(trialLaunches, [H], 'a trial-passed head launches its product review');

    // The verdict settles the request the way a control-plane verdict does: recorded on the item,
    // then reconciled. An approval satisfies it and passes the gate.
    item.productReview = review('approved');
    reconcileAutoDispatch(item, [item], new Date());
    assert.equal(item.autoDispatch!.product, null);
    assert.equal(item.autoDispatch!.history.at(-1)?.state, 'satisfied');
    assert.equal(reviewGate(item).passed, true);

    // A change request cancels the request for this head — the next head is requested afresh.
    const rework = feature('GY-21');
    reconcileAutoDispatch(rework, [rework], new Date());
    rework.productReview = review('changes-requested');
    reconcileAutoDispatch(rework, [rework], new Date());
    assert.equal(rework.autoDispatch!.product, null);
    assert.equal(rework.autoDispatch!.history.at(-1)?.state, 'cancelled');
    // A reject does the same: no session is asked for a head a reject has answered.
    const rejected = feature('GY-22');
    reconcileAutoDispatch(rejected, [rejected], new Date());
    rejected.productReview = review('rejected');
    reconcileAutoDispatch(rejected, [rejected], new Date());
    assert.equal(rejected.autoDispatch!.product, null);
  } finally { await rm(host, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }).catch(() => {}); }
});

test('unit:product-review-gates-features — the product prompt walks the preview and the served app and names the three verdicts and the screenshot lines', () => {
  const prompt = reviewPrompt({ repository: 'owner/project', cliPath: '/bin/graphyard' }, { key: 'GY-23', pr: 0, sha: H, baseSha: B, policyRevision: 1 }, undefined, undefined, undefined, undefined, undefined, null, null, null, null, { head: H, baseTip: B, product: true, previewUrl: 'https://graphyard.example/preview/GY-23/' });
  assert.match(prompt, /product reviewer/);
  assert.match(prompt, /https:\/\/graphyard\.example\/preview\/GY-23\//);
  assert.match(prompt, /agent-browser/);
  assert.match(prompt, /serving\.serve\.url/);
  assert.match(prompt, /--event REJECT/);
  assert.match(prompt, /Screenshot: /);
});
