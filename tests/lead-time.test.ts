import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { leadTime, leadTimeSpan, type LeadTimeReport } from '../src/pipeline-speed.js';
import { leadTimeReport } from '../src/flow-analytics.js';
import { leadTimeHeadline, mergeWriterLine } from '../src/cli/status-attention.js';
import TopBar, { LeadTimeLine } from '../web/components/top-bar.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-1989: one speed number at the top of the dashboard — the median released→merged lead time
// over the last 10 merges, with the previous 10's median beside it as the trend. Each test is
// named for the proof it produces — unit:lead-time (AC-1) and unit:lead-time-shown (AC-2) — and
// reads exact milliseconds and exact rendered text from fixture items, so a skipped window, an
// unskipped unmerged item or a reworded line fails the proof instead of passing vacuously.
// Every instant is derived from one fixed base, so the file reads no wall clock.

const minute = 60_000, hour = 60 * minute;
const iso = (ms: number) => new Date(ms).toISOString();

let fixtureIds = 0;
/** One delivered item, released at `releasedMs` and merged at `mergedMs`; its creation is an hour before its release. */
const merged = (releasedMs: number, mergedMs: number): Work => ({
  id: `00000000-0000-4000-8000-${String(++fixtureIds).padStart(12, '0')}`, key: `GY-${1000 + fixtureIds}`, title: `Fixture GY-${1000 + fixtureIds}`,
  description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: [], criteria: [], policy: { checks: ['test'], review: true },
  stage: 'done', revision: 1, policyRevision: 1, createdAt: iso(releasedMs - hour), updatedAt: iso(mergedMs), stageEnteredAt: iso(mergedMs),
  ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: { epoch: 1, pr: 400 + fixtureIds }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
  delivery: { mergedAt: iso(mergedMs), mergeSha: 'f'.repeat(40) },
} as unknown as Work);
/** A specimen pairs an item with the release instant its history records, so a release map is always item-true. */
const specimen = (releasedMs: number, mergedMs: number) => ({ item: merged(releasedMs, mergedMs), releasedMs });
/** An item merged at `mergedMs` that took `leadMs` from its release to its merge; smaller merged instants are older merges. */
const take = (mergedMs: number, leadMs: number) => specimen(mergedMs - leadMs, mergedMs);
const releaseMap = (list: { item: Work; releasedMs: number }[]) => new Map(list.map(({ item, releasedMs }) => [item.id, iso(releasedMs)]));
/** One open item (never merged) and one closed without delivery: both unmerged, both skipped. */
const unmerged = (stage: 'build' | 'done'): Work => ({ ...merged(0, minute), stage, delivery: undefined } as unknown as Work);

test('unit:lead-time — the median released-to-merged time of the last 10 merges and of the 10 before them, each unmerged or unreleased item skipped, each window counted (AC-1)', () => {
  // Twenty-five merges: the newest ten took 40 minutes each, the ten before took a rising
  // 30–48 minutes (nearest-rank p50: the fifth smallest, 38), the oldest five 5 hours — outside
  // both windows and never counted.
  const newest = Array.from({ length: 10 }, (_, index) => take((30 - index) * hour, 40 * minute));
  const previous = Array.from({ length: 10 }, (_, index) => take((20 - index) * hour, (30 + 2 * index) * minute));
  const oldest = Array.from({ length: 5 }, (_, index) => take((10 - index) * hour, 5 * hour));
  const items = [...newest, ...previous, ...oldest].map(entry => entry.item);
  const report = leadTime(items, releaseMap([...newest, ...previous, ...oldest]));
  assert.deepEqual(report.last, { medianMs: 40 * minute, count: 10 });
  assert.deepEqual(report.previous, { medianMs: 38 * minute, count: 10 });
  assert.equal(report.line, 'Lead time 40 min · last 10 merges · was 38 min');

  // An open item, an item closed without delivery, and a merge with no recorded release time are
  // all skipped, and each window reaches past them for the next qualifying merges.
  const withSkipped = [...items, unmerged('build'), unmerged('done')];
  const partial = releaseMap([...newest.slice(1), ...previous, ...oldest]); // the newest merge has no release time
  const narrowed = leadTime(withSkipped, partial);
  assert.deepEqual(narrowed.last, { medianMs: 40 * minute, count: 10 }, 'the newest merge is skipped and the window takes the next qualifying merge');
  assert.deepEqual(narrowed.previous, { medianMs: 40 * minute, count: 10 }, 'the second window shifts to the oldest five, whose releases were recorded');
  assert.notDeepEqual(narrowed.previous, report.previous, 'the skipped merge moved both windows');
  assert.equal(leadTime([unmerged('build'), unmerged('done')], new Map()).last.count, 0, 'nothing unmerged ever qualifies');
});

test('unit:lead-time — fewer than ten merges says how many the number covers, and nothing merged reads as no line, never a zero', () => {
  const few = [10, 20, 90].map((minutes, index) => take((30 - index) * hour, minutes * minute));
  const report = leadTime(few.map(entry => entry.item), releaseMap(few));
  assert.deepEqual(report.last, { medianMs: 20 * minute, count: 3 });
  assert.deepEqual(report.previous, { medianMs: null, count: 0 });
  assert.equal(report.line, 'Lead time 20 min · last 3 merges', 'no previous window, so no trend is claimed');

  const single = [take(2 * minute, 59_000)];
  assert.equal(leadTime(single.map(entry => entry.item), releaseMap(single)).line, 'Lead time 59s · last 1 merge', 'the singular reads as one merge');

  assert.deepEqual(leadTime([], new Map()), { line: null, last: { medianMs: null, count: 0 }, previous: { medianMs: null, count: 0 } });
  const unreleased = [merged(0, minute)];
  assert.equal(leadTime(unreleased, new Map()).line, null, 'merges with no recorded release time leave no line');

  // A release recorded after its merge is clamped at zero, never read as a negative lead time.
  const backwards = [specimen(2 * hour, hour)];
  assert.equal(leadTime(backwards.map(entry => entry.item), releaseMap(backwards)).last.medianMs, 0);
  assert.equal(leadTimeSpan(2 * 3_600_000 + 1_800_000), '2.5h', 'spans read as whole minutes, or hours to one decimal past the hour');
});

test('unit:lead-time-shown — the dashboard top bar and the report headline both show the lead time and its previous-10 comparison (AC-2)', () => {
  const newest = Array.from({ length: 10 }, (_, index) => take((30 - index) * hour, 42 * minute));
  const previous = Array.from({ length: 10 }, (_, index) => take((20 - index) * hour, 58 * minute));
  const items = [...newest, ...previous].map(entry => entry.item);
  const report = leadTime(items, releaseMap([...newest, ...previous]));
  assert.equal(report.line, 'Lead time 42 min · last 10 merges · was 58 min');

  // The dashboard's top bar renders the line above the release line, on every page's one top bar.
  const dashboard = (status: any) => ({
    token: 'fixture', work: [], status, error: '', connected: true, lastUpdated: null, view: 'work', setView: () => {}, filter: null, setFilter: () => {},
    selected: null, setSelected: () => {}, creating: false, setCreating: () => {}, busy: false, setBusy: () => {}, observedAt: hour, jobs: [], query: '', setQuery: () => {},
    operatorAgents: [], operatorAgentsError: null, features: { validation: null, releases: null, automation: null }, events: [], editingRequirements: false, setEditingRequirements: () => {},
    codexAvailable: false, sessionEpoch: { current: 0 }, api: async () => null, refresh: async () => {}, action: async () => {}, setError: () => {}, signOut: () => {},
  } as unknown as Dashboard);
  const markup = (element: ReactElement) => renderToStaticMarkup(element);
  const bar = markup(createElement(TopBar, dashboard({ actor: { role: 'admin' }, production: null, leadTime: report })));
  assert.match(bar, /data-lead-time="shown">Lead time 42 min · last 10 merges · was 58 min</);
  assert.ok(bar.indexOf('data-lead-time') < bar.indexOf('data-release-line'), 'the speed number is the top bar\'s first line');
  // Nothing qualifying renders no line, and a status without the figure renders none either.
  assert.doesNotMatch(markup(createElement(TopBar, dashboard({ actor: { role: 'admin' }, production: null, leadTime: { ...report, line: null } }))), /data-lead-time/);
  assert.doesNotMatch(markup(createElement(LeadTimeLine, { status: undefined })), /data-lead-time/);

  // Master status carries the same report as its first field, ahead of the merge writer's line,
  // and a failed lead-time read leaves it out rather than guessing a figure.
  assert.deepEqual(leadTimeHeadline(report), { leadTime: report });
  assert.deepEqual(leadTimeHeadline(null), {});
  const assembled = { ...leadTimeHeadline(report), ...mergeWriterLine({ mergeWriter: { line: 'the control plane merges' } }) };
  assert.equal(Object.keys(assembled)[0], 'leadTime');
  assert.match(String(assembled.leadTime?.line), /was 58 min/);
});

test('unit:lead-time-events-read — the report reads each release from the item’s own ready events, bounded to the window’s history', async () => {
  const newest = Array.from({ length: 12 }, (_, index) => take((30 - index) * hour, 25 * minute));
  const items = newest.map(entry => entry.item);
  const rows = newest.map(({ item, releasedMs }) => ({ work_id: item.id, created_at: iso(releasedMs) }));
  // A paged ledger: the first read answers with the newest ten releases and names a cursor; the
  // second answers with the rest and closes the walk.
  const reads: string[] = [];
  const reader = async (path: string) => {
    reads.push(path);
    if (reads.length === 1) return { events: rows.slice(0, 10), page: { hasMore: true, nextCursor: '42' } };
    assert.match(path, /cursor=42/, 'the walk continues from the cursor the first page named');
    return { events: rows.slice(10), page: { hasMore: false, nextCursor: null } };
  };
  const report: LeadTimeReport = await leadTimeReport(items, reader);
  assert.equal(reads.length, 2);
  assert.match(reads[0], /events\?kind=ready&order=asc/, 'the read asks the ledger for ready events, earliest first');
  assert.deepEqual(report.last, { medianMs: 25 * minute, count: 10 });
  assert.deepEqual(report.previous, { medianMs: 25 * minute, count: 2 });
  // The read reaches back far enough for the window's own history: its bound precedes every
  // release the window needs, with the margin against the two planes' clocks.
  const since = new URLSearchParams(reads[0].slice(reads[0].indexOf('?'))).get('since')!;
  const earliestRelease = Math.min(...newest.map(entry => entry.releasedMs));
  assert.ok(Date.parse(since) <= earliestRelease, `the read's bound precedes the window's earliest release, not ${since}`);
  // Nothing merged: no read is made and no line is claimed.
  const untouched: string[] = [];
  const quiet = await leadTimeReport([unmerged('build')], async path => { untouched.push(path); return { events: [], page: { hasMore: false, nextCursor: null } }; });
  assert.equal(untouched.length, 0, 'an empty window reads nothing');
  assert.equal(quiet.line, null);
});
