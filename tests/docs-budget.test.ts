import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The documentation is a short set an operator or agent can actually read: a word budget for the
 * whole set and for each page, and every topic on exactly one page. A page that grows past its
 * budget, or a section copied onto a second page instead of linked, fails here by name.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
const pages = ['README.md', ...readdirSync(`${root}docs`, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
  .map(entry => `${entry.parentPath.slice(root.length)}/${entry.name}`)].sort();

// Graphyard's own documentation budget (this repository's rule, not a product rule for managed
// projects; GY-574 moves it into graphyard.json). Raised from 12,000 on 2026-09-26: at exactly
// 12,000 every queued change that documented itself overflowed on its merge-queue tip and was
// ejected. The per-page budget is unchanged, so no page grows past 1,200 words.
const TOTAL_BUDGET = 13_000, PAGE_BUDGET = 1_200;
/** Words as `wc -w` counts them: maximal runs of non-whitespace, markup and code included. */
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Headings that name a kind of section rather than a topic, so two pages may share them. */
const GENERIC_HEADINGS = new Set(['overview', 'related', 'see also']);
const DUPLICATE_PARAGRAPH_WORDS = 25;

const normalize = (text: string) => text.toLowerCase().replace(/<!--[\s\S]*?-->/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_>#|-]/g, ' ').replace(/\s+/g, ' ').trim();

/** Prose blocks outside code fences, and each of their lines, as a reader would quote them. */
function paragraphs(text: string) {
  const prose = text.replace(/```[\s\S]*?```/g, '\n\n');
  const blocks = prose.split(/\n\s*\n/).map(block => block.trim()).filter(block => block && !block.startsWith('#'));
  return [...new Set([...blocks, ...blocks.flatMap(block => block.split('\n'))].map(normalize))].filter(block => words(block) >= DUPLICATE_PARAGRAPH_WORDS);
}

function headings(text: string) {
  return [...text.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => normalize(match[1])).filter(heading => !GENERIC_HEADINGS.has(heading));
}

test('unit:docs-word-budget — README.md plus every docs page total at most 13,000 words and no page exceeds 1,200, counted as wc -w counts them', () => {
  assert.equal(words('one  two\tthree\n\nfour — `five six` [seven](eight.md)'), 8, 'words are whitespace-separated runs, as wc -w counts them');
  const wc = spawnSync('wc', ['-w', 'README.md'], { cwd: root, encoding: 'utf8' });
  if (wc.status === 0) assert.equal(Number(wc.stdout.trim().split(/\s+/)[0]), words(read('README.md')), 'the count agrees with wc -w');
  const counts = pages.map(page => ({ page, words: words(read(page)) }));
  assert.ok(counts.length > 0 && counts.some(entry => entry.page === 'docs/README.md'), 'the generated index is counted');
  const over = counts.filter(entry => entry.words > PAGE_BUDGET).map(entry => `${entry.page} (${entry.words} words)`);
  assert.deepEqual(over, [], `pages over the ${PAGE_BUDGET}-word page budget: ${over.join(', ')}`);
  const total = counts.reduce((sum, entry) => sum + entry.words, 0);
  const largest = [...counts].sort((a, b) => b.words - a.words).slice(0, 5).map(entry => `${entry.page} ${entry.words}`).join(', ');
  assert.ok(total <= TOTAL_BUDGET, `README.md and docs/ total ${total} words; the budget is ${TOTAL_BUDGET} (largest: ${largest})`);
});

test('unit:docs-no-duplication — no two pages share a heading or a paragraph of 25+ words, and every internal link and anchor resolves', () => {
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
  const check = spawnSync(process.execPath, ['scripts/check-docs.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /all relative links, anchors and generated indexes resolve/);
});
