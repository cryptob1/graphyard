import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { predictQueue } from '../src/merge-queue.js';
import { NOW, boardApi, boardStatus, boardWork, realDeliveredWork } from '../browser-tests/ui-board.js';
// @ts-expect-error Dependency-free fixture script.
import { fixtureApi, flowApi, flowDataset, visibleWords } from '../scripts/dashboard-fixture.mjs';
import { boardFromStatus, classify, groupLabel, groupOf, groupWithin, groups, humanOnlyIds, mergedAt, nextActor, releasedAt, timedGroups, type OpenGroup } from '../web/groups.js';
import { checkStates, prSteps, stepHeld, stepIds, stepSince } from '../src/model/pr-steps.js';
import { noRelease, releaseView } from '../src/model/release.js';
import ShippedPage from '../web/pages/shipped.js';
import { positionsAt, replayFrames, transitionsFromRows } from '../web/flow-replay.js';
import { jargon } from '../src/model/plain-status.js';
import { formatAge, formatDuration } from '../src/model/duration.js';
import { primaryEntry, sections, views, visibleViews } from '../web/pages/index.js';
import { endedItemIdleMs, workersView } from '../web/workers-view.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import OverviewPage from '../web/pages/overview.js';
import WorkDetails from '../web/pages/work-details.js';
import GuidePage from '../web/pages/guide.js';
import { ShippingPulseView, wellFormedPulse } from '../web/shipping-pulse.js';
import { mergeTime, wellFormedDrilldown, wellFormedFlowReport } from '../web/flow-analytics.js';
import InsightsFlow, { Headline, InsightsDetails, ReplayLane, readFlow } from '../web/pages/insights-flow.js';
import { readStepRows } from '../web/step-moves.js';
import Sidebar from '../web/components/sidebar.js';
import TopBar from '../web/components/top-bar.js';
import WorkCard from '../web/components/work-card.js';
import WorkersPage, { roleWords, shortShas } from '../web/pages/workers.js';
import { CandidateSha } from '../web/candidate.js';
import { computeFlow, coveredWindow, deliveredAt, flowDrilldown, gateFactStep, productionHold, releaseObservedAt, servedAt, stepEntries, stepMoves } from '../src/flow-analytics.js';

// GY-161: the dashboard, rendered over the board fixture the browser suite also serves
// (browser-tests/ui-board.ts): an item parked on a human-only decision, one blocked, items building,
// in review, proving, testing and merging, two waiting for a worker, one in backlog and three shipped.

const root = new URL('..', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
const markup = (element: ReactElement) => renderToStaticMarkup(element);
const noop = () => {};
const hour = 3_600_000;
const board = () => boardWork() as unknown as Work[];
const find = (key: string, work: Work[] = board()) => work.find(item => item.key === key)!;
function dashboard(overrides: Partial<Dashboard> = {}, role = 'admin'): Dashboard {
  const work = overrides.work ?? board();
  const d: Dashboard = {
    token: 'fixture', work, status: boardStatus(role), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: { validation: null, releases: null, automation: null }, events: [], editingRequirements: false, setEditingRequirements: noop,
    codexAvailable: false, queue: predictQueue(work, NOW), sessionEpoch: { current: 0 }, api: async (path: string) => boardApi(path, role), refresh: async () => {},
    action: async () => {}, setError: noop, signOut: noop, ...overrides,
  };
  // The board GET /api/board serves over the same work (GY-200): the Work page renders its groups.
  return 'board' in overrides ? d : { ...d, board: boardFromStatus(d.work, d.observedAt, d.status) };
}
const home = (d = dashboard()) => markup(createElement(OverviewPage, d));
const itemPage = (key: string, d = dashboard()) => markup(createElement(WorkDetails, { ...d, item: find(key, d.work) }));
/** The rows a rendered group section holds, by item key. */
function rowsOf(page: string, group: OpenGroup): string[] {
  const start = page.indexOf(`data-group-section="${group}"`);
  if (start < 0) return [];
  const next = [page.indexOf('data-group-section="', start + 1), page.indexOf('aria-label="Shipped this week"', start)].filter(at => at > 0);
  return [...page.slice(start, Math.min(...next)).matchAll(/data-row="([^"]+)"/g)].map(match => match[1]);
}
const tileCount = (page: string, group: OpenGroup) => Number(new RegExp(`data-tile="${group}"[^>]*>[\\s\\S]*?<strong>(\\d+)</strong>`).exec(page)?.[1]);
/** Every element of a rendered tree (the page's own elements, without expanding child components). */
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node as ReactElement<any>, ...elements(props.children)];
}
/** The item page's first screen: everything before "Technical details", without the closed Edit menu. */
const firstScreen = (html: string) => html.slice(0, html.indexOf('<details class="more-details"')).replace(/<details class="edit-menu">[\s\S]*?<\/details>/, '');

test('unit:ui-one-classification — every summary tile filters the groups the lists render, its count equals the cards in that group, and pressing it shows exactly those cards', () => {
  const work = board();
  const page = home();
  const { byGroup, open } = classify(work, NOW);
  // The mixed board: every open item is in exactly one group, and the groups hold every open item.
  const keys = groups.flatMap(group => byGroup[group].map(item => item.key));
  assert.equal(new Set(keys).size, keys.length, 'no item is in two groups');
  assert.equal(keys.length, open);
  assert.deepEqual(Object.fromEntries(groups.map(group => [group, byGroup[group].map(item => item.key).sort()])), {
    'needs-you': ['GY-20'], blocked: ['GY-17'], moving: ['GY-14', 'GY-15', 'GY-16', 'GY-21', 'GY-22'], 'up-next': ['GY-12', 'GY-13'], backlog: ['GY-11'],
  });
  // Each tile's count is the number of cards its group renders, and they are the same cards.
  for (const group of groups) {
    assert.equal(tileCount(page, group), rowsOf(page, group).length, `${groupLabel[group]}: tile ${tileCount(page, group)} vs ${rowsOf(page, group).length} rows`);
    assert.deepEqual(rowsOf(page, group).sort(), byGroup[group].map(item => item.key).sort(), groupLabel[group]);
  }
  assert.equal(groups.reduce((sum, group) => sum + tileCount(page, group), 0), open, 'the tiles add up to the open items');
  // Pressing a tile sets the page's filter to that group, and the page then shows exactly its cards.
  for (const group of groups) {
    let chosen: string | null = null;
    const tree = OverviewPage(dashboard({ setFilter: (value: any) => { chosen = value; } }));
    const tile = elements(tree).find(element => element.props?.['data-tile'] === group);
    assert.ok(tile, `a tile for ${group}`);
    tile.props.onClick();
    assert.equal(chosen, group, `pressing ${groupLabel[group]} filters to it`);
    const filtered = home(dashboard({ filter: group }));
    assert.deepEqual([...filtered.matchAll(/data-row="([^"]+)"/g)].map(match => match[1]).sort(), byGroup[group].map(item => item.key).sort(), `${groupLabel[group]} alone`);
    assert.match(filtered, new RegExp(`data-tile="${group}"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-tile="${group}"`));
    // The tile row still counts every group, so the numbers never change under the reader.
    for (const other of groups) assert.equal(tileCount(filtered, other), byGroup[other].length);
  }
  // Merged work is Shipped; only a policy that asks for a post-deployment check keeps it Moving (at
  // Deploy) until that check passes on the recorded deployment, and a failed check is Blocked.
  const merged = find('GY-18', work);
  const release = (delivery: Record<string, unknown>) => ({ ...merged, policy: { ...merged.policy, deploySmoke: true }, delivery: { ...merged.delivery!, ...delivery } }) as Work;
  const deployment = { sha: merged.delivery!.mergeSha, covers: 'exact' };
  const smoke = (result: string) => ({ sha: merged.delivery!.mergeSha, mergeSha: merged.delivery!.mergeSha, result, producer: 'smoke', executed: 1, skipped: 0, at: new Date(NOW).toISOString() });
  const awaiting = release({ deployment: null }), checking = release({ deployment, smoke: null }), failed = release({ deployment, smoke: smoke('fail') }), live = release({ deployment, smoke: smoke('pass') });
  assert.equal(groupOf(merged, NOW), 'shipped');
  assert.equal(groupOf(live, NOW), 'shipped');
  // With no post-deployment check asked for, no per-item deployment record is written: the merge has shipped (AC-11).
  const unverified = { ...merged, delivery: { ...merged.delivery!, deployment: undefined } } as Work;
  assert.equal(groupOf(unverified, NOW), 'shipped'); assert.equal(prSteps(unverified, NOW).current, null);
  assert.equal(groupOf(awaiting, NOW), 'moving'); assert.equal(groupOf(checking, NOW), 'moving'); assert.equal(groupOf(failed, NOW), 'blocked');
  const releasing = classify(work.map(item => item.key === 'GY-18' ? awaiting : item), NOW);
  assert.ok(releasing.byGroup.moving.some(item => item.key === 'GY-18'), 'a merge waiting on its release stays on the Work page');
  assert.equal(releasing.open, open + 1);
  const releasingPage = home(dashboard({ work: work.map(item => item.key === 'GY-18' ? awaiting : item) }));
  assert.equal(tileCount(releasingPage, 'moving'), rowsOf(releasingPage, 'moving').length);
  assert.ok(rowsOf(releasingPage, 'moving').includes('GY-18'));
  // "Shipped this week" counts what the page classifies as Shipped and the release was seen serving:
  // a merge from this morning still waiting on the post-deployment check its policy asks for is in
  // Moving, not in the footer.
  const shippedLine = (html: string) => Number(/<strong>(\d+) shipped this week\.<\/strong>/.exec(html)?.[1]);
  const servedThisWeek = (items: Work[]) => items.filter(item => groupOf(item, NOW) === 'shipped' && releasedAt(item) !== null && NOW - releasedAt(item)! <= 7 * 24 * hour).map(item => item.key);
  assert.equal(shippedLine(page), servedThisWeek(work).length);
  const mergedToday = { ...awaiting, observation: { ...merged.observation!, mergedAt: new Date(NOW - hour).toISOString() } } as Work;
  const pending = work.map(item => item.key === 'GY-18' ? mergedToday : item);
  const pendingPage = home(dashboard({ work: pending }));
  assert.ok(!servedThisWeek(pending).includes('GY-18'));
  assert.equal(shippedLine(pendingPage), servedThisWeek(pending).length);
  assert.ok(rowsOf(pendingPage, 'moving').includes('GY-18'), 'the pending merge is counted once, in Moving');
  // The footer names it only as the latest merge (GY-168), never as shipped.
  assert.match(pendingPage.slice(pendingPage.indexOf('aria-label="Shipped this week"')), /Latest: <button type="button" class="text-button" data-latest="GY-18">[\s\S]*?<\/button> · merged /);
  // An item nothing is moving is Blocked on the Work page, and its own page carries the same badge.
  const stalled = work.map(item => item.key === 'GY-15' ? { ...item, nextAction: null, lease: null } as Work : item);
  assert.ok(classify(stalled, NOW).byGroup.blocked.some(item => item.key === 'GY-15'));
  assert.equal(groupWithin(find('GY-15', stalled), stalled, NOW), 'blocked');
  assert.match(firstScreen(itemPage('GY-15', dashboard({ work: stalled }))), /data-status-badge="blocked"/);
  for (const item of work) assert.equal(groupWithin(item, work, NOW), groups.find(group => byGroup[group].includes(item)) ?? groupOf(item, NOW), `${item.key} item page group`);
});

test('unit:ui-needs-you-and-timers — a human-only decision is listed once, under Needs you, with its one action and never as Blocked; parked, backlog and not-started items carry no overdue timer', () => {
  const page = home();
  // GY-20 is parked on a decision only the human may make: it also carries a blocker, and still it is Needs you only.
  const parked = find('GY-20');
  assert.ok(parked.blocker && parked.humanRequest);
  assert.equal(groupOf(parked, NOW, humanOnlyIds(board(), [])), 'needs-you');
  assert.deepEqual(rowsOf(page, 'needs-you'), ['GY-20']);
  assert.ok(!rowsOf(page, 'blocked').includes('GY-20'), 'never also Blocked');
  assert.equal(page.split('data-row="GY-20"').length - 1, 1, 'listed once on the page');
  assert.doesNotMatch(page, /Stuck:/, 'nothing on the page is called Stuck any more');
  const row = markup(createElement(WorkCard, { item: parked, now: NOW, onOpen: noop, group: 'needs-you' }));
  assert.match(row, new RegExp(parked.humanRequest!.needed), 'the row names the one thing needed');
  assert.equal((row.match(/<button[^>]*class="decide"[^>]*>Decide<\/button>/g) ?? []).length, 1, 'and the single action to take');
  // The item page answers it in place, from the same human-only rule table.
  assert.match(itemPage('GY-20'), /Answer and resume GY-20/);
  // No overdue timer on parked, backlog or not-yet-started work, however long it has waited.
  const stale = (item: Work) => ({ ...item, stageEnteredAt: new Date(NOW - 50 * hour).toISOString(), createdAt: new Date(NOW - 90 * 24 * hour).toISOString() }) as Work;
  for (const key of ['GY-20', 'GY-11', 'GY-12', 'GY-13']) {
    const item = stale(find(key));
    const group = groupOf(item, NOW, humanOnlyIds([item], []))!;
    assert.ok(!timedGroups.has(group), `${key} (${group}) carries no clock`);
    const html = markup(createElement(WorkCard, { item, now: NOW, onOpen: noop, group }));
    assert.doesNotMatch(html, /overdue/, `${key} row`);
    const detail = itemPage(key, dashboard({ work: board().map(entry => entry.key === key ? item : entry) }));
    assert.doesNotMatch(firstScreen(detail), /overdue/, `${key} item page`);
  }
  // Moving work still carries its clock, red past the threshold.
  assert.match(markup(createElement(WorkCard, { item: stale(find('GY-15')), now: NOW, onOpen: noop })), /overdue/);
});

test('unit:ui-design-system — one navigation and one design system: every status badge renders through the shared component, and no page defines its own status colours', async () => {
  const d = dashboard();
  // One navigation: the sidebar. The sub-page row under a section never repeats a sidebar entry.
  const sidebarLabels = sections.map(section => section.label);
  for (const view of views) assert.ok(!sidebarLabels.includes(view.label as any) || view.id === 'work' || view.id === 'workers' || view.id === 'insights' || view.id === 'tests', `${view.label} is not a second entry for a sidebar item`);
  for (const view of visibleViews(d)) {
    const tabs = [...markup(createElement(TopBar, { ...d, view: view.id }) as any).matchAll(/class="tab(?: active)?"[^>]*>(?:<abbr[^>]*>)?([^<]+)</g)].map(match => match[1]);
    for (const tab of tabs) assert.ok(!sidebarLabels.includes(tab as any), `${view.id}: tab ${tab} overlaps the sidebar`);
  }
  assert.ok(!views.some(view => view.id === 'needs-you' && view.section), 'Needs you is a group on the Work page, not a tab');
  // Every status badge on every page renders through web/components/status-badge.tsx.
  const pages = [home(), ...board().map(item => itemPage(item.key)), markup(createElement(InsightsFlow, d))];
  let badges = 0;
  for (const html of pages) for (const [tag] of html.matchAll(/<[^>]*class="(?:[^"]*\s)?badge(?:\s[^"]*)?"[^>]*>/g)) { badges++; assert.match(tag, /data-status-badge="(needs-you|blocked|moving|up-next|backlog|shipped)"/, tag); }
  assert.ok(badges >= board().length, `every item page shows its badge (${badges})`);
  // No component writes a colour: no hex literal and no inline colour in web/**/*.ts(x).
  const sources = ['web', 'web/pages', 'web/components'].flatMap(dir => readdirSync(new URL(`${dir}/`, root)).filter(name => /\.tsx?$/.test(name)).map(name => `${dir}/${name}`));
  for (const path of sources) {
    const source = (await read(path)).replace(/PR #\$?\{?[\w.]*\}?|#\d+/g, '');
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/, `${path} defines no colour`);
    assert.doesNotMatch(source, /\b(?:color|background|fill|stroke|borderColor)\s*:\s*['"](?!var\(|color-mix\(|currentColor|transparent)/, `${path} writes no inline colour`);
    if (path !== 'web/components/status-badge.tsx') assert.doesNotMatch(source, /className=[{"`'][^}]*\bbadge-(needs-you|blocked|moving|up-next|backlog|shipped)/, `${path} draws no badge of its own`);
  }
  // Spacing, radius and type scale are shared tokens too.
  const css = await read('web/style.css');
  for (const token of ['--space-1', '--space-4', '--radius', '--type-title', '--type-body', '--font-sans', '--font-mono']) assert.match(css, new RegExp(`${token}:`), token);
});

test('unit:ui-item-first-screen — an item page says on its first screen what state it is in, why, which named role acts next and its pull request once, in plain words with no internal jargon; the guide is under 300 words', () => {
  const roles = ['You', 'Builder agent', 'Reviewer agent', 'Prover agent', 'Automated checks', 'Graphyard (automatic)', 'Graphyard (assigns a builder)', 'Master agent', 'Nobody yet', 'Nobody — it is live', 'Nobody — it has merged'];
  const banned = [...jargon, 'session kind', 'epoch', 'lease', 'candidate'];
  for (const item of board()) {
    const screen = firstScreen(itemPage(item.key));
    const words = visibleWords(screen).join(' ');
    // State: the group's badge.
    assert.match(screen, /data-status-badge="[\w-]+"/, `${item.key} state`);
    // Why: one status sentence.
    assert.equal((screen.match(/class="status-sentence/g) ?? []).length, 1, `${item.key} why`);
    // Who acts next, as a named role.
    const who = /Who acts next:<\/span> <strong>([^<]+)<\/strong>/.exec(screen)?.[1];
    assert.ok(who && roles.includes(who), `${item.key} names a role: ${who}`);
    // Never a worker's code name.
    for (const name of [item.lastAssignment?.displayName, item.lastAssignment?.owner, item.lease?.owner].filter(Boolean)) assert.ok(!words.includes(name!), `${item.key} does not name ${name}`);
    // The pull request, linked once.
    const links = (screen.match(/aria-label="PR #\d+, open pull request/g) ?? []).length;
    assert.equal(links, item.candidate ? 1 : 0, `${item.key} links its pull request once`);
    assert.equal(words.split(/\s+/).filter((word: string) => /^#\d+$/.test(word)).length, item.candidate ? 1 : 0, `${item.key} shows its PR number once`);
    // No internal vocabulary in the default copy.
    for (const term of banned) assert.ok(!new RegExp(`\\b${term}`, 'i').test(words), `${item.key}: "${term}" in ${words}`);
  }
  // The why and the next step in plain words for the three cases a newcomer meets most.
  assert.match(firstScreen(itemPage('GY-20')), /Waiting on your decision about spending money or opening third-party accounts/);
  assert.match(firstScreen(itemPage('GY-17')), /Needs a second Postgres instance/);
  assert.match(firstScreen(itemPage('GY-22')), /Testing · 1 of 2 checks done/);
  // GY-22 waits on CI and on review; the page shows Test as current, so what is left is the test step's, not the review's.
  const left = /aria-label="What is left"[\s\S]*?<\/section>/.exec(itemPage('GY-22'))?.[0] ?? '';
  assert.match(left, /test/i); assert.doesNotMatch(left, /approv|review/i);
  // Review status is the review gate's verdict, whichever provider gave it.
  const reviewRow = (item: Work) => /<dt>Review<\/dt><dd>([^<]+)<\/dd>/.exec(markup(createElement(WorkDetails, { ...dashboard({ work: board().map(entry => entry.key === item.key ? item : entry) }), item })))?.[1];
  const codex = { ...find('GY-16'), policy: { ...find('GY-16').policy, reviewProvider: 'codex' }, observation: { ...find('GY-16').observation!, reviews: [] } } as Work;
  assert.equal(reviewRow(codex), 'Approved', 'a Codex approval, recorded outside GitHub reviews, reads as approved');
  assert.equal(reviewRow(find('GY-22')), 'Waiting for approval');
  const changes = { ...find('GY-21'), gates: find('GY-21').gates.map(gate => gate.name === 'review' ? { ...gate, passed: false, reasons: ['Outstanding change requests must be resolved through a new review'] } : gate) } as Work;
  assert.equal(reviewRow(changes), 'Changes requested', 'an approval beside an open change request is not reported as approved');
  // Blocked by a refusal no retry clears (no reviewer left, merge protection unconfirmed): the step's own
  // actor cannot move it, so the master agent acts next, whichever step it is at.
  for (const reason of ['Every configured reviewer profile is exhausted for this item', 'Required Graphyard check and merge-queue branch protection is not verified']) {
    const base = find('GY-22');
    const failing = base.gates.find(gate => !gate.passed)!.name;
    const refused = { ...base, gates: base.gates.map(gate => gate.name === failing ? { ...gate, reasons: [reason] } : gate) } as Work;
    const refusedBoard = board().map(entry => entry.key === base.key ? refused : entry);
    const group = groupWithin(refused, refusedBoard, NOW);
    assert.equal(group, 'blocked', reason);
    assert.equal(nextActor(refused, group, NOW).who, 'Master agent', reason);
    assert.match(firstScreen(itemPage(base.key, dashboard({ work: refusedBoard }))), /Who acts next:<\/span> <strong>Master agent<\/strong>/, reason);
  }
  const guide = visibleWords(markup(createElement(GuidePage)));
  assert.ok(guide.length < 300, `the guide is ${guide.length} words`);
});

test('unit:ui-browser-screenshots — the browser suite captures every page at desktop and phone width, before and after, and every page it lists is in the registry', async () => {
  const spec = await read('browser-tests/screenshots.spec.ts');
  const config = await read('playwright.config.ts');
  assert.match(config, /testDir: '\.\/browser-tests'/, 'the browser suite runs the screenshot spec');
  assert.match(spec, /name: 'desktop', width: 1440/); assert.match(spec, /name: 'phone', width: 390/);
  // It walks the navigation as the dashboard draws it — every sidebar entry and every page under it — plus the linked pages.
  assert.match(spec, /getByRole\('navigation', \{ name: 'Primary' \}\)\.getByRole\('button'\)\.allTextContents\(\)/);
  assert.match(spec, /getByRole\('navigation', \{ name: 'Pages in this section' \}\)/);
  assert.match(spec, /expect\(entries\)\.toEqual\(\['Work', 'Workers', 'Shipped', 'Tests', 'Insights', 'Settings'\]\)/);
  const d = dashboard();
  const entries = views.map(view => primaryEntry(d, view)).filter(Boolean).map(entry => entry!.label);
  for (const label of ['Work', 'Workers', 'Shipped', 'Tests', 'Insights', 'Settings']) assert.ok(entries.includes(label as any), label);
  // The committed images: every page of the registry at both widths, before and after.
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const after = new Set(readdirSync(new URL('browser-tests/screenshots/after/', root)));
  const before = new Set(readdirSync(new URL('browser-tests/screenshots/before/', root)));
  // Validation, Releases and Operator automation are hidden while nothing is configured, as they are over the board fixture.
  const shown = visibleViews(d).filter(view => view.section && !['validation', 'releases', 'automation'].includes(view.id));
  const expected = shown.map(view => {
    const section = sections.find(entry => entry.id === view.section)!;
    return shown.filter(page => page.section === view.section).length > 1 ? `${slug(section.label)}-${slug(view.label)}` : slug(section.label);
  });
  for (const name of [...new Set(expected), 'item-moving', 'item-needs-you', 'item-blocked', 'needs-you', 'guide'])
    for (const viewport of ['desktop', 'phone']) assert.ok(after.has(`${name}-${viewport}.png`), `after/${name}-${viewport}.png`);
  for (const name of ['work', 'item', 'needs-you', 'workers', 'shipped', 'insights', 'settings', 'guide'])
    for (const viewport of ['desktop', 'phone']) assert.ok(before.has(`${name}-${viewport}.png`), `before/${name}-${viewport}.png`);
  // The pre-existing browser tests are still in the suite, next to the screenshots.
  for (const file of ['dashboard.spec.ts', 'flow-analytics.spec.ts', 'attribution.spec.ts', 'screenshots.spec.ts']) assert.ok(existsSync(new URL(`browser-tests/${file}`, root)), file);
});

test('unit:ui-pr-steps — every moving item shows the seven steps from its gates, done, current and pending, with the current step in plain words naming what it waits on', () => {
  const work = board();
  const withReasons = (item: Work, reasons: Record<string, string[]>) => ({ ...item, gates: item.gates.map(gate => reasons[gate.name] ? { ...gate, passed: reasons[gate.name].length === 0, reasons: reasons[gate.name] } : gate) }) as Work;
  const handedIn = find('GY-22', work);
  const ci = (name: string) => `Required CI check ${name} has not passed on the current candidate`;
  const cases: [string, Work, string, string, string][] = [
    ['worker building', find('GY-14', work), 'build', 'Building · the builder is writing the code', 'Builder agent'],
    ['scope check', withReasons(handedIn, { build: ['Candidate diff has not been compared with the planned files'] }), 'validate', 'Validating · checking which files it changes', 'Graphyard (automatic)'],
    ['out of scope', withReasons(handedIn, { build: ['Candidate changes 2 files outside plannedFiles: a, b'] }), 'validate', 'Validating · it changes files outside its plan', 'Builder agent'],
    ['CI running', handedIn, 'test', 'Testing · 1 of 2 checks done', 'Automated checks'],
    ['CI failed', { ...handedIn, observation: { ...handedIn.observation!, checks: [{ name: 'test', result: 'failure', appId: 1 }, { name: 'typecheck', result: 'success', appId: 1 }] } } as Work, 'test', 'Testing · the check test failed', 'Builder agent'],
    ['CI re-run after a failure', { ...handedIn, observation: { ...handedIn.observation!, checks: [{ name: 'test', result: 'failure', appId: 1, id: 1 }, { name: 'test', result: 'in_progress', appId: 1, id: 2 }, { name: 'typecheck', result: 'success', appId: 1, id: 3 }] } } as Work, 'test', 'Testing · 1 of 2 checks done', 'Automated checks'],
    ['CI re-run after a success', withReasons({ ...handedIn, observation: { ...handedIn.observation!, checks: [{ name: 'test', result: 'success', appId: 1, id: 1 }, { name: 'test', result: 'queued', appId: 1, id: 2 }, { name: 'typecheck', result: 'in_progress', appId: 1, id: 3 }] } } as Work, { test: [ci('test'), ci('typecheck')] }), 'test', 'Testing · 0 of 2 checks done', 'Automated checks'],
    ['CI fixed on a re-run', withReasons({ ...handedIn, observation: { ...handedIn.observation!, checks: [{ name: 'test', result: 'failure', appId: 1, id: 1 }, { name: 'test', result: 'success', appId: 1, id: 2 }, { name: 'typecheck', result: 'in_progress', appId: 1, id: 3 }] } } as Work, { test: [ci('typecheck')] }), 'test', 'Testing · 1 of 2 checks done', 'Automated checks'],
    // Only the trusted CI App's runs count, as in the test gate, whose reasons name the checks not yet passed:
    // a newer run of the same name from another App neither completes a check nor fails it.
    ['CI pending behind an untrusted success', withReasons({ ...handedIn, observation: { ...handedIn.observation!, checks: [{ name: 'test', result: 'in_progress', appId: 1, id: 1 }, { name: 'test', result: 'success', appId: 99, id: 2 }, { name: 'typecheck', result: 'success', appId: 1, id: 3 }] } } as Work, { test: [ci('test')] }), 'test', 'Testing · 1 of 2 checks done', 'Automated checks'],
    ['CI pending behind an untrusted failure', withReasons({ ...handedIn, observation: { ...handedIn.observation!, checks: [{ name: 'test', result: 'queued', appId: 1, id: 1 }, { name: 'test', result: 'failure', appId: 99, id: 2 }, { name: 'typecheck', result: 'success', appId: 1, id: 3 }] } } as Work, { test: [ci('test')] }), 'test', 'Testing · 1 of 2 checks done', 'Automated checks'],
    ['CI failed behind an untrusted success', withReasons({ ...handedIn, observation: { ...handedIn.observation!, checks: [{ name: 'test', result: 'failure', appId: 1, id: 1 }, { name: 'test', result: 'success', appId: 99, id: 2 }, { name: 'typecheck', result: 'success', appId: 1, id: 3 }] } } as Work, { test: [ci('test')] }), 'test', 'Testing · the check test failed', 'Builder agent'],
    // No trusted run yet, only another App's failure under the same name: the gate says only that the trusted check has not passed.
    ['CI absent from the trusted App behind an untrusted failure', withReasons({ ...handedIn, observation: { ...handedIn.observation!, checks: [{ name: 'test', result: 'failure', appId: 99, id: 2 }, { name: 'typecheck', result: 'success', appId: 1, id: 3 }] } } as Work, { test: [ci('test')] }), 'test', 'Testing · 1 of 2 checks done', 'Automated checks'],
    ['review requested', find('GY-15', work), 'review', 'Reviewing · waiting for the reviewer', 'Reviewer agent'],
    ['proofs pending', find('GY-16', work), 'prove', 'Proving · 2 of 3 proofs passed', 'Prover agent'],
    // An obligation inherited from another change's deferred proof counts in the total and stays open until proven.
    ['proofs pending on an inherited obligation', withReasons(find('GY-16', work), { acceptance: ['Bootstrap obligation inherited from GY-9 AC-2: integration:contract needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'] }), 'prove', 'Proving · 3 of 4 proofs passed', 'Prover agent'],
    ['proofs no longer independent', withReasons(find('GY-16', work), { acceptance: [`Trusted ${find('GY-16', work).criteria[0].proofs[0]} evidence from producer-1 is no longer independent: producer-1 has since held an assignment on GY-16`] }), 'prove', 'Proving · 2 of 3 proofs passed', 'Prover agent'],
    ['merging', find('GY-21', work), 'merge', 'Merging · Graphyard is merging it', 'Graphyard (automatic)'],
    ['queued to merge', withReasons(find('GY-21', work), { merge: ['Merge queue position 2 of 3: GY-5 is ahead'] }), 'merge', 'Merging · 2nd in line, after GY-5', 'Graphyard (automatic)'],
    // Deploy is a step only where the policy asks for the check after deploying (GY-161, AC-11).
    ['deploying', { ...find('GY-18', work), policy: { ...find('GY-18', work).policy, deploySmoke: true }, delivery: { ...find('GY-18', work).delivery!, deployment: undefined } } as Work, 'deploy', 'Deploying · waiting for the live release to serve it', 'Graphyard (automatic)'],
    ['checking the live release', { ...find('GY-18', work), policy: { ...find('GY-18', work).policy, deploySmoke: true } } as Work, 'deploy', 'Deploying · checking the live release', 'Prover agent'],
    // A change request sends it back to the builder: the item waits at Build, not at Review.
    ['changes requested', withReasons(find('GY-15', work), { review: ['Outstanding change requests must be resolved through a new review'] }), 'build', 'Building · sent back for changes, waiting for a builder', 'Graphyard (assigns a builder)'],
  ];
  // The CI Apps the test gate trusts, as status carries them.
  const trusted = { ...noRelease, ciAppIds: [1] };
  for (const [name, item, current, label, who] of cases) {
    const steps = prSteps(item, NOW, trusted);
    assert.deepEqual(steps.steps.map(step => step.id), [...stepIds], name);
    assert.deepEqual(steps.steps.map(step => step.label), ['Build', 'Validate', 'Test', 'Review', 'Prove', 'Merge', 'Deploy']);
    assert.equal(steps.current, current, name); assert.equal(steps.label, label, name); assert.equal(steps.who, who, name);
    const at = stepIds.indexOf(current as any);
    assert.equal(steps.steps.filter(step => step.state === 'current').length, 1, `${name}: one current step`);
    for (const step of steps.steps.slice(0, at)) assert.equal(step.state, 'done', `${name}: ${step.id} before the current step is done`);
    assert.equal(steps.steps[stepIds.length - 1].state, current === 'deploy' ? 'current' : 'pending', `${name}: deploy`);
  }
  // A shipped item the live release serves has every step done.
  assert.ok(prSteps(find('GY-18', work), NOW).steps.every(step => step.state === 'done'));
  // The Work page row, the phone card (the same element, laid out as a card) and the item page draw the same steps.
  for (const key of ['GY-14', 'GY-15', 'GY-16', 'GY-21', 'GY-22']) {
    const steps = prSteps(find(key, work), NOW);
    const row = markup(createElement(WorkCard, { item: find(key, work), now: NOW, onOpen: noop }));
    assert.equal((row.match(/data-step="/g) ?? []).length, 7, `${key} row shows seven steps`);
    assert.match(row, new RegExp(`data-step="${steps.current}" data-state="current"`));
    assert.ok(row.includes(steps.label), `${key} row labels the current step`);
    const detail = firstScreen(itemPage(key));
    assert.match(detail, /aria-label="Pull request steps"/);
    assert.match(detail, new RegExp(`data-step="${steps.current}" data-state="current"`), `${key} item page`);
  }
  const css = readdirSync(new URL('web/', root)).includes('style.css');
  assert.ok(css);
});

test('unit:ui-insights-flow — Insights shows a Now view at each item\'s true step and a 24-hour replay built only from recorded step transitions, with rework returning to Build, and every animation off under prefers-reduced-motion', async () => {
  // The recorded history: the steps drill-down rows, one per recorded move between steps.
  const rows = [
    { workKey: 'GY-15', observedAt: new Date(NOW - 30 * hour).toISOString(), detail: 'outside to build' },
    { workKey: 'GY-15', observedAt: new Date(NOW - 20 * hour).toISOString(), detail: 'build to test' },
    { workKey: 'GY-16', observedAt: new Date(NOW - 10 * hour).toISOString(), detail: 'test to prove' },
    { workKey: 'GY-16', observedAt: new Date(NOW - 8 * hour).toISOString(), detail: 'prove to build' },
    { workKey: 'GY-16', observedAt: new Date(NOW - 6 * hour).toISOString(), detail: 'build to validate' },
    { workKey: 'GY-18', observedAt: new Date(NOW - 2 * hour).toISOString(), detail: 'merge to deploy' },
    { workKey: 'GY-19', observedAt: new Date(NOW - hour).toISOString(), detail: 'review to review' },
  ];
  const transitions = transitionsFromRows(rows);
  assert.deepEqual(transitions.map(t => `${t.key}:${t.from}>${t.to}`), ['GY-15:null>build', 'GY-15:build>test', 'GY-16:test>prove', 'GY-16:prove>build', 'GY-16:build>validate', 'GY-18:merge>deploy']);
  const frames = replayFrames(transitions, NOW);
  // Every frame is one recorded transition inside the last 24 hours, in order; nothing is invented.
  const inWindow = transitions.filter(t => Date.parse(t.at) > NOW - 24 * hour);
  assert.equal(frames.length, inWindow.length);
  frames.forEach((frame, index) => { assert.equal(frame.source, inWindow[index]); assert.equal(frame.step, frame.source.to); assert.equal(frame.at, Date.parse(frame.source.at)); });
  assert.ok(frames.every((frame, index) => index === 0 || frame.t >= frames[index - 1].t) && frames.every(frame => frame.t > 0 && frame.t <= 1));
  // Rework is a recorded return to Build, and only that.
  assert.deepEqual(frames.filter(frame => frame.rework).map(frame => `${frame.key}:${frame.source.from}>${frame.step}`), ['GY-16:prove>build']);
  // A dot stands where its latest recorded transition put it, and moves only at a transition.
  const at = (t: number) => Object.fromEntries([...positionsAt(frames, t)].map(([key, value]) => [key, `${value.step}${value.rework ? '!' : ''}`]));
  assert.deepEqual(at(0.2), { 'GY-15': 'test' });
  assert.deepEqual(at((24 - 7) / 24), { 'GY-15': 'test', 'GY-16': 'build!' });
  assert.deepEqual(at(1), { 'GY-15': 'test', 'GY-16': 'validate', 'GY-18': 'deploy' });
  // The recorded moves are read from the control plane's own gate facts by the same rule the Now
  // view uses: replaying the board's whole recorded history leaves every item in the flow at
  // exactly the step prSteps shows — GY-22, refused by both CI and review, at Test, not Review.
  const recorded = boardApi('analytics/flow/drilldown?window=7&metric=steps') as { rows: { workKey: string; observedAt: string | null; detail: string }[] };
  const replayed = positionsAt(replayFrames(transitionsFromRows(recorded.rows), NOW, 60 * 24 * hour), 1);
  const { byGroup: flowGroups } = classify(board(), NOW);
  for (const item of [...flowGroups.moving, ...flowGroups.blocked]) assert.equal(replayed.get(item.key)?.step, prSteps(item, NOW).current, `${item.key} replays to its true step`);
  assert.equal(replayed.get('GY-22')?.step, 'test');
  // The recorded release serving a merge takes its dot from Deploy out of the flow, as the Now view drops it.
  const shipped = board().filter(item => groupOf(item, NOW) === 'shipped');
  assert.ok(shipped.length > 0);
  for (const item of shipped) assert.equal(replayed.get(item.key), undefined, `${item.key} is out of the flow`);
  // (GY-9's fixture history records its creation after its merge, so only GY-18 and GY-19 leave Deploy at their release.)
  for (const key of ['GY-18', 'GY-19'])
    assert.ok(recorded.rows.some(row => row.workKey === key && row.detail === 'deploy to outside' && row.observedAt === find(key).delivery!.deployment!.observedAt), `${key} leaves Deploy when the release serves it`);
  // Time per step is measured over those same moves: Validate and Deploy get their own time, and
  // Deploy's is the wait from the merge to the recorded release (ten minutes on this board).
  const report = boardApi('analytics/flow?window=7') as { stepDwell: { step: string; n: number; medianMs: number | null }[] };
  assert.deepEqual(report.stepDwell.map(entry => entry.step), [...stepIds]);
  const deploy = report.stepDwell.find(entry => entry.step === 'deploy')!;
  assert.ok(deploy.n >= 2); assert.equal(deploy.medianMs, 10 * 60_000);
  const since = new Date(NOW - 3 * hour).toISOString();
  const recent = boardApi(`analytics/flow/drilldown?window=7&metric=steps&key=${encodeURIComponent(since)}`) as typeof recorded;
  assert.ok(recent.rows.length < recorded.rows.length && recent.rows.every(row => Date.parse(row.observedAt!) >= Date.parse(since)), 'the key leaves out moves before the instant');
  // The page reads exactly that recorded history, and the Now view places each open item at its true step.
  const source = await read('web/pages/insights-flow.tsx');
  assert.match(source, /readStepRows\(api, since\)/);
  assert.match(await read('web/step-moves.ts'), /analytics\/flow\/drilldown\?window=7&metric=steps\$\{key \? `&key=\$\{encodeURIComponent\(key\)\}` : ''\}/);
  assert.match(source, /replayFrames\(transitionsFromRows\(moves\.rows\), now\)/);
  assert.match(source, /analytics\/flow\?window=7/); assert.match(source, /report\?\.throughput/); assert.match(source, /report\?\.stepDwell/); assert.doesNotMatch(source, /stageDwell|stageStep/);
  const page = markup(createElement(InsightsFlow, dashboard()));
  for (const text of ['Now', 'Last 24 hours, replayed', 'Landed on main per day', 'Where the time goes']) assert.ok(page.includes(text), text);
  const now = [...page.matchAll(/class="now-dot[^"]*" data-step="([\w-]+)" data-key="([^"]+)"/g)].map(match => [match[2], match[1]]);
  const { byGroup } = classify(board(), NOW);
  assert.deepEqual(now.map(([key]) => key).sort(), [...byGroup.moving, ...byGroup.blocked].map(item => item.key).sort());
  for (const [key, step] of now) assert.equal(step, prSteps(find(key), NOW).current, `${key} at its true step`);
  // However many items share a step, each Now dot has its own place in that step's column.
  const crowd = Array.from({ length: 8 }, (_, index) => ({ ...find('GY-15'), id: `crowd-${index}`, key: `GY-${70 + index}` })) as Work[];
  const crowded = markup(createElement(InsightsFlow, dashboard({ work: [...board(), ...crowd] })));
  const places = [...crowded.matchAll(/class="now-dot[^"]*" data-step="([\w-]+)" data-key="[^"]+" data-row="(\d+)" style="left:([^;]+);top:(\d+)px"/g)].map(match => `${match[3]}|${match[4]}`);
  assert.equal(places.length, [...crowded.matchAll(/class="now-dot/g)].length);
  assert.ok(places.length >= 9); assert.equal(new Set(places).size, places.length, 'no two Now dots overlap');
  // The replay gives every item it plays its own row too, however many moved in the day: no thirteenth dot lands on the first.
  const busyDay = replayFrames(Array.from({ length: 30 }, (_, index) => ({ key: `GY-${200 + index}`, from: null, to: 'build' as const, at: new Date(NOW - (index + 1) * 600_000).toISOString() })), NOW);
  const lane = markup(createElement(ReplayLane, { frames: busyDay, t: 1 }));
  const replayPlaces = [...lane.matchAll(/class="replay-dot[^"]*" data-key="[^"]+" data-step="[\w-]+" data-row="(\d+)" style="left:([^;]+);top:(\d+)px"/g)].map(match => `${match[2]}|${match[3]}`);
  assert.equal(replayPlaces.length, 30); assert.equal(new Set(replayPlaces).size, 30, 'no two replay dots overlap');
  const laneHeight = Number(lane.match(/height:(\d+)px/)![1]);
  assert.ok(Math.max(...replayPlaces.map(place => Number(place.split('|')[1]))) < laneHeight, 'the replay lane grows to hold every row');
  // On a phone the step heads keep the seven columns the lanes below are drawn in.
  const cssFlow = await read('web/style.css');
  assert.deepEqual([...cssFlow.matchAll(/\.flow-columns-head\{[^}]*grid-template-columns:repeat\((\d+)/g)].map(match => match[1]), ['7']);
  assert.match(cssFlow, /\.flow-lane\{[^}]*calc\(100%\/7 - 1px\)/);
  // Time per step honours the report's stage filter, like every other item-scoped figure.
  const dwellItem = (id: string, stage: string) => ({ id, key: id, stage, type: 'feature', createdAt: new Date(NOW - 10 * hour).toISOString(), stageEnteredAt: new Date(NOW - hour).toISOString(), policy: {}, gates: [], criteria: [] }) as unknown as Work;
  const fact = (workId: string, kind: string, ago: number, details: Record<string, unknown>) => ({ workId, workKey: workId, kind, observedAt: new Date(NOW - ago * hour).toISOString(), recordedAt: new Date(NOW - ago * hour).toISOString(), source: 'graphyard', details, dedupe: `${kind}:${workId}:${ago}` });
  const merging = dwellItem('A', 'merge'), reviewing = dwellItem('B', 'review');
  const dwellFacts = [fact('A', 'gates.changed', 3, { hasCandidate: false, unmet: ['build'] }), fact('A', 'gates.changed', 2, { hasCandidate: true, unmet: ['test'] }), fact('A', 'gates.changed', 1, { hasCandidate: true, unmet: ['merge'] }),
    fact('B', 'gates.changed', 5, { hasCandidate: false, unmet: ['build'] }), fact('B', 'gates.changed', 1, { hasCandidate: true, unmet: ['review'] })];
  const dwellSet = { observedAt: new Date(NOW).toISOString(), from: new Date(NOW - 7 * 24 * hour).toISOString(), to: new Date(NOW).toISOString(), days: 7, work: [merging, reviewing], included: [merging, reviewing], facts: dwellFacts,
    latest: [fact('A', 'work.created', 10, {}), fact('B', 'work.created', 10, {}), fact('A', 'stage.changed', 1, { to: 'merge' }), fact('B', 'stage.changed', 1, { to: 'review' })], carryIn: [], deployments: [], mergedForDeployments: [],
    scanned: dwellFacts.length, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false, projection: { lastEvent: 0, updatedAt: new Date(NOW).toISOString(), pendingEvents: 0, pendingCapped: false } } as any;
  const buildDwell = (stage?: string) => computeFlow(dwellSet, { days: 7, stage } as any).stepDwell.find(entry => entry.step === 'build')!;
  assert.equal(buildDwell().n, 2);
  assert.equal(buildDwell('merge').n, 1); assert.equal(buildDwell('merge').medianMs, hour, 'only the item in the filtered stage');
  // Motion is disabled under prefers-reduced-motion, in the stylesheet and in the replay itself.
  const css = await read('web/style.css');
  const rule = /@media \(prefers-reduced-motion: reduce\)\{([^@]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /animation:none!important/); assert.match(rule, /transition:none!important/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  // Pressing Play cannot start it either: the button is not offered and the frame loop never runs.
  assert.match(source, /if \(!playing \|\| reducedMotion\(\)\) return;/);
  assert.match(source, /\{!reducedMotion\(\) && <button[^>]*onClick=\{\(\) => \{ if \(t >= 1\) setT\(0\); setPlaying/);
});

test('unit:ui-matches-design — the shared tokens and IBM Plex fonts are the only colour and font definitions in web/style.css, and the sidebar lists exactly Work, Workers, Shipped, Tests, Insights and Settings', async () => {
  const css = await read('web/style.css');
  const tokens = { bg: '#0f1411', surface: '#121915', raised: '#161d18', border: '#2a352d', text: '#e3eae2', 'text-2': '#a3b0a5', 'needs-you': '#e8b45a', blocked: '#ef8a6b', moving: '#7fb8f0', 'up-next': '#c5e69b', shipped: '#8fcf8a' };
  const rootBlock = /\n:root\{([^}]*)\}/.exec(css)![1];
  for (const [name, value] of Object.entries(tokens)) assert.match(rootBlock, new RegExp(`--${name}:${value}[;}]`), `--${name}`);
  assert.match(rootBlock, /--backlog:var\(--text-2\)/, 'Backlog is the dashed grey');
  // The only colour literals in the stylesheet are those tokens, each defined once, in :root.
  const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(match => match[0].toLowerCase());
  assert.deepEqual([...literals].sort(), Object.values(tokens).sort(), 'no colour outside the tokens');
  assert.equal([...rootBlock.matchAll(/#[0-9a-f]{6}/g)].length, literals.length, 'every colour literal sits in :root');
  for (const pattern of [/\brgba?\(/, /\bhsla?\(/, /(?:color|background|border(?:-[a-z]+)?|fill|stroke|box-shadow)\s*:[^;}]*\b(?:black|white|red|green|blue|gray|grey|orange|yellow)\b/])
    assert.doesNotMatch(css, pattern, `no ${pattern} colour`);
  // Fonts: IBM Plex Sans, Plex Mono for keys and commits, and nothing else.
  assert.match(rootBlock, /--font-sans:'IBM Plex Sans',/); assert.match(rootBlock, /--font-mono:'IBM Plex Mono',/);
  for (const [, value] of css.matchAll(/font-family:([^;}]+)/g)) assert.match(value.trim(), /^var\(--font-(sans|mono)\)$/, `font-family: ${value}`);
  assert.doesNotMatch(css.replace(rootBlock, ''), /Inter|Georgia|Segoe/, 'no other family');
  // The fonts are self-hosted: the server's Content-Security-Policy admits styles and fonts from
  // its own origin only, so a third-party stylesheet would never load in production.
  const html = await read('web/index.html');
  assert.match(html, /<link rel="stylesheet" href="\/fonts\/plex\.css">/);
  assert.doesNotMatch(html, /https?:\/\//, 'index.html loads nothing from another origin');
  const csp = /'Content-Security-Policy', "([^"]+)"/.exec(await read('src/server/index.ts'))![1];
  assert.match(csp, /default-src 'self'/); assert.match(csp, /style-src 'self'/); assert.doesNotMatch(csp, /font-src|https?:/);
  const faces = await read('web/public/fonts/plex.css');
  assert.doesNotMatch(faces, /https?:\/\//, 'every font file is same-origin');
  assert.deepEqual([...new Set([...faces.matchAll(/font-family:'([^']+)'/g)].map(match => match[1]))], ['IBM Plex Sans', 'IBM Plex Mono']);
  for (const [, file] of faces.matchAll(/url\(\/fonts\/([^)]+)\)/g)) assert.equal((await readFile(new URL(`web/public/fonts/${file}`, root))).subarray(0, 4).toString('latin1'), 'wOF2', file);
  // The sidebar: exactly the approved entries; Tests opens its page (GY-162).
  const d = dashboard();
  const sidebar = markup(createElement(Sidebar, { entries: views.map(view => primaryEntry(d, view)), dashboard: d }));
  const nav = /<nav class="primary-nav" aria-label="Primary">([\s\S]*?)<\/nav>/.exec(sidebar)![1];
  assert.deepEqual([...nav.matchAll(/data-nav="([^"]+)"/g)].map(match => match[1]), ['work', 'workers', 'shipped', 'tests', 'insights', 'settings']);
  assert.deepEqual([...nav.matchAll(/<span>([^<]+)<\/span>/g)].map(match => match[1]), ['Work', 'Workers', 'Shipped', 'Tests', 'Insights', 'Settings']);
  assert.match(nav, /<button[^>]*data-nav="tests"/);
  assert.doesNotMatch(nav, /planned/);
  // Built to the checked-in design: every artboard is in the repository.
  for (const name of ['Main', 'Item', 'Workers', 'Phone', 'Insights', 'System']) assert.ok(existsSync(new URL(`design/dashboard/${name}.dc.html`, root)), name);
  const system = await read('design/dashboard/System.dc.html');
  for (const value of Object.values(tokens)) assert.ok(system.includes(value), `the design system defines ${value}`);
});

/** The part of a page a reader sees without opening anything: every closed <details> reduced to its summary. */
const unopened = (html: string) => html.replace(/<details(?![^>]*\sopen)[^>]*>(<summary>[\s\S]*?<\/summary>)[\s\S]*?<\/details>/g, '$1');

test('unit:ui-workers-page — Workers is one table of agent sessions (agent, role in plain words, item, doing now, since, health); a session the runtime no longer reports is never running; no jargon paragraph and no Principals table on the first screen; no column cut off at 1440px or 390px', async () => {
  const d = dashboard();
  const html = markup(createElement(WorkersPage, d));
  const first = unopened(html);
  // One table on the first screen, with exactly the design's columns.
  assert.equal((first.match(/<table/g) ?? []).length, 1, 'one table');
  assert.match(first, /<table class="sessions-table" aria-label="Agent sessions">/);
  assert.deepEqual([...first.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(match => match[1]), ['Agent', 'Role', 'Working on', 'Doing now', 'Since', 'Health']);
  // The per-account summary and the ended sessions are folded away below it.
  assert.doesNotMatch(first, /aria-label="Principals"/); assert.match(html, /aria-label="Principals"/);
  // Each role in plain words; the item by key and title; what it is doing; since when; health.
  const row = (id: string) => { const start = first.indexOf(`data-session="${id}"`); assert.ok(start >= 0, id); return first.slice(start, first.indexOf('</tr>', start)); };
  assert.deepEqual(Object.values(roleWords).slice(0, 4), ['Builds code', 'Reviews code', 'Proves requirements', 'Approves decisions']);
  const builder = row('s14');
  assert.match(builder, /<td data-label="Role">Builds code<\/td>/);
  assert.match(builder, /<span class="mono">GY-14<\/span> Export monthly reports as CSV<\/button>/);
  assert.match(builder, new RegExp(`<td data-label="Doing now">${prSteps(find('GY-14'), NOW).label}</td>`));
  assert.match(builder, /<td data-label="Since"[^>]*>started <span class="spent">18m 00s<\/span> ago<\/td>/);
  assert.match(builder, /data-health="live"[^>]*><span class="health-dot" aria-hidden="true"><\/span>Seen 1m 00s ago/);
  assert.match(row('r15'), /<td data-label="Role">Reviews code<\/td>/);
  // Recorded running but not seen for forty minutes: stale, in plain words, never running or active.
  const stale = row('s12');
  assert.match(stale, /data-health="stale"[^>]*><span class="health-dot" aria-hidden="true"><\/span>Not seen for 40m 00s/);
  assert.doesNotMatch(stale, /running|Active/i);
  assert.match(first, /2 agent sessions open\. 1 not seen recently\. 2 ended\./);
  // A session the runtime stopped reporting is ended, in plain words, and is not in the open table.
  assert.doesNotMatch(first, /data-session="p16"/);
  assert.match(html, /data-session="p16"[\s\S]*?Ended · stopped responding/);
  assert.match(html, /data-session="a15"[\s\S]*?<td data-label="Role">Approves decisions<\/td>[\s\S]*?<td data-label="Doing now">Approved the rework request<\/td>/);
  // No explanatory jargon on the first screen.
  const words = visibleWords(first).join(' ');
  for (const term of ['principal', 'handle', 'liveness', 'sweep', 'epoch', 'lease', 'pane', 'reconcil']) assert.ok(!new RegExp(term, 'i').test(words), `"${term}" on the first screen: ${words}`);
  // No column is cut off: the table fills its width and wraps its cells, and on a phone each row is a card of labelled cells.
  const css = await read('web/style.css');
  assert.match(css, /\.sessions-table\{width:100%;/);
  assert.match(css, /\.sessions-table td,\.sessions-table th\[scope=row\]\{[^}]*overflow-wrap:anywhere/);
  const phone = /@media\(max-width:650px\)\{\.sessions-table,[^\n]*/.exec(css)?.[0] ?? '';
  assert.match(phone, /display:block;width:100%/); assert.match(phone, /\.sessions-table thead\{display:none\}/); assert.match(phone, /td::before\{content:attr\(data-label\)/);
  for (const label of ['Agent', 'Role', 'Working on', 'Doing now', 'Since', 'Health']) assert.match(builder, new RegExp(`data-label="${label}"`));
  // The browser suite measures it at both widths.
  assert.match(await read('browser-tests/screenshots.spec.ts'), /sessions-table[\s\S]*scrollWidth/);
});

test('unit:ui-review-polish — step names sit over their segments, commits show 8 characters, the current step is where the item waits, no session-kind badge in the sidebar, every phone chip is reachable, and requirements stay collapsed below the first screen', async () => {
  const css = await read('web/style.css');
  // The step names above the Moving rows are the same track as each row's bar: same grid column, same element, one equal share per step.
  const page = home();
  const head = /<div class="row-head"[\s\S]*?<\/div>/.exec(page)?.[0] ?? '';
  assert.match(head, /<span class="row-steps"><span class="steps-track step-names" aria-hidden="true">/);
  assert.deepEqual([...head.matchAll(/class="step-name" data-step="(\w+)">(\w+)</g)].map(match => match[1]), [...stepIds]);
  assert.match(markup(createElement(WorkCard, { item: find('GY-15'), now: NOW, onOpen: noop })), /<span class="row-steps"><span class="steps-bar"[^>]*><span class="steps-track"/);
  assert.match(css, /\.row-head,\.work-row\{display:grid;grid-template-columns:/);
  assert.match(css, /\.steps-track\{display:flex;gap:3px\}\.step-seg\{flex:1;/); assert.match(css, /\.step-name\{flex:1;min-width:0;text-align:center/);
  // The "In step" clock times the step the seven show, from the recorded move into it: GY-22 is
  // in the review stage but waits at Test, and its clock starts when it reached Test.
  const testing = find('GY-22');
  assert.equal(testing.stage, 'review'); assert.equal(prSteps(testing, NOW).current, 'test');
  const reachedTest = new Date(NOW - 95 * 60_000).toISOString();
  const moves = [{ key: 'GY-22', from: 'build' as const, to: 'validate' as const, at: new Date(NOW - 3 * hour).toISOString() }, { key: 'GY-22', from: 'validate' as const, to: 'test' as const, at: reachedTest }];
  assert.equal(stepSince(testing, NOW, moves), reachedTest);
  const clock = stepHeld(testing, NOW, moves);
  assert.equal(clock.minutes, 95);
  const timedRow = /<div class="work-row[^"]*" data-row="GY-22"[\s\S]*?<span class="row-time">([\s\S]*?)<\/span><\/div>/;
  assert.match(timedRow.exec(home(dashboard({ stepMoves: moves })))?.[1] ?? '', new RegExp(`>${clock.text}( overdue)?<`), 'the Work row shows the step clock');
  assert.match(itemPage('GY-22', dashboard({ stepMoves: moves })), new RegExp(`title="${clock.label}"`), 'and the item page the same one');
  // A record behind the live gates (its latest move is to another step) is not the step's start.
  assert.notEqual(stepSince(testing, NOW, [...moves, { key: 'GY-22', from: 'test', to: 'review', at: new Date(NOW - 10 * 60_000).toISOString() }]), new Date(NOW - 10 * 60_000).toISOString());
  // Validate starts at the hand-in, Deploy at the merge, when no recorded move says otherwise.
  const handed = { ...testing, pipeline: { attempts: [], submittedAt: new Date(NOW - 7 * hour).toISOString(), resubmittedAt: new Date(NOW - 2 * hour).toISOString(), reworkRounds: 1, interventions: { blocked: 0, requirements: 0 } }, gates: testing.gates.map(gate => gate.name === 'build' ? { ...gate, passed: false, reasons: ['Pull request has not been independently observed'] } : gate) } as unknown as Work;
  assert.equal(prSteps(handed, NOW).current, 'validate'); assert.equal(stepSince(handed, NOW), new Date(NOW - 2 * hour).toISOString());
  // Commits show 8 characters as their text (GY-168); the whole SHA stays in the title and the link.
  const sha = 'abcdef1234567890abcdef1234567890abcdef12';
  assert.match(markup(createElement(CandidateSha, { repository: 'fixture/shop', sha })), new RegExp(`href="[^"]*/commit/${sha}"[\\s\\S]*<code class="sha" title="${sha}">${sha.slice(0, 8)}</code>`));
  assert.match(css, /code\.sha\{display:inline-block;max-width:8ch;overflow:hidden;white-space:nowrap;/);
  const sources = ['web', 'web/pages', 'web/components'].flatMap(dir => readdirSync(new URL(`${dir}/`, root)).filter(name => /\.tsx?$/.test(name)).map(name => `${dir}/${name}`));
  for (const path of sources) for (const [, count] of (await read(path)).matchAll(/(?:[sS]ha|[tT]ip|[bB]ase)!?\)?\.slice\(0, ?(\d+)\)/g)) assert.equal(count, '8', `${path} shows ${count} characters of a commit`);
  // After a change request the item waits on its builder: the current step is Build, not Review — on the item and in the recorded history.
  const changes = { ...find('GY-15'), gates: find('GY-15').gates.map(gate => gate.name === 'review' ? { ...gate, passed: false, reasons: ['Outstanding change requests must be resolved through a new review'] } : gate) } as Work;
  assert.equal(prSteps(changes, NOW).current, 'build');
  assert.equal(prSteps(changes, NOW).steps.find(step => step.id === 'review')!.state, 'pending');
  assert.equal(gateFactStep({ stage: 'review', unmet: ['review'], firstUnmet: 'review', reasons: ['Outstanding change requests must be resolved through a new review'], hasCandidate: true }), 'build');
  assert.equal(gateFactStep({ stage: 'review', unmet: ['review'], firstUnmet: 'review', reasons: ['Independent approval of the current commit is required'], hasCandidate: true }), 'review');
  // No session-kind badge in the sidebar, for a human or an AI session.
  for (const kind of ['human', 'ai']) {
    const d = dashboard({ status: { ...boardStatus(), actor: { id: 'someone', role: 'admin', sessionKind: kind } } });
    const sidebar = markup(createElement(Sidebar, { entries: views.map(view => primaryEntry(d, view)), dashboard: d }));
    assert.doesNotMatch(sidebar, /class="identity|Human|\bAI\b|Session kind/, kind);
    assert.match(sidebar, /someone · admin/);
  }
  // On a phone the group chips wrap, so every one is reachable.
  const phone = css.slice(css.indexOf('/* Phone: the sidebar folds into a menu'));
  assert.match(phone, /\.tiles\{flex-wrap:wrap;/);
  assert.doesNotMatch(/\.tiles\{[^}]*\}/.exec(phone)![0], /overflow-x|nowrap/);
  // Requirements stay below the first screen (the summary: where it is now) and after what is left; each criterion is one
  // line there (GY-171 AC-1), and its full text is collapsed behind a closed <details>.
  const item = itemPage('GY-16');
  assert.match(item, /<section class="panel requirements" aria-label="Requirements"><h2>Requirements <small>3 · 2 of 3 proofs passed<\/small><\/h2>/);
  assert.ok(item.indexOf('aria-label="Where it is now"') < item.indexOf('aria-label="What is left"') && item.indexOf('aria-label="What is left"') < item.indexOf('aria-label="Requirements"'));
  const summary = visibleWords(item.slice(0, item.indexOf('aria-label="What is left"'))).join(' ');
  for (const ac of find('GY-16').criteria) assert.ok(!summary.split(' ').includes(ac.id), `${ac.id} is below the first screen`);
  assert.equal(item.match(/<details class="criterion-full"><summary>/g)?.length, find('GY-16').criteria.length, 'every full text folded');
});


test('unit:ui-delivered-without-deployment-record — a merged item is Shipped whether or not its delivery carries a deployment record: real-shaped deliveries without one never appear in Moving or at Deploy, and Insights counts none of them in the flow', async () => {
  const real = realDeliveredWork() as unknown as Work[];
  // Real-shaped: merged, delivered, no per-item deployment record, and a policy that asks for no post-deployment check.
  for (const item of real) { assert.equal(item.stage, 'done'); assert.ok(item.delivery && !item.delivery.deployment && !item.policy.deploySmoke, item.key); }
  const work = [...board(), ...real];
  const keys = real.map(item => item.key);
  for (const item of real) {
    assert.equal(groupOf(item, NOW), 'shipped', `${item.key} is Shipped`);
    const steps = prSteps(item, NOW);
    assert.equal(steps.current, null, `${item.key} is at no step`);
    assert.ok(steps.steps.every(step => step.state === 'done'), `${item.key} has every step done`);
    // No production observation covers it, so it reads "Merged", not "Live": it left the flow at its
    // merge (`deliveredAt`), but nothing says the release serves it yet (`servedAt` is null).
    assert.equal(steps.label, 'Merged');
    assert.equal(deliveredAt(item), item.delivery!.mergedAt);
    assert.equal(servedAt(item), null); assert.equal(releasedAt(item), null);
    assert.equal(mergedAt(item), Date.parse(item.delivery!.mergedAt));
  }
  // Where the control plane observed a production release serving it, that is when it shipped, and it reads "Live".
  const verified = (environment: string, ago: number) => ({ environment, policyRevision: 1, releaseId: `r-${environment}`, releaseRevision: 1, generation: 1, verifiedAt: new Date(NOW - ago).toISOString(), interval: { from: new Date(NOW - ago).toISOString(), to: new Date(NOW).toISOString() } });
  const released = { ...real[0], releaseDeliveries: [verified('production', hour)] } as Work;
  assert.equal(groupOf(released, NOW), 'shipped'); assert.equal(prSteps(released, NOW).label, 'Live'); assert.equal(servedAt(released), new Date(NOW - hour).toISOString());
  // Only the production environment's release counts: an earlier staging release is not the live one.
  const staged = { ...real[0], releaseDeliveries: [verified('staging', 3 * hour), verified('production', hour)] } as Work;
  assert.equal(releaseObservedAt(staged), new Date(NOW - hour).toISOString());
  assert.equal(servedAt({ ...real[0], releaseDeliveries: [verified('staging', hour)] } as Work), null, 'a staging release alone is not live');
  assert.equal(prSteps({ ...real[0], releaseDeliveries: [verified('staging', hour)] } as Work, NOW).label, 'Merged');
  assert.equal(releaseObservedAt({ ...real[0], releaseDeliveries: [verified('eu-live', hour)] } as Work, 'eu-live'), new Date(NOW - hour).toISOString(), 'the configured production environment is the one read');
  // None of them is in an open group, a Moving row or a tile count.
  const { byGroup, open } = classify(work, NOW);
  assert.equal(open, classify(board(), NOW).open, 'no delivered item adds to the open count');
  for (const group of groups) for (const item of byGroup[group]) assert.ok(!keys.includes(item.key), `${item.key} in ${group}`);
  const page = home(dashboard({ work }));
  for (const key of keys) assert.ok(!rowsOf(page, 'moving').includes(key) && !page.includes(`data-row="${key}"`), `${key} has no Work row`);
  assert.equal(tileCount(page, 'moving'), byGroup.moving.length);
  // Shipped this week counts only what the release was seen serving this week (AGENTS.md: a delivery
  // stays pending until the release serves it); the merges not yet seen live are counted apart, from
  // the production observation (GY-168) — with none, the page claims no count.
  const week = 7 * 24 * hour;
  assert.equal(Number(/<strong>(\d+) shipped this week\.<\/strong>/.exec(page)?.[1]), work.filter(item => groupOf(item, NOW) === 'shipped' && releasedAt(item) !== null && NOW - releasedAt(item)! <= week).length);
  assert.ok(real.filter(item => NOW - mergedAt(item) <= week).length >= 3);
  assert.doesNotMatch(page, /data-unreleased=|not yet seen live/);
  // None of them is counted as shipped; the newest merge is named only as the latest merge (GY-168).
  for (const key of keys) assert.doesNotMatch(page.slice(page.indexOf('aria-label="Shipped this week"')).replace(new RegExp(`data-latest="${key}"><span class="mono">${key}</span>[\\s\\S]*?</button> · merged `), ''), new RegExp(`>${key}<`), `${key} is not counted as shipped`);
  const live = home(dashboard({ work: [...board(), ...real.map(item => item.key === real[0].key ? released : item)] }));
  assert.equal(Number(/<strong>(\d+) shipped this week\.<\/strong>/.exec(live)?.[1]), Number(/<strong>(\d+) shipped this week\.<\/strong>/.exec(page)?.[1]) + 1, 'seen live, it counts');
  // Insights: none of them is a Now dot, none is counted in the flow, and the replay takes each out of Deploy.
  const insights = markup(createElement(InsightsFlow, dashboard({ work })));
  for (const key of keys) assert.doesNotMatch(insights, new RegExp(`class="now-dot[^"]*"[^>]*data-key="${key}"`), `${key} is no Now dot`);
  const flowing = [...byGroup.moving, ...byGroup.blocked].filter(item => prSteps(item, NOW).current).length;
  assert.match(insights, new RegExp(`${flowing} items are in the flow now`));
  const api = flowApi(work);
  const recorded = api('analytics/flow/drilldown?window=7&metric=steps') as { rows: { workKey: string; observedAt: string | null; detail: string }[] };
  const replayed = positionsAt(replayFrames(transitionsFromRows(recorded.rows), NOW, 60 * 24 * hour), 1);
  for (const key of keys) assert.equal(replayed.get(key), undefined, `${key} replays out of the flow`);
  for (const key of keys.slice(0, 3)) assert.ok(recorded.rows.some(row => row.workKey === key && row.detail === 'deploy to outside'), `${key} leaves Deploy`);
  // Leaving Deploy is never recorded before the move that put it there, even when the merge time comes first.
  const dataset = { facts: [{ workId: real[0].id, kind: 'gates.changed', observedAt: new Date(NOW - hour).toISOString(), details: { stage: 'done', unmet: ['merge'] } }], carryIn: [] } as any;
  const moves = stepMoves(dataset, { ...real[0], delivery: { ...real[0].delivery!, mergedAt: new Date(NOW - 2 * hour).toISOString() } } as Work);
  assert.deepEqual(moves.map(move => `${move.from}>${move.to}@${(NOW - Date.parse(move.at)) / hour}`), ['null>deploy@1', 'deploy>null@1']);
  // Nothing after the report's cutoff is a move: a report as of two hours ago has neither the gate
  // fact from an hour ago nor a delivery observed after it.
  const asOf = { ...dataset, facts: [{ ...dataset.facts[0], observedAt: new Date(NOW - 3 * hour).toISOString() }], to: new Date(NOW - 2 * hour).toISOString() };
  const later = { ...real[0], delivery: { ...real[0].delivery!, mergedAt: new Date(NOW - hour).toISOString() } } as Work;
  assert.deepEqual(stepMoves(asOf, later).map(move => `${move.from}>${move.to}`), ['null>deploy'], 'a delivery after the cutoff is not in the report');
  assert.deepEqual(stepMoves({ ...asOf, to: new Date(NOW).toISOString() }, later).map(move => `${move.from}>${move.to}`), ['null>deploy', 'deploy>null']);
  assert.deepEqual(stepMoves({ ...dataset, to: new Date(NOW - 2 * hour).toISOString() }, later), [], 'a gate fact after the cutoff is not a move');
  // Only a policy that asks for the post-deployment check keeps a merge at Deploy, while that check is outstanding.
  const smoke = { ...real[0], policy: { ...real[0].policy, deploySmoke: true } } as Work;
  assert.equal(groupOf(smoke, NOW), 'moving'); assert.equal(prSteps(smoke, NOW).current, 'deploy');
  // A Deploy stay that ended before the window opened is not in the window: no carried move, no exit.
  const before = { facts: [], carryIn: [{ workId: real[0].id, kind: 'gates.changed', observedAt: new Date(NOW - 30 * hour).toISOString(), details: { stage: 'done' } }], from: new Date(NOW - 24 * hour).toISOString(), to: new Date(NOW).toISOString() } as any;
  const early = { ...real[0], delivery: { ...real[0].delivery!, mergedAt: new Date(NOW - 28 * hour).toISOString() } } as Work;
  assert.deepEqual(stepMoves(before, early), [], 'a delivery before the window is no move in it');
  assert.deepEqual(stepMoves({ ...before, from: new Date(NOW - 29 * hour).toISOString() }, early).map(move => `${move.from}>${move.to}`), ['null>deploy', 'deploy>null']);
  // Held at Deploy by the production watch, the step clock runs and goes overdue; it settles only once the item leaves the flow.
  const stale = { ...real[0], delivery: { ...real[0].delivery!, mergedAt: new Date(NOW - 48 * hour).toISOString() } } as Work;
  const failing = { ...noRelease, failed: new Set([stale.key]) }, pending = { ...noRelease, unserved: new Set([stale.key]) };
  for (const release of [failing, pending]) { assert.equal(prSteps(stale, NOW, release).current, 'deploy'); assert.equal(stepHeld(stale, NOW, [], release).overdue, true, 'a pending Deploy goes overdue'); }
  assert.equal(stepHeld({ ...stale, policy: smoke.policy } as Work, NOW, []).overdue, true, 'an outstanding smoke check keeps the clock running');
  assert.equal(stepHeld(stale, NOW, []).overdue, false, 'work that left the flow is never overdue');
  // The step history holds a merge at Deploy exactly where the board does (one rule, `flowExitAt`):
  // while the watch reports it pending or failed, or it merged after the watch's last pass.
  const atDeploy = { facts: [{ workId: stale.id, kind: 'gates.changed', observedAt: new Date(NOW - 47 * hour).toISOString(), details: { stage: 'done' } }], carryIn: [] } as any;
  const exits = (production?: typeof noRelease) => stepMoves({ ...atDeploy, production }, stale).map(move => `${move.from}>${move.to}`);
  assert.deepEqual(exits(), ['null>deploy', 'deploy>null'], 'no production observation: the merge leaves Deploy');
  for (const release of [failing, pending, { ...noRelease, observedAt: NOW - 49 * hour }]) {
    assert.deepEqual(exits(release), ['null>deploy'], 'held at Deploy in the history as on the board');
    assert.notEqual(groupOf(stale, NOW, undefined, undefined, release), 'shipped');
  }
  assert.deepEqual(exits({ ...noRelease, observedAt: NOW - hour }), ['null>deploy', 'deploy>null'], 'looked for since, and not reported unserved');
  // The flow API reads the watch's report the same way as the board, so its steps drill-down and
  // step dwell agree with the Now view and each row's clock.
  const watch = { observedAt: new Date(NOW).toISOString(), serving: 'abc', pending: [keys[0]], incidents: [{ key: keys[1] }] };
  const watchView = releaseView({ ...boardStatus(), production: watch });
  assert.deepEqual([...productionHold(watch).unserved], [...watchView.unserved]); assert.deepEqual([...productionHold(watch).failed], [...watchView.failed]);
  assert.equal(groupOf(real[0], NOW, undefined, undefined, watchView), 'moving'); assert.equal(groupOf(real[1], NOW, undefined, undefined, watchView), 'blocked');
  const heldData = { ...flowDataset(work), production: productionHold(watch) };
  const heldRows = flowDrilldown(heldData, computeFlow(heldData, { days: 30 }), { metric: 'steps', key: null, authorized: true }).rows;
  for (const key of keys.slice(0, 2)) assert.ok(!heldRows.some(row => row.workKey === key && row.detail === 'deploy to outside'), `${key} stays at Deploy in the history`);
  assert.ok(heldRows.some(row => row.workKey === keys[2] && row.detail === 'deploy to outside'), `${keys[2]} is not held`);
  // The server's flow route reads the watch itself on each request, never through another route's
  // side effect (integration:flow-analytics-production-hold exercises it end to end).
  assert.match(await read('src/server/routes/flow-analytics.ts'), /production: production\?\.status\(\) \?\? null/);
  // Merges the watch holds at Deploy (Moving, Blocked) are still merged and not yet seen live: the footer counts them.
  const watched = home(dashboard({ work, status: { ...boardStatus(), production: watch } as any }));
  assert.equal(Number(/data-unreleased="(\d+)"/.exec(watched)?.[1]), 2, `${keys[0]} pending and ${keys[1]} failed`);
  // A production incident blocks at Deploy and says so, on the row and the item page — never "Shipped".
  assert.equal(groupOf(stale, NOW, undefined, undefined, failing), 'blocked');
  const row = markup(createElement(WorkCard, { item: stale, now: NOW, onOpen: noop, release: failing }));
  assert.match(row, /Production has not deployed it\./); assert.doesNotMatch(row, /Shipped/);
  const incident = { observedAt: new Date(NOW).toISOString(), serving: 'abc', incidents: [{ key: stale.key }], pending: [] };
  const detail = firstScreen(markup(createElement(WorkDetails, { ...dashboard({ work: [stale], status: { ...boardStatus(), production: incident } as any }), item: stale })));
  assert.match(detail, /Production has not deployed it\./); assert.doesNotMatch(detail, /Shipped in/);
  // What is left names the release-aware Deploy detail, never "nothing blocks it".
  const left = /aria-label="What is left">[\s\S]*?<\/section>/.exec(detail)![0];
  assert.match(left, /<small>1 thing<\/small>/); assert.match(left, /Production has not deployed it\./); assert.doesNotMatch(left, /nothing blocks it/);
});

test('unit:ui-insights-real-items — Insights builds its flow and 24-hour replay from real-shaped items (no observation, no reviews, no candidate) without failing, through the same code path the page reads', async () => {
  const real = realDeliveredWork() as unknown as Work[];
  assert.ok(real.some(item => item.observation === null), 'an item with no observation');
  assert.ok(real.some(item => item.observation && !(item.observation as any).reviews), 'an item whose observation has no reviews');
  assert.ok(real.some(item => item.candidate === null && item.submission === null), 'an item with no candidate');
  // Open items as the real board has them too: building with no observation or candidate yet.
  const building = { ...find('GY-14'), observation: null, candidate: null } as Work;
  assert.equal(building.observation, null);
  const work = [...board().filter(item => item.key !== 'GY-14'), building, ...real];
  // The flow API over these items: the report and the steps drill-down the page reads.
  const api = flowApi(work);
  let report: any, rows: any;
  assert.doesNotThrow(() => { report = api('analytics/flow?window=7'); rows = api(`analytics/flow/drilldown?window=7&metric=steps&key=${encodeURIComponent(new Date(NOW - 24 * hour).toISOString())}`); });
  assert.deepEqual(report.stepDwell.map((entry: any) => entry.step), [...stepIds]);
  assert.ok(Array.isArray(report.throughput) && Array.isArray(rows.rows));
  // The page's own reader, fed by that API, returns the report and replay frames built only from those rows.
  const flow = await readFlow(async (path: string) => api(path), NOW);
  assert.equal(flow.report, report);
  assert.deepEqual(flow.frames.map(frame => frame.source), replayFrames(transitionsFromRows(rows.rows), NOW).map(frame => frame.source));
  assert.ok(flow.frames.some(frame => real.some(item => item.key === frame.key)), 'the real items are in the replay');
  // And a control plane that answers with less — no rows, no figures — still gives an empty replay, not a failure.
  const empty = await readFlow(async () => null, NOW);
  assert.deepEqual(empty, { report: null, frames: [], truncated: false });
  // The same aggregation straight over the real items alone, as the server computes it.
  const dataset = { observedAt: new Date(NOW).toISOString(), from: new Date(NOW - 30 * 24 * hour).toISOString(), to: new Date(NOW).toISOString(), days: 30, work: real, included: real, facts: [], latest: [], carryIn: [], deployments: [], mergedForDeployments: [],
    scanned: 0, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false, projection: { lastEvent: 0, updatedAt: new Date(NOW).toISOString(), pendingEvents: 0, pendingCapped: false } } as any;
  assert.doesNotThrow(() => flowDrilldown(dataset, computeFlow(dataset, { days: 30 } as any), { metric: 'steps', authorized: true }));
  // The page renders over them: the Now view and the charts, without throwing.
  let page = '';
  assert.doesNotThrow(() => { page = markup(createElement(InsightsFlow, dashboard({ work, api: async (path: string) => api(path) }))); });
  for (const text of ['Now', 'Last 24 hours, replayed', 'Landed on main per day', 'Where the time goes']) assert.ok(page.includes(text), text);
  assert.match(page, /data-key="GY-14"/);
});

test('unit:ui-workers-finish — agent names and roles never break mid-word, Health and Since read as relative times, a session the runtime no longer reports is not counted as open, and commit SHAs show 8 characters in the text', async () => {
  const sha = '23d8dfbf674cbc8586cc98238acac9143a1765fa';
  const work = board().map(item => item.key !== 'GY-16' ? item : { ...item, sessions: [...(item.sessions ?? []), {
    id: 'p16b', kind: 'proof', principal: 'production-acceptance-producer', epoch: null, runtime: 'claude', host: 'build-1', workspace: 'w1', tab: null, pane: 'w1:p16b', agentName: null, role: 'proof:unit', head: sha,
    attach: 'herdr pane attach w1:p16b', transcript: null, subject: `GY-16: unit proofs on ${sha.slice(0, 12)} (unit:retry-after-copy)`, startedAt: new Date(NOW - 5 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 12_000).toISOString(), endedAt: null, state: 'running', outcome: null }, {
    id: 'p16c', kind: 'proof', principal: 'production-acceptance-producer', epoch: null, runtime: 'claude', host: 'build-1', workspace: 'w1', tab: null, pane: 'w1:p16c', agentName: null, role: 'proof:unit', head: sha,
    attach: null, transcript: null, subject: `GY-16: unit proofs on ${sha.slice(0, 12)}`, startedAt: new Date(NOW - 3 * hour).toISOString(), updatedAt: new Date(NOW - 2 * hour).toISOString(),
    endedAt: new Date(NOW - 2 * hour).toISOString(), state: 'finished', outcome: `superseded: ${sha} was replaced by the next candidate` }] } as Work);
  const html = markup(createElement(WorkersPage, dashboard({ work })));
  const text = visibleWords(html).join(' ');
  // Commit SHAs are 8 characters in the text itself, not only clipped by the stylesheet.
  assert.ok(text.includes(sha.slice(0, 8)), 'the short SHA is shown');
  assert.doesNotMatch(text, /\b[0-9a-f]{9,}\b/, 'no longer hex run in the page text');
  assert.doesNotMatch(html, new RegExp(sha.slice(0, 9)), 'nor in any attribute');
  assert.equal(shortShas(`on ${sha} and ${sha.slice(0, 12)}; PR #156`), 'on 23d8dfbf and 23d8dfbf; PR #156');
  // Health and Since are relative: "Seen 12s ago", "started 5m 00s ago", never an absolute timestamp.
  const row = (id: string) => { const start = html.indexOf(`data-session="${id}"`); assert.ok(start >= 0, id); return html.slice(start, html.indexOf('</tr>', start)); };
  assert.match(row('p16b'), /<td data-label="Since"[^>]*>started <span class="spent">5m 00s<\/span> ago<\/td>/);
  assert.match(row('p16b'), /data-health="live"[^>]*><span class="health-dot" aria-hidden="true"><\/span>Seen 12s ago<\/span>/);
  assert.match(row('s12'), /Not seen for 40m 00s/);
  assert.match(row('p16c'), /<td data-label="Since"[^>]*>ended 2h 00m 00s ago · ran <span class="spent">1h 00m 00s<\/span><\/td>/);
  const stamps = work.flatMap(item => (item.sessions ?? []).flatMap(handle => [handle.startedAt, handle.updatedAt, handle.endedAt])).filter((at): at is string => !!at);
  for (const at of stamps) { assert.ok(!html.includes(at), at); assert.ok(!html.includes(new Date(at).toLocaleString()), new Date(at).toLocaleString()); }
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}:\d{2}:\d{2}/, 'no date or clock time on the page');
  // A session the runtime no longer reports (s12, not seen for 40 minutes) is listed, marked, and not counted among the open ones.
  const open = work.flatMap(item => item.sessions ?? []).filter(handle => handle.state === 'running');
  assert.equal(open.length, 4);
  assert.match(html, /3 agent sessions open\. 1 not seen recently\. \d+ ended\./);
  assert.doesNotMatch(row('s12'), /running|Active|Seen /);
  // Names and roles never break mid-word: they do not wrap, and the copy links wrap below the name instead of squeezing it.
  const css = await read('web/style.css');
  assert.match(css, /\.sessions-table th\[scope=row\]\[data-label=Agent\],\.sessions-table td\[data-label=Role\]\{overflow-wrap:normal;word-break:keep-all\}/);
  assert.match(css, /\.sessions-table \.agent-name,\.sessions-table td\[data-label=Role\]\{white-space:nowrap\}/);
  assert.match(css, /\.sessions-table \.attach\{display:flex;[^}]*flex-wrap:wrap\}/); assert.match(css, /\.sessions-table \.copy\{[^}]*white-space:nowrap/);
  assert.match(row('s14'), /<th scope="row" data-label="Agent"><span class="mono agent-name"[^>]*>claude-1<\/span><span class="attach">/);
  // The browser suite measures both at 1440px and 390px: each name and role on one line.
  assert.match(await read('browser-tests/screenshots.spec.ts'), /\.sessions-table \.agent-name, \.sessions-table td\[data-label=Role\][\s\S]*getClientRects[\s\S]*toEqual\(\[\]\)/);
});

test('GY-161 review: where the production watch observes production, a merge waits at Deploy until it is served (a failed deployment is Blocked); the configured production environment decides Live; the item page reads its checks from the test gate', async () => {
  const real = realDeliveredWork() as unknown as Work[];
  const [waiting, failing, deployed] = real;
  const status = (production: unknown, productionEnvironment?: string) => ({ ...boardStatus('admin'), production, ...(productionEnvironment ? { productionEnvironment } : {}) });
  const observed = { observedAt: new Date(NOW - 60_000).toISOString(), serving: 'a'.repeat(40), servingSource: 'provider', error: null,
    deployed: [deployed.key], pending: [waiting.key, failing.key], incidents: [{ id: 'i1', workId: failing.id, key: failing.key, status: 'missing', reason: 'no deployment observed' }] };
  const release = releaseView(status(observed));
  // Production observed not serving it yet: Moving, at Deploy, waiting for the release.
  assert.equal(groupOf(waiting, NOW, undefined, undefined, release), 'moving');
  const steps = prSteps(waiting, NOW, release);
  assert.equal(steps.current, 'deploy'); assert.equal(steps.label, 'Deploying · waiting for the live release to serve it'); assert.equal(steps.who, 'Graphyard (automatic)');
  // An open deployment incident: Blocked at Deploy, for the master agent.
  assert.equal(groupOf(failing, NOW, undefined, undefined, release), 'blocked');
  assert.equal(prSteps(failing, NOW, release).label, 'Deploying · production has not deployed it');
  assert.equal(nextActor(failing, 'blocked', NOW, release).who, 'Master agent');
  // Served: Shipped.
  assert.equal(groupOf(deployed, NOW, undefined, undefined, release), 'shipped');
  // The Work page and Insights read the same view from status.
  const work = [...board(), ...real];
  const { byGroup } = classify(work, NOW, undefined, release);
  const page = home(dashboard({ work, status: status(observed) }));
  assert.ok(rowsOf(page, 'moving').includes(waiting.key)); assert.ok(rowsOf(page, 'blocked').includes(failing.key));
  assert.equal(tileCount(page, 'moving'), byGroup.moving.length); assert.equal(tileCount(page, 'blocked'), byGroup.blocked.length);
  assert.match(markup(createElement(InsightsFlow, dashboard({ work, status: status(observed) }))), new RegExp(`class="now-dot[^"]*"[^>]*data-key="${waiting.key}"`));
  // No observation of what production serves (none configured, an unknown serving commit, a failed
  // provider read) holds nothing back: every real-shaped merge stays Shipped (AC-11).
  for (const unknown of [null, { ...observed, serving: null }, { ...observed, error: 'Railway API answered 500' }, { ...observed, observedAt: null }]) {
    const none = releaseView(status(unknown));
    for (const item of real) assert.equal(groupOf(item, NOW, undefined, undefined, none), 'shipped', `${item.key} with ${JSON.stringify(unknown)?.slice(0, 40)}`);
  }
  // The installation's configured production environment is the one a verified release is read under.
  const verified = (environment: string) => ({ environment, policyRevision: 1, releaseId: 'r', releaseRevision: 1, generation: 1, verifiedAt: new Date(NOW - hour).toISOString(), interval: { from: new Date(NOW - hour).toISOString(), to: new Date(NOW).toISOString() } });
  const live = { ...waiting, releaseDeliveries: [verified('graphyard / production')] } as Work;
  const named = releaseView(status(observed, 'graphyard / production'));
  assert.equal(named.environment, 'graphyard / production');
  // The server reads that name per request the way the flow analytics route does — the master's
  // published setting, else its own — and carries it on status.
  assert.match(await read('src/server/routes/status.ts'), /const productionEnvironment = await resolvedProductionEnvironment\(engine\.store\.pool\);[\s\S]*production\?\.status\(\) \?\? null, productionEnvironment,/);
  assert.match(await read('src/server/routes/flow-analytics.ts'), /flowQuery\(url, await resolvedProductionEnvironment\(engine\.store\.reportPool\)\)/);
  assert.equal(releasedAt(live, named), NOW - hour); assert.equal(prSteps(live, NOW, named).label, 'Live');
  assert.equal(groupOf(live, NOW, undefined, undefined, named), 'shipped', 'a verified release outranks a pending watch entry');
  assert.equal(releasedAt(live), null, 'under the default name it is not live');
  const namedStatus = status(null, 'graphyard / production');
  assert.match(markup(createElement(ShippedPage, dashboard({ work: [live], status: namedStatus }))), /data-live="true">Live</);
  const before = Number(/<strong>(\d+) shipped this week\.<\/strong>/.exec(home(dashboard({ work: [...board(), waiting], status: namedStatus })))?.[1]);
  const withLive = home(dashboard({ work: [...board(), live], status: namedStatus }));
  assert.equal(Number(/<strong>(\d+) shipped this week\.<\/strong>/.exec(withLive)?.[1]), before + 1);
  // The footer's "Latest" is the newest merge, dated from that merge, not from the Unix epoch (GY-168).
  const footer = /aria-label="Shipped this week">[\s\S]*$/.exec(withLive)![0];
  assert.match(footer, new RegExp(`data-latest="${live.key}"><span class="mono">${live.key}</span> <span data-title="true">[^<]*</span></button> · merged ${formatAge(mergedAt(live), NOW)} ago`), footer.slice(0, 600));
  // The item page's Checks line reads each check as the test gate does: only the trusted App's runs
  // count, so a newer untrusted run of the same name neither passes nor fails a check.
  const handedIn = find('GY-22');
  const withChecks = (checks: unknown[], test: string[]) => ({ ...handedIn, observation: { ...handedIn.observation!, checks }, gates: handedIn.gates.map(gate => gate.name === 'test' ? { ...gate, passed: test.length === 0, reasons: test } : gate) }) as Work;
  const ci = 'Required CI check test has not passed on the current candidate';
  const cases: [Work, string][] = [
    [withChecks([{ id: 1, name: 'test', result: 'in_progress', appId: 1 }, { id: 2, name: 'test', result: 'success', appId: 99 }, { id: 3, name: 'typecheck', result: 'success', appId: 1 }], [ci]), 'test running · typecheck passed'],
    [withChecks([{ id: 1, name: 'test', result: 'success', appId: 1 }, { id: 2, name: 'test', result: 'failure', appId: 99 }, { id: 3, name: 'typecheck', result: 'success', appId: 1 }], []), 'test passed · typecheck passed'],
    [withChecks([{ id: 1, name: 'test', result: 'failure', appId: 1 }, { id: 3, name: 'typecheck', result: 'success', appId: 1 }], [ci]), 'test failed · typecheck passed'],
    // Only an untrusted App published the named check, and it failed: the trusted check is still to come.
    [withChecks([{ id: 2, name: 'test', result: 'failure', appId: 99 }, { id: 3, name: 'typecheck', result: 'success', appId: 1 }], [ci]), 'test running · typecheck passed'],
  ];
  // The status the item page reads names the trusted CI Apps; the server carries its own list.
  assert.deepEqual(releaseView(boardStatus()).ciAppIds, [1, 15368]);
  assert.match(await read('src/server/routes/status.ts'), /ciAppIds: engine\.ciAppIds/);
  for (const [item, line] of cases) {
    assert.equal(checkStates(item, [1]).map(check => `${check.name} ${check.state}`).join(' · '), line);
    const detail = markup(createElement(WorkDetails, { ...dashboard({ work: [item] }), item }));
    assert.match(detail, new RegExp(`<dt>Checks</dt><dd>${line}</dd>`));
  }
});


test('GY-161 review: a check fails on the latest trusted run across Apps; closed work has no step; a pending rework replays at Build; step moves are read page by page; a merge after the watch\'s last pass waits at Deploy', async () => {
  // The latest run across every trusted App decides, as the test gate's `latestCheck` does: an
  // older pending run from one App never hides a newer failure from another.
  const handedIn = find('GY-22');
  const ci = 'Required CI check test has not passed on the current candidate';
  const withChecks = (checks: unknown[]) => ({ ...handedIn, observation: { ...handedIn.observation!, checks }, gates: handedIn.gates.map(gate => gate.name === 'test' ? { ...gate, passed: false, reasons: [ci] } : gate) }) as Work;
  const trusted = { ...noRelease, ciAppIds: [1, 15368] };
  const newerFailure = withChecks([{ id: 1, name: 'test', result: 'in_progress', appId: 1 }, { id: 2, name: 'test', result: 'failure', appId: 15368 }, { id: 3, name: 'typecheck', result: 'success', appId: 1 }]);
  assert.equal(checkStates(newerFailure, trusted.ciAppIds).find(check => check.name === 'test')!.state, 'failed');
  const failedSteps = prSteps(newerFailure, NOW, trusted);
  assert.equal(failedSteps.current, 'test'); assert.equal(failedSteps.label, 'Testing · the check test failed'); assert.equal(failedSteps.who, 'Builder agent');
  const newerPending = withChecks([{ id: 1, name: 'test', result: 'failure', appId: 1 }, { id: 2, name: 'test', result: 'queued', appId: 15368 }]);
  assert.equal(checkStates(newerPending, trusted.ciAppIds).find(check => check.name === 'test')!.state, 'running', 'a newer re-run replaces the older failure');

  // Closed without merging: no step done or current, never "Merged", nobody acts, no step bar.
  const closed = { ...handedIn, stage: 'done', delivery: undefined, closure: { kind: 'obsolete', ref: null, reason: 'No longer needed', by: 'operator', at: new Date(NOW - hour).toISOString(), from: 'review' } } as unknown as Work;
  const closedSteps = prSteps(closed, NOW);
  assert.equal(closedSteps.current, null); assert.ok(closedSteps.steps.every(step => step.state === 'pending'));
  assert.doesNotMatch(closedSteps.label, /Merged|Live/);
  assert.equal(groupOf(closed, NOW), null);
  assert.doesNotMatch(nextActor(closed, null, NOW).who, /merged/);
  const closedPage = firstScreen(markup(createElement(WorkDetails, { ...dashboard({ work: [...board().filter(item => item.id !== closed.id), closed] }), item: closed })));
  assert.doesNotMatch(closedPage, /class="steps-detail"/); assert.doesNotMatch(closedPage, /Merged/); assert.match(closedPage, /Closed as obsolete/);

  // A pending rework puts the recorded gate fact at Build whichever gate refuses first, as prSteps does.
  const rework = { stage: 'build', unmet: ['build', 'review'], firstUnmet: 'build', reasons: ['Pull request is not mergeable against the current base'], hasCandidate: true };
  assert.equal(gateFactStep(rework), 'validate', 'without the rework the build gate reads as Validate');
  assert.equal(gateFactStep({ ...rework, reworkRequested: true }), 'build');
  const sentBack = { ...handedIn, reworkRequested: true, gates: handedIn.gates.map(gate => gate.name === 'ready' ? { ...gate, passed: false, reasons: ['Lease expired'] } : gate) } as Work;
  assert.equal(prSteps(sentBack, NOW).current, 'build');
  const sentBackRows = flowApi([...board().filter(item => item.id !== sentBack.id), sentBack])('analytics/flow/drilldown?window=7&metric=steps') as { rows: { workKey: string; observedAt: string | null; detail: string }[] };
  assert.equal(positionsAt(replayFrames(transitionsFromRows(sentBackRows.rows), NOW, 60 * 24 * hour), 1).get(sentBack.key)?.step, 'build', 'the replay ends where the live step is');

  // More recorded moves than one drill-down page: every page holds whole items and names the next,
  // and the dashboard's reader follows them to the whole history.
  const many = Array.from({ length: 60 }, (_, index) => board().filter(item => item.stage !== 'backlog').map(item => ({ ...item, id: `${item.id}-${index}`, key: `GY-${1000 + index * 40 + Number(item.key.slice(3))}` }))).flat() as Work[];
  const manyApi = flowApi(many);
  const first = manyApi('analytics/flow/drilldown?window=7&metric=steps') as { rows: { workKey: string; observedAt: string | null; detail: string }[]; truncated: boolean; next: string | null; total: number };
  assert.ok(first.truncated && first.total > 400, `${first.total} rows span several pages`);
  const second = manyApi(`analytics/flow/drilldown?window=7&metric=steps&key=${encodeURIComponent(first.next!)}`) as typeof first;
  const firstKeys = new Set(first.rows.map(row => row.workKey));
  assert.ok(second.rows.every(row => !firstKeys.has(row.workKey)), 'no item is split across pages');
  const whole = await readStepRows(async (path: string) => manyApi(path));
  assert.equal(whole.complete, true); assert.equal(whole.rows.length, first.total);
  // An instant and the cursor combine: the replay's last day, still whole.
  const since = new Date(NOW - 24 * hour).toISOString();
  const recent = await readStepRows(async (path: string) => manyApi(path), since);
  assert.equal(recent.complete, true);
  assert.equal(recent.rows.length, (manyApi(`analytics/flow/drilldown?window=7&metric=steps&key=${encodeURIComponent(since)}`) as typeof first).total);
  assert.ok(recent.rows.every(row => Date.parse(row.observedAt!) >= Date.parse(since)));
  // A control plane that stops naming pages leaves the answer marked incomplete, never taken as whole.
  const stuck = await readStepRows(async () => ({ rows: first.rows, truncated: true, next: null }));
  assert.equal(stuck.complete, false);
  assert.match(await read('web/step-moves.ts'), /readStepRows\(api\)/);
  assert.match(await read('web/pages/insights-flow.tsx'), /readStepRows\(api, since\)/);

  // Where the production watch observes production, a merge after its last pass has not been
  // looked for yet: it waits at Deploy until a live observation is recorded. Older merges the
  // watch does not list (outside its window) and boards with no watch stay Shipped (AC-11).
  const [merged] = realDeliveredWork() as unknown as Work[];
  const lastPass = NOW - 10 * 60_000;
  const watch = releaseView({ ...boardStatus('admin'), production: { observedAt: new Date(lastPass).toISOString(), serving: 'a'.repeat(40), error: null, deployed: [], pending: [], incidents: [] } });
  assert.equal(watch.observedAt, lastPass);
  const fresh = { ...merged, delivery: { ...merged.delivery!, mergedAt: new Date(NOW - 5 * 60_000).toISOString() } } as Work;
  assert.equal(groupOf(fresh, NOW, undefined, undefined, watch), 'moving');
  assert.equal(prSteps(fresh, NOW, watch).current, 'deploy');
  assert.equal(prSteps(fresh, NOW, watch).label, 'Deploying · waiting for the live release to serve it');
  const older = { ...merged, delivery: { ...merged.delivery!, mergedAt: new Date(NOW - 48 * hour).toISOString() } } as Work;
  assert.equal(groupOf(older, NOW, undefined, undefined, watch), 'shipped');
  assert.equal(groupOf(fresh, NOW), 'shipped', 'with no production observation a merge alone is Shipped');
});

test('GY-161 review: a refusing ready gate keeps handed-in work at Build, in the steps and the recorded moves; one item\'s history longer than a drill-down page is read in full, or not at all', async () => {
  // Handed in, then a blocker is recorded or a requirements revision adds a dependency: the ready
  // gate refuses, the control plane's stage is build (src/model/gates.ts), and so is the step.
  const handedIn = find('GY-22');
  assert.notEqual(prSteps(handedIn, NOW).current, 'build', 'handed in, it has moved past Build');
  const refuse = (reasons: string[]) => ({ ...handedIn, stage: 'build', gates: handedIn.gates.map(gate => gate.name === 'ready' ? { ...gate, passed: false, reasons } : gate) }) as Work;
  const blocked = prSteps(refuse(['Staging credentials expired']), NOW);
  assert.equal(blocked.current, 'build'); assert.ok(blocked.steps.slice(1).every(step => step.state === 'pending'));
  assert.equal(blocked.label, 'Building · blocked: Staging credentials expired'); assert.equal(blocked.who, 'Master agent');
  const waiting = prSteps(refuse(['Dependency GY-7 is unfinished']), NOW);
  assert.equal(waiting.current, 'build'); assert.equal(waiting.label, 'Building · waiting for GY-7 to ship first'); assert.equal(waiting.who, 'Graphyard (automatic)');
  assert.equal(stepSince(refuse(['Staging credentials expired']), NOW, [{ key: handedIn.key, at: new Date(NOW - hour).toISOString(), from: 'build', to: 'review' }]), stepSince(refuse(['Staging credentials expired']), NOW), 'Build keeps the builder\'s clock');
  // The recorded gate fact places it the same way, whichever later gate also refuses.
  const fact = { stage: 'build', unmet: ['ready', 'review', 'acceptance'], firstUnmet: 'ready', reasons: ['Dependency GY-7 is unfinished'], hasCandidate: true, dependencyWaiting: ['GY-7'] };
  assert.equal(gateFactStep(fact), 'build');
  assert.equal(gateFactStep({ ...fact, unmet: ['review', 'acceptance'], firstUnmet: 'review' }), 'review', 'once the ready gate passes it is back at its step');
  assert.equal(gateFactStep({ stage: 'ready', unmet: ['ready'], blocker: null }), null, 'not handed in and waiting on a dependency, it is not in the flow');

  // One item with more recorded moves than a drill-down page (flowLimits.drilldown = 200 rows).
  const [long, ...rest] = board().filter(item => item.stage !== 'backlog' && item.stage !== 'done');
  const dataset = flowDataset([long, ...rest]);
  const start = NOW - 5 * 24 * hour;
  for (let index = 0; index < 450; index++)
    dataset.facts.push({ workId: long.id, workKey: long.key, kind: 'gates.changed', observedAt: new Date(start + index * 60_000).toISOString(), details: { stage: index % 2 ? 'review' : 'test', unmet: [index % 2 ? 'review' : 'test'], firstUnmet: index % 2 ? 'review' : 'test', hasCandidate: true, reasons: [] } });
  const report = computeFlow(dataset, { days: 30 });
  const api = (path: string) => { const url = new URL(`http://fixture/${path}`); return flowDrilldown(dataset, report, { metric: 'steps', key: url.searchParams.get('key'), authorized: true }); };
  const own = stepMoves(dataset, long).filter(move => !move.carried);
  assert.ok(own.length > 400, `${own.length} moves for ${long.key}`);
  const first = api('analytics/flow/drilldown?window=7&metric=steps');
  assert.ok(first.truncated);
  const pages = [first];
  while (pages.at(-1)!.truncated) pages.push(api(`analytics/flow/drilldown?window=7&metric=steps&key=${encodeURIComponent(pages.at(-1)!.next!)}`));
  const longRows = pages.flatMap(page => page.rows).filter(row => row.workKey === long.key);
  assert.equal(longRows.length, own.length, 'every move of the long item is on some page');
  assert.ok(pages.some(page => /within:/.test(page.next ?? '')), 'the long item is continued within it');
  assert.equal(new Set(longRows.map(row => `${row.observedAt}|${row.detail}`)).size, longRows.length, 'no move is read twice');
  const latest = own.at(-1)!;
  assert.ok(longRows.some(row => row.observedAt === latest.at && row.detail === `${latest.from ?? 'outside'} to ${latest.to ?? 'outside'}`), 'its latest move is read');
  const whole = await readStepRows(async (path: string) => api(path));
  assert.equal(whole.complete, true);
  assert.equal(whole.rows.length, pages.reduce((sum, page) => sum + page.rows.length, 0));
  assert.equal(whole.rows.filter(row => row.workKey === long.key).length, own.length);
  // A read that stops inside the long item leaves that item out, never takes its first page for all of it.
  const cut = await readStepRows(async (path: string) => { const answer = api(path); return /within:/.test(decodeURIComponent(path)) ? { ...answer, next: null } : answer; });
  assert.equal(cut.complete, false);
  assert.ok(!cut.rows.some(row => row.workKey === long.key), 'the partly read item is left out');
});

test('GY-161 review: a step entered before the drill-down window still starts its clock at its entry; a truncated scan ends every step move where it stopped', () => {
  // At Test since 12 days ago, with gate facts at that step 10 and 9 days ago (other checks changing),
  // and nothing recorded in the 7-day window: the carried move starts at the entry, not at the last fact.
  const testing = board().find(item => prSteps(item, NOW).current === 'test')!;
  const day = 24 * hour;
  const fact = (id: number, ago: number, details: Record<string, unknown>) => ({ id, workId: testing.id, workKey: testing.key, kind: 'gates.changed', observedAt: new Date(NOW - ago).toISOString(), details });
  const atTest = { stage: 'review', unmet: ['test', 'review'], firstUnmet: 'test', hasCandidate: true, reasons: [] };
  const history = [fact(1, 14 * day, { stage: 'build', unmet: ['build'], firstUnmet: 'build', hasCandidate: false, reasons: ['Worker has not submitted implementation for this attempt'] }),
    fact(2, 12 * day, atTest), fact(3, 10 * day, atTest), fact(4, 9 * day, atTest)];
  assert.equal(gateFactStep(atTest), 'test');
  const carryIn = [history.at(-1)!];
  const entries = stepEntries(carryIn as any, history as any);
  assert.equal(entries[testing.id], history[1].observedAt, 'the entry is the oldest fact of the unbroken run at the step');
  const dataset = { ...flowDataset([testing]), facts: [], carryIn, from: new Date(NOW - 7 * day).toISOString(), days: 7, stepEntries: entries };
  const report = computeFlow(dataset, { days: 7 });
  const rows = flowDrilldown(dataset, report, { metric: 'steps', key: null, authorized: true }).rows as { workKey: string; observedAt: string | null; detail: string }[];
  assert.deepEqual(rows.filter(row => row.workKey === testing.key).map(row => [row.observedAt, row.detail]), [[history[1].observedAt, 'outside to test']], 'the drill-down returns the carried entry');
  assert.equal(stepSince(testing, NOW, transitionsFromRows(rows)), history[1].observedAt, 'the "In step" clock starts at the entry, 12 days ago');
  assert.equal(replayFrames(transitionsFromRows(rows), NOW).length, 0, 'an entry before the replay window is not a replay frame');
  // Without the entry lookup (a hand-built dataset), the carried fact's own instant still stands in.
  assert.equal(stepMoves({ ...dataset, stepEntries: undefined }, testing)[0].at, history.at(-1)!.observedAt);

  // A delivered item at Deploy whose merge falls past where a truncated scan stopped: no exit move.
  const [shipped] = realDeliveredWork() as Work[];
  const mergedAt = Date.parse(shipped.delivery!.mergedAt!);
  const deploy = { id: 9, workId: shipped.id, workKey: shipped.key, kind: 'gates.changed', observedAt: new Date(mergedAt - hour).toISOString(), details: { stage: 'done', unmet: [], hasCandidate: true, reasons: [] } };
  const whole = { ...flowDataset([shipped]), facts: [deploy], carryIn: [] };
  assert.deepEqual(stepMoves(whole, shipped).map(move => move.to), ['deploy', null], 'fully covered, the merge takes it out of the flow');
  const covered = coveredWindow(whole.from, whole.to, new Date(mergedAt - 30 * 60_000).toISOString(), 5, 20_000);
  const truncated = { ...whole, covered, truncated: true };
  assert.deepEqual(stepMoves(truncated, shipped).map(move => move.to), ['deploy'], 'an exit past the covered end is not a move');
  const cut = computeFlow(truncated, { days: 30 });
  assert.ok(!(flowDrilldown(truncated, cut, { metric: 'steps', key: null, authorized: true }).rows as { detail: string }[]).some(row => row.detail === 'deploy to outside'), 'nor a drill-down row');
  assert.equal(cut.stepDwell.find(entry => entry.step === 'deploy')?.n ?? 0, 0, 'nor a completed Deploy stay');
});

// GY-168: the follow-ups from the browser review of GY-161's merge.

/** Hex runs long enough to be a commit SHA (at least one letter, so a numeric id is not one; a UUID's segments are not one either). */
const longHex = (text: string) => [...text.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, 'uuid').matchAll(/\b[0-9a-f]{9,}\b/gi)].map(match => match[0]).filter(hex => /[a-f]/i.test(hex));

test('unit:ui-short-sha-text — commit SHAs render as 8 characters in the page text of the item page and every other page; only a title, link or copy action carries the whole SHA', () => {
  const head = '23d8dfbf674cbc8586cc98238acac9143a1765fa', base = '9c41be07d2f5a8e6b3c0d1f47e2a9b8c6d5e4f30', deployed = 'b7e1f0a2c3d4e5f60718293a4b5c6d7e8f901234';
  const real = realDeliveredWork() as unknown as Work[];
  const reviewing = find('GY-22');
  const at = (ago: number) => new Date(NOW - ago).toISOString();
  // An open item whose recorded text names full SHAs everywhere the control plane writes one.
  const loaded = { ...reviewing, candidate: { ...reviewing.candidate!, sha: head, baseSha: base },
    blocker: `Rebase onto ${base}`, violations: [`Commit ${head} was pushed after review`],
    gates: reviewing.gates.map(gate => gate.name === 'review' ? { ...gate, passed: false, reasons: [`Independent approval of ${head} is required`] }
      : gate.name === 'merge' ? { ...gate, passed: false, reasons: [`Speculative tip on predicted base ${base} is stale`] } : gate),
    observation: { ...reviewing.observation!, agentReview: { reason: `Reviewed ${head} against ${base}` } },
    nextAction: { kind: 'review', gate: 'review', refusal: `Independent approval of ${head} is required`, reason: `review the head ${head}`, llmRole: null },
    actionQueue: { actions: [{ id: 'a1', kind: 'review', state: 'pending', claim: null, requestedBy: 'graphyard', requestedAt: at(hour), attempts: 1, resolution: `reviewed ${base}`,
      history: [{ at: at(hour), event: 'requested', reason: `review ${head}`, result: null, executor: null, requester: 'graphyard' }] }], history: [] },
    queueEjection: { at: at(2 * hour), reason: `Speculative tip ${base} was stale` },
    // Revoked evidence, whose recorded reason names the commit it no longer binds.
    evidence: [{ ...board().flatMap(item => item.evidence)[0], id: 'e-revoked', sha: head, revocation: { actor: 'operator', at: at(hour), reason: `Proof run against ${base}, not ${head}` } }],
    agentRequests: [{ id: 'q1', type: 'scope', state: 'open', requestedBy: 'worker-1', reason: `Widen scope for ${head}`, paths: ['web/'], decider: { who: 'Master agent', command: null }, at: at(hour), releasedLease: false }],
    sessions: [
      { id: 'r22', kind: 'review', principal: 'reviewer-1', epoch: null, runtime: 'claude', host: 'build-1', workspace: 'w1', tab: null, pane: 'w1:r22', agentName: null, role: 'review', head,
        attach: 'herdr pane attach w1:r22', transcript: null, subject: `GY-22: review ${head}`, startedAt: at(10 * 60_000), updatedAt: at(60_000), endedAt: null, state: 'running', outcome: null },
      { id: 'r22b', kind: 'review', principal: 'reviewer-1', epoch: null, runtime: 'claude', host: 'build-1', workspace: 'w1', tab: null, pane: 'w1:r22b', agentName: null, role: 'review', head: base,
        attach: null, transcript: null, subject: `GY-22: review ${base}`, startedAt: at(3 * hour), updatedAt: at(2 * hour), endedAt: at(2 * hour), state: 'finished', outcome: `superseded: ${base} was replaced by ${head}` }],
  } as unknown as Work;
  // A merge the release was observed serving, and one a post-deployment check records a deployment for.
  const merged = { ...real[0], delivery: { ...real[0].delivery!, mergeSha: head } } as Work;
  const smoked = { ...real[1], policy: { ...real[1].policy, deploySmoke: true }, delivery: { ...real[1].delivery!, mergeSha: base,
    deployment: { sha: deployed, covers: 'descendant', source: 'railway', observedAt: at(hour), observer: 'master' } } } as unknown as Work;
  // A parked item whose human-only request names commits, as its Needs-you card shows it on the item page.
  const parkedOn = find('GY-20');
  const asked = { ...parkedOn, humanRequest: { ...parkedOn.humanRequest!, reason: `The live proof of ${head} needs a paid plan`, needed: `A cloud account for ${base}` } } as Work;
  const work = [...board().filter(item => ![reviewing.id, parkedOn.id].includes(item.id)), loaded, asked, merged, smoked, ...real.slice(2)];
  const status = { ...boardStatus(), production: { observedAt: at(0), serving: deployed, error: null, deployed: [merged.key], pending: [smoked.key], incidents: [] } };
  const d = dashboard({ work, status: status as any });
  // All rendered text, folded sections included; attributes (a title, a link, a copy action) are not text.
  const text = (html: string) => html.replace(/<[^>]*>/g, ' ');
  // Every item page: no whole SHA, and no hex run longer than 8, in what a reader sees.
  for (const item of work) {
    const page = markup(createElement(WorkDetails, { ...d, item }));
    assert.deepEqual(longHex(text(page)), [], `${item.key} item page text`);
  }
  const askedText = text(markup(createElement(WorkDetails, { ...d, item: asked })));
  assert.ok(askedText.includes(`The live proof of ${head.slice(0, 8)} needs a paid plan`) && askedText.includes(`A cloud account for ${base.slice(0, 8)}`), 'the Needs-you card shows the request in 8 characters');
  const itemText = text(markup(createElement(WorkDetails, { ...d, item: loaded })));
  for (const sha of [head, base]) assert.ok(itemText.includes(sha.slice(0, 8)), `${sha.slice(0, 8)} is shown`);
  assert.ok(itemText.includes(`Proof run against ${base.slice(0, 8)}, not ${head.slice(0, 8)}`), 'a revocation reason shows its commits in 8 characters');
  assert.ok(!itemText.includes(head) && !itemText.includes(base));
  const mergePage = markup(createElement(WorkDetails, { ...d, item: smoked }));
  assert.ok(text(mergePage).includes(deployed.slice(0, 8)) && !text(mergePage).includes(deployed), 'the deployed commit is 8 characters too');
  // The whole SHA is still reachable, as the commit's title and link (never its text).
  const commit = markup(createElement(CandidateSha, { repository: 'fixture/shop', sha: head }));
  assert.match(commit, new RegExp(`href="https://github.com/fixture/shop/commit/${head}"`));
  assert.match(commit, new RegExp(`<code class="sha" title="${head}">${head.slice(0, 8)}</code>`));
  // Every other page the dashboard draws, over the same items.
  for (const view of visibleViews(d)) assert.deepEqual(longHex(text(markup(createElement(() => view.render(d) as ReactElement)))), [], `${view.label} page text`);
  for (const item of work) assert.deepEqual(longHex(text(markup(createElement(WorkCard, { item, now: NOW, onOpen: noop, release: releaseView(status) })))), [], `${item.key} card text`);
  // Numbers are not SHAs: a review or run id stays whole.
  assert.equal(shortShas(`review 5303188884 on ${head}`), `review 5303188884 on ${head.slice(0, 8)}`);
  // A UUID names a record, not a commit, and stays whole.
  assert.equal(shortShas(`overriding refused reconciliation 36fad33a-319f-488b-b94a-c25de44ee705 at ${base}`), `overriding refused reconciliation 36fad33a-319f-488b-b94a-c25de44ee705 at ${base.slice(0, 8)}`);
});

test('unit:ui-insights-tabs-and-ended-sessions — Insights is one page with no tabs, in the design\'s order (headline numbers, Flow with Now and the 24-hour replay, landed per day beside where the time goes), the flow-analytics detail behind one collapsed Show details; Workers hides sessions not seen for over an hour on delivered or closed items behind a collapsed Ended group', async () => {
  // Insights: one page, so no tab list — neither the section's sub-page row nor one on the page.
  const configured = { validation: true, releases: true, automation: true };
  const d = dashboard({ features: configured });
  assert.deepEqual(views.filter(view => view.section === 'insights').map(view => view.id), ['insights']);
  assert.equal(markup(createElement(TopBar, { ...d, view: 'insights' })), '', 'no sub-page row under Insights');
  assert.ok(primaryEntry(d, views.find(view => view.id === 'insights')!), 'Insights is still its sidebar entry');
  const page = markup(createElement(InsightsFlow, d));
  assert.doesNotMatch(page, /role="tab(list)?"|class="tabs?(?: active)?"|aria-label="Pages in this section"/, 'the page draws no tabs');
  assert.match(page, /<h1>Insights<\/h1>/);
  // The design's order: headline numbers, the Flow panel (Now, then the replay), the two charts side by side, then Show details.
  const place = (marker: string) => { const index = page.indexOf(marker); assert.ok(index >= 0, marker); return index; };
  const order = ['<h1>Insights</h1>', 'aria-label="Headline numbers"', 'aria-label="Flow"', '<h3>Now</h3>', '<h3>Last 24 hours, replayed</h3>', 'class="insight-charts"', 'aria-label="Landed per day"', 'aria-label="Where the time goes"', '<details class="insight-details"'];
  const positions = order.map(place);
  assert.deepEqual([...positions].sort((x, y) => x - y), positions, `sections in order: ${order.join(' → ')}`);
  assert.match(page, /<div class="insight-charts"><section class="panel" aria-label="Landed per day">[\s\S]*?<\/section><section class="panel" aria-label="Where the time goes">/, 'the two charts share one row');
  // The headline numbers, in order, each counted as the page it replaces or the Work page counts it.
  const kpis = [...page.matchAll(/<div class="kpi" data-kpi="([^"]+)"><span>([^<]+)<\/span><strong>([^<]*)<\/strong>/g)].map(match => match.slice(1));
  assert.deepEqual(kpis.map(([id]) => id), ['shipped', 'start-to-live', 'moving', 'waiting-on-people']);
  assert.deepEqual(kpis.map(([, label]) => label), ['Shipped', 'Start to live, median', 'Moving now', 'Time waiting on people']);
  const workPage = home(d);
  assert.equal(kpis[0][2], /<strong>(\d+) shipped this week\.<\/strong>/.exec(workPage)?.[1], 'shipped as the Work page counts it');
  assert.equal(Number(kpis[2][2]), tileCount(workPage, 'moving'), 'moving now as the Work page counts it');
  assert.equal(kpis[1][2], '…', 'start to live waits on the shipping pulse read, never a zero');
  const waiting = classify(d.work, NOW, d.status?.humanOnly, releaseView(d.status)).byGroup['needs-you'];
  assert.ok(waiting.length > 0);
  assert.match(page, new RegExp(`data-kpi="waiting-on-people"><span>Time waiting on people</span><strong>\\d[^<]*</strong><small>${waiting.length} items? waits? on you now</small>`));
  // An item in Needs you through a human-only row waits from that request, not from when it entered its stage.
  const requested = { ...waiting[0], humanRequest: null, stageEnteredAt: new Date(NOW - 10 * hour).toISOString() } as unknown as Work;
  const asked = { id: requested.id, request: { at: new Date(NOW - 30 * 60_000).toISOString() } } as any;
  const headline = markup(createElement(Headline, { shipped: 0, moving: 0, waiting: [requested], now: NOW, pulse: { pulse: null, unavailable: true, elapsed: 0, stale: true, refresh: noop } as any, requests: [asked] }));
  assert.match(headline, new RegExp(`<strong>${formatDuration(30)}</strong><small>1 item waits on you now</small>`));
  // A cached start-to-live median after a failed poll is marked stale on the headline itself, never shown as current.
  const measured = { prToProduction: { configured: true, medianHours: 5, sampleSize: 3, eligible: 4 } };
  const kpi = (read: object) => /<div class="[^"]*" data-kpi="start-to-live"[\s\S]*?<\/div>/.exec(markup(createElement(Headline, { shipped: 0, moving: 0, waiting: [], now: NOW, pulse: { refresh: noop, ...read } as any })))![0];
  const fresh = kpi({ pulse: measured, unavailable: false, elapsed: 5_000, stale: false });
  assert.match(fresh, /<strong>5h<\/strong><small>pull request to production · 3 of 4 measured<\/small>/);
  assert.doesNotMatch(fresh, /stale/);
  const failed = kpi({ pulse: measured, unavailable: true, elapsed: 3 * 60_000, stale: true });
  assert.match(failed, /class="kpi stale" data-kpi="start-to-live" data-stale="true"/);
  assert.match(failed, /<small>pull request to production · 3 of 4 measured · stale: last read 3m ago, the latest read failed<\/small>/);
  assert.match(kpi({ pulse: measured, unavailable: false, elapsed: 4 * 60_000, stale: true }), /· stale: last read 4m ago<\/small>/);
  // A pulse without a production metric, or a malformed one, never breaks the headline and is refused as a read.
  for (const prToProduction of [undefined, null, {}, { configured: true, medianHours: '5' }]) {
    assert.match(kpi({ pulse: { prToProduction }, unavailable: false, elapsed: 0, stale: false }), /<strong>Unavailable<\/strong>/);
    assert.equal(wellFormedPulse({ counts: {}, weeks: [], recent: [], prToProduction }), false);
  }
  // A pulse is accepted only whole: Show details renders every field the validator lets through.
  const whole = {
    generatedAt: new Date(NOW).toISOString(), range: { start: '2026-06-29T00:00:00.000Z', end: new Date(NOW).toISOString(), weeks: 12, semantics: 'repository-utc-inclusive' },
    completeness: 'complete', truncated: false, counts: { days7: 3, days30: 8 }, intentToMerge: { medianHours: 12.5, sampleSize: 7, excluded: 1 },
    // No `configured`: servers before that field sent none, and the view reads its absence as configured.
    prToProduction: { averageHours: 30, medianHours: 24, p90Hours: 48, sampleSize: 6, eligible: 8, excluded: 2, coveragePercent: 75, sparse: false, exclusions: { 'no-verifiable-production-deployment': 2 }, split: { prToMergeAverageHours: 18, mergeToProductionAverageHours: 12 } },
    weeks: [{ start: '2026-09-14T00:00:00.000Z', end: '2026-09-20T00:00:00.000Z', count: 1 }],
    recent: [{ key: 'GY-9', title: 'Exact delivery', pullRequest: 42, mergeSha: 'abcdef1234567890abcdef1234567890abcdef12', mergedAt: '2026-09-15T12:00:00.000Z', quality: { passingProofs: 4, requiredProofs: 4, violations: [] } }],
  };
  assert.equal(wellFormedPulse(whole), true, 'a pulse from a server before `configured` is not refused');
  assert.equal(wellFormedPulse(fixtureApi('shipping-pulse')), true, 'the dashboard fixture pulse is whole');
  assert.equal(wellFormedPulse({ ...whole, prToProduction: { ...whole.prToProduction, configured: false, unconfiguredReason: null } }), true);
  assert.match(markup(createElement(ShippingPulseView, { pulse: whole as any, stale: false, elapsed: 0, onRefresh: noop })), /6 included of 8/);
  // The headline reads a legacy pulse (no `configured`) as ShippingPulseView does: configured, its median measured.
  assert.match(kpi({ pulse: whole, unavailable: false, elapsed: 0, stale: false }), /<strong>24h<\/strong><small>pull request to production · 6 of 8 measured<\/small>/);
  const sourced = (sources: unknown) => wellFormedPulse({ ...whole, prToProduction: { ...whole.prToProduction, sources } });
  assert.equal(sourced({ providerObservations: true, verifiedDeliveries: 0 }), true);
  for (const sources of [{ verifiedDeliveries: 0 }, { providerObservations: 'false', verifiedDeliveries: 0 }]) assert.equal(sourced(sources), false, `refused sources: ${JSON.stringify(sources)}`);
  assert.equal(wellFormedPulse({ ...whole, ...measured }), false, 'a production metric with only its median would crash Show details');
  const production = whole.prToProduction as Record<string, unknown>;
  for (const broken of [{ split: undefined }, { exclusions: null }, { sampleSize: '6' }, { eligible: undefined }, { excluded: null }, { coveragePercent: undefined }, { configured: 'yes' }, { dominantExclusion: { count: 2 } }]) {
    assert.equal(wellFormedPulse({ ...whole, prToProduction: { ...production, ...broken } }), false, `refused: ${JSON.stringify(broken)}`);
  }
  for (const broken of [{ counts: {} }, { weeks: [] }, { recent: [{ key: 'GY-9' }] }, { intentToMerge: null }, { completeness: undefined }]) {
    assert.equal(wellFormedPulse({ ...whole, ...broken }), false, `refused: ${JSON.stringify(broken)}`);
  }
  // Show details: exactly one toggle on the page, collapsed, and nothing of the detail read or drawn until it opens.
  assert.equal(page.match(/Show details/g)?.length, 1, 'one Show details toggle');
  assert.match(page, /<details class="insight-details"><summary>Show details<\/summary><\/details>/, 'collapsed and empty until opened');
  assert.doesNotMatch(page, /<details[^>]* open/);
  for (const hidden of ['Shipping pulse', 'Flow analytics', 'Cumulative flow', 'Where work is waiting']) assert.ok(!visibleWords(page).join(' ').includes(hidden), `${hidden} is behind Show details`);
  // Opened, it holds the former Shipping pulse and Flow analytics tabs, unfolded: no second Show details inside.
  const report = flowApi(board())('analytics/flow?window=30');
  const pulse = { pulse: null, unavailable: true, elapsed: 0, stale: true, refresh: noop };
  const opened = markup(createElement(InsightsDetails, { pulse, api: d.api, token: 'fixture', canAudit: true, initial: { report, merge: null } }));
  assert.match(opened, /Shipping pulse unavailable/);
  assert.match(opened, /<h2 id="flow-analytics-title">Flow analytics<\/h2>[\s\S]*Where work is waiting[\s\S]*Cumulative flow[\s\S]*Coverage, exclusions and definitions/);
  assert.doesNotMatch(opened, /Show details|<details class="flow-details"|<h1>/, 'the detail is not a page of its own and folds nothing again');
  // A flow report is accepted only whole, like the pulse: a shaped but malformed body would throw on render under Show details.
  assert.equal(wellFormedFlowReport(report), true, 'the fixture report, from computeFlow, is whole');
  assert.equal(wellFormedFlowReport(flowApi([])('analytics/flow?window=30')), true, 'an empty window is whole');
  assert.equal(wellFormedFlowReport({ coverage: { workItems: 1 }, bottleneck: { categories: [] } }), false, 'the shape the reviewer named is refused');
  const flowWhole = report as Record<string, any>;
  for (const [field, broken] of [['coverage', { ...flowWhole.coverage, projection: undefined }], ['window', null], ['bottleneck', { ...flowWhole.bottleneck, scope: {} }],
    ['bottleneck', { ...flowWhole.bottleneck, unclassified: 'none' }], ['cumulativeFlow', { ...flowWhole.cumulativeFlow, buckets: ['not a day'] }], ['wip', []],
    ['phases', [{ phase: 1, n: 0, medianMs: null, p90Ms: null, unknown: {} }]], ['operations', { ...flowWhole.operations, deployments: { ...flowWhole.operations.deployments, latency: null } }],
    ['definitions', { leadTime: { label: 'Lead time', formula: 'x' } }], ['privacy', { statement: { text: 'an object is no text' } }], ['availableTypes', 'feature']] as const) {
    assert.equal(wellFormedFlowReport({ ...flowWhole, [field]: broken }), false, `refused: ${field} ${JSON.stringify(broken)?.slice(0, 80)}`);
  }
  // The drill-down drawer and the handed-in-to-merged figure read each row by column, so a drill-down body is accepted only whole too.
  const flowRead = flowApi(board());
  for (const metric of ['bottleneck', 'phase', 'steps']) assert.equal(wellFormedDrilldown(flowRead(`analytics/flow/drilldown?window=30&metric=${metric}`)), true, `the served ${metric} drill-down is whole`);
  const drillWhole = flowRead('analytics/flow/drilldown?window=30&metric=phase') as Record<string, any>;
  for (const broken of [{ columns: ['workKey'], rows: [null] }, { rows: [[]] }, { rows: [{ workKey: { key: 'GY-1' } }] }, { columns: [1] }, { columns: ['workKey', 'workKey'] }, { total: '3' }, { total: undefined }, { truncated: 'no' }, { rows: undefined }]) {
    assert.equal(wellFormedDrilldown({ ...drillWhole, ...broken }), false, `refused drill-down: ${JSON.stringify(broken)}`);
  }
  assert.equal(wellFormedDrilldown(null), false);
  assert.equal(await mergeTime(async () => ({ columns: ['workKey'], rows: [null], total: 1, truncated: false }), 'window=30'), null, 'a malformed phase drill-down leaves the merge figure unread instead of throwing');
  // The former tabs are gone from the registry; Validation and Releases moved under Shipped.
  for (const id of ['pulse', 'flow']) assert.ok(!views.some(view => view.id === id), id);
  for (const id of ['validation', 'releases']) assert.equal(views.find(view => view.id === id)!.section, 'shipped', id);

  // Workers: sessions recorded running but not seen for more than an hour, on a delivered or a closed item.
  const real = realDeliveredWork() as unknown as Work[];
  const at = (ago: number) => new Date(NOW - ago).toISOString();
  const running = (id: string, subject: string, seenAgo: number) => ({ id, kind: 'implementation', principal: `worker-${id}`, epoch: 1, runtime: 'claude', host: 'build-1', workspace: 'w1', tab: null, pane: `w1:${id}`,
    agentName: `claude-${id}`, role: null, head: null, attach: `herdr pane attach w1:${id}`, transcript: null, subject, startedAt: at(seenAgo + hour), updatedAt: at(seenAgo), endedAt: null, state: 'running', outcome: null });
  const delivered = { ...real[0], sessions: [running('d1', 'Implement GY-163', 3 * hour), running('d2', 'Prove GY-163', 30 * 60_000)] } as unknown as Work;
  const closedItem = { ...find('GY-22'), stage: 'done', closure: { kind: 'obsolete', ref: null, reason: 'No longer needed', by: 'operator', at: at(5 * hour), from: 'review' },
    sessions: [running('c1', 'Review GY-22', 2 * hour)] } as unknown as Work;
  const openItem = find('GY-12');
  const idle = { ...openItem, sessions: [...(openItem.sessions ?? []), running('o1', 'Implement GY-12 again', 3 * hour)] } as unknown as Work;
  const work = [...board().filter(item => ![closedItem.id, openItem.id].includes(item.id)), closedItem, idle, delivered, ...real.slice(1)];
  const view = workersView(work, new Date(NOW));
  const ids = (rows: { id: string }[]) => rows.map(row => row.id);
  // Over an hour unseen on a finished item: filed with the ended sessions, saying why.
  for (const id of ['d1', 'c1']) { assert.ok(!ids(view.running).includes(id), `${id} is not open`); assert.ok(ids(view.finished).includes(id), `${id} is ended`); }
  assert.equal(view.finished.find(row => row.id === 'd1')!.leftOn, 'delivered'); assert.equal(view.finished.find(row => row.id === 'c1')!.leftOn, 'closed');
  // Its run time stops when it was last seen, not at the page clock.
  for (const later of [NOW, NOW + 5 * hour]) assert.equal(workersView(work, new Date(later)).finished.find(row => row.id === 'd1')!.spentMs, hour);
  // Under an hour, or on an open item, it stays in the open table (marked stale, never live).
  for (const id of ['d2', 'o1', 's12']) assert.ok(ids(view.running).includes(id), `${id} stays open`);
  assert.equal(view.running.find(row => row.id === 'o1')!.leftOn, null);
  assert.equal(endedItemIdleMs, hour);
  // The principal of a left-over session is idle, not on the finished item.
  assert.equal(view.principals.find(entry => entry.principal === 'worker-d1')!.current, null);
  const html = markup(createElement(WorkersPage, dashboard({ work })));
  const open = html.slice(html.indexOf('aria-label="Agent sessions"'), html.indexOf('<details class="finished-sessions"'));
  const ended = /<details class="finished-sessions"><summary>Ended <span class="count">(\d+)<\/span><\/summary>([\s\S]*?)<\/details>/.exec(html)!;
  for (const id of ['d1', 'c1']) { assert.doesNotMatch(open, new RegExp(`data-session="${id}"`)); assert.match(ended[2], new RegExp(`data-session="${id}"`)); }
  for (const id of ['d2', 'o1']) assert.match(open, new RegExp(`data-session="${id}"`));
  assert.equal(Number(ended[1]), view.finished.length);
  // The Ended group is collapsed: none of its rows is in the visible text.
  const visible = visibleWords(html).join(' ');
  assert.ok(!visible.includes('claude-d1') && !visible.includes('claude-c1'), 'folded away');
  assert.ok(visible.includes('claude-d2') && visible.includes('claude-o1'));
  // The heading counts neither as open nor as not seen recently.
  const staleOpen = view.running.filter(row => row.stale).length;
  assert.match(html, new RegExp(`${view.running.length - staleOpen} agent sessions? open\\. ${staleOpen} not seen recently\\. ${view.finished.length} ended\\.`));
  const row = /data-session="d1"[\s\S]*?<\/tr>/.exec(html)![0];
  assert.match(row, /data-health="ended"[^>]*>.*Not seen for 3h 00m 00s · its item is delivered/);
  assert.doesNotMatch(row, /Copy local|Copy remote/, 'no attach command offered for a left-over session');
  // Stage done is not delivered: a merge the production watch still reports pending, and a smoke-gated
  // merge without its passing check, are still at Deploy, so their idle sessions stay open.
  const pendingItem = { ...real[1], sessions: [running('p1', 'Watch GY-164 deploy', 3 * hour)] } as unknown as Work;
  const smokeItem = { ...real[2], policy: { ...real[2].policy, deploySmoke: true }, sessions: [running('s1', 'Smoke GY-165', 3 * hour)] } as unknown as Work;
  const deploying = [...work.filter(item => ![pendingItem.id, smokeItem.id].includes(item.id)), pendingItem, smokeItem];
  const status = { ...boardStatus(), production: { observedAt: new Date(NOW).toISOString(), serving: 'f'.repeat(40), error: null, deployed: [], pending: [pendingItem.key], incidents: [] } };
  const held = workersView(deploying, new Date(NOW), undefined, releaseView(status));
  for (const id of ['p1', 's1']) { assert.ok(ids(held.running).includes(id), `${id} stays open while its item is at Deploy`); assert.equal(held.running.find(row => row.id === id)!.leftOn, null); }
  assert.equal(held.finished.find(row => row.id === 'd1')!.leftOn, 'delivered', 'a merge that left the flow still files its session as ended');
  // Open is not running: a session not observed for three hours is no principal's current work (GY-172).
  assert.equal(held.principals.find(entry => entry.principal === 'worker-p1')!.current, null);
  const heldPage = markup(createElement(WorkersPage, dashboard({ work: deploying, status: status as any })));
  const heldOpen = heldPage.slice(heldPage.indexOf('aria-label="Agent sessions"'), heldPage.indexOf('<details class="finished-sessions"'));
  for (const id of ['p1', 's1']) assert.match(heldOpen, new RegExp(`data-session="${id}"`));
  // Work merged before delivery records existed is Shipped on the board, so an idle session on it is ended too.
  const legacyItem = { ...real[1], id: 'legacy-item', key: 'GY-9', delivery: undefined, sessions: [running('l1', 'Legacy GY-9', 3 * hour), running('l2', 'Legacy GY-9 fresh', 5 * 60_000)] } as unknown as Work;
  assert.equal(groupOf(legacyItem, NOW), 'shipped');
  const legacy = workersView([legacyItem], new Date(NOW));
  assert.equal(legacy.finished.find(row => row.id === 'l1')!.leftOn, 'delivered', 'a legacy shipped item files its idle session as ended');
  assert.equal(legacy.running.find(row => row.id === 'l2')!.leftOn, null, 'a session seen within the hour stays open');
});

test('unit:ui-shipped-strip-latest — the shipped strip names the most recently merged item as latest, and its not-yet-live count comes from the production observation: zero when production serves the newest merge', () => {
  const real = realDeliveredWork() as unknown as Work[];
  // Real-shaped deliveries: most carry no delivery.deployment and no verified release.
  assert.ok(real.filter(item => !item.delivery!.deployment).length > real.length / 2);
  assert.ok(real.every(item => !item.releaseDeliveries?.length));
  const work = [...board(), ...real];
  const merges = work.filter(item => item.stage === 'done' && !item.closure && item.delivery);
  const newest = merges.reduce((last, item) => mergedAt(item) > mergedAt(last) ? item : last);
  assert.equal(newest.key, 'GY-163');
  // The newest merge is not the newest release, so ordering by release would name another item.
  const released = merges.filter(item => releasedAt(item) !== null).sort((a, b) => releasedAt(b)! - releasedAt(a)!);
  assert.ok(released.length > 0 && released[0].key !== newest.key);
  const strip = (production: unknown) => { const page = home(dashboard({ work, status: { ...boardStatus(), production } as any })); return page.slice(page.indexOf('aria-label="Shipped this week"')); };
  const latestOf = (html: string) => /Latest: <button type="button" class="text-button" data-latest="([^"]+)"><span class="mono">([^<]+)<\/span>/.exec(html)?.slice(1);
  const unreleased = (html: string) => Number(/data-unreleased="(\d+)"/.exec(html)?.[1] ?? 0);
  // Production serves the newest merge (and so everything merged before it): latest is the newest merge, and nothing is waiting to go live.
  const serving = { observedAt: new Date(NOW).toISOString(), serving: newest.delivery!.mergeSha, servingSource: 'provider', error: null, deployed: merges.map(item => item.key), pending: [], incidents: [] };
  const live = strip(serving);
  assert.deepEqual(latestOf(live), [newest.key, newest.key]);
  assert.match(live, new RegExp(`· merged ${formatAge(mergedAt(newest), NOW)} ago`));
  assert.equal(unreleased(live), 0); assert.doesNotMatch(live, /not yet seen live/);
  // The count is the observation's: a merge it reports pending or failed, or one merged after its last pass, is not yet live.
  assert.equal(unreleased(strip({ ...serving, deployed: [], pending: [newest.key] })), 1);
  assert.match(strip({ ...serving, pending: [newest.key, real[1].key] }), /data-unreleased="2"> 2 merged, not yet seen live\./);
  assert.equal(unreleased(strip({ ...serving, deployed: [], incidents: [{ key: newest.key }] })), 1);
  assert.equal(unreleased(strip({ ...serving, observedAt: new Date(NOW - 3 * hour).toISOString() })), 1, 'merged 2h ago, after a pass 3h ago');
  // With no production observation the page claims no count, and latest is still the newest merge.
  for (const none of [null, { ...serving, serving: null }, { ...serving, error: 'Railway API answered 500' }]) {
    const page = strip(none);
    assert.deepEqual(latestOf(page), [newest.key, newest.key]); assert.equal(unreleased(page), 0);
  }
  // A smoke-gated merge with no production observation is not claimed as not yet live either.
  const smokeGated = { ...newest, policy: { ...newest.policy, deploySmoke: true }, delivery: { ...newest.delivery!, deployment: null } } as unknown as Work;
  const gated = home(dashboard({ work: [...work.filter(item => item.id !== newest.id), smokeGated] }));
  assert.equal(unreleased(gated.slice(gated.indexOf('aria-label="Shipped this week"'))), 0);
  assert.doesNotMatch(gated, /not yet seen live/);
  // A legacy delivery with no delivery record, dated from its observed merge, can be the latest.
  const legacy = { ...real[2], id: 'legacy-merge', key: 'GY-9', title: 'A merge from before delivery records', delivery: null,
    observation: { ...real[2].observation, mergedAt: new Date(NOW - 60_000).toISOString() } } as unknown as Work;
  assert.ok(mergedAt(legacy) > mergedAt(newest));
  const withLegacy = home(dashboard({ work: [...work, legacy] }));
  assert.deepEqual(latestOf(withLegacy.slice(withLegacy.indexOf('aria-label="Shipped this week"'))), ['GY-9', 'GY-9']);
  // It is Shipped on the board, so a production observation never counts it as not yet live.
  assert.equal(groupOf(legacy, NOW, undefined, undefined, releaseView({ production: serving } as any)), 'shipped');
  const legacyStrip = (() => { const page = home(dashboard({ work: [...work, legacy], status: { ...boardStatus(), production: serving } as any })); return page.slice(page.indexOf('aria-label="Shipped this week"')); })();
  assert.deepEqual(latestOf(legacyStrip), ['GY-9', 'GY-9']);
  assert.equal(unreleased(legacyStrip), 0); assert.doesNotMatch(legacyStrip, /not yet seen live/);
  // A closed item never counts as a merge, even the newest.
  const closed = { ...newest, closure: { kind: 'obsolete', ref: null, reason: 'Reverted', by: 'operator', at: new Date(NOW).toISOString(), from: 'merge' } } as unknown as Work;
  const withClosed = home(dashboard({ work: [...work.filter(item => item.id !== newest.id), closed] }));
  assert.notEqual(latestOf(withClosed.slice(withClosed.indexOf('aria-label="Shipped this week"')))?.[0], newest.key);
});
