import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeCandidateHold, mergeOne, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';

// GY-3151 AC-1: another head merges while this head's trial runs, so the snapshot's candidate.baseSha
// moves to the new tip. The head and policy revision are unchanged, so the trial is not refused as
// "candidate changed": on its pass the head is re-merged onto the new tip and pushed (a conflict
// returns it for rework), with no new trial.

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const head = sha('head'), base = sha('base'), moved = sha('moved');

const item = (baseSha: string): Work => {
  const candidate = { sha: head, baseSha, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' };
  return { id: 'w1', key: 'GY-1', type: 'feature', stage: 'build', epoch: 1, lease: null, policyRevision: 2, reworkRequested: false, submission: { epoch: 1, pr: 1 }, candidate,
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }], policy: { checks: ['test'], review: true }, evidence: [], mergeLedger: null,
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, at: '2030-01-01T00:00:00.000Z' },
    gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })) } as unknown as Work;
};

function world(conflictOnMoved = false) {
  const selected = item(base);
  let tip = base, current = selected;
  const trials: string[] = [], pushes: string[] = [], events: MergeRecordEvent[] = [];
  const ports: MergePorts = {
    baseBranch: 'main', now: () => Date.parse('2030-01-01T00:00:00Z'),
    fetch: async () => tip,
    merge: async (_head, onto) => onto === moved && conflictOnMoved ? { conflict: ['src/app.ts'] } : { mergeSha: sha(`merge-${onto}`), files: ['src/app.ts'] },
    trial: async mergeSha => {
      trials.push(mergeSha);
      // Another head lands: main moves and the snapshot's candidate base follows it.
      tip = moved; current = item(moved);
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
    },
    push: async (mergeSha, onto) => { if (onto !== tip) return 'rejected'; pushes.push(mergeSha); return 'pushed'; },
    holds: async () => false,
    hold: async work => mergeCandidateHold(current, work),
    record: async (_item, event) => { events.push(event); },
  };
  return { ports, selected, trials, pushes, events };
}

test('unit:base-move-keeps-concurrent-trial — main moving during a trial keeps it: the passing head is re-merged onto the new tip and pushed with no new trial', async () => {
  const w = world();
  const outcome = await mergeOne(w.ports, w.selected);
  assert.equal(outcome.outcome, 'merged', JSON.stringify(outcome));
  assert.deepEqual(w.trials, [sha(`merge-${base}`)], 'one trial, of the merge onto the original tip');
  assert.deepEqual(w.pushes, [sha(`merge-${moved}`)], 'a fresh re-merge onto the moved tip is pushed, not the trialled merge');
  assert.ok(!w.events.some(event => event.kind === 'refused'), 'nothing is refused as candidate changed');
});

test('unit:base-move-keeps-concurrent-trial — a re-merge onto the moved tip that conflicts returns the head for rework', async () => {
  const w = world(true);
  const outcome = await mergeOne(w.ports, w.selected);
  assert.equal(outcome.outcome, 'refused');
  assert.deepEqual(outcome.outcome === 'refused' && outcome.conflict, ['src/app.ts']);
  assert.equal(w.trials.length, 1);
  assert.deepEqual(w.pushes, []);
});

test('unit:base-move-keeps-concurrent-trial — a new head or policy revision still obsoletes the trial', () => {
  const selected = item(base);
  assert.match(mergeCandidateHold({ ...selected, candidate: { ...selected.candidate!, sha: sha('other') } } as Work, selected)!, /candidate changed/);
  assert.match(mergeCandidateHold({ ...selected, policyRevision: 3 } as Work, selected)!, /policy changed/);
});
