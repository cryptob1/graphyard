import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { budgetedPage, docsWordBudgetOf, parseRepositoryConfig } from '../src/model/documentation.js';

/**
 * GY-1518: docs/delivery-redesign.md states the decided control-plane merge model — the one rule,
 * the four flow steps, what is removed and kept, the `merger` setting, the rollout and the weekly
 * measures — inside 1,000 words; docs/README.md lists it under Operate Graphyard; and the budgeted
 * set stays at or under 15,600 words after docs/delivery.md and docs/github.md hand their
 * superseded github-mode prose to links, with every command and route they named still named.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
/** Words as `wc -w` counts them, exactly as tests/docs-budget.test.ts counts the set. */
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
/** The page under test, read inside each case so a missing page fails the case rather than the module. */
const redesign = () => {
  assert.ok(existsSync(`${root}docs/delivery-redesign.md`), 'docs/delivery-redesign.md exists');
  return read('docs/delivery-redesign.md');
};
/** The body of a `## heading` section: from its heading line to the next heading of any level or the end. */
const section = (text: string, heading: string, level = '##') => {
  const match = text.match(new RegExp(`^${level} ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,6} |(?![\\s\\S]))`, 'm'));
  assert.ok(match, `a "${level} ${heading}" section exists`);
  return match[1];
};
const sentences = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim().split(/(?<=[.!?])\s+/).filter(Boolean);

/** What AC-1 requires the page to state, each as a phrase a reader can find. */
const STATEMENTS: [string, RegExp][] = [
  ['the one rule', /Only Graphyard writes to main/],
  ['step 1: head submission under a lease', /^1\. .*[Hh]ead submission under a lease.*`complete GY-N EPOCH --head SHA`.*lease ends in the same transaction/m],
  ['step 2: a serial merge writer trial-merges and runs build and fast tests on the merged tree', /^2\. .*serial merge writer.*trial-merges.*build and fast tests on the merged tree/m],
  ['step 2: intent is recorded before a deploy-key push leased on the tested tip', /^2\. .*records merge intent, then pushes the exact tested merge commit with the install's deploy key, leased on the tested tip/m],
  ['step 3: candidates every ~10 merges or 15 quiet minutes', /^3\. .*every ~10 merges or 15 quiet minutes/m],
  ['step 3: the exact tested commit is promoted', /^3\. .*exact tested commit is promoted/m],
  ['step 3: related-item revert on E2E failure', /^3\. .*On E2E failure.*newest item related to the failing cases.*reverted/m],
  ['step 4: one independent reviewer per item, blocking only for sensitive diffs', /^4\. .*One independent reviewer per item.*Sensitive diffs.*blocking review before step 2; the rest a non-blocking review after merge/m],
  ['the removed list', /^Removed: GitHub Apps, branch protection, required checks/m],
  ['the kept list', /^Kept: leases and epochs, the transactional ledger/m],
  ['the merger setting and its two values', /`merger` selects the mode per install, `github` \(default\) or `control-plane`/],
  ['the setting is an admin-only ledger event never read from graphyard.json', /admin-only ledger event, never read from graphyard\.json/],
  ['the shadow-mode switch criterion', /Switch criterion: two weeks with no shadow-passed head reverted by the main guard and every shadow-only failure explained/],
  ['the three weekly measures', /Weekly: defects reaching production \(escapes\), merge-queue wait, human touches/],
  ['the deferred controls', /Deferred until one demands it: pre-merge review for medium risk, batched merge validation, a per-test flake ledger/],
];

test('unit:delivery-redesign-doc-statements — docs/delivery-redesign.md opens with its page line, stays within 1,000 words, and states the one rule, the four flow steps, the removed and kept lists, the merger setting, the four rollout stages with the shadow switch criterion, and the weekly measures', () => {
  const page = redesign();
  assert.ok(page.startsWith('<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->\n'), 'the page opens with its index declaration');
  assert.ok(words(page) <= 1_000, `the page is within 1,000 words (${words(page)})`);
  for (const [topic, pattern] of STATEMENTS) assert.match(page, pattern, `the page states ${topic}`);
  const flow = section(page, 'Flow').split('\n').filter(line => /^\d+\. /.test(line));
  assert.equal(flow.length, 4, 'the flow is exactly four numbered steps');
  const rollout = section(page, 'Rollout').split('\n').filter(line => /^\d+\. /.test(line));
  assert.equal(rollout.length, 4, 'the rollout is exactly four numbered stages');
  assert.match(rollout[0], /Shadow mode/); assert.match(rollout[1], /`control-plane`/); assert.match(rollout[2], /Snake pilot/); assert.match(rollout[3], /delete the github-mode gate code/);
  for (const heading of ['One rule', 'Flow', 'Merge writer', 'Removed and kept', 'The merger setting', 'Rollout', 'Measures']) section(page, heading);
});

test('unit:delivery-redesign-doc-indexed — docs/README.md lists the page under Operate Graphyard, scripts/check-docs.mjs accepts the set, and tests/docs-budget.test.ts requires the setting\'s two values and the one rule of the page', () => {
  const page = redesign();
  const index = read('docs/README.md');
  const operate = section(index, 'Operate Graphyard');
  assert.match(operate, /^- \[Delivery redesign\]\(delivery-redesign\.md\) — merge writer, rollout\.$/m, 'the generated index lists the page by its title and summary');
  const check = spawnSync(process.execPath, ['scripts/check-docs.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const budgetTest = read('tests/docs-budget.test.ts');
  const required = budgetTest.slice(budgetTest.indexOf('const REQUIRED_STATEMENTS'), budgetTest.indexOf('];', budgetTest.indexOf('const REQUIRED_STATEMENTS')));
  const entries = [...required.matchAll(/\['docs\/delivery-redesign\.md', \/(.+?)\/\]/g)].map(match => match[1]);
  assert.equal(entries.length, 2, `REQUIRED_STATEMENTS holds two entries for the page: ${entries.join(' | ')}`);
  for (const source of entries) assert.match(page, new RegExp(source), `the page states the required statement ${source}`);
  assert.ok(entries.some(source => /github.*control-plane/.test(source)), 'one entry pins the setting\'s two values');
  assert.ok(entries.some(source => /Only Graphyard writes to main/.test(source)), 'one entry pins the one rule');
});

/** Every CLI command name and HTTP route docs/delivery.md and docs/github.md named before the trim (AC-3). */
const NAMED_BEFORE_TRIM = [
  '`release cut', '`release uat', '`release validate', '`release promote', '`release verify', '`release follow-up', '`release soak', '`release status', '`release GY-N EPOCH`',
  'graphyard master config promoteEveryMinutes', '`init --scan`', '`install --plan`', '`graphyard delivery sweep`', '`graphyard delivery`', '`graphyard doctor`', '`graphyard release`',
  '`master tip-cleanup --apply`', '`graphyard app import', '`graphyard app list`', '`sync GY-N --push-via-control-plane', '`master protection --apply`', '`master browser protection`',
  '`master browser app-permissions`', '`master browser installation-accept`', '`master reviewer setup`', '`github-setup --update-permissions', 'github-setup URL --reviewer claude', '`graphyard reviewpolicy',
  '`POST /api/delivery/lease`', '`POST /api/delivery/build`', '`POST /api/delivery/release`', '`POST /api/delivery/approve`', '`POST /api/delivery/observe`', '`POST /api/delivery/notify`',
  '`POST /api/validation/result`', '`GET /api/analytics/attribution`', '`POST /api/work/:id/sync-push`',
];
const TOTAL_TARGET = 15_600;

test('unit:delivery-redesign-doc-total-under-headroom — README.md and docs/ total at most 15,600 words as tests/docs-budget.test.ts counts them; delivery.md\'s One delivery path is two sentences linking the redesign, github.md\'s Failed checks and Bindings and carry are links, and every command and route those pages named is still named on a budgeted page', () => {
  const budget = docsWordBudgetOf(parseRepositoryConfig(read('graphyard.json')).documentation)!;
  const pages = ['README.md', 'AGENTS.md', ...readdirSync(`${root}docs`, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => `${entry.parentPath.slice(root.length)}/${entry.name}`)].filter(name => budgetedPage(name, budget)).sort();
  assert.ok(pages.includes('docs/delivery-redesign.md') && pages.includes('docs/README.md'), 'the new page and the index are counted');
  const total = pages.reduce((sum, name) => sum + words(read(name)), 0);
  assert.ok(total <= TOTAL_TARGET, `README.md and docs/ total ${total} words; the target is ${TOTAL_TARGET}`);

  const delivery = read('docs/delivery.md');
  const onePath = sentences(section(delivery, 'One delivery path', '###'));
  assert.equal(onePath.length, 2, `One delivery path is two sentences: ${onePath.join(' | ')}`);
  assert.match(section(delivery, 'One delivery path', '###'), /\]\(delivery-redesign\.md\)/, 'and links the redesign page');

  const github = read('docs/github.md');
  for (const heading of ['Failed checks', 'Bindings and carry']) {
    const body = section(github, heading, heading === 'Failed checks' ? '##' : '###').trim();
    const withoutLinks = body.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/`[^`]*`/g, '');
    assert.ok(words(withoutLinks) <= 12, `${heading} is links, not prose (${words(withoutLinks)} words outside links and code: ${withoutLinks.trim()})`);
    assert.ok((body.match(/\]\(/g) ?? []).length >= 2, `${heading} links where the detail now lives`);
  }
  const everything = pages.map(read).join('\n');
  for (const name of NAMED_BEFORE_TRIM) assert.ok(everything.includes(name), `${name} is still named on a budgeted page`);
});
