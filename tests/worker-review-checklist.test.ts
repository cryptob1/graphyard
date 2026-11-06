import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerPrompt } from '../src/master/dispatch.js';
import { reviewPrompt, reviewStandard, reviewStandards } from '../src/reviewer.js';

// GY-3166: the worker brief carries the standards the reviewers judge by, from the one function
// their requests read, and its last step before complete is a self-check against them. The
// verdict-posting half of the criteria rule stays with the reviewer.

const cli = '/bin/graphyard.mjs';
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const criteria = [{ id: 'AC-1', text: 'Exports land intact', proofs: ['unit:exports', 'e2e:export-run'] }];
const work = { key: 'GY-7', title: 'Exports', criteria, scenarioRequirements: [] };
const brief = workerPrompt({ cliPath: cli }, work, { principal: 'graphyard-worker-1' }, 2);

test('unit:tests/worker-review-checklist.test.ts unit:worker-brief-has-review-checklist — the worker brief renders simplicity, the criteria rule for its own criteria, the repetition question and the product questions from reviewStandards, which the review requests read', () => {
  const standards = reviewStandards(work);
  for (const [name, piece] of Object.entries(standards)) {
    assert.ok(piece.trim().length > 0, `${name} is not empty`);
    assert.equal(brief.split(piece).length, 2, `the brief carries ${name} verbatim, once`);
  }
  assert.match(brief, /\[AC-1\] Exports land intact/, 'the brief lists the item\'s own criterion');
  assert.match(brief, /e2e\/cases\/export-run\.json/, 'and its bound proofs');
  assert.equal(standards.criteria.split('Every feature or bug needs at least one proof that fails without the change').length, 2, 'the criteria section says, once, that a feature or bug needs a proof failing without the change');
  assert.match(brief, /at head HEAD from code and test coverage/, 'the head a brief cannot know yet is named as HEAD');

  const code = reviewPrompt({ repository: 'owner/project', cliPath: cli }, { key: 'GY-7', pr: 1, sha: head, baseSha: base, policyRevision: 1 }, undefined, undefined, criteria);
  const reviewed = reviewStandards(work, head);
  for (const piece of [reviewed.simplicity, reviewed.criteria, reviewed.repetition]) assert.ok(code.includes(piece), 'the code review reads the same piece');
  assert.ok(reviewStandard({ key: 'GY-7', head, base }, criteria).includes(reviewed.criteria), 'as does the control-plane standard');
  const product = reviewPrompt({ repository: 'owner/project', cliPath: cli }, { key: 'GY-7', pr: 1, sha: head, baseSha: base, policyRevision: 1 }, undefined, undefined, criteria, undefined, undefined, undefined, undefined, undefined, { head, baseTip: base, product: true } as never);
  assert.ok(product.includes(`Then judge: ${standards.product}`), 'the product review reads the same questions');
});

test('unit:tests/worker-review-checklist.test.ts unit:worker-brief-self-check-before-complete — the brief\'s last step before complete checks the diff against those standards, and no verdict-posting text reaches the worker', () => {
  const checklist = brief.indexOf('Reviewers judge your head by this checklist');
  const selfCheck = brief.indexOf('Last step before complete: check your diff against the reviewers\' standards');
  const autonomous = brief.indexOf('Decide and act on your own');
  assert.ok(checklist >= 0 && checklist < selfCheck && selfCheck < autonomous, 'checklist, then self-check, then the closing line');
  assert.match(brief.slice(selfCheck, autonomous), /review self GY-7 prints them\) and fix each BLOCKING finding you would expect\. $/);
  for (const reviewerOnly of [/Post APPROVE/, /REQUEST_CHANGES/, /Do not run builds/, /state each judgement/]) assert.doesNotMatch(brief, reviewerOnly);
});
