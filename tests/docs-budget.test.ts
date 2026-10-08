import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { budgetedPage, docsBudgetJudgement, docsPageHeadroom, docsWordBudgetOf, parseRepositoryConfig, type DocsBudgetBase, type DocsWordCount } from '../src/model/documentation.js';

/**
 * The documentation is a short set an operator or agent can actually read: a word budget for the
 * whole set and for each page, and every topic on exactly one page. A page that grows past its
 * budget, or a section copied onto a second page instead of linked, fails here by name.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
// Graphyard's own documentation budget is this repository's configuration, not a product rule for
// managed projects (GY-574): graphyard.json's documentation.wordBudget sets the total, the per-page
// cap and the pages counted, exactly as the control plane reads any project's. It is 16,000 words,
// per page 1,200 (GY-1453 raised the total from 12,000 so the set sits at least 5% under it). A
// page over its cap fails here. The total was never a merge gate, so main re-saturated within
// hours of every trim (GY-1515): a total within 3% of the budget now fails any change that adds a
// word to it (docsBudgetJudgement), while a change that adds none, the base branch itself, or a
// change whose base cannot be counted passes with the warning, and the loop's trim item restores the room.
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

/** Graphyard's own configured budget (GY-1453), which docs/development.md states. */
const CONFIGURED_BUDGET = { total: 16_000, perPage: 1_200, paths: ['README.md', 'docs/'] };
/** The budget the judgement tests below exercise on fixtures, independent of the configured one. */
const FIXTURE_BUDGET = { total: 12_000, perPage: 1_200, paths: ['README.md', 'docs/'] };
const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
/**
 * The change's base, counted from Git as the checkout allows (GY-1515): CI checks a pull request
 * out as its merge onto the base, whose first parent is the base; a push to the base branch is the
 * base itself, where nothing can be refused; a local branch is judged against its merge-base with
 * origin's copy of the base, and uncommitted edits count as the change. Null when nothing resolves.
 */
function baseCount(): DocsBudgetBase {
  if (process.env.GITHUB_ACTIONS && !process.env.GITHUB_BASE_REF) return 'base-branch';
  const ref = process.env.GITHUB_BASE_REF ? 'HEAD^1' : git('merge-base', 'HEAD', 'origin/main').stdout.trim();
  if (!ref || git('rev-parse', '--verify', '--quiet', `${ref}^{tree}`).status !== 0) return null;
  const count: DocsWordCount = {};
  for (const page of git('ls-tree', '-r', '--name-only', ref).stdout.split('\n').filter(page => budgetedPage(page, budget))) count[page] = words(git('show', `${ref}:${page}`).stdout);
  return count;
}
/** Facts a criterion requires a budgeted page to state, so trimming for the budget cannot drop them. */
const REQUIRED_STATEMENTS: [string, RegExp][] = [
  ['docs/master-agent-reference.md', /decisions step stays within 10 s a cycle/],
  ['docs/master-agent-reference.md', /history whose ledger has not moved is kept, not read/],
  // GY-1518: the delivery redesign page keeps the merger setting's two values and the one rule.
  ['docs/delivery-redesign.md', /`github` \(default\) or `control-plane`/],
  ['docs/delivery-redesign.md', /Only Graphyard writes to main/],
  // GY-1536 AC-4: the general E2E step kinds, declared secrets and the env file, with one example of each kind.
  ['docs/validation.md', /`command`: `run` in the checkout with `TARGET_URL`.*`{"kind":"command","run":"npx playwright test"}`/],
  ['docs/validation.md', /`agent`: agent-browser pursues `goal` at `path` until `success` holds, ending `VERDICT: PASS\|FAIL - reason`.*"goal":"Win tic-tac-toe"/],
  ['docs/validation.md', /`secrets: \["NAME"\]` from `~\/\.config\/graphyard\/INSTALL\/e2e-secrets\.TARGET\.env` \(0600, uncommitted\) as variables and `\{\{secret:NAME\}\}`, redacted/],
  // GY-1526 AC-6: the loop-driven cut and the related-item revert of control-plane mode.
  ['docs/delivery.md', /Under a `control-plane` merger the loop cuts \(`run\.candidates\.everyMerges` 10, `idleMinutes` 15\), validates, promotes and verifies .*no workflow.*a failed required E2E case reverts the newest candidate item a matching verification map covers \(`candidateReverts`; reopened\); a main-watch freeze holds all/],
  // GY-1555 AC-6: setup-from-zero's control-plane merger subsection; steps 5 and 7 fold into step 4, where doctor's fixes point.
  ['docs/setup-from-zero.md', /### Control-plane merger\n\n`up --merger control-plane` creates an ed25519 deploy key, registers it read-write on OWNER\/REPO .*no App, no branch protection/],
  ['docs/setup-from-zero.md', /## 4\. Register the GitHub App\n\n.*Reviewer and revert-approver Apps: .*Branch protection: /],
  // GY-1523 AC-8: the head form of submit, its CLI and the change number it allocates.
  ['docs/protocol/work-commands.md', /`\{"epoch":1,"head":SHA\}` \(`complete GY-N EPOCH --head \[SHA\]`.*allocates one change number per head into `candidate\.pr`\/`submission\.pr`/],
  // GY-1529 AC-5: the Coordinator recovery section names its symptoms, the recover command and how promotion resumes.
  ['docs/recovery.md', /## Coordinator recovery\n\nSelf-merge stalled the loop, or main-watch froze: `graphyard master recover \[--to SHA\] --admin-token-stdin` repins, restarts; verified promotions repin\./],
];

test('unit:docs-word-budget — the pages graphyard.json budgets (README.md and every docs page) keep every page within its per-page budget and 200 words under it, counted as wc -w counts them; a total within 3% of the budget fails a change that adds to it and warns otherwise', () => {
  assert.ok(budget, 'graphyard.json configures documentation.wordBudget');
  assert.deepEqual({ total: budget.total, perPage: budget.perPage, paths: budget.paths }, CONFIGURED_BUDGET, 'graphyard.json budgets 16,000 words, 1,200 per page, over README.md and docs/');
  assert.match(read('docs/development.md'), /`wordBudget` \(16,000 words, 1,200 per page;/, 'docs/development.md states the configured budget');
  // Verification maps (GY-1495) carry their own 250-word cap (tests/verification-maps.test.ts), never the docs budget.
  for (const map of readdirSync(`${root}verification`).filter(name => name.endsWith('.md'))) assert.ok(!budgetedPage(`verification/${map}`, budget), `verification/${map} is outside the docs budget`);
  assert.equal(words('one  two\tthree\n\nfour — `five six` [seven](eight.md)'), 8, 'words are whitespace-separated runs, as wc -w counts them');
  const wc = spawnSync('wc', ['-w', 'README.md'], { cwd: root, encoding: 'utf8' });
  if (wc.status === 0) assert.equal(Number(wc.stdout.trim().split(/\s+/)[0]), words(read('README.md')), 'the count agrees with wc -w');
  const counts = pages.map(page => ({ page, words: words(read(page)) }));
  assert.ok(counts.length > 0 && counts.some(entry => entry.page === 'docs/README.md'), 'the generated index is counted');
  const judgement = docsBudgetJudgement(Object.fromEntries(counts.map(entry => [entry.page, entry.words])), budget, baseCount());
  assert.equal(judgement.failed, null, `a page over its budget or past its headroom, or a saturated total this change adds to, fails here: ${judgement.failed}`);
  if (judgement.warning) console.warn(`unit:docs-word-budget: ${judgement.warning}`);
  const largest = counts.reduce((top, entry) => entry.words > top.words ? entry : top);
  console.log(`unit:docs-word-budget: ${counts.length} pages, ${counts.reduce((sum, entry) => sum + entry.words, 0)} words in total; largest ${largest.page} (${largest.words})`);
  // Statements a criterion requires the budgeted pages to keep (GY-1142 AC-2): the budget holds
  // with them in, and a trim that drops one fails here instead of passing silently.
  for (const [page, statement] of REQUIRED_STATEMENTS) assert.match(read(page), statement, `${page} states ${statement}`);
  const coordinatorRecovery = read('docs/recovery.md').split(/^## Coordinator recovery$/m)[1]?.split(/\n## /)[0] ?? '';
  assert.ok(coordinatorRecovery && words(coordinatorRecovery) <= 120, `docs/recovery.md's Coordinator recovery section is at most 120 words: ${words(coordinatorRecovery)}`);
});

test('unit:docs-budget-growth-gate — a saturated total fails a change that adds to it and passes with the warning one that adds none, the base branch itself or an uncounted base; a page over its cap or past its headroom still fails', () => {
  const set = (total: number, count = 20) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`docs/page-${index}.md`, Math.floor(total / count) + (index < total % count ? 1 : 0)]));
  // Twenty pages of 585 words: 11,700 in total, within 3% of 12,000 (the band starts at 11,640), every page inside its cap.
  const grown = docsBudgetJudgement(set(11_700), FIXTURE_BUDGET, set(11_650));
  assert.match(grown.failed!, /^The budgeted documentation \(README\.md, docs\/\) totals 11700 words, within 3% of its 12000-word budget \(over 11640\), and this change adds 50 to it: a saturated set may not grow, so trim it to 11400 or fewer; largest pages: /, 'growth of a saturated set fails');
  assert.equal(grown.warning, null);
  const flat = docsBudgetJudgement(set(11_700), FIXTURE_BUDGET, set(11_700));
  assert.equal(flat.failed, null, 'a change that adds none to a saturated set is not refused');
  assert.match(flat.warning!, /^The budgeted documentation \(README\.md, docs\/\) totals 11700 words, within 3% of its 12000-word budget \(over 11640\); this change adds none, so it passes, and the loop's trim item restores the headroom: trim it to 11400 or fewer/);
  assert.match(docsBudgetJudgement(set(11_700), FIXTURE_BUDGET, set(11_750)).warning!, /this change adds -50, so it passes/, 'a trim that leaves the set saturated passes');
  assert.match(docsBudgetJudgement(set(11_700), FIXTURE_BUDGET, 'base-branch').warning!, /this is the base branch, where nothing can be refused, so it passes/, 'the base branch only warns: a tip that overran the band must not fail it');
  assert.match(docsBudgetJudgement(set(11_700), FIXTURE_BUDGET, null).warning!, /its base could not be counted, so the growth this change brings is not judged, so it passes/);
  assert.match(docsBudgetJudgement(set(12_100), FIXTURE_BUDGET, set(12_090)).failed!, /^The budgeted documentation \(README\.md, docs\/\) totals 12100 words, over its 12000-word budget by 100, and this change adds 10 to it: a saturated set may not grow/, 'over the budget the same rule holds');
  assert.deepEqual(docsBudgetJudgement(set(11_639), FIXTURE_BUDGET, set(11_000)).failed, null, 'growth that leaves the set under the band passes without a warning');
  assert.equal(docsBudgetJudgement(set(11_639), FIXTURE_BUDGET, set(11_000)).warning, null);
  // The per-page cap and its headroom fail by name whatever the total and the base.
  const breach = docsBudgetJudgement({ 'README.md': PAGE_BUDGET + 1, 'docs/a.md': 10 }, FIXTURE_BUDGET, 'base-branch');
  assert.equal(breach.warning, null, 'a set within its total raises no warning');
  assert.match(breach.failed!, /^pages over the 1200-word page budget: README\.md \(1201\)$/, 'a page over its per-page cap still fails');
  assert.match(docsBudgetJudgement({ 'docs/a.md': PAGE_BUDGET - docsPageHeadroom + 1 }, FIXTURE_BUDGET, 'base-branch').failed!, /^pages within 200 words of the 1200-word page budget \(over 1000\): docs\/a\.md \(1001\)$/, 'a page past its headroom fails');
  assert.equal(docsBudgetJudgement({ 'docs/a.md': PAGE_BUDGET - docsPageHeadroom }, FIXTURE_BUDGET, 'base-branch').failed, null, 'a page at its headroom passes');
  // This checkout's own base is counted from Git, as the gate above reads it.
  const base = baseCount();
  if (base !== null && base !== 'base-branch') assert.ok(Object.keys(base).some(page => page === 'README.md'), 'the base count includes README.md');
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
