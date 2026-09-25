import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchStep, defaultMergeBatchSize, describeMergeBatches, predictQueue, queueRef, runMergeBatches, tipVerdict, type TipVerdict } from '../src/merge-queue.js';
import { buildMasterStatus, masterConfigSchema, mergeBatchSize } from '../src/master.js';
import { decideCarry, type Evidence, type Work } from '../src/model.js';
import { prSteps } from '../web/pr-steps.js';

// GY-330: the merge queue tests several entries on one combined tip and bisects only on failure.
// Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const keys = ['GY-1', 'GY-2', 'GY-3', 'GY-4', 'GY-5'];

test('unit:queue-batching-bisects — five entries, batch size 4, a failure in the third: one run merges nothing, bisection ejects exactly the third, the rest merge in order, at most 4 runs', () => {
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
  const third = prSteps(all[2], now.getTime());
  assert.equal(third.current, 'merge');
  assert.equal(third.steps.find(step => step.id === 'test')!.state, 'done');
  assert.equal(third.label, 'Merging · validating the combined tip of batch 1 with GY-1, GY-2 · 0 of 1 checks done');
  assert.equal(prSteps(all[4], now.getTime()).label, 'Merging · validating the combined tip · 0 of 1 checks done', 'the first member of batch 2 holds no other member');
});
