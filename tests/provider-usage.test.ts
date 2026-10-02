import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  supportedProviderPlans,
  providerUsageAdapters,
  parseClaudeUsage,
  parseCodexUsage,
  parseZaiUsage,
  notReportedUsage,
  getCachedPlanUsage,
  setCachedPlanUsage,
  clearPlanUsageCache,
  deriveAccountPlan,
  groupAccountsByPlan,
} from '../src/provider-usage.js';
import {
  applyRegistryMutation,
  emptyRegistry,
  fleetView,
  foldObservation,
  accountIneligibility,
  chooseSession,
  type AgentRegistry,
  type FleetSession,
} from '../src/model/registry.js';
import { FleetOverview } from '../web/pages/fleet.js';

const HOST = 'agents-host';
const now = Date.parse('2026-10-02T12:00:00.000Z');
const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const iso = (offset: number) => new Date(now + offset).toISOString();

test('unit:provider-usage-adapters — each supported provider plan has a usage adapter returning its windows or an explicit not reported; covers Claude, Codex, Z.AI and not-reported cases', () => {
  // 1. Supported providers list contains all 6 required plans
  const expectedPlans = ['claude', 'codex', 'zai', 'cursor', 'muse', 'antigravity'];
  assert.deepEqual([...supportedProviderPlans].sort(), [...expectedPlans].sort(), 'supports all 6 provider plans');

  for (const plan of expectedPlans) {
    const adapter = providerUsageAdapters[plan as keyof typeof providerUsageAdapters];
    assert.ok(adapter, `adapter exists for ${plan}`);
    assert.equal(typeof adapter.parse, 'function', `adapter.parse is a function for ${plan}`);
    assert.equal(typeof adapter.getUsage, 'function', `adapter.getUsage is a function for ${plan}`);
  }

  // 2. Claude adapter with recorded provider responses (5h and 7d windows)
  const claudeResponse = {
    account: 'claude-user@example.com',
    usage: {
      fiveHourWindow: { percent: 42, resetsAt: iso(2 * hour) },
      sevenDayWindow: { percent: 78, resetsAt: iso(3 * day) },
    },
  };
  const claudeParsed = parseClaudeUsage(claudeResponse);
  assert.equal(claudeParsed.reported, true);
  assert.equal(claudeParsed.status, 'reported');
  assert.equal(claudeParsed.windows.length, 2);
  const claude5h = claudeParsed.windows.find(w => w.window === '5h');
  const claude7d = claudeParsed.windows.find(w => w.window === '7d');
  assert.ok(claude5h && claude5h.percent === 42 && claude5h.resetsAt === iso(2 * hour), 'Claude 5h window matches');
  assert.ok(claude7d && claude7d.percent === 78 && claude7d.resetsAt === iso(3 * day), 'Claude 7d window matches');
  assert.equal(claudeParsed.resetsAt, iso(3 * day), 'Claude latest reset time is tracked');

  // Claude text representation
  const claudeTextResponse = 'Usage: 5-hour window at 55% (resets 2026-10-02T14:00:00.000Z), weekly window at 80% (resets 2026-10-05T12:00:00.000Z)';
  const claudeTextParsed = parseClaudeUsage(claudeTextResponse);
  assert.equal(claudeTextParsed.reported, true);
  assert.equal(claudeTextParsed.windows.length, 2);

  // 3. Codex/ChatGPT adapter with recorded provider rate-limit responses
  const codexResponse = {
    rate_limits: [
      { window: 'requests', percent: 25, resets_at: iso(hour) },
      { window: 'tokens', percent: 60, resets_at: iso(4 * hour) },
    ],
  };
  const codexParsed = parseCodexUsage(codexResponse);
  assert.equal(codexParsed.reported, true);
  assert.equal(codexParsed.status, 'reported');
  assert.equal(codexParsed.windows.length, 2);
  assert.equal(codexParsed.windows[0].window, 'requests');
  assert.equal(codexParsed.windows[0].percent, 25);
  assert.equal(codexParsed.windows[1].window, 'tokens');
  assert.equal(codexParsed.windows[1].percent, 60);

  // 4. Z.AI adapter with recorded quota limit endpoint response
  const zaiQuotaResponse = {
    code: 200,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 35, nextResetTime: now + 3 * hour },
        { type: 'TIME_LIMIT', unit: 5, percentage: 88, nextResetTime: now + 5 * day },
      ],
    },
  };
  const zaiParsed = parseZaiUsage(zaiQuotaResponse);
  assert.equal(zaiParsed.reported, true);
  assert.equal(zaiParsed.status, 'reported');
  assert.equal(zaiParsed.windows.length, 2);
  const zai5h = zaiParsed.windows.find(w => w.window === '5h');
  const zai7d = zaiParsed.windows.find(w => w.window === '7d');
  assert.ok(zai5h && zai5h.percent === 35, 'Z.AI 5h tokens limit parsed');
  assert.ok(zai7d && zai7d.percent === 88, 'Z.AI 7d time limit parsed');

  // Z.AI 429 limit notice response
  const zai429Response = {
    code: 1310,
    message: 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-03 08:27:35',
  };
  const zai429Parsed = parseZaiUsage(zai429Response);
  assert.equal(zai429Parsed.reported, true);
  assert.equal(zai429Parsed.windows.length, 1);
  assert.equal(zai429Parsed.windows[0].percent, 100);
  assert.equal(zai429Parsed.windows[0].window, '7d');
  assert.ok(zai429Parsed.resetsAt?.includes('2026-10-03'), 'Z.AI reset time extracted from 429 message');

  // 5. Not-reported cases: Cursor, Muse, Antigravity
  for (const notReportedKind of ['cursor', 'muse', 'antigravity'] as const) {
    const adapter = providerUsageAdapters[notReportedKind];
    const res = adapter.getUsage();
    assert.equal(res.reported, false, `${notReportedKind} reported flag is false`);
    assert.equal(res.status, 'not-reported', `${notReportedKind} status is not-reported`);
    assert.equal(res.windows.length, 0);
    assert.match(res.reason ?? '', new RegExp(`usage not reported by ${adapter.name}`, 'i'), `${notReportedKind} has explicit reason`);
  }

  // 6. Plan usage cache behavior
  clearPlanUsageCache();
  const testPlan = 'test-plan-cache';
  assert.equal(getCachedPlanUsage(testPlan, now), null, 'initial cache is empty');
  setCachedPlanUsage(testPlan, claudeParsed, now);
  const cached = getCachedPlanUsage(testPlan, now + 10_000);
  assert.ok(cached, 'cached entry found within maxAge');
  assert.equal(cached?.windows.length, 2);
  // Cache expires after maxAge
  assert.equal(getCachedPlanUsage(testPlan, now + 70_000, 60_000), null, 'cache expires after TTL');
});

test('unit:accounts-page-groups-by-plan — accounts that draw on one plan are grouped under it on the Accounts page with a bar per window, and dispatch failover reads the same plan-level usage so accounts sharing a plan share one budget', () => {
  // Setup registry with multiple accounts sharing and not sharing plans:
  // - claude-1 (Claude plan)
  // - codex-1 (Codex plan)
  // - pi-a and opencode-a (sharing Z.AI plan 'a' via naming and key)
  // - cursor-1 (Cursor plan, not reported)
  // - muse-1 (Muse plan, not reported)
  // - agy-1 (Antigravity plan, not reported)
  const initial = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [
      { name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } },
      { name: 'codex', launch: { kind: 'codex', args: [], environment: {}, homeVariable: 'CODEX_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } },
      { name: 'pi', launch: { kind: 'pi', args: [], environment: {}, homeVariable: 'PI_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } },
      { name: 'opencode', launch: { kind: 'opencode', args: [], environment: {}, homeVariable: 'OPENCODE_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } },
      { name: 'cursor', launch: { kind: 'cursor', args: [], environment: {}, homeVariable: 'CURSOR_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } },
      { name: 'muse', launch: { kind: 'muse', args: [], environment: {}, homeVariable: 'MUSE_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } },
      { name: 'antigravity', launch: { kind: 'antigravity', args: [], environment: {}, homeVariable: 'AGY_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } },
    ],
    models: [
      { name: 'opus', id: 'claude-opus-5', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'frontier', contextTokens: null } },
      { name: 'o3', id: 'o3-mini', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } },
      { name: 'glm-flash', id: 'zai/glm-5.3-flash', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'fast', contextTokens: null } },
    ],
    accounts: [
      { name: 'claude-1', runtime: 'claude', model: 'opus', credential: { host: HOST, home: '/agents/claude-1' }, enabled: true },
      { name: 'codex-1', runtime: 'codex', model: 'o3', credential: { host: HOST, home: '/agents/codex-1' }, enabled: true },
      { name: 'pi-a', runtime: 'pi', model: 'glm-flash', credential: { host: HOST, home: '/agents/pi-a', key: { file: 'zai.key', variable: 'ZAI_API_KEY' } }, enabled: true },
      { name: 'opencode-a', runtime: 'opencode', model: 'glm-flash', credential: { host: HOST, home: '/agents/opencode-a', key: { file: 'zai.key', variable: 'ZAI_API_KEY' } }, enabled: true },
      { name: 'cursor-1', runtime: 'cursor', model: 'opus', credential: { host: HOST, home: '/agents/cursor-1' }, enabled: true },
      { name: 'muse-1', runtime: 'muse', model: 'opus', credential: { host: HOST, home: '/agents/muse-1' }, enabled: true },
      { name: 'agy-1', runtime: 'antigravity', model: 'opus', credential: { host: HOST, home: '/agents/agy-1' }, enabled: true },
    ],
    roles: [
      { name: 'worker', accounts: ['pi-a', 'opencode-a', 'claude-1'], concurrency: 2 },
    ],
    reason: 'test setup',
  }, { actor: 'operator', at: iso(-hour) }).registry;

  // Add observations for Claude and Z.AI
  const claudeAccount = initial.accounts.find(a => a.name === 'claude-1')!;
  foldObservation(claudeAccount, {
    loggedIn: true,
    state: 'available',
    usage: [
      { window: '5h', percent: 40, resetsAt: iso(2 * hour) },
      { window: '7d', percent: 75, resetsAt: iso(3 * day) },
    ],
    resetsAt: iso(3 * day),
    reason: null,
  }, { actor: 'coordinator', at: iso(-minute) });

  const piAccount = initial.accounts.find(a => a.name === 'pi-a')!;
  foldObservation(piAccount, {
    loggedIn: true,
    state: 'available',
    usage: [
      { window: '5h', percent: 65, resetsAt: iso(hour) },
    ],
    resetsAt: iso(hour),
    reason: null,
  }, { actor: 'coordinator', at: iso(-minute) });

  // 1. Test plan derivation and grouping
  const planPi = deriveAccountPlan(piAccount, initial.accounts);
  const opencodeAccount = initial.accounts.find(a => a.name === 'opencode-a')!;
  const planOpencode = deriveAccountPlan(opencodeAccount, initial.accounts);
  assert.equal(planPi.planId, planOpencode.planId, 'pi-a and opencode-a derive the same planId');
  assert.equal(planPi.planKind, 'zai');

  // 2. Render FleetOverview and verify DOM structure
  const view = fleetView(initial, now);
  assert.ok(view.plans && view.plans.length > 0, 'fleetView provides plans');

  const page = renderToStaticMarkup(createElement(FleetOverview, { fleet: view, now }));

  // Verify accounts table exists and contains all accounts
  assert.equal(page.split('aria-label="Accounts at a glance"').length - 1, 1, 'one accounts table');
  for (const acc of initial.accounts) {
    assert.ok(page.includes(`data-account-row="${acc.name}"`), `row rendered for ${acc.name}`);
  }

  // Verify grouping: pi-a and opencode-a appear in the same plan group
  const zaiPlan = view.plans.find(p => p.kind === 'zai');
  assert.ok(zaiPlan, 'zai plan found in view.plans');
  assert.ok(zaiPlan.accounts.includes('pi-a') && zaiPlan.accounts.includes('opencode-a'), 'zai plan groups pi-a and opencode-a together');
  assert.ok(page.includes(`data-plan-group="${zaiPlan.name}"`), `table has tbody for ${zaiPlan.name}`);

  // Verify usage bars rendered for reported plans (Claude, Z.AI)
  assert.ok(page.includes('data-window="5h"'), '5h window bar rendered');
  assert.ok(page.includes('role="progressbar"'), 'progress bar rendered');
  assert.ok(page.includes('40% used'), 'Claude 40% used displayed');

  // Verify explicit "usage not reported by <provider>" rendered for Cursor, Muse, Antigravity
  assert.match(page, /usage not reported by Cursor/i, 'Cursor shows not reported notice');
  assert.match(page, /usage not reported by Muse/i, 'Muse shows not reported notice');
  assert.match(page, /usage not reported by Antigravity/i, 'Antigravity shows not reported notice');

  // 3. Test dispatch failover and plan-level budget sharing:
  // When pi-a quota becomes exhausted, opencode-a sharing that plan must ALSO be treated as ineligible / exhausted!
  foldObservation(piAccount, {
    loggedIn: true,
    state: 'exhausted',
    usage: [{ window: '5h', percent: 100, resetsAt: iso(hour) }],
    resetsAt: iso(hour),
    reason: '5h token limit reached',
  }, { actor: 'coordinator', at: iso(-minute) });

  const piIneligibility = accountIneligibility(initial, piAccount, now, HOST);
  assert.match(piIneligibility ?? '', /quota is exhausted/i, 'pi-a is marked exhausted');

  const opencodeIneligibility = accountIneligibility(initial, opencodeAccount, now, HOST);
  assert.ok(opencodeIneligibility, 'opencode-a is ineligible because pi-a on the same plan is exhausted');
  assert.match(opencodeIneligibility ?? '', /quota is exhausted on plan/i, 'opencode-a indicates shared plan exhaustion');

  // Verify chooseSession skips opencode-a when selecting for worker role and falls over to claude-1
  const choice = chooseSession(initial, { role: 'worker', host: HOST }, now);
  assert.equal(choice.account?.name, 'claude-1', 'fails over to claude-1 when both pi-a and opencode-a are exhausted by shared plan');
  const skippedOpencode = choice.skipped.find(s => s.account === 'opencode-a');
  assert.ok(skippedOpencode, 'opencode-a was skipped');
  assert.match(skippedOpencode.reason, /plan/i, 'skip reason mentions plan exhaustion');
});
