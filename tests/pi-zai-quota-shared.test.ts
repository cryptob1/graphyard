import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { observeAccount } from '../src/fleet.js';
import { accountIneligibility } from '../src/model/registry-sessions.js';
import { applyRegistryMutation, emptyRegistry, foldObservation } from '../src/model/registry.js';

// GY-2871: pi-a and pi-b ran zai/glm-5.3-flash on the operator's shared Z.AI credit, but pi-a's own key
// answered the quota endpoint with no limits, so both read quota unknown and stayed eligible while
// opencode-a read the credit spent. Dispatch kept launching Pi workers on a claude profile; each printed
// pi's 429 code 1310 and sat at its prompt, judged against the profile's claude notices, until the idle bound ran out.

const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const reset = iso(3 * 86_400_000);
const keys = { opencode: 'opencode-credit-key', pi: 'pi-own-key' };

test('unit:pi-zai-quota-shared — a Pi account on a zai/ model reads the shared Z.AI credit: exhausted until its reset and ineligible for the worker role, then available again', async () => {
  const opencodeHome = await temporaryDirectory('zai-opencode'), piHome = await temporaryDirectory('zai-pi');
  await mkdir(join(opencodeHome, 'opencode'), { recursive: true });
  await writeFile(join(opencodeHome, 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { key: keys.opencode } }));
  await writeFile(join(piHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: keys.pi } }));
  let credit = { percentage: 100, nextResetTime: Date.parse(reset) };
  // The credit's key reports it; pi's own key answers with no limits, as pi-a's did.
  const probe = (async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ code: 200, data: {
    limits: (init?.headers as Record<string, string>).Authorization === `Bearer ${keys.opencode}` ? [{ type: 'CREDIT_LIMIT', ...credit }] : [] } }))) as typeof fetch;
  const launch = (kind: string) => ({ kind, args: [], environment: {}, homeVariable: 'HOME_DIR', modelFlag: '--model', login: null, loginFile: null });
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [{ name: 'opencode', launch: launch('opencode') }, { name: 'pi', launch: launch('pi') }],
    models: [{ name: 'glm-flash', id: 'zai/glm-5.3-flash', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'fast', contextTokens: null } }],
    accounts: [
      { name: 'opencode-a', runtime: 'opencode', model: 'glm-flash', credential: { host: 'host', home: opencodeHome }, enabled: true },
      { name: 'pi-a', runtime: 'pi', model: 'glm-flash', credential: { host: 'host', home: piHome }, enabled: true },
    ],
    roles: [{ name: 'worker', accounts: ['opencode-a', 'pi-a'], concurrency: 2 }],
    reason: 'test setup',
  }, { actor: 'operator', at: iso(-3_600_000) }).registry;
  const [opencode, pi] = registry.accounts;
  const observe = async (offsetMs: number) => {
    for (const account of [opencode, pi]) {
      const runtime = registry.runtimes.find(entry => entry.name === account.runtime)!;
      const { quota } = await observeAccount(account, runtime, { fetch: probe, cacheMs: 0, now: () => clock + offsetMs }, registry.accounts, 'zai/glm-5.3-flash');
      foldObservation(account, quota, { actor: 'coordinator', at: iso(offsetMs) });
    }
  };

  await observe(0);
  assert.equal(pi.quota?.state, 'exhausted', 'the Pi account reads the spent credit, not unknown');
  assert.equal(pi.quota?.resetsAt, reset, 'held until the credit resets');
  assert.ok(accountIneligibility(registry, pi, clock + 1_000, 'host'), 'the Pi account is not eligible for the worker role');

  credit = { percentage: 10, nextResetTime: Date.parse(reset) };
  await observe(60_000);
  assert.equal(pi.quota?.state, 'available', 'available again once the probe reports the credit available');
  assert.equal(accountIneligibility(registry, pi, clock + 61_000, 'host'), null);
});
