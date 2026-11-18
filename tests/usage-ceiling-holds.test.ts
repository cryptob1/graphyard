import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { observeAccount } from '../src/fleet.js';
import { hostAccountCheck, hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { accountIneligibility, emptyRegistry, fleetView, foldObservations, proposedRuntimes } from '../src/model/registry.js';

// GY-3494: a usage window at its ceiling holds a Claude account until that window's own reset,
// whatever the last live check said, and a failed usage read keeps the last good windows.
const HOST = 'ceiling-host';
const minute = 60_000, hour = 60 * minute;

test('integration:usage-ceiling-holds — a window at the ceiling holds through a passing check and a failed read, until its own reset', async () => {
  const root = await temporaryDirectory('usage-ceiling-holds');
  process.env[hostAccountsVariable] = await temporaryDirectory('host-records', root);
  const start = Date.parse('2026-11-18T12:00:00.000Z'), reset = new Date(start + 3 * hour).toISOString();
  let now = start;
  const homes: Record<string, string> = {};
  for (const name of ['claude-full', 'claude-mid']) {
    homes[name] = await temporaryDirectory(name, root);
    await writeFile(join(homes[name], '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `token-${name}`, refreshToken: 'refresh', expiresAt: start + 100 * hour } }));
  }
  // The stub usage endpoint: each token's weekly utilization, or a 429 once the provider refuses reads.
  const utilization: Record<string, number> = { 'token-claude-full': 100, 'token-claude-mid': 60 };
  let refuse = false;
  const usageEndpoint = (async (_url: string, init: { headers: Record<string, string> }) => {
    if (refuse) return new Response('{"error":"rate_limited"}', { status: 429 });
    const percent = utilization[init.headers.Authorization.replace('Bearer ', '')];
    return new Response(JSON.stringify({ five_hour: { utilization: 0, resets_at: new Date(start + hour).toISOString() }, seven_day: { utilization: percent, resets_at: reset } }), { status: 200 });
  }) as unknown as typeof fetch;
  let smokes = 0;
  const smoke = async () => { smokes++; return { ok: true as const }; };
  const runtime = proposedRuntimes.find(entry => entry.name === 'claude')!;
  let registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [runtime], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: Object.entries(homes).map(([name, home]) => ({ name, runtime: 'claude', model: 'opus', plan: name, credential: { host: HOST, home } })),
    roles: [{ name: 'worker', accounts: ['claude-full', 'claude-mid'], concurrency: 2 }], reason: 'ceiling fixture',
  }, { actor: 'operator', at: new Date(start).toISOString() }).registry;

  const observe = async () => {
    const observations = await Promise.all(registry.accounts.map(async account => ({ account: account.name,
      quota: (await observeAccount(account, runtime, { fetch: usageEndpoint, now: () => now, smoke, cacheMs: 0, opencodeAuth: null, opencodeModels: null }, registry.accounts, 'claude-opus-5')).quota })));
    foldObservations(registry, { host: HOST, observations }, { actor: HOST, at: new Date(now).toISOString() });
    return Object.fromEntries(observations.map(entry => [entry.account, entry.quota]));
  };
  const ineligible = (name: string) => accountIneligibility(registry, registry.accounts.find(account => account.name === name)!, now, HOST);

  // A fresh window at 100% with a passing live check: the account is exhausted until that window's reset.
  const first = await observe();
  assert.ok(smokes >= 1, 'the spent account had its live check');
  assert.equal(first['claude-full'].state, 'exhausted', JSON.stringify(first['claude-full']));
  assert.equal(first['claude-full'].resetsAt, reset);
  assert.equal(first['claude-full'].reason, 'weekly allowance 100% used, back 2026-11-18 15:00 UTC');
  assert.equal(ineligible('claude-full'), 'claude-full quota is exhausted: weekly allowance 100% used, back 2026-11-18 15:00 UTC');
  assert.deepEqual(hostAccountCheck(homes['claude-full'])!.quota.usage.map(entry => [entry.window, entry.percent]), [['5h', 0], ['7d', 100]], 'the live check keeps the windows it was given');
  assert.equal(ineligible('claude-mid'), null, 'an account at 60% stays eligible');
  assert.equal(fleetView(registry, now, HOST).roles.find(role => role.role === 'worker')!.next, 'claude-mid');

  // The provider refuses the next read (cached live check still passing): the last good windows stand.
  refuse = true; now += minute;
  await observe();
  assert.match(ineligible('claude-full') ?? '', /weekly allowance 100% used, back 2026-11-18 15:00 UTC/, 'a 429 leaves the spent account ineligible');
  assert.equal(ineligible('claude-mid'), null, 'a 429 leaves the 60% account eligible');
  // Past the live check's interval, a new passing check still cannot lift the window's hold.
  now += 40 * minute;
  await observe();
  assert.match(ineligible('claude-full') ?? '', /weekly allowance 100% used/);
  assert.equal(ineligible('claude-mid'), null);
  const mid = fleetView(registry, now, HOST).accounts.find(account => account.name === 'claude-mid')!;
  assert.deepEqual(mid.usage.map(entry => [entry.window, entry.percent, entry.lastRead]), [['5h', 0, 'last read 2026-11-18 12:00 UTC'], ['7d', 60, 'last read 2026-11-18 12:00 UTC']], 'the last good windows are said as last read');

  // After the window's own reset the account is eligible again, still with no usage read.
  now = Date.parse(reset) + minute;
  await observe();
  assert.equal(ineligible('claude-full'), null, 'eligible after the window resets');
  assert.equal(ineligible('claude-mid'), null);
  assert.deepEqual(registry.accounts.find(account => account.name === 'claude-mid')!.quota.usage, [], 'windows past their reset are dropped');
});
