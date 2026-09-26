import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { daemonEffects } from '../src/master-daemon.js';
import { batchStep, defaultMergeBatchSize, describeMergeBatches, predictQueue, queueBatch, queueRef, runMergeBatches, tipValidationPrefix, tipVerdict, type TipVerdict } from '../src/merge-queue.js';
import { buildMasterStatus, masterConfigSchema, mergeBatchSize } from '../src/master.js';
import { decideCarry, evaluate, type Evidence, type Work } from '../src/model.js';
import { prSteps } from '../web/pr-steps.js';

// GY-330: the merge queue tests several entries on one combined tip and bisects only on failure.
// Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const keys = ['GY-1', 'GY-2', 'GY-3', 'GY-4', 'GY-5'];

/**
 * The live queue (GY-330): five entries driven through the control plane's own gate evaluation
 * (`evaluate`, as the engine runs it on every observation). Each round publishes the tips the
 * queue asks for, evaluates every entry, lets GitHub merge the queue head when every gate passes,
 * and runs CI only on the tips the merge gates name as under validation — a CI that runs what the
 * queue requires and nothing else. A tip's tree is named by the entries it holds, so a republished
 * tip holding the same entries binds the entries behind it unchanged, as GY-100 binds them.
 */
function driveQueue(batchSize: number, failing: string, everyTip = false) {
  const now = new Date('2026-09-25T09:00:00.000Z'), at = '2026-09-25T08:00:00.000Z';
  const trees = new Map<string, string>(), holds = new Map<string, string[]>();
  let published = 0, base = { sha: sha40('b0'), tree: sha40('e0') };
  trees.set(base.sha, base.tree); holds.set(base.sha, []);
  const items: Work[] = keys.map((key, index) => {
    const own = sha40(`a${index + 1}`), candidate = { sha: own, baseSha: base.sha, pr: 100 + index, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
    return { id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: [`src/${key}/`], criteria: [],
      policy: { checks: ['test'], review: false }, stage: 'merge', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
      workspaces: [{ host: 'machine', path: `/tmp/${key}`, branch: candidate.branch, epoch: 1, owner: 'agent' }], candidate, submission: { epoch: 1, pr: 100 + index }, reworkRequested: false,
      scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [],
      observation: { clockOffset: { min: 0, max: 0 }, candidate, baseTip: base.sha, baseTree: base.tree, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: now.toISOString() },
      queue: { sequence: index + 1, enqueuedAt: at, policyRevision: 1, speculation: null }, queueSequence: index + 1 } as unknown as Work;
  });
  const queued = () => items.filter(item => !!item.queue && item.stage !== 'done').sort((a, b) => a.queue!.sequence - b.queue!.sequence);
  const observe = (item: Work, checks: Work['observation'] extends infer O ? O extends { checks: infer C } ? C : never : never = []) => {
    item.observation = { ...item.observation!, candidate: item.candidate!, baseTip: base.sha, baseTree: base.tree, checks, at: now.toISOString() };
  };
  // The control plane publishing each tip the queue asks for: the entry's own head merged onto its predicted base.
  const publish = () => {
    for (let moved = true; moved;) {
      moved = false;
      for (const placement of predictQueue(items, now.getTime())) {
        if (placement.current || !placement.publishable) continue;
        const item = items.find(entry => entry.id === placement.id)!, predicted = placement.predictedBase!;
        const holding = [...holds.get(predicted)!, item.key], tip = sha40(`c${++published}`), tree = sha40(`e${holding.map(key => key.slice(3)).join('')}`);
        trees.set(tip, tree); holds.set(tip, holding);
        item.candidate = { ...item.candidate!, sha: tip, baseSha: predicted };
        item.queue = { ...item.queue!, speculation: { ref: queueRef(item.key), tip, base: predicted, baseTree: trees.get(predicted)!, tipTree: tree, predecessors: placement.predecessors, policyRevision: 1, publishedAt: at, reviewedHead: sha40(`a${keys.indexOf(item.key) + 1}`) } };
        observe(item);
        moved = true;
        break;
      }
    }
  };
  const runs: string[][] = [], merged: { key: string; afterRuns: number }[] = [], ejected: { key: string; reason: string; afterRuns: number }[] = [];
  for (let round = 0; queued().length && round < 50; round++) {
    publish();
    // The engine evaluates each entry on its own observation, in no set order; `everyTip` takes the
    // back of the queue first, so an entry behind the failure is judged before the failure is isolated.
    for (const item of everyTip ? queued().reverse() : queued()) {
      Object.assign(item, evaluate(item, items, now, [15368], batchSize));
      if (!item.queue) ejected.push({ key: item.key, reason: item.queueEjection!.reason, afterRuns: runs.length });
    }
    // GitHub merges the queue head once every gate passes, which moves the base branch to its tip.
    const head = queued()[0];
    if (head && head.gates.every(gate => gate.passed)) {
      merged.push({ key: head.key, afterRuns: runs.length });
      base = { sha: head.candidate!.sha, tree: trees.get(head.candidate!.sha)! };
      head.stage = 'done'; head.queue = null;
      for (const item of queued()) observe(item, item.observation!.checks);
      continue;
    }
    // CI runs on exactly the tips the merge gates say the queue is validating.
    const named = new Set(queued().flatMap(item => item.gates.find(gate => gate.name === 'merge')!.reasons)
      .filter(reason => reason.startsWith(tipValidationPrefix)).map(reason => reason.slice(tipValidationPrefix.length, tipValidationPrefix.length + 12)));
    // With `everyTip`, CI runs on every published tip instead, as this repository's workflows do on
    // each push to a candidate branch: a tip the queue never asked about is still judged.
    const judged = everyTip ? queued().filter(item => item.queue!.speculation?.tip === item.candidate!.sha).map(item => item.candidate!.sha.slice(0, 12)) : named;
    for (const prefix of judged) {
      const item = queued().find(entry => entry.candidate!.sha.startsWith(prefix))!;
      if (item.observation!.checks.length) continue;
      const holding = holds.get(item.candidate!.sha)!;
      runs.push(holding);
      observe(item, [{ name: 'test', result: holding.includes(failing) ? 'failure' : 'success', appId: 15368 }]);
    }
  }
  return { runs, merged, ejected, items };
}

test('unit:queue-batching-bisects — five entries, batch size 4, a failure in the third: one run merges nothing, bisection ejects exactly the third, the rest merge in order, at most 4 runs', () => {
  const live = driveQueue(4, 'GY-3');
  assert.deepEqual(live.runs[0], ['GY-1', 'GY-2', 'GY-3', 'GY-4'], 'the first run is one combined tip of the first four entries');
  assert.ok(live.merged.every(entry => entry.afterRuns >= 2), `the failing combined run merged nothing: ${JSON.stringify(live.merged)}`);
  assert.deepEqual(live.ejected.map(entry => entry.key), ['GY-3'], 'the bisection ejects exactly the third entry');
  assert.match(live.ejected[0].reason, /^Required CI check test did not pass on speculative tip [0-9a-f]{12}, isolated by bisecting batch 1 \(GY-3, GY-4, GY-5\)$/, 'naming the failing check');
  assert.deepEqual(live.merged.map(entry => entry.key), ['GY-1', 'GY-2', 'GY-4', 'GY-5'], 'the others merge, in queue order');
  assert.ok(live.runs.length <= 4, `combined-tip runs: ${live.runs.map(run => run.join('+')).join(' | ')}`);
  assert.deepEqual(live.runs, [['GY-1', 'GY-2', 'GY-3', 'GY-4'], ['GY-1', 'GY-2'], ['GY-1', 'GY-2', 'GY-3'], ['GY-1', 'GY-2', 'GY-4', 'GY-5']]);
  // GY-4's own tip failed too — it held GY-3 — and it was never ejected for that: only the isolated entry is.
  assert.equal(live.items.find(item => item.key === 'GY-4')!.queueEjection ?? null, null);
  // The live queue ran exactly the combinations the reference plan runs.
  assert.deepEqual(live.runs, runMergeBatches(keys, 4, (landed, prefix) => [...landed, ...prefix].includes('GY-3') ? { result: 'fail', check: 'test' } : { result: 'pass' }).runs);

  // Batch size 1 restores today's behaviour: every entry is validated on its own tip, one run each.
  const single = driveQueue(1, 'GY-3');
  assert.deepEqual(single.runs, [['GY-1'], ['GY-1', 'GY-2'], ['GY-1', 'GY-2', 'GY-3'], ['GY-1', 'GY-2', 'GY-4'], ['GY-1', 'GY-2', 'GY-4', 'GY-5']]);
  assert.deepEqual([single.merged.map(entry => entry.key), single.ejected.map(entry => entry.key)], [['GY-1', 'GY-2', 'GY-4', 'GY-5'], ['GY-3']]);
  assert.match(single.ejected[0].reason, /^Required CI check test did not pass on speculative tip [0-9a-f]{12}$/);
  // A clean queue of five costs two runs at batch size 4.
  assert.equal(driveQueue(4, 'none').runs.length, 2);

  // CI on every published tip: GY-5 heads batch 2, and its tip, which holds GY-3, fails before GY-3
  // is isolated. That failure is inherited from the batch ahead, whose combined tip has not passed,
  // so GY-5 waits instead of being ejected; only GY-3 leaves the queue.
  const eager = driveQueue(4, 'GY-3', true);
  assert.ok(eager.runs.some(run => run.join() === keys.join()), 'GY-5\'s tip holding GY-3 was run and failed');
  assert.deepEqual(eager.ejected.map(entry => entry.key), ['GY-3']);
  assert.equal(eager.items.find(item => item.key === 'GY-5')!.queueEjection ?? null, null);
  assert.deepEqual(eager.merged.map(entry => entry.key), ['GY-1', 'GY-2', 'GY-4', 'GY-5']);
});

test('the batch plan the live queue follows: halves a failing batch, isolates the failing entry, merges passing prefixes, never re-runs a judged combination', () => {
  const mergedWhenRun: number[] = [];
  let merged: string[] = [];
  // CI fails on any combined tip that holds GY-3, naming the failing check.
  const runTip = (landed: string[], prefix: string[]): TipVerdict => { mergedWhenRun.push(landed.length); merged = landed; return [...landed, ...prefix].includes('GY-3') ? { result: 'fail', check: 'test' } : { result: 'pass' }; };
  const result = runMergeBatches(keys, 4, runTip);
  assert.deepEqual(result.runs[0], ['GY-1', 'GY-2', 'GY-3', 'GY-4'], 'the first run is one combined tip of the first four entries');
  assert.equal(mergedWhenRun[1], 0, 'that failing combined run merged nothing');
  assert.deepEqual(result.ejected, [{ member: 'GY-3', check: 'test' }], 'the bisection ejects exactly the third entry, naming the failing check');
  assert.deepEqual(result.merged, ['GY-1', 'GY-2', 'GY-4', 'GY-5'], 'the others merge, in queue order');
  assert.ok(result.runs.length <= 4, `combined-tip runs: ${result.runs.map(run => run.join('+')).join(' | ')}`);
  assert.deepEqual(result.runs, [['GY-1', 'GY-2', 'GY-3', 'GY-4'], ['GY-1', 'GY-2'], ['GY-1', 'GY-2', 'GY-3'], ['GY-1', 'GY-2', 'GY-4', 'GY-5']]);
  assert.deepEqual(merged, ['GY-1', 'GY-2'], 'the passing half merged before the rest was tested');

  // A clean batch costs one run for its four entries; batch size 1 restores one run per entry.
  assert.equal(runMergeBatches(keys, 4, () => ({ result: 'pass' })).runs.length, 2);
  const single = runMergeBatches(keys, 1, (landed, prefix) => [...landed, ...prefix].includes('GY-3') ? { result: 'fail', check: 'test' } : { result: 'pass' });
  assert.deepEqual(single.runs, [['GY-1'], ['GY-1', 'GY-2'], ['GY-1', 'GY-2', 'GY-3'], ['GY-1', 'GY-2', 'GY-4'], ['GY-1', 'GY-2', 'GY-4', 'GY-5']]);
  assert.deepEqual([single.merged, single.ejected], [['GY-1', 'GY-2', 'GY-4', 'GY-5'], [{ member: 'GY-3', check: 'test' }]]);

  // The step itself: halves a failing batch, never re-runs a combination already judged.
  const failed = (prefixes: Record<string, TipVerdict>) => (prefix: string[]) => prefixes[prefix.join(',')];
  assert.deepEqual(batchStep(keys.slice(0, 4), () => undefined), { kind: 'test', combination: keys.slice(0, 4) });
  assert.deepEqual(batchStep(keys.slice(0, 4), failed({ 'GY-1,GY-2,GY-3,GY-4': { result: 'fail', check: 'test' } })), { kind: 'test', combination: ['GY-1', 'GY-2'] });
  assert.deepEqual(batchStep(keys.slice(0, 4), failed({ 'GY-1,GY-2,GY-3,GY-4': { result: 'fail', check: 'test' }, 'GY-1,GY-2': { result: 'pass' } })), { kind: 'merge', members: ['GY-1', 'GY-2'] });
  assert.deepEqual(batchStep(['GY-3'], failed({ 'GY-3': { result: 'fail', check: 'typecheck' } })), { kind: 'eject', member: 'GY-3', check: 'typecheck' });
  // A batch behind the head whose first tip fails is isolated only once the batches ahead passed.
  assert.deepEqual(batchStep(['GY-5'], failed({ 'GY-5': { result: 'fail', check: 'test' } }), null), { kind: 'test', combination: ['GY-5'] });
  assert.deepEqual(batchStep(['GY-5'], failed({ 'GY-5': { result: 'fail', check: 'test' } }), { result: 'fail', check: 'test' }), { kind: 'test', combination: ['GY-5'] });
  assert.deepEqual(batchStep(['GY-5'], failed({ 'GY-5': { result: 'fail', check: 'test' } }), { result: 'pass' }), { kind: 'eject', member: 'GY-5', check: 'test' });

  // Master config: `mergeQueue.batchSize`, default 4.
  const base = { version: 1, url: 'http://x', credentialFile: '/c', cliPath: '/cli', repository: 'o/r', baseBranch: 'main', githubAppId: 1, hostId: 'h', masterAgentName: 'graphyard-master' };
  assert.equal(defaultMergeBatchSize, 4);
  assert.equal(mergeBatchSize(masterConfigSchema.parse(base)), 4);
  assert.equal(mergeBatchSize(masterConfigSchema.parse({ ...base, mergeQueue: { batchSize: 1 } })), 1);
  assert.throws(() => masterConfigSchema.parse({ ...base, mergeQueue: { batchSize: 0 } }));
});

// A live queue of five validated entries, each tip published on the one ahead of it.
const now = new Date('2026-09-25T09:00:00.000Z'), at = '2026-09-25T08:00:00.000Z';
const B0 = sha40('b0'), tip = (index: number) => sha40(`c${index + 1}`), H1 = sha40('a1');
const pass = { name: 'test', result: 'success', appId: 15368 }, running = { name: 'test', result: 'in_progress', appId: 15368 }, failing = { name: 'test', result: 'failure', appId: 15368 };
const gatesPassing = [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'test', passed: true, reasons: [] }, { name: 'acceptance', passed: true, reasons: [] }];
function entry(index: number, checks: object[], overrides: Partial<Work> = {}): Work {
  const key = keys[index], sha = tip(index), baseSha = index === 0 ? B0 : tip(index - 1), branch = `graphyard/${key.toLowerCase()}-1`;
  const candidate = { sha, baseSha, pr: 100 + index, branch, author: 'implementer' };
  return { id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, stage: 'merge', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: 100 + index }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate, baseTip: B0, checks, reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: now.toISOString() },
    queue: { sequence: index + 1, enqueuedAt: at, policyRevision: 1, speculation: { ref: queueRef(key), tip: sha, base: baseSha, baseTree: sha40(`e${index}`), predecessors: keys.slice(0, index), policyRevision: 1, publishedAt: at, reviewedHead: sha40(`a${index + 1}`) } },
    queueSequence: index + 1,
    gates: [...gatesPassing, { name: 'merge', passed: false, reasons: [`Merge queue is validating speculative tip ${sha.slice(0, 12)}: Required CI check test has not passed on the current candidate`] }], ...overrides } as unknown as Work;
}

test('unit:batch-and-carry-visible — master status and the dashboard show a batched entry\'s batch as a Merge substate, and carried review and proofs as carried with their ground', () => {
  // GY-1 reached the queue carrying its review and proof across a Graphyard-authored merge whose diff was unchanged.
  const id = sha40('9f');
  const carry = decideCarry({ from: { sha: H1, baseSha: sha40('b9') }, to: { sha: tip(0), baseSha: B0 }, policyRevision: 1, at, predecessor: { key: null, validated: true },
    merge: { from: H1, parents: [H1, B0], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/queue.ts'], diff: { reviewed: id, tip: id } },
    reviewedFiles: ['src/queue.ts'], approval: { provider: 'github', reviewer: 'reviewer[bot]', sha: H1, reviewId: 5 },
    proofs: [{ proof: 'unit:works', evidence: { id: 'ev-1', proof: 'unit:works', sha: H1, baseSha: sha40('b9'), policyRevision: 1, producer: 'ci-runner', trusted: true, result: 'pass', executed: 4, skipped: 0, at } as Evidence }], app: 'graphyard' });
  assert.equal(carry.approval.carried, true);
  const first = entry(0, [running]);
  const carried = { ...first, evidence: [{ id: 'ev-1', proof: 'unit:works', sha: H1, baseSha: sha40('b9'), policyRevision: 1, producer: 'ci-runner', trusted: true, result: 'pass', executed: 4, skipped: 0, at }],
    queue: { ...first.queue!, speculation: { ...first.queue!.speculation!, reviewedHead: H1, carry } } } as Work;
  const all = [carried, entry(1, [running]), entry(2, [running]), entry(3, [running]), entry(4, [running])];
  assert.deepEqual(predictQueue(all, now.getTime()).map(placement => [placement.key, placement.current]), keys.map(key => [key, true]), 'the fixture is a published, validated chain');

  const status = buildMasterStatus({ work: all, now: now.toISOString() }, [], [], {}, {}, undefined, 'main', undefined, undefined, undefined, undefined, 'graphyard', { batchSize: 4 });
  const row = (key: string) => status.work.find(item => item.key === key)!;
  for (const key of keys.slice(0, 4)) {
    assert.equal(row(key).stage, 'merge', `${key} is at Merge, not back at Test`);
    assert.deepEqual(row(key).mergeStep, { step: 'merge', substate: 'batch', batch: { number: 1, members: keys.slice(0, 4), tip: tip(3), underTest: { members: keys.slice(0, 4), tip: tip(3) }, state: 'testing' }, summary: `batch 1 (GY-1, GY-2, GY-3, GY-4): validating combined tip ${tip(3).slice(0, 12)}` });
  }
  assert.equal(row('GY-5').mergeStep!.batch!.state, 'waiting');
  assert.equal(row('GY-5').mergeStep!.summary, 'batch 2 (GY-5) waits for batch 1 to merge');
  assert.deepEqual(status.queue.find((entry: { key: string }) => entry.key === 'GY-2')!.batch!.members, keys.slice(0, 4), 'the queue rows carry the batch too');

  // The carried review and proof are named as carried, with their ground.
  const ground = `diff unchanged (patch-id ${id.slice(0, 12)})`;
  assert.deepEqual(row('GY-1').carried.review, { ground, reason: carry.approval.reason, from: H1 });
  assert.deepEqual(row('GY-1').carried.proofs.map(entry => [entry.proof, entry.ground, entry.evidenceId]), [['unit:works', ground, 'ev-1']]);
  assert.deepEqual(row('GY-2').carried, { review: null, proofs: [] });
  assert.equal(status.queue.find((entry: { key: string }) => entry.key === 'GY-1')!.binding!.ground, ground);

  // The batch tip failing moves the batch to bisecting on the first half's tip.
  const bisecting = buildMasterStatus({ work: [all[0], all[1], all[2], entry(3, [failing]), all[4]], now: now.toISOString() }, [], [], {}, {}, undefined, 'main', undefined, undefined, undefined, undefined, 'graphyard', { batchSize: 4 });
  const batch = bisecting.work.find(item => item.key === 'GY-3')!.mergeStep!;
  assert.deepEqual([batch.batch!.state, batch.batch!.underTest], ['bisecting', { members: ['GY-1', 'GY-2'], tip: tip(1) }]);
  assert.match(batch.summary, /the combined tip failed; bisecting on the tip of GY-1, GY-2/);
  const views = describeMergeBatches([all[0], entry(1, [pass]), all[2], entry(3, [failing]), all[4]], predictQueue(all, now.getTime()), 4);
  assert.deepEqual([views.get('GY-1')!.state, views.get('GY-1')!.step], ['merging', { kind: 'merge', members: ['GY-1', 'GY-2'] }], 'a passing half merges');
  assert.deepEqual(tipVerdict(entry(3, [failing])), { result: 'fail', check: 'test' });

  // The dashboard: the review and proof steps read carried with their ground, and the batched
  // entry is validating its combined tip inside Merge, naming the members its tip holds.
  const steps = prSteps({ ...carried, gates: [...gatesPassing, { name: 'merge', passed: false, reasons: [] }] } as Work, now.getTime());
  const review = steps.steps.find(step => step.id === 'review')!, prove = steps.steps.find(step => step.id === 'prove')!;
  assert.deepEqual([review.state, review.label, review.carried], ['done', 'Review · carried', ground]);
  assert.deepEqual([prove.state, prove.label, prove.carried], ['done', 'Prove · carried', ground]);
  assert.equal(steps.steps.find(step => step.id === 'test')!.carried, undefined, 'CI is never carried');
  // The dashboard reads the batch the control plane recorded on the queue entry.
  const third = prSteps({ ...all[2], queue: { ...all[2].queue!, batch: queueBatch(all[2], all, now.getTime(), 4, [15368]) } } as Work, now.getTime());
  assert.equal(third.current, 'merge');
  assert.equal(third.steps.find(step => step.id === 'test')!.state, 'done');
  assert.equal(third.label, 'Merging · validating the combined tip of batch 1 with GY-1, GY-2 · 0 of 1 checks done');
  assert.equal(prSteps(all[4], now.getTime()).label, 'Merging · validating the combined tip · 0 of 1 checks done', 'the first member of batch 2 holds no other member');
});

test('the master publishes mergeQueue.batchSize from its config, and the control plane batches its queue by it', async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 330;
  const database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-batch-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_batch');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_batch`);
  const tokens = { coordinator: 'm'.repeat(32), worker: 'w'.repeat(32) };
  let http: ReturnType<typeof server> | undefined;
  try {
    await store.init();
    const engine = new Engine(store, [15368], 120, 'owner/project');
    http = server(engine, [{ id: 'master', role: 'coordinator', token: tokens.coordinator }, { id: 'worker-a', role: 'worker', token: tokens.worker }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const api = async (path: string, token: string, init: RequestInit = {}) => {
      const response = await fetch(`${url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } });
      return { status: response.status, body: await response.json() };
    };
    assert.equal(engine.mergeBatchSize, defaultMergeBatchSize);
    assert.equal((await api('/api/status', tokens.coordinator)).body.mergeQueue.batchSize, 4, 'before any publication the control plane batches by the default');
    assert.equal((await api('/api/merge-queue', tokens.worker, { method: 'POST', body: JSON.stringify({ batchSize: 2 }) })).status, 403, 'only the master (or an operator) sets it');
    assert.equal((await api('/api/merge-queue', tokens.coordinator, { method: 'POST', body: JSON.stringify({ batchSize: 0 }) })).status, 400);
    assert.equal((await api('/api/merge-queue', tokens.coordinator, { method: 'POST', body: JSON.stringify({ batchSize: 33 }) })).status, 400);
    // The loop publishes the value in its own master config, once per change.
    const posted: string[] = [];
    const mutate = async (path: string, data: unknown) => { posted.push(path); const response = await api(`/api/${path}`, tokens.coordinator, { method: 'POST', body: JSON.stringify(data) }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
    let configured: number | undefined = 1;
    const effects = daemonEffects(process.cwd(), () => ({ url, run: {}, mergeQueue: configured === undefined ? undefined : { batchSize: configured } }) as any, { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate, executor: {} as any });
    await effects.publishMergeBatchSize!();
    await effects.publishMergeBatchSize!();
    assert.deepEqual(posted, ['merge-queue'], 'published once, not every cycle');
    assert.equal(engine.mergeBatchSize, 1, 'the control plane evaluates the queue by the master\'s batch size at once');
    assert.equal((await api('/api/status', tokens.coordinator)).body.mergeQueue.batchSize, 1);
    // A restarted control plane reads the published value back from the installation ledger.
    const restarted = new Engine(store, [15368], 120, 'owner/project');
    assert.equal(await restarted.loadMergeBatchSize(), 1);
    configured = undefined;
    await effects.publishMergeBatchSize!();
    assert.equal(posted.length, 2);
    assert.equal(await restarted.loadMergeBatchSize(), 4, 'removing the setting publishes the default');
    assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM events WHERE work_id IS NULL AND kind='merge-queue.batch-size'")).rows[0].n, 2, 'one ledger entry per change');
    // A ledger write that fails leaves the evaluation on the recorded size (GY-384), so the
    // master's retry and the control plane agree.
    const query = store.pool.query.bind(store.pool);
    (store.pool as any).query = (text: unknown, ...rest: unknown[]) => typeof text === 'string' && text.startsWith('INSERT INTO events') ? Promise.reject(new Error('ledger unavailable')) : (query as any)(text, ...rest);
    try {
      assert.notEqual((await api('/api/merge-queue', tokens.coordinator, { method: 'POST', body: JSON.stringify({ batchSize: 3 }) })).status, 200);
    } finally { (store.pool as any).query = query; }
    assert.equal(engine.mergeBatchSize, 4, 'an unrecorded batch size is not applied');
    assert.equal((await api('/api/merge-queue', tokens.coordinator, { method: 'POST', body: JSON.stringify({ batchSize: 3 }) })).body.recorded, true, 'the retry records it');
    assert.equal(engine.mergeBatchSize, 3);
  } finally {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    await store.close();
    await database.stop();
  }
});
