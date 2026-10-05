import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyRegistryMutation, emptyRegistry, fleetView, foldObservation, type AgentRegistry, type FleetView } from '../src/model/registry.js';
import { FleetOverview, probeStatus, quotaStaleThresholdMs } from '../web/pages/fleet.js';

/**
 * GY-945: the fleet panel — Settings › Agents (web/pages/fleet.tsx) — is where the dashboard shows
 * every agent account's limits, quota windows and eligibility. It renders exactly the `FleetView`
 * `GET /api/agent-registry` serves, the same data `graphyard master registry` reports, and marks
 * each account's probe health, so an operator can tell a real wall from an old probe. Both tests
 * build a registry with the real mutations and render the pure view; no browser, no server.
 */

const HOST = 'panel-host', now = Date.parse('2030-05-04T12:00:00Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
const minute = 60_000, hour = 60 * minute;

function registryFixture(): AgentRegistry {
  let registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [
      { name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } },
      { name: 'codex', launch: { kind: 'codex', args: [], environment: {}, homeVariable: null, modelFlag: null, login: null, loginFile: null } },
    ],
    models: [
      { name: 'opus', id: 'claude-opus-5', cost: { inputPerMTok: 15, outputPerMTok: 75 }, capability: { tier: 'frontier', contextTokens: null } },
      { name: 'gpt', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } },
    ],
    accounts: [
      { name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: HOST, home: '/agents/claude-a' }, maxSessions: 2 },
      { name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: HOST, home: '/agents/claude-b' } },
      { name: 'codex-a', runtime: 'codex', model: 'gpt', credential: { host: 'other-host', home: '/agents/codex-a' } },
    ],
    roles: [
      { name: 'worker', accounts: ['claude-a', 'claude-b', 'codex-a'], concurrency: 2 },
      { name: 'reviewer', accounts: ['codex-a'], concurrency: 1 },
    ],
    reason: 'panel fixture',
  }, { actor: 'operator', at: iso(-3 * hour) }).registry;
  // Quota windows as an executor's probe folds them (the same fold a selection records): the
  // exhausted account carries a reset per window where the provider states one, and each
  // observation carries the moment it was read and that a probe read it.
  foldObservation(registry.accounts.find(account => account.name === 'claude-a')!,
    { loggedIn: true, state: 'exhausted', usage: [{ window: '5h', percent: 62, resetsAt: iso(40 * minute) }, { window: '7d', percent: 18, resetsAt: null }], resetsAt: iso(40 * minute), reason: 'weekly window spent' },
    { actor: 'coordinator', at: iso(-5 * minute) });
  foldObservation(registry.accounts.find(account => account.name === 'claude-b')!,
    { loggedIn: true, state: 'available', usage: [{ window: '5h', percent: 12, resetsAt: null }], resetsAt: null, reason: null },
    { actor: 'coordinator', at: iso(-2 * hour) });
  // One live session, as a selection recorded it: the panel counts what the registry counts.
  registry.sessions.push({ id: '00000000-0000-4000-8000-000000009451', role: 'worker', account: 'claude-a', runtime: 'claude', model: 'opus', host: HOST, work: 'GY-945', principal: 'worker-1',
    selectedAt: iso(-10 * minute), selectedBy: 'coordinator', reason: 'first eligible', skipped: [], endedAt: null, endReason: null });
  return registry;
}

const card = (page: string, name: string) => {
  const start = page.indexOf(`data-account="${name}"`);
  assert.ok(start >= 0, `${name} has a card`);
  return page.slice(start, page.indexOf('data-account=', start + 1) < 0 ? page.length : page.indexOf('data-account=', start + 1));
};

test('unit:fleet-panel-renders-registry — the fleet panel lists every account the registry holds, each with its runtime and model, quota state, per-window usage percentages with reset times, eligibility and the reason when false, role preferences, and its live session count against its limit', () => {
  const view: FleetView = fleetView(registryFixture(), now, HOST);
  const page = renderToStaticMarkup(createElement(FleetOverview, { fleet: view, now }));
  // Every registry account opens as a card — the same fleet `master registry` reports, from the
  // same fleetView the /api/agent-registry route serves.
  assert.equal(view.accounts.length, 3);
  for (const account of view.accounts) assert.ok(page.includes(`data-account="${account.name}"`), `${account.name} is listed`);
  const claudeA = card(page, 'claude-a');
  // What it runs, and that it cannot launch right now, with the registry's own reason.
  assert.ok(claudeA.includes('claude-a · claude · opus (claude-opus-5) · ineligible'), claudeA);
  assert.ok(claudeA.includes('Ineligible: claude-a quota is exhausted'), 'the ineligible reason');
  // Quota state and every window's usage percentage, each with the reset time the registry holds
  // for it — and a window without a reset reads without one rather than inventing a time.
  assert.ok(claudeA.includes('Quota: exhausted — '), claudeA);
  assert.ok(claudeA.includes(`5h 62% (resets ${new Date(iso(40 * minute)).toLocaleString()})`), 'the window with its reset time');
  assert.ok(claudeA.includes('), 7d 18%'), 'the window without a reset reads without one');
  assert.ok(claudeA.includes(`Resets: ${new Date(iso(40 * minute)).toLocaleString()}`), 'the account-level reset');
  // Role preferences in the role's own order, and the live session count against the limit.
  assert.ok(claudeA.includes('Roles: worker (1 of 3)'), claudeA);
  assert.ok(claudeA.includes('Live sessions: 1 — worker on GY-945 since'), 'the live session count with the session itself');
  assert.ok(claudeA.includes('(limit 2)'), 'the account\'s session limit');
  // A placement-refused account shows its reason, and an account at no limit shows only the count.
  const codexA = card(page, 'codex-a');
  assert.ok(codexA.includes('Ineligible: codex-a is placed on other-host; this executor is panel-host'));
  assert.ok(codexA.includes('Roles: worker (3 of 3), reviewer (1 of 1)'), 'preferences across every role that names it');
  assert.ok(codexA.includes('Live sessions: 0'), 'a count even when nothing is live');
  assert.ok(!codexA.includes('(limit '), 'an account without a limit names none');
  const claudeB = card(page, 'claude-b');
  assert.ok(claudeB.includes('Quota: available — 5h 12%'), claudeB);
  assert.ok(claudeB.includes('claude-b · claude · opus (claude-opus-5) · eligible'), 'an eligible account says so');
});

test('unit:fleet-panel-marks-stale-probe — each card shows when its quota was last observed, an account whose reading is older than the freshness bound reads as an old probe and one whose probe failed reads as failed, each visually distinct from a healthy account', async () => {
  let registry = registryFixture();
  // A probe-failed account: its smoke test failed it, on a reading otherwise fresh.
  foldObservation(registry.accounts.find(account => account.name === 'codex-a')!,
    { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null }, { actor: 'coordinator', at: iso(-minute) });
  const codex = registry.accounts.find(account => account.name === 'codex-a')!;
  codex.smoke = { result: 'fail', reason: 'the model refused the smoke prompt', at: iso(-minute), by: 'coordinator' };

  const view = fleetView(registry, now, HOST);
  const page = renderToStaticMarkup(createElement(FleetOverview, { fleet: view, now }));
  // Three tones, one per card: fresh within the bound, stale past it (or never observed), failed on the smoke test.
  assert.match(card(page, 'claude-a'), /data-probe="fresh"[^>]*>quota observed 5m ago</);
  assert.match(card(page, 'claude-b'), /data-probe="stale"[^>]*>old probe — quota observed 2h ago</);
  assert.match(card(page, 'codex-a'), /data-probe="failed"[^>]*>probe failed: the model refused the smoke prompt</);
  // The absolute observation time stands beside the mark, so the operator sees when it was read.
  assert.ok(card(page, 'claude-b').includes(`Observed ${new Date(iso(-2 * hour)).toLocaleString()}`));
  // Never observed is the stalest reading of all.
  assert.equal(probeStatus({ observedAt: null, smoke: null, quotaSource: null }, now).text, 'quota never observed');
  // The bound itself: a reading at the threshold is fresh, one moment past it is stale.
  assert.equal(probeStatus({ observedAt: iso(-quotaStaleThresholdMs), smoke: null, quotaSource: 'probe' }, now).tone, 'fresh');
  assert.equal(probeStatus({ observedAt: iso(-quotaStaleThresholdMs - 1), smoke: null, quotaSource: 'probe' }, now).tone, 'stale');
  // Visually distinguished in the stylesheet: the stale mark and the failed mark draw different
  // tokens, and neither is the plain text a healthy account reads as.
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.probe\.stale\{color:var\(--needs-you\)\}/);
  assert.match(css, /\.probe\.failed\{color:var\(--blocked\)\}/);
  assert.match(css, /\.probe\{color:var\(--text-2\)\}/);
  assert.ok(!page.includes('data-probe="stale" data-probe="failed"'), 'one mark per card');
});

/**
 * GY-1325: Settings › Agents at a glance — one row per account, a Why cell that never repeats
 * another column, one launch line, and spent accounts collapsed by the day they are back. Each
 * fleet holds single-account plans (every account its own login home), as production does.
 */
type Role = 'worker' | 'reviewer' | 'producer' | 'approver' | 'escalation-handler' | 'master';
function declutterFleet(names: string[], roles: { name: Role; accounts: string[]; concurrency: number }[], spent: string[] = [], live: [Role, string, string][] = []): FleetView {
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } }],
    models: [{ name: 'opus', id: 'claude-opus-5', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'frontier', contextTokens: null } }],
    accounts: names.map(name => ({ name, runtime: 'claude', model: 'opus', credential: { host: HOST, home: `/agents/${name}` } })),
    roles, reason: 'declutter fixture',
  }, { actor: 'operator', at: iso(-3 * hour) }).registry;
  for (const account of registry.accounts) foldObservation(account, spent.includes(account.name)
    ? { loggedIn: true, state: 'exhausted', usage: [{ window: '5h', percent: 4, resetsAt: null }, { window: '7d', percent: 100, resetsAt: spentUntil }], resetsAt: spentUntil, reason: 'weekly window spent' }
    : { loggedIn: true, state: 'available', usage: account.name === 'unreported' ? [] : [{ window: '5h', percent: 31, resetsAt: iso(2 * hour) }], resetsAt: null, reason: null },
  { actor: 'coordinator', at: iso(-minute) });
  registry.sessions = live.map(([role, account, work], index) => ({ id: `00000000-0000-4000-8000-0000000132${String(index).padStart(2, '0')}`, role, account, runtime: 'claude', model: 'opus', host: HOST, work, principal: 'agent',
    selectedAt: iso(-minute), selectedBy: 'coordinator', reason: 'first eligible', skipped: [], endedAt: null, endReason: null }));
  return fleetView(registry, now, HOST);
}
const spentUntil = iso(3 * 24 * hour);
const render = (fleet: FleetView) => renderToStaticMarkup(createElement(FleetOverview, { fleet, now }));
const accountRow = (page: string, name: string) => {
  const start = page.lastIndexOf('<tr', page.indexOf(`data-account-row="${name}"`));
  assert.ok(start >= 0, `${name} has a row`);
  return page.slice(start, page.indexOf('</tr>', start));
};
const whyCell = (row: string) => /<td data-label="Why" class="why">(.*?)<\/td>/.exec(row)?.[1] ?? assert.fail(`no Why cell in ${row}`);

test('unit:fleet-one-row-per-account — a fleet of single-account plans renders exactly one table row per account and no plan header row, each row carrying its own usage windows, and unreported usage as a muted dash with its reason in the title', () => {
  const names = ['row-a', 'row-b', 'row-c', 'unreported'];
  const fleet = declutterFleet(names, [{ name: 'worker', accounts: names, concurrency: 4 }]);
  assert.ok(fleet.plans!.every(plan => plan.accounts.length === 1), 'every plan holds a single account');
  const page = render(fleet);
  const table = page.slice(page.indexOf('aria-label="Accounts at a glance"'), page.indexOf('</table>', page.indexOf('aria-label="Accounts at a glance"')));
  const body = table.slice(table.indexOf('</thead>'));
  assert.equal(body.split('<tr').length - 1, names.length, 'one table row per account, nothing else');
  assert.equal(body.split('data-account-row=').length - 1, names.length);
  assert.ok(!table.includes('plan-header'), 'no plan header row');
  // The usage windows sit in the account's own row: a compact bar and percent, the reset in its title.
  const rowA = accountRow(page, 'row-a');
  assert.match(rowA, /<td data-label="Usage">.*data-window="5h" title="5h: 31% used, resets [^"]+".*role="progressbar".*31%/);
  // Unreported usage is a short muted dash, never a full-width row, with why in its title.
  const unreported = accountRow(page, 'unreported');
  assert.match(unreported, /<td data-label="Usage"><span class="usage-not-reported" data-not-reported="true" title="usage not reported by Claude">—<\/span><\/td>/);
});

test('unit:fleet-why-no-duplication — an idle account\'s and a spent account\'s Why cells hold no role names and no reset time, and a working account\'s Why cell names its live work', () => {
  const names = ['busy', 'idle', 'spent'];
  const fleet = declutterFleet(names, [{ name: 'worker', accounts: names, concurrency: 4 }, { name: 'reviewer', accounts: names, concurrency: 2 }], ['spent'],
    [['worker', 'busy', 'GY-1236'], ['reviewer', 'busy', 'GY-1315']]);
  const page = render(fleet);
  const reset = new Date(spentUntil);
  for (const name of ['idle', 'spent']) {
    const why = whyCell(accountRow(page, name));
    assert.equal(why, '<span class="muted">—</span>', `${name}'s Why cell is empty: ${why}`);
    for (const word of ['worker', 'reviewer', 'ready for', 'until', 'in 3d', reset.toLocaleString(undefined, { month: 'short', day: 'numeric' })]) assert.ok(!why.includes(word), `${name}'s Why repeats "${word}"`);
  }
  // What the other cells already say is still on the row: its roles, and its Back time.
  assert.ok(accountRow(page, 'idle').includes('<td data-label="Roles">worker, reviewer</td>'));
  assert.ok(accountRow(page, 'spent').includes(`<time dateTime="${spentUntil}"`));
  assert.equal(whyCell(accountRow(page, 'busy')), 'worker on GY-1236, reviewer on GY-1315');
});

test('unit:fleet-launch-summary-compact — every role that can launch is one chip on one line naming its next account in its title, and only a role that cannot launch gets a line, with why and when', () => {
  const names = ['launch-a', 'launch-b'];
  const roles = (['worker', 'reviewer', 'producer', 'approver', 'escalation-handler', 'master'] as const).map(name => ({ name, accounts: names, concurrency: name === 'master' ? 1 : 2 }));
  // The master at its concurrency limit: one blocked role.
  const blocked = render(declutterFleet(names, roles, [], [['master', 'launch-a', 'GY-1325']]));
  assert.equal(blocked.split('data-can-launch="no"').length - 1, 1, 'exactly one reason line');
  assert.equal(blocked.split('Cannot launch').length - 1, 1);
  assert.match(blocked, /<li data-role-launch="master" data-can-launch="no">.*master: none can launch — at its concurrency limit \(1 of 1 live\); next: launch-a when one of its sessions ends<\/li>/);
  assert.equal(blocked.split('class="role-chip"').length - 1, 5, 'the other five are chips');
  assert.ok(blocked.includes('<span class="role-chip" data-role-launch="worker" data-can-launch="yes" title="next: launch-a now">Workers</span>'), 'a chip names its next account in its title');
  assert.ok(blocked.includes('</span>: can launch</p>'));
  // No blocked role: one line of chips, and no "Cannot launch" anywhere.
  const clear = render(declutterFleet(names, roles));
  assert.ok(!clear.includes('Cannot launch'), 'no Cannot launch text');
  assert.equal(clear.split('data-can-launch="no"').length - 1, 0);
  assert.equal(clear.split('class="role-launch-ready"').length - 1, 1, 'one line');
  assert.ok(clear.includes('Escalation handlers</span> · ') && clear.includes('</span>: all can launch</p>'), 'every role a chip on the one line');
});

test('unit:fleet-spent-collapsed — accounts read working, then idle, then spent or ineligible, and six spent accounts back on the same day render as one collapsed summary row naming all six', () => {
  const spent = ['claude-x', 'claude-y', 'opencode-x', 'opencode-y', 'pi-x', 'pi-y'];
  const names = ['idle-1', ...spent.slice(0, 3), 'busy-1', ...spent.slice(3), 'idle-2', 'busy-2'];
  const page = render(declutterFleet(names, [{ name: 'worker', accounts: names, concurrency: 8 }], spent, [['worker', 'busy-1', 'GY-1'], ['worker', 'busy-2', 'GY-2']]));
  const order = [...page.matchAll(/data-account-row="([^"]+)" data-status="([^"]+)"/g)].map(match => match[2]);
  assert.deepEqual(order, ['working', 'working', 'idle', 'idle', ...spent.map(() => 'spent')], 'ordered by status');
  assert.equal(page.split('data-spent-summary=').length - 1, 1, 'one summary row');
  const day = new Date(spentUntil).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const summary = page.slice(page.indexOf('data-spent-summary='), page.indexOf('</tr>', page.indexOf('data-spent-summary=')));
  assert.ok(summary.includes(`6 spent until ${day}</span> · ${spent.join(', ')}`), summary);
  assert.ok(summary.includes('aria-expanded="false"'), 'collapsed until clicked');
  // The six rows are still there, one per account, hidden until the summary is opened.
  for (const name of spent) assert.match(accountRow(page, name), /^<tr [^>]*hidden=""/, `${name} is collapsed`);
  for (const name of ['busy-1', 'idle-1']) assert.doesNotMatch(accountRow(page, name), /hidden=""/);
});
