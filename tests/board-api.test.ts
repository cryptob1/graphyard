import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { openHumanOnly } from '../src/model/human-request.js';
import { actorRole, groups, roleOf, type Board, type OpenGroup } from '../src/model/board.js';
import { statusRoutes } from '../src/server/routes/status.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { classify } from '../web/groups.js';
import { releaseView } from '../src/model/release.js';
import OverviewPage from '../web/pages/overview.js';
import WorkDetails from '../web/pages/work-details.js';
import { whatIsLeft } from '../web/item-page.js';
// A namespace import, so the proofs fail as test cases, not as a missing export, on a tree without GY-1739.
import * as plain from '../src/model/plain-status.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import { NOW, boardStatus, boardWork } from '../browser-tests/ui-board.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-200: one board. The dashboard derived its groups in the browser (web/groups.ts) while master
 * status spoke another vocabulary, so the operator saw three items Blocked, overdue, next actor
 * the master — and the master reported nothing stuck. The groups now
 * come from src/model/board.ts, served at GET /api/board, rendered by the Work page and read by
 * master status. Each test is named for the proof it produces.
 */

const minute = 60_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const passed = () => ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] as string[] }));
const refusing = (reasons: Record<string, string[]>) => passed().map(gate => reasons[gate.name] ? { ...gate, passed: false, reasons: reasons[gate.name] } : gate);

/**
 * The fixture board plus the shapes the incident had: an item blocked mid-attempt (GY-172, blocked
 * 90 minutes) and an item held behind the one it depends on (GY-175). GY-20 is parked on a human-only decision and
 * GY-21 has passed every gate but the merge.
 */
function scenario(): Work[] {
  const work = boardWork() as unknown as Work[];
  const template = work.find(item => item.key === 'GY-13')!;
  const make = (key: string, title: string, fields: Partial<Work>) => ({ ...template, id: `00000000-0000-4000-8000-${key.slice(3).padStart(12, '0')}`, key, title, ...fields }) as Work;
  const blocker = 'needs a staging database the item cannot provision';
  const stuck = make('GY-172', 'Blocked item', { stage: 'build', stageEnteredAt: at(-90 * minute), blocker,
    lease: { owner: 'worker-a', epoch: 2, expiresAt: at(20 * minute) }, lastAssignment: { owner: 'worker-a', epoch: 2, displayName: 'Cedar', runtime: 'Claude', claimedAt: at(-90 * minute) } as Work['lastAssignment'],
    gates: refusing({ ready: [blocker], build: ['Worker has not submitted implementation for this attempt'] }) });
  const waiting = make('GY-175', 'Held behind its dependency', { stage: 'ready', gates: refusing({ ready: ['Dependency GY-172 is unfinished'], build: ['Worker has not submitted implementation for this attempt'] }) });
  return [...work, stuck, waiting];
}

/** GET /api/board, through the route the server registers, over a store holding `work`. */
const boardRoute = statusRoutes.routes.find(route => route.method === 'GET' && route.path === '/api/board')!;
async function served(work: Work[]): Promise<Board> {
  const pool = { query: async (sql: string) => sql.includes('clock_timestamp') ? { rows: [{ now: new Date(NOW) }] } : { rows: [] } };
  const services = { engine: { store: { pool, fleet: async () => work }, ciAppIds: [1] }, production: null };
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
  expect('GY-172', 'blocked', 'master', 'graphyard master unblock GY-172 REASON');
  expect('GY-175', 'up-next', 'held', null);
  // GitHub merges a candidate every gate passes (GY-1235): there is no command to run for it.
  expect('GY-21', 'moving', 'executor', null);
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
  const root = await temporaryDirectory('board-master');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { stdio: 'ignore' });
  git('init', '-q'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'board\n'); git('add', 'README.md'); git('commit', '-q', '-m', 'board');
  const credentialFile = join(root, '.coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { root, master, dispose: () => rm(root, { recursive: true, force: true }) };
}

test('unit:master-status-board-owed — master status lists what the master owes from the board, first and with its command: a blocked item reads master unblock GY-N', async () => {
  const work = scenario();
  const { root, master, dispose } = await masterFixture();
  try {
    const failing = (status: number) => Object.assign(new Error(JSON.stringify({ error: status === 404 ? 'Route not found' : 'Internal error' })), { status });
    const report = async (board: 'served' | number) => masterStatusReport(root, master, async (path: string) => {
      if (path === 'work-snapshot') return { work, now: at(0) };
      if (path !== 'board') return { decisions: [] };
      if (board === 'served') return served(work);
      throw failing(board);
    }, { actor: { id: 'coordinator-1' }, humanOnly: humanRows(work) }, { commit: null });
    const status = await report('served');
    const shown = status.board;
    if ('error' in shown) assert.fail(shown.error);
    const owed = shown.owed;
    const stuck = owed.find(item => item.key === 'GY-172');
    assert.ok(stuck, `the blocked item is owed by the master: ${JSON.stringify(owed.map(item => item.key))}`);
    assert.equal(stuck.command, 'graphyard master unblock GY-172 REASON');
    assert.equal(stuck.group, 'blocked'); assert.equal(stuck.overdue, true);
    // Only the master's items are in the owed list; everything else follows it, and nothing is dropped.
    assert.ok(owed.every(item => item.actor === 'master'));
    assert.ok(!owed.some(item => item.key === 'GY-21' || item.key === 'GY-20'), 'a merge the queue is running and a human-only decision are not the master\'s');
    assert.ok(shown.others.every(item => item.actor !== 'master'));
    assert.ok(Object.keys(shown).indexOf('owed') < Object.keys(shown).indexOf('others'), 'the owed list comes first');
    const board = await served(work);
    assert.equal(owed.length + shown.others.length, board.open);
    assert.deepEqual(shown.counts, board.counts);
    // A server that predates the route: the same module builds the same board from the snapshot and status.
    const fallback = await report(404);
    assert.deepEqual(fallback.board, status.board);
    // Any other failure of the route is reported, not rebuilt around (GY-371): a 500 or an auth refusal surfaces.
    for (const code of [500, 401]) {
      const failed = (await report(code)).board;
      assert.ok('error' in failed, `a ${code} is not papered over with a locally built board`);
      assert.match(String(failed.error), /GET \/api\/board failed/, `a ${code} is reported`);
    }
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
  const [main, overview] = await Promise.all([read('web/main.tsx'), read('web/pages/overview.tsx')]);
  assert.match(main, /read\('board'\)/, 'the polling read fetches GET /api/board');
  assert.match(main, /api\('board'\)/, 'the refresh after an action fetches it too');
  assert.doesNotMatch(overview, /\bclassify\(|\bgroupOf\(|humanOnlyIds\(/, 'the Work page derives no group itself');
});

/**
 * GY-1739: the operator's Work page showed each blocked row's recorded reason verbatim twice — under
 * the title and again in the step column — 200 words of commands, paths and SHAs written for the
 * next agent. A blocked row now reads one plain sentence; the recorded text is on the item page once.
 */
const agentReason = 'Blocked at src/master-verification.ts:447: `node bin/graphyard.mjs master verify-deployment GY-1459 --json` exits 3 because '
  + "document.querySelector('[data-row=GY-1459] .row-steps') still renders the old label on 3b7de1dc18aa1f2e; see https://api.github.com/repos/cryptob1/graphyard/pulls/1152 at 0acd3d4d0a19e2f7c4b5a6d8e9f01234567890ab "
  + 'and tests/post-deploy-follow-ups.test.ts:212, then rebase onto 0acd3d4d0a and rerun npm test -- tests/board-api.test.ts before resubmitting; the JSON was {"state":"pending","sha":"14fb7da508"}.';
function blockedScenario(blocker: string, key = 'GY-176') {
  const work = scenario();
  const template = work.find(item => item.key === 'GY-13')!;
  const item = { ...template, id: '00000000-0000-4000-8000-000000000176', key, title: 'Blocked handed-in item', stage: 'build', stageEnteredAt: at(-30 * minute), blocker,
    submission: { epoch: 1, pr: 76 }, candidate: { sha: sha('c'), baseSha: sha('b'), pr: 76, branch: 'graphyard/gy-176-1', author: 'worker', createdAt: at(-60 * minute) },
    gates: refusing({ ready: [blocker] }) } as unknown as Work;
  return { work: [...work, item], item };
}
const rowOf = (html: string, key: string) => { const start = html.indexOf(`data-row="${key}"`); return html.slice(start, html.indexOf('data-row="', start + 1) > 0 ? html.indexOf('data-row="', start + 1) : undefined); };
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&quot;|&amp;|&lt;|&gt;/g, ' ').replace(/\s+/g, ' ').trim();
function details(work: Work[], item: Work) {
  const noop = () => {};
  const dashboard = { token: 'fixture', work, status: boardStatus('admin'), error: '', connected: true, lastUpdated: null, view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: item.id, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop, operatorAgents: [], operatorAgentsError: null,
    features: {}, events: [], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false, queue: [], sessionEpoch: { current: 0 }, api: async () => ({}),
    refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop, item } as unknown as Dashboard & { item: Work };
  return renderToStaticMarkup(createElement(WorkDetails, dashboard));
}
const fragments = ['0acd3d4d0a19e2f7c4b5a6d8e9f01234567890ab', 'src/master-verification.ts:447', 'verify-deployment GY-1459', 'tests/post-deploy-follow-ups.test.ts:212', 'api.github.com', 'querySelector'];

test('unit:board-blocked-row-plain-summary — a blocked row shows one plain sentence of at most 25 words naming the kind of block and who clears it; the recorded reason is on no Work page row and once on the item page', async () => {
  const { work, item } = blockedScenario(agentReason);
  const board = await served(work);
  const row = entry(board, item.key);
  assert.equal(row.group, 'blocked');
  const summary = row.blocker!.summary;
  assert.ok(summary.split(/\s+/).length <= 25, `at most 25 words: ${summary}`);
  assert.match(summary, /master agent clears it/, 'it names who clears it');
  assert.doesNotMatch(summary, /\.ts:|GY-1459|3b7de1|https?:|`/, 'none of the agent-facing detail');
  const html = page(work, board);
  const line = visible(rowOf(html, item.key));
  assert.ok(line.includes(summary), `the row reads the summary: ${line}`);
  for (const fragment of fragments) assert.ok(!html.includes(fragment), `no Work page row carries ${fragment}`);
  // The other kinds read their own block and who clears it.
  assert.match(plain.blockerSummary('Waiting on GY-1689 to merge first: its migration renames the table', NOW).sentence, /^Waiting on GY-1689; the master agent clears it/);
  assert.match(plain.blockerSummary('Waiting on a human-only decision (money or accounts): approve a cap for GY-1700', NOW).sentence, /^Waiting on a human answer to GY-1700; only you can clear it/);
  // The item page carries the recorded text exactly once, under Technical details.
  const view = details(work, item);
  for (const fragment of fragments) assert.equal(view.split(fragment).length - 1, 1, `${fragment} once on the item page`);
  assert.match(view, /Blocker as recorded/);
  const unescaped = view.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(unescaped.split(agentReason).length - 1, 1, 'the recorded reason once, whole and as written');
  // A short reason in plain words is still the agent's own: the row summarises it and never echoes it.
  const short = blockedScenario('Waiting for the coordinator to refresh');
  const shortBoard = await served(short.work);
  const shortRow = visible(rowOf(page(short.work, shortBoard), short.item.key));
  assert.doesNotMatch(shortRow, /coordinator to refresh/, shortRow);
  assert.ok(shortRow.includes(entry(shortBoard, short.item.key).blocker!.summary), shortRow);
});

test('unit:board-blocked-declined-human-names-master — a declined human answer reads as the master agent clearing the block, never as waiting on you', () => {
  const declined = 'A human declined spending money or opening third-party accounts for this item: not this quarter';
  const { item } = blockedScenario(declined);
  const summary = plain.blockerSummary(declined, NOW, { ...item, humanRequest: null });
  assert.match(summary.sentence, /master agent/);
  assert.doesNotMatch(summary.sentence, /only you|Waiting on a human/);
});

test('unit:board-blocked-next-action-no-echo — the item page Next-action paragraph points at the recorded blocker instead of repeating it', () => {
  const { work, item } = blockedScenario(agentReason);
  const escalated = { ...item, nextAction: { kind: 'attention', work: item.id, key: item.key, gate: 'ready', refusal: agentReason, reason: `${item.key} has waited past ${at(-minute)} on nobody named: ${agentReason}`,
    inputs: { kind: 'attention', trigger: 'stale-wait', detail: agentReason }, llmRole: 'decide', binding: 'liveness:stale-wait' } } as unknown as Work;
  const view = details(work.map(entry => entry.id === item.id ? escalated : entry), escalated);
  for (const fragment of fragments) assert.equal(view.split(fragment).length - 1, 1, `${fragment} once on the item page`);
  assert.match(view, /the recorded blocker, above/);
});

test('unit:board-blocked-row-no-duplicate-reason — a blocked row never says the same reason in two places', async () => {
  for (const blocker of [agentReason, 'Waiting on GY-1689 to merge first', 'git push failed: could not read Username for https://github.com: terminal prompts disabled']) {
    const { work, item } = blockedScenario(blocker);
    const board = await served(work);
    const html = page(work, board);
    const line = visible(rowOf(html, item.key));
    const summary = entry(board, item.key).blocker!.summary;
    assert.equal(line.split(summary).length - 1, 1, `the summary once in the row: ${line}`);
    // No clause of eight or more words appears twice in the row.
    const clauses = line.split(/\s*[·;—]\s*|(?<=\.)\s+/).filter(clause => clause.split(/\s+/).length >= 8);
    assert.equal(new Set(clauses).size, clauses.length, `no repeated clause: ${line}`);
    assert.doesNotMatch(line, /blocked: /, 'the step column names the block, never restates it');
  }
});

test('unit:board-blocked-row-waiting-until — a blocker naming a future not-before instant reads as waiting until that instant, not as a fault', async () => {
  const notBefore = at(6 * 60 * minute);
  const blocker = `The 24h observation for GY-1724 cannot exist yet: its window opens at deploy+24h, not before ${notBefore}; deferring per src/master-verification.ts:261.`;
  const { work, item } = blockedScenario(blocker);
  const board = await served(work);
  const summary = entry(board, item.key).blocker!.summary;
  // The server writes the time in UTC, naming the zone, and serves the instant itself for a reader in another zone.
  assert.equal(summary, `Waiting until ${plain.localInstant(Date.parse(notBefore), 'UTC')}; nothing is broken, and the master agent lifts the hold once that time passes.`);
  assert.match(summary, /UTC/);
  assert.equal(entry(board, item.key).blocker!.until, notBefore);
  assert.ok(summary.split(/\s+/).length <= 25, summary);
  assert.doesNotMatch(summary, /fault|problem|fix/i);
  // The recorded blocker stays until the master lifts it, so the sentence names the same clearer the board's actor does.
  assert.equal(entry(board, item.key).who, 'Master agent');
  // The browser writes the same instant in the reader's own zone, with the zone named.
  const local = `Waiting until ${plain.localInstant(Date.parse(notBefore))}; nothing is broken, and the master agent lifts the hold once that time passes.`;
  assert.equal(plain.blockerSummary(blocker, NOW).sentence, local);
  for (const timeZone of ['America/Los_Angeles', 'Asia/Kolkata']) assert.notEqual(plain.localInstant(Date.parse(notBefore), timeZone), plain.localInstant(Date.parse(notBefore), 'UTC'), timeZone);
  assert.ok(visible(rowOf(page(work, board), item.key)).includes(local));
  // With no next action the item is otherwise a stalled card: the wait still reads as the row's only sentence, never as a fault.
  const idle = work.map(entry => entry.id === item.id ? { ...entry, nextAction: null } as Work : entry);
  const idleBoard = await served(idle);
  const line = visible(rowOf(page(idle, idleBoard), item.key));
  assert.ok(line.includes(local), line);
  assert.doesNotMatch(line, /Nothing is happening|stuck at|nothing to do next/, line);
  // An instant already past is no wait: the block reads as the fault it is.
  const past = plain.blockerSummary(blocker.replace(notBefore, at(-60 * minute)), NOW).sentence;
  assert.doesNotMatch(past, /^Waiting until/);
  // Only the instant a wait word introduces is the deadline: an earlier retry or observation time in the same reason is not.
  const retry = at(30 * minute), observed = at(-30 * minute), later = at(9 * 60 * minute);
  const noisy = `Waiting for the 24h window: last observed ${observed}, next retry at ${retry}; not before ${notBefore}. Rechecked ${later}.`;
  assert.equal(plain.blockerSummary(noisy, NOW).until, notBefore, plain.blockerSummary(noisy, NOW).sentence);
  assert.equal(plain.blockerSummary(`Retry at ${retry}; the build failed`, NOW).kind === 'waiting-until', false);
  // The item's own observation window counts the same way.
  assert.match(plain.blockerSummary('Deferred.', NOW, { ...item, blocker: 'Deferred.', observationWindow: { notBefore, detail: '24h after deploy' } as Work['observationWindow'] }).sentence, /^Waiting until /);
});

// Every way a module names another: `import … from`, `export … from`, a side-effect `import`, a
// dynamic `import(` — of a literal or of `new URL(literal, import.meta.url)` (GY-1146) — and a
// `require(`, in any quote. A relative specifier is resolved against the importing file, dot
// segments and all, so `../x/../web/y` counts and `src/web/y` does not (GY-469).
const specifiers = /(?:\bfrom\s*|\bimport\s*\(?\s*(?:new\s+URL\s*\(\s*)?|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g;
const reachesWeb = (path: string, source: string) => [...source.matchAll(specifiers)].some(([, , specifier]) =>
  specifier!.startsWith('.') && /^web(?:\/|$)/.test(posix.join(posix.dirname(path), specifier!)));

test('manual:review-followups-triaged GY-469.1 (layering-guard-covers-every-import-form): the layering guard catches every form that reaches web/ — `from`, `export … from`, a side-effect import, a dynamic `import(`, `require(` and a path through dot segments — and nothing that resolves elsewhere', () => {
  for (const [path, form] of [
    ['src/server/a.ts', `import { x } from '../../web/x.js';`], ['src/a.ts', `export * from "../web/x.js";`], ['src/model/a.ts', `import '../../web/x.css';`],
    ['src/a.ts', 'await import(`../web/${name}.js`)'], ['src/a.ts', `require('../web/x')`], ['src/model/a.ts', `import x from '../../web';`],
    ['src/a.ts', `import '../placeholder/../web/x.js';`], ['src/a.ts', `import x from './../web/x.js';`],
  ] as const) assert.ok(reachesWeb(path, form), `the guard catches ${form} in ${path}`);
  for (const [path, form] of [
    ['src/a.ts', `import { x } from './web/x.js';`], ['src/model/a.ts', `import x from '../web/x.js';`], ['src/a.ts', `import x from '../webhooks/x.js';`],
    ['src/a.ts', `import '../web/../src/x.js';`], ['src/a.ts', `const web = '../web/';`], ['src/a.ts', `import x from 'web/x';`],
  ] as const) assert.ok(!reachesWeb(path, form), `the guard ignores ${form} in ${path}`);
});

test('manual:review-followups-triaged GY-1146.3 (layering-guard-catches-url-dynamic-import): the layering guard catches a dynamic import of `new URL(specifier, import.meta.url)` that resolves into web/, and ignores one that resolves elsewhere', () => {
  for (const [path, form] of [
    ['src/server/a.ts', `await import(new URL('../../web/x.js', import.meta.url))`], ['src/a.ts', 'await import( new URL( `../web/${name}.js`, import.meta.url ).href)'],
    ['src/a.ts', `import(new URL("../placeholder/../web/x.js", import.meta.url));`],
  ] as const) assert.ok(reachesWeb(path, form), `the guard catches ${form} in ${path}`);
  for (const [path, form] of [
    ['src/server/a.ts', `await import(new URL('../web/x.js', import.meta.url))`], ['src/a.ts', `await import(new URL('./web/x.js', import.meta.url))`],
    ['src/a.ts', `await import(new URL('../webhooks/x.js', import.meta.url))`],
  ] as const) assert.ok(!reachesWeb(path, form), `the guard ignores ${form} in ${path}`);
});

test('unit:server-does-not-import-web — the layering runs web → src only: no module under src imports from web/, so the runtime image needs no web tree (GY-371)', async () => {
  const sources = execFileSync('git', ['ls-files', 'src'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).split('\n').filter(path => /\.tsx?$/.test(path));
  const offenders: string[] = [];
  for (const path of sources) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    if (reachesWeb(path, source)) offenders.push(path);
  }
  assert.deepEqual(offenders, [], 'src imports nothing from web/');
  assert.doesNotMatch(await readFile(new URL('../Dockerfile', import.meta.url), 'utf8'), /COPY web /, 'the runtime image does not copy web/');
});

/** The source text of each top-level argument of the call whose `(` is at `open`, quoted strings skipped whole. */
function callArguments(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0, start = open + 1;
  for (let at = open; at < source.length; at++) {
    const char = source[at]!;
    if (char === "'" || char === '"' || char === '`') { at = source.indexOf(char, at + 1); continue; }
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char) && --depth === 0) { args.push(source.slice(start, at).trim()); return args; }
    else if (char === ',' && depth === 1) { args.push(source.slice(start, at).trim()); start = at + 1; }
  }
  throw new Error(`unclosed call at ${open}`);
}

/** The expression after `who:` up to the next top-level `,`, `;`, `}` or `)`. */
function whoValue(source: string, from: number): string {
  let depth = 0;
  for (let at = from; at < source.length; at++) {
    const char = source[at]!;
    if (char === "'" || char === '"' || char === '`') { at = source.indexOf(char, at + 1); continue; }
    if ('([{'.includes(char)) depth++;
    else if (depth === 0 && ',;})'.includes(char)) return source.slice(from, at).trim();
    else if (')]}'.includes(char)) depth--;
  }
  return source.slice(from).trim();
}

// What a `who` may be besides a label: its type, or a label forwarded from `prSteps`/`waitsOn`.
const forwardsLabel = new Set(['string', 'who', 'steps.who']);

test('manual:review-followups-triaged GY-469.2 (actor-role-covers-every-label): every `who` label nextActor, prSteps and waitsOn write — as `who:` in any quote, or the last argument of prSteps\' make() — names a role; any other `who` expression fails the scan; an unknown label reads as held, never the control plane (GY-469)', async () => {
  const labels = new Set<string>();
  const unscanned: string[] = [];
  const take = (path: string, expression: string) => {
    const literal = /^(['"`])([^'"`]*)\1$/.exec(expression);
    if (literal && !(literal[1] === '`' && literal[2]!.includes('${'))) labels.add(literal[2]!);
    else if (!forwardsLabel.has(expression)) unscanned.push(`${path}: ${expression}`);
  };
  for (const path of ['src/model/board.ts', 'src/model/pr-steps.ts']) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\bwho\s*:/g)) take(path, whoValue(source, match.index + match[0].length));
    for (const match of source.matchAll(/\bmake\(/g)) take(path, callArguments(source, match.index + match[0].length - 1).at(-1)!);
  }
  assert.deepEqual(unscanned, [], 'every who is a literal label or forwards one');
  for (const label of ['Nobody yet', 'Automated checks', 'Nobody — it was closed', 'Nobody — it is live', 'Nobody — it has merged'])
    assert.ok(labels.has(label), `the scan finds ${label} among ${[...labels].join(', ')}`);
  assert.deepEqual([...labels].filter(label => !Object.hasOwn(roleOf, label)), [], 'roleOf lists every label nextActor, prSteps and waitsOn write');
  const work = { lease: null } as unknown as Work;
  assert.equal(actorRole(work, 'moving', 'Nobody yet'), 'held');
  assert.equal(actorRole(work, 'moving', 'Automated checks'), 'executor');
  for (const label of ['Nobody — it was closed', 'Nobody — it is live', 'Nobody — it has merged'])
    assert.equal(actorRole(work, null, label), 'held', `${label}: nobody acts on closed or merged work`);
  assert.equal(actorRole(work, 'moving', 'Some future label'), 'held', 'an unknown label is not reported as the executor');
  assert.equal(actorRole(work, 'moving', 'toString'), 'held', 'an inherited property is no label');
});
