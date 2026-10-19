import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentationPolicySchema } from '../src/model/documentation.js';

// GY-2515: the docs wording pins and the docs word budget failed merge trials on prose, not
// behaviour — every rework round they cost was spent on sentences and word counts no user could
// observe. The wording-pin tests and the whole word-budget surface (the configuration, its
// enforcement, its headroom reading and its gates) are gone; the docs themselves stay, and tests
// that check a documented command exists or a link resolves stay with them. These cases keep the
// removal in place: the deleted files stay deleted, nothing configures or enforces a budget any
// more, and no remaining test starts counting the documentation's words again.

const root = fileURLToPath(new URL('..', import.meta.url));

const removed = [
  'tests/docs-repo-policy-wording.test.ts',
  'tests/delivery-docs.test.ts',
  'tests/delivery-redesign-doc.test.ts',
  'tests/docs-current-model.test.ts',
  'tests/main-watch-docs-wording.test.ts',
  'tests/docs-budget.test.ts',
  'tests/docs-budget-headroom.test.ts',
  'tests/docs-growth-gate.test.ts',
];

test('unit:docs-pins-removed — the docs wording-pin and word-budget test files are gone', async () => {
  for (const file of removed) await assert.rejects(access(join(root, file), constants.F_OK), `${file} is deleted`);
});

test('unit:docs-pins-removed — nothing configures or enforces a docs word budget any more', async () => {
  const config = JSON.parse(await readFile(join(root, 'graphyard.json'), 'utf8'));
  assert.equal(config.documentation?.wordBudget, undefined, 'graphyard.json configures no docs word budget');
  assert.throws(() => documentationPolicySchema.parse({ paths: ['docs/'], changelog: null, wordBudget: { total: 100, perPage: 100 } }),
    'the documentation policy refuses a wordBudget: the schema configures none');
  // The removed enforcement surface, by name: the module, its budget API and its headroom reading.
  const banned = /documentation-budget|docsBudget|docsHeadroom|docsWordBudgetOf|repositoryDocsBudget|budgetedPage/;
  for (const file of await testFiles(join(root, 'src'))) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, banned, `${file} under src/ enforces no docs word budget`);
  }
});

const WORD_COUNT = /(?:\.split\(\/\\s\+\/\)|\.match\(\/\\S\+\/g\)|\bdocsWords\s*\()/g;
const DOCS_PAGE = /(?:docs\/[\w.-]+(?:\/[\w.-]+)*\.md|['"]README\.md['"]|['"]docs\/['"])/g;

/** Every .ts file under `directory`, at any depth. */
async function testFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...await testFiles(join(directory, entry.name)));
    else if (entry.name.endsWith('.ts')) out.push(join(directory, entry.name));
  }
  return out;
}

test('unit:docs-pins-removed — no remaining file under tests/ asserts a word count of docs/', async () => {
  // This file itself names the patterns it forbids, so the scan skips it.
  for (const file of (await testFiles(join(root, 'tests'))).filter(file => !file.endsWith('docs-pins-removed.test.ts'))) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(WORD_COUNT)) {
      const window = text.slice(Math.max(0, match.index! - 400), match.index! + match[0].length + 400);
      const pages = [...window.matchAll(DOCS_PAGE)].map(entry => entry[0]);
      assert.deepEqual(pages, [], `${file} counts words of docs/ (${pages.join(', ')}): the docs word budget is gone, and prose is not judged by count`);
    }
  }
});
