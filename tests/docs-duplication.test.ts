import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Dependency-free documentation script.
import { duplicates, minimumWords, normative, sentences, similarity, threshold, words } from '../scripts/docs-duplication.mjs';

/**
 * One authoritative home per rule. A rule restated on a second page drifts from the first, so
 * this fails when two pages state the same normative sentence in nearly the same words.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

test('unit:docs-duplication no normative sentence is restated on a second page', () => {
  const report = duplicates(root);
  const findings = report.duplicates.map((entry: any) => `${entry.score} ${entry.pages.join(' / ')}\n  ${entry.sentences[0]}\n  ${entry.sentences[1]}`);
  assert.deepEqual(findings, [], findings.join('\n'));
  assert.ok(report.compared >= 300, `only ${report.compared} normative sentences were compared; the detector must actually read the corpus`);
});

test('unit:docs-duplication the detector recognises a restatement and tolerates a different rule', () => {
  const original = 'A worker must never receive an operator credential, because the acceptance gate would then be satisfiable by the implementer.';
  const restated = 'A worker must never receive an operator credential, since the acceptance gate would then be satisfiable by the implementer.';
  const different = 'A reviewer approves the exact candidate head and is never the pull-request author or the control-plane App.';
  assert.ok(similarity(words(original), words(restated)) >= threshold, 'a reworded copy is a restatement');
  assert.ok(similarity(words(original), words(different)) < threshold, 'a different rule is not');
  assert.ok(normative.test(original) && !normative.test('The dashboard shows three tiles at the top of the page.'));
  assert.equal(words('A worker must never!').length, 4);
  assert.ok(minimumWords >= 8, 'short shared phrases are not compared');
  // Tables, code and headings are reference material, not restated prose.
  assert.deepEqual(sentences('# Title\n\n| a | b |\n\n```sh\nnpm test\n```\n\nOne sentence. Two sentences.'), ['One sentence.', 'Two sentences.']);
});
