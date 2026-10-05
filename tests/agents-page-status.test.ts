import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyRegistryMutation, emptyRegistry, fleetView, foldObservation, recordRunOutcome, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { accountStatus, countdown, localTime, roleLaunch, whenText } from '../web/agent-status.js';
import { FleetOverview } from '../web/pages/fleet.js';

/**
 * GY-978: the Agents page answers at a glance which agents can work right now, which are spent and
 * until when, and why. Each test is named for the proof it produces:
 * unit:agents-page-account-status-chips and unit:agents-page-role-launchability.
 *
 * The registry is built with the real mutations and folds, viewed through the real `fleetView`
 * the /api/agent-registry route serves, and the page body is rendered as static markup.
 */

const HOST = 'agents-host', now = Date.parse('2026-09-30T09:00:00Z');
const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const iso = (offset: number) => new Date(now + offset).toISOString();
const account = (name: string, extra: Record<string, unknown> = {}) => ({ name, runtime: 'claude', model: 'opus', credential: { host: HOST, home: `/agents/${name}` }, ...extra });
const session = (id: string, role: FleetSession['role'], name: string, work: string, selectedAt: string, ended: string | null = null, endReason: string | null = null): FleetSession =>
  ({ id, role, account: name, runtime: 'claude', model: 'opus', host: HOST, work, principal: 'agent', selectedAt, selectedBy: 'coordinator', reason: 'first eligible', skipped: [], endedAt: ended, endReason });

function registry(roles: { name: 'worker' | 'reviewer'; accounts: string[]; concurrency: number }[], names: string[], extra: Record<string, Record<string, unknown>> = {}): AgentRegistry {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } }],
    models: [{ name: 'opus', id: 'claude-opus-5', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'frontier', contextTokens: null } }],
    accounts: names.map(name => account(name, extra[name])),
    roles, reason: 'agents page fixture',
  }, { actor: 'operator', at: iso(-3 * hour) }).registry;
}
const find = (document: AgentRegistry, name: string) => document.accounts.find(entry => entry.name === name)!;
const available = { loggedIn: true, state: 'available' as const, usage: [], resetsAt: null, reason: null };
const row = (page: string, name: string) => {
  const start = page.indexOf(`data-account-row="${name}"`);
  assert.ok(start >= 0, `${name} has a row`);
  return page.slice(start, page.indexOf('</tr>', start));
};

test('unit:agents-page-account-status-chips — the Agents page lists every registry account in one table with a single status chip from quota state, reset time, enabled flag, recent launch failures and role membership, and each reset in local time with a countdown', () => {
  const names = ['spent', 'disabled', 'smoke-fails', 'launch-fails', 'working', 'idle', 'role-less'];
  const document = registry([{ name: 'worker', accounts: names.filter(name => name !== 'role-less'), concurrency: 8 }], names, { disabled: { enabled: false } });
  for (const name of names) foldObservation(find(document, name), available, { actor: 'coordinator', at: iso(-minute) });
  const resetsAt = iso(2 * day + 23 * hour + 27 * minute);
  foldObservation(find(document, 'spent'), { loggedIn: true, state: 'exhausted', usage: [{ window: '7d', percent: 100, resetsAt }], resetsAt, reason: 'weekly window spent' }, { actor: 'coordinator', at: iso(-minute) });
  find(document, 'smoke-fails').smoke = { result: 'fail', reason: 'the model refused the smoke prompt', at: iso(-10 * minute), by: 'coordinator' };
  document.sessions = [
    session('00000000-0000-4000-8000-000000009781', 'worker', 'launch-fails', 'GY-977', iso(-20 * minute), iso(-19 * minute), 'worker run for GY-977 failed to start: cursor-agent: command not found'),
    session('00000000-0000-4000-8000-000000009782', 'worker', 'working', 'GY-978', iso(-10 * minute)),
  ];
  const view = fleetView(document, now);
  const page = renderToStaticMarkup(createElement(FleetOverview, { fleet: view, now }));

  // One table, one row per registry account.
  assert.equal(page.split('aria-label="Accounts at a glance"').length - 1, 1, 'one accounts table');
  assert.equal(page.split('data-account-row=').length - 1, names.length, 'every account has exactly one row');
  // One chip per row, derived from what keeps the account out or what it is doing.
  const expected: Record<string, [string, string, RegExp]> = {
    spent: ['spent', 'Spent', new RegExp(`quota spent until ${whenText(resetsAt, now).replace(/[()]/g, '\\$&')} — 7d 100%`)],
    disabled: ['disabled', 'Disabled', /disabled by an operator/],
    'smoke-fails': ['launch-failing', 'Launch failing', /smoke test failed: the model refused the smoke prompt; retried /],
    'launch-fails': ['launch-failing', 'Launch failing', /last launch failed: worker run for GY-977 failed to start: cursor-agent: command not found/],
    working: ['working', 'Working', /1 live — worker on GY-978/],
    idle: ['idle', 'Idle', /ready for worker/],
    'role-less': ['no-role', 'No role', /serves no role; name it in a role or remove it/],
  };
  const rowWhy: Record<string, RegExp> = {
    spent: /^<span class="muted">—<\/span>$/, idle: /^<span class="muted">—<\/span>$/,
    working: /^worker on GY-978$/, 'smoke-fails': /^smoke test failed: the model refused the smoke prompt$/,
  };
  for (const [name, [chip, label, reason]] of Object.entries(expected)) {
    const status = accountStatus(view.accounts.find(entry => entry.name === name)!, view, now);
    assert.equal(status.chip, chip, `${name} reads ${chip}`);
    assert.match(status.reason, reason, `${name}: ${status.reason}`);
    const shown = row(page, name);
    assert.ok(shown.includes(`data-status="${chip}"`), `${name}'s row carries its status`);
    assert.equal(shown.split('data-chip=').length - 1, 1, `${name} shows a single chip`);
    assert.ok(shown.includes(`data-chip="${chip}">${label}</span>`), `${name}'s chip reads ${label}`);
    // The row's Why cell adds only what no other cell says (GY-1325): nothing for idle or spent, the live work, the failure without its retry time.
    const why = /<td data-label="Why" class="why">(.*?)<\/td>/.exec(shown)![1].replaceAll('&#x27;', '\'');
    if (name in rowWhy) assert.match(why, rowWhy[name], `${name}'s row: ${why}`);
    else assert.match(why, reason, `${name}'s row states why`);
  }

  // The reset time in the viewer's local time with a relative countdown, the exact instant kept as its datetime.
  assert.equal(countdown(resetsAt, now), 'in 2d 23h');
  assert.equal(localTime(resetsAt), new Date(resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
  assert.ok(row(page, 'spent').includes(`<time dateTime="${resetsAt}" title="${resetsAt}">${localTime(resetsAt)} <small>in 2d 23h</small></time>`), row(page, 'spent'));
  assert.ok(row(page, 'idle').includes('<td data-label="Back">—</td>'), 'an account with nothing to wait for names no time');

  // A spent account whose reset has passed is not spent any more; a launch failure ages out of the window.
  assert.notEqual(accountStatus(view.accounts.find(entry => entry.name === 'spent')!, view, Date.parse(resetsAt) + minute).chip, 'spent');
  assert.equal(accountStatus(view.accounts.find(entry => entry.name === 'launch-fails')!, view, now + 2 * hour).chip, 'idle');
  // Only the first reason that applies: a disabled account that is also spent reads disabled.
  foldObservation(find(document, 'disabled'), { loggedIn: true, state: 'exhausted', usage: [], resetsAt, reason: null }, { actor: 'coordinator', at: iso(-minute) });
  assert.equal(accountStatus(fleetView(document, now).accounts.find(entry => entry.name === 'disabled')!, view, now).chip, 'disabled');
});

test('unit:agents-page-role-launchability — the Agents page states per role whether it can launch now and, when it cannot, each account\'s reason and the earliest time it can, for a fully spent role and a role at its concurrency limit', () => {
  const names = ['opencode-a', 'opencode-b', 'opencode-c', 'cursor-a', 'claude-b'];
  const document = registry([
    { name: 'worker', accounts: ['opencode-a', 'opencode-b', 'opencode-c', 'cursor-a'], concurrency: 8 },
    { name: 'reviewer', accounts: ['claude-b'], concurrency: 1 },
  ], names);
  for (const name of names) foldObservation(find(document, name), available, { actor: 'coordinator', at: iso(-minute) });
  const early = iso(2 * day + 23 * hour), late = iso(3 * day);
  for (const [name, resetsAt] of [['opencode-a', late], ['opencode-b', early], ['opencode-c', late]] as const)
    foldObservation(find(document, name), { loggedIn: true, state: 'exhausted', usage: [], resetsAt, reason: 'weekly limit' }, { actor: 'coordinator', at: iso(-minute) });
  // cursor-a: two runs in a row ended without a result, so the registry holds it from worker for an hour.
  recordRunOutcome(document, { account: 'cursor-a', role: 'worker' }, 'no-result', 'the run ended without a result', iso(-2 * minute));
  recordRunOutcome(document, { account: 'cursor-a', role: 'worker' }, 'no-result', 'the run ended without a result', iso(-minute));
  // The reviewer role is at its concurrency limit: one live session of one allowed.
  document.sessions = [session('00000000-0000-4000-8000-000000009783', 'reviewer', 'claude-b', 'GY-970', iso(-5 * minute))];
  const view = fleetView(document, now);
  const role = (name: string) => view.roles.find(entry => entry.role === name)!;

  // A fully spent role: none can launch, each account's reason grouped, and the earliest account back by itself.
  const workers = roleLaunch(role('worker'), view, now);
  assert.equal(workers.canLaunch, false);
  const held = iso(-minute + hour);
  assert.equal(workers.text, `Workers: none can launch — opencode-a, opencode-c spent until ${whenText(late, now)}; opencode-b spent until ${whenText(early, now)}; cursor-a launch failing; next: cursor-a ${whenText(held, now)}`);
  assert.equal(workers.nextAt, held, 'the earliest time any account frees up: the hold ends before any quota resets');
  // Once the hold is over and cursor-a is spent too, the earliest reset is next.
  recordRunOutcome(document, { account: 'cursor-a', role: 'worker' }, 'result', 'judged', iso(0));
  foldObservation(find(document, 'cursor-a'), { loggedIn: true, state: 'exhausted', usage: [], resetsAt: late, reason: null }, { actor: 'coordinator', at: iso(0) });
  const spent = roleLaunch(fleetView(document, now).roles.find(entry => entry.role === 'worker')!, fleetView(document, now), now);
  assert.equal(spent.nextAt, early);
  assert.match(spent.text, new RegExp(`next: opencode-b ${whenText(early, now).replace(/[()]/g, '\\$&')}$`));

  // A role at its concurrency limit: it cannot launch, it says so with its count, and next is its account once a session ends.
  const reviewers = roleLaunch(role('reviewer'), view, now);
  assert.equal(reviewers.canLaunch, false);
  assert.equal(reviewers.text, 'Reviewers: none can launch — at its concurrency limit (1 of 1 live); next: claude-b when one of its sessions ends');

  // A role with an eligible account launches now, on the account the registry's own choice takes.
  foldObservation(find(document, 'opencode-b'), available, { actor: 'coordinator', at: iso(0) });
  const recovered = fleetView(document, now);
  const ready = roleLaunch(recovered.roles.find(entry => entry.role === 'worker')!, recovered, now);
  assert.deepEqual([ready.canLaunch, ready.account, ready.text], [true, 'opencode-b', 'Workers: can launch now — next: opencode-b now']);

  // The page states each role's verdict in its own line.
  const page = renderToStaticMarkup(createElement(FleetOverview, { fleet: view, now }));
  assert.ok(page.includes('data-role-launch="worker" data-can-launch="no"'), 'the worker line');
  assert.ok(page.includes('data-role-launch="reviewer" data-can-launch="no"'), 'the reviewer line');
  assert.ok(page.includes('Reviewers: none can launch — at its concurrency limit (1 of 1 live)'), 'the reason on the page');
  assert.ok(page.includes('Can launch now? <span class="count">0 of 2</span>'), 'the section counts the roles that can launch');
});
