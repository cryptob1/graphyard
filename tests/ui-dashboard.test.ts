import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { NOW, boardApi, boardStatus, boardWork, realDeliveredWork } from '../browser-tests/ui-board.js';
// @ts-expect-error Dependency-free fixture script.
import { fixtureApi, visibleWords } from '../scripts/dashboard-fixture.mjs';
import { boardFromStatus, classify, groupLabel, groupOf, groupWithin, groups, humanOnlyIds, mergedAt, nextActor, releasedAt, timedGroups, type OpenGroup } from '../web/groups.js';
import { checkStates, prSteps, stateIds, stateLabel, stepHeld, stepIds, stepSince } from '../src/model/pr-steps.js';
import { noRelease, releaseView } from '../src/model/release.js';
import ShippedPage from '../web/pages/shipped.js';
import { jargon } from '../src/model/plain-status.js';
import { formatAge, formatDuration } from '../src/model/duration.js';
import { primaryEntry, sections, views, visibleViews } from '../web/pages/index.js';
import { endedItemIdleMs, workersView } from '../web/workers-view.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import OverviewPage from '../web/pages/overview.js';
import WorkDetails from '../web/pages/work-details.js';
import GuidePage from '../web/pages/guide.js';
import Sidebar from '../web/components/sidebar.js';
import TopBar from '../web/components/top-bar.js';
import WorkCard from '../web/components/work-card.js';
import WorkersPage, { roleWords, shortShas } from '../web/pages/workers.js';
import { CandidateSha } from '../web/candidate.js';

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
    codexAvailable: false, sessionEpoch: { current: 0 }, api: async (path: string) => boardApi(path, role), refresh: async () => {},
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
  // Merged work is Done (GY-1979): it has left the board in every delivery state — the top bar's
  // release line carries the commit production serves, its health and the merged changes it does
  // not carry yet. It still counts as shipped this week only once the release serves it.
  const merged = find('GY-18', work);
  const release = (delivery: Record<string, unknown>) => ({ ...merged, policy: { ...merged.policy, deploySmoke: true }, delivery: { ...merged.delivery!, ...delivery } }) as Work;
  const deployment = { sha: merged.delivery!.mergeSha, covers: 'exact' };
  const smoke = (result: string) => ({ sha: merged.delivery!.mergeSha, mergeSha: merged.delivery!.mergeSha, result, producer: 'smoke', executed: 1, skipped: 0, at: new Date(NOW).toISOString() });
  const awaiting = release({ deployment: null }), checking = release({ deployment, smoke: null }), failed = release({ deployment, smoke: smoke('fail') }), live = release({ deployment, smoke: smoke('pass') });
  assert.equal(groupOf(merged, NOW), 'shipped');
  assert.equal(groupOf(live, NOW), 'shipped');
  // With no post-deployment check asked for, no per-item deployment record is written: the merge is Done like any other (AC-11).
  const unverified = { ...merged, delivery: { ...merged.delivery!, deployment: undefined } } as Work;
  assert.equal(groupOf(unverified, NOW), 'shipped'); assert.equal(prSteps(unverified, NOW).current, 'done');
  for (const [state, item] of [['awaiting', awaiting], ['checking', checking], ['failed', failed]] as const) {
    assert.equal(groupOf(item, NOW), 'shipped', `${state}: a merged item is off the board`);
    assert.equal(prSteps(item, NOW).current, 'done', `${state}: merged is Done whatever the deployment owes`);
    assert.equal(prSteps(item, NOW).label, 'Live');
  }
  const releasing = classify(work.map(item => item.key === 'GY-18' ? awaiting : item), NOW);
  assert.equal(releasing.open, open, 'a merge waiting on its release adds no open item');
  const releasingPage = home(dashboard({ work: work.map(item => item.key === 'GY-18' ? awaiting : item) }));
  for (const group of groups) assert.ok(!rowsOf(releasingPage, group).includes('GY-18'), `${group}: no row for the merged item`);
  // "Shipped this week" counts what the release was seen serving this week; a merge from this
  // morning still waiting on the post-deployment check its policy asks for is not in the footer —
  // the release line says what production does not carry yet.
  const shippedLine = (html: string) => Number(/<strong>(\d+) shipped this week\.<\/strong>/.exec(html)?.[1]);
  const servedThisWeek = (items: Work[]) => items.filter(item => groupOf(item, NOW) === 'shipped' && releasedAt(item) !== null && NOW - releasedAt(item)! <= 7 * 24 * hour).map(item => item.key);
  assert.equal(shippedLine(page), servedThisWeek(work).length);
  const mergedToday = { ...awaiting, observation: { ...merged.observation!, mergedAt: new Date(NOW - hour).toISOString() } } as Work;
  const pending = work.map(item => item.key === 'GY-18' ? mergedToday : item);
  const pendingPage = home(dashboard({ work: pending }));
  assert.ok(!servedThisWeek(pending).includes('GY-18'));
  assert.equal(shippedLine(pendingPage), servedThisWeek(pending).length);
  assert.ok(!rowsOf(pendingPage, 'moving').includes('GY-18'), 'the pending merge has no row; it is Done');
  // The footer names it only as the latest merge (GY-168), never as shipped.
  assert.match(pendingPage.slice(pendingPage.indexOf('aria-label="Shipped this week"')), /Latest: <button type="button" class="text-button" data-latest="GY-18">[\s\S]*?<\/button> · Live · merged /);
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
  assert.match(firstScreen(itemPage('GY-17')), /A fault blocks it; the master agent clears it/);
  assert.match(firstScreen(itemPage('GY-22')), /In review/);
  // GY-22 waits on CI and on review: both fold into Checking (GY-1979), so what is left lists every
  // Checking requirement at once, the checks first, each with who clears it.
  const left = /aria-label="What is left"[\s\S]*?<\/section>/.exec(itemPage('GY-22'))?.[0] ?? '';
  assert.match(left, /aria-label="Checking state"/);
  assert.match(left, /cleared by Automated checks/);
  assert.match(left, /Automated check “test” has not passed yet/);
  assert.match(left, /Waiting for someone else to approve the latest code/);
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

test('unit:ui-pr-steps — every moving item shows the four states from its gates, done, current and pending, with the current state in plain words naming what it waits on', () => {
  const work = board();
  const withReasons = (item: Work, reasons: Record<string, string[]>) => ({ ...item, gates: item.gates.map(gate => reasons[gate.name] ? { ...gate, passed: reasons[gate.name].length === 0, reasons: reasons[gate.name] } : gate) }) as Work;
  const handedIn = find('GY-22', work);
  const ci = (name: string) => `Required CI check ${name} has not passed on the current candidate`;
  const trial = (item: Work) => `merge writer has not trialled ${item.candidate!.sha.slice(0, 12)} on ${item.candidate!.baseSha.slice(0, 12)}`;
  const refusedTrial = (item: Work) => ({ ...item, mergeLedger: { ...(item.mergeLedger ?? {}), state: 'refused', head: item.candidate!.sha } }) as unknown as Work;
  // Checking folds validate, test, review, proof and merge (GY-1979), so every gate case below is
  // Checking, and the label names the gate it waits on. A merge the release does not serve yet is Done.
  // GY-2988: the label people read is the plain stage; detail still names what the gate waits on.
  const cases: [string, Work, string, string, string][] = [
    ['worker building', find('GY-14', work), 'doing', 'Building', 'Builder agent'],
    ['CI running', handedIn, 'checking', 'In review', 'Automated checks'],
    // The merge writer's trial decides a check (GY-2010): a refused trial of this head failed the checks it names.
    ['CI failed', withReasons(refusedTrial(handedIn), { test: [trial(handedIn)] }), 'checking', 'In review', 'Builder agent'],
    ['review requested', find('GY-15', work), 'checking', 'In review', 'Reviewer agent'],
    ['proofs pending', find('GY-16', work), 'checking', 'Testing', 'Prover agent'],
    // An obligation inherited from another change's deferred proof counts in the total and stays open until proven.
    ['proofs pending on an inherited obligation', withReasons(find('GY-16', work), { acceptance: ['Bootstrap obligation inherited from GY-9 AC-2: integration:contract needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'] }), 'checking', 'Testing', 'Prover agent'],
    ['proofs no longer independent', withReasons(find('GY-16', work), { acceptance: [`Trusted ${find('GY-16', work).criteria[0].proofs[0]} evidence from producer-1 is no longer independent: producer-1 has since held an assignment on GY-16`] }), 'checking', 'Testing', 'Prover agent'],
    ['merging', find('GY-21', work), 'checking', 'Merging', 'Graphyard (automatic)'],
    // Repository serves nothing: a delivered item is Live (GY-2988).
    ['merged, not yet deployed', { ...find('GY-18', work), policy: { ...find('GY-18', work).policy, deploySmoke: true }, delivery: { ...find('GY-18', work).delivery!, deployment: undefined } } as Work, 'done', 'Live', 'Nobody — it has merged'],
    ['merged, deployment observed, smoke policy', { ...find('GY-18', work), policy: { ...find('GY-18', work).policy, deploySmoke: true } } as Work, 'done', 'Live', 'Nobody — it is live'],
    // A change request keeps the plain stage; detail names the send-back.
    ['changes requested', withReasons(find('GY-15', work), { review: ['Outstanding change requests must be resolved through a new review'] }), 'checking', 'In review', 'Graphyard (assigns a builder)'],
  ];
  // The CI Apps the test gate trusts, as status carries them.
  const trusted = noRelease;
  for (const [name, item, current, label, who] of cases) {
    const steps = prSteps(item, NOW, trusted);
    assert.deepEqual(steps.steps.map(step => step.id), [...stateIds], name);
    assert.deepEqual(steps.steps.map(step => step.label), ['Todo', 'Doing', 'Checking', 'Done']);
    assert.equal(steps.current, current, name); assert.equal(steps.label, label, name); assert.equal(steps.who, who, name);
    const at = stateIds.indexOf(current as never);
    assert.equal(steps.steps.filter(step => step.state === 'current').length, current === 'done' ? 0 : 1, `${name}: one live state until it is Done`);
    for (const step of steps.steps.slice(0, at)) assert.equal(step.state, 'done', `${name}: ${step.id} before the current state is done`);
    for (const step of steps.steps.slice(at + 1)) assert.equal(step.state, 'pending', `${name}: ${step.id} after the current state is pending`);
  }
  // A shipped item the live release serves has every state done, and Done current.
  const shipped = prSteps(find('GY-18', work), NOW);
  assert.equal(shipped.current, 'done');
  assert.ok(shipped.steps.every(step => step.state === 'done'));
  // The Work page row, the phone card (the same element, laid out as a card) and the item page draw the same states.
  for (const key of ['GY-14', 'GY-15', 'GY-16', 'GY-21', 'GY-22']) {
    const steps = prSteps(find(key, work), NOW);
    const row = markup(createElement(WorkCard, { item: find(key, work), now: NOW, onOpen: noop }));
    assert.equal((row.match(/data-step="/g) ?? []).length, 4, `${key} row shows the four states`);
    assert.match(row, new RegExp(`data-step="${steps.current}" data-state="current"`));
    assert.ok(row.includes(steps.label), `${key} row labels the current state`);
    const detail = firstScreen(itemPage(key));
    assert.match(detail, /aria-label="Item states"/);
    assert.match(detail, new RegExp(`data-step="${steps.current}" data-state="current"`), `${key} item page`);
  }
  const css = readdirSync(new URL('web/', root)).includes('style.css');
  assert.ok(css);
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
  assert.deepEqual(Object.values(roleWords).slice(0, 4), ['Builds code', 'Reviews code', 'Proves requirements', 'Runs the loop']);
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
  assert.match(html, /data-session="a15"[\s\S]*?<td data-label="Role">Runs the loop<\/td>[\s\S]*?<td data-label="Doing now">Approved the rework request<\/td>/);
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

// GY-168: the follow-ups from the browser review of GY-161's merge.

/** Hex runs long enough to be a commit SHA (at least one letter, so a numeric id is not one; a UUID's segments are not one either). */
const longHex = (text: string) => [...text.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, 'uuid').matchAll(/\b[0-9a-f]{9,}\b/gi)].map(match => match[0]).filter(hex => /[a-f]/i.test(hex));
