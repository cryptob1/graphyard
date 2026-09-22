import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { predictQueue } from '../src/merge-queue.js';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureApi, fixtureStatus, fixtureWork, NOW, visibleWords } from '../scripts/dashboard-fixture.mjs';
import { OVERDUE_MINUTES, formatDuration, statusDuration } from '../web/duration.js';
import { phaseOf, phaseLabel, statusHeld, statusSince } from '../web/plain-status.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import OverviewPage from '../web/pages/overview.js';
import WorkDetails from '../web/pages/work-details.js';
import WorkCard from '../web/components/work-card.js';

// GY-108: every work card carries how long it has held its current status, always, and says so
// in red past the one configured threshold. The renders here read the views the way a person
// does — visible text, no interaction — and the engine case drives a real item through a retry
// loop, so the claim that a stalled item cannot appear fresh is made against the control plane
// rather than against a hand-written timestamp.

const root = new URL('..', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
const markup = (element: any) => renderToStaticMarkup(element);
const noop = () => {};
const fixture = fixtureWork() as unknown as Work[];
const minute = 60_000;

function dashboard(work: Work[], observedAt = NOW, overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    token: 'fixture', work, status: fixtureStatus('admin'), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop,
    filter: null, setFilter: noop, selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop,
    observedAt, jobs: [], query: '', setQuery: noop, operatorAgents: [], operatorAgentsError: null, features: {} as any,
    events: fixtureApi('events') as any[], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false,
    queue: predictQueue(work, observedAt), sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, 'admin'),
    refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop, ...overrides,
  };
}
const homeView = (work: Work[], observedAt = NOW) => markup(createElement(OverviewPage as any, dashboard(work, observedAt)));
/** A board column draws the same component the list draws; web/pages/overview.tsx maps one `card`. */
const boardCard = (item: Work, observedAt = NOW) => markup(createElement(WorkCard as any, { item, now: observedAt, repository: 'fixture/repository', onOpen: noop }));
const itemView = (item: Work, work: Work[] = fixture, observedAt = NOW) => markup(createElement(WorkDetails as any, { ...dashboard(work, observedAt), item }));
/** Every duration the markup draws, in order, as a reader sees it. */
const ages = (html: string) => [...html.matchAll(/<span class="status-age(?: overdue)?"[^>]*>(.*?)<\/span>(?=\s*<\/div>|\s*<h)/g)]
  .map(match => visibleWords(match[1]).join(' '));
const overdueCount = (html: string) => (html.match(/class="status-age overdue"/g) ?? []).length;

/** The fixture item, moved so that it entered its current status `minutesAgo` minutes ago. */
const held = (key: string, minutesAgo: number, observedAt = NOW): Work => {
  const item = fixture.find(w => w.key === key)!;
  return { ...item, createdAt: new Date(observedAt - 90 * 24 * 60 * minute).toISOString(), stageEnteredAt: new Date(observedAt - minutesAgo * minute).toISOString(),
    pipeline: undefined, lease: item.lease && phaseOf(item, observedAt) === 'building' ? { ...item.lease, expiresAt: new Date(observedAt + 60 * minute).toISOString() } : item.lease } as Work;
};

// ---- AC-1: the duration is on every card, in every view, always ------------------------------

test('unit:card-shows-status-duration — every work card in every view carries how long it has held its status, measured from when it entered that status and drawn without a toggle', () => {
  const open = fixture.filter(w => w.stage !== 'done');
  const home = homeView(fixture);
  // One duration per open card the default view draws — no control to press, nothing collapsed.
  assert.equal(ages(home).length, open.length, `a duration on each of the ${open.length} open cards: ${ages(home).join(' | ')}`);
  // The default render is the untouched page: its times toggle is off, and the durations are
  // there all the same, so nothing has to be pressed to learn how long an item has waited.
  assert.match(home, /Show times/); assert.doesNotMatch(home, /\bp50\b/);
  for (const item of open) {
    const expected = formatDuration(Math.floor((NOW - Date.parse(statusSince(item, NOW))) / minute));
    assert.notEqual(expected, formatDuration(Math.floor((NOW - Date.parse(item.createdAt)) / minute)), `${item.key} is not showing its age`);
    assert.ok(ages(home).some(text => text.startsWith(expected)), `${item.key} shows ${expected} on the home page: ${ages(home).join(' | ')}`);
    // The same card, drawn as a board column draws it, and the item view: one number everywhere.
    assert.ok(ages(boardCard(item))[0]?.startsWith(expected), `${item.key} shows ${expected} in board view`);
    assert.ok(ages(itemView(item))[0]?.startsWith(expected), `${item.key} shows ${expected} in the item view`);
  }
  // The status the card names, not the stage behind it: the item whose claim lapsed reads
  // "Waiting for someone to pick this up", so its clock runs from when the claim lapsed rather
  // than from when it was claimed, and a card waiting forty seconds cannot look like one waiting
  // fifty minutes.
  const lapsed = fixture.find(w => w.key === 'GY-12')!;
  assert.equal(phaseOf(lapsed, NOW), 'needs-worker');
  assert.equal(statusSince(lapsed, NOW), lapsed.lease!.expiresAt);
  assert.ok(Date.parse(lapsed.lease!.expiresAt) > Date.parse(lapsed.stageEnteredAt), 'the claim lapsed after the stage was entered');

  // It is time in this status, not age: an item made long ago and moved a moment ago reads fresh.
  const moved = held('GY-15', 3);
  assert.equal(ages(boardCard(moved))[0], '3m');
  assert.equal(Math.round((NOW - Date.parse(moved.createdAt)) / minute), 90 * 24 * 60, 'the fixture item is ninety days old');
  assert.equal(statusHeld(moved, NOW).overdue, false, 'an item that just moved is not overdue, however old it is');
  // Unreadable instants say so rather than drawing a number nobody can trust.
  assert.equal(statusHeld({ ...moved, stageEnteredAt: '' } as Work, NOW).text, '—');
  // Delivered work shows how long it has been delivered and never reads as stopped.
  const shipped = fixture.find(w => w.stage === 'done')!;
  assert.equal(phaseOf(shipped, NOW), 'shipped');
  assert.equal(statusHeld(shipped, NOW).overdue, false, 'delivered work has arrived; it is not waiting on anything');
  assert.ok(ages(itemView(shipped))[0]!.length > 0, 'the item view of delivered work still says how long it has held that status');
});

// ---- AC-2: one threshold, thirty minutes, driving every view ---------------------------------

test('unit:overdue-threshold-applied — twenty-nine minutes is not red, thirty-one is, and one configured value decides it for every view', async () => {
  assert.equal(OVERDUE_MINUTES, 30, 'the operator\'s threshold');
  const views: [string, (item: Work) => string][] = [
    ['home list', item => homeView([item])],
    ['board column', item => boardCard(item)],
    ['item view', item => itemView(item)],
  ];
  for (const [name, render] of views) {
    for (const [minutes, overdue] of [[29, false], [30, false], [31, true], [90, true]] as const) {
      const item = held('GY-15', minutes);
      assert.equal(statusHeld(item, NOW).overdue, overdue, `${name}: ${minutes}m overdue=${overdue}`);
      const html = render(item);
      const marked = (html.match(/class="status-age overdue"/g) ?? []).length;
      assert.equal(marked > 0, overdue, `${name}: ${minutes} minutes is ${overdue ? 'red' : 'not red'} — ${ages(html).join(' | ')}`);
    }
  }
  // The card itself carries the same verdict, so a stalled item is legible from the list's shape.
  assert.match(boardCard(held('GY-15', 31)), /class="card tone-\w+ overdue"/);
  assert.doesNotMatch(boardCard(held('GY-15', 29)), /class="card tone-\w+ overdue"/);
  // The verdict is taken on the minutes the text renders, so nothing turns red while reading 30m.
  for (const seconds of [30 * 60, 30 * 60 + 59]) {
    const at = statusDuration(NOW - seconds * 1000, NOW);
    assert.equal(at.text, '30m'); assert.equal(at.overdue, false);
  }
  assert.equal(statusDuration(NOW - 31 * minute, NOW).text, '31m');
  assert.equal(statusDuration(NOW - 31 * minute, NOW).overdue, true);

  // And the value is configured once rather than repeated per view: no other source carries a
  // threshold of its own, and each view reaches the verdict through the one call.
  const sources = ['web/duration.ts', 'web/plain-status.ts', 'web/components/status-age.tsx', 'web/components/work-card.tsx', 'web/pages/work-details.tsx', 'web/pages/overview.tsx'];
  const definitions: string[] = [];
  for (const path of sources) {
    const source = await read(path);
    if (/OVERDUE_MINUTES\s*=/.test(source)) definitions.push(path);
    if (path === 'web/duration.ts') continue;
    // Outside the one definition, nothing compares a duration with a number of its own.
    assert.doesNotMatch(source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ''), /\bminutes\s*[<>]=?\s*\d/, `${path} judges nothing against its own number`);
    assert.doesNotMatch(source, /overdue\s*[:=]\s*(?!false\b)[^;,)]*\d/, `${path} derives overdue rather than computing it`);
  }
  assert.deepEqual(definitions, ['web/duration.ts'], 'the threshold has one home');
  // Every view reaches the verdict through the one call.
  for (const path of ['web/components/work-card.tsx', 'web/pages/work-details.tsx']) assert.match(await read(path), /statusHeld\(item, now\)/);
  assert.match(await read('web/components/status-age.tsx'), /held\.overdue/);
});

// ---- AC-4: the red state survives greyscale, colour blindness and a screen reader -------------

test('integration:overdue-legible-without-colour — an overdue duration is marked in words and in shape, not in colour alone', async () => {
  const late = boardCard(held('GY-15', 91));
  const fresh = boardCard(held('GY-15', 9));
  // The word is real text on the page, so a screen reader announces it and greyscale keeps it.
  assert.ok(visibleWords(late).includes('overdue'), `the word is visible text: ${visibleWords(late).join(' ')}`);
  assert.ok(!visibleWords(fresh).includes('overdue'));
  assert.notEqual(ages(late)[0], ages(fresh)[0], 'the two states differ in text, not only in colour');
  assert.equal(ages(late)[0], '1h 31m overdue');
  assert.equal(ages(fresh)[0], '9m');
  // The shape is decoration beside the word, hidden from assistive technology so nothing repeats.
  assert.match(late, /<span class="overdue-mark" aria-hidden="true">▲ <\/span>/);
  assert.doesNotMatch(fresh, /overdue-mark/);
  // The tooltip says the whole thing, including what the threshold is.
  assert.match(late, /title="In this status for 1h 31m — longer than the 30m an item may hold one status before it counts as stopped"/);
  assert.match(fresh, /title="In this status for 9m"/);
  // Colour is the third cue, and it carries its own weight: the red meets the text contrast bar
  // the rest of the dashboard meets (WCAG AA, 4.5:1) against the card it is drawn on.
  const style = await read('web/style.css');
  const colour = /\.status-age\.overdue\{[^}]*color:(#[0-9a-f]{6})/.exec(style)?.[1];
  const background = /\.card\{[^}]*background:(#[0-9a-f]{6})/.exec(style)?.[1];
  assert.ok(colour && background, `the overdue colour and the card background are declared: ${colour} on ${background}`);
  const luminance = (hex: string) => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (luminance(colour!) + 0.05) / (luminance(background!) + 0.05);
  assert.ok(contrast >= 4.5, `overdue red ${colour} on ${background} is ${contrast.toFixed(2)}:1`);
  // And the red is not the amber the dashboard already uses for "waiting", so the two read apart.
  assert.notEqual(colour, /\.amber\{color:(#[0-9a-f]{6})/.exec(style)?.[1]);
});

// ---- AC-3: the duration follows real movement, driven through the engine ---------------------

const operator: Principal = { id: 'card-timing-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'card-timing-worker', role: 'worker', sessionKind: 'ai' };
const executor: Principal = { id: 'card-timing-executor', role: 'coordinator' };
let database: EmbeddedPostgres, store: Store, engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_CARD_TIMING_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 45);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-card-timing-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  // A generous claim lease: this case reads the same recorded item at synthetic observation
  // times, and a lease that lapses between them would change the status under the reading.
  engine = new Engine(store, [15368], 3600, 'owner/project');
  engine.principals = [operator, worker, executor];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('integration:status-duration-tracks-real-progress — a retry loop, a heartbeat and an observation leave the clock running; only entering a new status restarts it', async () => {
  const id = () => randomUUID();
  let item = await engine.execute(operator, 'create', null, { title: 'Card timing', plannedFiles: ['src/card-timing.ts'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, id());
  item = await engine.execute(operator, 'ready', item.id, {}, id());

  // Waiting for a worker. The observation time is the reader's, so the same recorded item is
  // read at ten, twenty and thirty-one minutes without waiting for a real clock.
  const waiting = Date.parse(statusSince(item, Date.now()));
  const reading = (at: number, of: Work = item) => statusHeld(of, waiting + at * minute);
  assert.equal(phaseOf(item, waiting), 'needs-worker');
  assert.deepEqual([10, 20, 31].map(at => reading(at).minutes), [10, 20, 31]);
  assert.deepEqual([10, 20, 31].map(at => reading(at).overdue), [false, false, true]);

  // A retry loop: the control plane asks for this item to be dispatched, an executor takes the
  // action and reports it failed, and the row returns to the queue for another attempt. Nothing
  // about the item moved, so nothing about its clock may move either.
  const climbing: number[] = [];
  for (let round = 0; round < 3; round++) {
    await store.pool.query("UPDATE work_items SET document=(document #- '{actionQueue,actions,0,retryAt}') WHERE id=$1", [item.id]);
    const claimed = await engine.claimNextAction(executor, { host: 'card-timing-host' }, id());
    assert.equal(claimed.action?.kind, 'dispatch', `round ${round} offers the dispatch again`);
    const settled = await engine.settleClaimedAction(executor, claimed.action!.id, { result: 'failed', reason: 'no worker runtime answered' }, id());
    assert.equal(settled.action.result, 'failed');
    assert.equal(settled.action.attempts, round + 1, 'the same action, retried');
    item = (await store.list()).find(row => row.id === item.id)!;
    assert.equal(Date.parse(statusSince(item, Date.now())), waiting, `round ${round}: a failed retry is not a move`);
    climbing.push(reading(40 + round * 10).minutes!);
  }
  assert.deepEqual(climbing, [40, 50, 60], 'the duration keeps climbing through the retry loop');
  assert.ok(climbing.every(minutes => minutes > OVERDUE_MINUTES), 'and stays red the whole way');
  assert.equal(phaseOf(item, waiting), 'needs-worker', 'still waiting for a worker, and still saying so');

  // Entering a new status restarts it: a worker claims the item and the card names a new status.
  item = await engine.execute(worker, 'claim', item.id, {}, id());
  const building = Date.parse(statusSince(item, Date.now()));
  assert.equal(phaseOf(item, building), 'building');
  assert.ok(building > waiting, 'the clock restarted on the move');
  assert.equal(statusHeld(item, building + 5 * minute).minutes, 5, 'and counts from the move, not from before it');

  // A heartbeat and a workspace are facts about the same status, not a move.
  item = await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'card-timing-host', path: `/tmp/card-timing/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}` }, id());
  for (let beat = 0; beat < 3; beat++) item = await engine.execute(worker, 'heartbeat', item.id, { epoch: item.epoch }, id());
  assert.equal(Date.parse(statusSince(item, Date.now())), building, 'a heartbeat renews the claim; it does not move the item');
  assert.equal(statusHeld(item, building + 45 * minute).overdue, true, 'so a worker that has stopped shows red however often it checks in');

  // Handing the work in is a move the stage alone does not see: the build gate still refuses
  // until GitHub is observed, and the card's sentence changes all the same.
  item = await engine.execute(worker, 'submit', item.id, { epoch: item.epoch, pr: 4108 }, id());
  const handedIn = Date.parse(statusSince(item, Date.now()));
  assert.equal(item.stage, 'build', 'the stage has not moved');
  assert.notEqual(phaseLabel[phaseOf(item, handedIn)], phaseLabel.building);
  assert.ok(handedIn > building, 'but the status the card names has, so the clock restarted with it');
  assert.equal(statusHeld(item, handedIn + 29 * minute).overdue, false);
  assert.equal(statusHeld(item, handedIn + 31 * minute).overdue, true);

  // An observation that changes nothing leaves the restarted clock running.
  const observed = await engine.observe(item.id, item.revision, { candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 4108, branch: `graphyard/${item.key.toLowerCase()}-1`, author: worker.id }, reviews: [], checks: [], merged: false } as any);
  assert.equal(Date.parse(statusSince(observed, Date.now())) >= handedIn, true);
  assert.equal(statusHeld(observed, Date.parse(statusSince(observed, Date.now())) + 50 * minute).overdue, true, 'a stalled item cannot be made fresh by being looked at');
});
