import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { predictQueue } from '../src/merge-queue.js';
import { NOW, boardApi, boardStatus, boardWork } from '../browser-tests/ui-board.js';
// @ts-expect-error Dependency-free fixture script.
import { visibleWords } from '../scripts/dashboard-fixture.mjs';
import { classify, groupLabel, groupOf, groups, humanOnlyIds, timedGroups, type OpenGroup } from '../web/groups.js';
import { prSteps, stepIds } from '../web/pr-steps.js';
import { positionsAt, replayFrames, transitionsFromRows } from '../web/flow-replay.js';
import { jargon } from '../web/plain-status.js';
import { primaryEntry, sections, views, visibleViews } from '../web/pages/index.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import OverviewPage from '../web/pages/overview.js';
import WorkDetails from '../web/pages/work-details.js';
import GuidePage from '../web/pages/guide.js';
import InsightsFlow from '../web/pages/insights-flow.js';
import Sidebar from '../web/components/sidebar.js';
import TopBar from '../web/components/top-bar.js';
import WorkCard from '../web/components/work-card.js';

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
  return {
    token: 'fixture', work, status: boardStatus(role), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: { validation: null, releases: null, automation: null }, events: [], editingRequirements: false, setEditingRequirements: noop,
    codexAvailable: false, queue: predictQueue(work, NOW), sessionEpoch: { current: 0 }, api: async (path: string) => boardApi(path, role), refresh: async () => {},
    action: async () => {}, setError: noop, signOut: noop, ...overrides,
  };
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
/** The item page's first screen: everything before "More details", without the closed Edit menu. */
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
  for (const view of views) assert.ok(!sidebarLabels.includes(view.label as any) || view.id === 'work' || view.id === 'workers', `${view.label} is not a second entry for a sidebar item`);
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
  const roles = ['You', 'Builder agent', 'Reviewer agent', 'Prover agent', 'Automated checks', 'Graphyard (automatic)', 'Graphyard (assigns a builder)', 'Master agent', 'Nobody yet', 'Nobody — it has shipped'];
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
  assert.match(spec, /expect\(entries\)\.toEqual\(\['Work', 'Workers', 'Shipped', 'Insights', 'Settings'\]\)/);
  const d = dashboard();
  const entries = views.map(view => primaryEntry(d, view)).filter(Boolean).map(entry => entry!.label);
  for (const label of ['Work', 'Workers', 'Shipped', 'Insights', 'Settings']) assert.ok(entries.includes(label as any), label);
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
  const cases: [string, Work, string, string, string][] = [
    ['worker building', find('GY-14', work), 'build', 'Building · the builder is writing the code', 'Builder agent'],
    ['scope check', withReasons(handedIn, { build: ['Candidate diff has not been compared with the planned files'] }), 'validate', 'Validating · checking which files it changes', 'Graphyard (automatic)'],
    ['out of scope', withReasons(handedIn, { build: ['Candidate changes 2 files outside plannedFiles: a, b'] }), 'validate', 'Validating · it changes files outside its plan', 'Builder agent'],
    ['CI running', handedIn, 'test', 'Testing · 1 of 2 checks done', 'Automated checks'],
    ['CI failed', { ...handedIn, observation: { ...handedIn.observation!, checks: [{ name: 'test', result: 'failure', appId: 1 }, { name: 'typecheck', result: 'success', appId: 1 }] } } as Work, 'test', 'Testing · the check test failed', 'Builder agent'],
    ['review requested', find('GY-15', work), 'review', 'Reviewing · waiting for the reviewer', 'Reviewer agent'],
    ['proofs pending', find('GY-16', work), 'prove', 'Proving · 2 of 3 proofs passed', 'Prover agent'],
    ['merging', find('GY-21', work), 'merge', 'Merging · Graphyard is merging it', 'Graphyard (automatic)'],
    ['queued to merge', withReasons(find('GY-21', work), { merge: ['Merge queue position 2 of 3: GY-5 is ahead'] }), 'merge', 'Merging · 2nd in line, after GY-5', 'Graphyard (automatic)'],
    ['deploying', { ...find('GY-18', work), policy: { ...find('GY-18', work).policy, deploySmoke: true } } as Work, 'deploy', 'Deploying · waiting for the live release to serve it', 'Graphyard (automatic)'],
  ];
  for (const [name, item, current, label, who] of cases) {
    const steps = prSteps(item, NOW);
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
  // The recorded history: the stage-dwell drill-down rows, one per durable stage change.
  const rows = [
    { workKey: 'GY-15', observedAt: new Date(NOW - 30 * hour).toISOString(), detail: 'ready to build' },
    { workKey: 'GY-15', observedAt: new Date(NOW - 20 * hour).toISOString(), detail: 'build to review' },
    { workKey: 'GY-16', observedAt: new Date(NOW - 10 * hour).toISOString(), detail: 'test to acceptance' },
    { workKey: 'GY-16', observedAt: new Date(NOW - 8 * hour).toISOString(), detail: 'acceptance to build' },
    { workKey: 'GY-16', observedAt: new Date(NOW - 6 * hour).toISOString(), detail: 'build to review' },
    { workKey: 'GY-18', observedAt: new Date(NOW - 2 * hour).toISOString(), detail: 'merge to done' },
    { workKey: 'GY-19', observedAt: new Date(NOW - hour).toISOString(), detail: 'review to review' },
  ];
  const transitions = transitionsFromRows(rows);
  assert.deepEqual(transitions.map(t => `${t.key}:${t.from}>${t.to}`), ['GY-15:null>build', 'GY-15:build>review', 'GY-16:test>prove', 'GY-16:prove>build', 'GY-16:build>review', 'GY-18:merge>deploy']);
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
  assert.deepEqual(at(0.2), { 'GY-15': 'review' });
  assert.deepEqual(at((24 - 7) / 24), { 'GY-15': 'review', 'GY-16': 'build!' });
  assert.deepEqual(at(1), { 'GY-15': 'review', 'GY-16': 'review', 'GY-18': 'deploy' });
  // The page reads exactly that recorded history, and the Now view places each open item at its true step.
  const source = await read('web/pages/insights-flow.tsx');
  assert.match(source, /analytics\/flow\/drilldown\?days=7&metric=stage-dwell/);
  assert.match(source, /replayFrames\(transitionsFromRows\(rows\?\.rows \?\? \[\]\), now\)/);
  assert.match(source, /analytics\/flow\?days=7/); assert.match(source, /report\?\.throughput/); assert.match(source, /report\?\.stageDwell/);
  const page = markup(createElement(InsightsFlow, dashboard()));
  for (const text of ['Now', 'Last 24 hours, replayed', 'Landed on main per day', 'Where the time goes']) assert.ok(page.includes(text), text);
  const now = [...page.matchAll(/class="now-dot[^"]*" data-step="([\w-]+)" data-key="([^"]+)"/g)].map(match => [match[2], match[1]]);
  const { byGroup } = classify(board(), NOW);
  assert.deepEqual(now.map(([key]) => key).sort(), [...byGroup.moving, ...byGroup.blocked].map(item => item.key).sort());
  for (const [key, step] of now) assert.equal(step, prSteps(find(key), NOW).current, `${key} at its true step`);
  // Motion is disabled under prefers-reduced-motion, in the stylesheet and in the replay itself.
  const css = await read('web/style.css');
  const rule = /@media \(prefers-reduced-motion: reduce\)\{([^@]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /animation:none!important/); assert.match(rule, /transition:none!important/);
  assert.match(source, /prefers-reduced-motion: reduce/);
});

test('unit:ui-matches-design — the shared tokens and IBM Plex fonts are the only colour and font definitions in web/style.css, and the sidebar lists exactly Work, Workers, Shipped, Tests (planned), Insights and Settings', async () => {
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
  assert.match(await read('web/index.html'), /family=IBM\+Plex\+Mono[^"]*family=IBM\+Plex\+Sans/);
  // The sidebar: exactly the approved entries, Tests marked planned (GY-162).
  const d = dashboard();
  const sidebar = markup(createElement(Sidebar, { entries: views.map(view => primaryEntry(d, view)), dashboard: d }));
  const nav = /<nav class="primary-nav" aria-label="Primary">([\s\S]*?)<\/nav>/.exec(sidebar)![1];
  assert.deepEqual([...nav.matchAll(/data-nav="([^"]+)"/g)].map(match => match[1]), ['work', 'workers', 'shipped', 'tests', 'insights', 'settings']);
  assert.deepEqual([...nav.matchAll(/<span>([^<]+)<\/span>/g)].map(match => match[1]), ['Work', 'Workers', 'Shipped', 'Tests', 'Insights', 'Settings']);
  assert.match(nav, /data-nav="tests"[^>]*title="Planned in GY-162"[\s\S]*?<small>planned<\/small>/);
  // Built to the checked-in design: every artboard is in the repository.
  for (const name of ['Main', 'Item', 'Workers', 'Phone', 'Insights', 'System']) assert.ok(existsSync(new URL(`design/dashboard/${name}.dc.html`, root)), name);
  const system = await read('design/dashboard/System.dc.html');
  for (const value of Object.values(tokens)) assert.ok(system.includes(value), `the design system defines ${value}`);
});
