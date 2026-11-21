import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { observeAccount, checkAccountLive } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, fleetView, foldObservation, proposedRuntimes, type AgentRegistry, type FleetAccount, type QuotaObservation } from '../src/model/registry.js';
import { requestLimitNoticeCheck } from '../src/model/account-quota.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';

// GY-3555: account availability has one authority — a live minimal request made with the
// account's own login. Each fixture below is the recorded output of a false hold this week.
const now = Date.parse('2026-11-20T05:20:00Z');
const iso = (at: number) => new Date(at).toISOString();
// GY-3457: a worker's tool printed Z.ai's limit text from a test fixture.
const zaiFixtureText = 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-20 12:49:15';
// GY-3554: the evidence stored for claude-a's hold, a fragment of a Claude JSON result, while claude-a answered a live request.
const claudeFragment = 't":0,"concurrency_limit":0,"budget":0},"by_type":{';
// GY-3554: claude-b's own live answer; its real reset is 2026-11-22T05:00Z, not Dec 4.
const claudeWeekly = "You've hit your weekly limit, resets Nov 21, 9pm (America/Los_Angeles)";
const claudeReset = '2026-11-22T05:00:00.000Z';
// The usage endpoints answered as they did this week: Claude's 7-day window spent until Dec 4, and
// Z.ai's endpoint reading one key for all six accounts ("one shared plan"), whichever key asked.
const usageFetch = (async (url: string) => String(url).includes('anthropic')
  ? new Response(JSON.stringify({ five_hour: { utilization: 3, resets_at: iso(now + 3_600_000) }, seven_day: { utilization: 100, resets_at: '2026-12-04T05:38:19Z' } }))
  : new Response(JSON.stringify({ code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 100, nextResetTime: Date.parse('2026-11-21T03:54:09Z') }] } }))) as unknown as typeof fetch;

const kinds = ['claude', 'codex', 'opencode', 'pi', 'agy'] as const;
async function fleet(): Promise<AgentRegistry> {
  process.env[hostAccountsVariable] = await temporaryDirectory('one-authority-host');
  const runtimes = kinds.map(kind => {
    const runtime = structuredClone(proposedRuntimes.find(entry => entry.name === kind) ?? { ...proposedRuntimes.find(entry => entry.name === 'pi')!, name: kind });
    runtime.launch.kind = kind;
    return runtime;
  });
  const accounts = [];
  for (const [name, kind] of [['claude-a', 'claude'], ['claude-b', 'claude'], ['codex-a', 'codex'], ['opencode-a', 'opencode'], ['pi-a', 'pi'], ['agy-a', 'agy']] as const) {
    const home = await temporaryDirectory(`one-authority-${name}`);
    await mkdir(join(home, 'opencode'), { recursive: true });
    await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `token-${name}`, refreshToken: 'r', expiresAt: now + 86_400_000 } }));
    await writeFile(join(home, 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: `key-${name}` } }));
    await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: `key-${name}`, zai: { key: `key-${name}` } }));
    accounts.push({ name, runtime: kind, model: 'fixture', credential: { host: 'host', home } });
  }
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes, models: [{ name: 'fixture', id: null }], accounts,
    roles: [{ name: 'worker', accounts: accounts.map(account => account.name), concurrency: 1 }], reason: 'GY-3555 fixture',
  }, { actor: 'operator', at: iso(now - 86_400_000) }).registry;
}
const runtimeOf = (registry: AgentRegistry, account: FleetAccount) => registry.runtimes.find(runtime => runtime.name === account.runtime)!;
/** One host check of `name` as the executor runs it, folded into the registry as the control plane does. */
async function check(registry: AgentRegistry, name: string, live: { ok: boolean; error?: string }, at = now) {
  const account = registry.accounts.find(entry => entry.name === name)!;
  const calls: string[] = [];
  const { quota } = await observeAccount(account, runtimeOf(registry, account), { fetch: usageFetch, cacheMs: 0, opencodeAuth: null, opencodeModels: null, now: () => at,
    smoke: async target => { calls.push(target.home!); return { ok: live.ok, error: live.ok ? null : live.error ?? null }; } }, registry.accounts);
  foldObservation(account, quota, { actor: 'host', at: iso(at) });
  assert.ok(calls.every(home => home === account.credential.home), `${name}: the live request ran on its own login`);
  return { quota: account.quota, calls: calls.length };
}

test('integration:account-availability-one-authority — usage readings, notices and worker text never hold an account whose own live request passes', async () => {
  const registry = await fleet();
  for (const account of registry.accounts) {
    // A worker on the account printed Z.ai's limit text: it asks for a live check and holds nothing.
    requestLimitNoticeCheck(registry, { role: 'worker', work: 'GY-9555', principal: null, account: account.name, reason: zaiFixtureText, resetsAt: null }, { actor: 'host', at: iso(now - 1000) });
    assert.notEqual(account.quota.state, 'exhausted', `${account.name}: a notice schedules a check, never a hold`);
    const { quota, calls } = await check(registry, account.name, { ok: true });
    assert.equal(calls, 1, `${account.name}: the notice ran one live request`);
    assert.equal(quota.state, 'available', `${account.name}: its own live request passed, whatever the usage endpoint or another key read`);
    assert.equal(quota.resetsAt, null);
  }
  assert.ok(fleetView(registry, now).accounts.every(account => account.eligible), 'every account takes work');
});

test('integration:account-availability-one-authority — a passive reading of exhausted, for every runtime, is never a hold', () => {
  for (const kind of kinds) {
    const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
      runtimes: [{ ...structuredClone(proposedRuntimes.find(entry => entry.name === kind) ?? proposedRuntimes.find(entry => entry.name === 'pi')!), name: kind }],
      models: [{ name: 'fixture', id: null }], accounts: [{ name: `${kind}-a`, runtime: kind, model: 'fixture', credential: { host: 'host', home: '/tmp/none' } }],
      roles: [{ name: 'worker', accounts: [`${kind}-a`], concurrency: 1 }], reason: 'fixture',
    }, { actor: 'operator', at: iso(now - 60_000) }).registry;
    const account = registry.accounts[0];
    // The wrong-key probe of GY-3516 and the shared-plan reading: a usage window at 100% with a reset, read by a probe, not a request.
    const reading: QuotaObservation = { loggedIn: true, state: 'exhausted', usage: [{ window: '7d', percent: 100, resetsAt: '2026-11-21T03:54:09.000Z' }], resetsAt: '2026-11-21T03:54:09.000Z', reason: `${account.name} quota is exhausted (7d window at 100%)`, session: 'named' };
    foldObservation(account, reading, { actor: 'host', at: iso(now) });
    assert.notEqual(account.quota.state, 'exhausted', `${kind}: only a live request sets exhausted`);
    assert.ok(fleetView(registry, now).accounts[0].eligible, `${kind}: the account still takes work`);
  }
});

test('integration:account-availability-one-authority — a refused live request holds until the reset the provider states, in its words; any other failure is broken', async () => {
  const registry = await fleet();
  // claude-b: its own answer names Nov 21 9pm Pacific; the usage endpoint's Dec 4 is not the reset.
  let { quota } = await check(registry, 'claude-b', { ok: false, error: claudeWeekly });
  assert.equal(quota.state, 'exhausted');
  assert.equal(quota.resetsAt, claudeReset, 'held until the reset the provider stated');
  assert.equal(quota.reason, claudeWeekly, 'the evidence is the provider\'s own message');
  // claude-a: the stored evidence was a JSON fragment; a failure that is no limit notice is broken, never a dated hold.
  ({ quota } = await check(registry, 'claude-a', { ok: false, error: claudeFragment }));
  assert.equal(quota.state, 'broken');
  assert.equal(quota.resetsAt, null, 'no reset is read from a fragment');
  const view = fleetView(registry, now);
  assert.match(view.accounts.find(account => account.name === 'claude-a')!.ineligible ?? '', /broken/);
  assert.equal(view.accounts.find(account => account.name === 'claude-b')!.quota, 'exhausted');
  assert.equal(view.accounts.find(account => account.name === 'claude-b')!.checkedLive, iso(now), 'the view says when it was last checked live');
});

test('integration:account-availability-one-authority — the live request\'s words are the provider\'s message, not the tail of Claude\'s JSON', async () => {
  const home = await temporaryDirectory('one-authority-claude-json'), command = join(home, 'claude.cjs');
  const usage = { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 0 }, limits: { by_model: { opus: { spent: 0, concurrency_limit: 0, budget: 0 } }, by_type: { interactive: { spent: 0 } } }, padding: 'x'.repeat(600) };
  await writeFile(command, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: claudeWeekly, usage }))});\nprocess.exit(1);\n`);
  await chmod(command, 0o700);
  const registry = await fleet(), account = registry.accounts.find(entry => entry.name === 'claude-b')!;
  const quota = await checkAccountLive(account, runtimeOf(registry, account), { now: () => now, smoke: target => smokeRegistryAccount(target, { command, timeoutMs: 10_000 }) });
  assert.equal(quota.reason, claudeWeekly);
  assert.equal(quota.state, 'exhausted');
  assert.equal(quota.resetsAt, claudeReset);
});

test('integration:account-availability-one-authority — a held account is checked again within the hour and at its reset, and a passing request frees it', async () => {
  const registry = await fleet();
  let result = await check(registry, 'claude-b', { ok: false, error: claudeWeekly });
  assert.equal(result.quota.state, 'exhausted');
  result = await check(registry, 'claude-b', { ok: true }, now + 10 * 60_000);
  assert.equal(result.calls, 0, 'not checked again before it is due');
  assert.equal(result.quota.state, 'exhausted');
  result = await check(registry, 'claude-b', { ok: true }, now + 60 * 60_000);
  assert.equal(result.calls, 1, 'checked again within the hour, though its reset is two days away');
  assert.equal(result.quota.state, 'available', 'a passing request frees it at once');
  // A reset sooner than the hour is checked at that reset.
  const soon = iso(now + 2 * 3_600_000 + 5 * 60_000);
  result = await check(registry, 'opencode-a', { ok: false, error: `{"type":"error","error":{"type":"provider.quota","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at ${new Date(Date.parse(soon) + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')}"}}` }, now + 2 * 3_600_000);
  assert.equal(result.quota.resetsAt, soon, 'Z.ai names Beijing time; the reset is the provider\'s');
  result = await check(registry, 'opencode-a', { ok: true }, Date.parse(soon));
  assert.equal(result.calls, 1, 'checked at its stated reset');
  assert.equal(result.quota.state, 'available');
});

test('integration:account-availability-one-authority — a master\'s mark is replaced only by a newer live check of the same account', async () => {
  const registry = await fleet();
  const mark = (state: 'available' | 'exhausted', at: number) => {
    const next = applyRegistryMutation(registry, 'account.quota', { name: 'claude-a', quota: { state }, reason: 'master correction' }, { actor: 'master', at: iso(at) }).registry;
    registry.accounts = next.accounts;
  };
  const account = () => registry.accounts.find(entry => entry.name === 'claude-a')!;
  mark('available', now);
  // A live result taken before the mark, and a passive reading after it, do not replace it.
  foldObservation(account(), { loggedIn: true, state: 'exhausted', usage: [], resetsAt: claudeReset, reason: claudeWeekly, since: iso(now - 60_000), session: 'named' }, { actor: 'host', at: iso(now + 1000) });
  assert.equal(account().quota.state, 'available');
  assert.equal(account().quota.source, 'operator');
  foldObservation(account(), { loggedIn: true, state: 'unknown', usage: [], resetsAt: null, reason: 'passive reading' }, { actor: 'host', at: iso(now + 2000) });
  assert.equal(account().quota.source, 'operator', 'a reading that made no request never replaces the mark');
  // A newer live check does.
  const { quota } = await check(registry, 'claude-a', { ok: false, error: claudeWeekly }, now + 5000);
  assert.equal(quota.state, 'exhausted');
  assert.equal(quota.source, 'probe');
  mark('exhausted', now + 10_000);
  assert.equal((await check(registry, 'claude-a', { ok: true }, now + 20_000)).quota.state, 'available', 'a newer passing check replaces an exhausted mark');
});
