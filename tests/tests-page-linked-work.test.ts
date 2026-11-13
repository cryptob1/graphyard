import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TestsView } from '../web/pages/tests.js';

// GY-3194: a case linked by hundreds of items shows the count, the latest three and the rest folded
// into a collapsed details element, so its row stays a few lines tall.

const noop = () => {};
const at = '2026-11-01T00:00:00.000Z';
const run = { seq: 7, result: 'pass', sha: 'a'.repeat(40), pr: 12, workKey: 'GY-1', run: { kind: 'e2e', id: 'run-1', url: null }, executed: 3, skipped: 0, producer: 'producer', at, environment: 'uat', scenarioRevision: 2, withdrawn: false };
const entry = (links: number) => ({ id: 'fixture-static-home', title: 'The home page renders', purpose: null, testPath: 'e2e/cases/fixture-static-home.json', environment: null,
  revision: 2, changed: { at, by: 'operator' }, latest: run, staleRevision: false, runs: 1, failures: 0, lastFailure: null, flaky: false, flakyReason: null, passRate: 1, history: [run],
  onMain: true, links: Array.from({ length: links }, (_, i) => ({ id: `w${i + 1}`, key: `GY-${i + 1}`, title: `Item ${i + 1}`, stage: 'done', criteria: [{ id: 'AC-1', text: 'The home page renders' }] })) });
const render = (links: number) => renderToStaticMarkup(createElement(TestsView, { data: { window: 20, cases: [entry(links) as any] }, view: 'cases', error: '', loading: false, filter: 'all', setFilter: noop, retry: noop, api: async () => ({}), canEdit: false }));
const cells = (html: string) => html.split('<tbody>')[1].match(/<t[hd][ >][\s\S]*?<\/t[hd]>(?=<t[hd][ >]|<\/tr>)/g)!;

test('unit:tests/tests-page-linked-work.test.ts — a case linked by 400 items shows the count, the latest three and the rest collapsed', () => {
  const html = render(400);
  const linked = cells(html)[1];
  assert.match(linked, /^<td>400 items/);
  const [visible, folded] = linked.split('<details>');
  assert.equal(visible.match(/class="mono"/g)?.length, 3);
  assert.deepEqual([...visible.matchAll(/class="mono">(GY-\d+)</g)].map(m => m[1]), ['GY-400', 'GY-399', 'GY-398']);
  assert.ok(folded, 'the rest sits in a details element');
  assert.doesNotMatch(linked, /<details open/);
  assert.match(folded, /<summary>and 397 more items<\/summary>/);
  assert.equal(folded.match(/class="mono"/g)?.length, 397);
});

test('unit:tests/tests-page-linked-work.test.ts — every other column is unchanged by the number of linked items', () => {
  const without = (html: string) => cells(html).filter((_, i) => i !== 1);
  assert.deepEqual(without(render(400)), without(render(1)));
  assert.match(cells(render(1))[1], /^<td><div class="proof-item"><a href="#GY-1"><span class="mono">GY-1<\/span> Item 1<\/a><small class="proof-criterion">AC-1: The home page renders<\/small><\/div><\/td>$/);
  assert.match(cells(render(0))[1], /none/);
});
