import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPrompt, reviewStandard } from '../src/reviewer.js';
import { pinnedCases, singleCaseWarnings } from '../src/model.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const binding = { key: 'GY-3046', pr: 1, sha: head, baseSha: base, policyRevision: 1 };
const proofBinding = {
  id: 'AC-1',
  text: 'Bind e2e/cases/reviewer-static-criteria.json to regression coverage of the generated review requests.',
  proofs: ['e2e:reviewer-static-criteria'],
};
const seed = { id: 'AC-2', text: 'The campaign completes every mission on seed 42', proofs: ['unit:campaign'] };
const fixture = { id: 'AC-3', text: 'The level at fixtures/one.json loads', proofs: ['unit:level'] };
const multiple = { id: 'AC-4', text: 'The campaign completes on seeds 42, 7 and 1', proofs: ['unit:campaign'] };

test('unit:reviewer-static-criteria — proof bindings are not sample inputs, while seeds and fixtures still count', () => {
  assert.deepEqual(pinnedCases(proofBinding.text), []);
  assert.deepEqual(singleCaseWarnings([proofBinding]), []);
  assert.deepEqual(pinnedCases(`${proofBinding.text} Also load fixtures/one.json on seed 42.`), ['42', 'fixtures/one.json']);
  assert.deepEqual(pinnedCases('Bind e2e/cases/worker-filesystem-isolation.json to AC-4.'), []);
  assert.deepEqual(singleCaseWarnings([seed, fixture, multiple]).map(warning => warning.split(' ')[0]), ['AC-2', 'AC-3']);
});

test('unit:reviewer-static-criteria — generated GitHub, control-plane and post-merge briefs support a static verdict for every criterion', () => {
  const criteria = [proofBinding, seed, fixture, multiple];
  const prompts = [
    reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, criteria),
    ...[undefined, { mergeSha: head }].map(postMerge => reviewPrompt(
      { repository: 'owner/project' }, binding, undefined, undefined, criteria,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { head, baseTip: base, postMerge },
    )),
  ];
  for (const prompt of prompts) {
    for (const criterion of criteria) assert.ok(prompt.includes(`[${criterion.id}] ${criterion.text}`));
    assert.match(prompt, /state that judgement for every criterion/);
    assert.match(prompt, /Assess the code and test coverage without running builds, tests, or servers/);
    assert.match(prompt, /exact-head test and E2E execution belongs to the automated merge trial gate/);
    assert.match(prompt, /Post APPROVE or REQUEST_CHANGES on that assessment/);
    assert.match(prompt, /absence of a reviewer-run test is not a blocker and requires no human step/);
    assert.match(prompt, /do not run the project's build, tests, or servers/);
    assert.match(prompt, /AC-2, AC-3 check one case/);
    assert.match(prompt, /inspect the implementation and test coverage for other seeds or inputs/);
    assert.match(prompt, /request changes if the code only handles the pinned case or the coverage does not establish the required generality/);
    assert.doesNotMatch(prompt, /AC-1 checks one case|AC-4 checks one case|run the head once|quote both results/);
  }
  assert.doesNotMatch(reviewStandard({ key: binding.key, head, base }, [proofBinding]), /checks one case|check one case/);
  assert.doesNotMatch(reviewStandard({ key: binding.key, head, base }), /checks one case|check one case/);
});
