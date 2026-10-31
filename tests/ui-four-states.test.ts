import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { NOW, boardApi, boardStatus, boardWork, realDeliveredWork } from '../browser-tests/ui-board.js';
import { boardFromStatus, groupLabel, groups } from '../web/groups.js';
import { prSteps, stateIds, stepSince, type StepTransition } from '../src/model/pr-steps.js';
import TopBar, { ReleaseLine } from '../web/components/top-bar.js';
import OverviewPage from '../web/pages/overview.js';
import WorkDetails from '../web/pages/work-details.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-1979: the dashboard shows four states — Todo, Doing, Checking, Done — and one release line,
// instead of seven pull-request steps. The board lists Todo, Doing and Checking; a merged item is
// Done and leaves the board (its page still renders); the top bar names the commit production
// serves, its health and the merged changes it does not carry yet.

const minute = 60_000, hour = 60 * minute;
const board = () => boardWork() as unknown as Work[];
const find = (key: string, work: Work[] = board()) => work.find(item => item.key === key)!;
const noop = () => {};
function dashboard(work: Work[], overrides: Partial<Dashboard> = {}): Dashboard {
  const d: Dashboard = {
    token: 'fixture', work, status: boardStatus('admin'), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: {}, events: [], editingRequirements: false, setEditingRequirements: noop,
    codexAvailable: false, sessionEpoch: { current: 0 }, api: async (path: string) => boardApi(path), refresh: async () => {},
    action: async () => {}, setError: noop, signOut: noop, ...overrides,
  } as Dashboard;
  return 'board' in overrides ? d : { ...d, board: boardFromStatus(d.work, d.observedAt, d.status) };
}
const home = (work: Work[] = board(), overrides: Partial<Dashboard> = {}) =>
  renderToStaticMarkup(createElement('div', null, createElement(TopBar, dashboard(work, overrides)), createElement(OverviewPage, dashboard(work, overrides))));
const itemPage = (item: Work, work: Work[] = board()) => renderToStaticMarkup(createElement(WorkDetails, { ...dashboard(work), item }));
/** A merged item whose policy asks for a post-deployment check that has not run: merged, not yet deployed. */
const mergedUndeployed = () => {
  const merged = find('GY-18');
  return { ...merged, policy: { ...merged.policy, deploySmoke: true }, delivery: { ...merged.delivery!, deployment: undefined } } as unknown as Work;
};

test('unit:ui-four-states — prSteps returns exactly the four states Todo, Doing, Checking, Done, each proven from a fixture item, with Checking current from the hand-in until the merge and Done current once merged', () => {
  const work = board();
  // Every item carries exactly the four states, in order.
  for (const item of work) assert.deepEqual(prSteps(item, NOW).steps.map(step => step.id), [...stateIds], item.key);
  const segments = (steps: ReturnType<typeof prSteps>) => steps.steps.map(step => step.state).join(',');

  // Todo: not started — no lease and nothing handed in. GY-13 waits for a worker.
  const todo = prSteps(find('GY-13', work), NOW);
  assert.equal(todo.current, 'todo');
  assert.deepEqual(segments(todo), 'current,pending,pending,pending');
  assert.equal(todo.label, 'Building');
  assert.equal(todo.who, 'Graphyard (assigns a builder)');
  // A recorded blocker holds an unstarted item off the workers: the row's why names the fault and
  // the master agent clears it (the blocked row reads that, not the state label).
  const blocked = prSteps(find('GY-17', work), NOW);
  assert.equal(blocked.current, 'todo');
  assert.equal(blocked.label, 'Building');

  // Doing: a worker holds it and has not handed in. GY-14 is a builder at work.
  const doing = prSteps(find('GY-14', work), NOW);
  assert.equal(doing.current, 'doing');
  assert.deepEqual(segments(doing), 'done,current,pending,pending');
  assert.equal(doing.label, 'Building');
  assert.equal(doing.who, 'Builder agent');

  // Checking: handed in, until the merge — its label names what it waits on. GY-22 waits on CI.
  const checking = prSteps(find('GY-22', work), NOW);
  assert.equal(checking.current, 'checking');
  assert.deepEqual(segments(checking), 'done,done,current,pending');
  assert.equal(checking.label, 'In review');
  assert.equal(checking.who, 'Automated checks');
  // Waiting for review, and already merging, are Checking too — one state, what it waits on differs.
  assert.equal(prSteps(find('GY-15', work), NOW).label, 'In review');
  assert.equal(prSteps(find('GY-21', work), NOW).label, 'Merging');
  assert.equal(prSteps(find('GY-21', work), NOW).who, 'Graphyard (automatic)');
  // A requested rework says so in the Checking label; the hand-in stands until the merge.
  const changes = { ...find('GY-15', work), gates: find('GY-15', work).gates.map(gate => gate.name === 'review' ? { ...gate, passed: false, reasons: ['Outstanding change requests must be resolved through a new review'] } : gate) } as Work;
  assert.equal(prSteps(changes, NOW).current, 'checking');
  assert.equal(prSteps(changes, NOW).label, 'In review');
  assert.equal(prSteps(changes, NOW).detail, 'sent back for changes, waiting for a builder');
  // A blocker recorded after the hand-in is the Checking label's news, and the master agent clears it.
  const held = { ...find('GY-22', work), gates: find('GY-22', work).gates.map(gate => gate.name === 'ready' ? { ...gate, passed: false, reasons: ['Staging credentials expired'] } : gate) } as Work;
  assert.equal(prSteps(held, NOW).label, 'In review');
  assert.equal(prSteps(held, NOW).detail, 'held by a recorded blocker');
  assert.equal(prSteps(held, NOW).who, 'Master agent');

  // Done: merged — including a merge the release does not serve yet. No Deploy state exists.
  const undeployed = prSteps(mergedUndeployed(), NOW);
  assert.equal(undeployed.current, 'done');
  assert.deepEqual(segments(undeployed), 'done,done,done,done');
  assert.equal(undeployed.label, 'Live');
  assert.equal(undeployed.who, 'Nobody — it has merged');
  // Served by the release, it still reads Done, as Live.
  const live = prSteps(find('GY-18', work), NOW);
  assert.equal(live.current, 'done');
  assert.equal(live.label, 'Live');
  assert.equal(live.who, 'Nobody — it is live');

  // Closed without merging: no current state at all, nobody acts.
  const closed = { ...find('GY-22', work), stage: 'done', delivery: undefined, closure: { kind: 'obsolete', ref: null, reason: 'No longer needed', by: 'operator', at: new Date(NOW - hour).toISOString(), from: 'review' } } as unknown as Work;
  const closedSteps = prSteps(closed, NOW);
  assert.equal(closedSteps.current, null);
  assert.deepEqual(segments(closedSteps), 'pending,pending,pending,pending');
  assert.equal(closedSteps.who, 'Nobody — it was closed');
});

test('unit:ui-four-states-board — the board API and the Work page list only Todo, Doing and Checking items; a merged item is absent from the board while its page still renders; the top bar carries one release line', () => {
  // The board API: a merged item the release does not serve yet has no row in any group.
  const work = [...board(), ...realDeliveredWork() as unknown as Work[], mergedUndeployed()];
  const served = boardApi('board') as ReturnType<typeof boardFromStatus>;
  const rows = groups.flatMap(group => served.groups[group]);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.ok(['todo', 'doing', 'checking'].includes(prSteps(find(row.key, work), NOW).current ?? ''), `${row.key}: ${row.group}`);
  for (const merged of work.filter(item => item.stage === 'done')) {
    for (const group of groups) assert.ok(!served.groups[group].some(row => row.key === merged.key), `${merged.key} is absent from ${groupLabel[group]}`);
  }
  // The Work page renders the same absence, and the merged item's page still renders — Done.
  const page = home(work);
  for (const merged of work.filter(item => item.stage === 'done')) {
    assert.ok(!page.includes(`data-row="${merged.key}"`), `${merged.key} has no Work row`);
    const detail = itemPage(merged, work);
    assert.match(detail, new RegExp(`<h1 data-title="true"[^>]*>${merged.title}</h1>`));
    assert.match(detail, /aria-label="Item states"[\s\S]*?data-step="done"/, `${merged.key} shows the four states, Done last`);
  }
  // The tiles count the rows: no tile counts a merged item.
  for (const group of groups) {
    const tile = Number(new RegExp(`data-tile="${group}"[^>]*>[\\s\\S]*?<strong>(\\d+)</strong>`).exec(page)?.[1]);
    assert.equal(tile, served.groups[group].length, groupLabel[group]);
  }

  // The one release line, from the release view the board already reads: the served commit, its
  // health, and the merged changes it does not carry yet.
  const status = { ...boardStatus(), production: { observedAt: new Date(NOW - minute).toISOString(), serving: 'a'.repeat(40), error: null, pending: ['GY-18', 'GY-19', mergedUndeployed().key], incidents: [] } };
  const line = renderToStaticMarkup(createElement(ReleaseLine, { status }))!;
  assert.match(line, /data-release-line="serving"/);
  assert.match(line, /data-healthy="true"/);
  assert.match(line, /data-pending="3"/);
  assert.match(line, new RegExp(`title="${'a'.repeat(40)}">a{8}</span>`), 'the served commit, eight characters');
  assert.match(line, /Serving <span class="mono" title="a{40}">a{8}<\/span> · <strong>healthy<\/strong> · 3 merged changes not carried yet/);
  // An open deployment incident is an unhealthy release; the pending count is lag, not ill health.
  const unhealthy = { ...status, production: { ...status.production, incidents: [{ key: 'GY-18', status: 'missing', reason: 'no deployment observed' }] } };
  const failing = renderToStaticMarkup(createElement(ReleaseLine, { status: unhealthy }))!;
  assert.match(failing, /data-healthy="false"/);
  assert.match(failing, /<strong>unhealthy: 1 open deployment incident<\/strong>/);
  // Where nothing has observed production, the line says so rather than claiming either way.
  const unobserved = renderToStaticMarkup(createElement(ReleaseLine, { status: boardStatus() }))!;
  assert.match(unobserved, /data-release-line="unobserved"/);
  assert.match(unobserved, /Release: not watched/);
  // The Work page carries the line in its top bar, at the same place the reader starts.
  assert.match(home(work, { status: status as Dashboard['status'] }), /data-release-line="serving"/);
});

test('unit:ui-four-states-clock — a Checking item\'s clock starts at its own hand-in move, never at another item\'s move in the board-wide list (GY-1979 B2)', () => {
  const checking = find('GY-22');
  assert.equal(prSteps(checking, NOW).current, 'checking');
  // The move list is the board's, one list handed to every card (web/main.tsx `useStepMoves`):
  // another item's build → folded-step move must not start this item's clock (or its overdue flag).
  const other = { key: 'GY-999', from: 'build', to: 'test', at: new Date(NOW - minute).toISOString() } as StepTransition;
  assert.equal(stepSince(checking, NOW, [other]), stepSince(checking, NOW, []), 'another item\'s move does not move this clock');
  // Its own move into the folded Checking state does start it, even beside another item's move.
  const mine = { key: checking.key, from: 'build', to: 'validate', at: new Date(NOW - 2 * hour).toISOString() } as StepTransition;
  assert.equal(stepSince(checking, NOW, [mine, other]), mine.at);
  // A move between the folded steps does not restart it; a later own move out of Build (a rework's
  // fresh hand-in) does.
  const between = { key: checking.key, from: 'validate', to: 'test', at: new Date(NOW - hour).toISOString() } as StepTransition;
  assert.equal(stepSince(checking, NOW, [mine, between, other]), mine.at);
});
