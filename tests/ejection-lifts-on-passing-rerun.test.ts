import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { processJob, type GitHub } from '../src/github.js';
import { ejectedCheckLift, queueRef, type QueuePlacement, type QueueSpeculation } from '../src/merge-queue.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-1095: GY-1008 was ejected for the required `secrets` check failing on its speculative tip; a
// rerun of that check on the same tip passed hours later, yet the ejection stood with nothing in
// flight to produce a new candidate. An ejection for a failed required check now lifts when the
// newest run of that check on the same tip passes. Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:lift'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 900;
before(async () => {
  const port = Number(process.env.GRAPHYARD_EJECTION_LIFT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1095);
  const databaseDir = await temporaryDirectory('ejection-lift');
  database = new EmbeddedPostgres({ databaseDir, user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  // The one GY-516 rerun is the loop's own; here the first failure ejects, as after that rerun is spent.
  engine.rerunFailedChecks = 0;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

type Check = Observation['checks'][number];
const run = (name: string, id: number, result: string, appId = 15368): Check => ({ name, result, appId, id });
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work) => (await store.events(work.id)).reverse();
async function clearQueue() { await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE document->>'stage'<>'done'"); }
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
async function submitted(title: string) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/lift.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:lift'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/lift/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pr }, randomUUID());
}
// Branch protection also requires the `secrets` scan, from any app, as on the GY-1008 repository.
function seen(work: Work, candidate: { sha: string; baseSha: string }, checks: Check[]): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' }, checks,
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/lift.ts'], scopeFiles: [], requiredChecks: [{ name: 'secrets', appId: null }], at: new Date().toISOString() };
}
function adapter(candidate: { sha: string; baseSha: string }, checks: () => Check[]) {
  return {
    observe: async (work: Work) => seen(work, candidate, checks()),
    publishSpeculativeTip: async (work: Work, placement: QueuePlacement): Promise<QueueSpeculation> =>
      ({ ref: queueRef(work.key), tip: candidate.sha, base: placement.predictedBase!, baseTree: treeOf(placement.predictedBase!), predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date().toISOString(), merge: null }),
    requestCodex: async () => { throw new Error('no review request expected'); },
    publish: async () => {},
  } as unknown as GitHub;
}
const passing = (base = 1) => [run('test', base, 'success'), run('typecheck', base + 1, 'success'), run('secrets', base + 2, 'success', 4242)];
/** A head approved and proven, queued, and published as its own speculative tip with every required check passing. */
async function queuedTip(title: string, head: string, base: string) {
  let work = await submitted(title);
  work = await engine.observe(work.id, work.revision, seen(work, { sha: head, baseSha: base }, passing()));
  work = await engine.execute(producer, 'evidence', work.id, { proof: 'unit:lift', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/lift.ts'] }, randomUUID());
  assert.ok(work.queue, `enqueued: ${work.gates.flatMap(entry => entry.reasons).join('; ')}`);
  await onlyJob(work);
  await processJob(engine, adapter({ sha: head, baseSha: base }, passing));
  work = await reload(work);
  assert.equal(work.queue?.speculation?.tip, head, 'the tip is published');
  return work;
}
/** One reconciliation of `work` through the job loop, observing `checks` on its tip. */
async function reconcile(work: Work, checks: Check[]) {
  await onlyJob(work);
  await processJob(engine, adapter({ sha: work.candidate!.sha, baseSha: work.candidate!.baseSha }, () => checks));
  return reload(work);
}
/** A queued tip ejected because the required `secrets` scan failed on it (run 103). */
async function ejected(title: string, head: string, base: string) {
  const work = await reconcile(await queuedTip(title, head, base), [...passing().slice(0, 2), run('secrets', 103, 'failure', 4242)]);
  assert.equal(work.queue ?? null, null, 'the failed scan ejects');
  assert.match(work.queueEjection!.reason, new RegExp(`^Required CI check secrets did not pass on speculative tip ${head.slice(0, 12)}`));
  assert.deepEqual({ name: work.queueEjection!.check?.name, runId: work.queueEjection!.check?.runId, tip: work.queueEjection!.check?.tip }, { name: 'secrets', runId: 103, tip: head }, 'the ejection records the check, its failed run and the tip');
  assert.ok(work.gates.find(gate => gate.name === 'merge')!.reasons.some(reason => /a passing rerun of secrets on this tip lifts the ejection, or a new candidate re-enters at the back of the queue$/.test(reason)));
  return work;
}

test('unit:ejection-lifts-on-passing-rerun — the newest run of the failed check passing on the same tip lifts the ejection; the entry re-enters at its place, without a new candidate, and the lift is recorded naming the check and run', async () => {
  await clearQueue();
  const main = sha40('b1'), head = sha40('a1');
  let work = await ejected('Lifted ejection', head, main);
  const sequence = work.queueEjection!.sequence, speculation = work.queue?.speculation ?? work.queueEjection!.check!.speculation;
  // A later entry joins the queue behind where the ejected one stood.
  const later = await queuedTip('Later entry', sha40('a9'), main);
  assert.ok(later.queue!.sequence > sequence);

  work = await reconcile(work, [...passing().slice(0, 2), run('secrets', 103, 'failure', 4242), run('secrets', 107, 'success', 4242)]);
  assert.equal(work.queueEjection ?? null, null, 'the ejection is lifted');
  assert.ok(work.queue, 'the entry is queued again');
  assert.equal(work.queue!.sequence, sequence, 'at the sequence it held, ahead of the entry that joined later');
  assert.equal(work.candidate!.sha, head, 'no new candidate');
  assert.deepEqual(work.queue!.speculation, speculation, 'with the speculative tip it held');
  const lifted = work.queueHistory!.at(-1)!;
  assert.deepEqual([lifted.event, lifted.check, lifted.runId, lifted.tip], ['lifted', 'secrets', 107, head]);
  assert.match(lifted.reason!, /^ejection lifted: check secrets passed on rerun \(run 107\) on speculative tip [0-9a-f]{12}, replacing failed run 103$/);
  const ledger = (await events(work)).filter(event => event.kind === 'queue.ejection-lifted');
  assert.equal(ledger.length, 1, 'one ledger event records the lift');
  assert.deepEqual([ledger[0].payload.details.check, ledger[0].payload.details.runId, ledger[0].payload.details.tip, ledger[0].payload.details.sequence], ['secrets', 107, head, sequence]);
  assert.ok(work.gates.filter(gate => gate.name !== 'merge').every(gate => gate.passed), work.gates.flatMap(gate => gate.reasons).join('; '));

  // Observed again, nothing more is recorded: the lift happened once.
  work = await reconcile(work, [...passing().slice(0, 2), run('secrets', 103, 'failure', 4242), run('secrets', 107, 'success', 4242)]);
  assert.equal(work.queue!.sequence, sequence);
  assert.equal((await events(work)).filter(event => event.kind === 'queue.ejection-lifted').length, 1);
});

test('unit:ejection-lifts-on-passing-rerun — the ejection stands when the rerun fails or has not concluded, when another required check fails on the tip, or when the tip changed', async () => {
  await clearQueue();
  const main = sha40('b2');
  const stands = (work: Work, why: string) => {
    assert.equal(work.queue ?? null, null, why);
    assert.equal(work.queueEjection?.check?.name, 'secrets', why);
    assert.ok(!(work.queueHistory ?? []).some(entry => entry.event === 'lifted'), why);
  };
  // The rerun confirms the failure.
  let work = await ejected('Confirmed failure', sha40('a2'), main);
  work = await reconcile(work, [...passing().slice(0, 2), run('secrets', 103, 'failure', 4242), run('secrets', 108, 'failure', 4242)]);
  stands(work, 'a rerun that fails again keeps the ejection');
  // The rerun is still running.
  work = await reconcile(work, [...passing().slice(0, 2), run('secrets', 103, 'failure', 4242), run('secrets', 109, 'in_progress', 4242)]);
  stands(work, 'a rerun that has not concluded keeps the ejection');

  // The scan's rerun passes, but another required check now fails on the same tip.
  await clearQueue();
  work = await ejected('Other failure', sha40('a3'), main);
  work = await reconcile(work, [run('test', 1, 'success'), run('typecheck', 2, 'success'), run('typecheck', 5, 'failure'), run('secrets', 103, 'failure', 4242), run('secrets', 110, 'success', 4242)]);
  stands(work, 'another failing required check keeps the ejection');
  assert.equal(ejectedCheckLift(work, [work], [15368]), null);

  // The tip changed: the rerun passing on the old tip lifts nothing. Read on the same record with
  // only the candidate moved, since a new head re-enters by the ordinary rule at the back.
  await clearQueue();
  work = await ejected('Changed tip', sha40('a4'), main);
  const moved = sha40('a5');
  const rerunPassed = [...passing().slice(0, 2), run('secrets', 103, 'failure', 4242), run('secrets', 111, 'success', 4242)];
  const changed = { ...work, candidate: { ...work.candidate!, sha: moved }, observation: seen(work, { sha: moved, baseSha: main }, rerunPassed) } as Work;
  assert.equal(ejectedCheckLift(changed, [changed], [15368]), null, 'a changed tip keeps the ejection');
  const unchanged = { ...work, observation: seen(work, { sha: work.candidate!.sha, baseSha: main }, rerunPassed) } as Work;
  assert.equal(ejectedCheckLift(unchanged, [unchanged], [15368])?.check, 'secrets', 'the same record on the unchanged tip lifts');
  // An ejection for any other reason is never lifted by a passing check.
  const other = { ...unchanged, queueEjection: { ...unchanged.queueEjection!, check: null } } as Work;
  assert.equal(ejectedCheckLift(other, [other], [15368]), null);
});
