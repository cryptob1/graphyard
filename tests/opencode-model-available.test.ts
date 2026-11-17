import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkAgentEnvironment } from '../src/master/environments.js';
import { observeAccount } from '../src/fleet.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, foldObservations, proposedRuntimes } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3414: opencode-a's auth.json held only zai-coding-plan, which the installed OpenCode no longer
// lists, so every run fell back to the free big-pickle model and hit its limit. An OpenCode account
// is ready only when `opencode models` lists its configured model.
const scratch = await temporaryDirectory('opencode-model-available');
const listed = 'opencode/glm-5.3-flash-free\nopencode/big-pickle\n';
const probe = { quota: false, cacheMs: 0, opencodeAuth: async () => 'Z.AI Coding Plan  api', opencodeModels: async () => listed };
const HOST = 'host-a';

async function home(name: string) {
  const directory = join(scratch, name);
  await mkdir(join(directory, 'opencode'), { recursive: true });
  await writeFile(join(directory, 'opencode', 'auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: `${name}-key` } }));
  return directory;
}

test('integration:opencode-model-available — a configured model OpenCode does not list makes the account not ready', async () => {
  const health = await checkAgentEnvironment({ name: 'opencode-a', kind: 'opencode', home: await home('opencode-a'), plan: 'zai', declaredPlan: 'zai', model: 'zai-coding-plan/glm-4.6' }, probe);
  assert.equal(health.healthy, false);
  assert.equal(health.reason, 'opencode-a is not ready: model unavailable: zai-coding-plan/glm-4.6');
});

test('integration:opencode-model-available — a listed model, or a listed provider, is ready', async () => {
  const health = await checkAgentEnvironment({ name: 'opencode-b', kind: 'opencode', home: await home('opencode-b'), plan: 'zai', declaredPlan: 'zai', model: 'opencode/big-pickle' }, probe);
  assert.equal(health.reason, null);
  const provider = await checkAgentEnvironment({ name: 'opencode-p', kind: 'opencode', home: await home('opencode-p'), plan: 'zai', declaredPlan: 'zai', model: 'opencode' }, probe);
  assert.equal(provider.reason, null);
});

test('integration:opencode-model-available — an account whose model is unavailable is not dispatched', async () => {
  const now = new Date().toISOString();
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(entry => entry.name === 'opencode'),
    models: [{ name: 'glm', id: 'zai-coding-plan/glm-4.6' }, { name: 'pickle', id: 'opencode/big-pickle' }],
    accounts: [{ name: 'opencode-a', runtime: 'opencode', model: 'glm', credential: { host: HOST, home: await home('opencode-a2') } },
      { name: 'opencode-b', runtime: 'opencode', model: 'pickle', credential: { host: HOST, home: await home('opencode-b2') } }],
    roles: [{ name: 'reviewer', accounts: ['opencode-a', 'opencode-b'], concurrency: 1 }], reason: 'fixture',
  }, { actor: 'operator', at: now }).registry;
  const observations = await Promise.all(registry.accounts.map(async account => ({ account: account.name,
    quota: (await observeAccount(account, registry.runtimes[0]!, probe, registry.accounts, registry.models.find(model => model.name === account.model)!.id!)).quota })));
  assert.equal(observations[0]!.quota.reason, 'opencode-a is not ready: model unavailable: zai-coding-plan/glm-4.6');
  foldObservations(registry, { host: HOST, observations }, { actor: 'master', at: now });
  const choice = chooseSession(registry, { role: 'reviewer', host: HOST }, Date.parse(now));
  assert.equal(choice.account?.name, 'opencode-b', choice.reason ?? undefined);
  assert.ok(choice.skipped.some(entry => entry.account === 'opencode-a' && /model unavailable: zai-coding-plan\/glm-4\.6/.test(entry.reason)), JSON.stringify(choice.skipped));
});
