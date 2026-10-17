import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRepositoryConfig } from '../src/model/documentation.js';

// GY-1866: GY-1843 made review timing (`review.normalChanges`) and the sensitive path set
// (`risk.sensitive`) each repository's graphyard.json policy, with a generic default when it
// declares none, but README.md and docs/how-graphyard-works.md still presented
// sensitive-before/normal-after review and the sensitive set as Graphyard's fixed behaviour.
// This pin keeps both pages attributing review timing and the risk class to graphyard.json,
// linking docs/delivery.md for the details, and keeps the word budget the qualification was
// written under: the set was saturated, so the change had to be net-zero in words, not paid for
// by raising the budget.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

test('unit:docs-repo-policy-wording — README and the how-it-works guide attribute review timing and the risk class to graphyard.json, never to fixed behaviour', () => {
  for (const page of ['README.md', 'docs/how-graphyard-works.md']) {
    const text = read(page);
    // The passage that describes review timing and risk class names the policy and its two settings.
    const passages = text.split('\n').filter(line => /review\.normalChanges/.test(line));
    assert.ok(passages.length > 0, `${page} describes review timing (review.normalChanges)`);
    for (const passage of passages) {
      assert.match(passage, /graphyard\.json/, `${page} names graphyard.json in the passage that describes review timing and risk class`);
      assert.match(passage, /risk\.sensitive/, `${page} names risk.sensitive in the same passage`);
      assert.match(passage, /generic defaults?/, `${page} states the generic default for a graphyard.json that declares none`);
    }
    assert.match(text, /\(docs\/delivery\.md\)|\(delivery\.md\)/, `${page} links docs/delivery.md for the details`);
    // Neither page presents sensitive-before/normal-after review as fixed behaviour.
    assert.doesNotMatch(text, /for sensitive changes and after the merge for everything else/, `${page} no longer states fixed review timing`);
    assert.doesNotMatch(text, /\|normal: after\|/, `${page} no longer labels normal-after review as fixed`);
    assert.doesNotMatch(text, /\|sensitive: before\|/, `${page} no longer labels sensitive-before review as fixed`);
  }
  // The qualification is net-zero in words on a saturated set: it trims prose, it does not raise the budget.
  const budget = parseRepositoryConfig(read('graphyard.json')).documentation.wordBudget!;
  assert.equal(budget.total, 16_000, 'the docs word budget total stays 16,000; trim prose instead of raising it');
  assert.equal(budget.perPage, 1_200, 'the docs word budget per-page cap stays 1,200; trim prose instead of raising it');
});
