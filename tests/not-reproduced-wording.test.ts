import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOne, type MergePorts, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { advanceFailureRuns, diagnosisSection, repeatedFailureCause } from '../src/daemon/repeated-failure.js';
import type { DaemonState } from '../src/daemon/state.js';
import type { Work } from '../src/model.js';

// GY-3423: a feature or bug whose proofs already pass on the base tip is refused in plain words that
// name the case file to change, and repeated refusals of that kind never ask for a different approach.

const tip = 'b'.repeat(40);
const proofs = ['unit:widget-fix', 'e2e:widget-shows-fix'];

/** The merge writer's ports, its trial answering as a run whose proofs also passed on the base tip does. */
function ports(): MergePorts {
  const run: MergeTrialRun = { build: 'pass', tests: { passed: 2, failed: [], files: 2 }, durationMs: 1000, logTail: '', files: ['tests/widget.test.ts'],
    proofs: { 'unit:widget-fix': { executed: 1, failed: 0 }, 'e2e:widget-shows-fix': { executed: 1, failed: 0 } },
    notReproduced: { proofs, tip, files: ['tests/widget.test.ts', 'e2e/cases/widget-shows-fix.json'] } } as MergeTrialRun;
  return { baseBranch: 'main', now: () => Date.parse('2030-01-01T00:00:00Z'), fetch: async () => tip,
    merge: async head => ({ mergeSha: `${head.slice(0, 20)}${'c'.repeat(20)}`, files: ['src/widget.ts'] }), trial: async () => run,
    push: async () => 'pushed', holds: async () => false, record: async () => {} };
}

const work = (head: string) => ({ id: 'w-3423', key: 'GY-3423', type: 'bug', title: 'widget', stage: 'build', candidate: { sha: head, baseSha: tip, pr: 1, branch: 'graphyard/gy-3423-1', author: 'worker' },
  submission: { epoch: 1, pr: 1 }, criteria: [{ id: 'AC-1', text: 'the widget is fixed', proofs }], gates: [] }) as unknown as Work;

test('integration:not-reproduced-wording — a trial whose bound proofs pass on head and base is refused saying the proof already passes on the base tip without the change and naming the case file to change; repeated, it never asks for a different approach', async () => {
  const state = { failureRuns: {}, actions: {} } as unknown as DaemonState;
  for (const [index, head] of ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)].entries()) {
    const outcome = await mergeOne(ports(), work(head));
    assert.equal(outcome.outcome, 'refused', JSON.stringify(outcome));
    const reason = (outcome as { reason: string }).reason;
    assert.match(reason, new RegExp(`already pass on the base tip ${tip} without this change`));
    assert.match(reason, /Change tests\/widget\.test\.ts, e2e\/cases\/widget-shows-fix\.json so a case fails on the base tip and passes with the change\./);
    assert.doesNotMatch(reason, /not reproduced/);

    // The loop folds each refusal into the item's run of equal failures, as it does every cycle.
    const refused = { ...work(head), mergeLedger: { key: 'GY-3423', state: 'refused', head, intentAt: `2030-01-01T00:0${index}:00.000Z`, refusal: { kind: 'merge', reason } } } as unknown as Work;
    advanceFailureRuns(state, [refused], []);
    const run = state.failureRuns[refused.id];
    assert.equal(run?.count, index + 1);
    for (const text of [diagnosisSection(run), repeatedFailureCause(run)?.detail ?? '']) assert.doesNotMatch(text, /different approach/, text);
    if (index) assert.match(diagnosisSection(run), /change the named case file so a case fails on the base tip/);
  }
});
