import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { processJob, type GitHub } from '../src/github.js';
import { blockedAutoMergeProbeMs, blockedMergeStallMs, mergeQueueAction, mergeStalls, type GitHubMergeQueueState } from '../src/merge-queue.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1331. The release-candidate soak's simulated items stopped getting their reviewer approval
 * after GY-1235 made GitHub delivery the only delivery. That merge stopped requesting producers for
 * proofs and removed the mechanical-proof hold from `reviewNeed`, but the observation job still
 * held every codex and agent review dispatch until the unit proofs had passed: no producer was ever
 * asked for them, so the reviewer was never asked and the item sat in review for good. Nor did
 * anything record the merge request any more, so the BLOCKED auto-merge probe and master status's
 * merge-stall lines, which time the merge from it, never fired. These cases reproduce both
 * outside the soak.
 */

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const reviewerApps = [{ id: 'claude-reviewer', runtime: 'claude', appId: 55_001, botUserId: 55_002 }, { id: 'cursor-reviewer', runtime: 'cursor', appId: 66_001, botUserId: 66_002 }];
const agentProfiles = [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer' }, { name: 'cursor-reviewer', runtime: 'cursor', reviewerApp: 'cursor-reviewer' }];
let database: EmbeddedPostgres; let store: Store; let engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1331;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('soak-review-launch'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.reviewerApps = reviewerApps; engine.controlPlaneAppId = 1234;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

/** A submitted item whose one criterion names a unit proof no evidence binds: no producer is requested for it under GitHub delivery. */
async function submitted(): Promise<Work> {
  let w = await engine.execute(operator, 'create', null, { title: 'Reviewed without proofs', criteria: [{ id: 'AC-1', text: 'It behaves', proofs: ['unit:it-behaves'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'machine-a', path: `/tmp/${w.id}`, branch: `graphyard/${w.id}` }, randomUUID());
  return engine.execute(worker, 'submit', w.id, { epoch: 1, pr: Number(w.key.slice(3)) }, randomUUID());
}
function observation(w: Work, reviews: Observation['reviews'] = []): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: w.submission!.pr, branch: w.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews, protected: true, mergeable: true, prState: 'open', draft: false, merged: false, mergeSha: null, files: ['src/it.ts'], scopeFiles: [], at: new Date().toISOString() };
}
async function reload(w: Work) { return (await store.list()).find(item => item.id === w.id)!; }
/** Run the observation job for this item alone. */
async function observe(w: Work, adapter: GitHub) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [w.id]);
  await processJob(engine, adapter);
  return reload(w);
}

test('unit:soak-review-launch-regression — an agent-reviewed head whose unit proofs no producer was asked for still has its reviewer dispatched, and the verdict passes review', async () => {
  let w = await submitted();
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(operator, 'reviewpolicy', w.id, { provider: 'agent', reviewerProfiles: agentProfiles, expectedPolicyRevision: 1, reason: 'Reviewed by the reviewer bots' }, randomUUID());
  assert.equal(w.evidence.length, 0, 'no trusted evidence binds the head: nothing is asked to produce it');
  const dispatched: string[] = [];
  let approve = false;
  const adapter = {
    reviewerAppFor: (profile: { reviewerApp?: string } | null) => profile ? reviewerApps.find(app => app.id === profile.reviewerApp) : undefined,
    observe: async (item: Work) => {
      const request = item.reviewRequest;
      return { ...observation(item), ...(approve && request?.profile ? { agentReview: { provider: 'agent' as const, sha: head, approved: true, reason: `${request.profile} approved this commit`, requestId: request.commentId, profile: request.profile, reviewerApp: request.reviewerApp } } : {}) };
    },
    requestAgentReview: async (item: Work, profile: { name: string; reviewerApp: string }, _app: unknown, guard: () => Promise<void>) => {
      await guard(); dispatched.push(profile.name);
      return { commentId: 900 + dispatched.length, sha: head, baseSha: base, policyRevision: item.policyRevision, body: `review ${profile.name}`, createdAt: new Date().toISOString(),
        provider: 'agent' as const, profile: profile.name, reviewerApp: profile.reviewerApp, marker: '44444444-4444-4444-8444-444444444444' };
    },
    publish: async () => {},
  } as unknown as GitHub;
  w = await observe(w, adapter);
  // Before GY-1331 the hold for the unproven unit proof kept this empty on every observation.
  assert.deepEqual(dispatched, ['claude-reviewer'], 'the first reviewer profile is asked for the head');
  assert.equal(w.reviewRequest?.profile, 'claude-reviewer');
  assert.match(w.gates.find(gate => gate.name === 'review')!.reasons[0], /Waiting for reviewer profile claude-reviewer to post a verdict/);
  approve = true;
  w = await observe(w, adapter);
  assert.deepEqual(dispatched, ['claude-reviewer'], 'one request per head');
  assert.equal(w.gates.find(gate => gate.name === 'review')?.passed, true, 'the reviewer\'s verdict passes review');
});

test('unit:soak-review-launch-regression — a codex-reviewed head whose unit proofs no producer was asked for still has its review requested', async () => {
  let w = await submitted();
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(operator, 'reviewpolicy', w.id, { provider: 'codex', expectedPolicyRevision: 1, reason: 'Hosted Codex review' }, randomUUID());
  let requests = 0;
  const adapter = {
    observe: async (item: Work) => observation(item),
    requestCodex: async (item: Work, guard: () => Promise<void>) => {
      await guard(); requests++;
      return { commentId: 8124, sha: head, baseSha: base, policyRevision: item.policyRevision, body: '@codex review', createdAt: new Date().toISOString() };
    },
    publish: async () => {},
  } as unknown as GitHub;
  w = await observe(w, adapter);
  assert.equal(requests, 1, 'the Codex review is requested for the head');
  assert.equal(w.reviewRequest?.commentId, 8124);
});

test('unit:soak-review-launch-regression — the merge request is recorded once, when every gate first passes, so a BLOCKED auto-merge is probed and named', async () => {
  let w = await submitted();
  w = await engine.observe(w.id, w.revision, observation(w, [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }]));
  let mode: GitHubMergeQueueState['mode'] = 'none';
  const enqueued: boolean[] = [];
  const adapter = {
    observe: async (item: Work) => observation(item, [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }]),
    publish: async () => {},
    mergeQueueState: async (pr: number): Promise<GitHubMergeQueueState> => ({ pullRequestId: `PR_${pr}`, head, queue: false, mergeStateStatus: 'BLOCKED', mode, entryState: null, position: null, groupHead: null, at: new Date().toISOString() }),
    enqueuePullRequest: async (_state: GitHubMergeQueueState, _sha: string, mergeNow?: boolean) => { enqueued.push(!!mergeNow); mode = 'auto-merge'; },
    dequeuePullRequest: async () => { mode = 'none'; },
    publishGroupCheck: async () => {},
  } as unknown as GitHub;
  w = await observe(w, adapter);
  assert.ok(w.gates.every(gate => gate.passed), JSON.stringify(w.gates));
  assert.deepEqual(enqueued, [false], 'auto-merge is enabled for the head');
  const requests = async () => (await store.events(w.id)).filter((event: { kind: string }) => event.kind === 'merge.enqueue.requested');
  const [request, ...more] = await requests();
  assert.ok(request && !more.length, 'one merge request is recorded for the candidate');
  assert.deepEqual({ ...request.payload.details, at: undefined }, { sha: head, baseSha: base, policyRevision: w.policyRevision, requestedBy: 'graphyard', at: undefined });
  const requestedAt = request.payload.details.at as string;
  assert.equal(w.observation?.githubQueue?.requestedAt, requestedAt, 'the observation carries when the merge was requested');
  w = await observe(w, adapter);
  assert.equal((await requests()).length, 1, 'a later observation of the same binding records no second request');
  assert.equal(w.observation?.githubQueue?.requestedAt, requestedAt, 'and keeps the first request time');
  // What the recorded time drives: the BLOCKED auto-merge probe past its bound, and the merge-stall line.
  const late = Date.parse(requestedAt) + Math.max(blockedAutoMergeProbeMs, blockedMergeStallMs) + 60_000;
  const standing = { sha: head, baseSha: base, policyRevision: w.policyRevision, requestedBy: 'graphyard', at: requestedAt };
  const probe = mergeQueueAction(w, w.observation!.githubQueue!, standing, late);
  assert.ok(probe.kind === 'enqueue' && probe.mergeNow, `the probe asks GitHub to merge the BLOCKED head now: ${JSON.stringify(probe)}`);
  const stalls = mergeStalls([w], late);
  assert.equal(stalls.length, 1, 'master status names the BLOCKED auto-merge');
  assert.match(stalls[0].text, new RegExp(`^merge-stalled: ${w.key} pull request #\\d+ at ${head.slice(0, 12)} has been set to auto-merge for \\d+ minutes .* while GitHub reports mergeStateStatus BLOCKED`));
});
