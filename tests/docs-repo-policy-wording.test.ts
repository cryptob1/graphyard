import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRepositoryConfig } from '../src/model/documentation.js';

// GY-1866: GY-1843 made review timing (`review.normalChanges`) and the sensitive path set
// (`risk.sensitive`) each repository's graphyard.json policy, with a generic default when it
// declares none, but README.md and docs/how-graphyard-works.md still presented
// sensitive-before/normal-after review and the sensitive set as Graphyard's fixed behaviour.
// This pin keeps both pages attributing review timing and the risk class to graphyard.json (the
// guide linking docs/delivery.md for the details), and keeps the word budget the qualification was
// written under: the set was saturated, so the change had to be net-zero in words, not paid for
// by raising the budget.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

test('unit:docs-repo-policy-wording — README and the how-it-works guide attribute review timing and the risk class to graphyard.json, never to fixed behaviour', () => {
  // README's How it works steps are prose (tests/readme.test.ts): step 5 keeps the generic
  // timing, qualified as the default, and names graphyard.json as what sets it.
  const readme = read('README.md');
  const review = readme.split('\n').filter(line => /^\d+\. An independent agent reviews/.test(line));
  assert.equal(review.length, 1, 'README.md has one review step');
  assert.match(review[0], /before the merge for sensitive changes and after the merge for everything else, by default/, 'README.md states the review timing as the default');
  assert.match(review[0], /graphyard\.json sets both/, 'README.md names graphyard.json as what sets the review timing and the sensitive set');
  assert.match(readme, /Text equivalent: steps 1-8\./, 'the flowchart\'s text equivalent points at the qualified steps');
  // The how-it-works guide's risk class passage names the policy, its two settings and the generic default.
  const guide = read('docs/how-graphyard-works.md');
  const passages = guide.split('\n').filter(line => /^\*\*Risk class\*\*/.test(line));
  assert.equal(passages.length, 1, 'docs/how-graphyard-works.md has one risk class passage');
  for (const pattern of [/graphyard\.json/, /risk\.sensitive/, /review\.normalChanges/, /generic defaults?/]) {
    assert.match(passages[0], pattern, `the risk class passage names ${pattern}`);
  }
  assert.doesNotMatch(passages[0], /judged from the merge delta,/, 'the risk class is no longer described as judged from the merge delta alone');
  assert.match(guide, /\(delivery\.md\)/, 'docs/how-graphyard-works.md links docs/delivery.md, which lists the graphyard.json policy');
  // The qualification is net-zero in words on a saturated set: it trims prose, it does not raise the budget.
  const budget = parseRepositoryConfig(read('graphyard.json')).documentation.wordBudget!;
  assert.equal(budget.total, 16_000, 'the docs word budget total stays 16,000; trim prose instead of raising it');
  assert.equal(budget.perPage, 1_200, 'the docs word budget per-page cap stays 1,200; trim prose instead of raising it');
});
