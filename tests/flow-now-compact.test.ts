import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NOW, boardApi, boardStatus, boardWork } from '../browser-tests/ui-board.js';
import { stepIds } from '../src/model/pr-steps.js';
import InsightsFlow, { NowLane, flowNow, nowColumnLimit, nowPerRow, readFlow } from '../web/pages/insights-flow.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-705: the Insights Flow panel reads its report apart from the replay rows, and its Now view
// stays compact however many items share a step. The browser suite (browser-tests/flow-analytics.spec.ts)
// checks the same behaviour in the rendered page at desktop and 375 px.

const noop = () => {};
const dashboard = (work = boardWork(), api: Dashboard['api'] = async (path: string) => boardApi(path)) =>
  ({ token: 'fixture', work, status: boardStatus(), observedAt: NOW, api, setSelected: noop }) as unknown as Dashboard;
const crowded = (count: number) => {
  const work = boardWork();
  const template = work.find(item => item.key === 'GY-15');
  return [...work, ...Array.from({ length: count }, (_, index) => ({ ...template, id: `crowd-${index}`, key: `GY-${300 + index}` }))];
};
const lane = (work: any[], expanded: string[] = []) => {
  const { entries, byGroup } = flowNow(work, NOW, boardStatus());
  return renderToStaticMarkup(createElement(NowLane, { entries, blocked: new Set(byGroup.blocked.map(item => item.id)), expanded: new Set(expanded) as any, onToggle: noop, onSelect: noop }));
};

test('unit:flow-medians-independent-of-replay — a failed step-move read keeps the report, and each read names its own failure', async () => {
  const report = boardApi('analytics/flow?window=7');
  const failingMoves = async (path: string) => {
    if (path.startsWith('analytics/flow/drilldown')) throw new Error('The ledger is under load');
    return boardApi(path);
  };
  const flow = await readFlow(failingMoves, NOW);
  assert.deepEqual(flow.report, report, 'the report survives the failed replay read');
  assert.equal(flow.replayError, 'The ledger is under load');
  assert.equal(flow.reportError, undefined);
  assert.deepEqual(flow.frames, []);
  const failingReport = async (path: string) => { if (path === 'analytics/flow?window=7') throw new Error('Report timed out'); return boardApi(path); };
  const other = await readFlow(failingReport, NOW);
  assert.equal(other.report, null); assert.equal(other.reportError, 'Report timed out'); assert.equal(other.replayError, undefined);
  assert.ok(other.frames.length > 0, 'the replay survives the failed report read');
  // The page reads them apart, never through one Promise.all that a failure on either side discards.
  const source = await readFile('web/pages/insights-flow.tsx', 'utf8');
  assert.doesNotMatch(source, /Promise\.all\(\[api\('analytics\/flow/);
  assert.match(source, /readFlowReport\(api\)\.then/);
  assert.match(source, /readReplay\(api, now\)\.then/);
});

test('unit:flow-now-compact — a column shows at most twelve dots, several to a row, then a \'+N more\' control that expands it to all; the lane stays short', () => {
  const html = lane(crowded(40));
  const dots = [...html.matchAll(/class="now-dot[^"]*" data-step="([\w-]+)" data-key="([^"]+)" data-row="(\d+)"/g)];
  const review = dots.filter(([, step]) => step === 'review');
  assert.equal(review.length, nowColumnLimit, 'twelve dots shown in the crowded column');
  assert.equal(new Set(review.map(([, , , row]) => row)).size, Math.ceil(nowColumnLimit / nowPerRow), `${nowPerRow} dots to a row`);
  assert.ok(nowPerRow >= 2);
  const total = flowNow(crowded(40), NOW, boardStatus()).entries.filter(entry => entry.steps.current === 'review').length;
  assert.ok(total >= 40);
  const more = html.match(/class="now-more" data-step="review" data-hidden="(\d+)" aria-expanded="false"[^>]*aria-label="([^"]+)"[^>]*>([^<]+)<span class="now-more-word"> more<\/span>/);
  assert.ok(more, 'the crowded column ends in a +N more control');
  assert.equal(Number(more![1]), total - nowColumnLimit);
  assert.equal(more![3], `+${total - nowColumnLimit}`);
  assert.equal(more![2], `Show all ${total} items at Review`);
  const height = Number(html.match(/data-flow="now" style="height:(\d+)px"/)![1]);
  assert.ok(height <= 320, `collapsed lane is ${height}px`);
  // Its places never collide.
  const places = [...html.matchAll(/style="left:([^;]+);top:(\d+)px"/g)].map(([, left, top]) => `${left}|${top}`);
  assert.equal(new Set(places).size, places.length, 'no two Now dots or controls share a place');

  const open = lane(crowded(40), ['review']);
  const all = [...open.matchAll(/class="now-dot[^"]*" data-step="review" data-key="([^"]+)"/g)].map(([, key]) => key);
  assert.equal(all.length, total, 'expanding shows every item');
  for (let index = 0; index < 40; index++) assert.ok(all.includes(`GY-${300 + index}`));
  assert.match(open, /class="now-more" data-step="review" data-hidden="0" aria-expanded="true"[^>]*>Show fewer</);
  const openPlaces = [...open.matchAll(/style="left:([^;]+);top:(\d+)px"/g)].map(([, left, top]) => `${left}|${top}`);
  assert.equal(new Set(openPlaces).size, openPlaces.length);
  // The expanded column scrolls inside a lane CSS caps at 320 px, so the panel stays bounded.
  return readFile('web/style.css', 'utf8').then(css => assert.match(css, /\.now-lane\{[^}]*max-height:320px;overflow-y:auto/));
});

test('unit:flow-now-compact — a quiet board keeps one short row and no control, and the step header carries every column\'s count', () => {
  const html = lane(boardWork());
  assert.doesNotMatch(html, /now-more/);
  assert.ok(Number(html.match(/style="height:(\d+)px"/)![1]) <= 80);
  const page = renderToStaticMarkup(createElement(InsightsFlow, dashboard(crowded(40))));
  const counts = [...page.matchAll(/class="flow-step[^"]*" data-count="(\d+)"><strong>\w+<\/strong><span>\1 now</g)].map(([, n]) => Number(n));
  assert.equal(counts.length, stepIds.length);
  const { entries } = flowNow(crowded(40), NOW, boardStatus());
  assert.deepEqual(counts, stepIds.map(step => entries.filter(entry => entry.steps.current === step).length));
});

test('unit:flow-now-renders-first — before any read answers, the page draws the Now view from the work snapshot and the medians wait on the report alone', () => {
  const pending: Dashboard['api'] = () => new Promise(() => {});
  const page = renderToStaticMarkup(createElement(InsightsFlow, dashboard(boardWork(), pending)));
  const { entries } = flowNow(boardWork(), NOW, boardStatus());
  assert.ok(entries.length > 0);
  for (const { item } of entries) assert.match(page, new RegExp(`class="now-dot[^"]*"[^>]*data-key="${item.key}"`));
  assert.equal([...page.matchAll(/class="flow-median" data-median=""> · median —/g)].length, stepIds.length);
});
