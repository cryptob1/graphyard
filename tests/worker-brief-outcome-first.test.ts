import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerPrompt } from '../src/master/dispatch.js';
import { reviewStandards } from '../src/review-prompt.js';

// GY-3489: the worker brief opens with the outcome and when it is done, carries one numbered
// pre-submit list, says runtime-only text only to that runtime, and its fixed words stay under 450.

const cli = '/bin/graphyard.mjs';
const criteria = [{ id: 'AC-1', text: 'Exports land intact in src/export.ts', proofs: ['e2e:export-run'] }, { id: 'AC-2', text: 'The export page shows the count', proofs: ['unit:export-count'] }];
const work = {
  key: 'GY-7', title: 'Exports land intact', type: 'feature' as const, why: 'Owners lose rows on export today.', simplest: 'Stream rows instead of buffering them.',
  description: 'Export writes every row; the page shows how many.', criteria, scenarioRequirements: [],
  lastAssignment: { epoch: 2, claimedAt: '2026-11-18T10:00:00.000Z' },
} as Parameters<typeof workerPrompt>[1];
const brief = (kind?: string) => workerPrompt({ cliPath: cli, fastGates: true, ...(kind ? { kind } : {}) }, work, { principal: 'graphyard-worker-1' }, 2);
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const once = (text: string, piece: string) => text.split(piece).length - 1;

test('e2e:worker-brief-outcome-first AC-1 — the brief\'s fixed words, without the item\'s own data, are at most 450 for every runtime', () => {
  const itemData = [work.title, work.why!, work.simplest!, work.description!, ...criteria.map(criterion => `[${criterion.id}] ${criterion.text}`),
    ...criteria.map(criterion => reviewStandards({ key: 'GY-7', criteria: [criterion], scenarioRequirements: [] }).criteria.match(/\[AC-\d\] proofs: \[[^\]]*\]/)![0])];
  for (const kind of ['claude', 'opencode', 'codex']) {
    let fixed = brief(kind);
    for (const piece of itemData) fixed = fixed.split(piece).join(" ");
    assert.ok(words(fixed) <= 450, `the ${kind} brief has ${words(fixed)} fixed words, at most 450`);
  }
});

test('e2e:worker-brief-outcome-first AC-2 — outcome first, done-when and complete --head, then one pre-submit list whose sentences are not repeated', () => {
  const text = brief('claude');
  assert.ok(text.startsWith(`Implement GY-7: Exports land intact. Read why and simplest first and stay inside them. Why: ${work.why} Simplest: ${work.simplest} Done when every criterion below holds on a commit on your assigned branch, submitted with node ${cli} complete GY-7 2 --head as your last action`));
  const list = text.slice(text.indexOf('Before complete: 1.'));
  assert.ok(list.length < text.length, 'the brief carries the pre-submit list');
  const steps = [`1. Run node ${cli} sync GY-7 and resolve conflicts.`, '2. The full test suite is CI\'s gate: run the build and npm run test:affected -- BOUND_PROOF_TEST_FILES, not npm test.', `3. Run node ${cli} review self GY-7 and fix each BLOCKING finding.`, '4. For sandbox-only test failures'];
  let at = 0;
  for (const step of steps) { const next = list.indexOf(step); assert.ok(next >= at, `the list carries, in order: ${step}`); at = next; }
  assert.match(list, /record command and environment error in the commit message, submit with complete/);
  assert.equal(once(text, 'Before complete'), 1, 'one pre-submit list');
  for (const piece of [` sync GY-7`, 'review self', 'fast gates', 'test:affected', 'sandbox-only']) assert.equal(once(text, piece), 1, `${piece} is said once`);
});

test('e2e:worker-brief-outcome-first AC-3 — the brief says, in one sentence, to write the bound proof first and see it fail without the change', () => {
  assert.equal(once(brief(), 'Write the bound proof first and see it fail without the change.'), 1);
});

test('e2e:worker-brief-outcome-first AC-4 — runtime guidance reaches only its runtime, and autonomy is said once, positively', () => {
  const rmGuidance = 'Never give rm or mv a glob', openCode = 'OpenCode external-directory prompt';
  assert.ok(brief('claude').includes(rmGuidance) && !brief('claude').includes(openCode), 'a claude worker reads the rm/mv guidance only');
  assert.ok(brief('opencode').includes(openCode) && !brief('opencode').includes(rmGuidance), 'an opencode worker reads the external-directory guidance only');
  for (const text of [brief('codex'), brief()]) assert.ok(!text.includes(rmGuidance) && !text.includes(openCode), 'another runtime reads neither');
  for (const kind of ['claude', 'opencode', 'codex']) {
    const text = brief(kind);
    assert.equal(once(text, 'You decide and act on your own; end with complete or a recorded blocker naming the command and its error'), 1);
    assert.equal(once(text, 'act on your own'), 1, 'autonomy is stated once');
    for (const gone of ['never end your turn with a question', 'never offer a menu']) assert.ok(!text.includes(gone), `${gone} is gone`);
  }
});
