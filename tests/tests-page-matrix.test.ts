import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { bootstrapGate, gateRecordPath, writeGateRecord } from '../src/batch-gate.js';
import type { Principal, Work } from '../src/model.js';
import { MatrixView, TestsView, type MatrixFilter } from '../web/pages/tests.js';

// GY-3278 AC-3: the Tests page's default view is the environment matrix — every E2E case, grouped
// by its first tag, with its latest result in each place it runs (Trial, Main, Served, Nightly),
// read from the run ledger and the batch gate's record; a place with no record reads 'not run here'.

const operator: Principal = { id: 'operator', role: 'admin' };
const token = `operator-${'t'.repeat(32)}`;
const repository = 'owner/shop';
let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, checkout: string;
const previousRoot = process.env.GRAPHYARD_REPOSITORY_ROOT;

before(async () => {
  store = await withDatabase('tests-page-matrix'); await store.init();
  engine = new Engine(store, 120, repository);
  // The served main holds both case files; the batch gate's record sits in the same checkout.
  checkout = await temporaryDirectory('tests-page-matrix-main');
  await mkdir(join(checkout, 'e2e/cases'), { recursive: true });
  for (const id of ['case-a', 'case-b']) await writeFile(join(checkout, `e2e/cases/${id}.json`), '{}');
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'main'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  engine.gitRunner = gitRunnerFor(checkout);
  process.env.GRAPHYARD_REPOSITORY_ROOT = checkout;
  http = server(engine, [{ ...operator, token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (previousRoot === undefined) delete process.env.GRAPHYARD_REPOSITORY_ROOT; else process.env.GRAPHYARD_REPOSITORY_ROOT = previousRoot;
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const noop = () => {};
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const hour = 3_600_000;
/** The rendered element tree with every function component expanded (none of the matrix's own use hooks), so a button's handler can be called. */
function expand(node: any): any {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== 'object' || !('props' in node)) return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}
function find(node: any, match: (props: any) => boolean): any {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found; } return null; }
  if (!node || typeof node !== 'object' || !('props' in node)) return null;
  return match(node.props) ? node : find(node.props.children, match);
}

async function define(id: string, tags: string[], createdAt: string, required = false) {
  const document = { id, title: `Case ${id.slice(-1).toUpperCase()}`, purpose: 'p', setup: [], steps: ['s'], expected: ['e'], environment: 'any', runner: 'graphyard-e2e',
    testPath: `e2e/cases/${id}.json`, tags, required, revision: 1, hash: 'h', createdAt, createdBy: 'operator' };
  await store.pool.query('INSERT INTO scenarios(id,revision,document) VALUES($1,1,$2)', [id, JSON.stringify(document)]);
}
async function run(id: string, key: string, document: Record<string, unknown>) {
  await store.pool.query('INSERT INTO scenario_runs(scenario,run_key,document) VALUES($1,$2,$3)', [id, key, JSON.stringify({ scenarioId: id, proof: `e2e:${id}`, scenarioRevision: 1,
    executed: 2, skipped: 0, sha: 'a'.repeat(40), baseSha: '', policyRevision: 0, workId: '', workKey: '', pr: null, evidenceId: '', producer: 'operator', ...document })]);
}

test('e2e:tests-page-matrix — the matrix shows each case\'s result per place, group counts and column totals, and only failing leaves the failing case', async () => {
  const work = await engine.execute(operator, 'create', null, { title: 'Dashboard loads', criteria: [{ id: 'AC-1', text: 'The dashboard loads', proofs: ['e2e:case-a'] }] }, randomUUID()) as Work;
  // Case A (dashboard) is registered after the last nightly run, so the nightly never ran it; case B (review) is older.
  await define('case-a', ['dashboard', 'ui'], iso(0), true);
  await define('case-b', ['review'], iso(-48 * hour));
  // Case A passed in its merge trial and failed against the served release.
  await run('case-a', 'a-trial', { result: 'pass', environment: 'merge-writer-trial', workId: work.id, workKey: work.key, run: { kind: 'producer', id: 'ev-1', attempt: null, url: null }, at: iso(-3 * hour) });
  await run('case-a', 'a-served', { result: 'fail', environment: 'shop.example', run: { kind: 'e2e', id: 'run-2', attempt: null, url: null }, at: iso(-1 * hour),
    e2e: { baseUrl: 'https://shop.example', durationMs: 1000, failingStep: { index: 1, name: 'opens the dashboard', reason: 'status 500' } } });
  // The batch gate passed case A on main; the nightly ran the catalog, case B passing.
  const gate = bootstrapGate(repository, 'b'.repeat(40));
  gate.lastOutcome = { tip: 'b'.repeat(40), outcome: 'verified', reason: null, finishedAt: iso(-2 * hour), cases: { 'case-a': 'pass' } };
  gate.diagnosticsAt = iso(-5 * hour); gate.diagnosticFailures = {};
  await writeGateRecord(gateRecordPath(checkout), gate);

  const response = await fetch(`${url}/api/tests`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const data = await response.json() as any;
  const opened: string[] = [];
  const render = (props: object = {}) => renderToStaticMarkup(createElement(TestsView, { data, error: '', loading: false, filter: 'all', setFilter: noop, retry: noop, api: async () => ({}), canEdit: false, openItem: (id: string) => opened.push(id), ...props }));
  const html = render();
  const row = (markup: string, id: string) => new RegExp(`<tr data-case="${id}">([\\s\\S]*?)</tr>`).exec(markup)?.[1] ?? assert.fail(`no row for ${id}`);
  const cell = (markup: string, id: string, column: string) => text(new RegExp(`<td data-column="${column}"[^>]*>([\\s\\S]*?)</td>`).exec(row(markup, id))?.[1] ?? assert.fail(`no ${column} cell for ${id}`));

  // The matrix is the default view, its columns in delivery order.
  assert.match(html, /aria-label="Where each case runs"/);
  assert.deepEqual([...html.matchAll(/<th scope="col"[^>]*>(\w+)<br/g)].map(match => match[1]), ['Trial', 'Main', 'Served', 'Nightly']);
  // Case A: passed in Trial and Main, failed Served, never ran Nightly.
  assert.match(cell(html, 'case-a', 'trial'), /^✓ passed 3 h ago$/);
  assert.match(cell(html, 'case-a', 'main'), /^✓ passed 2 h ago$/);
  assert.match(cell(html, 'case-a', 'served'), /^× failed 1 h ago$/);
  assert.equal(cell(html, 'case-a', 'nightly'), 'not run here');
  // Case B ran only Nightly.
  for (const column of ['trial', 'main', 'served']) assert.equal(cell(html, 'case-b', column), 'not run here');
  assert.match(cell(html, 'case-b', 'nightly'), /^✓ passed 5 h ago$/);
  // A place with no record is neutral; the trial cell links to the item whose trial ran it; the served failure names its step.
  assert.match(row(html, 'case-a'), /<td data-column="nightly" class="matrix-cell result-none">/);
  assert.match(row(html, 'case-a'), new RegExp(`<a href="#${work.key}">✓ passed</a>`));
  assert.match(row(html, 'case-a'), /title="opens the dashboard: status 500"/);
  // Grouped by first tag, each group with its pass/fail count.
  assert.deepEqual([...html.matchAll(/<tbody data-category="([^"]+)">/g)].map(match => match[1]), ['dashboard', 'review']);
  const group = (markup: string, category: string) => text(new RegExp(`<tbody data-category="${category}"><tr class="matrix-group">([\\s\\S]*?)</tr>`).exec(markup)![1]);
  assert.equal(group(html, 'dashboard'), '▾ dashboard 0 passing · 1 failing');
  assert.equal(group(html, 'review'), '▾ review 1 passing · 0 failing');
  // The header row totals each column.
  const totals = /<tr class="matrix-totals">([\s\S]*?)<\/tr>/.exec(html)![1];
  assert.deepEqual([...totals.matchAll(/<td data-column="(\w+)">([^<]*)<\/td>/g)].map(match => [match[1], match[2]]),
    [['trial', '1 passed · 0 failed'], ['main', '1 passed · 0 failed'], ['served', '0 passed · 1 failed'], ['nightly', '1 passed · 0 failed']]);

  // Only failing leaves case A; one category, or one column, narrows the matrix.
  const failing = render({ matrix: { failing: true, category: 'all', column: 'all' } });
  assert.deepEqual([...failing.matchAll(/<tr data-case="([^"]+)"/g)].map(match => match[1]), ['case-a']);
  const review = render({ matrix: { failing: false, category: 'review', column: 'all' } });
  assert.deepEqual([...review.matchAll(/<tr data-case="([^"]+)"/g)].map(match => match[1]), ['case-b']);
  const nightly = render({ matrix: { failing: false, category: 'all', column: 'nightly' } });
  assert.deepEqual([...nightly.matchAll(/<th scope="col"[^>]*>(\w+)<br/g)].map(match => match[1]), ['Nightly']);
  assert.equal(cell(nightly, 'case-a', 'nightly'), 'not run here');
  // A group collapses to its heading and count.
  const collapsed = renderToStaticMarkup(createElement(MatrixView, { cases: data.cases, filter: { failing: false, category: 'all', column: 'all' }, setFilter: noop, collapsed: new Set(['dashboard']), toggle: noop, openItem: noop }));
  assert.doesNotMatch(collapsed, /data-case="case-a"/);
  assert.match(collapsed, /aria-expanded="false">▸ dashboard/);
  assert.equal(group(collapsed, 'dashboard'), '▸ dashboard 0 passing · 1 failing');
  // AC-4: the summary strip counts the cases per the selected place.
  const summary = (markup: string) => text(/<p class="matrix-summary"[^>]*>([\s\S]*?)<\/p>/.exec(markup)![1]);
  assert.equal(summary(html), '2 cases · 1 required · 1 passing · 1 failing · 0 not run');
  assert.equal(summary(render({ matrix: { failing: false, category: 'all', column: 'served' } })), '2 cases · 1 required · 0 passing · 1 failing · 1 not run in Served');
  // The coverage grid: each category by place, coloured by its worst case, a dot where none of the category runs.
  const grid = (category: string, column: string) => new RegExp(`<td data-grid="${category}:${column}" class="([^"]+)">([\\s\\S]*?)</td>`).exec(html) ?? assert.fail(`no grid cell ${category}:${column}`);
  assert.deepEqual([grid('dashboard', 'served')[1], text(grid('dashboard', 'served')[2])], ['result-fail', '0 ✓ 1 ×']);
  assert.deepEqual([grid('dashboard', 'trial')[1], text(grid('dashboard', 'trial')[2])], ['result-pass', '1 ✓ 0 ×']);
  assert.deepEqual([grid('review', 'served')[1], text(grid('review', 'served')[2])], ['result-none', '·'], 'a dot: no review case runs on the served release');
  // A grid cell is a link that filters the matrix to its category and place.
  let chosen: MatrixFilter | null = null;
  const all: MatrixFilter = { failing: false, category: 'all', column: 'all', required: 'all' };
  const tree = expand(createElement(MatrixView, { cases: data.cases, filter: all, setFilter: (next: MatrixFilter) => { chosen = next; }, collapsed: new Set(), toggle: noop, openItem: noop }));
  find(tree, props => props['data-grid'] === 'dashboard:served').props.children.props.onClick();
  assert.deepEqual(chosen, { ...all, category: 'dashboard', column: 'served' });
  const filtered = render({ matrix: chosen });
  assert.deepEqual([...filtered.matchAll(/<tr data-case="([^"]+)"/g)].map(match => match[1]), ['case-a']);
  assert.deepEqual([...filtered.matchAll(/<th scope="col" title[^>]*>(\w+)<br/g)].map(match => match[1]), ['Served']);
  // Filter chips for category, required or optional, and place; and the fold that explains the places.
  for (const group of ['Category', 'Where it runs']) assert.match(html, new RegExp(`role="group" aria-label="${group}"`));
  assert.deepEqual([...render({ matrix: { ...all, required: 'optional' } }).matchAll(/<tr data-case="([^"]+)"/g)].map(match => match[1]), ['case-b']);
  assert.match(html, /<details class="matrix-help"><summary>How this works<\/summary>/);
  // The by-item view is one click away.
  assert.match(html, /aria-pressed="false">By item and criterion</);
});
