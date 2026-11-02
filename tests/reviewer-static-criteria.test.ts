import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPrompt, reviewStandard, reviewRetryPrompt } from '../src/reviewer.js';
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
    assert.match(prompt, /state each judgement in the review body/);
    assert.match(prompt, /Do not run builds, tests or servers/);
    assert.match(prompt, /Post APPROVE or REQUEST_CHANGES before the automated merge trial/);
    assert.match(prompt, /from code and test coverage, including bound E2E cases/);
    assert.match(prompt, /missing later trusted results do not block review/);
    assert.match(prompt, /no human step/);
    assert.match(prompt, /do not run the project's build, tests, or servers/);
    assert.match(prompt, /AC-2, AC-3 check one case/);
    assert.match(prompt, /inspect the implementation and test coverage for other seeds or inputs/);
    assert.match(prompt, /request changes if the code only handles the pinned case or the coverage does not establish the required generality/);
    assert.doesNotMatch(prompt, /AC-1 checks one case|AC-4 checks one case|run the head once|quote both results/);
  }
  assert.doesNotMatch(reviewStandard({ key: binding.key, head, base }, [proofBinding]), /checks one case|check one case/);
  assert.doesNotMatch(reviewStandard({ key: binding.key, head, base }), /checks one case|check one case/);
});


test('review brief bindings also reach GitHub launches and legacy retries without invented pins', () => {
  const criteria = [{ id: 'AC-1', text: 'Coverage is inspectable.', proofs: ['integration:review-brief-proof-bindings', 'e2e:review-brief-proof-bindings'] }];
  const pins = [{ proof: 'e2e:review-brief-proof-bindings', revision: 3, environment: 'local', hash: 'c'.repeat(64) }];
  const config = { repository: 'owner/project', cliPath: '/bin/graphyard.mjs' };
  const briefs = [
    reviewPrompt(config, binding, undefined, undefined, criteria, undefined, undefined, undefined, undefined, undefined, undefined, undefined, pins),
    reviewRetryPrompt(config.repository, binding, criteria, config.cliPath, pins),
  ];
  for (const brief of briefs) {
    assert.ok(brief.includes('[AC-1] proofs: [{"proof":"integration:review-brief-proof-bindings"},{"proof":"e2e:review-brief-proof-bindings","caseId":"review-brief-proof-bindings","path":"e2e/cases/review-brief-proof-bindings.json","revision":3,"environment":"local","hash":"' + 'c'.repeat(64) + '"}]'));
    assert.ok(brief.includes(`git show ${head}:PATH`));
    assert.match(brief, /guide review is supported and needs no worker or coordinator credential/);
    assert.match(brief, /repository reads and reviews only/);
    assert.match(brief, /mistyped or nonexistent exploratory path or guessed command is not itself an operational blocker/);
    assert.match(brief, /rg --files/);
    assert.match(brief, /CLI --help, then retry the authorized read/);
    assert.match(brief, /necessary input remains unavailable through authorized equivalent reads/);
    assert.doesNotMatch(brief, /If a command you need is refused or cannot succeed/);
  }
  const unpinned = reviewPrompt(config, binding, undefined, undefined, criteria);
  assert.match(unpinned, /e2e\/cases\/review-brief-proof-bindings.json/);
  assert.doesNotMatch(unpinned, /"revision":|"environment":|"hash":/);
});
