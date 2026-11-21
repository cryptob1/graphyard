import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { parseZaiUsage } from '../src/model/provider-usage.js';
import { observeAccount } from '../src/fleet.js';
import { runtimeResetTime } from '../src/master/runtime-prompt.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, foldObservation } from '../src/model/registry.js';

// GY-3495: each Z.AI account reads its own key's allowance, with the provider's windows and its own reset time.
const fiveHourReset = Date.parse('2030-01-01T03:00:00Z'), weeklyReset = Date.parse('2030-01-05T00:00:00Z'), monthReset = Date.parse('2030-01-20T00:00:00Z');

test('integration:zai-usage-read — windows are named by the provider\'s type and unit, and the monthly TIME_LIMIT is no launch window', () => {
  // opencode-a's live shape.
  const live = parseZaiUsage({ code: 200, data: { limits: [
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 1, nextResetTime: monthReset },
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: fiveHourReset },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 96, nextResetTime: weeklyReset },
  ] } });
  assert.deepEqual(live.windows, [
    { window: '5h', percent: 1, resetsAt: new Date(fiveHourReset).toISOString() },
    { window: '7d', percent: 96, resetsAt: new Date(weeklyReset).toISOString() },
  ]);
  const credit = parseZaiUsage({ data: { limits: [{ type: 'CREDIT_LIMIT', unit: 6, percentage: 100, nextResetTime: weeklyReset }, { type: 'CREDIT_LIMIT', unit: 3, percentage: 4, nextResetTime: fiveHourReset }] } });
  assert.deepEqual(credit.windows.map(window => [window.window, window.percent]), [['7d', 100], ['5h', 4]]);
});

test('integration:zai-usage-read — a refusal\'s zoneless reset is Beijing time whatever the host\'s zone; the live refusal\'s own reset holds the account (GY-3555)', async () => {
  const notice = 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-20 12:49:15';
  const now = Date.parse('2026-11-18T00:00:00Z');
  for (const runtime of ['opencode', 'pi']) assert.equal(runtimeResetTime(notice, runtime, now), '2026-11-20T04:49:15.000Z', runtime);
  assert.equal(parseZaiUsage({ code: 1310, message: notice }).resetsAt, '2026-11-20T04:49:15.000Z');

  // A live request refused with the text, while the usage endpoint answered another reset: the live request decides (GY-3555).
  const home = await temporaryDirectory('zai-endpoint-reset');
  await mkdir(join(home, 'opencode'), { recursive: true });
  await writeFile(join(home, 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { key: 'spent-key' } }));
  const endpointReset = '2026-11-21T00:00:00.000Z';
  const probe = (async () => new Response(JSON.stringify({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, percentage: 100, nextResetTime: Date.parse(endpointReset) }] } }))) as unknown as typeof fetch;
  const registry = zaiRegistry([{ name: 'opencode-r', runtime: 'opencode', home }]);
  const account = registry.accounts[0];
  account.quota = { ...account.quota, state: 'exhausted', session: 'named', resetsAt: '2026-11-19T00:00:00.000Z', reason: notice };
  const { quota } = await observeAccount(account, registry.runtimes[0], { fetch: probe, cacheMs: 0, opencodeAuth: null, opencodeModels: null, now: () => now,
    smoke: async () => ({ ok: false, error: notice }) }, registry.accounts, 'zai/glm-5.1');
  assert.equal(quota.state, 'exhausted');
  assert.equal(quota.resetsAt, '2026-11-20T04:49:15.000Z', 'the reset the refusal states, in Beijing time');
  assert.notEqual(quota.resetsAt, endpointReset);
});

test('integration:zai-usage-read — a key answering no limits stays unknown after an exhausted account, and never inherits its windows', async () => {
  const opencodeHome = await temporaryDirectory('zai-exhausted'), piHome = await temporaryDirectory('zai-empty');
  await mkdir(join(opencodeHome, 'opencode'), { recursive: true });
  await writeFile(join(opencodeHome, 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { key: 'spent-key' } }));
  await writeFile(join(piHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'empty-key' } }));
  const probe = (async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ code: 200, data: {
    limits: (init?.headers as Record<string, string>).Authorization === 'Bearer spent-key' ? [{ type: 'TOKENS_LIMIT', unit: 6, percentage: 100, nextResetTime: weeklyReset }] : [] } }))) as unknown as typeof fetch;
  const registry = zaiRegistry([{ name: 'opencode-a', runtime: 'opencode', home: opencodeHome }, { name: 'pi-a', runtime: 'pi', home: piHome }]);
  const now = Date.parse('2030-01-01T00:00:00Z'), at = new Date(now).toISOString();
  const [opencode, pi] = registry.accounts;
  pi.smoke = { result: 'pass', at, reason: null } as never;
  for (const account of [opencode, pi]) {
    const runtime = registry.runtimes.find(entry => entry.name === account.runtime)!;
    const { quota } = await observeAccount(account, runtime, { fetch: probe, cacheMs: 0, opencodeAuth: null, opencodeModels: null, now: () => now, smoke: async () => ({ ok: true, error: '' }) }, registry.accounts, 'zai/glm-5.1');
    foldObservation(account, quota, { actor: 'coordinator', at });
  }
  assert.deepEqual(opencode.quota.usage.map(window => window.percent), [100], 'the spent key reads its own window');
  assert.equal(opencode.quota.state, 'available', 'its own live request passed (GY-3555: a usage reading never holds)');
  assert.equal(pi.quota.state, 'unknown');
  assert.deepEqual(pi.quota.usage, []);
  assert.equal(pi.quota.reason, 'this key reports no allowance');
});

function zaiRegistry(accounts: { name: string; runtime: string; home: string }[]) {
  const launch = (kind: string) => ({ kind, args: [], environment: {}, homeVariable: 'HOME_DIR', modelFlag: '--model', login: null, loginFile: null });
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [{ name: 'opencode', launch: launch('opencode') }, { name: 'pi', launch: launch('pi') }],
    models: [{ name: 'glm', id: 'zai/glm-5.1', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'fast', contextTokens: null } }],
    accounts: accounts.map(account => ({ name: account.name, runtime: account.runtime, model: 'glm', credential: { host: 'host', home: account.home }, enabled: true })),
    roles: [{ name: 'worker', accounts: accounts.map(account => account.name), concurrency: 2 }],
    reason: 'test setup',
  }, { actor: 'operator', at: '2026-01-01T00:00:00Z' }).registry;
}
