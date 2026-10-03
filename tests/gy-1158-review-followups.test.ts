import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { deriveAccountPlan, detectPlanKind } from '../src/provider-usage.js';
import { checkAgentEnvironment } from '../src/master/environments.js';
import { observeAccount } from '../src/fleet.js';
import {
  accountIneligibility,
} from '../src/model/registry-sessions.js';
import {
  emptyRegistry,
  applyRegistryMutation,
  foldObservation,
  accountSchema,
  type AgentRegistry,
  type FleetAccount,
} from '../src/model/registry.js';

const HOST = 'test-host';
const now = Date.parse('2026-10-03T12:00:00.000Z');
const minute = 60_000, hour = 60 * minute;
const iso = (offset: number) => new Date(now + offset).toISOString();

test('unit:gy-1158-finding-1 — require credential evidence before declaring plans shared by suffix', () => {
  // opencode-a has Anthropic model/credentials, pi-a has Z.AI credentials
  const opencodeAcc: any = {
    name: 'opencode-a',
    runtime: 'opencode',
    model: 'claude-3-5-sonnet',
    credential: { host: HOST, home: '/home/opencode-a', key: { file: 'anthropic.key', variable: 'ANTHROPIC_API_KEY' } },
  };
  const piAcc: any = {
    name: 'pi-a',
    runtime: 'pi',
    model: 'glm-flash',
    credential: { host: HOST, home: '/home/pi-a', key: { file: 'zai.key', variable: 'ZAI_API_KEY' } },
  };
  const allAccounts = [opencodeAcc, piAcc];

  const opencodePlan = deriveAccountPlan(opencodeAcc, allAccounts);
  const piPlan = deriveAccountPlan(piAcc, allAccounts);

  assert.notEqual(opencodePlan.planId, piPlan.planId, 'opencode-a and pi-a do not share a plan without common Z.AI credentials');
  assert.equal(opencodePlan.planKind, 'claude', 'opencode-a with claude model detects claude plan kind');
  assert.equal(piPlan.planKind, 'zai', 'pi-a with Z.AI credential detects zai plan kind');

  // When both accounts DO have verified Z.AI credential evidence, they share the plan
  const opencodeZaiAcc: any = {
    name: 'opencode-a',
    runtime: 'opencode',
    model: 'glm-flash',
    credential: { host: HOST, home: '/home/opencode-a', key: { file: 'zai.key', variable: 'ZAI_API_KEY' } },
  };
  const sharedPlanOpencode = deriveAccountPlan(opencodeZaiAcc, [opencodeZaiAcc, piAcc]);
  const sharedPlanPi = deriveAccountPlan(piAcc, [opencodeZaiAcc, piAcc]);
  assert.equal(sharedPlanOpencode.planId, sharedPlanPi.planId, 'both accounts with Z.AI credentials share zai-a');
  assert.equal(sharedPlanOpencode.planId, 'zai-a');
});

test('unit:gy-1158-finding-2 — do not treat unrelated local auth or process.env as this account Z.AI login', async () => {
  const dir = await temporaryDirectory('zai-unrelated-auth');
  // Home with unrelated auth.json without zai keys
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ otherProvider: { key: 'secret' } }));

  const savedEnv = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = 'host-wide-zai-key';
  try {
    const health = await checkAgentEnvironment({
      name: 'pi-test',
      kind: 'pi' as any,
      home: dir,
    }, { quota: false });

    assert.equal(health.loggedIn, false, 'unrelated auth.json and host process.env do not mark pi account logged in');
  } finally {
    if (savedEnv !== undefined) process.env.ZAI_API_KEY = savedEnv;
    else delete process.env.ZAI_API_KEY;
  }
});

test('unit:gy-1158-finding-4 — reconcile stale exhausted observations per plan by preferring newest observation', () => {
  const baseReg = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [
      { name: 'opencode', launch: { kind: 'opencode', args: [], environment: {}, homeVariable: 'OPENCODE_DIR', modelFlag: '--model', login: null, loginFile: null } },
    ],
    models: [
      { name: 'glm', id: 'glm-4', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'fast', contextTokens: null } },
    ],
    accounts: [
      { name: 'acc-host-a', runtime: 'opencode', model: 'glm', plan: 'team-zai', credential: { host: 'host-a', home: '/home/a' }, enabled: true },
      { name: 'acc-host-b', runtime: 'opencode', model: 'glm', plan: 'team-zai', credential: { host: 'host-b', home: '/home/b' }, enabled: true },
    ],
    roles: [
      { name: 'worker', accounts: ['acc-host-a', 'acc-host-b'], concurrency: 2 },
    ],
    reason: 'test setup',
  }, { actor: 'operator', at: iso(-2 * hour) }).registry;

  const accA = baseReg.accounts.find(a => a.name === 'acc-host-a')!;
  const accB = baseReg.accounts.find(a => a.name === 'acc-host-b')!;

  // Host A reports exhausted at T - 30 minutes without a reset timestamp
  foldObservation(accA, {
    loggedIn: true,
    state: 'exhausted',
    usage: [{ window: '5h', percent: 100, resetsAt: null }],
    resetsAt: null,
    reason: 'quota exceeded',
  }, { actor: 'coordinator', at: iso(-30 * minute) });

  // Later at T - 5 minutes, Host B observes the shared plan as available
  foldObservation(accB, {
    loggedIn: true,
    state: 'available',
    usage: [{ window: '5h', percent: 20, resetsAt: iso(2 * hour) }],
    resetsAt: iso(2 * hour),
    reason: null,
  }, { actor: 'coordinator', at: iso(-5 * minute) });

  // Checking ineligibility for accB: accA's older exhausted probe should NOT block accB indefinitely
  const ineligibilityB = accountIneligibility(baseReg, accB, now, 'host-b');
  assert.equal(ineligibilityB, null, 'acc-host-b is eligible because newer observation on the shared plan is available');

  // Checking ineligibility for accA: accA's stale exhaustion is also reconciled to available
  const ineligibilityA = accountIneligibility(baseReg, accA, now, 'host-a');
  assert.equal(ineligibilityA, null, 'acc-host-a is eligible because newest observation on the shared plan is available');
});

test('unit:gy-1158-finding-5 — observeAccount detects sibling accounts by passing allAccounts to deriveAccountPlan', async () => {
  const dirShared = await temporaryDirectory('shared-home');
  await writeFile(join(dirShared, 'login.token'), 'token');

  const runtime: any = {
    name: 'custom',
    launch: { kind: 'custom', args: [], environment: {}, homeVariable: 'CUSTOM_DIR', modelFlag: '--model', login: null, loginFile: 'login.token' },
  };

  const account1: any = {
    name: 'custom-1',
    runtime: 'custom',
    credential: { host: HOST, home: dirShared },
    enabled: true,
    quota: { loggedIn: null, state: 'unknown', usage: [], resetsAt: null, reason: null },
  };
  const account2: any = {
    name: 'custom-2',
    runtime: 'custom',
    credential: { host: HOST, home: dirShared },
    enabled: true,
    quota: { loggedIn: null, state: 'unknown', usage: [], resetsAt: null, reason: null },
  };

  // When allAccounts contains sibling accounts sharing the same home on the same host
  const obs = await observeAccount(account1, runtime, { quota: false }, [account1, account2]);
  assert.equal(obs.quota.loggedIn, true);

  const planSolo = deriveAccountPlan(account1, [account1]);
  const planShared = deriveAccountPlan(account1, [account1, account2]);
  assert.notEqual(planSolo.planId, planShared.planId);
  assert.ok(planShared.planId.startsWith(`home:${HOST}:`), 'shared home plan detected when allAccounts is passed');
});

test('unit:gy-1158-finding-6 — read Pi normal Z.AI credential before probing usage', async () => {
  const dir = await temporaryDirectory('pi-normal-auth');
  // Pi normal discovery structure: auth.json contains { zai: { type: 'api_key', key: '...' } }
  await writeFile(join(dir, 'auth.json'), JSON.stringify({
    zai: { type: 'api_key', key: 'test-pi-zai-secret' }
  }));

  let headerAuth: string | null = null;
  const mockFetch = (async (url: string, init?: any) => {
    headerAuth = init?.headers?.Authorization ?? null;
    return new Response(JSON.stringify({
      code: 200,
      data: {
        limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 50, nextResetTime: now + hour }],
      },
    }));
  }) as typeof fetch;

  const health = await checkAgentEnvironment({
    name: 'pi-normal',
    kind: 'pi' as any,
    home: dir,
  }, { fetch: mockFetch, now: () => now, cacheMs: 0 });

  assert.equal(health.loggedIn, true, 'pi account is logged in with normal zai discovery auth');
  assert.equal(headerAuth, 'Bearer test-pi-zai-secret', 'authorization header uses nested Pi Z.AI key');
  assert.equal(health.quota, 'available');
  assert.equal(health.usage.length, 1);
  assert.equal(health.usage[0].percent, 50);
});

test('unit:gy-1158-finding-3 — accountSchema rejects null plan but accepts omitted plan', () => {
  const accountWithNullPlan = {
    name: 'test-acc',
    runtime: 'claude',
    model: 'opus',
    plan: null,
    credential: { host: 'host-1', home: null },
  };
  assert.throws(() => accountSchema.parse(accountWithNullPlan), /Expected string, received null/i);

  const accountWithoutPlan = {
    name: 'test-acc',
    runtime: 'claude',
    model: 'opus',
    credential: { host: 'host-1', home: null },
  };
  const parsed = accountSchema.parse(accountWithoutPlan);
  assert.equal(parsed.plan, undefined);
});

