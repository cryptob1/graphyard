import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { docsHeadroomStatus, docsTrimActionKey, docsWordCountAt, fileDocsTrim, type ReportedAttention } from '../src/daemon/faults.js';
import { docsBudgetProof, docsHeadroom, docsTrimTitle, docsWordBudgetOf, documentationDrift, documentationPolicySchema, parseRepositoryConfig, type DocsWordCount } from '../src/model/documentation.js';
import type { Work } from '../src/model.js';
import { writeDocumentationConfig } from '../src/repository-setup.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dirname, join } from 'node:path';

// GY-574: main sat at exactly its 12,000-word docs budget, so two queued items that each added a few
// words overflowed it together on a merge-queue tip and ejected the queue head. Headroom is now kept
// (attention plus one trim item).
// The budget is each project's own configuration (graphyard.json documentation.wordBudget), never a
// Graphyard rule: a project that configures none is not counted at all.

const pages = (total: number, count = 20): DocsWordCount => Object.fromEntries(Array.from({ length: count }, (_, index) =>
  [index === 0 ? 'README.md' : `docs/page-${index}.md`, Math.floor(total / count) + (index < total % count ? 1 : 0)]));
/** The project's configured budget, as its graphyard.json declares it (AC-3). */
const projectConfig = { documentation: { paths: ['docs/', 'README.md'], changelog: null, wordBudget: { total: 12_000, perPage: 1_200 } } };
const budget = docsWordBudgetOf(projectConfig.documentation)!;
const counted = (pages: DocsWordCount) => ({ budget, pages });
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

test('unit:docs-headroom-kept — at 11,700 of 12,000 words master status raises attention and the loop files exactly one docs-trim item naming the largest pages', async () => {
  const main = { ...pages(11_000), 'docs/master-agent.md': 700 };
  const status = await docsHeadroomStatus('/repository', 'main', (_, ref) => ref === 'origin/main' ? counted(main) : null);
  assert.equal(status.docs!.headroom.total, 11_700);
  assert.equal(status.docs!.base, 'origin/main', 'the base branch as fetched is what is counted');
  assert.equal(status.attention.length, 1, 'within 3% of the budget raises one attention item');
  assert.equal(status.attention[0].subject, 'docs');
  assert.equal(status.attention[0].role, 'master');
  assert.match(status.attention[0].text, /11700 of its 12000-word budget \(300 left, within 3% of it\).*Trim to 11400 or fewer; largest pages: docs\/master-agent\.md \(700\)/);

  const filed: { input: any; key: string }[] = [], work: Work[] = [];
  const effects = { persist: async () => {}, fileFaultClass: async (input: any, key: string) => {
    filed.push({ input, key });
    return { id: 'work-trim', key: 'GY-900', title: input.title, stage: 'backlog' } as unknown as Work;
  } };
  const state = emptyDaemonState(config()), docs: ReportedAttention['docs'] = status.docs;
  for (let cycle = 0; cycle < 3; cycle++) await fileDocsTrim(state, effects, work, docs, () => Date.parse('2026-09-26T10:00:00Z'), []);
  assert.equal(filed.length, 1, 'filed once: while the trim item is open nothing more is filed');
  const item = filed[0].input;
  assert.ok(item.title.startsWith(docsTrimTitle), item.title);
  assert.match(item.description, /Start with the largest pages: docs\/master-agent\.md \(700\)/);
  assert.match(item.description, /do not remove any documented behaviour/);
  assert.equal(item.criteria.length, 1);
  assert.match(item.criteria[0].text, /at most 11400 words \(at least 5% under the 12000-word budget\)/);
  assert.match(item.criteria[0].text, /every behaviour, command, configuration and API documented before the change is still documented after it/);
  assert.deepEqual(item.criteria[0].proofs, [docsBudgetProof]);
  assert.equal(state.actions[docsTrimActionKey].work, 'GY-900');
  // A fresh loop (the action history lost) still files nothing while the open item stands.
  await fileDocsTrim(emptyDaemonState(config()), effects, work, docs, () => Date.now(), []);
  assert.equal(filed.length, 1, 'the open item, not the loop cursor, is what keeps it to one');

  // The filed item closes (or merges) while the set stays saturated: the episode the filing opened
  // on the loop cursor, not the open item, is what keeps it to one filing (review finding 1 on 2639e4d6).
  work.length = 0;
  for (let cycle = 0; cycle < 3; cycle++) await fileDocsTrim(state, effects, work, docs, () => Date.parse('2026-09-26T11:00:00Z'), []);
  assert.equal(filed.length, 1, 'a closed trim item files nothing more while the set stays saturated');
  assert.match(state.actions[docsTrimActionKey].detail, /^Filed GY-900 .*nothing more is filed until headroom is restored$/, 'the filing stands as an open episode on the loop cursor');
  // A total that drifts within the same saturation is still that episode.
  const drifted = await docsHeadroomStatus('/repository', 'main', () => counted({ ...main, 'docs/master-agent.md': 750 }));
  assert.equal(drifted.docs!.headroom.total, 11_750);
  await fileDocsTrim(state, effects, work, drifted.docs, () => Date.now(), []);
  assert.equal(filed.length, 1, 'a drifting total files nothing more until headroom is restored');
  // The first counted set with its headroom closes the episode, so a later saturation files once more.
  const restored = await docsHeadroomStatus('/repository', 'main', () => counted(pages(11_000)));
  await fileDocsTrim(state, effects, work, restored.docs, () => Date.now(), []);
  assert.match(state.actions[docsTrimActionKey].detail, /^Documentation headroom restored on origin\/main/, 'a set with its headroom closes the episode');
  await fileDocsTrim(state, effects, work, docs, () => Date.now(), []);
  assert.equal(filed.length, 2, 'a saturation after restored headroom files once more');
  assert.match(state.actions[docsTrimActionKey].detail, /^Filed GY-900 /, 'the new episode stands on the loop cursor');

  // A set with its headroom raises nothing and files nothing.
  const roomy = await docsHeadroomStatus('/repository', 'main', () => counted(pages(11_400)));
  assert.deepEqual(roomy.attention, []);
  assert.equal(roomy.docs!.headroom.saturated, false);
  const filings = filed.length;
  await fileDocsTrim(emptyDaemonState(config()), effects, [], roomy.docs, () => Date.now(), []);
  assert.equal(filed.length, filings, 'a set with its headroom files nothing');
  assert.equal(docsHeadroom(pages(11_640), budget).saturated, true, 'the warning starts at 97% of the budget');
  assert.equal(docsHeadroom(pages(11_639), budget).saturated, false);
});

/** A Git checkout whose main commit holds `files`, for counting the base branch as the loop does. */
async function checkout(files: Record<string, string>) {
  const root = await temporaryDirectory('docs-budget');
  const git = (...args: string[]) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-q', '-b', 'main');
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
  return root;
}
const prose = (count: number) => Array.from({ length: count }, (_, index) => `w${index}`).join(' ');

test('unit:docs-budget-per-project — a project with no wordBudget is never checked or filed against; a project with one is checked against its own paths and numbers', async t => {
  // Graphyard's own budget is its repository's configuration, and tests/docs-budget.test.ts reads it from there.
  const own = parseRepositoryConfig(readFileSync(new URL('../graphyard.json', import.meta.url), 'utf8')).documentation.wordBudget;
  assert.ok(own && own.total > 0 && own.perPage > 0, 'graphyard.json configures Graphyard\'s own word budget');
  assert.match(readFileSync(new URL('./docs-budget.test.ts', import.meta.url), 'utf8'), /parseRepositoryConfig\(read\('graphyard\.json'\)\)\.documentation/, 'the docs budget test reads its numbers from graphyard.json');
  assert.throws(() => documentationPolicySchema.parse({ paths: ['docs/'], wordBudget: { total: 0, perPage: 10 } }), 'a budget is a positive word count');
  assert.equal(documentationDrift({ paths: ['docs/'], changelog: null, wordBudget: { total: 10, perPage: 5 } }, { paths: ['docs/'], changelog: null }), null, 'the budget is read from the committed file, so a deployment without it is no drift');

  // No wordBudget: nothing is counted, no attention is raised and no trim item is filed — however large the docs.
  const unbudgeted = await checkout({ 'graphyard.json': JSON.stringify({ documentation: { paths: ['docs/', 'README.md'], changelog: null } }), 'README.md': prose(50_000), 'docs/a.md': prose(50_000) });
  const none = await checkout({ 'README.md': prose(50_000) });
  for (const root of [unbudgeted, none]) {
    assert.equal(await docsWordCountAt(root, 'main'), null, 'a project that configures no budget is not counted');
    const status = await docsHeadroomStatus(root, 'main');
    assert.deepEqual(status, { docs: null, attention: [] }, 'headroom is not monitored');
    const filed: unknown[] = [];
    const state = emptyDaemonState(config());
    await fileDocsTrim(state, { persist: async () => {}, fileFaultClass: async input => { filed.push(input); return {} as Work; } }, [], status.docs, () => Date.now(), []);
    assert.deepEqual(filed, [], 'no trim item is filed');
    assert.equal(state.actions[docsTrimActionKey], undefined);
  }
  // A project with its own budget: its own numbers, over its own paths (narrowed within its documentation paths).
  const budgeted = await checkout({
    'graphyard.json': JSON.stringify({ documentation: { paths: ['guide/', 'README.md', 'AGENTS.md'], changelog: null, wordBudget: { total: 100, perPage: 60, paths: ['guide/', 'README.md'] } } }),
    'README.md': prose(40), 'guide/intro.md': prose(58), 'guide/diagram.png': prose(500), 'AGENTS.md': prose(5_000), 'docs/other.md': prose(5_000),
  });
  assert.equal((await writeDocumentationConfig(budgeted, { paths: ['guide/', 'README.md', 'AGENTS.md'], changelog: null })).state, 'unchanged', 'a scan proposes no budget, so a committed one is not drift from it');
  const counted = (await docsWordCountAt(budgeted, 'main'))!;
  assert.deepEqual(counted.pages, { 'README.md': 40, 'guide/intro.md': 58 }, 'only Markdown pages inside the budgeted documentation paths are counted');
  assert.deepEqual({ total: counted.budget.total, perPage: counted.budget.perPage, paths: counted.budget.paths }, { total: 100, perPage: 60, paths: ['guide/', 'README.md'] });
  const status = await docsHeadroomStatus(budgeted, 'main');
  assert.equal(status.docs!.headroom.total, 98);
  assert.equal(status.attention.length, 1, '98 of a 100-word budget is within 3% of it');
  assert.match(status.attention[0].text, /^The documentation \(guide\/, README\.md\) on main is 98 of its 100-word budget \(2 left, within 3% of it\).*Trim to 95 or fewer/);
  const filed: any[] = [];
  await fileDocsTrim(emptyDaemonState(config()), { persist: async () => {}, fileFaultClass: async input => { filed.push(input); return { key: 'GY-901', title: input.title, stage: 'backlog' } as unknown as Work; } }, [], status.docs, () => Date.now(), []);
  assert.equal(filed.length, 1, 'the trim item is filed against the project\'s own budget');
  assert.match(filed[0].criteria[0].text, /^The budgeted documentation \(guide\/, README\.md\) totals at most 95 words \(at least 5% under the 100-word budget\)/);
});
