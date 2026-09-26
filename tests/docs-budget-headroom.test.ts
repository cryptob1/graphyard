import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchStep, predictQueue, queueRef, runMergeBatches, tipVerdict } from '../src/merge-queue.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { docsHeadroomStatus, docsTrimActionKey, docsWordCountAt, fileDocsTrim, type ReportedAttention } from '../src/daemon/faults.js';
import { attributeDocsOverflow, docsBudgetProof, docsHeadroom, docsOverflowReason, docsTrimTitle, docsWordBudgetOf, documentationDrift, documentationPolicySchema, parseRepositoryConfig, type DocsWordCount, type TipDocs } from '../src/model/documentation.js';
import { evaluate, type Work } from '../src/model.js';
import { GitHub } from '../src/github.js';
import { writeDocumentationConfig } from '../src/repository-setup.js';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// GY-574: main sat at exactly its 12,000-word docs budget, so two queued items that each added a few
// words overflowed it together on a merge-queue tip and ejected the queue head. Headroom is now kept
// (attention plus one trim item), and an overflow is attributed to the entry that crossed the budget.
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

/** Three entries each adding 10 words to a page of its own, on a base at the budget minus 15. */
const base = pages(budget.total - 15);
const holding = (keys: string[]): DocsWordCount => ({ ...base, ...Object.fromEntries(keys.map(key => [`docs/${key}.md`, 10])) });
const total = (count: DocsWordCount) => Object.values(count).reduce((sum, words) => sum + words, 0);

test('unit:docs-budget-overflow-attributed — three entries adding 10 words each on a base at the budget minus 15: entry 2 is ejected naming the words over and the pages that grew, and entry 1 merges', async () => {
  const keys = ['GY-1', 'GY-2', 'GY-3'];
  // The attribution: the first entry at which the running total exceeds the budget.
  const overflow = attributeDocsOverflow(base, keys.map((key, index) => ({ key, count: holding(keys.slice(0, index + 1)) })), budget)!;
  assert.deepEqual({ member: overflow.member, total: overflow.total, over: overflow.over, grew: overflow.grew }, { member: 'GY-2', total: 12_005, over: 5, grew: [{ page: 'docs/GY-2.md', from: 0, to: 10 }] });
  assert.equal(attributeDocsOverflow(base, [{ key: 'GY-1', count: holding(['GY-1']) }, { key: 'GY-2', count: undefined }], budget), null, 'a missing count attributes nothing');

  // The batch plan: a tip failing only the docs budget ejects the attributed entry, not the head, without bisecting.
  const failsDocs = (landed: string[], prefix: string[]) => total(holding([...landed, ...prefix])) > budget.total ? { result: 'fail' as const, check: docsBudgetProof } : { result: 'pass' as const };
  const step = batchStep(keys, prefix => prefix.length === 3 ? failsDocs([], prefix) : undefined, { result: 'pass' }, { base, count: holding, budget });
  assert.equal(step.kind, 'eject');
  assert.equal((step as { member: string }).member, 'GY-2');
  assert.match((step as { reason: string }).reason, /unit:docs-word-budget failed: its docs change takes the budgeted documentation \(docs\/, README\.md\) to 12005 words, 5 over the 12000-word budget; pages that grew: docs\/GY-2\.md \(0 → 10\)/);
  const run = runMergeBatches(keys, 4, failsDocs, holding, budget);
  assert.deepEqual(run.ejected.map(entry => entry.member), ['GY-2', 'GY-3'], 'entry 2 crossed the budget; entry 3 still overflows on entry 1 alone and is attributed on its own tip');
  assert.match(run.ejected[0].reason!, /5 over the 12000-word budget; pages that grew: docs\/GY-2\.md/);
  assert.deepEqual(run.merged, ['GY-1'], 'entry 1 merges');
  assert.deepEqual(run.runs, [['GY-1', 'GY-2', 'GY-3'], ['GY-1', 'GY-3'], ['GY-1']], 'no bisection run is spent on the attributed overflow');
  // Without the counts the same failure is bisected as before, and the head is never the one ejected either way.
  assert.deepEqual(runMergeBatches(keys, 4, failsDocs).ejected.map(entry => entry.member), ['GY-2', 'GY-3']);

  // The live queue: the control plane's own gate evaluation over observed tips carrying their docs counts.
  const live = await driveQueue(keys);
  assert.deepEqual(live.ejected.map(entry => entry.key), ['GY-2'], 'only entry 2 is ejected from the live queue');
  assert.match(live.ejected[0].reason, /^Required CI check test did not pass on speculative tip [0-9a-f]{12}: unit:docs-word-budget failed: its docs change takes the budgeted documentation \(docs\/, README\.md\) to 12005 words, 5 over the 12000-word budget; pages that grew: docs\/GY-2\.md \(0 → 10\)$/);
  assert.equal(live.items.find(item => item.key === 'GY-1')!.queueEjection ?? null, null, 'the queue head is not ejected');
  assert.ok(live.items.find(item => item.key === 'GY-3')!.queue, 'entry 3 stays queued: its own tip is judged again once entry 2 has left');
  assert.equal(live.items.find(item => item.key === 'GY-1')!.observation!.docsBudget, undefined, 'a passing tip is not counted');
  assert.ok(live.requests.every(url => /\/git\/(trees|blobs)\//.test(url)), 'the counts are read from the tip and base trees');
  assert.ok(live.requests.filter(url => url.includes('/git/blobs/')).length <= 24, 'each page version, and the configuration, is read once, whatever tips hold it');
});

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
/** A live queue (as tests/queue-batching.test.ts drives it) in which CI runs on every published tip and reports its docs counts. */
async function driveQueue(keys: string[]) {
  const now = new Date('2026-09-26T09:00:00.000Z'), at = '2026-09-26T08:00:00.000Z', baseSha = sha40('b0');
  const holds = new Map<string, string[]>([[baseSha, []]]);
  let published = 0;
  const items: Work[] = keys.map((key, index) => {
    const candidate = { sha: sha40(`a${index + 1}`), baseSha, pr: 100 + index, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
    return { id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: [`docs/${key}.md`], criteria: [],
      policy: { checks: ['test'], review: false }, stage: 'merge', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
      workspaces: [], candidate, submission: { epoch: 1, pr: 100 + index }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [],
      observation: { clockOffset: { min: 0, max: 0 }, candidate, baseTip: baseSha, baseTree: sha40('e0'), checks: [], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: now.toISOString() },
      queue: { sequence: index + 1, enqueuedAt: at, policyRevision: 1, speculation: null }, queueSequence: index + 1 } as unknown as Work;
  });
  for (let moved = true; moved;) {
    moved = false;
    for (const placement of predictQueue(items, now.getTime())) {
      if (placement.current || !placement.publishable) continue;
      const item = items.find(entry => entry.id === placement.id)!, predicted = placement.predictedBase!;
      const tip = sha40(`c${++published}`), holding = [...holds.get(predicted)!, item.key];
      holds.set(tip, holding);
      item.candidate = { ...item.candidate!, sha: tip, baseSha: predicted };
      item.queue = { ...item.queue!, speculation: { ref: queueRef(item.key), tip, base: predicted, baseTree: sha40('e0'), tipTree: sha40(`e${holding.length}`), predecessors: placement.predecessors, policyRevision: 1, publishedAt: at, reviewedHead: sha40(`a${keys.indexOf(item.key) + 1}`) } };
      item.observation = { ...item.observation!, candidate: item.candidate!, checks: [] };
      moved = true;
      break;
    }
  }
  // CI on every published tip: the test check fails exactly when the tip's docs overflow. The docs
  // counts are what the GitHub observer records for a failing published tip, read from its trees.
  const { github, requests } = docsRepository(sha => holds.has(sha) ? holding(holds.get(sha)!) : null);
  for (const item of items) {
    const over = total(holding(holds.get(item.candidate!.sha)!)) > budget.total;
    const checks = [{ id: 1, name: 'test', status: 'completed', conclusion: over ? 'failure' : 'success', app: { id: 15368 } }, { id: 2, name: 'typecheck', status: 'completed', conclusion: 'success', app: { id: 15368 } }];
    const docsBudget = await github.tipDocs({ ...item, policy: { checks: ['test', 'typecheck'], review: false } } as Work, item.candidate!.sha, item.candidate!.baseSha, checks);
    item.observation = { ...item.observation!, checks: [{ name: 'test', result: over ? 'failure' : 'success', appId: 15368 }], ...(docsBudget ? { docsBudget } : {}) };
    if (over) assert.equal(docsBudget?.onlyFailure, true, 'the test check is the only required check that failed');
  }
  const ejected: { key: string; reason: string }[] = [];
  for (const item of [...items].reverse()) {
    Object.assign(item, evaluate(item, items, now, [15368], 4));
    if (!item.queue) ejected.push({ key: item.key, reason: item.queueEjection!.reason });
  }
  return { items, ejected, requests };
}

/** A GitHub adapter over a repository whose trees hold `count(sha)`'s pages, each page a blob of that many words. */
function docsRepository(count: (sha: string) => DocsWordCount | null) {
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 7, privateKey: 'not-used' });
  Object.assign(github as any, { token: 'installation-token', expires: Date.now() + 3600_000 });
  const blobs = new Map<string, number>(), requests: string[] = [], configSha = 'c'.repeat(40);
  const blobSha = (page: string, words: number) => { const sha = createHash('sha1').update(`${page}:${words}`).digest('hex'); blobs.set(sha, words); return sha; };
  const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchStub = (async (input: string) => {
    const url = String(input);
    requests.push(url);
    const tree = url.match(/\/git\/trees\/([0-9a-f]{40})\?recursive=1$/), blob = url.match(/\/git\/blobs\/([0-9a-f]{40})$/);
    if (tree && count(tree[1])) return respond({ truncated: false, tree: [{ path: 'src/index.ts', type: 'blob', sha: 'f'.repeat(40) }, { path: 'docs', type: 'tree', sha: 'e'.repeat(40) }, { path: 'graphyard.json', type: 'blob', sha: configSha },
      ...Object.entries(count(tree[1])!).map(([path, words]) => ({ path, type: 'blob', sha: blobSha(path, words) }))] });
    if (blob && blob[1] === configSha) return respond({ encoding: 'base64', content: Buffer.from(JSON.stringify(projectConfig)).toString('base64') });
    if (blob && blobs.has(blob[1])) return respond({ encoding: 'base64', content: Buffer.from(Array.from({ length: blobs.get(blob[1])! }, () => 'word').join(' \n')).toString('base64') });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  (github as any).request = async (path: string) => { const saved = globalThis.fetch; globalThis.fetch = fetchStub; try { return await (GitHub.prototype as any).request.call(github, path); } finally { globalThis.fetch = saved; } };
  return { github, requests };
}

/** A Git checkout whose main commit holds `files`, for counting the base branch as the loop does. */
function checkout(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'graphyard-docs-budget-'));
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
  const unbudgeted = checkout({ 'graphyard.json': JSON.stringify({ documentation: { paths: ['docs/', 'README.md'], changelog: null } }), 'README.md': prose(50_000), 'docs/a.md': prose(50_000) });
  const none = checkout({ 'README.md': prose(50_000) });
  t.after(() => { for (const root of [unbudgeted, none]) rmSync(root, { recursive: true, force: true }); });
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
  // No budget on the tip: an over-large docs set is an ordinary failure, bisected as before, never attributed.
  const unbudgetedTip = { sha: 'a'.repeat(40), base: {}, pages: { 'README.md': 100_000 }, onlyFailure: true } as unknown as TipDocs;
  assert.deepEqual(tipVerdict({ policy: { checks: ['test'] }, candidate: { sha: 'a'.repeat(40) }, queue: { speculation: { tip: 'a'.repeat(40) } },
    observation: { candidate: { sha: 'a'.repeat(40) }, checks: [{ name: 'test', result: 'failure', appId: 1 }], docsBudget: unbudgetedTip } } as unknown as Work), { result: 'fail', check: 'test' });
  assert.deepEqual(batchStep(['GY-1', 'GY-2'], prefix => prefix.length === 2 ? { result: 'fail', check: docsBudgetProof } : undefined, { result: 'pass' }, { base: {}, count: () => ({ 'README.md': 100_000 }), budget: undefined }),
    { kind: 'test', combination: ['GY-1'] }, 'without a configured budget nothing is attributed; the batch is bisected');

  // A project with its own budget: its own numbers, over its own paths (narrowed within its documentation paths).
  const budgeted = checkout({
    'graphyard.json': JSON.stringify({ documentation: { paths: ['guide/', 'README.md', 'AGENTS.md'], changelog: null, wordBudget: { total: 100, perPage: 60, paths: ['guide/', 'README.md'] } } }),
    'README.md': prose(40), 'guide/intro.md': prose(58), 'guide/diagram.png': prose(500), 'AGENTS.md': prose(5_000), 'docs/other.md': prose(5_000),
  });
  t.after(() => rmSync(budgeted, { recursive: true, force: true }));
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
  // The same project's overflow on a tip is attributed against its own total.
  const overflow = attributeDocsOverflow(counted.pages, [{ key: 'GY-1', count: { ...counted.pages, 'guide/new.md': 5 } }], counted.budget)!;
  assert.deepEqual({ member: overflow.member, over: overflow.over }, { member: 'GY-1', over: 3 });
  assert.match(docsOverflowReason(overflow), /takes the budgeted documentation \(guide\/, README\.md\) to 103 words, 3 over the 100-word budget; pages that grew: guide\/new\.md \(0 → 5\)/);
});
