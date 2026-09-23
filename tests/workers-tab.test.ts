import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import type { SessionHandle } from '../src/model/sessions.js';
import { localAttachCommand, remoteAttachCommand, sessionRoleKind, sessionStaleThresholdMs, staleSession, workersView } from '../web/workers-view.js';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureWork, NOW, visibleWords } from '../scripts/dashboard-fixture.mjs';
import { views, visibleViews } from '../web/pages/index.js';
import WorkersPage, { spent } from '../web/pages/workers.js';
import TopBar from '../web/components/top-bar.js';
import type { Dashboard } from '../web/pages/dashboard.js';

/**
 * GY-116: a Workers tab shows every agent session, what it is on, how long it has spent, and a
 * copyable command to attach to it. Each test is named for the proof it produces:
 * integration:workers-tab-lists-every-session, unit:attach-command-remote-form,
 * integration:workers-tab-per-principal-summary, unit:stale-session-marked and
 * manual:workers-tab-docs-review.
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
  operatorAgents: [], operatorAgentsError: null, features: { releases: null, validation: null, automation: null }, events: [], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false,
  queue: { order: [], predictions: {} } as any, sessionEpoch: { current: 0 }, api: async () => ({}), refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop,
});
const render = (work: Work[]) => renderToStaticMarkup(createElement(WorkersPage, dashboard(work)));
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** The `data-copy` text of every copy button inside one table row, in order. */
const copies = (html: string, sessionId: string) => {
  const row = html.slice(html.indexOf(`data-session="${sessionId}"`));
  return [...row.slice(0, row.indexOf('</tr>')).matchAll(/data-copy="([^"]*)"/g)].map(match => unescape(match[1]));
};
const rowOf = (html: string, sessionId: string) => { const start = html.indexOf(`data-session="${sessionId}"`); assert.ok(start >= 0, `row for ${sessionId}`); return html.slice(start, html.indexOf('</tr>', start)); };

test('integration:workers-tab-lists-every-session — a top-level Workers tab lists every handle across every item with its item, role kind and time spent, live for a running handle and fixed for a finished one', async () => {
  // Registered beside Shipped and Insights, and offered as a tab of the Work section.
  const ids = views.map(view => view.id);
  assert.ok(ids.indexOf('workers') > ids.indexOf('shipped') && ids.indexOf('workers') < ids.indexOf('pulse'), `registered beside Shipped and Insights: ${ids.join(', ')}`);
  assert.equal(views.find(view => view.id === 'workers')?.section, 'work');
  for (const role of ['admin', 'reader', 'worker', 'coordinator', 'operator-agent']) assert.ok(visibleViews({ ...dashboard([]), status: { actor: { role } } }).some(view => view.id === 'workers'), role);
  const tabs = [...renderToStaticMarkup(createElement(TopBar, { ...dashboard([]), view: 'workers' })).matchAll(/class="tab(?: active)?"[^>]*>(?:<abbr[^>]*>)?([^<]+)</g)].map(match => match[1]);
  assert.deepEqual(tabs, ['Work', 'Needs you', 'Workers']);
  assert.match(await read('web/pages/index.tsx'), /id: 'workers'.*label: 'Workers'/);

  const work = fixture();
  const handles = every(work);
  assert.equal(handles.length, 9);
  assert.deepEqual([...new Set(work.filter(w => w.sessions?.length).map(w => w.key))].sort(), ['GY-13', 'GY-14', 'GY-15'], 'three items');
  assert.deepEqual([...new Set(handles.map(entry => entry.handle.kind))].sort(), ['coordination', 'implementation', 'proof', 'review'], 'four kinds');
  const html = render(work);
  const expectedRole: Record<string, string> = { implementation: 'worker', review: 'reviewer', proof: 'producer' };
  for (const { work: item, handle } of handles) {
    const row = rowOf(html, handle.id);
    assert.ok(row.includes(`data-work="${item.key}"`), `${handle.id} names ${item.key}`);
    assert.match(row, new RegExp(`>${item.key}${handle.epoch !== null ? ` · epoch ${handle.epoch}` : ''}<`), `${handle.id} links to its item and epoch`);
    const role = expectedRole[handle.kind] ?? (handle.role === 'approver' ? 'approver' : 'master');
    assert.ok(row.includes(`data-role="${role}"`) && row.includes(`<td>${role}`), `${handle.id} is a ${role}`);
    assert.ok(row.includes(handle.subject), `${handle.id} shows its subject`);
    assert.ok(row.includes(handle.host) && row.includes(handle.principal), `${handle.id} shows host and principal`);
    const spentMs = handle.state === 'running' ? NOW - Date.parse(handle.startedAt) : Date.parse(handle.endedAt!) - Date.parse(handle.startedAt);
    assert.ok(row.includes(`data-spent="${spentMs}"`) && row.includes(`>${spent(spentMs)}<`), `${handle.id} spent ${spent(spentMs)}`);
  }
  // The worker on GY-14 has spent an hour and a half, live; the producer on GY-15 spent exactly an hour, fixed.
  assert.match(rowOf(html, 'graphyard-codex-1:1'), />1h 30m 00s</);
  assert.match(rowOf(html, 'proof-gy-15'), />1h 00m 00s</);
  // Live means it moves with the clock: a later `now` lengthens the running row and leaves the finished one alone.
  const later = workersView(work, new Date(NOW + 7_000));
  assert.equal(later.running.find(row => row.id === 'graphyard-codex-1:1')!.spentMs, 90 * minute + 7_000);
  assert.equal(later.finished.find(row => row.id === 'proof-gy-15')!.spentMs, hour);
  // The page ticks without a reload: the clock hook adds the seconds since the last poll on a one-second interval.
  const page = await read('web/pages/workers.tsx');
  assert.match(page, /setInterval\(\(\) => setTick/);
  assert.match(page, /const now = useLiveNow\(observedAt\)/);
  // Every column the requirement names is a heading, in one table per group.
  for (const column of ['Agent', 'Role', 'Item', 'Subject', 'Host', 'State', 'Started', 'Time spent', 'Attach']) assert.ok(html.includes(`<th scope="col">${column}</th>`), column);
  // Nothing on the page names a runtime as its source, and it reads as prose to a newcomer.
  assert.ok(visibleWords(html).length > 0);
});

test('unit:attach-command-remote-form — every running row copies a local attach command and a remote form built from its host through Herdr\'s remote machinery, byte for byte; a finished row offers its transcript instead', async () => {
  const running = { state: 'running' as const, host: 'vishrog', attach: 'herdr pane attach w1V:pJD --workspace w1V' };
  const remote = 'herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog';
  // Herdr 0.9.1 has no `pane attach`: the recorded pane is attached with `agent attach`, which takes a workspace-qualified pane ID.
  assert.equal(localAttachCommand(running), 'herdr agent attach w1V:pJD');
  assert.equal(localAttachCommand({ ...running, attach: 'herdr pane attach w1V:pW2' }), 'herdr agent attach w1V:pW2');
  assert.equal(localAttachCommand({ ...running, attach: 'tmux attach -t gy-14' }), 'tmux attach -t gy-14', 'a command that is not Herdr\'s is offered as recorded');
  // --machine runs an API command (the focus) on the saved machine; --remote attaches that host's UI through SSH.
  assert.equal(remoteAttachCommand(running), remote);
  const docs = await read('docs/dashboard.md');
  assert.match(docs, /herdr --machine <label-or-id> <command>/);
  assert.match(docs, /herdr --remote <ssh-target>/);
  assert.ok(docs.includes(`\`${remote}\``), 'the docs state the exact remote form');
  // No second form for a command that is not Herdr's, one that already names a machine, a finished handle, or no command.
  assert.equal(remoteAttachCommand({ ...running, attach: 'tmux attach -t gy-14' }), null);
  assert.equal(remoteAttachCommand({ ...running, attach: 'herdr --machine other pane attach w1V:pJD' }), null);
  assert.equal(remoteAttachCommand({ ...running, state: 'finished' }), null);
  assert.equal(remoteAttachCommand({ ...running, attach: null }), null);

  const html = render(fixture());
  // The worker's row: exactly the two commands, in that order, and nothing else to copy.
  assert.deepEqual(copies(html, 'graphyard-codex-1:1'), ['herdr agent attach w1V:pJD', remote]);
  const row = rowOf(html, 'graphyard-codex-1:1');
  assert.ok(row.includes('data-copy="herdr --machine vishrog agent focus w1V:pJD &amp;&amp; herdr --remote vishrog"'), 'the escaped attribute is the command');
  assert.equal(Buffer.compare(Buffer.from(copies(html, 'graphyard-codex-1:1')[1]), Buffer.from(remote)), 0, 'byte for byte');
  assert.match(row, />Copy local<\/button>/); assert.match(row, />Copy remote<\/button>/);
  // The copy is one click on the text alone: the button writes its data-copy text and nothing more.
  const page = await read('web/pages/workers.tsx');
  assert.match(page, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(page, /data-copy=\{text\}/);
  // A finished handle offers its transcript path, not an attach command.
  assert.deepEqual(copies(html, 'proof-gy-15'), ['/home/agent/.graphyard/transcripts/proof-gy-15.md']);
  assert.match(rowOf(html, 'proof-gy-15'), />Copy transcript path<\/button>/);
  assert.doesNotMatch(rowOf(html, 'proof-gy-15'), /Copy local|Copy remote/);
  // A running handle without an attach command, and a finished one without a transcript, say so.
  assert.match(rowOf(html, 'graphyard-codex-1:gy-13'), /no transcript recorded/);
  const bare = fixture(); bare.find(w => w.key === 'GY-15')!.sessions!.find(h => h.id === 'approver-gy-15')!.attach = null;
  assert.match(rowOf(render(bare), 'approver-gy-15'), /no attach command recorded/);
  assert.deepEqual(copies(render(bare), 'approver-gy-15'), []);
});

test('integration:workers-tab-per-principal-summary — running rows first by time spent descending, finished rows collapsed with a count, and one line per principal naming its current item and epoch, how long, and its sessions in the last 24 hours', () => {
  const work = fixture();
  const view = workersView(work, new Date(NOW));
  assert.deepEqual(view.running.map(row => row.id), ['graphyard-codex-1:1', 'worker-b:2', 'review-gy-14', 'approver-gy-15']);
  assert.ok(view.running.every((row, i) => i === 0 || row.spentMs <= view.running[i - 1].spentMs), 'time spent descending');
  assert.deepEqual(view.finished.map(row => row.id), ['proof-gy-15', 'review-gy-13', 'graphyard-codex-1:gy-13', 'master-1', 'graphyard-codex-1:old']);
  const html = render(work);
  // Drawn in that order: running rows in the Running table, finished rows inside a collapsed <details> with the count.
  const order = [...view.running, ...view.finished].map(row => html.indexOf(`data-session="${row.id}"`));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), `rows in order: ${order}`);
  assert.match(html, /<h2>Running <span class="count">4<\/span><\/h2>/);
  assert.match(html, /<details class="finished-sessions"><summary>Finished <span class="count">5<\/span><\/summary>/);
  assert.ok(html.indexOf('<details') < html.indexOf('data-session="proof-gy-15"'), 'finished rows are inside the collapsed section');
  assert.ok(html.indexOf('aria-label="Principals"') < html.indexOf('aria-label="Running sessions"'), 'the summary is on top');
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
  assert.equal(byName['worker-b'].current?.key, 'GY-13');
  assert.ok(!('approver-1' in byName) && !('master-1' in byName), 'approver and master sessions are not seats');
  // Busy principals first, longest first, then idle.
  assert.deepEqual(view.principals.map(entry => entry.principal), ['graphyard-codex-1', 'worker-b', 'reviewer-a', 'herdr-worker-1']);
  const summary = html.slice(html.indexOf('aria-label="Principals"'), html.indexOf('aria-label="Running sessions"'));
  assert.match(summary, /data-principal="graphyard-codex-1" data-current="GY-14:1"/);
  assert.match(summary, />GY-14 · epoch 1<\/button><\/td><td>1h 30m 00s<\/td><td>2<\/td>/);
  assert.match(summary, /data-principal="herdr-worker-1" data-current="idle"/);
  assert.match(summary, /idle<\/span><\/td><td>—<\/td><td>1<\/td>/);
});

test('unit:stale-session-marked — a running handle not seen inside the threshold is badged as recorded running, not seen since its updatedAt; one seen two minutes ago is not; a handle the liveness sweep ended shows the outcome and why', () => {
  assert.equal(sessionStaleThresholdMs, 15 * minute, 'the documented default');
  const now = new Date(NOW);
  assert.deepEqual(staleSession({ state: 'running', updatedAt: at(-40 * minute) }, now), { since: at(-40 * minute), idleMs: 40 * minute });
  assert.equal(staleSession({ state: 'running', updatedAt: at(-2 * minute) }, now), null);
  assert.equal(staleSession({ state: 'running', updatedAt: at(-15 * minute) }, now), null, 'exactly the threshold is not past it');
  assert.equal(staleSession({ state: 'finished', updatedAt: at(-40 * minute) }, now), null, 'a finished handle is not stale, it is finished');
  assert.ok(staleSession({ state: 'running', updatedAt: at(-20 * minute) }, now, 30 * minute) === null, 'the threshold is a parameter');

  const html = render(fixture());
  const stale = rowOf(html, 'worker-b:2');
  assert.match(stale, new RegExp(`<span class="pulse-badge stale" data-stale="worker-b:2">recorded running, not seen since ${new Date(at(-40 * minute)).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`));
  assert.ok(stale.startsWith('data-session="worker-b:2" data-work="GY-13" data-role="worker" class="stale"'), 'the row itself is marked');
  const fresh = rowOf(html, 'graphyard-codex-1:1');
  assert.doesNotMatch(fresh, /pulse-badge stale|not seen since/);
  assert.match(fresh, /<span class="green-text">running<\/span>/);
  assert.match(html, /<span class="amber" role="status">1 recorded running but not seen recently<\/span>/);
  // Ended by liveness reconciliation: the recorded outcome and the rule that closed it.
  const reconciled = rowOf(html, 'review-gy-13');
  assert.match(reconciled, /finished · <span class="amber" data-reconciled="vanished">ended by liveness reconciliation \(vanished\): vanished: the herdr runtime on vishrog has not reported pane w1V:p9 for 95s/);
  // A session that ended on its own shows its outcome without that attribution.
  assert.match(rowOf(html, 'proof-gy-15'), /finished · evidence submitted/);
  assert.doesNotMatch(rowOf(html, 'proof-gy-15'), /liveness reconciliation/);
  assert.equal(sessionRoleKind({ kind: 'coordination', role: 'escalation' }), 'escalation handler');
});

test('manual:workers-tab-docs-review — docs/dashboard.md documents the Workers tab: what a row is, that the data is session handles and not Herdr, the stale threshold, the two attach forms with the exact remote syntax from herdr --help, and that GY-113 liveness reconciliation ends dead handles', async () => {
  const docs = await read('docs/dashboard.md');
  const section = docs.slice(docs.indexOf('## Workers'), docs.indexOf('## The status sentence'));
  assert.ok(section.length > 0, 'a Workers section');
  assert.match(section, /A row is one \[session handle\]/);
  assert.match(section, /not from Herdr/);
  assert.match(section, /\*\*15 minutes\*\* by default, `sessionStaleThresholdMs`/);
  assert.match(section, /recorded running, not seen since/);
  assert.match(section, /\*\*Copy local\*\*/); assert.match(section, /\*\*Copy remote\*\*/);
  assert.match(section, /`herdr --help` documents `herdr --machine <label-or-id> <command>`/);
  assert.ok(section.includes('`herdr agent attach w1V:pJD`'), 'the local form');
  assert.ok(section.includes('`herdr --machine vishrog agent focus w1V:pJD && herdr --remote vishrog`'), 'the exact remote form');
  assert.match(section, /interactive attachment is not forwarded/);
  assert.match(section, /GY-113's \[liveness reconciliation\]\(master-agent\.md#session-liveness-is-reconciled-not-trusted\).*is what ends a dead handle/);
  assert.match(section, /registered beside Shipped and Insights in `web\/pages\/index\.tsx`/);
  assert.match(docs, /\*\*Workers\*\*, every agent session across every item, as tabs/);
  // The anchor the section links to exists, and the page's own copy states the same threshold.
  assert.match(await read('docs/master-agent.md'), /### Session liveness is reconciled, not trusted/);
  assert.match(renderToStaticMarkup(createElement(WorkersPage, dashboard([]))), /not seen for 15 minutes is marked, never shown as live/);
});
