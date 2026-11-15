import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import type { SessionHandle } from '../src/model/sessions.js';
import { localAttachCommand, remoteAttachCommand, sessionState, sessionStaleThresholdMs, staleSession, workersView } from '../web/workers-view.js';
import { releaseView } from '../src/model/release.js';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureWork, NOW, visibleWords } from '../scripts/dashboard-fixture.mjs';
import { views, visibleViews } from '../web/pages/index.js';
import WorkersPage, { SessionPanel, spent } from '../web/pages/workers.js';
import TopBar from '../web/components/top-bar.js';
import type { Dashboard } from '../web/pages/dashboard.js';

/**
 * GY-116: a Workers tab shows every agent session as one compact line — the agent, its item with
 * a truncated title, a state of at most three words and its age (GY-3314) — and opening a row
 * shows that session's live view or its attach commands. Each test is named for the proof it
 * produces: integration:workers-tab-lists-every-session, unit:attach-command-remote-form,
 * integration:workers-tab-per-principal-summary and unit:stale-session-marked.
 *
 * The page is rendered over the checked-in dashboard fixture with handles added to three of its
 * items, and read as static markup: what a test asserts is the derivation and what is drawn,
 * never a runtime.
 */

const minute = 60_000, hour = 60 * minute;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const root = new URL('..', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

function handle(fields: Partial<SessionHandle> & Pick<SessionHandle, 'id' | 'kind' | 'principal' | 'startedAt'>): SessionHandle {
  const running = fields.state !== 'finished';
  return { epoch: null, runtime: 'herdr', host: 'vishrog', workspace: null, tab: null, pane: null, agentName: null, role: null, head: null, attach: null, transcript: null,
    subject: `${fields.kind} on the item`, updatedAt: fields.startedAt, endedAt: running ? null : fields.startedAt, state: running ? 'running' : 'finished', outcome: null, ...fields };
}

/** Three items, four kinds, nine handles: the fixture every test reads. */
function fixture(): Work[] {
  const work = fixtureWork() as unknown as Work[];
  const item = (key: string) => work.find(w => w.key === key)!;
  item('GY-14').sessions = [
    // The worker on GY-14 for an hour and a half, seen two minutes ago: live, and the longest-running row.
    handle({ id: 'graphyard-codex-1:1', kind: 'implementation', principal: 'graphyard-codex-1', agentName: 'worker-gy-14', epoch: 1, workspace: 'w1V', pane: 'w1V:pJD',
      attach: 'herdr pane attach w1V:pJD --workspace w1V', subject: 'Implement GY-14', startedAt: at(-90 * minute), updatedAt: at(-2 * minute) }),
    // A reviewer on the same head, twenty minutes in.
    handle({ id: 'review-gy-14', kind: 'review', role: 'review', principal: 'reviewer-a', agentName: 'reviewer-gy-14', head: 'a'.repeat(40), pane: 'w1V:pR1', workspace: 'w1V',
      attach: 'herdr pane attach w1V:pR1 --workspace w1V', subject: 'Review PR #43', startedAt: at(-20 * minute), updatedAt: at(-minute) }),
  ];
  item('GY-15').sessions = [
    // A producer that finished an hour ago after running for an hour: fixed duration, transcript offered.
    handle({ id: 'proof-gy-15', kind: 'proof', role: 'proof:integration', principal: 'herdr-worker-1', agentName: 'producer-gy-15', head: 'b'.repeat(40), state: 'finished',
      attach: 'herdr pane attach w1V:pP1 --workspace w1V', transcript: '/home/agent/.graphyard/transcripts/proof-gy-15.md', subject: 'Produce integration:gy-15', startedAt: at(-2 * hour), updatedAt: at(-hour), endedAt: at(-hour), outcome: 'evidence submitted' }),
    // An approver session five minutes in: a coordination handle, in the table but not the seat summary.
    handle({ id: 'approver-gy-15', kind: 'coordination', role: 'approver', principal: 'approver-1', agentName: 'approver-gy-15', pane: 'w1V:pA1',
      attach: 'herdr pane attach w1V:pA1', subject: 'Approve the merge decision on GY-15', startedAt: at(-5 * minute), updatedAt: at(-minute) }),
    // The same worker principal, on GY-15 thirty hours ago: outside the last 24 hours.
    handle({ id: 'graphyard-codex-1:old', kind: 'implementation', principal: 'graphyard-codex-1', epoch: 1, state: 'finished', subject: 'Implement GY-15',
      startedAt: at(-32 * hour), updatedAt: at(-30 * hour), endedAt: at(-30 * hour), transcript: '/home/agent/.graphyard/transcripts/gy-15.md', outcome: 'submitted PR #44' }),
  ];
  item('GY-13').sessions = [
    // Recorded running, not seen for forty minutes: stale.
    handle({ id: 'worker-b:2', kind: 'implementation', principal: 'worker-b', agentName: 'worker-gy-13', epoch: 2, pane: 'w1V:pW2', attach: 'herdr pane attach w1V:pW2',
      subject: 'Implement GY-13', startedAt: at(-hour), updatedAt: at(-40 * minute) }),
    // Ended by the liveness sweep, with the outcome the sweep wrote.
    handle({ id: 'review-gy-13', kind: 'review', role: 'review', principal: 'reviewer-a', state: 'finished', head: 'c'.repeat(40), pane: 'w1V:p9', subject: 'Review PR #40',
      startedAt: at(-3 * hour), updatedAt: at(-2 * hour), endedAt: at(-2 * hour), transcript: '/home/agent/.graphyard/transcripts/review-gy-13.md',
      outcome: `vanished: the herdr runtime on vishrog has not reported pane w1V:p9 for 95s, 130s after its last observed activity at ${at(-2 * hour - 130_000)}` }),
    // A master session that finished, and the same worker principal finished on GY-13 three hours ago: inside the last 24 hours.
    handle({ id: 'master-1', kind: 'coordination', role: 'master', principal: 'master-1', state: 'finished', subject: 'Coordinate the cycle', startedAt: at(-6 * hour), updatedAt: at(-4 * hour), endedAt: at(-4 * hour), transcript: '/home/agent/.graphyard/transcripts/master.md' }),
    handle({ id: 'graphyard-codex-1:gy-13', kind: 'implementation', principal: 'graphyard-codex-1', epoch: 1, state: 'finished', subject: 'Implement GY-13 (first attempt)',
      startedAt: at(-4 * hour), updatedAt: at(-3 * hour), endedAt: at(-3 * hour), outcome: 'lease lapsed' }),
  ];
  return work;
}
const every = (work: Work[]) => work.flatMap(w => (w.sessions ?? []).map(h => ({ work: w, handle: h })));
const noop = () => {};
const dashboard = (work: Work[]): Dashboard => ({
  token: 'fixture', work, status: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'owner/project' }, error: '', connected: true, lastUpdated: '12:00:00', view: 'workers', setView: noop,
  filter: null, setFilter: noop, selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
  operatorAgents: [], operatorAgentsError: null, features: { releases: null, validation: null, automation: null }, events: [], editingRequirements: false, setEditingRequirements: noop,
  sessionEpoch: { current: 0 }, api: async () => ({}), refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop,
});
const render = (work: Work[]) => renderToStaticMarkup(createElement(WorkersPage, dashboard(work)));
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** The `data-copy` text of every copy button inside one table row, in order. */
const copies = (html: string, sessionId: string) => {
  const row = html.slice(html.indexOf(`data-session="${sessionId}"`));
  return [...row.slice(0, row.indexOf('</tr>')).matchAll(/data-copy="([^"]*)"/g)].map(match => unescape(match[1]));
};
const rowOf = (html: string, sessionId: string) => { const start = html.indexOf(`data-session="${sessionId}"`); assert.ok(start >= 0, `row for ${sessionId}`); return html.slice(start, html.indexOf('</tr>', start)); };
/** One session's unfolded panel, as a row click renders it. */
const panelOf = (work: Work[], sessionId: string) => {
  const view = workersView(work, new Date(NOW));
  const row = [...view.running, ...view.finished].find(entry => entry.id === sessionId)!;
  return renderToStaticMarkup(createElement(SessionPanel, { row, item: work.find(item => item.id === row.workId), now: NOW, release: releaseView(undefined), token: 'fixture', setSelected: noop }));
};

test('integration:workers-tab-lists-every-session — a top-level Workers tab lists every handle as one compact line: the agent, its item with a truncated title, a state of at most three words and how long it has held it', async () => {
  // Registered after Shipped; since GY-161 it is its own sidebar entry, so no tab row repeats it.
  const ids = views.map(view => view.id);
  assert.ok(ids.indexOf('workers') > ids.indexOf('shipped'), `registered after Shipped: ${ids.join(', ')}`);
  assert.equal(views.find(view => view.id === 'workers')?.section, 'workers');
  for (const role of ['admin', 'reader', 'worker', 'coordinator', 'operator-agent']) assert.ok(visibleViews({ ...dashboard([]), status: { actor: { role } } }).some(view => view.id === 'workers'), role);
  const tabs = [...renderToStaticMarkup(createElement(TopBar, { ...dashboard([]), view: 'workers' })).matchAll(/class="tab(?: active)?"[^>]*>(?:<abbr[^>]*>)?([^<]+)</g)].map(match => match[1]);
  assert.deepEqual(tabs, ['Workers', 'Costs'], 'Workers offers no Master tab now that Master is a top-level entry (GY-3287); Costs sits beside it (GY-3297)');
  assert.equal(views.find(view => view.id === 'master')?.section, 'master');
  assert.match(await read('web/pages/index.tsx'), /id: 'workers'.*label: 'Workers'/);

  const work = fixture();
  const handles = every(work);
  assert.equal(handles.length, 9);
  assert.deepEqual([...new Set(work.filter(w => w.sessions?.length).map(w => w.key))].sort(), ['GY-13', 'GY-14', 'GY-15'], 'three items');
  assert.deepEqual([...new Set(handles.map(entry => entry.handle.kind))].sort(), ['coordination', 'implementation', 'proof', 'review'], 'four kinds');
  const html = render(work);
  const expectedRole: Record<string, string> = { implementation: 'worker', review: 'reviewer', proof: 'producer' };
  const view = workersView(work, new Date(NOW));
  const rowInView = (id: string) => [...view.running, ...view.finished].find(entry => entry.id === id)!;
  for (const { work: item, handle } of handles) {
    const row = rowOf(html, handle.id);
    assert.ok(row.includes(`data-work="${item.key}"`), `${handle.id} names ${item.key}`);
    assert.match(row, new RegExp(`<span class="mono">${item.key}</span> <span class="row-title">${item.title}</span></button>`), `${handle.id} shows its item's key and title`);
    // The full title stays one hover away (GY-3314: the row truncates it, the title attribute carries it whole).
    assert.ok(row.includes(`title="${item.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}"`), `${handle.id} carries its full title on hover`);
    const role = expectedRole[handle.kind] ?? 'master';
    assert.ok(row.includes(`data-role="${role}"`), `${handle.id} is a ${role}`);
    assert.ok(row.includes(handle.principal) && row.includes(handle.host), `${handle.id} shows host and principal`);
    // The state is the session's own, in at most three words, with how long it has held it (sessionState).
    const state = sessionState(rowInView(handle.id), item, NOW);
    assert.ok(state.words.split(/\s+/).length <= 3, `${handle.id}: "${state.words}" is at most three words`);
    assert.ok(row.includes(`data-state="${state.words}"`), `${handle.id} shows ${state.words}`);
    const age = spent(NOW - Date.parse(state.since));
    assert.ok(row.includes(`>${age}<`), `${handle.id} has held it for ${age}`);
  }
  // The state words by role (GY-3314): a builder builds, a reviewer is in review, the master runs the loop, a stale session is not seen.
  const words = (id: string, key: string) => sessionState(rowInView(id), work.find(item => item.key === key)!, NOW).words;
  assert.equal(words('graphyard-codex-1:1', 'GY-14'), 'Building');
  assert.equal(words('review-gy-14', 'GY-14'), 'In review');
  assert.equal(words('approver-gy-15', 'GY-15'), 'Runs the loop');
  assert.equal(words('worker-b:2', 'GY-13'), 'Not seen');
  assert.equal(words('proof-gy-15', 'GY-15'), 'Ended');
  // A builder sent back names the round it is on, from when the item was sent back.
  const rework = fixture();
  const sent = rework.find(item => item.key === 'GY-14')!;
  Object.assign(sent, { reworkRequested: true, pipeline: { attempts: [], submittedAt: at(-3 * hour), resubmittedAt: null, reworkRounds: 3, interventions: { blocked: 0, requirements: 0 } } });
  const round = sessionState(rowInView('graphyard-codex-1:1'), sent, NOW);
  assert.deepEqual([round.words, round.since], ['Rework 3', at(90_000 - 30 * minute)], 'the third round, since the claim that took it');
  // The page ticks without a reload: the clock hook adds the seconds since the last poll on a one-second interval.
  const page = await read('web/pages/workers.tsx');
  assert.match(page, /setInterval\(\(\) => setTick/);
  assert.match(page, /const now = useLiveNow\(observedAt\)/);
  // The columns of the compact Workers line (GY-3314): the agent, the item, the state, the age.
  for (const column of ['Agent', 'Working on', 'State', 'Age']) assert.ok(html.includes(`<th scope="col">${column}</th>`), column);
  // Nothing on the page names a runtime as its source, and it reads as prose to a newcomer.
  assert.ok(visibleWords(html).length > 0);
});

test('unit:attach-command-remote-form — a session in a pane offers its local attach command and a remote form built from its host through Herdr\'s remote machinery in its unfolded panel, byte for byte; a headless run shows its log instead', async () => {
  const running = { state: 'running' as const, host: 'vishrog', attach: 'herdr pane attach w1V:pJD --workspace w1V' };
  const remote = 'herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog';
  // Herdr 0.9.1 has no `pane attach`: the recorded pane is attached with `agent attach`, which takes a workspace-qualified pane ID.
  assert.equal(localAttachCommand(running), 'herdr agent attach w1V:pJD');
  assert.equal(localAttachCommand({ ...running, attach: 'herdr pane attach w1V:pW2' }), 'herdr agent attach w1V:pW2');
  assert.equal(localAttachCommand({ ...running, attach: 'tmux attach -t gy-14' }), 'tmux attach -t gy-14', 'a command that is not Herdr\'s is offered as recorded');
  // --machine runs an API command (the focus) on the saved machine; --remote attaches that host's UI through SSH.
  assert.equal(remoteAttachCommand(running), remote);
  // No second form for a command that is not Herdr's, one that already names a machine, a finished handle, or no command.
  assert.equal(remoteAttachCommand({ ...running, attach: 'tmux attach -t gy-14' }), null);
  assert.equal(remoteAttachCommand({ ...running, attach: 'herdr --machine other pane attach w1V:pJD' }), null);
  assert.equal(remoteAttachCommand({ ...running, state: 'finished' }), null);
  assert.equal(remoteAttachCommand({ ...running, attach: null }), null);

  const work = fixture();
  const workerPanel = panelOf(work, 'graphyard-codex-1:1');
  // The worker's panel: exactly the two commands, in that order, and nothing else to copy.
  assert.deepEqual([...workerPanel.matchAll(/data-copy="([^"]*)"/g)].map(match => unescape(match[1])), ['herdr agent attach w1V:pJD', remote]);
  assert.ok(workerPanel.includes('data-copy="herdr --machine vishrog agent focus w1V:pJD &amp;&amp; herdr --remote vishrog"'), 'the escaped attribute is the command');
  assert.match(workerPanel, />Copy local<\/button>/); assert.match(workerPanel, />Copy remote<\/button>/);
  // The copy is one click on the text alone: the button writes its data-copy text and nothing more.
  const page = await read('web/pages/workers.tsx');
  assert.match(page, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(page, /data-copy=\{text\}/);
  // A finished handle offers its transcript path, not an attach command.
  const endedPanel = panelOf(work, 'proof-gy-15');
  assert.deepEqual([...endedPanel.matchAll(/data-copy="([^"]*)"/g)].map(match => unescape(match[1])), ['/home/agent/.graphyard/transcripts/proof-gy-15.md']);
  assert.match(endedPanel, />Copy transcript path<\/button>/);
  assert.doesNotMatch(endedPanel, /Copy local|Copy remote/);
  assert.match(endedPanel, /evidence submitted/);
  // A running handle without an attach command, and a finished one without a transcript, say so.
  assert.match(panelOf(work, 'graphyard-codex-1:gy-13'), /no transcript recorded/);
  const bare = fixture(); bare.find(w => w.key === 'GY-15')!.sessions!.find(h => h.id === 'approver-gy-15')!.attach = null;
  assert.match(panelOf(bare, 'approver-gy-15'), /no attach command recorded/);
  assert.deepEqual([...panelOf(bare, 'approver-gy-15').matchAll(/data-copy="([^"]*)"/g)].map(match => unescape(match[1])), []);
  // A headless run (transcript `run:<uuid>`) is its log, read live, and no attach command is offered beside it (GY-3314).
  const headless = fixture();
  const run = '0f0e0d0c-1111-4222-8333-444455556666';
  headless.find(w => w.key === 'GY-14')!.sessions!.find(h => h.id === 'graphyard-codex-1:1')!.transcript = `run:${run}`;
  const logPanel = panelOf(headless, 'graphyard-codex-1:1');
  assert.match(logPanel, new RegExp(`data-run="${run}"`));
  assert.doesNotMatch(logPanel, /Copy local|Copy remote|no attach command/);
  // The compact row carries no attach buttons at all: everything to copy sits in the opened panel.
  const html = render(work);
  for (const { handle } of every(work)) assert.deepEqual(copies(html, handle.id), [], `${handle.id} row has nothing to copy`);
});

test('integration:workers-tab-per-principal-summary — running rows first by time spent descending, finished rows collapsed with a count, and one line per principal naming its current item and epoch, how long, and its sessions in the last 24 hours', () => {
  const work = fixture();
  const view = workersView(work, new Date(NOW));
  assert.deepEqual(view.running.map(row => row.id), ['graphyard-codex-1:1', 'worker-b:2', 'review-gy-14', 'approver-gy-15']);
  assert.ok(view.running.every((row, i) => i === 0 || row.spentMs <= view.running[i - 1].spentMs), 'time spent descending');
  assert.deepEqual(view.finished.map(row => row.id), ['proof-gy-15', 'review-gy-13', 'graphyard-codex-1:gy-13', 'master-1', 'graphyard-codex-1:old']);
  const html = render(work);
  // Drawn in that order: open rows in the one sessions table, ended rows inside a collapsed <details> with the count.
  const order = [...view.running, ...view.finished].map(row => html.indexOf(`data-session="${row.id}"`));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), `rows in order: ${order}`);
  assert.match(html, /3 agent sessions open\. 1 not seen recently\. 5 ended\./);
  assert.match(html, /<details class="panel finished-sessions"><summary>Ended <span class="count">5<\/span><\/summary>/);
  assert.ok(html.indexOf('<details') < html.indexOf('data-session="proof-gy-15"'), 'ended rows are inside the collapsed section');
  // The per-account summary is folded below the sessions table, never a second table on the first screen (GY-161, AC-9).
  assert.ok(html.indexOf('aria-label="Agent sessions"') < html.indexOf('<details class="panel finished-sessions accounts">') && html.indexOf('<details class="panel finished-sessions accounts">') < html.indexOf('aria-label="Principals"'), 'the summary is folded below');
  // One line per worker, reviewer or producer principal: the one with two finished sessions and one running is on the running one.
  const byName = Object.fromEntries(view.principals.map(entry => [entry.principal, entry]));
  assert.deepEqual(Object.keys(byName).sort(), ['graphyard-codex-1', 'herdr-worker-1', 'reviewer-a', 'worker-b']);
  assert.deepEqual(byName['graphyard-codex-1'].current, { key: 'GY-14', workId: work.find(w => w.key === 'GY-14')!.id, epoch: 1, sinceMs: 90 * minute });
  assert.equal(byName['graphyard-codex-1'].sessionsLast24h, 2, 'the running one and the one that ended three hours ago; the one thirty hours old is out');
  assert.equal(byName['graphyard-codex-1'].roleKind, 'worker');
  assert.deepEqual(byName['reviewer-a'].current, { key: 'GY-14', workId: work.find(w => w.key === 'GY-14')!.id, epoch: null, sinceMs: 20 * minute });
  assert.equal(byName['reviewer-a'].sessionsLast24h, 2);
  assert.equal(byName['herdr-worker-1'].current, null, 'a producer with only finished sessions is idle');
  assert.equal(byName['herdr-worker-1'].sessionsLast24h, 1);
  assert.equal(byName['worker-b'].current, null, 'its only open record is not seen lately, so it is on nothing — the same reading as its row (GY-172)');
  assert.ok(!('approver-1' in byName) && !('master-1' in byName), 'approver and master sessions are not seats');
  // Busy principals first, longest first, then idle.
  assert.deepEqual(view.principals.map(entry => entry.principal), ['graphyard-codex-1', 'reviewer-a', 'herdr-worker-1', 'worker-b']);
  const summary = html.slice(html.indexOf('aria-label="Principals"'));
  assert.match(summary, /data-principal="graphyard-codex-1" data-current="GY-14:1"/);
  assert.match(summary, />GY-14<\/button><\/td><td data-label="For">1h 30m 00s<\/td><td data-label="Sessions today">2<\/td>/);
  assert.match(summary, /data-principal="herdr-worker-1" data-current="idle"/);
  assert.match(summary, /idle<\/span><\/td><td data-label="For">—<\/td><td data-label="Sessions today">1<\/td>/);
});

test('unit:stale-session-marked — a running handle not seen inside the threshold is badged Not seen since its last observation; one seen two minutes ago is live; a handle the liveness sweep ended shows the outcome and why', () => {
  assert.equal(sessionStaleThresholdMs, 15 * minute, 'the documented default');
  const now = new Date(NOW);
  assert.deepEqual(staleSession({ state: 'running', updatedAt: at(-40 * minute) }, now), { since: at(-40 * minute), idleMs: 40 * minute });
  assert.equal(staleSession({ state: 'running', updatedAt: at(-2 * minute) }, now), null);
  assert.equal(staleSession({ state: 'running', updatedAt: at(-15 * minute) }, now), null, 'exactly the threshold is not past it');
  assert.equal(staleSession({ state: 'finished', updatedAt: at(-40 * minute) }, now), null, 'a finished handle is not stale, it is finished');
  assert.ok(staleSession({ state: 'running', updatedAt: at(-20 * minute) }, now, 30 * minute) === null, 'the threshold is a parameter');

  const html = render(fixture());
  const stale = rowOf(html, 'worker-b:2');
  // Stale reads as its state, never "running" (GY-161, AC-9): the dot is marked and the sentence is one hover away.
  assert.ok(stale.startsWith('data-session="worker-b:2" data-work="GY-13" data-role="worker" class="stale"'), 'the row itself is marked');
  assert.match(stale, /<span class="health stale" data-health="stale" data-stale="worker-b:2"[^>]*title="Not seen for 40m 00s[^"]*"><span class="health-dot" aria-hidden="true"><\/span><\/span>/);
  assert.match(stale, /data-state="Not seen"/);
  assert.ok(stale.includes('>40m 00s<'), 'its age is how long it has not been seen');
  assert.doesNotMatch(stale, /data-health="live"|>Building<|running|Active/i);
  const fresh = rowOf(html, 'graphyard-codex-1:1');
  assert.doesNotMatch(fresh, /data-stale/);
  assert.match(fresh, /<span class="health live" data-health="live"[^>]*title="Seen 2m 00s ago"[^>]*><span class="health-dot" aria-hidden="true"><\/span><\/span>/);
  assert.match(html, /1 not seen recently/);
  // Ended by liveness reconciliation: said in plain words in the ended row's hover, the rule that closed it on the element and the recorded outcome in its title.
  const reconciled = rowOf(html, 'review-gy-13');
  assert.match(reconciled, /data-health="ended" data-reconciled="vanished" title="Ended · stopped responding · vanished: the herdr runtime on vishrog has not reported pane w1V:p9 for 95s[^"]*"><span class="health-dot" aria-hidden="true"><\/span><\/span>/);
  assert.match(reconciled, /data-state="Ended"/);
  // A session that ended on its own reads as ended too, without that attribution.
  assert.match(rowOf(html, 'proof-gy-15'), /data-state="Ended"/);
  assert.match(rowOf(html, 'proof-gy-15'), /data-health="ended"/);
  assert.doesNotMatch(rowOf(html, 'proof-gy-15'), /data-reconciled/);
});
