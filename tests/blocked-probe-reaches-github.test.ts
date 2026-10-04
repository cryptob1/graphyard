import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { processJob, type GitHub } from '../src/github.js';
import { buildMasterStatus } from '../src/master.js';
import { mergeStallAttention } from '../src/cli/master-status.js';
import { blockedAuthorizedStallMs, mergeAuthorized, queueRef, type GitHubMergeQueueState, type QueuePlacement, type QueueSpeculation } from '../src/merge-queue.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-1112: on 2026-10-02 GY-794 headed a 17-entry merge queue for over 40 minutes, PR #412
// approved with every required check passing, auto-merge enabled and GitHub reporting BLOCKED.
// The blocked-auto-merge probe was meant to ask GitHub to merge that head, but every observation
// recorded "GitHub refused to enqueue GY-794: Work or job ownership changed before publication":
// the probe's write guard demanded the item's exact revision, and a save the observation itself
// set off (an executor claiming the item's action row) moved it between the read and the probe.
// The probe's guard is now bound only to the candidate, policy and authorization it acts on.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:probe'] };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 1112;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1112;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('blocked-probe'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

type Check = Observation['checks'][number];
const passing: Check[] = [{ name: 'test', result: 'success', appId: 15368, id: 1 }, { name: 'typecheck', result: 'success', appId: 15368, id: 2 }];
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
function seen(work: Work, candidate: { sha: string; baseSha: string }): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' }, checks: passing,
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/probe.ts'], scopeFiles: [], at: new Date().toISOString() };
}
/**
 * GitHub as the job loop reaches it, holding the pull request under auto-merge and reporting it
 * BLOCKED. `between` runs after the merge-queue read, before the probe's write: a save of the item
 * that changes nothing the probe acts on. `mergeError` is GitHub's answer to the head-bound merge.
 */
function adapter(candidate: { sha: string; baseSha: string }, between: () => Promise<void>, mergeError?: string) {
  const merges: { head: string; mergeNow: boolean }[] = [], published: string[] = [];
  return { merges, published, github: {
    observe: async (work: Work) => seen(work, candidate),
    publishSpeculativeTip: async (work: Work, placement: QueuePlacement): Promise<QueueSpeculation> =>
      ({ ref: queueRef(work.key), tip: candidate.sha, base: placement.predictedBase!, baseTree: treeOf(placement.predictedBase!), predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString(), merge: null }),
    requestCodex: async () => { throw new Error('no review request expected'); },
    publish: async (work: Work, _reason: string | undefined, beforeWrite: () => Promise<void>) => { await beforeWrite(); published.push(work.candidate!.sha); },
    mergeQueueState: async (): Promise<GitHubMergeQueueState> => {
      await between();
      return { pullRequestId: 'PR_kw412', head: candidate.sha, queue: false, mergeStateStatus: 'BLOCKED', mode: 'auto-merge', entryState: null, position: null, groupHead: null, at: new Date().toISOString() };
    },
    enqueuePullRequest: async (_state: GitHubMergeQueueState, sha: string, mergeNow = false) => {
      merges.push({ head: sha, mergeNow });
      if (mergeError) throw new Error(mergeError);
    },
    dequeuePullRequest: async () => { throw new Error('an authorized head is never dequeued'); },
    publishGroupCheck: async () => {},
  } as unknown as GitHub };
}
/** An item at the merge stage with every gate passing, the merge requested `minutes` ago and GitHub holding it under auto-merge. */
async function authorizedHead(label: string, minutes: number) {
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE document->>'stage'<>'done'");
  const head = sha40(`a${label}`), base = sha40(`b${label}`);
  let work = await engine.execute(operator, 'create', null, { title: `Blocked head ${label}`, plannedFiles: ['src/probe.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:probe'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/probe/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pr }, randomUUID());
  work = await engine.observe(work.id, work.revision, seen(work, { sha: head, baseSha: base }));
  work = await engine.execute(producer, 'evidence', work.id, { proof: 'unit:probe', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/probe.ts'] }, randomUUID());
  // The queue publishes the entry's tip (its own head, at the front), and the next reading authorizes it.
  await onlyJob(work);
  await processJob(engine, adapter({ sha: head, baseSha: base }, async () => {}).github);
  work = await reload(work);
  assert.ok(mergeAuthorized(work), `authorized: ${work.gates.flatMap(gate => gate.reasons).join('; ')}`);
  // The coordinator's request, as `requestEnqueue` records it, made `minutes` ago: past the probe
  // bound, auto-merge has waited on a BLOCKED head. The ledger is append-only, so it is written aged.
  const request = { sha: head, baseSha: base, policyRevision: work.policyRevision, requestedBy: coordinator.id, at: new Date(Date.now() - minutes * 60_000).toISOString() };
  await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, coordinator.id, 'merge.enqueue.requested', JSON.stringify({ details: request })]);
  return { work, head, base };
}
/** A save of the item between the probe's read and its write that changes nothing it acts on: an executor claims the item's action row, or, with none open, its session list is touched. */
const unrelatedSave = (work: Work) => async () => {
  const before = (await reload(work)).revision;
  const claimed = await engine.claimNextAction(coordinator, { host: 'executor-host', executor: 'executor-1' }, randomUUID());
  if (!claimed.action) await store.transaction(async db => {
    const current: Work = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [work.id])).rows[0].document;
    current.revision += 1; current.updatedAt = new Date().toISOString();
    await db.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(current)]);
  });
  assert.ok((await reload(work)).revision > before, 'the item moved between the read and the probe');
};

test('unit:blocked-probe-reaches-github — a head held BLOCKED under auto-merge past the probe bound with every gate passing is asked of GitHub on consecutive observations even when a save moved the item between read and probe; GitHub\'s refusal is the recorded refusal shown in master status, and past 30 minutes one merge-blocked attention item names the pull request and that answer', async () => {
  const { work: authorized, head, base } = await authorizedHead('1112', 11);
  const refusal = 'Repository rule violations found: Required status check "secrets" is expected.';

  // Two consecutive observations, each with an item save between the merge-queue read and the probe.
  const asked: { head: string; mergeNow: boolean }[] = [];
  let work = authorized;
  for (let observation = 0; observation < 2; observation++) {
    await onlyJob(work);
    const github = adapter({ sha: head, baseSha: base }, unrelatedSave(work), refusal);
    await processJob(engine, github.github);
    work = await reload(work);
    asked.push(...github.merges);
    assert.deepEqual(github.merges, [{ head, mergeNow: true }], `observation ${observation + 1}: GitHub was asked to merge the head, head-bound`);
    assert.deepEqual(github.published, [head], `observation ${observation + 1}: the passing check was published on the head`);
  }
  assert.equal(asked.length, 2);

  // GitHub's answer, not the publication guard's, is the item's merge refusal, recorded once.
  const refused = work.observation?.githubQueue?.refused;
  assert.equal(refused?.reason, `GitHub refused to enqueue ${work.key}: ${refusal}`);
  assert.equal(refused?.head, head);
  const events = (await store.pool.query("SELECT payload->'details'->>'reason' AS reason FROM events WHERE work_id=$1 AND kind='merge.enqueue.refused' ORDER BY seq", [work.id])).rows.map(row => row.reason);
  assert.deepEqual(events, [`GitHub refused to enqueue ${work.key}: ${refusal}`]);
  assert.ok(!events.some(reason => /changed before publication/.test(reason)), 'the publication guard refused nothing');

  // Master status names the refusal while the head has waited under 30 minutes. (No principal
  // registry is in this store, so the proof-authority gap master status would name first is cleared.)
  work = { ...work, proofGaps: [] };
  const now = new Date();
  const row: any = (buildMasterStatus({ work: [work], now: now.toISOString() }, [], []) as any).work.find((entry: any) => entry.key === work.key);
  assert.match(row.attention ?? '', new RegExp(`GitHub refused the merge request for ${work.key} at ${head.slice(0, 12)}.*Required status check "secrets" is expected`));
  assert.deepEqual(mergeStallAttention({ work: [work], now: now.toISOString() }).filter(item => /merge-blocked/.test(item.text)), [], 'not raised within 30 minutes');

  // Past 30 minutes: exactly one attention item, naming the pull request and GitHub's last answer.
  const later = new Date(Date.parse(work.observation!.githubQueue!.requestedAt!) + blockedAuthorizedStallMs + 60_000).toISOString();
  const raised = mergeStallAttention({ work: [work], now: later });
  assert.equal(raised.length, 1, JSON.stringify(raised));
  assert.equal(raised[0].subject, work.key);
  assert.match(raised[0].text, new RegExp(`^merge-blocked: ${work.key} pull request #${work.candidate!.pr} at ${head.slice(0, 12)} has been BLOCKED with every gate passing for 3\\d minutes`));
  assert.match(raised[0].text, /GitHub's last answer \(.*\): GitHub refused to enqueue .*Required status check "secrets" is expected\.$/);
  const status = buildMasterStatus({ work: [work], now: later }, [], []) as any;
  assert.deepEqual(status.attentionItems.filter((item: any) => item.subject === work.key), [], 'the row does not name the same refusal a second time');

  // An answer GitHub accepted without merging is named as such; a head that is not BLOCKED, or not authorized, raises nothing.
  const accepted = { ...work, observation: { ...work.observation!, githubQueue: { ...work.observation!.githubQueue!, refused: null } } } as Work;
  assert.match(mergeStallAttention({ work: [accepted], now: later })[0].text, /GitHub's last answer: no refusal recorded; it accepted the request and has not merged$/);
  const clean = { ...accepted, observation: { ...accepted.observation!, githubQueue: { ...accepted.observation!.githubQueue!, mergeStateStatus: 'DIRTY' } } } as Work;
  assert.deepEqual(mergeStallAttention({ work: [clean], now: later }), []);
  const unauthorized = { ...accepted, mergeAuthorization: null } as Work;
  assert.ok(!mergeStallAttention({ work: [unauthorized], now: later }).some(item => /merge-blocked/.test(item.text)));
});

test('unit:blocked-probe-reaches-github — the probe\'s guard still refuses a write once the candidate\'s authorization is gone', async () => {
  const { work, head, base } = await authorizedHead('1113', 11);
  await onlyJob(work);
  // Between the read and the probe, the authorization is withdrawn (a new policy revision).
  const github = adapter({ sha: head, baseSha: base }, async () => {
    await store.transaction(async db => {
      const current: Work = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [work.id])).rows[0].document;
      current.revision += 1; current.mergeAuthorization = null;
      await db.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(current)]);
    });
  });
  await processJob(engine, github.github);
  assert.deepEqual(github.merges, [], 'GitHub is never asked to merge a head whose authorization changed');
  const refused = (await reload(work)).observation?.githubQueue?.refused;
  assert.match(refused?.reason ?? '', /GitHub refused to enqueue .*: Candidate, policy or merge authorization changed before publication; retry/);
});
