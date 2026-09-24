import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import type { SessionHandle } from '../src/model/sessions.js';
import { predictQueue } from '../src/merge-queue.js';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureApi, fixtureStatus, fixtureWork, NOW, visibleWords } from '../scripts/dashboard-fixture.mjs';
import { live } from '../browser-tests/ui-board.js';
import { buildMasterStatus, type HerdrAgent, type WorkerProfile } from '../src/master.js';
import { sessionReport } from '../src/cli/master-status.js';
import { workersView } from '../web/workers-view.js';
import { classify, groupMeaning, nextActor, upNextMeaning } from '../web/groups.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import WorkersPage from '../web/pages/workers.js';
import OverviewPage from '../web/pages/overview.js';
import WorkDetails from '../web/pages/work-details.js';

/**
 * GY-172 AC-3: the Workers page and its counts, `master status` and the Work page read only the one
 * session state. A session is shown running only while its latest observation is working or idle
 * and fresh; 'seen' is that observation's time — never the last time anything wrote the record —
 * and the Up next group says what an item is really waiting on. Every render here is over the
 * checked-in dashboard fixture, with session records shaped exactly as the session report writes them.
 */

const minute = 60_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const noop = () => {};
const base = (): Work[] => (fixtureWork() as unknown as Work[]).map(live).map(item => ({ ...item, sessions: [] }));

function handle(fields: Partial<SessionHandle> & Pick<SessionHandle, 'id' | 'kind' | 'principal'>): SessionHandle {
  return { epoch: null, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: `w1V:${fields.id}`, agentName: `agent-${fields.id}`, role: null, head: null,
    attach: `herdr pane attach w1V:${fields.id} --workspace w1V`, transcript: null, subject: `${fields.id} on the item`, startedAt: at(-60 * minute), updatedAt: at(-minute),
    endedAt: null, state: 'running', outcome: null, ...fields };
}
/** Five sessions as the loop's report left them: working, idle, stale (written recently, observed long ago), ended at a shell, and lost. */
function board(): Work[] {
  const work = base();
  const item = (key: string) => work.find(w => w.key === key)!;
  item('GY-14').sessions = [
    // Observed working a minute ago; its record was last written forty minutes ago. Seen is the observation.
    handle({ id: 'working', kind: 'implementation', principal: 'worker-3', epoch: 1, observed: 'working', observedAt: at(-minute), updatedAt: at(-40 * minute) }),
    handle({ id: 'idle', kind: 'review', role: 'review', principal: 'reviewer-a', observed: 'idle', observedAt: at(-2 * minute) }),
  ];
  item('GY-12').sessions = [
    // Written a minute ago (its coordinates), but last observed twenty minutes ago: not running.
    handle({ id: 'stale', kind: 'implementation', principal: 'worker-7', epoch: 1, observed: 'working', observedAt: at(-20 * minute), updatedAt: at(-minute) }),
    handle({ id: 'shell', kind: 'implementation', principal: 'worker-9', epoch: 1, state: 'finished', observed: 'ended', observedAt: at(-5 * minute), endedAt: at(-5 * minute),
      outcome: 'the claude runtime on vishrog reports pane w1V:shell as exited to a shell (no agent in the pane), so the session is over' }),
    handle({ id: 'lost', kind: 'proof', role: 'proof:unit', principal: 'producer-1', state: 'finished', observed: 'lost', observedAt: at(-9 * minute), endedAt: at(-8 * minute),
      outcome: `vanished: the claude runtime on vishrog has not reported pane w1V:lost for 60s (absent from 2 consecutive session reports, so the session is lost), 61s after its last observed activity at ${at(-9 * minute)}` }),
  ];
  return work;
}
function dashboard(work: Work[], overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    token: 'fixture', work, status: fixtureStatus('admin'), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop,
    filter: null, setFilter: noop, selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop,
    observedAt: NOW, jobs: [], query: '', setQuery: noop, operatorAgents: [], operatorAgentsError: null, features: {} as any,
    events: fixtureApi('events') as any[], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false,
    queue: predictQueue(work, NOW), sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, 'admin'),
    refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop, ...overrides,
  };
}
const rowOf = (html: string, id: string) => { const start = html.indexOf(`data-session="${id}"`); assert.ok(start >= 0, id); return html.slice(start, html.indexOf('</tr>', start)); };

test('unit:ui-reads-session-state — the Workers page and its counts show a session running only while its latest observation is working or idle and fresh, seen at that observation', () => {
  const work = board();
  const view = workersView(work, new Date(NOW));
  assert.deepEqual(view.running.filter(row => row.live).map(row => row.id).sort(), ['idle', 'working']);
  assert.deepEqual(view.running.filter(row => !row.live).map(row => row.id), ['stale'], 'an open record not observed inside the bound is not running, however recently it was written');
  assert.deepEqual(view.finished.map(row => [row.id, row.observed]).sort(), [['lost', 'lost'], ['shell', 'ended']]);

  const html = renderToStaticMarkup(createElement(WorkersPage, dashboard(work)));
  assert.match(html, /2 agent sessions open\. 1 not seen recently\. 2 ended\./, 'the counts are the same reading');
  assert.match(rowOf(html, 'working'), /data-health="live"[^>]*><span class="health-dot" aria-hidden="true"><\/span>Seen 1m 00s ago<\/span>/, 'seen at the observation, not at the forty-minute-old write');
  assert.match(rowOf(html, 'idle'), /data-health="live"[^>]*>.*Seen 2m 00s ago · at its prompt<\/span>/, 'idle is running, and says it waits at its prompt');
  assert.match(rowOf(html, 'stale'), /data-health="stale"[^>]*>.*Not seen for 20m 00s<\/span>/, 'not seen since its last observation, whatever wrote the record since');
  assert.doesNotMatch(rowOf(html, 'stale'), /data-health="live"|>Seen \d|running/);
  assert.match(rowOf(html, 'shell'), /Ended · its agent exited/);
  assert.match(rowOf(html, 'lost'), /Ended · stopped responding/);
  const open = html.slice(0, html.indexOf('<details class="finished-sessions">'));
  assert.ok(!open.includes('data-session="shell"') && !open.includes('data-session="lost"'), 'ended and lost sessions are never in the open table');
});

test('unit:ui-reads-session-state — master status reads the session state: running rows, and the assigned worker\'s session by its record rather than by the runtime', () => {
  const work = board();
  const report = sessionReport({ work, now: new Date(NOW).toISOString() });
  assert.deepEqual(report.running.map(row => row.id).sort(), ['idle', 'working'], 'master status lists as running exactly what the Workers page does');
  assert.deepEqual(report.running.map(row => row.seenAt).sort(), [at(-2 * minute), at(-minute)]);
  assert.ok(!report.running.some(row => row.id === 'stale'));

  const worker = { name: 'worker-3', principal: 'worker-3', agentName: 'graphyard-worker-3', mode: 'launch', kind: 'claude', credentialFile: '/outside/w3.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const held = (sessions: SessionHandle[]): Work => ({ ...work.find(w => w.key === 'GY-14')!, lease: { owner: 'worker-3', epoch: 1, expiresAt: at(30 * minute) }, sessions });
  const attention = (item: Work, agents: HerdrAgent[]) => buildMasterStatus({ work: [item], now: new Date(NOW).toISOString() }, [worker], agents).work[0].attention;
  const record = (fields: Partial<SessionHandle>) => handle({ id: 'worker-3:1', kind: 'implementation', principal: 'worker-3', epoch: 1, ...fields });
  // The runtime lists nothing for the profile, but the session record is observed idle a minute ago: the worker is there.
  assert.doesNotMatch(attention(held([record({ observed: 'idle', observedAt: at(-minute) })]), []) ?? '', /Assigned worker session/);
  // The runtime says working, the record says the agent exited: the record is what is reported.
  assert.equal(attention(held([record({ state: 'finished', observed: 'ended', observedAt: at(-minute), endedAt: at(-minute) })]), [{ name: 'graphyard-worker-3', agent_status: 'working', pane_id: 'w1V:x' }]), 'Assigned worker session is ended');
  assert.equal(attention(held([record({ observed: 'working', observedAt: at(-20 * minute) })]), [{ name: 'graphyard-worker-3', agent_status: 'working', pane_id: 'w1V:x' }]), `Assigned worker session is not seen since ${at(-20 * minute)}`);
});

test('unit:ui-reads-session-state — the Work page lists as running only the sessions shown running, with when each was seen', () => {
  const work = board();
  const page = (key: string) => renderToStaticMarkup(createElement(WorkDetails as any, { ...dashboard(work), item: work.find(w => w.key === key)! }));
  const running = (html: string) => { const start = html.indexOf('<h3>Sessions running now</h3>'); return start < 0 ? '' : html.slice(start, html.indexOf('</ul>', start)); };
  const gy14 = running(page('GY-14'));
  assert.match(gy14, /working on working on the item · [^<]* · seen 1m ago/, 'seen at its observation a minute ago, not at the write forty minutes ago');
  assert.match(gy14, /idle on the item/);
  assert.equal(running(page('GY-12')), '', 'a stale, an ended and a lost session: none is running');
  assert.match(page('GY-12'), /\? implementation · worker-7/, 'the stale record is listed, marked, not as running');
  assert.match(page('GY-12'), /Not seen for 20m/);
});

test('unit:ui-reads-session-state — Up next says what an item waits on: the dependency that must ship first, or the overlap that holds it, never "Waiting for a worker" for either', () => {
  const work = base();
  const item = (key: string) => work.find(w => w.key === key)!;
  // GY-13 waits on GY-17 to ship; GY-17 itself is ready but its planned files overlap GY-14, claimed and in flight.
  Object.assign(item('GY-13'), { dependencies: [item('GY-17').id], gates: item('GY-13').gates.map(gate => gate.name === 'ready' ? { ...gate, passed: false, reasons: ['Dependency GY-17 is unfinished'] } : gate) });
  Object.assign(item('GY-17'), { plannedFiles: ['web/groups.ts'], blocker: null, gates: item('GY-17').gates.map(gate => gate.name === 'ready' ? { ...gate, passed: true, reasons: [] } : gate) });
  // Claimed ten minutes ago: a hold inside its two-hour bound (a hold past it no longer holds).
  Object.assign(item('GY-14'), { plannedFiles: ['web/groups.ts', 'web/pages/'], priority: item('GY-17').priority, lease: { ...item('GY-14').lease!, expiresAt: at(30 * minute) },
    lastAssignment: { ...item('GY-14').lastAssignment!, claimedAt: at(-10 * minute) }, pipeline: undefined });

  const { byGroup } = classify(work, NOW);
  const upNext = byGroup['up-next'].map(entry => entry.key).sort();
  assert.deepEqual(upNext, ['GY-12', 'GY-13', 'GY-17'], 'both are released and unclaimed, beside GY-12, whose worker\'s lease lapsed');
  assert.deepEqual(nextActor(item('GY-13'), 'up-next', NOW, undefined, work), { who: 'Nobody yet', does: 'Waiting for GY-17 to ship first' });
  assert.deepEqual(nextActor(item('GY-17'), 'up-next', NOW, undefined, work), { who: 'Nobody yet', does: 'Waiting for GY-14 to land first: its planned files overlap (web/groups.ts)' });
  assert.equal(nextActor(item('GY-12'), 'up-next', NOW, undefined, work).does, 'Hands it to the next free builder agent', 'GY-12 really is waiting for a worker');
  assert.equal(upNextMeaning(byGroup['up-next'], work, NOW), '1 waiting for a worker · 2 held', 'the tile counts what waits for a worker apart from what is held');
  assert.equal(upNextMeaning(byGroup['up-next'].filter(entry => entry.key !== 'GY-12'), work, NOW), 'Held behind other work', 'and never says a worker is what held items wait for');

  const html = renderToStaticMarkup(createElement(OverviewPage as any, dashboard(work)));
  const section = html.slice(html.indexOf('data-group-section="up-next"'));
  const row = (key: string) => { const start = section.indexOf(`data-row="${key}"`); assert.ok(start >= 0, key); return visibleWords(section.slice(start, section.indexOf('</div>', section.indexOf('row-who', start)))).join(' '); };
  assert.match(row('GY-13'), /Waiting for GY-17 to ship first/);
  assert.match(row('GY-17'), /Waiting for GY-14 to land first: its planned files overlap \(web\/groups\.ts\)/);
  for (const key of ['GY-13', 'GY-17']) assert.doesNotMatch(row(key), /Waiting for a worker|next free builder/);
  const tile = html.slice(html.indexOf('data-tile="up-next"'), html.indexOf('</button>', html.indexOf('data-tile="up-next"')));
  assert.match(tile, /<small>1 waiting for a worker · 2 held<\/small>/);
  assert.doesNotMatch(tile, /<small>Waiting for a worker<\/small>/);
  // With nothing held, the tile says what it always said.
  assert.equal(upNextMeaning([item('GY-12')], work, NOW), groupMeaning['up-next']);
  assert.equal(groupMeaning['up-next'], 'Waiting for a worker');
  assert.equal(upNextMeaning([item('GY-13')], work, NOW), 'Waiting for GY-17 to ship first', 'one held item: the tile names what it waits for');
});
