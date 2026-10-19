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
  // timing, qualified as the default.
  const readme = read('README.md');
  const review = readme.split('\n').filter(line => /^\d+\. An independent agent reviews/.test(line));
  assert.equal(review.length, 1, 'README.md has one review step');
  assert.match(review[0], /before the merge for sensitive changes and after the merge for everything else, by default\.$/, 'README.md states the review timing as the default');
  // Steps stay prose (no code or links), so the settings and the link follow the steps: each
  // setting is named beside the decision it makes.
  const policy = readme.split('\n').filter(line => /^graphyard\.json sets/.test(line));
  assert.equal(policy.length, 1, 'README.md has one line naming the graphyard.json review policy');
  assert.match(policy[0], /sensitive paths \(`risk\.sensitive`\)/, 'README.md names risk.sensitive as the setting that decides which paths are sensitive');
  assert.match(policy[0], /normal-change review timing \(`review\.normalChanges`\)/, 'README.md names review.normalChanges as the setting that decides when normal changes are reviewed');
  assert.match(policy[0], /\]\(docs\/delivery\.md\)/, 'README.md links docs/delivery.md, which lists the graphyard.json policy');
  assert.match(readme, /Text equivalent: steps 1-8\./, 'the flowchart\'s text equivalent points at the qualified steps');
  // The how-it-works guide ties each setting to the decision it makes, as src/model/risk-class.ts
  // does: classifyRisk reads risk.sensitive for the class; reviewedBeforeMerge reads
  // review.normalChanges for when a normal change is reviewed. Neither setting decides the other.
  const guide = read('docs/how-graphyard-works.md');
  const passages = guide.split('\n').filter(line => /^\*\*Risk class\*\*/.test(line));
  assert.equal(passages.length, 1, 'docs/how-graphyard-works.md has one risk class passage');
  const [riskClass, timing] = passages[0].split('**Review timing**');
  assert.ok(timing, 'the passage explains review timing apart from the risk class');
  assert.match(riskClass, /`graphyard\.json` `risk\.sensitive` \(generic default\)/, 'the risk class comes from graphyard.json\'s risk.sensitive, with the generic default');
  assert.doesNotMatch(riskClass, /review\.normalChanges/, 'review.normalChanges does not determine the risk class');
  assert.match(timing, /sensitive before merge, normal after unless `review\.normalChanges: pre-merge`/, 'review.normalChanges chooses when normal changes are reviewed; post-merge is the default');
  // GY-2010: there is no github mode left to except from the review timing.
  assert.doesNotMatch(timing, /github mode/, 'no github-mode exception is described');
  assert.doesNotMatch(timing, /risk\.sensitive/, 'risk.sensitive does not set the review timing');
  assert.match(timing, /\]\(delivery\.md\)/, 'the review timing links docs/delivery.md, which lists the graphyard.json policy');
  assert.doesNotMatch(passages[0], /judged from the merge delta,/, 'the risk class is no longer described as judged from the merge delta alone');
  // The qualification is net-zero in words on a saturated set: it trims prose, it does not raise the budget.
  const budget = parseRepositoryConfig(read('graphyard.json')).documentation.wordBudget!;
  // GY-2172 halved the set and lowered the budget to the new total plus 10%.
  assert.equal(budget.total, 8_489, 'the docs word budget total stays at the halved set plus 10%; trim prose instead of raising it');
  assert.equal(budget.perPage, 1_200, 'the docs word budget per-page cap stays 1,200; trim prose instead of raising it');
});
