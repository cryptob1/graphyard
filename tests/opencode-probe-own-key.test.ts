import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { observeAccount } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, fleetView, foldObservation, type AgentRegistry } from '../src/model/registry.js';
import { localTime } from '../web/agent-status.js';
import { FleetOverview } from '../web/pages/fleet.js';

// GY-3516: three OpenCode accounts, three keys. The live `opencode run` check was answered by a
// shared OpenCode service with whichever login it held, so each account read another's refusal.
// The probe's own-key reading decides, and records which key it used.
const now = Date.parse('2026-11-19T00:18:58Z');
const resets = { a: '2026-11-21T03:54:09.000Z', b: '2026-11-25T00:00:00.000Z', c: '2026-11-20T12:49:15.000Z' };
const used: Record<string, number> = { a: 100, b: 10, c: 10 };
// What the shared service answered for each account's `opencode run`, as the incident recorded it.
const beijing = (iso: string) => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
const refusal = (owner: 'a' | 'c') => `{"type":"error","error":{"type":"provider.quota","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at ${beijing(resets[owner])}"}}`;
const served: Record<string, string> = { a: refusal('c'), b: refusal('a'), c: refusal('a') };
const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 12);
const zai = (async (_url: string, init?: RequestInit) => {
  const key = (init?.headers as Record<string, string>).Authorization.replace('Bearer ', '');
  const owner = key.slice(-1) as 'a' | 'b' | 'c';
  return new Response(JSON.stringify({ code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: used[owner], nextResetTime: Date.parse(resets[owner]) }] } }));
}) as unknown as typeof fetch;

async function fleet() {
  process.env[hostAccountsVariable] = await temporaryDirectory('opencode-own-key-host');
  const homes: Record<string, string> = {};
  for (const name of ['a', 'b', 'c']) {
    homes[name] = await temporaryDirectory(`opencode-own-key-${name}`);
    await mkdir(join(homes[name], 'opencode'), { recursive: true });
    await writeFile(join(homes[name], 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: `secret-key-${name}` } }));
  }
  const launch = { kind: 'opencode', args: [], environment: {}, homeVariable: 'XDG_DATA_HOME', modelFlag: '--model', login: null, loginFile: null };
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [{ name: 'opencode', launch }],
    models: [{ name: 'glm', id: 'zai-coding-plan/glm-5.1', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'fast', contextTokens: null } }],
    accounts: ['a', 'b', 'c'].map(name => ({ name: `opencode-${name}`, runtime: 'opencode', model: 'glm', credential: { host: 'host', home: homes[name] } })),
    roles: [{ name: 'worker', accounts: ['opencode-a', 'opencode-b', 'opencode-c'], concurrency: 1 }],
    reason: 'GY-3516 fixture',
  }, { actor: 'operator', at: '2026-11-18T00:00:00Z' }).registry;
  // Each account's session printed a limit notice, which asks the host for a live check of it.
  for (const account of registry.accounts) account.quota = { ...account.quota, state: 'exhausted', session: 'guessed', resetsAt: new Date(now + 1_800_000).toISOString(), reason: 'a session reported a limit' };
  return registry;
}
async function probe(registry: AgentRegistry, name: string, when = now) {
  const account = registry.accounts.find(entry => entry.name === name)!;
  const { quota } = await observeAccount(account, registry.runtimes[0], { fetch: zai, cacheMs: 0, opencodeAuth: null, opencodeModels: null, now: () => when,
    smoke: async () => ({ ok: false, error: served[name.slice(-1)] }) }, registry.accounts, 'zai-coding-plan/glm-5.1');
  foldObservation(account, quota, { actor: 'coordinator', at: new Date(when).toISOString() });
  return account.quota;
}

test('integration:opencode-probe-own-key — three keys, one probe each: only the over-limit account is exhausted, each with its own reset, and the probe names the key it used', async () => {
  const registry = await fleet();
  for (const name of ['a', 'b', 'c']) {
    const quota = await probe(registry, `opencode-${name}`);
    assert.equal(quota.key, fingerprint(`secret-key-${name}`), `opencode-${name}'s probe used its own key`);
    assert.ok(!JSON.stringify(quota).includes('secret-key'), 'the key itself is never recorded');
    if (used[name] >= 95) {
      assert.equal(quota.state, 'exhausted', `opencode-${name} is over its limit`);
      assert.equal(quota.resetsAt, resets[name as 'a' | 'c'], `opencode-${name} holds until its own reset`);
    } else {
      assert.equal(quota.state, 'available', `opencode-${name} is usable by its own key, whatever another login answered`);
      assert.equal(quota.resetsAt, null);
      assert.match(quota.fault ?? '', /another account/, 'the mismatched live answer is recorded as a fault');
    }
  }
});

test('integration:opencode-probe-own-key — a master\'s available mark holds until the probe reads that same account\'s key differently', async () => {
  let registry = await fleet();
  await probe(registry, 'opencode-b');
  registry = applyRegistryMutation(registry, 'account.quota', { name: 'opencode-b', quota: { state: 'available' }, reason: 'its own key answers' }, { actor: 'master', at: new Date(now + 60_000).toISOString() }).registry;
  let quota = await probe(registry, 'opencode-b', now + 120_000);
  assert.equal(quota.state, 'available', 'another login\'s refusal does not overwrite the mark');
  assert.equal(quota.key, fingerprint('secret-key-b'));
  used.b = 100;
  try {
    quota = await probe(registry, 'opencode-b', now + 180_000);
    assert.equal(quota.state, 'exhausted', 'its own key now reads spent');
    assert.equal(quota.resetsAt, resets.b);
    assert.equal(quota.key, fingerprint('secret-key-b'));
  } finally { used.b = 10; }
});

test('e2e:opencode-probe-own-key — the Agents page names a spent account\'s own reset in one line and shows a probe that answered with another account\'s key as a fault', async () => {
  const registry = await fleet();
  for (const name of ['a', 'b', 'c']) await probe(registry, `opencode-${name}`);
  const view = fleetView(registry, now);
  const page = renderToStaticMarkup(createElement(FleetOverview, { fleet: view, now }));
  const row = (name: string) => { const start = page.indexOf(`data-account-row="${name}"`); assert.ok(start >= 0, name); return page.slice(start, page.indexOf('</tr>', start)); };
  assert.match(row('opencode-a'), /data-status="spent"/);
  assert.ok(row('opencode-a').includes(localTime(resets.a)), 'opencode-a is back at its own reset');
  assert.ok(!row('opencode-a').includes(localTime(resets.c)), 'never at another account\'s');
  for (const name of ['opencode-b', 'opencode-c']) {
    const usable = row(name);
    assert.doesNotMatch(usable, /data-status="spent"/, name);
    assert.match(usable, /data-fault/, 'the mismatch is shown on the account, not hidden');
    assert.match(usable, /Live check answered with another account&#x27;s limit/);
  }
});
