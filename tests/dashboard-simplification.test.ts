import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { evaluate, stages, type Gate, type Work } from '../src/model.js';
import { predictQueue } from '../src/merge-queue.js';
import { apiRoutes } from '../src/server/index.js';
import { computeAttribution } from '../src/attribution.js';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureApi, fixtureStatus, fixtureWork, NOW, visibleWords } from '../scripts/dashboard-fixture.mjs';
import { jargon, phaseOf, phases, plainReason, plainStatus } from '../web/plain-status.js';
import { homeNumbers } from '../web/home-numbers.js';
import { glossary } from '../web/glossary.js';
import { probeFeatures, unknownFeatures, type Features } from '../web/features.js';
import { primaryEntries, primaryEntry, sections, views, visibleViews } from '../web/pages/index.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import OverviewPage from '../web/pages/overview.js';
import WorkDetails from '../web/pages/work-details.js';
import ShippedPage from '../web/pages/shipped.js';
import GuidePage from '../web/pages/guide.js';
import CreateWork from '../web/pages/create-work.js';
import TopBar from '../web/components/top-bar.js';
import Sidebar from '../web/components/sidebar.js';
import FlowAnalytics, { FlowSummary, plainWait, submitToMerge } from '../web/flow-analytics.js';

// GY-67: the dashboard is rendered from the checked-in fixture (scripts/dashboard-fixture.mjs)
// and read the way a newcomer reads it: visible words only, closed <details> bodies and item
// titles excluded. Every assertion here is about presentation; gates, authority and the API
// are the control plane's and are only read.

const root = new URL('..', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
const work = fixtureWork() as unknown as Work[];
const find = (key: string) => work.find(w => w.key === key)!;
const noop = () => {};
function dashboard(overrides: Partial<Dashboard> = {}, role = 'admin', features: Features = unknownFeatures): Dashboard {
  return {
    token: 'fixture', work, status: fixtureStatus(role), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], features, events: fixtureApi('events') as any[], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false,
    queue: predictQueue(work, NOW), sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, role), refresh: async () => {}, action: async () => {},
    setError: noop, signOut: noop, ...overrides,
  };
}
const markup = (element: any) => renderToStaticMarkup(element);
const words = (html: string): string[] => visibleWords(html);
const text = (html: string) => words(html).join(' ');
const home = (d = dashboard()) => markup(createElement('div', null, createElement(Sidebar, { entries: views.map(view => primaryEntry(d, view)), dashboard: d }), createElement(TopBar, d), createElement(OverviewPage, d)));
const itemView = (key: string, role = 'admin') => markup(createElement(WorkDetails, { ...dashboard({}, role), item: find(key) }));
const jargonIn = (sentence: string) => jargon.filter(term => new RegExp(`\\b${term}`, 'i').test(sentence));

/** A work item in a given shape, evaluated by the real gate evaluator so its reasons are the control plane's own. */
function evaluated(overrides: Partial<Work>, all: Work[] = work): Work {
  const base = { ...find('GY-13'), id: `probe-${Math.random()}`, key: 'GY-99', ...overrides } as Work;
  const result = evaluate(base, [...all, base], new Date(NOW), [1]);
  return { ...base, stage: base.stage === 'done' ? 'done' : result.stage, gates: result.gates };
}
const withGates = (item: Partial<Work>, first: string, reasons: string[]): Work => {
  const order = ['ready', 'build', 'review', 'test', 'acceptance', 'merge'];
  const gates: Gate[] = order.map(name => ({ name, passed: order.indexOf(name) < order.indexOf(first), reasons: name === first ? reasons : order.indexOf(name) < order.indexOf(first) ? [] : ['later'] }));
  return { ...find('GY-15'), stage: first === 'ready' ? 'build' : first, ...item, gates } as Work;
};

test('unit:plain-status-copy — every stage and every gate reason reads as one plain sentence with no internal terms', () => {
  // The examples the requirement names, on the fixture.
  assert.equal(plainStatus(find('GY-13'), NOW).sentence, 'Waiting for someone to pick this up');
  assert.equal(plainStatus(find('GY-14'), NOW).sentence, 'Alex is building it — no pull request yet');
  assert.equal(plainStatus(find('GY-15'), NOW).sentence, 'Waiting for review of PR #42');
  assert.equal(plainStatus(find('GY-17'), NOW).sentence, 'Stuck: needs a second Postgres instance');
  // A lapsed claim is waiting for a worker, and says who stopped.
  assert.equal(plainStatus(find('GY-12'), NOW).sentence, 'Waiting for someone to pick this up — Robin stopped working on it');

  // One row per stage: the sentence, its tone, and who is named.
  const handedIn = { submission: { epoch: 1, pr: 42 }, candidate: { ...find('GY-15').candidate! }, epoch: 1 };
  const table: [string, Work, string, string][] = [
    ['backlog', { ...find('GY-11') }, 'Not started — waiting to be released for work', 'waiting'],
    ['ready', { ...find('GY-13') }, 'Waiting for someone to pick this up', 'waiting'],
    ['ready (dependency)', evaluated({ ready: true, dependencies: [find('GY-15').id] }), 'Waiting for GY-15 to ship first', 'waiting'],
    ['build', { ...find('GY-14') }, 'Alex is building it — no pull request yet', 'working'],
    ['build (rework)', { ...find('GY-15'), reworkRequested: true, lease: null }, 'Sent back for changes — waiting for someone to pick it up', 'waiting'],
    ['build (handed in)', withGates(handedIn, 'build', ['Pull request has not been independently observed']), 'Handed in — Graphyard has not seen the pull request on GitHub yet', 'waiting'],
    ['review', { ...find('GY-15') }, 'Waiting for review of PR #42', 'waiting'],
    ['review (changes)', withGates(handedIn, 'review', ['Outstanding change requests must be resolved through a new review']), 'A reviewer asked for changes on PR #42', 'waiting'],
    ['test', withGates(handedIn, 'test', ['Required CI check test has not passed on the current candidate']), 'Waiting for automated checks on PR #42', 'waiting'],
    ['acceptance', { ...find('GY-16') }, 'Waiting for proof that it works — 2 of 3 proofs passed', 'waiting'],
    ['merge', withGates(handedIn, 'merge', ['Merge queue position 2 of 3: GY-10 is ahead']), 'Queued to merge — 2nd in line, after GY-10', 'waiting'],
    ['merge (conflict)', withGates(handedIn, 'merge', ['Pull request is not mergeable against the current base']), 'Stuck: the pull request conflicts with the main branch', 'stuck'],
    ['merge (ready)', { ...withGates(handedIn, 'merge', []), stage: 'merge', gates: find('GY-18').gates }, 'Ready to merge PR #42', 'waiting'],
    ['done', { ...find('GY-18') }, 'Shipped in PR #40', 'shipped'],
    ['done (awaiting deploy)', { ...find('GY-18'), policy: { ...find('GY-18').policy, deploySmoke: true } as any }, 'Shipped in PR #40 — waiting to be deployed', 'waiting'],
    ['blocked', { ...find('GY-17') }, 'Stuck: needs a second Postgres instance', 'stuck'],
  ];
  const seen = new Set<string>();
  for (const [name, item, sentence, tone] of table) {
    const status = plainStatus(item, NOW);
    if (sentence) assert.equal(status.sentence, sentence, name);
    if (tone) assert.equal(status.tone, tone, name);
    assert.deepEqual(jargonIn(status.sentence), [], `${name}: ${status.sentence}`);
    seen.add(item.stage);
  }
  assert.deepEqual([...seen].sort(), [...stages].sort(), 'the table covers every stage');

  // Every reason the gate evaluator can give, in every form, has a plain reading.
  const reasons: [string, string][] = [
    ['ready', 'Not released from backlog'], ['ready', 'Dependency GY-3 is unfinished'], ['ready', 'needs a second Postgres instance'],
    ['build', 'Worker has not submitted implementation for this attempt'], ['build', 'Pull request has not been independently observed'], ['build', 'No workspace registered'],
    ['build', 'Candidate diff has not been compared against the base branch tip; a fresh GitHub observation is required'],
    ['build', 'Candidate changes 2 files outside its planned files that must match the base branch byte-for-byte; run graphyard sync GY-9, restore each file from origin/<base>, and push again'],
    ['build', 'Out-of-scope regression: src/engine.ts: reverted (shipped by GY-3)'],
    ['review', 'Verified clean Codex review of the current commit is required'],
    ['review', 'Every configured reviewer profile is exhausted for this candidate (claude); add reviewer capacity or select another review provider'],
    ['review', 'Verified approval from reviewer profile claude is required for the current commit'],
    ['review', 'A new independent GitHub approval after the requirement-review baseline is required'], ['review', 'Independent approval of the current commit is required'],
    ['review', 'Outstanding change requests must be resolved through a new review'],
    ['test', 'Required CI check typecheck has not passed on the current candidate'],
    ['acceptance', 'AC-2: unit:login needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'],
    ['acceptance', 'AC-2: e2e:checkout needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy; scenario v3 in staging; previously accepted evidence was revoked'],
    ['acceptance', 'Bootstrap obligation inherited from GY-4 AC-1: unit:x needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'],
    ['acceptance', 'Trusted unit:x evidence from ci is no longer independent: ci has since held an assignment on GY-9'],
    ['merge', 'GitHub observation missing or older than two minutes'], ['merge', 'Required Graphyard check and merge-queue branch protection have not been verified'],
    ['merge', 'Pull request is not mergeable against the current base'], ['merge', 'Unresolved lease-loss escalation requires operator resolution: worker vanished'],
    ['merge', 'Slice lead lead-1 ruled hold under rule R-2; delivery is blocked until the authorized recovery: redo the migration'],
    ['merge', 'Merge queue position 2 of 2: GY-10 is ahead'], ['merge', 'Speculative tip on predicted base abcdef123456 has not been published and validated for this candidate'],
    ['merge', 'Waiting for GY-10 to publish its speculative tip'],
  ];
  for (const [gate, reason] of reasons) {
    const plain = plainReason(reason, gate);
    assert.ok(plain.known, `${gate}: no plain reading for "${reason}"`);
    assert.deepEqual(jargonIn(plain.text), [], `${reason} → ${plain.text}`);
    const status = plainStatus(withGates({ submission: { epoch: 1, pr: 7 }, candidate: { ...find('GY-15').candidate!, pr: 7 }, blocker: gate === 'ready' && !/^(Not released|Dependency)/.test(reason) ? reason : null, lease: null }, gate, [reason]), NOW);
    assert.deepEqual(jargonIn(status.sentence), [], `${reason} → ${status.sentence}`);
  }
  // The live evaluator's reasons for every fixture item are all recognised.
  for (const item of work) for (const gate of evaluate(item, work, new Date(NOW), [1]).gates) for (const reason of gate.reasons) assert.ok(plainReason(reason, gate.name).known, `${item.key} ${gate.name}: ${reason}`);
  // An unanticipated reason never leaks: it reads as its step.
  assert.equal(plainReason('Internal epoch lease candidate mismatch', 'merge').text, 'Waiting to merge');
});

test('integration:dashboard-navigation — four primary entries; everything else under Insights or Settings; admin-only and unconfigured pages hidden', async () => {
  const labels = (d: Dashboard) => primaryEntries(d).map(entry => entry!.label);
  assert.deepEqual(sections.map(section => section.label), ['Work', 'Shipped', 'Insights', 'Settings']);
  for (const role of ['admin', 'reader', 'worker', 'coordinator', 'operator-agent']) assert.ok(labels(dashboard({}, role)).length <= 4, role);
  assert.deepEqual(labels(dashboard()), ['Work', 'Shipped', 'Insights', 'Settings']);
  const sectionOf = Object.fromEntries(views.map(view => [view.label, view.section]));
  for (const page of ['Shipping pulse', 'Flow analytics', 'Validation', 'Releases']) assert.equal(sectionOf[page], 'insights', page);
  for (const page of ['Test cases', 'Proof authority', 'Operator automation']) assert.equal(sectionOf[page], 'settings', page);

  // The sidebar renders exactly the primary entries; the pages of a section are tabs above the content.
  const sidebar = markup(createElement(Sidebar, { entries: views.map(view => primaryEntry(dashboard(), view)), dashboard: dashboard() }));
  assert.equal(sidebar.match(/class="nav( active)?"/g)?.length, 4);
  const tabs = (d: Dashboard, view: string) => [...markup(createElement(TopBar, { ...d, view })).matchAll(/class="tab(?: active)?"[^>]*>([^<]+)</g)].map(match => match[1]);
  assert.deepEqual(tabs(dashboard(), 'flow'), ['Shipping pulse', 'Flow analytics', 'Validation', 'Releases']);
  assert.deepEqual(tabs(dashboard(), 'grants'), ['Test cases', 'Proof authority', 'Operator automation']);
  assert.match(markup(createElement(TopBar, dashboard())), />How Graphyard works</, 'the guide is linked from the header');

  // Admin-only pages are hidden from reader and worker sessions, even when configured.
  const configured = { validation: true, releases: true, automation: true };
  for (const role of ['reader', 'worker']) {
    assert.ok(!visibleViews(dashboard({}, role, configured)).some(view => view.adminOnly), role);
    assert.deepEqual(tabs(dashboard({}, role, configured), 'grants'), ['Test cases', 'Proof authority'], role);
  }
  // A feature with nothing configured is hidden, not rendered as an empty explainer; an unknown one stays.
  const probed = await probeFeatures(async path => path === 'operator-agents' ? [] : { environments: [], releases: [], requests: [], candidates: [] }, true, false);
  assert.deepEqual(probed.features, { releases: false, validation: false, automation: false });
  const none = dashboard({}, 'admin', probed.features);
  assert.deepEqual(tabs(none, 'flow'), ['Shipping pulse', 'Flow analytics']);
  assert.deepEqual(tabs(none, 'grants'), ['Test cases', 'Proof authority']);
  const failing = await probeFeatures(async () => { throw new Error('unavailable'); }, true, false);
  assert.deepEqual(failing.features, { releases: null, validation: null, automation: null }, 'an outage never hides a page');
  assert.equal((await probeFeatures(async () => ({ requests: [] }), false, true)).features.validation, true, 'a scenario requirement means validation is in use');
  // No slice lead: no Delivery slices panel. A lead: the panel appears.
  assert.doesNotMatch(home(), /Delivery slices/);
  const led = fixtureStatus('admin'); led.delegation.slices[0].lead = { id: 'lead', displayName: 'Pine', sessionKind: 'ai' } as any;
  assert.match(home(dashboard({ status: led })), /Delivery slices/);
  // Operator agents cannot read the analytics pages, so they are not offered.
  assert.ok(!visibleViews(dashboard({}, 'operator-agent')).some(view => ['pulse', 'flow'].includes(view.id)));
  // web/main.tsx builds the sidebar from the registry through primaryEntry.
  assert.match(await read('web/main.tsx'), /views\.map\(entry => primaryEntry\(dashboard, entry\)\)/);
});

test('integration:dashboard-word-budget — the home page answers in progress, stuck and shipped on one screen in at most 150 words', () => {
  const page = home();
  const count = words(page).length;
  assert.ok(count <= 150, `home renders ${count} words excluding item titles: ${text(page)}`);
  for (const gone of ['Delivery slices', 'NO LEAD ASSIGNED', 'ENGINEERING, IN VIEW', 'Every change has an owner', 'Explicit reasons, actionable next steps', 'No delivery requires', 'sessions retain goals', 'leads coordinate only', 'Ownership is explicit'])
    assert.ok(!text(page).includes(gone), `no ${gone}`);
  assert.doesNotMatch(text(page), /\bp50\b|\bp95\b/, 'no percentile microtext by default');
  // The three questions, in order: stuck first, then in progress, then shipped.
  const order = ['aria-label="Stuck"', 'aria-label="In progress"', 'aria-label="Needs a worker"', 'aria-label="Shipped this week"'].map(label => page.indexOf(label));
  assert.ok(order.every(index => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]), `sections in order: ${order}`);
  assert.ok(page.indexOf('Move sessions to Postgres') < page.indexOf('Add dark mode to settings'), 'the stuck item is listed first');
  assert.match(text(page), /Stuck: needs a second Postgres instance/);
  // Every open item's status sentence is on the page.
  for (const item of work.filter(w => w.stage !== 'done' && phaseOf(w, NOW) !== 'not-started')) assert.ok(text(page).includes(text(plainStatus(item, NOW).sentence)), item.key);
});

test('integration:item-view-structure — status, owner, pull request and the one blocker first; the current step only; each criterion once; edits in an admin menu; at most 250 words', () => {
  const view = itemView('GY-16');
  const visible = text(view);
  const count = words(view).length;
  assert.ok(count <= 250, `item view renders ${count} words: ${visible}`);
  const at = (needle: string) => { const index = visible.indexOf(words(needle).join(' ')); assert.ok(index >= 0, `shows ${needle}: ${visible}`); return index; };
  const order = [at('Waiting for proof that it works — 2 of 3 proofs passed'), at('Owner'), at('PR #43'), at('Blocking now: The proof integration:login-latency has not passed yet')];
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'status sentence, owner, PR link and blocker lead the view');
  // Only the current step's reasons are visible; later refusing steps are collapsed.
  const review = itemView('GY-15');
  assert.match(text(review), /Waiting for someone else to approve the latest code/);
  assert.match(review, /<details class="later-steps"><summary>Later steps \(1\)<\/summary>/);
  assert.doesNotMatch(text(review), /Proven to work:/, 'later steps are collapsed');
  for (const raw of ['needs trusted passing evidence', 'Policy v', 'Revision ', 'assignment 1', 'GitHub observation missing']) assert.ok(!text(review).includes(raw) && !visible.includes(raw), `no ${raw} by default`);
  // Each criterion appears once, with one marker per proof.
  for (const ac of find('GY-16').criteria) assert.equal(visible.split(/\s+/).filter((word: string) => word === ac.id).length, 1, `${ac.id} once`);
  assert.equal(view.match(/class="marker-pass"/g)?.length, 2); assert.equal(view.match(/class="marker-pending"/g)?.length, 1);
  assert.match(visible, /AC-1 More than ten failed logins from one address in a minute are refused\. integration:login-rate-limit passed/);
  assert.match(view, /<li class="marker-pass">✓ <abbr class="term"[^>]*>integration:login-rate-limit<\/abbr> passed<\/li>/);
  // Policy-changing actions sit in a closed, admin-only Edit menu.
  assert.match(view, /<details class="edit-menu"><summary>Edit<\/summary>[\s\S]*Use Codex cloud review[\s\S]*Revise requirements[\s\S]*<\/details>/);
  assert.ok(!visible.includes('Use Codex cloud review') && !visible.includes('Revise requirements'));
  for (const role of ['reader', 'worker']) { const other = itemView('GY-16', role); assert.doesNotMatch(other, /edit-menu|Use Codex cloud review|Revise requirements/, role); }
});

test('integration:analytics-default-view — flow analytics opens to where work waits and pull-request-to-merge time; the rest behind Show details; no UNKNOWN cards', () => {
  const report = fixtureApi('analytics/flow?window=30');
  const phaseRows = (fixtureApi('analytics/flow/drilldown?window=30&metric=phase') as any).rows;
  const merge = submitToMerge(phaseRows);
  assert.equal(merge.n, 3, 'every shipped fixture item has a measured pull-request-to-merge time');
  assert.ok(merge.p50Ms! > 0 && merge.p90Ms! >= merge.p50Ms!);
  const attribution = computeAttribution({ observedAt: new Date(NOW).toISOString(), from: new Date(NOW - 30 * 864e5).toISOString(), to: new Date(NOW).toISOString(), days: 30, records: [], recordsTruncated: false, requests: [], requestsTruncated: false, environments: {}, blockedNow: [] } as any);
  const page = markup(createElement(FlowAnalytics, { request: async () => ({}), token: 'fixture', canAudit: true, initial: { report, merge, attribution } }));
  const visible = text(page);
  assert.match(visible, /Where work is waiting/);
  assert.match(visible, /Pull request opened merged/);
  assert.match(page, /Pull request opened → merged/);
  assert.match(visible, /typical p50 .*slowest one in ten p90 .*3 merged/);
  const waiting = (report as any).bottleneck.categories.filter((c: any) => c.id !== 'delivered');
  for (const category of waiting) assert.equal(visible.includes(`${plainWait[category.id]} ${category.count}`), category.count > 0, `${category.label}: shown only when it has items, in plain words`);
  assert.doesNotMatch(visible, /acceptance evidence|In implementation/, 'the server category labels stay in Show details');
  for (const hidden of ['Cumulative flow', 'Lead time', 'Stage dwell', 'Phase durations', 'Operations', 'Attribution', 'Coverage, exclusions and definitions', 'Work type', 'Delivery slice'])
    assert.ok(!visible.includes(hidden), `${hidden} is behind Show details`);
  assert.match(page, /<details class="flow-details"><summary>Show details<\/summary>[\s\S]*Cumulative flow[\s\S]*Attribution[\s\S]*Coverage, exclusions and definitions/);
  assert.ok((attribution as any).unavailable.length > 0, 'the fixture has unmeasured attribution metrics');
  assert.doesNotMatch(page, /class="flow-card attribution-card"[^>]*data-state="unavailable"|attribution-badge-unavailable/, 'a metric with no data is never drawn as an UNKNOWN card');
  assert.doesNotMatch(visible, /UNKNOWN/i);
  // A report with nothing measured omits the merge figure rather than showing a placeholder.
  assert.doesNotMatch(markup(createElement(FlowSummary, { report, merge: submitToMerge([]), onDrill: noop })), /Pull request opened/);
});

test('plain-language support for manual:plain-language-review — every visible technical term has a hover definition from the shared glossary; the guide is under 300 words; the create form explains proofs', () => {
  const guide = markup(createElement(GuidePage));
  assert.ok(words(guide).length <= 300, `guide is ${words(guide).length} words`);
  for (const html of [guide, itemView('GY-16'), home(dashboard({ status: (() => { const s = fixtureStatus('admin'); s.delegation.slices[0].lead = { id: 'l', displayName: 'Pine', sessionKind: 'ai' } as any; return s; })() }))])
    for (const [, title] of html.matchAll(/<abbr class="term" title="([^"]*)"/g)) assert.ok(Object.values(glossary).includes(title.replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&') as any), `definition from the glossary: ${title}`);
  const form = markup(createElement(CreateWork, dashboard({ creating: true })));
  assert.match(form, /A proof name starts with its kind/);
  for (const example of ['unit:login-rejects-bad-password', 'integration:claim-safety', 'e2e:checkout', 'manual:copy-review']) assert.ok(form.includes(example), example);
  assert.match(form, /Add another criterion/);
});

test('integration:dashboard-capability-parity — nothing removed from a default view is lost; the API is unchanged; the fixture reproduces the audit views; the sidebar spans the page', async () => {
  // The item view keeps every datum and action, under More details or the Edit menu.
  const item = find('GY-16');
  const view = itemView('GY-16');
  for (const needle of ['Policy v1', 'Revision 1', 'P2', 'Worker ID: worker-2', 'Coordination', 'Code review', 'Gate decisions', 'Evidence (2)', 'Work history', 'Use Codex cloud review', 'Revise requirements', 'build-1:/work/gy-16-1', 'In this step for'])
    assert.ok(view.includes(needle), needle);
  for (const gate of item.gates) for (const reason of gate.reasons) assert.ok(view.includes(reason.replace(/&/g, '&amp;').replace(/>/g, '&gt;')), `raw reason kept: ${reason}`);
  for (const ac of item.criteria) assert.ok(view.includes(ac.text), `full criterion kept: ${ac.id}`);
  // The home page keeps the board arrangement, stage timings and search; delivered work has its own page.
  const page = home();
  for (const control of ['Board view', 'Show times', 'aria-label="Search work"', 'See everything shipped']) assert.ok(page.includes(control), control);
  const shipped = markup(createElement(ShippedPage, dashboard()));
  for (const key of ['GY-18', 'GY-19', 'GY-9']) assert.ok(shipped.includes(key), key);
  // Every page in the registry stays reachable for an admin while its feature is unknown or configured.
  const admin = dashboard();
  for (const view of views) assert.ok(visibleViews(admin).includes(view), `${view.label} reachable`);
  // The dashboard calls only endpoints the server already serves: the API is unchanged.
  const served = apiRoutes.flatMap(module => module.routes).map(route => route.path);
  const matches = (path: string) => served.some(route => typeof route === 'string' ? route === `/api/${path}` : route.test(`/api/${path}`));
  for (const file of ['web/features.ts', 'web/flow-analytics.tsx', 'web/main.tsx', 'web/pages/create-work.tsx', 'web/pages/work-details.tsx'])
    for (const [, path] of (await read(file)).matchAll(/(?:api|request|read)\(`([^`$?]+)[`$?]/g)) assert.ok(matches(path.replace(/\/$/, '')) || matches(`${path}x`), `${file}: /api/${path}`);
  for (const path of ['delivery', 'validation', 'operator-agents', 'analytics/flow', 'analytics/flow/drilldown', 'work']) assert.ok(matches(path), path);
  const source = (await Promise.all(['web/pages/work-details.tsx', 'web/plain-status.ts', 'web/home-numbers.ts'].map(read))).join('\n');
  assert.doesNotMatch(source, /api\((['`])work\/[^'`]*\/(stage|state)/, 'no client-controlled lifecycle state');
  // The fixture reproduces the audit's cases (the stage table in unit:plain-status-copy covers the rest), and the script the views.
  for (const phase of ['not-started', 'needs-worker', 'building', 'review', 'proof', 'shipped'] as const) assert.ok(work.some(w => phaseOf(w, NOW) === phase), phase);
  assert.ok(work.some(w => w.blocker) && work.some(w => w.stage === 'build' && !w.submission && Date.parse(w.lease?.expiresAt ?? '') < NOW), 'a blocked item and a lapsed claim');
  const script = await read('scripts/dashboard-fixture.mjs');
  for (const view of ['01-home', '02-item-view', '05-flow-analytics', '09-create-form']) assert.ok(script.includes(`'${view}'`), view);
  // The sidebar is a full-height flex column whose contents stick; no later rule pins it to one viewport.
  const css = await read('web/style.css');
  const sidebarRules = [...css.matchAll(/(?:^|[}\s])\.sidebar\{([^}]*)\}/g)].map(match => match[1]);
  const last = sidebarRules.filter(rule => /position:/.test(rule)).at(-1)!;
  assert.match(last, /position:relative/); assert.match(last, /align-self:stretch/);
  assert.match(css, /\.sidebar-inner\{position:sticky;top:0;height:100vh/);
  assert.match(css, /\.main\{margin-left:0\}/);
});

test('unit:home-numbers-reconcile — every home number counts one named thing and the numbers agree', () => {
  const numbers = homeNumbers(work, NOW);
  const open = work.filter(w => w.stage !== 'done');
  assert.equal(numbers.open, open.length, 'Open counts open items only');
  assert.equal(numbers.open, 7);
  assert.equal(numbers.byPhase.shipped, 0, 'delivered items are never in a tile or the open strip');
  assert.equal(phases.filter(p => p !== 'shipped').reduce((sum, p) => sum + numbers.byPhase[p], 0), numbers.open, 'the stage strip sums to Open');
  assert.equal(numbers.building, numbers.byPhase.building);
  assert.equal(numbers.needsWorker, numbers.byPhase['needs-worker']);
  // The lapsed claim (GY-12, stored stage "build") and the blocked item are waiting for a worker; only Alex is building.
  assert.equal(find('GY-12').stage, 'build');
  assert.equal(phaseOf(find('GY-12'), NOW), 'needs-worker');
  assert.equal(numbers.building, 1);
  assert.equal(numbers.needsWorker, 3);
  // Stuck counts items, not reasons: GY-17 has one blocker but its item refuses several gates.
  assert.equal(numbers.stuck, 1);
  assert.ok(find('GY-17').gates.flatMap(g => g.reasons).length > 1);
  assert.equal(numbers.shippedThisWeek, 2, 'GY-18 and GY-19; GY-9 shipped 20 days ago');
  // The rendered tiles and strip show exactly these numbers.
  const page = home();
  const tile = (label: string) => page.match(new RegExp(`<span>${label}</span><strong>(\\d+)</strong>`))?.[1];
  assert.equal(tile('Open'), String(numbers.open)); assert.equal(tile('Being built'), String(numbers.building));
  assert.equal(tile('Need a worker'), String(numbers.needsWorker)); assert.equal(tile('Stuck'), String(numbers.stuck));
  for (const phase of phases.filter(p => p !== 'shipped')) {
    const label = { 'not-started': 'Not started', 'needs-worker': 'Needs a worker', building: 'Being built', review: 'In review', checks: 'Automated checks', proof: 'Proving it works', merging: 'Merging' }[phase];
    assert.match(page, new RegExp(`<span>${label}</span><strong>${numbers.byPhase[phase]}</strong>`), phase);
  }
  assert.match(page, new RegExp(`Shipped this week <span class="count">${numbers.shippedThisWeek}</span>`));
});
