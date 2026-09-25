import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { openHumanOnly } from '../src/model/human-request.js';
import { scopeRefusalBlocker } from '../src/model/scope.js';
import { groups, type Board, type OpenGroup } from '../src/model/board.js';
import { statusRoutes } from '../src/server/routes/status.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { classify } from '../web/groups.js';
import { releaseView } from '../web/release.js';
import OverviewPage from '../web/pages/overview.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import { NOW, boardStatus, boardWork } from '../browser-tests/ui-board.js';

/**
 * GY-200: one board. The dashboard derived its groups in the browser (web/groups.ts) while master
 * status spoke another vocabulary, so the operator saw three items Blocked on refused scope
 * requests, overdue, next actor the master — and the master reported nothing stuck. The groups now
 * come from src/model/board.ts, served at GET /api/board, rendered by the Work page and read by
 * master status. Each test is named for the proof it produces.
 */

const minute = 60_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const passed = () => ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] as string[] }));
const refusing = (reasons: Record<string, string[]>) => passed().map(gate => reasons[gate.name] ? { ...gate, passed: false, reasons: reasons[gate.name] } : gate);

/**
 * The fixture board plus the shapes the incident had: a worker's scope request the widening rule
 * refused (GY-172, blocked 90 minutes), a merge held by an escalation nobody resolved (GY-174), and
 * an item held behind the one it depends on (GY-175). GY-20 is parked on a human-only decision and
 * GY-21 has passed every gate but the merge.
 */
function scenario(): Work[] {
  const work = boardWork() as unknown as Work[];
  const template = work.find(item => item.key === 'GY-13')!;
  const make = (key: string, title: string, fields: Partial<Work>) => ({ ...template, id: `00000000-0000-4000-8000-${key.slice(3).padStart(12, '0')}`, key, title, ...fields }) as Work;
  const refused = `${scopeRefusalBlocker}: docs/board.md is outside the widening rule`;
  const scope = make('GY-172', 'Scope-refused item', { stage: 'build', stageEnteredAt: at(-90 * minute), blocker: refused,
    lease: { owner: 'worker-a', epoch: 2, expiresAt: at(20 * minute) }, lastAssignment: { owner: 'worker-a', epoch: 2, displayName: 'Cedar', runtime: 'Claude', claimedAt: at(-90 * minute) } as Work['lastAssignment'],
    scopeRequest: { epoch: 2, paths: ['docs/board.md'], reason: 'The board endpoint needs its page', requestedBy: 'worker-a', at: at(-80 * minute),
      decision: { state: 'refused', reason: 'outside the widening rule', at: at(-79 * minute), decidedBy: 'graphyard', waitedMs: minute, paths: ['docs/board.md'], requestedBy: 'worker-a', requestedAt: at(-80 * minute), epoch: 2 } },
    gates: refusing({ ready: [refused], build: ['Worker has not submitted implementation for this attempt'] }) });
  const held = make('GY-174', 'Held item', { stage: 'merge', stageEnteredAt: at(-45 * minute), submission: { epoch: 1, pr: 74 } as Work['submission'],
    candidate: { sha: sha('h'), baseSha: sha('b'), pr: 74, branch: 'graphyard/gy-174-1', author: 'worker', createdAt: at(-2 * 60 * minute) } as Work['candidate'],
    gates: refusing({ merge: ['Unresolved lease-loss escalation requires operator resolution: the builder lost contact'] }) });
  const waiting = make('GY-175', 'Held behind its dependency', { stage: 'ready', gates: refusing({ ready: ['Dependency GY-172 is unfinished'], build: ['Worker has not submitted implementation for this attempt'] }) });
  return [...work, scope, held, waiting];
}

/** GET /api/board, through the route the server registers, over a store holding `work`. */
const boardRoute = statusRoutes.routes.find(route => route.method === 'GET' && route.path === '/api/board')!;
async function served(work: Work[]): Promise<Board> {
  const pool = { query: async (sql: string) => sql.includes('clock_timestamp') ? { rows: [{ now: new Date(NOW) }] } : { rows: [] } };
  const services = { engine: { store: { pool, list: async () => work }, ciAppIds: [1] }, production: null };
  return boardRoute.handle({ actor: { id: 'operator', role: 'admin' }, services, operatorVisible: (items: unknown[]) => items } as any, []) as Promise<Board>;
}
const humanRows = (work: Work[]) => openHumanOnly(work.map(item => ({ work: item, decisions: [] })), NOW);
const entry = (board: Board, key: string) => groups.flatMap(group => board.groups[group]).find(item => item.key === key)!;

test('unit:board-api-matches-dashboard — GET /api/board gives each open item its group, next actor and command, and web/groups.ts groups the same data the same way', async () => {
  assert.ok(boardRoute, 'the server registers GET /api/board');
  const work = scenario();
  const board = await served(work);
  const expect = (key: string, group: OpenGroup, actor: string, command: string | null) => {
    const item = entry(board, key);
    assert.ok(item, `${key} is on the board`);
    assert.deepEqual({ group: item.group, actor: item.actor, command: item.command }, { group, actor, command }, key);
  };
  expect('GY-172', 'blocked', 'master', 'graphyard master scope GY-172');
  expect('GY-174', 'blocked', 'master', 'graphyard master decide GY-174 resolve REASON');
  expect('GY-175', 'up-next', 'executor', null);
  expect('GY-21', 'moving', 'executor', 'graphyard master merge GY-21');
  const request = work.find(item => item.key === 'GY-20')!.humanRequest!;
  expect('GY-20', 'needs-you', 'human-only', `graphyard answer GY-20 ${request.id} ANSWER`);
  expect('GY-17', 'blocked', 'master', 'graphyard master unblock GY-17 REASON');
  expect('GY-11', 'backlog', 'master', 'graphyard master release GY-11');

  // Every field an automation needs, on every item: stage, owner, since, overdue against the bound.
  assert.equal(board.overdueAfterMs, 30 * minute);
  for (const item of groups.flatMap(group => board.groups[group])) {
    assert.ok(typeof item.stage === 'string' && item.stage.length > 0, `${item.key} has a stage`);
    assert.ok(Number.isFinite(Date.parse(item.since)) && Date.parse(item.since) <= NOW, `${item.key} says since when`);
    assert.equal(typeof item.overdue, 'boolean');
    assert.ok(item.owner === null || typeof item.owner === 'string');
  }
  assert.equal(entry(board, 'GY-172').owner, 'worker-a');
  assert.equal(entry(board, 'GY-172').overdue, true, 'blocked for 90 minutes is past the 30-minute bound');
  assert.equal(entry(board, 'GY-21').overdue, false, 'a merge a minute old is not');
  assert.equal(entry(board, 'GY-20').overdue, false, 'Needs you shows how long it waited, never overdue');
  assert.equal(entry(board, 'GY-20').since, request.at);

  // The page's module groups the same data exactly as the server did: same items, same order.
  const status = { ...boardStatus('admin'), humanOnly: humanRows(work) };
  const { byGroup, open } = classify(work, NOW, status.humanOnly, releaseView(status));
  for (const group of groups) assert.deepEqual(board.groups[group].map(item => item.key), byGroup[group].map(item => item.key), `group ${group}`);
  assert.equal(board.open, open);
  assert.deepEqual(board.counts, Object.fromEntries(groups.map(group => [group, byGroup[group].length])));
  // And the web module is the model module, not a copy that could drift.
  assert.equal(classify, (await import('../src/model/board.js')).classify);
});

async function masterFixture() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-board-master-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { stdio: 'ignore' });
  git('init', '-q'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'board\n'); git('add', 'README.md'); git('commit', '-q', '-m', 'board');
  const credentialFile = join(root, '.coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { root, master, dispose: () => rm(root, { recursive: true, force: true }) };
}

test('unit:master-status-board-owed — master status lists what the master owes from the board, first and with its command: a refused scope request reads master scope GY-N', async () => {
  const work = scenario();
  const { root, master, dispose } = await masterFixture();
  try {
    const report = async (serveBoard: boolean) => masterStatusReport(root, master, async (path: string) =>
      path === 'work-snapshot' ? { work, now: at(0) } : path === 'board' && serveBoard ? served(work) : { decisions: [] },
    { actor: { id: 'coordinator-1' }, humanOnly: humanRows(work) }, { commit: null });
    const status = await report(true);
    const owed = status.board.owed;
    const scope = owed.find(item => item.key === 'GY-172');
    assert.ok(scope, `the refused scope request is owed by the master: ${JSON.stringify(owed.map(item => item.key))}`);
    assert.equal(scope.command, 'graphyard master scope GY-172');
    assert.equal(scope.group, 'blocked'); assert.equal(scope.overdue, true);
    assert.equal(owed.find(item => item.key === 'GY-174')?.command, 'graphyard master decide GY-174 resolve REASON', 'the unresolved escalation is owed too');
    // Only the master's items are in the owed list; everything else follows it, and nothing is dropped.
    assert.ok(owed.every(item => item.actor === 'master'));
    assert.ok(!owed.some(item => item.key === 'GY-21' || item.key === 'GY-20'), 'a merge the queue is running and a human-only decision are not the master\'s');
    assert.ok(status.board.others.every(item => item.actor !== 'master'));
    assert.ok(Object.keys(status.board).indexOf('owed') < Object.keys(status.board).indexOf('others'), 'the owed list comes first');
    const board = await served(work);
    assert.equal(owed.length + status.board.others.length, board.open);
    assert.deepEqual(status.board.counts, board.counts);
    // A server that predates the route: the same module builds the same board from the snapshot and status.
    const fallback = await report(false);
    assert.deepEqual(fallback.board, status.board);
  } finally { await dispose(); }
});

/** The Work page rendered from a dashboard whose board is `board`. */
function page(work: Work[], board: Board | null, query = '') {
  const noop = () => {};
  const dashboard = { token: 'fixture', work, board, status: boardStatus('admin'), error: '', connected: true, lastUpdated: null, view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query, setQuery: noop, operatorAgents: [], operatorAgentsError: null,
    features: {}, events: [], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false, queue: [], sessionEpoch: { current: 0 }, api: async () => ({}),
    refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop } as unknown as Dashboard;
  return renderToStaticMarkup(createElement(OverviewPage, dashboard));
}
function rendered(html: string, group: OpenGroup): string[] {
  const start = html.indexOf(`data-group-section="${group}"`);
  if (start < 0) return [];
  const next = [html.indexOf('data-group-section="', start + 1), html.indexOf('aria-label="Shipped this week"', start)].filter(index => index > 0);
  return [...html.slice(start, Math.min(...next)).matchAll(/data-row="([^"]+)"/g)].map(match => match[1]);
}
const tile = (html: string, group: OpenGroup) => Number(new RegExp(`data-tile="${group}"[^>]*>[\\s\\S]*?<strong>(\\d+)</strong>`).exec(html)?.[1]);

test('unit:dashboard-uses-board-api — the Work page renders the groups GET /api/board returns and derives none of its own', async () => {
  const work = scenario();
  const board = await served(work);
  const html = page(work, board);
  for (const group of groups) {
    assert.deepEqual(rendered(html, group), board.groups[group].map(item => item.key), `the ${group} section lists the board's ${group} items in its order`);
    assert.equal(tile(html, group), board.groups[group].length, `the ${group} tile counts the board's ${group} items`);
  }

  // A board that says otherwise wins: the page shows the server's answer, not one of its own.
  const moved = entry(board, 'GY-21');
  const doctored: Board = { ...board, groups: { ...board.groups, moving: board.groups.moving.filter(item => item.key !== 'GY-21'), blocked: [...board.groups.blocked, { ...moved, group: 'blocked' }] } };
  const served21 = page(work, doctored);
  assert.ok(rendered(served21, 'blocked').includes('GY-21') && !rendered(served21, 'moving').includes('GY-21'), 'GY-21 is where the API put it');
  // Search filters the board's rows; it does not re-classify them.
  assert.deepEqual(rendered(page(work, board, 'GY-172'), 'blocked'), ['GY-172']);

  // Until the board is read, no group is drawn from the snapshot.
  const reading = page(work, null);
  assert.equal(reading.includes('data-group-section='), false, 'no group before the board answers');
  assert.match(reading, /Reading the board/);

  // The poll reads the board beside the snapshot and status, and the page carries no classifier.
  const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [main, overview, docs] = await Promise.all([read('web/main.tsx'), read('web/pages/overview.tsx'), read('docs/dashboard.md')]);
  assert.match(main, /read\('board'\)/, 'the polling read fetches GET /api/board');
  assert.match(main, /api\('board'\)/, 'the refresh after an action fetches it too');
  assert.doesNotMatch(overview, /\bclassify\(|\bgroupOf\(|humanOnlyIds\(/, 'the Work page derives no group itself');
  assert.match(docs, /GET \/api\/board/, 'docs/dashboard.md documents the endpoint');
});
