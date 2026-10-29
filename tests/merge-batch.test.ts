import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeBatch } from '../src/merge-writer/batch.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import type { MergePorts, MergeRecordEvent, MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';

// GY-2088: the merge writer merges the next few queued heads together — one trial, one push — and
// falls back to one head at a time when the batch fails.

const start = Date.parse('2030-04-01T00:00:00Z');
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
const head = (n: number) => sha(`head${n}`);
const queued = (n: number) => {
  const candidate = { sha: head(n), baseSha: tip, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
  return { id: `w${n}`, key: `GY-${n}`, type: 'feature', criteria: [{ id: 'AC-1', text: 'Works', proofs: [`unit:item-${n}`] }], submission: { epoch: 1, pr: n }, candidate,
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: new Date(start).toISOString() }, mergeLedger: null } as unknown as Work;
};

/** A recording runner: every port call in order, the records per item, and a trial that fails on any merge commit containing a failing head. */
function recording(options: { failing?: number[]; conflicting?: number[] } = {}) {
  const calls: string[] = [], records: { key: string; event: MergeRecordEvent }[] = [];
  const contains = new Map<string, number[]>([[tip, []]]);
  let current = tip;
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 0, now: () => start,
    fetch: async () => { calls.push('fetch'); return current; },
    merge: async (headSha, baseTip) => {
      const n = [1, 2, 3, 4, 5].find(index => head(index) === headSha)!;
      calls.push(`merge:GY-${n}`);
      if (options.conflicting?.includes(n)) return { conflict: ['src/app.ts'] };
      const mergeSha = sha(`merge:${headSha}:${baseTip}`);
      contains.set(mergeSha, [...contains.get(baseTip)!, n]);
      return { mergeSha, files: [`src/item-${n}.ts`] };
    },
    trial: async (mergeSha, files, item) => {
      const heads = contains.get(mergeSha)!;
      calls.push(`trial:${heads.map(n => `GY-${n}`).join('+')}`);
      const failed = heads.some(n => options.failing?.includes(n));
      const proofs = Object.fromEntries(item.criteria.flatMap(criterion => criterion.proofs).map(proof => [proof, { executed: 1, failed: 0 }]));
      return { build: 'pass', tests: { passed: 2, failed: failed ? ['tests/item.test.ts'] : [], files: 2 }, durationMs: 1000, logTail: '', files: [...files], proofs } satisfies MergeTrialRun;
    },
    push: async mergeSha => { calls.push(`push:${contains.get(mergeSha)!.map(n => `GY-${n}`).join('+')}`); current = mergeSha; return 'pushed'; },
    holds: async () => false,
    record: async (item, event) => { records.push({ key: item.key, event }); },
  };
  const kinds = (key: string) => records.filter(entry => entry.key === key).map(entry => entry.event.kind);
  return { ports, calls, records, kinds, contains };
}

test('unit:merge-batch-pass — four queued heads that merge cleanly and pass take one trial and one push, and each item is recorded merged at its own merge commit', async () => {
  const run = recording();
  const results = await mergeBatch(run.ports, [1, 2, 3, 4].map(queued));
  assert.equal(run.calls.filter(call => call.startsWith('trial:')).length, 1, 'one trial');
  assert.deepEqual(run.calls.filter(call => call.startsWith('trial:') || call.startsWith('push:')), ['trial:GY-1+GY-2+GY-3+GY-4', 'push:GY-1+GY-2+GY-3+GY-4'], 'one push lands all four');
  let parent = tip;
  for (const n of [1, 2, 3, 4]) {
    const mergeSha = sha(`merge:${head(n)}:${parent}`);
    const result = results.find(entry => entry.work.key === `GY-${n}`)!;
    assert.ok('outcome' in result && result.outcome.outcome === 'merged' && result.outcome.mergeSha === mergeSha && result.outcome.baseTip === parent, `GY-${n} is merged at its own merge commit`);
    assert.deepEqual(run.kinds(`GY-${n}`), ['intent', 'trial', 'pushed', 'reconciled'], `GY-${n} is recorded through to reconciled`);
    const intent = run.records.find(entry => entry.key === `GY-${n}` && entry.event.kind === 'intent')!.event;
    assert.deepEqual(intent, { kind: 'intent', head: head(n), baseTip: parent, mergeSha, risk: 'normal', at: new Date(start).toISOString() });
    const trial = run.records.find(entry => entry.key === `GY-${n}` && entry.event.kind === 'trial')!.event;
    assert.ok(trial.kind === 'trial' && trial.outcome === 'verdict' && Object.keys(trial.proofs).join() === `unit:item-${n}`, 'each trial record counts the item\'s own proofs');
    parent = mergeSha;
  }
});

test('unit:merge-batch-fallback — a batch whose trial fails is trialled one head at a time and only the failing head is refused; a head that conflicts in the batch merge is set aside and the others still batch', async () => {
  const failing = recording({ failing: [3] });
  const results = await mergeBatch(failing.ports, [1, 2, 3, 4].map(queued));
  assert.deepEqual(failing.calls.filter(call => call.startsWith('trial:')), ['trial:GY-1+GY-2+GY-3+GY-4', 'trial:GY-1', 'trial:GY-1+GY-2', 'trial:GY-1+GY-2+GY-3', 'trial:GY-1+GY-2+GY-4'], 'the batch, then each head alone on the tip the last landed');
  const outcomes = Object.fromEntries(results.map(entry => [entry.work.key, 'outcome' in entry ? entry.outcome.outcome : 'error']));
  assert.deepEqual(outcomes, { 'GY-1': 'merged', 'GY-2': 'merged', 'GY-3': 'refused', 'GY-4': 'merged' }, 'only the failing head is refused');
  assert.deepEqual(failing.kinds('GY-3'), ['intent', 'trial', 'refused']);
  const refusal = failing.records.find(entry => entry.key === 'GY-3' && entry.event.kind === 'refused')!.event;
  assert.ok(refusal.kind === 'refused' && refusal.reason.startsWith(trialFailurePrefix), 'the refusal grounds the head\'s rework');

  const conflicting = recording({ conflicting: [2] });
  const batched = await mergeBatch(conflicting.ports, [1, 2, 3, 4].map(queued));
  assert.deepEqual(conflicting.calls.filter(call => call.startsWith('trial:') || call.startsWith('push:')), ['trial:GY-1+GY-3+GY-4', 'push:GY-1+GY-3+GY-4'], 'the others still batch: one trial, one push');
  assert.deepEqual(conflicting.kinds('GY-2'), ['refused'], 'the conflicting head is set aside for rework');
  const set = batched.find(entry => entry.work.key === 'GY-2')!;
  assert.ok('outcome' in set && set.outcome.outcome === 'refused' && set.outcome.conflict.join() === 'src/app.ts');
  for (const key of ['GY-1', 'GY-3', 'GY-4']) assert.deepEqual(conflicting.kinds(key), ['intent', 'trial', 'pushed', 'reconciled'], `${key} is merged`);
});

test('unit:merge-batch-e2e-own-item — each head in a passing batch records only the runs of its own e2e cases, so no case run is attributed to another item', async () => {
  const run = recording();
  const items = [1, 2].map(queued);
  items.forEach((item, index) => item.criteria.push({ id: 'AC-2', text: 'Shows', proofs: [`e2e:case-${index + 1}`] }));
  const trial = run.ports.trial;
  run.ports.trial = async (...args) => ({ ...await trial(...args), e2e: [1, 2].map(n => ({ proof: `e2e:case-${n}`, case: `e2e/cases/case-${n}.json`, executed: 1, failed: 0 })) });
  await mergeBatch(run.ports, items);
  for (const n of [1, 2]) {
    const record = run.records.find(entry => entry.key === `GY-${n}` && entry.event.kind === 'trial')!.event;
    assert.ok(record.kind === 'trial' && record.outcome === 'verdict');
    assert.deepEqual(record.e2e?.map(entry => entry.proof), [`e2e:case-${n}`], `GY-${n} records its own case run only`);
  }
});
