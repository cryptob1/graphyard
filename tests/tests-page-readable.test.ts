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
import type { Principal, Work } from '../src/model.js';
import { TestsView } from '../web/pages/tests.js';

// GY-3278: the Tests page of a fixture install reads plainly. Each row names its item, title and
// criterion; a backlog item's unwritten case is neutral and folded; only a merged item whose case
// file is missing on main is an alarm; a case whose file is on main is never "not in the registry";
// manual proofs are listed with their state; failing rows come first.

const operator: Principal = { id: 'operator', role: 'admin' };
const token = `operator-${'t'.repeat(32)}`;
let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  store = await withDatabase('tests-page-readable'); await store.init();
  engine = new Engine(store, 120, 'owner/shop');
  // The served main holds one case file: e2e/cases/passed-case.json.
  const checkout = await temporaryDirectory('tests-page-readable-main');
  await mkdir(join(checkout, 'e2e/cases'), { recursive: true });
  await writeFile(join(checkout, 'e2e/cases/passed-case.json'), JSON.stringify({ id: 'passed-case', title: 'Checkout passes', target: 'uat', steps: [{ kind: 'http', method: 'GET', path: '/healthz', status: 200 }] }));
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'main'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  engine.gitRunner = gitRunnerFor(checkout);
  http = server(engine, [{ ...operator, token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
});

/** An item whose one criterion names `proof`, its document then set as the fixture needs (stage, evidence). */
async function item(title: string, text: string, proof: string, patch: Record<string, unknown>) {
  // Created with an e2e proof, as every item owes one; the criterion then names the proof under test.
  const criteria = [{ id: 'AC-1', text, proofs: [proof] }];
  const work = await engine.execute(operator, 'create', null, { title, criteria: [{ ...criteria[0], proofs: ['e2e:created'] }] }, randomUUID()) as Work;
  await store.pool.query('UPDATE work_items SET document = document || $2::jsonb WHERE id=$1', [work.id, JSON.stringify({ criteria, ...patch })]);
  return work;
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = () => {};

test('e2e:tests-page-readable — each proof shows its item and criterion; unwritten backlog cases fold neutrally; only a merged item missing its case alarms; manual proofs are listed; failing first', async () => {
  const at = new Date().toISOString();
  const passed = await item('Checkout takes payment', 'Paying completes the order', 'e2e:passed-case', { stage: 'done' });
  // The passing run is in the run ledger, though the case was never synced into the registry.
  await store.pool.query('INSERT INTO scenario_runs(scenario,run_key,document) VALUES($1,$2,$3)', ['passed-case', 'passed-case-run-1', JSON.stringify({ scenarioId: 'passed-case', proof: 'e2e:passed-case', result: 'pass',
    scenarioRevision: 1, environment: 'uat', executed: 3, skipped: 0, sha: 'a'.repeat(40), baseSha: '', policyRevision: 0, workId: passed.id, workKey: passed.key, pr: null,
    run: { kind: 'e2e', id: 'run-1', attempt: null, url: null }, evidenceId: '', producer: 'operator', at })]);
  const missing = await item('Refunds are issued', 'A refund returns the money', 'e2e:missing-case', { stage: 'done' });
  const backlog = await item('R-07 reports', 'The R-07 report lists every booking', 'e2e:unwritten-case', { stage: 'backlog' });
  const manual = await item('Live dashboard', 'The live dashboard shows the release', 'manual:dashboard-checked', { stage: 'build',
    evidence: [{ id: 'att-1', proof: 'manual:dashboard-checked', sha: 'b'.repeat(40), baseSha: 'c'.repeat(40), policyRevision: 1, producer: 'master', trusted: true, result: 'pass', executed: 1, skipped: 0, at }] });

  const response = await fetch(`${url}/api/tests`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const data = await response.json() as any;
  const opened: string[] = [];
  const html = renderToStaticMarkup(createElement(TestsView, { data, error: '', loading: false, filter: 'all', setFilter: noop, retry: noop, api: async () => ({}), canEdit: false, openItem: (id: string) => opened.push(id) }));
  const row = (id: string) => new RegExp(`<tr data-case="${id}">([\\s\\S]*?)</tr>`).exec(html)?.[1] ?? assert.fail(`no row for ${id}`);

  // Each row names its item key and title, linking to the item, and the criterion's own words.
  for (const [id, work, criterion] of [['passed-case', passed, 'Paying completes the order'], ['missing-case', missing, 'A refund returns the money'], ['unwritten-case', backlog, 'The R-07 report lists every booking']] as const) {
    assert.match(row(id), new RegExp(`<a href="#${work.key}"><span class="mono">${work.key}</span> ${work.title}</a>`), `${id} links to ${work.key}`);
    assert.match(text(row(id)), new RegExp(`AC-1: ${criterion}`), `${id} shows its criterion`);
  }
  // The passed case reads passed, with no registry warning.
  assert.match(text(row('passed-case')), /✓ passed/);
  assert.doesNotMatch(html, /not in the registry/);
  // Only the merged item missing its case file uses the alarm style.
  assert.equal(html.match(/class="case-alarm"/g)?.length, 1, 'exactly one alarm');
  assert.match(row('missing-case'), /class="case-alarm"/);
  assert.match(text(row('missing-case')), new RegExp(`Case file missing on main: ${missing.key} merged without e2e/cases/missing-case.json`));
  // The backlog item's unwritten case is neutral and folded under a count.
  assert.doesNotMatch(row('unwritten-case'), /case-alarm|amber|danger|result-fail/);
  assert.match(text(row('unwritten-case')), /Case file not written yet — item in backlog/);
  const fold = /<details class="unbuilt-proofs"><summary>([^<]*)<\/summary>([\s\S]*?)<\/details>/.exec(html);
  assert.ok(fold, 'proofs of unbuilt items are folded');
  assert.equal(fold![1], '1 proof of items not built yet');
  assert.match(fold![2], /data-case="unwritten-case"/);
  // Failing rows come first.
  assert.deepEqual([...html.matchAll(/<tr data-case="([^"]+)"/g)].map(match => match[1]), ['missing-case', 'passed-case', 'unwritten-case']);
  // The manual proof is listed with its item, criterion and state.
  const proof = /<tr[^>]*data-proof="manual:dashboard-checked">([\s\S]*?)<\/tr>/.exec(html)?.[1] ?? assert.fail('the manual proof is listed');
  assert.match(text(proof), new RegExp(`${manual.key} Live dashboard AC-1: The live dashboard shows the release ✓ passed attested by master`));
});
