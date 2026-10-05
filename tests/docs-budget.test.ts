import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { budgetedPage, docsWordBudgetOf, parseRepositoryConfig } from '../src/model/documentation.js';

/**
 * The documentation is a short set an operator or agent can actually read: a word budget for the
 * whole set and for each page, and every topic on exactly one page. A page that grows past its
 * budget, or a section copied onto a second page instead of linked, fails here by name.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
// Graphyard's own documentation budget is this repository's configuration, not a product rule for
// managed projects (GY-574): graphyard.json's documentation.wordBudget sets the total, the per-page
// cap and the pages counted, exactly as the control plane reads any project's. It is 12,000 words,
// per page 1,200, as the criterion requires. The total is never a merge gate: over it this test
// warns and passes, and the loop's headroom step and its one trim item restore the room; a page
// over its cap still fails here.
const budget = docsWordBudgetOf(parseRepositoryConfig(read('graphyard.json')).documentation)!;
const { total: TOTAL_BUDGET, perPage: PAGE_BUDGET } = budget;
const pages = ['README.md', 'AGENTS.md', ...readdirSync(`${root}docs`, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => `${entry.parentPath.slice(root.length)}/${entry.name}`)].filter(page => budgetedPage(page, budget)).sort();
/** Words as `wc -w` counts them: maximal runs of non-whitespace, markup and code included. */
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Headings that name a kind of section rather than a topic, so two pages may share them. */
const GENERIC_HEADINGS = new Set(['overview', 'related', 'see also']);
const DUPLICATE_PARAGRAPH_WORDS = 25;
/** A sentence or clause this long, said on two pages, is a copy rather than a shared phrase (GY-1069). */
const DUPLICATE_SENTENCE_WORDS = 10;

const normalize = (text: string) => text.toLowerCase().replace(/<!--[\s\S]*?-->/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_>#|-]/g, ' ').replace(/\s+/g, ' ').trim();

/** Prose blocks outside code fences, and each of their lines, as a reader would quote them. */
function paragraphs(text: string) {
  const prose = text.replace(/```[\s\S]*?```/g, '\n\n');
  const blocks = prose.split(/\n\s*\n/).map(block => block.trim()).filter(block => block && !block.startsWith('#'));
  return [...new Set([...blocks, ...blocks.flatMap(block => block.split('\n'))].map(normalize))].filter(block => words(block) >= DUPLICATE_PARAGRAPH_WORDS);
}

/** Sentences and clauses of prose outside code fences, split where a reader's quote would end. */
function sentences(text: string) {
  return [...new Set(text.replace(/```[\s\S]*?```/g, '\n\n').split(/(?<=[.!?:;])\s+|\n\s*\n/).map(normalize))].filter(sentence => words(sentence) >= DUPLICATE_SENTENCE_WORDS);
}

function headings(text: string) {
  return [...text.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => normalize(match[1])).filter(heading => !GENERIC_HEADINGS.has(heading));
}

/**
 * Headroom under the configured budget (GY-1069): every page stays at least 200 words under the
 * per-page cap, so a merge-queue tip that adds a paragraph to one page does not fail the cap. A
 * page past its headroom fails here by name; the total's headroom, like the total itself, is never
 * a merge gate and only warns.
 */
const PAGE_HEADROOM = 200;
const TOTAL_HEADROOM = 600;
const headroomJudgement = (counts: { page: string; words: number }[]) => {
  const pageTarget = PAGE_BUDGET - PAGE_HEADROOM;
  const totalTarget = TOTAL_BUDGET - TOTAL_HEADROOM;
  const over = counts.filter(entry => entry.words > pageTarget).map(entry => `${entry.page} (${entry.words} words)`);
  const total = counts.reduce((sum, entry) => sum + entry.words, 0);
  return {
    failed: over.length ? `pages within ${PAGE_HEADROOM} words of the ${PAGE_BUDGET}-word page budget (over ${pageTarget}): ${over.join(', ')}` : null,
    warning: total > totalTarget ? `README.md and docs/ total ${total} words, within ${TOTAL_HEADROOM} of the ${TOTAL_BUDGET}-word budget (over ${totalTarget})` : null,
  };
};

/**
 * The budget's judgement (GY-574): a page over its per-page cap fails here by name; a total over
 * the budget never does — the word budget is never a merge gate, so an over-budget total is the
 * warning that passes, naming the total and the largest pages, and `master status` reports it.
 */
const budgetJudgement = (counts: { page: string; words: number }[]) => {
  const over = counts.filter(entry => entry.words > PAGE_BUDGET).map(entry => `${entry.page} (${entry.words} words)`);
  const total = counts.reduce((sum, entry) => sum + entry.words, 0);
  const largest = [...counts].sort((a, b) => b.words - a.words).slice(0, 5).map(entry => `${entry.page} ${entry.words}`).join(', ');
  return {
    failed: over.length ? `pages over the ${PAGE_BUDGET}-word page budget: ${over.join(', ')}` : null,
    warning: total > TOTAL_BUDGET ? `README.md and docs/ total ${total} words; the budget is ${TOTAL_BUDGET} (largest: ${largest})` : null,
  };
};

/** Facts a criterion requires a budgeted page to state, so trimming for the budget cannot drop them. */
const REQUIRED_STATEMENTS: [string, RegExp][] = [
  ['docs/master-agent-reference.md', /decisions step stays within 10 s a cycle/],
  ['docs/master-agent-reference.md', /history whose ledger has not moved is kept, not read/],
];

test('unit:docs-word-budget — the pages graphyard.json budgets (README.md and every docs page) keep every page within its per-page budget and 200 words under it, counted as wc -w counts them; a total over the budget or its headroom warns and passes', () => {
  assert.ok(budget, 'graphyard.json configures documentation.wordBudget');
  assert.equal(words('one  two\tthree\n\nfour — `five six` [seven](eight.md)'), 8, 'words are whitespace-separated runs, as wc -w counts them');
  const wc = spawnSync('wc', ['-w', 'README.md'], { cwd: root, encoding: 'utf8' });
  if (wc.status === 0) assert.equal(Number(wc.stdout.trim().split(/\s+/)[0]), words(read('README.md')), 'the count agrees with wc -w');
  const counts = pages.map(page => ({ page, words: words(read(page)) }));
  assert.ok(counts.length > 0 && counts.some(entry => entry.page === 'docs/README.md'), 'the generated index is counted');
  const judgement = budgetJudgement(counts);
  assert.equal(judgement.failed, null, `a page over its budget fails here: ${judgement.failed}`);
  if (judgement.warning) console.warn(`unit:docs-word-budget: ${judgement.warning}`);
  const headroom = headroomJudgement(counts);
  assert.equal(headroom.failed, null, `a page past its headroom fails here: ${headroom.failed}`);
  if (headroom.warning) console.warn(`unit:docs-word-budget: ${headroom.warning}`);
  const largest = counts.reduce((top, entry) => entry.words > top.words ? entry : top);
  console.log(`unit:docs-word-budget: ${counts.length} pages, ${counts.reduce((sum, entry) => sum + entry.words, 0)} words in total; largest ${largest.page} (${largest.words})`);
  // Statements a criterion requires the budgeted pages to keep (GY-1142 AC-2): the budget holds
  // with them in, and a trim that drops one fails here instead of passing silently.
  for (const [page, statement] of REQUIRED_STATEMENTS) assert.match(read(page), statement, `${page} states ${statement}`);
});

test('unit:docs-budget-reports-not-blocks — an over-budget total passes with the warning recorded; a page over its per-page cap still fails', () => {
  // Thirteen pages of 1,000 words: 13,000 in total, every page inside its cap.
  const overTotal = budgetJudgement(Array.from({ length: 13 }, (_, index) => ({ page: `docs/page-${index}.md`, words: 1_000 })));
  assert.equal(overTotal.failed, null, 'a total over the budget is not a failure: the budget is never a merge gate');
  assert.match(overTotal.warning!, /^README\.md and docs\/ total 13000 words; the budget is 12000 \(largest: /, 'the warning records the total and is reported');
  assert.match(headroomJudgement([{ page: 'docs/a.md', words: PAGE_BUDGET - PAGE_HEADROOM + 1 }]).failed!, /^pages within 200 words of the 1200-word page budget \(over 1000\): docs\/a\.md \(1001 words\)$/, 'a page past its headroom fails');
  assert.equal(headroomJudgement([{ page: 'docs/a.md', words: PAGE_BUDGET - PAGE_HEADROOM }]).failed, null, 'a page at its headroom passes');
  const nearTotal = headroomJudgement(Array.from({ length: 12 }, (_, index) => ({ page: `docs/page-${index}.md`, words: 951 })));
  assert.equal(nearTotal.failed, null, 'a total past its headroom is not a failure');
  assert.match(nearTotal.warning!, /^README\.md and docs\/ total 11412 words, within 600 of the 12000-word budget \(over 11400\)$/, 'the total headroom only warns');
  const breach = budgetJudgement([{ page: 'README.md', words: PAGE_BUDGET + 1 }, { page: 'docs/a.md', words: 10 }]);
  assert.equal(breach.warning, null, 'a set within its total raises no warning');
  assert.match(breach.failed!, /^pages over the 1200-word page budget: README\.md \(1201 words\)$/, 'a page over its per-page cap still fails');
});

test('unit:docs-no-duplication — no two pages share a heading, a paragraph of 25+ words or a sentence of 10+ words, and every internal link and anchor resolves', () => {
  const owners = (extract: (text: string) => string[]) => {
    const seen = new Map<string, Set<string>>();
    for (const page of pages) for (const item of extract(read(page))) seen.set(item, (seen.get(item) ?? new Set()).add(page));
    return [...seen].filter(([, where]) => where.size > 1).map(([item, where]) => `"${item.slice(0, 80)}" on ${[...where].join(', ')}`);
  };
  assert.deepEqual(headings('# Overview\n## A `sync` heading\n```sh\n# not a heading\n```'), ['a sync heading'], 'code comments are not headings and generic headings are exempt');
  assert.equal(paragraphs(`${'word '.repeat(24)}\n\n${'long '.repeat(25)}`).length, 1, 'only paragraphs of 25 or more words are compared');
  const sharedHeadings = owners(headings);
  assert.deepEqual(sharedHeadings, [], `headings on more than one page: ${sharedHeadings.join('; ')}`);
  const sharedParagraphs = owners(paragraphs);
  assert.deepEqual(sharedParagraphs, [], `paragraphs repeated on more than one page: ${sharedParagraphs.join('; ')}`);
  assert.deepEqual(sentences('Low lands on its [required CI checks](x.md) and one approving review: then it merges.'), ['low lands on its required ci checks and one approving review:'], 'sentences split at a clause end and keep only 10+ words');
  const sharedSentences = owners(sentences);
  assert.deepEqual(sharedSentences, [], `sentences repeated on more than one page: ${sharedSentences.join('; ')}`);
  const check = spawnSync(process.execPath, ['scripts/check-docs.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /all relative links, anchors and generated indexes resolve/);
});
