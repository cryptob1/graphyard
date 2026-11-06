import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { awaitsMerge } from '../src/model/merge-queue.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { keptTrialAheadOfReview, mergeCandidateHold, mergeOne, mergeOpeningHold, mergeRecordKinds, trialAheadOfReviewReason, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';

// GY-3164 AC-1: the merge writer starts a head's trial once its build gate passed (worker
// verification recorded), beside review; the push to main still requires the review gate for that
// exact head. A trial that passes before approval is kept against its head and reused when the
// same head is approved later — a new head discards it — and a trial that fails refuses to rework
// exactly as it does today, review or no review.

const start = Date.parse('2030-05-01T00:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
const head = (seed: string) => sha(seed);
const mergeOf = (commit: string, base: string) => sha(`merge:${commit}:${base}`);
const gatesOf = (passed: Record<string, boolean>) => ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: passed[name] ?? false, reasons: passed[name] ?? false ? [] : [`${name} refused`] }));

/**
 * One item whose gates and candidate the test moves: `gate` is what the control plane serves now
 * (review flips when the same head is approved), `candidate` the submitted head. The ports fold
 * every recorded event with the real fold, so the kept trial the queue and the next flight read is
 * the one the coordinator's ledger would hold.
 */
class World {
  events: MergeRecordEvent[] = [];
  trials = 0;
  pushes: string[] = [];
  gate: Record<string, boolean> = { ready: true, build: true, review: false, test: false, merge: false };
  candidate = head('head1');
  failing = false;
  ledger(): MergeLedgerState | null {
    const rows = this.events.map(event => {
      const { kind: _kind, ...fields } = event as Record<string, unknown> as { kind: string } & Record<string, unknown>;
      return { kind: mergeRecordKinds[event.kind], work: 'GY-1',
        payload: event.kind === 'intent' ? { key: 'GY-1', ...fields } : event.kind === 'refused' ? { ...fields, kind: 'merge' } : fields };
    });
    return foldMergeLedger(rows)['GY-1'] ?? null;
  }
  item(): Work {
    const candidate = { sha: this.candidate, baseSha: tip, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' };
    return {
      id: 'w1', key: 'GY-1', description: '', type: 'feature', priority: 1, dependencies: [],
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }], policy: { checks: ['test'], review: true },
      revision: 1, policyRevision: 1, createdAt: iso(start - 10 * minute), updatedAt: iso(start), stageEnteredAt: iso(start - 10 * minute),
      ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 1 }, candidate, reworkRequested: false,
      scenarioRequirements: [], evidence: [], observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: iso(start) },
      blocker: null, violations: [], gates: gatesOf(this.gate), mergeLedger: this.ledger(), stage: 'build',
    } as unknown as Work;
  }
  ports(): MergePorts {
    const world = this;
    return {
      baseBranch: 'main', now: () => start,
      fetch: async () => tip,
      merge: async (commit, baseTip) => ({ mergeSha: mergeOf(commit, baseTip), files: ['src/app.ts'] }),
      trial: async () => {
        world.trials++;
        const run: MergeTrialRun = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1000, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
        return world.failing ? { ...run, tests: { passed: 0, failed: ['tests/item.test.ts'], files: 1 }, proofs: { 'unit:item-works': { executed: 1, failed: 1 } } } : run;
      },
      push: async mergeSha => { world.pushes.push(mergeSha); return 'pushed'; },
      holds: async () => false,
      // The production wiring (effects-production.ts): the build gate alone opens, both gates land.
      holdOpening: async selected => mergeOpeningHold(world.item(), selected),
      hold: async selected => mergeCandidateHold(world.item(), selected),
      record: async (_item, event) => { world.events.push(event); },
    };
  }
}

test('unit:trial-concurrent-with-review — a build-passed head whose review gate has not passed trials anyway; the passing trial is kept for exactly that head, nothing lands, and the queue holds the head until the same head is approved', async () => {
  const world = new World();
  const outcome = await mergeOne(world.ports(), world.item());
  assert.equal(outcome.outcome, 'requeued', JSON.stringify(outcome));
  assert.deepEqual(world.events.map(event => event.kind), ['intent', 'trial', 'refused'], 'the flight opens, trials and settles without pushing');
  assert.deepEqual(world.pushes, [], 'an unapproved head never lands');
  const kept = world.ledger()!;
  assert.equal(kept.state, 'refused');
  assert.equal(kept.refusal?.kind, 'merge');
  assert.equal(kept.refusal?.reason, trialAheadOfReviewReason('GY-1'), 'the settle grounds no rework and names the kept result');
  assert.ok(!kept.refusal!.reason.startsWith(trialFailurePrefix), 'the marker never reads as a trial failure');
  assert.equal(kept.trial?.head, world.candidate, 'the fold keeps the passing trial on the settled state');
  assert.ok(keptTrialAheadOfReview(world.item().candidate, kept), 'the kept trial is read back for the head');
  // While review has not passed the head is owed nothing: it would only wait at the landing boundary again.
  assert.equal(awaitsMerge(world.item(), { 'GY-1': kept }, start), false, 'no second trial while the review gate has not passed');
  // The same head is approved: the queue owes the landing, and it lands on the kept result — no second trial.
  world.gate.review = true;
  assert.equal(awaitsMerge(world.item(), { 'GY-1': kept }, start), true, 'approval returns the head to the queue for its landing');
  const landing = await mergeOne(world.ports(), world.item());
  const mergeSha = mergeOf(world.candidate, tip);
  assert.deepEqual(landing, { outcome: 'merged', mergeSha, baseTip: tip, observedTip: tip, pushes: 1 }, JSON.stringify(landing));
  assert.deepEqual(world.events.map(event => event.kind), ['intent', 'trial', 'refused', 'intent', 'pushed', 'reconciled'], 'the landing flight records its intent and pushes on the kept result');
  assert.equal(world.trials, 1, 'the kept result is reused: the approved head is never trialled twice');
  const delivered = world.ledger()!;
  assert.equal(delivered.state, 'reconciled');
  assert.equal(awaitsMerge(world.item(), { 'GY-1': delivered }, start), false, 'a delivered head leaves the queue');
});

test('unit:trial-concurrent-with-review — a trial that fails while review is still pending refuses for rework, never as kept: the ground is the trial failure and the head waits for its rework', async () => {
  const world = new World();
  world.failing = true;
  const outcome = await mergeOne(world.ports(), world.item());
  assert.equal(outcome.outcome, 'refused');
  assert.ok(outcome.outcome === 'refused' && outcome.reason.startsWith(trialFailurePrefix), `the refusal grounds the rework: ${outcome.reason}`);
  assert.deepEqual(world.events.map(event => event.kind), ['intent', 'trial', 'refused']);
  const state = world.ledger()!;
  assert.equal(state.refusal?.reason, `${trialFailurePrefix}: tests tests/item.test.ts`);
  assert.ok(!keptTrialAheadOfReview(world.item().candidate, state), 'a failing trial is never kept');
  assert.equal(awaitsMerge(world.item(), { 'GY-1': state }, start), false, 'the head waits for its rework, exactly as it does today');
  assert.deepEqual(world.pushes, []);
});

test('unit:trial-concurrent-with-review — a new head discards the kept result: its own flight trials afresh, settles its own kept trial while unapproved, and lands on it once approved', async () => {
  const world = new World();
  await mergeOne(world.ports(), world.item());
  assert.equal(world.trials, 1);
  assert.ok(keptTrialAheadOfReview(world.item().candidate, world.ledger()), 'the first head kept its trial');
  // A rework lands a new head; review of it has not passed yet either.
  const first = world.candidate;
  world.candidate = head('head2');
  assert.ok(!keptTrialAheadOfReview(world.item().candidate, world.ledger()), "the old head's marker never applies to the new head");
  assert.equal(awaitsMerge(world.item(), { 'GY-1': world.ledger()! }, start), true, 'the new head is owed its own trial beside its review');
  const outcome = await mergeOne(world.ports(), world.item());
  assert.equal(outcome.outcome, 'requeued');
  assert.equal(world.trials, 2, 'the new head trials afresh');
  const second = world.ledger()!;
  assert.equal(second.head, world.candidate, 'the settle belongs to the new head');
  assert.equal(second.trial?.head, world.candidate);
  assert.ok(second.refusal?.reason === trialAheadOfReviewReason('GY-1') && second.head !== first, 'the new head keeps its own result');
  assert.equal(awaitsMerge(world.item(), { 'GY-1': second }, start), false, 'and waits for its approval like the first did');
  world.gate.review = true;
  const landing = await mergeOne(world.ports(), world.item());
  assert.equal(landing.outcome, 'merged');
  assert.equal(world.trials, 2, 'still two trials in all: each head trials exactly once');
  assert.deepEqual(world.pushes, [mergeOf(world.candidate, tip)]);
});

test('unit:trial-concurrent-with-review — the opening hold requires the build gate alone and the landing hold the review gate: an unreviewed head opens, the landing names the keep marker, and each hold still names obsolescence', () => {
  const world = new World();
  const unreviewed = world.item();
  assert.equal(mergeOpeningHold(unreviewed), null, 'the opening hold passes a head whose review gate has not passed');
  assert.equal(mergeCandidateHold(unreviewed), trialAheadOfReviewReason('GY-1'), 'the landing hold answers the keep marker for the same head');
  assert.match(mergeOpeningHold({ ...unreviewed, gates: gatesOf({ ready: true, review: true, test: true }) } as Work)!, /build gate no longer passes/, 'the opening hold still requires the build gate');
  assert.match(mergeCandidateHold({ ...unreviewed, gates: gatesOf({ ready: true, build: true, test: true }) } as Work)!, /^trial passed ahead of review/, 'the landing hold still requires the review gate');
  assert.match(mergeOpeningHold({ ...unreviewed, candidate: { ...unreviewed.candidate!, sha: head('other') } } as Work, unreviewed)!, /candidate changed/, 'obsolescence holds at opening');
  assert.match(mergeCandidateHold({ ...unreviewed, reworkRequested: true } as Work)!, /returned for rework/, 'obsolescence holds at landing');
});
